import { AppError } from "../shared/errors.js";
import {
  RecoveryReadbackAllowlistContractMetadataSchema,
  type RecoveryReadbackAllowlistContractMetadata,
  type RecoveryReadbackToolDefinition,
} from "./recovery-readback-tool-registry.js";
import {
  RecoveryReadbackToolRegistry,
  computeRecoveryReadbackAllowlistVersion,
} from "./recovery-readback-tool-registry.js";

interface RecoveryEvidenceDispatchPreflightBinding {
  readonly allowlistId: string;
  readonly allowlistVersion: string;
  readonly allowlistContractDigest: string;
  readonly readToolName: string;
  readonly readToolVersion: string;
  readonly readToolSchemaHash: string;
  readonly retrySafety: RecoveryReadbackToolDefinition["retrySafety"];
  readonly consistencyMode: RecoveryReadbackToolDefinition["consistencyMode"];
}

declare const recoveryEvidenceDispatchPreflightBrand: unique symbol;

export interface RecoveryEvidenceDispatchPreflightCapability {
  readonly [recoveryEvidenceDispatchPreflightBrand]: true;
}

const dispatchPreflightCapabilities = new WeakMap<
  object,
  Readonly<RecoveryEvidenceDispatchPreflightBinding>
>();

export function prepareRecoveryEvidenceDispatchPreflight(input: {
  readonly registry: RecoveryReadbackToolRegistry;
  readonly allowlistId: string;
  readonly expectedAllowlistContractDigest: string;
}): RecoveryEvidenceDispatchPreflightCapability {
  if (!(input.registry instanceof RecoveryReadbackToolRegistry)) {
    throw dispatchPreflightError();
  }
  let definition: RecoveryReadbackToolDefinition;
  try {
    definition = input.registry.getExact(
      input.allowlistId,
      input.expectedAllowlistContractDigest,
    );
  } catch {
    throw dispatchPreflightError();
  }

  const metadata = RecoveryReadbackAllowlistContractMetadataSchema.parse({
    protocolVersion: definition.protocolVersion,
    allowlistId: definition.allowlistId,
    sourceResolverId: definition.sourceResolverId,
    sourceResolverVersion: definition.sourceResolverVersion,
    argumentBuilderId: definition.argumentBuilderId,
    argumentBuilderVersion: definition.argumentBuilderVersion,
    toolName: definition.name,
    toolVersion: definition.version,
    toolInputSchemaHash: definition.schemaHash,
    resultSchemaId: definition.resultSchemaId,
    resultSchemaVersion: definition.resultSchemaVersion,
    resultSchemaHash: definition.resultSchemaHash,
    resourceMetadataExtractorId:
      definition.resourceMetadataExtractorId,
    resourceMetadataExtractorVersion:
      definition.resourceMetadataExtractorVersion,
    allowedResourceSchemes: [...definition.allowedResourceSchemes],
    retrySafety: definition.retrySafety,
    consistencyMode: definition.consistencyMode,
    timeoutMs: definition.timeoutMs,
    maximumPayloadBytes: definition.maximumPayloadBytes,
    sensitiveOutputPolicy: definition.sensitiveOutputPolicy,
  } satisfies RecoveryReadbackAllowlistContractMetadata);
  const digest =
    computeRecoveryReadbackAllowlistVersion(metadata);
  if (
    digest !== input.expectedAllowlistContractDigest ||
    definition.allowlistVersion !== digest
  ) {
    throw dispatchPreflightError();
  }

  const capability = Object.freeze({}) as
    RecoveryEvidenceDispatchPreflightCapability;
  dispatchPreflightCapabilities.set(
    capability,
    Object.freeze({
      allowlistId: definition.allowlistId,
      allowlistVersion: definition.allowlistVersion,
      allowlistContractDigest: digest,
      readToolName: definition.name,
      readToolVersion: definition.version,
      readToolSchemaHash: definition.schemaHash,
      retrySafety: definition.retrySafety,
      consistencyMode: definition.consistencyMode,
    }),
  );
  return capability;
}

export function assertRecoveryEvidenceDispatchPreflightCapability(
  capability: unknown,
): Readonly<RecoveryEvidenceDispatchPreflightBinding> {
  if (
    capability === null ||
    typeof capability !== "object" ||
    !dispatchPreflightCapabilities.has(capability)
  ) {
    throw dispatchPreflightError();
  }
  return dispatchPreflightCapabilities.get(capability)!;
}

function dispatchPreflightError(): AppError {
  return new AppError({
    code: "RECOVERY_EVIDENCE_DISPATCH_PREFLIGHT_INVALID",
    message: "Recovery evidence dispatch preflight is invalid.",
    statusCode: 409,
    details: [],
  });
}
