import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const PLAN_STATUS_CHECK = `
  status IN ('active', 'completed', 'failed', 'cancelled')
`;

const PLAN_STEP_STATUS_CHECK = `
  status IN (
    'queued',
    'running',
    'awaiting_approval',
    'waiting_review',
    'interrupted',
    'completed',
    'failed',
    'skipped',
    'cancelled'
  )
`;

const TOOL_RUN_STATUS_CHECK = `
  status IN (
    'queued',
    'awaiting_approval',
    'running',
    'interrupted',
    'succeeded',
    'failed',
    'timed_out',
    'unknown',
    'cancelled',
    'skipped'
  )
`;

const SHA256_HASH_CHECK = (column: string) => `
  length(${column}) = 71
  AND substr(${column}, 1, 7) = 'sha256:'
  AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*'
`;

const PLAN_STEP_COMPLETION_BLOCKER = `
  tool_run.status IN (
    'queued',
    'awaiting_approval',
    'running',
    'interrupted'
  )
  OR (
    tool_run.status = 'unknown'
    AND (
      recovery_review.id IS NULL
      OR recovery_review.status != 'confirmed_succeeded'
    )
  )
`;

const PHASE3_STEP3_SCHEMA = `
  CREATE UNIQUE INDEX ux_model_calls_task_id
    ON model_calls(task_id, id);

  CREATE TABLE execution_plans (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    version INTEGER NOT NULL CHECK (version > 0),
    source_model_call_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (${PLAN_STATUS_CHECK}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, version),
    UNIQUE (task_id, id),
    FOREIGN KEY (task_id, source_model_call_id)
      REFERENCES model_calls(task_id, id) ON DELETE RESTRICT
  );

  CREATE TABLE plan_steps (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    plan_id TEXT NOT NULL,
    step_index INTEGER NOT NULL CHECK (step_index >= 0),
    kind TEXT NOT NULL CHECK (kind IN ('read_batch', 'write', 'unknown_tool')),
    status TEXT NOT NULL CHECK (${PLAN_STEP_STATUS_CHECK}),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (plan_id, step_index),
    UNIQUE (task_id, id),
    FOREIGN KEY (task_id, plan_id)
      REFERENCES execution_plans(task_id, id) ON DELETE RESTRICT
  );

  CREATE TABLE tool_runs (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    plan_step_id TEXT NOT NULL,
    call_id TEXT NOT NULL,
    original_index INTEGER NOT NULL CHECK (original_index >= 0),
    tool_name TEXT NOT NULL CHECK (length(trim(tool_name)) > 0),
    tool_version TEXT NOT NULL CHECK (length(trim(tool_version)) > 0),
    input_schema_hash TEXT NOT NULL CHECK (${SHA256_HASH_CHECK("input_schema_hash")}),
    canonical_input_hash TEXT NOT NULL CHECK (${SHA256_HASH_CHECK("canonical_input_hash")}),
    mode TEXT NOT NULL CHECK (mode IN ('read', 'write')),
    requires_approval INTEGER NOT NULL CHECK (requires_approval IN (0, 1)),
    status TEXT NOT NULL CHECK (${TOOL_RUN_STATUS_CHECK}),
    input_json TEXT NOT NULL,
    output_json TEXT,
    error_json TEXT,
    idempotency_key TEXT NOT NULL CHECK (${SHA256_HASH_CHECK("idempotency_key")}),
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    started_at TEXT,
    finished_at TEXT,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, call_id),
    UNIQUE (plan_step_id, original_index),
    UNIQUE (idempotency_key),
    UNIQUE (task_id, id),
    CHECK (status != 'unknown' OR mode = 'write'),
    CHECK (finished_at IS NULL OR started_at IS NULL OR finished_at >= started_at),
    FOREIGN KEY (task_id, plan_step_id)
      REFERENCES plan_steps(task_id, id) ON DELETE RESTRICT
  );

  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    tool_run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'approved', 'rejected', 'expired', 'cancelled')
    ),
    tool_version TEXT NOT NULL CHECK (length(trim(tool_version)) > 0),
    canonical_input_hash TEXT NOT NULL CHECK (${SHA256_HASH_CHECK("canonical_input_hash")}),
    request_json TEXT NOT NULL,
    reason TEXT,
    requested_at TEXT NOT NULL,
    expires_at TEXT,
    decided_at TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (task_id, id),
    CHECK (status = 'pending' OR decided_at IS NOT NULL),
    FOREIGN KEY (task_id, tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX ux_approvals_one_per_run
    ON approvals(tool_run_id);

  CREATE UNIQUE INDEX ux_approvals_pending
    ON approvals(tool_run_id)
    WHERE status = 'pending';

  CREATE TABLE recovery_reviews (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    tool_run_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN (
        'pending',
        'confirmed_succeeded',
        'confirmed_not_executed',
        'unresolved'
      )
    ),
    note TEXT,
    source_type TEXT CHECK (
      source_type IS NULL
      OR source_type IN ('manual_review', 'system_verification')
    ),
    evidence_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    decided_at TEXT,
    UNIQUE (task_id, id),
    CHECK (
      status = 'pending'
      OR (source_type IS NOT NULL AND decided_at IS NOT NULL)
    ),
    CHECK (
      status != 'confirmed_succeeded'
      OR evidence_ref IS NOT NULL
    ),
    FOREIGN KEY (task_id, tool_run_id)
      REFERENCES tool_runs(task_id, id) ON DELETE RESTRICT
  );

  CREATE UNIQUE INDEX ux_recovery_reviews_one_per_run
    ON recovery_reviews(task_id, tool_run_id);

  CREATE UNIQUE INDEX ux_recovery_reviews_active
    ON recovery_reviews(tool_run_id)
    WHERE status IN ('pending', 'unresolved');

  CREATE TRIGGER tool_runs_validate_step_mode_insert
  BEFORE INSERT ON tool_runs
  WHEN NOT EXISTS (
    SELECT 1
    FROM plan_steps
    WHERE plan_steps.id = NEW.plan_step_id
      AND plan_steps.task_id = NEW.task_id
      AND (
        (plan_steps.kind = 'read_batch' AND NEW.mode = 'read')
        OR (plan_steps.kind = 'write' AND NEW.mode = 'write')
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'tool run mode does not match plan step kind');
  END;

  CREATE TRIGGER tool_runs_validate_step_mode_update
  BEFORE UPDATE OF mode, plan_step_id, task_id ON tool_runs
  WHEN NOT EXISTS (
    SELECT 1
    FROM plan_steps
    WHERE plan_steps.id = NEW.plan_step_id
      AND plan_steps.task_id = NEW.task_id
      AND (
        (plan_steps.kind = 'read_batch' AND NEW.mode = 'read')
        OR (plan_steps.kind = 'write' AND NEW.mode = 'write')
      )
  )
  BEGIN
    SELECT RAISE(ABORT, 'tool run mode does not match plan step kind');
  END;

  CREATE TRIGGER approvals_validate_binding_insert
  BEFORE INSERT ON approvals
  WHEN NOT EXISTS (
    SELECT 1
    FROM tool_runs
    WHERE tool_runs.id = NEW.tool_run_id
      AND tool_runs.task_id = NEW.task_id
      AND tool_runs.mode = 'write'
      AND tool_runs.requires_approval = 1
      AND tool_runs.tool_version = NEW.tool_version
      AND tool_runs.canonical_input_hash = NEW.canonical_input_hash
  )
  BEGIN
    SELECT RAISE(ABORT, 'approval does not match tool run definition');
  END;

  CREATE TRIGGER approvals_validate_binding_update
  BEFORE UPDATE OF tool_run_id, task_id, tool_version, canonical_input_hash
  ON approvals
  WHEN NOT EXISTS (
    SELECT 1
    FROM tool_runs
    WHERE tool_runs.id = NEW.tool_run_id
      AND tool_runs.task_id = NEW.task_id
      AND tool_runs.mode = 'write'
      AND tool_runs.requires_approval = 1
      AND tool_runs.tool_version = NEW.tool_version
      AND tool_runs.canonical_input_hash = NEW.canonical_input_hash
  )
  BEGIN
    SELECT RAISE(ABORT, 'approval does not match tool run definition');
  END;

  CREATE TRIGGER recovery_reviews_validate_target_insert
  BEFORE INSERT ON recovery_reviews
  WHEN NOT EXISTS (
    SELECT 1
    FROM tool_runs
    WHERE tool_runs.id = NEW.tool_run_id
      AND tool_runs.task_id = NEW.task_id
      AND tool_runs.mode = 'write'
      AND tool_runs.status = 'unknown'
  )
  BEGIN
    SELECT RAISE(ABORT, 'recovery review requires an unknown write tool run');
  END;

  CREATE TRIGGER recovery_reviews_validate_target_update
  BEFORE UPDATE OF tool_run_id, task_id ON recovery_reviews
  WHEN NOT EXISTS (
    SELECT 1
    FROM tool_runs
    WHERE tool_runs.id = NEW.tool_run_id
      AND tool_runs.task_id = NEW.task_id
      AND tool_runs.mode = 'write'
      AND tool_runs.status = 'unknown'
  )
  BEGIN
    SELECT RAISE(ABORT, 'recovery review requires an unknown write tool run');
  END;

  CREATE TRIGGER plan_steps_completion_guard
  BEFORE UPDATE OF status ON plan_steps
  WHEN NEW.status = 'completed'
    AND EXISTS (
      SELECT 1
      FROM tool_runs AS tool_run
      LEFT JOIN recovery_reviews AS recovery_review
        ON recovery_review.tool_run_id = tool_run.id
      WHERE tool_run.plan_step_id = NEW.id
        AND (${PLAN_STEP_COMPLETION_BLOCKER})
    )
  BEGIN
    SELECT RAISE(ABORT, 'plan step has blocking tool run');
  END;

  CREATE TRIGGER tool_runs_block_completed_step_insert
  BEFORE INSERT ON tool_runs
  WHEN EXISTS (
    SELECT 1
    FROM plan_steps
    WHERE id = NEW.plan_step_id
      AND status = 'completed'
  )
  AND NEW.status IN ('queued', 'awaiting_approval', 'running', 'interrupted', 'unknown')
  BEGIN
    SELECT RAISE(ABORT, 'completed plan step cannot receive a non-terminal tool run');
  END;

  CREATE TRIGGER tool_runs_block_completed_step_update
  BEFORE UPDATE OF status ON tool_runs
  WHEN EXISTS (
    SELECT 1
    FROM plan_steps
    WHERE id = NEW.plan_step_id
      AND status = 'completed'
  )
  AND NEW.status IN ('queued', 'awaiting_approval', 'running', 'interrupted', 'unknown')
  BEGIN
    SELECT RAISE(ABORT, 'completed plan step cannot contain a non-terminal tool run');
  END;

  CREATE TRIGGER recovery_reviews_block_completed_step
  BEFORE UPDATE OF status ON recovery_reviews
  WHEN NEW.status = 'confirmed_not_executed'
    AND EXISTS (
      SELECT 1
      FROM tool_runs
      JOIN plan_steps ON plan_steps.id = tool_runs.plan_step_id
      WHERE tool_runs.id = NEW.tool_run_id
        AND plan_steps.status = 'completed'
    )
  BEGIN
    SELECT RAISE(ABORT, 'completed plan step cannot be confirmed not executed');
  END;
`;

export const phase3Step3Migration: Migration = {
  version: 2,
  name: "phase3_step3_plan_tool_approval",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP3_SCHEMA);
  },
};
