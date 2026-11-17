import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  RecoveryEvidenceReadbackReservationRepository,
  RecoveryEvidenceReadbackReservationUnitOfWork,
  TaskSnapshotReader,
  closeDatabase,
  computeRecoveryEvidenceReadbackRequestIntentDigest,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import {
  canonicalRecoveryEvidenceReadbackRequestIntent,
} from "../../src/storage/recovery-evidence-readback-reservation-keys.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";
import {
  createRecoveryEvidenceUowFixture,
  type RecoveryEvidenceUowFixture,
} from "./recovery-evidence-uow-fixture.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
const workers: ChildProcess[] = [];
const workerPath = fileURLToPath(
  new URL("./recovery-evidence-reservation-worker.ts", import.meta.url),
);
const now = "2026-11-08T00:00:00.000Z";

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.connected) {
      worker.disconnect();
    }
    if (!worker.killed) {
      worker.kill();
    }
  }
  vi.restoreAllMocks();
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("RecoveryEvidenceReadbackReservationUnitOfWork", () => {
  it("creates one stable reservation and returns in_progress to the same owner", () => {
    const fixture = openFixture("reservation-stable");
    const unitOfWork = createUnitOfWork(fixture);
    const beforeEvents = fixtureEvents(fixture);
    const input = acquireInput(fixture, "stable");

    const first = unitOfWork.acquireOwned(input);
    const second = unitOfWork.acquireOwned({
      ...input,
      requestId: "different-request-id",
      operationId: "different-operation-id",
      executionPlanId: "different-plan-id",
      planStepId: "different-step-id",
      readToolRunId: "different-run-id",
      readAttemptId: "different-attempt-id",
    });
    const reentered = unitOfWork.acquireOwned({
      ...input,
      ownerToken: first.ownerToken as string,
    });

    expect(first).toMatchObject({
      state: "acquired",
      reservation: {
        status: "preparing",
        reservationVersion: 1,
        ownerFencingToken: fixture.ownership.fencingToken,
        requestId: input.requestId,
      },
    });
    expect(first.ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toMatchObject({
      state: "in_progress",
      ownerToken: null,
      reservation: {
        id: first.reservation?.id,
        requestId: input.requestId,
        operationId: input.operationId,
        executionPlanId: input.executionPlanId,
        planStepId: input.planStepId,
        readToolRunId: input.readToolRunId,
        readAttemptId: input.readAttemptId,
        reservationVersion: 1,
      },
    });
    expect(JSON.stringify(second)).not.toContain(
      first.ownerToken as string,
    );
    expect(reentered).toMatchObject({
      state: "reentered",
      ownerToken: first.ownerToken,
      reservation: {
        id: first.reservation?.id,
        requestId: input.requestId,
      },
    });
    expect(() =>
      unitOfWork.acquireOwned({
        ...input,
        requestIntent: {
          ...input.requestIntent,
          allowlistId: "different_allowlist",
        },
      }),
    ).toThrow(
      /RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT|Request Intent/,
    );
    expect(() =>
      unitOfWork.acquireOwned({
        ...input,
        requestIntent: {
          ...input.requestIntent,
          expectedDecisionVersion: 99,
        },
      }),
    ).toThrow(
      /RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT|Request Intent/,
    );
    expect(() =>
      unitOfWork.acquireOwned({
        ...input,
        requestIntent: {
          ...input.requestIntent,
          expectedResourceVersion: "8",
          expectedEtag: "etag-8",
        },
      }),
    ).toThrow(
      /RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT|Request Intent/,
    );
    expect(
      fixture.database
        .prepare(
          "SELECT COUNT(*) AS count FROM recovery_evidence_readback_request_reservations",
        )
        .get(),
    ).toEqual({ count: 1 });
    expect(fixtureEvents(fixture)).toBe(beforeEvents);
  });

  it("takes over stale preparing ownership with fencing and version CAS", () => {
    const fixture = openFixture("reservation-takeover");
    const oldUnitOfWork = createUnitOfWork(fixture);
    const input = acquireInput(fixture, "takeover");
    const first = oldUnitOfWork.acquireOwned(input);
    const originalReservation = first.reservation;
    if (originalReservation === null) {
      throw new Error("Expected reservation.");
    }

    fixture.leaseManager.release(
      fixture.taskId,
      fixture.ownership.leaseToken,
      fixture.ownership.fencingToken,
    );
    const replacementLease = fixture.leaseManager.claim(
      fixture.taskId,
      "replacement-worker",
    );
    if (replacementLease.leaseToken === null) {
      throw new Error("Expected replacement lease token.");
    }
    const replacementOwnership = {
      taskId: fixture.taskId,
      leaseToken: replacementLease.leaseToken,
      fencingToken: replacementLease.fencingToken,
    };
    const newUnitOfWork = createUnitOfWork(fixture);
    const takeover = newUnitOfWork.acquireOwned({
      ...input,
      ownership: replacementOwnership,
      requestId: "candidate-request-after-takeover",
      operationId: "candidate-operation-after-takeover",
      executionPlanId: "candidate-plan-after-takeover",
      planStepId: "candidate-step-after-takeover",
      readToolRunId: "candidate-run-after-takeover",
      readAttemptId: "candidate-attempt-after-takeover",
    });

    expect(takeover).toMatchObject({
      state: "acquired",
      reservation: {
        id: originalReservation.id,
        requestId: originalReservation.requestId,
        operationId: originalReservation.operationId,
        executionPlanId: originalReservation.executionPlanId,
        planStepId: originalReservation.planStepId,
        readToolRunId: originalReservation.readToolRunId,
        readAttemptId: originalReservation.readAttemptId,
        status: "preparing",
        reservationVersion: 2,
        ownerFencingToken: replacementLease.fencingToken,
      },
    });
    expect(takeover.ownerToken).not.toBe(first.ownerToken);

    expect(() =>
      runInTransaction(
        fixture.database,
        () => {
          const permit = createStorageWritePermit(fixture.database);
          new RecoveryEvidenceReadbackReservationRepository(
            fixture.database,
          ).abandon(
            {
              id: originalReservation.id,
              expectedReservationVersion: 2,
              ownerToken: first.ownerToken as string,
              ownerFencingToken:
                originalReservation.ownerFencingToken,
              updatedAt: "2026-11-08T00:00:01.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrow(/reservation changed/i);
    expect(() =>
      runInTransaction(
        fixture.database,
        () => {
          const permit = createStorageWritePermit(fixture.database);
          new RecoveryEvidenceReadbackReservationRepository(
            fixture.database,
          ).complete(
            {
              id: originalReservation.id,
              expectedReservationVersion: 2,
              ownerToken: first.ownerToken as string,
              ownerFencingToken:
                originalReservation.ownerFencingToken,
              updatedAt: "2026-11-08T00:00:01.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrow(/reservation changed/i);
  });

  it("abandons and reclaims a reservation with a new owner token", () => {
    const fixture = openFixture("reservation-abandon");
    const unitOfWork = createUnitOfWork(fixture);
    const input = acquireInput(fixture, "abandon");
    const first = unitOfWork.acquireOwned(input);
    if (first.reservation === null) {
      throw new Error("Expected reservation.");
    }
    const abandoned = unitOfWork.abandonOwned({
      ownership: fixture.ownership,
      reservationId: first.reservation.id,
      expectedReservationVersion: first.reservation.reservationVersion,
      ownerToken: first.ownerToken as string,
      requestIntent: input.requestIntent,
    });
    expect(abandoned).toMatchObject({
      status: "abandoned",
      reservationVersion: 2,
    });
    expect(() =>
      unitOfWork.acquireOwned({
        ...input,
        requestIntent: {
          ...input.requestIntent,
          allowlistId: "different_allowlist",
        },
      }),
    ).toThrow(
      /RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT|Request Intent/,
    );

    fixture.leaseManager.release(
      fixture.taskId,
      fixture.ownership.leaseToken,
      fixture.ownership.fencingToken,
    );
    const replacementLease = fixture.leaseManager.claim(
      fixture.taskId,
      "abandon-reclaimer",
    );
    if (replacementLease.leaseToken === null) {
      throw new Error("Expected replacement lease token.");
    }
    const reclaimed = createUnitOfWork(fixture).acquireOwned({
      ...input,
      ownership: {
        taskId: fixture.taskId,
        leaseToken: replacementLease.leaseToken,
        fencingToken: replacementLease.fencingToken,
      },
    });

    expect(reclaimed).toMatchObject({
      state: "acquired",
      reservation: {
        id: abandoned.id,
        status: "preparing",
        reservationVersion: 3,
        ownerFencingToken: replacementLease.fencingToken,
      },
    });
    expect(reclaimed.ownerToken).not.toBe(first.ownerToken);
  });

  it("rejects takeover and abandon when reservation_version CAS is stale", () => {
    const fixture = openFixture("reservation-cas");
    const unitOfWork = createUnitOfWork(fixture);
    const acquired = unitOfWork.acquireOwned(
      acquireInput(fixture, "cas"),
    );
    const reservation = acquired.reservation;
    if (reservation === null) {
      throw new Error("Expected reservation.");
    }

    expect(() =>
      runInTransaction(
        fixture.database,
        () => {
          const permit = createStorageWritePermit(fixture.database);
          new RecoveryEvidenceReadbackReservationRepository(
            fixture.database,
          ).takeover(
            {
              id: reservation.id,
              expectedReservationVersion: 99,
              previousOwnerFencingToken:
                reservation.ownerFencingToken,
              newOwnerToken: "a".repeat(64),
              newOwnerFencingToken:
                reservation.ownerFencingToken + 1,
              updatedAt: "2026-11-08T00:00:01.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrow(/reservation changed/i);
    expect(() =>
      unitOfWork.abandonOwned({
        ownership: fixture.ownership,
        reservationId: reservation.id,
        expectedReservationVersion:
          reservation.reservationVersion + 1,
        ownerToken: acquired.ownerToken as string,
        requestIntent: acquireInput(fixture, "cas").requestIntent,
      }),
    ).toThrow(/reservation changed/i);
  });

  it("completes only with matching Transaction A artifacts in the same transaction", () => {
    const fixture = openFixture("reservation-complete");
    const unitOfWork = createUnitOfWork(fixture);
    const completion = completionReservationInput(fixture);
    const acquired = unitOfWork.acquireOwned(completion.acquire);
    if (acquired.reservation === null) {
      throw new Error("Expected reservation.");
    }

    expect(() =>
      unitOfWork.completeOwned(
        {
          ownership: fixture.ownership,
          reservationId: acquired.reservation?.id as string,
          expectedReservationVersion:
            acquired.reservation?.reservationVersion as number,
          ownerToken: acquired.ownerToken as string,
          requestIntent: completion.acquire.requestIntent,
        },
        () => undefined,
      ),
    ).toThrow(/does not match|Transaction A|inconsistent/i);
    expect(
      new RecoveryEvidenceReadbackReservationRepository(
        fixture.database,
      ).getById(acquired.reservation.id).status,
    ).toBe("preparing");

    const completed = unitOfWork.completeOwned(
      {
        ownership: fixture.ownership,
        reservationId: acquired.reservation.id,
        expectedReservationVersion:
          acquired.reservation.reservationVersion,
        ownerToken: acquired.ownerToken as string,
        requestIntent: completion.acquire.requestIntent,
      },
      () => {
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
          completion.request,
        );
      },
    );

    expect(completed).toMatchObject({
      status: "completed",
      reservationVersion: 2,
    });
    const replay = unitOfWork.acquireOwned(completion.acquire);
    expect(replay).toMatchObject({
      state: "completed",
      ownerToken: null,
      reservation: { id: completed.id },
      request: {
        id: completion.acquire.requestId,
        operationId: completion.acquire.operationId,
      },
    });
    expect(() =>
      unitOfWork.acquireOwned({
        ...completion.acquire,
        requestIntent: {
          ...completion.acquire.requestIntent,
          allowlistId: "different_allowlist",
        },
      }),
    ).toThrow(
      /RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT|Request Intent/,
    );
    expect(() =>
      fixture.database
        .prepare(
          "UPDATE recovery_evidence_readback_request_reservations SET owner_token = ? WHERE id = ?",
        )
        .run("f".repeat(64), completed.id),
    ).toThrow(/transition is invalid/i);
    expect(() =>
      fixture.database
        .prepare(
          "DELETE FROM recovery_evidence_readback_request_reservations WHERE id = ?",
        )
        .run(completed.id),
    ).toThrow(/retained/i);
  });

  it("rejects cross-task identities without partial Reservation writes", () => {
    const first = openFixture("reservation-cross-a");
    const second = createRecoveryEvidenceUowFixture(
      first.database,
      "reservation-cross-b",
    );
    const unitOfWork = createUnitOfWork(first);
    const before = countReservations(first.database);

    expect(() =>
      unitOfWork.acquireOwned(
        acquireInput(first, "cross-task", {
          evidenceSubmissionId: second.evidenceSubmissionId,
          originalToolRunId: second.originalToolRunId,
        }),
      ),
    ).toThrow();
    expect(countReservations(first.database)).toBe(before);
  });

  it("replays historical Requests only when the verifiable intent matches", () => {
    const fixture = openFixture("reservation-historical-replay");
    const historical = completionReservationInput(fixture);
    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        historical.request,
      );
    const unitOfWork = createUnitOfWork(fixture);
    const replay = unitOfWork.acquireOwned(historical.acquire);

    expect(replay).toMatchObject({
      state: "historical_request",
      ownerToken: null,
      reservation: null,
      request: {
        id: created.request.id,
        verificationCheckId:
          historical.acquire.requestIntent.verificationCheckId,
        allowlistId:
          historical.acquire.requestIntent.allowlistId,
        expectedResourceVersion: "7",
        expectedEtag: "etag-7",
      },
    });
    for (const requestIntent of [
      {
        ...historical.acquire.requestIntent,
        allowlistId: "different_allowlist",
      },
      {
        ...historical.acquire.requestIntent,
        expectedDecisionVersion: 99,
      },
      {
        ...historical.acquire.requestIntent,
        expectedResourceVersion: "8",
      },
      {
        ...historical.acquire.requestIntent,
        expectedEtag: "etag-8",
      },
      {
        ...historical.acquire.requestIntent,
        verificationCheckId: "different-check-intent",
      },
    ]) {
      expect(() =>
        unitOfWork.acquireOwned({
          ...historical.acquire,
          requestIntent,
        }),
      ).toThrow(
        /RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT|Request Intent/,
      );
    }
  });

  it("keeps request intent digest stable and sensitive to business intent", () => {
    const fixture = openFixture("reservation-intent");
    const intent = acquireInput(fixture, "intent").requestIntent;
    const full = {
      taskId: fixture.taskId,
      ...intent,
    };
    expect(
      computeRecoveryEvidenceReadbackRequestIntentDigest(full),
    ).toBe(
      computeRecoveryEvidenceReadbackRequestIntentDigest({
        expectedEtag: full.expectedEtag,
        expectedResourceVersion: full.expectedResourceVersion,
        expectedDecisionVersion: full.expectedDecisionVersion,
        verificationCheckId: full.verificationCheckId,
        allowlistId: full.allowlistId,
        originalToolRunId: full.originalToolRunId,
        evidenceSubmissionId: full.evidenceSubmissionId,
        reviewId: full.reviewId,
        taskId: full.taskId,
      }),
    );
    expect(
      canonicalRecoveryEvidenceReadbackRequestIntent(full),
    ).toContain(
      '"forgeflow.recovery-evidence-readback-request-intent.v1"',
    );
    expect(
      canonicalRecoveryEvidenceReadbackRequestIntent(full),
    ).toContain(`"taskId":"${fixture.taskId}"`);
    expect(() =>
      computeRecoveryEvidenceReadbackRequestIntentDigest({
        ...full,
        taskId: "",
      }),
    ).toThrow();
    expect(
      computeRecoveryEvidenceReadbackRequestIntentDigest({
        ...full,
        taskId: "different-task",
      }),
    ).not.toBe(
      computeRecoveryEvidenceReadbackRequestIntentDigest(full),
    );
    expect(
      computeRecoveryEvidenceReadbackRequestIntentDigest({
        ...full,
        expectedResourceVersion: "8",
      }),
    ).not.toBe(
      computeRecoveryEvidenceReadbackRequestIntentDigest(full),
    );
  });

  it("allows only one of two concurrent connections to become reservation owner", async () => {
    const fixture = openFixture("reservation-concurrent");
    const base = acquireInput(fixture, "concurrent");
    const config = {
      databasePath: temporaryDatabase?.path as string,
      now,
      ownership: fixture.ownership,
      expectedTaskVersion: base.expectedTaskVersion,
      requestIntent: base.requestIntent,
      executionPlanId: base.executionPlanId,
      planStepId: base.planStepId,
      readToolRunId: base.readToolRunId,
      requestId: "worker-request-a",
      operationId: "worker-operation-a",
      readAttemptId: "worker-attempt-a",
    };
    const first = await startWorker(config);
    const second = await startWorker({
      ...config,
      requestId: "worker-request-b",
      operationId: "worker-operation-b",
      readAttemptId: "worker-attempt-b",
    });
    const results = await Promise.all([
      runWorker(first),
      runWorker(second),
    ]);

    expect(
      results.map((result) => result.state).sort(),
    ).toEqual(["acquired", "in_progress"]);
    expect(
      results.filter((result) => result.state === "acquired"),
    ).toHaveLength(1);
    expect(countReservations(fixture.database)).toBe(1);
    expect(
      new Set(results.map((result) => result.reservationId)).size,
    ).toBe(1);
  });
});

function openFixture(suffix: string): RecoveryEvidenceUowFixture {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  return createRecoveryEvidenceUowFixture(database, suffix);
}

function createUnitOfWork(
  fixture: RecoveryEvidenceUowFixture,
): RecoveryEvidenceReadbackReservationUnitOfWork {
  return new RecoveryEvidenceReadbackReservationUnitOfWork(
    fixture.database,
    () => fixture.authority.assertActive(),
    fixture.leaseManager,
    { now: () => new Date(now) },
  );
}

function acquireInput(
  fixture: RecoveryEvidenceUowFixture,
  suffix: string,
  overrides: {
    readonly evidenceSubmissionId?: string;
    readonly originalToolRunId?: string;
  } = {},
) {
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: new TaskSnapshotReader(
      fixture.database,
    ).load(fixture.taskId).task.version,
    requestIntent: {
      reviewId: fixture.reviewId,
      evidenceSubmissionId:
        overrides.evidenceSubmissionId ??
        fixture.evidenceSubmissionId,
      originalToolRunId:
        overrides.originalToolRunId ?? fixture.originalToolRunId,
      allowlistId: "inventory_readback",
      verificationCheckId: `reservation-check-${suffix}`,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
    },
    requestId: `reservation-request-${suffix}`,
    operationId: `reservation-operation-${suffix}`,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    readAttemptId: `reservation-attempt-${suffix}`,
  };
}

function completionReservationInput(
  fixture: RecoveryEvidenceUowFixture,
) {
  const ids = {
    requestId: "completion-request",
    operationId: "completion-operation",
    readAttemptId: "completion-attempt",
    verificationCheckId: "completion-check",
  };
  const acquire = {
    ...acquireInput(fixture, "completion"),
    requestId: ids.requestId,
    operationId: ids.operationId,
    readAttemptId: ids.readAttemptId,
    requestIntent: {
      ...acquireInput(fixture, "completion").requestIntent,
      verificationCheckId: ids.verificationCheckId,
    },
  };
  const actorId = "reviewer-host";
  const operationPayloadDigest =
    computeRecoveryEvidenceReadbackOperationPayloadDigest({
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalUnknownToolRunId: fixture.originalToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("7"),
      allowlistId: "inventory_readback",
      allowlistVersion: "1",
      readToolName: "inventory_lookup",
      readToolVersion: "1",
      readToolSchemaHash: digest("3"),
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
      verificationCheckId: ids.verificationCheckId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
    });
  return {
    acquire,
    request: {
      ownership: fixture.ownership,
      expectedTaskVersion: new TaskSnapshotReader(
        fixture.database,
      ).load(fixture.taskId).task.version,
      ...ids,
      reviewId: fixture.reviewId,
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalToolRunId: fixture.originalToolRunId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
      actorId,
      operationPayloadDigest,
      requestKey: computeRecoveryReviewOperationRequestKey({
        reviewId: fixture.reviewId,
        expectedDecisionVersion: fixture.expectedDecisionVersion,
        operation: "request_readback",
        operationPayloadDigest,
        actorId,
      }),
      executionPlanId: fixture.executionPlanId,
      planStepId: fixture.planStepId,
      readToolRunId: fixture.readToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("7"),
      allowlistId: "inventory_readback",
      allowlistVersion: "1",
      readToolName: "inventory_lookup",
      readToolVersion: "1",
      readToolSchemaHash: digest("3"),
      retrySafety: "version_conditional" as const,
      consistencyMode: "etag_or_resource_version" as const,
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
    },
  };
}

function countReservations(activeDatabase: ForgeFlowDatabase): number {
  return (
    activeDatabase
      .prepare(
        "SELECT COUNT(*) AS count FROM recovery_evidence_readback_request_reservations",
      )
      .get() as { count: number }
  ).count;
}

function fixtureEvents(fixture: RecoveryEvidenceUowFixture): number {
  return (
    fixture.database
      .prepare(
        "SELECT COUNT(*) AS count FROM events WHERE task_id = ?",
      )
      .get(fixture.taskId) as { count: number }
  ).count;
}

interface WorkerResult {
  readonly type: "result";
  readonly state: "acquired" | "in_progress" | "completed" | "error";
  readonly reservationId: string | null;
  readonly ownerTokenPresent: boolean;
  readonly code?: string;
}

async function startWorker(config: {
  readonly databasePath: string;
  readonly now: string;
  readonly ownership: RecoveryEvidenceUowFixture["ownership"];
  readonly expectedTaskVersion: number;
  readonly requestIntent: ReturnType<typeof acquireInput>["requestIntent"];
  readonly requestId: string;
  readonly operationId: string;
  readonly executionPlanId: string;
  readonly planStepId: string;
  readonly readToolRunId: string;
  readonly readAttemptId: string;
}): Promise<ChildProcess> {
  const worker = fork(workerPath, [JSON.stringify(config)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workers.push(worker);

  return new Promise((resolve, reject) => {
    let stderr = "";
    worker.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timeout = setTimeout(() => {
      reject(
        new Error(
          `Reservation worker did not start.\n${stderr}`,
        ),
      );
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
      ) {
        clearTimeout(timeout);
        worker.off("message", onMessage);
        resolve(worker);
      }
    };
    worker.on("message", onMessage);
  });
}

function runWorker(worker: ChildProcess): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error("Reservation worker timed out."));
    }, 15_000);
    worker.on("message", (message: unknown) => {
      clearTimeout(timeout);
      resolve(message as WorkerResult);
    });
    worker.on("exit", (code) => {
      clearTimeout(timeout);
      reject(
        new Error(
          `Reservation worker exited early (${String(code)}).`,
        ),
      );
    });
    worker.send({ type: "run" });
  });
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
