import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import type { ToolMode } from "../tools/types.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { assertTaskCanBecomeTerminal } from "./task-invariants.js";
import { TaskRepository } from "./task-repository.js";
import { TaskSnapshotReader } from "./task-snapshot.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import { runInTransaction } from "./transaction.js";
import {
  JsonValueSchema,
  PersistedErrorSchema,
  PlanStepStatusSchema,
  TaskStatusSchema,
  ToolRunStatusSchema,
  type PlanStepStatus,
  type PlanStepRecord,
  type TaskRecord,
  type TaskSnapshot,
  type TaskStatus,
  type ToolRunStatus,
} from "./types.js";
import { createStorageWritePermit } from "./write-boundary.js";

const OwnershipInputSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
    expectedTaskVersion: z.number().int().positive(),
  })
  .strict();

const TaskTransitionInputSchema = OwnershipInputSchema.extend({
  expectedStatus: TaskStatusSchema,
  status: TaskStatusSchema,
  finalAnswer: z.string().optional(),
}).strict();

const ToolRunTransitionInputSchema = OwnershipInputSchema.extend({
  toolRunId: z.string().min(1),
  expectedStatus: ToolRunStatusSchema,
  expectedVersion: z.number().int().positive(),
  status: ToolRunStatusSchema,
  output: JsonValueSchema.optional(),
  error: PersistedErrorSchema.optional(),
  startedAt: z.string().min(1).optional(),
  finishedAt: z.string().min(1).optional(),
}).strict();

const PlanStepTransitionInputSchema = OwnershipInputSchema.extend({
  planStepId: z.string().min(1),
  expectedStatus: PlanStepStatusSchema,
  expectedVersion: z.number().int().positive(),
  status: PlanStepStatusSchema,
}).strict();

export type TaskTransitionInput = z.input<
  typeof TaskTransitionInputSchema
>;
export type ToolRunGuardedTransitionInput = z.input<
  typeof ToolRunTransitionInputSchema
>;
export type PlanStepGuardedTransitionInput = z.input<
  typeof PlanStepTransitionInputSchema
>;
export type RequestCancelInput = z.input<typeof OwnershipInputSchema>;

export interface ExecutionStateMachineOptions {
  readonly now?: () => Date;
}

const TASK_TRANSITIONS: Readonly<
  Record<TaskStatus, readonly TaskStatus[]>
> = {
  queued: ["running", "cancel_requested"],
  running: [
    "pause_requested",
    "cancel_requested",
    "waiting_approval",
    "waiting_review",
    "completed",
    "failed",
  ],
  pause_requested: ["paused", "waiting_review", "cancel_requested"],
  paused: ["running", "cancel_requested"],
  cancel_requested: ["cancelled", "waiting_review"],
  waiting_approval: ["running", "cancel_requested", "failed"],
  waiting_review: ["running", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

const READ_TOOL_TRANSITIONS: Readonly<
  Record<ToolRunStatus, readonly ToolRunStatus[]>
> = {
  queued: ["running", "failed", "skipped", "cancelled"],
  awaiting_approval: [],
  running: ["succeeded", "failed", "timed_out", "cancelled", "interrupted"],
  interrupted: ["queued", "failed", "skipped", "cancelled"],
  succeeded: [],
  failed: [],
  timed_out: [],
  unknown: [],
  cancelled: [],
  skipped: [],
};

const WRITE_TOOL_TRANSITIONS: Readonly<
  Record<ToolRunStatus, readonly ToolRunStatus[]>
> = {
  queued: ["awaiting_approval", "running", "failed", "skipped", "cancelled"],
  awaiting_approval: ["queued", "running", "failed", "skipped", "cancelled"],
  running: ["succeeded", "unknown"],
  interrupted: [],
  succeeded: [],
  failed: [],
  timed_out: [],
  unknown: [],
  cancelled: [],
  skipped: [],
};

const PLAN_STEP_TRANSITIONS: Readonly<
  Record<PlanStepStatus, readonly PlanStepStatus[]>
> = {
  queued: [
    "running",
    "awaiting_approval",
    "failed",
    "skipped",
    "cancelled",
  ],
  running: [
    "completed",
    "failed",
    "cancelled",
    "waiting_review",
    "interrupted",
  ],
  awaiting_approval: ["running", "failed", "skipped", "cancelled"],
  waiting_review: ["completed", "failed", "cancelled"],
  interrupted: ["running", "failed", "skipped", "cancelled"],
  completed: [],
  failed: [],
  skipped: [],
  cancelled: [],
};

export function canTransitionTaskStatus(
  from: TaskStatus,
  to: TaskStatus,
): boolean {
  return TASK_TRANSITIONS[from].includes(to);
}

export function canTransitionToolRunStatus(
  mode: ToolMode,
  from: ToolRunStatus,
  to: ToolRunStatus,
): boolean {
  return (
    mode === "read" ? READ_TOOL_TRANSITIONS : WRITE_TOOL_TRANSITIONS
  )[from].includes(to);
}

export function canTransitionPlanStepStatus(
  from: PlanStepStatus,
  to: PlanStepStatus,
): boolean {
  return PLAN_STEP_TRANSITIONS[from].includes(to);
}

export class ExecutionStateMachine {
  private readonly tasks: TaskRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly leases: TaskLeaseManager;
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    leases: TaskLeaseManager,
    options: ExecutionStateMachineOptions = {},
  ) {
    this.leases = leases;
    this.now = options.now ?? (() => new Date());
    this.tasks = new TaskRepository(database);
    this.planSteps = new PlanStepRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    const sequences = new SequenceAllocator(database);
    this.events = new EventRepository(database, sequences);
    this.checkpoints = new CheckpointStore(database, sequences);
    this.snapshotReader = new TaskSnapshotReader(database);
  }

  transitionTask(input: TaskTransitionInput): TaskSnapshot {
    const parsed = TaskTransitionInputSchema.parse(input);
    const now = this.now().toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(
          parsed,
          parsed.expectedStatus,
        );
        if (!canTransitionTaskStatus(task.status, parsed.status)) {
          throw this.invalidTransition(
            "task",
            task.status,
            parsed.status,
          );
        }
        this.assertTaskTransitionPreconditions(task, parsed.status);
        const options = {
          ...(parsed.finalAnswer === undefined
            ? {}
            : { finalAnswer: parsed.finalAnswer }),
          ...(parsed.status === "completed" ||
          parsed.status === "failed" ||
          parsed.status === "cancelled"
            ? { completedAt: now }
            : {}),
          ...(parsed.status === "cancel_requested"
            ? { cancelRequestedAt: now }
            : {}),
          ...(parsed.status === "pause_requested"
            ? { pauseRequestedAt: now }
            : {}),
        };
        const updated = this.tasks.updateStatusCas(
          task.id,
          task.status,
          parsed.expectedTaskVersion,
          parsed.status,
          now,
          permit,
          options,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "task.transitioned",
            entityType: "task",
            entityId: task.id,
            payload: {
              from: task.status,
              to: updated.status,
              fencingToken: parsed.fencingToken,
            },
          },
          now,
          permit,
        );
        this.appendCheckpoint(
          updated.id,
          updated.traceId,
          updated.status,
          "task_transitioned",
          now,
          event.sequence,
          permit,
        );
        return this.snapshotReader.load(updated.id);
      },
      "immediate",
    );
  }

  requestCancel(input: RequestCancelInput): TaskSnapshot {
    const parsed = OwnershipInputSchema.parse(input);
    const now = this.now().toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed);
        if (
          task.status !== "waiting_review" &&
          !canTransitionTaskStatus(task.status, "cancel_requested")
        ) {
          throw this.invalidTransition(
            "task",
            task.status,
            "cancel_requested",
          );
        }
        const nextStatus =
          task.status === "waiting_review"
            ? "waiting_review"
            : "cancel_requested";
        const updated = this.tasks.updateStatusCas(
          task.id,
          task.status,
          parsed.expectedTaskVersion,
          nextStatus,
          now,
          permit,
          { cancelRequestedAt: now },
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "task.cancel_requested",
            entityType: "task",
            entityId: task.id,
            payload: {
              status: updated.status,
              fencingToken: parsed.fencingToken,
            },
          },
          now,
          permit,
        );
        this.appendCheckpoint(
          task.id,
          task.traceId,
          updated.status,
          "task_cancel_requested",
          now,
          event.sequence,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  transitionToolRun(input: ToolRunGuardedTransitionInput): TaskSnapshot {
    const parsed = ToolRunTransitionInputSchema.parse(input);
    const now = this.now().toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        this.assertOwnedTask(parsed);
        const current = this.toolRuns.get(parsed.toolRunId);
        if (
          current.taskId !== parsed.taskId ||
          current.status !== parsed.expectedStatus ||
          current.version !== parsed.expectedVersion
        ) {
          throw new AppError({
            code: "TOOL_RUN_STATE_CONFLICT",
            message: "Tool run changed while applying a transition.",
            statusCode: 409,
            details: [],
          });
        }
        if (
          !canTransitionToolRunStatus(
            current.mode,
            current.status,
            parsed.status,
          )
        ) {
          throw this.invalidTransition(
            "tool run",
            current.status,
            parsed.status,
          );
        }
        const task = this.tasks.get(parsed.taskId);
        if (parsed.status === "running" && task.status !== "running") {
          throw new AppError({
            code: "TASK_NOT_RUNNING",
            message: "Task must be running before a tool run can start.",
            statusCode: 409,
            details: [],
          });
        }
        const updated = this.toolRuns.transition(
          current.id,
          [current.status],
          {
            expectedVersion: parsed.expectedVersion,
            status: parsed.status,
            updatedAt: now,
            ...(parsed.startedAt === undefined
              ? {}
              : { startedAt: parsed.startedAt }),
            ...(parsed.finishedAt === undefined
              ? {}
              : { finishedAt: parsed.finishedAt }),
            ...(parsed.output === undefined
              ? {}
              : { output: parsed.output }),
            ...(parsed.error === undefined ? {} : { error: parsed.error }),
          },
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "tool_run.transitioned",
            entityType: "tool_run",
            entityId: updated.id,
            payload: {
              from: current.status,
              to: updated.status,
              mode: updated.mode,
              fencingToken: parsed.fencingToken,
            },
          },
          now,
          permit,
        );
        this.appendCheckpoint(
          task.id,
          task.traceId,
          task.status,
          "tool_run_transitioned",
          now,
          event.sequence,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  transitionPlanStep(
    input: PlanStepGuardedTransitionInput,
  ): TaskSnapshot {
    const parsed = PlanStepTransitionInputSchema.parse(input);
    const now = this.now().toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        this.assertOwnedTask(parsed);
        const current = this.planSteps.get(parsed.planStepId);
        if (
          current.taskId !== parsed.taskId ||
          current.status !== parsed.expectedStatus ||
          current.version !== parsed.expectedVersion
        ) {
          throw new AppError({
            code: "PLAN_STEP_STATE_CONFLICT",
            message: "Plan step changed while applying a transition.",
            statusCode: 409,
            details: [],
          });
        }
        if (
          !canTransitionPlanStepStatus(current.status, parsed.status)
        ) {
          throw this.invalidTransition(
            "plan step",
            current.status,
            parsed.status,
          );
        }
        this.assertPlanStepExecutionSemantics(current, parsed.status);
        const task = this.tasks.get(parsed.taskId);
        const updated = this.planSteps.updateStatusCas(
          current.id,
          current.status,
          parsed.expectedVersion,
          parsed.status,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "plan_step.transitioned",
            entityType: "plan_step",
            entityId: updated.id,
            payload: {
              from: current.status,
              to: updated.status,
              fencingToken: parsed.fencingToken,
            },
          },
          now,
          permit,
        );
        this.appendCheckpoint(
          task.id,
          task.traceId,
          task.status,
          "plan_step_transitioned",
          now,
          event.sequence,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  private assertOwnedTask(
    input: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
      readonly expectedTaskVersion: number;
    },
    expectedStatus?: TaskStatus,
  ): TaskRecord {
    this.leases.assertOwned(
      input.taskId,
      input.leaseToken,
      input.fencingToken,
    );
    const task = this.tasks.get(input.taskId);
    if (
      task.version !== input.expectedTaskVersion ||
      (expectedStatus !== undefined && task.status !== expectedStatus)
    ) {
      throw new AppError({
        code: "TASK_STATE_CONFLICT",
        message: "Task changed while applying a transition.",
        statusCode: 409,
        details: [],
      });
    }
    return task;
  }

  private assertTaskTransitionPreconditions(
    task: TaskRecord,
    status: TaskStatus,
  ): void {
    if (status === "running" && task.status === "waiting_review") {
      this.assertReviewRecoveryComplete(task.id);
      if (task.cancelRequestedAt !== null) {
        throw new AppError({
          code: "TASK_CANCEL_REQUESTED",
          message: "A task with cancel intent cannot resume.",
          statusCode: 409,
          details: [],
        });
      }
    }
    if (
      status === "completed" ||
      status === "failed" ||
      status === "cancelled"
    ) {
      this.assertTerminalInvariants(task.id, status);
    }
  }

  private assertReviewRecoveryComplete(taskId: string): void {
    const activeReview = this.database
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
        message: "Task cannot resume while recovery review is active.",
        statusCode: 409,
        details: [],
      });
    }

    const incompleteRecovery = this.database
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
    if (incompleteRecovery !== undefined) {
      throw new AppError({
        code: "TASK_RECOVERY_REVIEW_INCOMPLETE",
        message: "Task recovery review has not reached a safe conclusion.",
        statusCode: 409,
        details: [],
      });
    }
  }

  private assertPlanStepExecutionSemantics(
    step: PlanStepRecord,
    status: PlanStepStatus,
  ): void {
    if (status !== "interrupted" && status !== "waiting_review") {
      return;
    }
    const toolRuns = this.toolRuns.listByPlanStep(step.id);
    if (
      status === "interrupted" &&
      (step.kind !== "read_batch" ||
        toolRuns.some((toolRun) => toolRun.mode !== "read"))
    ) {
      throw new AppError({
        code: "PLAN_STEP_CRASH_TRANSITION_INVALID",
        message: "Only a Read Batch can enter interrupted after a crash.",
        statusCode: 409,
        details: [],
      });
    }
    if (
      status === "waiting_review" &&
      (step.kind !== "write" ||
        !toolRuns.some(
          (toolRun) => toolRun.mode === "write" && toolRun.status === "unknown",
        ))
    ) {
      throw new AppError({
        code: "PLAN_STEP_CRASH_TRANSITION_INVALID",
        message: "A Write PlanStep requires an unknown ToolRun before review.",
        statusCode: 409,
        details: [],
      });
    }
  }

  private assertTerminalInvariants(
    taskId: string,
    status: "completed" | "failed" | "cancelled",
  ): void {
    assertTaskCanBecomeTerminal(this.database, taskId, status);
  }

  private appendCheckpoint(
    taskId: string,
    traceId: string,
    taskStatus: TaskStatus,
    reason: string,
    now: string,
    eventSequence: number,
    permit: ReturnType<typeof createStorageWritePermit>,
  ): void {
    const task = this.tasks.get(taskId);
    const latestMessage = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM messages
          WHERE task_id = ?
        `,
      )
      .get(taskId) as { sequence: number };
    const latestPlan = this.database
      .prepare(
        `
          SELECT MAX(version) AS version
          FROM execution_plans
          WHERE task_id = ? AND purpose = 'agent'
        `,
      )
      .get(taskId) as { version: number | null };
    this.checkpoints.append(
      {
        taskId,
        reason,
        taskStatus,
        lastMessageSequence: latestMessage.sequence,
        modelIteration: task.currentIteration,
        planVersion: latestPlan.version,
        lastEventSequence: eventSequence,
        budget: {
          maxModelTurns: task.maxModelTurns,
          maxToolCalls: task.maxToolCalls,
        },
        metadata: { traceId },
      },
      now,
      permit,
    );
  }

  private invalidTransition(
    entity: string,
    from: string,
    to: string,
  ): AppError {
    return new AppError({
      code: "INVALID_STATE_TRANSITION",
      message: `Invalid ${entity} transition from ${from} to ${to}.`,
      statusCode: 409,
      details: [],
    });
  }
}
