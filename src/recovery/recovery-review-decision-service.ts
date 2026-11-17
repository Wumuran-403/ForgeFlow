import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  ExecutionUnitOfWork,
  JsonValueSchema,
  TaskLeaseManager,
  type ForgeFlowDatabase,
  type LeaseOwnershipContext,
  type RecoveryReviewOperationCommitResult,
} from "../storage/index.js";
import {
  computeRecoveryReviewOperationPayloadDigest,
  computeRecoveryReviewOperationRequestKey,
} from "../storage/recovery-review-operation-keys.js";
import { createRecoveryReviewOperationCapability } from "../storage/recovery-review-operation-capability.js";
import {
  computeRecoveryEvidenceEnvelopeDigest,
} from "./recovery-evidence.js";
import {
  MarkRecoveryReviewUnresolvedInputSchema,
  SubmitRecoveryEvidenceInputSchema,
  buildRecoveryEvidenceEnvelope,
  computeSubmittedEvidencePayloadDigest,
  computeUnresolvedOperationPayloadDigest,
  evidenceOperationActorId,
  submittedEvidencePayloadBytes,
  type MarkRecoveryReviewUnresolvedInput,
  type SubmitRecoveryEvidenceInput,
} from "./recovery-review-submission.js";
import type { EvidencePayloadStore } from "./evidence-payload-store.js";

const Sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const LeaseOwnedRecoveryReviewOperationInputSchema = z
  .object({
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    operation: z.literal("advance_decision_version"),
    actorId: z.string().trim().min(1),
    operationPayload: JsonValueSchema,
    requestKey: Sha256HashSchema,
  })
  .strict();

export type LeaseOwnedRecoveryReviewOperationInput = z.input<
  typeof LeaseOwnedRecoveryReviewOperationInputSchema
>;

export class RecoveryReviewDecisionService {
  private readonly unitOfWork: ExecutionUnitOfWork;

  constructor(
    database: ForgeFlowDatabase,
    leaseManager: TaskLeaseManager,
    private readonly payloadStore: EvidencePayloadStore,
  ) {
    this.unitOfWork = new ExecutionUnitOfWork(database, leaseManager);
  }

  commitOwned(
    input: LeaseOwnedRecoveryReviewOperationInput,
    ownership: LeaseOwnershipContext,
    expectedTaskVersion: number,
    assertAuthority?: () => void,
  ): RecoveryReviewOperationCommitResult {
    const parsed =
      LeaseOwnedRecoveryReviewOperationInputSchema.parse(input);
    const operationPayloadDigest =
      computeRecoveryReviewOperationPayloadDigest(
        parsed.operationPayload,
      );
    const expectedRequestKey =
      computeRecoveryReviewOperationRequestKey({
        reviewId: parsed.reviewId,
        expectedDecisionVersion: parsed.expectedDecisionVersion,
        operation: parsed.operation,
        operationPayloadDigest,
        actorId: parsed.actorId,
      });
    if (expectedRequestKey !== parsed.requestKey) {
      throw new AppError({
        code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
        message: "Review operation request key does not match its payload.",
        statusCode: 409,
        details: [],
      });
    }

    return this.unitOfWork.commitOwnedRecoveryReviewOperation(
      {
        capability: createRecoveryReviewOperationCapability(),
        ownership,
        expectedTaskVersion,
        reviewId: parsed.reviewId,
        expectedDecisionVersion: parsed.expectedDecisionVersion,
        operation: parsed.operation,
        actorId: parsed.actorId,
        operationPayloadDigest,
        requestKey: parsed.requestKey,
      },
      assertAuthority,
    );
  }

  submitEvidenceOwned(
    input: SubmitRecoveryEvidenceInput,
    ownership: LeaseOwnershipContext,
    expectedTaskVersion: number,
    submittedAt: string,
    assertAuthority?: () => void,
  ): RecoveryReviewOperationCommitResult {
    const parsed = SubmitRecoveryEvidenceInputSchema.parse(input);
    const computedPayloadDigest =
      computeSubmittedEvidencePayloadDigest(parsed.payload);
    if (computedPayloadDigest !== parsed.payload.payloadDigest) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_PAYLOAD_DIGEST_MISMATCH",
        message:
          "Evidence payload digest does not match the submitted content.",
        statusCode: 409,
        details: [],
      });
    }
    const envelope = buildRecoveryEvidenceEnvelope(
      parsed,
      submittedAt,
    );
    const envelopeDigest =
      computeRecoveryEvidenceEnvelopeDigest(envelope);
    const operationActorId = evidenceOperationActorId(envelope);
    const payloadBytes = submittedEvidencePayloadBytes(parsed.payload);
    const storedPayload =
      payloadBytes === null
        ? {
            storeRef: null,
            storageMode: "reference_only" as const,
          }
        : {
            storeRef: this.payloadStore.put(
              payloadBytes,
              parsed.payload.payloadDigest,
            ).storeRef,
            storageMode: "content_addressed_file" as const,
          };
    const expectedRequestKey =
      computeRecoveryReviewOperationRequestKey({
        reviewId: parsed.reviewId,
        expectedDecisionVersion: parsed.expectedDecisionVersion,
        operation: "submit_evidence",
        operationPayloadDigest: envelopeDigest,
        actorId: operationActorId,
      });
    if (expectedRequestKey !== parsed.requestKey) {
      throw new AppError({
        code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
        message: "Review operation request key does not match its payload.",
        statusCode: 409,
        details: [],
      });
    }

    return this.unitOfWork.submitOwnedRecoveryEvidence(
      {
        capability: createRecoveryReviewOperationCapability(),
        ownership,
        expectedTaskVersion,
        reviewId: parsed.reviewId,
        expectedDecisionVersion: parsed.expectedDecisionVersion,
        evidenceSubmissionId: randomUUID(),
        envelope,
        envelopeDigest,
        payloadStoreRef: storedPayload.storeRef,
        payloadStorageMode: storedPayload.storageMode,
        operationActorId,
        operationPayloadDigest: envelopeDigest,
        requestKey: parsed.requestKey,
      },
      assertAuthority,
    );
  }

  markUnresolvedOwned(
    input: MarkRecoveryReviewUnresolvedInput,
    ownership: LeaseOwnershipContext,
    expectedTaskVersion: number,
    assertAuthority?: () => void,
  ): RecoveryReviewOperationCommitResult {
    const parsed =
      MarkRecoveryReviewUnresolvedInputSchema.parse(input);
    const operationPayloadDigest =
      computeUnresolvedOperationPayloadDigest({
        reason: parsed.reason,
        referencedEvidenceEnvelopeDigest:
          parsed.referencedEvidenceEnvelopeDigest,
      });
    const expectedRequestKey =
      computeRecoveryReviewOperationRequestKey({
        reviewId: parsed.reviewId,
        expectedDecisionVersion: parsed.expectedDecisionVersion,
        operation: "mark_unresolved",
        operationPayloadDigest,
        actorId: parsed.actorId,
      });
    if (expectedRequestKey !== parsed.requestKey) {
      throw new AppError({
        code: "RECOVERY_REVIEW_REQUEST_KEY_MISMATCH",
        message: "Review operation request key does not match its payload.",
        statusCode: 409,
        details: [],
      });
    }

    return this.unitOfWork.markOwnedRecoveryReviewUnresolved(
      {
        capability: createRecoveryReviewOperationCapability(),
        ownership,
        expectedTaskVersion,
        reviewId: parsed.reviewId,
        expectedDecisionVersion: parsed.expectedDecisionVersion,
        actorId: parsed.actorId,
        reason: parsed.reason,
        referencedEvidenceEnvelopeDigest:
          parsed.referencedEvidenceEnvelopeDigest,
        operationPayloadDigest,
        requestKey: parsed.requestKey,
      },
      assertAuthority,
    );
  }
}
