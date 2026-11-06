import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  PlanStepKindSchema,
  PlanStepStatusSchema,
  type PlanStepKind,
  type PlanStepRecord,
  type PlanStepStatus,
} from "./types.js";
import { assertTaskAcceptsActiveExecution } from "./task-invariants.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface PlanStepRow {
  id: string;
  task_id: string;
  plan_id: string;
  step_index: number;
  kind: string;
  status: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapPlanStepRow(row: PlanStepRow): PlanStepRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    planId: row.plan_id,
    stepIndex: row.step_index,
    kind: PlanStepKindSchema.parse(row.kind),
    status: PlanStepStatusSchema.parse(row.status),
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface CreatePlanStepInput {
  readonly id: string;
  readonly taskId: string;
  readonly planId: string;
  readonly stepIndex: number;
  readonly kind: PlanStepKind;
  readonly status: PlanStepStatus;
  readonly createdAt: string;
}

export class PlanStepRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreatePlanStepInput,
    permit: StorageWritePermit,
  ): PlanStepRecord {
    assertStorageWritePermit(this.database, permit);
    assertTaskAcceptsActiveExecution(this.database, input.taskId);
    this.database
      .prepare(
        `
          INSERT INTO plan_steps (
            id, task_id, plan_id, step_index, kind,
            status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.planId,
        input.stepIndex,
        PlanStepKindSchema.parse(input.kind),
        PlanStepStatusSchema.parse(input.status),
        input.createdAt,
        input.createdAt,
      );
    return this.get(input.id);
  }

  updateStatus(
    id: string,
    status: PlanStepStatus,
    updatedAt: string,
    permit: StorageWritePermit,
  ): PlanStepRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE plan_steps
          SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(PlanStepStatusSchema.parse(status), updatedAt, id);
    if (result.changes !== 1) {
      throw new AppError({
        code: "PLAN_STEP_NOT_FOUND",
        message: "Plan step was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return this.get(id);
  }

  updateStatusCas(
    id: string,
    expectedStatus: PlanStepStatus,
    expectedVersion: number,
    status: PlanStepStatus,
    updatedAt: string,
    permit: StorageWritePermit,
  ): PlanStepRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE plan_steps
          SET status = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND status = ? AND version = ?
        `,
      )
      .run(
        PlanStepStatusSchema.parse(status),
        updatedAt,
        id,
        PlanStepStatusSchema.parse(expectedStatus),
        expectedVersion,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "PLAN_STEP_STATE_CONFLICT",
        message: "Plan step changed while applying a transition.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  get(id: string): PlanStepRecord {
    const row = this.database
      .prepare("SELECT * FROM plan_steps WHERE id = ?")
      .get(id) as PlanStepRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "PLAN_STEP_NOT_FOUND",
        message: "Plan step was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapPlanStepRow(row);
  }

  listByTask(taskId: string): readonly PlanStepRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM plan_steps
            WHERE task_id = ?
            ORDER BY plan_id, step_index
          `,
        )
        .all(taskId) as PlanStepRow[]
    ).map(mapPlanStepRow);
  }
}
