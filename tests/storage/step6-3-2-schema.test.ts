import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  PHASE3_STORAGE_MIGRATIONS,
  runMigrations,
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

describe("Step 6.3.2 operation schema", () => {
  it("adds finite operation status values and immutable key material", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;
    const columns = tableInfo(
      activeDatabase,
      "recovery_review_operations",
    );
    expect(
      columns.find((column) => column.name === "actor_id"),
    ).toBeDefined();
    expect(
      columns.find(
        (column) => column.name === "operation_payload_digest",
      ),
    ).toBeDefined();

    const sql = activeDatabase
      .prepare(
        `
          SELECT sql FROM sqlite_master
          WHERE name = 'recovery_review_operations'
        `,
      )
      .pluck()
      .get() as string;
    expect(sql).toContain("status IN ('applied', 'accepted')");
    expect(sql).toContain("'advance_decision_version'");
    expect(sql).toContain(
      "operation != 'advance_decision_version'",
    );
    expect(
      activeDatabase
        .prepare(
          `
            SELECT name FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'recovery_review_operations_validate_readback',
                'recovery_review_operations_validate_status_insert',
                'recovery_review_operations_reject_update',
                'recovery_review_operations_reject_delete'
              )
            ORDER BY name
          `,
        )
        .all(),
    ).toEqual([
      { name: "recovery_review_operations_reject_delete" },
      { name: "recovery_review_operations_reject_update" },
      { name: "recovery_review_operations_validate_readback" },
      { name: "recovery_review_operations_validate_status_insert" },
    ]);
  });

  it("upgrades v4 operation rows without fabricating actor or payload keys", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 4));
    insertV4OperationFixture(activeDatabase);

    expect(migrateStorage(activeDatabase)).toMatchObject({
      appliedVersions: [5, 6, 7, 8, 9, 10, 11, 12],
      currentVersion: 12,
    });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT status, actor_id, operation_payload_digest,
                   request_key, operation,
                   expected_decision_version,
                   resulting_decision_version,
                   result_plan_id, result_tool_run_id,
                   applied_event_id
            FROM recovery_review_operations
            WHERE id = 'operation-v4'
          `,
        )
        .get(),
    ).toEqual({
      status: "applied",
      actor_id: null,
      operation_payload_digest: null,
      request_key: digest("a"),
      operation: "mark_unresolved",
      expected_decision_version: 0,
      resulting_decision_version: 1,
      result_plan_id: null,
      result_tool_run_id: null,
      applied_event_id: "event-v4",
    });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT name FROM sqlite_master
            WHERE type IN ('index', 'trigger')
              AND name IN (
                'ix_recovery_review_operations_review',
                'recovery_review_operations_validate_readback',
                'recovery_review_operations_validate_status_insert',
                'recovery_review_operations_reject_update',
                'recovery_review_operations_reject_delete'
              )
            ORDER BY name
          `,
        )
        .all(),
    ).toEqual([
      { name: "ix_recovery_review_operations_review" },
      { name: "recovery_review_operations_reject_delete" },
      { name: "recovery_review_operations_reject_update" },
      { name: "recovery_review_operations_validate_readback" },
      { name: "recovery_review_operations_validate_status_insert" },
    ]);
    expect(
      activeDatabase.pragma(
        "foreign_key_list(recovery_review_operations)",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "recovery_reviews",
          from: "review_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "events",
          from: "applied_event_id",
          to: "id",
        }),
      ]),
    );
  });

  it("rolls back v5 when a historical status violates the new CHECK", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 4));
    insertV4OperationFixture(activeDatabase, "pending");

    expect(() => migrateStorage(activeDatabase)).toThrow(
      /CHECK constraint failed|constraint failed/i,
    );
    expect(
      activeDatabase
        .prepare(
          `
            SELECT status FROM recovery_review_operations
            WHERE id = 'operation-v4'
          `,
        )
        .get(),
    ).toEqual({ status: "pending" });
    expect(
      tableInfo(activeDatabase, "recovery_review_operations").some(
        (column) => column.name === "actor_id",
      ),
    ).toBe(false);
    expect(
      activeDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 4 });
  });

  it("rolls back v5 when the replacement table cannot be created", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 4));
    activeDatabase.exec(
      "CREATE TABLE recovery_review_operations_v5 (id TEXT PRIMARY KEY)",
    );

    expect(() => migrateStorage(activeDatabase)).toThrow(
      /recovery_review_operations_v5 already exists/i,
    );
    expect(
      tableInfo(activeDatabase, "recovery_review_operations").some(
        (column) => column.name === "actor_id",
      ),
    ).toBe(false);
    expect(
      activeDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 4 });
  });

  it("enforces status, neutral-operation key material, and append-only rows", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;
    insertV5OperationFixture(activeDatabase);

    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE recovery_review_operations SET status = 'pending' WHERE id = 'operation-v5'",
        )
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      activeDatabase
        .prepare(
          `
            INSERT INTO recovery_review_operations (
              id, task_id, review_id, request_key, operation,
              expected_decision_version, resulting_decision_version,
              status, actor_id, operation_payload_digest,
              evidence_envelope_digest, result_plan_id,
              result_tool_run_id, applied_event_id, created_at
            ) VALUES (
              'invalid-status', 'task-schema', 'review-schema', ?,
              'advance_decision_version', 1, 2, 'pending',
              'actor-host', ?, NULL, NULL, NULL, 'event-schema', ?
            )
          `,
        )
        .run(digest("a"), digest("b"), timestamp),
    ).toThrow();
    expect(() =>
      activeDatabase
        .prepare(
          `
            INSERT INTO recovery_review_operations (
              id, task_id, review_id, request_key, operation,
              expected_decision_version, resulting_decision_version,
              status, actor_id, operation_payload_digest,
              evidence_envelope_digest, result_plan_id,
              result_tool_run_id, applied_event_id, created_at
            ) VALUES (
              'invalid-neutral', 'task-schema', 'review-schema', ?,
              'advance_decision_version', 2, 3, 'applied',
              NULL, NULL, NULL, NULL, NULL, 'event-schema', ?
            )
          `,
        )
        .run(digest("c"), timestamp),
    ).toThrow();
    expect(() =>
      activeDatabase
        .prepare(
          `
            INSERT INTO recovery_review_operations (
              id, task_id, review_id, request_key, operation,
              expected_decision_version, resulting_decision_version,
              status, actor_id, operation_payload_digest,
              evidence_envelope_digest, result_plan_id,
              result_tool_run_id, applied_event_id, created_at
            ) VALUES (
              'invalid-status-mapping', 'task-schema', 'review-schema', ?,
              'advance_decision_version', 1, 2, 'accepted',
              'actor-host', ?, NULL, NULL, NULL, NULL, ?
            )
          `,
        )
        .run(digest("f"), digest("b"), timestamp),
    ).toThrow(/combination is invalid/i);
    expect(() =>
      activeDatabase
        .prepare(
          `
            INSERT INTO recovery_review_operations (
              id, task_id, review_id, request_key, operation,
              expected_decision_version, resulting_decision_version,
              status, actor_id, operation_payload_digest,
              evidence_envelope_digest, result_plan_id,
              result_tool_run_id, applied_event_id, created_at
            ) VALUES (
              'valid-neutral', 'task-schema', 'review-schema', ?,
              'advance_decision_version', 1, 2, 'applied',
              'actor-host', ?, NULL, NULL, NULL, NULL, ?
            )
          `,
        )
        .run(digest("d"), digest("e"), timestamp),
    ).not.toThrow();
    expect(() =>
      activeDatabase
        .prepare(
          "DELETE FROM recovery_review_operations WHERE id = 'valid-neutral'",
        )
        .run(),
    ).toThrow(/append-only/);
  });
});

function openMigratedDatabase(): void {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
}

function tableInfo(
  database: ForgeFlowDatabase,
  table: string,
): Array<{ name: string }> {
  return database.pragma(`table_info(${table})`) as Array<{ name: string }>;
}

function insertV4OperationFixture(
  database: ForgeFlowDatabase,
  status = "applied",
): void {
  insertTaskAndReview(database);
  database
    .prepare(
      `
        INSERT INTO events (
          id, task_id, sequence, trace_id, type, payload_json, created_at
        ) VALUES ('event-v4', 'task-schema', 1, 'trace-schema',
                  'test.event', '{}', ?)
      `,
    )
    .run(timestamp);
  database
    .prepare(
      `
        INSERT INTO recovery_review_operations (
          id, task_id, review_id, request_key, operation,
          expected_decision_version, resulting_decision_version,
          status, evidence_envelope_digest, result_plan_id,
          result_tool_run_id, applied_event_id, created_at
        ) VALUES (
          'operation-v4', 'task-schema', 'review-schema', ?,
          'mark_unresolved', 0, 1, ?, NULL, NULL,
          NULL, 'event-v4', ?
        )
      `,
    )
    .run(digest("a"), status, timestamp);
}

function insertV5OperationFixture(database: ForgeFlowDatabase): void {
  insertTaskAndReview(database);
  database
    .prepare(
      `
        INSERT INTO events (
          id, task_id, sequence, trace_id, type, payload_json, created_at
        ) VALUES ('event-schema', 'task-schema', 1, 'trace-schema',
                  'test.event', '{}', ?)
      `,
    )
    .run(timestamp);
  database
    .prepare(
      `
        INSERT INTO recovery_review_operations (
          id, task_id, review_id, request_key, operation,
          expected_decision_version, resulting_decision_version,
          status, actor_id, operation_payload_digest,
          evidence_envelope_digest, result_plan_id,
          result_tool_run_id, applied_event_id, created_at
        ) VALUES (
          'operation-v5', 'task-schema', 'review-schema', ?,
          'advance_decision_version', 0, 1, 'applied',
          'actor-host', ?, NULL, NULL, NULL, 'event-schema', ?
        )
      `,
    )
    .run(digest("a"), digest("b"), timestamp);
}

function insertTaskAndReview(database: ForgeFlowDatabase): void {
  database
    .prepare(
      `
        INSERT INTO tasks (
          id, trace_id, status, objective, system_prompt,
          max_model_turns, max_tool_calls, token_usage_json,
          created_at, updated_at
        ) VALUES ('task-schema', 'trace-schema', 'waiting_review',
                  'Schema test', 'You are ForgeFlow.', 10, 20,
                  '{"source":"unknown"}', ?, ?)
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO model_calls (
          id, task_id, iteration, attempt_no, status,
          request_json, started_at
        ) VALUES ('model-schema', 'task-schema', 1, 1,
                  'requested', '{}', ?)
      `,
    )
    .run(timestamp);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          purpose, status, created_at, updated_at
        ) VALUES ('plan-schema', 'task-schema', 1, 'model-schema',
                  'agent', 'active', ?, ?)
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES ('step-schema', 'task-schema', 'plan-schema', 0,
                  'write', 'waiting_review', ?, ?)
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO tool_runs (
          id, task_id, plan_step_id, call_id, original_index,
          tool_name, tool_version, input_schema_hash,
          canonical_input_hash, mode, requires_approval, status,
          input_json, error_json, idempotency_key, attempt_no,
          started_at, created_at, updated_at
        ) VALUES (
          'run-schema', 'task-schema', 'step-schema', 'call-schema', 0,
          'bom_update', '1', ?, ?, 'write', 1, 'unknown',
          '{}', '{"code":"WRITE_OUTCOME_UNKNOWN","message":"Unknown","details":[]}',
          ?, 1, ?, ?, ?
        )
      `,
    )
    .run(
      digest("1"),
      digest("2"),
      digest("3"),
      timestamp,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO recovery_reviews (
          id, task_id, tool_run_id, status, note,
          review_protocol_version, decision_version,
          created_at, updated_at
        ) VALUES ('review-schema', 'task-schema', 'run-schema',
                  'pending', NULL, 1, 0, ?, ?)
      `,
    )
    .run(timestamp, timestamp);
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

const timestamp = "2026-01-01T00:00:00.000Z";
