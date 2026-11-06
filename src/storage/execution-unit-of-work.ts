import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { ModelResponseSchema, type ToolCall } from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import { computeCanonicalInputHash, computeIdempotencyKey } from "../tools/fingerprint.js";
import { ToolModeSchema } from "../tools/types.js";
import { ApprovalRepository } from "./approval-repository.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { MessageRepository } from "./message-repository.js";
import { ModelCallRepository } from "./model-call-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryReviewRepository } from "./recovery-review-repository.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskRepository, type PersistedTaskInput } from "./task-repository.js";
import { TaskSnapshotReader } from "./task-snapshot.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { runInTransaction } from "./transaction.js";
import {
  BeginModelCallInputSchema,
  CompleteModelCallInputSchema,
  CreateTaskInputSchema,
  FailModelCallInputSchema,
  JsonValueSchema,
  PersistedErrorSchema,
  PlanStepKindSchema,
  PlanStepStatusSchema,
  UpdateTaskStatusInputSchema,
  type BeginModelCallInput,
  type CompleteModelCallInput,
  type CreateTaskInput,
  type FailModelCallInput,
  type ModelCallRecord,
  type PlanStepStatus,
  type TaskSnapshot,
  type TaskStatus,
} from "./types.js";
import { createStorageWritePermit } from "./write-boundary.js";

function nowIso(): string {
  return new Date().toISOString();
}

function checkpointBudget(task: {
  maxModelTurns: number;
  maxToolCalls: number;
}) {
  return {
    maxModelTurns: task.maxModelTurns,
    maxToolCalls: task.maxToolCalls,
  };
}

const Sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const PlannedToolRunInputSchema = z
  .object({
    id: z.string().min(1),
    planStepId: z.string().min(1),
    toolCallId: z.string().min(1),
    originalIndex: z.number().int().nonnegative(),
    toolName: z.string().min(1),
    toolVersion: z.string().trim().min(1),
    inputSchemaHash: Sha256HashSchema,
    canonicalInputHash: Sha256HashSchema,
    mode: ToolModeSchema,
    requiresApproval: z.boolean(),
    input: JsonValueSchema,
    attemptNo: z.number().int().positive().default(1),
  })
  .strict();

const PlannedPlanStepInputSchema = z
  .object({
    id: z.string().min(1),
    stepIndex: z.number().int().nonnegative(),
    kind: PlanStepKindSchema,
    status: PlanStepStatusSchema.default("queued"),
  })
  .strict();

const CompleteModelCallWithPlanInputSchema = z
  .object({
    modelCallId: z.string().min(1),
    response: ModelResponseSchema,
    durationMs: z.number().int().nonnegative(),
    plan: z
      .object({
        id: z.string().min(1),
        version: z.number().int().positive(),
        status: z.enum(["active", "completed", "failed", "cancelled"]).default("active"),
        steps: z.array(PlannedPlanStepInputSchema).min(1),
        toolRuns: z.array(PlannedToolRunInputSchema),
      })
      .strict(),
  })
  .strict();

const BeginToolRunInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    status: z.enum(["running", "awaiting_approval"]),
  })
  .strict();

const RequestApprovalInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    request: JsonValueSchema,
    expiresAt: z.string().min(1).optional(),
  })
  .strict();

const DecideApprovalInputSchema = z
  .object({
    approvalId: z.string().min(1),
    status: z.enum(["approved", "rejected", "expired", "cancelled"]),
    reason: z.string().optional(),
  })
  .strict();

const CompleteToolRunInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    status: z.enum([
      "succeeded",
      "failed",
      "timed_out",
      "unknown",
      "cancelled",
      "skipped",
    ]),
    output: JsonValueSchema.optional(),
    error: PersistedErrorSchema.optional(),
    messageContent: z.string().optional(),
    planStepStatus: PlanStepStatusSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "succeeded" && value.output === undefined) {
      context.addIssue({
        code: "custom",
        path: ["output"],
        message: "Successful tool runs require output.",
      });
    }
    if (
      ["failed", "timed_out", "unknown"].includes(value.status) &&
      value.error === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed, timed out, and unknown tool runs require an error.",
      });
    }
  });

const RequestRecoveryReviewInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    note: z.string().nullable().default(null),
  })
  .strict();

const DecideRecoveryReviewInputSchema = z
  .object({
    recoveryReviewId: z.string().min(1),
    status: z.enum([
      "confirmed_succeeded",
      "confirmed_not_executed",
      "unresolved",
    ]),
    note: z.string().nullable().default(null),
    sourceType: z.enum(["manual_review", "system_verification"]),
    evidenceRef: z.string().min(1).nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.status === "confirmed_succeeded" &&
      value.evidenceRef === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["evidenceRef"],
        message: "Confirmed success requires an evidence reference.",
      });
    }
  });

const OwnedLeaseContextSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const BeginOwnedToolRunInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    expectedToolRunVersion: z.number().int().positive(),
    ownership: OwnedLeaseContextSchema,
  })
  .strict();

const CompleteOwnedToolRunInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    expectedToolRunVersion: z.number().int().positive(),
    status: z.enum([
      "succeeded",
      "failed",
      "timed_out",
      "unknown",
      "cancelled",
      "skipped",
    ]),
    output: JsonValueSchema.optional(),
    error: PersistedErrorSchema.optional(),
    messageContent: z.string().optional(),
    ownership: OwnedLeaseContextSchema,
  })
  .strict();

const FinalizeOwnedToolRunBeforeStartInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    expectedToolRunVersion: z.number().int().positive(),
    status: z.enum(["failed", "skipped", "cancelled"]),
    error: PersistedErrorSchema,
    ownership: OwnedLeaseContextSchema,
  })
  .strict();

export type CompleteModelCallWithPlanInput = z.input<
  typeof CompleteModelCallWithPlanInputSchema
>;
export type BeginToolRunInput = z.input<typeof BeginToolRunInputSchema>;
export type RequestApprovalInput = z.input<typeof RequestApprovalInputSchema>;
export type DecideApprovalInput = z.input<typeof DecideApprovalInputSchema>;
export type CompleteToolRunInput = z.input<typeof CompleteToolRunInputSchema>;
export type RequestRecoveryReviewInput = z.input<
  typeof RequestRecoveryReviewInputSchema
>;
export type DecideRecoveryReviewInput = z.input<
  typeof DecideRecoveryReviewInputSchema
>;
export type BeginOwnedToolRunInput = z.input<
  typeof BeginOwnedToolRunInputSchema
>;
export type CompleteOwnedToolRunInput = z.input<
  typeof CompleteOwnedToolRunInputSchema
>;
export type FinalizeOwnedToolRunBeforeStartInput = z.input<
  typeof FinalizeOwnedToolRunBeforeStartInputSchema
>;
export type LeaseOwnershipContext = {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
};

export class ExecutionUnitOfWork {
  private readonly tasks: TaskRepository;
  private readonly messages: MessageRepository;
  private readonly modelCalls: ModelCallRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly plans: ExecutionPlanRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly approvals: ApprovalRepository;
  private readonly recoveryReviews: RecoveryReviewRepository;
  private readonly sequences: SequenceAllocator;
  private readonly snapshotReader: TaskSnapshotReader;

  constructor(
    private readonly database: Database.Database,
    private readonly leaseManager?: TaskLeaseManager,
  ) {
    this.sequences = new SequenceAllocator(database);
    this.tasks = new TaskRepository(database);
    this.messages = new MessageRepository(database, this.sequences);
    this.modelCalls = new ModelCallRepository(database);
    this.events = new EventRepository(database, this.sequences);
    this.checkpoints = new CheckpointStore(database, this.sequences);
    this.plans = new ExecutionPlanRepository(database);
    this.planSteps = new PlanStepRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    this.approvals = new ApprovalRepository(database);
    this.recoveryReviews = new RecoveryReviewRepository(database);
    this.snapshotReader = new TaskSnapshotReader(database);
  }

  createTask(input: CreateTaskInput): TaskSnapshot {
    const parsed = CreateTaskInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const taskInput: PersistedTaskInput = parsed;
        const task = this.tasks.insert(taskInput, now, permit);
        this.messages.append(
          {
            taskId: task.id,
            role: "system",
            content: task.systemPrompt,
          },
          now,
          permit,
        );
        this.messages.append(
          {
            taskId: task.id,
            role: "user",
            content: task.objective,
          },
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "task.created",
            payload: { status: task.status },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "task_created",
            taskStatus: task.status,
            lastMessageSequence: 2,
            modelIteration: 0,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {},
          },
          now,
          permit,
        );

        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  beginModelCall(
    input: BeginModelCallInput,
    ownership?: LeaseOwnershipContext,
  ): ModelCallRecord {
    const parsed = BeginModelCallInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        if (ownership !== undefined) {
          this.assertOwnedTask(ownership);
        }
        const task = this.tasks.get(parsed.taskId);
        const attemptNo =
          parsed.attemptNo ??
          this.sequences.nextModelCallAttempt(parsed.taskId, parsed.iteration);
        const modelCall = this.modelCalls.createRequested({
          id: randomUUID(),
          taskId: parsed.taskId,
          iteration: parsed.iteration,
          attemptNo,
          request: parsed.request,
          startedAt: now,
        }, permit);
        this.tasks.updateCurrentIteration(
          parsed.taskId,
          parsed.iteration,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: parsed.taskId,
            traceId: task.traceId,
            type: "llm.requested",
            entityType: "model_call",
            entityId: modelCall.id,
            payload: {
              iteration: parsed.iteration,
              attemptNo,
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: parsed.taskId,
            reason: "model_call_requested",
            taskStatus: task.status,
            lastMessageSequence:
              this.snapshotReader.load(parsed.taskId).messages.at(-1)?.sequence ?? 0,
            modelIteration: parsed.iteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { modelCallId: modelCall.id, attemptNo },
          },
          now,
          permit,
        );
        return modelCall;
      },
      "immediate",
    );
  }

  completeModelCall(
    input: CompleteModelCallInput,
    ownership?: LeaseOwnershipContext,
  ): TaskSnapshot {
    const parsed = CompleteModelCallInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        if (ownership !== undefined) {
          this.assertOwnedTask(ownership);
        }
        const modelCall = this.modelCalls.get(parsed.modelCallId);
        const task = this.tasks.get(modelCall.taskId);
        const completedCall = this.modelCalls.complete(
          parsed.modelCallId,
          parsed.response,
          parsed.durationMs,
          now,
          permit,
        );
        const message = this.messages.append(
          {
            taskId: task.id,
            role: "assistant",
            content: parsed.response.message.content,
            ...(parsed.response.message.toolCalls === undefined
              ? {}
              : { toolCalls: parsed.response.message.toolCalls }),
          },
          now,
          permit,
        );
        this.tasks.updateTokenUsage(task.id, parsed.response.usage, now, permit);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "llm.responded",
            entityType: "model_call",
            entityId: completedCall.id,
            payload: {
              finishReason: completedCall.finishReason,
              usageSource: completedCall.usage?.source ?? "unknown",
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "model_response",
            taskStatus: task.status,
            lastMessageSequence: message.sequence,
            modelIteration: modelCall.iteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { modelCallId: modelCall.id },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  failModelCall(
    input: FailModelCallInput,
    ownership?: LeaseOwnershipContext,
  ): TaskSnapshot {
    const parsed = FailModelCallInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        if (ownership !== undefined) {
          this.assertOwnedTask(ownership);
        }
        const modelCall = this.modelCalls.get(parsed.modelCallId);
        const task = this.tasks.get(modelCall.taskId);
        const failedCall = this.modelCalls.fail(
          parsed.modelCallId,
          parsed.status,
          parsed.durationMs,
          parsed.error,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: `llm.${parsed.status}`,
            entityType: "model_call",
            entityId: failedCall.id,
            payload: { errorCode: parsed.error.code },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "model_call_finished",
            taskStatus: task.status,
            lastMessageSequence:
              latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: modelCall.iteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { modelCallId: modelCall.id, status: parsed.status },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  updateTaskStatus(taskId: string, status: TaskStatus): TaskSnapshot {
    const parsed = UpdateTaskStatusInputSchema.parse({ taskId, status });
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const current = this.tasks.get(parsed.taskId);
        const completedAt =
          parsed.status === "completed" ||
          parsed.status === "failed" ||
          parsed.status === "cancelled"
            ? now
            : undefined;
        const updated = this.tasks.updateStatus(
          parsed.taskId,
          parsed.status,
          now,
          permit,
          current.finalAnswer ?? undefined,
          completedAt,
        );
        const event = this.events.append(
          {
            taskId: updated.id,
            traceId: updated.traceId,
            type: "task.status_changed",
            entityType: "task",
            entityId: updated.id,
            payload: {
              from: current.status,
              to: updated.status,
            },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(updated.id);
        this.checkpoints.append(
          {
            taskId: updated.id,
            reason: "task_status_changed",
            taskStatus: updated.status,
            lastMessageSequence:
              latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: updated.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(updated),
            metadata: { from: current.status, to: updated.status },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(updated.id);
      },
      "immediate",
    );
  }

  completeModelCallWithPlan(
    input: CompleteModelCallWithPlanInput,
    ownership?: LeaseOwnershipContext,
  ): TaskSnapshot {
    const parsed = CompleteModelCallWithPlanInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        if (ownership !== undefined) {
          this.assertOwnedTask(ownership);
        }
        const modelCall = this.modelCalls.get(parsed.modelCallId);
        const task = this.tasks.get(modelCall.taskId);
        const stepIds = new Set(parsed.plan.steps.map((step) => step.id));
        if (stepIds.size !== parsed.plan.steps.length) {
          throw new AppError({
            code: "PLAN_STEP_ID_DUPLICATE",
            message: "Plan step IDs must be unique.",
            statusCode: 400,
            details: [],
          });
        }

        const toolCalls = new Map(
          (parsed.response.message.toolCalls ?? []).map((call): [string, ToolCall] => [
            call.id,
            call,
          ]),
        );
        const callIds = new Set<string>();
        for (const toolRun of parsed.plan.toolRuns) {
          if (!stepIds.has(toolRun.planStepId)) {
            throw new AppError({
              code: "TOOL_RUN_PLAN_STEP_MISSING",
              message: "Tool run references a plan step outside this plan.",
              statusCode: 400,
              details: [],
            });
          }
          if (callIds.has(toolRun.toolCallId)) {
            throw new AppError({
              code: "TOOL_RUN_CALL_ID_DUPLICATE",
              message: "Tool run call IDs must be unique.",
              statusCode: 400,
              details: [],
            });
          }
          const call = toolCalls.get(toolRun.toolCallId);
          if (call === undefined || call.name !== toolRun.toolName) {
            throw new AppError({
              code: "TOOL_RUN_CALL_MISMATCH",
              message: "Tool run does not match the assistant tool call.",
              statusCode: 400,
              details: [],
            });
          }
          if (
            computeCanonicalInputHash(toolRun.input) !==
            toolRun.canonicalInputHash
          ) {
            throw new AppError({
              code: "TOOL_INPUT_HASH_MISMATCH",
              message: "Canonical tool input hash does not match the persisted input.",
              statusCode: 409,
              details: [],
            });
          }
          callIds.add(toolRun.toolCallId);
        }

        const completedCall = this.modelCalls.complete(
          parsed.modelCallId,
          parsed.response,
          parsed.durationMs,
          now,
          permit,
        );
        const message = this.messages.append(
          {
            taskId: task.id,
            role: "assistant",
            content: parsed.response.message.content,
            ...(parsed.response.message.toolCalls === undefined
              ? {}
              : { toolCalls: parsed.response.message.toolCalls }),
          },
          now,
          permit,
        );
        this.tasks.updateStatus(task.id, "running", now, permit);
        this.tasks.updateTokenUsage(task.id, parsed.response.usage, now, permit);

        const plan = this.plans.insert(
          {
            id: parsed.plan.id,
            taskId: task.id,
            version: parsed.plan.version,
            sourceModelCallId: completedCall.id,
            status: parsed.plan.status,
            createdAt: now,
          },
          permit,
        );
        for (const step of parsed.plan.steps) {
          this.planSteps.insert(
            {
              id: step.id,
              taskId: task.id,
              planId: plan.id,
              stepIndex: step.stepIndex,
              kind: step.kind,
              status: step.status,
              createdAt: now,
            },
            permit,
          );
        }

        let lastEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "llm.responded",
            entityType: "model_call",
            entityId: completedCall.id,
            payload: {
              finishReason: completedCall.finishReason,
            },
          },
          now,
          permit,
        );
        lastEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "plan.created",
            entityType: "execution_plan",
            entityId: plan.id,
            payload: {
              version: plan.version,
              stepCount: parsed.plan.steps.length,
            },
          },
          now,
          permit,
        );

        for (const toolRun of parsed.plan.toolRuns) {
          const idempotencyKey = computeIdempotencyKey({
            taskId: task.id,
            planVersion: plan.version,
            originalIndex: toolRun.originalIndex,
            toolName: toolRun.toolName,
            toolVersion: toolRun.toolVersion,
            inputSchemaHash: toolRun.inputSchemaHash,
            canonicalInputHash: toolRun.canonicalInputHash,
          });
          const created = this.toolRuns.createIntent(
            {
              ...toolRun,
              taskId: task.id,
              status: "queued",
              idempotencyKey,
              createdAt: now,
            },
            permit,
          );
          lastEvent = this.events.append(
            {
              taskId: task.id,
              traceId: task.traceId,
              type: "tool.queued",
              entityType: "tool_run",
              entityId: created.id,
              payload: {
                callId: created.toolCallId,
                originalIndex: created.originalIndex,
              },
            },
            now,
            permit,
          );
        }

        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "model_response_plan",
            taskStatus: "running",
            lastMessageSequence: message.sequence,
            modelIteration: modelCall.iteration,
            planVersion: plan.version,
            lastEventSequence: lastEvent.sequence,
            budget: checkpointBudget(task),
            metadata: {
              modelCallId: modelCall.id,
              planId: plan.id,
            },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  beginToolRun(input: BeginToolRunInput): TaskSnapshot {
    const parsed = BeginToolRunInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const current = this.toolRuns.get(parsed.toolRunId);
        const task = this.tasks.get(current.taskId);
        const running = this.toolRuns.transition(
          current.id,
          ["queued"],
          {
            status: parsed.status,
            updatedAt: now,
            ...(parsed.status === "running" ? { startedAt: now } : {}),
          },
          permit,
        );
        this.planSteps.updateStatus(
          running.planStepId,
          parsed.status === "running" ? "running" : "awaiting_approval",
          now,
          permit,
        );
        const taskStatus =
          parsed.status === "running" ? "running" : "waiting_approval";
        this.tasks.updateStatus(task.id, taskStatus, now, permit);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type:
              parsed.status === "running"
                ? "tool.started"
                : "tool.awaiting_approval",
            entityType: "tool_run",
            entityId: running.id,
            payload: {
              callId: running.toolCallId,
            },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "tool_intent",
            taskStatus,
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            planVersion: this.plans.get(
              this.planSteps.get(running.planStepId).planId,
            ).version,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { toolRunId: running.id, status: running.status },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  requestApproval(input: RequestApprovalInput): TaskSnapshot {
    const parsed = RequestApprovalInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const current = this.toolRuns.get(parsed.toolRunId);
        const task = this.tasks.get(current.taskId);
        if (
          current.mode !== "write" ||
          !current.requiresApproval
        ) {
          throw new AppError({
            code: "APPROVAL_NOT_REQUIRED",
            message: "Tool run does not require write approval.",
            statusCode: 409,
            details: [],
          });
        }

        const awaiting =
          current.status === "queued"
            ? this.toolRuns.transition(
                current.id,
                ["queued"],
                { status: "awaiting_approval", updatedAt: now },
                permit,
              )
            : current;
        if (awaiting.status !== "awaiting_approval") {
          throw new AppError({
            code: "APPROVAL_STATE_CONFLICT",
            message: "Tool run cannot request approval in its current state.",
            statusCode: 409,
            details: [],
          });
        }
        this.planSteps.updateStatus(
          awaiting.planStepId,
          "awaiting_approval",
          now,
          permit,
        );
        this.tasks.updateStatus(
          task.id,
          "waiting_approval",
          now,
          permit,
        );
        const approval = this.approvals.createPending(
          {
            id: randomUUID(),
            taskId: task.id,
            toolRunId: awaiting.id,
            toolVersion: awaiting.toolVersion,
            canonicalInputHash: awaiting.canonicalInputHash,
            request: parsed.request,
            requestedAt: now,
            expiresAt: parsed.expiresAt ?? null,
          },
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "approval.requested",
            entityType: "approval",
            entityId: approval.id,
            payload: { toolRunId: awaiting.id },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "approval_requested",
            taskStatus: "waiting_approval",
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { approvalId: approval.id, toolRunId: awaiting.id },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  decideApproval(input: DecideApprovalInput): TaskSnapshot {
    const parsed = DecideApprovalInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const currentApproval = this.approvals.get(parsed.approvalId);
        const toolRun = this.toolRuns.get(currentApproval.toolRunId);
        const task = this.tasks.get(currentApproval.taskId);
        if (
          currentApproval.toolVersion !== toolRun.toolVersion ||
          currentApproval.canonicalInputHash !==
            toolRun.canonicalInputHash
        ) {
          throw new AppError({
            code: "APPROVAL_BINDING_MISMATCH",
            message: "Approval does not match the tool run definition.",
            statusCode: 409,
            details: [],
          });
        }

        const approval = this.approvals.decide(
          currentApproval.id,
          parsed.status,
          parsed.reason ?? null,
          now,
          permit,
        );
        const nextToolStatus =
          parsed.status === "approved"
            ? "queued"
            : parsed.status === "cancelled"
              ? "cancelled"
              : "skipped";
        const updatedToolRun = this.toolRuns.transition(
          toolRun.id,
          ["awaiting_approval"],
          { status: nextToolStatus, updatedAt: now, finishedAt: parsed.status === "approved" ? null : now },
          permit,
        );
        const nextStepStatus =
          parsed.status === "approved"
            ? "queued"
            : parsed.status === "cancelled"
              ? "cancelled"
              : "skipped";
        this.planSteps.updateStatus(
          updatedToolRun.planStepId,
          nextStepStatus,
          now,
          permit,
        );
        // The decision is durable, but Task execution remains parked until a
        // Step 4 lease owner explicitly resumes it.
        const nextTaskStatus =
          parsed.status === "cancelled"
            ? "cancel_requested"
            : "waiting_approval";
        this.tasks.updateStatus(task.id, nextTaskStatus, now, permit);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: `approval.${parsed.status}`,
            entityType: "approval",
            entityId: approval.id,
            payload: {
              toolRunId: toolRun.id,
              reason: parsed.reason ?? null,
            },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "approval_decided",
            taskStatus: nextTaskStatus,
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              approvalId: approval.id,
              status: parsed.status,
            },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  completeToolRun(input: CompleteToolRunInput): TaskSnapshot {
    const parsed = CompleteToolRunInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const current = this.toolRuns.get(parsed.toolRunId);
        const task = this.tasks.get(current.taskId);
        if (
          current.mode === "write" &&
          current.status === "running" &&
          !["succeeded", "unknown"].includes(parsed.status)
        ) {
          throw new AppError({
            code: "WRITE_TOOL_RUN_UNKNOWN_REQUIRED",
            message: "A started write tool must complete as succeeded or unknown.",
            statusCode: 409,
            details: [],
          });
        }

        const completed = this.toolRuns.transition(
          current.id,
          ["running"],
          {
            status: parsed.status,
            updatedAt: now,
            finishedAt: now,
            ...(parsed.output === undefined
              ? {}
              : { output: parsed.output }),
            ...(parsed.error === undefined ? {} : { error: parsed.error }),
          },
          permit,
        );
        const resultPayload = {
          status: completed.status,
          ...(completed.output === null
            ? {}
            : { output: completed.output }),
          ...(completed.error === null
            ? {}
            : { error: completed.error }),
        };
        const message = this.messages.append(
          {
            taskId: task.id,
            role: "tool",
            toolCallId: completed.toolCallId,
            content:
              parsed.messageContent ?? JSON.stringify(resultPayload),
          },
          now,
          permit,
        );
        const planStepStatus =
          parsed.planStepStatus ??
          (completed.status === "unknown"
            ? "waiting_review"
            : completed.status === "succeeded"
              ? "completed"
              : completed.status === "cancelled"
                ? "cancelled"
                : completed.status === "skipped"
                  ? "skipped"
                  : "failed");
        this.planSteps.updateStatus(
          completed.planStepId,
          planStepStatus,
          now,
          permit,
        );
        const nextTaskStatus =
          completed.status === "unknown" ? "waiting_review" : "running";
        this.tasks.updateStatus(task.id, nextTaskStatus, now, permit);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: `tool.${completed.status}`,
            entityType: "tool_run",
            entityId: completed.id,
            payload: {
              callId: completed.toolCallId,
              status: completed.status,
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "tool_result",
            taskStatus: nextTaskStatus,
            lastMessageSequence: message.sequence,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              toolRunId: completed.id,
              status: completed.status,
            },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  requestRecoveryReview(input: RequestRecoveryReviewInput): TaskSnapshot {
    const parsed = RequestRecoveryReviewInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const toolRun = this.toolRuns.get(parsed.toolRunId);
        const task = this.tasks.get(toolRun.taskId);
        if (toolRun.mode !== "write" || toolRun.status !== "unknown") {
          throw new AppError({
            code: "RECOVERY_REVIEW_INVALID_TARGET",
            message: "Only an unknown write tool run can request recovery review.",
            statusCode: 409,
            details: [],
          });
        }
        const review = this.recoveryReviews.createPending(
          {
            id: randomUUID(),
            taskId: task.id,
            toolRunId: toolRun.id,
            note: parsed.note,
            createdAt: now,
          },
          permit,
        );
        this.planSteps.updateStatus(
          toolRun.planStepId,
          "waiting_review",
          now,
          permit,
        );
        this.tasks.updateStatus(task.id, "waiting_review", now, permit);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery_review.requested",
            entityType: "recovery_review",
            entityId: review.id,
            payload: { toolRunId: toolRun.id },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_review_requested",
            taskStatus: "waiting_review",
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              recoveryReviewId: review.id,
              toolRunId: toolRun.id,
            },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  decideRecoveryReview(input: DecideRecoveryReviewInput): TaskSnapshot {
    const parsed = DecideRecoveryReviewInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const currentReview = this.recoveryReviews.get(
          parsed.recoveryReviewId,
        );
        const toolRun = this.toolRuns.get(currentReview.toolRunId);
        const task = this.tasks.get(currentReview.taskId);
        const review = this.recoveryReviews.decide(
          currentReview.id,
          {
            status: parsed.status,
            note: parsed.note,
            sourceType: parsed.sourceType,
            evidenceRef: parsed.evidenceRef,
            decidedAt: now,
          },
          permit,
        );
        const planStepStatus =
          parsed.status === "confirmed_succeeded"
            ? "completed"
            : parsed.status === "confirmed_not_executed"
              ? "failed"
              : "waiting_review";
        this.planSteps.updateStatus(
          toolRun.planStepId,
          planStepStatus,
          now,
          permit,
        );
        // Recovery decisions remain parked until Step 4/6 can prove lease
        // ownership and complete the full recovery gate.
        const taskStatus = "waiting_review" as const;
        this.tasks.updateStatus(task.id, taskStatus, now, permit);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery_review.decided",
            entityType: "recovery_review",
            entityId: review.id,
            payload: {
              status: review.status,
              toolRunId: toolRun.id,
            },
          },
          now,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_review_decided",
            taskStatus,
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              recoveryReviewId: review.id,
              status: review.status,
            },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  beginOwnedToolRun(input: BeginOwnedToolRunInput): TaskSnapshot {
    const parsed = BeginOwnedToolRunInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        if (task.status !== "running") {
          throw new AppError({
            code: "TASK_NOT_RUNNING",
            message: "Task must be running before a tool intent can commit.",
            statusCode: 409,
            details: [],
          });
        }
        const current = this.toolRuns.get(parsed.toolRunId);
        if (
          current.taskId !== task.id ||
          current.status !== "queued" ||
          current.version !== parsed.expectedToolRunVersion
        ) {
          throw new AppError({
            code: "TOOL_RUN_STATE_CONFLICT",
            message: "Tool run changed while committing its intent.",
            statusCode: 409,
            details: [],
          });
        }
        const started = this.toolRuns.transition(
          current.id,
          ["queued"],
          {
            expectedVersion: parsed.expectedToolRunVersion,
            status: "running",
            startedAt: now,
            updatedAt: now,
          },
          permit,
        );
        const step = this.planSteps.get(started.planStepId);
        if (step.status === "queued") {
          this.planSteps.updateStatusCas(
            step.id,
            "queued",
            step.version,
            "running",
            now,
            permit,
          );
        }
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "tool.intent_committed",
            entityType: "tool_run",
            entityId: started.id,
            payload: {
              callId: started.toolCallId,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "tool_intent",
            taskStatus: task.status,
            lastMessageSequence:
              this.snapshotReader.load(task.id).messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { toolRunId: started.id },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  completeOwnedToolRun(input: CompleteOwnedToolRunInput): TaskSnapshot {
    const parsed = CompleteOwnedToolRunInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        const current = this.toolRuns.get(parsed.toolRunId);
        if (
          current.taskId !== task.id ||
          current.status !== "running" ||
          current.version !== parsed.expectedToolRunVersion
        ) {
          throw new AppError({
            code: "TOOL_RUN_STATE_CONFLICT",
            message: "Tool run changed while committing its result.",
            statusCode: 409,
            details: [],
          });
        }
        if (
          current.mode === "write" &&
          !["succeeded", "unknown"].includes(parsed.status)
        ) {
          throw new AppError({
            code: "WRITE_TOOL_RUN_UNKNOWN_REQUIRED",
            message: "A started write must finish as succeeded or unknown.",
            statusCode: 409,
            details: [],
          });
        }
        const completed = this.toolRuns.transition(
          current.id,
          ["running"],
          {
            expectedVersion: parsed.expectedToolRunVersion,
            status: parsed.status,
            finishedAt: now,
            updatedAt: now,
            ...(parsed.output === undefined
              ? {}
              : { output: parsed.output }),
            ...(parsed.error === undefined ? {} : { error: parsed.error }),
          },
          permit,
        );
        const resultPayload = {
          status: completed.status,
          ...(completed.output === null ? {} : { output: completed.output }),
          ...(completed.error === null ? {} : { error: completed.error }),
        };
        const message = this.messages.append(
          {
            taskId: task.id,
            role: "tool",
            toolCallId: completed.toolCallId,
            content:
              parsed.messageContent ?? JSON.stringify(resultPayload),
          },
          now,
          permit,
        );
        const step = this.planSteps.get(completed.planStepId);
        const nextStepStatus = this.resolvePlanStepStatus(
          step.id,
          step.status,
          completed.status,
        );
        if (nextStepStatus !== step.status) {
          this.planSteps.updateStatusCas(
            step.id,
            step.status,
            step.version,
            nextStepStatus,
            now,
            permit,
          );
        }
        let taskStatus = task.status;
        if (completed.status === "unknown" && task.status !== "waiting_review") {
          taskStatus = "waiting_review";
          this.tasks.updateStatusCas(
            task.id,
            task.status,
            task.version,
            "waiting_review",
            now,
            permit,
          );
        }
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: `tool.${completed.status}`,
            entityType: "tool_run",
            entityId: completed.id,
            payload: {
              callId: completed.toolCallId,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "tool_result",
            taskStatus,
            lastMessageSequence: message.sequence,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { toolRunId: completed.id, status: completed.status },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  finalizeOwnedToolRunBeforeStart(
    input: FinalizeOwnedToolRunBeforeStartInput,
  ): TaskSnapshot {
    const parsed = FinalizeOwnedToolRunBeforeStartInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        const current = this.toolRuns.get(parsed.toolRunId);
        if (
          current.taskId !== task.id ||
          !["queued", "awaiting_approval"].includes(current.status) ||
          current.version !== parsed.expectedToolRunVersion
        ) {
          throw new AppError({
            code: "TOOL_RUN_STATE_CONFLICT",
            message: "Tool run changed before its pre-execution result.",
            statusCode: 409,
            details: [],
          });
        }
        const finalized = this.toolRuns.transition(
          current.id,
          [current.status],
          {
            expectedVersion: parsed.expectedToolRunVersion,
            status: parsed.status,
            finishedAt: now,
            updatedAt: now,
            error: parsed.error,
          },
          permit,
        );
        const message = this.messages.append(
          {
            taskId: task.id,
            role: "tool",
            toolCallId: finalized.toolCallId,
            content: JSON.stringify({
              status: finalized.status,
              error: finalized.error,
            }),
          },
          now,
          permit,
        );
        const step = this.planSteps.get(finalized.planStepId);
        const nextStepStatus =
          finalized.status === "skipped"
            ? "skipped"
            : finalized.status === "cancelled"
              ? "cancelled"
              : "failed";
        this.planSteps.updateStatusCas(
          step.id,
          step.status,
          step.version,
          nextStepStatus,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: `tool.${finalized.status}`,
            entityType: "tool_run",
            entityId: finalized.id,
            payload: {
              callId: finalized.toolCallId,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "tool_result",
            taskStatus: task.status,
            lastMessageSequence: message.sequence,
            modelIteration: task.currentIteration,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: { toolRunId: finalized.id, status: finalized.status },
          },
          now,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  private assertOwnedTask(ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  }): {
    id: string;
    traceId: string;
    status: TaskStatus;
    version: number;
    currentIteration: number;
    maxModelTurns: number;
    maxToolCalls: number;
  } {
    if (this.leaseManager === undefined) {
      throw new AppError({
        code: "TASK_LEASE_REQUIRED",
        message: "Persistent execution requires an owned task lease.",
        statusCode: 409,
        details: [],
      });
    }
    this.leaseManager.assertOwned(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
    return this.tasks.get(ownership.taskId);
  }

  private resolvePlanStepStatus(
    planStepId: string,
    current: PlanStepStatus,
    resultStatus: string,
  ): PlanStepStatus {
    const siblings = this.toolRuns.listByPlanStep(planStepId);
    const hasActiveSibling = siblings.some((toolRun) =>
      ["queued", "awaiting_approval", "running", "interrupted"].includes(
        toolRun.status,
      ),
    );
    if (hasActiveSibling) {
      return current;
    }
    const hasUnknown = siblings.some((toolRun) => toolRun.status === "unknown");
    if (hasUnknown) {
      return "waiting_review";
    }
    if (current === "awaiting_approval" && resultStatus === "skipped") {
      return "skipped";
    }
    return "completed";
  }
}
