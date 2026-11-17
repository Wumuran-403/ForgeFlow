import { z } from "zod";

import {
  RecoveryEvidenceUnitOfWork,
  TaskLeaseManager,
  TaskSnapshotReader,
  closeDatabase,
  openDatabase,
} from "../../src/storage/index.js";

const WorkerConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    taskId: z.string().min(1),
    readbackRequestId: z.string().min(1),
    attemptId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
    now: z.string().min(1),
  })
  .strict();

const config = WorkerConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const database = openDatabase(config.databasePath);
const leaseManager = new TaskLeaseManager(database, {
  now: () => new Date(config.now),
  leaseTtlMs: 60_000,
});
const unitOfWork = new RecoveryEvidenceUnitOfWork(
  database,
  () => undefined,
  leaseManager,
);

process.once("message", () => {
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const snapshot = new TaskSnapshotReader(database).load(config.taskId);
    try {
      const attempt =
        unitOfWork.createOwnedRecoveryEvidenceReadAttemptPrepared({
          ownership: {
            taskId: config.taskId,
            leaseToken: config.leaseToken,
            fencingToken: config.fencingToken,
          },
          expectedTaskVersion: snapshot.task.version,
          attemptId: config.attemptId,
          readbackRequestId: config.readbackRequestId,
        });
      sendAndExit({
        type: "complete",
        attemptNumber: attempt.attemptNumber,
      });
      return;
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "TASK_STATE_CONFLICT"
      ) {
        continue;
      }
      sendAndExit({
        type: "error",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "UNKNOWN",
      });
      return;
    }
  }
  sendAndExit({ type: "error", code: "ATTEMPT_ALLOCATION_RETRY_EXHAUSTED" });
});

process.send?.({ type: "ready" });

function sendAndExit(message: unknown): void {
  closeDatabase(database);
  if (process.send === undefined) {
    process.exit(0);
  }
  process.send(message, () => process.exit(0));
}
