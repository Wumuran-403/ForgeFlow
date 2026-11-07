import { z } from "zod";

import {
  ModelRequestSchema,
  ModelResponseSchema,
  ModelUsageSchema,
  ToolCallSchema,
} from "../provider/types.js";
import type { ToolMode } from "../tools/types.js";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number(),
    z.string(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

export const TaskStatusSchema = z.enum([
  "queued",
  "running",
  "pause_requested",
  "paused",
  "cancel_requested",
  "waiting_approval",
  "waiting_review",
  "completed",
  "failed",
  "cancelled",
]);

export const MessageRoleSchema = z.enum([
  "system",
  "user",
  "assistant",
  "tool",
]);

export const ModelCallStatusSchema = z.enum([
  "requested",
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);

export const ExecutionPlanStatusSchema = z.enum([
  "active",
  "completed",
  "failed",
  "cancelled",
]);

export const ExecutionPlanPurposeSchema = z.enum([
  "agent",
  "recovery_evidence",
]);

export const PlanStepKindSchema = z.enum([
  "read_batch",
  "write",
  "unknown_tool",
]);

export const PlanStepStatusSchema = z.enum([
  "queued",
  "running",
  "awaiting_approval",
  "waiting_review",
  "interrupted",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const ToolRunStatusSchema = z.enum([
  "queued",
  "awaiting_approval",
  "running",
  "interrupted",
  "succeeded",
  "failed",
  "timed_out",
  "unknown",
  "cancelled",
  "skipped",
]);

export const ApprovalStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "expired",
  "cancelled",
]);

export const RecoveryReviewStatusSchema = z.enum([
  "pending",
  "confirmed_succeeded",
  "confirmed_not_executed",
  "unresolved",
]);

export const RecoveryReviewSourceSchema = z.enum([
  "manual_review",
  "system_verification",
]);

export const RecoveryEvidencePayloadTypeSchema = z.enum([
  "raw_bytes",
  "json",
  "external_reference",
  "readback_result",
]);

export const RecoveryEvidenceDigestProtocolSchema = z.enum([
  "sha256-raw-v1",
  "jcs-sha256-v1",
  "adapter-content-sha256-v1",
]);

export const RecoveryLegacyAttestationResultSchema = z.enum([
  "confirms_original",
  "contradicts_original",
  "inconclusive",
]);

export const RecoveryReviewOperationTypeSchema = z.enum([
  "submit_evidence",
  "request_readback",
  "mark_unresolved",
  "confirm_succeeded",
  "confirm_not_executed",
  "legacy_attest",
]);

export const MessageToolCallsSchema = z.array(ToolCallSchema);
export const EventPayloadSchema = z.record(z.string(), z.unknown());
export const CheckpointBudgetSchema = z
  .object({
    maxModelTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    maxTokens: z.number().int().nonnegative().optional(),
  })
  .strict();
export const CheckpointMetadataSchema = z.record(z.string(), z.unknown());
export const PersistedErrorSchema = z
  .object({
    code: z.string().min(1),
    message: z.string().min(1),
    details: z
      .array(
        z
          .object({
            path: z.string(),
            message: z.string(),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const CreateTaskInputSchema = z
  .object({
    taskId: z.string().min(1),
    traceId: z.string().min(1),
    objective: z.string().trim().min(1),
    systemPrompt: z.string().trim().min(1),
    maxModelTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    tokenUsage: ModelUsageSchema.default({ source: "unknown" }),
  })
  .strict();

export const NewMessageInputSchema = z
  .object({
    taskId: z.string().min(1),
    role: MessageRoleSchema,
    content: z.string(),
    toolCallId: z.string().min(1).optional(),
    toolCalls: MessageToolCallsSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.role === "tool" && value.toolCallId === undefined) {
      context.addIssue({
        code: "custom",
        path: ["toolCallId"],
        message: "Tool messages require a toolCallId.",
      });
    }

    if (value.role !== "tool" && value.toolCallId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["toolCallId"],
        message: "Only tool messages may define toolCallId.",
      });
    }

    if (value.role !== "assistant" && value.toolCalls !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["toolCalls"],
        message: "Only assistant messages may define toolCalls.",
      });
    }
  });

export const BeginModelCallInputSchema = z
  .object({
    taskId: z.string().min(1),
    iteration: z.number().int().positive(),
    attemptNo: z.number().int().positive().optional(),
    request: ModelRequestSchema,
  })
  .strict();

export const CompleteModelCallInputSchema = z
  .object({
    modelCallId: z.string().min(1),
    response: ModelResponseSchema,
    durationMs: z.number().int().nonnegative(),
  })
  .strict();

export const FailModelCallInputSchema = z
  .object({
    modelCallId: z.string().min(1),
    status: z.enum(["failed", "interrupted", "cancelled"]),
    durationMs: z.number().int().nonnegative(),
    error: PersistedErrorSchema,
  })
  .strict();

export const UpdateTaskStatusInputSchema = z
  .object({
    taskId: z.string().min(1),
    status: TaskStatusSchema,
  })
  .strict();

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type MessageRole = z.infer<typeof MessageRoleSchema>;
export type ModelCallStatus = z.infer<typeof ModelCallStatusSchema>;
export type ExecutionPlanStatus = z.infer<typeof ExecutionPlanStatusSchema>;
export type ExecutionPlanPurpose = z.infer<
  typeof ExecutionPlanPurposeSchema
>;
export type PlanStepKind = z.infer<typeof PlanStepKindSchema>;
export type PlanStepStatus = z.infer<typeof PlanStepStatusSchema>;
export type ToolRunStatus = z.infer<typeof ToolRunStatusSchema>;
export type ApprovalStatus = z.infer<typeof ApprovalStatusSchema>;
export type RecoveryReviewStatus = z.infer<
  typeof RecoveryReviewStatusSchema
>;
export type RecoveryReviewSource = z.infer<
  typeof RecoveryReviewSourceSchema
>;
export type RecoveryEvidencePayloadType = z.infer<
  typeof RecoveryEvidencePayloadTypeSchema
>;
export type RecoveryEvidenceDigestProtocol = z.infer<
  typeof RecoveryEvidenceDigestProtocolSchema
>;
export type RecoveryLegacyAttestationResult = z.infer<
  typeof RecoveryLegacyAttestationResultSchema
>;
export type RecoveryReviewOperationType = z.infer<
  typeof RecoveryReviewOperationTypeSchema
>;
export type CreateTaskInput = z.input<typeof CreateTaskInputSchema>;
export type NewMessageInput = z.input<typeof NewMessageInputSchema>;
export type BeginModelCallInput = z.input<typeof BeginModelCallInputSchema>;
export type CompleteModelCallInput = z.input<typeof CompleteModelCallInputSchema>;
export type FailModelCallInput = z.input<typeof FailModelCallInputSchema>;

export interface TaskRecord {
  readonly id: string;
  readonly traceId: string;
  readonly status: TaskStatus;
  readonly objective: string;
  readonly systemPrompt: string;
  readonly currentIteration: number;
  readonly maxModelTurns: number;
  readonly maxToolCalls: number;
  readonly tokenUsage: z.infer<typeof ModelUsageSchema>;
  readonly version: number;
  readonly cancelRequestedAt: string | null;
  readonly pauseRequestedAt: string | null;
  readonly lastEventSequence: number;
  readonly finalAnswer: string | null;
  readonly lastError: z.infer<typeof PersistedErrorSchema> | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface MessageRecord {
  readonly id: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly role: MessageRole;
  readonly content: string;
  readonly toolCallId: string | null;
  readonly toolCalls: z.infer<typeof MessageToolCallsSchema> | null;
  readonly createdAt: string;
}

export interface ModelCallRecord {
  readonly id: string;
  readonly taskId: string;
  readonly iteration: number;
  readonly attemptNo: number;
  readonly status: ModelCallStatus;
  readonly request: z.infer<typeof ModelRequestSchema>;
  readonly response: z.infer<typeof ModelResponseSchema> | null;
  readonly usage: z.infer<typeof ModelUsageSchema> | null;
  readonly finishReason: string | null;
  readonly providerRequestId: string | null;
  readonly durationMs: number | null;
  readonly error: z.infer<typeof PersistedErrorSchema> | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface EventRecord {
  readonly id: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly traceId: string;
  readonly type: string;
  readonly entityType: string | null;
  readonly entityId: string | null;
  readonly payload: z.infer<typeof EventPayloadSchema>;
  readonly createdAt: string;
}

export interface CheckpointRecord {
  readonly id: string;
  readonly taskId: string;
  readonly sequence: number;
  readonly reason: string;
  readonly taskStatus: TaskStatus;
  readonly lastMessageSequence: number;
  readonly modelIteration: number;
  readonly planVersion: number | null;
  readonly lastEventSequence: number;
  readonly budget: z.infer<typeof CheckpointBudgetSchema>;
  readonly metadata: z.infer<typeof CheckpointMetadataSchema>;
  readonly createdAt: string;
}

export interface ExecutionPlanRecord {
  readonly id: string;
  readonly taskId: string;
  readonly version: number;
  readonly sourceModelCallId: string;
  readonly purpose: ExecutionPlanPurpose;
  readonly status: ExecutionPlanStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PlanStepRecord {
  readonly id: string;
  readonly taskId: string;
  readonly planId: string;
  readonly stepIndex: number;
  readonly kind: PlanStepKind;
  readonly status: PlanStepStatus;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ToolRunRecord {
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
  readonly status: ToolRunStatus;
  readonly input: JsonValue;
  readonly output: JsonValue | null;
  readonly error: z.infer<typeof PersistedErrorSchema> | null;
  readonly idempotencyKey: string;
  readonly attemptNo: number;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ApprovalRecord {
  readonly id: string;
  readonly taskId: string;
  readonly toolRunId: string;
  readonly status: ApprovalStatus;
  readonly toolVersion: string;
  readonly canonicalInputHash: string;
  readonly request: JsonValue;
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly expiresAt: string | null;
  readonly decidedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecoveryReviewRecord {
  readonly id: string;
  readonly taskId: string;
  readonly toolRunId: string;
  readonly status: RecoveryReviewStatus;
  readonly note: string | null;
  readonly sourceType: RecoveryReviewSource | null;
  readonly evidenceRef: string | null;
  readonly reviewProtocolVersion: number;
  readonly decisionVersion: number;
  readonly evidencePayloadDigest: string | null;
  readonly evidencePayloadType: RecoveryEvidencePayloadType | null;
  readonly evidenceDigestProtocol: RecoveryEvidenceDigestProtocol | null;
  readonly evidenceEnvelopeDigest: string | null;
  readonly actorId: string | null;
  readonly verifierId: string | null;
  readonly verificationId: string | null;
  readonly sourceObservedAt: string | null;
  readonly submittedAt: string | null;
  readonly verifiedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly decidedAt: string | null;
}

export interface RecoveryEvidenceReadRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly toolRunId: string;
  readonly evidenceEnvelopeDigest: string;
  readonly createdAt: string;
}

export interface RecoveryLegacyAttestationRecord {
  readonly id: string;
  readonly taskId: string;
  readonly originalReviewId: string;
  readonly attestationVersion: number;
  readonly requestKey: string;
  readonly evidenceEnvelopeDigest: string;
  readonly evidenceRef: string;
  readonly sourceType: RecoveryReviewSource;
  readonly actorId: string | null;
  readonly verifierId: string | null;
  readonly verificationId: string | null;
  readonly sourceObservedAt: string;
  readonly submittedAt: string;
  readonly verifiedAt: string;
  readonly result: RecoveryLegacyAttestationResult;
  readonly createdAt: string;
}

export interface RecoveryReviewOperationRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly requestKey: string;
  readonly operation: RecoveryReviewOperationType;
  readonly expectedDecisionVersion: number;
  readonly resultingDecisionVersion: number;
  readonly status: string;
  readonly evidenceEnvelopeDigest: string | null;
  readonly resultPlanId: string | null;
  readonly resultToolRunId: string | null;
  readonly appliedEventId: string | null;
  readonly createdAt: string;
}

export interface TaskLeaseRecord {
  readonly taskId: string;
  readonly ownerId: string | null;
  readonly leaseToken: string | null;
  readonly fencingToken: number;
  readonly expiresAt: string | null;
  readonly heartbeatAt: string;
  readonly releasedAt: string | null;
  readonly updatedAt: string;
}

export interface TaskSnapshot {
  readonly task: TaskRecord;
  readonly lease: TaskLeaseRecord | null;
  readonly messages: readonly MessageRecord[];
  readonly modelCalls: readonly ModelCallRecord[];
  readonly events: readonly EventRecord[];
  readonly checkpoints: readonly CheckpointRecord[];
  readonly executionPlans: readonly ExecutionPlanRecord[];
  readonly agentExecutionPlans: readonly ExecutionPlanRecord[];
  readonly recoveryEvidencePlans: readonly ExecutionPlanRecord[];
  readonly planSteps: readonly PlanStepRecord[];
  readonly toolRuns: readonly ToolRunRecord[];
  readonly approvals: readonly ApprovalRecord[];
  readonly recoveryReviews: readonly RecoveryReviewRecord[];
  readonly recoveryEvidenceReads: readonly RecoveryEvidenceReadRecord[];
  readonly recoveryLegacyAttestations: readonly RecoveryLegacyAttestationRecord[];
  readonly recoveryReviewOperations: readonly RecoveryReviewOperationRecord[];
}

export const PersistedMessagePayloadSchema = z
  .object({
    content: z.string(),
    toolCallId: z.string().optional(),
    toolCalls: MessageToolCallsSchema.optional(),
  })
  .strict();
