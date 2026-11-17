import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  ExecutionPlanPurposeSchema,
  ExecutionPlanStatusSchema,
  type ExecutionPlanRecord,
  type ExecutionPlanPurpose,
  type ExecutionPlanStatus,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface ExecutionPlanRow {
  id: string;
  task_id: string;
  version: number;
  source_model_call_id: string;
  purpose: string;
  status: string;
  created_at: string;
  updated_at: string;
}

function mapExecutionPlanRow(row: ExecutionPlanRow): ExecutionPlanRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    version: row.version,
    sourceModelCallId: row.source_model_call_id,
    purpose: ExecutionPlanPurposeSchema.parse(row.purpose),
    status: ExecutionPlanStatusSchema.parse(row.status),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreateExecutionPlanInput {
  readonly id: string;
  readonly taskId: string;
  readonly version: number;
  readonly sourceModelCallId: string;
  readonly status: ExecutionPlanStatus;
  readonly purpose?: ExecutionPlanPurpose;
  readonly createdAt: string;
}

export class ExecutionPlanRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreateExecutionPlanInput,
    permit: StorageWritePermit,
  ): ExecutionPlanRecord {
    assertStorageWritePermit(this.database, permit);
    this.database
      .prepare(
        `
          INSERT INTO execution_plans (
            id, task_id, version, source_model_call_id,
            purpose, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.version,
        input.sourceModelCallId,
        ExecutionPlanPurposeSchema.parse(input.purpose ?? "agent"),
        ExecutionPlanStatusSchema.parse(input.status),
        input.createdAt,
        input.createdAt,
      );
    return this.get(input.id);
  }

  updateStatusCas(
    id: string,
    expectedStatus: ExecutionPlanStatus,
    expectedVersion: number,
    status: ExecutionPlanStatus,
    updatedAt: string,
    permit: StorageWritePermit,
  ): ExecutionPlanRecord {
    assertStorageWritePermit(this.database, permit);
    if (
      expectedStatus !== "active" ||
      !["completed", "failed", "cancelled"].includes(status)
    ) {
      throw new AppError({
        code: "EXECUTION_PLAN_STATE_CONFLICT",
        message: "Execution plan transition is invalid.",
        statusCode: 409,
        details: [],
      });
    }
    const result = this.database
      .prepare(
        `
          UPDATE execution_plans
          SET status = ?, updated_at = ?
          WHERE id = ? AND status = ? AND version = ?
        `,
      )
      .run(
        ExecutionPlanStatusSchema.parse(status),
        updatedAt,
        id,
        ExecutionPlanStatusSchema.parse(expectedStatus),
        expectedVersion,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "EXECUTION_PLAN_STATE_CONFLICT",
        message: "Execution plan changed while applying a transition.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  get(id: string): ExecutionPlanRecord {
    const row = this.database
      .prepare("SELECT * FROM execution_plans WHERE id = ?")
      .get(id) as ExecutionPlanRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "EXECUTION_PLAN_NOT_FOUND",
        message: "Execution plan was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapExecutionPlanRow(row);
  }

  listByTask(taskId: string): readonly ExecutionPlanRecord[] {
    return this.listByTaskPurpose(taskId);
  }

  listByTaskPurpose(
    taskId: string,
    purpose?: ExecutionPlanPurpose,
  ): readonly ExecutionPlanRecord[] {
    const wherePurpose =
      purpose === undefined ? "" : "AND purpose = ?";
    const parameters =
      purpose === undefined ? [taskId] : [taskId, purpose];
    return (
      this.database
        .prepare(
          `
            SELECT * FROM execution_plans
            WHERE task_id = ?
              ${wherePurpose}
            ORDER BY version
          `,
        )
        .all(...parameters) as ExecutionPlanRow[]
    ).map(mapExecutionPlanRow);
  }

  listAgentByTask(taskId: string): readonly ExecutionPlanRecord[] {
    return this.listByTaskPurpose(taskId, "agent");
  }

  listRecoveryEvidenceByTask(
    taskId: string,
  ): readonly ExecutionPlanRecord[] {
    return this.listByTaskPurpose(taskId, "recovery_evidence");
  }

  getLatestByPurpose(
    taskId: string,
    purpose: ExecutionPlanPurpose,
  ): ExecutionPlanRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM execution_plans
          WHERE task_id = ? AND purpose = ?
          ORDER BY version DESC
          LIMIT 1
        `,
      )
      .get(taskId, purpose) as ExecutionPlanRow | undefined;
    return row === undefined ? undefined : mapExecutionPlanRow(row);
  }

  nextVersion(taskId: string): number {
    const row = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(version), 0) + 1 AS next_version
          FROM execution_plans
          WHERE task_id = ?
        `,
      )
      .get(taskId) as { next_version: number };
    return row.next_version;
  }
}
