import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { aggregateModelUsage } from "../context/token-usage.js";
import { ModelResponseSchema, type ToolCall } from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import { computeCanonicalInputHash, computeIdempotencyKey } from "../tools/fingerprint.js";
import { ToolModeSchema } from "../tools/types.js";
import type { RecoveryEvidenceEnvelope } from "../recovery/recovery-evidence.js";
import type { EvidencePayloadStore } from "../recovery/evidence-payload-store.js";
import { ApprovalRepository } from "./approval-repository.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { MessageRepository } from "./message-repository.js";
import { ModelCallRepository } from "./model-call-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryReviewRepository } from "./recovery-review-repository.js";
import { RecoveryReviewOperationRepository } from "./recovery-review-operation-repository.js";
import { RecoveryEvidenceSubmissionRepository } from "./recovery-evidence-submission-repository.js";
import {
  computeRecoveryReviewOperationRequestKey,
} from "./recovery-review-operation-keys.js";
import {
  assertRecoveryReviewOperationCapability,
  type RecoveryReviewOperationCapability,
} from "./recovery-review-operation-capability.js";
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
  RecoveryEvidencePayloadStorageModeSchema,
  TaskStatusSchema,
  UpdateTaskStatusInputSchema,
  type BeginModelCallInput,
  type CompleteModelCallInput,
  type CreateTaskInput,
  type FailModelCallInput,
  type ModelCallRecord,
  type PlanStepStatus,
  type RecoveryReviewOperationRecord,
  type RecoveryEvidenceSubmissionRecord,
  type TaskSnapshot,
  type TaskStatus,
} from "./types.js";
import { createStorageWritePermit } from "./write-boundary.js";
import { assertMultiWriteBarrier } from "./recovery-multi-write-barrier-policy.js";

function nowIso(): string {
  return new Date().toISOString();
}

function checkpointBudget(task: {
  maxModelTurns: number;
  maxToolCalls: number;
  maxTokens?: number | null;
}) {
  return {
    maxModelTurns: task.maxModelTurns,
    maxToolCalls: task.maxToolCalls,
    ...(task.maxTokens === undefined || task.maxTokens === null
      ? {}
      : { maxTokens: task.maxTokens }),
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
    expectedPlanStepVersion: z.number().int().positive(),
    ownership: OwnedLeaseContextSchema,
  })
  .strict();

const RecoverOwnedRunningWriteInputSchema = z
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

const RecordRecoveryInspectionInputSchema = z
  .object({
    ownership: OwnedLeaseContextSchema,
    expectedTaskVersion: z.number().int().positive(),
    classification: z.string().min(1),
    findingCount: z.number().int().nonnegative(),
    recommendedNextAction: z.string().min(1),
    inspectedAt: z.string().min(1),
  })
  .strict();

const RecordReadRecoveryInputSchema = z
  .object({
    ownership: OwnedLeaseContextSchema,
    expectedTaskVersion: z.number().int().positive(),
    requeuedCount: z.number().int().nonnegative(),
    attemptedCount: z.number().int().nonnegative(),
    succeededCount: z.number().int().nonnegative(),
    failedCount: z.number().int().nonnegative(),
    inspectedAt: z.string().min(1),
  })
  .strict();

const CommitOwnedRecoveryReviewOperationInputSchema = z
  .object({
    capability: z.custom<RecoveryReviewOperationCapability>(
      (value) => typeof value === "object" && value !== null,
    ),
    ownership: OwnedLeaseContextSchema,
    expectedTaskVersion: z.number().int().positive(),
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    operation: z.literal("advance_decision_version"),
    actorId: z.string().trim().min(1),
    operationPayloadDigest: Sha256HashSchema,
    requestKey: Sha256HashSchema,
  })
  .strict();

const SubmitOwnedRecoveryEvidenceInputSchema = z
  .object({
    capability: z.custom<RecoveryReviewOperationCapability>(
      (value) => typeof value === "object" && value !== null,
    ),
    ownership: OwnedLeaseContextSchema,
    expectedTaskVersion: z.number().int().positive(),
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    evidenceSubmissionId: z.string().min(1),
    envelope: z.custom<RecoveryEvidenceEnvelope>(
      (value) => typeof value === "object" && value !== null,
    ),
    envelopeDigest: Sha256HashSchema,
    operationActorId: z.string().trim().min(1),
    operationPayloadDigest: Sha256HashSchema,
    payloadStoreRef: z.string().min(1).nullable(),
    payloadStorageMode: RecoveryEvidencePayloadStorageModeSchema,
    requestKey: Sha256HashSchema,
  })
  .strict();

const MarkOwnedRecoveryReviewUnresolvedInputSchema = z
  .object({
    capability: z.custom<RecoveryReviewOperationCapability>(
      (value) => typeof value === "object" && value !== null,
    ),
    ownership: OwnedLeaseContextSchema,
    expectedTaskVersion: z.number().int().positive(),
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    actorId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    referencedEvidenceEnvelopeDigest: Sha256HashSchema.nullable(),
    operationPayloadDigest: Sha256HashSchema,
    requestKey: Sha256HashSchema,
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
export type RecoverOwnedRunningWriteInput = z.input<
  typeof RecoverOwnedRunningWriteInputSchema
>;
export type CompleteOwnedToolRunInput = z.input<
  typeof CompleteOwnedToolRunInputSchema
>;
export type FinalizeOwnedToolRunBeforeStartInput = z.input<
  typeof FinalizeOwnedToolRunBeforeStartInputSchema
>;
export type RecordRecoveryInspectionInput = z.input<
  typeof RecordRecoveryInspectionInputSchema
>;
export type RecordReadRecoveryInput = z.input<
  typeof RecordReadRecoveryInputSchema
>;
export type CommitOwnedRecoveryReviewOperationInput = z.input<
  typeof CommitOwnedRecoveryReviewOperationInputSchema
>;
export type SubmitOwnedRecoveryEvidenceInput = z.input<
  typeof SubmitOwnedRecoveryEvidenceInputSchema
>;
export type MarkOwnedRecoveryReviewUnresolvedInput = z.input<
  typeof MarkOwnedRecoveryReviewUnresolvedInputSchema
>;
export type LeaseOwnershipContext = {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
};

export interface RecoveryReviewOperationCommitResult {
  readonly operation: RecoveryReviewOperationRecord;
  readonly replayed: boolean;
  readonly evidenceSubmission?: RecoveryEvidenceSubmissionRecord | null;
}

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
  private readonly recoveryReviewOperations: RecoveryReviewOperationRepository;
  private readonly recoveryEvidenceSubmissions: RecoveryEvidenceSubmissionRepository;
  private readonly sequences: SequenceAllocator;
  private readonly snapshotReader: TaskSnapshotReader;

  constructor(
    private readonly database: Database.Database,
    private readonly leaseManager?: TaskLeaseManager,
    private readonly finalReviewPayloadStore?: EvidencePayloadStore,
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
    this.recoveryReviewOperations =
      new RecoveryReviewOperationRepository(database);
    this.recoveryEvidenceSubmissions =
      new RecoveryEvidenceSubmissionRepository(database);
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
    assertAuthority?: () => void,
  ): ModelCallRecord {
    const parsed = BeginModelCallInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = CompleteModelCallInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
        this.tasks.updateTokenUsage(
          task.id,
          aggregateModelUsage(
            this.modelCalls.listByTask(task.id).flatMap((call) =>
              call.usage === null ? [] : [call.usage],
            ),
          ),
          now,
          permit,
        );
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
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = FailModelCallInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = CompleteModelCallWithPlanInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
        this.tasks.updateTokenUsage(
          task.id,
          aggregateModelUsage(
            this.modelCalls.listByTask(task.id).flatMap((call) =>
              call.usage === null ? [] : [call.usage],
            ),
          ),
          now,
          permit,
        );

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
              usageSource: completedCall.usage?.source ?? "unknown",
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

  requestApproval(input: RequestApprovalInput, ownership?: LeaseOwnershipContext): TaskSnapshot {
    const parsed = RequestApprovalInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const current = this.toolRuns.get(parsed.toolRunId);
        const task = this.tasks.get(current.taskId);
        if (ownership !== undefined) {
          const owned = this.assertOwnedTask(ownership);
          if (owned.id !== task.id) {
            throw new AppError({ code: "TASK_LEASE_NOT_OWNED", message: "Approval task lease mismatch.", statusCode: 409 });
          }
        }
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

  decideApproval(input: DecideApprovalInput, ownership?: LeaseOwnershipContext): TaskSnapshot {
    const parsed = DecideApprovalInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const currentApproval = this.approvals.get(parsed.approvalId);
        const toolRun = this.toolRuns.get(currentApproval.toolRunId);
        const task = this.tasks.get(currentApproval.taskId);
        if (ownership !== undefined) {
          const owned = this.assertOwnedTask(ownership);
          if (owned.id !== task.id) {
            throw new AppError({ code: "TASK_LEASE_NOT_OWNED", message: "Approval task lease mismatch.", statusCode: 409 });
          }
        }
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
        if (parsed.status !== "approved") {
          this.messages.append(
            {
              taskId: task.id,
              role: "tool",
              toolCallId: updatedToolRun.toolCallId,
              content: JSON.stringify({
                status: parsed.status === "rejected" ? "skipped" : "cancelled",
                error: {
                  code: parsed.status === "rejected" ? "WRITE_APPROVAL_REJECTED" : "WRITE_APPROVAL_CANCELLED",
                  message: "The write was not started because approval was not granted.",
                  details: [],
                },
              }),
            },
            now,
            permit,
          );
        }
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

  commitOwnedRecoveryReviewOperation(
    input: CommitOwnedRecoveryReviewOperationInput,
    assertAuthority?: () => void,
  ): RecoveryReviewOperationCommitResult {
    const parsed =
      CommitOwnedRecoveryReviewOperationInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
        assertRecoveryReviewOperationCapability(parsed.capability);
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);

        const computedRequestKey =
          computeRecoveryReviewOperationRequestKey({
            reviewId: parsed.reviewId,
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            operation: parsed.operation,
            operationPayloadDigest: parsed.operationPayloadDigest,
            actorId: parsed.actorId,
          });
        if (computedRequestKey !== parsed.requestKey) {
          throw new AppError({
            code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
            message: "Review operation request key does not match its payload.",
            statusCode: 409,
            details: [],
          });
        }

        const existing =
          this.recoveryReviewOperations.getByRequestKey(parsed.requestKey);
        if (existing !== undefined) {
          if (
            existing.taskId !== task.id ||
            existing.reviewId !== parsed.reviewId ||
            existing.operation !== parsed.operation ||
            existing.expectedDecisionVersion !==
              parsed.expectedDecisionVersion ||
            existing.resultingDecisionVersion !==
              parsed.expectedDecisionVersion + 1 ||
            existing.status !== "applied" ||
            existing.actorId !== parsed.actorId ||
            existing.operationPayloadDigest !==
              parsed.operationPayloadDigest ||
            existing.evidenceEnvelopeDigest !== null ||
            existing.resultPlanId !== null ||
            existing.resultToolRunId !== null
          ) {
            throw new AppError({
              code: "RECOVERY_REVIEW_REQUEST_KEY_CONFLICT",
              message:
                "Review operation request key was already used with different content.",
              statusCode: 409,
              details: [],
            });
          }
          return { operation: existing, replayed: true };
        }

        if (task.version !== parsed.expectedTaskVersion) {
          throw new AppError({
            code: "TASK_STATE_CONFLICT",
            message: "Task changed before the review operation was committed.",
            statusCode: 409,
            details: [],
          });
        }

        const review = this.recoveryReviews.get(parsed.reviewId);
        if (review.taskId !== task.id) {
          throw new AppError({
            code: "RECOVERY_REVIEW_TASK_MISMATCH",
            message: "Recovery review does not belong to the owned task.",
            statusCode: 409,
            details: [],
          });
        }
        if (review.reviewProtocolVersion < 1) {
          throw new AppError({
            code: "RECOVERY_REVIEW_PROTOCOL_REQUIRED",
            message:
              "Lease-owned review operations require protocol v1.",
            statusCode: 409,
            details: [],
          });
        }
        if (!["pending", "unresolved"].includes(review.status)) {
          throw new AppError({
            code: "RECOVERY_REVIEW_NOT_ACTIVE",
            message: "Recovery review is not active.",
            statusCode: 409,
            details: [],
          });
        }
        if (review.decisionVersion !== parsed.expectedDecisionVersion) {
          throw new AppError({
            code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            message: "Recovery review decision version has changed.",
            statusCode: 409,
            details: [],
          });
        }
        const toolRun = this.toolRuns.get(review.toolRunId);
        if (
          toolRun.taskId !== task.id ||
          toolRun.mode !== "write" ||
          toolRun.status !== "unknown"
        ) {
          throw new AppError({
            code: "RECOVERY_REVIEW_TARGET_INVALID",
            message: "Recovery review target is not an unknown write.",
            statusCode: 409,
            details: [],
          });
        }

        const resultingDecisionVersion =
          parsed.expectedDecisionVersion + 1;
        const update = this.database
          .prepare(
            `
              UPDATE recovery_reviews
              SET decision_version = ?, updated_at = ?
              WHERE id = ?
                AND task_id = ?
                AND review_protocol_version >= 1
                AND status IN ('pending', 'unresolved')
                AND decision_version = ?
            `,
          )
          .run(
            resultingDecisionVersion,
            now,
            review.id,
            task.id,
            parsed.expectedDecisionVersion,
          );
        if (update.changes !== 1) {
          throw new AppError({
            code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            message: "Recovery review decision version has changed.",
            statusCode: 409,
            details: [],
          });
        }

        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.review_operation.applied",
            entityType: "recovery_review",
            entityId: review.id,
            payload: {
              operation: parsed.operation,
              expectedDecisionVersion: parsed.expectedDecisionVersion,
              resultingDecisionVersion,
              actorId: parsed.actorId,
              operationPayloadDigest: parsed.operationPayloadDigest,
              requestKey: parsed.requestKey,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const operation = this.recoveryReviewOperations.append(
          {
            id: randomUUID(),
            taskId: task.id,
            reviewId: review.id,
            requestKey: parsed.requestKey,
            operation: parsed.operation,
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            resultingDecisionVersion,
            status: "applied",
            actorId: parsed.actorId,
            operationPayloadDigest: parsed.operationPayloadDigest,
            evidenceEnvelopeDigest: null,
            resultPlanId: null,
            resultToolRunId: null,
            appliedEventId: event.id,
            createdAt: now,
          },
          permit,
        );

        const latestMessage = this.database
          .prepare(
            `
              SELECT COALESCE(MAX(sequence), 0) AS sequence
              FROM messages
              WHERE task_id = ?
            `,
          )
          .get(task.id) as { sequence: number };
        const latestPlan = this.database
          .prepare(
            `
              SELECT MAX(version) AS version
              FROM execution_plans
              WHERE task_id = ? AND purpose = 'agent'
            `,
          )
          .get(task.id) as { version: number | null };
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_review_operation",
            taskStatus: task.status,
            lastMessageSequence: latestMessage.sequence,
            modelIteration: task.currentIteration,
            planVersion: latestPlan.version,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              recoveryReviewId: review.id,
              operation: operation.operation,
              expectedDecisionVersion: parsed.expectedDecisionVersion,
              resultingDecisionVersion,
            },
          },
          now,
          permit,
        );
        return { operation, replayed: false };
      },
      "immediate",
    );
  }

  submitOwnedRecoveryEvidence(
    input: SubmitOwnedRecoveryEvidenceInput,
    assertAuthority?: () => void,
  ): RecoveryReviewOperationCommitResult {
    const parsed =
      SubmitOwnedRecoveryEvidenceInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
        assertRecoveryReviewOperationCapability(parsed.capability);
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        if (parsed.envelopeDigest !== parsed.operationPayloadDigest) {
          throw new AppError({
            code: "RECOVERY_EVIDENCE_DIGEST_MISMATCH",
            message:
              "Evidence envelope digest must be the operation payload digest.",
            statusCode: 409,
            details: [],
          });
        }
        const computedRequestKey =
          computeRecoveryReviewOperationRequestKey({
            reviewId: parsed.reviewId,
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            operation: "submit_evidence",
            operationPayloadDigest: parsed.operationPayloadDigest,
            actorId: parsed.operationActorId,
          });
        if (computedRequestKey !== parsed.requestKey) {
          throw new AppError({
            code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
            message: "Review operation request key does not match its payload.",
            statusCode: 409,
            details: [],
          });
        }

        const existing =
          this.recoveryReviewOperations.getByRequestKey(parsed.requestKey);
        if (existing !== undefined) {
          if (
            existing.taskId !== task.id ||
            existing.reviewId !== parsed.reviewId ||
            existing.operation !== "submit_evidence" ||
            existing.expectedDecisionVersion !==
              parsed.expectedDecisionVersion ||
            existing.resultingDecisionVersion !==
              parsed.expectedDecisionVersion + 1 ||
            existing.status !== "applied" ||
            existing.actorId !== parsed.operationActorId ||
            existing.operationPayloadDigest !==
              parsed.operationPayloadDigest ||
            existing.evidenceEnvelopeDigest !==
              parsed.envelopeDigest ||
            existing.resultPlanId !== null ||
            existing.resultToolRunId !== null
          ) {
            throw new AppError({
              code: "RECOVERY_REVIEW_REQUEST_KEY_CONFLICT",
              message:
                "Review operation request key was already used with different content.",
              statusCode: 409,
              details: [],
            });
          }
          const existingSubmission =
            this.recoveryEvidenceSubmissions.getByRequestKey(
              parsed.requestKey,
            );
          if (existingSubmission !== undefined) {
            if (
              existingSubmission.operationId !== existing.id ||
              existingSubmission.evidenceRef !==
                parsed.envelope.evidenceRef ||
              existingSubmission.envelopeDigest !==
                parsed.envelopeDigest ||
              existingSubmission.payloadStoreRef !==
                parsed.payloadStoreRef ||
              existingSubmission.payloadStorageMode !==
                parsed.payloadStorageMode
            ) {
              throw new AppError({
                code: "RECOVERY_REVIEW_REQUEST_KEY_CONFLICT",
                message:
                  "Evidence manifest does not match the persisted operation.",
                statusCode: 409,
                details: [],
              });
            }
          }
          return {
            operation: existing,
            replayed: true,
            evidenceSubmission: existingSubmission ?? null,
          };
        }

        if (task.version !== parsed.expectedTaskVersion) {
          throw new AppError({
            code: "TASK_STATE_CONFLICT",
            message: "Task changed before evidence was submitted.",
            statusCode: 409,
            details: [],
          });
        }
        if (
          parsed.envelope.verifiedAt !== null ||
          parsed.envelope.taskId !== task.id
        ) {
          throw new AppError({
            code: "RECOVERY_EVIDENCE_TRUST_BOUNDARY_INVALID",
            message:
              "Submitted evidence must be unverified and belong to the task.",
            statusCode: 409,
            details: [],
          });
        }
        const review = this.recoveryReviews.get(parsed.reviewId);
        if (review.taskId !== task.id) {
          throw new AppError({
            code: "RECOVERY_REVIEW_TASK_MISMATCH",
            message: "Recovery review does not belong to the owned task.",
            statusCode: 409,
            details: [],
          });
        }
        if (review.reviewProtocolVersion < 1) {
          throw new AppError({
            code: "RECOVERY_REVIEW_PROTOCOL_REQUIRED",
            message: "Evidence submission requires protocol v1.",
            statusCode: 409,
            details: [],
          });
        }
        if (!["pending", "unresolved"].includes(review.status)) {
          throw new AppError({
            code: "RECOVERY_REVIEW_NOT_ACTIVE",
            message: "Final recovery reviews do not accept new evidence.",
            statusCode: 409,
            details: [],
          });
        }
        if (review.decisionVersion !== parsed.expectedDecisionVersion) {
          throw new AppError({
            code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            message: "Recovery review decision version has changed.",
            statusCode: 409,
            details: [],
          });
        }
        const toolRun = this.toolRuns.get(review.toolRunId);
        if (
          toolRun.taskId !== task.id ||
          toolRun.mode !== "write" ||
          toolRun.status !== "unknown" ||
          parsed.envelope.toolRunId !== toolRun.id ||
          parsed.envelope.toolName !== toolRun.toolName ||
          parsed.envelope.toolVersion !== toolRun.toolVersion ||
          parsed.envelope.inputSchemaHash !== toolRun.inputSchemaHash ||
          parsed.envelope.canonicalInputHash !==
            toolRun.canonicalInputHash ||
          parsed.envelope.idempotencyKey !== toolRun.idempotencyKey
        ) {
          throw new AppError({
            code: "RECOVERY_EVIDENCE_BINDING_MISMATCH",
            message:
              "Evidence does not match the reviewed unknown Write ToolRun.",
            statusCode: 409,
            details: [],
          });
        }

        const resultingDecisionVersion =
          parsed.expectedDecisionVersion + 1;
        const update = this.database
          .prepare(
            `
              UPDATE recovery_reviews
              SET decision_version = ?,
                  source_type = ?,
                  evidence_ref = ?,
                  evidence_payload_digest = ?,
                  evidence_payload_type = ?,
                  evidence_digest_protocol = ?,
                  evidence_envelope_digest = ?,
                  actor_id = ?,
                  verifier_id = ?,
                  verification_id = ?,
                  source_observed_at = ?,
                  submitted_at = ?,
                  verified_at = NULL,
                  updated_at = ?
              WHERE id = ?
                AND task_id = ?
                AND review_protocol_version >= 1
                AND status IN ('pending', 'unresolved')
                AND decision_version = ?
            `,
          )
          .run(
            resultingDecisionVersion,
            parsed.envelope.sourceType,
            parsed.envelope.evidenceRef,
            parsed.envelope.payloadDigest,
            parsed.envelope.payloadType,
            parsed.envelope.payloadDigestProtocol,
            parsed.envelopeDigest,
            parsed.envelope.actorId,
            parsed.envelope.verifierId,
            parsed.envelope.verificationId,
            parsed.envelope.sourceObservedAt,
            parsed.envelope.submittedAt,
            now,
            review.id,
            task.id,
            parsed.expectedDecisionVersion,
          );
        if (update.changes !== 1) {
          throw new AppError({
            code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            message: "Recovery review decision version has changed.",
            statusCode: 409,
            details: [],
          });
        }

        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.submitted",
            entityType: "recovery_review",
            entityId: review.id,
            payload: {
              evidenceSubmissionId: parsed.evidenceSubmissionId,
              reviewId: review.id,
              toolRunId: toolRun.id,
              sourceType: parsed.envelope.sourceType,
              outcome: parsed.envelope.outcome,
              evidenceRef: parsed.envelope.evidenceRef,
              resourceRef: parsed.envelope.resourceRef,
              resourceVersion: parsed.envelope.resourceVersion,
              sourceObservedAt: parsed.envelope.sourceObservedAt,
              submittedAt: parsed.envelope.submittedAt,
              payloadType: parsed.envelope.payloadType,
              payloadDigestProtocol:
                parsed.envelope.payloadDigestProtocol,
              payloadDigest: parsed.envelope.payloadDigest,
              envelopeDigest: parsed.envelopeDigest,
              actorId: parsed.envelope.actorId,
              verifierId: parsed.envelope.verifierId,
              verificationId: parsed.envelope.verificationId,
              payloadStoreRef: parsed.payloadStoreRef,
              payloadStorageMode: parsed.payloadStorageMode,
              decisionVersion: resultingDecisionVersion,
              operationRequestKey: parsed.requestKey,
              fencingToken: parsed.ownership.fencingToken,
              trustStatus: "unverified",
              finalEligible: false,
              trustReason:
                parsed.envelope.payloadType === "external_reference"
                  ? "external_adapter_not_executed"
                  : "final_verification_not_executed",
            },
          },
          now,
          permit,
        );
        const operation = this.recoveryReviewOperations.append(
          {
            id: randomUUID(),
            taskId: task.id,
            reviewId: review.id,
            requestKey: parsed.requestKey,
            operation: "submit_evidence",
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            resultingDecisionVersion,
            status: "applied",
            actorId: parsed.operationActorId,
            operationPayloadDigest: parsed.operationPayloadDigest,
            evidenceEnvelopeDigest: parsed.envelopeDigest,
            resultPlanId: null,
            resultToolRunId: null,
            appliedEventId: event.id,
            createdAt: now,
          },
          permit,
        );
        const evidenceSubmission =
          this.recoveryEvidenceSubmissions.insert(
            {
              id: parsed.evidenceSubmissionId,
              taskId: task.id,
              reviewId: review.id,
              toolRunId: toolRun.id,
              operationId: operation.id,
              requestKey: parsed.requestKey,
              decisionVersion: resultingDecisionVersion,
              sourceType: parsed.envelope.sourceType,
              outcome: parsed.envelope.outcome,
              evidenceRef: parsed.envelope.evidenceRef,
              resourceRef: parsed.envelope.resourceRef,
              resourceVersion: parsed.envelope.resourceVersion,
              sourceObservedAt: parsed.envelope.sourceObservedAt,
              submittedAt: parsed.envelope.submittedAt,
              actorId: parsed.envelope.actorId,
              verifierId: parsed.envelope.verifierId,
              verificationId: parsed.envelope.verificationId,
              payloadType: parsed.envelope.payloadType,
              payloadDigestProtocol:
                parsed.envelope.payloadDigestProtocol,
              payloadDigest: parsed.envelope.payloadDigest,
              envelopeDigest: parsed.envelopeDigest,
              payloadStoreRef: parsed.payloadStoreRef,
              payloadStorageMode: parsed.payloadStorageMode,
              appliedEventId: event.id,
              createdAt: now,
            },
            permit,
          );
        this.appendReviewOperationCheckpoint(
          task,
          "recovery_evidence_submitted",
          event.sequence,
          {
            recoveryReviewId: review.id,
            toolRunId: toolRun.id,
            evidenceSubmissionId: evidenceSubmission.id,
            operation: operation.operation,
            decisionVersion: resultingDecisionVersion,
            trustStatus: "unverified",
          },
          now,
          permit,
        );
        return {
          operation,
          replayed: false,
          evidenceSubmission,
        };
      },
      "immediate",
    );
  }

  markOwnedRecoveryReviewUnresolved(
    input: MarkOwnedRecoveryReviewUnresolvedInput,
    assertAuthority?: () => void,
  ): RecoveryReviewOperationCommitResult {
    const parsed =
      MarkOwnedRecoveryReviewUnresolvedInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
        assertRecoveryReviewOperationCapability(parsed.capability);
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        const computedRequestKey =
          computeRecoveryReviewOperationRequestKey({
            reviewId: parsed.reviewId,
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            operation: "mark_unresolved",
            operationPayloadDigest: parsed.operationPayloadDigest,
            actorId: parsed.actorId,
          });
        if (computedRequestKey !== parsed.requestKey) {
          throw new AppError({
            code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
            message: "Review operation request key does not match its payload.",
            statusCode: 409,
            details: [],
          });
        }

        const existing =
          this.recoveryReviewOperations.getByRequestKey(parsed.requestKey);
        if (existing !== undefined) {
          if (
            existing.taskId !== task.id ||
            existing.reviewId !== parsed.reviewId ||
            existing.operation !== "mark_unresolved" ||
            existing.expectedDecisionVersion !==
              parsed.expectedDecisionVersion ||
            existing.resultingDecisionVersion !==
              parsed.expectedDecisionVersion + 1 ||
            existing.status !== "applied" ||
            existing.actorId !== parsed.actorId ||
            existing.operationPayloadDigest !==
              parsed.operationPayloadDigest ||
            existing.evidenceEnvelopeDigest !==
              parsed.referencedEvidenceEnvelopeDigest ||
            existing.resultPlanId !== null ||
            existing.resultToolRunId !== null
          ) {
            throw new AppError({
              code: "RECOVERY_REVIEW_REQUEST_KEY_CONFLICT",
              message:
                "Review operation request key was already used with different content.",
              statusCode: 409,
              details: [],
            });
          }
          return { operation: existing, replayed: true };
        }

        if (task.version !== parsed.expectedTaskVersion) {
          throw new AppError({
            code: "TASK_STATE_CONFLICT",
            message:
              "Task changed before the review was marked unresolved.",
            statusCode: 409,
            details: [],
          });
        }
        const review = this.recoveryReviews.get(parsed.reviewId);
        if (review.taskId !== task.id) {
          throw new AppError({
            code: "RECOVERY_REVIEW_TASK_MISMATCH",
            message: "Recovery review does not belong to the owned task.",
            statusCode: 409,
            details: [],
          });
        }
        if (review.reviewProtocolVersion < 1) {
          throw new AppError({
            code: "RECOVERY_REVIEW_PROTOCOL_REQUIRED",
            message: "Unresolved decisions require protocol v1.",
            statusCode: 409,
            details: [],
          });
        }
        if (!["pending", "unresolved"].includes(review.status)) {
          throw new AppError({
            code: "RECOVERY_REVIEW_FINAL",
            message: "Final recovery reviews cannot become unresolved.",
            statusCode: 409,
            details: [],
          });
        }
        if (review.decisionVersion !== parsed.expectedDecisionVersion) {
          throw new AppError({
            code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            message: "Recovery review decision version has changed.",
            statusCode: 409,
            details: [],
          });
        }
        if (
          parsed.referencedEvidenceEnvelopeDigest !== null &&
          !this.recoveryReviewOperations
            .listByReview(review.id)
            .some(
              (operation) =>
                operation.operation === "submit_evidence" &&
                operation.status === "applied" &&
                operation.evidenceEnvelopeDigest ===
                  parsed.referencedEvidenceEnvelopeDigest,
            )
        ) {
          throw new AppError({
            code: "RECOVERY_UNRESOLVED_EVIDENCE_NOT_FOUND",
            message:
              "Unresolved decision references unknown submitted evidence.",
            statusCode: 409,
            details: [],
          });
        }
        const nextSourceType = review.sourceType ?? "manual_review";
        const nextActorId =
          review.actorId ??
          (nextSourceType === "manual_review" ? parsed.actorId : null);
        const resultingDecisionVersion =
          parsed.expectedDecisionVersion + 1;
        const update = this.database
          .prepare(
            `
              UPDATE recovery_reviews
              SET status = 'unresolved',
                  note = ?,
                  decision_version = ?,
                  source_type = ?,
                  actor_id = ?,
                  decided_at = COALESCE(decided_at, ?),
                  updated_at = ?
              WHERE id = ?
                AND task_id = ?
                AND review_protocol_version >= 1
                AND status IN ('pending', 'unresolved')
                AND decision_version = ?
            `,
          )
          .run(
            parsed.reason,
            resultingDecisionVersion,
            nextSourceType,
            nextActorId,
            now,
            now,
            review.id,
            task.id,
            parsed.expectedDecisionVersion,
          );
        if (update.changes !== 1) {
          throw new AppError({
            code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
            message: "Recovery review decision version has changed.",
            statusCode: 409,
            details: [],
          });
        }

        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.review.unresolved",
            entityType: "recovery_review",
            entityId: review.id,
            payload: {
              reviewId: review.id,
              toolRunId: review.toolRunId,
              reason: parsed.reason,
              referencedEvidenceEnvelopeDigest:
                parsed.referencedEvidenceEnvelopeDigest,
              decisionVersion: resultingDecisionVersion,
              operationRequestKey: parsed.requestKey,
              actorId: parsed.actorId,
              fencingToken: parsed.ownership.fencingToken,
              trustStatus: "unverified",
            },
          },
          now,
          permit,
        );
        const operation = this.recoveryReviewOperations.append(
          {
            id: randomUUID(),
            taskId: task.id,
            reviewId: review.id,
            requestKey: parsed.requestKey,
            operation: "mark_unresolved",
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            resultingDecisionVersion,
            status: "applied",
            actorId: parsed.actorId,
            operationPayloadDigest: parsed.operationPayloadDigest,
            evidenceEnvelopeDigest:
              parsed.referencedEvidenceEnvelopeDigest,
            resultPlanId: null,
            resultToolRunId: null,
            appliedEventId: event.id,
            createdAt: now,
          },
          permit,
        );
        this.appendReviewOperationCheckpoint(
          task,
          "recovery_review_unresolved",
          event.sequence,
          {
            recoveryReviewId: review.id,
            toolRunId: review.toolRunId,
            operation: operation.operation,
            decisionVersion: resultingDecisionVersion,
            referencedEvidenceEnvelopeDigest:
              parsed.referencedEvidenceEnvelopeDigest,
          },
          now,
          permit,
        );
        return { operation, replayed: false };
      },
      "immediate",
    );
  }

  beginOwnedToolRunAfterWriteBarrier(
    input: BeginOwnedToolRunInput,
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = BeginOwnedToolRunInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
        const step = this.planSteps.get(current.planStepId);
        const plan = this.plans.get(step.planId);
        if (step.taskId !== task.id || plan.taskId !== task.id ||
            plan.purpose !== "agent" || plan.status !== "active" ||
            step.version !== parsed.expectedPlanStepVersion ||
            !["queued", "running"].includes(step.status) ||
            (current.mode === "write" && step.kind !== "write") ||
            (current.mode === "read" && step.kind !== "read_batch")) {
          throw new AppError({
            code: "TOOL_RUN_ADMISSION_STATE_CONFLICT",
            message: "The tool run or its plan step is not eligible for execution.",
            statusCode: 409,
            details: [],
          });
        }
        if (current.mode === "write") {
          assertMultiWriteBarrier(this.snapshotReader.load(task.id), current,
            this.finalReviewPayloadStore);
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

  recoverOwnedRunningWriteAsUnknown(
    input: RecoverOwnedRunningWriteInput,
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = RecoverOwnedRunningWriteInputSchema.parse(input);
    const now = nowIso();
    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        if (["completed", "failed", "cancelled"].includes(task.status)) {
          throw new AppError({
            code: "TASK_TERMINAL",
            message: "A terminal task cannot recover an interrupted write.",
            statusCode: 409,
            details: [],
          });
        }
        const run = this.toolRuns.get(parsed.toolRunId);
        const step = this.planSteps.get(run.planStepId);
        if (
          run.taskId !== task.id ||
          run.mode !== "write" ||
          run.status !== "running" ||
          run.version !== parsed.expectedToolRunVersion ||
          step.taskId !== task.id ||
          step.kind !== "write" ||
          step.status !== "running"
        ) {
          throw new AppError({
            code: "WRITE_RECOVERY_STATE_CONFLICT",
            message: "The interrupted write is not eligible for unknown settlement.",
            statusCode: 409,
            details: [],
          });
        }
        const unknown = this.toolRuns.transition(
          run.id,
          ["running"],
          {
            expectedVersion: run.version,
            status: "unknown",
            finishedAt: now,
            updatedAt: now,
            error: {
              code: "WRITE_OUTCOME_UNKNOWN_AFTER_PROCESS_EXIT",
              message: "The process exited after the write started, so its outcome requires review.",
              details: [],
            },
          },
          permit,
        );
        this.planSteps.updateStatusCas(
          step.id,
          "running",
          step.version,
          "waiting_review",
          now,
          permit,
        );
        this.tasks.updateStatusCas(
          task.id,
          task.status,
          task.version,
          "waiting_review",
          now,
          permit,
        );
        const message = this.messages.append(
          {
            taskId: task.id,
            role: "tool",
            toolCallId: unknown.toolCallId,
            content: JSON.stringify({
              status: "unknown",
              error: unknown.error,
            }),
          },
          now,
          permit,
        );
        const review = this.recoveryReviews.createPending(
          {
            id: randomUUID(),
            taskId: task.id,
            toolRunId: unknown.id,
            note: "Write was still running when the owning process exited.",
            createdAt: now,
          },
          permit,
        );
        const unknownEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "tool.unknown",
            entityType: "tool_run",
            entityId: unknown.id,
            payload: {
              callId: unknown.toolCallId,
              reasonCode: "PROCESS_EXIT_AFTER_WRITE_START",
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const reviewEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery_review.requested",
            entityType: "recovery_review",
            entityId: review.id,
            payload: {
              toolRunId: unknown.id,
              reasonCode: "PROCESS_EXIT_AFTER_WRITE_START",
              unknownEventId: unknownEvent.id,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_write_interrupted",
            taskStatus: "waiting_review",
            lastMessageSequence: message.sequence,
            modelIteration: task.currentIteration,
            lastEventSequence: reviewEvent.sequence,
            budget: checkpointBudget(task),
            metadata: {
              toolRunId: unknown.id,
              recoveryReviewId: review.id,
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

  completeOwnedToolRun(
    input: CompleteOwnedToolRunInput,
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = CompleteOwnedToolRunInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
        this.settleAgentPlanIfTerminal(task.id, step.planId, now, permit);
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
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = FinalizeOwnedToolRunBeforeStartInputSchema.parse(input);
    const now = nowIso();

    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
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
        this.settleAgentPlanIfTerminal(task.id, step.planId, now, permit);
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

  recordRecoveryInspection(
    input: RecordRecoveryInspectionInput,
  ): TaskSnapshot {
    const parsed = RecordRecoveryInspectionInputSchema.parse(input);

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        if (task.version !== parsed.expectedTaskVersion) {
          throw new AppError({
            code: "TASK_STATE_CONFLICT",
            message: "Task changed before recovery inspection was recorded.",
            statusCode: 409,
            details: [],
          });
        }
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.inspected",
            entityType: "task",
            entityId: task.id,
            payload: {
              classification: parsed.classification,
              findingCount: parsed.findingCount,
              recommendedNextAction: parsed.recommendedNextAction,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          parsed.inspectedAt,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        const latestPlan = this.plans.listAgentByTask(task.id).at(-1);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_inspected",
            taskStatus: task.status,
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            planVersion: latestPlan?.version ?? null,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              classification: parsed.classification,
              findingCount: parsed.findingCount,
            },
          },
          parsed.inspectedAt,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  recordRecoveryInspectionWithoutSnapshot(
    input: RecordRecoveryInspectionInput,
  ): void {
    const parsed = RecordRecoveryInspectionInputSchema.parse(input);

    runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        if (this.leaseManager === undefined) {
          throw new AppError({
            code: "TASK_LEASE_REQUIRED",
            message: "Persistent execution requires an owned task lease.",
            statusCode: 409,
            details: [],
          });
        }
        this.leaseManager.assertOwned(
          parsed.ownership.taskId,
          parsed.ownership.leaseToken,
          parsed.ownership.fencingToken,
        );
        const task = this.database
          .prepare(
            `
              SELECT id, trace_id, status, current_iteration,
                     max_model_turns, max_tool_calls, version
              FROM tasks
              WHERE id = ?
            `,
          )
          .get(parsed.ownership.taskId) as
          | {
              id: string;
              trace_id: string;
              status: string;
              current_iteration: number;
              max_model_turns: number;
              max_tool_calls: number;
              version: number;
            }
          | undefined;
        if (task === undefined) {
          throw new AppError({
            code: "TASK_NOT_FOUND",
            message: "Task was not found.",
            statusCode: 404,
            details: [],
          });
        }
        if (task.version !== parsed.expectedTaskVersion) {
          throw new AppError({
            code: "TASK_STATE_CONFLICT",
            message: "Task changed before recovery inspection was recorded.",
            statusCode: 409,
            details: [],
          });
        }
        const taskStatus = TaskStatusSchema.parse(task.status);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.trace_id,
            type: "recovery.inspected",
            entityType: "task",
            entityId: task.id,
            payload: {
              classification: parsed.classification,
              findingCount: parsed.findingCount,
              recommendedNextAction: parsed.recommendedNextAction,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          parsed.inspectedAt,
          permit,
        );
        const latestMessage = this.database
          .prepare(
            `
              SELECT COALESCE(MAX(sequence), 0) AS sequence
              FROM messages
              WHERE task_id = ?
            `,
          )
          .get(task.id) as { sequence: number };
        const latestPlan = this.database
          .prepare(
            `
              SELECT MAX(version) AS version
              FROM execution_plans
              WHERE task_id = ? AND purpose = 'agent'
            `,
          )
          .get(task.id) as { version: number | null };
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_inspected",
            taskStatus,
            lastMessageSequence: latestMessage.sequence,
            modelIteration: task.current_iteration,
            planVersion: latestPlan.version,
            lastEventSequence: event.sequence,
            budget: {
              maxModelTurns: task.max_model_turns,
              maxToolCalls: task.max_tool_calls,
            },
            metadata: {
              classification: parsed.classification,
              findingCount: parsed.findingCount,
            },
          },
          parsed.inspectedAt,
          permit,
        );
      },
      "immediate",
    );
  }

  recordReadRecovery(
    input: RecordReadRecoveryInput,
    assertAuthority?: () => void,
  ): TaskSnapshot {
    const parsed = RecordReadRecoveryInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        assertAuthority?.();
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        if (task.version !== parsed.expectedTaskVersion) {
          throw new AppError({
            code: "TASK_STATE_CONFLICT",
            message: "Task changed before read recovery was recorded.",
            statusCode: 409,
            details: [],
          });
        }
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type:
              parsed.requeuedCount > 0
                ? "recovery.read_retried"
                : "recovery.read_completed",
            entityType: "task",
            entityId: task.id,
            payload: {
              requeuedCount: parsed.requeuedCount,
              attemptedCount: parsed.attemptedCount,
              succeededCount: parsed.succeededCount,
              failedCount: parsed.failedCount,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          parsed.inspectedAt,
          permit,
        );
        const latest = this.snapshotReader.load(task.id);
        const latestPlan = this.plans.listAgentByTask(task.id).at(-1);
        this.checkpoints.append(
          {
            taskId: task.id,
            reason: "recovery_read_completed",
            taskStatus: task.status,
            lastMessageSequence: latest.messages.at(-1)?.sequence ?? 0,
            modelIteration: task.currentIteration,
            planVersion: latestPlan?.version ?? null,
            lastEventSequence: event.sequence,
            budget: checkpointBudget(task),
            metadata: {
              requeuedCount: parsed.requeuedCount,
              attemptedCount: parsed.attemptedCount,
              succeededCount: parsed.succeededCount,
              failedCount: parsed.failedCount,
            },
          },
          parsed.inspectedAt,
          permit,
        );
        return this.snapshotReader.load(task.id);
      },
      "immediate",
    );
  }

  private settleAgentPlanIfTerminal(
    taskId: string,
    planId: string,
    now: string,
    permit: ReturnType<typeof createStorageWritePermit>,
  ): void {
    const plan = this.plans.get(planId);
    if (plan.taskId !== taskId || plan.purpose !== "agent" || plan.status !== "active") return;
    const steps = this.planSteps.listByTask(taskId).filter((item) => item.planId === planId);
    if (steps.length === 0 || steps.some((item) =>
      !["completed", "failed", "skipped", "cancelled"].includes(item.status))) return;
    const status = steps.some((item) => item.status === "failed") ? "failed" :
      steps.some((item) => item.status === "cancelled") ? "cancelled" : "completed";
    this.plans.updateStatusCas(plan.id, "active", plan.version, status, now, permit);
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

  private appendReviewOperationCheckpoint(
    task: {
      readonly id: string;
      readonly status: TaskStatus;
      readonly currentIteration: number;
      readonly maxModelTurns: number;
      readonly maxToolCalls: number;
    },
    reason: string,
    eventSequence: number,
    metadata: Record<string, unknown>,
    now: string,
    permit: ReturnType<typeof createStorageWritePermit>,
  ): void {
    const latestMessage = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM messages
          WHERE task_id = ?
        `,
      )
      .get(task.id) as { sequence: number };
    const latestPlan = this.database
      .prepare(
        `
          SELECT MAX(version) AS version
          FROM execution_plans
          WHERE task_id = ? AND purpose = 'agent'
        `,
      )
      .get(task.id) as { version: number | null };
    this.checkpoints.append(
      {
        taskId: task.id,
        reason,
        taskStatus: task.status,
        lastMessageSequence: latestMessage.sequence,
        modelIteration: task.currentIteration,
        planVersion: latestPlan.version,
        lastEventSequence: eventSequence,
        budget: checkpointBudget(task),
        metadata,
      },
      now,
      permit,
    );
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
