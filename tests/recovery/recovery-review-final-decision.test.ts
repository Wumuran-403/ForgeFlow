import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createHostAuthFixture, now } from "../host-auth/host-auth-fixture.js";
import { createRecoveryReviewFixture } from "./review-operation-fixture.js";
import { FileEvidencePayloadStore } from "../../src/recovery/evidence-payload-store.js";
import { computeJsonPayloadDigest, computeRecoveryEvidenceEnvelopeDigest } from "../../src/recovery/recovery-evidence.js";
import { computeRecoverySourceContractDigest } from "../../src/recovery/recovery-source-contract.js";
import { RecoveryReviewDecisionService } from "../../src/recovery/recovery-review-decision-service.js";
import { issueManualFinalDecisionAuthorization } from "../../src/recovery/recovery-review-final-decision-authorization.js";
import { computeFinalDecisionIdentity, RecoveryReviewFinalDecisionService,
  type FinalDecisionInput } from "../../src/recovery/recovery-review-final-decision-service.js";
import { RecoveryReviewTerminalReplayService } from "../../src/recovery/recovery-review-terminal-replay-service.js";
import { resolveUnknownWriteSettlement } from "../../src/recovery/recovery-unknown-write-settlement.js";
import { buildRecoveryEvidenceEnvelope } from "../../src/recovery/recovery-review-submission.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import { closeDatabase, migrateStorage, openDatabase, runInTransaction, TaskLeaseManager,
  TaskSnapshotReader, type ForgeFlowDatabase } from "../../src/storage/index.js";
import { EventRepository } from "../../src/storage/event-repository.js";
import { ExecutionStateMachine } from "../../src/storage/execution-state-machine.js";
import { ExecutionUnitOfWork } from "../../src/storage/execution-unit-of-work.js";
import { createFinalConvergenceCapability } from "../../src/storage/recovery-review-final-convergence-capability.js";
import { PlanStepRepository } from "../../src/storage/plan-step-repository.js";
import { RecoveryEvidenceVerificationCheckRepository } from "../../src/storage/recovery-evidence-verification-check-repository.js";
import { RecoveryEvidenceVerificationRepository } from "../../src/storage/recovery-evidence-verification-repository.js";
import { SequenceAllocator } from "../../src/storage/sequences.js";
import { ToolRunRepository } from "../../src/storage/tool-run-repository.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";

const stamp = "2026-01-01T00:02:00.000Z";
const digest = (character: string) => `sha256:${character.repeat(64)}`;
let database: ForgeFlowDatabase;
let directory: string;
let payloadStore: FileEvidencePayloadStore;
let fixtureNo = 0;

beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(now);
  directory = mkdtempSync(join(tmpdir(), "forgeflow-final-review-"));
  database = openDatabase(join(directory, "state.sqlite")); migrateStorage(database);
  payloadStore = new FileEvidencePayloadStore(join(directory, "evidence"));
});
afterEach(() => { closeDatabase(database); rmSync(directory, { recursive: true, force: true }); vi.useRealTimers(); });

function setup(operation: "confirm_succeeded" | "confirm_not_executed", downstream = false,
  options: { verificationStatus?: "not_run" | "failed"; contractTaskId?: string;
    manualAuthenticity?: "unverified" | "manual_attested" } = {}) {
  const fixture = createRecoveryReviewFixture(database, `${operation}-${downstream}-${++fixtureNo}`);
  const snapshots = new TaskSnapshotReader(database);
  const leases = new TaskLeaseManager(database);
  const lease = leases.claim(fixture.taskId, "final-review-test");
  const ownership = { taskId: fixture.taskId, leaseToken: lease.leaseToken!, fencingToken: lease.fencingToken };
  const original = snapshots.load(fixture.taskId).toolRuns.find((item) => item.id === fixture.toolRunId)!;
  if (downstream) {
    const upstreamStep = snapshots.load(fixture.taskId).planSteps.find((item) => item.id === original.planStepId)!;
    runInTransaction(database, () => {
      const permit = createStorageWritePermit(database);
      const steps = new PlanStepRepository(database);
      const tools = new ToolRunRepository(database);
      for (const index of [1, 2]) {
        const step = steps.insert({ id: `downstream-step-${index}`, taskId: fixture.taskId,
          planId: upstreamStep.planId, stepIndex: index, kind: index === 1 ? "read_batch" : "write",
          status: "queued", createdAt: stamp }, permit);
        for (let item = 0; item < (index === 1 ? 2 : 1); item += 1) {
          tools.createIntent({ id: `downstream-run-${index}-${item}`, taskId: fixture.taskId,
            planStepId: step.id, toolCallId: `downstream-call-${index}-${item}`, originalIndex: index + item,
            toolName: index === 1 ? "inventory_lookup" : "bom_update", toolVersion: "1",
            inputSchemaHash: digest("1"), canonicalInputHash: original.canonicalInputHash,
            mode: index === 1 ? "read" : "write", requiresApproval: index === 2,
            status: "queued", input: {}, idempotencyKey: digest(String(index * 2 + item)), attemptNo: 1,
            createdAt: stamp }, permit);
        }
      }
    }, "immediate");
  }
  const contract = operation === "confirm_not_executed" ? {
    sourceContractSchemaVersion: "forgeflow.recovery-source-contract.v1" as const,
    sourceContractAuthority: "manual_attested" as const, sourceType: "manual_review" as const,
    taskId: options.contractTaskId ?? fixture.taskId, reviewId: fixture.reviewId, originalUnknownWriteToolRunId: fixture.toolRunId,
    targetResourceIdentity: { resourceType: "draft", resourceRef: "demo://draft/1", resourceVersion: null },
    queryScope: { kind: "exact_resource" as const, selector: "demo://draft/1" },
    observationTimeWindow: { startsAt: "2026-01-01T00:00:00.000Z", endsAt: "2026-01-01T00:05:00.000Z" },
    coverageCompleteness: { isComplete: true as const, coveredSelectors: ["demo://draft/1"] },
    negativeObservationSemantics: "manual_attested_non_execution" as const,
    provenance: "declared_payload" as const, result: "not_run" as const,
    sourceObservedAt: stamp, payloadDigest: digest("4"),
    manualAttestation: { actorId: "reviewer-1", actorType: "human_reviewer" as const,
      attestationId: "attestation-1", attestationDigest: digest("5"),
      responsibilityStatement: "I checked the authoritative demo record and attest to non-execution." },
  } : null;
  const payloadContent = contract ?? { observed: "succeeded", resource: "demo://draft/1" };
  const payloadDigest = contract === null ? computeJsonPayloadDigest(payloadContent) : computeRecoverySourceContractDigest(contract);
  const submission = {
    taskId: fixture.taskId, reviewId: fixture.reviewId, expectedDecisionVersion: 0,
    binding: { toolRunId: original.id, toolName: original.toolName, toolVersion: original.toolVersion,
      inputSchemaHash: original.inputSchemaHash, canonicalInputHash: original.canonicalInputHash,
      idempotencyKey: original.idempotencyKey },
    host: { sourceType: "manual_review" as const, actorId: "reviewer-1" },
    payload: { evidenceRef: "demo://evidence/1", outcome: operation === "confirm_succeeded" ? "observed_succeeded" as const : "observed_not_executed" as const,
      sourceObservedAt: stamp, resourceRef: "demo://draft/1", resourceVersion: null,
      payloadType: "json" as const, payloadDigestProtocol: "jcs-sha256-v1" as const,
      payloadContent, payloadDigest, redactedSummary: null }, requestKey: digest("f"),
  };
  const envelopeDigest = computeRecoveryEvidenceEnvelopeDigest(buildRecoveryEvidenceEnvelope(submission, stamp));
  const requestKey = computeRecoveryReviewOperationRequestKey({ reviewId: fixture.reviewId,
    expectedDecisionVersion: 0, operation: "submit_evidence", operationPayloadDigest: envelopeDigest,
    actorId: "reviewer-1" });
  const submitted = new RecoveryReviewDecisionService(database, leases, payloadStore)
    .submitEvidenceOwned({ ...submission, requestKey }, ownership, snapshots.load(fixture.taskId).task.version, stamp);
  const evidence = submitted.evidenceSubmission!;
  const checkId = `check-${fixture.reviewId}`;
  const verificationId = `verification-${fixture.reviewId}`;
  const verificationKey = computeJsonPayloadDigest({ checkId });
  runInTransaction(database, () => {
    const permit = createStorageWritePermit(database);
    new RecoveryEvidenceVerificationCheckRepository(database).insert({ id: checkId, taskId: fixture.taskId,
      reviewId: fixture.reviewId, evidenceSubmissionId: evidence.id, originalToolRunId: original.id,
      readbackRequestId: null, evidenceReadId: null, verificationCheckId: checkId, requestKey: verificationKey,
      checkOrigin: "stored_evidence_v0", verifierId: "manual-evidence-check", verifierVersion: "1",
      verifierConfigDigest: digest("7"), allowlistId: null, allowlistVersion: null,
      readToolName: null, readToolVersion: null, readToolSchemaHash: null,
      expectedPayloadDigest: evidence.payloadDigest, createdAt: stamp }, permit);
    const event = new EventRepository(database, new SequenceAllocator(database)).append({
      taskId: fixture.taskId, traceId: snapshots.load(fixture.taskId).task.traceId,
      type: "recovery.evidence.availability_checked", entityType: "recovery_verification", entityId: verificationId,
      payload: { verificationId, verificationCheckId: checkId, requestKey: verificationKey,
        availabilityStatus: "available" } }, stamp, permit);
    const verificationStatus = options.verificationStatus ?? "not_run";
    const verificationEvent = verificationStatus === "not_run" ? null :
      new EventRepository(database, new SequenceAllocator(database)).append({
        taskId: fixture.taskId, traceId: snapshots.load(fixture.taskId).task.traceId,
        type: "recovery.evidence.verification_completed", entityType: "recovery_verification", entityId: verificationId,
        payload: { verificationId, verificationCheckId: checkId, requestKey: verificationKey,
          verificationStatus } }, stamp, permit);
    new RecoveryEvidenceVerificationRepository(database).insert({ id: verificationId, taskId: fixture.taskId,
      reviewId: fixture.reviewId, evidenceSubmissionId: evidence.id, originalToolRunId: original.id,
      readbackRequestId: null, evidenceReadId: null, readAttemptId: null,
      verificationCheckId: checkId, readbackResultProvenance: "declared_payload",
      verifierId: "manual-evidence-check", verifierVersion: "1", verifierConfigDigest: digest("7"),
      allowlistId: null, allowlistVersion: null, requestKey: verificationKey,
      availabilityStatus: "available", integrityStatus: "matched",
      authenticityStatus: options.manualAuthenticity ?? "manual_attested",
      verificationStatus, expectedPayloadDigest: evidence.payloadDigest,
      observedPayloadDigest: evidence.payloadDigest, reasonCode: "MANUAL_ATTESTED", redactedSummary: null,
      availabilityEventId: event.id, verificationEventId: verificationEvent?.id ?? null, createdAt: stamp }, permit);
  }, "immediate");
  const input: FinalDecisionInput = { taskId: fixture.taskId, reviewId: fixture.reviewId,
    originalUnknownWriteToolRunId: original.id, operation,
    expectedDecisionVersion: snapshots.load(fixture.taskId).recoveryReviews[0]!.decisionVersion,
    evidenceSubmissionId: evidence.id, verificationCheckId: checkId, verificationId,
    sourceContractDigest: contract === null ? null : payloadDigest, decisionNote: "Reviewed authoritative evidence." };
  const host = createHostAuthFixture();
  const writeContext = host.gateway.createContext({ access: "final_decision",
    assertion: host.issueAssertion(host.humanPrivateKey, "human-reviewer-key-1") });
  const readContext = host.gateway.createContext({ access: "read_replay",
    assertion: host.issueAssertion(host.humanPrivateKey, "human-reviewer-key-1", { assertionId: "read-assertion" }) });
  const identity = computeFinalDecisionIdentity(input, "reviewer-1", "human_reviewer");
  const authorization = issueManualFinalDecisionAuthorization(writeContext, identity, "final_decision");
  const readAuthorization = issueManualFinalDecisionAuthorization(readContext, identity, "read_replay");
  const authorize = (request: FinalDecisionInput) => issueManualFinalDecisionAuthorization(writeContext,
    computeFinalDecisionIdentity(request, "reviewer-1", "human_reviewer"), "final_decision");
  const service = new RecoveryReviewFinalDecisionService(database, leases, payloadStore);
  return { fixture, ownership, snapshots, input, authorization, readAuthorization, authorize, service,
    evidence, contract, payloadDigest, verificationId };
}

describe("internal Final RecoveryReview core", () => {
  it("applies Cancel priority when Cancel commits before the Final Decision", () => {
    const f = setup("confirm_succeeded");
    const second = openDatabase(join(directory, "state.sqlite"));
    try {
      const before = f.snapshots.load(f.fixture.taskId);
      new ExecutionStateMachine(second, new TaskLeaseManager(second)).requestCancel({
        ...f.ownership, expectedTaskVersion: before.task.version,
      });
      const afterCancel = f.snapshots.load(f.fixture.taskId);
      expect(afterCancel.task.cancelRequestedAt).not.toBeNull();
      const decision = f.service.commitInternal(f.input, f.authorization, f.ownership,
        afterCancel.task.version);
      expect(decision.snapshot.task.status).toBe("cancelled");
      expect(decision.snapshot.task.cancelRequestedAt).not.toBeNull();
      expect(decision.snapshot.toolRuns.find((item) => item.id === f.fixture.toolRunId)?.status).toBe("unknown");
      expect(() => new ExecutionStateMachine(second, new TaskLeaseManager(second))
        .requestCancel({ ...f.ownership, expectedTaskVersion: decision.snapshot.task.version })).toThrow();
    } finally { closeDatabase(second); }
  });

  it("converges queued descendants when Cancel precedes the Final Decision", () => {
    const f = setup("confirm_succeeded", true);
    new ExecutionStateMachine(database, new TaskLeaseManager(database),
      { finalReviewPayloadStore: payloadStore }).requestCancel({
        ...f.ownership, expectedTaskVersion: f.snapshots.load(f.fixture.taskId).task.version,
      });
    const decided = f.service.commitInternal(f.input, f.authorization, f.ownership,
      f.snapshots.load(f.fixture.taskId).task.version);
    expect(decided.snapshot.task.status).toBe("cancelled");
    expect(decided.snapshot.toolRuns.filter((run) => run.id.startsWith("downstream-run-"))
      .every((run) => run.status === "cancelled")).toBe(true);
    expect(decided.snapshot.toolRuns.find((run) => run.id === f.fixture.toolRunId)?.status).toBe("unknown");
  });

  it("converges Cancel after a nonterminal Final Decision on a second connection", () => {
    const f = setup("confirm_succeeded", true);
    const decided = f.service.commitInternal(f.input, f.authorization, f.ownership,
      f.snapshots.load(f.fixture.taskId).task.version);
    expect(decided.snapshot.task.status).toBe("waiting_review");
    const second = openDatabase(join(directory, "state.sqlite"));
    try {
      const cancelled = new ExecutionStateMachine(second, new TaskLeaseManager(second),
        { finalReviewPayloadStore: payloadStore }).requestCancel({
          ...f.ownership, expectedTaskVersion: decided.snapshot.task.version,
        });
      expect(cancelled.task.status).toBe("cancelled");
      expect(cancelled.toolRuns.filter((run) => run.id.startsWith("downstream-run-"))
        .every((run) => run.status === "cancelled")).toBe(true);
      expect(cancelled.toolRuns.find((run) => run.id === f.fixture.toolRunId)?.status).toBe("unknown");
      expect(() => f.service.commitInternal(f.input, f.authorization, f.ownership,
        decided.snapshot.task.version)).toThrow();
    } finally { closeDatabase(second); }
  });

  it("admits a later Write only with a verified resolved-success audit chain", () => {
    const f = setup("confirm_succeeded", true);
    const decided = f.service.commitInternal(f.input, f.authorization, f.ownership,
      f.snapshots.load(f.fixture.taskId).task.version);
    const machine = new ExecutionStateMachine(database, new TaskLeaseManager(database));
    machine.transitionTask({ ...f.ownership, expectedTaskVersion: decided.snapshot.task.version,
      expectedStatus: "waiting_review", status: "running" });
    const snapshot = f.snapshots.load(f.fixture.taskId);
    const target = snapshot.toolRuns.find((run) => run.id === "downstream-run-2-0")!;
    const step = snapshot.planSteps.find((item) => item.id === target.planStepId)!;
    const input = { toolRunId: target.id, expectedToolRunVersion: target.version,
      expectedPlanStepVersion: step.version, ownership: f.ownership };
    expect(() => new ExecutionUnitOfWork(database, new TaskLeaseManager(database))
      .beginOwnedToolRunAfterWriteBarrier(input)).toThrow();
    const admitted = new ExecutionUnitOfWork(database, new TaskLeaseManager(database), payloadStore)
      .beginOwnedToolRunAfterWriteBarrier(input);
    expect(admitted.toolRuns.find((run) => run.id === target.id)?.status).toBe("running");
    expect(admitted.toolRuns.find((run) => run.id === f.fixture.toolRunId)?.status).toBe("unknown");
  });

  it("keeps a paused task from dispatching after an audit-only Final Decision", () => {
    const f = setup("confirm_succeeded", true);
    database.prepare("UPDATE tasks SET pause_requested_at = ? WHERE id = ?")
      .run(stamp, f.fixture.taskId);
    const result = f.service.commitInternal(f.input, f.authorization, f.ownership,
      f.snapshots.load(f.fixture.taskId).task.version);
    expect(result.snapshot.task.status).toBe("waiting_review");
    expect(result.snapshot.task.pauseRequestedAt).toBe(stamp);
    expect(result.snapshot.toolRuns.filter((run) => run.id.startsWith("downstream-run-") && run.mode === "write")
      .every((run) => run.status === "queued")).toBe(true);
    expect(() => new ExecutionStateMachine(database, new TaskLeaseManager(database)).transitionTask({
      ...f.ownership, expectedTaskVersion: result.snapshot.task.version,
      expectedStatus: "waiting_review", status: "running",
    })).toThrow();
  });
  it("commits confirmed_succeeded, preserves original unknown, and supports terminal read-only replay", () => {
    const f = setup("confirm_succeeded");
    expect(resolveUnknownWriteSettlement(f.snapshots.load(f.fixture.taskId), f.fixture.toolRunId, payloadStore)).toBe("open_unknown");
    const before = f.snapshots.load(f.fixture.taskId);
    const result = f.service.commitInternal(f.input, f.authorization, f.ownership, before.task.version);
    expect(result.state).toBe("applied");
    expect(result.snapshot.task.status).toBe("completed");
    expect(result.snapshot.toolRuns.find((item) => item.id === f.fixture.toolRunId)?.status).toBe("unknown");
    expect(resolveUnknownWriteSettlement(result.snapshot, f.fixture.toolRunId, payloadStore)).toBe("resolved_success");
    new TaskLeaseManager(database).release(f.ownership.taskId, f.ownership.leaseToken, f.ownership.fencingToken);
    const released = f.snapshots.load(f.fixture.taskId);
    expect(() => new TaskLeaseManager(database).claim(f.fixture.taskId, "replay-owner")).toThrow();
    const replay = new RecoveryReviewTerminalReplayService(database, payloadStore).replayInternal(f.input, f.readAuthorization);
    expect(replay.operation.id).toBe(result.operation.id);
    expect(f.snapshots.load(f.fixture.taskId).events).toHaveLength(released.events.length);
    expect(f.snapshots.load(f.fixture.taskId).checkpoints).toHaveLength(released.checkpoints.length);
    expect(() => f.service.commitInternal(f.input, f.authorization, f.ownership, before.task.version)).toThrow();
  });

  it("atomically confirms not executed, skips 1:N downstream runs, and fails the task", () => {
    const f = setup("confirm_not_executed", true);
    const result = f.service.commitInternal(f.input, f.authorization, f.ownership,
      f.snapshots.load(f.fixture.taskId).task.version);
    expect(result.snapshot.task.status).toBe("failed");
    expect(result.snapshot.toolRuns.find((item) => item.id === f.fixture.toolRunId)?.status).toBe("unknown");
    expect(result.snapshot.toolRuns.filter((item) => item.id.startsWith("downstream-run-")).map((item) => item.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(result.snapshot.planSteps.filter((item) => item.id.startsWith("downstream-step-")).every((item) => item.status === "skipped")).toBe(true);
    expect(resolveUnknownWriteSettlement(result.snapshot, f.fixture.toolRunId, payloadStore)).toBe("resolved_not_executed");
    expect(new RecoveryReviewTerminalReplayService(database, payloadStore).replayInternal(f.input, f.readAuthorization).state).toBe("replayed");
  });

  it("rejects missing evidence, mismatched contract and verification, unauthorized calls, and CAS conflicts", () => {
    const f = setup("confirm_not_executed");
    const version = f.snapshots.load(f.fixture.taskId).task.version;
    const missingEvidence = { ...f.input, evidenceSubmissionId: "missing" };
    expect(() => f.service.commitInternal(missingEvidence, f.authorize(missingEvidence), f.ownership, version)).toThrow();
    expect(() => f.service.commitInternal(f.input, {} as typeof f.authorization, f.ownership, version)).toThrow();
    expect(() => f.service.commitInternal(f.input, f.authorization, f.ownership, version + 1)).toThrow();
    const wrongDigest = { ...f.input, sourceContractDigest: digest("9") };
    expect(() => f.service.commitInternal(wrongDigest, f.authorize(wrongDigest), f.ownership, version)).toThrow();
    const wrongVerification = { ...f.input, verificationId: "wrong" };
    expect(() => f.service.commitInternal(wrongVerification, f.authorize(wrongVerification), f.ownership, version)).toThrow();
    expect(() => f.service.commitInternal({ ...f.input, decisionNote: "different payload" }, f.authorization, f.ownership, version)).toThrow();
    expect(f.snapshots.load(f.fixture.taskId).recoveryReviews[0]?.status).toBe("pending");
  });

  it("rejects failed verification, invalid contract binding, and missing stored evidence", () => {
    const failed = setup("confirm_not_executed", false, { verificationStatus: "failed" });
    expect(() => failed.service.commitInternal(failed.input, failed.authorization, failed.ownership,
      failed.snapshots.load(failed.fixture.taskId).task.version)).toThrow();
    const inconsistent = setup("confirm_not_executed", false, { contractTaskId: "wrong-task" });
    expect(() => inconsistent.service.commitInternal(inconsistent.input, inconsistent.authorization, inconsistent.ownership,
      inconsistent.snapshots.load(inconsistent.fixture.taskId).task.version)).toThrow();
    const missingFile = setup("confirm_succeeded");
    rmSync(join(directory, "evidence", `${missingFile.payloadDigest.slice(7)}.bin`));
    expect(() => missingFile.service.commitInternal(missingFile.input, missingFile.authorization, missingFile.ownership,
      missingFile.snapshots.load(missingFile.fixture.taskId).task.version)).toThrow();
  });

  it("rejects unverified manual evidence even with a valid Host Final Decision authorization", () => {
    const f = setup("confirm_succeeded", false, { manualAuthenticity: "unverified" });
    const before = f.snapshots.load(f.fixture.taskId);
    expect(() => f.service.commitInternal(f.input, f.authorization, f.ownership,
      before.task.version)).toThrow();
    const after = f.snapshots.load(f.fixture.taskId);
    expect(after.recoveryReviews[0]?.status).toBe("pending");
    expect(after.toolRuns.find((item) => item.id === f.fixture.toolRunId)?.status).toBe("unknown");
  });

  it("replays a nonterminal final decision exactly and rejects premature terminal replay", () => {
    const f = setup("confirm_succeeded", true);
    const version = f.snapshots.load(f.fixture.taskId).task.version;
    const applied = f.service.commitInternal(f.input, f.authorization, f.ownership, version);
    expect(applied.snapshot.task.status).toBe("waiting_review");
    const replayed = f.service.commitInternal(f.input, f.authorization, f.ownership, version);
    expect(replayed.state).toBe("replayed");
    expect(replayed.operation.id).toBe(applied.operation.id);
    expect(replayed.snapshot.events).toHaveLength(applied.snapshot.events.length);
    expect(replayed.snapshot.checkpoints).toHaveLength(applied.snapshot.checkpoints.length);
    expect(() => new RecoveryReviewTerminalReplayService(database, payloadStore)
      .replayInternal(f.input, f.readAuthorization)).toThrow();
  });

  it("rejects stale decisionVersion and treats a bare final review as inconsistent", () => {
    const f = setup("confirm_succeeded");
    database.prepare("UPDATE recovery_reviews SET decision_version = decision_version + 1 WHERE id = ?")
      .run(f.fixture.reviewId);
    expect(() => f.service.commitInternal(f.input, f.authorization, f.ownership,
      f.snapshots.load(f.fixture.taskId).task.version)).toThrowError();
    const f2 = setup("confirm_succeeded", true);
    const applied = f2.service.commitInternal(f2.input, f2.authorization, f2.ownership,
      f2.snapshots.load(f2.fixture.taskId).task.version);
    const incomplete = { ...applied.snapshot, events: applied.snapshot.events.filter((item) => item.id !== applied.operation.appliedEventId) };
    expect(resolveUnknownWriteSettlement(incomplete, f2.fixture.toolRunId, payloadStore)).toBe("state_inconsistent");
  });

  it("rolls back review, operation, step, and event when checkpoint insert fails", () => {
    const f = setup("confirm_succeeded");
    const before = f.snapshots.load(f.fixture.taskId);
    database.exec("CREATE TEMP TRIGGER fail_final_checkpoint BEFORE INSERT ON checkpoints BEGIN SELECT RAISE(ABORT, 'test checkpoint failure'); END");
    expect(() => f.service.commitInternal(f.input, f.authorization, f.ownership, before.task.version)).toThrow();
    const after = f.snapshots.load(f.fixture.taskId);
    expect(after.recoveryReviews[0]?.status).toBe("pending");
    expect(after.planSteps.find((item) => item.id === before.toolRuns.find((run) => run.id === f.fixture.toolRunId)?.planStepId)?.status).toBe("waiting_review");
    expect(after.events).toHaveLength(before.events.length);
    expect(after.recoveryReviewOperations).toHaveLength(before.recoveryReviewOperations.length);
    expect(after.task.status).toBe("waiting_review");
  });

  it("keeps ordinary task completion closed and rejects cloned convergence capability", () => {
    const f = setup("confirm_succeeded");
    const machine = new ExecutionStateMachine(database, new TaskLeaseManager(database));
    const version = f.snapshots.load(f.fixture.taskId).task.version;
    expect(() => machine.transitionTask({ ...f.ownership, expectedTaskVersion: version,
      expectedStatus: "waiting_review", status: "completed" })).toThrow();
    const forged = { ...createFinalConvergenceCapability() };
    expect(() => runInTransaction(database, () => machine.transitionTaskFinalConvergenceInCurrentTransaction({
      ...f.ownership, expectedTaskVersion: version, status: "completed",
      capability: forged as ReturnType<typeof createFinalConvergenceCapability>,
    }, createStorageWritePermit(database)), "immediate")).toThrow();
    expect(f.snapshots.load(f.fixture.taskId).task.status).toBe("waiting_review");
  });
});
