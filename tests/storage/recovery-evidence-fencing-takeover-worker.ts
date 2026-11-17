import { z } from "zod";

import {
  closeDatabase,
  openDatabase,
  RecoveryEvidenceFencingTakeoverGuard,
  TaskLeaseManager,
} from "../../src/storage/index.js";

const ConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    taskId: z.string().min(1),
    ownerId: z.string().min(1),
    now: z.string().min(1),
  })
  .strict();

const StartSchema = z.object({ type: z.literal("start") }).strict();
const config = ConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const database = openDatabase(config.databasePath);
const leaseManager = new TaskLeaseManager(database, {
  leaseTtlMs: 30_000,
  now: () => new Date(config.now),
});
const guard = new RecoveryEvidenceFencingTakeoverGuard(
  database,
  leaseManager,
);

process.once("message", (message: unknown) => {
  if (!StartSchema.safeParse(message).success) {
    sendAndExit({ type: "error", code: "WORKER_START_INVALID" }, 1);
    return;
  }

  try {
    const result = guard.claimRecoveryEvidenceOwnership(
      config.taskId,
      config.ownerId,
    );
    if (result.status === "ready") {
      sendAndExit(
        {
          type: "complete",
          status: "ready",
          fencingToken: result.ownership.fencingToken,
          leaseClaimEventId: result.leaseClaimEventId,
        },
        0,
      );
      return;
    }
    sendAndExit(
      {
        type: "complete",
        status:
          result.status === "in_progress"
            ? "in_progress"
            : "rejected",
        code:
          result.status === "in_progress"
            ? "TASK_LEASE_UNAVAILABLE"
            : result.reasonCode,
      },
      0,
    );
  } catch (error) {
    sendAndExit(
      {
        type: "complete",
        status: "rejected",
        code:
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          typeof error.code === "string"
            ? error.code
            : "UNKNOWN",
      },
      0,
    );
  }
});

process.send?.({ type: "ready" });

function sendAndExit(message: unknown, code: number): void {
  closeDatabase(database);
  if (process.send === undefined) {
    process.exit(code);
  }
  process.send(message, () => process.exit(code));
}
