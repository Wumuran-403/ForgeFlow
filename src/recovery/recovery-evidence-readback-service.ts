import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  computeCanonicalInputHash,
  computeIdempotencyKey,
} from "../tools/fingerprint.js";
import {
  ExecutionPlanRepository,
  JsonValueSchema,
  PlanStepRepository,
  RecoveryEvidenceReadbackReservationStatusSchema,
  RecoveryEvidenceReadbackReservationUnitOfWork,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
  type RecoveryEvidenceReadbackRequestRecord,
  type RecoveryEvidenceReadbackReservationAcquireResult,
  type RecoveryEvidenceReadbackReservationView,
  type RecoveryEvidenceSubmissionRecord,
  type RecoveryReviewRecord,
  type TaskRecord,
  type TaskSnapshot,
  type ToolRunRecord,
} from "../storage/index.js";
import {
  RecoveryEvidenceUnitOfWork,
} from "../storage/recovery-evidence-unit-of-work.js";
import {
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
} from "../storage/recovery-evidence-readback-operation-keys.js";
import { computeRecoveryReviewOperationRequestKey } from "../storage/recovery-review-operation-keys.js";
import type { StorageWritePermit } from "../storage/write-boundary.js";
import { buildRecoveryEvidenceEnvelopeFromRecord } from "./recovery-evidence-manifest.js";
import {
  RecoveryReadbackToolRegistry,
  type RecoveryReadbackPreparedInvocation,
  type RecoveryReadbackToolDefinition,
} from "./recovery-readback-tool-registry.js";
import {
  RecoveryVerifierRuntime,
  type RecoveryVerifierHostBinding,
} from "./recovery-verifier-runtime.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const OwnershipSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

export const PrepareRecoveryEvidenceReadbackInputSchema = z
  .object({
    ownership: OwnershipSchema,
    expectedTaskVersion: z.number().int().positive(),
    reviewId: z.string().trim().min(1),
    evidenceSubmissionId: z.string().trim().min(1),
    originalToolRunId: z.string().min(1),
    verificationCheckId: z.string().trim().min(1),
    allowlistId: z.string().trim().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    expectedResourceVersion: z.string().trim().min(1).nullable(),
    expectedEtag: z.string().trim().min(1).nullable(),
    ownerToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

export type PrepareRecoveryEvidenceReadbackInput = z.input<
  typeof PrepareRecoveryEvidenceReadbackInputSchema
>;

const RecoveryEvidenceReadbackRequestViewSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    requestKey: Sha256DigestSchema,
    operationId: z.string().min(1),
    executionPlanId: z.string().min(1),
    planStepId: z.string().min(1),
    readToolRunId: z.string().min(1),
    verifierId: z.string().min(1),
    verifierVersion: z.string().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().min(1),
    allowlistVersion: z.string().min(1),
    readToolName: z.string().min(1),
    readToolVersion: z.string().min(1),
    readToolSchemaHash: Sha256DigestSchema,
    retrySafety: z.enum(["immutable", "version_conditional"]),
    consistencyMode: z.enum([
      "immutable_version",
      "etag_or_resource_version",
    ]),
    expectedResourceVersion: z.string().min(1).nullable(),
    expectedEtag: z.string().min(1).nullable(),
    verificationCheckId: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

const RecoveryEvidenceReadbackReservationViewSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    requestId: z.string().min(1),
    operationId: z.string().min(1),
    executionPlanId: z.string().min(1),
    planStepId: z.string().min(1),
    readToolRunId: z.string().min(1),
    readAttemptId: z.string().min(1),
    verificationCheckId: z.string().min(1),
    requestIntentDigest: Sha256DigestSchema,
    ownerFencingToken: z.number().int().positive(),
    status: RecoveryEvidenceReadbackReservationStatusSchema,
    reservationVersion: z.number().int().positive(),
    createdAt: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export const PrepareRecoveryEvidenceReadbackResultSchema = z
  .object({
    state: z.enum(["request", "in_progress"]),
    replayed: z.boolean(),
    request: RecoveryEvidenceReadbackRequestViewSchema.nullable(),
    reservation: RecoveryEvidenceReadbackReservationViewSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === "request") !==
      (value.request !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["request"],
        message: "Request presence must match the readback state.",
      });
    }
  });

export type PrepareRecoveryEvidenceReadbackResult = z.infer<
  typeof PrepareRecoveryEvidenceReadbackResultSchema
>;

export interface RecoveryEvidenceReadbackServiceOptions {
  readonly database: ForgeFlowDatabase;
  readonly leaseManager: TaskLeaseManager;
  readonly readbackToolRegistry: RecoveryReadbackToolRegistry;
  readonly verifierRuntime: RecoveryVerifierRuntime;
  readonly hostVerifierId: string;
  readonly hostActorId: string;
  readonly hostAllowlistVersions: Readonly<Record<string, string>>;
  readonly assertAuthority: () => void;
  readonly idFactory?: () => string;
  readonly now?: () => Date;
}

interface PreparedHostReadback {
  readonly review: RecoveryReviewRecord;
  readonly submission: RecoveryEvidenceSubmissionRecord;
  readonly originalRun: ToolRunRecord;
  readonly sourceModelCallId: string;
  readonly allowlist: RecoveryReadbackToolDefinition;
  readonly preparedInvocation: RecoveryReadbackPreparedInvocation;
  readonly verifierBinding: RecoveryVerifierHostBinding;
  readonly canonicalInputHash: string;
  readonly operationPayloadDigest: string;
  readonly requestKey: string;
}

export class RecoveryEvidenceReadbackService {
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly reservationUnitOfWork: RecoveryEvidenceReadbackReservationUnitOfWork;
  private readonly evidenceUnitOfWork: RecoveryEvidenceUnitOfWork;
  private readonly plans: ExecutionPlanRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly idFactory: () => string;

  constructor(
    private readonly options: RecoveryEvidenceReadbackServiceOptions,
  ) {
    this.snapshotReader = new TaskSnapshotReader(options.database);
    this.reservationUnitOfWork =
      new RecoveryEvidenceReadbackReservationUnitOfWork(
        options.database,
        options.assertAuthority,
        options.leaseManager,
        options.now === undefined ? {} : { now: options.now },
      );
    this.evidenceUnitOfWork = new RecoveryEvidenceUnitOfWork(
      options.database,
      options.assertAuthority,
      options.leaseManager,
    );
    this.plans = new ExecutionPlanRepository(options.database);
    this.planSteps = new PlanStepRepository(options.database);
    this.toolRuns = new ToolRunRepository(options.database);
    this.idFactory = options.idFactory ?? randomUUID;
  }

  async prepareReadback(
    input: PrepareRecoveryEvidenceReadbackInput,
  ): Promise<PrepareRecoveryEvidenceReadbackResult> {
    const parsed =
      PrepareRecoveryEvidenceReadbackInputSchema.parse(input);
    const requestIntent = {
      reviewId: parsed.reviewId,
      evidenceSubmissionId: parsed.evidenceSubmissionId,
      originalToolRunId: parsed.originalToolRunId,
      allowlistId: parsed.allowlistId,
      verificationCheckId: parsed.verificationCheckId,
      expectedDecisionVersion: parsed.expectedDecisionVersion,
      expectedResourceVersion: parsed.expectedResourceVersion,
      expectedEtag: parsed.expectedEtag,
    };
    let acquired: RecoveryEvidenceReadbackReservationAcquireResult;
    try {
      acquired = this.reservationUnitOfWork.acquireOwned({
        ownership: parsed.ownership,
        expectedTaskVersion: parsed.expectedTaskVersion,
        requestIntent,
        requestId: this.idFactory(),
        operationId: this.idFactory(),
        executionPlanId: this.idFactory(),
        planStepId: this.idFactory(),
        readToolRunId: this.idFactory(),
        readAttemptId: this.idFactory(),
        ...(parsed.ownerToken === undefined
          ? {}
          : { ownerToken: parsed.ownerToken }),
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw preparationError();
    }

    if (acquired.state === "historical_request") {
      return result({
        state: "request",
        replayed: true,
        request: acquired.request,
        reservation: null,
      });
    }
    if (acquired.state === "completed") {
      return result({
        state: "request",
        replayed: true,
        request: acquired.request,
        reservation: acquired.reservation,
      });
    }
    if (acquired.state === "in_progress") {
      return result({
        state: "in_progress",
        replayed: true,
        request: null,
        reservation: acquired.reservation,
      });
    }

    try {
      const host = await this.prepareHost(parsed, acquired.reservation);
      let createdRequest:
        | RecoveryEvidenceReadbackRequestRecord
        | undefined;
      const completedReservation =
        this.reservationUnitOfWork.completeOwned(
        {
          ownership: parsed.ownership,
          reservationId: acquired.reservation.id,
          expectedReservationVersion:
            acquired.reservation.reservationVersion,
          ownerToken: acquired.ownerToken,
          requestIntent,
        },
        ({ task, permit, now }) => {
          const created =
            this.evidenceUnitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
              {
                ownership: parsed.ownership,
                expectedTaskVersion: parsed.expectedTaskVersion,
                requestId: acquired.reservation.requestId,
                operationId: acquired.reservation.operationId,
                readAttemptId:
                  acquired.reservation.readAttemptId,
                reviewId: host.review.id,
                evidenceSubmissionId: host.submission.id,
                originalToolRunId: host.originalRun.id,
                expectedDecisionVersion:
                  parsed.expectedDecisionVersion,
                actorId: this.options.hostActorId,
                operationPayloadDigest:
                  host.operationPayloadDigest,
                requestKey: host.requestKey,
                executionPlanId:
                  acquired.reservation.executionPlanId,
                planStepId: acquired.reservation.planStepId,
                readToolRunId:
                  acquired.reservation.readToolRunId,
                verifierId: host.verifierBinding.verifierId,
                verifierVersion:
                  host.verifierBinding.verifierVersion,
                verifierConfigDigest:
                  host.verifierBinding.verifierConfigDigest,
                allowlistId: host.allowlist.allowlistId,
                allowlistVersion: host.allowlist.allowlistVersion,
                readToolName: host.allowlist.name,
                readToolVersion: host.allowlist.version,
                readToolSchemaHash: host.allowlist.schemaHash,
                retrySafety: host.allowlist.retrySafety,
                consistencyMode: host.allowlist.consistencyMode,
                expectedResourceVersion:
                  parsed.expectedResourceVersion,
                expectedEtag: parsed.expectedEtag,
                verificationCheckId: parsed.verificationCheckId,
              },
              ({ task: parentTask, permit: parentPermit, now: parentNow }) => {
                this.prepareParents({
                  host,
                  reservation: acquired.reservation,
                  task: parentTask,
                  permit: parentPermit,
                  now: parentNow,
                });
              },
            );
          createdRequest = created.request;
          void task;
          void permit;
          void now;
        },
      );
      if (createdRequest === undefined) {
        throw preparationError();
      }
      return result({
        state: "request",
        replayed: false,
        request: createdRequest,
        reservation: completedReservation,
      });
    } catch (error) {
      this.tryAbandon(parsed, acquired.reservation, acquired.ownerToken);
      if (error instanceof AppError) {
        throw error;
      }
      throw preparationError();
    }
  }

  private async prepareHost(
    input: z.output<
      typeof PrepareRecoveryEvidenceReadbackInputSchema
    >,
    reservation: RecoveryEvidenceReadbackReservationView,
  ): Promise<PreparedHostReadback> {
    const snapshot = this.snapshotReader.load(
      input.ownership.taskId,
    );
    const review = findReview(snapshot, input);
    const submission = findSubmission(snapshot, input, review);
    const originalRun = findOriginalUnknownWrite(
      snapshot,
      submission,
    );
    const originalPlan = findOriginalAgentPlan(snapshot, originalRun);
    const sourceModelCall = snapshot.modelCalls.find(
      (candidate) =>
        candidate.id === originalPlan.sourceModelCallId,
    );
    if (sourceModelCall?.status !== "completed") {
      throw preparationError(
        "RECOVERY_EVIDENCE_ORIGINAL_MODEL_CALL_INVALID",
      );
    }
    const manifest = buildRecoveryEvidenceEnvelopeFromRecord(
      submission,
      originalRun,
    );
    const allowlistVersion =
      this.options.hostAllowlistVersions[input.allowlistId];
    if (allowlistVersion === undefined) {
      throw preparationError(
        "RECOVERY_EVIDENCE_ALLOWLIST_VERSION_UNAVAILABLE",
      );
    }
    const allowlist = this.options.readbackToolRegistry.getExact(
      input.allowlistId,
      allowlistVersion,
    );
    const verifierBinding =
      this.options.verifierRuntime.getBindingForNewCheck(
        this.options.hostVerifierId,
      );
    const preparedInvocation =
      await this.options.readbackToolRegistry.prepareArguments(
        allowlist.allowlistId,
        allowlist.allowlistVersion,
        manifest,
        {
          taskId: input.ownership.taskId,
          reviewId: review.id,
          evidenceSubmissionId: submission.id,
          verificationCheckId: input.verificationCheckId,
          readbackRequestId: reservation.requestId,
          expectedResourceVersion:
            input.expectedResourceVersion,
          expectedEtag: input.expectedEtag,
        },
        originalRun,
      );
    const canonicalInputHash = computeCanonicalInputHash(
      preparedInvocation.validatedInput.value,
    );
    const operationPayloadDigest =
      computeRecoveryEvidenceReadbackOperationPayloadDigest({
        evidenceSubmissionId: submission.id,
        originalUnknownToolRunId: originalRun.id,
        verifierId: verifierBinding.verifierId,
        verifierVersion: verifierBinding.verifierVersion,
        verifierConfigDigest:
          verifierBinding.verifierConfigDigest,
        allowlistId: allowlist.allowlistId,
        allowlistVersion: allowlist.allowlistVersion,
        readToolName: allowlist.name,
        readToolVersion: allowlist.version,
        readToolSchemaHash: allowlist.schemaHash,
        expectedResourceVersion: input.expectedResourceVersion,
        expectedEtag: input.expectedEtag,
        verificationCheckId: input.verificationCheckId,
        expectedDecisionVersion: input.expectedDecisionVersion,
      });
    const requestKey = computeRecoveryReviewOperationRequestKey({
      reviewId: review.id,
      expectedDecisionVersion: input.expectedDecisionVersion,
      operation: "request_readback",
      operationPayloadDigest,
      actorId: this.options.hostActorId,
    });
    return {
      review,
      submission,
      originalRun,
      sourceModelCallId: sourceModelCall.id,
      allowlist,
      preparedInvocation,
      verifierBinding,
      canonicalInputHash,
      operationPayloadDigest,
      requestKey,
    };
  }

  private prepareParents(input: {
    readonly host: PreparedHostReadback;
    readonly reservation: RecoveryEvidenceReadbackReservationView;
    readonly task: TaskRecord;
    readonly permit: StorageWritePermit;
    readonly now: string;
  }): void {
    const planVersion = this.plans.nextVersion(input.task.id);
    this.plans.insert(
      {
        id: input.reservation.executionPlanId,
        taskId: input.task.id,
        version: planVersion,
        sourceModelCallId: input.host.sourceModelCallId,
        purpose: "recovery_evidence",
        status: "active",
        createdAt: input.now,
      },
      input.permit,
    );
    this.planSteps.insert(
      {
        id: input.reservation.planStepId,
        taskId: input.task.id,
        planId: input.reservation.executionPlanId,
        stepIndex: 0,
        kind: "read_batch",
        status: "queued",
        createdAt: input.now,
      },
      input.permit,
    );
    const validatedInput =
      input.host.preparedInvocation.validatedInput;
    const toolInput = JsonValueSchema.parse(validatedInput.value);
    this.toolRuns.createIntent(
      {
        id: input.reservation.readToolRunId,
        taskId: input.task.id,
        planStepId: input.reservation.planStepId,
        toolCallId: `recovery-readback-call-${input.reservation.id}`,
        originalIndex: 0,
        toolName: validatedInput.toolName,
        toolVersion: validatedInput.toolVersion,
        inputSchemaHash: validatedInput.inputSchemaHash,
        canonicalInputHash: input.host.canonicalInputHash,
        mode: "read",
        requiresApproval: false,
        status: "queued",
        input: toolInput,
        idempotencyKey: computeIdempotencyKey({
          taskId: input.task.id,
          planVersion,
          originalIndex: 0,
          toolName: validatedInput.toolName,
          toolVersion: validatedInput.toolVersion,
          inputSchemaHash: validatedInput.inputSchemaHash,
          canonicalInputHash: input.host.canonicalInputHash,
        }),
        attemptNo: 1,
        createdAt: input.now,
      },
      input.permit,
    );
  }

  private tryAbandon(
    input: z.output<
      typeof PrepareRecoveryEvidenceReadbackInputSchema
    >,
    reservation: RecoveryEvidenceReadbackReservationView,
    ownerToken: string,
  ): void {
    try {
      this.reservationUnitOfWork.abandonOwned({
        ownership: input.ownership,
        reservationId: reservation.id,
        expectedReservationVersion:
          reservation.reservationVersion,
        ownerToken,
        requestIntent: {
          reviewId: input.reviewId,
          evidenceSubmissionId: input.evidenceSubmissionId,
          originalToolRunId: input.originalToolRunId,
          allowlistId: input.allowlistId,
          verificationCheckId: input.verificationCheckId,
          expectedDecisionVersion: input.expectedDecisionVersion,
          expectedResourceVersion:
            input.expectedResourceVersion,
          expectedEtag: input.expectedEtag,
        },
      });
    } catch {
      // A stale/revoked owner cannot safely write cleanup state.
    }
  }
}

function findReview(
  snapshot: TaskSnapshot,
  input: z.output<
    typeof PrepareRecoveryEvidenceReadbackInputSchema
  >,
): RecoveryReviewRecord {
  const review = snapshot.recoveryReviews.find(
    (candidate) => candidate.id === input.reviewId,
  );
  if (
    review === undefined ||
    review.taskId !== input.ownership.taskId ||
    review.reviewProtocolVersion < 1 ||
    !["pending", "unresolved"].includes(review.status) ||
    review.decisionVersion !== input.expectedDecisionVersion
  ) {
    throw preparationError(
      "RECOVERY_EVIDENCE_REVIEW_BINDING_INVALID",
    );
  }
  return review;
}

function findSubmission(
  snapshot: TaskSnapshot,
  input: z.output<
    typeof PrepareRecoveryEvidenceReadbackInputSchema
  >,
  review: RecoveryReviewRecord,
): RecoveryEvidenceSubmissionRecord {
  const submission = snapshot.recoveryEvidenceSubmissions.find(
    (candidate) => candidate.id === input.evidenceSubmissionId,
  );
  if (
    submission === undefined ||
    submission.taskId !== input.ownership.taskId ||
    submission.reviewId !== review.id ||
    submission.toolRunId !== review.toolRunId ||
    submission.toolRunId !== input.originalToolRunId
  ) {
    throw preparationError(
      "RECOVERY_EVIDENCE_SUBMISSION_BINDING_INVALID",
    );
  }
  const event = snapshot.events.find(
    (candidate) => candidate.id === submission.appliedEventId,
  );
  if (
    event === undefined ||
    event.type !== "recovery.evidence.submitted" ||
    event.entityId !== review.id ||
    event.payload.evidenceSubmissionId !== submission.id
  ) {
    throw preparationError(
      "RECOVERY_EVIDENCE_SUBMISSION_EVENT_INVALID",
    );
  }
  return submission;
}

function findOriginalUnknownWrite(
  snapshot: TaskSnapshot,
  submission: RecoveryEvidenceSubmissionRecord,
): ToolRunRecord {
  const run = snapshot.toolRuns.find(
    (candidate) => candidate.id === submission.toolRunId,
  );
  if (
    run === undefined ||
    run.taskId !== submission.taskId ||
    run.mode !== "write" ||
    run.status !== "unknown"
  ) {
    throw preparationError(
      "RECOVERY_EVIDENCE_ORIGINAL_WRITE_INVALID",
    );
  }
  return run;
}

function findOriginalAgentPlan(
  snapshot: TaskSnapshot,
  originalRun: ToolRunRecord,
) {
  const step = snapshot.planSteps.find(
    (candidate) => candidate.id === originalRun.planStepId,
  );
  const plan =
    step === undefined
      ? undefined
      : snapshot.executionPlans.find(
          (candidate) => candidate.id === step.planId,
        );
  if (
    step === undefined ||
    step.taskId !== originalRun.taskId ||
    plan === undefined ||
    plan.taskId !== originalRun.taskId ||
    plan.purpose !== "agent"
  ) {
    throw preparationError(
      "RECOVERY_EVIDENCE_ORIGINAL_PLAN_INVALID",
    );
  }
  return plan;
}

function result(
  input: PrepareRecoveryEvidenceReadbackResult,
): PrepareRecoveryEvidenceReadbackResult {
  return PrepareRecoveryEvidenceReadbackResultSchema.parse(input);
}

function preparationError(
  code = "RECOVERY_EVIDENCE_READBACK_PREPARATION_FAILED",
): AppError {
  return new AppError({
    code,
    message: "Recovery evidence readback preparation failed.",
    statusCode: 409,
    details: [],
  });
}
