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

describe("Step 6.3.3.1 evidence audit schema", () => {
  it("creates immutable manifests with operation/event composite links", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;
    const columns = tableInfo(
      activeDatabase,
      "recovery_evidence_submissions",
    );
    for (const column of [
      "id",
      "task_id",
      "review_id",
      "tool_run_id",
      "operation_id",
      "request_key",
      "decision_version",
      "evidence_ref",
      "resource_ref",
      "resource_version",
      "source_observed_at",
      "submitted_at",
      "actor_id",
      "verifier_id",
      "verification_id",
      "payload_digest",
      "envelope_digest",
      "payload_store_ref",
      "payload_storage_mode",
      "applied_event_id",
    ]) {
      expect(columns.some((item) => item.name === column)).toBe(true);
    }

    expect(
      activeDatabase.pragma(
        "foreign_key_list(recovery_evidence_submissions)",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "recovery_reviews",
          from: "review_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "tool_runs",
          from: "tool_run_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "recovery_review_operations",
          from: "operation_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "events",
          from: "applied_event_id",
          to: "id",
        }),
      ]),
    );
    expect(
      activeDatabase
        .prepare(
          `
            SELECT name FROM sqlite_master
            WHERE type IN ('index', 'trigger')
              AND name IN (
                'ux_recovery_review_operations_task_id',
                'ix_recovery_evidence_submissions_review',
                'recovery_evidence_submissions_validate_operation',
                'recovery_evidence_submissions_reject_update',
                'recovery_evidence_submissions_reject_delete'
              )
            ORDER BY name
          `,
        )
        .all(),
    ).toEqual([
      { name: "ix_recovery_evidence_submissions_review" },
      { name: "recovery_evidence_submissions_reject_delete" },
      { name: "recovery_evidence_submissions_reject_update" },
      { name: "recovery_evidence_submissions_validate_operation" },
      { name: "ux_recovery_review_operations_task_id" },
    ]);
  });

  it("does not backfill historical submit_evidence operations", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 6));
    insertHistoricalSubmission(activeDatabase);

    expect(migrateStorage(activeDatabase)).toMatchObject({
      appliedVersions: [7, 8, 9, 10, 11, 12],
      currentVersion: 12,
    });
    expect(
      activeDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM recovery_evidence_submissions",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      activeDatabase
        .prepare(
          "SELECT operation, request_key, evidence_envelope_digest FROM recovery_review_operations",
        )
        .get(),
    ).toEqual({
      operation: "submit_evidence",
      request_key: digest("c"),
      evidence_envelope_digest: digest("b"),
    });
  });

  it("rolls back v7 when the manifest table cannot be created", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 6));
    activeDatabase.exec(
      "CREATE TABLE recovery_evidence_submissions (id TEXT PRIMARY KEY)",
    );

    expect(() => migrateStorage(activeDatabase)).toThrow(
      /recovery_evidence_submissions already exists/i,
    );
    expect(
      activeDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 6 });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM sqlite_master
            WHERE name = 'ux_recovery_review_operations_task_id'
          `,
        )
        .get(),
    ).toEqual({ count: 0 });
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

function insertHistoricalSubmission(database: ForgeFlowDatabase): void {
  database
    .prepare(
      `
        INSERT INTO tasks (
          id, trace_id, status, objective, system_prompt,
          max_model_turns, max_tool_calls, token_usage_json,
          created_at, updated_at
        ) VALUES ('task-history', 'trace-history', 'waiting_review',
                  'History', 'System', 10, 20, '{"source":"unknown"}', ?, ?)
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO model_calls (
          id, task_id, iteration, attempt_no, status, request_json, started_at
        ) VALUES ('model-history', 'task-history', 1, 1, 'requested', '{}', ?)
      `,
    )
    .run(timestamp);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          purpose, status, created_at, updated_at
        ) VALUES ('plan-history', 'task-history', 1, 'model-history',
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
        ) VALUES ('step-history', 'task-history', 'plan-history', 0,
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
          'run-history', 'task-history', 'step-history', 'call-history', 0,
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
          id, task_id, tool_run_id, status, review_protocol_version,
          decision_version, created_at, updated_at
        ) VALUES ('review-history', 'task-history', 'run-history',
                  'pending', 1, 1, ?, ?)
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO events (
          id, task_id, sequence, trace_id, type,
          entity_type, entity_id, payload_json, created_at
        ) VALUES ('event-history', 'task-history', 1, 'trace-history',
                  'recovery.evidence.submitted', 'recovery_review',
                  'review-history', '{}', ?)
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
          'operation-history', 'task-history', 'review-history', ?,
          'submit_evidence', 0, 1, 'applied', 'legacy-actor', ?,
          ?, NULL, NULL, 'event-history', ?
        )
      `,
    )
    .run(digest("c"), digest("b"), digest("b"), timestamp);
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

const timestamp = "2026-01-01T00:00:00.000Z";
