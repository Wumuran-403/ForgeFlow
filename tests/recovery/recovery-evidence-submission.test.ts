import { fork, type ChildProcess } from "node:child_process";
import {
  existsSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileEvidencePayloadStore,
  RecoveryEvidenceAvailabilityAuditSchema,
  RecoveryManager,
  buildRecoveryEvidenceEnvelope,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeRecoveryEvidenceEnvelopeDigest,
  computeRecoveryReviewOperationRequestKey,
  computeUnresolvedOperationPayloadDigest,
  evidenceOperationActorId,
  type MarkRecoveryReviewUnresolvedInput,
  type SubmitRecoveryEvidenceInput,
  type EvidencePayloadStore,
} from "../../src/recovery/index.js";
import { RecoveryReviewDecisionService } from "../../src/recovery/recovery-review-decision-service.js";
import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";
import {
  createRecoveryReviewFixture,
  reviewOperationTimestamp,
  type RecoveryReviewFixture,
} from "./review-operation-fixture.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
let evidenceStore: EvidencePayloadStore | undefined;
const workers: ChildProcess[] = [];
const WORKER_TIMEOUT_MS = 15_000;
const workerPath = fileURLToPath(
  new URL("./evidence-submission-worker.ts", import.meta.url),
);

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  evidenceStore = new FileEvidencePayloadStore(
    join(temporaryDatabase.directory, "evidence"),
  );
});

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.connected) {
      worker.disconnect();
    }
    if (!worker.killed) {
      worker.kill();
    }
  }
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
  evidenceStore = undefined;
  vi.restoreAllMocks();
});

describe("recovery evidence submission and unresolved", () => {
  it("persists manual evidence as unverified without changing execution state", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "manual");
    const before = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    const input = createSubmission(activeDatabase, fixture, {
      secretContent: "MANUAL_EVIDENCE_SECRET",
    });
    const result = await createManager(activeDatabase).submitRecoveryEvidence(
      input,
      "evidence-worker",
    );

    expect(result).toMatchObject({
      replayed: false,
      operation: {
        operation: "submit_evidence",
        status: "applied",
        expectedDecisionVersion: 0,
        resultingDecisionVersion: 1,
        evidenceEnvelopeDigest:
          computeRecoveryEvidenceEnvelopeDigest(
            buildRecoveryEvidenceEnvelope(
              input,
              reviewOperationTimestamp,
            ),
          ),
      },
    });
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]).toMatchObject({
      status: "pending",
      sourceType: "manual_review",
      actorId: "reviewer-host",
      verifierId: null,
      verificationId: null,
      reviewProtocolVersion: 1,
      decisionVersion: 1,
      evidencePayloadType: "json",
      evidenceDigestProtocol: "jcs-sha256-v1",
      verifiedAt: null,
    });
    expect(snapshot.task.status).toBe(before.task.status);
    expect(snapshot.planSteps[0]?.status).toBe("waiting_review");
    expect(snapshot.toolRuns[0]).toMatchObject({
      status: "unknown",
      output: null,
    });
    expect(snapshot.messages).toEqual(before.messages);
    const event = snapshot.events.find(
      (candidate) => candidate.type === "recovery.evidence.submitted",
    );
    const manifest = snapshot.recoveryEvidenceSubmissions[0];
    expect(manifest).toMatchObject({
      id: result.evidenceSubmission?.id,
      reviewId: fixture.reviewId,
      toolRunId: fixture.toolRunId,
      operationId: result.operation.id,
      requestKey: input.requestKey,
      evidenceRef: "audit://evidence/1",
      sourceObservedAt: reviewOperationTimestamp,
      payloadStorageMode: "content_addressed_file",
      appliedEventId: result.operation.appliedEventId,
    });
    expect(manifest?.payloadStoreRef).toMatch(/^evidence-file:sha256\//);
    expect(event?.payload).toMatchObject({
      evidenceSubmissionId: manifest?.id,
      evidenceRef: "audit://evidence/1",
      sourceObservedAt: reviewOperationTimestamp,
      submittedAt: reviewOperationTimestamp,
      trustStatus: "unverified",
      finalEligible: false,
      sourceType: "manual_review",
      outcome: "observed_succeeded",
      actorId: "reviewer-host",
    });
    expect(JSON.stringify(event)).not.toContain("MANUAL_EVIDENCE_SECRET");
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) =>
          checkpoint.reason === "recovery_evidence_submitted",
      ),
    ).toHaveLength(1);
  });

  it("supports structurally valid system verification evidence", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "system");
    const input = createSubmission(activeDatabase, fixture, {
      host: {
        sourceType: "system_verification",
        verifierId: "ledger-verifier",
        verificationId: "verification-1",
      },
    });

    await createManager(activeDatabase).submitRecoveryEvidence(
      input,
      "evidence-worker",
    );
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]).toMatchObject({
      sourceType: "system_verification",
      actorId: null,
      verifierId: "ledger-verifier",
      verificationId: "verification-1",
    });
    expect(snapshot.recoveryReviewOperations[0]).toMatchObject({
      operation: "submit_evidence",
      actorId: "ledger-verifier",
    });
  });

  it("rejects invalid host identity, binding, and payload digest", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "invalid");
    const manager = createManager(activeDatabase);
    const valid = createSubmission(activeDatabase, fixture);

    await expect(
      manager.submitRecoveryEvidence(
        {
          ...valid,
          host: {
            sourceType: "system_verification",
            actorId: "model-supplied",
            verifierId: "verifier",
            verificationId: "verification",
          },
        } as never,
        "worker-invalid-host",
      ),
    ).rejects.toThrow();

    const wrongTask = finalizeSubmission({
      ...valid,
      taskId: "task-other",
    });
    await expect(
      manager.submitRecoveryEvidence(
        wrongTask,
        "worker-wrong-task",
      ),
    ).rejects.toMatchObject({
      code: "TASK_NOT_FOUND",
    });

    for (const bindingOverride of [
      { toolName: "different.tool" },
      { toolVersion: "9" },
      { inputSchemaHash: digest("8") },
      { canonicalInputHash: digest("8") },
      { idempotencyKey: digest("8") },
    ]) {
      const wrongBinding = finalizeSubmission({
        ...valid,
        binding: {
          ...valid.binding,
          ...bindingOverride,
        },
      });
      await expect(
        manager.submitRecoveryEvidence(
          wrongBinding,
          "worker-wrong-binding",
        ),
      ).rejects.toMatchObject({
        code: "RECOVERY_EVIDENCE_BINDING_MISMATCH",
      });
    }

    const wrongDigestBase = finalizeSubmission({
      ...valid,
      payload: {
        ...valid.payload,
        payloadDigest: digest("9"),
      },
    });
    await expect(
      manager.submitRecoveryEvidence(
        wrongDigestBase,
        "worker-wrong-digest",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_PAYLOAD_DIGEST_MISMATCH",
    });
  });

  it("accepts external references only as unverified evidence", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "external");
    const input = createSubmission(activeDatabase, fixture, {
      payload: {
        payloadType: "external_reference",
        payloadDigestProtocol: "adapter-content-sha256-v1",
        payloadContent: null,
        payloadDigest: digest("e"),
        resourceRef: "adapter://ledger/write-1",
        resourceVersion: "etag-1",
      },
    });
    await createManager(activeDatabase).submitRecoveryEvidence(
      input,
      "evidence-worker",
    );
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(
      snapshot.events.find(
        (event) => event.type === "recovery.evidence.submitted",
      )?.payload,
    ).toMatchObject({
      trustStatus: "unverified",
      finalEligible: false,
      trustReason: "external_adapter_not_executed",
    });
    expect(snapshot.recoveryEvidenceSubmissions[0]).toMatchObject({
      payloadType: "external_reference",
      payloadStorageMode: "reference_only",
      payloadStoreRef: null,
      resourceRef: "adapter://ledger/write-1",
      resourceVersion: "etag-1",
    });
  });

  it("stores raw and JSON payloads immutably and detects replacement or loss", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "payload-store");
    const manager = createManager(activeDatabase);
    const rawBytes = Buffer.from("raw evidence bytes", "utf8");
    const rawDigest = computeRawPayloadDigest(rawBytes);
    const rawInput = createSubmission(activeDatabase, fixture, {
      payload: {
        evidenceRef: "audit://evidence/raw",
        payloadType: "raw_bytes",
        payloadDigestProtocol: "sha256-raw-v1",
        payloadContent: rawBytes.toString("base64"),
        payloadDigest: rawDigest,
      },
    });
    await manager.submitRecoveryEvidence(rawInput, "worker-raw");
    const jsonInput = createSubmission(activeDatabase, fixture, {
      expectedDecisionVersion: 1,
      payload: {
        evidenceRef: "audit://evidence/json",
        resourceRef: "resource://json",
        resourceVersion: "json-v1",
        sourceObservedAt: "2026-01-01T00:00:01.000Z",
      },
    });
    await manager.submitRecoveryEvidence(jsonInput, "worker-json");
    let snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    const rawManifest = snapshot.recoveryEvidenceSubmissions[0];
    const jsonManifest = snapshot.recoveryEvidenceSubmissions[1];
    expect(rawManifest?.payloadStorageMode).toBe("content_addressed_file");
    expect(jsonManifest?.payloadStorageMode).toBe("content_addressed_file");
    expect(
      (evidenceStore as EvidencePayloadStore).read(
        rawManifest?.payloadStoreRef as string,
        rawDigest,
      ),
    ).toEqual(rawBytes);
    expect(
      new TextDecoder().decode(
        (evidenceStore as EvidencePayloadStore).read(
          jsonManifest?.payloadStoreRef as string,
          jsonManifest?.payloadDigest as string,
        ),
      ),
    ).toContain('"receipt":"receipt-1"');

    const duplicate = (evidenceStore as FileEvidencePayloadStore).put(
      rawBytes,
      rawDigest,
    );
    expect(duplicate.storeRef).toBe(rawManifest?.payloadStoreRef);

    const rawPath = storedPayloadPath(rawDigest);
    writeFileSync(rawPath, Buffer.from("replaced"));
    expect(() =>
      (evidenceStore as EvidencePayloadStore).read(
        rawManifest?.payloadStoreRef as string,
        rawDigest,
      ),
    ).toThrowError(/digest/i);

    rmSync(storedPayloadPath(jsonManifest?.payloadDigest as string));
    expect(() =>
      (evidenceStore as EvidencePayloadStore).read(
        jsonManifest?.payloadStoreRef as string,
        jsonManifest?.payloadDigest as string,
      ),
    ).toThrow();

    expect(
      RecoveryEvidenceAvailabilityAuditSchema.parse({
        evidenceSubmissionId: jsonManifest?.id,
        status: "unavailable",
        checkedAt: "2026-01-01T00:00:04.000Z",
        expectedDigest: jsonManifest?.payloadDigest,
        observedDigest: null,
        reason: "payload file is missing",
      }),
    ).toMatchObject({ status: "unavailable" });
  });

  it("does not create a manifest when Payload Store writes fail", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "store-fail");
    const failingStore: EvidencePayloadStore = {
      put: () => {
        throw new Error("payload store unavailable");
      },
      read: () => {
        throw new Error("payload store unavailable");
      },
    };
    const manager = new RecoveryManager({
      database: activeDatabase,
      leaseManager: new TaskLeaseManager(activeDatabase, {
        now: () => new Date(reviewOperationTimestamp),
      }),
      heartbeatIntervalMs: 1_000,
      now: () => new Date(reviewOperationTimestamp),
      evidencePayloadStore: failingStore,
    });

    await expect(
      manager.submitRecoveryEvidence(
        createSubmission(activeDatabase, fixture),
        "evidence-worker",
      ),
    ).rejects.toThrow("payload store unavailable");
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
    expect(snapshot.recoveryEvidenceSubmissions).toHaveLength(0);
  });

  it("replays evidence submissions without duplicate audit writes", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "replay");
    const manager = createManager(activeDatabase);
    const input = createSubmission(activeDatabase, fixture);
    const first = await manager.submitRecoveryEvidence(
      input,
      "worker-first",
    );
    const second = await manager.submitRecoveryEvidence(
      input,
      "worker-second",
    );

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      replayed: true,
      operation: { id: first.operation.id },
    });
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    expect(snapshot.recoveryEvidenceSubmissions).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.evidence.submitted",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) =>
          checkpoint.reason === "recovery_evidence_submitted",
      ),
    ).toHaveLength(1);
  });

  it("replays evidence before Task Version CAS and still enforces current fencing", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "replay-stale");
    const leaseManager = new TaskLeaseManager(activeDatabase, {
      now: () => new Date(reviewOperationTimestamp),
    });
    const input = createSubmission(activeDatabase, fixture);
    const oldLease = leaseManager.claim(fixture.taskId, "worker-old");
    const oldTaskVersion = new TaskSnapshotReader(
      activeDatabase,
    ).load(fixture.taskId).task.version;
    const service = new RecoveryReviewDecisionService(
      activeDatabase,
      leaseManager,
      evidenceStore as EvidencePayloadStore,
    );
    const first = service.submitEvidenceOwned(
      input,
      {
        taskId: fixture.taskId,
        leaseToken: oldLease.leaseToken as string,
        fencingToken: oldLease.fencingToken,
      },
      oldTaskVersion,
      reviewOperationTimestamp,
    );
    expect(first.replayed).toBe(false);
    leaseManager.release(
      fixture.taskId,
      oldLease.leaseToken as string,
      oldLease.fencingToken,
    );
    const newLease = leaseManager.claim(fixture.taskId, "worker-new");

    expect(() =>
      service.submitEvidenceOwned(
        input,
        {
          taskId: fixture.taskId,
          leaseToken: oldLease.leaseToken as string,
          fencingToken: oldLease.fencingToken,
        },
        oldTaskVersion,
        reviewOperationTimestamp,
      ),
    ).toThrowError(/ownership/i);

    const replay = service.submitEvidenceOwned(
      input,
      {
        taskId: fixture.taskId,
        leaseToken: newLease.leaseToken as string,
        fencingToken: newLease.fencingToken,
      },
      oldTaskVersion,
      reviewOperationTimestamp,
    );
    expect(replay).toMatchObject({
      replayed: true,
      operation: { id: first.operation.id },
    });
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    leaseManager.release(
      fixture.taskId,
      newLease.leaseToken as string,
      newLease.fencingToken,
    );
  });

  it("rejects reuse of a requestKey with different evidence content", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "same-key");
    const manager = createManager(activeDatabase);
    const original = createSubmission(activeDatabase, fixture);
    await manager.submitRecoveryEvidence(original, "worker-original");
    const different = finalizeSubmission({
      ...original,
      payload: {
        ...original.payload,
        payloadContent: {
          receipt: "different",
          accepted: true,
        },
        payloadDigest: computeJsonPayloadDigest({
          receipt: "different",
          accepted: true,
        }),
      },
    });

    await expect(
      manager.submitRecoveryEvidence(
        { ...different, requestKey: original.requestKey },
        "worker-reuse",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
    });
  });

  it(
    "allows only one concurrent evidence submission for the same version",
    async () => {
      const activeDatabase = database as ForgeFlowDatabase;
      const fixture = createRecoveryReviewFixture(
        activeDatabase,
        "concurrent",
      );
      const leaseManager = new TaskLeaseManager(activeDatabase, {
        now: () => new Date(reviewOperationTimestamp),
      });
      const lease = leaseManager.claim(fixture.taskId, "lease-holder");
      const expectedTaskVersion = new TaskSnapshotReader(
        activeDatabase,
      ).load(fixture.taskId).task.version;
      const ownership = {
        taskId: fixture.taskId,
        leaseToken: lease.leaseToken as string,
        fencingToken: lease.fencingToken,
      };
      const firstInput = createSubmission(activeDatabase, fixture, {
        host: {
          sourceType: "manual_review",
          actorId: "reviewer-a",
        },
      });
      const secondInput = createSubmission(activeDatabase, fixture, {
        host: {
          sourceType: "manual_review",
          actorId: "reviewer-b",
        },
      });
      const firstWorker = await startWorker({
        databasePath: temporaryDatabase?.path as string,
        evidenceStorePath: join(temporaryDatabase?.directory as string, "evidence"),
        now: reviewOperationTimestamp,
        ownership,
        expectedTaskVersion,
        submittedAt: reviewOperationTimestamp,
        input: firstInput,
      });
      const secondWorker = await startWorker({
        databasePath: temporaryDatabase?.path as string,
        evidenceStorePath: join(temporaryDatabase?.directory as string, "evidence"),
        now: reviewOperationTimestamp,
        ownership,
        expectedTaskVersion,
        submittedAt: reviewOperationTimestamp,
        input: secondInput,
      });
      const firstResult = runWorker(firstWorker);
      const secondResult = runWorker(secondWorker);
      firstWorker.send({ type: "start" });
      secondWorker.send({ type: "start" });
      const results = await Promise.all([firstResult, secondResult]);

      expect(
        results.filter((result) => result.status === "applied"),
      ).toHaveLength(1);
      expect(
        results.filter(
          (result) =>
            result.status === "rejected" &&
            [
              "TASK_STATE_CONFLICT",
              "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            ].includes(result.code),
        ),
      ).toHaveLength(1);
      leaseManager.release(
        fixture.taskId,
        ownership.leaseToken,
        ownership.fencingToken,
      );
      const snapshot = new TaskSnapshotReader(activeDatabase).load(
        fixture.taskId,
      );
      expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
      expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    },
    WORKER_TIMEOUT_MS,
  );

  it("marks pending and unresolved reviews without resuming execution", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "unresolved");
    const manager = createManager(activeDatabase);
    const firstRequest = createUnresolvedRequest(fixture, 0, {
      reason: "No authoritative source yet.",
      referencedEvidenceEnvelopeDigest: null,
    });
    await manager.markRecoveryReviewUnresolved(
      firstRequest,
      "review-worker",
    );
    let snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]).toMatchObject({
      status: "unresolved",
      decisionVersion: 1,
      sourceType: "manual_review",
      actorId: "reviewer-host",
    });
    expect(snapshot.task.status).toBe("waiting_review");
    expect(snapshot.planSteps[0]?.status).toBe("waiting_review");
    expect(snapshot.toolRuns[0]?.status).toBe("unknown");

    const submission = createSubmission(activeDatabase, fixture, {
      expectedDecisionVersion: 1,
    });
    await manager.submitRecoveryEvidence(submission, "evidence-worker");
    snapshot = new TaskSnapshotReader(activeDatabase).load(fixture.taskId);
    const envelopeDigest = snapshot.recoveryReviews[0]
      ?.evidenceEnvelopeDigest as string;
    const secondRequest = createUnresolvedRequest(fixture, 2, {
      reason: "Evidence remains inconclusive.",
      referencedEvidenceEnvelopeDigest: envelopeDigest,
    });
    await manager.markRecoveryReviewUnresolved(
      secondRequest,
      "review-worker",
    );
    const replay = await manager.markRecoveryReviewUnresolved(
      secondRequest,
      "review-worker-replay",
    );
    expect(replay.replayed).toBe(true);
    snapshot = new TaskSnapshotReader(activeDatabase).load(fixture.taskId);
    expect(snapshot.recoveryReviews[0]).toMatchObject({
      status: "unresolved",
      decisionVersion: 3,
      evidenceEnvelopeDigest: envelopeDigest,
    });
    expect(snapshot.task.status).toBe("waiting_review");
    expect(snapshot.planSteps[0]?.status).toBe("waiting_review");
    expect(snapshot.toolRuns[0]?.status).toBe("unknown");
    expect(
      snapshot.recoveryReviewOperations.map(
        (operation) => operation.operation,
      ),
    ).toEqual([
      "mark_unresolved",
      "submit_evidence",
      "mark_unresolved",
    ]);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.review.unresolved",
      ),
    ).toHaveLength(2);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) =>
          checkpoint.reason === "recovery_review_unresolved",
      ),
    ).toHaveLength(2);
  });

  it("retains complete A/B/C evidence history through manifests, operations, and events", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "abc-history");
    const manager = createManager(activeDatabase);
    const submissions = [
      createSubmission(activeDatabase, fixture, {
        expectedDecisionVersion: 0,
        host: {
          sourceType: "manual_review",
          actorId: "reviewer-a",
        },
        payload: {
          evidenceRef: "audit://evidence/A",
          resourceRef: "resource://A",
          resourceVersion: "A-v1",
          sourceObservedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
      createSubmission(activeDatabase, fixture, {
        expectedDecisionVersion: 2,
        host: {
          sourceType: "system_verification",
          verifierId: "verifier-b",
          verificationId: "verification-b",
        },
        payload: {
          evidenceRef: "audit://evidence/B",
          resourceRef: "resource://B",
          resourceVersion: "B-v2",
          sourceObservedAt: "2026-01-01T00:00:02.000Z",
        },
      }),
      createSubmission(activeDatabase, fixture, {
        expectedDecisionVersion: 4,
        host: {
          sourceType: "manual_review",
          actorId: "reviewer-c",
        },
        payload: {
          evidenceRef: "audit://evidence/C",
          resourceRef: "resource://C",
          resourceVersion: "C-v3",
          sourceObservedAt: "2026-01-01T00:00:03.000Z",
        },
      }),
    ] as const;
    const first = await manager.submitRecoveryEvidence(
      submissions[0] as SubmitRecoveryEvidenceInput,
      "worker-a",
    );
    const unresolvedA = createUnresolvedRequest(fixture, 1, {
      reason: "Evidence A remains unresolved.",
      referencedEvidenceEnvelopeDigest:
        first.evidenceSubmission?.envelopeDigest as string,
    });
    await manager.markRecoveryReviewUnresolved(
      unresolvedA,
      "review-worker-a",
    );
    const second = await manager.submitRecoveryEvidence(
      submissions[1] as SubmitRecoveryEvidenceInput,
      "worker-b",
    );
    const unresolvedB = createUnresolvedRequest(fixture, 3, {
      reason: "Evidence B remains unresolved.",
      referencedEvidenceEnvelopeDigest:
        second.evidenceSubmission?.envelopeDigest as string,
    });
    await manager.markRecoveryReviewUnresolved(
      unresolvedB,
      "review-worker-b",
    );
    const third = await manager.submitRecoveryEvidence(
      submissions[2] as SubmitRecoveryEvidenceInput,
      "worker-c",
    );

    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryEvidenceSubmissions).toHaveLength(3);
    expect(
      snapshot.recoveryEvidenceSubmissions.map((manifest) => ({
        decisionVersion: manifest.decisionVersion,
        evidenceRef: manifest.evidenceRef,
        resourceRef: manifest.resourceRef,
        resourceVersion: manifest.resourceVersion,
        sourceObservedAt: manifest.sourceObservedAt,
        actorId: manifest.actorId,
        verifierId: manifest.verifierId,
        payloadDigest: manifest.payloadDigest,
        envelopeDigest: manifest.envelopeDigest,
        requestKey: manifest.requestKey,
      })),
    ).toEqual([
      {
        decisionVersion: 1,
        evidenceRef: "audit://evidence/A",
        resourceRef: "resource://A",
        resourceVersion: "A-v1",
        sourceObservedAt: "2026-01-01T00:00:01.000Z",
        actorId: "reviewer-a",
        verifierId: null,
        payloadDigest: submissions[0].payload.payloadDigest,
        envelopeDigest: first.evidenceSubmission?.envelopeDigest,
        requestKey: submissions[0].requestKey,
      },
      {
        decisionVersion: 3,
        evidenceRef: "audit://evidence/B",
        resourceRef: "resource://B",
        resourceVersion: "B-v2",
        sourceObservedAt: "2026-01-01T00:00:02.000Z",
        actorId: null,
        verifierId: "verifier-b",
        payloadDigest: submissions[1].payload.payloadDigest,
        envelopeDigest: second.evidenceSubmission?.envelopeDigest,
        requestKey: submissions[1].requestKey,
      },
      {
        decisionVersion: 5,
        evidenceRef: "audit://evidence/C",
        resourceRef: "resource://C",
        resourceVersion: "C-v3",
        sourceObservedAt: "2026-01-01T00:00:03.000Z",
        actorId: "reviewer-c",
        verifierId: null,
        payloadDigest: submissions[2].payload.payloadDigest,
        envelopeDigest: third.evidenceSubmission?.envelopeDigest,
        requestKey: submissions[2].requestKey,
      },
    ]);

    for (const manifest of snapshot.recoveryEvidenceSubmissions) {
      const operation = snapshot.recoveryReviewOperations.find(
        (candidate) => candidate.id === manifest.operationId,
      );
      const event = snapshot.events.find(
        (candidate) => candidate.id === manifest.appliedEventId,
      );
      expect(operation).toMatchObject({
        requestKey: manifest.requestKey,
        operation: "submit_evidence",
        appliedEventId: manifest.appliedEventId,
      });
      expect(event?.payload).toMatchObject({
        evidenceSubmissionId: manifest.id,
        evidenceRef: manifest.evidenceRef,
        resourceRef: manifest.resourceRef,
        resourceVersion: manifest.resourceVersion,
        sourceObservedAt: manifest.sourceObservedAt,
        envelopeDigest: manifest.envelopeDigest,
      });
    }
    expect(
      snapshot.events
        .filter((event) => event.type === "recovery.review.unresolved")
        .map((event) => event.payload.reason),
    ).toEqual([
      "Evidence A remains unresolved.",
      "Evidence B remains unresolved.",
    ]);
    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE recovery_evidence_submissions SET evidence_ref = 'changed' WHERE id = ?",
        )
        .run(snapshot.recoveryEvidenceSubmissions[0]?.id),
    ).toThrow(/immutable/);
    expect(() =>
      activeDatabase
        .prepare("DELETE FROM recovery_evidence_submissions WHERE id = ?")
        .run(snapshot.recoveryEvidenceSubmissions[0]?.id),
    ).toThrow(/immutable/);
  });

  it("rejects unresolved references to evidence that was never submitted", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "bad-ref");
    const request = createUnresolvedRequest(fixture, 0, {
      reason: "References missing evidence.",
      referencedEvidenceEnvelopeDigest: digest("f"),
    });

    await expect(
      createManager(activeDatabase).markRecoveryReviewUnresolved(
        request,
        "review-worker",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_UNRESOLVED_EVIDENCE_NOT_FOUND",
    });
  });

  it("rejects Heartbeat revocation and exposes evidence lease release failure", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const heartbeatFixture = createRecoveryReviewFixture(
      activeDatabase,
      "heartbeat",
    );
    const heartbeatLease = new TaskLeaseManager(activeDatabase, {
      now: () => new Date(reviewOperationTimestamp),
    });
    vi.spyOn(heartbeatLease, "heartbeat").mockImplementation(() => {
      throw new Error("heartbeat failed");
    });
    const heartbeatManager = new RecoveryManager({
      database: activeDatabase,
      leaseManager: heartbeatLease,
      heartbeatIntervalMs: 1_000,
      now: () => new Date(reviewOperationTimestamp),
    });
    await expect(
      heartbeatManager.submitRecoveryEvidence(
        createSubmission(activeDatabase, heartbeatFixture),
        "evidence-worker",
      ),
    ).rejects.toMatchObject({
      code: "TASK_LEASE_HEARTBEAT_FAILED",
    });
    let snapshot = new TaskSnapshotReader(activeDatabase).load(
      heartbeatFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);

    vi.restoreAllMocks();
    const releaseFixture = createRecoveryReviewFixture(
      activeDatabase,
      "release",
    );
    const releaseLease = new TaskLeaseManager(activeDatabase, {
      now: () => new Date(reviewOperationTimestamp),
    });
    vi.spyOn(releaseLease, "release").mockImplementation(() => {
      throw new Error("release failed");
    });
    const releaseManager = new RecoveryManager({
      database: activeDatabase,
      leaseManager: releaseLease,
      heartbeatIntervalMs: 1_000,
      now: () => new Date(reviewOperationTimestamp),
    });
    await expect(
      releaseManager.submitRecoveryEvidence(
        createSubmission(activeDatabase, releaseFixture),
        "evidence-worker",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REVIEW_LEASE_RELEASE_FAILED",
    });
    snapshot = new TaskSnapshotReader(activeDatabase).load(
      releaseFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
  });

  it("rejects final reviews and rolls back Event or Checkpoint failures", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const finalFixture = createRecoveryReviewFixture(activeDatabase, "final");
    activeDatabase
      .prepare(
        `
          UPDATE recovery_reviews
          SET status = 'confirmed_succeeded',
              source_type = 'manual_review',
              evidence_ref = 'audit://final',
              decided_at = ?
          WHERE id = ?
        `,
      )
      .run(reviewOperationTimestamp, finalFixture.reviewId);
    const finalInput = createSubmission(activeDatabase, finalFixture);
    await expect(
      createManager(activeDatabase).submitRecoveryEvidence(
        finalInput,
        "evidence-worker",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REVIEW_NOT_ACTIVE",
    });
    await expect(
      createManager(activeDatabase).markRecoveryReviewUnresolved(
        createUnresolvedRequest(finalFixture, 0, {
          reason: "Final reviews cannot become unresolved.",
          referencedEvidenceEnvelopeDigest: null,
        }),
        "review-worker",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REVIEW_NOT_ACTIVE",
    });

    const eventFixture = createRecoveryReviewFixture(
      activeDatabase,
      "event-rollback",
    );
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_evidence_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'recovery.evidence.submitted'
        BEGIN
          SELECT RAISE(ABORT, 'evidence event rejected');
        END
      `,
    );
    await expect(
      createManager(activeDatabase).submitRecoveryEvidence(
        createSubmission(activeDatabase, eventFixture),
        "evidence-worker",
      ),
    ).rejects.toThrow("evidence event rejected");
    let snapshot = new TaskSnapshotReader(activeDatabase).load(
      eventFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
    expect(snapshot.recoveryEvidenceSubmissions).toHaveLength(0);
    activeDatabase.exec("DROP TRIGGER reject_evidence_event");

    const checkpointFixture = createRecoveryReviewFixture(
      activeDatabase,
      "checkpoint-rollback",
    );
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_evidence_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'recovery_evidence_submitted'
        BEGIN
          SELECT RAISE(ABORT, 'evidence checkpoint rejected');
        END
      `,
    );
    const checkpointInput = createSubmission(
      activeDatabase,
      checkpointFixture,
    );
    await expect(
      createManager(activeDatabase).submitRecoveryEvidence(
        checkpointInput,
        "evidence-worker",
      ),
    ).rejects.toThrow("evidence checkpoint rejected");
    snapshot = new TaskSnapshotReader(activeDatabase).load(
      checkpointFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
    expect(snapshot.recoveryEvidenceSubmissions).toHaveLength(0);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.evidence.submitted",
      ),
    ).toHaveLength(0);
    expect(
      existsSync(storedPayloadPath(checkpointInput.payload.payloadDigest)),
    ).toBe(true);
  });
});

interface SubmissionOptions {
  readonly host?:
    | {
        readonly sourceType: "manual_review";
        readonly actorId: string;
      }
    | {
        readonly sourceType: "system_verification";
        readonly verifierId: string;
        readonly verificationId: string;
      };
  readonly payload?: Partial<SubmitRecoveryEvidenceInput["payload"]>;
  readonly secretContent?: string;
  readonly submittedAt?: string;
  readonly expectedDecisionVersion?: number;
}

function createSubmission(
  database: ForgeFlowDatabase,
  fixture: RecoveryReviewFixture,
  options: SubmissionOptions = {},
): SubmitRecoveryEvidenceInput {
  const toolRun = new TaskSnapshotReader(database)
    .load(fixture.taskId)
    .toolRuns.find((candidate) => candidate.id === fixture.toolRunId);
  if (toolRun === undefined) {
    throw new Error("Fixture ToolRun is missing.");
  }
  const payloadContent = {
    receipt: options.secretContent ?? "receipt-1",
    accepted: true,
  };
  const base: SubmitRecoveryEvidenceInput = {
    taskId: fixture.taskId,
    reviewId: fixture.reviewId,
    expectedDecisionVersion: options.expectedDecisionVersion ?? 0,
    binding: {
      toolRunId: toolRun.id,
      toolName: toolRun.toolName,
      toolVersion: toolRun.toolVersion,
      inputSchemaHash: toolRun.inputSchemaHash,
      canonicalInputHash: toolRun.canonicalInputHash,
      idempotencyKey: toolRun.idempotencyKey,
    },
    host: options.host ?? {
      sourceType: "manual_review",
      actorId: "reviewer-host",
    },
    payload: {
      evidenceRef: "audit://evidence/1",
      outcome: "observed_succeeded",
      sourceObservedAt: reviewOperationTimestamp,
      resourceRef: null,
      resourceVersion: null,
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadContent,
      payloadDigest: computeJsonPayloadDigest(payloadContent),
      redactedSummary: "External receipt accepted.",
      ...options.payload,
    },
    requestKey: digest("0"),
  };
  return finalizeSubmission(base, options.submittedAt);
}

function finalizeSubmission(
  input: SubmitRecoveryEvidenceInput,
  submittedAt = reviewOperationTimestamp,
): SubmitRecoveryEvidenceInput {
  const envelope = buildRecoveryEvidenceEnvelope(input, submittedAt);
  const envelopeDigest =
    computeRecoveryEvidenceEnvelopeDigest(envelope);
  const actorId = evidenceOperationActorId(envelope);
  return {
    ...input,
    requestKey: computeRecoveryReviewOperationRequestKey({
      reviewId: input.reviewId,
      expectedDecisionVersion: input.expectedDecisionVersion,
      operation: "submit_evidence",
      operationPayloadDigest: envelopeDigest,
      actorId,
    }),
  };
}

function createUnresolvedRequest(
  fixture: RecoveryReviewFixture,
  expectedDecisionVersion: number,
  input: {
    readonly reason: string;
    readonly referencedEvidenceEnvelopeDigest: string | null;
  },
): MarkRecoveryReviewUnresolvedInput {
  const actorId = "reviewer-host";
  const operationPayloadDigest =
    computeUnresolvedOperationPayloadDigest(input);
  return {
    taskId: fixture.taskId,
    reviewId: fixture.reviewId,
    expectedDecisionVersion,
    actorId,
    reason: input.reason,
    referencedEvidenceEnvelopeDigest:
      input.referencedEvidenceEnvelopeDigest,
    requestKey: computeRecoveryReviewOperationRequestKey({
      reviewId: fixture.reviewId,
      expectedDecisionVersion,
      operation: "mark_unresolved",
      operationPayloadDigest,
      actorId,
    }),
  };
}

function createManager(database: ForgeFlowDatabase): RecoveryManager {
  return new RecoveryManager({
    database,
    leaseManager: new TaskLeaseManager(database, {
      now: () => new Date(reviewOperationTimestamp),
    }),
    heartbeatIntervalMs: 1_000,
    now: () => new Date(reviewOperationTimestamp),
    evidencePayloadStore: evidenceStore as EvidencePayloadStore,
  });
}

interface WorkerConfig {
  readonly databasePath: string;
  readonly evidenceStorePath: string;
  readonly now: string;
  readonly ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  };
  readonly expectedTaskVersion: number;
  readonly submittedAt: string;
  readonly input: SubmitRecoveryEvidenceInput;
}

type WorkerResult =
  | { readonly status: "applied"; readonly replayed: boolean }
  | { readonly status: "rejected"; readonly code: string };

function startWorker(config: WorkerConfig): Promise<ChildProcess> {
  const worker = fork(
    workerPath,
    [JSON.stringify(config)],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  workers.push(worker);

  let stderr = "";
  worker.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Evidence submission worker did not become ready.\n${stderr}`,
        ),
      );
    }, WORKER_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
      ) {
        cleanup();
        resolve(worker);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `Evidence submission worker exited early (${String(code)}).\n${stderr}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

function runWorker(worker: ChildProcess): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Evidence submission worker timed out."));
    }, WORKER_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
      cleanup();
      resolve(message as WorkerResult);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `Evidence submission worker exited without a result (${String(code)}).`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function storedPayloadPath(digestValue: string): string {
  return join(
    temporaryDatabase?.directory as string,
    "evidence",
    `${digestValue.slice("sha256:".length)}.bin`,
  );
}
