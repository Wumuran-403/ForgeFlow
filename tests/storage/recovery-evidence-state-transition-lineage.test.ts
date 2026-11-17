import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CheckpointStore,
  EventRepository,
  RecoveryEvidenceReadAttemptRepository,
  SequenceAllocator,
  TaskSnapshotReader,
  PlanStepRepository,
  ToolRunRepository,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { issueRecoveryEvidenceHostControlAuthorization } from "../../src/recovery/recovery-evidence-host-control-authorization.js";
import {
  RecoveryEvidenceInterruptLineageV1Schema,
  type RecoveryEvidenceInterruptLineageV1,
} from "../../src/storage/recovery-evidence-recovery-lineage.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";
import {
  createRecoveryEvidenceUowFixture,
  createRecoveryInterruptionFixture,
  type RecoveryEvidenceUowFixture,
} from "./recovery-evidence-uow-fixture.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
  vi.restoreAllMocks();
});

describe("RecoveryEvidence State Transition Lineage", () => {
  it("persists a valid Interrupted Lineage and matching last Event", () => {
    const reserved = openDispatchedFixture("lineage-valid");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
        recoveryOperationId:
          "11111111-1111-4111-8111-111111111111",
      },
    );
    const before = snapshot(reserved.fixture);
    const interrupted = transitionInterrupted(
      reserved.fixture,
      interruption.lineage,
    );
    const after = snapshot(reserved.fixture);
    const event = after.events.find(
      (candidate) =>
        candidate.type ===
          "recovery.evidence.read_attempt_interrupted" &&
        candidate.entityId === reserved.attemptId,
    );
    expect(event).toBeDefined();
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.parse(event?.payload),
    ).toEqual(interruption.lineage);
    expect(interrupted.status).toBe("interrupted");
    expect(interrupted.lastEventId).toBe(event?.id);
    expect(
      after.toolRuns.find(
        (run) => run.id === reserved.fixture.readToolRunId,
      )?.status,
    ).toBe("interrupted");
    expect(
      after.planSteps.find(
        (step) => step.id === reserved.fixture.planStepId,
      )?.status,
    ).toBe("interrupted");
    expect(
      after.executionPlans.find(
        (plan) => plan.id === reserved.fixture.executionPlanId,
      )?.status,
    ).toBe("active");
    expect(after.checkpoints).toHaveLength(
      before.checkpoints.length + 1,
    );
  });

  it.each([
    [
      "recoveryOperationId",
      (lineage: Record<string, unknown>) => {
        delete lineage.recoveryOperationId;
      },
    ],
    [
      "leaseClaimEventId",
      (lineage: Record<string, unknown>) => {
        delete lineage.leaseClaimEventId;
      },
    ],
  ] as const)("rejects missing %s", (_field, removeField) => {
    const reserved = openDispatchedFixture(`lineage-missing-${_field}`);
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const lineage = structuredClone(interruption.lineage) as
      Record<string, unknown>;
    removeField(lineage);
    const before = snapshot(reserved.fixture);
    expect(() =>
      transitionInterrupted(
        reserved.fixture,
        lineage as never,
      ),
    ).toThrow();
    expectStateUnchanged(reserved.fixture, before);
  });

  it.each(["taskId", "readbackRequestId", "readAttemptId"] as const)(
    "rejects mismatched persisted %s",
    (field) => {
      const reserved = openDispatchedFixture(`lineage-${field}`);
      const interruption = createRecoveryInterruptionFixture(
        reserved.fixture,
        {
          attemptId: reserved.attemptId,
          reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
        },
      );
      const lineage = {
        ...interruption.lineage,
        [field]:
          field === "readAttemptId"
            ? "different-attempt"
            : `different-${field}`,
      };
      const before = snapshot(reserved.fixture);
      const input = {
        ...interruptionInput(
          reserved.fixture,
          interruption.lineage,
        ),
        recoveryLineage: lineage,
      };
      expect(() =>
        transitionInterrupted(
          reserved.fixture,
          interruption.lineage,
          input,
        ),
      ).toThrow(/lineage|identity|readAttemptId/i);
      expectStateUnchanged(reserved.fixture, before);
    },
  );

  it("rejects non-increasing dispatch fencing and invalid Retry Assessment", () => {
    const reserved = openDispatchedFixture("lineage-validation");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const before = snapshot(reserved.fixture);
    expect(() =>
      transitionInterrupted(reserved.fixture, {
        ...interruption.lineage,
        dispatchFencingToken: interruption.lineage.fencingToken,
      }),
    ).toThrow();
    expect(() =>
      transitionInterrupted(reserved.fixture, {
        ...interruption.lineage,
        resumeEligible: true,
      }),
    ).toThrow();
    expectStateUnchanged(reserved.fixture, before);
  });

  it("rejects mismatched Cancel and Pause Intent Event identities", () => {
    const cancel = openDispatchedFixture("lineage-cancel-intent");
    setCancelIntent(cancel.fixture, "lineage-cancel-intent");
    const cancelInterruption = createRecoveryInterruptionFixture(
      cancel.fixture,
      {
        attemptId: cancel.attemptId,
        reasonCode: "CANCEL_INTERRUPTED",
      },
    );
    const cancelBefore = snapshot(cancel.fixture);
    expect(() =>
      transitionInterrupted(cancel.fixture, {
        ...cancelInterruption.lineage,
        controlIntentEventId:
          cancelInterruption.lineage.dispatchEventId,
      }),
    ).toThrow(/intent/i);
    expectStateUnchanged(cancel.fixture, cancelBefore);

    closeCurrentDatabase();
    const pause = openDispatchedFixture("lineage-pause-intent");
    setPauseIntent(pause.fixture, "lineage-pause-intent");
    const pauseInterruption = createRecoveryInterruptionFixture(
      pause.fixture,
      {
        attemptId: pause.attemptId,
        reasonCode: "PAUSE_INTERRUPTED",
      },
    );
    const pauseBefore = snapshot(pause.fixture);
    expect(() =>
      transitionInterrupted(pause.fixture, {
        ...pauseInterruption.lineage,
        controlIntentEventId:
          pauseInterruption.lineage.dispatchEventId,
        pauseRequestEventId:
          pauseInterruption.lineage.dispatchEventId,
      }),
    ).toThrow(/intent/i);
    expectStateUnchanged(pause.fixture, pauseBefore);
  });

  it("rolls back when Interrupted Event append fails", () => {
    const reserved = openDispatchedFixture("lineage-event-failure");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const before = snapshot(reserved.fixture);
    vi.spyOn(EventRepository.prototype, "append").mockImplementationOnce(
      () => {
        throw new Error("injected Interrupted Event failure");
      },
    );
    expect(() =>
      transitionInterrupted(reserved.fixture, interruption.lineage),
    ).toThrow(/injected Interrupted Event failure/i);
    expectStateUnchanged(reserved.fixture, before);
  });

  it("rolls back when Checkpoint append fails", () => {
    const reserved = openDispatchedFixture("lineage-checkpoint-failure");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const before = snapshot(reserved.fixture);
    vi.spyOn(CheckpointStore.prototype, "append").mockImplementationOnce(
      () => {
        throw new Error("injected Interrupted checkpoint failure");
      },
    );
    expect(() =>
      transitionInterrupted(reserved.fixture, interruption.lineage),
    ).toThrow(/injected Interrupted checkpoint failure/i);
    expectStateUnchanged(reserved.fixture, before);
  });

  it("exact-replays Interrupted lineage without duplicate writes", () => {
    const reserved = openDispatchedFixture("lineage-exact-replay");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const input = interruptionInput(
      reserved.fixture,
      interruption.lineage,
    );
    transitionInterrupted(reserved.fixture, interruption.lineage, input);
    const afterFirst = snapshot(reserved.fixture);
    expect(
      transitionInterrupted(
        reserved.fixture,
        interruption.lineage,
        input,
      ).status,
    ).toBe("interrupted");
    const afterReplay = snapshot(reserved.fixture);
    expect(afterReplay.events).toHaveLength(afterFirst.events.length);
    expect(afterReplay.checkpoints).toHaveLength(
      afterFirst.checkpoints.length,
    );
  });

  it("exact-replays historical lineage under a newer Owner fencing", () => {
    const reserved = openDispatchedFixture("lineage-cross-owner-replay");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
        recoveryOperationId:
          "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      },
    );
    const ownerA = { ...reserved.fixture.ownership };
    const inputA = {
      ...interruptionInput(
        reserved.fixture,
        interruption.lineage,
      ),
      ownership: ownerA,
    };
    expect(
      new RecoveryEvidenceReadAttemptRepository(
        reserved.fixture.database,
      ).get(reserved.attemptId).status,
    ).toBe("dispatching");
    transitionInterrupted(
      reserved.fixture,
      interruption.lineage,
      inputA,
    );
    const afterOwnerA = snapshot(reserved.fixture);
    const interruptedEvent = afterOwnerA.events.find(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_interrupted" &&
        event.entityId === reserved.attemptId,
    );
    if (interruptedEvent === undefined) {
      throw new Error("Expected Owner A Interrupted Event.");
    }

    reserved.fixture.leaseManager.release(
      reserved.fixture.taskId,
      ownerA.leaseToken,
      ownerA.fencingToken,
    );
    const ownerB = reserved.fixture.leaseManager.claim(
      reserved.fixture.taskId,
      "owner-b-cross-replay",
    );
    if (ownerB.leaseToken === null) {
      throw new Error("Owner B lease claim failed.");
    }
    reserved.fixture.ownership.leaseToken = ownerB.leaseToken;
    reserved.fixture.ownership.fencingToken = ownerB.fencingToken;
    const beforeReplay = snapshot(reserved.fixture);
    const replayed = transitionInterrupted(
      reserved.fixture,
      interruption.lineage,
      {
        ...inputA,
        ownership: { ...reserved.fixture.ownership },
      },
    );
    const afterReplay = snapshot(reserved.fixture);
    expect(replayed.status).toBe("interrupted");
    expect(replayed.lastEventId).toBe(interruptedEvent.id);
    expect(ownerB.fencingToken).toBeGreaterThan(ownerA.fencingToken);
    expect(afterReplay.lease?.fencingToken).toBe(ownerB.fencingToken);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        interruptedEvent.payload,
      ),
    ).toMatchObject({
      fencingToken: ownerA.fencingToken,
      leaseClaimEventId: interruption.lineage.leaseClaimEventId,
    });
    expect(afterReplay.events).toHaveLength(beforeReplay.events.length);
    expect(afterReplay.checkpoints).toHaveLength(
      beforeReplay.checkpoints.length,
    );

    expect(() =>
      transitionInterrupted(
        reserved.fixture,
        interruption.lineage,
        inputA,
      ),
    ).toThrow(/lease|owned|fencing/i);
  });

  it("replays Interrupted lineage after Stage 3.3 Cancel convergence", () => {
    const reserved = openDispatchedFixture("lineage-cancel-replay");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const originalInput = interruptionInput(
      reserved.fixture,
      interruption.lineage,
    );
    transitionInterrupted(
      reserved.fixture,
      interruption.lineage,
      originalInput,
    );
    const cancel = setCancelIntent(
      reserved.fixture,
      "lineage-cancel-replay-intent",
    );
    reserved.fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
      cancelOwnedInput(
        reserved.fixture,
        reserved.attemptId,
        cancel.eventId,
      ),
    );
    const beforeReplay = snapshot(reserved.fixture);
    expect(beforeReplay.recoveryEvidenceReadAttempts[0]?.status).toBe(
      "interrupted",
    );
    expect(
      beforeReplay.toolRuns.find(
        (run) => run.id === reserved.fixture.readToolRunId,
      )?.status,
    ).toBe("cancelled");
    expect(
      transitionInterrupted(
        reserved.fixture,
        interruption.lineage,
        originalInput,
      ).status,
    ).toBe("interrupted");
    const afterReplay = snapshot(reserved.fixture);
    expect(afterReplay.events).toHaveLength(beforeReplay.events.length);
    expect(afterReplay.checkpoints).toHaveLength(
      beforeReplay.checkpoints.length,
    );
  });

  it.each(["full", "pause"] as const)(
    "replays Interrupted lineage after %s recovery child preparation",
    (mode) => {
      const reserved = openDispatchedFixture(
        `lineage-${mode}-evolution`,
      );
      let pauseRequestEventId: string | undefined;
      if (mode === "pause") {
        setPauseIntent(
          reserved.fixture,
          "lineage-pause-evolution",
        );
      }
      const interruption = createRecoveryInterruptionFixture(
        reserved.fixture,
        {
          attemptId: reserved.attemptId,
          reasonCode:
            mode === "pause"
              ? "PAUSE_INTERRUPTED"
              : "RECOVERY_READY",
        },
      );
      const resumableInterruption = {
        ...interruption.lineage,
        retryAssessment: "passed" as const,
        resumeEligible: true,
      };
      if (mode === "pause") {
        pauseRequestEventId =
          interruption.lineage.pauseRequestEventId;
      }
      const originalInput = interruptionInput(
        reserved.fixture,
        resumableInterruption,
      );
      transitionInterrupted(
        reserved.fixture,
        resumableInterruption,
        originalInput,
      );
      const interruptedSnapshot = snapshot(reserved.fixture);
      const interruptedEvent = interruptedSnapshot.events.find(
        (event) =>
          event.type ===
            "recovery.evidence.read_attempt_interrupted" &&
          event.entityId === reserved.attemptId,
      );
      if (interruptedEvent === undefined) {
        throw new Error("Expected Interrupted Event.");
      }
      let pauseClearEventId: string | undefined;
      if (mode === "pause") {
        if (pauseRequestEventId === undefined) {
          throw new Error("Expected Pause Request Event.");
        }
        pauseClearEventId = clearPauseIntent(
          reserved.fixture,
          "lineage-pause-clear",
          pauseRequestEventId,
        ).eventId;
      }
      createPreparedRecoveryChild({
        fixture: reserved.fixture,
        interrupt: resumableInterruption,
        interruptionEventId: interruptedEvent.id,
        pauseClearEventId,
      });
      const beforeReplay = snapshot(reserved.fixture);
      expect(
        beforeReplay.recoveryEvidenceReadAttempts.map(
          (attempt) => attempt.status,
        ),
      ).toEqual(["interrupted", "prepared"]);
      expect(
        transitionInterrupted(
          reserved.fixture,
          resumableInterruption,
          originalInput,
        ).status,
      ).toBe("interrupted");
      const afterReplay = snapshot(reserved.fixture);
      expect(afterReplay.events).toHaveLength(beforeReplay.events.length);
      expect(afterReplay.checkpoints).toHaveLength(
        beforeReplay.checkpoints.length,
      );
    },
  );

  it("rejects a tampered historical lineage reference on Replay", () => {
    const reserved = openDispatchedFixture("lineage-tampered-replay");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    transitionInterrupted(
      reserved.fixture,
      interruption.lineage,
    );
    const before = snapshot(reserved.fixture);
    expect(() =>
      transitionInterrupted(reserved.fixture, {
        ...interruption.lineage,
        leaseClaimEventId:
          "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    ).toThrow(/lineage|conflict/i);
    expectStateUnchanged(reserved.fixture, before);
  });

  it("rejects unexplained downstream state on Replay", () => {
    const reserved = openDispatchedFixture("lineage-illegal-state");
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    transitionInterrupted(
      reserved.fixture,
      interruption.lineage,
    );
    runInTransaction(
      reserved.fixture.database,
      () => {
        const permit = createStorageWritePermit(
          reserved.fixture.database,
        );
        const runs = new ToolRunRepository(
          reserved.fixture.database,
        );
        const run = runs.get(reserved.fixture.readToolRunId);
        runs.transition(
          run.id,
          ["interrupted"],
          {
            expectedVersion: run.version,
            status: "failed",
            updatedAt: "2026-11-08T00:10:00.000Z",
          },
          permit,
        );
      },
      "immediate",
    );
    const before = snapshot(reserved.fixture);
    expect(() =>
      transitionInterrupted(
        reserved.fixture,
        interruption.lineage,
      ),
    ).toThrow(/downstream|replay|inconsistent/i);
    expectStateUnchanged(reserved.fixture, before);
  });

  it("rejects stale lease, fencing and revoked Authority", () => {
    const reserved = openDispatchedFixture("lineage-old-owner");
    const previousOwnership = { ...reserved.fixture.ownership };
    const interruption = createRecoveryInterruptionFixture(
      reserved.fixture,
      {
        attemptId: reserved.attemptId,
        reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
      },
    );
    const before = snapshot(reserved.fixture);
    expect(() =>
      transitionInterrupted(
        reserved.fixture,
        interruption.lineage,
        {
          ...interruptionInput(
            reserved.fixture,
            interruption.lineage,
          ),
          ownership: previousOwnership,
        },
      ),
    ).toThrow(/lease|owned|fencing/i);

    reserved.fixture.authority.revoke(new Error("stale authority"));
    expect(() =>
      transitionInterrupted(reserved.fixture, interruption.lineage),
    ).toThrow(/authority/i);
    expectStateUnchanged(reserved.fixture, before);
  });
});

function openDispatchedFixture(suffix: string): {
  readonly fixture: RecoveryEvidenceUowFixture;
  readonly attemptId: string;
} {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  const fixture = createRecoveryEvidenceUowFixture(database, suffix, {
    allowlistVersion: "a".repeat(64),
  });
  const request =
    fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
      requestInput(fixture, suffix),
    );
  const current = snapshot(fixture);
  runInTransaction(
    fixture.database,
    () =>
      fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
        {
          ownership: fixture.ownership,
          expectedTaskVersion: current.task.version,
          attemptId: request.attempt.id,
          expectedAttemptVersion: request.attempt.version,
          status: "dispatching",
          observedAt: null,
          resourceVersion: null,
          resourceEtag: null,
          resultDigest: null,
          resultPayloadStoreRef: null,
          reasonCode: null,
        },
        createStorageWritePermit(fixture.database),
      ),
    "immediate",
  );
  return {
    fixture,
    attemptId: request.attempt.id,
  };
}

function transitionInterrupted(
  fixture: RecoveryEvidenceUowFixture,
  lineage: RecoveryEvidenceInterruptLineageV1,
  input = interruptionInput(fixture, lineage),
) {
  return runInTransaction(
    fixture.database,
    () =>
      fixture.stateTransitions.transitionOwnedRecoveryEvidenceReadAttempt(
        input,
        createStorageWritePermit(fixture.database),
      ),
    "immediate",
  );
}

function interruptionInput(
  fixture: RecoveryEvidenceUowFixture,
  lineage: RecoveryEvidenceInterruptLineageV1,
) {
  const current = snapshot(fixture);
  const attempt = new RecoveryEvidenceReadAttemptRepository(
    fixture.database,
  ).get(lineage.readAttemptId);
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: current.task.version,
    attemptId: attempt.id,
    expectedAttemptVersion: attempt.version,
    status: "interrupted" as const,
    observedAt: null,
    resourceVersion: null,
    resourceEtag: null,
    resultDigest: null,
    resultPayloadStoreRef: null,
    reasonCode: lineage.reasonCode,
    recoveryLineage: lineage,
  };
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
      allowlistId: "inventory_readback",
      allowlistVersion: fixture.allowlistVersion,
      readToolName: "inventory_lookup",
      readToolVersion: "1",
      readToolSchemaHash: digest("3"),
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
    expectedTaskVersion: snapshot(fixture).task.version,
    requestId: `lineage-request-${suffix}`,
    operationId: `lineage-operation-${suffix}`,
    readAttemptId: `lineage-attempt-${suffix}`,
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
    allowlistId: "inventory_readback",
    allowlistVersion: fixture.allowlistVersion,
    readToolName: "inventory_lookup",
    readToolVersion: "1",
    readToolSchemaHash: digest("3"),
    retrySafety: "version_conditional" as const,
    consistencyMode: "etag_or_resource_version" as const,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
    verificationCheckId: fixture.verificationCheckId,
  };
}

function createPreparedRecoveryChild(input: {
  readonly fixture: RecoveryEvidenceUowFixture;
  readonly interrupt: RecoveryEvidenceInterruptLineageV1;
  readonly interruptionEventId: string;
  readonly pauseClearEventId?: string | undefined;
}): void {
  const current = snapshot(input.fixture);
  const priorAttempt = current.recoveryEvidenceReadAttempts.find(
    (attempt) => attempt.id === input.interrupt.priorAttemptId,
  );
  const run = current.toolRuns.find(
    (candidate) =>
      candidate.id === input.interrupt.readToolRunId,
  );
  const step = current.planSteps.find(
    (candidate) =>
      candidate.id === input.fixture.planStepId,
  );
  if (
    priorAttempt === undefined ||
    run === undefined ||
    step === undefined
  ) {
    throw new Error("Expected recovery child binding.");
  }
  const newAttemptId = `recovery-child-${input.interrupt.priorAttemptId}`;
  const newAttemptNumber = priorAttempt.attemptNumber + 1;
  const preparedLineage = {
    lineageSchemaVersion: input.interrupt.lineageSchemaVersion,
    recoveryOperationId: input.interrupt.recoveryOperationId,
    recoveryPhase: "prepare" as const,
    taskId: input.interrupt.taskId,
    readbackRequestId: input.interrupt.readbackRequestId,
    readToolRunId: input.interrupt.readToolRunId,
    readAttemptId: newAttemptId,
    attemptNumber: newAttemptNumber,
    attemptStatus: "prepared" as const,
    priorAttemptId: priorAttempt.id,
    priorAttemptNumber: priorAttempt.attemptNumber,
    interruptionEventId: input.interruptionEventId,
    newAttemptId,
    newAttemptNumber,
    leaseClaimEventId: input.interrupt.leaseClaimEventId,
    fencingToken: input.interrupt.fencingToken,
    retrySafety: input.interrupt.retrySafety,
    consistencyMode: input.interrupt.consistencyMode,
    allowlistId: input.interrupt.allowlistId,
    allowlistVersion: input.interrupt.allowlistVersion,
    readToolName: input.interrupt.readToolName,
    readToolVersion: input.interrupt.readToolVersion,
    readToolSchemaHash: input.interrupt.readToolSchemaHash,
    requestIntentDigest: input.interrupt.requestIntentDigest,
    expectedResourceVersion:
      input.interrupt.expectedResourceVersion,
    expectedEtag: input.interrupt.expectedEtag,
    ...(input.pauseClearEventId === undefined
      ? {}
      : { pauseClearEventId: input.pauseClearEventId }),
  };
  runInTransaction(
    input.fixture.database,
    () => {
      const permit = createStorageWritePermit(input.fixture.database);
      new ToolRunRepository(input.fixture.database).transition(
        run.id,
        ["interrupted"],
        {
          expectedVersion: run.version,
          status: "queued",
          finishedAt: null,
          updatedAt: "2026-11-08T00:09:00.000Z",
        },
        permit,
      );
      new PlanStepRepository(input.fixture.database).updateStatusCas(
        step.id,
        "interrupted",
        step.version,
        "running",
        "2026-11-08T00:09:00.000Z",
        permit,
      );
      const event = new EventRepository(
        input.fixture.database,
        new SequenceAllocator(input.fixture.database),
      ).append(
        {
          taskId: input.fixture.taskId,
          traceId: current.task.traceId,
          type: "recovery.evidence.read_attempt_prepared",
          entityType: "recovery_evidence_read_attempt",
          entityId: newAttemptId,
          payload: preparedLineage,
        },
        "2026-11-08T00:09:00.000Z",
        permit,
      );
      new RecoveryEvidenceReadAttemptRepository(
        input.fixture.database,
      ).insertPrepared(
        {
          id: newAttemptId,
          taskId: input.fixture.taskId,
          readbackRequestId: input.interrupt.readbackRequestId,
          readToolRunId: input.interrupt.readToolRunId,
          attemptNumber: newAttemptNumber,
          retrySafety: input.interrupt.retrySafety,
          consistencyMode: input.interrupt.consistencyMode,
          preparedAt: "2026-11-08T00:09:00.000Z",
          lastEventId: event.id,
          createdAt: "2026-11-08T00:09:00.000Z",
        },
        permit,
      );
    },
    "immediate",
  );
}

function clearPauseIntent(
  fixture: RecoveryEvidenceUowFixture,
  requestNonce: string,
  pauseRequestEventId: string,
): ReturnType<
  RecoveryEvidenceUowFixture["unitOfWork"]["clearTaskWideRecoveryEvidencePause"]
> {
  const current = snapshot(fixture);
  const pauseEvent = current.events.find(
    (event) => event.id === pauseRequestEventId,
  );
  if (
    pauseEvent === undefined ||
    current.task.pauseRequestedAt === null
  ) {
    throw new Error("Expected active Pause Event.");
  }
  return fixture.unitOfWork.clearTaskWideRecoveryEvidencePause({
    hostControlAuthorization:
      issueRecoveryEvidenceHostControlAuthorization({
        taskId: fixture.taskId,
        operation: "pause_clear",
        requestNonce,
        controlActor: "host-control",
      }),
    expectedTaskVersion: current.task.version,
    requestNonce,
    controlActor: "host-control",
    expectedPauseRequestedAt: current.task.pauseRequestedAt,
    pauseRequestEventId,
    expectedPauseEventSequence: pauseEvent.sequence,
  });
}

function cancelOwnedInput(
  fixture: RecoveryEvidenceUowFixture,
  attemptId: string,
  cancelIntentEventId: string,
) {
  const current = snapshot(fixture);
  const request = current.recoveryEvidenceReadbackRequests[0];
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
    throw new Error("Expected Cancel binding.");
  }
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: current.task.version,
    requestId: request.id,
    attemptId,
    cancelIntentEventId,
    expectedAttemptVersion: attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
    reasonCode: "CANCEL_REQUESTED" as const,
  };
}

function setCancelIntent(
  fixture: RecoveryEvidenceUowFixture,
  requestNonce: string,
): ReturnType<
  RecoveryEvidenceUowFixture["unitOfWork"]["setTaskWideRecoveryEvidenceCancel"]
> {
  return fixture.unitOfWork.setTaskWideRecoveryEvidenceCancel({
    hostControlAuthorization:
      issueRecoveryEvidenceHostControlAuthorization({
        taskId: fixture.taskId,
        operation: "cancel_set",
        requestNonce,
        controlActor: "host-control",
      }),
    expectedTaskVersion: snapshot(fixture).task.version,
    requestNonce,
    controlActor: "host-control",
  });
}

function setPauseIntent(
  fixture: RecoveryEvidenceUowFixture,
  requestNonce: string,
): void {
  fixture.unitOfWork.setTaskWideRecoveryEvidencePause({
    hostControlAuthorization:
      issueRecoveryEvidenceHostControlAuthorization({
        taskId: fixture.taskId,
        operation: "pause_set",
        requestNonce,
        controlActor: "host-control",
      }),
    expectedTaskVersion: snapshot(fixture).task.version,
    requestNonce,
    controlActor: "host-control",
  });
}

function snapshot(fixture: RecoveryEvidenceUowFixture) {
  return new TaskSnapshotReader(fixture.database).load(fixture.taskId);
}

function expectStateUnchanged(
  fixture: RecoveryEvidenceUowFixture,
  before: ReturnType<typeof snapshot>,
): void {
  const after = snapshot(fixture);
  expect(after.recoveryEvidenceReadAttempts).toEqual(
    before.recoveryEvidenceReadAttempts,
  );
  expect(after.toolRuns).toEqual(before.toolRuns);
  expect(after.planSteps).toEqual(before.planSteps);
  expect(after.executionPlans).toEqual(before.executionPlans);
  expect(after.events).toHaveLength(before.events.length);
  expect(after.checkpoints).toHaveLength(before.checkpoints.length);
}

function closeCurrentDatabase(): void {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
