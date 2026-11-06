import type Database from "better-sqlite3";

import {
  ModelRequestSchema,
  ModelResponseSchema,
  ModelUsageSchema,
} from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import { decodeJson, encodeJson } from "./json-codec.js";
import {
  ModelCallStatusSchema,
  PersistedErrorSchema,
  type ModelCallRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface ModelCallRow {
  id: string;
  task_id: string;
  iteration: number;
  attempt_no: number;
  status: string;
  request_json: string;
  response_json: string | null;
  usage_json: string | null;
  finish_reason: string | null;
  provider_request_id: string | null;
  duration_ms: number | null;
  error_json: string | null;
  started_at: string;
  finished_at: string | null;
}

function mapModelCallRow(row: ModelCallRow): ModelCallRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    iteration: row.iteration,
    attemptNo: row.attempt_no,
    status: ModelCallStatusSchema.parse(row.status),
    request: decodeJson(
      ModelRequestSchema,
      row.request_json,
      "model_calls.request_json",
    ),
    response:
      row.response_json === null
        ? null
        : decodeJson(
            ModelResponseSchema,
            row.response_json,
            "model_calls.response_json",
          ),
    usage:
      row.usage_json === null
        ? null
        : decodeJson(
            ModelUsageSchema,
            row.usage_json,
            "model_calls.usage_json",
          ),
    finishReason: row.finish_reason,
    providerRequestId: row.provider_request_id,
    durationMs: row.duration_ms,
    error:
      row.error_json === null
        ? null
        : decodeJson(
            PersistedErrorSchema,
            row.error_json,
            "model_calls.error_json",
          ),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

export interface CreateRequestedModelCallInput {
  readonly id: string;
  readonly taskId: string;
  readonly iteration: number;
  readonly attemptNo: number;
  readonly request: unknown;
  readonly startedAt: string;
}

export class ModelCallRepository {
  constructor(private readonly database: Database.Database) {}

  createRequested(
    input: CreateRequestedModelCallInput,
    permit: StorageWritePermit,
  ): ModelCallRecord {
    assertStorageWritePermit(this.database, permit);
    this.database
      .prepare(
        `
          INSERT INTO model_calls (
            id, task_id, iteration, attempt_no, status,
            request_json, started_at
          ) VALUES (?, ?, ?, ?, 'requested', ?, ?)
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.iteration,
        input.attemptNo,
        encodeJson(
          ModelRequestSchema,
          input.request,
          "model_calls.request_json",
        ),
        input.startedAt,
      );

    return this.get(input.id);
  }

  complete(
    id: string,
    response: unknown,
    durationMs: number,
    finishedAt: string,
    permit: StorageWritePermit,
  ): ModelCallRecord {
    assertStorageWritePermit(this.database, permit);
    const parsedResponse = ModelResponseSchema.parse(response);
    const result = this.database
      .prepare(
        `
          UPDATE model_calls
          SET status = 'completed',
              response_json = ?,
              usage_json = ?,
              finish_reason = ?,
              provider_request_id = ?,
              duration_ms = ?,
              finished_at = ?
          WHERE id = ? AND status = 'requested'
        `,
      )
      .run(
        encodeJson(
          ModelResponseSchema,
          parsedResponse,
          "model_calls.response_json",
        ),
        encodeJson(
          ModelUsageSchema,
          parsedResponse.usage,
          "model_calls.usage_json",
        ),
        parsedResponse.finishReason ?? null,
        parsedResponse.requestId ?? null,
        durationMs,
        finishedAt,
        id,
      );

    if (result.changes !== 1) {
      throw new AppError({
        code: "MODEL_CALL_NOT_REQUESTED",
        message: "Model call is not in requested state.",
        statusCode: 409,
        details: [],
      });
    }

    return this.get(id);
  }

  fail(
    id: string,
    status: "failed" | "interrupted" | "cancelled",
    durationMs: number,
    error: unknown,
    finishedAt: string,
    permit: StorageWritePermit,
  ): ModelCallRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE model_calls
          SET status = ?,
              duration_ms = ?,
              error_json = ?,
              finished_at = ?
          WHERE id = ? AND status = 'requested'
        `,
      )
      .run(
        ModelCallStatusSchema.parse(status),
        durationMs,
        encodeJson(
          PersistedErrorSchema,
          error,
          "model_calls.error_json",
        ),
        finishedAt,
        id,
      );

    if (result.changes !== 1) {
      throw new AppError({
        code: "MODEL_CALL_NOT_REQUESTED",
        message: "Model call is not in requested state.",
        statusCode: 409,
        details: [],
      });
    }

    return this.get(id);
  }

  get(id: string): ModelCallRecord {
    const row = this.database
      .prepare("SELECT * FROM model_calls WHERE id = ?")
      .get(id) as ModelCallRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "MODEL_CALL_NOT_FOUND",
        message: "Model call was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapModelCallRow(row);
  }

  listByTask(taskId: string): readonly ModelCallRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM model_calls
            WHERE task_id = ?
            ORDER BY iteration, attempt_no
          `,
        )
        .all(taskId) as ModelCallRow[]
    ).map(mapModelCallRow);
  }
}
