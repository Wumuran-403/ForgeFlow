import {
  canonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "../shared/canonical-json.js";
import type {
  JsonValue,
  RecoveryReviewOperationType,
} from "./types.js";

const RECOVERY_REVIEW_OPERATION_DOMAIN =
  "forgeflow.recovery-review-operation.v1";

export interface RecoveryReviewOperationKeyInput {
  readonly reviewId: string;
  readonly expectedDecisionVersion: number;
  readonly operation: RecoveryReviewOperationType;
  readonly operationPayloadDigest: string;
  readonly actorId: string;
}

export function computeRecoveryReviewOperationPayloadDigest(
  payload: JsonValue,
): string {
  return sha256CanonicalJson(payload);
}

export function computeRecoveryReviewOperationRequestKey(
  input: RecoveryReviewOperationKeyInput,
): string {
  const canonicalPayload = canonicalJson([
    RECOVERY_REVIEW_OPERATION_DOMAIN,
    input.reviewId,
    input.expectedDecisionVersion,
    input.operation,
    input.operationPayloadDigest,
    input.actorId,
  ]);
  return `sha256:${sha256Text(canonicalPayload)}`;
}
