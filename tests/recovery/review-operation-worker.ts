import { dirname, join } from "node:path";

import { z } from "zod";

import { ExecutionAuthority } from "../../src/persistence/index.js";
import { FileEvidencePayloadStore } from "../../src/recovery/index.js";
import { RecoveryReviewDecisionService } from "../../src/recovery/recovery-review-decision-service.js";
import {
  closeDatabase,
  JsonValueSchema,
  openDatabase,
  TaskLeaseManager,
} from "../../src/storage/index.js";

const WorkerConfigSchema = z
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
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    actorId: z.string().trim().min(1),
    operationPayload: JsonValueSchema,
    requestKey: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  })
  .strict();

const config = WorkerConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const database = openDatabase(config.databasePath);
const service = new RecoveryReviewDecisionService(
  database,
  new TaskLeaseManager(database, {
    now: () => new Date(config.now),
  }),
  new FileEvidencePayloadStore(join(dirname(config.databasePath), "evidence")),
);

process.once("message", () => {
  try {
    const authority = new ExecutionAuthority();
    const result = service.commitOwned(
      {
        reviewId: config.reviewId,
        expectedDecisionVersion: config.expectedDecisionVersion,
        operation: "advance_decision_version",
        actorId: config.actorId,
        operationPayload: config.operationPayload,
        requestKey: config.requestKey,
      },
      config.ownership,
      config.expectedTaskVersion,
      () => authority.assertActive(),
    );
    sendAndExit({
      status: "applied",
      replayed: result.replayed,
    });
  } catch (error) {
    sendAndExit({
      status: "rejected",
      code:
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        typeof error.code === "string"
          ? error.code
          : "UNKNOWN",
    });
  }
});

process.send?.({ type: "ready" });

function sendAndExit(message: unknown): void {
  closeDatabase(database);
  if (process.send === undefined) {
    process.exit(0);
  }
  process.send(message, () => process.exit(0));
}
