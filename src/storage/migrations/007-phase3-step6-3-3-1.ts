import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const REQUIRED_SHA256_DIGEST_CHECK = (column: string) => `
  length(${column}) = 71
  AND substr(${column}, 1, 7) = 'sha256:'
  AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
`;

const PHASE3_STEP6_3_3_1_SCHEMA = `
  CREATE UNIQUE INDEX ux_recovery_review_operations_task_id
    ON recovery_review_operations(task_id, id);

  CREATE TABLE recovery_evidence_submissions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    review_id TEXT NOT NULL,
    tool_run_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    request_key TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("request_key")}),
    decision_version INTEGER NOT NULL CHECK (decision_version > 0),
    source_type TEXT NOT NULL CHECK (
      source_type IN ('manual_review', 'system_verification')
    ),
    outcome TEXT NOT NULL CHECK (
      outcome IN (
        'observed_succeeded',
        'observed_not_executed',
        'inconclusive'
      )
    ),
    evidence_ref TEXT NOT NULL CHECK (length(trim(evidence_ref)) > 0),
    resource_ref TEXT,
    resource_version TEXT,
    source_observed_at TEXT NOT NULL
      CHECK (length(trim(source_observed_at)) > 0),
    submitted_at TEXT NOT NULL CHECK (length(trim(submitted_at)) > 0),
    actor_id TEXT,
    verifier_id TEXT,
    verification_id TEXT,
    payload_type TEXT NOT NULL CHECK (
      payload_type IN (
        'raw_bytes',
        'json',
        'external_reference',
        'readback_result'
      )
    ),
    payload_digest_protocol TEXT NOT NULL CHECK (
      payload_digest_protocol IN (
        'sha256-raw-v1',
        'jcs-sha256-v1',
        'adapter-content-sha256-v1'
      )
    ),
    payload_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("payload_digest")}),
    envelope_digest TEXT NOT NULL
      CHECK (${REQUIRED_SHA256_DIGEST_CHECK("envelope_digest")}),
    payload_store_ref TEXT,
    payload_storage_mode TEXT NOT NULL CHECK (
      payload_storage_mode IN (
        'content_addressed_file',
        'reference_only'
      )
    ),
    applied_event_id TEXT NOT NULL,
    created_at TEXT NOT NULL CHECK (length(trim(created_at)) > 0),
    UNIQUE (request_key),
    UNIQUE (operation_id),
    UNIQUE (applied_event_id),
    CHECK (
      (
        source_type = 'manual_review'
        AND actor_id IS NOT NULL
        AND verifier_id IS NULL
        AND verification_id IS NULL
      )
      OR (
        source_type = 'system_verification'
        AND actor_id IS NULL
        AND verifier_id IS NOT NULL
        AND verification_id IS NOT NULL
      )
    ),
    CHECK (
      (
        payload_type = 'external_reference'
        AND payload_storage_mode = 'reference_only'
        AND payload_store_ref IS NULL
        AND resource_ref IS NOT NULL
        AND resource_version IS NOT NULL
      )
      OR (
        payload_type != 'external_reference'
        AND payload_storage_mode = 'content_addressed_file'
        AND payload_store_ref IS NOT NULL
        AND length(trim(payload_store_ref)) > 0
      )
    ),
    FOREIGN KEY (task_id, review_id)
      REFERENCES recovery_reviews(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, operation_id)
      REFERENCES recovery_review_operations(task_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (task_id, applied_event_id)
      REFERENCES events(task_id, id) ON DELETE RESTRICT
  );

  CREATE INDEX ix_recovery_evidence_submissions_review
    ON recovery_evidence_submissions(task_id, review_id, decision_version);

  CREATE TRIGGER recovery_evidence_submissions_validate_operation
  BEFORE INSERT ON recovery_evidence_submissions
  WHEN NOT EXISTS (
    SELECT 1
    FROM recovery_review_operations AS operation
    JOIN events AS event
      ON event.id = operation.applied_event_id
      AND event.task_id = operation.task_id
    WHERE operation.id = NEW.operation_id
      AND operation.task_id = NEW.task_id
      AND operation.review_id = NEW.review_id
      AND operation.request_key = NEW.request_key
      AND operation.operation = 'submit_evidence'
      AND operation.status = 'applied'
      AND operation.resulting_decision_version = NEW.decision_version
      AND operation.evidence_envelope_digest = NEW.envelope_digest
      AND operation.applied_event_id = NEW.applied_event_id
      AND event.type = 'recovery.evidence.submitted'
      AND event.entity_type = 'recovery_review'
      AND event.entity_id = NEW.review_id
      AND json_extract(event.payload_json, '$.evidenceSubmissionId') = NEW.id
      AND json_extract(event.payload_json, '$.evidenceRef') = NEW.evidence_ref
      AND json_extract(event.payload_json, '$.envelopeDigest') = NEW.envelope_digest
  )
  BEGIN
    SELECT RAISE(ABORT, 'evidence submission does not match its operation and event');
  END;

  CREATE TRIGGER recovery_evidence_submissions_reject_update
  BEFORE UPDATE ON recovery_evidence_submissions
  BEGIN
    SELECT RAISE(ABORT, 'evidence submissions are immutable');
  END;

  CREATE TRIGGER recovery_evidence_submissions_reject_delete
  BEFORE DELETE ON recovery_evidence_submissions
  BEGIN
    SELECT RAISE(ABORT, 'evidence submissions are immutable');
  END;
`;

export const phase3Step6_3_3_1Migration: Migration = {
  version: 7,
  name: "phase3_step6_3_3_1_evidence_auditability",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP6_3_3_1_SCHEMA);
  },
};
