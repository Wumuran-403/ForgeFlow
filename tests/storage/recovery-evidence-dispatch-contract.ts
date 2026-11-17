import { z } from "zod";

import {
  RecoveryReadbackToolRegistry,
  computeRecoveryReadbackAllowlistVersion,
  type RecoveryReadbackAllowlistContractMetadata,
  type RecoveryReadbackToolDefinition,
} from "../../src/recovery/recovery-readback-tool-registry.js";
import { computeToolInputSchemaHash } from "../../src/tools/fingerprint.js";
import { ToolRegistry } from "../../src/tools/registry.js";

export const DISPATCH_ALLOWLIST_ID = "inventory_readback";
export const DISPATCH_READ_TOOL_NAME = "inventory_lookup";
export const DISPATCH_READ_TOOL_VERSION = "1";

export const DISPATCH_INPUT_SCHEMA = z
  .object({
    resourceRef: z.string().trim().min(1),
    expectedVersion: z.string().trim().min(1).optional(),
    expectedEtag: z.string().trim().min(1).optional(),
    limit: z.number().int().positive(),
  })
  .strict();

const resultSchema = z
  .object({
    accepted: z.boolean(),
    resourceVersion: z.string().trim().min(1).nullable(),
    resourceEtag: z.string().trim().min(1).nullable(),
  })
  .strict();

export const DISPATCH_READ_TOOL_SCHEMA_HASH =
  computeToolInputSchemaHash(DISPATCH_INPUT_SCHEMA);

const definitionWithoutVersion: Omit<
  RecoveryReadbackToolDefinition,
  "allowlistVersion"
> = {
  protocolVersion: "forgeflow.recovery-readback-contract.v1",
  sourceResolverId: "inventory_source",
  sourceResolverVersion: "1",
  argumentBuilderId: "inventory_arguments",
  argumentBuilderVersion: "1",
  name: DISPATCH_READ_TOOL_NAME,
  version: DISPATCH_READ_TOOL_VERSION,
  schemaHash: DISPATCH_READ_TOOL_SCHEMA_HASH,
  allowlistId: DISPATCH_ALLOWLIST_ID,
  resultSchemaId: "inventory_result",
  resultSchemaVersion: "1",
  resultSchemaHash: computeToolInputSchemaHash(resultSchema),
  resourceMetadataExtractorId: "inventory_metadata",
  resourceMetadataExtractorVersion: "1",
  allowedResourceSchemes: ["inventory"],
  mode: "read",
  retrySafety: "version_conditional",
  consistencyMode: "etag_or_resource_version",
  inputSchema: DISPATCH_INPUT_SCHEMA,
  timeoutMs: 1_000,
  maximumPayloadBytes: 16_384,
  sensitiveOutputPolicy: {
    classification: "internal",
    mode: "allow",
    redactionProfile: null,
  },
  resolveSource: (originalToolRun, manifest) => {
    const input = originalToolRun.input as { resourceRef?: unknown };
    if (
      typeof input.resourceRef !== "string" ||
      !input.resourceRef.startsWith("inventory://")
    ) {
      throw new Error("Dispatch fixture source is invalid.");
    }
    return {
      resourceRef: input.resourceRef,
      resourceVersionHint: manifest.resourceVersion,
      resourceEtagHint: null,
    };
  },
  buildArguments: (manifest, requestContext, source) => {
    const arguments_: Record<string, unknown> = {
      resourceRef: source.resourceRef,
      limit: 10,
    };
    if (requestContext.expectedResourceVersion !== null) {
      arguments_.expectedVersion = requestContext.expectedResourceVersion;
    }
    if (requestContext.expectedEtag !== null) {
      arguments_.expectedEtag = requestContext.expectedEtag;
    }
    void manifest;
    return arguments_;
  },
  resultSchema,
  extractResultMetadata: (result) => {
    const parsed = resultSchema.parse(result);
    return {
      resourceVersion: parsed.resourceVersion,
      resourceEtag: parsed.resourceEtag,
    };
  },
};

const contract: RecoveryReadbackAllowlistContractMetadata = {
  protocolVersion: definitionWithoutVersion.protocolVersion,
  allowlistId: definitionWithoutVersion.allowlistId,
  sourceResolverId: definitionWithoutVersion.sourceResolverId,
  sourceResolverVersion: definitionWithoutVersion.sourceResolverVersion,
  argumentBuilderId: definitionWithoutVersion.argumentBuilderId,
  argumentBuilderVersion:
    definitionWithoutVersion.argumentBuilderVersion,
  toolName: definitionWithoutVersion.name,
  toolVersion: definitionWithoutVersion.version,
  toolInputSchemaHash: definitionWithoutVersion.schemaHash,
  resultSchemaId: definitionWithoutVersion.resultSchemaId,
  resultSchemaVersion: definitionWithoutVersion.resultSchemaVersion,
  resultSchemaHash: definitionWithoutVersion.resultSchemaHash,
  resourceMetadataExtractorId:
    definitionWithoutVersion.resourceMetadataExtractorId,
  resourceMetadataExtractorVersion:
    definitionWithoutVersion.resourceMetadataExtractorVersion,
  allowedResourceSchemes: [
    ...definitionWithoutVersion.allowedResourceSchemes,
  ],
  retrySafety: definitionWithoutVersion.retrySafety,
  consistencyMode: definitionWithoutVersion.consistencyMode,
  timeoutMs: definitionWithoutVersion.timeoutMs,
  maximumPayloadBytes: definitionWithoutVersion.maximumPayloadBytes,
  sensitiveOutputPolicy:
    definitionWithoutVersion.sensitiveOutputPolicy,
};

export const DISPATCH_ALLOWLIST_VERSION =
  computeRecoveryReadbackAllowlistVersion(contract);

export function createDispatchReadbackRegistry(): RecoveryReadbackToolRegistry {
  return createDispatchReadbackRegistryVariant({
    maximumPayloadBytes: definitionWithoutVersion.maximumPayloadBytes,
  }).registry;
}

export function createDispatchReadbackRegistryVariant(options: {
  readonly maximumPayloadBytes: number;
}): {
  readonly registry: RecoveryReadbackToolRegistry;
  readonly allowlistVersion: string;
} {
  const tools = new ToolRegistry();
  tools.register({
    name: DISPATCH_READ_TOOL_NAME,
    description: "Read inventory state for Dispatch tests.",
    mode: "read",
    version: DISPATCH_READ_TOOL_VERSION,
    timeoutMs: 1_000,
    inputSchema: DISPATCH_INPUT_SCHEMA,
    execute: async () => {
      throw new Error("Dispatch preflight must not execute the read tool.");
    },
  });
  const registry = new RecoveryReadbackToolRegistry(tools);
  const variantContract = {
    ...contract,
    maximumPayloadBytes: options.maximumPayloadBytes,
  };
  const allowlistVersion =
    computeRecoveryReadbackAllowlistVersion(variantContract);
  registry.register({
    ...definitionWithoutVersion,
    maximumPayloadBytes: options.maximumPayloadBytes,
    allowlistVersion,
  });
  return {
    registry,
    allowlistVersion,
  };
}
