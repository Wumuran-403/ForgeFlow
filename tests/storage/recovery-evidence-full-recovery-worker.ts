import { z } from "zod";

import { ExecutionAuthority } from "../../src/persistence/lease-heartbeat.js";
import { prepareRecoveryEvidenceRecoveryPreflight } from "../../src/recovery/recovery-evidence-recovery-preflight.js";
import {
  RecoveryEvidenceFencingTakeoverGuard,
  TaskLeaseManager,
  TaskSnapshotReader,
  closeDatabase,
  openDatabase,
} from "../../src/storage/index.js";
import { RecoveryEvidenceFullRecoveryUnitOfWork } from "../../src/storage/recovery-evidence-full-recovery-unit-of-work.js";
import { createDispatchReadbackRegistry } from "./recovery-evidence-dispatch-contract.js";

const ConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    taskId: z.string().min(1),
    requestId: z.string().min(1),
    priorAttemptId: z.string().min(1),
    recoveryOperationId: z.uuid(),
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
  leaseTtlMs: 60_000,
  now: () => new Date(config.now),
});
const takeoverGuard = new RecoveryEvidenceFencingTakeoverGuard(
  database,
  leaseManager,
);

process.once("message", (message: unknown) => {
  if (!StartSchema.safeParse(message).success) {
    sendAndExit({ type: "error", code: "WORKER_START_INVALID" }, 1);
    return;
  }
  void run();
});

process.send?.({ type: "ready" });

async function run(): Promise<void> {
  try {
    const claim = takeoverGuard.claimRecoveryEvidenceOwnership(
      config.taskId,
      config.ownerId,
    );
    if (claim.status !== "ready") {
      sendAndExit({
        type: "complete",
        state: claim.status,
      });
      return;
    }
    const current = new TaskSnapshotReader(database).load(
      config.taskId,
    );
    const priorAttempt =
      current.recoveryEvidenceReadAttempts.find(
        (attempt) => attempt.id === config.priorAttemptId,
      );
    const request =
      current.recoveryEvidenceReadbackRequests.find(
        (candidate) => candidate.id === config.requestId,
      );
    const runRecord = current.toolRuns.find(
      (candidate) => candidate.id === request?.readToolRunId,
    );
    const step = current.planSteps.find(
      (candidate) => candidate.id === request?.planStepId,
    );
    const plan = current.executionPlans.find(
      (candidate) =>
        candidate.id === request?.executionPlanId,
    );
    if (
      priorAttempt === undefined ||
      request === undefined ||
      runRecord === undefined ||
      step === undefined ||
      plan === undefined
    ) {
      throw new Error("Recovery worker binding is incomplete.");
    }
    const preflight =
      await prepareRecoveryEvidenceRecoveryPreflight({
        database,
        registry: createDispatchReadbackRegistry(),
        requestId: request.id,
      });
    const authority = new ExecutionAuthority();
    const result =
      new RecoveryEvidenceFullRecoveryUnitOfWork(
        database,
        () => authority.assertActive(),
        leaseManager,
        () => new Date(config.now),
      ).recoverOwnedRecoveryEvidenceReadAttempt({
        ownership: claim.ownership,
        currentLeaseClaimEventId: claim.leaseClaimEventId,
        expectedTaskVersion: current.task.version,
        requestId: request.id,
        priorAttemptId: priorAttempt.id,
        expectedPriorAttemptVersion: priorAttempt.version,
        expectedToolRunVersion: runRecord.version,
        expectedPlanStepVersion: step.version,
        expectedPlanVersion: plan.version,
        recoveryOperationId: config.recoveryOperationId,
        preflightResult: preflight,
      });
    sendAndExit({
      type: "complete",
      state: result.status,
      replayed: result.replayed,
      newAttemptId: result.newAttempt?.id ?? null,
      preparedEventId: result.preparedEventId,
      fencingToken: claim.ownership.fencingToken,
      leaseClaimEventId: claim.leaseClaimEventId,
    });
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
}

function sendAndExit(message: unknown, exitCode = 0): void {
  closeDatabase(database);
  if (process.send === undefined) {
    process.exit(exitCode);
  }
  process.send(message, () => process.exit(exitCode));
}
