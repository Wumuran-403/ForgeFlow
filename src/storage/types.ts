import { z } from "zod";

import {
  ModelRequestSchema,
  ModelResponseSchema,
  ModelUsageSchema,
  TokenUsageAggregateSchema,
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

export const RecoveryEvidenceOutcomeSchema = z.enum([
  "observed_succeeded",
  "observed_not_executed",
  "inconclusive",
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
  "advance_decision_version",
]);

export const RecoveryReviewOperationStatusSchema = z.enum([
  "applied",
  "accepted",
]);

export const RecoveryEvidencePayloadStorageModeSchema = z.enum([
  "content_addressed_file",
  "reference_only",
]);

export const RecoveryEvidenceReadAttemptStatusSchema = z.enum([
  "prepared",
  "dispatching",
  "interrupted",
  "completed",
  "failed",
  "timed_out",
  "cancelled",
  "blocked_by_intent",
]);

export const RecoveryEvidenceReadbackReservationStatusSchema = z.enum([
  "preparing",
  "completed",
  "abandoned",
]);

export const RecoveryEvidenceReadbackRetrySafetySchema = z.enum([
  "immutable",
  "version_conditional",
]);

export const RecoveryEvidenceReadbackConsistencyModeSchema = z.enum([
  "immutable_version",
  "etag_or_resource_version",
]);

export const RecoveryEvidenceVerificationCheckOriginSchema = z.enum([
  "readback_transaction_b",
  "stored_evidence_v0",
]);

export const RecoveryEvidenceAvailabilityResultStatusSchema = z.enum([
  "available",
  "unavailable",
  "expired",
  "replaced",
  "digest_mismatch",
]);

export const RecoveryEvidenceIntegrityStatusSchema = z.enum([
  "not_checked",
  "matched",
  "mismatch",
]);

export const RecoveryEvidenceAuthenticityStatusSchema = z.enum([
  "unverified",
  "manual_attested",
  "system_verified",
]);

export const RecoveryEvidenceVerificationResultStatusSchema = z.enum([
  "not_run",
  "passed",
  "failed",
  "inconclusive",
]);

export const RecoveryEvidenceReadbackProvenanceSchema = z.enum([
  "none",
  "declared_payload",
  "controlled_runtime_read",
]);

export const MessageToolCallsSchema = z.array(ToolCallSchema);
export const EventPayloadSchema = z.record(z.string(), z.unknown());
export const CheckpointBudgetSchema = z
  .object({
    maxModelTurns: z.number().int().positive(),
    maxToolCalls: z.number().int().nonnegative(),
    maxTokens: z.number().int().positive().optional(),
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
    maxTokens: z.number().int().positive().optional(),
    tokenUsage: TokenUsageAggregateSchema.default({ source: "unknown" }),
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
export type RecoveryEvidenceOutcome = z.infer<
  typeof RecoveryEvidenceOutcomeSchema
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
export type RecoveryReviewOperationStatus = z.infer<
  typeof RecoveryReviewOperationStatusSchema
>;
export type RecoveryEvidencePayloadStorageMode = z.infer<
  typeof RecoveryEvidencePayloadStorageModeSchema
>;
export type RecoveryEvidenceReadAttemptStatus = z.infer<
  typeof RecoveryEvidenceReadAttemptStatusSchema
>;
export type RecoveryEvidenceReadbackReservationStatus = z.infer<
  typeof RecoveryEvidenceReadbackReservationStatusSchema
>;
export type RecoveryEvidenceReadbackRetrySafety = z.infer<
  typeof RecoveryEvidenceReadbackRetrySafetySchema
>;
export type RecoveryEvidenceReadbackConsistencyMode = z.infer<
  typeof RecoveryEvidenceReadbackConsistencyModeSchema
>;
export type RecoveryEvidenceVerificationCheckOrigin = z.infer<
  typeof RecoveryEvidenceVerificationCheckOriginSchema
>;
export type RecoveryEvidenceAvailabilityResultStatus = z.infer<
  typeof RecoveryEvidenceAvailabilityResultStatusSchema
>;
export type RecoveryEvidenceIntegrityStatus = z.infer<
  typeof RecoveryEvidenceIntegrityStatusSchema
>;
export type RecoveryEvidenceAuthenticityStatus = z.infer<
  typeof RecoveryEvidenceAuthenticityStatusSchema
>;
export type RecoveryEvidenceVerificationResultStatus = z.infer<
  typeof RecoveryEvidenceVerificationResultStatusSchema
>;
export type RecoveryEvidenceReadbackProvenance = z.infer<
  typeof RecoveryEvidenceReadbackProvenanceSchema
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
  readonly maxTokens: number | null;
  readonly tokenUsage: z.infer<typeof TokenUsageAggregateSchema>;
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
  /**
   * Immutable Task-scoped plan generation identity. Status transitions use it
   * for CAS but must not increment it.
   */
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
  readonly evidenceSubmissionId: string | null;
  readonly readbackRequestId: string | null;
  readonly readAttemptId: string | null;
  readonly verificationCheckId: string | null;
  readonly observedAt: string | null;
  readonly resourceVersion: string | null;
  readonly resourceEtag: string | null;
  readonly resultPayloadDigest: string | null;
  readonly resultPayloadStoreRef: string | null;
  readonly resultPayloadStorageMode: RecoveryEvidencePayloadStorageMode | null;
  readonly createdAt: string;
}

export interface RecoveryEvidenceReadbackRequestRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly evidenceSubmissionId: string;
  readonly originalToolRunId: string;
  readonly requestKey: string;
  readonly operationId: string;
  readonly executionPlanId: string;
  readonly planStepId: string;
  readonly readToolRunId: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly verifierConfigDigest: string;
  readonly allowlistId: string;
  readonly allowlistVersion: string;
  readonly readToolName: string;
  readonly readToolVersion: string;
  readonly readToolSchemaHash: string;
  readonly retrySafety: RecoveryEvidenceReadbackRetrySafety;
  readonly consistencyMode: RecoveryEvidenceReadbackConsistencyMode;
  readonly expectedResourceVersion: string | null;
  readonly expectedEtag: string | null;
  readonly verificationCheckId: string;
  readonly createdAt: string;
}

export interface RecoveryEvidenceReadAttemptRecord {
  readonly id: string;
  readonly taskId: string;
  readonly readbackRequestId: string;
  readonly readToolRunId: string;
  readonly attemptNumber: number;
  readonly retrySafety: RecoveryEvidenceReadbackRetrySafety;
  readonly consistencyMode: RecoveryEvidenceReadbackConsistencyMode;
  readonly status: RecoveryEvidenceReadAttemptStatus;
  readonly preparedAt: string;
  readonly dispatchingAt: string | null;
  readonly interruptedAt: string | null;
  readonly completedAt: string | null;
  readonly observedAt: string | null;
  readonly resourceVersion: string | null;
  readonly resourceEtag: string | null;
  readonly resultDigest: string | null;
  readonly resultPayloadStoreRef: string | null;
  readonly reasonCode: string | null;
  readonly lastEventId: string;
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecoveryEvidenceReadbackReservationRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly evidenceSubmissionId: string;
  readonly originalToolRunId: string;
  readonly requestId: string;
  readonly operationId: string;
  readonly executionPlanId: string;
  readonly planStepId: string;
  readonly readToolRunId: string;
  readonly readAttemptId: string;
  readonly verificationCheckId: string;
  readonly requestIntentDigest: string;
  readonly ownerToken: string;
  readonly ownerFencingToken: number;
  readonly status: RecoveryEvidenceReadbackReservationStatus;
  readonly reservationVersion: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecoveryEvidenceVerificationCheckRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly evidenceSubmissionId: string;
  readonly originalToolRunId: string;
  readonly readbackRequestId: string | null;
  readonly evidenceReadId: string | null;
  readonly verificationCheckId: string;
  readonly requestKey: string;
  readonly checkOrigin: RecoveryEvidenceVerificationCheckOrigin;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly verifierConfigDigest: string;
  readonly allowlistId: string | null;
  readonly allowlistVersion: string | null;
  readonly readToolName: string | null;
  readonly readToolVersion: string | null;
  readonly readToolSchemaHash: string | null;
  readonly expectedPayloadDigest: string;
  readonly createdAt: string;
}

export interface RecoveryEvidenceVerificationRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly evidenceSubmissionId: string;
  readonly originalToolRunId: string;
  readonly readbackRequestId: string | null;
  readonly evidenceReadId: string | null;
  readonly readAttemptId: string | null;
  readonly verificationCheckId: string;
  readonly readbackResultProvenance: RecoveryEvidenceReadbackProvenance;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly verifierConfigDigest: string;
  readonly allowlistId: string | null;
  readonly allowlistVersion: string | null;
  readonly requestKey: string;
  readonly availabilityStatus: RecoveryEvidenceAvailabilityResultStatus;
  readonly integrityStatus: RecoveryEvidenceIntegrityStatus;
  readonly authenticityStatus: RecoveryEvidenceAuthenticityStatus;
  readonly verificationStatus: RecoveryEvidenceVerificationResultStatus;
  readonly expectedPayloadDigest: string;
  readonly observedPayloadDigest: string | null;
  readonly reasonCode: string;
  readonly redactedSummary: string | null;
  readonly availabilityEventId: string;
  readonly verificationEventId: string | null;
  readonly createdAt: string;
}

export interface RecoveryEvidenceSubmissionRecord {
  readonly id: string;
  readonly taskId: string;
  readonly reviewId: string;
  readonly toolRunId: string;
  readonly operationId: string;
  readonly requestKey: string;
  readonly decisionVersion: number;
  readonly sourceType: RecoveryReviewSource;
  readonly outcome: RecoveryEvidenceOutcome;
  readonly evidenceRef: string;
  readonly resourceRef: string | null;
  readonly resourceVersion: string | null;
  readonly sourceObservedAt: string;
  readonly submittedAt: string;
  readonly actorId: string | null;
  readonly verifierId: string | null;
  readonly verificationId: string | null;
  readonly payloadType: RecoveryEvidencePayloadType;
  readonly payloadDigestProtocol: RecoveryEvidenceDigestProtocol;
  readonly payloadDigest: string;
  readonly envelopeDigest: string;
  readonly payloadStoreRef: string | null;
  readonly payloadStorageMode: RecoveryEvidencePayloadStorageMode;
  readonly appliedEventId: string;
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
  readonly status: RecoveryReviewOperationStatus;
  readonly actorId: string | null;
  readonly operationPayloadDigest: string | null;
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
  readonly recoveryEvidenceReadbackRequests: readonly RecoveryEvidenceReadbackRequestRecord[];
  readonly recoveryEvidenceReadAttempts: readonly RecoveryEvidenceReadAttemptRecord[];
  readonly recoveryEvidenceReads: readonly RecoveryEvidenceReadRecord[];
  readonly recoveryEvidenceVerificationChecks: readonly RecoveryEvidenceVerificationCheckRecord[];
  readonly recoveryEvidenceVerifications: readonly RecoveryEvidenceVerificationRecord[];
  readonly recoveryEvidenceSubmissions: readonly RecoveryEvidenceSubmissionRecord[];
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
