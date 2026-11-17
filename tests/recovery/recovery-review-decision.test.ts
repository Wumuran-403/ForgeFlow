import { fork, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ExecutionAuthority,
} from "../../src/persistence/index.js";
import {
  FileEvidencePayloadStore,
  RecoveryManager,
  computeRecoveryReviewOperationPayloadDigest,
  computeRecoveryReviewOperationRequestKey,
} from "../../src/recovery/index.js";
import { RECOVERY_REVIEW_INTERNAL_TEST_OPERATION } from "../../src/recovery/recovery-manager.js";
import { RecoveryReviewDecisionService } from "../../src/recovery/recovery-review-decision-service.js";
import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
  type JsonValue,
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
const workers: ChildProcess[] = [];
const WORKER_TIMEOUT_MS = 15_000;
const workerPath = fileURLToPath(
  new URL("./review-operation-worker.ts", import.meta.url),
);

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
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
  vi.restoreAllMocks();
});

describe("lease-owned recovery review decision core", () => {
  it("commits only the neutral decision revision and its audit records", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "success");
    const manager = createManager(activeDatabase);
    const request = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "lease-owned-core" },
    );

    const result = await commitReviewOperation(
      manager,
      { ...request, taskId: fixture.taskId },
      "review-worker",
    );

    expect(result).toMatchObject({
      replayed: false,
      operation: {
        taskId: fixture.taskId,
        reviewId: fixture.reviewId,
        operation: "advance_decision_version",
        expectedDecisionVersion: 0,
        resultingDecisionVersion: 1,
        status: "applied",
        actorId: "actor-host",
        operationPayloadDigest: computeRecoveryReviewOperationPayloadDigest(
          { reason: "lease-owned-core" },
        ),
      },
    });

    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]).toMatchObject({
      status: "pending",
      decisionVersion: 1,
    });
    expect(snapshot.planSteps[0]?.status).toBe("waiting_review");
    expect(snapshot.toolRuns[0]?.status).toBe("unknown");
    expect(snapshot.task.status).toBe("waiting_review");
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.review_operation.applied",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) => checkpoint.reason === "recovery_review_operation",
      ),
    ).toHaveLength(1);
    expect(snapshot.lease).toMatchObject({
      ownerId: null,
      leaseToken: null,
    });
  });

  it("replays the same request without duplicating operation, Event, or Checkpoint", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "replay");
    const manager = createManager(activeDatabase);
    const request = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "same-request" },
    );

    const first = await commitReviewOperation(
      manager,
      { ...request, taskId: fixture.taskId },
      "worker-first",
    );
    const second = await commitReviewOperation(
      manager,
      { ...request, taskId: fixture.taskId },
      "worker-second",
    );

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      replayed: true,
      operation: {
        id: first.operation.id,
        resultingDecisionVersion: 1,
      },
    });
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.review_operation.applied",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) => checkpoint.reason === "recovery_review_operation",
      ),
    ).toHaveLength(1);
  });

  it("rejects payload mismatch and stale decision-version CAS without partial writes", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "conflict");
    const manager = createManager(activeDatabase);
    const first = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "first" },
    );

    await commitReviewOperation(
      manager,
      { ...first, taskId: fixture.taskId },
      "worker-first",
    );

    await expect(
      commitReviewOperation(
        manager,
        {
          ...first,
          taskId: fixture.taskId,
          operationPayload: { reason: "different" },
        },
        "worker-mismatch",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
    });

    const stale = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "second" },
      0,
    );
    await expect(
      commitReviewOperation(
        manager,
        { ...stale, taskId: fixture.taskId },
        "worker-stale",
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
    });

    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.review_operation.applied",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) => checkpoint.reason === "recovery_review_operation",
      ),
    ).toHaveLength(1);
  });

  it("recognizes an applied request after reopening the database", async () => {
    const initialDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(initialDatabase, "restart");
    const request = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "restart" },
    );
    const first = await commitReviewOperation(
      createManager(initialDatabase),
        { ...request, taskId: fixture.taskId },
        "worker-first",
    );
    expect(first.replayed).toBe(false);

    closeDatabase(initialDatabase);
    database = openDatabase(temporaryDatabase?.path as string);
    const restartedDatabase = database;
    const replay = await commitReviewOperation(
      createManager(restartedDatabase),
        { ...request, taskId: fixture.taskId },
        "worker-restarted",
    );

    expect(replay).toMatchObject({
      replayed: true,
      operation: { id: first.operation.id },
    });
    const snapshot = new TaskSnapshotReader(restartedDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.review_operation.applied",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) => checkpoint.reason === "recovery_review_operation",
      ),
    ).toHaveLength(1);
  });

  it("replays before Task Version CAS after later legal Task changes", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(
      activeDatabase,
      "replay-after-version-growth",
    );
    const leaseManager = new TaskLeaseManager(activeDatabase, {
      now: () => new Date(reviewOperationTimestamp),
    });
    const request = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "replay-after-growth" },
    );
    const originalLease = leaseManager.claim(
      fixture.taskId,
      "original-worker",
    );
    const originalTaskVersion = new TaskSnapshotReader(
      activeDatabase,
    ).load(fixture.taskId).task.version;
    const service = createDecisionService(activeDatabase, leaseManager);
    const first = service.commitOwned(
      request,
      {
        taskId: fixture.taskId,
        leaseToken: originalLease.leaseToken as string,
        fencingToken: originalLease.fencingToken,
      },
      originalTaskVersion,
    );
    expect(first.replayed).toBe(false);
    leaseManager.release(
      fixture.taskId,
      originalLease.leaseToken as string,
      originalLease.fencingToken,
    );
    const operationEventCount = countEvents(
      activeDatabase,
      fixture.taskId,
    );
    const operationCheckpointCount = countCheckpoints(
      activeDatabase,
      fixture.taskId,
    );

    const growthLease = leaseManager.claim(
      fixture.taskId,
      "version-growth-worker",
    );
    leaseManager.release(
      fixture.taskId,
      growthLease.leaseToken as string,
      growthLease.fencingToken,
    );
    const replayLease = leaseManager.claim(
      fixture.taskId,
      "replay-worker",
    );
    const replay = service.commitOwned(
      request,
      {
        taskId: fixture.taskId,
        leaseToken: replayLease.leaseToken as string,
        fencingToken: replayLease.fencingToken,
      },
      originalTaskVersion,
    );

    expect(replay).toMatchObject({
      replayed: true,
      operation: { id: first.operation.id },
    });
    expect(countEvents(activeDatabase, fixture.taskId)).toBe(
      operationEventCount,
    );
    expect(countCheckpoints(activeDatabase, fixture.taskId)).toBe(
      operationCheckpointCount,
    );
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(1);
    expect(snapshot.recoveryReviewOperations).toHaveLength(1);
    leaseManager.release(
      fixture.taskId,
      replayLease.leaseToken as string,
      replayLease.fencingToken,
    );
  });

  it("rejects stale Lease replay and lets the replacement owner replay", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(
      activeDatabase,
      "replay-lease-replacement",
    );
    const leaseManager = new TaskLeaseManager(activeDatabase, {
      now: () => new Date(reviewOperationTimestamp),
    });
    const request = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "lease-replacement" },
    );
    const oldLease = leaseManager.claim(fixture.taskId, "worker-old");
    const oldTaskVersion = new TaskSnapshotReader(
      activeDatabase,
    ).load(fixture.taskId).task.version;
    const service = createDecisionService(activeDatabase, leaseManager);
    const first = service.commitOwned(
      request,
      {
        taskId: fixture.taskId,
        leaseToken: oldLease.leaseToken as string,
        fencingToken: oldLease.fencingToken,
      },
      oldTaskVersion,
    );
    expect(first.replayed).toBe(false);
    leaseManager.release(
      fixture.taskId,
      oldLease.leaseToken as string,
      oldLease.fencingToken,
    );
    const newLease = leaseManager.claim(fixture.taskId, "worker-new");

    expect(() =>
      service.commitOwned(
        request,
        {
          taskId: fixture.taskId,
          leaseToken: oldLease.leaseToken as string,
          fencingToken: oldLease.fencingToken,
        },
        oldTaskVersion,
      ),
    ).toThrowError(/ownership/i);

    const replay = service.commitOwned(
      request,
      {
        taskId: fixture.taskId,
        leaseToken: newLease.leaseToken as string,
        fencingToken: newLease.fencingToken,
      },
      oldTaskVersion,
    );
    expect(replay).toMatchObject({
      replayed: true,
      operation: { id: first.operation.id },
    });
    leaseManager.release(
      fixture.taskId,
      newLease.leaseToken as string,
      newLease.fencingToken,
    );
  });

  it("rejects missing, expired, stale-fenced, and revoked ownership", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createRecoveryReviewFixture(activeDatabase, "ownership");
    const request = createReviewOperationRequest(
      fixture,
      "actor-host",
      { reason: "ownership" },
    );
    let nowMs = Date.parse(reviewOperationTimestamp);
    const leaseManager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 1_000,
      now: () => new Date(nowMs),
    });
    const decisionService = createDecisionService(
      activeDatabase,
      leaseManager,
    );
    expect(() =>
      decisionService.commitOwned(
        request,
        {
          taskId: fixture.taskId,
          leaseToken: "missing-lease",
          fencingToken: 1,
        },
        fixture.taskVersion,
      ),
    ).toThrowError(/ownership/i);

    const expiring = leaseManager.claim(fixture.taskId, "worker-expiring");
    const expiringTaskVersion = new TaskSnapshotReader(
      activeDatabase,
    ).load(fixture.taskId).task.version;
    nowMs += 1_001;
    expect(() =>
      decisionService.commitOwned(
        request,
        {
          taskId: fixture.taskId,
          leaseToken: expiring.leaseToken as string,
          fencingToken: expiring.fencingToken,
        },
        expiringTaskVersion,
      ),
    ).toThrowError(/ownership/i);

    nowMs += 10_000;
    const oldLease = leaseManager.claim(fixture.taskId, "worker-old");
    leaseManager.release(
      fixture.taskId,
      oldLease.leaseToken as string,
      oldLease.fencingToken,
    );
    const newLease = leaseManager.claim(fixture.taskId, "worker-new");
    const newTaskVersion = new TaskSnapshotReader(
      activeDatabase,
    ).load(fixture.taskId).task.version;
    expect(() =>
      decisionService.commitOwned(
        request,
        {
          taskId: fixture.taskId,
          leaseToken: oldLease.leaseToken as string,
          fencingToken: oldLease.fencingToken,
        },
        newTaskVersion,
      ),
    ).toThrowError(/ownership/i);
    expect(() =>
      leaseManager.release(
        fixture.taskId,
        oldLease.leaseToken as string,
        oldLease.fencingToken,
      ),
    ).toThrowError(/ownership/i);
    expect(
      new TaskSnapshotReader(activeDatabase).load(fixture.taskId).lease,
    ).toMatchObject({
      ownerId: "worker-new",
      leaseToken: newLease.leaseToken,
      fencingToken: newLease.fencingToken,
    });

    const authority = new ExecutionAuthority();
    authority.revoke(new Error("local authority revoked"));
    expect(() =>
      decisionService.commitOwned(
        request,
        {
          taskId: fixture.taskId,
          leaseToken: newLease.leaseToken as string,
          fencingToken: newLease.fencingToken,
        },
        newTaskVersion,
        () => authority.assertActive(),
      ),
    ).toThrowError(/authority/i);

    leaseManager.release(
      fixture.taskId,
      newLease.leaseToken as string,
      newLease.fencingToken,
    );
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
  });

  it(
    "allows only one of two independent connections to win the same version",
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
      const firstRequest = createReviewOperationRequest(
        fixture,
        "actor-a",
        { reason: "worker-a" },
      );
      const secondRequest = createReviewOperationRequest(
        fixture,
        "actor-b",
        { reason: "worker-b" },
      );
      const firstWorker = await startWorker({
        databasePath: temporaryDatabase?.path as string,
        now: reviewOperationTimestamp,
        ownership,
        expectedTaskVersion,
        reviewId: fixture.reviewId,
        expectedDecisionVersion: 0,
        actorId: firstRequest.actorId,
        operationPayload: firstRequest.operationPayload,
        requestKey: firstRequest.requestKey,
      });
      const secondWorker = await startWorker({
        databasePath: temporaryDatabase?.path as string,
        now: reviewOperationTimestamp,
        ownership,
        expectedTaskVersion,
        reviewId: fixture.reviewId,
        expectedDecisionVersion: 0,
        actorId: secondRequest.actorId,
        operationPayload: secondRequest.operationPayload,
        requestKey: secondRequest.requestKey,
      });
      const firstResult = runWorker(firstWorker);
      const secondResult = runWorker(secondWorker);
      firstWorker.send({ type: "start" });
      secondWorker.send({ type: "start" });
      const results = await Promise.all([
        firstResult,
        secondResult,
      ]);
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
      expect(
        snapshot.events.filter(
          (event) =>
            event.type === "recovery.review_operation.applied",
        ),
      ).toHaveLength(1);
      expect(
        snapshot.checkpoints.filter(
          (checkpoint) =>
            checkpoint.reason === "recovery_review_operation",
        ),
      ).toHaveLength(1);
    },
    WORKER_TIMEOUT_MS,
  );

  it("does not commit after Heartbeat failure and surfaces release failure", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const heartbeatFixture = createRecoveryReviewFixture(
      activeDatabase,
      "heartbeat",
    );
    const heartbeatLease = new TaskLeaseManager(activeDatabase);
    vi.spyOn(heartbeatLease, "heartbeat").mockImplementation(() => {
      throw new Error("heartbeat failed");
    });
    const heartbeatManager = createManager(
      activeDatabase,
      heartbeatLease,
    );
    const heartbeatRequest = createReviewOperationRequest(
      heartbeatFixture,
      "actor-host",
      { reason: "heartbeat" },
    );

    await expect(
      commitReviewOperation(
        heartbeatManager,
        { ...heartbeatRequest, taskId: heartbeatFixture.taskId },
        "worker-heartbeat",
      ),
    ).rejects.toMatchObject({
      code: "TASK_LEASE_HEARTBEAT_FAILED",
    });
    let snapshot = new TaskSnapshotReader(activeDatabase).load(
      heartbeatFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
    expect(snapshot.lease?.ownerId).toBeNull();

    const releaseFixture = createRecoveryReviewFixture(
      activeDatabase,
      "release",
    );
    const releaseLease = new TaskLeaseManager(activeDatabase);
    const releaseManager = createManager(activeDatabase, releaseLease);
    vi.spyOn(releaseLease, "release").mockImplementation(() => {
      throw new Error("release failed");
    });
    const releaseRequest = createReviewOperationRequest(
      releaseFixture,
      "actor-host",
      { reason: "release" },
    );

    await expect(
      commitReviewOperation(
        releaseManager,
        { ...releaseRequest, taskId: releaseFixture.taskId },
        "worker-release",
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

  it("rolls back the Review CAS when Event or Checkpoint insertion fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const eventFixture = createRecoveryReviewFixture(
      activeDatabase,
      "event-rollback",
    );
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_review_operation_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'recovery.review_operation.applied'
        BEGIN
          SELECT RAISE(ABORT, 'review operation event rejected');
        END
      `,
    );

    await expect(
      commitReviewOperation(
        createManager(activeDatabase),
        {
          ...createReviewOperationRequest(
            eventFixture,
            "actor-host",
            { reason: "event-rollback" },
          ),
          taskId: eventFixture.taskId,
        },
        "worker-event",
      ),
    ).rejects.toThrow("review operation event rejected");
    let snapshot = new TaskSnapshotReader(activeDatabase).load(
      eventFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
    activeDatabase.exec("DROP TRIGGER reject_review_operation_event");

    const checkpointFixture = createRecoveryReviewFixture(
      activeDatabase,
      "checkpoint-rollback",
    );
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_review_operation_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'recovery_review_operation'
        BEGIN
          SELECT RAISE(ABORT, 'review operation checkpoint rejected');
        END
      `,
    );

    await expect(
      commitReviewOperation(
        createManager(activeDatabase),
        {
          ...createReviewOperationRequest(
            checkpointFixture,
            "actor-host",
            { reason: "checkpoint-rollback" },
          ),
          taskId: checkpointFixture.taskId,
        },
        "worker-checkpoint",
      ),
    ).rejects.toThrow("review operation checkpoint rejected");
    snapshot = new TaskSnapshotReader(activeDatabase).load(
      checkpointFixture.taskId,
    );
    expect(snapshot.recoveryReviews[0]?.decisionVersion).toBe(0);
    expect(snapshot.recoveryReviewOperations).toHaveLength(0);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.review_operation.applied",
      ),
    ).toHaveLength(0);
  });

  it("keeps legacy v0 decisions working while rejecting v1 and final outcomes", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const v0 = createRecoveryReviewFixture(activeDatabase, "legacy-v0", {
      reviewProtocolVersion: 0,
    });
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    expect(() =>
      unitOfWork.decideRecoveryReview({
        recoveryReviewId: v0.reviewId,
        status: "unresolved",
        note: "Legacy review remains unresolved.",
        sourceType: "manual_review",
        evidenceRef: null,
      }),
    ).not.toThrow();

    const v1 = createRecoveryReviewFixture(activeDatabase, "legacy-v1");
    expect(() =>
      unitOfWork.decideRecoveryReview({
        recoveryReviewId: v1.reviewId,
        status: "unresolved",
        note: "Protocol v1 cannot use the legacy API.",
        sourceType: "manual_review",
        evidenceRef: null,
      }),
    ).toThrowError(/not active/i);

    await expect(
      commitReviewOperation(
        createManager(activeDatabase),
        {
          ...createReviewOperationRequest(
            v1,
            "actor-host",
            { reason: "final-not-allowed" },
          ),
          taskId: v1.taskId,
          operation: "confirm_succeeded",
        } as never,
        "worker-final",
      ),
    ).rejects.toThrow();

    const storageModule = (await import(
      "../../src/storage/index.js"
    )) as Record<string, unknown>;
    const recoveryModule = (await import(
      "../../src/recovery/index.js"
    )) as Record<string, unknown>;
    expect(storageModule.RecoveryReviewOperationRepository).toBeUndefined();
    expect(recoveryModule.RecoveryReviewDecisionService).toBeUndefined();
    expect(
      recoveryModule.RECOVERY_REVIEW_INTERNAL_TEST_OPERATION,
    ).toBeUndefined();
    expect(
      "commitRecoveryReviewOperation" in RecoveryManager.prototype,
    ).toBe(false);
    expect(() =>
      new ExecutionUnitOfWork(
        activeDatabase,
        new TaskLeaseManager(activeDatabase),
      ).commitOwnedRecoveryReviewOperation({
        capability: {},
        ownership: {
          taskId: v1.taskId,
          leaseToken: "direct-bypass",
          fencingToken: 1,
        },
        expectedTaskVersion: v1.taskVersion,
        reviewId: v1.reviewId,
        expectedDecisionVersion: 0,
        operation: "advance_decision_version",
        actorId: "actor-host",
        operationPayloadDigest: computeRecoveryReviewOperationPayloadDigest(
          { reason: "direct" },
        ),
        requestKey: computeRecoveryReviewOperationRequestKey({
          reviewId: v1.reviewId,
          expectedDecisionVersion: 0,
          operation: "advance_decision_version",
          operationPayloadDigest:
            computeRecoveryReviewOperationPayloadDigest({
              reason: "direct",
            }),
          actorId: "actor-host",
        }),
      } as never),
    ).toThrowError(/decision service/i);
  });
});

function createManager(
  database: ForgeFlowDatabase,
  leaseManager = new TaskLeaseManager(database, {
    now: () => new Date(reviewOperationTimestamp),
  }),
): RecoveryManager {
  return new RecoveryManager({
    database,
    leaseManager,
    heartbeatIntervalMs: 1_000,
    now: () => new Date(reviewOperationTimestamp),
  });
}
function createDecisionService(
  database: ForgeFlowDatabase,
  leaseManager: TaskLeaseManager,
): RecoveryReviewDecisionService {
  return new RecoveryReviewDecisionService(
    database,
    leaseManager,
    new FileEvidencePayloadStore(
      join(temporaryDatabase?.directory as string, "evidence"),
    ),
  );
}

function commitReviewOperation(
  manager: RecoveryManager,
  input: Parameters<
    RecoveryManager[typeof RECOVERY_REVIEW_INTERNAL_TEST_OPERATION]
  >[0],
  ownerId: string,
) {
  return manager[RECOVERY_REVIEW_INTERNAL_TEST_OPERATION](
    input,
    ownerId,
  );
}

function countEvents(
  database: ForgeFlowDatabase,
  taskId: string,
): number {
  return new TaskSnapshotReader(database)
    .load(taskId)
    .events.filter(
      (event) => event.type === "recovery.review_operation.applied",
    ).length;
}

function countCheckpoints(
  database: ForgeFlowDatabase,
  taskId: string,
): number {
  return new TaskSnapshotReader(database)
    .load(taskId)
    .checkpoints.filter(
      (checkpoint) => checkpoint.reason === "recovery_review_operation",
    ).length;
}

function createReviewOperationRequest(
  fixture: RecoveryReviewFixture,
  actorId: string,
  operationPayload: JsonValue,
  expectedDecisionVersion = 0,
) {
  const operationPayloadDigest =
    computeRecoveryReviewOperationPayloadDigest(operationPayload);
  return {
    reviewId: fixture.reviewId,
    expectedDecisionVersion,
    operation: "advance_decision_version" as const,
    actorId,
    operationPayload,
    requestKey: computeRecoveryReviewOperationRequestKey({
      reviewId: fixture.reviewId,
      expectedDecisionVersion,
      operation: "advance_decision_version",
      operationPayloadDigest,
      actorId,
    }),
  };
}

interface WorkerConfig {
  readonly databasePath: string;
  readonly now: string;
  readonly ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  };
  readonly expectedTaskVersion: number;
  readonly reviewId: string;
  readonly expectedDecisionVersion: number;
  readonly actorId: string;
  readonly operationPayload: JsonValue;
  readonly requestKey: string;
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
        new Error(`Review operation worker did not become ready.\n${stderr}`),
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
          `Review operation worker exited early (${String(code)}).\n${stderr}`,
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
      reject(new Error("Review operation worker timed out."));
    }, WORKER_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
      cleanup();
      resolve(message as WorkerResult);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `Review operation worker exited without a result (${String(code)}).`,
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
