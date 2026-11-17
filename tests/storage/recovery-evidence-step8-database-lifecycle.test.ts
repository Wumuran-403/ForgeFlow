import { afterEach, describe, expect, it } from "vitest";

import {
  ExecutionUnitOfWork,
  TaskLeaseManager,
  TaskSnapshotReader,
  closeDatabase,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let database: ForgeFlowDatabase | undefined;
let temporaryDatabase: TemporaryDatabase | undefined;

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("Step 8 SQLite lifecycle", () => {
  it("preserves a committed Lease claim after close and reopen", () => {
    const temporary = createTemporaryDatabase();
    temporaryDatabase = temporary;
    database = openDatabase(temporary.path);
    migrateStorage(database);
    createTask(database, "step8-committed-lease");
    const manager = createLeaseManager(database);
    const claimed = manager.claim(
      "step8-committed-lease",
      "worker-committed",
    );

    closeDatabase(database);
    database = openDatabase(temporary.path);
    const reopenedManager = createLeaseManager(database);
    const snapshot = new TaskSnapshotReader(database).load(
      "step8-committed-lease",
    );
    expect(snapshot.lease).toMatchObject({
      ownerId: "worker-committed",
      leaseToken: claimed.leaseToken,
      fencingToken: claimed.fencingToken,
    });
    expect(
      snapshot.events.filter(
        (event) => event.type === "lease.claimed",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) => checkpoint.reason === "lease_claimed",
      ),
    ).toHaveLength(1);

    expect(() =>
      reopenedManager.claim(
        "step8-committed-lease",
        "worker-contender",
      ),
    ).toThrowError(/active execution lease/i);
  });

  it("does not persist partial Lease state when Checkpoint append fails", () => {
    const temporary = createTemporaryDatabase();
    temporaryDatabase = temporary;
    database = openDatabase(temporary.path);
    migrateStorage(database);
    createTask(database, "step8-rollback-lease");
    database.exec(
      `
        CREATE TRIGGER step8_reject_lease_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'lease_claimed'
        BEGIN
          SELECT RAISE(ABORT, 'step8 lease checkpoint rejected');
        END
      `,
    );
    const manager = createLeaseManager(database);
    expect(() =>
      manager.claim("step8-rollback-lease", "worker-failed"),
    ).toThrow(/step8 lease checkpoint rejected/i);

    closeDatabase(database);
    database = openDatabase(temporary.path);
    const snapshot = new TaskSnapshotReader(database).load(
      "step8-rollback-lease",
    );
    expect(snapshot.lease).toBeNull();
    expect(
      snapshot.events.filter(
        (event) => event.type === "lease.claimed",
      ),
    ).toHaveLength(0);
    expect(
      snapshot.checkpoints.filter(
        (checkpoint) => checkpoint.reason === "lease_claimed",
      ),
    ).toHaveLength(0);
  });
});

function createTask(
  activeDatabase: ForgeFlowDatabase,
  taskId: string,
): void {
  new ExecutionUnitOfWork(activeDatabase).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Step 8 SQLite lifecycle test.",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function createLeaseManager(
  activeDatabase: ForgeFlowDatabase,
): TaskLeaseManager {
  return new TaskLeaseManager(activeDatabase, {
    leaseTtlMs: 60_000,
    now: () => new Date("2026-11-08T00:20:00.000Z"),
  });
}
