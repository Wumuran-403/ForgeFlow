import { z } from "zod";

import {
  closeDatabase,
  openDatabase,
  TaskLeaseManager,
} from "../../src/storage/index.js";
import {
  RecoveryManager,
  type RecoveryInspectionOwnership,
} from "../../src/recovery/index.js";

const ConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    taskId: z.string().min(1),
    ownerId: z.string().min(1),
    now: z.string().min(1),
  })
  .strict();
const MessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("start") }).strict(),
  z.object({ type: z.literal("finish") }).strict(),
]);
const config = ConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const database = openDatabase(config.databasePath);
const manager = new TaskLeaseManager(database, {
  leaseTtlMs: 30_000,
  now: () => new Date(config.now),
});
const recovery = new RecoveryManager({
  database,
  leaseManager: manager,
  now: () => new Date(config.now),
});
let ownership: RecoveryInspectionOwnership | undefined;

process.on("message", (message: unknown) => {
  const parsed = MessageSchema.safeParse(message);
  if (!parsed.success) {
    sendAndExit({ type: "error", code: "WORKER_MESSAGE_INVALID" }, 1);
    return;
  }
  if (parsed.data.type === "start") {
    try {
      ownership = recovery.claimInspectionLease(
        config.taskId,
        config.ownerId,
      );
      process.send?.({ type: "claimed" });
    } catch (error) {
      sendAndExit(
        {
          type: "complete",
          status: "rejected",
          code: errorCode(error),
        },
        0,
      );
    }
    return;
  }

  if (ownership === undefined) {
    sendAndExit({ type: "error", code: "WORKER_NOT_CLAIMED" }, 1);
    return;
  }
  try {
    const report = recovery.inspectOwnedTask(ownership);
    recovery.releaseInspectionLease(ownership);
    sendAndExit(
      {
        type: "complete",
        status: "inspected",
        classification: report.primaryClassification,
      },
      0,
    );
  } catch (error) {
    try {
      recovery.releaseInspectionLease(ownership);
    } catch {
      // Preserve the primary failure in the worker response.
    }
    sendAndExit(
      {
        type: "complete",
        status: "rejected",
        code: errorCode(error),
      },
      0,
    );
  }
});

process.send?.({ type: "ready" });

function errorCode(error: unknown): string {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : "UNKNOWN";
}

function sendAndExit(message: unknown, code: number): void {
  closeDatabase(database);
  if (process.send === undefined) {
    process.exit(code);
  }
  process.send(message, () => process.exit(code));
}
