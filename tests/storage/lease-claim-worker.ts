import { z } from "zod";

import {
  closeDatabase,
  openDatabase,
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
const manager = new TaskLeaseManager(database, {
  leaseTtlMs: 30_000,
  now: () => new Date(config.now),
});

process.once("message", (message: unknown) => {
  if (!StartSchema.safeParse(message).success) {
    sendAndExit({ type: "error", code: "WORKER_START_INVALID" }, 1);
    return;
  }

  try {
    const lease = manager.claim(config.taskId, config.ownerId);
    sendAndExit(
      {
        type: "complete",
        status: "claimed",
        fencingToken: lease.fencingToken,
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
