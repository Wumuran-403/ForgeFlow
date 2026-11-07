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

const PHASE3_STEP6_3_1_SCHEMA = `
  ALTER TABLE execution_plans
    ADD COLUMN purpose TEXT NOT NULL DEFAULT 'agent'
      CHECK (purpose IN ('agent', 'recovery_evidence'));

  CREATE INDEX ix_execution_plans_task_purpose_version
    ON execution_plans(task_id, purpose, version);

  ALTER TABLE recovery_reviews
    ADD COLUMN review_protocol_version INTEGER NOT NULL DEFAULT 0
      CHECK (review_protocol_version >= 0);

  ALTER TABLE recovery_reviews
    ADD COLUMN decision_version INTEGER NOT NULL DEFAULT 0
      CHECK (decision_version >= 0);

  ALTER TABLE recovery_reviews
    ADD COLUMN evidence_payload_digest TEXT
      CHECK (${SHA256_DIGEST_CHECK("evidence_payload_digest")});

  ALTER TABLE recovery_reviews
    ADD COLUMN evidence_payload_type TEXT
      CHECK (
        evidence_payload_type IS NULL
        OR evidence_payload_type IN (
          'raw_bytes',
          'json',
          'external_reference',
          'readback_result'
        )
      );

  ALTER TABLE recovery_reviews
    ADD COLUMN evidence_digest_protocol TEXT
      CHECK (
        evidence_digest_protocol IS NULL
        OR evidence_digest_protocol IN (
          'sha256-raw-v1',
          'jcs-sha256-v1',
          'adapter-content-sha256-v1'
        )
      );

  ALTER TABLE recovery_reviews
    ADD COLUMN evidence_envelope_digest TEXT
      CHECK (${SHA256_DIGEST_CHECK("evidence_envelope_digest")});

  ALTER TABLE recovery_reviews
    ADD COLUMN actor_id TEXT;

  ALTER TABLE recovery_reviews
    ADD COLUMN verifier_id TEXT;

  ALTER TABLE recovery_reviews
    ADD COLUMN verification_id TEXT;

  ALTER TABLE recovery_reviews
    ADD COLUMN source_observed_at TEXT;

  ALTER TABLE recovery_reviews
    ADD COLUMN submitted_at TEXT;

  ALTER TABLE recovery_reviews
    ADD COLUMN verified_at TEXT;

  CREATE UNIQUE INDEX ux_events_task_id
    ON events(task_id, id);

  CREATE TABLE recovery_evidence_reads (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    review_id TEXT NOT NULL,
    tool_run_id TEXT NOT NULL,
    evidence_envelope_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("evidence_envelope_digest")}),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (review_id, tool_run_id),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_reads_task
    ON recovery_evidence_reads(task_id, created_at);

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

  CREATE TABLE recovery_legacy_attestations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    original_review_id TEXT NOT NULL,
    attestation_version INTEGER NOT NULL CHECK (attestation_version > 0),
    request_key TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_key")}),
    evidence_envelope_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("evidence_envelope_digest")}),
    evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) > 0),
    source_type TEXT NOT NULL CHECK (
      source_type IN ('manual_review', 'system_verification')
    ),
    actor_id TEXT,
    verifier_id TEXT,
    verification_id TEXT,
    source_observed_at TEXT NOT NULL
      CHECK (length(trim(source_observed_at)) > 0),
    submitted_at TEXT NOT NULL CHECK (length(trim(submitted_at)) > 0),
    verified_at TEXT NOT NULL CHECK (length(trim(verified_at)) > 0),
    result TEXT NOT NULL CHECK (
      result IN (
        'confirms_original',
        'contradicts_original',
        'inconclusive'
      )
    ),
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (original_review_id, attestation_version),
    UNIQUE (request_key),
    CHECK (
      (
        source_type = 'manual_review'
        AND actor_id IS NOT NULL
        AND length(trim(actor_id)) > 0
        AND verifier_id IS NULL
        AND verification_id IS NULL
      )
      OR (
        source_type = 'system_verification'
        AND actor_id IS NULL
        AND verifier_id IS NOT NULL
        AND length(trim(verifier_id)) > 0
        AND verification_id IS NOT NULL
        AND length(trim(verification_id)) > 0
      )
    ),
    FOREIGN KEY (task_id, original_review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_legacy_attestations_review
    ON recovery_legacy_attestations(task_id, original_review_id, attestation_version);

  CREATE TRIGGER recovery_legacy_attestations_validate_review
  BEFORE INSERT ON recovery_legacy_attestations
  WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_reviews
    WHERE id = NEW.original_review_id
      AND task_id = NEW.task_id
      AND review_protocol_version = 0
  )
  BEGIN
    SELECT RAISE(ABORT, 'legacy attestation requires a protocol v0 review');
  END;

  CREATE TRIGGER recovery_legacy_attestations_reject_update
  BEFORE UPDATE ON recovery_legacy_attestations
  BEGIN
    SELECT RAISE(ABORT, 'legacy attestations are append-only');
  END;

  CREATE TRIGGER recovery_legacy_attestations_reject_delete
  BEFORE DELETE ON recovery_legacy_attestations
  BEGIN
    SELECT RAISE(ABORT, 'legacy attestations are append-only');
  END;

  CREATE TABLE recovery_review_operations (
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
        'legacy_attest'
      )
    ),
    expected_decision_version INTEGER NOT NULL
      CHECK (expected_decision_version >= 0),
    resulting_decision_version INTEGER NOT NULL
      CHECK (resulting_decision_version > 0),
    status TEXT NOT NULL CHECK (length(trim(status)) > 0),
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
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, result_plan_id)
      REFERENCES execution_plans(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, result_tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, applied_event_id)
      REFERENCES events(task_id, id) ON DELETE RESTRICT
  );

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

export const phase3Step6_3_1Migration: Migration = {
  version: 4,
  name: "phase3_step6_3_1_recovery_evidence_contract",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP6_3_1_SCHEMA);
  },
};
