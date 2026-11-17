import { z } from "zod";

import {
  RecoveryEvidenceUnitOfWork,
  TaskLeaseManager,
  closeDatabase,
  openDatabase,
} from "../../src/storage/index.js";
import { ExecutionAuthority } from "../../src/persistence/index.js";
import { prepareRecoveryEvidenceDispatchPreflight } from "../../src/recovery/recovery-evidence-dispatch-preflight.js";
import { createDispatchReadbackRegistry } from "./recovery-evidence-dispatch-contract.js";

const ConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    preflight: z
      .object({
        allowlistId: z.string().min(1),
        expectedAllowlistContractDigest: z
          .string()
          .regex(/^[0-9a-f]{64}$/),
      })
      .strict(),
    now: z.string().min(1),
  })
  .strict();

const config = ConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const database = openDatabase(config.databasePath);
const leaseManager = new TaskLeaseManager(database, {
  now: () => new Date(config.now),
  leaseTtlMs: 60_000,
});
const authority = new ExecutionAuthority();
const unitOfWork = new RecoveryEvidenceUnitOfWork(
  database,
  () => authority.assertActive(),
  leaseManager,
);

process.once("message", () => {
  try {
    const preflight = prepareRecoveryEvidenceDispatchPreflight({
      registry: createDispatchReadbackRegistry(),
      allowlistId: config.preflight.allowlistId,
      expectedAllowlistContractDigest:
        config.preflight.expectedAllowlistContractDigest,
    });
    const result = unitOfWork.beginOwnedRecoveryEvidenceRead(
      {
        ...config.input,
        preflight,
      } as never,
    );
    sendAndExit({ type: "complete", state: result.state });
  } catch (error) {
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
