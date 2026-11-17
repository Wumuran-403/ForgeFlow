import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const REQUIRED_SHA256_DIGEST_CHECK = (column: string) => `
  length(${column}) = 71
  AND substr(${column}, 1, 7) = 'sha256:'
  AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
`;

const OPTIONAL_SHA256_DIGEST_CHECK = (column: string) => `
  ${column} IS NULL
  OR (
    length(${column}) = 71
    AND substr(${column}, 1, 7) = 'sha256:'
    AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
  )
`;

const PHASE3_STEP6_3_4_2_SCHEMA = `
  CREATE UNIQUE INDEX ux_recovery_evidence_submissions_task_id
    ON recovery_evidence_submissions(task_id, id);

  DROP TRIGGER recovery_evidence_reads_validate_binding_insert;
  DROP TRIGGER recovery_evidence_reads_reject_update;
  DROP TRIGGER recovery_evidence_reads_reject_delete;

  ALTER TABLE recovery_evidence_reads
    RENAME TO recovery_evidence_reads_v7;

  CREATE TABLE recovery_evidence_readback_requests (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    evidence_submission_id TEXT NOT NULL,
    original_tool_run_id TEXT NOT NULL,
    request_key TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_key")}),
    operation_id TEXT NOT NULL,
    execution_plan_id TEXT NOT NULL,
    plan_step_id TEXT NOT NULL,
    read_tool_run_id TEXT NOT NULL,
    verifier_id TEXT NOT NULL CHECK (length(trim(verifier_id)) > 0),
    verifier_version TEXT NOT NULL CHECK (length(trim(verifier_version)) > 0),
    verifier_config_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("verifier_config_digest")}),
    allowlist_id TEXT NOT NULL CHECK (length(trim(allowlist_id)) > 0),
    allowlist_version TEXT NOT NULL CHECK (length(trim(allowlist_version)) > 0),
    read_tool_name TEXT NOT NULL CHECK (length(trim(read_tool_name)) > 0),
    read_tool_version TEXT NOT NULL CHECK (length(trim(read_tool_version)) > 0),
    read_tool_schema_hash TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("read_tool_schema_hash")}),
    retry_safety TEXT NOT NULL CHECK (
      retry_safety IN ('immutable', 'version_conditional')
    ),
    consistency_mode TEXT NOT NULL CHECK (
      consistency_mode IN (
        'immutable_version',
        'etag_or_resource_version'
      )
    ),
    expected_resource_version TEXT,
    expected_etag TEXT,
    verification_check_id TEXT NOT NULL
      CHECK (length(trim(verification_check_id)) > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (request_key),
    UNIQUE (operation_id),
    UNIQUE (execution_plan_id),
    UNIQUE (plan_step_id),
    UNIQUE (read_tool_run_id),
    UNIQUE (task_id, id),
    UNIQUE (task_id, verification_check_id),
    UNIQUE (
      task_id,
      review_id,
      evidence_submission_id,
      original_tool_run_id
    ),
    CHECK (
      (
        retry_safety = 'immutable'
        AND consistency_mode = 'immutable_version'
        AND expected_resource_version IS NULL
        AND expected_etag IS NULL
      )
      OR (
        retry_safety = 'version_conditional'
        AND consistency_mode = 'etag_or_resource_version'
        AND (
          expected_resource_version IS NOT NULL
          OR expected_etag IS NOT NULL
        )
      )
    ),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_submission_id)
      REFERENCES recovery_evidence_submissions(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, original_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, operation_id)
      REFERENCES recovery_review_operations(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, execution_plan_id)
      REFERENCES execution_plans(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, plan_step_id)
      REFERENCES plan_steps(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, read_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_readback_requests_task
    ON recovery_evidence_readback_requests(task_id, created_at, id);

  CREATE TABLE recovery_evidence_read_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    readback_request_id TEXT NOT NULL,
    read_tool_run_id TEXT NOT NULL,
    attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
    retry_safety TEXT NOT NULL CHECK (
      retry_safety IN ('immutable', 'version_conditional')
    ),
    consistency_mode TEXT NOT NULL CHECK (
      consistency_mode IN (
        'immutable_version',
        'etag_or_resource_version'
      )
    ),
    attempt_status TEXT NOT NULL CHECK (
      attempt_status IN (
        'prepared',
        'dispatching',
        'interrupted',
        'completed',
        'failed',
        'timed_out',
        'cancelled',
        'blocked_by_intent'
      )
    ),
    prepared_at TEXT NOT NULL CHECK (length(trim(prepared_at)) > 0),
    dispatching_at TEXT,
    interrupted_at TEXT,
    completed_at TEXT,
    observed_at TEXT,
    resource_version TEXT,
    resource_etag TEXT,
    result_digest TEXT
      CHECK (${OPTIONAL_SHA256_DIGEST_CHECK("result_digest")}),
    result_payload_store_ref TEXT,
    reason_code TEXT,
    last_event_id TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    updated_at TEXT NOT NULL CHECK (length(trim(updated_at)) > 0),
    UNIQUE (readback_request_id, read_tool_run_id, attempt_number),
    UNIQUE (task_id, id),
    CHECK (
      (
        attempt_status = 'prepared'
        AND dispatching_at IS NULL
        AND interrupted_at IS NULL
        AND completed_at IS NULL
      )
      OR (
        attempt_status = 'dispatching'
        AND dispatching_at IS NOT NULL
        AND interrupted_at IS NULL
        AND completed_at IS NULL
      )
      OR (
        attempt_status = 'interrupted'
        AND interrupted_at IS NOT NULL
      )
      OR (
        attempt_status = 'completed'
        AND completed_at IS NOT NULL
        AND result_digest IS NOT NULL
        AND result_payload_store_ref IS NOT NULL
      )
      OR (
        attempt_status IN (
          'failed',
          'timed_out',
          'cancelled',
          'blocked_by_intent'
        )
        AND completed_at IS NOT NULL
      )
    ),
    CHECK (
      attempt_status IN ('prepared', 'dispatching', 'completed')
      OR reason_code IS NOT NULL
    ),
    FOREIGN KEY (task_id, readback_request_id)
      REFERENCES recovery_evidence_readback_requests(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, read_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, last_event_id)
      REFERENCES events(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_read_attempts_request
    ON recovery_evidence_read_attempts(
      task_id,
      readback_request_id,
      read_tool_run_id,
      attempt_number
    );

  CREATE TABLE recovery_evidence_reads (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    tool_run_id TEXT NOT NULL,
    evidence_envelope_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("evidence_envelope_digest")}),
    evidence_submission_id TEXT,
    readback_request_id TEXT,
    read_attempt_id TEXT,
    verification_check_id TEXT,
    observed_at TEXT,
    resource_version TEXT,
    resource_etag TEXT,
    result_payload_digest TEXT
      CHECK (${OPTIONAL_SHA256_DIGEST_CHECK("result_payload_digest")}),
    result_payload_store_ref TEXT,
    result_payload_storage_mode TEXT CHECK (
      result_payload_storage_mode IS NULL
      OR result_payload_storage_mode IN (
        'content_addressed_file',
        'reference_only'
      )
    ),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (review_id, tool_run_id),
    UNIQUE (task_id, id),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_submission_id)
      REFERENCES recovery_evidence_submissions(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, readback_request_id)
      REFERENCES recovery_evidence_readback_requests(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, read_attempt_id)
      REFERENCES recovery_evidence_read_attempts(task_id, id)
      ON DELETE RESTRICT
  );

  INSERT INTO recovery_evidence_reads (
    id, task_id, review_id, tool_run_id, evidence_envelope_digest, created_at
  )
  SELECT
    id, task_id, review_id, tool_run_id, evidence_envelope_digest, created_at
  FROM recovery_evidence_reads_v7;

  DROP TABLE recovery_evidence_reads_v7;

  CREATE INDEX ix_recovery_evidence_reads_task
    ON recovery_evidence_reads(task_id, created_at);

  CREATE UNIQUE INDEX ux_recovery_evidence_reads_task_verification_check
    ON recovery_evidence_reads(task_id, verification_check_id)
    WHERE verification_check_id IS NOT NULL;

  CREATE UNIQUE INDEX ux_recovery_evidence_reads_submission_run
    ON recovery_evidence_reads(evidence_submission_id, tool_run_id)
    WHERE evidence_submission_id IS NOT NULL;

  CREATE TABLE recovery_evidence_verification_checks (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    evidence_submission_id TEXT NOT NULL,
    original_tool_run_id TEXT NOT NULL,
    readback_request_id TEXT,
    evidence_read_id TEXT,
    verification_check_id TEXT NOT NULL
      CHECK (length(trim(verification_check_id)) > 0),
    request_key TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_key")}),
    check_origin TEXT NOT NULL CHECK (
      check_origin IN ('readback_transaction_b', 'stored_evidence_v0')
    ),
    verifier_id TEXT NOT NULL CHECK (length(trim(verifier_id)) > 0),
    verifier_version TEXT NOT NULL CHECK (length(trim(verifier_version)) > 0),
    verifier_config_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("verifier_config_digest")}),
    allowlist_id TEXT,
    allowlist_version TEXT,
    read_tool_name TEXT,
    read_tool_version TEXT,
    read_tool_schema_hash TEXT
      CHECK (${OPTIONAL_SHA256_DIGEST_CHECK("read_tool_schema_hash")}),
    expected_payload_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("expected_payload_digest")}),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (request_key),
    UNIQUE (task_id, id),
    UNIQUE (task_id, verification_check_id),
    UNIQUE (readback_request_id),
    CHECK (
      (
        check_origin = 'readback_transaction_b'
        AND readback_request_id IS NOT NULL
        AND evidence_read_id IS NULL
        AND allowlist_id IS NOT NULL
        AND length(trim(allowlist_id)) > 0
        AND allowlist_version IS NOT NULL
        AND length(trim(allowlist_version)) > 0
        AND read_tool_name IS NOT NULL
        AND length(trim(read_tool_name)) > 0
        AND read_tool_version IS NOT NULL
        AND length(trim(read_tool_version)) > 0
        AND read_tool_schema_hash IS NOT NULL
      )
      OR check_origin = 'stored_evidence_v0'
    ),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_submission_id)
      REFERENCES recovery_evidence_submissions(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, original_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, readback_request_id)
      REFERENCES recovery_evidence_readback_requests(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_read_id)
      REFERENCES recovery_evidence_reads(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_verification_checks_task
    ON recovery_evidence_verification_checks(
      task_id,
      check_origin,
      created_at,
      id
    );

  CREATE TABLE recovery_evidence_verifications (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    evidence_submission_id TEXT NOT NULL,
    original_tool_run_id TEXT NOT NULL,
    readback_request_id TEXT,
    evidence_read_id TEXT,
    read_attempt_id TEXT,
    verification_check_id TEXT NOT NULL,
    readback_result_provenance TEXT NOT NULL CHECK (
      readback_result_provenance IN (
        'none',
        'declared_payload',
        'controlled_runtime_read'
      )
    ),
    verifier_id TEXT NOT NULL CHECK (length(trim(verifier_id)) > 0),
    verifier_version TEXT NOT NULL CHECK (length(trim(verifier_version)) > 0),
    verifier_config_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("verifier_config_digest")}),
    allowlist_id TEXT,
    allowlist_version TEXT,
    request_key TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_key")}),
    availability_status TEXT NOT NULL CHECK (
      availability_status IN (
        'available',
        'unavailable',
        'expired',
        'replaced',
        'digest_mismatch'
      )
    ),
    integrity_status TEXT NOT NULL CHECK (
      integrity_status IN ('not_checked', 'matched', 'mismatch')
    ),
    authenticity_status TEXT NOT NULL CHECK (
      authenticity_status IN (
        'unverified',
        'manual_attested',
        'system_verified'
      )
    ),
    verification_status TEXT NOT NULL CHECK (
      verification_status IN (
        'not_run',
        'passed',
        'failed',
        'inconclusive'
      )
    ),
    expected_payload_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("expected_payload_digest")}),
    observed_payload_digest TEXT
      CHECK (${OPTIONAL_SHA256_DIGEST_CHECK("observed_payload_digest")}),
    reason_code TEXT NOT NULL CHECK (length(trim(reason_code)) > 0),
    redacted_summary TEXT,
    availability_event_id TEXT NOT NULL,
    verification_event_id TEXT,
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (request_key),
    UNIQUE (task_id, id),
    UNIQUE (task_id, verification_check_id),
    UNIQUE (availability_event_id),
    UNIQUE (verification_event_id),
    CHECK (
      (
        verification_status = 'not_run'
        AND verification_event_id IS NULL
      )
      OR (
        verification_status != 'not_run'
        AND verification_event_id IS NOT NULL
      )
    ),
    CHECK (
      (
        readback_result_provenance = 'controlled_runtime_read'
        AND readback_request_id IS NOT NULL
        AND evidence_read_id IS NOT NULL
        AND read_attempt_id IS NOT NULL
      )
      OR readback_result_provenance != 'controlled_runtime_read'
    ),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_submission_id)
      REFERENCES recovery_evidence_submissions(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, original_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, readback_request_id)
      REFERENCES recovery_evidence_readback_requests(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, evidence_read_id)
      REFERENCES recovery_evidence_reads(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, read_attempt_id)
      REFERENCES recovery_evidence_read_attempts(task_id, id)
      ON DELETE RESTRICT,
    FOREIGN KEY (task_id, verification_check_id)
      REFERENCES recovery_evidence_verification_checks(
        task_id,
        verification_check_id
      ) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, availability_event_id)
      REFERENCES events(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, verification_event_id)
      REFERENCES events(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_verifications_task
    ON recovery_evidence_verifications(task_id, created_at, id);

  CREATE TRIGGER recovery_evidence_readback_requests_validate_insert
  BEFORE INSERT ON recovery_evidence_readback_requests
  WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_evidence_submissions AS manifest
    JOIN recovery_reviews AS review
      ON review.id = NEW.review_id
      AND review.task_id = NEW.task_id
    JOIN tool_runs AS original_run
      ON original_run.id = NEW.original_tool_run_id
      AND original_run.task_id = NEW.task_id
    JOIN plan_steps AS original_step
      ON original_step.id = original_run.plan_step_id
      AND original_step.task_id = original_run.task_id
    JOIN execution_plans AS original_plan
      ON original_plan.id = original_step.plan_id
      AND original_plan.task_id = original_step.task_id
    JOIN model_calls AS original_model
      ON original_model.id = original_plan.source_model_call_id
      AND original_model.task_id = original_plan.task_id
    JOIN execution_plans AS read_plan
      ON read_plan.id = NEW.execution_plan_id
      AND read_plan.task_id = NEW.task_id
    JOIN model_calls AS read_model
      ON read_model.id = read_plan.source_model_call_id
      AND read_model.task_id = read_plan.task_id
    JOIN plan_steps AS read_step
      ON read_step.id = NEW.plan_step_id
      AND read_step.task_id = NEW.task_id
      AND read_step.plan_id = read_plan.id
    JOIN tool_runs AS read_run
      ON read_run.id = NEW.read_tool_run_id
      AND read_run.task_id = NEW.task_id
      AND read_run.plan_step_id = read_step.id
    JOIN recovery_review_operations AS operation
      ON operation.id = NEW.operation_id
      AND operation.task_id = NEW.task_id
    JOIN events AS event
      ON event.id = operation.applied_event_id
      AND event.task_id = NEW.task_id
    WHERE manifest.id = NEW.evidence_submission_id
      AND manifest.task_id = NEW.task_id
      AND manifest.review_id = NEW.review_id
      AND manifest.tool_run_id = NEW.original_tool_run_id
      AND review.tool_run_id = NEW.original_tool_run_id
      AND original_run.mode = 'write'
      AND original_run.status = 'unknown'
      AND original_plan.purpose = 'agent'
      AND original_model.status = 'completed'
      AND read_plan.purpose = 'recovery_evidence'
      AND read_model.status = 'completed'
      AND read_step.kind = 'read_batch'
      AND read_run.mode = 'read'
      AND read_run.tool_name = NEW.read_tool_name
      AND read_run.tool_version = NEW.read_tool_version
      AND read_run.input_schema_hash = NEW.read_tool_schema_hash
      AND operation.review_id = NEW.review_id
      AND operation.request_key = NEW.request_key
      AND operation.operation = 'request_readback'
      AND operation.status = 'accepted'
      AND operation.result_plan_id = NEW.execution_plan_id
      AND operation.result_tool_run_id = NEW.read_tool_run_id
      AND operation.applied_event_id IS NOT NULL
      AND event.type = 'recovery.readback_requested'
      AND event.entity_type = 'recovery_review'
      AND event.entity_id = NEW.review_id
      AND json_extract(event.payload_json, '$.operationId') =
        NEW.operation_id
      AND json_extract(event.payload_json, '$.requestKey') =
        NEW.request_key
      AND json_extract(event.payload_json, '$.readbackRequestId') =
        NEW.id
      AND json_extract(event.payload_json, '$.executionPlanId') =
        NEW.execution_plan_id
      AND json_extract(event.payload_json, '$.planStepId') =
        NEW.plan_step_id
      AND json_extract(event.payload_json, '$.readToolRunId') =
        NEW.read_tool_run_id
      AND json_extract(event.payload_json, '$.verificationCheckId') =
        NEW.verification_check_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'recovery readback request binding is invalid');
  END;

  CREATE TRIGGER recovery_evidence_readback_requests_reject_check_collision
  BEFORE INSERT ON recovery_evidence_readback_requests
  WHEN EXISTS (
    SELECT 1
    FROM recovery_evidence_verification_checks
    WHERE task_id = NEW.task_id
      AND verification_check_id = NEW.verification_check_id
  )
  BEGIN
    SELECT RAISE(ABORT, 'verification check id is already reserved');
  END;

  CREATE TRIGGER recovery_evidence_readback_requests_reject_update
  BEFORE UPDATE ON recovery_evidence_readback_requests
  BEGIN
    SELECT RAISE(ABORT, 'recovery readback requests are append-only');
  END;

  CREATE TRIGGER recovery_evidence_readback_requests_reject_delete
  BEFORE DELETE ON recovery_evidence_readback_requests
  BEGIN
    SELECT RAISE(ABORT, 'recovery readback requests are append-only');
  END;

  CREATE TRIGGER recovery_evidence_readback_requests_reject_terminal_task
  BEFORE INSERT ON recovery_evidence_readback_requests
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a readback request');
  END;

  CREATE TRIGGER recovery_evidence_read_attempts_validate_insert
  BEFORE INSERT ON recovery_evidence_read_attempts
  WHEN NEW.attempt_status != 'prepared'
    OR NEW.version != 1
    OR NEW.dispatching_at IS NOT NULL
    OR NEW.interrupted_at IS NOT NULL
    OR NEW.completed_at IS NOT NULL
    OR NOT EXISTS (
      SELECT 1
      FROM recovery_evidence_readback_requests AS request
      JOIN events AS event
        ON event.id = NEW.last_event_id
        AND event.task_id = NEW.task_id
      WHERE request.id = NEW.readback_request_id
        AND request.task_id = NEW.task_id
        AND request.read_tool_run_id = NEW.read_tool_run_id
        AND request.retry_safety = NEW.retry_safety
        AND request.consistency_mode = NEW.consistency_mode
        AND event.type = 'recovery.evidence.read_attempt_prepared'
        AND json_extract(event.payload_json, '$.readAttemptId') = NEW.id
        AND json_extract(event.payload_json, '$.attemptNumber') =
          NEW.attempt_number
        AND json_extract(event.payload_json, '$.attemptStatus') = 'prepared'
    )
  BEGIN
    SELECT RAISE(ABORT, 'recovery read attempt prepared binding is invalid');
  END;

  CREATE TRIGGER recovery_evidence_read_attempts_validate_transition
  BEFORE UPDATE ON recovery_evidence_read_attempts
  WHEN NEW.id != OLD.id
    OR NEW.task_id != OLD.task_id
    OR NEW.readback_request_id != OLD.readback_request_id
    OR NEW.read_tool_run_id != OLD.read_tool_run_id
    OR NEW.attempt_number != OLD.attempt_number
    OR NEW.created_at != OLD.created_at
    OR NEW.version != OLD.version + 1
    OR NEW.last_event_id = OLD.last_event_id
    OR NOT (
      (
        OLD.attempt_status = 'prepared'
        AND NEW.attempt_status IN (
          'dispatching',
          'cancelled',
          'blocked_by_intent'
        )
      )
      OR (
        OLD.attempt_status = 'dispatching'
        AND NEW.attempt_status IN (
          'completed',
          'interrupted',
          'failed',
          'timed_out',
          'cancelled'
        )
      )
    )
    OR NOT EXISTS (
      SELECT 1
      FROM events AS event
      WHERE event.id = NEW.last_event_id
        AND event.task_id = NEW.task_id
        AND event.type = CASE NEW.attempt_status
          WHEN 'dispatching' THEN 'recovery.evidence.read_attempt_dispatching'
          WHEN 'completed' THEN 'recovery.evidence.read_attempt_completed'
          WHEN 'interrupted' THEN 'recovery.evidence.read_attempt_interrupted'
          WHEN 'failed' THEN 'recovery.evidence.read_attempt_failed'
          WHEN 'timed_out' THEN 'recovery.evidence.read_attempt_timed_out'
          WHEN 'cancelled' THEN 'recovery.evidence.read_attempt_cancelled'
          WHEN 'blocked_by_intent' THEN
            'recovery.evidence.read_attempt_blocked_by_intent'
          ELSE '__invalid__'
        END
        AND json_extract(event.payload_json, '$.readAttemptId') = NEW.id
        AND json_extract(event.payload_json, '$.attemptNumber') =
          NEW.attempt_number
        AND json_extract(event.payload_json, '$.attemptStatus') =
          NEW.attempt_status
    )
  BEGIN
    SELECT RAISE(ABORT, 'recovery read attempt transition is invalid');
  END;

  CREATE TRIGGER recovery_evidence_read_attempts_reject_delete
  BEFORE DELETE ON recovery_evidence_read_attempts
  BEGIN
    SELECT RAISE(ABORT, 'recovery read attempts are retained');
  END;

  CREATE TRIGGER recovery_evidence_read_attempts_reject_terminal_task
  BEFORE INSERT ON recovery_evidence_read_attempts
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a read attempt');
  END;

  CREATE TRIGGER recovery_evidence_reads_validate_binding_insert
  BEFORE INSERT ON recovery_evidence_reads
  BEGIN
    SELECT RAISE(
      ABORT,
      'evidence read review binding is invalid'
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM recovery_reviews AS review
      WHERE review.id = NEW.review_id
        AND review.task_id = NEW.task_id
        AND review.review_protocol_version >= 1
        AND review.status IN ('pending', 'unresolved')
    );
    SELECT RAISE(
      ABORT,
      'evidence read tool run binding is invalid'
    )
    WHERE NOT EXISTS (
      SELECT 1
      FROM tool_runs AS evidence_run
      JOIN plan_steps AS evidence_step
        ON evidence_step.id = evidence_run.plan_step_id
        AND evidence_step.task_id = evidence_run.task_id
      JOIN execution_plans AS evidence_plan
        ON evidence_plan.id = evidence_step.plan_id
        AND evidence_plan.task_id = evidence_step.task_id
      WHERE evidence_run.id = NEW.tool_run_id
        AND evidence_run.task_id = NEW.task_id
        AND evidence_plan.purpose = 'recovery_evidence'
        AND evidence_step.kind = 'read_batch'
        AND evidence_run.mode = 'read'
        AND evidence_run.status = 'succeeded'
    );
    SELECT RAISE(
      ABORT,
      'evidence read tool message binding is invalid'
    )
    WHERE (
      SELECT COUNT(*)
      FROM tool_runs AS evidence_run
      JOIN messages AS message
        ON message.task_id = evidence_run.task_id
        AND message.role = 'tool'
        AND message.tool_call_id = evidence_run.call_id
      WHERE evidence_run.id = NEW.tool_run_id
        AND evidence_run.task_id = NEW.task_id
    ) != 1;
    SELECT RAISE(ABORT, 'controlled evidence read binding is incomplete')
    WHERE (
      NEW.evidence_submission_id IS NOT NULL
      OR NEW.readback_request_id IS NOT NULL
      OR NEW.read_attempt_id IS NOT NULL
      OR NEW.verification_check_id IS NOT NULL
      OR NEW.observed_at IS NOT NULL
      OR NEW.result_payload_digest IS NOT NULL
      OR NEW.result_payload_store_ref IS NOT NULL
      OR NEW.result_payload_storage_mode IS NOT NULL
    )
    AND (
      NEW.evidence_submission_id IS NULL
      OR NEW.readback_request_id IS NULL
      OR NEW.read_attempt_id IS NULL
      OR NEW.verification_check_id IS NULL
      OR NEW.observed_at IS NULL
      OR NEW.result_payload_digest IS NULL
      OR NEW.result_payload_store_ref IS NULL
      OR NEW.result_payload_storage_mode != 'content_addressed_file'
    );
    SELECT RAISE(ABORT, 'controlled evidence read relation is invalid')
    WHERE NEW.readback_request_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM recovery_evidence_readback_requests AS request
      JOIN recovery_evidence_verification_checks AS check_row
        ON check_row.task_id = request.task_id
        AND check_row.readback_request_id = request.id
        AND check_row.verification_check_id =
          request.verification_check_id
        AND check_row.check_origin = 'readback_transaction_b'
      JOIN recovery_evidence_read_attempts AS attempt
        ON attempt.id = NEW.read_attempt_id
        AND attempt.task_id = NEW.task_id
        AND attempt.readback_request_id = request.id
        AND attempt.read_tool_run_id = NEW.tool_run_id
        AND attempt.attempt_status = 'completed'
      WHERE request.id = NEW.readback_request_id
        AND request.task_id = NEW.task_id
        AND request.review_id = NEW.review_id
        AND request.evidence_submission_id = NEW.evidence_submission_id
        AND request.read_tool_run_id = NEW.tool_run_id
        AND request.verification_check_id = NEW.verification_check_id
        AND check_row.evidence_submission_id =
          NEW.evidence_submission_id
        AND check_row.expected_payload_digest =
          NEW.result_payload_digest
        AND (
          request.retry_safety != 'version_conditional'
          OR (
            (
              request.expected_resource_version IS NULL
              OR NEW.resource_version =
                request.expected_resource_version
            )
            AND (
              request.expected_etag IS NULL
              OR NEW.resource_etag = request.expected_etag
            )
          )
        )
    );
  END;

  CREATE TRIGGER recovery_evidence_reads_reject_update
  BEFORE UPDATE ON recovery_evidence_reads
  BEGIN
    SELECT RAISE(ABORT, 'recovery evidence reads are append-only');
  END;

  CREATE TRIGGER recovery_evidence_reads_reject_delete
  BEFORE DELETE ON recovery_evidence_reads
  BEGIN
    SELECT RAISE(ABORT, 'recovery evidence reads are append-only');
  END;

  CREATE TRIGGER recovery_evidence_reads_reject_terminal_task_insert
  BEFORE INSERT ON recovery_evidence_reads
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive an evidence read');
  END;

  CREATE TRIGGER recovery_evidence_verification_checks_validate_insert
  BEFORE INSERT ON recovery_evidence_verification_checks
  WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_evidence_submissions AS manifest
    JOIN recovery_reviews AS review
      ON review.id = NEW.review_id
      AND review.task_id = NEW.task_id
    JOIN tool_runs AS original_run
      ON original_run.id = NEW.original_tool_run_id
      AND original_run.task_id = NEW.task_id
    JOIN plan_steps AS original_step
      ON original_step.id = original_run.plan_step_id
      AND original_step.task_id = original_run.task_id
    JOIN execution_plans AS original_plan
      ON original_plan.id = original_step.plan_id
      AND original_plan.task_id = original_step.task_id
    WHERE manifest.id = NEW.evidence_submission_id
      AND manifest.task_id = NEW.task_id
      AND manifest.review_id = NEW.review_id
      AND manifest.tool_run_id = NEW.original_tool_run_id
      AND review.tool_run_id = NEW.original_tool_run_id
      AND original_run.mode = 'write'
      AND original_run.status = 'unknown'
      AND original_plan.purpose = 'agent'
  )
  BEGIN
    SELECT RAISE(ABORT, 'verification check original binding is invalid');
  END;

  CREATE TRIGGER recovery_evidence_verification_checks_validate_origin
  BEFORE INSERT ON recovery_evidence_verification_checks
  WHEN (
    NEW.check_origin = 'readback_transaction_b'
    AND NOT EXISTS (
      SELECT 1
      FROM recovery_evidence_readback_requests AS request
      WHERE request.id = NEW.readback_request_id
        AND request.task_id = NEW.task_id
        AND request.review_id = NEW.review_id
        AND request.evidence_submission_id =
          NEW.evidence_submission_id
        AND request.original_tool_run_id = NEW.original_tool_run_id
        AND request.read_tool_run_id IS NOT NULL
        AND request.read_tool_name = NEW.read_tool_name
        AND request.read_tool_version = NEW.read_tool_version
        AND request.read_tool_schema_hash =
          NEW.read_tool_schema_hash
        AND request.verifier_id = NEW.verifier_id
        AND request.verifier_version = NEW.verifier_version
        AND request.verifier_config_digest =
          NEW.verifier_config_digest
        AND request.allowlist_id = NEW.allowlist_id
        AND request.allowlist_version = NEW.allowlist_version
        AND request.verification_check_id =
          NEW.verification_check_id
    )
  )
  OR (
    NEW.check_origin = 'stored_evidence_v0'
    AND EXISTS (
      SELECT 1
      FROM recovery_evidence_readback_requests AS request
      WHERE request.task_id = NEW.task_id
        AND request.verification_check_id =
          NEW.verification_check_id
    )
  )
  OR (
    NEW.check_origin = 'stored_evidence_v0'
    AND NEW.readback_request_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM recovery_evidence_readback_requests AS request
      WHERE request.id = NEW.readback_request_id
        AND request.task_id = NEW.task_id
        AND request.review_id = NEW.review_id
        AND request.evidence_submission_id =
          NEW.evidence_submission_id
        AND request.original_tool_run_id = NEW.original_tool_run_id
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'verification check origin binding is invalid');
  END;

  CREATE TRIGGER recovery_evidence_verification_checks_reject_update
  BEFORE UPDATE ON recovery_evidence_verification_checks
  BEGIN
    SELECT RAISE(ABORT, 'verification checks are append-only');
  END;

  CREATE TRIGGER recovery_evidence_verification_checks_reject_delete
  BEFORE DELETE ON recovery_evidence_verification_checks
  BEGIN
    SELECT RAISE(ABORT, 'verification checks are append-only');
  END;

  CREATE TRIGGER recovery_evidence_verification_checks_reject_terminal_task
  BEFORE INSERT ON recovery_evidence_verification_checks
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a verification check');
  END;

  CREATE TRIGGER recovery_evidence_verifications_validate_insert
  BEFORE INSERT ON recovery_evidence_verifications
  WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_evidence_verification_checks AS check_row
    WHERE check_row.task_id = NEW.task_id
      AND check_row.verification_check_id =
        NEW.verification_check_id
      AND check_row.review_id = NEW.review_id
      AND check_row.evidence_submission_id =
        NEW.evidence_submission_id
      AND check_row.original_tool_run_id =
        NEW.original_tool_run_id
      AND check_row.readback_request_id IS NEW.readback_request_id
      AND check_row.verifier_id = NEW.verifier_id
      AND check_row.verifier_version = NEW.verifier_version
      AND check_row.verifier_config_digest =
        NEW.verifier_config_digest
      AND check_row.allowlist_id IS NEW.allowlist_id
      AND check_row.allowlist_version IS NEW.allowlist_version
      AND check_row.request_key = NEW.request_key
      AND (
        (
          check_row.check_origin = 'readback_transaction_b'
          AND check_row.expected_payload_digest =
            NEW.expected_payload_digest
          AND NEW.evidence_read_id IS NOT NULL
          AND EXISTS (
            SELECT 1
            FROM recovery_evidence_reads AS read_row
            WHERE read_row.id = NEW.evidence_read_id
              AND read_row.task_id = NEW.task_id
              AND read_row.readback_request_id =
                check_row.readback_request_id
              AND read_row.verification_check_id =
                check_row.verification_check_id
              AND read_row.read_attempt_id = NEW.read_attempt_id
          )
        )
        OR (
          check_row.check_origin = 'stored_evidence_v0'
          AND (
            check_row.evidence_read_id IS NULL
            OR check_row.evidence_read_id = NEW.evidence_read_id
          )
        )
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'verification does not match its check intent');
  END;

  CREATE TRIGGER recovery_evidence_verifications_validate_availability_event
  BEFORE INSERT ON recovery_evidence_verifications
  WHEN NOT EXISTS (
    SELECT 1
    FROM events AS event
    WHERE event.id = NEW.availability_event_id
      AND event.task_id = NEW.task_id
      AND event.type = 'recovery.evidence.availability_checked'
      AND event.entity_type = 'recovery_verification'
      AND event.entity_id = NEW.id
      AND json_extract(event.payload_json, '$.verificationId') = NEW.id
      AND json_extract(event.payload_json, '$.verificationCheckId') =
        NEW.verification_check_id
      AND json_extract(event.payload_json, '$.requestKey') =
        NEW.request_key
      AND json_extract(event.payload_json, '$.availabilityStatus') =
        NEW.availability_status
  )
  BEGIN
    SELECT RAISE(ABORT, 'verification availability event is invalid');
  END;

  CREATE TRIGGER recovery_evidence_verifications_validate_verification_event
  BEFORE INSERT ON recovery_evidence_verifications
  WHEN (
    NEW.verification_event_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM events AS event
      WHERE event.id = NEW.verification_event_id
        AND event.task_id = NEW.task_id
        AND event.type = 'recovery.evidence.verification_completed'
        AND event.entity_type = 'recovery_verification'
        AND event.entity_id = NEW.id
        AND json_extract(event.payload_json, '$.verificationId') = NEW.id
        AND json_extract(event.payload_json, '$.verificationCheckId') =
          NEW.verification_check_id
        AND json_extract(event.payload_json, '$.requestKey') =
          NEW.request_key
        AND json_extract(event.payload_json, '$.verificationStatus') =
          NEW.verification_status
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'verification completion event is invalid');
  END;

  CREATE TRIGGER recovery_evidence_verifications_reject_update
  BEFORE UPDATE ON recovery_evidence_verifications
  BEGIN
    SELECT RAISE(ABORT, 'verification results are append-only');
  END;

  CREATE TRIGGER recovery_evidence_verifications_reject_delete
  BEFORE DELETE ON recovery_evidence_verifications
  BEGIN
    SELECT RAISE(ABORT, 'verification results are append-only');
  END;

  CREATE TRIGGER recovery_evidence_verifications_reject_terminal_task
  BEFORE INSERT ON recovery_evidence_verifications
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a verification');
  END;
`;

export const phase3Step6_3_4_2Migration: Migration = {
  version: 8,
  name: "phase3_step6_3_4_2_verification_repository",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP6_3_4_2_SCHEMA);
  },
};
