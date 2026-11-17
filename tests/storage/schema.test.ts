import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("storage schema through Step 4", () => {
  it("creates all approved business and lease tables", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    migrateStorage(database);

    const tables = (
      database
        .prepare(
          `
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    expect(tables).toEqual([
      "approvals",
      "checkpoints",
      "evaluation_case_results",
      "evaluation_metrics",
      "evaluation_runs",
      "events",
      "execution_plans",
      "global_model_budget_days",
      "global_model_budget_reservations",
      "messages",
      "model_calls",
      "plan_steps",
      "recovery_evidence_read_attempts",
      "recovery_evidence_readback_request_reservations",
      "recovery_evidence_readback_requests",
      "recovery_evidence_reads",
      "recovery_evidence_submissions",
      "recovery_evidence_verification_checks",
      "recovery_evidence_verifications",
      "recovery_legacy_attestations",
      "recovery_review_operations",
      "recovery_reviews",
      "schema_migrations",
      "task_leases",
      "tasks",
      "tool_runs",
    ]);
  });

  it("enforces required columns and checkpoint task foreign keys", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    migrateStorage(database);

    const tasks = database.pragma("table_info(tasks)") as Array<{
      name: string;
      notnull: number;
    }>;
    const requiredTaskColumns = [
      "trace_id",
      "status",
      "objective",
      "system_prompt",
      "token_usage_json",
      "created_at",
      "updated_at",
    ];

    for (const column of requiredTaskColumns) {
      expect(tasks.find((item) => item.name === column)?.notnull).toBe(1);
    }
    expect(tasks.find((item) => item.name === "id")).toMatchObject({
      pk: 1,
    });
    expect(tasks.find((item) => item.name === "max_tokens")).toMatchObject({
      notnull: 0,
    });

    expect(database.pragma("foreign_key_list(checkpoints)")).toContainEqual(
      expect.objectContaining({
        table: "tasks",
        from: "task_id",
        to: "id",
      }),
    );
    expect(database.pragma("foreign_key_list(messages)")).toContainEqual(
      expect.objectContaining({
        table: "tasks",
        from: "task_id",
        to: "id",
      }),
    );
  });

  it("enforces a positive optional task token budget", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    migrateStorage(database);
    insertTask(database, "task-budget");
    expect(database.prepare("SELECT max_tokens FROM tasks WHERE id = ?")
      .get("task-budget")).toEqual({ max_tokens: null });
    database.prepare("UPDATE tasks SET max_tokens = 50000 WHERE id = ?")
      .run("task-budget");
    expect(() => database?.prepare("UPDATE tasks SET max_tokens = 0 WHERE id = ?")
      .run("task-budget")).toThrow();
  });

  it("enforces status, role, and message-shape CHECK constraints", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    migrateStorage(database);
    insertTask(database, "task-1");

    expect(() =>
      database
        ?.prepare(
          "UPDATE tasks SET status = 'not-a-status' WHERE id = 'task-1'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        ?.prepare(
          `
            INSERT INTO messages
              (id, task_id, sequence, role, content, created_at)
            VALUES
              ('message-1', 'task-1', 1, 'invalid', 'x', '2026-01-01')
          `,
        )
        .run(),
    ).toThrow();
    expect(() =>
      database
        ?.prepare(
          `
            INSERT INTO messages
              (id, task_id, sequence, role, content, created_at)
            VALUES
              ('message-2', 'task-1', 2, 'tool', 'x', '2026-01-01')
          `,
        )
        .run(),
    ).toThrow();
  });

  it("keeps events append-only with database triggers", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    migrateStorage(database);
    insertTask(database, "task-1");
    database
      .prepare(
        `
          INSERT INTO events (
            id, task_id, sequence, trace_id, type, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "event-1",
        "task-1",
        1,
        "trace-1",
        "task.created",
        "{}",
        "2026-01-01",
      );

    expect(() =>
      database
        ?.prepare("UPDATE events SET type = 'changed' WHERE id = 'event-1'")
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      database?.prepare("DELETE FROM events WHERE id = 'event-1'").run(),
    ).toThrow(/append-only/);
    expect(
      database.prepare("SELECT type FROM events WHERE id = 'event-1'").get(),
    ).toEqual({ type: "task.created" });
  });

  it("enforces unique message and event sequences", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    migrateStorage(database);
    insertTask(database, "task-1");

    const insertMessage = database.prepare(
      `
        INSERT INTO messages
          (id, task_id, sequence, role, content, created_at)
        VALUES (?, 'task-1', 1, 'user', 'hello', '2026-01-01')
      `,
    );
    insertMessage.run("message-1");
    expect(() => insertMessage.run("message-2")).toThrow();

    const insertEvent = database.prepare(
      `
        INSERT INTO events
          (id, task_id, sequence, trace_id, type, payload_json, created_at)
        VALUES (?, 'task-1', 1, 'trace-1', 'task.created', '{}', '2026-01-01')
      `,
    );
    insertEvent.run("event-1");
    expect(() => insertEvent.run("event-2")).toThrow();
  });

  it("runs the storage migrations repeatedly without duplicate tables", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);

    expect(migrateStorage(database)).toMatchObject({
      appliedVersions: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
      currentVersion: 12,
    });
    expect(migrateStorage(database)).toMatchObject({
      appliedVersions: [],
      currentVersion: 12,
    });
  });
});

function insertTask(database: ForgeFlowDatabase, id: string): void {
  database
    .prepare(
      `
        INSERT INTO tasks (
          id, trace_id, status, objective, system_prompt,
          max_model_turns, max_tool_calls, token_usage_json,
          created_at, updated_at
        ) VALUES (?, ?, 'queued', ?, ?, 10, 20, ?, ?, ?)
      `,
    )
    .run(
      id,
      `trace-${id}`,
      "Test objective",
      "Test system prompt",
      JSON.stringify({ source: "unknown" }),
      "2026-01-01",
      "2026-01-01",
    );
}
