import { z } from "zod";

import { ExecutionAuthority } from "../../src/persistence/index.js";
import {
  RecoveryEvidenceReadbackReservationUnitOfWork,
  TaskLeaseManager,
  closeDatabase,
  openDatabase,
} from "../../src/storage/index.js";

const ConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    now: z.string().min(1),
    ownership: z
      .object({
        taskId: z.string().min(1),
        leaseToken: z.string().min(1),
        fencingToken: z.number().int().positive(),
      })
      .strict(),
    expectedTaskVersion: z.number().int().positive(),
    requestIntent: z
      .object({
        reviewId: z.string().min(1),
        evidenceSubmissionId: z.string().min(1),
        originalToolRunId: z.string().min(1),
        allowlistId: z.string().min(1),
        verificationCheckId: z.string().min(1),
        expectedDecisionVersion: z.number().int().nonnegative(),
        expectedResourceVersion: z.string().min(1).nullable(),
        expectedEtag: z.string().min(1).nullable(),
      })
      .strict(),
    requestId: z.string().min(1),
    operationId: z.string().min(1),
    executionPlanId: z.string().min(1),
    planStepId: z.string().min(1),
    readToolRunId: z.string().min(1),
    readAttemptId: z.string().min(1),
  })
  .strict();

const config = ConfigSchema.parse(
  JSON.parse(process.argv[2] as string),
);
const database = openDatabase(config.databasePath);
const authority = new ExecutionAuthority();
const leaseManager = new TaskLeaseManager(database, {
  now: () => new Date(config.now),
});
const unitOfWork =
  new RecoveryEvidenceReadbackReservationUnitOfWork(
    database,
    () => authority.assertActive(),
    leaseManager,
    {
      now: () => new Date(config.now),
    },
  );

if (process.send === undefined) {
  throw new Error("Reservation worker requires IPC.");
}

process.once("message", (message: unknown) => {
  if (
    typeof message !== "object" ||
    message === null ||
    !("type" in message) ||
    message.type !== "run"
  ) {
    return;
  }
  try {
    const result = unitOfWork.acquireOwned({
      ownership: config.ownership,
      expectedTaskVersion: config.expectedTaskVersion,
      requestIntent: config.requestIntent,
      requestId: config.requestId,
      operationId: config.operationId,
      executionPlanId: config.executionPlanId,
      planStepId: config.planStepId,
      readToolRunId: config.readToolRunId,
      readAttemptId: config.readAttemptId,
    });
    process.send?.({
      type: "result",
      state: result.state,
      reservationId:
        result.reservation === null ? null : result.reservation.id,
      ownerTokenPresent: result.ownerToken !== null,
    });
  } catch (error) {
    process.send?.({
      type: "result",
      state: "error",
      code:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "INTERNAL_ERROR",
    });
  } finally {
    closeDatabase(database);
  }
});

process.send({ type: "ready" });
