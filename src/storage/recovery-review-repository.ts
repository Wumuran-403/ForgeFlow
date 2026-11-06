import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  RecoveryReviewSourceSchema,
  RecoveryReviewStatusSchema,
  type RecoveryReviewRecord,
  type RecoveryReviewSource,
  type RecoveryReviewStatus,
} from "./types.js";
import { assertTaskAcceptsActiveExecution } from "./task-invariants.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface RecoveryReviewRow {
  id: string;
  task_id: string;
  tool_run_id: string;
  status: string;
  note: string | null;
  source_type: string | null;
  evidence_ref: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

function mapRecoveryReviewRow(
  row: RecoveryReviewRow,
): RecoveryReviewRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    toolRunId: row.tool_run_id,
    status: RecoveryReviewStatusSchema.parse(row.status),
    note: row.note,
    sourceType:
      row.source_type === null
        ? null
        : RecoveryReviewSourceSchema.parse(row.source_type),
    evidenceRef: row.evidence_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

export interface CreateRecoveryReviewInput {
  readonly id: string;
  readonly taskId: string;
  readonly toolRunId: string;
  readonly note: string | null;
  readonly createdAt: string;
}

export interface DecideRecoveryReviewRecordInput {
  readonly status: Exclude<RecoveryReviewStatus, "pending">;
  readonly note: string | null;
  readonly sourceType: RecoveryReviewSource;
  readonly evidenceRef: string | null;
  readonly decidedAt: string;
}

export class RecoveryReviewRepository {
  constructor(private readonly database: Database.Database) {}

  createPending(
    input: CreateRecoveryReviewInput,
    permit: StorageWritePermit,
  ): RecoveryReviewRecord {
    assertStorageWritePermit(this.database, permit);
    assertTaskAcceptsActiveExecution(this.database, input.taskId);
    this.database
      .prepare(
        `
          INSERT INTO recovery_reviews (
            id, task_id, tool_run_id, status, note,
            created_at, updated_at
          ) VALUES (?, ?, ?, 'pending', ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.toolRunId,
        input.note,
        input.createdAt,
        input.createdAt,
      );
    return this.get(input.id);
  }

  decide(
    id: string,
    input: DecideRecoveryReviewRecordInput,
    permit: StorageWritePermit,
  ): RecoveryReviewRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE recovery_reviews
          SET status = ?,
              note = ?,
              source_type = ?,
              evidence_ref = ?,
              decided_at = ?,
              updated_at = ?
          WHERE id = ? AND status IN ('pending', 'unresolved')
        `,
      )
      .run(
        RecoveryReviewStatusSchema.parse(input.status),
        input.note,
        RecoveryReviewSourceSchema.parse(input.sourceType),
        input.evidenceRef,
        input.decidedAt,
        input.decidedAt,
        id,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "RECOVERY_REVIEW_STATE_CONFLICT",
        message: "Recovery review is not active.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  get(id: string): RecoveryReviewRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_reviews WHERE id = ?")
      .get(id) as RecoveryReviewRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_REVIEW_NOT_FOUND",
        message: "Recovery review was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryReviewRow(row);
  }

  getByToolRun(toolRunId: string): RecoveryReviewRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM recovery_reviews WHERE tool_run_id = ?")
      .get(toolRunId) as RecoveryReviewRow | undefined;
    return row === undefined ? undefined : mapRecoveryReviewRow(row);
  }

  listByTask(taskId: string): readonly RecoveryReviewRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_reviews
            WHERE task_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(taskId) as RecoveryReviewRow[]
    ).map(mapRecoveryReviewRow);
  }
}
