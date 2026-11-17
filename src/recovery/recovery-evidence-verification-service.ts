import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceAvailabilityResultStatusSchema,
  RecoveryEvidenceAuthenticityStatusSchema,
  RecoveryEvidenceIntegrityStatusSchema,
  RecoveryEvidenceReadbackProvenanceSchema,
  RecoveryEvidenceVerificationCheckOriginSchema,
  RecoveryEvidenceVerificationResultStatusSchema,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
  type RecoveryEvidenceSubmissionRecord,
  type RecoveryEvidenceVerificationCheckRecord,
  type RecoveryEvidenceVerificationRecord,
  type RecoveryReviewRecord,
  type TaskSnapshot,
  type ToolRunRecord,
} from "../storage/index.js";
import {
  RecoveryEvidenceUnitOfWork,
} from "../storage/recovery-evidence-unit-of-work.js";
import type { EvidencePayloadStore } from "./evidence-payload-store.js";
import {
  loadRecoveryEvidencePayloadWithIntegrity,
} from "./recovery-evidence-payload-integrity.js";
import { buildRecoveryEvidenceEnvelopeFromRecord } from "./recovery-evidence-manifest.js";
import {
  RecoveryVerifierRuntime,
  type RecoveryPersistedVerifierBinding,
} from "./recovery-verifier-runtime.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const VerificationOwnershipSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

export const VerifyStoredEvidenceInputSchema = z
  .object({
    ownership: VerificationOwnershipSchema,
    expectedTaskVersion: z.number().int().positive(),
    reviewId: z.string().trim().min(1),
    evidenceSubmissionId: z.string().trim().min(1),
    verificationCheckId: z.string().trim().min(1),
  })
  .strict();

export type VerifyStoredEvidenceInput = z.input<
  typeof VerifyStoredEvidenceInputSchema
>;

const RecoveryEvidenceVerificationCheckViewSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    readbackRequestId: z.string().min(1).nullable(),
    evidenceReadId: z.string().min(1).nullable(),
    verificationCheckId: z.string().min(1),
    requestKey: Sha256DigestSchema,
    checkOrigin: RecoveryEvidenceVerificationCheckOriginSchema,
    verifierId: z.string().min(1),
    verifierVersion: z.string().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().min(1).nullable(),
    allowlistVersion: z.string().min(1).nullable(),
    readToolName: z.string().min(1).nullable(),
    readToolVersion: z.string().min(1).nullable(),
    readToolSchemaHash: Sha256DigestSchema.nullable(),
    expectedPayloadDigest: Sha256DigestSchema,
    createdAt: z.string().min(1),
  })
  .strict();

const RecoveryEvidenceVerificationViewSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    readbackRequestId: z.string().min(1).nullable(),
    evidenceReadId: z.string().min(1).nullable(),
    readAttemptId: z.string().min(1).nullable(),
    verificationCheckId: z.string().min(1),
    readbackResultProvenance:
      RecoveryEvidenceReadbackProvenanceSchema,
    verifierId: z.string().min(1),
    verifierVersion: z.string().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().min(1).nullable(),
    allowlistVersion: z.string().min(1).nullable(),
    requestKey: Sha256DigestSchema,
    availabilityStatus:
      RecoveryEvidenceAvailabilityResultStatusSchema,
    integrityStatus: RecoveryEvidenceIntegrityStatusSchema,
    authenticityStatus:
      RecoveryEvidenceAuthenticityStatusSchema,
    verificationStatus:
      RecoveryEvidenceVerificationResultStatusSchema,
    expectedPayloadDigest: Sha256DigestSchema,
    observedPayloadDigest: Sha256DigestSchema.nullable(),
    reasonCode: z.string().trim().min(1),
    redactedSummary: z.string().trim().min(1).max(500).nullable(),
    availabilityEventId: z.string().min(1),
    verificationEventId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  })
  .strict();

export const RecoveryEvidenceStoredVerificationResultSchema = z
  .object({
    state: z.enum(["pending", "verification"]),
    replayed: z.boolean(),
    check: RecoveryEvidenceVerificationCheckViewSchema,
    verification: RecoveryEvidenceVerificationViewSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.state === "verification") !==
      (value.verification !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["verification"],
        message:
          "Verification result presence must match the replay state.",
      });
    }
  });

export type RecoveryEvidenceStoredVerificationResult = z.infer<
  typeof RecoveryEvidenceStoredVerificationResultSchema
>;

export interface RecoveryEvidenceVerificationServiceOptions {
  readonly database: ForgeFlowDatabase;
  readonly leaseManager: TaskLeaseManager;
  readonly payloadStore: EvidencePayloadStore;
  readonly verifierRuntime: RecoveryVerifierRuntime;
  readonly hostVerifierId: string;
  readonly assertAuthority: () => void;
  readonly now?: () => Date;
  readonly idFactory?: () => string;
}

export class RecoveryEvidenceVerificationService {
  private readonly database: ForgeFlowDatabase;
  private readonly leaseManager: TaskLeaseManager;
  private readonly payloadStore: EvidencePayloadStore;
  private readonly verifierRuntime: RecoveryVerifierRuntime;
  private readonly hostVerifierId: string;
  private readonly assertAuthority: () => void;
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly unitOfWork: RecoveryEvidenceUnitOfWork;
  private readonly now: () => Date;
  private readonly idFactory: () => string;

  constructor(options: RecoveryEvidenceVerificationServiceOptions) {
    this.database = options.database;
    this.leaseManager = options.leaseManager;
    this.payloadStore = options.payloadStore;
    this.verifierRuntime = options.verifierRuntime;
    this.hostVerifierId = options.hostVerifierId;
    this.assertAuthority = options.assertAuthority;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.snapshotReader = new TaskSnapshotReader(this.database);
    this.unitOfWork = new RecoveryEvidenceUnitOfWork(
      this.database,
      this.assertAuthority,
      this.leaseManager,
    );
  }

  async verifyStoredEvidence(
    input: VerifyStoredEvidenceInput,
  ): Promise<RecoveryEvidenceStoredVerificationResult> {
    const parsed = VerifyStoredEvidenceInputSchema.parse(input);

    this.leaseManager.assertOwned(
      parsed.ownership.taskId,
      parsed.ownership.leaseToken,
      parsed.ownership.fencingToken,
    );
    this.assertAuthority();

    const snapshot = this.snapshotReader.load(
      parsed.ownership.taskId,
    );
    const graph = resolveStoredEvidenceGraph(snapshot, parsed);
    const checkResult =
      this.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        {
          ownership: parsed.ownership,
          expectedTaskVersion: parsed.expectedTaskVersion,
          checkRecordId: this.idFactory(),
          reviewId: graph.review.id,
          evidenceSubmissionId: graph.manifest.id,
          originalToolRunId: graph.toolRun.id,
          verificationCheckId: parsed.verificationCheckId,
          expectedPayloadDigest: graph.manifest.payloadDigest,
        },
        () => {
          const hostBinding =
            this.verifierRuntime.getBindingForNewCheck(
              this.hostVerifierId,
            );
          return {
            verifierId: hostBinding.verifierId,
            verifierVersion: hostBinding.verifierVersion,
            verifierConfigDigest:
              hostBinding.verifierConfigDigest,
          };
        },
      );

    if (checkResult.state !== "created") {
      return storedVerificationResult(
        checkResult.check,
        checkResult.verification,
        checkResult.replayed,
      );
    }

    const postCheckSnapshot = this.snapshotReader.load(
      parsed.ownership.taskId,
    );
    this.assertAuthority();
    assertNoIntent(postCheckSnapshot);
    const expectedTaskVersion = postCheckSnapshot.task.version;

    const loaded = loadRecoveryEvidencePayloadWithIntegrity(
      graph.manifest,
      this.payloadStore,
    );
    this.assertAuthority();
    assertNoIntent(
      this.snapshotReader.load(parsed.ownership.taskId),
    );
    if (
      loaded.result.integrityStatus !== "matched" ||
      loaded.payload === null
    ) {
      return this.recordResult({
        ownership: parsed.ownership,
        expectedTaskVersion,
        check: checkResult.check,
        availabilityStatus:
          loaded.result.availabilityStatus,
        integrityStatus: loaded.result.integrityStatus,
        verificationStatus: "not_run",
        observedPayloadDigest:
          loaded.result.actualSemanticDigest,
        reasonCode: loaded.result.reasonCode,
        redactedSummary: loaded.result.redactedSummary,
      });
    }

    const verificationId = this.idFactory();
    const binding = persistedBinding(checkResult.check);
    const runtimeResult =
      await this.verifierRuntime.executePersisted({
        binding,
        manifest: buildRecoveryEvidenceEnvelopeFromRecord(
          graph.manifest,
          graph.toolRun,
        ),
        verifiedPayload: loaded.payload,
        context: {
          taskId: parsed.ownership.taskId,
          reviewId: graph.review.id,
          originalToolRunId: graph.toolRun.id,
          evidenceSubmissionId: graph.manifest.id,
          verificationId,
          verificationCheckId: parsed.verificationCheckId,
          verifierConfigDigest: binding.verifierConfigDigest,
          payloadType: graph.manifest.payloadType,
          sourceType: graph.manifest.sourceType,
          verificationStartedAt: this.now().toISOString(),
          authenticatedActorId: graph.manifest.actorId,
          trustAnchorId: null,
          readbackToolRunId: null,
          toolMessageId: null,
        },
      });

    this.assertAuthority();
    assertNoIntent(
      this.snapshotReader.load(parsed.ownership.taskId),
    );

    return this.recordResult({
      ownership: parsed.ownership,
      expectedTaskVersion,
      check: checkResult.check,
      availabilityStatus: "available",
      integrityStatus: "matched",
      verificationStatus: runtimeResult.status,
      observedPayloadDigest:
        loaded.result.actualSemanticDigest,
      reasonCode: runtimeResult.reasonCode,
      redactedSummary: runtimeResult.redactedSummary,
      verificationId,
    });
  }

  private recordResult(input: {
    readonly ownership: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    };
    readonly expectedTaskVersion: number;
    readonly check: RecoveryEvidenceVerificationCheckRecord;
    readonly availabilityStatus:
      | "available"
      | "unavailable";
    readonly integrityStatus:
      | "not_checked"
      | "matched"
      | "mismatch";
    readonly verificationStatus:
      | "not_run"
      | "passed"
      | "failed"
      | "inconclusive";
    readonly observedPayloadDigest: string | null;
    readonly reasonCode: string;
    readonly redactedSummary: string | null;
    readonly verificationId?: string;
  }): RecoveryEvidenceStoredVerificationResult {
    const recorded =
      this.unitOfWork.recordOwnedRecoveryEvidenceVerification({
        ownership: input.ownership,
        expectedTaskVersion: input.expectedTaskVersion,
        verificationId: input.verificationId ?? this.idFactory(),
        verificationCheckId: input.check.verificationCheckId,
        requestKey: input.check.requestKey,
        readbackResultProvenance: "declared_payload",
        availabilityStatus: input.availabilityStatus,
        integrityStatus: input.integrityStatus,
        authenticityStatus: "unverified",
        verificationStatus: input.verificationStatus,
        observedPayloadDigest: input.observedPayloadDigest,
        reasonCode: input.reasonCode,
        redactedSummary: input.redactedSummary,
      });
    return storedVerificationResult(
      input.check,
      recorded.verification,
      recorded.replayed,
    );
  }
}

interface StoredEvidenceGraph {
  readonly review: RecoveryReviewRecord;
  readonly manifest: RecoveryEvidenceSubmissionRecord;
  readonly toolRun: ToolRunRecord;
}

function resolveStoredEvidenceGraph(
  snapshot: TaskSnapshot,
  input: z.output<typeof VerifyStoredEvidenceInputSchema>,
): StoredEvidenceGraph {
  const review = snapshot.recoveryReviews.find(
    (candidate) => candidate.id === input.reviewId,
  );
  if (review === undefined || review.taskId !== input.ownership.taskId) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_REVIEW_NOT_FOUND",
      "Recovery evidence review was not found.",
      404,
    );
  }
  if (!["pending", "unresolved"].includes(review.status)) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_REVIEW_NOT_ACTIVE",
      "Recovery evidence review is not active.",
    );
  }

  const manifest = snapshot.recoveryEvidenceSubmissions.find(
    (candidate) => candidate.id === input.evidenceSubmissionId,
  );
  if (
    manifest === undefined ||
    manifest.taskId !== input.ownership.taskId ||
    manifest.reviewId !== review.id ||
    manifest.toolRunId !== review.toolRunId
  ) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_SUBMISSION_BINDING_INVALID",
      "Recovery evidence submission does not match the review.",
    );
  }

  const event = snapshot.events.find(
    (candidate) => candidate.id === manifest.appliedEventId,
  );
  if (
    event === undefined ||
    event.taskId !== input.ownership.taskId ||
    event.type !== "recovery.evidence.submitted" ||
    event.entityId !== review.id ||
    event.payload.evidenceSubmissionId !== manifest.id
  ) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_SUBMISSION_EVENT_INVALID",
      "Recovery evidence submission event binding is invalid.",
    );
  }

  const toolRun = snapshot.toolRuns.find(
    (candidate) => candidate.id === manifest.toolRunId,
  );
  if (
    toolRun === undefined ||
    toolRun.taskId !== input.ownership.taskId ||
    toolRun.mode !== "write" ||
    toolRun.status !== "unknown"
  ) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_ORIGINAL_WRITE_INVALID",
      "Recovery evidence original write binding is invalid.",
    );
  }
  const planStep = snapshot.planSteps.find(
    (candidate) => candidate.id === toolRun.planStepId,
  );
  const plan =
    planStep === undefined
      ? undefined
      : snapshot.executionPlans.find(
          (candidate) => candidate.id === planStep.planId,
        );
  if (
    planStep === undefined ||
    planStep.taskId !== input.ownership.taskId ||
    plan === undefined ||
    plan.taskId !== input.ownership.taskId ||
    plan.purpose !== "agent"
  ) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_ORIGINAL_PLAN_INVALID",
      "Recovery evidence original agent plan binding is invalid.",
    );
  }
  return { review, manifest, toolRun };
}

function persistedBinding(
  check: RecoveryEvidenceVerificationCheckRecord,
): RecoveryPersistedVerifierBinding {
  return {
    verifierId: check.verifierId,
    verifierVersion: check.verifierVersion,
    verifierConfigDigest: check.verifierConfigDigest,
  };
}

function storedVerificationResult(
  check: RecoveryEvidenceVerificationCheckRecord,
  verification: RecoveryEvidenceVerificationRecord | null,
  replayed: boolean,
): RecoveryEvidenceStoredVerificationResult {
  return RecoveryEvidenceStoredVerificationResultSchema.parse({
    state: verification === null ? "pending" : "verification",
    replayed,
    check,
    verification,
  });
}

function assertNoIntent(snapshot: TaskSnapshot): void {
  if (
    snapshot.task.cancelRequestedAt !== null ||
    snapshot.task.pauseRequestedAt !== null
  ) {
    throw verificationStateError(
      "RECOVERY_EVIDENCE_INTENT_BLOCKED",
      "Cancel or pause intent blocks verification execution.",
    );
  }
}

function verificationStateError(
  code: string,
  message: string,
  statusCode = 409,
): AppError {
  return new AppError({
    code,
    message,
    statusCode,
    details: [],
  });
}
