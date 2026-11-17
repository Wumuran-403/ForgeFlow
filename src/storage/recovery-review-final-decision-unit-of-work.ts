import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import { computeRecoverySourceContractDigest, validateRecoverySourceContractV1 } from "../recovery/recovery-source-contract.js";
import { resolveUnknownWriteSettlement } from "../recovery/recovery-unknown-write-settlement.js";
import type { EvidencePayloadStore } from "../recovery/evidence-payload-store.js";
import type { FinalDecisionClaims, FinalDecisionIdentity } from "../recovery/recovery-review-final-decision-authorization.js";
import type { FinalDecisionInput } from "../recovery/recovery-review-final-decision-service.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionStateMachine } from "./execution-state-machine.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryReviewOperationRepository } from "./recovery-review-operation-repository.js";
import { RecoveryReviewRepository } from "./recovery-review-repository.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { createFinalConvergenceCapability } from "./recovery-review-final-convergence-capability.js";
import { convergeReviewedCancelInCurrentTransaction } from "./recovery-reviewed-cancel-convergence.js";
import { TaskSnapshotReader } from "./task-snapshot.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import { runInTransaction } from "./transaction.js";
import type { LeaseOwnershipContext } from "./execution-unit-of-work.js";
import type { RecoveryReviewOperationRecord, TaskSnapshot } from "./types.js";
import { createStorageWritePermit } from "./write-boundary.js";

interface CommitContext {
  readonly input: FinalDecisionInput;
  readonly identity: FinalDecisionIdentity;
  readonly actor: Readonly<FinalDecisionClaims>;
  readonly ownership: LeaseOwnershipContext;
  readonly expectedTaskVersion: number;
  readonly assertAuthority?: () => void;
}
export interface FinalDecisionResult {
  readonly state: "applied" | "replayed";
  readonly operation: RecoveryReviewOperationRecord;
  readonly snapshot: TaskSnapshot;
}

export class RecoveryReviewFinalDecisionUnitOfWork {
  private readonly snapshots: TaskSnapshotReader;
  private readonly machine: ExecutionStateMachine;
  private readonly reviews: RecoveryReviewRepository;
  private readonly operations: RecoveryReviewOperationRepository;
  private readonly steps: PlanStepRepository;
  private readonly runs: ToolRunRepository;
  private readonly plans: ExecutionPlanRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;

  constructor(private readonly database: Database.Database, private readonly leases: TaskLeaseManager,
    private readonly payloadStore: EvidencePayloadStore) {
    const sequences = new SequenceAllocator(database);
    this.snapshots = new TaskSnapshotReader(database);
    this.machine = new ExecutionStateMachine(database, leases);
    this.reviews = new RecoveryReviewRepository(database);
    this.operations = new RecoveryReviewOperationRepository(database);
    this.steps = new PlanStepRepository(database);
    this.runs = new ToolRunRepository(database);
    this.plans = new ExecutionPlanRepository(database);
    this.events = new EventRepository(database, sequences);
    this.checkpoints = new CheckpointStore(database, sequences);
  }

  commitInternal(context: CommitContext): FinalDecisionResult {
    context.assertAuthority?.();
    this.leases.assertOwned(context.ownership.taskId, context.ownership.leaseToken, context.ownership.fencingToken);
    return runInTransaction(this.database, () => {
      context.assertAuthority?.();
      this.leases.assertOwned(context.ownership.taskId, context.ownership.leaseToken, context.ownership.fencingToken);
      const permit = createStorageWritePermit(this.database);
      const { input, identity, actor, ownership } = context;
      if (ownership.taskId !== input.taskId) throw conflict("RECOVERY_REVIEW_TASK_MISMATCH");
      let snapshot = this.snapshots.load(input.taskId);
      if (["completed", "failed", "cancelled"].includes(snapshot.task.status))
        throw conflict("RECOVERY_REVIEW_TERMINAL_READ_REPLAY_REQUIRED");
      const existing = this.operations.getByRequestKey(identity.requestKey);
      if (existing !== undefined) {
        if (existing.taskId !== input.taskId || existing.reviewId !== input.reviewId ||
            existing.operation !== input.operation || existing.actorId !== actor.actorId ||
            existing.operationPayloadDigest !== identity.operationPayloadDigest ||
            existing.expectedDecisionVersion !== input.expectedDecisionVersion ||
            existing.evidenceEnvelopeDigest === null ||
            resolveUnknownWriteSettlement(snapshot, input.originalUnknownWriteToolRunId, this.payloadStore) !==
              (input.operation === "confirm_succeeded" ? "resolved_success" : "resolved_not_executed")) {
          throw conflict("RECOVERY_REVIEW_FINAL_DECISION_OPERATION_CONFLICT");
        }
        const event = snapshot.events.find((item) => item.id === existing.appliedEventId);
        if (event?.payload.actorType !== actor.actorType ||
            event.payload.sourceContractDigest !== input.sourceContractDigest ||
            event.payload.operationPayloadDigest !== identity.operationPayloadDigest) {
          throw conflict("RECOVERY_REVIEW_FINAL_DECISION_OPERATION_CONFLICT");
        }
        return { state: "replayed", operation: existing, snapshot };
      }
      const task = snapshot.task;
      const review = snapshot.recoveryReviews.find((item) => item.id === input.reviewId);
      const run = snapshot.toolRuns.find((item) => item.id === input.originalUnknownWriteToolRunId);
      const step = snapshot.planSteps.find((item) => item.id === run?.planStepId);
      if (task.version !== context.expectedTaskVersion) throw conflict("TASK_STATE_CONFLICT");
      if (task.status !== "waiting_review" && task.status !== "paused") throw conflict("RECOVERY_REVIEW_TASK_STATE_CONFLICT");
      if (review?.taskId !== task.id || review.toolRunId !== run?.id || review.reviewProtocolVersion < 1 ||
          !["pending", "unresolved"].includes(review.status) || run?.status !== "unknown" || run.mode !== "write" ||
          step?.status !== "waiting_review" || step.kind !== "write") throw conflict("RECOVERY_REVIEW_STATE_INCONSISTENT");
      if (review.decisionVersion !== input.expectedDecisionVersion) throw conflict("RECOVERY_REVIEW_DECISION_VERSION_CONFLICT");
      const evidence = snapshot.recoveryEvidenceSubmissions.find((item) => item.id === input.evidenceSubmissionId);
      const check = snapshot.recoveryEvidenceVerificationChecks.find((item) => item.verificationCheckId === input.verificationCheckId);
      const verification = snapshot.recoveryEvidenceVerifications.find((item) => item.id === input.verificationId);
      if (evidence === undefined || check === undefined || verification === undefined ||
          evidence.taskId !== task.id || evidence.reviewId !== review.id || evidence.toolRunId !== run.id ||
          evidence.outcome !== (input.operation === "confirm_succeeded" ? "observed_succeeded" : "observed_not_executed") ||
          evidence.sourceType !== (actor.actorType === "human_reviewer" ? "manual_review" : "system_verification") ||
          (actor.actorType === "human_reviewer" ? evidence.actorId : evidence.verifierId) !== actor.actorId ||
          check.taskId !== task.id || check.reviewId !== review.id || check.evidenceSubmissionId !== evidence.id ||
          check.originalToolRunId !== run.id || verification.verificationCheckId !== check.verificationCheckId ||
          verification.taskId !== task.id || verification.reviewId !== review.id ||
          verification.evidenceSubmissionId !== evidence.id || verification.originalToolRunId !== run.id ||
          verification.availabilityStatus !== "available" || verification.integrityStatus !== "matched" ||
          verification.verificationStatus === "failed" || verification.expectedPayloadDigest !== evidence.payloadDigest ||
          verification.observedPayloadDigest !== evidence.payloadDigest ||
          check.expectedPayloadDigest !== evidence.payloadDigest ||
          check.verifierId !== verification.verifierId ||
          check.verifierConfigDigest !== verification.verifierConfigDigest ||
          check.requestKey !== verification.requestKey ||
          (actor.actorType === "host_verifier" &&
            (verification.verificationStatus !== "passed" || verification.authenticityStatus !== "system_verified" ||
             verification.readbackResultProvenance !== "controlled_runtime_read")) ||
          (actor.actorType === "human_reviewer" && verification.authenticityStatus !== "manual_attested") ||
          evidence.payloadStoreRef === null) throw conflict("RECOVERY_REVIEW_EVIDENCE_INSUFFICIENT");
      const evidenceBytes = this.payloadStore.read(evidence.payloadStoreRef, evidence.payloadDigest);
      if (input.operation === "confirm_not_executed") {
        if (input.sourceContractDigest !== evidence.payloadDigest || evidence.payloadType !== "json")
          throw conflict("RECOVERY_REVIEW_SOURCE_CONTRACT_MISMATCH");
        let parsed: unknown;
        try { parsed = JSON.parse(Buffer.from(evidenceBytes).toString("utf8")); }
        catch { throw conflict("RECOVERY_REVIEW_SOURCE_CONTRACT_MISMATCH"); }
        const contract = validateRecoverySourceContractV1(parsed, {
          taskId: task.id, reviewId: review.id, originalUnknownWriteToolRunId: run.id,
          sourceContractAuthority: actor.actorType === "human_reviewer" ? "manual_attested" : "system_verified",
        });
        if (computeRecoverySourceContractDigest(contract) !== input.sourceContractDigest ||
            contract.sourceType !== evidence.sourceType || contract.sourceObservedAt !== evidence.sourceObservedAt ||
            contract.targetResourceIdentity.resourceRef !== evidence.resourceRef ||
            contract.queryScope.selector !== evidence.resourceRef ||
            (contract.sourceContractAuthority === "manual_attested" &&
              (contract.manualAttestation.actorId !== actor.actorId || contract.result !== verification.verificationStatus)) ||
            (contract.sourceContractAuthority === "system_verified" &&
              (contract.verifierBinding.verifierId !== verification.verifierId ||
               contract.verifierBinding.verifierConfigDigest !== verification.verifierConfigDigest ||
               contract.verifierBinding.verificationId !== verification.id ||
               contract.payloadDigest !== snapshot.recoveryEvidenceReads.find((item) => item.id === verification.evidenceReadId)?.resultPayloadDigest)))
          throw conflict("RECOVERY_REVIEW_SOURCE_CONTRACT_MISMATCH");
      }
      const downstream = snapshot.planSteps.filter((item) => item.planId === step.planId && item.stepIndex > step.stepIndex);
      if (input.operation === "confirm_not_executed") {
        for (const later of downstream) {
          const tools = snapshot.toolRuns.filter((item) => item.planStepId === later.id);
          if (later.status !== "queued" || (later.kind === "write" && tools.length !== 1) ||
              (later.kind === "read_batch" && tools.length === 0) ||
              (later.kind === "unknown_tool" && tools.length !== 0) ||
              tools.some((item) => item.status !== "queued") ||
              snapshot.approvals.some((item) => tools.some((tool) => tool.id === item.toolRunId && item.status === "pending")))
            throw conflict("RECOVERY_REVIEW_STATE_INCONSISTENT");
        }
      }
      const now = new Date().toISOString();
      this.reviews.finalizeCas({ id: review.id, taskId: task.id,
        expectedDecisionVersion: input.expectedDecisionVersion,
        status: input.operation === "confirm_succeeded" ? "confirmed_succeeded" : "confirmed_not_executed",
        note: input.decisionNote, sourceType: evidence.sourceType, evidenceRef: evidence.evidenceRef,
        evidencePayloadDigest: evidence.payloadDigest, evidencePayloadType: evidence.payloadType,
        evidenceDigestProtocol: evidence.payloadDigestProtocol, evidenceEnvelopeDigest: evidence.envelopeDigest,
        actorId: evidence.actorId, verifierId: evidence.verifierId, verificationId: verification.id,
        sourceObservedAt: evidence.sourceObservedAt, submittedAt: evidence.submittedAt,
        verifiedAt: verification.createdAt, decidedAt: now }, permit);
      this.steps.updateStatusCas(step.id, "waiting_review", step.version,
        input.operation === "confirm_succeeded" ? "completed" : "failed", now, permit);
      const operationId = randomUUID();
      const event = this.events.append({ taskId: task.id, traceId: task.traceId,
        type: "recovery.review.final_decision", entityType: "recovery_review", entityId: review.id,
        payload: { operationId, reviewId: review.id, originalUnknownWriteToolRunId: run.id,
          decision: input.operation === "confirm_succeeded" ? "confirmed_succeeded" : "confirmed_not_executed",
          decisionVersion: input.expectedDecisionVersion + 1, evidenceSubmissionId: evidence.id,
          verificationCheckId: check.verificationCheckId, verificationId: verification.id,
          sourceContractDigest: input.sourceContractDigest, actorId: actor.actorId, actorType: actor.actorType,
          requestKey: identity.requestKey, operationPayloadDigest: identity.operationPayloadDigest,
          fencingToken: ownership.fencingToken } }, now, permit);
      const operation = this.operations.append({ id: operationId, taskId: task.id, reviewId: review.id,
        requestKey: identity.requestKey, operation: input.operation,
        expectedDecisionVersion: input.expectedDecisionVersion,
        resultingDecisionVersion: input.expectedDecisionVersion + 1, status: "applied", actorId: actor.actorId,
        operationPayloadDigest: identity.operationPayloadDigest, evidenceEnvelopeDigest: evidence.envelopeDigest,
        resultPlanId: null, resultToolRunId: null, appliedEventId: event.id, createdAt: now }, permit);
      let lastEventSequence = event.sequence;
      if (input.operation === "confirm_not_executed") {
        for (const later of downstream) {
          for (const tool of snapshot.toolRuns.filter((item) => item.planStepId === later.id)) {
            this.runs.transition(tool.id, ["queued"], { status: "skipped", expectedVersion: tool.version,
              finishedAt: now, updatedAt: now }, permit);
            lastEventSequence = this.events.append({ taskId: task.id, traceId: task.traceId,
              type: "tool.skipped", entityType: "tool_run", entityId: tool.id,
              payload: { operationId, upstreamDecisionEventId: event.id, requestKey: identity.requestKey,
                reasonCode: "UPSTREAM_WRITE_NOT_EXECUTED", planId: later.planId, planStepId: later.id,
                toolRunId: tool.id, upstreamToolRunId: run.id, upstreamReviewId: review.id,
                fencingToken: ownership.fencingToken } }, now, permit).sequence;
          }
          this.steps.updateStatusCas(later.id, "queued", later.version, "skipped", now, permit);
          lastEventSequence = this.events.append({ taskId: task.id, traceId: task.traceId,
            type: "plan_step.skipped", entityType: "plan_step", entityId: later.id,
            payload: { operationId, upstreamDecisionEventId: event.id, requestKey: identity.requestKey,
              reasonCode: "UPSTREAM_WRITE_NOT_EXECUTED", planId: later.planId, planStepId: later.id,
              upstreamToolRunId: run.id, upstreamReviewId: review.id,
              fencingToken: ownership.fencingToken } }, now, permit).sequence;
        }
      }
      snapshot = this.snapshots.load(task.id);
      const plan = snapshot.executionPlans.find((item) => item.id === step.planId);
      if (plan?.status === "active" && snapshot.planSteps.filter((item) => item.planId === plan.id)
        .every((item) => ["completed", "skipped", "failed", "cancelled"].includes(item.status))) {
        this.plans.updateStatusCas(plan.id, "active", plan.version,
          snapshot.planSteps.some((item) => item.planId === plan.id && item.status === "failed") ? "failed" : "completed", now, permit);
      }
      snapshot = this.snapshots.load(task.id);
      const settlements = snapshot.toolRuns.filter((item) => item.status === "unknown" && item.mode === "write")
        .map((item) => resolveUnknownWriteSettlement(snapshot, item.id, this.payloadStore));
      if (settlements.includes("state_inconsistent")) throw conflict("RECOVERY_REVIEW_STATE_INCONSISTENT");
      if (snapshot.task.cancelRequestedAt !== null) {
        convergeReviewedCancelInCurrentTransaction(this.database, snapshot, this.payloadStore, permit, now);
        snapshot = this.snapshots.load(task.id);
      }
      const terminalEligible = settlements.every((item) => item !== "open_unknown") &&
        snapshot.recoveryReviews.every((item) => !["pending", "unresolved"].includes(item.status)) &&
        snapshot.planSteps.every((item) => ["completed", "failed", "skipped", "cancelled"].includes(item.status)) &&
        snapshot.toolRuns.every((item) => !["queued", "awaiting_approval", "running", "interrupted"].includes(item.status)) &&
        !snapshot.approvals.some((item) => item.status === "pending");
      if (terminalEligible && snapshot.task.pauseRequestedAt === null) {
        const outcome = snapshot.task.cancelRequestedAt !== null ? "cancelled" :
          settlements.includes("resolved_not_executed") || snapshot.planSteps.some((item) => item.status === "failed")
            ? "failed" : "completed";
        const converged = this.machine.transitionTaskFinalConvergenceInCurrentTransaction({
          ...ownership, expectedTaskVersion: snapshot.task.version, status: outcome,
          capability: createFinalConvergenceCapability(),
        }, permit);
        lastEventSequence = converged.eventSequence;
      }
      snapshot = this.snapshots.load(task.id);
      this.checkpoints.append({ taskId: task.id, reason: "recovery_review_final_decision",
        taskStatus: snapshot.task.status, lastMessageSequence: snapshot.messages.at(-1)?.sequence ?? 0,
        modelIteration: snapshot.task.currentIteration, planVersion: plan?.version ?? null,
        lastEventSequence,
        budget: { maxModelTurns: task.maxModelTurns, maxToolCalls: task.maxToolCalls },
        metadata: { operationId, requestKey: identity.requestKey, decision: input.operation } }, now, permit);
      return { state: "applied", operation, snapshot: this.snapshots.load(task.id) };
    }, "immediate");
  }
}

function conflict(code: string): AppError {
  return new AppError({ code, message: "Final recovery review state is not eligible.", statusCode: 409, details: [] });
}
