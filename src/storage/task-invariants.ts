import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import type { TaskStatus } from "./types.js";

export function assertTaskCanBecomeTerminal(
  database: Database.Database,
  taskId: string,
  status: Extract<TaskStatus, "completed" | "failed" | "cancelled">,
): void {
  const activeReview = database
    .prepare(
      `
        SELECT 1
        FROM recovery_reviews
        WHERE task_id = ?
          AND status IN ('pending', 'unresolved')
        LIMIT 1
      `,
    )
    .get(taskId);
  if (activeReview !== undefined) {
    throw new AppError({
      code: "TASK_RECOVERY_REVIEW_ACTIVE",
      message: "Task cannot become terminal with an active recovery review.",
      statusCode: 409,
      details: [],
    });
  }

  const activePlanStep = database
    .prepare(
      `
        SELECT 1
        FROM plan_steps
        WHERE task_id = ?
          AND status IN (
            'queued',
            'running',
            'awaiting_approval',
            'waiting_review',
            'interrupted'
          )
        LIMIT 1
      `,
    )
    .get(taskId);
  if (activePlanStep !== undefined) {
    throw new AppError({
      code: "TASK_ACTIVE_PLAN_STEP",
      message: "Task cannot become terminal with an active plan step.",
      statusCode: 409,
      details: [],
    });
  }

  const activeToolRun = database
    .prepare(
      `
        SELECT 1
        FROM tool_runs
        WHERE task_id = ?
          AND status IN ('queued', 'awaiting_approval', 'running', 'interrupted')
        LIMIT 1
      `,
    )
    .get(taskId);
  if (activeToolRun !== undefined) {
    throw new AppError({
      code: "TASK_ACTIVE_TOOL_RUN",
      message: "Task cannot become terminal with an active tool run.",
      statusCode: 409,
      details: [],
    });
  }

  const pendingApproval = database
    .prepare(
      `
        SELECT 1
        FROM approvals
        WHERE task_id = ?
          AND status = 'pending'
        LIMIT 1
      `,
    )
    .get(taskId);
  if (pendingApproval !== undefined) {
    throw new AppError({
      code: "TASK_APPROVAL_PENDING",
      message: "Task cannot become terminal with a pending approval.",
      statusCode: 409,
      details: [],
    });
  }

  const unresolvedUnknownWrite = database
    .prepare(
      `
        SELECT 1
        FROM tool_runs AS tool_run
        LEFT JOIN recovery_reviews AS recovery_review
          ON recovery_review.tool_run_id = tool_run.id
        LEFT JOIN plan_steps AS plan_step
          ON plan_step.id = tool_run.plan_step_id
        WHERE tool_run.task_id = ?
          AND tool_run.status = 'unknown'
          AND (
            recovery_review.id IS NULL
            OR recovery_review.status IN ('pending', 'unresolved')
            OR (
              recovery_review.status = 'confirmed_not_executed'
              AND plan_step.status != 'failed'
            )
          )
        LIMIT 1
      `,
    )
    .get(taskId);
  if (unresolvedUnknownWrite !== undefined) {
    throw new AppError({
      code: "TASK_UNKNOWN_WRITE_UNRESOLVED",
      message: "Task cannot become terminal with an unresolved unknown write.",
      statusCode: 409,
      details: [],
    });
  }

  if (status === "completed") {
    const unfinishedPlanStep = database
      .prepare(
        `
          SELECT 1
          FROM plan_steps
          WHERE task_id = ?
            AND status NOT IN ('completed', 'skipped')
          LIMIT 1
        `,
      )
      .get(taskId);
    if (unfinishedPlanStep !== undefined) {
      throw new AppError({
        code: "TASK_PLAN_STEP_UNFINISHED",
        message: "Completed task cannot retain an unfinished plan step.",
        statusCode: 409,
        details: [],
      });
    }
  }
}

export function assertTaskAcceptsActiveExecution(
  database: Database.Database,
  taskId: string,
): void {
  const row = database
    .prepare("SELECT status FROM tasks WHERE id = ?")
    .get(taskId) as { status: TaskStatus } | undefined;
  if (row === undefined) {
    throw new AppError({
      code: "TASK_NOT_FOUND",
      message: "Task was not found.",
      statusCode: 404,
      details: [],
    });
  }
  if (
    row.status === "completed" ||
    row.status === "failed" ||
    row.status === "cancelled"
  ) {
    throw new AppError({
      code: "TASK_TERMINAL",
      message: "A terminal task cannot accept new active execution data.",
      statusCode: 409,
      details: [],
    });
  }
}
