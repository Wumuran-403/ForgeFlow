import { fork, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  EventRepository,
  ExecutionStateMachine,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  RecoveryEvidenceFencingTakeoverGuard,
  SequenceAllocator,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { runInTransaction } from "../../src/storage/transaction.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

const workerPath = fileURLToPath(
  new URL(
    "./recovery-evidence-fencing-takeover-worker.ts",
    import.meta.url,
  ),
);
const workers: ChildProcess[] = [];

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
let nowMs: number;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  nowMs = Date.parse("2026-11-08T00:10:00.000Z");
});

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.connected) {
      worker.disconnect();
    }
    if (!worker.killed) {
      worker.kill();
    }
  }
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("RecoveryEvidenceFencingTakeoverGuard", () => {
  it("returns the exact Claim Event ID and rejects active takeover", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-takeover-release");
    const manager = createLeaseManager(activeDatabase);
    const guard = new RecoveryEvidenceFencingTakeoverGuard(
      activeDatabase,
      manager,
    );

    const first = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-release",
        "worker-a",
      ),
    );
    const claimEvent = new EventRepository(
      activeDatabase,
      new SequenceAllocator(activeDatabase),
    )
      .listByTask("task-takeover-release")
      .find((event) => event.id === first.leaseClaimEventId);
    expect(claimEvent).toMatchObject({
      taskId: "task-takeover-release",
      type: "lease.claimed",
      entityType: "task_lease",
      entityId: "task-takeover-release",
      payload: {
        ownerId: "worker-a",
        fencingToken: first.ownership.fencingToken,
      },
    });

    expect(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-release",
        "worker-b",
      ),
    ).toMatchObject({
      status: "in_progress",
      taskId: "task-takeover-release",
      leaseRecord: {
        ownerId: "worker-a",
        fencingToken: first.ownership.fencingToken,
      },
    });

    manager.heartbeat(
      first.ownership.taskId,
      first.ownership.leaseToken,
      first.ownership.fencingToken,
    );
    expect(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-release",
        "worker-b",
      ).status,
    ).toBe("in_progress");

    manager.release(
      first.ownership.taskId,
      first.ownership.leaseToken,
      first.ownership.fencingToken,
    );
    const replacement = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-release",
        "worker-b",
      ),
    );
    expect(replacement.ownership.fencingToken).toBe(
      first.ownership.fencingToken + 1,
    );
    expect(replacement.leaseClaimEventId).not.toBe(
      first.leaseClaimEventId,
    );
  });

  it("allows a new Owner to claim after lease expiry", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-takeover-expiry");
    const manager = createLeaseManager(activeDatabase);
    const guard = new RecoveryEvidenceFencingTakeoverGuard(
      activeDatabase,
      manager,
    );
    const first = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-expiry",
        "worker-a",
      ),
    );

    nowMs += 31_000;
    const replacement = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-expiry",
        "worker-b",
      ),
    );
    expect(replacement.ownership.fencingToken).toBe(
      first.ownership.fencingToken + 1,
    );
  });

  it("returns state_inconsistent for missing and terminal Tasks", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const manager = createLeaseManager(activeDatabase);
    const guard = new RecoveryEvidenceFencingTakeoverGuard(
      activeDatabase,
      manager,
    );
    expect(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-missing",
        "worker-a",
      ),
    ).toEqual({
      status: "state_inconsistent",
      taskId: "task-takeover-missing",
      reasonCode: "TASK_NOT_FOUND",
    });

    createTask(activeDatabase, "task-takeover-terminal");
    new ExecutionUnitOfWork(activeDatabase).updateTaskStatus(
      "task-takeover-terminal",
      "cancelled",
    );
    expect(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-terminal",
        "worker-a",
      ),
    ).toEqual({
      status: "state_inconsistent",
      taskId: "task-takeover-terminal",
      reasonCode: "TASK_LEASE_TASK_TERMINAL",
    });
  });

  it("rejects a stale Owner SQLite write after fencing takeover", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-takeover-stale-write");
    const manager = createLeaseManager(activeDatabase);
    const guard = new RecoveryEvidenceFencingTakeoverGuard(
      activeDatabase,
      manager,
    );
    const oldOwner = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-stale-write",
        "worker-old",
      ),
    );
    manager.release(
      oldOwner.ownership.taskId,
      oldOwner.ownership.leaseToken,
      oldOwner.ownership.fencingToken,
    );
    const newOwner = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-stale-write",
        "worker-new",
      ),
    );
    expect(newOwner.ownership.fencingToken).toBeGreaterThan(
      oldOwner.ownership.fencingToken,
    );
    const beforeAttempt = new TaskSnapshotReader(activeDatabase).load(
      "task-takeover-stale-write",
    );

    const stateMachine = new ExecutionStateMachine(
      activeDatabase,
      manager,
    );
    expect(() =>
      stateMachine.transitionTask({
        ...oldOwner.ownership,
        expectedTaskVersion: beforeAttempt.task.version,
        expectedStatus: "queued",
        status: "running",
      }),
    ).toThrowError(/ownership is invalid/i);
    expect(
      new TaskSnapshotReader(activeDatabase).load(
        "task-takeover-stale-write",
      ).task,
    ).toMatchObject({
      status: "queued",
      version: beforeAttempt.task.version,
    });
  });

  it("validates Claim Event identity and Event sequence bindings", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-takeover-lineage");
    const manager = createLeaseManager(activeDatabase);
    const guard = new RecoveryEvidenceFencingTakeoverGuard(
      activeDatabase,
      manager,
    );
    const dispatchEvent = appendEvent(
      activeDatabase,
      "task-takeover-lineage",
      "recovery.evidence.read_attempt_dispatching",
      {
        readAttemptId: "attempt-takeover",
        attemptNumber: 1,
        attemptStatus: "dispatching",
      },
    );
    const first = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-lineage",
        "worker-a",
      ),
    );
    const interruptedEvent = appendEvent(
      activeDatabase,
      "task-takeover-lineage",
      "recovery.evidence.read_attempt_interrupted",
      {
        readAttemptId: "attempt-takeover",
        attemptNumber: 1,
        attemptStatus: "interrupted",
      },
    );
    const preparedEvent = appendEvent(
      activeDatabase,
      "task-takeover-lineage",
      "recovery.evidence.read_attempt_prepared",
      {
        readAttemptId: "attempt-next",
        attemptNumber: 2,
        attemptStatus: "prepared",
      },
    );

    expect(() =>
      guard.assertInterruptedClaimBinding({
        ownership: first.ownership,
        leaseClaimEventId: first.leaseClaimEventId,
        dispatchEventId: dispatchEvent.id,
        interruptedEventId: interruptedEvent.id,
      }),
    ).not.toThrow();
    expect(() =>
      guard.assertPreparedClaimBinding({
        ownership: first.ownership,
        leaseClaimEventId: first.leaseClaimEventId,
        preparedEventId: preparedEvent.id,
      }),
    ).not.toThrow();
    expect(() =>
      guard.assertLeaseClaimEvent({
        ownership: first.ownership,
        leaseClaimEventId: randomUUID(),
      }),
    ).toThrowError(/lease claim event is invalid/i);

    manager.release(
      first.ownership.taskId,
      first.ownership.leaseToken,
      first.ownership.fencingToken,
    );
    const resumed = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-lineage",
        "worker-b",
      ),
    );
    const resumedPreparedEvent = appendEvent(
      activeDatabase,
      "task-takeover-lineage",
      "recovery.evidence.read_attempt_prepared",
      {
        readAttemptId: "attempt-resumed",
        attemptNumber: 3,
        attemptStatus: "prepared",
      },
    );
    expect(() =>
      guard.assertPreparedClaimBinding({
        ownership: resumed.ownership,
        leaseClaimEventId: resumed.leaseClaimEventId,
        preparedEventId: resumedPreparedEvent.id,
      }),
    ).not.toThrow();
    expect(() =>
      guard.assertPreparedClaimBinding({
        ownership: resumed.ownership,
        leaseClaimEventId: first.leaseClaimEventId,
        preparedEventId: resumedPreparedEvent.id,
      }),
    ).toThrowError(/lease claim event is invalid/i);

    createTask(activeDatabase, "task-takeover-wrong-sequence");
    const wrongOrderClaim = readyClaim(
      guard.claimRecoveryEvidenceOwnership(
        "task-takeover-wrong-sequence",
        "worker-a",
      ),
    );
    const wrongDispatchEvent = appendEvent(
      activeDatabase,
      "task-takeover-wrong-sequence",
      "recovery.evidence.read_attempt_dispatching",
      {
        readAttemptId: "attempt-wrong-order",
        attemptNumber: 1,
        attemptStatus: "dispatching",
      },
    );
    const wrongInterruptedEvent = appendEvent(
      activeDatabase,
      "task-takeover-wrong-sequence",
      "recovery.evidence.read_attempt_interrupted",
      {
        readAttemptId: "attempt-wrong-order",
        attemptNumber: 1,
        attemptStatus: "interrupted",
      },
    );
    expect(() =>
      guard.assertInterruptedClaimBinding({
        ownership: wrongOrderClaim.ownership,
        leaseClaimEventId: wrongOrderClaim.leaseClaimEventId,
        dispatchEventId: wrongDispatchEvent.id,
        interruptedEventId: wrongInterruptedEvent.id,
      }),
    ).toThrowError(/sequence is invalid/i);
    expect(
      activeDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM recovery_evidence_read_attempts",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it(
    "allows only one of two independent connections to claim",
    async () => {
      const activeDatabase = database as ForgeFlowDatabase;
      createTask(activeDatabase, "task-takeover-concurrent");
      const databasePath = temporaryDatabase?.path as string;
      const first = await startWorker({
        databasePath,
        taskId: "task-takeover-concurrent",
        ownerId: "worker-a",
        now: new Date(nowMs).toISOString(),
      });
      const second = await startWorker({
        databasePath,
        taskId: "task-takeover-concurrent",
        ownerId: "worker-b",
        now: new Date(nowMs).toISOString(),
      });
      const results = await Promise.all([
        runWorker(first),
        runWorker(second),
      ]);

      const ready = results.filter(
        (result) => result.status === "ready",
      );
      expect(ready).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "in_progress"),
      ).toHaveLength(1);
      expect(
        activeDatabase
          .prepare(
            `
              SELECT COUNT(*) AS count FROM events
              WHERE task_id = ? AND type = 'lease.claimed'
            `,
          )
          .get("task-takeover-concurrent"),
      ).toEqual({ count: 1 });
      expect(
        activeDatabase
          .prepare(
            "SELECT id FROM events WHERE id = ?",
          )
          .get(ready[0]?.leaseClaimEventId),
      ).toMatchObject({ id: ready[0]?.leaseClaimEventId });
    },
    15_000,
  );
});

interface TakeoverWorkerResult {
  readonly type: "complete";
  readonly status: "ready" | "in_progress" | "rejected";
  readonly fencingToken?: number;
  readonly leaseClaimEventId?: string;
  readonly code?: string;
}

function readyClaim(
  result: ReturnType<
    RecoveryEvidenceFencingTakeoverGuard["claimRecoveryEvidenceOwnership"]
  >,
): Extract<
  ReturnType<
    RecoveryEvidenceFencingTakeoverGuard["claimRecoveryEvidenceOwnership"]
  >,
  { status: "ready" }
> {
  if (result.status !== "ready") {
    throw new Error(`Expected ready takeover, received ${result.status}.`);
  }
  return result;
}

function appendEvent(
  database: ForgeFlowDatabase,
  taskId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  return runInTransaction(
    database,
    () => {
      const permit = createStorageWritePermit(database);
      return new EventRepository(
        database,
        new SequenceAllocator(database),
      ).append(
        {
          taskId,
          traceId: `trace-${taskId}`,
          type,
          entityType: "recovery_evidence_read_attempt",
          entityId: payload.readAttemptId as string,
          payload,
        },
        new Date(nowMs).toISOString(),
        permit,
      );
    },
    "immediate",
  );
}

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Recovery evidence fencing takeover test.",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function createLeaseManager(
  database: ForgeFlowDatabase,
): TaskLeaseManager {
  return new TaskLeaseManager(database, {
    leaseTtlMs: 30_000,
    now: () => new Date(nowMs),
  });
}

function startWorker(config: {
  databasePath: string;
  taskId: string;
  ownerId: string;
  now: string;
}): Promise<ChildProcess> {
  const worker = fork(workerPath, [JSON.stringify(config)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workers.push(worker);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Takeover worker did not become ready."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
      ) {
        cleanup();
        resolve(worker);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `Takeover worker exited before readiness: ${String(code)}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}

function runWorker(
  worker: ChildProcess,
): Promise<TakeoverWorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Takeover worker timed out."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete"
      ) {
        cleanup();
        resolve(message as TakeoverWorkerResult);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(
          new Error(`Takeover worker exited with code ${String(code)}.`),
        );
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.send({ type: "start" });
  });
}
