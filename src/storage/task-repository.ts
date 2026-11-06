import type Database from "better-sqlite3";
import type { z } from "zod";

import {
  ModelUsageSchema,
  type ModelUsage,
} from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import { decodeJson, encodeJson } from "./json-codec.js";
import { assertTaskCanBecomeTerminal } from "./task-invariants.js";
import {
  CreateTaskInputSchema,
  PersistedErrorSchema,
  TaskStatusSchema,
  type TaskRecord,
  type TaskStatus,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface TaskRow {
  id: string;
  trace_id: string;
  status: string;
  objective: string;
  system_prompt: string;
  current_iteration: number;
  max_model_turns: number;
  max_tool_calls: number;
  token_usage_json: string;
  version: number;
  cancel_requested_at: string | null;
  pause_requested_at: string | null;
  last_event_sequence: number;
  final_answer: string | null;
  last_error_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export type PersistedTaskInput = z.output<typeof CreateTaskInputSchema>;

function mapTaskRow(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    traceId: row.trace_id,
    status: TaskStatusSchema.parse(row.status),
    objective: row.objective,
    systemPrompt: row.system_prompt,
    currentIteration: row.current_iteration,
    maxModelTurns: row.max_model_turns,
    maxToolCalls: row.max_tool_calls,
    tokenUsage: decodeJson(
      ModelUsageSchema,
      row.token_usage_json,
      "tasks.token_usage_json",
    ),
    version: row.version,
    cancelRequestedAt: row.cancel_requested_at,
    pauseRequestedAt: row.pause_requested_at,
    lastEventSequence: row.last_event_sequence,
    finalAnswer: row.final_answer,
    lastError:
      row.last_error_json === null
        ? null
        : decodeJson(
            PersistedErrorSchema,
            row.last_error_json,
            "tasks.last_error_json",
          ),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export class TaskRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: PersistedTaskInput,
    now: string,
    permit: StorageWritePermit,
  ): TaskRecord {
    assertStorageWritePermit(this.database, permit);
    this.database
      .prepare(
        `
          INSERT INTO tasks (
            id, trace_id, status, objective, system_prompt,
            current_iteration, max_model_turns, max_tool_calls,
            token_usage_json, version, last_event_sequence,
            created_at, updated_at
          ) VALUES (?, ?, 'queued', ?, ?, 0, ?, ?, ?, 1, 0, ?, ?)
        `,
      )
      .run(
        input.taskId,
        input.traceId,
        input.objective,
        input.systemPrompt,
        input.maxModelTurns,
        input.maxToolCalls,
        encodeJson(
          ModelUsageSchema,
          input.tokenUsage,
          "tasks.token_usage_json",
        ),
        now,
        now,
      );

    return this.get(input.taskId);
  }

  get(taskId: string): TaskRecord {
    const row = this.database
      .prepare("SELECT * FROM tasks WHERE id = ?")
      .get(taskId) as TaskRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "TASK_NOT_FOUND",
        message: "Task was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapTaskRow(row);
  }

  updateStatus(
    taskId: string,
    status: TaskStatus,
    updatedAt: string,
    permit: StorageWritePermit,
    finalAnswer?: string,
    completedAt?: string,
  ): TaskRecord {
    assertStorageWritePermit(this.database, permit);
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      assertTaskCanBecomeTerminal(this.database, taskId, status);
    }
    const result = this.database
      .prepare(
        `
          UPDATE tasks
          SET status = ?,
              version = version + 1,
              updated_at = ?,
              final_answer = ?,
              completed_at = ?
          WHERE id = ?
        `,
      )
      .run(
        TaskStatusSchema.parse(status),
        updatedAt,
        finalAnswer ?? null,
        completedAt ?? null,
        taskId,
      );

    if (result.changes !== 1) {
      throw new AppError({
        code: "TASK_NOT_FOUND",
        message: "Task was not found.",
        statusCode: 404,
        details: [],
      });
    }

    return this.get(taskId);
  }

  updateStatusCas(
    taskId: string,
    expectedStatus: TaskStatus,
    expectedVersion: number,
    status: TaskStatus,
    updatedAt: string,
    permit: StorageWritePermit,
    options: {
      readonly finalAnswer?: string;
      readonly completedAt?: string;
      readonly cancelRequestedAt?: string;
      readonly pauseRequestedAt?: string;
    } = {},
  ): TaskRecord {
    assertStorageWritePermit(this.database, permit);
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      assertTaskCanBecomeTerminal(this.database, taskId, status);
    }
    const result = this.database
      .prepare(
        `
          UPDATE tasks
          SET status = ?,
              version = version + 1,
              updated_at = ?,
              final_answer = COALESCE(?, final_answer),
              completed_at = COALESCE(?, completed_at),
              cancel_requested_at = COALESCE(?, cancel_requested_at),
              pause_requested_at = COALESCE(?, pause_requested_at)
          WHERE id = ? AND status = ? AND version = ?
        `,
      )
      .run(
        TaskStatusSchema.parse(status),
        updatedAt,
        options.finalAnswer ?? null,
        options.completedAt ?? null,
        options.cancelRequestedAt ?? null,
        options.pauseRequestedAt ?? null,
        taskId,
        TaskStatusSchema.parse(expectedStatus),
        expectedVersion,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "TASK_STATE_CONFLICT",
        message: "Task changed while applying a transition.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(taskId);
  }

  updateCurrentIteration(
    taskId: string,
    iteration: number,
    updatedAt: string,
    permit: StorageWritePermit,
  ): void {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE tasks
          SET current_iteration = CASE
                WHEN current_iteration < ? THEN ?
                ELSE current_iteration
              END,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(iteration, iteration, updatedAt, taskId);

    if (result.changes !== 1) {
      throw new AppError({
        code: "TASK_NOT_FOUND",
        message: "Task was not found.",
        statusCode: 404,
        details: [],
      });
    }
  }

  updateTokenUsage(
    taskId: string,
    usage: ModelUsage,
    updatedAt: string,
    permit: StorageWritePermit,
  ): void {
    assertStorageWritePermit(this.database, permit);
    this.database
      .prepare(
        `
          UPDATE tasks
          SET token_usage_json = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        encodeJson(ModelUsageSchema, usage, "tasks.token_usage_json"),
        updatedAt,
        taskId,
      );
  }
}
