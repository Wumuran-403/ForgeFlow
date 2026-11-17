import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CheckpointStore,
  EventRepository,
  ExecutionPlanRepository,
  RecoveryEvidenceReadAttemptRepository,
  RecoveryEvidenceReadbackReservationUnitOfWork,
  SequenceAllocator,
  TaskSnapshotReader,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
  type RecoveryEvidenceReadAttemptRecord,
} from "../../src/storage/index.js";
import { prepareRecoveryEvidenceDispatchPreflight } from "../../src/recovery/recovery-evidence-dispatch-preflight.js";
import { issueRecoveryEvidenceHostControlAuthorization } from "../../src/recovery/recovery-evidence-host-control-authorization.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";
import {
  createRecoveryInterruptionFixture,
  createRecoveryEvidenceUowFixture,
  type RecoveryEvidenceUowFixture,
} from "./recovery-evidence-uow-fixture.js";
import {
  DISPATCH_ALLOWLIST_ID,
  DISPATCH_ALLOWLIST_VERSION,
  DISPATCH_READ_TOOL_NAME,
  DISPATCH_READ_TOOL_SCHEMA_HASH,
  DISPATCH_READ_TOOL_VERSION,
  createDispatchReadbackRegistry,
  createDispatchReadbackRegistryVariant,
} from "./recovery-evidence-dispatch-contract.js";
import * as recoveryPublicApi from "../../src/recovery/index.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
const workers: ChildProcess[] = [];
const WORKER_TIMEOUT_MS = 15_000;
const dispatchWorkerPath = fileURLToPath(
  new URL("./recovery-evidence-dispatch-worker.ts", import.meta.url),
);

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

describe("RecoveryEvidence Dispatch UoW", () => {
  it("creates Dispatch once and exact-replays the original Task version", () => {
    const fixture = openReservedFixture("dispatch-created");
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const before = snapshot(fixture.fixture);
    const input = dispatchInput(fixture, before);

    expect(
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(input),
    ).toMatchObject({
      state: "created",
      replayed: false,
      attemptStatus: "dispatching",
      toolRunStatus: "running",
      planStepStatus: "running",
      planStatus: "active",
    });
    const afterCreate = snapshot(fixture.fixture);
    expect(afterCreate.task.version).toBe(before.task.version + 2);
    expect(
      afterCreate.events.filter(
        (event) =>
          event.type ===
            "recovery.evidence.read_attempt_dispatching" &&
          event.entityId === input.attemptId,
      ),
    ).toHaveLength(1);
    expect(
      afterCreate.events.filter(
        (event) =>
          event.type === "tool.started" &&
          event.entityId === fixture.request.readToolRunId,
      ),
    ).toHaveLength(1);

    expect(
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(input),
    ).toMatchObject({
      state: "replayed-existing-dispatching",
      replayed: true,
      attemptId: input.attemptId,
    });
    const replayed = snapshot(fixture.fixture);
    expect(replayed.events).toHaveLength(afterCreate.events.length);
    expect(replayed.checkpoints).toHaveLength(
      afterCreate.checkpoints.length,
    );
    expect(executeValidated).not.toHaveBeenCalled();
  });

  it("rejects forged, cloned, and cast preflight objects", () => {
    const reserved = openReservedFixture("dispatch-preflight-capability");
    const before = snapshot(reserved.fixture);
    const input = dispatchInput(reserved, before);
    const capability = input.preflight;
    const forged = [
      {},
      { ...capability },
      JSON.parse(JSON.stringify(capability)) as unknown,
      {
        allowlistId: reserved.request.allowlistId,
        allowlistVersion: reserved.request.allowlistVersion,
        allowlistContractDigest: reserved.request.allowlistVersion,
        readToolName: reserved.request.readToolName,
        readToolVersion: reserved.request.readToolVersion,
        readToolSchemaHash: reserved.request.readToolSchemaHash,
        retrySafety: reserved.request.retrySafety,
        consistencyMode: reserved.request.consistencyMode,
      },
    ];

    for (const preflight of forged) {
      expect(() =>
        reserved.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead({
          ...input,
          preflight: preflight as never,
        }),
      ).toThrow(/preflight/i);
    }
    expectDispatchStateUnchanged(reserved.fixture, before);
  });

  it("rejects a Host capability for a different immutable contract", () => {
    const reserved = openReservedFixture("dispatch-preflight-contract");
    const before = snapshot(reserved.fixture);
    const input = dispatchInput(reserved, before);
    const variant = createDispatchReadbackRegistryVariant({
      maximumPayloadBytes: 32_768,
    });
    const otherContract = prepareRecoveryEvidenceDispatchPreflight({
      registry: variant.registry,
      allowlistId: DISPATCH_ALLOWLIST_ID,
      expectedAllowlistContractDigest: variant.allowlistVersion,
    });

    expect(() =>
      reserved.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead({
        ...input,
        preflight: otherContract,
      }),
    ).toThrow(/preflight.*persisted|mismatch/i);
    expectDispatchStateUnchanged(reserved.fixture, before);
  });

  it("returns Intent results without Dispatch writes", () => {
    const cancel = openReservedFixture("dispatch-cancel");
    setTaskIntent(cancel.fixture, "cancel");
    const cancelBefore = snapshot(cancel.fixture);
    expect(
      cancel.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(cancel, cancelBefore),
      ),
    ).toMatchObject({ state: "cancel_required", replayed: false });
    expectDispatchStateUnchanged(cancel.fixture, cancelBefore);

    if (database !== undefined) {
      closeDatabase(database);
      database = undefined;
    }
    temporaryDatabase?.cleanup();
    temporaryDatabase = undefined;

    const pause = openReservedFixture("dispatch-pause");
    setTaskIntent(pause.fixture, "pause");
    const pauseBefore = snapshot(pause.fixture);
    expect(
      pause.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(pause, pauseBefore),
      ),
    ).toMatchObject({ state: "pause_blocked", replayed: false });
    expectDispatchStateUnchanged(pause.fixture, pauseBefore);
  });

  it("never treats Exact Replay as authorization under Cancel or Pause", () => {
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const cancel = openReservedFixture("dispatch-replay-cancel");
    const originalInput = dispatchInput(
      cancel,
      snapshot(cancel.fixture),
    );
    expect(
      cancel.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        originalInput,
      ).state,
    ).toBe("created");
    setTaskIntent(cancel.fixture, "cancel");
    const cancelBefore = snapshot(cancel.fixture);
    expect(
      cancel.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        originalInput,
      ),
    ).toMatchObject({
      state: "cancel_required",
      replayed: false,
    });
    expectDispatchStateUnchanged(cancel.fixture, cancelBefore);

    closeCurrentDatabase();
    const pause = openReservedFixture("dispatch-replay-pause");
    const pauseInput = dispatchInput(pause, snapshot(pause.fixture));
    expect(
      pause.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        pauseInput,
      ).state,
    ).toBe("created");
    setTaskIntent(pause.fixture, "pause");
    const pauseBefore = snapshot(pause.fixture);
    expect(
      pause.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        pauseInput,
      ),
    ).toMatchObject({
      state: "pause_blocked",
      replayed: false,
    });
    expectDispatchStateUnchanged(pause.fixture, pauseBefore);
    expect(executeValidated).not.toHaveBeenCalled();
  });

  it("does not restore an old owner's write permission through Replay", () => {
    const reserved = openReservedFixture("dispatch-replay-old-owner");
    const fixture = reserved.fixture;
    const input = dispatchInput(reserved, snapshot(fixture));
    expect(
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(input).state,
    ).toBe("created");

    fixture.leaseManager.release(
      fixture.taskId,
      fixture.ownership.leaseToken,
      fixture.ownership.fencingToken,
    );
    const replacement = fixture.leaseManager.claim(
      fixture.taskId,
      "dispatch-replay-replacement-owner",
    );
    expect(replacement.leaseToken).not.toBeNull();
    const beforeReplay = snapshot(fixture);

    expect(() =>
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(input),
    ).toThrow(/lease|owned|fencing/i);
    expectDispatchStateUnchanged(fixture, beforeReplay);
  });

  it(
    "allows only one created result across two concurrent Dispatch workers",
    async () => {
      const reserved = openReservedFixture("dispatch-concurrent");
      const input = dispatchInput(
        reserved,
        snapshot(reserved.fixture),
      );
      const preflightSource = {
        allowlistId: reserved.request.allowlistId,
        expectedAllowlistContractDigest:
          reserved.request.allowlistVersion,
      };
      const first = await startDispatchWorker(input, preflightSource);
      const second = await startDispatchWorker(input, preflightSource);
      const results = await Promise.all([
        runDispatchWorker(first),
        runDispatchWorker(second),
      ]);
      expect(results.sort()).toEqual([
        "created",
        "replayed-existing-dispatching",
      ]);
      const current = snapshot(reserved.fixture);
      expect(
        current.events.filter(
          (event) =>
            event.type ===
              "recovery.evidence.read_attempt_dispatching" &&
            event.entityId === input.attemptId,
        ),
      ).toHaveLength(1);
    },
    WORKER_TIMEOUT_MS,
  );

  it("fails closed for a Retry without a production Recovery lineage", () => {
    const reserved = openReservedFixture("dispatch-retry");
    const fixture = reserved.fixture;
    fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(reserved, snapshot(fixture)),
    );
    let current = snapshot(fixture);
    const firstAttempt = current.recoveryEvidenceReadAttempts.find(
      (attempt) => attempt.readbackRequestId === reserved.request.id,
    );
    if (firstAttempt === undefined) {
      throw new Error("Expected first Dispatch Attempt.");
    }
    transitionAttemptInCurrentTransaction(fixture, {
      ownership: fixture.ownership,
      expectedTaskVersion: current.task.version,
      attemptId: firstAttempt.id,
      expectedAttemptVersion: firstAttempt.version,
      status: "interrupted",
      observedAt: null,
      resourceVersion: null,
      resourceEtag: null,
      resultDigest: null,
      resultPayloadStoreRef: null,
      reasonCode: "FENCING_TAKEOVER",
    });
    current = snapshot(fixture);
    const retry = fixture.unitOfWork.createOwnedRecoveryEvidenceReadAttemptPrepared({
      ownership: fixture.ownership,
      expectedTaskVersion: current.task.version,
      attemptId: "dispatch-retry-attempt-2",
      readbackRequestId: reserved.request.id,
    });
    const beforeRetry = snapshot(fixture);
    expect(
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(reserved, beforeRetry, retry.id),
      ),
    ).toMatchObject({
      state: "state_inconsistent",
      reason: "retry_lineage_invalid",
      replayed: false,
    });
    expectDispatchStateUnchanged(fixture, beforeRetry);
  });

  it.each([
    ["attempt binding", { attemptId: "missing-attempt" }],
    ["request binding", { requestId: "missing-request" }],
    ["canonical input hash", { expectedCanonicalInputHash: digest("9") }],
  ] as const)("rejects a %s mismatch", (_label, override) => {
    const fixture = openReservedFixture(`dispatch-${_label}`);
    const before = snapshot(fixture.fixture);
    expect(() =>
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead({
        ...dispatchInput(fixture, before),
        ...override,
      }),
    ).toThrow(/preflight|mismatch|not found|binding/i);
    expectDispatchStateUnchanged(fixture.fixture, before);
  });

  it("rejects multiple active Attempts inside the Dispatch transaction", () => {
    const reserved = openReservedFixture("dispatch-single-active");
    const fixture = reserved.fixture;
    const candidate = snapshot(fixture).recoveryEvidenceReadAttempts.find(
      (attempt) => attempt.readbackRequestId === reserved.request.id,
    );
    if (candidate === undefined) {
      throw new Error("Expected initial Dispatch Attempt.");
    }
    runInTransaction(
      fixture.database,
      () => {
        const permit = createStorageWritePermit(fixture.database);
        const now = "2026-11-08T00:07:00.000Z";
        const event = new EventRepository(
          fixture.database,
          new SequenceAllocator(fixture.database),
        ).append(
          {
            taskId: fixture.taskId,
            traceId: snapshot(fixture).task.traceId,
            type: "recovery.evidence.read_attempt_prepared",
            entityType: "recovery_evidence_read_attempt",
            entityId: "dispatch-extra-active-attempt",
            payload: {
              readAttemptId: "dispatch-extra-active-attempt",
              attemptNumber: 2,
              attemptStatus: "prepared",
              fencingToken: fixture.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        new RecoveryEvidenceReadAttemptRepository(
          fixture.database,
        ).insertPrepared(
          {
            id: "dispatch-extra-active-attempt",
            taskId: fixture.taskId,
            readbackRequestId: reserved.request.id,
            readToolRunId: reserved.request.readToolRunId,
            attemptNumber: 2,
            retrySafety: reserved.request.retrySafety,
            consistencyMode: reserved.request.consistencyMode,
            preparedAt: now,
            lastEventId: event.id,
            createdAt: now,
          },
          permit,
        );
      },
      "immediate",
    );
    const before = snapshot(fixture);
    expect(
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(reserved, before, candidate.id),
      ),
    ).toMatchObject({
      state: "state_inconsistent",
      reason: "multiple_active_attempts",
    });
    expectDispatchStateUnchanged(fixture, before);
  });

  it("rejects historical Requests without a v9 Reservation", () => {
    const fixture = openFixture("dispatch-historical", {
      allowlistVersion: DISPATCH_ALLOWLIST_VERSION,
      readToolSchemaHash: DISPATCH_READ_TOOL_SCHEMA_HASH,
    });
    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "dispatch-historical"),
      );
    const before = snapshot(fixture);
    expect(() =>
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(
          {
            fixture,
            request: created.request,
          },
          before,
        ),
      ),
    ).toThrow(/reservation/i);
    expectDispatchStateUnchanged(fixture, before);
  });

  it("rejects an incomplete completed Reservation invariant", () => {
    const reserved = openReservedFixture("dispatch-reservation-invariant");
    runInTransaction(
      reserved.fixture.database,
      () => {
        const permit = createStorageWritePermit(reserved.fixture.database);
        const plans = new ExecutionPlanRepository(reserved.fixture.database);
        const plan = plans.get(reserved.fixture.executionPlanId);
        plans.updateStatusCas(
          plan.id,
          "active",
          plan.version,
          "failed",
          "2026-11-08T00:08:00.000Z",
          permit,
        );
      },
      "immediate",
    );
    const before = snapshot(reserved.fixture);
    expect(() =>
      reserved.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(reserved, before),
      ),
    ).toThrow(/reservation|state|conflict|invariant/i);
    expectDispatchStateUnchanged(reserved.fixture, before);
  });

  it("rolls back Event and Checkpoint failures", () => {
    const eventFixture = openReservedFixture("dispatch-event-failure");
    const eventBefore = snapshot(eventFixture.fixture);
    const eventInput = dispatchInput(eventFixture, eventBefore);
    vi.spyOn(EventRepository.prototype, "append").mockImplementation(() => {
      throw new Error("injected dispatch Event failure");
    });
    expect(() =>
      eventFixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        eventInput,
      ),
    ).toThrow(/injected dispatch Event failure/i);
    expectDispatchStateUnchanged(eventFixture.fixture, eventBefore);
  });

  it("rolls back when Checkpoint append fails", () => {
    const fixture = openReservedFixture("dispatch-checkpoint-failure");
    const before = snapshot(fixture.fixture);
    vi.spyOn(CheckpointStore.prototype, "append").mockImplementation(() => {
      throw new Error("injected dispatch checkpoint failure");
    });
    expect(() =>
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(fixture, before),
      ),
    ).toThrow(/injected dispatch checkpoint failure/i);
    expectDispatchStateUnchanged(fixture.fixture, before);
  });

  it("rejects stale lease, fencing, Authority, Task and Review gates", () => {
    const fixture = openReservedFixture("dispatch-gates");
    const before = snapshot(fixture.fixture);
    const input = dispatchInput(fixture, before);

    expect(() =>
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead({
        ...input,
        ownership: {
          ...input.ownership,
          fencingToken: input.ownership.fencingToken + 1,
        },
      }),
    ).toThrow(/lease|owned|fencing/i);

    fixture.fixture.leaseManager.release(
      fixture.fixture.taskId,
      fixture.fixture.ownership.leaseToken,
      fixture.fixture.ownership.fencingToken,
    );
    expect(() =>
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(input),
    ).toThrow(/lease|owned|fencing/i);
    const replacement = fixture.fixture.leaseManager.claim(
      fixture.fixture.taskId,
      "dispatch-gates-replacement",
    );
    if (replacement.leaseToken === null) {
      throw new Error("Expected replacement lease token.");
    }
    const replacementOwnership = {
      taskId: fixture.fixture.taskId,
      leaseToken: replacement.leaseToken,
      fencingToken: replacement.fencingToken,
    };
    fixture.fixture.authority.revoke(new Error("revoked"));
    expect(() =>
      fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead({
        ...input,
        ownership: replacementOwnership,
      }),
    ).toThrow(/authority/i);
  });

  it("requires a live current-transaction StorageWritePermit", () => {
    const reserved = openReservedFixture("dispatch-permit");
    const fixture = reserved.fixture;
    const before = snapshot(fixture);
    const attempt = before.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === reserved.request.id,
    );
    if (attempt === undefined) {
      throw new Error("Expected Dispatch Attempt.");
    }
    const transitionInput = preparedDispatchTransitionInput(
      fixture,
      attempt,
    );

    expect(() =>
      fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
        transitionInput,
        undefined as never,
      ),
    ).toThrow(/transaction|permit/i);

    expect(() =>
      runInTransaction(
        fixture.database,
        () =>
          fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
            transitionInput,
            {} as never,
          ),
        "immediate",
      ),
    ).toThrow(/permit/i);

    expect(() =>
      runInTransaction(
        fixture.database,
        () => createStorageWritePermit(fixture.database),
        "exclusive",
      ),
    ).toThrow(/immediate transaction/i);

    let stalePermit:
      | ReturnType<typeof createStorageWritePermit>
      | undefined;
    runInTransaction(
      fixture.database,
      () => {
        stalePermit = createStorageWritePermit(fixture.database);
      },
      "immediate",
    );
    expect(() =>
      runInTransaction(
        fixture.database,
        () =>
          fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
            transitionInput,
            stalePermit as never,
          ),
        "immediate",
      ),
    ).toThrow(/permit/i);
    expectDispatchStateUnchanged(fixture, before);
  });

  it("rejects non-waiting Task and mismatched Review decision", () => {
    const taskFixture = openReservedFixture("dispatch-task-state");
    updateOne(
      taskFixture.fixture,
      "UPDATE tasks SET status = 'paused', version = version + 1 WHERE id = ?",
      taskFixture.fixture.taskId,
    );
    expect(() =>
      taskFixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(taskFixture, snapshot(taskFixture.fixture)),
      ),
    ).toThrow(/task|waiting_review/i);

    closeCurrentDatabase();
    const reviewFixture = openReservedFixture("dispatch-review-state");
    updateOne(
      reviewFixture.fixture,
      "UPDATE recovery_reviews SET decision_version = decision_version + 1 WHERE id = ?",
      reviewFixture.fixture.reviewId,
    );
    expect(() =>
      reviewFixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(reviewFixture, snapshot(reviewFixture.fixture)),
      ),
    ).toThrow(/review|decision/i);
  });

  it("keeps the Original Agent Plan and Unknown Write unchanged", () => {
    const fixture = openReservedFixture("dispatch-audit");
    const before = snapshot(fixture.fixture);
    const originalPlan = before.executionPlans.find(
      (plan) => plan.purpose === "agent",
    );
    const originalStep = before.planSteps.find(
      (step) => step.planId === originalPlan?.id,
    );
    const originalRun = before.toolRuns.find(
      (run) => run.id === fixture.fixture.originalToolRunId,
    );
    fixture.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(fixture, before),
    );
    const after = snapshot(fixture.fixture);
    expect(
      after.executionPlans.find((plan) => plan.id === originalPlan?.id),
    ).toEqual(originalPlan);
    expect(
      after.planSteps.find((step) => step.id === originalStep?.id),
    ).toEqual(originalStep);
    expect(
      after.toolRuns.find((run) => run.id === originalRun?.id),
    ).toEqual(originalRun);
  });

  it("settles dispatched reads as failed or timed out with Exact Replay", () => {
    const failed = openReservedFixture("intent-failed");
    const failedDispatch = dispatchInput(
      failed,
      snapshot(failed.fixture),
    );
    failed.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      failedDispatch,
    );
    const failedSnapshot = snapshot(failed.fixture);
    const failedInput = terminalInput(
      failed,
      failedSnapshot,
      "failed",
      "HOST_EXECUTION_FAILED",
    );
    expect(
      failed.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        failedInput,
      ),
    ).toMatchObject({
      state: "failed",
      attemptStatus: "failed",
      toolRunStatus: "failed",
      planStepStatus: "failed",
      planStatus: "failed",
      replayed: false,
    });
    const afterFailure = snapshot(failed.fixture);
    expect(
      failed.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        failedInput,
      ),
    ).toMatchObject({ state: "failed", replayed: true });
    expect(snapshot(failed.fixture).events).toHaveLength(
      afterFailure.events.length,
    );
    failed.fixture.authority.revoke(new Error("authority expired"));
    expect(() =>
      failed.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        failedInput,
      ),
    ).toThrow(/authority/i);

    closeCurrentDatabase();
    const timedOut = openReservedFixture("intent-timed-out");
    timedOut.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(timedOut, snapshot(timedOut.fixture)),
    );
    expect(
      timedOut.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        terminalInput(
          timedOut,
          snapshot(timedOut.fixture),
          "timed_out",
          "TOOL_TIMEOUT",
        ),
      ),
    ).toMatchObject({
      state: "timed_out",
      attemptStatus: "timed_out",
      toolRunStatus: "timed_out",
      planStepStatus: "failed",
      planStatus: "failed",
    });
  });

  it("rejects forged HostControlAuthorization and stale operation scope", () => {
    expect(
      "issueRecoveryEvidenceHostControlAuthorization" in recoveryPublicApi,
    ).toBe(false);
    expect(
      "createRecoveryEvidenceHostControlAuthorization" in recoveryPublicApi,
    ).toBe(false);
    const reserved = openReservedFixture("intent-host-auth");
    const before = snapshot(reserved.fixture);
    expect(() =>
      reserved.fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
        hostControlAuthorization: {} as never,
        expectedTaskVersion: before.task.version,
        requestNonce: "forged-host-control",
        controlActor: "host-control",
      }),
    ).toThrow(/authorization/i);
    const pauseAuthorization = hostControlAuthorization(
      reserved.fixture,
      "pause_set",
      "wrong-operation",
    );
    for (const clone of [
      { ...pauseAuthorization },
      JSON.parse(JSON.stringify(pauseAuthorization)) as unknown,
    ]) {
      expect(() =>
        reserved.fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
          hostControlAuthorization: clone as never,
          expectedTaskVersion: before.task.version,
          requestNonce: "wrong-operation",
          controlActor: "host-control",
        }),
      ).toThrow(/authorization/i);
    }
    expect(() =>
      reserved.fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
        hostControlAuthorization: pauseAuthorization,
        expectedTaskVersion: before.task.version,
        requestNonce: "different-nonce",
        controlActor: "host-control",
      }),
    ).toThrow(/authorization/i);
    expect(() =>
      reserved.fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
        hostControlAuthorization: pauseAuthorization,
        expectedTaskVersion: before.task.version,
        requestNonce: "wrong-operation",
        controlActor: "different-actor",
      }),
    ).toThrow(/authorization/i);
    expect(() =>
      reserved.fixture.unitOfWork.clearTaskWideRecoveryEvidencePause({
        hostControlAuthorization: pauseAuthorization,
        expectedTaskVersion: before.task.version,
        requestNonce: "wrong-operation",
        controlActor: "host-control",
        expectedPauseRequestedAt: "2026-11-08T00:00:00.000Z",
        pauseRequestEventId: "pause-event",
        expectedPauseEventSequence: 1,
      }),
    ).toThrow(/authorization/i);
    expectDispatchStateUnchanged(reserved.fixture, before);
  });

  it("persists known Failure while preserving Cancel or Pause audit", () => {
    const paused = openReservedFixture("intent-failure-paused");
    paused.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(paused, snapshot(paused.fixture)),
    );
    const pausedBeforeIntent = snapshot(paused.fixture);
    const pausedFailureInput = terminalInput(
      paused,
      pausedBeforeIntent,
      "failed",
      "HOST_EXECUTION_FAILED",
    );
    const pauseIntent = setPauseIntent(
      paused.fixture,
      "failure-paused-intent",
    );
    expect(
      paused.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        pausedFailureInput,
      ),
    ).toMatchObject({ state: "failed", replayed: false });
    const pausedAfter = snapshot(paused.fixture);
    expect(pausedAfter.task.pauseRequestedAt).not.toBeNull();
    expect(
      pausedAfter.events.find(
        (event) =>
          event.type === "recovery.evidence.read_attempt_failed" &&
          event.entityId ===
            pausedBeforeIntent.recoveryEvidenceReadAttempts[0]?.id,
      )?.payload,
    ).toMatchObject({
      controlIntentKind: "pause",
      controlIntentEventId: pauseIntent.eventId,
    });

    closeCurrentDatabase();
    const cancelled = openReservedFixture("intent-failure-cancelled");
    cancelled.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(cancelled, snapshot(cancelled.fixture)),
    );
    const cancelBeforeIntent = snapshot(cancelled.fixture);
    const cancelledFailureInput = terminalInput(
      cancelled,
      cancelBeforeIntent,
      "failed",
      "HOST_EXECUTION_FAILED",
    );
    const cancelIntent = setCancelIntent(
      cancelled.fixture,
      "failure-cancelled-intent",
    );
    expect(
      cancelled.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        cancelledFailureInput,
      ),
    ).toMatchObject({ state: "failed", replayed: false });
    const cancelledAfter = snapshot(cancelled.fixture);
    expect(cancelledAfter.task.cancelRequestedAt).not.toBeNull();
    expect(
      cancelledAfter.events.find(
        (event) =>
          event.type === "recovery.evidence.read_attempt_failed" &&
          event.entityId ===
            cancelBeforeIntent.recoveryEvidenceReadAttempts[0]?.id,
      )?.payload,
    ).toMatchObject({
      controlIntentKind: "cancel",
      controlIntentEventId: cancelIntent.eventId,
    });
  });

  it("rejects prepared-to-failed and prepared-to-timed-out", () => {
    const fixture = openReservedFixture("intent-prepared-terminal");
    const before = snapshot(fixture.fixture);
    expect(() =>
      fixture.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
        terminalInput(fixture, before, "failed", "HOST_EXECUTION_FAILED"),
      ),
    ).toThrow(/dispatched|state|transition/i);
    expectDispatchStateUnchanged(fixture.fixture, before);
  });

  it("applies Task-wide Cancel and exact-replays prepared cancellation", () => {
    const reserved = openReservedFixture("intent-cancel-prepared-replay");
    const cancelIntent = setCancelIntent(
      reserved.fixture,
      "cancel-intent-dispatching",
    );
    expect(cancelIntent.state).toBe("created");
    expect(snapshot(reserved.fixture).task.cancelRequestedAt).not.toBeNull();
    expect(
      setCancelIntent(reserved.fixture, "cancel-intent-dispatching"),
    ).toMatchObject({
      state: "replayed",
      eventId: cancelIntent.eventId,
    });
    const beforeCancel = snapshot(reserved.fixture);
    const input = cancelInput(reserved, beforeCancel, cancelIntent.eventId);
    expect(
      reserved.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(input),
    ).toMatchObject({
      state: "cancelled",
      replayed: false,
      attemptStatus: "cancelled",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
    });
    const afterCancel = snapshot(reserved.fixture);
    expect(
      reserved.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(input),
    ).toMatchObject({ state: "cancelled", replayed: true });
    expect(snapshot(reserved.fixture).events).toHaveLength(
      afterCancel.events.length,
    );
  });

  it("cancels prepared and blocked Attempts without reviving them", () => {
    const prepared = openReservedFixture("intent-cancel-prepared");
    const preparedIntent = setCancelIntent(
      prepared.fixture,
      "cancel-prepared-intent",
    );
    const preparedBefore = snapshot(prepared.fixture);
    expect(
      prepared.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
        cancelInput(prepared, preparedBefore, preparedIntent.eventId),
      ),
    ).toMatchObject({
      state: "cancelled",
      attemptStatus: "cancelled",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
    });

    closeCurrentDatabase();
    const blocked = openReservedFixture("intent-cancel-blocked");
    const pause = setPauseIntent(
      blocked.fixture,
      "cancel-blocked-pause",
    );
    const afterPause = snapshot(blocked.fixture);
    const attempt = afterPause.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === blocked.request.id,
    );
    if (attempt === undefined) {
      throw new Error("Expected Pause-blocked Attempt.");
    }
    blocked.fixture.unitOfWork.blockOwnedRecoveryEvidenceReadForIntent(
      pauseBlockInput(blocked, afterPause, attempt, pause.eventId),
    );
    const cancel = setCancelIntent(
      blocked.fixture,
      "cancel-blocked-intent",
    );
    const beforeCancel = snapshot(blocked.fixture);
    const result =
      blocked.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
        cancelInput(blocked, beforeCancel, cancel.eventId),
      );
    expect(result).toMatchObject({
      state: "cancelled",
      attemptStatus: "blocked_by_intent",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
    });
    expect(
      snapshot(blocked.fixture).recoveryEvidenceReadAttempts.find(
        (candidate) => candidate.id === attempt.id,
      )?.status,
    ).toBe("blocked_by_intent");
  });

  it("converges an interrupted Attempt without rewriting its history", () => {
    const reserved = openReservedFixture("intent-cancel-interrupted");
    const fixture = reserved.fixture;
    fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(reserved, snapshot(fixture)),
    );
    const dispatching = snapshot(fixture);
    const attempt = dispatching.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === reserved.request.id,
    );
    if (attempt === undefined) {
      throw new Error("Expected interrupted cancel candidate.");
    }
    transitionAttemptInCurrentTransaction(fixture, {
      ownership: fixture.ownership,
      expectedTaskVersion: dispatching.task.version,
      attemptId: attempt.id,
      expectedAttemptVersion: attempt.version,
      status: "interrupted",
      observedAt: null,
      resourceVersion: null,
      resourceEtag: null,
      resultDigest: null,
      resultPayloadStoreRef: null,
      reasonCode: "FENCING_TAKEOVER",
    });
    const cancel = setCancelIntent(
      fixture,
      "cancel-interrupted-intent",
    );
    const before = snapshot(fixture);
    expect(
      fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
        cancelInput(reserved, before, cancel.eventId),
      ),
    ).toMatchObject({
      state: "cancelled",
      attemptStatus: "interrupted",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
    });
    expect(
      snapshot(fixture).recoveryEvidenceReadAttempts.find(
        (candidate) => candidate.id === attempt.id,
      )?.status,
    ).toBe("interrupted");
  });

  it("returns terminal conflict for Cancel after failure", () => {
    const reserved = openReservedFixture("intent-cancel-terminal");
    reserved.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(reserved, snapshot(reserved.fixture)),
    );
    reserved.fixture.unitOfWork.failOwnedRecoveryEvidenceRead(
      terminalInput(
        reserved,
        snapshot(reserved.fixture),
        "timed_out",
        "TOOL_TIMEOUT",
      ),
    );
    const cancel = setCancelIntent(
      reserved.fixture,
      "cancel-terminal-intent",
    );
    const before = snapshot(reserved.fixture);
    expect(
      reserved.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
        cancelInput(reserved, before, cancel.eventId),
      ),
    ).toMatchObject({
      state: "terminal_status_conflict",
      replayed: false,
    });
    expectDispatchStateUnchanged(reserved.fixture, before);
  });

  it("fails closed for dispatching Cancel without trusted settlement", () => {
    const reserved = openReservedFixture("intent-cancel-settlement");
    reserved.fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(reserved, snapshot(reserved.fixture)),
    );
    const cancel = setCancelIntent(
      reserved.fixture,
      "cancel-settlement-intent",
    );
    const before = snapshot(reserved.fixture);
    const input = cancelInput(reserved, before, cancel.eventId);
    expect(() =>
      reserved.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(input),
    ).toThrow(/settlement/i);
    expect(() =>
      reserved.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead({
        ...input,
        dispatchingSettlement: "not_started",
      } as never),
    ).toThrow(/unrecognized|invalid|settlement/i);
    expectDispatchStateUnchanged(reserved.fixture, before);
  });

  it("Pause-blocks, observes, clears, resumes, then allows Dispatch", () => {
    const reserved = openReservedFixture("intent-pause-resume");
    const fixture = reserved.fixture;
    const pauseIntent = setPauseIntent(fixture, "pause-intent-resume");
    expect(pauseIntent.state).toBe("created");
    const afterPause = snapshot(fixture);
    expect(
      setPauseIntent(fixture, "pause-intent-resume"),
    ).toMatchObject({
      state: "replayed",
      eventId: pauseIntent.eventId,
    });
    expect(snapshot(fixture).events).toHaveLength(afterPause.events.length);
    const attempt = afterPause.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === reserved.request.id,
    );
    if (attempt === undefined) {
      throw new Error("Expected paused Attempt.");
    }
    const blockInput = pauseBlockInput(
      reserved,
      afterPause,
      attempt,
      pauseIntent.eventId,
    );
    expect(
      fixture.unitOfWork.blockOwnedRecoveryEvidenceReadForIntent(
        blockInput,
      ),
    ).toMatchObject({
      state: "blocked",
      replayed: false,
      pauseRequestEventId: pauseIntent.eventId,
    });
    const blocked = snapshot(fixture);
    expect(
      fixture.unitOfWork.blockOwnedRecoveryEvidenceReadForIntent(
        blockInput,
      ),
    ).toMatchObject({ state: "replayed", replayed: true });
    expect(snapshot(fixture).events).toHaveLength(blocked.events.length);

    const clear = clearPauseIntent(
      fixture,
      "pause-clear-resume",
      pauseIntent.eventId,
    );
    expect(clear.state).toBe("created");
    const beforeResume = snapshot(fixture);
    const resume = fixture.unitOfWork.resumeBlockedOwnedRecoveryEvidenceRead(
      resumeInput(reserved, beforeResume, clear.eventId),
    );
    expect(resume).toMatchObject({
      state: "created",
      replayed: false,
      attempt: {
        status: "prepared",
        attemptNumber: attempt.attemptNumber + 1,
      },
    });
    const beforeReplay = snapshot(fixture);
    expect(
      fixture.unitOfWork.resumeBlockedOwnedRecoveryEvidenceRead(
        resumeInput(
          reserved,
          beforeReplay,
          clear.eventId,
          resume.attempt.id,
        ),
      ),
    ).toMatchObject({
      state: "replayed",
      replayed: true,
      attempt: { id: resume.attempt.id },
    });
    expect(snapshot(fixture).events).toHaveLength(beforeReplay.events.length);

    const resumedDispatch = dispatchInput(
      reserved,
      snapshot(fixture),
      resume.attempt.id,
    );
    expect(
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(resumedDispatch),
    ).toMatchObject({
      state: "created",
      attemptId: resume.attempt.id,
      attemptStatus: "dispatching",
    });
  });

  it("lets Host Pause control-plane write while the worker owns the lease", () => {
    const reserved = openReservedFixture("intent-host-pause-independent");
    expect(
      reserved.fixture.leaseManager.assertOwned(
        reserved.fixture.taskId,
        reserved.fixture.ownership.leaseToken,
        reserved.fixture.ownership.fencingToken,
      ).ownerId,
    ).not.toBeNull();
    reserved.fixture.authority.revoke(
      new Error("worker-local authority unavailable"),
    );
    expect(
      setPauseIntent(
        reserved.fixture,
        "host-pause-without-work-authority",
      ),
    ).toMatchObject({ state: "created" });
    expect(
      snapshot(reserved.fixture).task.pauseRequestedAt,
    ).not.toBeNull();
  });

  it("records Pause observed without changing execution state", () => {
    const reserved = openReservedFixture("intent-pause-observed");
    const fixture = reserved.fixture;
    fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(reserved, snapshot(fixture)),
    );
    const pause = setPauseIntent(fixture, "pause-intent-observed");
    const before = snapshot(fixture);
    const attempt = before.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === reserved.request.id,
    );
    const dispatchEvent = before.events.find(
      (event) =>
        event.type === "recovery.evidence.read_attempt_dispatching" &&
        event.entityId === attempt?.id,
    );
    if (attempt === undefined || dispatchEvent === undefined) {
      throw new Error("Expected dispatched Attempt.");
    }
    const input = {
      ownership: fixture.ownership,
      expectedTaskVersion: before.task.version,
      requestId: reserved.request.id,
      attemptId: attempt.id,
      pauseRequestEventId: pause.eventId,
      dispatchEventId: dispatchEvent.id,
      externalCallStarted: false as const,
      interruptionCause: "pause_before_external_call" as const,
      expectedAttemptVersion: attempt.version,
    };
    expect(
      fixture.unitOfWork.recordOwnedRecoveryEvidenceReadPauseObserved(input),
    ).toMatchObject({
      state: "created",
      replayed: false,
      externalCallStarted: false,
    });
    const after = snapshot(fixture);
    expect(after.recoveryEvidenceReadAttempts).toEqual(
      before.recoveryEvidenceReadAttempts,
    );
    expect(after.toolRuns).toEqual(before.toolRuns);
    expect(after.planSteps).toEqual(before.planSteps);
    expect(after.executionPlans).toEqual(before.executionPlans);
    expect(
      fixture.unitOfWork.recordOwnedRecoveryEvidenceReadPauseObserved(input),
    ).toMatchObject({ state: "replayed", replayed: true });
    expect(snapshot(fixture).events).toHaveLength(after.events.length);
  });

  it.each([true, "unknown"] as const)(
    "records externalCallStarted=%s for Pause observed",
    (externalCallStarted) => {
      const reserved = openReservedFixture(
        `intent-pause-observed-${externalCallStarted}`,
      );
      const fixture = reserved.fixture;
      fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
        dispatchInput(reserved, snapshot(fixture)),
      );
      const pause = setPauseIntent(
        fixture,
        `pause-observed-${externalCallStarted}`,
      );
      const current = snapshot(fixture);
      const attempt = current.recoveryEvidenceReadAttempts.find(
        (candidate) => candidate.readbackRequestId === reserved.request.id,
      );
      const dispatchEvent = current.events.find(
        (event) =>
          event.type ===
            "recovery.evidence.read_attempt_dispatching" &&
          event.entityId === attempt?.id,
      );
      if (attempt === undefined || dispatchEvent === undefined) {
        throw new Error("Expected Pause observed binding.");
      }
      expect(
        fixture.unitOfWork.recordOwnedRecoveryEvidenceReadPauseObserved({
          ownership: fixture.ownership,
          expectedTaskVersion: current.task.version,
          requestId: reserved.request.id,
          attemptId: attempt.id,
          pauseRequestEventId: pause.eventId,
          dispatchEventId: dispatchEvent.id,
          externalCallStarted,
          interruptionCause: "pause_before_transaction_b",
          expectedAttemptVersion: attempt.version,
        }),
      ).toMatchObject({
        state: "created",
        externalCallStarted,
      });
    },
  );

  it("enforces Pause clear generation and prevents stale Resume", () => {
    const reserved = openReservedFixture("intent-pause-generation");
    const fixture = reserved.fixture;
    const firstPause = setPauseIntent(fixture, "pause-generation-1");
    const firstClear = clearPauseIntent(
      fixture,
      "pause-clear-generation-1",
      firstPause.eventId,
    );
    const clearReplay = clearPauseIntent(
      fixture,
      "pause-clear-generation-1",
      firstPause.eventId,
    );
    expect(clearReplay).toMatchObject({
      state: "replayed",
      eventId: firstClear.eventId,
    });
    const secondPause = setPauseIntent(fixture, "pause-generation-2");
    const secondPauseRequestedAt =
      snapshot(fixture).task.pauseRequestedAt;
    const beforeStaleResume = snapshot(fixture);
    expect(() =>
      fixture.unitOfWork.resumeBlockedOwnedRecoveryEvidenceRead(
        resumeInput(
          reserved,
          beforeStaleResume,
          firstClear.eventId,
          "stale-resume-attempt",
        ),
      ),
    ).toThrow(/pause|resume|blocked/i);

    const beforeStaleClear = snapshot(fixture);
    expect(() =>
      fixture.unitOfWork.clearTaskWideRecoveryEvidencePause({
        hostControlAuthorization: hostControlAuthorization(
          fixture,
          "pause_clear",
          "stale-clear-generation-1",
        ),
        expectedTaskVersion: beforeStaleClear.task.version,
        requestNonce: "stale-clear-generation-1",
        controlActor: "host-control",
        expectedPauseRequestedAt:
          beforeStaleClear.task.pauseRequestedAt ?? "",
        pauseRequestEventId: firstPause.eventId,
        expectedPauseEventSequence:
          beforeStaleClear.events.find(
            (event) => event.id === firstPause.eventId,
          )?.sequence ?? 1,
      }),
    ).toThrow(/pause|generation|clear/i);
    expect(snapshot(fixture).task.pauseRequestedAt).not.toBeNull();
    expect(snapshot(fixture).task.pauseRequestedAt).toBe(
      secondPauseRequestedAt,
    );
    expect(secondPause.eventId).toBeTruthy();
  });

  it("keeps Cancel precedence over Pause block and clear", () => {
    const reserved = openReservedFixture("intent-cancel-priority");
    const fixture = reserved.fixture;
    const pause = setPauseIntent(fixture, "pause-before-cancel");
    const cancel = setCancelIntent(fixture, "cancel-after-pause");
    const before = snapshot(fixture);
    const attempt = before.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === reserved.request.id,
    );
    if (attempt === undefined) {
      throw new Error("Expected Pause-block candidate.");
    }
    expect(() =>
      fixture.unitOfWork.blockOwnedRecoveryEvidenceReadForIntent(
        pauseBlockInput(reserved, before, attempt, pause.eventId),
      ),
    ).toThrow(/cancel/i);
    expect(() =>
      fixture.unitOfWork.clearTaskWideRecoveryEvidencePause({
        hostControlAuthorization: hostControlAuthorization(
          fixture,
          "pause_clear",
          "clear-under-cancel",
        ),
        expectedTaskVersion: before.task.version,
        requestNonce: "clear-under-cancel",
        controlActor: "host-control",
        expectedPauseRequestedAt: before.task.pauseRequestedAt ?? "",
        pauseRequestEventId: pause.eventId,
        expectedPauseEventSequence:
          before.events.find((event) => event.id === pause.eventId)
            ?.sequence ?? 1,
      }),
    ).toThrow(/cancel/i);
    expectDispatchStateUnchanged(fixture, before);
    expect(snapshot(fixture).task.cancelRequestedAt).not.toBeNull();
    expect(cancel.eventId).toBeTruthy();
  });

  it("rolls back Pause observed and then rejects stale Authority", () => {
    const reserved = openReservedFixture("intent-pause-observed-failure");
    const fixture = reserved.fixture;
    fixture.unitOfWork.beginOwnedRecoveryEvidenceRead(
      dispatchInput(reserved, snapshot(fixture)),
    );
    const pause = setPauseIntent(fixture, "pause-observed-failure");
    const before = snapshot(fixture);
    const attempt = before.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.readbackRequestId === reserved.request.id,
    );
    const dispatchEvent = before.events.find(
      (event) =>
        event.type === "recovery.evidence.read_attempt_dispatching" &&
        event.entityId === attempt?.id,
    );
    if (attempt === undefined || dispatchEvent === undefined) {
      throw new Error("Expected Pause observed binding.");
    }
    const input = {
      ownership: fixture.ownership,
      expectedTaskVersion: before.task.version,
      requestId: reserved.request.id,
      attemptId: attempt.id,
      pauseRequestEventId: pause.eventId,
      dispatchEventId: dispatchEvent.id,
      externalCallStarted: true as const,
      interruptionCause: "pause_during_external_read" as const,
      expectedAttemptVersion: attempt.version,
    };
    vi.spyOn(EventRepository.prototype, "append").mockImplementationOnce(
      () => {
        throw new Error("injected Pause observed failure");
      },
    );
    expect(() =>
      fixture.unitOfWork.recordOwnedRecoveryEvidenceReadPauseObserved(
        input,
      ),
    ).toThrow(/injected Pause observed failure/i);
    expectDispatchStateUnchanged(fixture, before);
    fixture.authority.revoke(new Error("pause observation failed"));
    expect(() =>
      fixture.unitOfWork.recordOwnedRecoveryEvidenceReadPauseObserved(
        input,
      ),
    ).toThrow(/authority/i);
  });

  it("rolls back Task-wide intent field writes when Event append fails", () => {
    const reserved = openReservedFixture("intent-event-failure");
    const fixture = reserved.fixture;
    const before = snapshot(fixture);
    vi.spyOn(EventRepository.prototype, "append").mockImplementationOnce(
      () => {
        throw new Error("injected Pause intent Event failure");
      },
    );
    expect(() =>
      setPauseIntent(fixture, "pause-event-failure"),
    ).toThrow(/injected Pause intent Event failure/i);
    expectDispatchStateUnchanged(fixture, before);
    expect(snapshot(fixture).task.pauseRequestedAt).toBeNull();

    closeCurrentDatabase();
    const checkpointFixture = openReservedFixture(
      "intent-checkpoint-failure",
    );
    const checkpointBefore = snapshot(checkpointFixture.fixture);
    vi.spyOn(CheckpointStore.prototype, "append").mockImplementationOnce(
      () => {
        throw new Error("injected Pause intent checkpoint failure");
      },
    );
    expect(() =>
      setPauseIntent(
        checkpointFixture.fixture,
        "pause-checkpoint-failure",
      ),
    ).toThrow(/injected Pause intent checkpoint failure/i);
    expectDispatchStateUnchanged(
      checkpointFixture.fixture,
      checkpointBefore,
    );
    expect(snapshot(checkpointFixture.fixture).task.pauseRequestedAt).toBeNull();
  });

  it("keeps Task.status and Original Unknown Write unchanged for intents", () => {
    const reserved = openReservedFixture("intent-audit");
    const before = snapshot(reserved.fixture);
    const originalRun = before.toolRuns.find(
      (run) => run.id === reserved.fixture.originalToolRunId,
    );
    setPauseIntent(reserved.fixture, "pause-intent-audit");
    expect(snapshot(reserved.fixture).task.status).toBe("waiting_review");
    expect(
      snapshot(reserved.fixture).toolRuns.find(
        (run) => run.id === reserved.fixture.originalToolRunId,
      ),
    ).toEqual(originalRun);
  });
});

interface ReservedFixture {
  readonly fixture: RecoveryEvidenceUowFixture;
  readonly request: ReturnType<
    RecoveryEvidenceUowFixture["unitOfWork"]["createOwnedRecoveryEvidenceReadbackRequest"]
  >["request"];
}

function openReservedFixture(suffix: string): ReservedFixture {
  const fixture = openFixture(suffix, {
    allowlistVersion: DISPATCH_ALLOWLIST_VERSION,
    readToolSchemaHash: DISPATCH_READ_TOOL_SCHEMA_HASH,
  });
  const reservations = new RecoveryEvidenceReadbackReservationUnitOfWork(
    fixture.database,
    () => fixture.authority.assertActive(),
    fixture.leaseManager,
    { now: () => new Date("2026-11-08T00:04:00.000Z") },
  );
  const input = requestInput(fixture, suffix);
  const requestIntent = {
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    allowlistId: DISPATCH_ALLOWLIST_ID,
    verificationCheckId: fixture.verificationCheckId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
  };
  const acquired = reservations.acquireOwned({
    ownership: fixture.ownership,
    expectedTaskVersion: snapshot(fixture).task.version,
    requestIntent,
    requestId: input.requestId,
    operationId: input.operationId,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    readAttemptId: input.readAttemptId,
  });
  if (acquired.state !== "acquired" || acquired.ownerToken === null) {
    throw new Error("Expected acquired Reservation.");
  }
  let request: ReservedFixture["request"] | undefined;
  reservations.completeOwned(
    {
      ownership: fixture.ownership,
      reservationId: acquired.reservation.id,
      expectedReservationVersion:
        acquired.reservation.reservationVersion,
      ownerToken: acquired.ownerToken,
      requestIntent,
    },
    ({ task }) => {
      request =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest({
          ...input,
          expectedTaskVersion: task.version,
        }).request;
    },
  );
  if (request === undefined) {
    throw new Error("Expected Transaction A Request.");
  }
  return { fixture, request };
}

function openFixture(
  suffix: string,
  options: {
    readonly allowlistVersion?: string;
    readonly readToolSchemaHash?: string;
  } = {},
): RecoveryEvidenceUowFixture {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  return createRecoveryEvidenceUowFixture(database, suffix, options);
}

function dispatchInput(
  reserved: ReservedFixture,
  current: ReturnType<typeof snapshot>,
  selectedAttemptId?: string,
) {
  const { fixture, request } = reserved;
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request.readToolRunId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request.executionPlanId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request.planStepId,
  );
  if (run === undefined || plan === undefined || step === undefined) {
    throw new Error("Expected Dispatch binding.");
  }
  const readAttempt = current.recoveryEvidenceReadAttempts.find(
    (candidate) =>
      candidate.readbackRequestId === request.id &&
      (selectedAttemptId === undefined ||
        candidate.id === selectedAttemptId),
  );
  if (readAttempt === undefined) {
    throw new Error("Expected Dispatch Attempt.");
  }
  const preflight = prepareRecoveryEvidenceDispatchPreflight({
    registry: createDispatchReadbackRegistry(),
    allowlistId: request.allowlistId,
    expectedAllowlistContractDigest: request.allowlistVersion,
  });
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    attemptId: readAttempt.id,
    preflight,
    expectedCanonicalInputHash: run.canonicalInputHash,
    expectedAttemptVersion: readAttempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
  };
}

function hostControlAuthorization(
  fixture: RecoveryEvidenceUowFixture,
  operation: "cancel_set" | "pause_set" | "pause_clear",
  requestNonce: string,
) {
  return issueRecoveryEvidenceHostControlAuthorization({
    taskId: fixture.taskId,
    operation,
    requestNonce,
    controlActor: "host-control",
  });
}

function setCancelIntent(
  fixture: RecoveryEvidenceUowFixture,
  requestNonce: string,
) {
  return fixture.unitOfWork.setTaskWideRecoveryEvidenceCancel({
    hostControlAuthorization: hostControlAuthorization(
      fixture,
      "cancel_set",
      requestNonce,
    ),
    expectedTaskVersion: snapshot(fixture).task.version,
    requestNonce,
    controlActor: "host-control",
  });
}

function setPauseIntent(
  fixture: RecoveryEvidenceUowFixture,
  requestNonce: string,
) {
  return fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
    hostControlAuthorization: hostControlAuthorization(
      fixture,
      "pause_set",
      requestNonce,
    ),
    expectedTaskVersion: snapshot(fixture).task.version,
    requestNonce,
    controlActor: "host-control",
  });
}

function clearPauseIntent(
  fixture: RecoveryEvidenceUowFixture,
  requestNonce: string,
  pauseRequestEventId: string,
) {
  const current = snapshot(fixture);
  const pauseEvent = current.events.find(
    (event) => event.id === pauseRequestEventId,
  );
  if (pauseEvent === undefined) {
    throw new Error("Expected active Pause generation.");
  }
  const clearEvent = current.events.find(
    (event) =>
      event.type === "recovery.evidence.pause_cleared" &&
      event.payload.clearedPauseEventId === pauseRequestEventId &&
      event.payload.requestNonce === requestNonce,
  );
  const pauseRequestedAt =
    current.task.pauseRequestedAt ??
    (typeof clearEvent?.payload.pauseRequestedAt === "string"
      ? clearEvent.payload.pauseRequestedAt
      : null);
  if (pauseRequestedAt === null) {
    throw new Error("Expected Pause generation timestamp.");
  }
  return fixture.unitOfWork.clearTaskWideRecoveryEvidencePause({
    hostControlAuthorization: hostControlAuthorization(
      fixture,
      "pause_clear",
      requestNonce,
    ),
    expectedTaskVersion: current.task.version,
    requestNonce,
    controlActor: "host-control",
    expectedPauseRequestedAt: pauseRequestedAt,
    pauseRequestEventId,
    expectedPauseEventSequence: pauseEvent.sequence,
  });
}

function terminalInput(
  reserved: ReservedFixture,
  current: ReturnType<typeof snapshot>,
  terminalStatus: "failed" | "timed_out",
  reasonCode: string,
) {
  const { fixture, request } = reserved;
  const attempt = current.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.readbackRequestId === request.id,
  );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request.executionPlanId,
  );
  if (
    attempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined
  ) {
    throw new Error("Expected terminal input binding.");
  }
  return {
    ownership: fixture.ownership,
    requestId: request.id,
    attemptId: attempt.id,
    expectedAttemptVersion: attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
    terminalStatus,
    reasonCode,
  };
}

function cancelInput(
  reserved: ReservedFixture,
  current: ReturnType<typeof snapshot>,
  cancelIntentEventId: string,
) {
  const { fixture, request } = reserved;
  const attempt = current.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.readbackRequestId === request.id,
  );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request.executionPlanId,
  );
  if (
    attempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined
  ) {
    throw new Error("Expected cancel input binding.");
  }
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    attemptId: attempt.id,
    cancelIntentEventId,
    expectedAttemptVersion: attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
    reasonCode: "CANCEL_REQUESTED" as const,
  };
}

function pauseBlockInput(
  reserved: ReservedFixture,
  current: ReturnType<typeof snapshot>,
  attempt: RecoveryEvidenceReadAttemptRecord,
  pauseRequestEventId: string,
) {
  const { fixture, request } = reserved;
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request.executionPlanId,
  );
  if (run === undefined || step === undefined || plan === undefined) {
    throw new Error("Expected Pause block binding.");
  }
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    attemptId: attempt.id,
    pauseRequestEventId,
    expectedAttemptVersion: attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
    reasonCode: "PAUSE_REQUESTED" as const,
  };
}

function resumeInput(
  reserved: ReservedFixture,
  current: ReturnType<typeof snapshot>,
  pauseClearEventId: string,
  newAttemptId?: string,
) {
  const { fixture, request } = reserved;
  const priorAttempt = current.recoveryEvidenceReadAttempts.find(
    (attempt) =>
      attempt.readbackRequestId === request.id &&
      attempt.status === "blocked_by_intent",
  );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request.executionPlanId,
  );
  if (
    priorAttempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined
  ) {
    throw new Error("Expected Resume input binding.");
  }
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    priorAttemptId: priorAttempt.id,
    newAttemptId:
      newAttemptId ?? `resume-attempt-${reserved.request.id}`,
    pauseClearEventId,
    expectedPriorAttemptVersion: priorAttempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
  };
}

function transitionAttemptInCurrentTransaction(
  fixture: RecoveryEvidenceUowFixture,
  input: Parameters<
    RecoveryEvidenceUowFixture["stateTransitions"]["transitionOwnedRecoveryEvidenceReadAttempt"]
  >[0],
) {
  let effectiveInput = input;
  if (
    input.status === "interrupted" &&
    input.recoveryLineage === undefined
  ) {
    const interruption = createRecoveryInterruptionFixture(fixture, {
      attemptId: input.attemptId,
      reasonCode:
        input.reasonCode ?? "FENCING_TAKEOVER",
    });
    effectiveInput = {
      ...input,
      ownership: interruption.ownership,
      expectedTaskVersion: snapshot(fixture).task.version,
      reasonCode: interruption.lineage.reasonCode,
      recoveryLineage: interruption.lineage,
    };
  }
  return runInTransaction(
    fixture.database,
    () =>
      fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
        effectiveInput,
        createStorageWritePermit(fixture.database),
      ),
    "immediate",
  );
}

function preparedDispatchTransitionInput(
  fixture: RecoveryEvidenceUowFixture,
  attempt: RecoveryEvidenceReadAttemptRecord,
) {
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: snapshot(fixture).task.version,
    attemptId: attempt.id,
    expectedAttemptVersion: attempt.version,
    status: "dispatching" as const,
    observedAt: null,
    resourceVersion: null,
    resourceEtag: null,
    resultDigest: null,
    resultPayloadStoreRef: null,
    reasonCode: null,
  };
}

function requestInput(fixture: RecoveryEvidenceUowFixture, suffix: string) {
  const actorId = "reviewer-host";
  const operationPayloadDigest =
    computeRecoveryEvidenceReadbackOperationPayloadDigest({
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalUnknownToolRunId: fixture.originalToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("7"),
      allowlistId: DISPATCH_ALLOWLIST_ID,
      allowlistVersion: fixture.allowlistVersion,
      readToolName: DISPATCH_READ_TOOL_NAME,
      readToolVersion: DISPATCH_READ_TOOL_VERSION,
      readToolSchemaHash: fixture.readToolSchemaHash,
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
      verificationCheckId: fixture.verificationCheckId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
    });
  const requestKey = computeRecoveryReviewOperationRequestKey({
    reviewId: fixture.reviewId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    operation: "request_readback",
    operationPayloadDigest,
    actorId,
  });
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: fixture.expectedTaskVersion,
    requestId: `dispatch-request-${suffix}`,
    operationId: `dispatch-operation-${suffix}`,
    readAttemptId: `dispatch-attempt-${suffix}`,
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    actorId,
    operationPayloadDigest,
    requestKey,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    verifierId: "host_verifier",
    verifierVersion: "1",
    verifierConfigDigest: digest("7"),
    allowlistId: DISPATCH_ALLOWLIST_ID,
    allowlistVersion: fixture.allowlistVersion,
    readToolName: DISPATCH_READ_TOOL_NAME,
    readToolVersion: DISPATCH_READ_TOOL_VERSION,
    readToolSchemaHash: fixture.readToolSchemaHash,
    retrySafety: "version_conditional" as const,
    consistencyMode: "etag_or_resource_version" as const,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
    verificationCheckId: fixture.verificationCheckId,
  };
}

function snapshot(fixture: RecoveryEvidenceUowFixture) {
  return new TaskSnapshotReader(fixture.database).load(fixture.taskId);
}

function setTaskIntent(
  fixture: RecoveryEvidenceUowFixture,
  intent: "cancel" | "pause",
): void {
  runInTransaction(
    fixture.database,
    () => {
      createStorageWritePermit(fixture.database);
      fixture.database
        .prepare(
          `
            UPDATE tasks
            SET ${intent === "cancel" ? "cancel_requested_at" : "pause_requested_at"} = ?,
                version = version + 1,
                updated_at = ?
            WHERE id = ?
          `,
        )
        .run(
          "2026-11-08T00:05:00.000Z",
          "2026-11-08T00:05:00.000Z",
          fixture.taskId,
        );
    },
    "immediate",
  );
}

function updateOne(
  fixture: RecoveryEvidenceUowFixture,
  sql: string,
  parameter: string,
): void {
  runInTransaction(
    fixture.database,
    () => {
      createStorageWritePermit(fixture.database);
      fixture.database.prepare(sql).run(parameter);
    },
    "immediate",
  );
}

function closeCurrentDatabase(): void {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
}

function expectDispatchStateUnchanged(
  fixture: RecoveryEvidenceUowFixture,
  before: ReturnType<typeof snapshot>,
): void {
  const after = snapshot(fixture);
  expect(
    after.recoveryEvidenceReadAttempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
    })),
  ).toEqual(
    before.recoveryEvidenceReadAttempts.map((attempt) => ({
      id: attempt.id,
      status: attempt.status,
    })),
  );
  expect(
    after.toolRuns.find((run) => run.id === fixture.readToolRunId)?.status,
  ).toBe(
    before.toolRuns.find((run) => run.id === fixture.readToolRunId)?.status,
  );
  expect(
    after.planSteps.find((step) => step.id === fixture.planStepId)?.status,
  ).toBe(
    before.planSteps.find((step) => step.id === fixture.planStepId)?.status,
  );
  expect(after.events).toHaveLength(before.events.length);
  expect(after.checkpoints).toHaveLength(before.checkpoints.length);
}

function startDispatchWorker(
  input: unknown,
  preflightSource: {
    readonly allowlistId: string;
    readonly expectedAllowlistContractDigest: string;
  },
): Promise<ChildProcess> {
  if (temporaryDatabase === undefined) {
    throw new Error("Temporary database is unavailable.");
  }
  if (typeof input !== "object" || input === null) {
    throw new Error("Dispatch worker input is invalid.");
  }
  const { preflight: _preflight, ...serializableInput } =
    input as Record<string, unknown>;
  const worker = fork(
    dispatchWorkerPath,
    [
      JSON.stringify({
        databasePath: temporaryDatabase.path,
        input: serializableInput,
        preflight: preflightSource,
        now: "2026-11-08T00:00:00.000Z",
      }),
    ],
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
      reject(new Error(`Dispatch worker readiness timed out.\n${stderr}`));
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
          `Dispatch worker exited before readiness (${String(code)}).\n${stderr}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}

function runDispatchWorker(worker: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Dispatch worker timed out."));
    }, WORKER_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete" &&
        "state" in message &&
        typeof message.state === "string"
      ) {
        cleanup();
        resolve(message.state);
        return;
      }
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "error"
      ) {
        cleanup();
        reject(
          new Error(
            "code" in message && typeof message.code === "string"
              ? message.code
              : "DISPATCH_WORKER_FAILED",
          ),
        );
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
    };
    worker.on("message", onMessage);
    worker.send({ type: "start" });
  });
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
