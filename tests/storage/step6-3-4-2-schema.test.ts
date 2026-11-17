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

describe("Step 6.3.4.2 recovery verification schema", () => {
  it("upgrades v7 and preserves historical EvidenceRead fields as NULL", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 7));
    insertV7HistoricalRead(activeDatabase);

    expect(migrateStorage(activeDatabase)).toMatchObject({
      appliedVersions: [8, 9, 10, 11, 12],
      currentVersion: 12,
    });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT id, evidence_submission_id, readback_request_id,
                   read_attempt_id, verification_check_id, observed_at,
                   resource_version, resource_etag, result_payload_digest,
                   result_payload_store_ref, result_payload_storage_mode
            FROM recovery_evidence_reads
            WHERE id = 'evidence-read-v7'
          `,
        )
        .get(),
    ).toEqual({
      id: "evidence-read-v7",
      evidence_submission_id: null,
      readback_request_id: null,
      read_attempt_id: null,
      verification_check_id: null,
      observed_at: null,
      resource_version: null,
      resource_etag: null,
      result_payload_digest: null,
      result_payload_store_ref: null,
      result_payload_storage_mode: null,
    });

    for (const table of [
      "recovery_evidence_readback_requests",
      "recovery_evidence_read_attempts",
      "recovery_evidence_verification_checks",
      "recovery_evidence_verifications",
    ]) {
      expect(
        (
          activeDatabase.pragma(`table_info(${table})`) as Array<{
            name: string;
          }>
        ).length,
      ).toBeGreaterThan(0);
    }
    expect(
      activeDatabase
        .prepare(
          `
            SELECT name FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'recovery_evidence_readback_requests_validate_insert',
                'recovery_evidence_read_attempts_validate_transition',
                'recovery_evidence_verification_checks_validate_origin',
                'recovery_evidence_verifications_validate_availability_event',
                'recovery_evidence_reads_reject_update',
                'recovery_evidence_reads_reject_delete'
              )
            ORDER BY name
          `,
        )
        .all(),
    ).toHaveLength(6);
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'recovery_evidence_readback_requests_reject_terminal_task',
                'recovery_evidence_read_attempts_reject_terminal_task',
                'recovery_evidence_reads_reject_terminal_task_insert',
                'recovery_evidence_verification_checks_reject_terminal_task',
                'recovery_evidence_verifications_reject_terminal_task'
              )
          `,
        )
        .get(),
    ).toEqual({ count: 5 });
  });

  it("rolls back v8 when a new schema object cannot be created", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 7));
    activeDatabase.exec(
      "CREATE TABLE recovery_evidence_readback_requests (id TEXT PRIMARY KEY)",
    );

    expect(() => migrateStorage(activeDatabase)).toThrow(
      /already exists/i,
    );
    expect(
      activeDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 7 });
    const readColumns = activeDatabase.pragma(
      "table_info(recovery_evidence_reads)",
    ) as Array<{ name: string }>;
    expect(
      readColumns.some(
        (column) => column.name === "verification_check_id",
      ),
    ).toBe(false);
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM sqlite_master
            WHERE type = 'trigger'
              AND name = 'recovery_evidence_reads_reject_update'
          `,
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("creates the required composite indexes and append-only guards", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    migrateStorage(activeDatabase);

    const indexes = activeDatabase
      .prepare(
        `
          SELECT name FROM sqlite_master
          WHERE type = 'index'
            AND name IN (
              'ux_recovery_evidence_reads_task_verification_check',
              'ux_recovery_evidence_reads_submission_run',
              'ix_recovery_evidence_readback_requests_task',
              'ix_recovery_evidence_read_attempts_request',
              'ix_recovery_evidence_verification_checks_task',
              'ix_recovery_evidence_verifications_task'
            )
          ORDER BY name
        `,
      )
      .all();
    expect(indexes).toHaveLength(6);
    for (const table of [
      "recovery_evidence_readback_requests",
      "recovery_evidence_read_attempts",
      "recovery_evidence_verification_checks",
      "recovery_evidence_verifications",
      "recovery_evidence_reads",
    ]) {
      expect(
        activeDatabase.pragma(`foreign_key_check(${table})`),
      ).toEqual([]);
    }
  });
});

function insertV7HistoricalRead(database: ForgeFlowDatabase): void {
  const timestamp = "2026-11-08T00:00:00.000Z";
  database
    .prepare(
      `
        INSERT INTO tasks (
          id, trace_id, status, objective, system_prompt,
          max_model_turns, max_tool_calls, token_usage_json,
          created_at, updated_at
        ) VALUES (
          'task-v7', 'trace-v7', 'waiting_review', 'V7 history',
          'System', 10, 20, '{"source":"unknown"}', ?, ?
        )
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO model_calls (
          id, task_id, iteration, attempt_no, status,
          request_json, started_at
        ) VALUES ('model-v7', 'task-v7', 1, 1, 'requested', '{}', ?)
      `,
    )
    .run(timestamp);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          purpose, status, created_at, updated_at
        ) VALUES (
          'agent-plan-v7', 'task-v7', 1, 'model-v7',
          'agent', 'active', ?, ?
        )
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES (
          'agent-step-v7', 'task-v7', 'agent-plan-v7', 0,
          'write', 'waiting_review', ?, ?
        )
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
          'write-run-v7', 'task-v7', 'agent-step-v7', 'write-call-v7', 0,
          'bom_update', '1', ?, ?, 'write', 1, 'unknown',
          '{}', '{"code":"UNKNOWN","message":"Unknown","details":[]}',
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
        ) VALUES (
          'review-v7', 'task-v7', 'write-run-v7', 'pending', 1, 0, ?, ?
        )
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          purpose, status, created_at, updated_at
        ) VALUES (
          'evidence-plan-v7', 'task-v7', 2, 'model-v7',
          'recovery_evidence', 'active', ?, ?
        )
      `,
    )
    .run(timestamp, timestamp);
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES (
          'evidence-step-v7', 'task-v7', 'evidence-plan-v7', 0,
          'read_batch', 'completed', ?, ?
        )
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
          input_json, output_json, idempotency_key, attempt_no,
          started_at, finished_at, created_at, updated_at
        ) VALUES (
          'evidence-run-v7', 'task-v7', 'evidence-step-v7',
          'evidence-call-v7', 0, 'inventory_lookup', '1', ?, ?,
          'read', 0, 'succeeded', '{}', '{"status":"ok"}', ?, 1,
          ?, ?, ?, ?
        )
      `,
    )
    .run(
      digest("4"),
      digest("5"),
      digest("6"),
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO messages (
          id, task_id, sequence, role, content,
          tool_call_id, created_at
        ) VALUES (
          'message-v7', 'task-v7', 1, 'tool', '{"status":"ok"}',
          'evidence-call-v7', ?
        )
      `,
    )
    .run(timestamp);
  database
    .prepare(
      `
        INSERT INTO recovery_evidence_reads (
          id, task_id, review_id, tool_run_id,
          evidence_envelope_digest, created_at
        ) VALUES (
          'evidence-read-v7', 'task-v7', 'review-v7',
          'evidence-run-v7', ?, ?
        )
      `,
    )
    .run(digest("7"), timestamp);
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
