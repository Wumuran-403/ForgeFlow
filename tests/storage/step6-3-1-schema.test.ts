import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  PHASE3_STORAGE_MIGRATIONS,
  RecoveryEvidenceReadRepository,
  RecoveryLegacyAttestationRepository,
  RecoveryReviewOperationRepository,
  runInTransaction,
  runMigrations,
  type ForgeFlowDatabase,
  type SynchronousOperation,
} from "../../src/storage/index.js";
import {
  createStorageWritePermit,
  type StorageWritePermit,
} from "../../src/storage/write-boundary.js";
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

describe("Step 6.3.1 migration and schema", () => {
  it("adds purpose, review evidence fields, composite FKs, and unique indexes", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;

    const planColumns = tableInfo(activeDatabase, "execution_plans");
    expect(planColumns.find((column) => column.name === "purpose")).toMatchObject(
      {
        notnull: 1,
        dflt_value: "'agent'",
      },
    );

    const reviewColumns = tableInfo(activeDatabase, "recovery_reviews");
    for (const column of [
      "review_protocol_version",
      "decision_version",
    ]) {
      expect(reviewColumns.find((item) => item.name === column)).toMatchObject({
        notnull: 1,
        dflt_value: "0",
      });
    }
    for (const column of [
      "evidence_payload_digest",
      "evidence_payload_type",
      "evidence_digest_protocol",
      "evidence_envelope_digest",
      "actor_id",
      "verifier_id",
      "verification_id",
      "source_observed_at",
      "submitted_at",
      "verified_at",
    ]) {
      expect(reviewColumns.some((item) => item.name === column)).toBe(true);
    }

    expect(
      activeDatabase.pragma("foreign_key_list(recovery_evidence_reads)"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "recovery_reviews",
          from: "task_id",
          to: "task_id",
        }),
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
      ]),
    );
    expect(
      activeDatabase.pragma("foreign_key_list(recovery_review_operations)"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "recovery_reviews",
          from: "review_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "execution_plans",
          from: "result_plan_id",
          to: "id",
        }),
        expect.objectContaining({
          table: "tool_runs",
          from: "result_tool_run_id",
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
      activeDatabase.pragma(
        "foreign_key_list(recovery_legacy_attestations)",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "recovery_reviews",
          from: "task_id",
          to: "task_id",
        }),
        expect.objectContaining({
          table: "recovery_reviews",
          from: "original_review_id",
          to: "id",
        }),
      ]),
    );
    expect(activeDatabase.pragma("foreign_keys", { simple: true })).toBe(1);

    const indexes = activeDatabase
      .prepare(
        `
          SELECT name FROM sqlite_master
          WHERE type = 'index'
          ORDER BY name
        `,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "ux_events_task_id",
        "ix_execution_plans_task_purpose_version",
        "ix_recovery_evidence_reads_task",
        "ix_recovery_legacy_attestations_review",
        "ix_recovery_review_operations_review",
      ]),
    );
  });

  it("upgrades a Step 6.2 database without fabricating legacy evidence", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 3));
    insertLegacyTaskFixture(activeDatabase, "legacy");

    expect(migrateStorage(activeDatabase)).toMatchObject({
      appliedVersions: [4],
      currentVersion: 4,
    });

    const review = activeDatabase
      .prepare(
        `
          SELECT status, note, source_type, evidence_ref,
                 review_protocol_version, decision_version,
                 evidence_payload_digest, evidence_envelope_digest,
                 actor_id, verifier_id, verification_id
          FROM recovery_reviews
          WHERE id = 'review-legacy'
        `,
      )
      .get();
    expect(review).toEqual({
      status: "pending",
      note: "Legacy review",
      source_type: "manual_review",
      evidence_ref: "audit://legacy/review",
      review_protocol_version: 0,
      decision_version: 0,
      evidence_payload_digest: null,
      evidence_envelope_digest: null,
      actor_id: null,
      verifier_id: null,
      verification_id: null,
    });
    expect(
      activeDatabase
        .prepare(
          "SELECT purpose FROM execution_plans WHERE id = 'plan-legacy'",
        )
        .get(),
    ).toEqual({ purpose: "agent" });
    expect(
      activeDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM events WHERE id = 'event-legacy'",
        )
        .get(),
    ).toEqual({ count: 1 });
  });

  it("rolls the v4 migration back when a later statement fails", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(activeDatabase, PHASE3_STORAGE_MIGRATIONS.slice(0, 3));
    activeDatabase.exec(
      "CREATE TABLE recovery_evidence_reads (id TEXT PRIMARY KEY)",
    );

    expect(() => migrateStorage(activeDatabase)).toThrow(
      /recovery_evidence_reads already exists/i,
    );
    expect(
      tableInfo(activeDatabase, "execution_plans").some(
        (column) => column.name === "purpose",
      ),
    ).toBe(false);
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM sqlite_master
            WHERE name IN (
              'recovery_legacy_attestations',
              'recovery_review_operations',
              'ux_events_task_id'
            )
          `,
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      activeDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 3 });
  });

  it("rejects cross-task evidence, operation, and legacy attestation links", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;
    insertTaskShell(activeDatabase, "a");
    insertTaskShell(activeDatabase, "b");
    insertUnknownWriteReview(activeDatabase, "a", { protocolVersion: 1 });
    insertUnknownWriteReview(activeDatabase, "b", { protocolVersion: 1 });
    insertEvidenceReadFixture(activeDatabase, "a");
    insertTaskShell(activeDatabase, "legacy");
    insertUnknownWriteReview(activeDatabase, "legacy", {
      protocolVersion: 0,
    });

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new RecoveryEvidenceReadRepository(activeDatabase).insert(
          {
            id: "cross-task-evidence-read",
            taskId: "task-a",
            reviewId: "review-b",
            toolRunId: "evidence-run-a",
            evidenceEnvelopeDigest: digest("e"),
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new RecoveryReviewOperationRepository(activeDatabase).append(
          {
            id: "cross-task-operation",
            taskId: "task-a",
            reviewId: "review-a",
            requestKey: digest("d"),
            operation: "request_readback",
            expectedDecisionVersion: 0,
            resultingDecisionVersion: 1,
            status: "applied",
            evidenceEnvelopeDigest: null,
            resultPlanId: "evidence-plan-a",
            resultToolRunId: "evidence-run-b",
            appliedEventId: null,
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new RecoveryLegacyAttestationRepository(activeDatabase).append(
          {
            id: "cross-task-attestation",
            taskId: "task-a",
            originalReviewId: "review-legacy",
            attestationVersion: 1,
            requestKey: digest("f"),
            evidenceEnvelopeDigest: digest("e"),
            evidenceRef: "audit://legacy/attestation",
            sourceType: "manual_review",
            actorId: "reviewer-1",
            verifierId: null,
            verificationId: null,
            sourceObservedAt: timestamp,
            submittedAt: timestamp,
            verifiedAt: timestamp,
            result: "confirms_original",
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();
  });

  it("keeps evidence, attestation, and operation audit rows append-only", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;
    insertTaskShell(activeDatabase, "a");
    insertUnknownWriteReview(activeDatabase, "a", { protocolVersion: 1 });
    insertEvidenceReadFixture(activeDatabase, "a");
    insertTaskShell(activeDatabase, "legacy");
    insertUnknownWriteReview(activeDatabase, "legacy", {
      protocolVersion: 0,
    });

    const eventId = insertEvent(activeDatabase, "a", 1);
    expect(
      activeDatabase
        .prepare(
          `
            SELECT review.review_protocol_version, review.status,
                   plan.purpose, step.kind, tool_run.mode,
                   tool_run.status AS tool_status,
                   (
                     SELECT COUNT(*) FROM messages
                     WHERE task_id = tool_run.task_id
                       AND role = 'tool'
                       AND tool_call_id = tool_run.call_id
                   ) AS message_count
            FROM recovery_reviews AS review
            JOIN tool_runs AS tool_run
              ON tool_run.task_id = review.task_id
              AND tool_run.id = 'evidence-run-a'
            JOIN plan_steps AS step
              ON step.id = tool_run.plan_step_id
            JOIN execution_plans AS plan
              ON plan.id = step.plan_id
            WHERE review.id = 'review-a'
          `,
        )
        .get(),
    ).toEqual({
      review_protocol_version: 1,
      status: "pending",
      purpose: "recovery_evidence",
      kind: "read_batch",
      mode: "read",
      tool_status: "succeeded",
      message_count: 1,
    });
    writeWithPermit(activeDatabase, (permit) =>
      new RecoveryEvidenceReadRepository(activeDatabase).insert(
        {
          id: "evidence-read-a",
          taskId: "task-a",
          reviewId: "review-a",
          toolRunId: "evidence-run-a",
          evidenceEnvelopeDigest: digest("e"),
          createdAt: timestamp,
        },
        permit,
      ),
    );
    writeWithPermit(activeDatabase, (permit) =>
      new RecoveryLegacyAttestationRepository(activeDatabase).append(
        {
          id: "attestation-legacy",
          taskId: "task-legacy",
          originalReviewId: "review-legacy",
          attestationVersion: 1,
          requestKey: digest("f"),
          evidenceEnvelopeDigest: digest("e"),
          evidenceRef: "audit://legacy/attestation",
          sourceType: "manual_review",
          actorId: "reviewer-1",
          verifierId: null,
          verificationId: null,
          sourceObservedAt: timestamp,
          submittedAt: timestamp,
          verifiedAt: timestamp,
          result: "confirms_original",
          createdAt: timestamp,
        },
        permit,
      ),
    );
    writeWithPermit(activeDatabase, (permit) =>
      new RecoveryReviewOperationRepository(activeDatabase).append(
        {
          id: "operation-a",
          taskId: "task-a",
          reviewId: "review-a",
          requestKey: digest("d"),
          operation: "request_readback",
          expectedDecisionVersion: 0,
          resultingDecisionVersion: 1,
          status: "applied",
          evidenceEnvelopeDigest: null,
          resultPlanId: "evidence-plan-a",
          resultToolRunId: "evidence-run-a",
          appliedEventId: eventId,
          createdAt: timestamp,
        },
        permit,
      ),
    );

    for (const table of [
      "recovery_evidence_reads",
      "recovery_legacy_attestations",
      "recovery_review_operations",
    ]) {
      expect(() =>
        activeDatabase
          .prepare(`UPDATE ${table} SET created_at = created_at`)
          .run(),
      ).toThrow(/append-only/);
      expect(() =>
        activeDatabase.prepare(`DELETE FROM ${table}`).run(),
      ).toThrow(/append-only/);
    }
  });

  it("rejects invalid plan purposes and protocol field values", () => {
    openMigratedDatabase();
    const activeDatabase = database as ForgeFlowDatabase;
    insertLegacyTaskFixture(activeDatabase, "constraints", {
      reviewProtocolVersion: 1,
    });

    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE execution_plans SET purpose = 'invalid' WHERE id = 'plan-constraints'",
        )
        .run(),
    ).toThrow();
    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE recovery_reviews SET evidence_payload_type = 'invalid' WHERE id = 'review-constraints'",
        )
        .run(),
    ).toThrow();
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
): Array<{
  name: string;
  notnull: number;
  dflt_value: string | null;
}> {
  return database.pragma(`table_info(${table})`) as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function insertTaskShell(database: ForgeFlowDatabase, suffix: string): void {
  database
    .prepare(
      `
        INSERT INTO tasks (
          id, trace_id, status, objective, system_prompt,
          max_model_turns, max_tool_calls, token_usage_json,
          created_at, updated_at
        ) VALUES (?, ?, 'waiting_review', ?, ?, 10, 20, ?, ?, ?)
      `,
    )
    .run(
      `task-${suffix}`,
      `trace-${suffix}`,
      "Evidence schema test",
      "You are ForgeFlow.",
      JSON.stringify({ source: "unknown" }),
      timestamp,
      timestamp,
    );
}

function insertLegacyTaskFixture(
  database: ForgeFlowDatabase,
  suffix: string,
  options: { readonly reviewProtocolVersion?: number } = {},
): void {
  insertTaskShell(database, suffix);
  insertModelCall(database, suffix);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          status, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'active', ?, ?)
      `,
    )
    .run(
      `plan-${suffix}`,
      `task-${suffix}`,
      `model-${suffix}`,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'write', 'waiting_review', ?, ?)
      `,
    )
    .run(
      `step-${suffix}`,
      `task-${suffix}`,
      `plan-${suffix}`,
      timestamp,
      timestamp,
    );
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
          ?, ?, ?, ?, 0,
          'bom_update', '1', ?,
          ?, 'write', 1, 'unknown',
          '{}', ?, ?, 1,
          ?, ?, ?
        )
      `,
    )
    .run(
      `run-${suffix}`,
      `task-${suffix}`,
      `step-${suffix}`,
      `call-${suffix}`,
      digest("a"),
      digest("b"),
      JSON.stringify({
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Unknown write.",
        details: [],
      }),
      digest("c"),
      timestamp,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO messages (
          id, task_id, sequence, role, content, tool_call_id, created_at
        ) VALUES (?, ?, 1, 'tool', ?, ?, ?)
      `,
    )
    .run(
      `message-${suffix}`,
      `task-${suffix}`,
      '{"status":"unknown"}',
      `call-${suffix}`,
      timestamp,
    );
  if (
    tableInfo(database, "recovery_reviews").some(
      (column) => column.name === "review_protocol_version",
    )
  ) {
    database
      .prepare(
        `
          INSERT INTO recovery_reviews (
            id, task_id, tool_run_id, status, note, source_type,
            evidence_ref, review_protocol_version, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, 'manual_review', ?, ?, ?, ?)
        `,
      )
      .run(
        `review-${suffix}`,
        `task-${suffix}`,
        `run-${suffix}`,
        "Legacy review",
        "audit://legacy/review",
        options.reviewProtocolVersion ?? 0,
        timestamp,
        timestamp,
      );
  } else {
    database
      .prepare(
        `
          INSERT INTO recovery_reviews (
            id, task_id, tool_run_id, status, note, source_type,
            evidence_ref, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, 'manual_review', ?, ?, ?)
        `,
      )
      .run(
        `review-${suffix}`,
        `task-${suffix}`,
        `run-${suffix}`,
        "Legacy review",
        "audit://legacy/review",
        timestamp,
        timestamp,
      );
  }
  if (suffix === "legacy") {
    insertEvent(database, suffix, 1, "event-legacy");
  }
}

function insertUnknownWriteReview(
  database: ForgeFlowDatabase,
  suffix: string,
  options: { readonly protocolVersion: number },
): void {
  insertModelCall(database, suffix);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          purpose, status, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'agent', 'active', ?, ?)
      `,
    )
    .run(
      `plan-${suffix}`,
      `task-${suffix}`,
      `model-${suffix}`,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'write', 'waiting_review', ?, ?)
      `,
    )
    .run(
      `step-${suffix}`,
      `task-${suffix}`,
      `plan-${suffix}`,
      timestamp,
      timestamp,
    );
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
          ?, ?, ?, ?, 0,
          'bom_update', '1', ?,
          ?, 'write', 1, 'unknown',
          '{}', ?, ?, 1,
          ?, ?, ?
        )
      `,
    )
    .run(
      `run-${suffix}`,
      `task-${suffix}`,
      `step-${suffix}`,
      `call-${suffix}`,
      digest("a"),
      digest("b"),
      JSON.stringify({
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Unknown write.",
        details: [],
      }),
      digest(characterFor(suffix, "c")),
      timestamp,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO recovery_reviews (
          id, task_id, tool_run_id, status, note,
          review_protocol_version, created_at, updated_at
        ) VALUES (?, ?, ?, 'pending', NULL, ?, ?, ?)
      `,
    )
    .run(
      `review-${suffix}`,
      `task-${suffix}`,
      `run-${suffix}`,
      options.protocolVersion,
      timestamp,
      timestamp,
    );
}

function insertEvidenceReadFixture(
  database: ForgeFlowDatabase,
  suffix: string,
): void {
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          purpose, status, created_at, updated_at
        ) VALUES (?, ?, 2, ?, 'recovery_evidence', 'active', ?, ?)
      `,
    )
    .run(
      `evidence-plan-${suffix}`,
      `task-${suffix}`,
      `model-${suffix}`,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'read_batch', 'completed', ?, ?)
      `,
    )
    .run(
      `evidence-step-${suffix}`,
      `task-${suffix}`,
      `evidence-plan-${suffix}`,
      timestamp,
      timestamp,
    );
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
          ?, ?, ?, ?, 0,
          'ledger.read', '1', ?,
          ?, 'read', 0, 'succeeded',
          '{}', '{}', ?, 1,
          ?, ?, ?, ?
        )
      `,
    )
    .run(
      `evidence-run-${suffix}`,
      `task-${suffix}`,
      `evidence-step-${suffix}`,
      `evidence-call-${suffix}`,
      digest("a"),
      digest("b"),
      digest("9"),
      timestamp,
      timestamp,
      timestamp,
      timestamp,
    );
  database
    .prepare(
      `
        INSERT INTO messages (
          id, task_id, sequence, role, content, tool_call_id, created_at
        ) VALUES (?, ?, 2, 'tool', ?, ?, ?)
      `,
    )
    .run(
      `evidence-message-${suffix}`,
      `task-${suffix}`,
      '{"status":"succeeded"}',
      `evidence-call-${suffix}`,
      timestamp,
    );
}

function insertModelCall(database: ForgeFlowDatabase, suffix: string): void {
  database
    .prepare(
      `
        INSERT INTO model_calls (
          id, task_id, iteration, attempt_no, status,
          request_json, started_at
        ) VALUES (?, ?, 1, 1, 'requested', '{}', ?)
      `,
    )
    .run(`model-${suffix}`, `task-${suffix}`, timestamp);
}

function insertEvent(
  database: ForgeFlowDatabase,
  suffix: string,
  sequence: number,
  id = `event-${suffix}-${sequence}`,
): string {
  database
    .prepare(
      `
        INSERT INTO events (
          id, task_id, sequence, trace_id, type, payload_json, created_at
        ) VALUES (?, ?, ?, ?, 'test.event', '{}', ?)
      `,
    )
    .run(
      id,
      `task-${suffix}`,
      sequence,
      `trace-${suffix}`,
      timestamp,
    );
  return id;
}

function writeWithPermit<T>(
  database: ForgeFlowDatabase,
  operation: SynchronousOperation<T, [StorageWritePermit]>,
): T {
  return runInTransaction(
    database,
    () => operation(createStorageWritePermit(database)),
    "immediate",
  );
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function characterFor(value: string, fallback: string): string {
  const character = value.charCodeAt(0);
  return character >= 0 && character <= 255
    ? character.toString(16).padStart(2, "0").at(-1) as string
    : fallback;
}

const timestamp = "2026-01-01T00:00:00.000Z";
