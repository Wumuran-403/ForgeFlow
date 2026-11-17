import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const SHA256_DIGEST_CHECK = (column: string) => `
  ${column} IS NULL
  OR (
    length(${column}) = 71
    AND substr(${column}, 1, 7) = 'sha256:'
    AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
  )
`;

const REQUIRED_SHA256_DIGEST_CHECK = (column: string) => `
  length(${column}) = 71
  AND substr(${column}, 1, 7) = 'sha256:'
  AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
`;

const PHASE3_STEP6_3_2_SCHEMA = `
  CREATE TABLE recovery_review_operations_v5 (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    request_key TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_key")}),
    operation TEXT NOT NULL CHECK (
      operation IN (
        'submit_evidence',
        'request_readback',
        'mark_unresolved',
        'confirm_succeeded',
        'confirm_not_executed',
        'legacy_attest',
        'advance_decision_version'
      )
    ),
    expected_decision_version INTEGER NOT NULL
      CHECK (expected_decision_version >= 0),
    resulting_decision_version INTEGER NOT NULL
      CHECK (resulting_decision_version > 0),
    status TEXT NOT NULL CHECK (status IN ('applied', 'accepted')),
    actor_id TEXT
      CHECK (actor_id IS NULL OR length(trim(actor_id)) > 0),
    operation_payload_digest TEXT
      CHECK (${SHA256_DIGEST_CHECK("operation_payload_digest")}),
    evidence_envelope_digest TEXT
      CHECK (${SHA256_DIGEST_CHECK("evidence_envelope_digest")}),
    result_plan_id TEXT,
    result_tool_run_id TEXT,
    applied_event_id TEXT,
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (request_key),
    UNIQUE (review_id, resulting_decision_version),
    UNIQUE (task_id, applied_event_id),
    CHECK (resulting_decision_version = expected_decision_version + 1),
    CHECK (
      (
        operation = 'request_readback'
        AND result_plan_id IS NOT NULL
        AND result_tool_run_id IS NOT NULL
      )
      OR (
        operation != 'request_readback'
        AND result_plan_id IS NULL
        AND result_tool_run_id IS NULL
      )
    ),
    CHECK (
      operation != 'advance_decision_version'
      OR (
        actor_id IS NOT NULL
        AND operation_payload_digest IS NOT NULL
        AND evidence_envelope_digest IS NULL
        AND result_plan_id IS NULL
        AND result_tool_run_id IS NULL
      )
    ),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, result_plan_id)
      REFERENCES execution_plans(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, result_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, applied_event_id)
      REFERENCES events(task_id, id) ON DELETE RESTRICT
  );

  INSERT INTO recovery_review_operations_v5 (
    id, task_id, review_id, request_key, operation,
    expected_decision_version, resulting_decision_version, status,
    actor_id, operation_payload_digest, evidence_envelope_digest,
    result_plan_id, result_tool_run_id, applied_event_id, created_at
  )
  SELECT
    id, task_id, review_id, request_key, operation,
    expected_decision_version, resulting_decision_version, status,
    NULL, NULL, evidence_envelope_digest,
    result_plan_id, result_tool_run_id, applied_event_id, created_at
  FROM recovery_review_operations;

  DROP TABLE recovery_review_operations;

  ALTER TABLE recovery_review_operations_v5
    RENAME TO recovery_review_operations;

  CREATE INDEX ix_recovery_review_operations_review
    ON recovery_review_operations(task_id, review_id, resulting_decision_version);

  CREATE TRIGGER recovery_review_operations_validate_readback
  BEFORE INSERT ON recovery_review_operations
  WHEN NEW.operation = 'request_readback'
    AND NOT EXISTS (
      SELECT 1
      FROM execution_plans AS plan
      JOIN plan_steps AS step
        ON step.plan_id = plan.id
        AND step.task_id = plan.task_id
      JOIN tool_runs AS tool_run
        ON tool_run.plan_step_id = step.id
        AND tool_run.task_id = step.task_id
      WHERE plan.id = NEW.result_plan_id
        AND plan.task_id = NEW.task_id
        AND plan.purpose = 'recovery_evidence'
        AND tool_run.id = NEW.result_tool_run_id
        AND tool_run.task_id = NEW.task_id
        AND tool_run.mode = 'read'
    )
  BEGIN
    SELECT RAISE(ABORT, 'request_readback must reference a recovery evidence read');
  END;

  CREATE TRIGGER recovery_review_operations_reject_update
  BEFORE UPDATE ON recovery_review_operations
  BEGIN
    SELECT RAISE(ABORT, 'recovery review operations are append-only');
  END;

  CREATE TRIGGER recovery_review_operations_reject_delete
  BEFORE DELETE ON recovery_review_operations
  BEGIN
    SELECT RAISE(ABORT, 'recovery review operations are append-only');
  END;
`;

export const phase3Step6_3_2Migration: Migration = {
  version: 5,
  name: "phase3_step6_3_2_lease_owned_decision_core",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP6_3_2_SCHEMA);
  },
};
