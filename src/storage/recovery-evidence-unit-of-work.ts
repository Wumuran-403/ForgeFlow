import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  assertRecoveryEvidenceDispatchPreflightCapability,
  type RecoveryEvidenceDispatchPreflightCapability,
} from "../recovery/recovery-evidence-dispatch-preflight.js";
import {
  assertRecoveryEvidenceHostControlAuthorization,
  type RecoveryEvidenceHostControlAuthorization,
} from "../recovery/recovery-evidence-host-control-authorization.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { MessageRepository } from "./message-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryEvidenceReadAttemptRepository } from "./recovery-evidence-read-attempt-repository.js";
import { RecoveryEvidenceReadbackReservationRepository } from "./recovery-evidence-readback-reservation-repository.js";
import { RecoveryEvidenceStateTransitionUnitOfWork } from "./recovery-evidence-state-transition-unit-of-work.js";
import {
  createRecoveryEvidenceControlledReadCapability,
} from "./recovery-evidence-read-capability.js";
import { RecoveryEvidenceReadRepository } from "./recovery-evidence-read-repository.js";
import { computeRecoveryEvidenceReadbackOperationPayloadDigest } from "./recovery-evidence-readback-operation-keys.js";
import { RecoveryEvidenceReadbackRequestRepository } from "./recovery-evidence-readback-request-repository.js";
import { computeRecoveryEvidenceVerificationRequestKey } from "./recovery-evidence-verification-keys.js";
import { RecoveryEvidenceSubmissionRepository } from "./recovery-evidence-submission-repository.js";
import { RecoveryEvidenceVerificationCheckRepository } from "./recovery-evidence-verification-check-repository.js";
import { RecoveryEvidenceVerificationRepository } from "./recovery-evidence-verification-repository.js";
import { RecoveryReviewRepository } from "./recovery-review-repository.js";
import { RecoveryReviewOperationRepository } from "./recovery-review-operation-repository.js";
import { computeRecoveryReviewOperationRequestKey } from "./recovery-review-operation-keys.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { TaskRepository } from "./task-repository.js";
import { TaskSnapshotReader } from "./task-snapshot.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import {
  assertSynchronousResult,
  runInTransaction,
} from "./transaction.js";
import {
  RecoveryEvidenceAuthenticityStatusSchema,
  RecoveryEvidenceAvailabilityResultStatusSchema,
  RecoveryEvidenceIntegrityStatusSchema,
  RecoveryEvidenceReadAttemptStatusSchema,
  RecoveryEvidenceReadbackConsistencyModeSchema,
  RecoveryEvidenceReadbackProvenanceSchema,
  RecoveryEvidenceReadbackRetrySafetySchema,
  RecoveryEvidenceVerificationCheckOriginSchema,
  RecoveryEvidenceVerificationResultStatusSchema,
  JsonValueSchema,
  type CheckpointRecord,
  type EventRecord,
  type ExecutionPlanRecord,
  type ExecutionPlanStatus,
  type PlanStepRecord,
  type PlanStepStatus,
  type RecoveryEvidenceReadAttemptRecord,
  type RecoveryEvidenceReadAttemptStatus,
  type RecoveryEvidenceReadRecord,
  type RecoveryEvidenceReadbackRequestRecord,
  type RecoveryEvidenceVerificationCheckRecord,
  type RecoveryEvidenceVerificationRecord,
  type RecoveryReviewOperationRecord,
  type TaskRecord,
  type ToolRunRecord,
  type ToolRunStatus,
} from "./types.js";
import {
  createStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const OwnershipSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const CommonOwnedInputSchema = z
  .object({
    ownership: OwnershipSchema,
    expectedTaskVersion: z.number().int().positive(),
  })
  .strict();

const OwnedExecutionInputSchema = z
  .object({
    ownership: OwnershipSchema,
  })
  .strict();

const CreateRecoveryEvidenceReadbackRequestInputSchema =
  CommonOwnedInputSchema.extend({
    requestId: z.string().min(1),
    operationId: z.string().min(1),
    readAttemptId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    actorId: z.string().trim().min(1),
    operationPayloadDigest: Sha256DigestSchema,
    requestKey: Sha256DigestSchema,
    executionPlanId: z.string().min(1),
    planStepId: z.string().min(1),
    readToolRunId: z.string().min(1),
    verifierId: z.string().trim().min(1),
    verifierVersion: z.string().trim().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().trim().min(1),
    allowlistVersion: z.string().trim().min(1),
    readToolName: z.string().trim().min(1),
    readToolVersion: z.string().trim().min(1),
    readToolSchemaHash: Sha256DigestSchema,
    retrySafety: RecoveryEvidenceReadbackRetrySafetySchema,
    consistencyMode: RecoveryEvidenceReadbackConsistencyModeSchema,
    expectedResourceVersion: z.string().trim().min(1).nullable(),
    expectedEtag: z.string().trim().min(1).nullable(),
    verificationCheckId: z.string().trim().min(1),
  }).superRefine((value, context) => {
    const hasExpected =
      value.expectedResourceVersion !== null || value.expectedEtag !== null;
    if (
      (value.retrySafety === "immutable" &&
        (value.consistencyMode !== "immutable_version" || hasExpected)) ||
      (value.retrySafety === "version_conditional" &&
        (value.consistencyMode !== "etag_or_resource_version" ||
          !hasExpected))
    ) {
      context.addIssue({
        code: "custom",
        path: ["retrySafety"],
        message: "Readback retry and consistency bindings are incompatible.",
      });
    }
  });

const CreateRecoveryEvidenceReadAttemptPreparedInputSchema =
  CommonOwnedInputSchema.extend({
    attemptId: z.string().min(1),
    readbackRequestId: z.string().min(1),
  }).strict();

const BeginOwnedRecoveryEvidenceReadInputSchema =
  CommonOwnedInputSchema.extend({
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    preflight: z.custom<RecoveryEvidenceDispatchPreflightCapability>(
      (value) => typeof value === "object" && value !== null,
      "Recovery evidence Dispatch preflight capability is invalid.",
    ),
    expectedCanonicalInputHash: Sha256DigestSchema,
    expectedAttemptVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
  }).strict();

const RetryDispatchLineageSchema = z
  .object({
    recoveryOperationId: z.string().trim().min(1),
    priorAttemptId: z.string().min(1),
    interruptionEventId: z.string().min(1),
    newAttemptId: z.string().min(1),
    pauseClearEventId: z.string().min(1).nullable().default(null),
  })
  .passthrough();

const PauseResumeDispatchLineageSchema = z
  .object({
    priorAttemptId: z.string().min(1),
    newAttemptId: z.string().min(1),
    pauseClearEventId: z.string().min(1),
    pauseRequestEventId: z.string().min(1),
  })
  .passthrough();

const StableReasonCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/);

const ExternalCallStartedSchema = z.union([
  z.boolean(),
  z.literal("unknown"),
]);

const HostControlCommonInputSchema = z
  .object({
    hostControlAuthorization: z.custom<RecoveryEvidenceHostControlAuthorization>(
      (value) => typeof value === "object" && value !== null,
      "Recovery evidence host control authorization is invalid.",
    ),
    expectedTaskVersion: z.number().int().positive(),
    requestNonce: z.string().trim().min(1),
    controlActor: z.string().trim().min(1),
  })
  .strict();

const SetTaskWideRecoveryEvidenceCancelInputSchema =
  HostControlCommonInputSchema;

const SetTaskWideRecoveryEvidencePauseInputSchema =
  HostControlCommonInputSchema;

const ClearTaskWideRecoveryEvidencePauseInputSchema =
  HostControlCommonInputSchema.extend({
    expectedPauseRequestedAt: z.string().min(1),
    pauseRequestEventId: z.string().min(1),
    expectedPauseEventSequence: z.number().int().positive(),
  }).strict();

const FailOwnedRecoveryEvidenceReadInputSchema =
  OwnedExecutionInputSchema.extend({
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    expectedAttemptVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
    terminalStatus: z.enum(["failed", "timed_out"]),
    reasonCode: StableReasonCodeSchema,
  }).strict();

const CancelOwnedRecoveryEvidenceReadInputSchema =
  CommonOwnedInputSchema.extend({
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    cancelIntentEventId: z.string().min(1),
    expectedAttemptVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
    reasonCode: StableReasonCodeSchema.default("CANCEL_REQUESTED"),
  }).strict();

const BlockOwnedRecoveryEvidenceReadForIntentInputSchema =
  CommonOwnedInputSchema.extend({
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    pauseRequestEventId: z.string().min(1),
    expectedAttemptVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
    reasonCode: StableReasonCodeSchema.default("PAUSE_REQUESTED"),
  }).strict();

const RecordOwnedRecoveryEvidenceReadPauseObservedInputSchema =
  CommonOwnedInputSchema.extend({
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    pauseRequestEventId: z.string().min(1),
    dispatchEventId: z.string().min(1),
    externalCallStarted: ExternalCallStartedSchema,
    interruptionCause: z.enum([
      "pause_before_external_call",
      "pause_during_external_read",
      "pause_before_transaction_b",
    ]),
    expectedAttemptVersion: z.number().int().positive(),
  }).strict();

const ResumeBlockedOwnedRecoveryEvidenceReadInputSchema =
  CommonOwnedInputSchema.extend({
    requestId: z.string().min(1),
    priorAttemptId: z.string().min(1),
    newAttemptId: z.string().min(1),
    pauseClearEventId: z.string().min(1),
    expectedPriorAttemptVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
  }).strict();

const CreateRecoveryEvidenceVerificationCheckInputSchema =
  CommonOwnedInputSchema.extend({
    checkRecordId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    verificationCheckId: z.string().trim().min(1),
    requestKey: Sha256DigestSchema,
    checkOrigin: RecoveryEvidenceVerificationCheckOriginSchema,
    verifierId: z.string().trim().min(1),
    verifierVersion: z.string().trim().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().trim().min(1).nullable(),
    allowlistVersion: z.string().trim().min(1).nullable(),
    readToolName: z.string().trim().min(1).nullable(),
    readToolVersion: z.string().trim().min(1).nullable(),
    readToolSchemaHash: Sha256DigestSchema.nullable(),
    expectedPayloadDigest: Sha256DigestSchema,
  })
    .strict()
    .superRefine((value, context) => {
      if (
        value.checkOrigin === "stored_evidence_v0" &&
        [
          value.allowlistId,
          value.allowlistVersion,
          value.readToolName,
          value.readToolVersion,
          value.readToolSchemaHash,
        ].some((field) => field !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["checkOrigin"],
          message:
            "Stored Evidence V0 requires explicit NULL readback configuration.",
        });
      }
    });

const RecoveryEvidenceVerificationHostBindingSchema = z
  .object({
    verifierId: z.string().trim().min(1),
    verifierVersion: z.string().trim().min(1),
    verifierConfigDigest: Sha256DigestSchema,
  })
  .strict();

const CreateOwnedStoredEvidenceVerificationCheckInputSchema =
  CommonOwnedInputSchema.extend({
    checkRecordId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    verificationCheckId: z.string().trim().min(1),
    expectedPayloadDigest: Sha256DigestSchema,
  }).strict();

const CompleteRecoveryEvidenceReadInputSchema =
  CommonOwnedInputSchema.extend({
    readbackRequestId: z.string().min(1),
    checkRecordId: z.string().min(1),
    evidenceReadId: z.string().min(1),
    attemptId: z.string().min(1),
    expectedAttemptVersion: z.number().int().positive(),
    expectedReadToolRunVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    toolOutput: JsonValueSchema,
    toolMessageContent: z.string().optional(),
    verificationRequestKey: Sha256DigestSchema,
    observedAt: z.string().min(1),
    resourceVersion: z.string().min(1).nullable(),
    resourceEtag: z.string().min(1).nullable(),
    resultPayloadDigest: Sha256DigestSchema,
    resultPayloadStoreRef: z.string().min(1),
  }).strict();

const RecordRecoveryEvidenceVerificationInputSchema =
  CommonOwnedInputSchema.extend({
    verificationId: z.string().min(1),
    verificationCheckId: z.string().trim().min(1),
    requestKey: Sha256DigestSchema,
    readbackResultProvenance:
      RecoveryEvidenceReadbackProvenanceSchema,
    availabilityStatus: RecoveryEvidenceAvailabilityResultStatusSchema,
    integrityStatus: RecoveryEvidenceIntegrityStatusSchema,
    authenticityStatus: RecoveryEvidenceAuthenticityStatusSchema,
    verificationStatus: RecoveryEvidenceVerificationResultStatusSchema,
    observedPayloadDigest: Sha256DigestSchema.nullable(),
    reasonCode: z.string().trim().min(1),
    redactedSummary: z.string().trim().min(1).max(500).nullable(),
  }).strict();

export type CreateOwnedRecoveryEvidenceReadbackRequestInput = z.input<
  typeof CreateRecoveryEvidenceReadbackRequestInputSchema
>;
export type CreateOwnedRecoveryEvidenceReadAttemptPreparedInput = z.input<
  typeof CreateRecoveryEvidenceReadAttemptPreparedInputSchema
>;
export type BeginOwnedRecoveryEvidenceReadInput = z.input<
  typeof BeginOwnedRecoveryEvidenceReadInputSchema
>;
export type SetTaskWideRecoveryEvidenceCancelInput = z.input<
  typeof SetTaskWideRecoveryEvidenceCancelInputSchema
>;
export type SetTaskWideRecoveryEvidencePauseInput = z.input<
  typeof SetTaskWideRecoveryEvidencePauseInputSchema
>;
export type ClearTaskWideRecoveryEvidencePauseInput = z.input<
  typeof ClearTaskWideRecoveryEvidencePauseInputSchema
>;
export type FailOwnedRecoveryEvidenceReadInput = z.input<
  typeof FailOwnedRecoveryEvidenceReadInputSchema
>;
export type CancelOwnedRecoveryEvidenceReadInput = z.input<
  typeof CancelOwnedRecoveryEvidenceReadInputSchema
>;
export type BlockOwnedRecoveryEvidenceReadForIntentInput = z.input<
  typeof BlockOwnedRecoveryEvidenceReadForIntentInputSchema
>;
export type RecordOwnedRecoveryEvidenceReadPauseObservedInput = z.input<
  typeof RecordOwnedRecoveryEvidenceReadPauseObservedInputSchema
>;
export type ResumeBlockedOwnedRecoveryEvidenceReadInput = z.input<
  typeof ResumeBlockedOwnedRecoveryEvidenceReadInputSchema
>;
export type CreateOwnedRecoveryEvidenceVerificationCheckInput = z.input<
  typeof CreateRecoveryEvidenceVerificationCheckInputSchema
>;
export type CreateOwnedStoredEvidenceVerificationCheckInput = z.input<
  typeof CreateOwnedStoredEvidenceVerificationCheckInputSchema
>;
export type RecoveryEvidenceVerificationHostBinding = z.output<
  typeof RecoveryEvidenceVerificationHostBindingSchema
>;
export type RecoveryEvidenceVerificationHostBindingProvider =
  () => RecoveryEvidenceVerificationHostBinding;
export type CompleteOwnedRecoveryEvidenceReadInput = z.input<
  typeof CompleteRecoveryEvidenceReadInputSchema
>;
export type RecordOwnedRecoveryEvidenceVerificationInput = z.input<
  typeof RecordRecoveryEvidenceVerificationInputSchema
>;

export interface RecoveryEvidenceReadbackRequestCreationResult {
  readonly request: RecoveryEvidenceReadbackRequestRecord;
  readonly attempt: RecoveryEvidenceReadAttemptRecord;
  readonly operation: RecoveryReviewOperationRecord;
  readonly replayed: boolean;
}

export interface RecoveryEvidenceDispatchPersistedResult {
  readonly taskId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly readToolRunId: string;
  readonly planId: string;
  readonly planStepId: string;
  readonly attemptStatus: RecoveryEvidenceReadAttemptStatus;
  readonly toolRunStatus: ToolRunStatus;
  readonly planStepStatus: PlanStepStatus;
  readonly planStatus: ExecutionPlanStatus;
}

export type RecoveryEvidenceDispatchResult =
  | (RecoveryEvidenceDispatchPersistedResult & {
      readonly state: "created";
      readonly replayed: false;
    })
  | (RecoveryEvidenceDispatchPersistedResult & {
      readonly state: "replayed-existing-dispatching";
      readonly replayed: true;
    })
  | {
      readonly state: "cancel_required";
      readonly replayed: false;
      readonly taskId: string;
      readonly requestId: string;
    }
  | {
      readonly state: "pause_blocked";
      readonly replayed: false;
      readonly taskId: string;
      readonly requestId: string;
    }
  | {
      readonly state: "state_inconsistent";
      readonly replayed: false;
      readonly taskId: string;
      readonly requestId: string;
      readonly reason:
        | "initial_attempt_identity_invalid"
        | "multiple_active_attempts"
        | "retry_lineage_invalid";
    };

export interface RecoveryEvidenceTaskWideIntentResult {
  readonly state: "created" | "replayed";
  readonly replayed: boolean;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly checkpointSequence: number;
}

export interface RecoveryEvidenceReadFailureResult
  extends RecoveryEvidenceDispatchPersistedResult {
  readonly state: "failed" | "timed_out";
  readonly replayed: boolean;
  readonly reasonCode: string;
}

export type RecoveryEvidenceReadCancelResult =
  | (RecoveryEvidenceDispatchPersistedResult & {
      readonly state: "cancelled";
      readonly replayed: boolean;
      readonly cancelIntentEventId: string;
    })
  | (RecoveryEvidenceDispatchPersistedResult & {
      readonly state: "completed";
      readonly replayed: true;
    })
  | {
      readonly state:
        | "cancel_required"
        | "terminal_status_conflict"
        | "state_inconsistent";
      readonly replayed: false;
      readonly taskId: string;
      readonly requestId: string;
      readonly attemptId: string;
    };

export interface RecoveryEvidencePauseBlockResult {
  readonly state: "blocked" | "replayed";
  readonly replayed: boolean;
  readonly attempt: RecoveryEvidenceReadAttemptRecord;
  readonly pauseRequestEventId: string;
}

export interface RecoveryEvidencePauseObservedResult {
  readonly state: "created" | "replayed";
  readonly replayed: boolean;
  readonly taskId: string;
  readonly requestId: string;
  readonly attemptId: string;
  readonly pauseRequestEventId: string;
  readonly eventId: string;
  readonly eventSequence: number;
  readonly checkpointSequence: number;
  readonly externalCallStarted: boolean | "unknown";
}

export interface RecoveryEvidenceResumeResult {
  readonly state: "created" | "replayed";
  readonly replayed: boolean;
  readonly request: RecoveryEvidenceReadbackRequestRecord;
  readonly attempt: RecoveryEvidenceReadAttemptRecord;
  readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
  readonly pauseClearEventId: string;
}

export interface RecoveryEvidenceReadCompletionResult {
  readonly request: RecoveryEvidenceReadbackRequestRecord;
  readonly attempt: RecoveryEvidenceReadAttemptRecord;
  readonly check: RecoveryEvidenceVerificationCheckRecord;
  readonly read: RecoveryEvidenceReadRecord;
  readonly replayed: boolean;
}

export interface RecoveryEvidenceVerificationCheckCreationResult {
  readonly check: RecoveryEvidenceVerificationCheckRecord;
  readonly replayed: boolean;
  readonly state: "created" | "verification" | "pending";
  readonly verification: RecoveryEvidenceVerificationRecord | null;
}

export interface RecoveryEvidenceVerificationCreationResult {
  readonly verification: RecoveryEvidenceVerificationRecord;
  readonly replayed: boolean;
}

export interface RecoveryEvidenceParentPreparationContext {
  readonly task: TaskRecord;
  readonly permit: StorageWritePermit;
  readonly now: string;
}

export type RecoveryEvidenceParentPreparation = (
  context: RecoveryEvidenceParentPreparationContext,
) => void;

export class RecoveryEvidenceUnitOfWork {
  private readonly tasks: TaskRepository;
  private readonly reviews: RecoveryReviewRepository;
  private readonly operations: RecoveryReviewOperationRepository;
  private readonly plans: ExecutionPlanRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly submissions: RecoveryEvidenceSubmissionRepository;
  private readonly requests: RecoveryEvidenceReadbackRequestRepository;
  private readonly reservations: RecoveryEvidenceReadbackReservationRepository;
  private readonly attempts: RecoveryEvidenceReadAttemptRepository;
  private readonly reads: RecoveryEvidenceReadRepository;
  private readonly checks: RecoveryEvidenceVerificationCheckRepository;
  private readonly verifications: RecoveryEvidenceVerificationRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly sequences: SequenceAllocator;
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly stateTransitions: RecoveryEvidenceStateTransitionUnitOfWork | undefined;

  constructor(
    private readonly database: Database.Database,
    private readonly assertAuthority: () => void,
    private readonly leaseManager?: TaskLeaseManager,
  ) {
    this.sequences = new SequenceAllocator(database);
    this.tasks = new TaskRepository(database);
    this.reviews = new RecoveryReviewRepository(database);
    this.operations = new RecoveryReviewOperationRepository(database);
    this.plans = new ExecutionPlanRepository(database);
    this.planSteps = new PlanStepRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    this.submissions = new RecoveryEvidenceSubmissionRepository(database);
    this.requests = new RecoveryEvidenceReadbackRequestRepository(database);
    this.reservations =
      new RecoveryEvidenceReadbackReservationRepository(database);
    this.attempts = new RecoveryEvidenceReadAttemptRepository(database);
    this.reads = new RecoveryEvidenceReadRepository(database);
    this.checks =
      new RecoveryEvidenceVerificationCheckRepository(database);
    this.verifications =
      new RecoveryEvidenceVerificationRepository(database);
    this.events = new EventRepository(database, this.sequences);
    this.checkpoints = new CheckpointStore(database, this.sequences);
    this.snapshotReader = new TaskSnapshotReader(database);
    this.stateTransitions =
      leaseManager === undefined
        ? undefined
        : new RecoveryEvidenceStateTransitionUnitOfWork(
            database,
            assertAuthority,
            leaseManager,
          );
  }

  createOwnedRecoveryEvidenceReadbackRequest(
    input: CreateOwnedRecoveryEvidenceReadbackRequestInput,
    prepareParents?: RecoveryEvidenceParentPreparation,
  ): RecoveryEvidenceReadbackRequestCreationResult {
    const parsed =
      CreateRecoveryEvidenceReadbackRequestInputSchema.parse(input);
    const now = new Date().toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const computedPayloadDigest =
          computeRecoveryEvidenceReadbackOperationPayloadDigest({
            evidenceSubmissionId: parsed.evidenceSubmissionId,
            originalUnknownToolRunId: parsed.originalToolRunId,
            verifierId: parsed.verifierId,
            verifierVersion: parsed.verifierVersion,
            verifierConfigDigest: parsed.verifierConfigDigest,
            allowlistId: parsed.allowlistId,
            allowlistVersion: parsed.allowlistVersion,
            readToolName: parsed.readToolName,
            readToolVersion: parsed.readToolVersion,
            readToolSchemaHash: parsed.readToolSchemaHash,
            expectedResourceVersion: parsed.expectedResourceVersion,
            expectedEtag: parsed.expectedEtag,
            verificationCheckId: parsed.verificationCheckId,
            expectedDecisionVersion: parsed.expectedDecisionVersion,
          });
        if (computedPayloadDigest !== parsed.operationPayloadDigest) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAYLOAD_DIGEST_MISMATCH",
            "Recovery evidence operation payload digest does not match its binding.",
          );
        }
        const expectedRequestKey =
          computeRecoveryReviewOperationRequestKey({
            reviewId: parsed.reviewId,
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            operation: "request_readback",
            operationPayloadDigest: parsed.operationPayloadDigest,
            actorId: parsed.actorId,
          });
        if (expectedRequestKey !== parsed.requestKey) {
          throw stateError(
            "RECOVERY_EVIDENCE_REQUEST_KEY_MISMATCH",
            "Recovery evidence request key does not match its payload.",
          );
        }

        const existing =
          this.operations.getByRequestKey(parsed.requestKey);
        if (existing !== undefined) {
          if (
            existing.taskId !== task.id ||
            existing.reviewId !== parsed.reviewId ||
            existing.operation !== "request_readback" ||
            existing.status !== "accepted" ||
            existing.expectedDecisionVersion !==
              parsed.expectedDecisionVersion ||
            existing.resultingDecisionVersion !==
              parsed.expectedDecisionVersion + 1 ||
            existing.actorId !== parsed.actorId ||
            existing.operationPayloadDigest !==
              parsed.operationPayloadDigest ||
            existing.resultPlanId !== parsed.executionPlanId ||
            existing.resultToolRunId !== parsed.readToolRunId
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_REQUEST_KEY_CONFLICT",
              "Recovery evidence request key was already used.",
            );
          }
          const request = this.requests.getByOperationId(existing.id);
          if (request === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_READBACK_REQUEST_INCOMPLETE",
              "Recovery evidence request operation has no request row.",
            );
          }
          if (
            request.reviewId !== parsed.reviewId ||
            request.evidenceSubmissionId !==
              parsed.evidenceSubmissionId ||
            request.originalToolRunId !== parsed.originalToolRunId ||
            request.requestKey !== parsed.requestKey ||
            request.operationId !== existing.id ||
            request.executionPlanId !== parsed.executionPlanId ||
            request.planStepId !== parsed.planStepId ||
            request.readToolRunId !== parsed.readToolRunId ||
            request.verifierId !== parsed.verifierId ||
            request.verifierVersion !== parsed.verifierVersion ||
            request.verifierConfigDigest !==
              parsed.verifierConfigDigest ||
            request.allowlistId !== parsed.allowlistId ||
            request.allowlistVersion !== parsed.allowlistVersion ||
            request.readToolName !== parsed.readToolName ||
            request.readToolVersion !== parsed.readToolVersion ||
            request.readToolSchemaHash !== parsed.readToolSchemaHash ||
            request.retrySafety !== parsed.retrySafety ||
            request.consistencyMode !== parsed.consistencyMode ||
            request.expectedResourceVersion !==
              parsed.expectedResourceVersion ||
            request.expectedEtag !== parsed.expectedEtag ||
            request.verificationCheckId !==
              parsed.verificationCheckId
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_REQUEST_KEY_CONFLICT",
              "Recovery evidence request binding does not match the replay.",
            );
          }
          const attempt = this.attempts
            .listByTask(task.id)
            .find(
              (candidate) =>
                candidate.readbackRequestId === request.id &&
                candidate.attemptNumber === 1,
            );
          if (attempt === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_READBACK_REQUEST_INCOMPLETE",
              "Recovery evidence request has no prepared attempt.",
            );
          }
          return {
            request,
            attempt,
            operation: existing,
            replayed: true,
          };
        }

        this.assertNoRecoveryIntent(task);
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        prepareParents?.({ task, permit, now });
        const review = this.reviews.get(parsed.reviewId);
        if (
          review.taskId !== task.id ||
          review.toolRunId !== parsed.originalToolRunId ||
          review.reviewProtocolVersion < 1 ||
          !["pending", "unresolved"].includes(review.status) ||
          review.decisionVersion !== parsed.expectedDecisionVersion
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_REVIEW_BINDING_INVALID",
            "Recovery review is not an active protocol v1 target.",
          );
        }
        const readPlan = this.plans.get(parsed.executionPlanId);
        const readStep = this.planSteps.get(parsed.planStepId);
        const readRun = this.toolRuns.get(parsed.readToolRunId);
        if (
          readPlan.taskId !== task.id ||
          readPlan.purpose !== "recovery_evidence" ||
          readStep.taskId !== task.id ||
          readStep.planId !== readPlan.id ||
          readStep.kind !== "read_batch" ||
          readRun.taskId !== task.id ||
          readRun.planStepId !== readStep.id ||
          readRun.mode !== "read" ||
          readRun.status !== "queued"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_PLAN_BINDING_INVALID",
            "Recovery evidence read plan binding is invalid.",
          );
        }

        const resultingDecisionVersion =
          parsed.expectedDecisionVersion + 1;
        const reviewUpdate = this.database
          .prepare(
            `
              UPDATE recovery_reviews
              SET decision_version = ?, updated_at = ?
              WHERE id = ? AND task_id = ?
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
        if (reviewUpdate.changes !== 1) {
          throw stateError(
            "RECOVERY_EVIDENCE_DECISION_VERSION_CONFLICT",
            "Recovery review decision version changed.",
          );
        }

        const requestEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.readback_requested",
            entityType: "recovery_review",
            entityId: review.id,
            payload: {
              operationId: parsed.operationId,
              requestKey: parsed.requestKey,
              readbackRequestId: parsed.requestId,
              executionPlanId: parsed.executionPlanId,
              planStepId: parsed.planStepId,
              readToolRunId: parsed.readToolRunId,
              verificationCheckId: parsed.verificationCheckId,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const operation = this.operations.append(
          {
            id: parsed.operationId,
            taskId: task.id,
            reviewId: review.id,
            requestKey: parsed.requestKey,
            operation: "request_readback",
            expectedDecisionVersion: parsed.expectedDecisionVersion,
            resultingDecisionVersion,
            status: "accepted",
            actorId: parsed.actorId,
            operationPayloadDigest: parsed.operationPayloadDigest,
            evidenceEnvelopeDigest: null,
            resultPlanId: parsed.executionPlanId,
            resultToolRunId: parsed.readToolRunId,
            appliedEventId: requestEvent.id,
            createdAt: now,
          },
          permit,
        );
        const request = this.requests.insert(
          {
            id: parsed.requestId,
            taskId: task.id,
            reviewId: review.id,
            evidenceSubmissionId: parsed.evidenceSubmissionId,
            originalToolRunId: parsed.originalToolRunId,
            requestKey: parsed.requestKey,
            operationId: operation.id,
            executionPlanId: parsed.executionPlanId,
            planStepId: parsed.planStepId,
            readToolRunId: parsed.readToolRunId,
            verifierId: parsed.verifierId,
            verifierVersion: parsed.verifierVersion,
            verifierConfigDigest: parsed.verifierConfigDigest,
            allowlistId: parsed.allowlistId,
            allowlistVersion: parsed.allowlistVersion,
            readToolName: parsed.readToolName,
            readToolVersion: parsed.readToolVersion,
            readToolSchemaHash: parsed.readToolSchemaHash,
            retrySafety: parsed.retrySafety,
            consistencyMode: parsed.consistencyMode,
            expectedResourceVersion: parsed.expectedResourceVersion,
            expectedEtag: parsed.expectedEtag,
            verificationCheckId: parsed.verificationCheckId,
            createdAt: now,
          },
          permit,
        );
        const preparedEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.read_attempt_prepared",
            entityType: "recovery_evidence_read_attempt",
            entityId: parsed.readAttemptId,
            payload: {
              readAttemptId: parsed.readAttemptId,
              attemptNumber: 1,
              attemptStatus: "prepared",
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const attempt = this.attempts.insertPrepared(
          {
            id: parsed.readAttemptId,
            taskId: task.id,
            readbackRequestId: request.id,
            readToolRunId: request.readToolRunId,
            attemptNumber: 1,
            retrySafety: request.retrySafety,
            consistencyMode: request.consistencyMode,
            preparedAt: now,
            lastEventId: preparedEvent.id,
            createdAt: now,
          },
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_readback_requested",
          preparedEvent.sequence,
          {
            readbackRequestId: request.id,
            attemptId: attempt.id,
            operationId: operation.id,
          },
          now,
          permit,
        );
        return {
          request,
          attempt,
          operation,
          replayed: false,
        };
      },
      "immediate",
    );
  }

  createOwnedRecoveryEvidenceReadAttemptPrepared(
    input: CreateOwnedRecoveryEvidenceReadAttemptPreparedInput,
  ): RecoveryEvidenceReadAttemptRecord {
    const parsed =
      CreateRecoveryEvidenceReadAttemptPreparedInputSchema.parse(input);
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const request = this.requests.get(parsed.readbackRequestId);
        if (request.taskId !== task.id) {
          throw stateError(
            "RECOVERY_EVIDENCE_REQUEST_TASK_MISMATCH",
            "Recovery evidence request does not belong to the owned task.",
          );
        }
        const attempts = this.attempts
          .listByTask(task.id)
          .filter(
            (attempt) => attempt.readbackRequestId === request.id,
          );
        if (
          attempts.some((attempt) =>
            ["prepared", "dispatching"].includes(attempt.status),
          )
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_ATTEMPT_ACTIVE",
            "Recovery evidence request already has an active attempt.",
          );
        }
        if (attempts.some((attempt) => attempt.status === "completed")) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_ALREADY_COMPLETED",
            "A completed recovery evidence read cannot receive a new attempt.",
          );
        }
        const attemptNumber = this.attempts.nextAttemptNumber(
          task.id,
          request.id,
          request.readToolRunId,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.read_attempt_prepared",
            entityType: "recovery_evidence_read_attempt",
            entityId: parsed.attemptId,
            payload: {
              readAttemptId: parsed.attemptId,
              attemptNumber,
              attemptStatus: "prepared",
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const attempt = this.attempts.insertPrepared(
          {
            id: parsed.attemptId,
            taskId: task.id,
            readbackRequestId: request.id,
            readToolRunId: request.readToolRunId,
            attemptNumber,
            retrySafety: request.retrySafety,
            consistencyMode: request.consistencyMode,
            preparedAt: now,
            lastEventId: event.id,
            createdAt: now,
          },
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_read_attempt_prepared",
          event.sequence,
          { attemptId: attempt.id, attemptNumber },
          now,
          permit,
        );
        return attempt;
      },
      "immediate",
    );
  }

  setTaskWideRecoveryEvidenceCancel(
    input: SetTaskWideRecoveryEvidenceCancelInput,
  ): RecoveryEvidenceTaskWideIntentResult {
    const parsed =
      SetTaskWideRecoveryEvidenceCancelInputSchema.parse(input);
    const claims = assertRecoveryEvidenceHostControlAuthorization(
      parsed.hostControlAuthorization,
      {
        operation: "cancel_set",
        requestNonce: parsed.requestNonce,
        controlActor: parsed.controlActor,
      },
    );
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.getWaitingReviewTask(claims.taskId);
        const events = this.events.listByTask(task.id);
        const replayEvent = events.find(
          (event) =>
            event.type === "recovery.evidence.cancel_requested" &&
            event.payload.requestNonce === parsed.requestNonce,
        );
        const latestCancelEvent = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "recovery.evidence.cancel_requested",
          );
        if (task.cancelRequestedAt !== null) {
          if (
            replayEvent === undefined ||
            latestCancelEvent?.id !== replayEvent.id ||
            replayEvent.payload.cancelRequestedAt !==
              task.cancelRequestedAt ||
            replayEvent.payload.controlActor !== parsed.controlActor
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_CANCEL_INTENT_CONFLICT",
              "Recovery evidence Cancel intent is already set.",
            );
          }
          const checkpoint = this.findIntentCheckpoint(
            task.id,
            "recovery_evidence_cancel_requested",
            replayEvent.id,
          );
          if (checkpoint === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_CANCEL_INTENT_INCOMPLETE",
              "Recovery evidence Cancel intent checkpoint is missing.",
            );
          }
          return intentResult("replayed", task, replayEvent, checkpoint);
        }
        if (replayEvent !== undefined) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_INTENT_INCOMPLETE",
            "Recovery evidence Cancel intent Event exists without Task intent.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        this.tasks.setRecoveryEvidenceCancelIntentCas(
          task.id,
          parsed.expectedTaskVersion,
          now,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.cancel_requested",
            entityType: "task",
            entityId: task.id,
            payload: {
              taskId: task.id,
              cancelRequestedAt: now,
              taskVersion: parsed.expectedTaskVersion,
              controlActor: parsed.controlActor,
              requestNonce: parsed.requestNonce,
            },
          },
          now,
          permit,
        );
        const checkpoint = this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_evidence_cancel_requested",
          event.sequence,
          {
            intentEventId: event.id,
            requestNonce: parsed.requestNonce,
            controlActor: parsed.controlActor,
          },
          now,
          permit,
        );
        return intentResult(
          "created",
          this.tasks.get(task.id),
          event,
          checkpoint,
        );
      },
      "immediate",
    );
  }

  setTaskWideRecoveryEvidencePause(
    input: SetTaskWideRecoveryEvidencePauseInput,
  ): RecoveryEvidenceTaskWideIntentResult {
    const parsed =
      SetTaskWideRecoveryEvidencePauseInputSchema.parse(input);
    const claims = assertRecoveryEvidenceHostControlAuthorization(
      parsed.hostControlAuthorization,
      {
        operation: "pause_set",
        requestNonce: parsed.requestNonce,
        controlActor: parsed.controlActor,
      },
    );
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.getWaitingReviewTask(claims.taskId);
        if (task.cancelRequestedAt !== null) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_PRECEDES_PAUSE",
            "Cancel intent blocks setting recovery evidence Pause.",
          );
        }
        const events = this.events.listByTask(task.id);
        const replayEvent = events.find(
          (event) =>
            event.type === "recovery.evidence.pause_requested" &&
            event.payload.requestNonce === parsed.requestNonce,
        );
        const latestPauseEvent = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "recovery.evidence.pause_requested",
          );
        if (task.pauseRequestedAt !== null) {
          if (
            replayEvent === undefined ||
            latestPauseEvent?.id !== replayEvent.id ||
            replayEvent.payload.pauseRequestedAt !==
              task.pauseRequestedAt ||
            replayEvent.payload.controlActor !== parsed.controlActor
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_INTENT_CONFLICT",
              "Recovery evidence Pause intent is already set.",
            );
          }
          const checkpoint = this.findIntentCheckpoint(
            task.id,
            "recovery_evidence_pause_requested",
            replayEvent.id,
          );
          if (checkpoint === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_INTENT_INCOMPLETE",
              "Recovery evidence Pause intent checkpoint is missing.",
            );
          }
          return intentResult("replayed", task, replayEvent, checkpoint);
        }
        if (replayEvent !== undefined) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_INTENT_INCOMPLETE",
            "Recovery evidence Pause intent Event exists without Task intent.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        this.tasks.setRecoveryEvidencePauseIntentCas(
          task.id,
          parsed.expectedTaskVersion,
          now,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.pause_requested",
            entityType: "task",
            entityId: task.id,
            payload: {
              taskId: task.id,
              pauseRequestedAt: now,
              pauseEventSequence: task.lastEventSequence + 1,
              taskVersion: parsed.expectedTaskVersion,
              controlActor: parsed.controlActor,
              requestNonce: parsed.requestNonce,
            },
          },
          now,
          permit,
        );
        const checkpoint = this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_evidence_pause_requested",
          event.sequence,
          {
            intentEventId: event.id,
            requestNonce: parsed.requestNonce,
            controlActor: parsed.controlActor,
          },
          now,
          permit,
        );
        return intentResult(
          "created",
          this.tasks.get(task.id),
          event,
          checkpoint,
        );
      },
      "immediate",
    );
  }

  clearTaskWideRecoveryEvidencePause(
    input: ClearTaskWideRecoveryEvidencePauseInput,
  ): RecoveryEvidenceTaskWideIntentResult {
    const parsed =
      ClearTaskWideRecoveryEvidencePauseInputSchema.parse(input);
    const claims = assertRecoveryEvidenceHostControlAuthorization(
      parsed.hostControlAuthorization,
      {
        operation: "pause_clear",
        requestNonce: parsed.requestNonce,
        controlActor: parsed.controlActor,
      },
    );
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.getWaitingReviewTask(claims.taskId);
        const events = this.events.listByTask(task.id);
        if (task.pauseRequestedAt === null) {
          const replayEvent = events.find(
            (event) =>
              event.type === "recovery.evidence.pause_cleared" &&
              event.payload.clearedPauseEventId ===
                parsed.pauseRequestEventId &&
              event.payload.requestNonce === parsed.requestNonce &&
              event.payload.clearedPauseEventSequence ===
                parsed.expectedPauseEventSequence,
          );
          if (replayEvent === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_NOT_ACTIVE",
              "Recovery evidence Pause intent is not active.",
            );
          }
          const checkpoint = this.findIntentCheckpoint(
            task.id,
            "recovery_evidence_pause_cleared",
            replayEvent.id,
          );
          if (checkpoint === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_CLEAR_INCOMPLETE",
              "Recovery evidence Pause clear checkpoint is missing.",
            );
          }
          return intentResult("replayed", task, replayEvent, checkpoint);
        }
        if (task.cancelRequestedAt !== null) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_PRECEDES_PAUSE",
            "Cancel intent blocks clearing recovery evidence Pause.",
          );
        }
        if (task.pauseRequestedAt !== parsed.expectedPauseRequestedAt) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_GENERATION_CONFLICT",
            "Recovery evidence Pause generation changed.",
          );
        }
        const pauseEvent = events.find(
          (event) =>
            event.id === parsed.pauseRequestEventId &&
            event.type === "recovery.evidence.pause_requested",
        );
        const latestPauseEvent = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "recovery.evidence.pause_requested",
          );
        if (
          pauseEvent === undefined ||
          pauseEvent.sequence !== parsed.expectedPauseEventSequence ||
          pauseEvent.payload.pauseRequestedAt !==
            parsed.expectedPauseRequestedAt ||
          latestPauseEvent?.id !== pauseEvent.id
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_GENERATION_CONFLICT",
            "Recovery evidence Pause generation does not match.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        this.tasks.clearRecoveryEvidencePauseIntentCas(
          task.id,
          parsed.expectedTaskVersion,
          parsed.expectedPauseRequestedAt,
          now,
          permit,
        );
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.pause_cleared",
            entityType: "task",
            entityId: task.id,
            payload: {
              clearedPauseEventId: pauseEvent.id,
              clearedPauseEventSequence: pauseEvent.sequence,
              pauseRequestedAt: parsed.expectedPauseRequestedAt,
              requestNonce: parsed.requestNonce,
              controlActor: parsed.controlActor,
              taskVersion: parsed.expectedTaskVersion,
            },
          },
          now,
          permit,
        );
        const checkpoint = this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_evidence_pause_cleared",
          event.sequence,
          {
            intentEventId: event.id,
            clearedPauseEventId: pauseEvent.id,
            requestNonce: parsed.requestNonce,
            controlActor: parsed.controlActor,
          },
          now,
          permit,
        );
        return intentResult(
          "created",
          this.tasks.get(task.id),
          event,
          checkpoint,
        );
      },
      "immediate",
    );
  }

  beginOwnedRecoveryEvidenceRead(
    input: BeginOwnedRecoveryEvidenceReadInput,
  ): RecoveryEvidenceDispatchResult {
    const parsed = BeginOwnedRecoveryEvidenceReadInputSchema.parse(input);
    const preflight =
      assertRecoveryEvidenceDispatchPreflightCapability(parsed.preflight);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const request = this.requests.get(parsed.requestId);
        const attempt = this.attempts.get(parsed.attemptId);
        if (
          request.taskId !== task.id ||
          attempt.taskId !== task.id ||
          attempt.readbackRequestId !== request.id ||
          attempt.readToolRunId !== request.readToolRunId
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_BINDING_INVALID",
            "Recovery evidence dispatch identity is invalid.",
          );
        }
        const reservation = this.reservations.getByRequestId(request.id);
        if (
          reservation === undefined ||
          reservation.status !== "completed" ||
          reservation.taskId !== task.id ||
          reservation.requestId !== request.id ||
          reservation.operationId !== request.operationId ||
          reservation.executionPlanId !== request.executionPlanId ||
          reservation.planStepId !== request.planStepId ||
          reservation.readToolRunId !== request.readToolRunId ||
          reservation.verificationCheckId !== request.verificationCheckId
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_RESERVATION_REQUIRED",
            "Recovery evidence dispatch requires a completed Reservation.",
          );
        }
        this.reservations.assertCompletedIdentityInvariant(reservation.id);
        const operation = this.operations.get(request.operationId);
        const review = this.reviews.get(request.reviewId);
        if (
          operation.taskId !== task.id ||
          operation.reviewId !== review.id ||
          operation.operation !== "request_readback" ||
          operation.status !== "accepted" ||
          operation.resultPlanId !== request.executionPlanId ||
          operation.resultToolRunId !== request.readToolRunId ||
          review.taskId !== task.id ||
          review.toolRunId !== request.originalToolRunId ||
          !["pending", "unresolved"].includes(review.status) ||
          review.decisionVersion !== operation.resultingDecisionVersion
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_REVIEW_INVALID",
            "Recovery evidence dispatch Review binding is invalid.",
          );
        }

        const plan = this.plans.get(request.executionPlanId);
        const planStep = this.planSteps.get(request.planStepId);
        const readRun = this.toolRuns.get(request.readToolRunId);
        if (
          plan.taskId !== task.id ||
          plan.purpose !== "recovery_evidence" ||
          planStep.taskId !== task.id ||
          planStep.planId !== plan.id ||
          planStep.kind !== "read_batch" ||
          readRun.taskId !== task.id ||
          readRun.planStepId !== planStep.id ||
          readRun.mode !== "read"
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_BINDING_INVALID",
            "Recovery evidence dispatch Plan binding is invalid.",
          );
        }
        if (
          request.allowlistId !== preflight.allowlistId ||
          request.allowlistVersion !== preflight.allowlistVersion ||
          request.allowlistVersion !==
            preflight.allowlistContractDigest ||
          request.readToolName !== preflight.readToolName ||
          request.readToolVersion !== preflight.readToolVersion ||
          request.readToolSchemaHash !== preflight.readToolSchemaHash ||
          request.retrySafety !== preflight.retrySafety ||
          request.consistencyMode !== preflight.consistencyMode ||
          readRun.toolName !== request.readToolName ||
          readRun.toolVersion !== request.readToolVersion ||
          readRun.inputSchemaHash !== request.readToolSchemaHash ||
          readRun.canonicalInputHash !==
            parsed.expectedCanonicalInputHash ||
          attempt.retrySafety !== request.retrySafety ||
          attempt.consistencyMode !== request.consistencyMode
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_PREFLIGHT_MISMATCH",
            "Recovery evidence dispatch preflight does not match persisted state.",
          );
        }

        if (task.cancelRequestedAt !== null) {
          return {
            state: "cancel_required",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
          } as const;
        }
        if (task.pauseRequestedAt !== null) {
          return {
            state: "pause_blocked",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
          } as const;
        }

        const activeAttempts = this.attempts
          .listByTask(task.id)
          .filter(
            (candidate) =>
              candidate.readbackRequestId === request.id &&
              candidate.readToolRunId === request.readToolRunId &&
              ["prepared", "dispatching"].includes(candidate.status),
          );
        if (
          activeAttempts.length !== 1 ||
          activeAttempts[0]?.id !== attempt.id
        ) {
          return {
            state: "state_inconsistent",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
            reason: "multiple_active_attempts",
          } as const;
        }
        if (
          !this.hasPreparedAttemptEvent(
            task.id,
            attempt.id,
            attempt.attemptNumber,
            attempt.status === "prepared" ? attempt.lastEventId : null,
          )
        ) {
          return {
            state: "state_inconsistent",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
            reason: "retry_lineage_invalid",
          } as const;
        }
        if (attempt.attemptNumber === 1) {
          if (attempt.id !== reservation.readAttemptId) {
            return {
              state: "state_inconsistent",
              replayed: false,
              taskId: task.id,
              requestId: request.id,
              reason: "initial_attempt_identity_invalid",
            } as const;
          }
        } else if (
          !this.hasValidRetryDispatchLineage({
            taskId: task.id,
            request,
            attempt,
            currentFencingToken: parsed.ownership.fencingToken,
          })
        ) {
          return {
            state: "state_inconsistent",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
            reason: "retry_lineage_invalid",
          } as const;
        }

        const dispatchEvent = this.events
          .listByTask(task.id)
          .find(
            (event) =>
              event.type ===
                "recovery.evidence.read_attempt_dispatching" &&
              event.entityId === attempt.id &&
              event.payload.readAttemptId === attempt.id &&
              event.payload.attemptStatus === "dispatching",
          );
        if (attempt.status === "dispatching") {
          if (
            dispatchEvent === undefined ||
            readRun.status !== "running" ||
            planStep.status !== "running" ||
            plan.status !== "active"
          ) {
            throw dispatchStateError(
              "RECOVERY_EVIDENCE_DISPATCH_STATE_INCONSISTENT",
              "Persisted Dispatch state is inconsistent.",
            );
          }
          return dispatchResult("replayed-existing-dispatching", {
            task,
            request,
            attempt,
            readRun,
            plan,
            planStep,
          });
        }

        if (
          attempt.status !== "prepared" ||
          readRun.status !== "queued" ||
          !["queued", "running"].includes(planStep.status) ||
          plan.status !== "active"
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_STATE_CONFLICT",
            "Recovery evidence dispatch state is not eligible.",
          );
        }
        if (attempt.attemptNumber === 1) {
          this.reservations.assertCompletedInvariant(reservation.id);
        }
        if (
          attempt.version !== parsed.expectedAttemptVersion ||
          readRun.version !== parsed.expectedToolRunVersion ||
          planStep.version !== parsed.expectedPlanStepVersion ||
          plan.version !== parsed.expectedPlanVersion
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_VERSION_CONFLICT",
            "Recovery evidence dispatch binding changed.",
          );
        }
        if (this.stateTransitions === undefined) {
          throw dispatchStateError(
            "TASK_LEASE_REQUIRED",
            "Recovery evidence dispatch requires an owned task lease.",
          );
        }
        const dispatching =
          this.stateTransitions.transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
            {
              ownership: parsed.ownership,
              expectedTaskVersion: parsed.expectedTaskVersion,
              attemptId: attempt.id,
              expectedAttemptVersion: attempt.version,
              status: "dispatching",
              observedAt: null,
              resourceVersion: null,
              resourceEtag: null,
              resultDigest: null,
              resultPayloadStoreRef: null,
              reasonCode: null,
            },
            permit,
          );
        const latest = this.snapshotReader.load(task.id);
        const latestRun = latest.toolRuns.find(
          (run) => run.id === request.readToolRunId,
        );
        const latestStep = latest.planSteps.find(
          (step) => step.id === request.planStepId,
        );
        const latestPlan = latest.executionPlans.find(
          (candidate) => candidate.id === request.executionPlanId,
        );
        if (
          latestRun === undefined ||
          latestStep === undefined ||
          latestPlan === undefined
        ) {
          throw dispatchStateError(
            "RECOVERY_EVIDENCE_DISPATCH_STATE_INCONSISTENT",
            "Recovery evidence dispatch state disappeared.",
          );
        }
        return dispatchResult("created", {
          task,
          request,
          attempt: dispatching,
          readRun: latestRun,
          plan: latestPlan,
          planStep: latestStep,
        });
      },
      "immediate",
    );
  }

  failOwnedRecoveryEvidenceRead(
    input: FailOwnedRecoveryEvidenceReadInput,
  ): RecoveryEvidenceReadFailureResult {
    const parsed =
      FailOwnedRecoveryEvidenceReadInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const request = this.requests.get(parsed.requestId);
        const attempt = this.attempts.get(parsed.attemptId);
        const run = this.toolRuns.get(request.readToolRunId);
        const step = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        this.assertRecoveryEvidenceReadBinding(
          task,
          request,
          attempt,
          run,
          step,
          plan,
        );
        const replayEvent = this.findAttemptOutcomeEvent(
          task.id,
          attempt.id,
          parsed.terminalStatus,
          parsed.reasonCode,
        );
        if (attempt.status === parsed.terminalStatus) {
          if (
            replayEvent === undefined ||
            run.status !== parsed.terminalStatus ||
            step.status !== "failed" ||
            plan.status !== "failed"
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_READ_TERMINAL_STATE_INCONSISTENT",
              "Recovery evidence terminal state is inconsistent.",
            );
          }
          return failureResult("replayed", {
            task,
            request,
            attempt,
            run,
            step,
            plan,
            reasonCode: parsed.reasonCode,
          });
        }
        if (
          ["failed", "timed_out", "cancelled", "completed"].includes(
            attempt.status,
          )
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_TERMINAL_CONFLICT",
            "Recovery evidence Attempt already has another terminal status.",
          );
        }
        const cancelAuditEvent =
          task.cancelRequestedAt === null
            ? undefined
            : this.getLatestCancelRequestedEvent(task.id);
        if (
          task.cancelRequestedAt !== null &&
          (cancelAuditEvent === undefined ||
            cancelAuditEvent.payload.cancelRequestedAt !==
              task.cancelRequestedAt)
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_GENERATION_INCOMPLETE",
            "Recovery evidence Cancel generation is incomplete.",
          );
        }
        const pauseAuditEvent =
          task.pauseRequestedAt === null
            ? undefined
            : this.getLatestPauseRequestedEvent(task.id);
        if (
          task.pauseRequestedAt !== null &&
          (pauseAuditEvent === undefined ||
            pauseAuditEvent.payload.pauseRequestedAt !==
              task.pauseRequestedAt)
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_GENERATION_INCOMPLETE",
            "Recovery evidence Pause generation is incomplete.",
          );
        }
        const observedIntentEvent =
          cancelAuditEvent ?? pauseAuditEvent;
        const observedIntentKind =
          cancelAuditEvent !== undefined ? "cancel" : "pause";
        if (
          attempt.status !== "dispatching" ||
          run.status !== "running" ||
          step.status !== "running" ||
          plan.status !== "active"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_TERMINAL_STATE_CONFLICT",
            "Only a dispatched recovery evidence read can fail or time out.",
          );
        }
        if (
          attempt.version !== parsed.expectedAttemptVersion ||
          run.version !== parsed.expectedToolRunVersion ||
          step.version !== parsed.expectedPlanStepVersion ||
          plan.version !== parsed.expectedPlanVersion
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_TERMINAL_VERSION_CONFLICT",
            "Recovery evidence read changed before terminal settlement.",
          );
        }
        if (this.stateTransitions === undefined) {
          throw stateError(
            "TASK_LEASE_REQUIRED",
            "Recovery evidence terminal settlement requires an owned lease.",
          );
        }
        this.stateTransitions.transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
          {
            ownership: parsed.ownership,
            expectedTaskVersion: task.version,
            attemptId: attempt.id,
            expectedAttemptVersion: attempt.version,
            status: parsed.terminalStatus,
            observedAt: null,
            resourceVersion: null,
            resourceEtag: null,
            resultDigest: null,
            resultPayloadStoreRef: null,
            reasonCode: parsed.reasonCode,
            ...(observedIntentEvent === undefined
              ? {}
              : {
                  observedIntentEventId: observedIntentEvent.id,
                  observedIntentKind,
                }),
          },
          permit,
        );
        return failureResult("created", {
          task: this.tasks.get(task.id),
          request,
          attempt: this.attempts.get(attempt.id),
          run: this.toolRuns.get(run.id),
          step: this.planSteps.get(step.id),
          plan: this.plans.get(plan.id),
          reasonCode: parsed.reasonCode,
        });
      },
      "immediate",
    );
  }

  cancelOwnedRecoveryEvidenceRead(
    input: CancelOwnedRecoveryEvidenceReadInput,
  ): RecoveryEvidenceReadCancelResult {
    const parsed =
      CancelOwnedRecoveryEvidenceReadInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        if (task.cancelRequestedAt === null) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_INTENT_REQUIRED",
            "Recovery evidence cancellation requires a Task-wide Cancel intent.",
          );
        }
        const events = this.events.listByTask(task.id);
        const cancelEvent = events.find(
          (event) =>
            event.id === parsed.cancelIntentEventId &&
            event.type === "recovery.evidence.cancel_requested",
        );
        if (
          cancelEvent === undefined ||
          cancelEvent.payload.cancelRequestedAt !==
            task.cancelRequestedAt
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_GENERATION_CONFLICT",
            "Recovery evidence Cancel generation does not match the Task.",
          );
        }
        const request = this.requests.get(parsed.requestId);
        const attempt = this.attempts.get(parsed.attemptId);
        const run = this.toolRuns.get(request.readToolRunId);
        const step = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        this.assertRecoveryEvidenceReadBinding(
          task,
          request,
          attempt,
          run,
          step,
          plan,
        );
        const requestCancelEvent = this.findRequestCancelEvent(
          task.id,
          request.id,
          parsed.cancelIntentEventId,
        );
        const attemptCancelEvent = this.findAttemptOutcomeEvent(
          task.id,
          attempt.id,
          "cancelled",
          parsed.reasonCode,
          parsed.cancelIntentEventId,
        );
        if (
          requestCancelEvent !== undefined ||
          attemptCancelEvent !== undefined
        ) {
          if (
            !["blocked_by_intent", "interrupted", "cancelled"].includes(
              attempt.status,
            ) ||
            run.status !== "cancelled" ||
            step.status !== "cancelled" ||
            plan.status !== "cancelled"
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_CANCEL_REPLAY_INCONSISTENT",
              "Recovery evidence cancellation replay is inconsistent.",
            );
          }
          return cancelResult("cancelled", true, {
            task,
            request,
            attempt,
            run,
            step,
            plan,
            cancelIntentEventId: parsed.cancelIntentEventId,
          });
        }
        if (this.isRecoveryEvidenceReadbackCompleted(request)) {
          if (
            attempt.status !== "completed" ||
            run.status !== "succeeded" ||
            step.status !== "completed" ||
            !["active", "completed"].includes(plan.status)
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_CANCEL_COMPLETION_INCONSISTENT",
              "Completed recovery evidence read cancellation replay is inconsistent.",
            );
          }
          return cancelResult("completed", true, {
            task,
            request,
            attempt,
            run,
            step,
            plan,
            cancelIntentEventId: parsed.cancelIntentEventId,
          });
        }
        if (attempt.version !== parsed.expectedAttemptVersion) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_VERSION_CONFLICT",
            "Recovery evidence Attempt changed before cancellation.",
          );
        }
        const attempts = this.attempts
          .listByTask(task.id)
          .filter(
            (candidate) =>
              candidate.readbackRequestId === request.id &&
              candidate.readToolRunId === request.readToolRunId,
          );
        const activeAttempts = attempts.filter((candidate) =>
          ["prepared", "dispatching"].includes(candidate.status),
        );
        if (activeAttempts.length > 1) {
          return {
            state: "state_inconsistent",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
            attemptId: attempt.id,
          } as const;
        }
        const targetAttempt =
          activeAttempts[0] ?? attempts.at(-1);
        if (
          targetAttempt === undefined ||
          targetAttempt.id !== attempt.id
        ) {
          return {
            state: "state_inconsistent",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
            attemptId: attempt.id,
          } as const;
        }
        if (
          ["failed", "timed_out", "cancelled", "completed"].includes(
            attempt.status,
          )
        ) {
          return {
            state: "terminal_status_conflict",
            replayed: false,
            taskId: task.id,
            requestId: request.id,
            attemptId: attempt.id,
          } as const;
        }
        if (
          run.version !== parsed.expectedToolRunVersion ||
          step.version !== parsed.expectedPlanStepVersion ||
          plan.version !== parsed.expectedPlanVersion
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_VERSION_CONFLICT",
            "Recovery evidence read changed before cancellation.",
          );
        }
        if (attempt.status === "dispatching") {
          throw stateError(
            "RECOVERY_EVIDENCE_DISPATCH_SETTLEMENT_UNAVAILABLE",
            "Dispatching cancellation is unavailable until trusted settlement exists.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        if (this.stateTransitions === undefined) {
          throw stateError(
            "TASK_LEASE_REQUIRED",
            "Recovery evidence cancellation requires an owned lease.",
          );
        }
        this.stateTransitions.transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
          {
            ownership: parsed.ownership,
            expectedTaskVersion: parsed.expectedTaskVersion,
            attemptId: attempt.id,
            expectedAttemptVersion: attempt.version,
            status: "cancelled",
            transitionOperationId: parsed.cancelIntentEventId,
            intentEventId: parsed.cancelIntentEventId,
            observedAt: null,
            resourceVersion: null,
            resourceEtag: null,
            resultDigest: null,
            resultPayloadStoreRef: null,
            reasonCode: parsed.reasonCode,
          },
          permit,
        );
        return cancelResult("cancelled", false, {
          task: this.tasks.get(task.id),
          request,
          attempt: this.attempts.get(attempt.id),
          run: this.toolRuns.get(run.id),
          step: this.planSteps.get(step.id),
          plan: this.plans.get(plan.id),
          cancelIntentEventId: parsed.cancelIntentEventId,
        });
      },
      "immediate",
    );
  }

  blockOwnedRecoveryEvidenceReadForIntent(
    input: BlockOwnedRecoveryEvidenceReadForIntentInput,
  ): RecoveryEvidencePauseBlockResult {
    const parsed =
      BlockOwnedRecoveryEvidenceReadForIntentInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const request = this.requests.get(parsed.requestId);
        const attempt = this.attempts.get(parsed.attemptId);
        const run = this.toolRuns.get(request.readToolRunId);
        const step = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        this.assertRecoveryEvidenceReadBinding(
          task,
          request,
          attempt,
          run,
          step,
          plan,
        );
        const replayEvent = this.findAttemptOutcomeEvent(
          task.id,
          attempt.id,
          "blocked_by_intent",
          parsed.reasonCode,
          parsed.pauseRequestEventId,
        );
        if (replayEvent !== undefined) {
          if (
            attempt.status !== "blocked_by_intent" ||
            run.status !== "queued" ||
            !["queued", "running"].includes(step.status) ||
            plan.status !== "active"
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_BLOCK_REPLAY_INCONSISTENT",
              "Recovery evidence Pause block replay is inconsistent.",
            );
          }
          return {
            state: "replayed",
            replayed: true,
            attempt,
            pauseRequestEventId: parsed.pauseRequestEventId,
          } as const;
        }
        if (task.cancelRequestedAt !== null) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_PRECEDES_PAUSE",
            "Cancel intent blocks Recovery evidence Pause block.",
          );
        }
        if (task.pauseRequestedAt === null) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_INTENT_REQUIRED",
            "Recovery evidence Pause block requires active Pause intent.",
          );
        }
        const pauseEvent = this.getLatestPauseRequestedEvent(task.id);
        if (
          pauseEvent === undefined ||
          pauseEvent.id !== parsed.pauseRequestEventId ||
          pauseEvent.payload.pauseRequestedAt !==
            task.pauseRequestedAt
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_GENERATION_CONFLICT",
            "Recovery evidence Pause generation does not match.",
          );
        }
        if (
          attempt.status !== "prepared" ||
          run.status !== "queued" ||
          !["queued", "running"].includes(step.status) ||
          plan.status !== "active"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_BLOCK_STATE_CONFLICT",
            "Only a prepared recovery evidence read can be Pause-blocked.",
          );
        }
        if (
          attempt.version !== parsed.expectedAttemptVersion ||
          run.version !== parsed.expectedToolRunVersion ||
          step.version !== parsed.expectedPlanStepVersion ||
          plan.version !== parsed.expectedPlanVersion
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_BLOCK_VERSION_CONFLICT",
            "Recovery evidence read changed before Pause block.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        if (this.stateTransitions === undefined) {
          throw stateError(
            "TASK_LEASE_REQUIRED",
            "Recovery evidence Pause block requires an owned lease.",
          );
        }
        this.stateTransitions.transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
          {
            ownership: parsed.ownership,
            expectedTaskVersion: parsed.expectedTaskVersion,
            attemptId: attempt.id,
            expectedAttemptVersion: attempt.version,
            status: "blocked_by_intent",
            intentEventId: pauseEvent.id,
            observedAt: null,
            resourceVersion: null,
            resourceEtag: null,
            resultDigest: null,
            resultPayloadStoreRef: null,
            reasonCode: parsed.reasonCode,
          },
          permit,
        );
        return {
          state: "blocked",
          replayed: false,
          attempt: this.attempts.get(attempt.id),
          pauseRequestEventId: pauseEvent.id,
        } as const;
      },
      "immediate",
    );
  }

  recordOwnedRecoveryEvidenceReadPauseObserved(
    input: RecordOwnedRecoveryEvidenceReadPauseObservedInput,
  ): RecoveryEvidencePauseObservedResult {
    const parsed =
      RecordOwnedRecoveryEvidenceReadPauseObservedInputSchema.parse(input);
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const request = this.requests.get(parsed.requestId);
        const attempt = this.attempts.get(parsed.attemptId);
        const run = this.toolRuns.get(request.readToolRunId);
        const step = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        this.assertRecoveryEvidenceReadBinding(
          task,
          request,
          attempt,
          run,
          step,
          plan,
        );
        if (attempt.version !== parsed.expectedAttemptVersion) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_OBSERVED_VERSION_CONFLICT",
            "Recovery evidence Attempt changed before Pause observation.",
          );
        }
        const events = this.events.listByTask(task.id);
        const replayEvent = events.find(
          (event) =>
            event.type === "recovery.evidence.pause_observed" &&
            event.payload.readbackRequestId === request.id &&
            event.payload.readAttemptId === attempt.id &&
            event.payload.pauseRequestEventId ===
              parsed.pauseRequestEventId,
        );
        if (replayEvent !== undefined) {
          if (
            replayEvent.payload.dispatchEventId !==
              parsed.dispatchEventId ||
            replayEvent.payload.externalCallStarted !==
              parsed.externalCallStarted ||
            replayEvent.payload.interruptionCause !==
              parsed.interruptionCause ||
            replayEvent.payload.fencingToken !==
              parsed.ownership.fencingToken
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_OBSERVED_CONFLICT",
              "Recovery evidence Pause observation replay conflicts.",
            );
          }
          const checkpoint = this.findIntentCheckpoint(
            task.id,
            "recovery_evidence_pause_observed",
            replayEvent.id,
          );
          if (checkpoint === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_PAUSE_OBSERVED_INCOMPLETE",
              "Recovery evidence Pause observation checkpoint is missing.",
            );
          }
          return pauseObservedResult(
            "replayed",
            request.id,
            attempt.id,
            replayEvent,
            checkpoint,
            parsed.externalCallStarted,
          );
        }
        if (task.cancelRequestedAt !== null) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_PRECEDES_PAUSE",
            "Cancel intent blocks Pause observation.",
          );
        }
        if (task.pauseRequestedAt === null) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_INTENT_REQUIRED",
            "Pause observation requires active Pause intent.",
          );
        }
        const pauseEvent = this.getLatestPauseRequestedEvent(task.id);
        if (
          pauseEvent === undefined ||
          pauseEvent.id !== parsed.pauseRequestEventId ||
          pauseEvent.payload.pauseRequestedAt !==
            task.pauseRequestedAt
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_GENERATION_CONFLICT",
            "Pause observation does not match the latest generation.",
          );
        }
        const dispatchEvent = events.find(
          (event) =>
            event.id === parsed.dispatchEventId &&
            event.type ===
              "recovery.evidence.read_attempt_dispatching" &&
            event.entityId === attempt.id &&
            event.payload.readAttemptId === attempt.id &&
            event.payload.attemptStatus === "dispatching",
        );
        if (dispatchEvent === undefined) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_DISPATCH_BINDING_INVALID",
            "Pause observation does not bind the persisted Dispatch Event.",
          );
        }
        if (
          attempt.status !== "dispatching" ||
          run.status !== "running" ||
          step.status !== "running" ||
          plan.status !== "active"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_OBSERVED_STATE_CONFLICT",
            "Pause observation requires an actively dispatching Attempt.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.pause_observed",
            entityType: "recovery_evidence_read_attempt",
            entityId: attempt.id,
            payload: {
              readbackRequestId: request.id,
              readAttemptId: attempt.id,
              attemptNumber: attempt.attemptNumber,
              dispatchEventId: dispatchEvent.id,
              pauseRequestEventId: pauseEvent.id,
              attemptStatusAtPause: attempt.status,
              interruptionCause: parsed.interruptionCause,
              resumeEligible: true,
              externalCallStarted: parsed.externalCallStarted,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const checkpoint = this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_evidence_pause_observed",
          event.sequence,
          {
            intentEventId: event.id,
            pauseRequestEventId: pauseEvent.id,
            readbackRequestId: request.id,
            readAttemptId: attempt.id,
            dispatchEventId: dispatchEvent.id,
            externalCallStarted: parsed.externalCallStarted,
          },
          now,
          permit,
        );
        return pauseObservedResult(
          "created",
          request.id,
          attempt.id,
          event,
          checkpoint,
          parsed.externalCallStarted,
        );
      },
      "immediate",
    );
  }

  resumeBlockedOwnedRecoveryEvidenceRead(
    input: ResumeBlockedOwnedRecoveryEvidenceReadInput,
  ): RecoveryEvidenceResumeResult {
    const parsed =
      ResumeBlockedOwnedRecoveryEvidenceReadInputSchema.parse(input);
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        if (task.cancelRequestedAt !== null) {
          throw stateError(
            "RECOVERY_EVIDENCE_CANCEL_PRECEDES_RESUME",
            "Cancel intent blocks recovery evidence Resume.",
          );
        }
        if (task.pauseRequestedAt !== null) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_INTENT_ACTIVE",
            "Active Pause intent blocks recovery evidence Resume.",
          );
        }
        const request = this.requests.get(parsed.requestId);
        const priorAttempt = this.attempts.get(parsed.priorAttemptId);
        const run = this.toolRuns.get(request.readToolRunId);
        const step = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        this.assertRecoveryEvidenceReadBinding(
          task,
          request,
          priorAttempt,
          run,
          step,
          plan,
        );
        const events = this.events.listByTask(task.id);
        const clearEvent = events.find(
          (event) =>
            event.id === parsed.pauseClearEventId &&
            event.type === "recovery.evidence.pause_cleared",
        );
        const clearedPauseEventId = clearEvent?.payload
          .clearedPauseEventId;
        if (
          clearEvent === undefined ||
          typeof clearedPauseEventId !== "string"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_CLEAR_REQUIRED",
            "Recovery evidence Resume requires a matching Pause clear Event.",
          );
        }
        const latestPauseEvent = this.getLatestPauseRequestedEvent(task.id);
        if (
          latestPauseEvent !== undefined &&
          latestPauseEvent.sequence > clearEvent.sequence
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_PAUSE_GENERATION_CONFLICT",
            "A newer Pause generation blocks recovery evidence Resume.",
          );
        }
        const priorBlockEvent = events.find(
          (event) =>
            event.type ===
              "recovery.evidence.read_attempt_blocked_by_intent" &&
            event.entityId === priorAttempt.id &&
            event.payload.readAttemptId === priorAttempt.id &&
            event.payload.attemptStatus === "blocked_by_intent" &&
            event.payload.intentEventId === clearedPauseEventId,
        );
        if (
          priorAttempt.status !== "blocked_by_intent" ||
          priorAttempt.version !== parsed.expectedPriorAttemptVersion ||
          priorBlockEvent === undefined
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_RESUME_PRIOR_INVALID",
            "Recovery evidence Resume requires the matching blocked Attempt.",
          );
        }
        if (
          run.status !== "queued" ||
          !["queued", "running"].includes(step.status) ||
          plan.status !== "active" ||
          run.version !== parsed.expectedToolRunVersion ||
          step.version !== parsed.expectedPlanStepVersion ||
          plan.version !== parsed.expectedPlanVersion
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_RESUME_STATE_CONFLICT",
            "Recovery evidence read is not resumable.",
          );
        }
        const attempts = this.attempts
          .listByTask(task.id)
          .filter(
            (attempt) =>
              attempt.readbackRequestId === request.id &&
              attempt.readToolRunId === request.readToolRunId,
          );
        const activeAttempts = attempts.filter((attempt) =>
          ["prepared", "dispatching"].includes(attempt.status),
        );
        if (activeAttempts.length > 1) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_ATTEMPT_ACTIVE",
            "Recovery evidence Request has multiple active Attempts.",
          );
        }
        if (activeAttempts.length === 1) {
          const active = activeAttempts[0]!;
          const preparedEvent = events.find(
            (event) =>
              event.type === "recovery.evidence.read_attempt_prepared" &&
              event.entityId === active.id &&
              event.payload.readAttemptId === active.id &&
              event.payload.priorAttemptId === priorAttempt.id &&
              event.payload.newAttemptId === active.id &&
              event.payload.pauseClearEventId === clearEvent.id,
          );
          if (
            active.id !== parsed.newAttemptId ||
            preparedEvent === undefined
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_RESUME_REPLAY_INCONSISTENT",
              "Recovery evidence Resume replay is inconsistent.",
            );
          }
          return {
            state: "replayed",
            replayed: true,
            request,
            attempt: active,
            priorAttempt,
            pauseClearEventId: clearEvent.id,
          } as const;
        }
        if (attempts.at(-1)?.id !== priorAttempt.id) {
          throw stateError(
            "RECOVERY_EVIDENCE_RESUME_PRIOR_INVALID",
            "Recovery evidence Resume prior Attempt is not the latest history.",
          );
        }
        if (
          events.some(
            (event) =>
              event.type ===
                "recovery.evidence.read_attempt_prepared" &&
              event.entityId === parsed.newAttemptId,
          )
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_RESUME_REPLAY_INCONSISTENT",
            "Recovery evidence Resume Attempt already exists without an active binding.",
          );
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const attemptNumber = this.attempts.nextAttemptNumber(
          task.id,
          request.id,
          request.readToolRunId,
        );
        const preparedEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.read_attempt_prepared",
            entityType: "recovery_evidence_read_attempt",
            entityId: parsed.newAttemptId,
            payload: {
              readAttemptId: parsed.newAttemptId,
              attemptNumber,
              attemptStatus: "prepared",
              fencingToken: parsed.ownership.fencingToken,
              priorAttemptId: priorAttempt.id,
              newAttemptId: parsed.newAttemptId,
              pauseClearEventId: clearEvent.id,
              pauseRequestEventId: clearedPauseEventId,
              resumeCause: "pause",
            },
          },
          now,
          permit,
        );
        const attempt = this.attempts.insertPrepared(
          {
            id: parsed.newAttemptId,
            taskId: task.id,
            readbackRequestId: request.id,
            readToolRunId: request.readToolRunId,
            attemptNumber,
            retrySafety: request.retrySafety,
            consistencyMode: request.consistencyMode,
            preparedAt: now,
            lastEventId: preparedEvent.id,
            createdAt: now,
          },
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_read_attempt_resumed",
          preparedEvent.sequence,
          {
            attemptId: attempt.id,
            attemptNumber,
            priorAttemptId: priorAttempt.id,
            pauseClearEventId: clearEvent.id,
          },
          now,
          permit,
        );
        return {
          state: "created",
          replayed: false,
          request,
          attempt,
          priorAttempt,
          pauseClearEventId: clearEvent.id,
        } as const;
      },
      "immediate",
    );
  }

  createOwnedRecoveryEvidenceVerificationCheck(
    input: CreateOwnedRecoveryEvidenceVerificationCheckInput,
  ): RecoveryEvidenceVerificationCheckCreationResult {
    const parsed =
      CreateRecoveryEvidenceVerificationCheckInputSchema.parse(input);
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const byCheckId = this.checks.getByCheckId(
          task.id,
          parsed.verificationCheckId,
        );
        if (byCheckId !== undefined) {
          this.assertVerificationCheckLogicalIdentity(
            byCheckId,
            task.id,
            parsed,
          );
          this.assertPersistedVerificationRequestKey(byCheckId);
          const verification = this.verifications.getByCheckId(
            task.id,
            byCheckId.verificationCheckId,
          );
          return {
            check: byCheckId,
            replayed: true,
            state:
              verification === undefined ? "pending" : "verification",
            verification: verification ?? null,
          };
        }

        const requestKey =
          computeRecoveryEvidenceVerificationRequestKey({
            taskId: task.id,
            reviewId: parsed.reviewId,
            evidenceSubmissionId: parsed.evidenceSubmissionId,
            originalToolRunId: parsed.originalToolRunId,
            verificationCheckId: parsed.verificationCheckId,
            checkOrigin: parsed.checkOrigin,
            verifierId: parsed.verifierId,
            verifierVersion: parsed.verifierVersion,
            verifierConfigDigest: parsed.verifierConfigDigest,
            allowlistId: parsed.allowlistId,
            allowlistVersion: parsed.allowlistVersion,
            readToolName: parsed.readToolName,
            readToolVersion: parsed.readToolVersion,
            readToolSchemaHash: parsed.readToolSchemaHash,
            expectedPayloadDigest: parsed.expectedPayloadDigest,
          });
        if (requestKey !== parsed.requestKey) {
          throw stateError(
            "RECOVERY_EVIDENCE_VERIFICATION_REQUEST_KEY_MISMATCH",
            "Verification request key does not match its binding.",
          );
        }

        const byRequestKey =
          this.checks.getByRequestKey(parsed.requestKey);
        if (byRequestKey !== undefined) {
          this.assertVerificationCheckLogicalIdentity(
            byRequestKey,
            task.id,
            parsed,
          );
          this.assertPersistedVerificationRequestKey(byRequestKey);
          const verification = this.verifications.getByCheckId(
            task.id,
            byRequestKey.verificationCheckId,
          );
          return {
            check: byRequestKey,
            replayed: true,
            state:
              verification === undefined ? "pending" : "verification",
            verification: verification ?? null,
          };
        }

        this.assertNoRecoveryIntent(task);
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const check = this.checks.insert(
          {
            id: parsed.checkRecordId,
            taskId: task.id,
            reviewId: parsed.reviewId,
            evidenceSubmissionId: parsed.evidenceSubmissionId,
            originalToolRunId: parsed.originalToolRunId,
            readbackRequestId: null,
            evidenceReadId: null,
            verificationCheckId: parsed.verificationCheckId,
            requestKey,
            checkOrigin: parsed.checkOrigin,
            verifierId: parsed.verifierId,
            verifierVersion: parsed.verifierVersion,
            verifierConfigDigest: parsed.verifierConfigDigest,
            allowlistId: parsed.allowlistId,
            allowlistVersion: parsed.allowlistVersion,
            readToolName: parsed.readToolName,
            readToolVersion: parsed.readToolVersion,
            readToolSchemaHash: parsed.readToolSchemaHash,
            expectedPayloadDigest: parsed.expectedPayloadDigest,
            createdAt: now,
          },
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_verification_check_created",
          task.lastEventSequence,
          { verificationCheckId: check.verificationCheckId },
          now,
          permit,
        );
        return {
          check,
          replayed: false,
          state: "created",
          verification: null,
        };
      },
      "immediate",
    );
  }

  createOwnedStoredEvidenceVerificationCheck(
    input: CreateOwnedStoredEvidenceVerificationCheckInput,
    resolveHostBinding: RecoveryEvidenceVerificationHostBindingProvider,
  ): RecoveryEvidenceVerificationCheckCreationResult {
    const parsed =
      CreateOwnedStoredEvidenceVerificationCheckInputSchema.parse(input);
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const byCheckId = this.checks.getByCheckId(
          task.id,
          parsed.verificationCheckId,
        );
        if (byCheckId !== undefined) {
          this.assertStoredEvidenceCheckLogicalIdentity(
            byCheckId,
            task.id,
            parsed,
          );
          this.assertPersistedVerificationRequestKey(byCheckId);
          const verification = this.verifications.getByCheckId(
            task.id,
            byCheckId.verificationCheckId,
          );
          return {
            check: byCheckId,
            replayed: true,
            state:
              verification === undefined ? "pending" : "verification",
            verification: verification ?? null,
          };
        }

        const binding =
          this.resolveRecoveryEvidenceVerificationHostBinding(
            resolveHostBinding,
          );
        const requestKey =
          computeRecoveryEvidenceVerificationRequestKey({
            taskId: task.id,
            reviewId: parsed.reviewId,
            evidenceSubmissionId: parsed.evidenceSubmissionId,
            originalToolRunId: parsed.originalToolRunId,
            verificationCheckId: parsed.verificationCheckId,
            checkOrigin: "stored_evidence_v0",
            verifierId: binding.verifierId,
            verifierVersion: binding.verifierVersion,
            verifierConfigDigest: binding.verifierConfigDigest,
            allowlistId: null,
            allowlistVersion: null,
            readToolName: null,
            readToolVersion: null,
            readToolSchemaHash: null,
            expectedPayloadDigest: parsed.expectedPayloadDigest,
          });
        const byRequestKey =
          this.checks.getByRequestKey(requestKey);
        if (byRequestKey !== undefined) {
          this.assertStoredEvidenceCheckLogicalIdentity(
            byRequestKey,
            task.id,
            parsed,
          );
          this.assertPersistedVerificationRequestKey(byRequestKey);
          const verification = this.verifications.getByCheckId(
            task.id,
            byRequestKey.verificationCheckId,
          );
          return {
            check: byRequestKey,
            replayed: true,
            state:
              verification === undefined ? "pending" : "verification",
            verification: verification ?? null,
          };
        }

        this.assertNoRecoveryIntent(task);
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const check = this.checks.insert(
          {
            id: parsed.checkRecordId,
            taskId: task.id,
            reviewId: parsed.reviewId,
            evidenceSubmissionId: parsed.evidenceSubmissionId,
            originalToolRunId: parsed.originalToolRunId,
            readbackRequestId: null,
            evidenceReadId: null,
            verificationCheckId: parsed.verificationCheckId,
            requestKey,
            checkOrigin: "stored_evidence_v0",
            verifierId: binding.verifierId,
            verifierVersion: binding.verifierVersion,
            verifierConfigDigest: binding.verifierConfigDigest,
            allowlistId: null,
            allowlistVersion: null,
            readToolName: null,
            readToolVersion: null,
            readToolSchemaHash: null,
            expectedPayloadDigest: parsed.expectedPayloadDigest,
            createdAt: now,
          },
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_verification_check_created",
          task.lastEventSequence,
          { verificationCheckId: check.verificationCheckId },
          now,
          permit,
        );
        return {
          check,
          replayed: false,
          state: "created",
          verification: null,
        };
      },
      "immediate",
    );
  }

  completeOwnedRecoveryEvidenceRead(
    input: CompleteOwnedRecoveryEvidenceReadInput,
  ): RecoveryEvidenceReadCompletionResult {
    const parsed = CompleteRecoveryEvidenceReadInputSchema.parse(input);
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const request = this.requests.get(parsed.readbackRequestId);
        if (
          request.taskId !== task.id ||
          request.verificationCheckId === "" ||
          request.readToolRunId === ""
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_REQUEST_TASK_MISMATCH",
            "Recovery evidence request does not belong to the owned task.",
          );
        }
        const existingCheck = this.checks.getByRequestKey(
          parsed.verificationRequestKey,
        );
        if (existingCheck !== undefined) {
          const existingRead =
            existingCheck.evidenceReadId === null
              ? this.reads.getByVerificationCheckId(
                  task.id,
                  existingCheck.verificationCheckId,
                )
              : this.reads.get(existingCheck.evidenceReadId);
          if (
            existingRead === undefined ||
            existingCheck.readbackRequestId !== request.id ||
            existingCheck.checkOrigin !== "readback_transaction_b" ||
            existingCheck.verificationCheckId !==
              request.verificationCheckId ||
            existingCheck.expectedPayloadDigest !==
              parsed.resultPayloadDigest ||
            existingRead.readAttemptId === null ||
            existingRead.observedAt !== parsed.observedAt ||
            existingRead.resourceVersion !== parsed.resourceVersion ||
            existingRead.resourceEtag !== parsed.resourceEtag ||
            existingRead.resultPayloadDigest !==
              parsed.resultPayloadDigest ||
            existingRead.resultPayloadStoreRef !==
              parsed.resultPayloadStoreRef
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_READ_COMPLETION_CONFLICT",
              "Recovery evidence read completion replay does not match.",
            );
          }
          return {
            request,
            attempt: this.attempts.get(existingRead.readAttemptId),
            check: existingCheck,
            read: existingRead,
            replayed: true,
          };
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const readRun = this.toolRuns.get(request.readToolRunId);
        const readStep = this.planSteps.get(readRun.planStepId);
        if (
          readRun.taskId !== task.id ||
          readRun.status !== "running" ||
          readRun.version !== parsed.expectedReadToolRunVersion ||
          readStep.taskId !== task.id ||
          readStep.version !== parsed.expectedPlanStepVersion
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_RESULT_BINDING_INVALID",
            "Recovery evidence read result binding is invalid.",
          );
        }
        const succeededRun = this.toolRuns.transition(
          readRun.id,
          ["running"],
          {
            expectedVersion: parsed.expectedReadToolRunVersion,
            status: "succeeded",
            finishedAt: now,
            updatedAt: now,
            output: parsed.toolOutput,
          },
          permit,
        );
        const toolMessage = new MessageRepository(
          this.database,
          this.sequences,
        ).append(
          {
            taskId: task.id,
            role: "tool",
            toolCallId: succeededRun.toolCallId,
            content:
              parsed.toolMessageContent ??
              JSON.stringify({
                status: "succeeded",
                output: parsed.toolOutput,
              }),
          },
          now,
          permit,
        );
        this.planSteps.updateStatusCas(
          readStep.id,
          readStep.status,
          parsed.expectedPlanStepVersion,
          "completed",
          now,
          permit,
        );
        const attempt = this.applyAttemptTransition(
          task,
          parsed.attemptId,
          parsed.expectedAttemptVersion,
          {
            status: "completed",
            observedAt: parsed.observedAt,
            resourceVersion: parsed.resourceVersion,
            resourceEtag: parsed.resourceEtag,
            resultDigest: parsed.resultPayloadDigest,
            resultPayloadStoreRef: parsed.resultPayloadStoreRef,
            reasonCode: null,
          },
          now,
          parsed.ownership.fencingToken,
          permit,
        );
        const toolEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "tool.succeeded",
            entityType: "tool_run",
            entityId: succeededRun.id,
            payload: {
              callId: succeededRun.toolCallId,
              messageSequence: toolMessage.sequence,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const submission = this.submissions.get(
          request.evidenceSubmissionId,
        );
        const check = this.checks.insert(
          {
            id: parsed.checkRecordId,
            taskId: task.id,
            reviewId: request.reviewId,
            evidenceSubmissionId: request.evidenceSubmissionId,
            originalToolRunId: request.originalToolRunId,
            readbackRequestId: request.id,
            evidenceReadId: null,
            verificationCheckId: request.verificationCheckId,
            requestKey: parsed.verificationRequestKey,
            checkOrigin: "readback_transaction_b",
            verifierId: request.verifierId,
            verifierVersion: request.verifierVersion,
            verifierConfigDigest: request.verifierConfigDigest,
            allowlistId: request.allowlistId,
            allowlistVersion: request.allowlistVersion,
            readToolName: request.readToolName,
            readToolVersion: request.readToolVersion,
            readToolSchemaHash: request.readToolSchemaHash,
            expectedPayloadDigest: parsed.resultPayloadDigest,
            createdAt: now,
          },
          permit,
        );
        const read = this.reads.insertControlled(
          {
            id: parsed.evidenceReadId,
            taskId: task.id,
            reviewId: request.reviewId,
            toolRunId: request.readToolRunId,
            evidenceEnvelopeDigest: submission.envelopeDigest,
            evidenceSubmissionId: request.evidenceSubmissionId,
            readbackRequestId: request.id,
            readAttemptId: attempt.id,
            verificationCheckId: request.verificationCheckId,
            observedAt: parsed.observedAt,
            resourceVersion: parsed.resourceVersion,
            resourceEtag: parsed.resourceEtag,
            resultPayloadDigest: parsed.resultPayloadDigest,
            resultPayloadStoreRef: parsed.resultPayloadStoreRef,
            resultPayloadStorageMode: "content_addressed_file",
            createdAt: now,
          },
          permit,
          createRecoveryEvidenceControlledReadCapability(),
        );
        const readEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.read_completed",
            entityType: "recovery_evidence_read",
            entityId: read.id,
            payload: {
              readbackRequestId: request.id,
              verificationCheckId: check.verificationCheckId,
              readAttemptId: attempt.id,
              toolEventSequence: toolEvent.sequence,
              resultPayloadDigest: parsed.resultPayloadDigest,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_evidence_read_completed",
          readEvent.sequence,
          {
            evidenceReadId: read.id,
            readbackRequestId: request.id,
            verificationCheckId: check.verificationCheckId,
          },
          now,
          permit,
        );
        return { request, attempt, check, read, replayed: false };
      },
      "immediate",
    );
  }

  recordOwnedRecoveryEvidenceVerification(
    input: RecordOwnedRecoveryEvidenceVerificationInput,
  ): RecoveryEvidenceVerificationCreationResult {
    const parsed =
      RecordRecoveryEvidenceVerificationInputSchema.parse(input);
    if (parsed.authenticityStatus === "manual_attested") {
      throw stateError(
        "RECOVERY_MANUAL_ATTESTATION_ISSUER_REQUIRED",
        "Manual attestation requires an authenticated Host issuance path.",
      );
    }
    const now = new Date().toISOString();
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();
        const existing =
          this.verifications.getByRequestKey(parsed.requestKey);
        if (existing !== undefined) {
          if (
            existing.taskId !== task.id ||
            existing.verificationCheckId !==
              parsed.verificationCheckId ||
            existing.requestKey !== parsed.requestKey ||
            existing.readbackResultProvenance !==
              parsed.readbackResultProvenance ||
            existing.availabilityStatus !==
              parsed.availabilityStatus ||
            existing.integrityStatus !== parsed.integrityStatus ||
            existing.authenticityStatus !==
              parsed.authenticityStatus ||
            existing.verificationStatus !==
              parsed.verificationStatus ||
            existing.observedPayloadDigest !==
              parsed.observedPayloadDigest ||
            existing.reasonCode !== parsed.reasonCode ||
            existing.redactedSummary !== parsed.redactedSummary
          ) {
            throw stateError(
              "RECOVERY_EVIDENCE_VERIFICATION_CONFLICT",
              "Verification request key was already used.",
            );
          }
          return { verification: existing, replayed: true };
        }
        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const check = this.checks.getByCheckId(
          task.id,
          parsed.verificationCheckId,
        );
        if (check === undefined || check.requestKey !== parsed.requestKey) {
          throw stateError(
            "RECOVERY_EVIDENCE_VERIFICATION_CHECK_MISMATCH",
            "Verification check binding is invalid.",
          );
        }
        if (
          check.checkOrigin === "readback_transaction_b" &&
          parsed.readbackResultProvenance !== "controlled_runtime_read"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_VERIFICATION_PROVENANCE_INVALID",
            "Transaction B verification requires controlled runtime provenance.",
          );
        }
        const evidenceRead =
          check.evidenceReadId === null
            ? this.reads.getByVerificationCheckId(
                task.id,
                check.verificationCheckId,
              )
            : this.reads.get(check.evidenceReadId);
        const attempt =
          evidenceRead?.readAttemptId === null ||
          evidenceRead?.readAttemptId === undefined
            ? null
            : this.attempts.get(evidenceRead.readAttemptId);

        const availabilityEvent = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "recovery.evidence.availability_checked",
            entityType: "recovery_verification",
            entityId: parsed.verificationId,
            payload: {
              verificationId: parsed.verificationId,
              verificationCheckId: check.verificationCheckId,
              evidenceSubmissionId: check.evidenceSubmissionId,
              evidenceReadId: evidenceRead?.id ?? null,
              availabilityStatus: parsed.availabilityStatus,
              integrityStatus: parsed.integrityStatus,
              requestKey: parsed.requestKey,
              fencingToken: parsed.ownership.fencingToken,
            },
          },
          now,
          permit,
        );
        const verificationEvent =
          parsed.verificationStatus === "not_run"
            ? null
            : this.events.append(
                {
                  taskId: task.id,
                  traceId: task.traceId,
                  type: "recovery.evidence.verification_completed",
                  entityType: "recovery_verification",
                  entityId: parsed.verificationId,
                  payload: {
                    verificationId: parsed.verificationId,
                    verificationCheckId: check.verificationCheckId,
                    evidenceSubmissionId: check.evidenceSubmissionId,
                    evidenceReadId: evidenceRead?.id ?? null,
                    verifierId: check.verifierId,
                    verifierVersion: check.verifierVersion,
                    verifierConfigDigest: check.verifierConfigDigest,
                    allowlistId: check.allowlistId,
                    allowlistVersion: check.allowlistVersion,
                    verificationStatus: parsed.verificationStatus,
                    reasonCode: parsed.reasonCode,
                    redactedSummary: parsed.redactedSummary,
                    requestKey: parsed.requestKey,
                    fencingToken: parsed.ownership.fencingToken,
                  },
                },
                now,
                permit,
              );
        const verification = this.verifications.insert(
          {
            id: parsed.verificationId,
            taskId: task.id,
            reviewId: check.reviewId,
            evidenceSubmissionId: check.evidenceSubmissionId,
            originalToolRunId: check.originalToolRunId,
            readbackRequestId: check.readbackRequestId,
            evidenceReadId: evidenceRead?.id ?? null,
            readAttemptId: attempt?.id ?? null,
            verificationCheckId: check.verificationCheckId,
            readbackResultProvenance:
              parsed.readbackResultProvenance,
            verifierId: check.verifierId,
            verifierVersion: check.verifierVersion,
            verifierConfigDigest: check.verifierConfigDigest,
            allowlistId: check.allowlistId,
            allowlistVersion: check.allowlistVersion,
            requestKey: parsed.requestKey,
            availabilityStatus: parsed.availabilityStatus,
            integrityStatus: parsed.integrityStatus,
            authenticityStatus: parsed.authenticityStatus,
            verificationStatus: parsed.verificationStatus,
            expectedPayloadDigest: check.expectedPayloadDigest,
            observedPayloadDigest: parsed.observedPayloadDigest,
            reasonCode: parsed.reasonCode,
            redactedSummary: parsed.redactedSummary,
            availabilityEventId: availabilityEvent.id,
            verificationEventId: verificationEvent?.id ?? null,
            createdAt: now,
          },
          permit,
        );
        this.appendRecoveryEvidenceCheckpoint(
          task,
          "recovery_evidence_verification_recorded",
          verificationEvent?.sequence ?? availabilityEvent.sequence,
          {
            verificationId: verification.id,
            verificationCheckId: verification.verificationCheckId,
            verificationStatus: verification.verificationStatus,
          },
          now,
          permit,
        );
        return { verification, replayed: false };
      },
      "immediate",
    );
  }

  private applyAttemptTransition(
    task: TaskRecord,
    attemptId: string,
    expectedAttemptVersion: number,
    transition: {
      readonly status: z.output<
        typeof RecoveryEvidenceReadAttemptStatusSchema
      >;
      readonly observedAt?: string | null;
      readonly resourceVersion?: string | null;
      readonly resourceEtag?: string | null;
      readonly resultDigest?: string | null;
      readonly resultPayloadStoreRef?: string | null;
      readonly reasonCode?: string | null;
    },
    now: string,
    fencingToken: number,
    permit: ReturnType<typeof createStorageWritePermit>,
  ): RecoveryEvidenceReadAttemptRecord {
    const current = this.attempts.get(attemptId);
    if (current.taskId !== task.id) {
      throw stateError(
        "RECOVERY_EVIDENCE_ATTEMPT_TASK_MISMATCH",
        "Recovery evidence attempt does not belong to the owned task.",
      );
    }
    if (current.status === "completed" && transition.status === "completed") {
      return current;
    }
    const eventType = attemptEventType(transition.status);
    if (eventType === undefined) {
      throw stateError(
        "RECOVERY_EVIDENCE_ATTEMPT_TRANSITION_INVALID",
        "Recovery evidence attempt transition is invalid.",
      );
    }
    const event = this.events.append(
      {
        taskId: task.id,
        traceId: task.traceId,
        type: eventType,
        entityType: "recovery_evidence_read_attempt",
        entityId: current.id,
        payload: {
          readAttemptId: current.id,
          attemptNumber: current.attemptNumber,
          attemptStatus: transition.status,
          fencingToken,
          reasonCode: transition.reasonCode ?? null,
        },
      },
      now,
      permit,
    );
    return this.attempts.transition(
      current.id,
      {
        expectedVersion: expectedAttemptVersion,
        status: transition.status,
        dispatchingAt:
          transition.status === "dispatching" ? now : undefined,
        interruptedAt:
          transition.status === "interrupted" ? now : undefined,
        completedAt:
          ["completed", "failed", "timed_out", "cancelled", "blocked_by_intent"].includes(
            transition.status,
          )
            ? now
            : undefined,
        observedAt: transition.observedAt,
        resourceVersion: transition.resourceVersion,
        resourceEtag: transition.resourceEtag,
        resultDigest: transition.resultDigest,
        resultPayloadStoreRef: transition.resultPayloadStoreRef,
        reasonCode: transition.reasonCode,
        lastEventId: event.id,
        updatedAt: now,
      },
      permit,
    );
  }

  private assertOwnedRecoveryTask(ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  }): TaskRecord {
    if (this.leaseManager === undefined) {
      throw stateError(
        "TASK_LEASE_REQUIRED",
        "Recovery evidence writes require an owned task lease.",
      );
    }
    this.leaseManager.assertOwned(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
    const task = this.tasks.get(ownership.taskId);
    if (task.status !== "waiting_review") {
      throw stateError(
        "RECOVERY_EVIDENCE_TASK_STATE_INVALID",
        "Recovery evidence writes require a waiting_review task.",
      );
    }
    return task;
  }

  private getWaitingReviewTask(taskId: string): TaskRecord {
    const task = this.tasks.get(taskId);
    if (task.status !== "waiting_review") {
      throw stateError(
        "RECOVERY_EVIDENCE_TASK_STATE_INVALID",
        "Recovery evidence intent writes require a waiting_review task.",
      );
    }
    return task;
  }

  private assertRecoveryEvidenceReadBinding(
    task: TaskRecord,
    request: RecoveryEvidenceReadbackRequestRecord,
    attempt: RecoveryEvidenceReadAttemptRecord,
    run: ToolRunRecord,
    step: PlanStepRecord,
    plan: ExecutionPlanRecord,
  ): void {
    if (
      request.taskId !== task.id ||
      attempt.taskId !== task.id ||
      attempt.readbackRequestId !== request.id ||
      attempt.readToolRunId !== request.readToolRunId ||
      run.taskId !== task.id ||
      run.id !== request.readToolRunId ||
      step.taskId !== task.id ||
      step.id !== request.planStepId ||
      step.planId !== plan.id ||
      step.kind !== "read_batch" ||
      plan.taskId !== task.id ||
      plan.id !== request.executionPlanId ||
      plan.purpose !== "recovery_evidence" ||
      run.planStepId !== step.id ||
      run.mode !== "read"
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_READ_BINDING_INVALID",
        "Recovery evidence read binding is invalid.",
      );
    }
  }

  private findIntentCheckpoint(
    taskId: string,
    reason: string,
    intentEventId: string,
  ): CheckpointRecord | undefined {
    return this.checkpoints
      .listByTask(taskId)
      .find(
        (checkpoint) =>
          checkpoint.reason === reason &&
          checkpoint.metadata.intentEventId === intentEventId,
      );
  }

  private findAttemptOutcomeEvent(
    taskId: string,
    attemptId: string,
    status: RecoveryEvidenceReadAttemptStatus,
    reasonCode: string,
    intentEventId?: string,
  ): EventRecord | undefined {
    return this.events
      .listByTask(taskId)
      .find(
        (event) =>
          event.type === attemptEventType(status) &&
          event.entityId === attemptId &&
          event.payload.readAttemptId === attemptId &&
          event.payload.attemptStatus === status &&
          event.payload.reasonCode === reasonCode &&
          (intentEventId === undefined
            ? event.payload.intentEventId === undefined ||
              event.payload.intentEventId === null
            : event.payload.intentEventId === intentEventId),
      );
  }

  private findRequestCancelEvent(
    taskId: string,
    requestId: string,
    cancelIntentEventId: string,
  ): EventRecord | undefined {
    return this.events
      .listByTask(taskId)
      .find(
        (event) =>
          event.type === "recovery.evidence.readback_cancelled" &&
          event.entityId === requestId &&
          event.payload.readbackRequestId === requestId &&
          event.payload.cancelIntentEventId === cancelIntentEventId,
      );
  }

  private getLatestPauseRequestedEvent(
    taskId: string,
  ): EventRecord | undefined {
    return [...this.events.listByTask(taskId)]
      .reverse()
      .find(
        (event) =>
          event.type === "recovery.evidence.pause_requested",
      );
  }

  private getLatestCancelRequestedEvent(
    taskId: string,
  ): EventRecord | undefined {
    return [...this.events.listByTask(taskId)]
      .reverse()
      .find(
        (event) =>
          event.type === "recovery.evidence.cancel_requested",
      );
  }

  private isRecoveryEvidenceReadbackCompleted(
    request: RecoveryEvidenceReadbackRequestRecord,
  ): boolean {
    const check = this.checks.getByCheckId(
      request.taskId,
      request.verificationCheckId,
    );
    if (
      check === undefined ||
      check.checkOrigin !== "readback_transaction_b" ||
      check.readbackRequestId !== request.id
    ) {
      return false;
    }
    const read =
      check.evidenceReadId === null
        ? this.reads.getByVerificationCheckId(
            request.taskId,
            request.verificationCheckId,
          )
        : this.reads.get(check.evidenceReadId);
    return (
      read !== undefined &&
      read.readbackRequestId === request.id &&
      read.verificationCheckId === request.verificationCheckId
    );
  }

  private assertVerificationCheckLogicalIdentity(
    check: RecoveryEvidenceVerificationCheckRecord,
    taskId: string,
    input: z.output<
      typeof CreateRecoveryEvidenceVerificationCheckInputSchema
    >,
  ): void {
    if (
      check.taskId !== taskId ||
      check.reviewId !== input.reviewId ||
      check.evidenceSubmissionId !== input.evidenceSubmissionId ||
      check.originalToolRunId !== input.originalToolRunId ||
      check.verificationCheckId !== input.verificationCheckId ||
      check.checkOrigin !== input.checkOrigin ||
      check.expectedPayloadDigest !== input.expectedPayloadDigest
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_VERIFICATION_CHECK_ID_CONFLICT",
        "Verification Check ID is already bound to different logical identity.",
      );
    }
  }

  private assertStoredEvidenceCheckLogicalIdentity(
    check: RecoveryEvidenceVerificationCheckRecord,
    taskId: string,
    input: z.output<
      typeof CreateOwnedStoredEvidenceVerificationCheckInputSchema
    >,
  ): void {
    if (
      check.taskId !== taskId ||
      check.reviewId !== input.reviewId ||
      check.evidenceSubmissionId !== input.evidenceSubmissionId ||
      check.originalToolRunId !== input.originalToolRunId ||
      check.verificationCheckId !== input.verificationCheckId ||
      check.checkOrigin !== "stored_evidence_v0" ||
      check.expectedPayloadDigest !== input.expectedPayloadDigest
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_VERIFICATION_CHECK_ID_CONFLICT",
        "Verification Check ID is already bound to different logical identity.",
      );
    }
  }

  private resolveRecoveryEvidenceVerificationHostBinding(
    resolveHostBinding: RecoveryEvidenceVerificationHostBindingProvider,
  ): RecoveryEvidenceVerificationHostBinding {
    try {
      const binding = resolveHostBinding();
      assertSynchronousResult(binding);
      return RecoveryEvidenceVerificationHostBindingSchema.parse(
        binding,
      );
    } catch (error) {
      if (
        error instanceof AppError &&
        error.code === "RECOVERY_VERIFIER_BINDING_NOT_FOUND"
      ) {
        throw error;
      }
      throw stateError(
        "RECOVERY_EVIDENCE_VERIFICATION_HOST_BINDING_UNAVAILABLE",
        "Recovery evidence verification host binding is unavailable.",
      );
    }
  }

  private assertPersistedVerificationRequestKey(
    check: RecoveryEvidenceVerificationCheckRecord,
  ): void {
    const recomputed =
      computeRecoveryEvidenceVerificationRequestKey({
        taskId: check.taskId,
        reviewId: check.reviewId,
        evidenceSubmissionId: check.evidenceSubmissionId,
        originalToolRunId: check.originalToolRunId,
        verificationCheckId: check.verificationCheckId,
        checkOrigin: check.checkOrigin,
        verifierId: check.verifierId,
        verifierVersion: check.verifierVersion,
        verifierConfigDigest: check.verifierConfigDigest,
        allowlistId: check.allowlistId,
        allowlistVersion: check.allowlistVersion,
        readToolName: check.readToolName,
        readToolVersion: check.readToolVersion,
        readToolSchemaHash: check.readToolSchemaHash,
        expectedPayloadDigest: check.expectedPayloadDigest,
      });
    if (recomputed !== check.requestKey) {
      throw stateError(
        "RECOVERY_EVIDENCE_VERIFICATION_CHECK_BINDING_CORRUPT",
        "Persisted Verification Check request key does not match its binding.",
      );
    }
  }

  private assertNoRecoveryIntent(task: TaskRecord): void {
    if (
      task.cancelRequestedAt !== null ||
      task.pauseRequestedAt !== null
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_INTENT_BLOCKED",
        "Cancel or pause intent blocks a new verification write.",
      );
    }
  }

  private assertTaskVersion(task: TaskRecord, expected: number): void {
    if (task.version !== expected) {
      throw stateError(
        "TASK_STATE_CONFLICT",
        "Task changed before the recovery evidence write.",
      );
    }
  }

  private hasPreparedAttemptEvent(
    taskId: string,
    attemptId: string,
    attemptNumber: number,
    expectedLastEventId: string | null,
  ): boolean {
    const events = this.events
      .listByTask(taskId)
      .filter(
        (candidate) =>
          candidate.type ===
            "recovery.evidence.read_attempt_prepared" &&
          candidate.entityType ===
            "recovery_evidence_read_attempt" &&
          candidate.entityId === attemptId &&
          candidate.payload.readAttemptId === attemptId &&
          candidate.payload.attemptNumber === attemptNumber &&
          candidate.payload.attemptStatus === "prepared",
      );
    if (events.length !== 1) {
      return false;
    }
    const event = events[0]!;
    return (
      expectedLastEventId === null ||
      event.id === expectedLastEventId
    );
  }

  private hasValidRetryDispatchLineage(input: {
    readonly taskId: string;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly currentFencingToken: number;
  }): boolean {
    const events = this.events.listByTask(input.taskId);
    const preparedEvent = events.find(
      (event) =>
        event.type === "recovery.evidence.read_attempt_prepared" &&
        event.entityId === input.attempt.id &&
        event.payload.readAttemptId === input.attempt.id &&
        event.payload.attemptNumber === input.attempt.attemptNumber,
    );
    if (preparedEvent === undefined) {
      return false;
    }
    if (
      preparedEvent.entityType !==
        "recovery_evidence_read_attempt" ||
      preparedEvent.entityId !== input.attempt.id ||
      preparedEvent.payload.readAttemptId !== input.attempt.id ||
      preparedEvent.payload.attemptNumber !== input.attempt.attemptNumber ||
      preparedEvent.payload.attemptStatus !== "prepared" ||
      (input.attempt.status === "prepared" &&
        input.attempt.lastEventId !== preparedEvent.id)
    ) {
      return false;
    }
    const parsedPauseLineage =
      PauseResumeDispatchLineageSchema.safeParse({
        priorAttemptId: preparedEvent.payload.priorAttemptId,
        newAttemptId: preparedEvent.payload.newAttemptId,
        pauseClearEventId: preparedEvent.payload.pauseClearEventId,
        pauseRequestEventId: preparedEvent.payload.pauseRequestEventId,
      });
    if (
      parsedPauseLineage.success &&
      parsedPauseLineage.data.newAttemptId === input.attempt.id
    ) {
      const priorPausedAttempt = this.attempts
        .listByTask(input.taskId)
        .find(
          (attempt) =>
            attempt.id === parsedPauseLineage.data.priorAttemptId,
        );
      if (
        priorPausedAttempt?.status === "blocked_by_intent" &&
        this.hasValidPauseResumeDispatchLineage({
          taskId: input.taskId,
          request: input.request,
          attempt: input.attempt,
          priorAttempt: priorPausedAttempt,
          preparedEvent,
          lineage: parsedPauseLineage.data,
          currentFencingToken: input.currentFencingToken,
        })
      ) {
        return true;
      }
    }
    const parsedLineage = RetryDispatchLineageSchema.safeParse({
      recoveryOperationId: preparedEvent.payload.recoveryOperationId,
      priorAttemptId: preparedEvent.payload.priorAttemptId,
      interruptionEventId: preparedEvent.payload.interruptionEventId,
      newAttemptId: preparedEvent.payload.newAttemptId,
      pauseClearEventId: preparedEvent.payload.pauseClearEventId,
    });
    if (!parsedLineage.success) {
      return false;
    }
    const lineage = parsedLineage.data;
    if (lineage.newAttemptId !== input.attempt.id) {
      return false;
    }
    const matchingPreparedEvents = events.filter(
      (event) =>
        event.type === "recovery.evidence.read_attempt_prepared" &&
        event.payload.recoveryOperationId ===
          lineage.recoveryOperationId,
    );
    if (
      matchingPreparedEvents.length !== 1 ||
      matchingPreparedEvents[0]?.id !== preparedEvent.id
    ) {
      return false;
    }

    const priorAttempt = this.attempts
      .listByTask(input.taskId)
      .find((attempt) => attempt.id === lineage.priorAttemptId);
    if (
      priorAttempt === undefined ||
      priorAttempt.id === input.attempt.id ||
      priorAttempt.readbackRequestId !== input.request.id ||
      priorAttempt.readToolRunId !== input.request.readToolRunId ||
      priorAttempt.status !== "interrupted" ||
      priorAttempt.attemptNumber + 1 !== input.attempt.attemptNumber
    ) {
      return false;
    }

    const interruptionEvent = events.find(
      (event) => event.id === lineage.interruptionEventId,
    );
    if (
      interruptionEvent === undefined ||
      interruptionEvent.type !==
        "recovery.evidence.read_attempt_interrupted" ||
      interruptionEvent.entityType !==
        "recovery_evidence_read_attempt" ||
      interruptionEvent.entityId !== priorAttempt.id ||
      interruptionEvent.payload.readAttemptId !== priorAttempt.id ||
      interruptionEvent.payload.recoveryOperationId !==
        lineage.recoveryOperationId ||
      interruptionEvent.payload.priorAttemptId !== priorAttempt.id ||
      interruptionEvent.payload.resumeEligible !== true ||
      interruptionEvent.sequence >= preparedEvent.sequence
    ) {
      return false;
    }

    const priorDispatchEvent = events.find(
      (event) =>
        event.type === "recovery.evidence.read_attempt_dispatching" &&
        event.entityId === priorAttempt.id &&
        event.payload.readAttemptId === priorAttempt.id &&
        event.payload.attemptStatus === "dispatching",
    );
    const priorDispatchFencingToken =
      priorDispatchEvent?.payload.fencingToken;
    const preparedFencingToken = preparedEvent.payload.fencingToken;
    if (
      priorDispatchEvent === undefined ||
      typeof priorDispatchFencingToken !== "number" ||
      !Number.isInteger(priorDispatchFencingToken) ||
      priorDispatchFencingToken <= 0 ||
      typeof preparedFencingToken !== "number" ||
      preparedFencingToken !== input.currentFencingToken ||
      input.currentFencingToken <= priorDispatchFencingToken
    ) {
      return false;
    }

    const pauseSourceEventId = interruptionEvent.payload.pauseRequestEventId;
    if (
      pauseSourceEventId !== undefined &&
      pauseSourceEventId !== null &&
      typeof pauseSourceEventId !== "string"
    ) {
      return false;
    }
    const hasPauseSource = typeof pauseSourceEventId === "string";
    if (
      hasPauseSource &&
      lineage.pauseClearEventId === null
    ) {
      return false;
    }
    if (!hasPauseSource && lineage.pauseClearEventId !== null) {
      return false;
    }
    if (lineage.pauseClearEventId !== null) {
      const pauseClearEvent = events.find(
        (event) => event.id === lineage.pauseClearEventId,
      );
      if (
        pauseClearEvent === undefined ||
        pauseClearEvent.type !== "recovery.evidence.pause_cleared" ||
        pauseClearEvent.sequence >= preparedEvent.sequence
      ) {
        return false;
      }
    }
    return true;
  }

  private hasValidPauseResumeDispatchLineage(input: {
    readonly taskId: string;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly preparedEvent: EventRecord;
    readonly lineage: z.output<typeof PauseResumeDispatchLineageSchema>;
    readonly currentFencingToken: number;
  }): boolean {
    if (
      input.priorAttempt.id === input.attempt.id ||
      input.priorAttempt.readbackRequestId !== input.request.id ||
      input.priorAttempt.readToolRunId !==
        input.request.readToolRunId ||
      input.priorAttempt.attemptNumber + 1 !==
        input.attempt.attemptNumber
    ) {
      return false;
    }
    const events = this.events.listByTask(input.taskId);
    const clearEvent = events.find(
      (event) => event.id === input.lineage.pauseClearEventId,
    );
    const latestPauseEvent = [...events]
      .reverse()
      .find(
        (event) =>
          event.type === "recovery.evidence.pause_requested",
      );
    if (
      clearEvent === undefined ||
      clearEvent.type !== "recovery.evidence.pause_cleared" ||
      clearEvent.payload.clearedPauseEventId !==
        input.lineage.pauseRequestEventId ||
      clearEvent.sequence >= input.preparedEvent.sequence ||
      (latestPauseEvent !== undefined &&
        latestPauseEvent.sequence > clearEvent.sequence)
    ) {
      return false;
    }
    const blockEvent = events.find(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_blocked_by_intent" &&
        event.entityId === input.priorAttempt.id &&
        event.payload.readAttemptId === input.priorAttempt.id &&
        event.payload.attemptStatus === "blocked_by_intent" &&
        event.payload.intentEventId ===
          input.lineage.pauseRequestEventId,
    );
    if (
      blockEvent === undefined ||
      blockEvent.sequence >= clearEvent.sequence ||
      input.preparedEvent.payload.fencingToken !==
        input.currentFencingToken
    ) {
      return false;
    }
    return (
      input.preparedEvent.payload.priorAttemptId ===
        input.priorAttempt.id &&
      input.preparedEvent.payload.newAttemptId === input.attempt.id &&
      input.preparedEvent.payload.pauseClearEventId === clearEvent.id &&
      input.preparedEvent.payload.pauseRequestEventId ===
        input.lineage.pauseRequestEventId &&
      input.preparedEvent.payload.resumeCause === "pause"
    );
  }

  private appendRecoveryEvidenceCheckpoint(
    task: TaskRecord,
    reason: string,
    lastEventSequence: number,
    metadata: Record<string, unknown>,
    now: string,
    permit: ReturnType<typeof createStorageWritePermit>,
  ): ReturnType<CheckpointStore["append"]> {
    const snapshot = this.snapshotReader.load(task.id);
    const latestPlan = this.plans.listAgentByTask(task.id).at(-1);
    return this.checkpoints.append(
      {
        taskId: task.id,
        reason,
        taskStatus: task.status,
        lastMessageSequence: snapshot.messages.at(-1)?.sequence ?? 0,
        modelIteration: task.currentIteration,
        planVersion: latestPlan?.version ?? null,
        lastEventSequence,
        budget: {
          maxModelTurns: task.maxModelTurns,
          maxToolCalls: task.maxToolCalls,
        },
        metadata,
      },
      now,
      permit,
    );
  }
}

function intentResult(
  state: "created" | "replayed",
  task: TaskRecord,
  event: EventRecord,
  checkpoint: CheckpointRecord,
): RecoveryEvidenceTaskWideIntentResult {
  return {
    state,
    replayed: state === "replayed",
    taskId: task.id,
    taskVersion: task.version,
    eventId: event.id,
    eventSequence: event.sequence,
    checkpointSequence: checkpoint.sequence,
  };
}

function failureResult(
  state: "created" | "replayed",
  input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly run: ToolRunRecord;
    readonly step: PlanStepRecord;
    readonly plan: ExecutionPlanRecord;
    readonly reasonCode: string;
  },
): RecoveryEvidenceReadFailureResult {
  return {
    state: input.attempt.status as "failed" | "timed_out",
    replayed: state === "replayed",
    taskId: input.task.id,
    requestId: input.request.id,
    attemptId: input.attempt.id,
    readToolRunId: input.run.id,
    planId: input.plan.id,
    planStepId: input.step.id,
    attemptStatus: input.attempt.status,
    toolRunStatus: input.run.status,
    planStepStatus: input.step.status,
    planStatus: input.plan.status,
    reasonCode: input.reasonCode,
  };
}

function cancelResult(
  state: "cancelled" | "completed",
  replayed: boolean,
  input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly run: ToolRunRecord;
    readonly step: PlanStepRecord;
    readonly plan: ExecutionPlanRecord;
    readonly cancelIntentEventId: string;
  },
): RecoveryEvidenceReadCancelResult {
  const persisted = {
    taskId: input.task.id,
    requestId: input.request.id,
    attemptId: input.attempt.id,
    readToolRunId: input.run.id,
    planId: input.plan.id,
    planStepId: input.step.id,
    attemptStatus: input.attempt.status,
    toolRunStatus: input.run.status,
    planStepStatus: input.step.status,
    planStatus: input.plan.status,
  };
  return state === "completed"
    ? { ...persisted, state: "completed", replayed: true }
    : {
        ...persisted,
        state: "cancelled",
        replayed,
        cancelIntentEventId: input.cancelIntentEventId,
      };
}

function pauseObservedResult(
  state: "created" | "replayed",
  requestId: string,
  attemptId: string,
  event: EventRecord,
  checkpoint: CheckpointRecord,
  externalCallStarted: boolean | "unknown",
): RecoveryEvidencePauseObservedResult {
  return {
    state,
    replayed: state === "replayed",
    taskId: event.taskId,
    requestId,
    attemptId,
    pauseRequestEventId:
      typeof event.payload.pauseRequestEventId === "string"
        ? event.payload.pauseRequestEventId
        : "",
    eventId: event.id,
    eventSequence: event.sequence,
    checkpointSequence: checkpoint.sequence,
    externalCallStarted,
  };
}

function attemptEventType(
  status: RecoveryEvidenceReadAttemptStatus,
): string {
  const eventTypeByStatus: Record<string, string> = {
    dispatching: "recovery.evidence.read_attempt_dispatching",
    interrupted: "recovery.evidence.read_attempt_interrupted",
    completed: "recovery.evidence.read_attempt_completed",
    failed: "recovery.evidence.read_attempt_failed",
    timed_out: "recovery.evidence.read_attempt_timed_out",
    cancelled: "recovery.evidence.read_attempt_cancelled",
    blocked_by_intent:
      "recovery.evidence.read_attempt_blocked_by_intent",
  };
  return eventTypeByStatus[status] ?? "__invalid__";
}

function dispatchResult(
  state: "created" | "replayed-existing-dispatching",
  input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly readRun: ToolRunRecord;
    readonly plan: ExecutionPlanRecord;
    readonly planStep: PlanStepRecord;
  },
): RecoveryEvidenceDispatchResult {
  const result = {
    taskId: input.task.id,
    requestId: input.request.id,
    attemptId: input.attempt.id,
    readToolRunId: input.readRun.id,
    planId: input.plan.id,
    planStepId: input.planStep.id,
    attemptStatus: input.attempt.status,
    toolRunStatus: input.readRun.status,
    planStepStatus: input.planStep.status,
    planStatus: input.plan.status,
  };
  return state === "created"
    ? {
        ...result,
        state: "created",
        replayed: false,
      }
    : {
        ...result,
        state: "replayed-existing-dispatching",
        replayed: true,
      };
}

function dispatchStateError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    statusCode: 409,
    details: [],
  });
}

function stateError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    statusCode: 409,
    details: [],
  });
}
