import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import { decodeJson, encodeJson } from "./json-codec.js";
import {
  ApprovalStatusSchema,
  JsonValueSchema,
  type ApprovalRecord,
  type ApprovalStatus,
  type JsonValue,
} from "./types.js";
import { assertTaskAcceptsActiveExecution } from "./task-invariants.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface ApprovalRow {
  id: string;
  task_id: string;
  tool_run_id: string;
  status: string;
  tool_version: string;
  canonical_input_hash: string;
  request_json: string;
  reason: string | null;
  requested_at: string;
  expires_at: string | null;
  decided_at: string | null;
  created_at: string;
  updated_at: string;
}

function mapApprovalRow(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    toolRunId: row.tool_run_id,
    status: ApprovalStatusSchema.parse(row.status),
    toolVersion: row.tool_version,
    canonicalInputHash: row.canonical_input_hash,
    request: decodeJson(
      JsonValueSchema,
      row.request_json,
      "approvals.request_json",
    ),
    reason: row.reason,
    requestedAt: row.requested_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateApprovalInput {
  readonly id: string;
  readonly taskId: string;
  readonly toolRunId: string;
  readonly toolVersion: string;
  readonly canonicalInputHash: string;
  readonly request: JsonValue;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
}

export class ApprovalRepository {
  constructor(private readonly database: Database.Database) {}

  createPending(
    input: CreateApprovalInput,
    permit: StorageWritePermit,
  ): ApprovalRecord {
    assertStorageWritePermit(this.database, permit);
    assertTaskAcceptsActiveExecution(this.database, input.taskId);
    this.database
      .prepare(
        `
          INSERT INTO approvals (
            id, task_id, tool_run_id, status, tool_version,
            canonical_input_hash, request_json, requested_at,
            expires_at, created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.toolRunId,
        input.toolVersion,
        input.canonicalInputHash,
        encodeJson(JsonValueSchema, input.request, "approvals.request_json"),
        input.requestedAt,
        input.expiresAt,
        input.requestedAt,
        input.requestedAt,
      );
    return this.get(input.id);
  }

  decide(
    id: string,
    status: Exclude<ApprovalStatus, "pending">,
    reason: string | null,
    decidedAt: string,
    permit: StorageWritePermit,
  ): ApprovalRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE approvals
          SET status = ?, reason = ?, decided_at = ?, updated_at = ?
          WHERE id = ? AND status = 'pending'
        `,
      )
      .run(
        ApprovalStatusSchema.parse(status),
        reason,
        decidedAt,
        decidedAt,
        id,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "APPROVAL_STATE_CONFLICT",
        message: "Approval is not pending.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  get(id: string): ApprovalRecord {
    const row = this.database
      .prepare("SELECT * FROM approvals WHERE id = ?")
      .get(id) as ApprovalRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "APPROVAL_NOT_FOUND",
        message: "Approval was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapApprovalRow(row);
  }

  getByToolRun(toolRunId: string): ApprovalRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM approvals WHERE tool_run_id = ?")
      .get(toolRunId) as ApprovalRow | undefined;
    return row === undefined ? undefined : mapApprovalRow(row);
  }

  listByTask(taskId: string): readonly ApprovalRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM approvals
            WHERE task_id = ?
            ORDER BY requested_at, id
          `,
        )
        .all(taskId) as ApprovalRow[]
    ).map(mapApprovalRow);
  }
}
