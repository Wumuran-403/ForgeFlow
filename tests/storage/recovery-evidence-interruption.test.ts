import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventRepository,
  ExecutionPlanRepository,
  PlanStepRepository,
  RecoveryEvidenceFencingTakeoverGuard,
  RecoveryEvidenceReadAttemptRepository,
  RecoveryEvidenceReadbackReservationUnitOfWork,
  RecoveryEvidenceUnitOfWork,
  SequenceAllocator,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { ExecutionAuthority } from "../../src/persistence/lease-heartbeat.js";
import {
  prepareRecoveryEvidenceRecoveryPreflight,
  type RecoveryEvidenceRecoveryPreflightResult,
} from "../../src/recovery/recovery-evidence-recovery-preflight.js";
import { prepareRecoveryEvidenceDispatchPreflight } from "../../src/recovery/recovery-evidence-dispatch-preflight.js";
import { issueRecoveryEvidenceHostControlAuthorization } from "../../src/recovery/recovery-evidence-host-control-authorization.js";
import { computeCanonicalInputHash } from "../../src/tools/fingerprint.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { RecoveryEvidenceInterruptionUnitOfWork } from "../../src/storage/recovery-evidence-interruption-unit-of-work.js";
import { RecoveryEvidenceFullRecoveryUnitOfWork } from "../../src/storage/recovery-evidence-full-recovery-unit-of-work.js";
import { RecoveryEvidenceStateTransitionUnitOfWork } from "../../src/storage/recovery-evidence-state-transition-unit-of-work.js";
import {
  RecoveryEvidenceInterruptLineageV1Schema,
  RecoveryEvidencePrepareLineageV1Schema,
  type RecoveryEvidenceInterruptLineageV1,
} from "../../src/storage/recovery-evidence-recovery-lineage.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createRecoveryEvidenceUowFixture,
  type RecoveryEvidenceUowFixture,
} from "./recovery-evidence-uow-fixture.js";
import {
  DISPATCH_ALLOWLIST_ID,
  DISPATCH_ALLOWLIST_VERSION,
  DISPATCH_READ_TOOL_SCHEMA_HASH,
  createDispatchReadbackRegistry,
} from "./recovery-evidence-dispatch-contract.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let context: InterruptionTestContext | undefined;
const recoveryWorkers: ChildProcess[] = [];
const recoveryWorkerPath = fileURLToPath(
  new URL(
    "./recovery-evidence-full-recovery-worker.ts",
    import.meta.url,
  ),
);

afterEach(() => {
  for (const worker of recoveryWorkers.splice(0)) {
    if (worker.connected) {
      worker.disconnect();
    }
    if (!worker.killed) {
      worker.kill();
    }
  }
  if (context !== undefined) {
    closeDatabase(context.database);
    context.temporaryDatabase.cleanup();
    context = undefined;
  }
  vi.restoreAllMocks();
});

describe("RecoveryEvidenceInterruptionUnitOfWork", () => {
  it("interrupts for Cancel, returns the persisted Event, and Exact Replays", () => {
    const active = openInterruptionContext("interrupt-cancel");
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    const cancelIntentEventId = setCancelIntent(active);
    const input = interruptionInput(active, operationId);
    const before = snapshot(active);
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );

    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(input);
    expect(result).toMatchObject({
      status: "interrupted_cancel_pending",
      replayed: false,
      retryAssessment: "not_evaluated",
      interruptionEventId: result.attempt.lastEventId,
    });
    const after = snapshot(active);
    expect(after.task.status).toBe("waiting_review");
    const attempt = after.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.id === active.attemptId,
    );
    const interruptionEvent = after.events.find(
      (event) => event.id === result.interruptionEventId,
    );
    expect(attempt).toMatchObject({
      status: "interrupted",
      lastEventId: interruptionEvent?.id,
    });
    expect(
      after.toolRuns.find(
        (candidate) => candidate.id === active.fixture.readToolRunId,
      )?.status,
    ).toBe("interrupted");
    expect(
      after.planSteps.find(
        (candidate) => candidate.id === active.fixture.planStepId,
      )?.status,
    ).toBe("interrupted");
    expect(
      after.executionPlans.find(
        (candidate) =>
          candidate.id === active.fixture.executionPlanId,
      )?.status,
    ).toBe("active");
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        interruptionEvent?.payload,
      ),
    ).toMatchObject({
      controlIntentKind: "cancel",
      controlIntentEventId: cancelIntentEventId,
      retryAssessment: "not_evaluated",
      resumeEligible: false,
    });
    expect(after.recoveryEvidenceReadAttempts).toHaveLength(
      before.recoveryEvidenceReadAttempts.length,
    );
    expect(executeValidated).not.toHaveBeenCalled();

    const eventCount = after.events.length;
    const checkpointCount = after.checkpoints.length;
    const replay = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(input);
    expect(replay).toMatchObject({
      status: "interrupted_cancel_pending",
      replayed: true,
      interruptionEventId: result.interruptionEventId,
    });
    const afterReplay = snapshot(active);
    expect(afterReplay.events).toHaveLength(eventCount);
    expect(afterReplay.checkpoints).toHaveLength(checkpointCount);
  });

  it("supports Pause + Preflight passed and Prepare-child Replay", async () => {
    const active = openInterruptionContext("interrupt-pause-passed");
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    setPauseIntent(active);
    const preflight = await preparePreflight(active);
    expect(preflight).toMatchObject({
      state: "passed",
      retryAssessment: "passed",
    });
    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, operationId, preflight),
      );
    expect(result).toMatchObject({
      status: "interrupted_pause_pending",
      retryAssessment: "passed",
      replayed: false,
    });
    const interruptedSnapshot = snapshot(active);
    const interruptionEvent = interruptedSnapshot.events.find(
      (event) => event.id === result.interruptionEventId,
    );
    const lineage =
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        interruptionEvent?.payload,
      );
    expect(lineage).toMatchObject({
      controlIntentKind: "pause",
      retryAssessment: "passed",
      resumeEligible: true,
    });

    createPreparedRecoveryChild(active, lineage, result.interruptionEventId!);
    const beforeReplay = snapshot(active);
    const replay = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, operationId, preflight),
      );
    expect(replay).toMatchObject({
      status: "interrupted_pause_pending",
      replayed: true,
      attempt: { id: active.attemptId },
    });
    const afterReplay = snapshot(active);
    expect(afterReplay.events).toHaveLength(
      beforeReplay.events.length,
    );
    expect(afterReplay.checkpoints).toHaveLength(
      beforeReplay.checkpoints.length,
    );
    expect(afterReplay.recoveryEvidenceReadAttempts).toHaveLength(
      beforeReplay.recoveryEvidenceReadAttempts.length,
    );
  });

  it("records Pause with Preflight failed", async () => {
    const active = openInterruptionContext("interrupt-pause-failed", {
      canonicalInputHash: digest("f"),
    });
    takeOver(active, "worker-b");
    setPauseIntent(active);
    const preflight = await preparePreflight(active);
    expect(preflight).toMatchObject({
      state: "failed",
      retryAssessment: "failed",
    });
    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), preflight),
      );
    expect(result).toMatchObject({
      status: "interrupted_pause_pending",
      retryAssessment: "failed",
      preflightReasonCode: "CANONICAL_INPUT_HASH_MISMATCH",
      recommendedNextAction: "manual_review",
    });
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        snapshot(active).events.find(
          (event) => event.id === result.interruptionEventId,
        )?.payload,
      ),
    ).toMatchObject({
      retryAssessment: "failed",
      resumeEligible: false,
    });
  });

  it("records Pause with Preflight not_evaluated", async () => {
    const active = openInterruptionContext(
      "interrupt-pause-not-evaluated",
      {
        requestAllowlistVersion: "a".repeat(64),
      },
    );
    takeOver(active, "worker-b");
    setPauseIntent(active);
    const preflight = await preparePreflight(active);
    expect(preflight).toMatchObject({
      state: "not_evaluated",
      retryAssessment: "not_evaluated",
    });
    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), preflight),
      );
    expect(result).toMatchObject({
      status: "interrupted_pause_pending",
      retryAssessment: "not_evaluated",
      preflightReasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      recommendedNextAction: "manual_review",
    });
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        snapshot(active).events.find(
          (event) => event.id === result.interruptionEventId,
        )?.payload,
      ),
    ).toMatchObject({
      retryAssessment: "not_evaluated",
      resumeEligible: false,
    });
  });

  it("records Retry Unsafe interruption when no control intent exists", async () => {
    const active = openInterruptionContext("interrupt-retry-unsafe", {
      canonicalInputHash: digest("f"),
    });
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), preflight),
      );
    expect(result).toMatchObject({
      status: "interrupted_retry_unsafe",
      retryAssessment: "failed",
      recommendedNextAction: "manual_review",
    });
  });

  it("does not write when Full Recovery is required", async () => {
    const active = openInterruptionContext("interrupt-full-required");
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const before = snapshot(active);
    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), preflight),
      );
    expect(result).toEqual({
      status: "full_recovery_required",
      replayed: false,
      attempt: expect.objectContaining({ id: active.attemptId }),
      interruptionEventId: null,
      retryAssessment: "passed",
      preflightReasonCode: null,
      recommendedNextAction: "stage3_4_full_recovery",
    });
    expectStateUnchanged(active, before);
  });

  it("does not write when no-intent Preflight is not_evaluated", async () => {
    const active = openInterruptionContext(
      "interrupt-preflight-unavailable",
      {
        requestAllowlistVersion: "a".repeat(64),
      },
    );
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const before = snapshot(active);
    const result = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), preflight),
      );
    expect(result).toMatchObject({
      status: "retry_assessment_unavailable",
      retryAssessment: "not_evaluated",
      interruptionEventId: null,
      recommendedNextAction: "manual_review",
    });
    expectStateUnchanged(active, before);
  });

  it("gives Cancel priority over Pause and rejects old/forged authorization", () => {
    const active = openInterruptionContext("interrupt-priority");
    setPauseIntent(active);
    const cancelIntentEventId = setCancelIntent(active);
    const current = snapshot(active).task.version;
    const oldOwnership = {
      taskId: active.fixture.taskId,
      leaseToken: active.ownership.leaseToken,
      fencingToken: active.ownership.fencingToken,
    };
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt({
        ...interruptionInput(active, randomUUID()),
        ownership: oldOwnership,
      }),
    ).toThrowError(/lease claim event|dispatch event/i);
    expect(snapshot(active).task.version).toBe(current);

    takeOver(active, "worker-b");
    const cancelResult = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID()),
      );
    expect(cancelResult.status).toBe("interrupted_cancel_pending");
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        snapshot(active).events.find(
          (event) => event.id === cancelResult.interruptionEventId,
        )?.payload,
      ).controlIntentEventId,
    ).toBe(cancelIntentEventId);
  });

  it("rejects invalid Authority, Claim Event and persisted identity", () => {
    const active = openInterruptionContext("interrupt-invalid-auth");
    takeOver(active, "worker-b");
    setCancelIntent(active);
    const input = interruptionInput(active, randomUUID());
    const before = snapshot(active);

    active.authority.revoke(new Error("stale authority"));
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(input),
    ).toThrowError(/authority/i);
    expectStateUnchanged(active, before);

    takeOver(active, "worker-c");
    const beforeInvalidBindings = snapshot(active);
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt({
        ...input,
        ownership: active.ownership,
        currentLeaseClaimEventId: randomUUID(),
      }),
    ).toThrowError(/lease claim event is invalid/i);
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt({
        ...input,
        ownership: active.ownership,
        currentLeaseClaimEventId: active.currentLeaseClaimEventId,
        requestId: "missing-request",
      }),
    ).toThrowError(/not found/i);
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt({
        ...input,
        ownership: active.ownership,
        currentLeaseClaimEventId: active.currentLeaseClaimEventId,
        priorAttemptId: "missing-attempt",
      }),
    ).toThrowError(/not found/i);
    expectStateUnchanged(active, beforeInvalidBindings);
  });

  it("rejects an additional active Attempt in the transaction", () => {
    const active = openInterruptionContext("interrupt-active-conflict");
    takeOver(active, "worker-b");
    createPreparedSibling(active);
    setCancelIntent(active);
    const before = snapshot(active);
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID()),
      ),
    ).toThrowError(/active attempt|inconsistent/i);
    expectStateUnchanged(active, before);
  });

  it("rejects forged and spread-cloned Preflight results", async () => {
    const active = openInterruptionContext("interrupt-forged-preflight", {
      canonicalInputHash: digest("f"),
    });
    takeOver(active, "worker-b");
    setPauseIntent(active);
    const genuineFailure = await preparePreflight(active);
    expect(Object.isFrozen(genuineFailure)).toBe(true);
    const before = snapshot(active);
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), {
          state: "failed",
          retryAssessment: "failed",
          reasonCode: "FORGED",
        }),
      ),
    ).toThrowError(/capability/i);
    expect(() =>
      active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, randomUUID(), {
          ...genuineFailure,
        }),
      ),
    ).toThrowError(/capability/i);
    expectStateUnchanged(active, before);
  });

  it("rolls back when Interrupted Event or Checkpoint append fails", () => {
    const eventFailure =
      openInterruptionContext("interrupt-event-rollback");
    takeOver(eventFailure, "worker-b");
    setCancelIntent(eventFailure);
    const eventBefore = snapshot(eventFailure);
    vi.spyOn(EventRepository.prototype, "append").mockImplementationOnce(
      () => {
        throw new Error("injected interruption event failure");
      },
    );
    expect(() =>
      eventFailure.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(eventFailure, randomUUID()),
      ),
    ).toThrow(/injected interruption event failure/i);
    expectStateUnchanged(eventFailure, eventBefore);

    closeCurrentContext();
    const checkpointFailure =
      openInterruptionContext("interrupt-checkpoint-rollback");
    takeOver(checkpointFailure, "worker-b");
    setCancelIntent(checkpointFailure);
    checkpointFailure.database.exec(
      `
        CREATE TRIGGER reject_recovery_interruption_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'recovery_read_attempt_interrupted'
        BEGIN
          SELECT RAISE(ABORT, 'interruption checkpoint rejected');
        END
      `,
    );
    const checkpointBefore = snapshot(checkpointFailure);
    expect(() =>
      checkpointFailure.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(checkpointFailure, randomUUID()),
      ),
    ).toThrow(/interruption checkpoint rejected/i);
    expectStateUnchanged(checkpointFailure, checkpointBefore);
  });

  it("replays across fencing ownership and after Cancel convergence", () => {
    const active = openInterruptionContext("interrupt-cross-owner-replay");
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    const cancelIntentEventId = setCancelIntent(active);
    const originalInput = interruptionInput(active, operationId);
    const first = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(originalInput);

    takeOver(active, "worker-c");
    const beforeCrossOwner = snapshot(active);
    const replay = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt({
        ...originalInput,
        ownership: active.ownership,
        currentLeaseClaimEventId: active.currentLeaseClaimEventId,
      });
    expect(replay).toMatchObject({
      replayed: true,
      interruptionEventId: first.interruptionEventId,
    });
    expect(snapshot(active).events).toHaveLength(
      beforeCrossOwner.events.length,
    );

    convergeCancel(active, cancelIntentEventId);
    const beforeConvergedReplay = snapshot(active);
    const convergedReplay = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt({
        ...originalInput,
        ownership: active.ownership,
        currentLeaseClaimEventId: active.currentLeaseClaimEventId,
      });
    expect(convergedReplay).toMatchObject({
      replayed: true,
      interruptionEventId: first.interruptionEventId,
    });
    expect(snapshot(active).events).toHaveLength(
      beforeConvergedReplay.events.length,
    );
  });
});

describe("RecoveryEvidenceFullRecoveryUnitOfWork", () => {
  it("atomically creates a prepared New Attempt from dispatching", async () => {
    const active = openInterruptionContext("full-recovery-valid");
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const before = snapshot(active);
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );

    const result = runFullRecovery(
      active,
      randomUUID(),
      preflight,
    );
    expect(result).toMatchObject({
      status: "prepared",
      replayed: false,
      retryAssessment: "passed",
    });
    if (
      result.status !== "prepared" ||
      result.newAttempt === null
    ) {
      throw new Error("Expected prepared Full Recovery.");
    }
    expect(result.newAttempt.id).not.toBe(before.recoveryEvidenceReadAttempts[0]?.id);
    expect(result.newAttempt.attemptNumber).toBe(2);

    const after = snapshot(active);
    const oldAttempt = after.recoveryEvidenceReadAttempts.find(
      (attempt) => attempt.id === active.attemptId,
    );
    const newAttempt = after.recoveryEvidenceReadAttempts.find(
      (attempt) => attempt.id === result.newAttempt?.id,
    );
    expect(oldAttempt?.status).toBe("interrupted");
    expect(newAttempt).toMatchObject({
      status: "prepared",
      attemptNumber: 2,
      lastEventId: result.preparedEventId,
    });
    expect(
      after.toolRuns.find(
        (run) => run.id === active.fixture.readToolRunId,
      )?.status,
    ).toBe("queued");
    expect(
      after.planSteps.find(
        (step) => step.id === active.fixture.planStepId,
      )?.status,
    ).toBe("running");
    expect(
      after.executionPlans.find(
        (plan) => plan.id === active.fixture.executionPlanId,
      )?.status,
    ).toBe("active");
    expect(after.recoveryEvidenceReadAttempts).toHaveLength(
      before.recoveryEvidenceReadAttempts.length + 1,
    );
    expect(executeValidated).not.toHaveBeenCalled();

    const interruptionEvent = after.events.find(
      (event) => event.id === result.interruptionEventId,
    );
    const preparedEvent = after.events.find(
      (event) => event.id === result.preparedEventId,
    );
    const interrupt =
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        interruptionEvent?.payload,
      );
    const prepare = RecoveryEvidencePrepareLineageV1Schema.parse(
      preparedEvent?.payload,
    );
    expect(prepare).toMatchObject({
      recoveryOperationId: interrupt.recoveryOperationId,
      interruptionEventId: interruptionEvent?.id,
      priorAttemptId: active.attemptId,
      newAttemptId: result.newAttempt.id,
      attemptNumber: 2,
    });
    expect(interrupt.leaseClaimEventId).toBe(
      active.currentLeaseClaimEventId,
    );
    expect(prepare.leaseClaimEventId).toBe(
      active.currentLeaseClaimEventId,
    );
  });

  it("does not create an Attempt when Preflight is failed or unavailable", async () => {
    const failed = openInterruptionContext(
      "full-recovery-preflight-failed",
      {
        canonicalInputHash: digest("f"),
      },
    );
    takeOver(failed, "worker-b");
    const failedPreflight = await preparePreflight(failed);
    const failedBefore = snapshot(failed);
    expect(
      runFullRecovery(failed, randomUUID(), failedPreflight),
    ).toMatchObject({
      status: "manual_review",
      newAttempt: null,
      retryAssessment: "failed",
    });
    expectStateUnchanged(failed, failedBefore);

    closeCurrentContext();
    const unavailable = openInterruptionContext(
      "full-recovery-preflight-unavailable",
      {
        requestAllowlistVersion: "a".repeat(64),
      },
    );
    takeOver(unavailable, "worker-b");
    const unavailablePreflight = await preparePreflight(unavailable);
    const unavailableBefore = snapshot(unavailable);
    expect(
      runFullRecovery(
        unavailable,
        randomUUID(),
        unavailablePreflight,
      ),
    ).toMatchObject({
      status: "retry_assessment_unavailable",
      newAttempt: null,
      retryAssessment: "not_evaluated",
    });
    expectStateUnchanged(unavailable, unavailableBefore);

    closeCurrentContext();
    const digestMismatch = openInterruptionContext(
      "full-recovery-digest-mismatch",
    );
    takeOver(digestMismatch, "worker-b");
    const mismatchPreflight = await preparePreflight(
      digestMismatch,
      {
        expectedRequestIntentDigest: digest("b"),
      },
    );
    const mismatchBefore = snapshot(digestMismatch);
    expect(
      runFullRecovery(
        digestMismatch,
        randomUUID(),
        mismatchPreflight,
      ),
    ).toMatchObject({
      status: "manual_review",
      newAttempt: null,
      retryAssessment: "failed",
    });
    expectStateUnchanged(digestMismatch, mismatchBefore);
  });

  it("gives Cancel priority and rejects conflicting active Attempts", async () => {
    const cancel = openInterruptionContext("full-recovery-cancel");
    takeOver(cancel, "worker-b");
    setPauseIntent(cancel);
    setCancelIntent(cancel);
    const preflight = await preparePreflight(cancel);
    const cancelBefore = snapshot(cancel);
    expect(
      runFullRecovery(cancel, randomUUID(), preflight),
    ).toMatchObject({
      status: "cancel_required",
      newAttempt: null,
    });
    expectStateUnchanged(cancel, cancelBefore);

    closeCurrentContext();
    const conflict = openInterruptionContext(
      "full-recovery-active-conflict",
    );
    takeOver(conflict, "worker-b");
    createPreparedSibling(conflict);
    const conflictPreflight = await preparePreflight(conflict);
    const conflictBefore = snapshot(conflict);
    expect(() =>
      runFullRecovery(
        conflict,
        randomUUID(),
        conflictPreflight,
      ),
    ).toThrowError(/active attempt|inconsistent/i);
    expectStateUnchanged(conflict, conflictBefore);
  });

  it("rejects stale Authority and Claim Event before creating an Attempt", async () => {
    const active = openInterruptionContext(
      "full-recovery-stale-authority",
    );
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const before = snapshot(active);
    active.authority.revoke(new Error("stale authority"));
    expect(() =>
      runFullRecovery(active, randomUUID(), preflight),
    ).toThrowError(/authority/i);
    expectStateUnchanged(active, before);

    takeOver(active, "worker-c");
    const beforeClaim = snapshot(active);
    expect(() =>
      runFullRecovery(active, randomUUID(), preflight, {
        currentLeaseClaimEventId: randomUUID(),
      }),
    ).toThrowError(/lease claim event is invalid/i);
    expectStateUnchanged(active, beforeClaim);
  });

  it("replays the same Prepared Event across owners", async () => {
    const active = openInterruptionContext("full-recovery-replay");
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const first = runFullRecovery(active, operationId, preflight);
    if (
      first.status !== "prepared" ||
      first.newAttempt === null
    ) {
      throw new Error("Expected prepared Full Recovery.");
    }
    const afterFirst = snapshot(active);
    const historicalPrepared = afterFirst.events.find(
      (event) => event.id === first.preparedEventId,
    );
    const historicalClaimEventId =
      RecoveryEvidencePrepareLineageV1Schema.parse(
        historicalPrepared?.payload,
      ).leaseClaimEventId;
    const replaySameOwner = runFullRecovery(
      active,
      operationId,
      preflight,
    );
    expect(replaySameOwner).toMatchObject({
      status: "prepared",
      replayed: true,
      newAttempt: { id: first.newAttempt.id },
      preparedEventId: first.preparedEventId,
    });
    expect(snapshot(active).events).toHaveLength(
      afterFirst.events.length,
    );
    expect(snapshot(active).checkpoints).toHaveLength(
      afterFirst.checkpoints.length,
    );

    const dispatched = snapshot(active);
    const preparedAttempt =
      dispatched.recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === first.newAttempt?.id,
      );
    if (preparedAttempt === undefined) {
      throw new Error("Expected prepared child Attempt.");
    }
    runInTransaction(
      active.database,
      () =>
        active.fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
          {
            ownership: active.ownership,
            expectedTaskVersion: dispatched.task.version,
            attemptId: preparedAttempt.id,
            expectedAttemptVersion: preparedAttempt.version,
            status: "dispatching",
            reasonCode: null,
          },
          createStorageWritePermit(active.database),
        ),
      "immediate",
    );
    const legalEvolutionReplay = runFullRecovery(
      active,
      operationId,
      preflight,
    );
    expect(legalEvolutionReplay).toMatchObject({
      status: "prepared",
      replayed: true,
      newAttempt: { id: first.newAttempt.id },
    });

    takeOver(active, "worker-c");
    const beforeOwnerReplay = snapshot(active);
    const replayOtherOwner = runFullRecovery(
      active,
      operationId,
      preflight,
    );
    expect(replayOtherOwner).toMatchObject({
      status: "prepared",
      replayed: true,
      newAttempt: { id: first.newAttempt.id },
      interruptionEventId: first.interruptionEventId,
      preparedEventId: first.preparedEventId,
    });
    expect(snapshot(active).events).toHaveLength(
      beforeOwnerReplay.events.length,
    );
    expect(
      RecoveryEvidencePrepareLineageV1Schema.parse(
        snapshot(active).events.find(
          (event) => event.id === first.preparedEventId,
        )?.payload,
      ).leaseClaimEventId,
    ).toBe(historicalClaimEventId);
  });

  it("resumes after Pause Clear with the Resume Owner Claim", async () => {
    const active = openInterruptionContext("full-recovery-pause-resume");
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    setPauseIntent(active);
    const preflight = await preparePreflight(active);
    const interrupted = active.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(active, operationId, preflight),
      );
    expect(interrupted.status).toBe(
      "interrupted_pause_pending",
    );

    const blocked = runFullRecovery(
      active,
      operationId,
      preflight,
    );
    expect(blocked).toMatchObject({
      status: "pause_blocked",
      newAttempt: null,
    });

    const pauseClearEventId = clearPauseIntent(active);
    const oldClaimId = active.currentLeaseClaimEventId;
    expect(() =>
      runFullRecovery(
        active,
        operationId,
        preflight,
        { pauseClearEventId },
      ),
    ).toThrowError(/resume owner claim|clear/i);

    takeOver(active, "worker-c");
    const resumed = runFullRecovery(
      active,
      operationId,
      preflight,
      { pauseClearEventId },
    );
    expect(resumed).toMatchObject({
      status: "prepared",
      replayed: false,
      pauseClearEventId,
    });
    if (
      resumed.status !== "prepared" ||
      resumed.newAttempt === null
    ) {
      throw new Error("Expected Pause Resume Continuation.");
    }
    expect(snapshot(active).task.status).toBe("waiting_review");
    const preparedEvent = snapshot(active).events.find(
      (event) => event.id === resumed.preparedEventId,
    );
    expect(
      RecoveryEvidencePrepareLineageV1Schema.parse(
        preparedEvent?.payload,
      ),
    ).toMatchObject({
      pauseClearEventId,
      leaseClaimEventId: active.currentLeaseClaimEventId,
    });
    expect(active.currentLeaseClaimEventId).not.toBe(oldClaimId);

    takeOver(active, "worker-d");
    const beforeReplay = snapshot(active);
    const replay = runFullRecovery(
      active,
      operationId,
      preflight,
      { pauseClearEventId },
    );
    expect(replay).toMatchObject({
      status: "prepared",
      replayed: true,
      newAttempt: { id: resumed.newAttempt.id },
    });
    expect(snapshot(active).events).toHaveLength(
      beforeReplay.events.length,
    );
  });

  it("rejects Pause failed / not_evaluated and a mismatched Pause Clear", async () => {
    const failed = openInterruptionContext(
      "full-recovery-pause-failed",
      {
        canonicalInputHash: digest("f"),
      },
    );
    takeOver(failed, "worker-b");
    setPauseIntent(failed);
    const failedPreflight = await preparePreflight(failed);
    const failedOperationId = randomUUID();
    const failedInterruption = failed.unitOfWork
      .interruptOwnedRecoveryEvidenceReadAttempt(
        interruptionInput(
          failed,
          failedOperationId,
          failedPreflight,
        ),
      );
    expect(failedInterruption.retryAssessment).toBe("failed");
    const failedClear = clearPauseIntent(failed);
    takeOver(failed, "worker-c");
    const failedBefore = snapshot(failed);
    expect(
      runFullRecovery(
        failed,
        failedOperationId,
        failedPreflight,
        { pauseClearEventId: failedClear },
      ),
    ).toMatchObject({
      status: "manual_review",
      newAttempt: null,
    });
    expectStateUnchanged(failed, failedBefore);

    closeCurrentContext();
    const notEvaluated = openInterruptionContext(
      "full-recovery-pause-not-evaluated",
      {
        requestAllowlistVersion: "a".repeat(64),
      },
    );
    takeOver(notEvaluated, "worker-b");
    setPauseIntent(notEvaluated);
    const notEvaluatedPreflight =
      await preparePreflight(notEvaluated);
    const notEvaluatedOperationId = randomUUID();
    const notEvaluatedInterruption =
      notEvaluated.unitOfWork
        .interruptOwnedRecoveryEvidenceReadAttempt(
          interruptionInput(
            notEvaluated,
            notEvaluatedOperationId,
            notEvaluatedPreflight,
          ),
        );
    expect(notEvaluatedInterruption.retryAssessment).toBe(
      "not_evaluated",
    );
    const notEvaluatedClear = clearPauseIntent(notEvaluated);
    takeOver(notEvaluated, "worker-c");
    const notEvaluatedBefore = snapshot(notEvaluated);
    expect(
      runFullRecovery(
        notEvaluated,
        notEvaluatedOperationId,
        notEvaluatedPreflight,
        { pauseClearEventId: notEvaluatedClear },
      ),
    ).toMatchObject({
      status: "manual_review",
      newAttempt: null,
      retryAssessment: "not_evaluated",
    });
    expectStateUnchanged(
      notEvaluated,
      notEvaluatedBefore,
    );

    closeCurrentContext();
    const mismatch = openInterruptionContext(
      "full-recovery-pause-clear-mismatch",
    );
    const operationId = randomUUID();
    takeOver(mismatch, "worker-b");
    setPauseIntent(mismatch);
    const mismatchPreflight = await preparePreflight(mismatch);
    mismatch.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
      interruptionInput(
        mismatch,
        operationId,
        mismatchPreflight,
      ),
    );
    clearPauseIntent(mismatch);
    setPauseIntent(mismatch);
    const newerPauseClearEventId = clearPauseIntent(mismatch);
    takeOver(mismatch, "worker-c");
    expect(() =>
      runFullRecovery(
        mismatch,
        operationId,
        mismatchPreflight,
        { pauseClearEventId: newerPauseClearEventId },
      ),
    ).toThrowError(/pause clear|generation/i);
  });

  it("fails closed for conflicting operation identity and illegal replay state", async () => {
    const conflicting = openInterruptionContext(
      "full-recovery-operation-conflict",
    );
    const operationId = randomUUID();
    takeOver(conflicting, "worker-b");
    const conflictingPreflight =
      await preparePreflight(conflicting);
    const first = runFullRecovery(
      conflicting,
      operationId,
      conflictingPreflight,
    );
    if (first.status !== "prepared") {
      throw new Error("Expected prepared recovery.");
    }
    const preparedEvent = snapshot(conflicting).events.find(
      (event) => event.id === first.preparedEventId,
    );
    if (preparedEvent === undefined) {
      throw new Error("Expected Prepared Event.");
    }
    appendEvent(
      conflicting.database,
      conflicting.fixture.taskId,
      "recovery.evidence.read_attempt_prepared",
      {
        ...preparedEvent.payload,
        readbackRequestId: "different-request",
      },
    );
    expect(() =>
      runFullRecovery(
        conflicting,
        operationId,
        conflictingPreflight,
      ),
    ).toThrowError(/lineage conflict|multiple prepared/i);

    closeCurrentContext();
    const illegal = openInterruptionContext(
      "full-recovery-illegal-replay",
    );
    const illegalOperationId = randomUUID();
    takeOver(illegal, "worker-b");
    const illegalPreflight = await preparePreflight(illegal);
    const prepared = runFullRecovery(
      illegal,
      illegalOperationId,
      illegalPreflight,
    );
    if (prepared.status !== "prepared") {
      throw new Error("Expected prepared recovery.");
    }
    illegal.database
      .prepare(
        `
          UPDATE tool_runs
          SET status = 'failed',
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        "2026-11-08T00:11:00.000Z",
        illegal.fixture.readToolRunId,
      );
    expect(() =>
      runFullRecovery(
        illegal,
        illegalOperationId,
        illegalPreflight,
      ),
    ).toThrowError(/downstream state is invalid|replay inconsistent/i);
  });

  it("rejects a different newAttemptId without writes", async () => {
    const active = openInterruptionContext(
      "full-recovery-replay-identity-conflict",
    );
    const operationId = randomUUID();
    const firstAttemptId = randomUUID();
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const first = runFullRecovery(
      active,
      operationId,
      preflight,
      { newAttemptId: firstAttemptId },
    );
    if (first.status !== "prepared") {
      throw new Error("Expected prepared Full Recovery.");
    }
    const before = snapshot(active);
    let caught: unknown;
    try {
      runFullRecovery(
        active,
        operationId,
        preflight,
        { newAttemptId: randomUUID() },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
    });
    const after = snapshot(active);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(
      before.checkpoints.length,
    );
    expect(after.recoveryEvidenceReadAttempts).toEqual(
      before.recoveryEvidenceReadAttempts,
    );
  });

  it("classifies a real different Request as an Exact Replay identity conflict", async () => {
    const active = openInterruptionContext(
      "full-recovery-request-identity-conflict",
    );
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const first = runFullRecovery(active, operationId, preflight);
    if (first.status !== "prepared") {
      throw new Error("Expected prepared Full Recovery.");
    }
    const otherRequestId = createSecondRealRequest(
      active.database,
      "request-identity-conflict",
    );
    const before = snapshot(active);
    let caught: unknown;
    try {
      runFullRecovery(active, operationId, preflight, {
        requestId: otherRequestId,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    const after = snapshot(active);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(
      before.checkpoints.length,
    );
    expect(after.recoveryEvidenceReadAttempts).toEqual(
      before.recoveryEvidenceReadAttempts,
    );
    expect(
      after.events.find(
        (event) => event.id === first.preparedEventId,
      )?.payload,
    ).toEqual(
      before.events.find(
        (event) => event.id === first.preparedEventId,
      )?.payload,
    );
    expect(caught).toMatchObject({
      code: "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
    });
  });

  it("validates current Owner authorization before replay result lookup", async () => {
    const active = openInterruptionContext(
      "full-recovery-replay-owner-priority",
    );
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    const preflight = await preparePreflight(active);
    const first = runFullRecovery(active, operationId, preflight);
    if (first.status !== "prepared") {
      throw new Error("Expected prepared Full Recovery.");
    }
    const staleOwnership = { ...active.ownership };
    takeOver(active, "worker-c");
    const before = snapshot(active);

    active.authority.revoke(new Error("stale replay authority"));
    expect(() =>
      runFullRecovery(active, operationId, preflight),
    ).toThrowError(/authority/i);
    expectStateUnchanged(active, before);
    takeOver(active, "worker-d");
    const beforeClaim = snapshot(active);

    expect(() =>
      runFullRecovery(active, operationId, preflight, {
        currentLeaseClaimEventId: randomUUID(),
      }),
    ).toThrowError(/lease claim event is invalid/i);
    expect(() =>
      runFullRecovery(active, operationId, preflight, {
        ownership: staleOwnership,
      }),
    ).toThrowError(/ownership|lease/i);
    expectStateUnchanged(active, beforeClaim);
  });

  it("dispatches a recovered prepared Attempt through the original Stage 3.2 Gate", async () => {
    const active = openInterruptionContext(
      "step7-dispatch-integration",
    );
    const operationId = randomUUID();
    takeOver(active, "worker-b");
    const recoveryPreflight = await preparePreflight(active);
    const recovered = runFullRecovery(
      active,
      operationId,
      recoveryPreflight,
    );
    if (
      recovered.status !== "prepared" ||
      recovered.newAttempt === null
    ) {
      throw new Error("Expected prepared recovered Attempt.");
    }
    const beforeDispatch = snapshot(active);
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const dispatch = beginRecoveredDispatch(
      active,
      recovered.newAttempt.id,
    );
    expect(dispatch).toMatchObject({
      state: "created",
      replayed: false,
      attemptStatus: "dispatching",
      toolRunStatus: "running",
      planStepStatus: "running",
      planStatus: "active",
    });
    const afterDispatch = snapshot(active);
    expect(afterDispatch.task.status).toBe("waiting_review");
    expect(
      afterDispatch.recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === recovered.newAttempt?.id,
      )?.status,
    ).toBe("dispatching");
    expect(afterDispatch.recoveryEvidenceReadAttempts).toHaveLength(
      beforeDispatch.recoveryEvidenceReadAttempts.length,
    );
    expect(executeValidated).not.toHaveBeenCalled();

    const beforeReplay = snapshot(active);
    const replay = runFullRecovery(
      active,
      operationId,
      recoveryPreflight,
    );
    expect(replay).toMatchObject({
      status: "prepared",
      replayed: true,
      newAttempt: { id: recovered.newAttempt.id },
      preparedEventId: recovered.preparedEventId,
    });
    expect(snapshot(active).events).toHaveLength(
      beforeReplay.events.length,
    );
    expect(snapshot(active).checkpoints).toHaveLength(
      beforeReplay.checkpoints.length,
    );

    const previousOwnership = { ...active.ownership };
    takeOver(active, "worker-c");
    const crossOwnerReplay = runFullRecovery(
      active,
      operationId,
      recoveryPreflight,
    );
    expect(crossOwnerReplay).toMatchObject({
      status: "prepared",
      replayed: true,
      newAttempt: { id: recovered.newAttempt.id },
    });
    expect(
      snapshot(active).recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === recovered.newAttempt?.id,
      )?.status,
    ).toBe("dispatching");
    expect(() =>
      beginRecoveredDispatch(
        active,
        recovered.newAttempt!.id,
        previousOwnership,
      ),
    ).toThrowError(/ownership|lease/i);
  });

  it("keeps Cancel and Pause ahead of recovered Dispatch and Replay", async () => {
    const cancel = openInterruptionContext(
      "step7-dispatch-cancel",
    );
    takeOver(cancel, "worker-b");
    const cancelPreflight = await preparePreflight(cancel);
    const cancelRecovery = runFullRecovery(
      cancel,
      randomUUID(),
      cancelPreflight,
    );
    if (
      cancelRecovery.status !== "prepared" ||
      cancelRecovery.newAttempt === null
    ) {
      throw new Error("Expected Cancel recovered Attempt.");
    }
    const cancelDispatch = beginRecoveredDispatch(
      cancel,
      cancelRecovery.newAttempt.id,
    );
    expect(cancelDispatch.state).toBe("created");
    setCancelIntent(cancel);
    const cancelBefore = snapshot(cancel);
    expect(
      beginRecoveredDispatch(
        cancel,
        cancelRecovery.newAttempt.id,
      ),
    ).toMatchObject({
      state: "cancel_required",
      replayed: false,
    });
    expectStateUnchanged(cancel, cancelBefore);

    closeCurrentContext();
    const pause = openInterruptionContext("step7-dispatch-pause");
    takeOver(pause, "worker-b");
    const pausePreflight = await preparePreflight(pause);
    const pauseRecovery = runFullRecovery(
      pause,
      randomUUID(),
      pausePreflight,
    );
    if (
      pauseRecovery.status !== "prepared" ||
      pauseRecovery.newAttempt === null
    ) {
      throw new Error("Expected Pause recovered Attempt.");
    }
    setPauseIntent(pause);
    const pauseBefore = snapshot(pause);
    expect(
      beginRecoveredDispatch(
        pause,
        pauseRecovery.newAttempt.id,
      ),
    ).toMatchObject({
      state: "pause_blocked",
      replayed: false,
    });
    expectStateUnchanged(pause, pauseBefore);
  });

  it("rejects recovered Dispatch when Prepared Lineage is incomplete", async () => {
    const active = openInterruptionContext(
      "step7-invalid-prepared-lineage",
    );
    takeOver(active, "worker-b");
    const recoveryPreflight = await preparePreflight(active);
    const recovered = runFullRecovery(
      active,
      randomUUID(),
      recoveryPreflight,
    );
    if (
      recovered.status !== "prepared" ||
      recovered.newAttempt === null ||
      recovered.preparedEventId === null
    ) {
      throw new Error("Expected prepared recovered Attempt.");
    }
    const preparedEvent = snapshot(active).events.find(
      (event) => event.id === recovered.preparedEventId,
    );
    if (preparedEvent === undefined) {
      throw new Error("Expected Prepared Event.");
    }
    active.database.exec("DROP TRIGGER events_reject_update");
    const payload = { ...preparedEvent.payload };
    delete payload.interruptionEventId;
    active.database
      .prepare(
        `
          UPDATE events
          SET payload_json = ?
          WHERE id = ?
        `,
      )
      .run(JSON.stringify(payload), preparedEvent.id);
    const before = snapshot(active);
    expect(
      beginRecoveredDispatch(
        active,
        recovered.newAttempt.id,
      ),
    ).toMatchObject({
      state: "state_inconsistent",
      replayed: false,
      reason: "retry_lineage_invalid",
    });
    expectStateUnchanged(active, before);
  });

  it(
    "uses independent SQLite connections for concurrent Prepare and Replay",
    async () => {
      const active = openInterruptionContext(
        "step7-concurrent-recovery",
      );
      const operationId = randomUUID();
      active.leaseManager.release(
        active.ownership.taskId,
        active.ownership.leaseToken,
        active.ownership.fencingToken,
      );
      const workerConfig = {
        databasePath: active.temporaryDatabase.path,
        taskId: active.fixture.taskId,
        requestId: active.requestId,
        priorAttemptId: active.attemptId,
        recoveryOperationId: operationId,
        now: "2026-11-08T00:10:00.000Z",
      };
      const first = await startRecoveryWorker({
        ...workerConfig,
        ownerId: "recovery-worker-a",
      });
      const second = await startRecoveryWorker({
        ...workerConfig,
        ownerId: "recovery-worker-b",
      });
      const prepareResults = await Promise.all([
        runRecoveryWorker(first),
        runRecoveryWorker(second),
      ]);
      const prepared = prepareResults.filter(
        (result) => result.state === "prepared",
      );
      expect(prepared).toHaveLength(1);
      expect(
        prepareResults.filter(
          (result) => result.state === "in_progress",
        ),
      ).toHaveLength(1);

      const afterPrepare = snapshot(active);
      expect(
        afterPrepare.events.filter(
          (event) =>
            event.type ===
              "recovery.evidence.read_attempt_prepared" &&
            event.payload.recoveryOperationId === operationId,
        ),
      ).toHaveLength(1);
      expect(afterPrepare.recoveryEvidenceReadAttempts).toHaveLength(
        2,
      );

      const lease = afterPrepare.lease;
      if (
        lease?.leaseToken === null ||
        lease?.leaseToken === undefined ||
        lease.fencingToken === null
      ) {
        throw new Error("Expected winning Recovery lease.");
      }
      active.leaseManager.release(
        lease.taskId,
        lease.leaseToken,
        lease.fencingToken,
      );
      const replayFirst = await startRecoveryWorker({
        ...workerConfig,
        ownerId: "recovery-replay-a",
      });
      const replaySecond = await startRecoveryWorker({
        ...workerConfig,
        ownerId: "recovery-replay-b",
      });
      const replayResults = await Promise.all([
        runRecoveryWorker(replayFirst),
        runRecoveryWorker(replaySecond),
      ]);
      const replay = replayResults.filter(
        (result) =>
          result.state === "prepared" && result.replayed === true,
      );
      expect(replay).toHaveLength(1);
      expect(
        replayResults.filter(
          (result) => result.state === "in_progress",
        ),
      ).toHaveLength(1);
      const afterReplay = snapshot(active);
      expect(
        afterReplay.events.filter(
          (event) =>
            event.type ===
              "recovery.evidence.read_attempt_prepared" &&
            event.payload.recoveryOperationId === operationId,
        ),
      ).toHaveLength(1);
      expect(
        afterReplay.events.filter(
          (event) => event.type === "tool.queued",
        ),
      ).toHaveLength(
        afterPrepare.events.filter(
          (event) => event.type === "tool.queued",
        ).length,
      );
      expect(
        afterReplay.checkpoints.filter(
          (checkpoint) =>
            checkpoint.reason ===
            "recovery_read_attempt_prepared",
        ),
      ).toHaveLength(
        afterPrepare.checkpoints.filter(
          (checkpoint) =>
            checkpoint.reason ===
            "recovery_read_attempt_prepared",
        ).length,
      );
      expect(afterReplay.recoveryEvidenceReadAttempts).toHaveLength(
        2,
      );
    },
    20_000,
  );

  it("rolls back Attempt, Prepared Event, Tool Event and Checkpoint failures", async () => {
    const attemptFailure = openInterruptionContext(
      "full-recovery-attempt-rollback",
    );
    takeOver(attemptFailure, "worker-b");
    const attemptPreflight = await preparePreflight(attemptFailure);
    const attemptBefore = snapshot(attemptFailure);
    vi.spyOn(
      RecoveryEvidenceReadAttemptRepository.prototype,
      "insertPrepared",
    ).mockImplementationOnce(() => {
      throw new Error("injected prepared Attempt failure");
    });
    expect(() =>
      runFullRecovery(
        attemptFailure,
        randomUUID(),
        attemptPreflight,
      ),
    ).toThrow(/injected prepared Attempt failure/i);
    expectStateUnchanged(attemptFailure, attemptBefore);

    closeCurrentContext();
    const preparedEventFailure = openInterruptionContext(
      "full-recovery-prepared-event-rollback",
    );
    takeOver(preparedEventFailure, "worker-b");
    const preparedPreflight = await preparePreflight(
      preparedEventFailure,
    );
    preparedEventFailure.database.exec(
      `
        CREATE TRIGGER reject_prepared_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'recovery.evidence.read_attempt_prepared'
        BEGIN
          SELECT RAISE(ABORT, 'prepared event rejected');
        END
      `,
    );
    const preparedBefore = snapshot(preparedEventFailure);
    expect(() =>
      runFullRecovery(
        preparedEventFailure,
        randomUUID(),
        preparedPreflight,
      ),
    ).toThrow(/prepared event rejected/i);
    expectStateUnchanged(preparedEventFailure, preparedBefore);

    closeCurrentContext();
    const toolEventFailure = openInterruptionContext(
      "full-recovery-tool-event-rollback",
    );
    takeOver(toolEventFailure, "worker-b");
    const toolPreflight = await preparePreflight(toolEventFailure);
    toolEventFailure.database.exec(
      `
        CREATE TRIGGER reject_tool_queued_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'tool.queued'
        BEGIN
          SELECT RAISE(ABORT, 'tool queued event rejected');
        END
      `,
    );
    const toolBefore = snapshot(toolEventFailure);
    expect(() =>
      runFullRecovery(
        toolEventFailure,
        randomUUID(),
        toolPreflight,
      ),
    ).toThrow(/tool queued event rejected/i);
    expectStateUnchanged(toolEventFailure, toolBefore);

    closeCurrentContext();
    const checkpointFailure = openInterruptionContext(
      "full-recovery-checkpoint-rollback",
    );
    takeOver(checkpointFailure, "worker-b");
    const checkpointPreflight =
      await preparePreflight(checkpointFailure);
    checkpointFailure.database.exec(
      `
        CREATE TRIGGER reject_prepared_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'recovery_read_attempt_prepared'
        BEGIN
          SELECT RAISE(ABORT, 'prepared checkpoint rejected');
        END
      `,
    );
    const checkpointBefore = snapshot(checkpointFailure);
    expect(() =>
      runFullRecovery(
        checkpointFailure,
        randomUUID(),
        checkpointPreflight,
      ),
    ).toThrow(/prepared checkpoint rejected/i);
    expectStateUnchanged(checkpointFailure, checkpointBefore);
  });
});

describe("Step 8 Transaction Fault Injection", () => {
  it("rolls back interruption Attempt, ToolRun, PlanStep and Tool Event failures", () => {
    const cases = [
      {
        suffix: "interrupt-attempt",
        sql: `
          CREATE TRIGGER step8_reject_attempt
          BEFORE UPDATE OF attempt_status
          ON recovery_evidence_read_attempts
          WHEN NEW.attempt_status = 'interrupted'
          BEGIN
            SELECT RAISE(ABORT, 'step8 attempt rejected');
          END
        `,
        error: /step8 attempt rejected/i,
      },
      {
        suffix: "interrupt-toolrun",
        sql: `
          CREATE TRIGGER step8_reject_toolrun
          BEFORE UPDATE OF status ON tool_runs
          WHEN NEW.status = 'interrupted'
          BEGIN
            SELECT RAISE(ABORT, 'step8 toolrun rejected');
          END
        `,
        error: /step8 toolrun rejected/i,
      },
      {
        suffix: "interrupt-planstep",
        sql: `
          CREATE TRIGGER step8_reject_planstep
          BEFORE UPDATE OF status ON plan_steps
          WHEN NEW.status = 'interrupted'
          BEGIN
            SELECT RAISE(ABORT, 'step8 planstep rejected');
          END
        `,
        error: /step8 planstep rejected/i,
      },
      {
        suffix: "interrupt-tool-event",
        sql: `
          CREATE TRIGGER step8_reject_tool_event
          BEFORE INSERT ON events
          WHEN NEW.type = 'tool.interrupted'
          BEGIN
            SELECT RAISE(ABORT, 'step8 tool event rejected');
          END
        `,
        error: /step8 tool event rejected/i,
      },
    ] as const;

    for (const failure of cases) {
      const active = openInterruptionContext(failure.suffix);
      takeOver(active, "worker-b");
      setCancelIntent(active);
      active.database.exec(failure.sql);
      const before = snapshot(active);
      expect(() =>
        active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
          interruptionInput(active, randomUUID()),
        ),
      ).toThrowError(failure.error);
      expectStateUnchanged(active, before);
      closeCurrentContext();
    }
  });

  it("rolls back Full Recovery ToolRun requeue and PlanStep resume failures", async () => {
    const toolRun = openInterruptionContext(
      "full-recovery-requeue-fault",
    );
    takeOver(toolRun, "worker-b");
    const toolRunPreflight = await preparePreflight(toolRun);
    toolRun.database.exec(
      `
        CREATE TRIGGER step8_reject_requeue
        BEFORE UPDATE OF status ON tool_runs
        WHEN NEW.status = 'queued'
        BEGIN
          SELECT RAISE(ABORT, 'step8 requeue rejected');
        END
      `,
    );
    const toolRunBefore = snapshot(toolRun);
    expect(() =>
      runFullRecovery(
        toolRun,
        randomUUID(),
        toolRunPreflight,
      ),
    ).toThrow(/step8 requeue rejected/i);
    expectStateUnchanged(toolRun, toolRunBefore);

    closeCurrentContext();
    const planStep = openInterruptionContext(
      "full-recovery-planstep-resume-fault",
    );
    takeOver(planStep, "worker-b");
    const planStepPreflight = await preparePreflight(planStep);
    planStep.database.exec(
      `
        CREATE TRIGGER step8_reject_planstep_resume
        BEFORE UPDATE OF status ON plan_steps
        WHEN NEW.status = 'running'
        BEGIN
          SELECT RAISE(ABORT, 'step8 planstep resume rejected');
        END
      `,
    );
    const planStepBefore = snapshot(planStep);
    expect(() =>
      runFullRecovery(
        planStep,
        randomUUID(),
        planStepPreflight,
      ),
    ).toThrow(/step8 planstep resume rejected/i);
    expectStateUnchanged(planStep, planStepBefore);
  });
});

describe("RecoveryEvidenceStateTransitionUnitOfWork Prepare Recovery", () => {
  it("prepares recovered state through the current-transaction transition", async () => {
    const setup = await openPrepareTransitionSetup(
      "prepare-transition-valid",
    );
    const before = snapshot(setup.context);
    const newAttemptId = randomUUID();
    const attempt = runPrepareTransition(
      setup.context,
      setup.operationId,
      setup.pauseClearEventId,
      { newAttemptId },
    );
    const after = snapshot(setup.context);
    expect(attempt).toMatchObject({
      id: newAttemptId,
      status: "prepared",
      attemptNumber: 2,
      lastEventId: attempt.lastEventId,
    });
    expect(after.task.status).toBe("waiting_review");
    expect(
      after.recoveryEvidenceReadAttempts.find(
        (candidate) => candidate.id === setup.context.attemptId,
      )?.status,
    ).toBe("interrupted");
    expect(
      after.toolRuns.find(
        (run) =>
          run.id === setup.context.fixture.readToolRunId,
      )?.status,
    ).toBe("queued");
    expect(
      after.planSteps.find(
        (step) =>
          step.id === setup.context.fixture.planStepId,
      )?.status,
    ).toBe("running");
    expect(
      after.executionPlans.find(
        (plan) =>
          plan.id === setup.context.fixture.executionPlanId,
      )?.status,
    ).toBe("active");
    expect(after.recoveryEvidenceReadAttempts).toHaveLength(
      before.recoveryEvidenceReadAttempts.length + 1,
    );
  });

  it("rejects invalid source state and active Attempt conflicts", async () => {
    const toolRun = await openPrepareTransitionSetup(
      "prepare-transition-toolrun-invalid",
    );
    runInTransaction(
      toolRun.context.database,
      () => {
        const permit = createStorageWritePermit(toolRun.context.database);
        const run = new ToolRunRepository(
          toolRun.context.database,
        ).get(toolRun.context.fixture.readToolRunId);
        new ToolRunRepository(toolRun.context.database).transition(
          run.id,
          ["interrupted"],
          {
            expectedVersion: run.version,
            status: "queued",
            startedAt: null,
            finishedAt: null,
            updatedAt: "2026-11-08T00:10:00.000Z",
          },
          permit,
        );
      },
      "immediate",
    );
    expect(() =>
      runPrepareTransition(
        toolRun.context,
        toolRun.operationId,
        toolRun.pauseClearEventId,
      ),
    ).toThrowError(/source state|tool/i);

    closeCurrentContext();
    const planStep = await openPrepareTransitionSetup(
      "prepare-transition-planstep-invalid",
    );
    runInTransaction(
      planStep.context.database,
      () => {
        const permit = createStorageWritePermit(planStep.context.database);
        const step = new PlanStepRepository(
          planStep.context.database,
        ).get(planStep.context.fixture.planStepId);
        new PlanStepRepository(planStep.context.database).updateStatusCas(
          step.id,
          "interrupted",
          step.version,
          "running",
          "2026-11-08T00:10:00.000Z",
          permit,
        );
      },
      "immediate",
    );
    expect(() =>
      runPrepareTransition(
        planStep.context,
        planStep.operationId,
        planStep.pauseClearEventId,
      ),
    ).toThrowError(/source state|planstep/i);

    closeCurrentContext();
    const plan = await openPrepareTransitionSetup(
      "prepare-transition-plan-invalid",
    );
    runInTransaction(
      plan.context.database,
      () => {
        const permit = createStorageWritePermit(plan.context.database);
        const currentPlan = new ExecutionPlanRepository(
          plan.context.database,
        ).get(plan.context.fixture.executionPlanId);
        new ExecutionPlanRepository(
          plan.context.database,
        ).updateStatusCas(
          currentPlan.id,
          "active",
          currentPlan.version,
          "failed",
          "2026-11-08T00:10:00.000Z",
          permit,
        );
      },
      "immediate",
    );
    expect(() =>
      runPrepareTransition(
        plan.context,
        plan.operationId,
        plan.pauseClearEventId,
      ),
    ).toThrowError(/source state|plan/i);

    closeCurrentContext();
    const interruptedAttempt = await openPrepareTransitionSetup(
      "prepare-transition-attempt-invalid",
    );
    const dispatchEvent = snapshot(
      interruptedAttempt.context,
    ).events.find(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_dispatching" &&
        event.entityId === interruptedAttempt.context.attemptId,
    );
    if (dispatchEvent === undefined) {
      throw new Error("Expected Dispatch Event.");
    }
    interruptedAttempt.context.database.exec(
      "DROP TRIGGER recovery_evidence_read_attempts_validate_transition",
    );
    interruptedAttempt.context.database
      .prepare(
        `
          UPDATE recovery_evidence_read_attempts
          SET attempt_status = 'dispatching',
              dispatching_at = ?,
              interrupted_at = NULL,
              last_event_id = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        "2026-11-08T00:10:00.000Z",
        dispatchEvent.id,
        "2026-11-08T00:10:00.000Z",
        interruptedAttempt.context.attemptId,
      );
    expect(() =>
      runPrepareTransition(
        interruptedAttempt.context,
        interruptedAttempt.operationId,
        interruptedAttempt.pauseClearEventId,
      ),
    ).toThrowError(/source state|attempt/i);

    closeCurrentContext();
    const activeConflict = await openPrepareTransitionSetup(
      "prepare-transition-active-invalid",
    );
    createPreparedSibling(activeConflict.context);
    expect(() =>
      runPrepareTransition(
        activeConflict.context,
        activeConflict.operationId,
        activeConflict.pauseClearEventId,
      ),
    ).toThrowError(/active attempt/i);
  });

  it("rejects stale ownership, authority, permit, version and attempt number", async () => {
    const stale = await openPrepareTransitionSetup(
      "prepare-transition-stale",
    );
    expect(() =>
      runPrepareTransition(
        stale.context,
        stale.operationId,
        stale.pauseClearEventId,
        {
          ownership: stale.previousOwnership,
          currentLeaseClaimEventId:
            stale.previousLeaseClaimEventId,
        },
      ),
    ).toThrowError(/ownership|lease/i);

    closeCurrentContext();
    const authority = await openPrepareTransitionSetup(
      "prepare-transition-authority",
    );
    authority.context.authority.revoke(
      new Error("stale prepare authority"),
    );
    expect(() =>
      runPrepareTransition(
        authority.context,
        authority.operationId,
        authority.pauseClearEventId,
      ),
    ).toThrowError(/authority/i);

    closeCurrentContext();
    const versions = await openPrepareTransitionSetup(
      "prepare-transition-version",
    );
    expect(() =>
      runPrepareTransition(
        versions.context,
        versions.operationId,
        versions.pauseClearEventId,
        { expectedToolRunVersion: 999 },
      ),
    ).toThrowError(/version/i);
    expect(() =>
      runPrepareTransition(
        versions.context,
        versions.operationId,
        versions.pauseClearEventId,
        { newAttemptNumber: 4 },
      ),
    ).toThrow();

    const missingPermit = buildPrepareTransitionInput(
      versions.context,
      versions.operationId,
      versions.pauseClearEventId,
    );
    expect(() => {
      const transition =
        new RecoveryEvidenceStateTransitionUnitOfWork(
        versions.context.database,
        () => versions.context.authority.assertActive(),
        versions.context.leaseManager,
        () => new Date("2026-11-08T00:10:00.000Z"),
      );
      transition.prepareRecoveredReadAttemptInCurrentTransaction(
        missingPermit,
        {} as never,
      );
    }).toThrowError(/transaction|permit/i);
  });

  it("rolls back Prepare Recovery writes on checkpoint failure", async () => {
    const setup = await openPrepareTransitionSetup(
      "prepare-transition-rollback",
    );
    setup.context.database.exec(
      `
        CREATE TRIGGER reject_prepare_transition_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'recovery_read_attempt_prepared'
        BEGIN
          SELECT RAISE(ABORT, 'prepare transition checkpoint rejected');
        END
      `,
    );
    const before = snapshot(setup.context);
    expect(() =>
      runPrepareTransition(
        setup.context,
        setup.operationId,
        setup.pauseClearEventId,
      ),
    ).toThrow(/prepare transition checkpoint rejected/i);
    expectStateUnchanged(setup.context, before);
  });
});

interface InterruptionTestContext {
  readonly temporaryDatabase: TemporaryDatabase;
  readonly database: ForgeFlowDatabase;
  readonly fixture: RecoveryEvidenceUowFixture;
  readonly requestId: string;
  readonly attemptId: string;
  readonly leaseManager: TaskLeaseManager;
  readonly unitOfWork: RecoveryEvidenceInterruptionUnitOfWork;
  ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  };
  currentLeaseClaimEventId: string;
  authority: ExecutionAuthority;
}

function openInterruptionContext(
  suffix: string,
  options: {
    readonly canonicalInputHash?: string;
    readonly requestAllowlistVersion?: string;
  } = {},
): InterruptionTestContext {
  const temporaryDatabase = createTemporaryDatabase();
  const database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  const readToolInput = {
    resourceRef: "inventory://part/STM32",
    limit: 10,
  };
  const canonicalInputHash =
    options.canonicalInputHash ??
    computeCanonicalInputHash(readToolInput);
  const fixture = createRecoveryEvidenceUowFixture(database, suffix, {
    allowlistVersion:
      options.requestAllowlistVersion ??
      DISPATCH_ALLOWLIST_VERSION,
    readToolName: "inventory_lookup",
    readToolVersion: "1",
    readToolSchemaHash: DISPATCH_READ_TOOL_SCHEMA_HASH,
    readToolInput,
    canonicalInputHash,
  });
  const manager = fixture.leaseManager;
  const takeover = new RecoveryEvidenceFencingTakeoverGuard(
    database,
    manager,
  );
  manager.release(
    fixture.ownership.taskId,
    fixture.ownership.leaseToken,
    fixture.ownership.fencingToken,
  );
  const ownerA = takeover.claimRecoveryEvidenceOwnership(
    fixture.taskId,
    `worker-a-${suffix}`,
  );
  if (ownerA.status !== "ready") {
    throw new Error("Expected initial interruption owner claim.");
  }
  const ownership = ownerA.ownership;
  const authority = new ExecutionAuthority();
  const reservations =
    new RecoveryEvidenceReadbackReservationUnitOfWork(
      database,
      () => authority.assertActive(),
      manager,
      { now: () => new Date("2026-11-08T00:10:00.000Z") },
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
    ownership,
    expectedTaskVersion: snapshotByDatabase(database, fixture.taskId).task
      .version,
    requestIntent,
    requestId: input.requestId,
    operationId: input.operationId,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    readAttemptId: input.readAttemptId,
  });
  if (acquired.state !== "acquired" || acquired.ownerToken === null) {
    throw new Error("Expected completed interruption Reservation.");
  }
  let created:
    | ReturnType<
        RecoveryEvidenceUowFixture["unitOfWork"]["createOwnedRecoveryEvidenceReadbackRequest"]
      >
    | undefined;
  reservations.completeOwned(
    {
      ownership,
      reservationId: acquired.reservation.id,
      expectedReservationVersion:
        acquired.reservation.reservationVersion,
      ownerToken: acquired.ownerToken,
      requestIntent,
    },
    ({ task }) => {
      created =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest({
          ...input,
          ownership,
          expectedTaskVersion: task.version,
        });
    },
  );
  if (created === undefined) {
    throw new Error("Expected interruption Request.");
  }
  const creation = created;
  const request = creation.request;
  const current = snapshotByDatabase(database, fixture.taskId);
  runInTransaction(
    database,
    () =>
      fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
        {
          ownership,
          expectedTaskVersion: current.task.version,
          attemptId: creation.attempt.id,
          expectedAttemptVersion: creation.attempt.version,
          status: "dispatching",
          reasonCode: null,
        },
        createStorageWritePermit(database),
      ),
    "immediate",
  );

  const activeContext: InterruptionTestContext = {
    temporaryDatabase,
    database,
    fixture,
    requestId: request.id,
    attemptId: creation.attempt.id,
    leaseManager: manager,
    ownership,
    currentLeaseClaimEventId: ownerA.leaseClaimEventId,
    authority: new ExecutionAuthority(),
    unitOfWork: undefined as never,
  };
  Object.defineProperty(activeContext, "unitOfWork", {
    value: new RecoveryEvidenceInterruptionUnitOfWork(
      database,
      () => activeContext.authority.assertActive(),
      manager,
      () => new Date("2026-11-08T00:10:00.000Z"),
    ),
  });
  context = activeContext;
  return activeContext;
}

function takeOver(
  context: InterruptionTestContext,
  ownerId: string,
): void {
  context.leaseManager.release(
    context.ownership.taskId,
    context.ownership.leaseToken,
    context.ownership.fencingToken,
  );
  const result = new RecoveryEvidenceFencingTakeoverGuard(
    context.database,
    context.leaseManager,
  ).claimRecoveryEvidenceOwnership(
    context.fixture.taskId,
    ownerId,
  );
  if (result.status !== "ready") {
    throw new Error(`Expected takeover ready, received ${result.status}.`);
  }
  context.ownership = result.ownership;
  context.currentLeaseClaimEventId = result.leaseClaimEventId;
  context.authority = new ExecutionAuthority();
}

function setCancelIntent(context: InterruptionTestContext): string {
  const requestNonce = randomUUID();
  const result =
    context.fixture.unitOfWork.setTaskWideRecoveryEvidenceCancel({
      hostControlAuthorization:
        issueRecoveryEvidenceHostControlAuthorization({
          taskId: context.fixture.taskId,
          operation: "cancel_set",
          requestNonce,
          controlActor: "host-control",
        }),
      expectedTaskVersion:
        snapshot(context).task.version,
      requestNonce,
      controlActor: "host-control",
    });
  return result.eventId;
}

function setPauseIntent(context: InterruptionTestContext): string {
  const requestNonce = randomUUID();
  const result =
    context.fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
      hostControlAuthorization:
        issueRecoveryEvidenceHostControlAuthorization({
          taskId: context.fixture.taskId,
          operation: "pause_set",
          requestNonce,
          controlActor: "host-control",
        }),
      expectedTaskVersion: snapshot(context).task.version,
      requestNonce,
      controlActor: "host-control",
    });
  return result.eventId;
}

function preparePreflight(
  context: InterruptionTestContext,
  options: {
    readonly expectedRequestIntentDigest?: string;
  } = {},
): Promise<RecoveryEvidenceRecoveryPreflightResult> {
  return prepareRecoveryEvidenceRecoveryPreflight({
    database: context.database,
    registry: createDispatchReadbackRegistry(),
    requestId: context.requestId,
    ...(options.expectedRequestIntentDigest === undefined
      ? {}
      : {
          expectedRequestIntentDigest:
            options.expectedRequestIntentDigest,
        }),
  });
}

function interruptionInput(
  context: InterruptionTestContext,
  recoveryOperationId: string,
  preflightResult?: unknown,
) {
  const current = snapshot(context);
  const attempt =
    current.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.id === context.attemptId,
    );
  if (attempt === undefined) {
    throw new Error("Expected interruption Attempt.");
  }
  return {
    ownership: context.ownership,
    currentLeaseClaimEventId:
      context.currentLeaseClaimEventId,
    expectedTaskVersion: current.task.version,
    requestId: context.requestId,
    priorAttemptId: context.attemptId,
    expectedAttemptVersion: attempt.version,
    recoveryOperationId,
    ...(preflightResult === undefined
      ? {}
      : { preflightResult }),
  };
}

function createPreparedRecoveryChild(
  context: InterruptionTestContext,
  interrupt: RecoveryEvidenceInterruptLineageV1,
  interruptionEventId: string,
): void {
  const current = snapshot(context);
  const run = current.toolRuns.find(
    (candidate) => candidate.id === interrupt.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === context.fixture.planStepId,
  );
  const priorAttempt =
    current.recoveryEvidenceReadAttempts.find(
      (candidate) => candidate.id === context.attemptId,
    );
  if (run === undefined || step === undefined || priorAttempt === undefined) {
    throw new Error("Expected prepared Recovery child bindings.");
  }
  const newAttemptId = `interruption-child-${context.attemptId}`;
  const newAttemptNumber = priorAttempt.attemptNumber + 1;
  const preparedLineage = {
    ...interrupt,
    recoveryPhase: "prepare" as const,
    readAttemptId: newAttemptId,
    attemptNumber: newAttemptNumber,
    attemptStatus: "prepared" as const,
    newAttemptId,
    newAttemptNumber,
    interruptionEventId,
    pauseClearEventId: randomUUID(),
  };
  delete (preparedLineage as Record<string, unknown>)
    .dispatchEventId;
  delete (preparedLineage as Record<string, unknown>)
    .dispatchFencingToken;
  delete (preparedLineage as Record<string, unknown>)
    .interruptionCause;
  delete (preparedLineage as Record<string, unknown>).reasonCode;
  delete (preparedLineage as Record<string, unknown>)
    .retryAssessment;
  delete (preparedLineage as Record<string, unknown>).resumeEligible;
  delete (preparedLineage as Record<string, unknown>)
    .controlIntentKind;
  delete (preparedLineage as Record<string, unknown>)
    .controlIntentEventId;
  delete (preparedLineage as Record<string, unknown>)
    .pauseRequestEventId;

  runInTransaction(
    context.database,
    () => {
      const permit = createStorageWritePermit(context.database);
      new ToolRunRepository(context.database).transition(
        run.id,
        ["interrupted"],
        {
          expectedVersion: run.version,
          status: "queued",
          finishedAt: null,
          updatedAt: "2026-11-08T00:10:00.000Z",
        },
        permit,
      );
      new PlanStepRepository(context.database).updateStatusCas(
        step.id,
        "interrupted",
        step.version,
        "running",
        "2026-11-08T00:10:00.000Z",
        permit,
      );
      const event = new EventRepository(
        context.database,
        new SequenceAllocator(context.database),
      ).append(
        {
          taskId: context.fixture.taskId,
          traceId: current.task.traceId,
          type: "recovery.evidence.read_attempt_prepared",
          entityType: "recovery_evidence_read_attempt",
          entityId: newAttemptId,
          payload: preparedLineage,
        },
        "2026-11-08T00:10:00.000Z",
        permit,
      );
      new RecoveryEvidenceReadAttemptRepository(
        context.database,
      ).insertPrepared(
        {
          id: newAttemptId,
          taskId: context.fixture.taskId,
          readbackRequestId: interrupt.readbackRequestId,
          readToolRunId: interrupt.readToolRunId,
          attemptNumber: newAttemptNumber,
          retrySafety: interrupt.retrySafety,
          consistencyMode: interrupt.consistencyMode,
          preparedAt: "2026-11-08T00:10:00.000Z",
          lastEventId: event.id,
          createdAt: "2026-11-08T00:10:00.000Z",
        },
        permit,
      );
    },
    "immediate",
  );
}

function createPreparedSibling(context: InterruptionTestContext): void {
  const current = snapshot(context);
  const request = current.recoveryEvidenceReadbackRequests.find(
    (candidate) => candidate.id === context.requestId,
  );
  if (request === undefined) {
    throw new Error("Expected active conflict Request.");
  }
  const attemptId = `active-conflict-${context.attemptId}`;
  runInTransaction(
    context.database,
    () => {
      const permit = createStorageWritePermit(context.database);
      const event = new EventRepository(
        context.database,
        new SequenceAllocator(context.database),
      ).append(
        {
          taskId: context.fixture.taskId,
          traceId: current.task.traceId,
          type: "recovery.evidence.read_attempt_prepared",
          entityType: "recovery_evidence_read_attempt",
          entityId: attemptId,
          payload: {
            readAttemptId: attemptId,
            attemptNumber: 2,
            attemptStatus: "prepared",
          },
        },
        "2026-11-08T00:10:00.000Z",
        permit,
      );
      new RecoveryEvidenceReadAttemptRepository(
        context.database,
      ).insertPrepared(
        {
          id: attemptId,
          taskId: context.fixture.taskId,
          readbackRequestId: request.id,
          readToolRunId: request.readToolRunId,
          attemptNumber: 2,
          retrySafety: request.retrySafety,
          consistencyMode: request.consistencyMode,
          preparedAt: "2026-11-08T00:10:00.000Z",
          lastEventId: event.id,
          createdAt: "2026-11-08T00:10:00.000Z",
        },
        permit,
      );
    },
    "immediate",
  );
}

function appendEvent(
  database: ForgeFlowDatabase,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  return runInTransaction(
    database,
    () => {
      const permit = createStorageWritePermit(database);
      return new EventRepository(
        database,
        new SequenceAllocator(database),
      ).append(
        {
          taskId,
          traceId: `trace-${taskId}`,
          type,
          entityType: "recovery_evidence_read_attempt",
          entityId: payload.readAttemptId as string,
          payload,
        },
        "2026-11-08T00:10:00.000Z",
        permit,
      );
    },
    "immediate",
  );
}

function convergeCancel(
  context: InterruptionTestContext,
  cancelIntentEventId: string,
): void {
  const current = snapshot(context);
  const request = current.recoveryEvidenceReadbackRequests.find(
    (candidate) => candidate.id === context.requestId,
  );
  const attempt = current.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.id === context.attemptId,
  );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request?.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request?.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request?.executionPlanId,
  );
  if (
    request === undefined ||
    attempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined
  ) {
    throw new Error("Expected Cancel convergence binding.");
  }
  context.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead({
    ownership: context.ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    attemptId: attempt.id,
    cancelIntentEventId,
    expectedAttemptVersion: attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
    reasonCode: "CANCEL_REQUESTED",
  });
}

function clearPauseIntent(context: InterruptionTestContext): string {
  const current = snapshot(context);
  const pauseEvent = [...current.events]
    .reverse()
    .find(
      (event) =>
        event.type === "recovery.evidence.pause_requested" &&
        event.payload.pauseRequestedAt ===
          current.task.pauseRequestedAt,
    );
  if (
    pauseEvent === undefined ||
    current.task.pauseRequestedAt === null
  ) {
    throw new Error("Expected active Pause Event.");
  }
  const requestNonce = randomUUID();
  return context.fixture.unitOfWork.clearTaskWideRecoveryEvidencePause({
    hostControlAuthorization:
      issueRecoveryEvidenceHostControlAuthorization({
        taskId: context.fixture.taskId,
        operation: "pause_clear",
        requestNonce,
        controlActor: "host-control",
      }),
    expectedTaskVersion: current.task.version,
    requestNonce,
    controlActor: "host-control",
    expectedPauseRequestedAt: current.task.pauseRequestedAt,
    pauseRequestEventId: pauseEvent.id,
    expectedPauseEventSequence: pauseEvent.sequence,
  }).eventId;
}

function runFullRecovery(
  context: InterruptionTestContext,
  recoveryOperationId: string,
  preflightResult: RecoveryEvidenceRecoveryPreflightResult,
  options: {
    readonly pauseClearEventId?: string;
    readonly newAttemptId?: string;
    readonly currentLeaseClaimEventId?: string;
    readonly requestId?: string;
    readonly ownership?: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    };
  } = {},
) {
  const current = snapshot(context);
  const priorAttempt =
    current.recoveryEvidenceReadAttempts.find(
      (attempt) => attempt.id === context.attemptId,
    );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === context.fixture.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === context.fixture.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === context.fixture.executionPlanId,
  );
  if (
    priorAttempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined
  ) {
    throw new Error("Expected Full Recovery bindings.");
  }
  return new RecoveryEvidenceFullRecoveryUnitOfWork(
    context.database,
    () => context.authority.assertActive(),
    context.leaseManager,
    () => new Date("2026-11-08T00:10:00.000Z"),
  ).recoverOwnedRecoveryEvidenceReadAttempt({
    ownership: options.ownership ?? context.ownership,
    currentLeaseClaimEventId:
      options.currentLeaseClaimEventId ??
      context.currentLeaseClaimEventId,
    expectedTaskVersion: current.task.version,
    requestId: options.requestId ?? context.requestId,
    priorAttemptId: priorAttempt.id,
    expectedPriorAttemptVersion: priorAttempt.version,
    expectedToolRunVersion: run.version,
    expectedPlanStepVersion: step.version,
    expectedPlanVersion: plan.version,
    recoveryOperationId,
    preflightResult,
    ...(options.newAttemptId === undefined
      ? {}
      : { newAttemptId: options.newAttemptId }),
    ...(options.pauseClearEventId === undefined
      ? {}
      : { pauseClearEventId: options.pauseClearEventId }),
  });
}

function beginRecoveredDispatch(
  context: InterruptionTestContext,
  attemptId: string,
  ownership = context.ownership,
) {
  const current = snapshot(context);
  const request = current.recoveryEvidenceReadbackRequests.find(
    (candidate) => candidate.id === context.requestId,
  );
  const attempt = current.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.id === attemptId,
  );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === request?.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === request?.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === request?.executionPlanId,
  );
  if (
    request === undefined ||
    attempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined
  ) {
    throw new Error("Expected recovered Dispatch binding.");
  }
  const preflight = prepareRecoveryEvidenceDispatchPreflight({
    registry: createDispatchReadbackRegistry(),
    allowlistId: request.allowlistId,
    expectedAllowlistContractDigest: request.allowlistVersion,
  });
  const unitOfWork = new RecoveryEvidenceUnitOfWork(
    context.database,
    () => context.authority.assertActive(),
    context.leaseManager,
  );
  return unitOfWork.beginOwnedRecoveryEvidenceRead({
    ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    attemptId: attempt.id,
    preflight,
    expectedCanonicalInputHash: run.canonicalInputHash,
    expectedAttemptVersion: attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
  });
}

interface PrepareTransitionSetup {
  readonly context: InterruptionTestContext;
  readonly operationId: string;
  readonly pauseClearEventId: string;
  readonly previousOwnership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  };
  readonly previousLeaseClaimEventId: string;
}

async function openPrepareTransitionSetup(
  suffix: string,
): Promise<PrepareTransitionSetup> {
  const active = openInterruptionContext(suffix);
  const operationId = randomUUID();
  takeOver(active, "worker-b");
  setPauseIntent(active);
  const preflight = await preparePreflight(active);
  active.unitOfWork.interruptOwnedRecoveryEvidenceReadAttempt(
    interruptionInput(active, operationId, preflight),
  );
  const previousOwnership = { ...active.ownership };
  const previousLeaseClaimEventId =
    active.currentLeaseClaimEventId;
  const pauseClearEventId = clearPauseIntent(active);
  takeOver(active, "worker-c");
  return {
    context: active,
    operationId,
    pauseClearEventId,
    previousOwnership,
    previousLeaseClaimEventId,
  };
}

function buildPrepareTransitionInput(
  context: InterruptionTestContext,
  recoveryOperationId: string,
  pauseClearEventId: string,
  options: {
    readonly ownership?: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    };
    readonly currentLeaseClaimEventId?: string;
    readonly expectedToolRunVersion?: number;
    readonly newAttemptId?: string;
    readonly newAttemptNumber?: number;
  } = {},
) {
  const current = snapshot(context);
  const priorAttempt =
    current.recoveryEvidenceReadAttempts.find(
      (attempt) => attempt.id === context.attemptId,
    );
  const run = current.toolRuns.find(
    (candidate) => candidate.id === context.fixture.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) => candidate.id === context.fixture.planStepId,
  );
  const plan = current.executionPlans.find(
    (candidate) => candidate.id === context.fixture.executionPlanId,
  );
  const interruptionEvent = current.events.find(
    (event) =>
      event.type ===
        "recovery.evidence.read_attempt_interrupted" &&
      event.payload.recoveryOperationId === recoveryOperationId &&
      event.payload.recoveryPhase === "interrupt",
  );
  if (
    priorAttempt === undefined ||
    run === undefined ||
    step === undefined ||
    plan === undefined ||
    interruptionEvent === undefined
  ) {
    throw new Error("Expected Prepare Transition bindings.");
  }
  const interrupt =
    RecoveryEvidenceInterruptLineageV1Schema.parse(
      interruptionEvent.payload,
    );
  const newAttemptId =
    options.newAttemptId ?? randomUUID();
  const newAttemptNumber =
    options.newAttemptNumber ?? priorAttempt.attemptNumber + 1;
  const preparedLineage = {
    lineageSchemaVersion: interrupt.lineageSchemaVersion,
    recoveryOperationId: interrupt.recoveryOperationId,
    recoveryPhase: "prepare" as const,
    taskId: interrupt.taskId,
    readbackRequestId: interrupt.readbackRequestId,
    readToolRunId: interrupt.readToolRunId,
    readAttemptId: newAttemptId,
    attemptNumber: newAttemptNumber,
    attemptStatus: "prepared" as const,
    priorAttemptId: priorAttempt.id,
    priorAttemptNumber: priorAttempt.attemptNumber,
    interruptionEventId: interruptionEvent.id,
    newAttemptId,
    newAttemptNumber,
    leaseClaimEventId:
      options.currentLeaseClaimEventId ??
      context.currentLeaseClaimEventId,
    fencingToken:
      options.ownership?.fencingToken ??
      context.ownership.fencingToken,
    retrySafety: interrupt.retrySafety,
    consistencyMode: interrupt.consistencyMode,
    allowlistId: interrupt.allowlistId,
    allowlistVersion: interrupt.allowlistVersion,
    readToolName: interrupt.readToolName,
    readToolVersion: interrupt.readToolVersion,
    readToolSchemaHash: interrupt.readToolSchemaHash,
    requestIntentDigest: interrupt.requestIntentDigest,
    expectedResourceVersion:
      interrupt.expectedResourceVersion,
    expectedEtag: interrupt.expectedEtag,
    pauseClearEventId,
  };
  return {
    ownership: options.ownership ?? context.ownership,
    currentLeaseClaimEventId:
      options.currentLeaseClaimEventId ??
      context.currentLeaseClaimEventId,
    expectedTaskVersion: current.task.version,
    priorAttemptId: priorAttempt.id,
    expectedPriorAttemptVersion: priorAttempt.version,
    expectedToolRunVersion:
      options.expectedToolRunVersion ?? run.version,
    expectedPlanStepVersion: step.version,
    expectedPlanVersion: plan.version,
    newAttemptId,
    newAttemptNumber,
    preparedLineage,
  };
}

function runPrepareTransition(
  context: InterruptionTestContext,
  recoveryOperationId: string,
  pauseClearEventId: string,
  options: Parameters<typeof buildPrepareTransitionInput>[3] = {},
) {
  const input = buildPrepareTransitionInput(
    context,
    recoveryOperationId,
    pauseClearEventId,
    options,
  );
  return runInTransaction(
    context.database,
    () => {
      const transition =
        new RecoveryEvidenceStateTransitionUnitOfWork(
          context.database,
          () => context.authority.assertActive(),
          context.leaseManager,
          () => new Date("2026-11-08T00:10:00.000Z"),
        );
      return transition.prepareRecoveredReadAttemptInCurrentTransaction(
        input,
        createStorageWritePermit(context.database),
      );
    },
    "immediate",
  );
}

interface RecoveryWorkerResult {
  readonly type: "complete" | "error";
  readonly state?: "prepared" | "in_progress" | "rejected";
  readonly replayed?: boolean;
  readonly newAttemptId?: string | null;
  readonly preparedEventId?: string | null;
  readonly fencingToken?: number;
  readonly leaseClaimEventId?: string;
  readonly code?: string;
}

function startRecoveryWorker(config: {
  readonly databasePath: string;
  readonly taskId: string;
  readonly requestId: string;
  readonly priorAttemptId: string;
  readonly recoveryOperationId: string;
  readonly ownerId: string;
  readonly now: string;
}): Promise<ChildProcess> {
  const worker = fork(
    recoveryWorkerPath,
    [JSON.stringify(config)],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  recoveryWorkers.push(worker);
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Recovery worker did not become ready."));
    }, 15_000);
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
          `Recovery worker exited before readiness: ${String(code)}`,
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

function runRecoveryWorker(
  worker: ChildProcess,
): Promise<RecoveryWorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Recovery worker timed out."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message.type === "complete" ||
          message.type === "error")
      ) {
        cleanup();
        resolve(message as RecoveryWorkerResult);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(
          new Error(
            `Recovery worker exited with code ${String(code)}.`,
          ),
        );
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.send({ type: "start" });
  });
}

function snapshot(context: InterruptionTestContext) {
  return new TaskSnapshotReader(context.database).load(
    context.fixture.taskId,
  );
}

function snapshotByDatabase(
  database: ForgeFlowDatabase,
  taskId: string,
) {
  return new TaskSnapshotReader(database).load(taskId);
}

function expectStateUnchanged(
  context: InterruptionTestContext,
  before: ReturnType<typeof snapshot>,
): void {
  const after = snapshot(context);
  expect(after.task).toMatchObject({
    status: before.task.status,
    version: before.task.version,
  });
  expect(after.events).toHaveLength(before.events.length);
  expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  expect(after.recoveryEvidenceReadAttempts).toEqual(
    before.recoveryEvidenceReadAttempts,
  );
  expect(after.toolRuns).toEqual(before.toolRuns);
  expect(after.planSteps).toEqual(before.planSteps);
  expect(after.executionPlans).toEqual(before.executionPlans);
}

function requestInput(
  fixture: RecoveryEvidenceUowFixture,
  suffix: string,
) {
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
      readToolName: fixture.readToolName,
      readToolVersion: fixture.readToolVersion,
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
    expectedTaskVersion: snapshotByDatabase(
      fixture.database,
      fixture.taskId,
    ).task.version,
    requestId: `interruption-request-${suffix}`,
    operationId: `interruption-operation-${suffix}`,
    readAttemptId: `interruption-attempt-${suffix}`,
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
    readToolName: fixture.readToolName,
    readToolVersion: fixture.readToolVersion,
    readToolSchemaHash: fixture.readToolSchemaHash,
    retrySafety: "version_conditional" as const,
    consistencyMode: "etag_or_resource_version" as const,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
    verificationCheckId: fixture.verificationCheckId,
  };
}

function createSecondRealRequest(
  database: ForgeFlowDatabase,
  suffix: string,
): string {
  const readToolInput = {
    resourceRef: "inventory://part/STM32",
    limit: 10,
  };
  const fixture = createRecoveryEvidenceUowFixture(
    database,
    `second-${suffix}`,
    {
      allowlistVersion: DISPATCH_ALLOWLIST_VERSION,
      readToolName: "inventory_lookup",
      readToolVersion: "1",
      readToolSchemaHash: DISPATCH_READ_TOOL_SCHEMA_HASH,
      readToolInput,
      canonicalInputHash: computeCanonicalInputHash(readToolInput),
    },
  );
  const reservations =
    new RecoveryEvidenceReadbackReservationUnitOfWork(
      database,
      () => fixture.authority.assertActive(),
      fixture.leaseManager,
      { now: () => new Date("2026-11-08T00:10:00.000Z") },
    );
  const input = requestInput(fixture, `second-${suffix}`);
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
    expectedTaskVersion: snapshotByDatabase(
      database,
      fixture.taskId,
    ).task.version,
    requestIntent,
    requestId: input.requestId,
    operationId: input.operationId,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    readAttemptId: input.readAttemptId,
  });
  if (acquired.state !== "acquired" || acquired.ownerToken === null) {
    throw new Error("Expected second Request Reservation.");
  }
  let requestId: string | undefined;
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
      requestId =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest({
          ...input,
          expectedTaskVersion: task.version,
        }).request.id;
    },
  );
  if (requestId === undefined) {
    throw new Error("Expected second real Request.");
  }
  return requestId;
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function closeCurrentContext(): void {
  if (context !== undefined) {
    closeDatabase(context.database);
    context.temporaryDatabase.cleanup();
    context = undefined;
  }
}
