import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

const workerPath = fileURLToPath(
  new URL("./lease-claim-worker.ts", import.meta.url),
);
const workers: ChildProcess[] = [];

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
let nowMs: number;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  nowMs = Date.parse("2026-01-01T00:00:00.000Z");
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

describe("TaskLeaseManager", () => {
  it("claims, heartbeats, rejects stale ownership, and retains fencing history", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-lease");
    const manager = createLeaseManager(activeDatabase, () => nowMs);

    const first = manager.claim("task-lease", "worker-a");
    expect(first).toMatchObject({
      taskId: "task-lease",
      ownerId: "worker-a",
      fencingToken: 1,
      releasedAt: null,
    });
    expect(first.leaseToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    expect(() => manager.claim("task-lease", "worker-b")).toThrowError(
      /active execution lease/i,
    );
    expect(() =>
      manager.heartbeat(
        "task-lease",
        first.leaseToken as string,
        first.fencingToken + 1,
      ),
    ).toThrowError(/ownership is invalid/i);
    expect(() =>
      manager.release(
        "task-lease",
        "stale-token",
        first.fencingToken,
      ),
    ).toThrowError(/ownership is invalid/i);

    nowMs += 500;
    const heartbeat = manager.heartbeat(
      "task-lease",
      first.leaseToken as string,
      first.fencingToken,
    );
    expect(Date.parse(heartbeat.expiresAt as string)).toBeGreaterThan(
      Date.parse(first.expiresAt as string),
    );
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM checkpoints
            WHERE task_id = ? AND reason = 'lease_heartbeat'
          `,
        )
        .get("task-lease"),
    ).toEqual({ count: 0 });

    const released = manager.release(
      "task-lease",
      first.leaseToken as string,
      first.fencingToken,
    );
    expect(released).toMatchObject({
      ownerId: null,
      leaseToken: null,
      fencingToken: 1,
      releasedAt: "2026-01-01T00:00:00.500Z",
    });

    const second = manager.claim("task-lease", "worker-b");
    expect(second.fencingToken).toBe(2);
    expect(second.leaseToken).not.toBe(first.leaseToken);
    expect(
      new TaskSnapshotReader(activeDatabase).load("task-lease").lease,
    ).toMatchObject({
      ownerId: "worker-b",
      fencingToken: 2,
    });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT type FROM events
            WHERE task_id = ?
              AND type LIKE 'lease.%'
            ORDER BY sequence
          `,
        )
        .all("task-lease"),
    ).toEqual([
      { type: "lease.claimed" },
      { type: "lease.heartbeat" },
      { type: "lease.released" },
      { type: "lease.claimed" },
    ]);
  });

  it("does not allow an expired lease to heartbeat or submit ownership", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-expiry");
    const manager = createLeaseManager(activeDatabase, () => nowMs);
    const lease = manager.claim("task-expiry", "worker-a");

    nowMs += 31_000;
    expect(() =>
      manager.heartbeat(
        "task-expiry",
        lease.leaseToken as string,
        lease.fencingToken,
      ),
    ).toThrowError(/ownership is invalid/i);
    expect(() =>
      manager.assertOwned(
        "task-expiry",
        lease.leaseToken as string,
        lease.fencingToken,
      ),
    ).toThrowError(/ownership is invalid/i);
    expect(
      manager.isExpired(
        "task-expiry",
        lease.leaseToken as string,
        lease.fencingToken,
      ),
    ).toBe(true);

    const replacement = manager.claim("task-expiry", "worker-b");
    expect(replacement.fencingToken).toBe(lease.fencingToken + 1);
  });

  it("rejects claims for every terminal Task status", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    const manager = createLeaseManager(activeDatabase, () => nowMs);

    for (const status of ["completed", "failed", "cancelled"] as const) {
      const taskId = `task-terminal-${status}`;
      createTask(activeDatabase, taskId);
      unitOfWork.updateTaskStatus(taskId, status);
      expect(() => manager.claim(taskId, `worker-${status}`)).toThrowError(
        /terminal task/i,
      );
    }
  });

  it("rolls back claim when its Event or Checkpoint fails", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-rollback");
    const manager = createLeaseManager(activeDatabase, () => nowMs);
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_lease_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'lease.claimed'
        BEGIN
          SELECT RAISE(ABORT, 'lease event rejected');
        END
      `,
    );

    expect(() =>
      manager.claimWithClaimEvent("task-rollback", "worker-a"),
    ).toThrow("lease event rejected");
    expect(
      activeDatabase
        .prepare("SELECT * FROM task_leases WHERE task_id = ?")
        .get("task-rollback"),
    ).toBeUndefined();
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM events
            WHERE task_id = ? AND type = 'lease.claimed'
          `,
        )
        .get("task-rollback"),
    ).toEqual({ count: 0 });

    activeDatabase.exec("DROP TRIGGER reject_lease_event");
    createTask(activeDatabase, "task-checkpoint-rollback");
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_lease_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'lease_claimed'
        BEGIN
          SELECT RAISE(ABORT, 'lease checkpoint rejected');
        END
      `,
    );
    expect(() =>
      manager.claimWithClaimEvent(
        "task-checkpoint-rollback",
        "worker-a",
      ),
    ).toThrow("lease checkpoint rejected");
    expect(
      activeDatabase
        .prepare("SELECT * FROM task_leases WHERE task_id = ?")
        .get("task-checkpoint-rollback"),
    ).toBeUndefined();
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM events
            WHERE task_id = ? AND type = 'lease.claimed'
          `,
        )
        .get("task-checkpoint-rollback"),
    ).toEqual({ count: 0 });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM checkpoints
            WHERE task_id = ? AND reason = 'lease_claimed'
          `,
        )
        .get("task-checkpoint-rollback"),
    ).toEqual({ count: 0 });
  });

  it("keeps heartbeat and release atomic with their Events", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-lease-events");
    const manager = createLeaseManager(activeDatabase, () => nowMs);
    const lease = manager.claim("task-lease-events", "worker-a");
    const beforeHeartbeat = new TaskSnapshotReader(
      activeDatabase,
    ).load("task-lease-events").lease;
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_heartbeat_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'lease.heartbeat'
        BEGIN
          SELECT RAISE(ABORT, 'heartbeat event rejected');
        END
      `,
    );
    nowMs += 1_000;

    expect(() =>
      manager.heartbeat(
        "task-lease-events",
        lease.leaseToken as string,
        lease.fencingToken,
      ),
    ).toThrow("heartbeat event rejected");
    expect(
      new TaskSnapshotReader(activeDatabase).load("task-lease-events").lease,
    ).toMatchObject({
      heartbeatAt: beforeHeartbeat?.heartbeatAt,
      expiresAt: beforeHeartbeat?.expiresAt,
    });

    activeDatabase.exec("DROP TRIGGER reject_heartbeat_event");
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_release_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'lease.released'
        BEGIN
          SELECT RAISE(ABORT, 'release event rejected');
        END
      `,
    );
    expect(() =>
      manager.release(
        "task-lease-events",
        lease.leaseToken as string,
        lease.fencingToken,
      ),
    ).toThrow("release event rejected");
    expect(
      new TaskSnapshotReader(activeDatabase).load("task-lease-events").lease,
    ).toMatchObject({
      ownerId: "worker-a",
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
    });
  });

  it(
    "allows only one of two independent file-database connections to claim",
    async () => {
      const activeDatabase = database as ForgeFlowDatabase;
      createTask(activeDatabase, "task-concurrent-lease");
      const databasePath = temporaryDatabase?.path as string;

      const first = await startWorker({
        databasePath,
        taskId: "task-concurrent-lease",
        ownerId: "worker-a",
        now: "2026-01-01T00:00:00.000Z",
      });
      const second = await startWorker({
        databasePath,
        taskId: "task-concurrent-lease",
        ownerId: "worker-b",
        now: "2026-01-01T00:00:00.000Z",
      });
      const results = await Promise.all([
        runWorker(first),
        runWorker(second),
      ]);

      expect(
        results.filter((result) => result.status === "claimed"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      expect(
        activeDatabase
          .prepare(
            "SELECT owner_id, fencing_token FROM task_leases WHERE task_id = ?",
          )
          .get("task-concurrent-lease"),
      ).toMatchObject({ fencing_token: 1 });
    },
    15_000,
  );
});

interface WorkerMessage {
  readonly type: "complete";
  readonly status: "claimed" | "rejected";
  readonly fencingToken?: number;
  readonly code?: string;
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
      reject(new Error("Lease worker did not become ready."));
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
        new Error(`Lease worker exited before readiness: ${String(code)}`),
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

function runWorker(worker: ChildProcess): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Lease worker timed out."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete"
      ) {
        cleanup();
        resolve(message as WorkerMessage);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(
          new Error(`Lease worker exited with code ${String(code)}`),
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

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Lease concurrency test",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function createLeaseManager(
  database: ForgeFlowDatabase,
  now: () => number,
): TaskLeaseManager {
  return new TaskLeaseManager(database, {
    leaseTtlMs: 30_000,
    now: () => new Date(now()),
  });
}
