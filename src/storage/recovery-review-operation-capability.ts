import { AppError } from "../shared/errors.js";

const operationCapabilities = new WeakSet<object>();
const capabilityBrand = Symbol("forgeflow.recovery-review-operation");

export interface RecoveryReviewOperationCapability {
  readonly [capabilityBrand]: true;
}

export function createRecoveryReviewOperationCapability(): RecoveryReviewOperationCapability {
  const capability = Object.freeze({
    [capabilityBrand]: true as const,
  });
  operationCapabilities.add(capability);
  return capability;
}

export function assertRecoveryReviewOperationCapability(
  capability: unknown,
): asserts capability is RecoveryReviewOperationCapability {
  if (
    capability === null ||
    typeof capability !== "object" ||
    !operationCapabilities.has(capability)
  ) {
    throw new AppError({
      code: "RECOVERY_REVIEW_OPERATION_CAPABILITY_REQUIRED",
      message:
        "Recovery review operations must use the decision service.",
      statusCode: 500,
      details: [],
    });
  }
}
