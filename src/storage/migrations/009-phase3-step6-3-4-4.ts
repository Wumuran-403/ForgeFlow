import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const REQUIRED_SHA256_DIGEST_CHECK = (column: string) => `
  length(${column}) = 71
  AND substr(${column}, 1, 7) = 'sha256:'
  AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
`;

const OWNER_TOKEN_CHECK = (column: string) => `
  length(${column}) = 64
  AND ${column} NOT GLOB '*[^0-9a-f]*'
`;

const COMPLETED_TRANSACTION_A_INVARIANT = `
  EXISTS (
    SELECT 1
    FROM recovery_evidence_readback_requests AS request
    JOIN recovery_review_operations AS operation
      ON operation.id = NEW.operation_id
      AND operation.task_id = request.task_id
      AND operation.review_id = request.review_id
      AND operation.request_key = request.request_key
    JOIN execution_plans AS plan
      ON plan.id = NEW.execution_plan_id
      AND plan.task_id = request.task_id
    JOIN plan_steps AS step
      ON step.id = NEW.plan_step_id
      AND step.task_id = request.task_id
      AND step.plan_id = plan.id
    JOIN tool_runs AS read_run
      ON read_run.id = NEW.read_tool_run_id
      AND read_run.task_id = request.task_id
      AND read_run.plan_step_id = step.id
    JOIN recovery_evidence_read_attempts AS attempt
      ON attempt.id = NEW.read_attempt_id
      AND attempt.task_id = request.task_id
      AND attempt.readback_request_id = request.id
      AND attempt.read_tool_run_id = read_run.id
    JOIN events AS request_event
      ON request_event.id = operation.applied_event_id
      AND request_event.task_id = request.task_id
    WHERE request.id = NEW.request_id
      AND request.task_id = NEW.task_id
      AND request.review_id = NEW.review_id
      AND request.evidence_submission_id = NEW.evidence_submission_id
      AND request.original_tool_run_id = NEW.original_tool_run_id
      AND request.operation_id = NEW.operation_id
      AND request.execution_plan_id = NEW.execution_plan_id
      AND request.plan_step_id = NEW.plan_step_id
      AND request.read_tool_run_id = NEW.read_tool_run_id
      AND request.verification_check_id = NEW.verification_check_id
      AND operation.operation = 'request_readback'
      AND operation.status = 'accepted'
      AND operation.result_plan_id = NEW.execution_plan_id
      AND operation.result_tool_run_id = NEW.read_tool_run_id
      AND request_event.type = 'recovery.readback_requested'
      AND plan.purpose = 'recovery_evidence'
      AND plan.status = 'active'
      AND step.kind = 'read_batch'
      AND step.status = 'queued'
      AND read_run.mode = 'read'
      AND read_run.status = 'queued'
      AND attempt.attempt_status = 'prepared'
      AND attempt.attempt_number = 1
  )
`;

const PHASE3_STEP6_3_4_4_SCHEMA = `
  CREATE TABLE recovery_evidence_readback_request_reservations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    evidence_submission_id TEXT NOT NULL,
    original_tool_run_id TEXT NOT NULL,
    request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
    operation_id TEXT NOT NULL CHECK (length(trim(operation_id)) > 0),
    execution_plan_id TEXT NOT NULL
      CHECK (length(trim(execution_plan_id)) > 0),
    plan_step_id TEXT NOT NULL CHECK (length(trim(plan_step_id)) > 0),
    read_tool_run_id TEXT NOT NULL
      CHECK (length(trim(read_tool_run_id)) > 0),
    read_attempt_id TEXT NOT NULL
      CHECK (length(trim(read_attempt_id)) > 0),
    verification_check_id TEXT NOT NULL
      CHECK (length(trim(verification_check_id)) > 0),
    request_intent_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_intent_digest")}),
    owner_token TEXT NOT NULL CHECK (${OWNER_TOKEN_CHECK("owner_token")}),
    owner_fencing_token INTEGER NOT NULL
      CHECK (owner_fencing_token > 0),
    status TEXT NOT NULL CHECK (
      status IN ('preparing', 'completed', 'abandoned')
    ),
    reservation_version INTEGER NOT NULL DEFAULT 1
      CHECK (reservation_version > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    UNIQUE (task_id, id),
    UNIQUE (
      task_id,
      review_id,
      evidence_submission_id,
      original_tool_run_id
    ),
    UNIQUE (task_id, verification_check_id),
    UNIQUE (request_id),
    UNIQUE (operation_id),
    UNIQUE (execution_plan_id),
    UNIQUE (plan_step_id),
    UNIQUE (read_tool_run_id),
    UNIQUE (read_attempt_id),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_submission_id)
      REFERENCES recovery_evidence_submissions(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, original_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_readback_reservations_task_status
    ON recovery_evidence_readback_request_reservations(
      task_id,
      status,
      updated_at,
      id
    );

  CREATE TRIGGER recovery_evidence_readback_reservations_validate_insert
  BEFORE INSERT ON recovery_evidence_readback_request_reservations
  WHEN NEW.status != 'preparing'
    OR NEW.reservation_version != 1
    OR NEW.created_at != NEW.updated_at
    OR NOT EXISTS (
      SELECT 1
      FROM tasks AS task
      JOIN recovery_reviews AS review
        ON review.task_id = task.id
        AND review.id = NEW.review_id
      JOIN recovery_evidence_submissions AS submission
        ON submission.task_id = task.id
        AND submission.id = NEW.evidence_submission_id
      JOIN tool_runs AS original_run
        ON original_run.task_id = task.id
        AND original_run.id = NEW.original_tool_run_id
      WHERE task.id = NEW.task_id
        AND task.status = 'waiting_review'
        AND review.status IN ('pending', 'unresolved')
        AND review.tool_run_id = NEW.original_tool_run_id
        AND submission.review_id = NEW.review_id
        AND submission.tool_run_id = NEW.original_tool_run_id
        AND original_run.mode = 'write'
        AND original_run.status = 'unknown'
    )
  BEGIN
    SELECT RAISE(ABORT, 'recovery readback reservation insert is invalid');
  END;

  CREATE TRIGGER recovery_evidence_readback_reservations_validate_transition
  BEFORE UPDATE ON recovery_evidence_readback_request_reservations
  WHEN NEW.id != OLD.id
    OR NEW.task_id != OLD.task_id
    OR NEW.review_id != OLD.review_id
    OR NEW.evidence_submission_id != OLD.evidence_submission_id
    OR NEW.original_tool_run_id != OLD.original_tool_run_id
    OR NEW.request_id != OLD.request_id
    OR NEW.operation_id != OLD.operation_id
    OR NEW.execution_plan_id != OLD.execution_plan_id
    OR NEW.plan_step_id != OLD.plan_step_id
    OR NEW.read_tool_run_id != OLD.read_tool_run_id
    OR NEW.read_attempt_id != OLD.read_attempt_id
    OR NEW.verification_check_id != OLD.verification_check_id
    OR NEW.request_intent_digest != OLD.request_intent_digest
    OR NEW.created_at != OLD.created_at
    OR NEW.reservation_version != OLD.reservation_version + 1
    OR NEW.updated_at < OLD.updated_at
    OR NOT (
      (
        OLD.status = 'preparing'
        AND NEW.status = 'completed'
        AND NEW.owner_token = OLD.owner_token
        AND NEW.owner_fencing_token = OLD.owner_fencing_token
        AND ${COMPLETED_TRANSACTION_A_INVARIANT}
      )
      OR (
        OLD.status = 'preparing'
        AND NEW.status = 'abandoned'
        AND NEW.owner_token = OLD.owner_token
        AND NEW.owner_fencing_token = OLD.owner_fencing_token
      )
      OR (
        OLD.status = 'preparing'
        AND NEW.status = 'preparing'
        AND NEW.owner_token != OLD.owner_token
        AND NEW.owner_fencing_token > OLD.owner_fencing_token
      )
      OR (
        OLD.status = 'abandoned'
        AND NEW.status = 'preparing'
        AND NEW.owner_token != OLD.owner_token
        AND NEW.owner_fencing_token > OLD.owner_fencing_token
      )
    )
  BEGIN
    SELECT RAISE(ABORT, 'recovery readback reservation transition is invalid');
  END;

  CREATE TRIGGER recovery_evidence_readback_reservations_reject_delete
  BEFORE DELETE ON recovery_evidence_readback_request_reservations
  BEGIN
    SELECT RAISE(ABORT, 'recovery readback reservations are retained');
  END;
`;

export const phase3Step6_3_4_4Migration: Migration = {
  version: 9,
  name: "phase3_step6_3_4_4_reservation_foundation",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP6_3_4_4_SCHEMA);
  },
};
