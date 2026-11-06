import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import { decodeJson, encodeJson } from "./json-codec.js";
import {
  JsonValueSchema,
  PersistedErrorSchema,
  ToolRunStatusSchema,
  type JsonValue,
  type ToolRunRecord,
  type ToolRunStatus,
} from "./types.js";
import { ToolModeSchema, type ToolMode } from "../tools/types.js";
import { assertTaskAcceptsActiveExecution } from "./task-invariants.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface ToolRunRow {
  id: string;
  task_id: string;
  plan_step_id: string;
  call_id: string;
  original_index: number;
  tool_name: string;
  tool_version: string;
  input_schema_hash: string;
  canonical_input_hash: string;
  mode: string;
  requires_approval: number;
  status: string;
  input_json: string;
  output_json: string | null;
  error_json: string | null;
  idempotency_key: string;
  attempt_no: number;
  started_at: string | null;
  finished_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapToolRunRow(row: ToolRunRow): ToolRunRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    planStepId: row.plan_step_id,
    toolCallId: row.call_id,
    originalIndex: row.original_index,
    toolName: row.tool_name,
    toolVersion: row.tool_version,
    inputSchemaHash: row.input_schema_hash,
    canonicalInputHash: row.canonical_input_hash,
    mode: ToolModeSchema.parse(row.mode),
    requiresApproval: row.requires_approval === 1,
    status: ToolRunStatusSchema.parse(row.status),
    input: decodeJson(
      JsonValueSchema,
      row.input_json,
      "tool_runs.input_json",
    ),
    output:
      row.output_json === null
        ? null
        : decodeJson(
            JsonValueSchema,
            row.output_json,
            "tool_runs.output_json",
          ),
    error:
      row.error_json === null
        ? null
        : decodeJson(
            PersistedErrorSchema,
            row.error_json,
            "tool_runs.error_json",
          ),
    idempotencyKey: row.idempotency_key,
    attemptNo: row.attempt_no,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateToolRunIntentInput {
  readonly id: string;
  readonly taskId: string;
  readonly planStepId: string;
  readonly toolCallId: string;
  readonly originalIndex: number;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly inputSchemaHash: string;
  readonly canonicalInputHash: string;
  readonly mode: ToolMode;
  readonly requiresApproval: boolean;
  readonly status: "queued" | "awaiting_approval";
  readonly input: JsonValue;
  readonly idempotencyKey: string;
  readonly attemptNo: number;
  readonly createdAt: string;
}

export interface ToolRunTransition {
  readonly expectedVersion?: number;
  readonly status: ToolRunStatus;
  readonly updatedAt: string;
  readonly startedAt?: string | null;
  readonly finishedAt?: string | null;
  readonly output?: JsonValue | null;
  readonly error?: {
    readonly code: string;
    readonly message: string;
    readonly details: readonly {
      readonly path: string;
      readonly message: string;
    }[];
  } | null;
}

export class ToolRunRepository {
  constructor(private readonly database: Database.Database) {}

  createIntent(
    input: CreateToolRunIntentInput,
    permit: StorageWritePermit,
  ): ToolRunRecord {
    assertStorageWritePermit(this.database, permit);
    assertTaskAcceptsActiveExecution(this.database, input.taskId);
    this.database
      .prepare(
        `
          INSERT INTO tool_runs (
            id, task_id, plan_step_id, call_id, original_index,
            tool_name, tool_version, input_schema_hash,
            canonical_input_hash, mode, requires_approval,
            status, input_json, idempotency_key, attempt_no,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.planStepId,
        input.toolCallId,
        input.originalIndex,
        input.toolName,
        input.toolVersion,
        input.inputSchemaHash,
        input.canonicalInputHash,
        ToolModeSchema.parse(input.mode),
        input.requiresApproval ? 1 : 0,
        ToolRunStatusSchema.parse(input.status),
        encodeJson(JsonValueSchema, input.input, "tool_runs.input_json"),
        input.idempotencyKey,
        input.attemptNo,
        input.createdAt,
        input.createdAt,
      );
    return this.get(input.id);
  }

  transition(
    id: string,
    expectedStatuses: readonly ToolRunStatus[],
    transition: ToolRunTransition,
    permit: StorageWritePermit,
  ): ToolRunRecord {
    assertStorageWritePermit(this.database, permit);
    const current = this.get(id);
    if (!expectedStatuses.includes(current.status)) {
      throw new AppError({
        code: "TOOL_RUN_STATE_CONFLICT",
        message: "Tool run is not in an allowed state for this transition.",
        statusCode: 409,
        details: [],
      });
    }

    const result = this.database
      .prepare(
        `
          UPDATE tool_runs
          SET status = ?,
              started_at = ?,
              finished_at = ?,
              output_json = ?,
              error_json = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ? AND status = ?
            AND version = ?
        `,
      )
      .run(
        ToolRunStatusSchema.parse(transition.status),
        transition.startedAt === undefined
          ? current.startedAt
          : transition.startedAt,
        transition.finishedAt === undefined
          ? current.finishedAt
          : transition.finishedAt,
        transition.output === undefined
          ? encodeOptionalJson(current.output, "tool_runs.output_json")
          : encodeOptionalJson(transition.output, "tool_runs.output_json"),
        transition.error === undefined
          ? encodeOptionalError(current.error, "tool_runs.error_json")
          : encodeOptionalError(transition.error, "tool_runs.error_json"),
        transition.updatedAt,
        id,
        current.status,
        transition.expectedVersion ?? current.version,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "TOOL_RUN_STATE_CONFLICT",
        message: "Tool run changed while applying a transition.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  get(id: string): ToolRunRecord {
    const row = this.database
      .prepare("SELECT * FROM tool_runs WHERE id = ?")
      .get(id) as ToolRunRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "TOOL_RUN_NOT_FOUND",
        message: "Tool run was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapToolRunRow(row);
  }

  listByTask(taskId: string): readonly ToolRunRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM tool_runs
            WHERE task_id = ?
            ORDER BY original_index, attempt_no
          `,
        )
        .all(taskId) as ToolRunRow[]
    ).map(mapToolRunRow);
  }

  listByPlanStep(planStepId: string): readonly ToolRunRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM tool_runs
            WHERE plan_step_id = ?
            ORDER BY original_index, attempt_no
          `,
        )
        .all(planStepId) as ToolRunRow[]
    ).map(mapToolRunRow);
  }
}

function encodeOptionalJson(value: JsonValue | null, column: string): string | null {
  return value === null ? null : encodeJson(JsonValueSchema, value, column);
}

function encodeOptionalError(
  value: unknown,
  column: string,
): string | null {
  return value === null
    ? null
    : encodeJson(PersistedErrorSchema, value, column);
}
