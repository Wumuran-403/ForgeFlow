import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const TASK_STATUS_CHECK = `
  status IN (
    'queued',
    'running',
    'pause_requested',
    'paused',
    'cancel_requested',
    'waiting_approval',
    'waiting_review',
    'completed',
    'failed',
    'cancelled'
  )
`;

const CHECKPOINT_TASK_STATUS_CHECK = `
  task_status IN (
    'queued',
    'running',
    'pause_requested',
    'paused',
    'cancel_requested',
    'waiting_approval',
    'waiting_review',
    'completed',
    'failed',
    'cancelled'
  )
`;

const PHASE3_STEP2_SCHEMA = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    trace_id TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL CHECK (${TASK_STATUS_CHECK}),
    objective TEXT NOT NULL,
    system_prompt TEXT NOT NULL,
    current_iteration INTEGER NOT NULL DEFAULT 0 CHECK (current_iteration >= 0),
    max_model_turns INTEGER NOT NULL CHECK (max_model_turns > 0),
    max_tool_calls INTEGER NOT NULL CHECK (max_tool_calls >= 0),
    token_usage_json TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
    cancel_requested_at TEXT,
    pause_requested_at TEXT,
    last_event_sequence INTEGER NOT NULL DEFAULT 0
      CHECK (last_event_sequence >= 0),
    final_answer TEXT,
    last_error_json TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
  );

  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    role TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
    content TEXT NOT NULL,
    tool_call_id TEXT,
    tool_calls_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, sequence),
    CHECK (
      (
        role = 'tool'
        AND tool_call_id IS NOT NULL
        AND tool_calls_json IS NULL
      )
      OR (
        role = 'assistant'
        AND tool_call_id IS NULL
      )
      OR (
        role IN ('system', 'user')
        AND tool_call_id IS NULL
        AND tool_calls_json IS NULL
      )
    )
  );

  CREATE UNIQUE INDEX ux_messages_tool_result
    ON messages(task_id, tool_call_id)
    WHERE role = 'tool' AND tool_call_id IS NOT NULL;

  CREATE TABLE model_calls (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    iteration INTEGER NOT NULL CHECK (iteration > 0),
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    status TEXT NOT NULL CHECK (
      status IN ('requested', 'completed', 'failed', 'interrupted', 'cancelled')
    ),
    request_json TEXT NOT NULL,
    response_json TEXT,
    usage_json TEXT,
    finish_reason TEXT,
    provider_request_id TEXT,
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    error_json TEXT,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE (task_id, iteration, attempt_no),
    CHECK (
      (
        status = 'requested'
        AND response_json IS NULL
        AND finished_at IS NULL
      )
      OR (
        status = 'completed'
        AND response_json IS NOT NULL
        AND usage_json IS NOT NULL
        AND finished_at IS NOT NULL
      )
      OR (
        status IN ('failed', 'interrupted', 'cancelled')
        AND response_json IS NULL
        AND finished_at IS NOT NULL
      )
    )
  );

  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    trace_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (length(trim(type)) > 0),
    entity_type TEXT,
    entity_id TEXT,
    payload_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, sequence),
    CHECK (
      (entity_type IS NULL AND entity_id IS NULL)
      OR (entity_type IS NOT NULL AND entity_id IS NOT NULL)
    )
  );

  CREATE TRIGGER events_reject_update
  BEFORE UPDATE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;

  CREATE TRIGGER events_reject_delete
  BEFORE DELETE ON events
  BEGIN
    SELECT RAISE(ABORT, 'events are append-only');
  END;

  CREATE TABLE checkpoints (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,
    sequence INTEGER NOT NULL CHECK (sequence > 0),
    reason TEXT NOT NULL CHECK (length(trim(reason)) > 0),
    task_status TEXT NOT NULL CHECK (${CHECKPOINT_TASK_STATUS_CHECK}),
    last_message_sequence INTEGER NOT NULL CHECK (last_message_sequence >= 0),
    model_iteration INTEGER NOT NULL CHECK (model_iteration >= 0),
    plan_version INTEGER CHECK (plan_version IS NULL OR plan_version > 0),
    last_event_sequence INTEGER NOT NULL CHECK (last_event_sequence >= 0),
    budget_json TEXT NOT NULL,
    metadata_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE (task_id, sequence)
  );
`;

export const phase3Step2Migration: Migration = {
  version: 1,
  name: "phase3_step2_task_message_model_call",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP2_SCHEMA);
  },
};
