import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  EventRepository,
  ExecutionPlanRepository,
  CheckpointStore,
  MessageRepository,
  PlanStepRepository,
  RecoveryEvidenceReadAttemptRepository,
  RecoveryEvidenceReadRepository,
  RecoveryEvidenceReadbackRequestRepository,
  RecoveryEvidenceVerificationCheckRepository,
  RecoveryReviewRepository,
  SequenceAllocator,
  TaskSnapshotReader,
  ToolRunRepository,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  computeRecoveryEvidenceVerificationRequestKey,
  migrateStorage,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { issueRecoveryEvidenceHostControlAuthorization } from "../../src/recovery/recovery-evidence-host-control-authorization.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import type { RecoveryEvidenceTransitionTarget } from "../../src/storage/recovery-evidence-state-matrix.js";
import { RecoveryEvidenceSubmissionRepository } from "../../src/storage/recovery-evidence-submission-repository.js";
import { RecoveryReviewOperationRepository } from "../../src/storage/recovery-review-operation-repository.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { computeCanonicalInputHash } from "../../src/tools/fingerprint.js";
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

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
const workers: ChildProcess[] = [];
const WORKER_TIMEOUT_MS = 15_000;
const attemptWorkerPath = fileURLToPath(
  new URL("./recovery-evidence-attempt-worker.ts", import.meta.url),
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

describe("RecoveryEvidenceUnitOfWork", () => {
  it("creates a readback request and prepared attempt atomically with exact replay", () => {
    const fixture = openFixture("request");
    const input = requestInput(fixture, "request");

    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(input);
    expect(created).toMatchObject({
      replayed: false,
      request: {
        id: input.requestId,
        verificationCheckId: fixture.verificationCheckId,
      },
      attempt: {
        attemptNumber: 1,
        status: "prepared",
      },
      operation: {
        operation: "request_readback",
        status: "accepted",
      },
    });
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest({
        ...input,
        operationPayloadDigest: digest("f"),
      }),
    ).toThrow(/payload digest|digest/i);

    const replayed =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        input,
        () => {
          throw new Error("replay must not prepare parents");
        },
      );
    expect(replayed.replayed).toBe(true);
    expect(replayed.request.id).toBe(created.request.id);
    expect(replayed.attempt.id).toBe(created.attempt.id);

    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryEvidenceReadbackRequests).toHaveLength(1);
    expect(snapshot.recoveryEvidenceReadAttempts).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.readback_requested",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.read_attempt_prepared",
      ),
    ).toHaveLength(1);
  });

  it("rolls back parent preparation with the Request in one transaction", () => {
    const fixture = openFixture("parent-transaction");
    const input = {
      ...requestInput(fixture, "parent-transaction"),
      evidenceSubmissionId: "submission-missing-parent-rollback",
    };
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        input,
        ({ permit }) => {
          new MessageRepository(
            fixture.database,
            new SequenceAllocator(fixture.database),
          ).append(
            {
              taskId: fixture.taskId,
              role: "user",
              content: "parent transaction marker",
            },
            "2026-11-08T00:00:50.000Z",
            permit,
          );
        },
      ),
    ).toThrow(/binding|invalid/i);
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(
      snapshot.messages.some(
        (message) => message.content === "parent transaction marker",
      ),
    ).toBe(false);
    expect(snapshot.recoveryEvidenceReadbackRequests).toHaveLength(0);
  });

  it("cannot use replay or new writes after local authority is revoked", () => {
    const fixture = openFixture("authority-replay");
    const input = requestInput(fixture, "authority-replay");
    fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(input);
    fixture.authority.revoke(new Error("heartbeat failed"));
    expect(() =>
      fixture.leaseManager.assertOwned(
        fixture.ownership.taskId,
        fixture.ownership.leaseToken,
        fixture.ownership.fencingToken,
      ),
    ).not.toThrow();
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(input),
    ).toThrow(/authority/i);
    const attempt = new RecoveryEvidenceReadAttemptRepository(
      fixture.database,
    ).get(input.readAttemptId);
    expect(() =>
      transitionInImmediate(fixture, {
        ownership: fixture.ownership,
        expectedTaskVersion: new TaskSnapshotReader(
          fixture.database,
        ).load(fixture.taskId).task.version,
        attemptId: attempt.id,
        expectedAttemptVersion: attempt.version,
        status: "dispatching",
        observedAt: null,
        resourceVersion: null,
        resourceEtag: null,
        resultDigest: null,
        resultPayloadStoreRef: null,
        reasonCode: null,
      }),
    ).toThrow(/authority/i);
  });

  it("creates independent A/B/C requests for one Review and Original Write", () => {
    const fixture = openFixture("abc");
    const first =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "abc-a"),
      );
    const secondResource = addEvidenceVariant(fixture, "abc-b", "d");
    const second =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInputForResource(fixture, secondResource, "abc-b"),
      );
    const thirdResource = addEvidenceVariant(fixture, "abc-c", "e");
    const third =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInputForResource(fixture, thirdResource, "abc-c"),
      );

    expect(
      new Set([
        first.request.requestKey,
        second.request.requestKey,
        third.request.requestKey,
      ]).size,
    ).toBe(3);
    expect(
      new Set([
        first.request.evidenceSubmissionId,
        second.request.evidenceSubmissionId,
        third.request.evidenceSubmissionId,
      ]).size,
    ).toBe(3);
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryEvidenceReadbackRequests).toHaveLength(3);
    expect(snapshot.recoveryEvidenceReadAttempts).toHaveLength(3);
  });

  it("transitions attempts with CAS and appends matching events", () => {
    const fixture = openFixture("attempt");
    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "attempt"),
      );
    const afterCreate = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    const dispatching =
      transitionInImmediate(fixture, {
        ownership: fixture.ownership,
        expectedTaskVersion: afterCreate.task.version,
        attemptId: created.attempt.id,
        expectedAttemptVersion: created.attempt.version,
        status: "dispatching",
        observedAt: null,
        resourceVersion: null,
        resourceEtag: null,
        resultDigest: null,
        resultPayloadStoreRef: null,
        reasonCode: null,
      });
    expect(dispatching).toMatchObject({
      status: "dispatching",
      version: 2,
    });

    const afterDispatch = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    const interrupted =
      transitionInImmediate(fixture, {
        ownership: fixture.ownership,
        expectedTaskVersion: afterDispatch.task.version,
        attemptId: dispatching.id,
        expectedAttemptVersion: dispatching.version,
        status: "interrupted",
        observedAt: null,
        resourceVersion: null,
        resourceEtag: null,
        resultDigest: null,
        resultPayloadStoreRef: null,
        reasonCode: "READ_INTERRUPTED",
      });
    expect(interrupted.status).toBe("interrupted");

    expect(() =>
      transitionInImmediate(fixture, {
        ownership: fixture.ownership,
        expectedTaskVersion: afterDispatch.task.version,
        attemptId: dispatching.id,
        expectedAttemptVersion: 1,
        status: "failed",
        observedAt: "2026-11-08T00:00:00.000Z",
        resourceVersion: "7",
        resourceEtag: "etag-7",
        resultDigest: digest("8"),
        resultPayloadStoreRef: `evidence-file:sha256/${"8".repeat(64)}`,
        reasonCode: "STALE_ATTEMPT",
      }),
    ).toThrow(/transition|conflict|invalid|changed/i);

    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(
      snapshot.events
        .filter((event) => event.entityId === created.attempt.id)
        .map((event) => event.type),
    ).toEqual([
      "recovery.evidence.read_attempt_prepared",
      "recovery.evidence.read_attempt_dispatching",
      "recovery.evidence.read_attempt_interrupted",
    ]);
  });

  it(
    "allocates concurrent retry attempt numbers monotonically",
    async () => {
      const fixture = openFixture("attempt-concurrency");
      const request =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
          requestInput(fixture, "attempt-concurrency"),
        );
      let attempt = new RecoveryEvidenceReadAttemptRepository(
        fixture.database,
      ).get(request.attempt.id);
      let snapshot = new TaskSnapshotReader(fixture.database).load(
        fixture.taskId,
      );
      attempt =
        transitionInImmediate(fixture, {
          ownership: fixture.ownership,
          expectedTaskVersion: snapshot.task.version,
          attemptId: attempt.id,
          expectedAttemptVersion: attempt.version,
          status: "dispatching",
          observedAt: null,
          resourceVersion: null,
          resourceEtag: null,
          resultDigest: null,
          resultPayloadStoreRef: null,
          reasonCode: null,
        });
      snapshot = new TaskSnapshotReader(fixture.database).load(
        fixture.taskId,
      );
      transitionInImmediate(fixture, {
        ownership: fixture.ownership,
        expectedTaskVersion: snapshot.task.version,
        attemptId: attempt.id,
        expectedAttemptVersion: attempt.version,
        status: "interrupted",
        observedAt: null,
        resourceVersion: null,
        resourceEtag: null,
        resultDigest: null,
        resultPayloadStoreRef: null,
        reasonCode: "READ_INTERRUPTED",
      });
      const first = await startAttemptWorker(
        fixture,
        request.request.id,
        "attempt-worker-a",
      );
      const second = await startAttemptWorker(
        fixture,
        request.request.id,
        "attempt-worker-b",
      );
      const results = await Promise.allSettled([
        runAttemptWorker(first),
        runAttemptWorker(second),
      ]);
      expect(
        results.filter((result) => result.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const completed = results.find(
        (result): result is PromiseFulfilledResult<AttemptWorkerResult> =>
          result.status === "fulfilled",
      );
      expect(completed?.value.attemptNumber).toBe(2);
      const finalSnapshot = new TaskSnapshotReader(fixture.database).load(
        fixture.taskId,
      );
      expect(
        finalSnapshot.recoveryEvidenceReadAttempts
          .map((attempt) => attempt.attemptNumber)
          .sort((a, b) => a - b),
      ).toEqual([1, 2]);
    },
    WORKER_TIMEOUT_MS,
  );

  it("commits Check intent and EvidenceRead together after Transaction B", () => {
    const fixture = openFixture("b-complete");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "b-complete"),
      );
    const dispatching = dispatchAttempt(fixture, request.attempt.id);
    const completeInput = completeReadInput(
      fixture,
      request.request.id,
      dispatching.id,
      "check-record-b",
      "evidence-read-b",
    );
    const completed =
      fixture.unitOfWork.completeOwnedRecoveryEvidenceRead(completeInput);

    expect(completed.check.checkOrigin).toBe(
      "readback_transaction_b",
    );
    expect(completed.read).toMatchObject({
      verificationCheckId: fixture.verificationCheckId,
      resultPayloadDigest: digest("8"),
    });
    const replayed =
      fixture.unitOfWork.completeOwnedRecoveryEvidenceRead(completeInput);
    expect(replayed.replayed).toBe(true);
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryEvidenceVerificationChecks).toHaveLength(1);
    expect(snapshot.recoveryEvidenceReads).toHaveLength(1);
    expect(
      snapshot.toolRuns.find(
        (run) => run.id === fixture.readToolRunId,
      )?.status,
    ).toBe("succeeded");
    expect(
      snapshot.messages.filter(
        (message) =>
          message.toolCallId ===
          snapshot.toolRuns.find(
            (run) => run.id === fixture.readToolRunId,
          )?.toolCallId,
      ),
    ).toHaveLength(1);
    expect(
      snapshot.planSteps.find(
        (step) => step.id === fixture.planStepId,
      )?.status,
    ).toBe("completed");
  });

  it("does not roll back a completed Transaction B on Cancel", () => {
    const fixture = openFixture("intent-cancel-completed");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "intent-cancel-completed"),
      );
    const dispatching = dispatchAttempt(fixture, request.attempt.id);
    fixture.unitOfWork.completeOwnedRecoveryEvidenceRead(
      completeReadInput(
        fixture,
        request.request.id,
        dispatching.id,
        "check-record-cancel-completed",
        "evidence-read-cancel-completed",
      ),
    );
    const cancel = fixture.unitOfWork.setTaskWideRecoveryEvidenceCancel({
      hostControlAuthorization:
        issueRecoveryEvidenceHostControlAuthorization({
          taskId: fixture.taskId,
          operation: "cancel_set",
          requestNonce: "cancel-completed-intent",
          controlActor: "host-control",
        }),
      expectedTaskVersion: snapshotOf(fixture).task.version,
      requestNonce: "cancel-completed-intent",
      controlActor: "host-control",
    });
    const before = snapshotOf(fixture);
    expect(
      fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
        cancelOwnedInput(
          fixture,
          request.request.id,
          dispatching.id,
          cancel.eventId,
        ),
      ),
    ).toMatchObject({
      state: "completed",
      replayed: true,
      attemptStatus: "completed",
      toolRunStatus: "succeeded",
      planStepStatus: "completed",
      planStatus: "active",
    });
    const after = snapshotOf(fixture);
    expect(after.recoveryEvidenceReads).toEqual(before.recoveryEvidenceReads);
    expect(after.recoveryEvidenceVerificationChecks).toEqual(
      before.recoveryEvidenceVerificationChecks,
    );
    expect(after.events).toHaveLength(before.events.length);
  });

  it("rejects a late Transaction B result after authority revocation", () => {
    const fixture = openFixture("authority-b");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "authority-b"),
      );
    const dispatching = dispatchAttempt(fixture, request.attempt.id);
    const completeInput = completeReadInput(
      fixture,
      request.request.id,
      dispatching.id,
      "check-record-authority-b",
      "evidence-read-authority-b",
    );
    fixture.authority.revoke(new Error("heartbeat failed"));
    expect(() =>
      fixture.leaseManager.assertOwned(
        fixture.ownership.taskId,
        fixture.ownership.leaseToken,
        fixture.ownership.fencingToken,
      ),
    ).not.toThrow();
    expect(() =>
      fixture.unitOfWork.completeOwnedRecoveryEvidenceRead(completeInput),
    ).toThrow(/authority/i);

    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(
      snapshot.toolRuns.find(
        (run) => run.id === fixture.readToolRunId,
      )?.status,
    ).toBe("running");
    expect(snapshot.recoveryEvidenceReadAttempts[0]?.status).toBe(
      "dispatching",
    );
    expect(snapshot.recoveryEvidenceVerificationChecks).toHaveLength(0);
    expect(snapshot.recoveryEvidenceReads).toHaveLength(0);
  });

  const transactionBFailureCases: ReadonlyArray<
    readonly [string, () => void]
  > = [
    [
      "ToolRun transition",
      () => {
        vi.spyOn(
          ToolRunRepository.prototype,
          "transition",
        ).mockImplementation(() => {
          throw new Error("injected ToolRun failure");
        });
      },
    ],
    [
      "Tool Message",
      () => {
        vi.spyOn(MessageRepository.prototype, "append").mockImplementation(
          () => {
            throw new Error("injected message failure");
          },
        );
      },
    ],
    [
      "PlanStep result",
      () => {
        vi.spyOn(
          PlanStepRepository.prototype,
          "updateStatusCas",
        ).mockImplementation(() => {
          throw new Error("injected PlanStep failure");
        });
      },
    ],
    [
      "Attempt result",
      () => {
        vi.spyOn(
          RecoveryEvidenceReadAttemptRepository.prototype,
          "transition",
        ).mockImplementation(() => {
          throw new Error("injected Attempt failure");
        });
      },
    ],
    [
      "Check intent",
      () => {
        vi.spyOn(
          RecoveryEvidenceVerificationCheckRepository.prototype,
          "insert",
        ).mockImplementation(() => {
          throw new Error("injected Check failure");
        });
      },
    ],
    [
      "EvidenceRead",
      () => {
        vi.spyOn(
          RecoveryEvidenceReadRepository.prototype,
          "insertControlled",
        ).mockImplementation(() => {
          throw new Error("injected EvidenceRead failure");
        });
      },
    ],
    [
      "Attempt completed Event",
      () => {
        const original = EventRepository.prototype.append;
        let callCount = 0;
        vi.spyOn(EventRepository.prototype, "append").mockImplementation(
          function (
            this: EventRepository,
            input,
            now,
            permit,
          ) {
            callCount += 1;
            if (callCount === 1) {
              throw new Error("injected attempt event failure");
            }
            return original.call(this, input, now, permit);
          },
        );
      },
    ],
    [
      "Tool result Event",
      () => {
        const original = EventRepository.prototype.append;
        let callCount = 0;
        vi.spyOn(EventRepository.prototype, "append").mockImplementation(
          function (
            this: EventRepository,
            input,
            now,
            permit,
          ) {
            callCount += 1;
            if (callCount === 2) {
              throw new Error("injected tool event failure");
            }
            return original.call(this, input, now, permit);
          },
        );
      },
    ],
    [
      "Read completed Event",
      () => {
        const original = EventRepository.prototype.append;
        let callCount = 0;
        vi.spyOn(EventRepository.prototype, "append").mockImplementation(
          function (
            this: EventRepository,
            input,
            now,
            permit,
          ) {
            callCount += 1;
            if (callCount === 3) {
              throw new Error("injected read event failure");
            }
            return original.call(this, input, now, permit);
          },
        );
      },
    ],
    [
      "Checkpoint",
      () => {
        vi.spyOn(CheckpointStore.prototype, "append").mockImplementation(
          () => {
            throw new Error("injected checkpoint failure");
          },
        );
      },
    ],
  ];

  it.each(transactionBFailureCases)(
    "rolls back every Transaction B write when %s fails",
    (_label, installFailure) => {
      const fixture = openFixture("b-rollback");
      const request =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
          requestInput(fixture, "b-rollback"),
        );
      const dispatching = dispatchAttempt(fixture, request.attempt.id);
      const beforeComplete = new TaskSnapshotReader(fixture.database).load(
        fixture.taskId,
      );
      installFailure();
      const completeInput = completeReadInput(
        fixture,
        request.request.id,
        dispatching.id,
        "check-record-rollback",
        "evidence-read-rollback",
      );

      expect(() =>
        fixture.unitOfWork.completeOwnedRecoveryEvidenceRead(
          completeInput,
        ),
      ).toThrow(/injected/i);

      const after = new TaskSnapshotReader(fixture.database).load(
        fixture.taskId,
      );
      expect(
        after.toolRuns.find(
          (run) => run.id === fixture.readToolRunId,
        )?.status,
      ).toBe("running");
      expect(
        after.planSteps.find(
          (step) => step.id === fixture.planStepId,
        )?.status,
      ).toBe(beforeComplete.planSteps.find(
        (step) => step.id === fixture.planStepId,
      )?.status);
      expect(
        after.messages.filter(
          (message) =>
            message.toolCallId ===
            beforeComplete.toolRuns.find(
              (run) => run.id === fixture.readToolRunId,
            )?.toolCallId,
        ),
      ).toHaveLength(0);
      expect(
        after.recoveryEvidenceReadAttempts.find(
          (attempt) => attempt.id === dispatching.id,
        )?.status,
      ).toBe("dispatching");
      expect(after.recoveryEvidenceVerificationChecks).toHaveLength(0);
      expect(after.recoveryEvidenceReads).toHaveLength(0);
      expect(
        after.events.filter(
          (event) =>
            event.type === "recovery.evidence.read_completed" ||
            event.type === "tool.succeeded",
        ),
      ).toHaveLength(0);
      expect(after.checkpoints).toHaveLength(
        beforeComplete.checkpoints.length,
      );
    },
  );

  it("rejects cross-task references before writing request state", () => {
    const first = openFixture("cross-a");
    const second = createRecoveryEvidenceUowFixture(
      first.database,
      "cross-b",
    );
    const input = {
      ...requestInput(first, "cross"),
      readToolRunId: second.readToolRunId,
    };
    expect(() =>
      first.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(input),
    ).toThrow(/binding|task|invalid/i);
    expect(
      new TaskSnapshotReader(first.database).load(first.taskId)
        .recoveryEvidenceReadbackRequests,
    ).toHaveLength(0);
  });

  it("rejects wrong Manifest and Original Write bindings", () => {
    const fixture = openFixture("wrong-binding");
    const wrongManifest = {
      ...requestInput(fixture, "wrong-manifest"),
      evidenceSubmissionId: "submission-missing",
    };
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        wrongManifest,
      ),
    ).toThrow(/binding|invalid/i);

    const wrongOriginal = {
      ...requestInput(fixture, "wrong-original"),
      originalToolRunId: "run-missing",
    };
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        wrongOriginal,
      ),
    ).toThrow(/review|binding|invalid/i);
    expect(
      new TaskSnapshotReader(fixture.database).load(fixture.taskId)
        .recoveryEvidenceReadbackRequests,
    ).toHaveLength(0);
  });

  it("rejects Operation/Event ID mismatch before committing request state", () => {
    const fixture = openFixture("event-mismatch");
    const input = requestInput(fixture, "event-mismatch");
    expect(() =>
      runInTransaction(
        fixture.database,
        () => {
          const permit = createStorageWritePermit(fixture.database);
          const event = new EventRepository(
            fixture.database,
            new SequenceAllocator(fixture.database),
          ).append(
            {
              taskId: fixture.taskId,
              traceId: `trace-${fixture.taskId}`,
              type: "recovery.readback_requested",
              entityType: "recovery_review",
              entityId: fixture.reviewId,
              payload: {
                operationId: input.operationId,
                requestKey: input.requestKey,
                readbackRequestId: input.requestId,
                executionPlanId: fixture.executionPlanId,
                planStepId: fixture.planStepId,
                readToolRunId: "wrong-read-run",
                verificationCheckId: fixture.verificationCheckId,
              },
            },
            "2026-11-08T00:03:00.000Z",
            permit,
          );
          const operation = new RecoveryReviewOperationRepository(
            fixture.database,
          ).append(
            {
              id: input.operationId,
              taskId: fixture.taskId,
              reviewId: fixture.reviewId,
              requestKey: input.requestKey,
              operation: "request_readback",
              expectedDecisionVersion: input.expectedDecisionVersion,
              resultingDecisionVersion:
                input.expectedDecisionVersion + 1,
              status: "accepted",
              actorId: input.actorId,
              operationPayloadDigest: input.operationPayloadDigest,
              evidenceEnvelopeDigest: null,
              resultPlanId: fixture.executionPlanId,
              resultToolRunId: fixture.readToolRunId,
              appliedEventId: event.id,
              createdAt: "2026-11-08T00:03:00.000Z",
            },
            permit,
          );
          new RecoveryEvidenceReadbackRequestRepository(
            fixture.database,
          ).insert(
            {
              id: input.requestId,
              taskId: fixture.taskId,
              reviewId: fixture.reviewId,
              evidenceSubmissionId: fixture.evidenceSubmissionId,
              originalToolRunId: fixture.originalToolRunId,
              requestKey: input.requestKey,
              operationId: operation.id,
              executionPlanId: fixture.executionPlanId,
              planStepId: fixture.planStepId,
              readToolRunId: fixture.readToolRunId,
              verifierId: input.verifierId,
              verifierVersion: input.verifierVersion,
              verifierConfigDigest: input.verifierConfigDigest,
              allowlistId: input.allowlistId,
              allowlistVersion: input.allowlistVersion,
              readToolName: input.readToolName,
              readToolVersion: input.readToolVersion,
              readToolSchemaHash: input.readToolSchemaHash,
              retrySafety: input.retrySafety,
              consistencyMode: input.consistencyMode,
              expectedResourceVersion: input.expectedResourceVersion,
              expectedEtag: input.expectedEtag,
              verificationCheckId: input.verificationCheckId,
              createdAt: "2026-11-08T00:03:00.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrow(/binding is invalid|request binding/i);
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryEvidenceReadbackRequests).toHaveLength(0);
    expect(
      snapshot.events.filter(
        (event) => event.type === "recovery.readback_requested",
      ),
    ).toHaveLength(0);
  });

  it("creates Stored Evidence V0 checks and verification history", () => {
    const fixture = openFixture("v0");
    const requestKey = v0CheckRequestKey(fixture, "check-v0");
    const input = {
      ownership: fixture.ownership,
      expectedTaskVersion: fixture.expectedTaskVersion,
      checkRecordId: "check-record-v0",
      reviewId: fixture.reviewId,
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalToolRunId: fixture.originalToolRunId,
      verificationCheckId: "check-v0",
      requestKey,
      checkOrigin: "stored_evidence_v0" as const,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
      allowlistId: null,
      allowlistVersion: null,
      readToolName: null,
      readToolVersion: null,
      readToolSchemaHash: null,
      expectedPayloadDigest: digest("c"),
    };
    const check =
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(input);
    expect(check.replayed).toBe(false);
    expect(check.check.checkOrigin).toBe("stored_evidence_v0");
    expect(
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        input,
      ).replayed,
    ).toBe(true);

    const afterCheck = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    const recorded =
      fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
        ownership: fixture.ownership,
        expectedTaskVersion: afterCheck.task.version,
        verificationId: "verification-v0",
        verificationCheckId: "check-v0",
        requestKey,
        readbackResultProvenance: "declared_payload",
        availabilityStatus: "available",
        integrityStatus: "not_checked",
        authenticityStatus: "unverified",
        verificationStatus: "not_run",
        observedPayloadDigest: null,
        reasonCode: "VERIFIER_NOT_EXECUTED",
        redactedSummary: null,
      });
    expect(recorded.replayed).toBe(false);
    expect(recorded.verification.verificationEventId).toBeNull();

    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(snapshot.recoveryEvidenceVerifications).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.availability_checked",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.verification_completed",
      ),
    ).toHaveLength(0);
  });

  it("prevents Stored V0 from stealing a Request-reserved Check ID", () => {
    const fixture = openFixture("check-reservation");
    fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
      requestInput(fixture, "check-reservation"),
    );
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck({
        ownership: fixture.ownership,
        expectedTaskVersion: snapshot.task.version,
        checkRecordId: "check-record-reserved",
        reviewId: fixture.reviewId,
        evidenceSubmissionId: fixture.evidenceSubmissionId,
        originalToolRunId: fixture.originalToolRunId,
        verificationCheckId: fixture.verificationCheckId,
        requestKey: v0CheckRequestKey(
          fixture,
          fixture.verificationCheckId,
        ),
        checkOrigin: "stored_evidence_v0",
        verifierId: "host_verifier",
        verifierVersion: "1",
        verifierConfigDigest: digest("6"),
        allowlistId: null,
        allowlistVersion: null,
        readToolName: null,
        readToolVersion: null,
        readToolSchemaHash: null,
        expectedPayloadDigest: digest("c"),
      }),
    ).toThrow(/reserved|origin|invalid/i);
    expect(
      new TaskSnapshotReader(fixture.database).load(fixture.taskId)
        .recoveryEvidenceVerificationChecks,
    ).toHaveLength(0);
  });

  it("keeps distinct Stored V0 Check IDs independent", () => {
    const fixture = openFixture("v0-distinct");
    for (const index of [0, 1]) {
      const verificationCheckId = `check-distinct-${index}`;
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck({
        ownership: fixture.ownership,
        expectedTaskVersion: fixture.expectedTaskVersion,
        checkRecordId: `check-record-distinct-${index}`,
        reviewId: fixture.reviewId,
        evidenceSubmissionId: fixture.evidenceSubmissionId,
        originalToolRunId: fixture.originalToolRunId,
        verificationCheckId,
        requestKey: v0CheckRequestKey(fixture, verificationCheckId),
        checkOrigin: "stored_evidence_v0",
        verifierId: "host_verifier",
        verifierVersion: "1",
        verifierConfigDigest: digest("6"),
        allowlistId: null,
        allowlistVersion: null,
        readToolName: null,
        readToolVersion: null,
        readToolSchemaHash: null,
        expectedPayloadDigest: digest("c"),
      });
    }
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(
      snapshot.recoveryEvidenceVerificationChecks.map(
        (check) => check.verificationCheckId,
      ),
    ).toEqual(["check-distinct-0", "check-distinct-1"]);
  });

  it("rejects mutation of requests, attempts, checks, reads, and verifications", () => {
    const fixture = openFixture("append-only");
    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "append-only"),
      );
    expect(() =>
      fixture.database
        .prepare(
          "UPDATE recovery_evidence_readback_requests SET verifier_version = '2' WHERE id = ?",
        )
        .run(created.request.id),
    ).toThrow(/append-only/i);
    expect(() =>
      fixture.database
        .prepare(
          "DELETE FROM recovery_evidence_readback_requests WHERE id = ?",
        )
        .run(created.request.id),
    ).toThrow(/append-only/i);
    expect(() =>
      fixture.database
        .prepare(
          "DELETE FROM recovery_evidence_read_attempts WHERE id = ?",
        )
        .run(created.attempt.id),
    ).toThrow(/retained/i);

    const afterRequest = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck({
      ownership: fixture.ownership,
      expectedTaskVersion: afterRequest.task.version,
      checkRecordId: "check-record-append",
      reviewId: fixture.reviewId,
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalToolRunId: fixture.originalToolRunId,
      verificationCheckId: "check-append",
      requestKey: v0CheckRequestKey(fixture, "check-append"),
      checkOrigin: "stored_evidence_v0",
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
      allowlistId: null,
      allowlistVersion: null,
      readToolName: null,
      readToolVersion: null,
      readToolSchemaHash: null,
      expectedPayloadDigest: digest("c"),
    });
    expect(() =>
      fixture.database
        .prepare(
          "UPDATE recovery_evidence_verification_checks SET verifier_version = '2' WHERE id = 'check-record-append'",
        )
        .run(),
    ).toThrow(/append-only/i);
    expect(() =>
      fixture.database
        .prepare(
          "DELETE FROM recovery_evidence_verification_checks WHERE id = 'check-record-append'",
        )
        .run(),
    ).toThrow(/append-only/i);

    const afterCheck = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
      ownership: fixture.ownership,
      expectedTaskVersion: afterCheck.task.version,
      verificationId: "verification-append",
      verificationCheckId: "check-append",
      requestKey: v0CheckRequestKey(fixture, "check-append"),
      readbackResultProvenance: "declared_payload",
      availabilityStatus: "unavailable",
      integrityStatus: "not_checked",
      authenticityStatus: "unverified",
      verificationStatus: "not_run",
      observedPayloadDigest: null,
      reasonCode: "EVIDENCE_UNAVAILABLE",
      redactedSummary: null,
    });
    expect(() =>
      fixture.database
        .prepare(
          "UPDATE recovery_evidence_verifications SET reason_code = 'CHANGED' WHERE id = 'verification-append'",
        )
        .run(),
    ).toThrow(/append-only/i);
    expect(() =>
      fixture.database
        .prepare(
          "DELETE FROM recovery_evidence_verifications WHERE id = 'verification-append'",
        )
        .run(),
    ).toThrow(/append-only/i);
  });

  it("prevents the legacy EvidenceRead insert from creating controlled rows", () => {
    const fixture = openFixture("legacy-read");
    expect(() =>
      runInTransaction(
        fixture.database,
        () => {
          const permit = createStorageWritePermit(fixture.database);
          new RecoveryEvidenceReadRepository(fixture.database).insert(
            {
              id: "legacy-controlled-forbidden",
              taskId: fixture.taskId,
              reviewId: fixture.reviewId,
              toolRunId: fixture.readToolRunId,
              evidenceEnvelopeDigest: digest("a"),
              evidenceSubmissionId: fixture.evidenceSubmissionId,
              readbackRequestId: "request",
              readAttemptId: "attempt",
              verificationCheckId: fixture.verificationCheckId,
              observedAt: "2026-11-08T00:01:00.000Z",
              resourceVersion: "7",
              resourceEtag: "etag-7",
              resultPayloadDigest: digest("8"),
              resultPayloadStoreRef: `evidence-file:sha256/${"8".repeat(64)}`,
              resultPayloadStorageMode: "content_addressed_file",
              createdAt: "2026-11-08T00:01:00.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrow(/insertControlled|controlled/i);
  });

  it("records passed verification with availability and completion events", () => {
    const fixture = openFixture("v0-passed");
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck({
      ownership: fixture.ownership,
      expectedTaskVersion: fixture.expectedTaskVersion,
      checkRecordId: "check-record-v0-passed",
      reviewId: fixture.reviewId,
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalToolRunId: fixture.originalToolRunId,
      verificationCheckId: "check-v0-passed",
      requestKey: v0CheckRequestKey(fixture, "check-v0-passed"),
      checkOrigin: "stored_evidence_v0",
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
      allowlistId: null,
      allowlistVersion: null,
      readToolName: null,
      readToolVersion: null,
      readToolSchemaHash: null,
      expectedPayloadDigest: digest("c"),
    });
    const afterCheck = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    const input = {
      ownership: fixture.ownership,
      expectedTaskVersion: afterCheck.task.version,
      verificationId: "verification-v0-passed",
      verificationCheckId: "check-v0-passed",
      requestKey: v0CheckRequestKey(fixture, "check-v0-passed"),
      readbackResultProvenance: "declared_payload" as const,
      availabilityStatus: "available" as const,
      integrityStatus: "matched" as const,
      authenticityStatus: "system_verified" as const,
      verificationStatus: "passed" as const,
      observedPayloadDigest: digest("c"),
      reasonCode: "EXPECTED_STATE_OBSERVED",
      redactedSummary: "Expected state observed.",
    };
    expect(() => fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
      ...input, authenticityStatus: "manual_attested",
    })).toThrow(/Manual attestation requires/i);
    const recorded =
      fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification(input);
    expect(recorded.verification.verificationEventId).not.toBeNull();

    const replayed =
      fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification(input);
    expect(replayed.replayed).toBe(true);
    const snapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(() =>
      fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
        ...input,
        expectedTaskVersion: snapshot.task.version,
        requestKey: digest("a"),
      }),
    ).toThrow(/check|binding|mismatch/i);
    expect(snapshot.recoveryEvidenceVerifications).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.availability_checked",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.verification_completed",
      ),
    ).toHaveLength(1);
  });

  it("rejects a late Verification result after authority revocation", () => {
    const fixture = openFixture("authority-verification");
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck({
      ownership: fixture.ownership,
      expectedTaskVersion: fixture.expectedTaskVersion,
      checkRecordId: "check-record-authority-v0",
      reviewId: fixture.reviewId,
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalToolRunId: fixture.originalToolRunId,
      verificationCheckId: "check-authority-v0",
      requestKey: v0CheckRequestKey(fixture, "check-authority-v0"),
      checkOrigin: "stored_evidence_v0",
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
      allowlistId: null,
      allowlistVersion: null,
      readToolName: null,
      readToolVersion: null,
      readToolSchemaHash: null,
      expectedPayloadDigest: digest("c"),
    });
    const before = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    fixture.authority.revoke(new Error("heartbeat failed"));
    expect(() =>
      fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
        ownership: fixture.ownership,
        expectedTaskVersion: before.task.version,
        verificationId: "verification-authority-v0",
        verificationCheckId: "check-authority-v0",
        requestKey: v0CheckRequestKey(
          fixture,
          "check-authority-v0",
        ),
        readbackResultProvenance: "declared_payload",
        availabilityStatus: "available",
        integrityStatus: "matched",
        authenticityStatus: "unverified",
        verificationStatus: "passed",
        observedPayloadDigest: digest("c"),
        reasonCode: "EXPECTED_STATE",
        redactedSummary: "Expected state.",
      }),
    ).toThrow(/authority/i);
    const after = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(after.recoveryEvidenceVerifications).toHaveLength(0);
    expect(
      after.events.filter(
        (event) =>
          event.type === "recovery.evidence.availability_checked" ||
          event.type === "recovery.evidence.verification_completed",
      ),
    ).toHaveLength(0);
  });

  it("exact-replays after a lost response using the original Task version", () => {
    const fixture = openFixture("state-dispatch");
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-dispatch"),
      );
    const beforeDispatch = snapshotOf(fixture);
    const initialTaskVersion = beforeDispatch.task.version;
    const first = transitionAttempt(
      fixture,
      request.attempt.id,
      "dispatching",
    );
    expect(first).toMatchObject({ status: "dispatching", version: 2 });
    let snapshot = snapshotOf(fixture);
    expect(snapshot.task.version).toBe(initialTaskVersion + 2);
    expect(
      snapshot.toolRuns.find((run) => run.id === fixture.readToolRunId),
    ).toMatchObject({ status: "running" });
    expect(
      snapshot.planSteps.find((step) => step.id === fixture.planStepId),
    ).toMatchObject({ status: "running" });
    expect(
      snapshot.executionPlans.find(
        (plan) => plan.id === fixture.executionPlanId,
      ),
    ).toMatchObject({ status: "active" });
    expect(snapshot.checkpoints).toHaveLength(
      beforeDispatch.checkpoints.length + 1,
    );

    const eventCount = snapshot.events.length;
    const checkpointCount = snapshot.checkpoints.length;
    const replayed = transitionAttempt(
      fixture,
      request.attempt.id,
      "dispatching",
      {
        expectedTaskVersion: initialTaskVersion,
        expectedAttemptVersion: 1,
      },
    );
    expect(replayed.id).toBe(first.id);
    snapshot = snapshotOf(fixture);
    expect(snapshot.events).toHaveLength(eventCount);
    expect(snapshot.checkpoints).toHaveLength(checkpointCount);
    expect(executeValidated).not.toHaveBeenCalled();
  });

  it.each([
    [
      "failed",
      "failed",
      "failed",
      "failed",
      "recovery.evidence.read_attempt_failed",
    ],
    [
      "timed_out",
      "timed_out",
      "failed",
      "failed",
      "recovery.evidence.read_attempt_timed_out",
    ],
    [
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
      "recovery.evidence.read_attempt_cancelled",
    ],
    [
      "interrupted",
      "interrupted",
      "interrupted",
      "active",
      "recovery.evidence.read_attempt_interrupted",
    ],
  ] as const)(
    "applies active %s transition across all records",
    (target, toolStatus, stepStatus, planStatus, eventType) => {
      const fixture = openFixture(`state-${target}`);
      const request =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
          requestInput(fixture, `state-${target}`),
        );
      transitionAttempt(fixture, request.attempt.id, "dispatching");
      const before = snapshotOf(fixture);
      const attempt = transitionAttempt(
        fixture,
        request.attempt.id,
        target,
        { reasonCode: `STATE_${target.toUpperCase()}` },
      );
      expect(attempt.status).toBe(target);
      const snapshot = snapshotOf(fixture);
      expect(
        snapshot.toolRuns.find(
          (run) => run.id === fixture.readToolRunId,
        )?.status,
      ).toBe(toolStatus);
      expect(
        snapshot.planSteps.find(
          (step) => step.id === fixture.planStepId,
        )?.status,
      ).toBe(stepStatus);
      expect(
        snapshot.executionPlans.find(
          (plan) => plan.id === fixture.executionPlanId,
        )?.status,
      ).toBe(planStatus);
      expect(
        snapshot.events.filter(
          (event) =>
            event.type === eventType &&
            event.entityId === request.attempt.id,
        ),
      ).toHaveLength(1);
      expect(snapshot.checkpoints).toHaveLength(
        before.checkpoints.length + (target === "interrupted" ? 3 : 1),
      );
    },
  );

  it("cancels a blocked Attempt at Request level without rewriting the Attempt", () => {
    const fixture = openFixture("state-cancel-blocked");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-cancel-blocked"),
      );
    transitionAttempt(
      fixture,
      request.attempt.id,
      "blocked_by_intent",
      { reasonCode: "PAUSE_REQUESTED" },
    );
    const before = snapshotOf(fixture);
    const originalPlan = before.executionPlans.find(
      (plan) => plan.purpose === "agent",
    );
    const originalRun = before.toolRuns.find(
      (run) => run.id === fixture.originalToolRunId,
    );

    const cancelled = transitionAttempt(
      fixture,
      request.attempt.id,
      "cancelled",
      {
        reasonCode: "CANCEL_REQUESTED",
        transitionOperationId: "cancel-intent-blocked",
      },
    );
    expect(cancelled.status).toBe("blocked_by_intent");
    let snapshot = snapshotOf(fixture);
    expect(
      snapshot.toolRuns.find((run) => run.id === fixture.readToolRunId)
        ?.status,
    ).toBe("cancelled");
    expect(
      snapshot.planSteps.find((step) => step.id === fixture.planStepId)
        ?.status,
    ).toBe("cancelled");
    expect(
      snapshot.executionPlans.find(
        (plan) => plan.id === fixture.executionPlanId,
      )?.status,
    ).toBe("cancelled");
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.read_attempt_cancelled",
      ),
    ).toHaveLength(0);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.readback_cancelled" &&
          event.payload.cancelIntentEventId ===
            "cancel-intent-blocked",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.executionPlans.find(
        (plan) => plan.id === originalPlan?.id,
      ),
    ).toEqual(originalPlan);
    expect(
      snapshot.toolRuns.find((run) => run.id === originalRun?.id),
    ).toEqual(originalRun);

    const eventCount = snapshot.events.length;
    const checkpointCount = snapshot.checkpoints.length;
    transitionAttempt(fixture, request.attempt.id, "cancelled", {
      reasonCode: "CANCEL_REQUESTED",
      transitionOperationId: "cancel-intent-blocked",
    });
    snapshot = snapshotOf(fixture);
    expect(snapshot.events).toHaveLength(eventCount);
    expect(snapshot.checkpoints).toHaveLength(checkpointCount);
  });

  it("cancels a prepared Attempt and exact-replays the Attempt event", () => {
    const fixture = openFixture("state-cancel-prepared");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-cancel-prepared"),
      );
    const cancelled = transitionAttempt(
      fixture,
      request.attempt.id,
      "cancelled",
      { reasonCode: "CANCEL_REQUESTED" },
    );
    expect(cancelled.status).toBe("cancelled");
    let snapshot = snapshotOf(fixture);
    expect(
      snapshot.toolRuns.find((run) => run.id === fixture.readToolRunId)
        ?.status,
    ).toBe("cancelled");
    expect(
      snapshot.planSteps.find((step) => step.id === fixture.planStepId)
        ?.status,
    ).toBe("cancelled");
    expect(
      snapshot.executionPlans.find(
        (plan) => plan.id === fixture.executionPlanId,
      )?.status,
    ).toBe("cancelled");
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.read_attempt_cancelled" &&
          event.entityId === request.attempt.id,
      ),
    ).toHaveLength(1);

    const eventCount = snapshot.events.length;
    const checkpointCount = snapshot.checkpoints.length;
    transitionAttempt(fixture, request.attempt.id, "cancelled", {
      reasonCode: "CANCEL_REQUESTED",
      expectedAttemptVersion: 1,
    });
    snapshot = snapshotOf(fixture);
    expect(snapshot.events).toHaveLength(eventCount);
    expect(snapshot.checkpoints).toHaveLength(checkpointCount);
  });

  it("cancels an interrupted Attempt at Request level", () => {
    const fixture = openFixture("state-cancel-interrupted");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-cancel-interrupted"),
      );
    transitionAttempt(fixture, request.attempt.id, "dispatching");
    transitionAttempt(fixture, request.attempt.id, "interrupted", {
      reasonCode: "FENCING_TAKEOVER",
    });
    const cancelled = transitionAttempt(
      fixture,
      request.attempt.id,
      "cancelled",
      {
        reasonCode: "CANCEL_REQUESTED",
        transitionOperationId: "cancel-intent-interrupted",
      },
    );
    expect(cancelled.status).toBe("interrupted");
    const snapshot = snapshotOf(fixture);
    expect(
      snapshot.toolRuns.find((run) => run.id === fixture.readToolRunId)
        ?.status,
    ).toBe("cancelled");
    expect(
      snapshot.planSteps.find((step) => step.id === fixture.planStepId)
        ?.status,
    ).toBe("cancelled");
    expect(
      snapshot.executionPlans.find(
        (plan) => plan.id === fixture.executionPlanId,
      )?.status,
    ).toBe("cancelled");
  });

  it("does not force terminal Attempts into cancelled", () => {
    const fixture = openFixture("state-terminal");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-terminal"),
      );
    transitionAttempt(fixture, request.attempt.id, "dispatching");
    transitionAttempt(fixture, request.attempt.id, "timed_out", {
      reasonCode: "TOOL_TIMEOUT",
    });
    const before = snapshotOf(fixture);
    expect(() =>
      transitionAttempt(fixture, request.attempt.id, "cancelled", {
        reasonCode: "CANCEL_REQUESTED",
        transitionOperationId: "cancel-intent-terminal",
      }),
    ).toThrow(/state transition is invalid/i);
    const after = snapshotOf(fixture);
    expect(
      after.recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === request.attempt.id,
      )?.status,
    ).toBe("timed_out");
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  });

  it("converges multiple Requests from one Task-wide Cancel intent", () => {
    const fixture = openFixture("intent-multi-request-cancel");
    const first =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "intent-multi-cancel-a"),
      );
    const secondResource = addEvidenceVariant(
      fixture,
      "intent-multi-cancel-b",
      "d",
    );
    const second =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInputForResource(
          fixture,
          secondResource,
          "intent-multi-cancel-b",
        ),
      );
    const cancel = fixture.unitOfWork.setTaskWideRecoveryEvidenceCancel({
      hostControlAuthorization:
        issueRecoveryEvidenceHostControlAuthorization({
          taskId: fixture.taskId,
          operation: "cancel_set",
          requestNonce: "task-wide-cancel-multi",
          controlActor: "host-control",
        }),
      expectedTaskVersion: snapshotOf(fixture).task.version,
      requestNonce: "task-wide-cancel-multi",
      controlActor: "host-control",
    });
    const firstInput = cancelOwnedInput(
      fixture,
      first.request.id,
      first.attempt.id,
      cancel.eventId,
    );
    const planVersionsBeforeCancel = new Map(
      snapshotOf(fixture).executionPlans.map((plan) => [
        plan.id,
        plan.version,
      ]),
    );
    expect(
      fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(firstInput),
    ).toMatchObject({ state: "cancelled", replayed: false });

    const secondSnapshot = snapshotOf(fixture);
    const secondInput = cancelOwnedInput(
      fixture,
      second.request.id,
      second.attempt.id,
      cancel.eventId,
      {
        expectedAttemptVersion:
          second.attempt.version + 1,
        expectedTaskVersion: secondSnapshot.task.version,
      },
    );
    expect(() =>
      fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(secondInput),
    ).toThrow(/changed|version|conflict/i);
    expect(
      snapshotOf(fixture).recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === second.attempt.id,
      )?.status,
    ).toBe("prepared");

    expect(
      fixture.unitOfWork.cancelOwnedRecoveryEvidenceRead(
        cancelOwnedInput(
          fixture,
          second.request.id,
          second.attempt.id,
          cancel.eventId,
        ),
      ),
    ).toMatchObject({ state: "cancelled", replayed: false });
    const after = snapshotOf(fixture);
    expect(
      after.recoveryEvidenceReadAttempts
        .filter((attempt) =>
          [first.attempt.id, second.attempt.id].includes(attempt.id),
        )
        .map((attempt) => attempt.status),
    ).toEqual(["cancelled", "cancelled"]);
    expect(
      after.toolRuns.find(
        (run) => run.id === fixture.originalToolRunId,
      )?.status,
    ).toBe("unknown");
    for (const plan of after.executionPlans) {
      expect(plan.version).toBe(planVersionsBeforeCancel.get(plan.id));
    }
    expect(after.task.status).toBe("waiting_review");
  });

  it("keeps Pause separate from Cancel", () => {
    const fixture = openFixture("state-pause");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-pause"),
      );
    const paused = transitionAttempt(
      fixture,
      request.attempt.id,
      "blocked_by_intent",
      { reasonCode: "PAUSE_REQUESTED" },
    );
    expect(paused.status).toBe("blocked_by_intent");
    const snapshot = snapshotOf(fixture);
    expect(
      snapshot.toolRuns.find((run) => run.id === fixture.readToolRunId)
        ?.status,
    ).toBe("queued");
    expect(
      snapshot.planSteps.find((step) => step.id === fixture.planStepId)
        ?.status,
    ).toBe("queued");
    expect(
      snapshot.executionPlans.find(
        (plan) => plan.id === fixture.executionPlanId,
      )?.status,
    ).toBe("active");
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.read_attempt_cancelled" ||
          event.type === "recovery.evidence.readback_cancelled",
      ),
    ).toHaveLength(0);
  });

  it("keeps ExecutionPlan generation version stable across status CAS", () => {
    const fixture = openFixture("plan-version-semantics");
    const before = snapshotOf(fixture).executionPlans.find(
      (plan) => plan.id === fixture.executionPlanId,
    );
    if (before === undefined) {
      throw new Error("Expected Recovery Evidence Plan.");
    }
    const updated = runInTransaction(
      fixture.database,
      () =>
        new ExecutionPlanRepository(
          fixture.database,
        ).updateStatusCas(
          before.id,
          before.status,
          before.version,
          "cancelled",
          "2026-11-08T00:08:00.000Z",
          createStorageWritePermit(fixture.database),
        ),
      "immediate",
    );
    expect(updated.status).toBe("cancelled");
    expect(updated.version).toBe(before.version);
  });

  it("dispatches a prepared retry against an already-running PlanStep", () => {
    const fixture = openFixture("state-retry");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-retry"),
      );
    transitionAttempt(fixture, request.attempt.id, "dispatching");
    transitionAttempt(fixture, request.attempt.id, "interrupted", {
      reasonCode: "FENCING_TAKEOVER",
    });
    const retryAttempt =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadAttemptPrepared({
        ownership: fixture.ownership,
        expectedTaskVersion: snapshotOf(fixture).task.version,
        attemptId: "retry-attempt-stage-3-1",
        readbackRequestId: request.request.id,
      });
    runInTransaction(
      fixture.database,
      () => {
        const permit = createStorageWritePermit(fixture.database);
        const toolRuns = new ToolRunRepository(fixture.database);
        const planSteps = new PlanStepRepository(fixture.database);
        const run = toolRuns.get(fixture.readToolRunId);
        if (run.status !== "interrupted") {
          throw new Error("Expected interrupted read ToolRun.");
        }
        toolRuns.transition(
          run.id,
          ["interrupted"],
          {
            expectedVersion: run.version,
            status: "queued",
            updatedAt: "2026-11-08T00:03:00.000Z",
          },
          permit,
        );
        const step = planSteps.get(fixture.planStepId);
        if (step.status !== "interrupted") {
          throw new Error("Expected interrupted recovery PlanStep.");
        }
        planSteps.updateStatusCas(
          step.id,
          "interrupted",
          step.version,
          "running",
          "2026-11-08T00:03:00.000Z",
          permit,
        );
      },
      "immediate",
    );

    const dispatched = transitionAttempt(
      fixture,
      retryAttempt.id,
      "dispatching",
    );
    expect(dispatched.status).toBe("dispatching");
    const snapshot = snapshotOf(fixture);
    expect(
      snapshot.planSteps.find((step) => step.id === fixture.planStepId)
        ?.status,
    ).toBe("running");
    expect(
      snapshot.toolRuns.find((run) => run.id === fixture.readToolRunId)
        ?.status,
    ).toBe("running");
  });

  it("rolls back all state writes when checkpoint append fails", () => {
    const fixture = openFixture("state-rollback");
    const request =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        requestInput(fixture, "state-rollback"),
      );
    const before = snapshotOf(fixture);
    vi.spyOn(CheckpointStore.prototype, "append").mockImplementation(() => {
      throw new Error("injected state checkpoint failure");
    });

    expect(() =>
      transitionAttempt(fixture, request.attempt.id, "dispatching"),
    ).toThrow(/injected state checkpoint failure/i);
    const after = snapshotOf(fixture);
    expect(
      after.recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === request.attempt.id,
      )?.status,
    ).toBe("prepared");
    expect(
      after.toolRuns.find((run) => run.id === fixture.readToolRunId)
        ?.status,
    ).toBe("queued");
    expect(
      after.planSteps.find((step) => step.id === fixture.planStepId)
        ?.status,
    ).toBe("queued");
    expect(
      after.executionPlans.find(
        (plan) => plan.id === fixture.executionPlanId,
      )?.status,
    ).toBe("active");
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  });
});

function transitionAttempt(
  fixture: RecoveryEvidenceUowFixture,
  attemptId: string,
  status: RecoveryEvidenceTransitionTarget,
  options: {
    readonly reasonCode?: string;
    readonly transitionOperationId?: string;
    readonly expectedTaskVersion?: number;
    readonly expectedAttemptVersion?: number;
  } = {},
) {
  const snapshot = snapshotOf(fixture);
  const attempt = snapshot.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.id === attemptId,
  );
  if (attempt === undefined) {
    throw new Error("Expected recovery evidence read attempt.");
  }
  return transitionInImmediate(fixture, {
    ownership: fixture.ownership,
    expectedTaskVersion:
      options.expectedTaskVersion ?? snapshot.task.version,
    attemptId,
    expectedAttemptVersion:
      options.expectedAttemptVersion ?? attempt.version,
    status,
    ...(options.transitionOperationId === undefined
      ? {}
      : { transitionOperationId: options.transitionOperationId }),
    observedAt: null,
    resourceVersion: null,
    resourceEtag: null,
    resultDigest: null,
    resultPayloadStoreRef: null,
    reasonCode:
      options.reasonCode ??
      (status === "dispatching"
        ? null
        : `STATE_${status.toUpperCase()}`),
  });
}

function transitionInImmediate(
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
      expectedTaskVersion: snapshotOf(fixture).task.version,
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

function snapshotOf(fixture: RecoveryEvidenceUowFixture) {
  return new TaskSnapshotReader(fixture.database).load(fixture.taskId);
}

function openFixture(
  suffix: string,
  options: { readonly allowlistVersion?: string } = {},
): RecoveryEvidenceUowFixture {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  return createRecoveryEvidenceUowFixture(database, suffix, {
    ...options,
    allowlistVersion:
      options.allowlistVersion ?? "a".repeat(64),
  });
}

function requestInput(
  fixture: RecoveryEvidenceUowFixture,
  suffix: string,
) {
  return requestInputForResource(
    fixture,
    {
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      executionPlanId: fixture.executionPlanId,
      planStepId: fixture.planStepId,
      readToolRunId: fixture.readToolRunId,
      verificationCheckId: fixture.verificationCheckId,
      expectedTaskVersion: fixture.expectedTaskVersion,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
    },
    suffix,
  );
}

interface EvidenceVariantResource {
  readonly evidenceSubmissionId: string;
  readonly executionPlanId: string;
  readonly planStepId: string;
  readonly readToolRunId: string;
  readonly verificationCheckId: string;
  readonly expectedTaskVersion: number;
  readonly expectedDecisionVersion: number;
}

function requestInputForResource(
  fixture: RecoveryEvidenceUowFixture,
  resource: EvidenceVariantResource,
  suffix: string,
) {
  const actorId = "reviewer-host";
  const operationPayloadDigest =
    computeRecoveryEvidenceReadbackOperationPayloadDigest({
      evidenceSubmissionId: resource.evidenceSubmissionId,
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
      verificationCheckId: resource.verificationCheckId,
      expectedDecisionVersion: resource.expectedDecisionVersion,
    });
  const requestKey = computeRecoveryReviewOperationRequestKey({
    reviewId: fixture.reviewId,
    expectedDecisionVersion: resource.expectedDecisionVersion,
    operation: "request_readback",
    operationPayloadDigest,
    actorId,
  });
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: resource.expectedTaskVersion,
    requestId: `readback-request-${suffix}`,
    operationId: `readback-operation-${suffix}`,
    readAttemptId: `read-attempt-${suffix}`,
    reviewId: fixture.reviewId,
    evidenceSubmissionId: resource.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    expectedDecisionVersion: resource.expectedDecisionVersion,
    actorId,
    operationPayloadDigest,
    requestKey,
    executionPlanId: resource.executionPlanId,
    planStepId: resource.planStepId,
    readToolRunId: resource.readToolRunId,
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
    verificationCheckId: resource.verificationCheckId,
  };
}

function addEvidenceVariant(
  fixture: RecoveryEvidenceUowFixture,
  suffix: string,
  character: string,
): EvidenceVariantResource {
  const submissionId = `submission-${suffix}`;
  const executionPlanId = `plan-${suffix}`;
  const planStepId = `step-${suffix}`;
  const readToolRunId = `read-run-${suffix}`;
  const verificationCheckId = `check-${suffix}`;
  const envelopeDigest = digest(character);
  const operationKey = digest(nextCharacter(character, 1));
  const payloadDigest = computeCanonicalInputHash(
    `payload-${suffix}`,
  );
  const requestOperationId = `submit-operation-${suffix}`;
  const now = "2026-11-08T00:02:00.000Z";

  let expectedDecisionVersion = 0;
  runInTransaction(
    fixture.database,
    () => {
      const permit = createStorageWritePermit(fixture.database);
      const reviews = new RecoveryReviewRepository(fixture.database);
      const review = reviews.get(fixture.reviewId);
      expectedDecisionVersion = review.decisionVersion + 1;
      const event = new EventRepository(
        fixture.database,
        new SequenceAllocator(fixture.database),
      ).append(
        {
          taskId: fixture.taskId,
          traceId: `trace-${fixture.taskId}`,
          type: "recovery.evidence.submitted",
          entityType: "recovery_review",
          entityId: fixture.reviewId,
          payload: {
            evidenceSubmissionId: submissionId,
            evidenceRef: `evidence://${submissionId}`,
            envelopeDigest,
          },
        },
        now,
        permit,
      );
      const operation = new RecoveryReviewOperationRepository(
        fixture.database,
      ).append(
        {
          id: requestOperationId,
          taskId: fixture.taskId,
          reviewId: fixture.reviewId,
          requestKey: operationKey,
          operation: "submit_evidence",
          expectedDecisionVersion: expectedDecisionVersion - 1,
          resultingDecisionVersion: expectedDecisionVersion,
          status: "applied",
          actorId: "host_verifier",
          operationPayloadDigest: envelopeDigest,
          evidenceEnvelopeDigest: envelopeDigest,
          resultPlanId: null,
          resultToolRunId: null,
          appliedEventId: event.id,
          createdAt: now,
        },
        permit,
      );
      new RecoveryEvidenceSubmissionRepository(fixture.database).insert(
        {
          id: submissionId,
          taskId: fixture.taskId,
          reviewId: fixture.reviewId,
          toolRunId: fixture.originalToolRunId,
          operationId: operation.id,
          requestKey: operationKey,
          decisionVersion: expectedDecisionVersion,
          sourceType: "system_verification",
          outcome: "observed_succeeded",
          evidenceRef: `evidence://${submissionId}`,
          resourceRef: "inventory://part/STM32",
          resourceVersion: "7",
          sourceObservedAt: now,
          submittedAt: now,
          actorId: null,
          verifierId: "host_verifier",
          verificationId: `verification-${suffix}`,
          payloadType: "json",
          payloadDigestProtocol: "jcs-sha256-v1",
          payloadDigest,
          envelopeDigest,
          payloadStoreRef: `evidence-file:sha256/${payloadDigest.slice(7)}`,
          payloadStorageMode: "content_addressed_file",
          appliedEventId: event.id,
          createdAt: now,
        },
        permit,
      );
      fixture.database
        .prepare(
          `
            UPDATE recovery_reviews
            SET decision_version = ?, updated_at = ?
            WHERE id = ? AND task_id = ?
          `,
        )
        .run(
          expectedDecisionVersion,
          now,
          fixture.reviewId,
          fixture.taskId,
        );

      const planVersion = (
        fixture.database
          .prepare(
            `
              SELECT COALESCE(MAX(version), 0) + 1 AS version
              FROM execution_plans
              WHERE task_id = ?
            `,
          )
          .get(fixture.taskId) as { version: number }
      ).version;
      new ExecutionPlanRepository(fixture.database).insert(
        {
          id: executionPlanId,
          taskId: fixture.taskId,
          version: planVersion,
          sourceModelCallId: fixture.modelCallId,
          purpose: "recovery_evidence",
          status: "active",
          createdAt: now,
        },
        permit,
      );
      new PlanStepRepository(fixture.database).insert(
        {
          id: planStepId,
          taskId: fixture.taskId,
          planId: executionPlanId,
          stepIndex: 0,
          kind: "read_batch",
          status: "queued",
          createdAt: now,
        },
        permit,
      );
      new ToolRunRepository(fixture.database).createIntent(
        {
          id: readToolRunId,
          taskId: fixture.taskId,
          planStepId,
          toolCallId: `call-${suffix}`,
          originalIndex: 0,
          toolName: "inventory_lookup",
          toolVersion: "1",
          inputSchemaHash: digest("3"),
          canonicalInputHash: digest("4"),
          mode: "read",
          requiresApproval: false,
          status: "queued",
          input: { resourceRef: "inventory://part/STM32" },
          idempotencyKey: computeCanonicalInputHash(
            `read-${suffix}`,
          ),
          attemptNo: 1,
          createdAt: now,
        },
        permit,
      );
    },
    "immediate",
  );

  const snapshot = new TaskSnapshotReader(fixture.database).load(
    fixture.taskId,
  );
  return {
    evidenceSubmissionId: submissionId,
    executionPlanId,
    planStepId,
    readToolRunId,
    verificationCheckId,
    expectedTaskVersion: snapshot.task.version,
    expectedDecisionVersion,
  };
}

function dispatchAttempt(
  fixture: RecoveryEvidenceUowFixture,
  attemptId: string,
) {
  const snapshot = new TaskSnapshotReader(fixture.database).load(
    fixture.taskId,
  );
  const attempt = new RecoveryEvidenceReadAttemptRepository(
    fixture.database,
  ).get(attemptId);
  return transitionInImmediate(fixture, {
    ownership: fixture.ownership,
    expectedTaskVersion: snapshot.task.version,
    attemptId,
    expectedAttemptVersion: attempt.version,
    status: "dispatching",
    observedAt: null,
    resourceVersion: null,
    resourceEtag: null,
    resultDigest: null,
    resultPayloadStoreRef: null,
    reasonCode: null,
  });
}

function cancelOwnedInput(
  fixture: RecoveryEvidenceUowFixture,
  requestId: string,
  attemptId: string,
  cancelIntentEventId: string,
  options: {
    readonly expectedTaskVersion?: number;
    readonly expectedAttemptVersion?: number;
  } = {},
) {
  const snapshot = new TaskSnapshotReader(fixture.database).load(
    fixture.taskId,
  );
  const request = snapshot.recoveryEvidenceReadbackRequests.find(
    (candidate) => candidate.id === requestId,
  );
  const attempt = snapshot.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.id === attemptId,
  );
  const run = snapshot.toolRuns.find(
    (candidate) => candidate.id === request?.readToolRunId,
  );
  const step = snapshot.planSteps.find(
    (candidate) => candidate.id === request?.planStepId,
  );
  const plan = snapshot.executionPlans.find(
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
    expectedTaskVersion:
      options.expectedTaskVersion ?? snapshot.task.version,
    requestId,
    attemptId,
    cancelIntentEventId,
    expectedAttemptVersion:
      options.expectedAttemptVersion ?? attempt.version,
    expectedPlanVersion: plan.version,
    expectedPlanStepVersion: step.version,
    expectedToolRunVersion: run.version,
    reasonCode: "CANCEL_REQUESTED" as const,
  };
}

function completeReadInput(
  fixture: RecoveryEvidenceUowFixture,
  readbackRequestId: string,
  attemptId: string,
  checkRecordId: string,
  evidenceReadId: string,
) {
  const snapshot = new TaskSnapshotReader(fixture.database).load(
    fixture.taskId,
  );
  const run = new ToolRunRepository(fixture.database).get(
    fixture.readToolRunId,
  );
  const step = new PlanStepRepository(fixture.database).get(
    fixture.planStepId,
  );
  const attempt = new RecoveryEvidenceReadAttemptRepository(
    fixture.database,
  ).get(attemptId);
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: snapshot.task.version,
    readbackRequestId,
    checkRecordId,
    evidenceReadId,
    attemptId,
    expectedAttemptVersion: attempt.version,
    expectedReadToolRunVersion: run.version,
    expectedPlanStepVersion: step.version,
    toolOutput: { status: "ok" },
    toolMessageContent: JSON.stringify({ status: "ok" }),
    verificationRequestKey: digest("9"),
    observedAt: "2026-11-08T00:01:00.000Z",
    resourceVersion: "7",
    resourceEtag: "etag-7",
    resultPayloadDigest: digest("8"),
    resultPayloadStoreRef: `evidence-file:sha256/${"8".repeat(64)}`,
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function v0CheckRequestKey(
  fixture: RecoveryEvidenceUowFixture,
  verificationCheckId: string,
): string {
  return computeRecoveryEvidenceVerificationRequestKey({
    taskId: fixture.taskId,
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    verificationCheckId,
    checkOrigin: "stored_evidence_v0",
    verifierId: "host_verifier",
    verifierVersion: "1",
    verifierConfigDigest: digest("6"),
    allowlistId: null,
    allowlistVersion: null,
    readToolName: null,
    readToolVersion: null,
    readToolSchemaHash: null,
    expectedPayloadDigest: digest("c"),
  });
}

function nextCharacter(character: string, offset: number): string {
  return String.fromCharCode(character.charCodeAt(0) + offset);
}

interface AttemptWorkerResult {
  readonly attemptNumber: number;
}

function startAttemptWorker(
  fixture: RecoveryEvidenceUowFixture,
  readbackRequestId: string,
  attemptId: string,
): Promise<ChildProcess> {
  if (temporaryDatabase === undefined) {
    throw new Error("Temporary database is unavailable.");
  }
  const worker = fork(
    attemptWorkerPath,
    [
      JSON.stringify({
        databasePath: temporaryDatabase.path,
        taskId: fixture.taskId,
        readbackRequestId,
        attemptId,
        leaseToken: fixture.ownership.leaseToken,
        fencingToken: fixture.ownership.fencingToken,
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
      reject(new Error(`Attempt worker readiness timed out.\n${stderr}`));
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
          `Attempt worker exited before readiness (${String(code)}).\n${stderr}`,
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

function runAttemptWorker(
  worker: ChildProcess,
): Promise<AttemptWorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Attempt worker timed out."));
    }, WORKER_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
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
              : "ATTEMPT_WORKER_FAILED",
          ),
        );
        return;
      }
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete" &&
        "attemptNumber" in message &&
        typeof message.attemptNumber === "number"
      ) {
        cleanup();
        resolve({ attemptNumber: message.attemptNumber });
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
