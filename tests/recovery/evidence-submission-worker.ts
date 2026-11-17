import { z } from "zod";

import { ExecutionAuthority } from "../../src/persistence/index.js";
import {
  FileEvidencePayloadStore,
  SubmitRecoveryEvidenceInputSchema,
} from "../../src/recovery/index.js";
import { RecoveryReviewDecisionService } from "../../src/recovery/recovery-review-decision-service.js";
import {
  closeDatabase,
  openDatabase,
  TaskLeaseManager,
} from "../../src/storage/index.js";

const WorkerConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    evidenceStorePath: z.string().min(1),
    now: z.string().min(1),
    ownership: z
      .object({
        taskId: z.string().min(1),
        leaseToken: z.string().min(1),
        fencingToken: z.number().int().positive(),
      })
      .strict(),
    expectedTaskVersion: z.number().int().positive(),
    submittedAt: z.string().min(1),
    input: SubmitRecoveryEvidenceInputSchema,
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
  new FileEvidencePayloadStore(config.evidenceStorePath),
);

process.once("message", () => {
  try {
    const authority = new ExecutionAuthority();
    const result = service.submitEvidenceOwned(
      config.input,
      config.ownership,
      config.expectedTaskVersion,
      config.submittedAt,
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
