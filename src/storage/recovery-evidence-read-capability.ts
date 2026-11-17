import { AppError } from "../shared/errors.js";

const controlledReadCapabilities = new WeakSet<object>();
const controlledReadBrand = Symbol(
  "forgeflow.recovery-evidence-controlled-read",
);

export interface RecoveryEvidenceControlledReadCapability {
  readonly [controlledReadBrand]: true;
}

export function createRecoveryEvidenceControlledReadCapability(): RecoveryEvidenceControlledReadCapability {
  const capability = Object.freeze({
    [controlledReadBrand]: true as const,
  });
  controlledReadCapabilities.add(capability);
  return capability;
}

export function assertRecoveryEvidenceControlledReadCapability(
  capability: unknown,
): asserts capability is RecoveryEvidenceControlledReadCapability {
  if (
    capability === null ||
    typeof capability !== "object" ||
    !controlledReadCapabilities.has(capability)
  ) {
    throw new AppError({
      code: "RECOVERY_EVIDENCE_CONTROLLED_READ_CAPABILITY_REQUIRED",
      message: "Controlled recovery evidence reads require the dedicated UoW.",
      statusCode: 500,
      details: [],
    });
  }
}
