import { z } from "zod";

import { AppError } from "../shared/errors.js";
import { computeRecoveryReviewOperationPayloadDigest,
  computeRecoveryReviewOperationRequestKey } from "../storage/recovery-review-operation-keys.js";
import type { ForgeFlowDatabase, LeaseOwnershipContext } from "../storage/index.js";
import { TaskLeaseManager } from "../storage/task-lease-manager.js";
import type { EvidencePayloadStore } from "./evidence-payload-store.js";
import { assertFinalDecisionAuthorization, readFinalDecisionAuthorizationClaims,
  type FinalDecisionAuthorization, type FinalDecisionIdentity } from "./recovery-review-final-decision-authorization.js";
import { RecoveryReviewFinalDecisionUnitOfWork } from "../storage/recovery-review-final-decision-unit-of-work.js";

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
export const FinalDecisionInputSchema = z.object({
  taskId: z.string().min(1), reviewId: z.string().min(1),
  originalUnknownWriteToolRunId: z.string().min(1),
  operation: z.enum(["confirm_succeeded", "confirm_not_executed"]),
  expectedDecisionVersion: z.number().int().nonnegative(),
  evidenceSubmissionId: z.string().min(1),
  verificationCheckId: z.string().min(1).nullable(),
  verificationId: z.string().min(1).nullable(),
  sourceContractDigest: Digest.nullable(),
  decisionNote: z.string().trim().max(2_000).nullable(),
}).strict();
export type FinalDecisionInput = z.input<typeof FinalDecisionInputSchema>;

export function computeFinalDecisionIdentity(input: FinalDecisionInput,
  actorId: string, actorType: "human_reviewer" | "host_verifier"): FinalDecisionIdentity {
  const parsed = FinalDecisionInputSchema.parse(input);
  const operationPayloadDigest = computeRecoveryReviewOperationPayloadDigest({
    domain: "forgeflow.recovery-review-final-decision.v1",
    taskId: parsed.taskId, recoveryReviewId: parsed.reviewId,
    originalUnknownWriteToolRunId: parsed.originalUnknownWriteToolRunId,
    decision: parsed.operation === "confirm_succeeded" ? "confirmed_succeeded" : "confirmed_not_executed",
    actorType, evidenceSubmissionId: parsed.evidenceSubmissionId,
    verificationCheckId: parsed.verificationCheckId, verificationId: parsed.verificationId,
    sourceContractDigest: parsed.sourceContractDigest, decisionNote: parsed.decisionNote,
  });
  return {
    taskId: parsed.taskId, reviewId: parsed.reviewId,
    originalUnknownWriteToolRunId: parsed.originalUnknownWriteToolRunId,
    operation: parsed.operation, expectedDecisionVersion: parsed.expectedDecisionVersion,
    operationPayloadDigest, sourceContractDigest: parsed.sourceContractDigest,
    requestKey: computeRecoveryReviewOperationRequestKey({
      reviewId: parsed.reviewId, expectedDecisionVersion: parsed.expectedDecisionVersion,
      operation: parsed.operation, operationPayloadDigest, actorId,
    }),
  };
}

export class RecoveryReviewFinalDecisionService {
  private readonly unitOfWork: RecoveryReviewFinalDecisionUnitOfWork;
  constructor(database: ForgeFlowDatabase, leaseManager: TaskLeaseManager,
    payloadStore: EvidencePayloadStore) {
    this.unitOfWork = new RecoveryReviewFinalDecisionUnitOfWork(database, leaseManager, payloadStore);
  }

  commitInternal(input: FinalDecisionInput, authorization: FinalDecisionAuthorization,
    ownership: LeaseOwnershipContext, expectedTaskVersion: number,
    assertAuthority?: () => void) {
    const parsed = FinalDecisionInputSchema.parse(input);
    const actor = readFinalDecisionAuthorizationClaims(authorization, "final_decision");
    const identity = computeFinalDecisionIdentity(parsed, actor.actorId, actor.actorType);
    assertFinalDecisionAuthorization(authorization, { ...identity, access: "final_decision" });
    if (parsed.operation === "confirm_succeeded" && parsed.sourceContractDigest !== null ||
        parsed.operation === "confirm_not_executed" && parsed.sourceContractDigest === null) {
      throw new AppError({ code: "RECOVERY_REVIEW_SOURCE_CONTRACT_REQUIRED",
        message: "Source contract binding is invalid for this decision.", statusCode: 409, details: [] });
    }
    return this.unitOfWork.commitInternal({ input: parsed, identity, actor,
      ownership, expectedTaskVersion, ...(assertAuthority === undefined ? {} : { assertAuthority }) });
  }
}
