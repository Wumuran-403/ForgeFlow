import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const PHASE3_STEP4_SCHEMA = `
  ALTER TABLE plan_steps
    ADD COLUMN version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0);

  CREATE TABLE task_leases (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
    owner_id TEXT,
    lease_token TEXT UNIQUE,
    fencing_token INTEGER NOT NULL CHECK (fencing_token > 0),
    expires_at TEXT,
    heartbeat_at TEXT NOT NULL,
    released_at TEXT,
    updated_at TEXT NOT NULL,
    CHECK (
      (
        owner_id IS NOT NULL
        AND lease_token IS NOT NULL
        AND expires_at IS NOT NULL
        AND released_at IS NULL
      )
      OR (
        owner_id IS NULL
        AND lease_token IS NULL
        AND expires_at IS NULL
        AND released_at IS NOT NULL
      )
    )
  );

  CREATE INDEX ix_task_leases_expiry
    ON task_leases(expires_at)
    WHERE owner_id IS NOT NULL;

  CREATE TRIGGER task_leases_reject_delete
  BEFORE DELETE ON task_leases
  BEGIN
    SELECT RAISE(ABORT, 'task leases are retained');
  END;

  CREATE TRIGGER task_leases_reject_terminal_claim_insert
  BEFORE INSERT ON task_leases
  WHEN EXISTS (
    SELECT 1
    FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot acquire a lease');
  END;

  CREATE TRIGGER task_leases_reject_terminal_claim_update
  BEFORE UPDATE OF owner_id, lease_token ON task_leases
  WHEN NEW.owner_id IS NOT NULL
    AND EXISTS (
      SELECT 1
      FROM tasks
      WHERE id = NEW.task_id
        AND status IN ('completed', 'failed', 'cancelled')
    )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot acquire a lease');
  END;

  CREATE TRIGGER task_leases_reject_task_change
  BEFORE UPDATE OF task_id ON task_leases
  WHEN NEW.task_id != OLD.task_id
  BEGIN
    SELECT RAISE(ABORT, 'task lease task_id is immutable');
  END;

  CREATE TRIGGER task_leases_reject_fencing_regression
  BEFORE UPDATE OF fencing_token ON task_leases
  WHEN NEW.fencing_token < OLD.fencing_token
  BEGIN
    SELECT RAISE(ABORT, 'fencing token cannot decrease');
  END;

  CREATE TRIGGER tasks_reject_terminal_with_active_review
  BEFORE UPDATE OF status ON tasks
  WHEN NEW.status IN ('completed', 'failed', 'cancelled')
    AND EXISTS (
      SELECT 1
      FROM recovery_reviews
      WHERE task_id = NEW.id
        AND status IN ('pending', 'unresolved')
    )
  BEGIN
    SELECT RAISE(ABORT, 'task has active recovery review');
  END;

  CREATE TRIGGER tasks_reject_terminal_with_active_execution
  BEFORE UPDATE OF status ON tasks
  WHEN NEW.status IN ('completed', 'failed', 'cancelled')
    AND (
      EXISTS (
        SELECT 1
        FROM plan_steps
        WHERE task_id = NEW.id
          AND status IN (
            'queued',
            'running',
            'awaiting_approval',
            'waiting_review',
            'interrupted'
          )
      )
      OR
      EXISTS (
        SELECT 1
        FROM tool_runs
        WHERE task_id = NEW.id
          AND status IN ('queued', 'awaiting_approval', 'running', 'interrupted')
      )
      OR EXISTS (
        SELECT 1
        FROM approvals
        WHERE task_id = NEW.id
          AND status = 'pending'
      )
      OR EXISTS (
        SELECT 1
        FROM tool_runs AS tool_run
        LEFT JOIN recovery_reviews AS recovery_review
          ON recovery_review.tool_run_id = tool_run.id
        LEFT JOIN plan_steps AS plan_step
          ON plan_step.id = tool_run.plan_step_id
        WHERE tool_run.task_id = NEW.id
          AND tool_run.status = 'unknown'
          AND (
            recovery_review.id IS NULL
            OR recovery_review.status IN ('pending', 'unresolved')
            OR (
              recovery_review.status = 'confirmed_not_executed'
              AND plan_step.status != 'failed'
            )
          )
      )
      OR (
        NEW.status = 'completed'
        AND EXISTS (
          SELECT 1
          FROM plan_steps
          WHERE task_id = NEW.id
            AND status NOT IN ('completed', 'skipped')
        )
      )
    )
  BEGIN
    SELECT RAISE(ABORT, 'task has active execution state');
  END;

  CREATE TRIGGER plan_steps_reject_terminal_task_insert
  BEFORE INSERT ON plan_steps
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a plan step');
  END;

  CREATE TRIGGER tool_runs_reject_terminal_task_insert
  BEFORE INSERT ON tool_runs
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a tool run');
  END;

  CREATE TRIGGER approvals_reject_terminal_task_insert
  BEFORE INSERT ON approvals
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive an approval');
  END;

  CREATE TRIGGER recovery_reviews_reject_terminal_task_insert
  BEFORE INSERT ON recovery_reviews
  WHEN EXISTS (
    SELECT 1 FROM tasks
    WHERE id = NEW.task_id
      AND status IN ('completed', 'failed', 'cancelled')
  )
  BEGIN
    SELECT RAISE(ABORT, 'terminal task cannot receive a recovery review');
  END;
`;

export const phase3Step4Migration: Migration = {
  version: 3,
  name: "phase3_step4_task_lease_state_machine",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP4_SCHEMA);
  },
};
