import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
} from "../shared/canonical-json.js";
import {
  ToolInputValidationError,
  ToolNotFoundError,
} from "../tools/errors.js";
import type { ValidatedToolInput } from "../tools/types.js";
import {
  JsonValueSchema,
  type ToolRunRecord,
} from "../storage/types.js";
import { computeToolInputSchemaHash } from "../tools/fingerprint.js";
import { ToolRegistry } from "../tools/registry.js";
import { ToolNameSchema } from "../shared/tool-name.js";
import {
  RecoveryReadbackAlreadyRegisteredError,
  RecoveryReadbackArgumentsInvalidError,
  RecoveryReadbackDefinitionInvalidError,
  RecoveryReadbackNotFoundError,
  RecoveryReadbackResultContractInvalidError,
  RecoveryReadbackSourceInvalidError,
  RecoveryReadbackToolForbiddenError,
  RecoveryReadbackToolMismatchError,
  RecoveryReadbackVersionMismatchError,
  RecoveryReadbackVersionRequiredError,
} from "./recovery-contract-errors.js";
import {
  RecoveryEvidenceEnvelopeSchema,
  type RecoveryEvidenceEnvelope,
} from "./recovery-evidence.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const AllowlistVersionSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const RecoveryReadbackProtocolVersionSchema = z.literal(
  "forgeflow.recovery-readback-contract.v1",
);

const RecoveryReadbackComponentIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(/^[a-z0-9][a-z0-9._-]*$/);

const RecoveryReadbackComponentVersionSchema = z
  .string()
  .trim()
  .min(1)
  .max(64);

export const RecoveryReadbackAllowlistIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Allowlist ids must use lowercase host-stable identifiers.",
  );

export const RecoveryReadbackRetrySafetySchema = z.enum([
  "immutable",
  "version_conditional",
]);

export const RecoveryReadbackConsistencyModeSchema = z.enum([
  "immutable_version",
  "etag_or_resource_version",
]);

export const RecoveryReadbackSensitiveOutputPolicySchema = z
  .object({
    classification: z.enum(["public", "internal", "confidential"]),
    mode: z.enum(["allow", "redact", "reject"]),
    redactionProfile: z.string().trim().min(1).max(128).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.mode === "redact") !==
      (value.redactionProfile !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["redactionProfile"],
        message:
          "Only redact mode requires a redaction profile.",
      });
    }
  });

export const RecoveryReadbackResolvedSourceSchema = z
  .object({
    resourceRef: z
      .string()
      .trim()
      .min(1)
      .regex(/^[a-z][a-z0-9+.-]*:\/\/.+$/)
      .refine(
        (value) => {
          const scheme = value.slice(0, value.indexOf(":"));
          return !["http", "https", "file", "ftp"].includes(scheme);
        },
        "Generic network and filesystem resources are not allowed.",
      ),
    resourceVersionHint: z.string().trim().min(1).nullable(),
    resourceEtagHint: z.string().trim().min(1).nullable(),
  })
  .strict();

export const RecoveryReadbackOriginalWriteContextSchema = z.object({
  id: z.string().min(1),
  taskId: z.string().min(1),
  toolName: z.string().trim().min(1),
  toolVersion: z.string().trim().min(1),
  inputSchemaHash: Sha256DigestSchema,
  canonicalInputHash: Sha256DigestSchema,
  mode: z.literal("write"),
  status: z.literal("unknown"),
  input: JsonValueSchema,
  idempotencyKey: Sha256DigestSchema,
});

export const RecoveryReadbackResultMetadataSchema = z
  .object({
    resourceVersion: z.string().trim().min(1).nullable(),
    resourceEtag: z.string().trim().min(1).nullable(),
  })
  .strict();

export const RecoveryReadbackValidatedResultSchema = z
  .object({
    result: z.unknown(),
    metadata: RecoveryReadbackResultMetadataSchema,
    canonicalBytes: z.number().int().nonnegative(),
  })
  .strict();

export const RecoveryReadbackRequestContextSchema = z
  .object({
    taskId: z.string().trim().min(1),
    reviewId: z.string().trim().min(1),
    evidenceSubmissionId: z.string().trim().min(1),
    verificationCheckId: z.string().trim().min(1),
    readbackRequestId: z.string().trim().min(1),
    expectedResourceVersion: z.string().trim().min(1).nullable().default(null),
    expectedEtag: z.string().trim().min(1).nullable().default(null),
  })
  .strict();

const ZodSchemaBoundary = z.custom<z.ZodType<unknown>>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    "safeParseAsync" in value &&
    typeof value.safeParseAsync === "function",
  "Expected a Zod input schema.",
);

const BuildArgumentsBoundary = z.custom<
  RecoveryReadbackToolDefinition["buildArguments"]
>(
  (value) => typeof value === "function",
  "Expected a host buildArguments function.",
);

const SourceResolverBoundary = z.custom<
  RecoveryReadbackToolDefinition["resolveSource"]
>(
  (value) => typeof value === "function",
  "Expected a host source resolver function.",
);

const ResultMetadataExtractorBoundary = z.custom<
  RecoveryReadbackToolDefinition["extractResultMetadata"]
>(
  (value) => typeof value === "function",
  "Expected a host result metadata extractor function.",
);

const RecoveryReadbackResourceSchemeSchema = z
  .string()
  .regex(/^[a-z][a-z0-9+.-]*$/)
  .refine(
    (scheme) =>
      !["http", "https", "file", "ftp"].includes(scheme),
    "Generic network and filesystem schemes are forbidden.",
  );

export const RecoveryReadbackAllowedResourceSchemesSchema = z
  .array(RecoveryReadbackResourceSchemeSchema)
  .min(1)
  .max(16)
  .refine(
    (values) => new Set(values).size === values.length,
    "Allowed resource schemes must be unique.",
  );

export const RecoveryReadbackToolDefinitionSchema = z
  .object({
    protocolVersion: RecoveryReadbackProtocolVersionSchema,
    sourceResolverId: RecoveryReadbackComponentIdSchema,
    sourceResolverVersion: RecoveryReadbackComponentVersionSchema,
    argumentBuilderId: RecoveryReadbackComponentIdSchema,
    argumentBuilderVersion: RecoveryReadbackComponentVersionSchema,
    name: ToolNameSchema,
    version: z.string().trim().min(1).max(64),
    schemaHash: Sha256DigestSchema,
    allowlistId: RecoveryReadbackAllowlistIdSchema,
    allowlistVersion: AllowlistVersionSchema,
    resultSchemaId: RecoveryReadbackComponentIdSchema,
    resultSchemaVersion: RecoveryReadbackComponentVersionSchema,
    resultSchemaHash: Sha256DigestSchema,
    resourceMetadataExtractorId:
      RecoveryReadbackComponentIdSchema,
    resourceMetadataExtractorVersion:
      RecoveryReadbackComponentVersionSchema,
    allowedResourceSchemes:
      RecoveryReadbackAllowedResourceSchemesSchema,
    mode: z.literal("read"),
    retrySafety: RecoveryReadbackRetrySafetySchema,
    consistencyMode: RecoveryReadbackConsistencyModeSchema,
    inputSchema: ZodSchemaBoundary,
    timeoutMs: z.number().int().positive(),
    maximumPayloadBytes: z.number().int().positive(),
    sensitiveOutputPolicy:
      RecoveryReadbackSensitiveOutputPolicySchema,
    resolveSource: SourceResolverBoundary,
    buildArguments: BuildArgumentsBoundary,
    resultSchema: ZodSchemaBoundary,
    extractResultMetadata: ResultMetadataExtractorBoundary,
  })
  .strict()
  .superRefine((value, context) => {
    const expectedConsistency =
      value.retrySafety === "immutable"
        ? "immutable_version"
        : "etag_or_resource_version";
    if (value.consistencyMode !== expectedConsistency) {
      context.addIssue({
        code: "custom",
        path: ["consistencyMode"],
        message: "retrySafety and consistencyMode are incompatible.",
      });
    }
    if (value.maximumPayloadBytes <= 0) {
      context.addIssue({
        code: "custom",
        path: ["maximumPayloadBytes"],
        message: "Maximum payload bytes must be positive.",
      });
    }
  });

export const RecoveryReadbackPreparedInvocationSchema = z
  .object({
    protocolVersion: RecoveryReadbackProtocolVersionSchema,
    allowlistId: RecoveryReadbackAllowlistIdSchema,
    allowlistVersion: AllowlistVersionSchema,
    toolName: ToolNameSchema,
    toolVersion: z.string().trim().min(1),
    inputSchemaHash: Sha256DigestSchema,
    resolvedSource: RecoveryReadbackResolvedSourceSchema,
    validatedInput: z.custom<ValidatedToolInput>(
      (value) =>
        typeof value === "object" &&
        value !== null &&
        "toolName" in value &&
        "value" in value,
      "Expected a ToolRegistry validated input token.",
    ),
  })
  .strict();

export type RecoveryReadbackRetrySafety = z.infer<
  typeof RecoveryReadbackRetrySafetySchema
>;
export type RecoveryReadbackConsistencyMode = z.infer<
  typeof RecoveryReadbackConsistencyModeSchema
>;
export type RecoveryReadbackSensitiveOutputPolicy = z.infer<
  typeof RecoveryReadbackSensitiveOutputPolicySchema
>;
export type RecoveryReadbackResolvedSource = z.infer<
  typeof RecoveryReadbackResolvedSourceSchema
>;
export type RecoveryReadbackOriginalWriteContext = Pick<
  ToolRunRecord,
  | "id"
  | "taskId"
  | "toolName"
  | "toolVersion"
  | "inputSchemaHash"
  | "canonicalInputHash"
  | "mode"
  | "status"
  | "input"
  | "idempotencyKey"
>;
export type RecoveryReadbackResultMetadata = z.infer<
  typeof RecoveryReadbackResultMetadataSchema
>;
export type RecoveryReadbackValidatedResult = z.infer<
  typeof RecoveryReadbackValidatedResultSchema
>;

export const RecoveryReadbackAllowlistContractMetadataSchema = z
  .object({
    protocolVersion: RecoveryReadbackProtocolVersionSchema,
    allowlistId: RecoveryReadbackAllowlistIdSchema,
    sourceResolverId: RecoveryReadbackComponentIdSchema,
    sourceResolverVersion:
      RecoveryReadbackComponentVersionSchema,
    argumentBuilderId: RecoveryReadbackComponentIdSchema,
    argumentBuilderVersion:
      RecoveryReadbackComponentVersionSchema,
    toolName: ToolNameSchema,
    toolVersion: z.string().trim().min(1).max(64),
    toolInputSchemaHash: Sha256DigestSchema,
    resultSchemaId: RecoveryReadbackComponentIdSchema,
    resultSchemaVersion: RecoveryReadbackComponentVersionSchema,
    resultSchemaHash: Sha256DigestSchema,
    resourceMetadataExtractorId:
      RecoveryReadbackComponentIdSchema,
    resourceMetadataExtractorVersion:
      RecoveryReadbackComponentVersionSchema,
    allowedResourceSchemes:
      RecoveryReadbackAllowedResourceSchemesSchema,
    retrySafety: RecoveryReadbackRetrySafetySchema,
    consistencyMode: RecoveryReadbackConsistencyModeSchema,
    timeoutMs: z.number().int().positive(),
    maximumPayloadBytes: z.number().int().positive(),
    sensitiveOutputPolicy:
      RecoveryReadbackSensitiveOutputPolicySchema,
  })
  .strict();

export type RecoveryReadbackAllowlistContractMetadata = z.input<
  typeof RecoveryReadbackAllowlistContractMetadataSchema
>;
export type RecoveryReadbackRequestContext = z.infer<
  typeof RecoveryReadbackRequestContextSchema
>;
export type RecoveryReadbackPreparedInvocation = z.infer<
  typeof RecoveryReadbackPreparedInvocationSchema
>;

export interface RecoveryReadbackToolDefinition {
  readonly protocolVersion: "forgeflow.recovery-readback-contract.v1";
  readonly sourceResolverId: string;
  readonly sourceResolverVersion: string;
  readonly argumentBuilderId: string;
  readonly argumentBuilderVersion: string;
  readonly name: string;
  readonly version: string;
  readonly schemaHash: string;
  readonly allowlistId: string;
  readonly allowlistVersion: string;
  readonly resultSchemaId: string;
  readonly resultSchemaVersion: string;
  readonly resultSchemaHash: string;
  readonly resourceMetadataExtractorId: string;
  readonly resourceMetadataExtractorVersion: string;
  readonly allowedResourceSchemes: readonly string[];
  readonly mode: "read";
  readonly retrySafety: RecoveryReadbackRetrySafety;
  readonly consistencyMode: RecoveryReadbackConsistencyMode;
  readonly inputSchema: z.ZodType<unknown>;
  readonly timeoutMs: number;
  readonly maximumPayloadBytes: number;
  readonly sensitiveOutputPolicy:
    RecoveryReadbackSensitiveOutputPolicy;
  resolveSource(
    originalToolRun: RecoveryReadbackOriginalWriteContext,
    manifest: RecoveryEvidenceEnvelope,
  ): RecoveryReadbackResolvedSource;
  buildArguments(
    manifest: RecoveryEvidenceEnvelope,
    requestContext: RecoveryReadbackRequestContext,
    resolvedSource: RecoveryReadbackResolvedSource,
  ): unknown | Promise<unknown>;
  readonly resultSchema: z.ZodType<unknown>;
  extractResultMetadata(
    result: unknown,
  ): RecoveryReadbackResultMetadata;
}

export interface RegisteredRecoveryReadbackTool
  extends RecoveryReadbackToolDefinition {
  readonly allowlistId: string;
  readonly buildArguments: RecoveryReadbackToolDefinition["buildArguments"];
}

const FORBIDDEN_RECOVERY_TOOL_NAME_PATTERN =
  /(?:^|_)(?:fetch|url|http|https)(?:_|$)/;
const FORBIDDEN_URL_PROPERTY_NAMES = new Set([
  "url",
  "uri",
  "href",
  "endpoint",
]);

function toDetails(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): readonly { path: string; message: string }[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "definition",
    message: issue.message,
  }));
}

function containsForbiddenUrlProperty(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(containsForbiddenUrlProperty);
  }
  if (value === null || typeof value !== "object") {
    return false;
  }

  for (const [key, child] of Object.entries(value)) {
    if (
      key === "properties" &&
      child !== null &&
      typeof child === "object" &&
      !Array.isArray(child) &&
      Object.keys(child).some((property) =>
        FORBIDDEN_URL_PROPERTY_NAMES.has(property.toLowerCase()),
      )
    ) {
      return true;
    }
    if (containsForbiddenUrlProperty(child)) {
      return true;
    }
  }
  return false;
}

function assertContextMatchesRetrySafety(
  definition: RegisteredRecoveryReadbackTool,
  context: RecoveryReadbackRequestContext,
): void {
  const hasExpectedBinding =
    context.expectedResourceVersion !== null || context.expectedEtag !== null;
  if (definition.retrySafety === "immutable") {
    if (hasExpectedBinding) {
      throw new RecoveryReadbackArgumentsInvalidError(definition.allowlistId, [
        {
          path: "requestContext",
          message: "Immutable readback must not define version expectations.",
        },
      ]);
    }
    return;
  }

  if (!hasExpectedBinding) {
    throw new RecoveryReadbackArgumentsInvalidError(definition.allowlistId, [
      {
        path: "requestContext",
        message:
          "version_conditional readback requires an expected version or ETag.",
      },
    ]);
  }
}

function safeToolInputDetails(
  allowlistId: string,
  error: unknown,
): never {
  const details =
    error instanceof ToolInputValidationError
      ? error.details
      : [
          {
            path: "arguments",
            message: "Host buildArguments did not produce valid tool input.",
          },
        ];
  throw new RecoveryReadbackArgumentsInvalidError(allowlistId, details);
}

export function computeRecoveryReadbackAllowlistVersion(
  input: RecoveryReadbackAllowlistContractMetadata,
): string {
  // This binds Host-declared metadata and schema hashes, not callback code bytes.
  // Host release governance must keep code and metadata versioned together.
  const parsed =
    RecoveryReadbackAllowlistContractMetadataSchema.parse(input);
  return sha256CanonicalJson([
    "forgeflow.recovery-readback-allowlist-contract.v1",
    {
      protocolVersion: parsed.protocolVersion,
      allowlistId: parsed.allowlistId,
      sourceResolverId: parsed.sourceResolverId,
      sourceResolverVersion: parsed.sourceResolverVersion,
      argumentBuilderId: parsed.argumentBuilderId,
      argumentBuilderVersion: parsed.argumentBuilderVersion,
      toolName: parsed.toolName,
      toolVersion: parsed.toolVersion,
      toolInputSchemaHash: parsed.toolInputSchemaHash,
      resultSchemaId: parsed.resultSchemaId,
      resultSchemaVersion: parsed.resultSchemaVersion,
      resultSchemaHash: parsed.resultSchemaHash,
      resourceMetadataExtractorId:
        parsed.resourceMetadataExtractorId,
      resourceMetadataExtractorVersion:
        parsed.resourceMetadataExtractorVersion,
      allowedResourceSchemes: parsed.allowedResourceSchemes,
      retrySafety: parsed.retrySafety,
      consistencyMode: parsed.consistencyMode,
      timeoutMs: parsed.timeoutMs,
      maximumPayloadBytes: parsed.maximumPayloadBytes,
      sensitiveOutputPolicy:
        parsed.sensitiveOutputPolicy,
    },
  ]).slice("sha256:".length);
}

export class RecoveryReadbackToolRegistry {
  private readonly definitions = new Map<
    string,
    Map<string, RegisteredRecoveryReadbackTool>
  >();

  constructor(private readonly tools: ToolRegistry) {}

  register(definition: RecoveryReadbackToolDefinition): void {
    let parsed: z.output<typeof RecoveryReadbackToolDefinitionSchema>;
    try {
      parsed = RecoveryReadbackToolDefinitionSchema.parse(definition);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new RecoveryReadbackDefinitionInvalidError(
          toDetails(error.issues),
        );
      }
      throw error;
    }

    const contractVersion =
      computeRecoveryReadbackAllowlistVersion({
        protocolVersion: parsed.protocolVersion,
        allowlistId: parsed.allowlistId,
        sourceResolverId: parsed.sourceResolverId,
        sourceResolverVersion: parsed.sourceResolverVersion,
        argumentBuilderId: parsed.argumentBuilderId,
        argumentBuilderVersion: parsed.argumentBuilderVersion,
        toolName: parsed.name,
        toolVersion: parsed.version,
        toolInputSchemaHash: parsed.schemaHash,
        resultSchemaId: parsed.resultSchemaId,
        resultSchemaVersion: parsed.resultSchemaVersion,
        resultSchemaHash: parsed.resultSchemaHash,
        resourceMetadataExtractorId:
          parsed.resourceMetadataExtractorId,
        resourceMetadataExtractorVersion:
          parsed.resourceMetadataExtractorVersion,
        allowedResourceSchemes: parsed.allowedResourceSchemes,
        retrySafety: parsed.retrySafety,
        consistencyMode: parsed.consistencyMode,
        timeoutMs: parsed.timeoutMs,
        maximumPayloadBytes: parsed.maximumPayloadBytes,
        sensitiveOutputPolicy: parsed.sensitiveOutputPolicy,
      });
    if (contractVersion !== parsed.allowlistVersion) {
      throw new RecoveryReadbackVersionMismatchError(
        parsed.allowlistId,
      );
    }

    const versions = this.definitions.get(parsed.allowlistId);
    if (versions?.has(parsed.allowlistVersion)) {
      throw new RecoveryReadbackAlreadyRegisteredError(parsed.allowlistId);
    }
    if (FORBIDDEN_RECOVERY_TOOL_NAME_PATTERN.test(parsed.name)) {
      throw new RecoveryReadbackToolForbiddenError(parsed.name);
    }

    try {
      if (
        containsForbiddenUrlProperty(
          z.toJSONSchema(parsed.inputSchema, {
            target: "draft-07",
            io: "input",
            unrepresentable: "throw",
          }),
        )
      ) {
        throw new RecoveryReadbackToolForbiddenError(parsed.name);
      }
    } catch (error) {
      if (error instanceof RecoveryReadbackToolForbiddenError) {
        throw error;
      }
      throw new RecoveryReadbackDefinitionInvalidError([
        {
          path: "inputSchema",
          message: "Recovery readback input schema is not representable.",
        },
      ]);
    }

    let registeredTool: ReturnType<ToolRegistry["get"]>;
    try {
      registeredTool = this.tools.get(parsed.name);
    } catch (error) {
      if (error instanceof ToolNotFoundError) {
        throw new RecoveryReadbackToolMismatchError(parsed.allowlistId, [
          {
            path: "name",
            message: "Recovery readback tool must already exist in ToolRegistry.",
          },
        ]);
      }
      throw error;
    }

    const details: { path: string; message: string }[] = [];
    const definitionHash = (() => {
      try {
        return computeToolInputSchemaHash(parsed.inputSchema);
      } catch {
        details.push({
          path: "inputSchema",
          message: "Recovery readback input schema is not hashable.",
        });
        return null;
      }
    })();
    const resultSchemaHash = (() => {
      try {
        return computeToolInputSchemaHash(parsed.resultSchema);
      } catch {
        details.push({
          path: "resultSchema",
          message: "Recovery readback result schema is not hashable.",
        });
        return null;
      }
    })();

    if (registeredTool.mode !== "read") {
      details.push({
        path: "mode",
        message: "Recovery readback requires a read-only registered tool.",
      });
    }
    if (registeredTool.version !== parsed.version) {
      details.push({
        path: "version",
        message: "ToolRegistry version does not match the allowlist definition.",
      });
    }
    if (registeredTool.timeoutMs !== parsed.timeoutMs) {
      details.push({
        path: "timeoutMs",
        message: "ToolRegistry timeout does not match the allowlist definition.",
      });
    }
    if (
      definitionHash === null ||
      registeredTool.inputSchemaHash !== parsed.schemaHash ||
      definitionHash !== parsed.schemaHash
    ) {
      details.push({
        path: "schemaHash",
        message: "ToolRegistry schema hash does not match the allowlist definition.",
      });
    }
    if (
      resultSchemaHash === null ||
      resultSchemaHash !== parsed.resultSchemaHash
    ) {
      details.push({
        path: "resultSchemaHash",
        message: "Result schema hash does not match the allowlist definition.",
      });
    }
    if (details.length > 0) {
      throw new RecoveryReadbackToolMismatchError(
        parsed.allowlistId,
        details,
      );
    }

    const registered: RegisteredRecoveryReadbackTool = Object.freeze({
      ...parsed,
      buildArguments: parsed.buildArguments,
      resolveSource: parsed.resolveSource,
      resultSchema: parsed.resultSchema,
      extractResultMetadata: parsed.extractResultMetadata,
      sensitiveOutputPolicy: Object.freeze({
        ...parsed.sensitiveOutputPolicy,
      }),
      allowedResourceSchemes: Object.freeze([
        ...parsed.allowedResourceSchemes,
      ]),
    });
    const byVersion =
      this.definitions.get(parsed.allowlistId) ??
      new Map<string, RegisteredRecoveryReadbackTool>();
    byVersion.set(parsed.allowlistVersion, registered);
    this.definitions.set(parsed.allowlistId, byVersion);
  }

  get(allowlistId: string): RegisteredRecoveryReadbackTool {
    const versions = this.definitions.get(allowlistId);
    if (versions === undefined || versions.size === 0) {
      throw new RecoveryReadbackNotFoundError(allowlistId);
    }
    if (versions.size > 1) {
      throw new RecoveryReadbackVersionRequiredError(allowlistId);
    }
    return versions.values().next().value as RegisteredRecoveryReadbackTool;
  }

  getExact(
    allowlistId: string,
    allowlistVersion: string,
  ): RegisteredRecoveryReadbackTool {
    const definition = this.definitions
      .get(allowlistId)
      ?.get(allowlistVersion);
    if (definition === undefined) {
      throw new RecoveryReadbackNotFoundError(allowlistId);
    }
    return definition;
  }

  listVersions(allowlistId: string): readonly string[] {
    return [
      ...(this.definitions.get(allowlistId)?.keys() ?? []),
    ].sort();
  }

  async prepareArguments(
    allowlistId: string,
    allowlistVersion: string,
    manifest: unknown,
    requestContext: unknown,
    originalToolRun: unknown,
  ): Promise<RecoveryReadbackPreparedInvocation> {
    let parsedManifest: RecoveryEvidenceEnvelope;
    let parsedContext: RecoveryReadbackRequestContext;
    let parsedOriginalToolRun: RecoveryReadbackOriginalWriteContext;
    try {
      parsedManifest = RecoveryEvidenceEnvelopeSchema.parse(manifest);
      parsedContext =
        RecoveryReadbackRequestContextSchema.parse(requestContext);
      parsedOriginalToolRun =
        RecoveryReadbackOriginalWriteContextSchema.parse(
          originalToolRun,
        ) as RecoveryReadbackOriginalWriteContext;
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new RecoveryReadbackArgumentsInvalidError(
          allowlistId,
          toDetails(error.issues),
        );
      }
      throw error;
    }

    const definition = this.getExact(
      allowlistId,
      allowlistVersion,
    );
    if (
      parsedManifest.taskId !== parsedContext.taskId ||
      parsedOriginalToolRun.taskId !== parsedContext.taskId ||
      parsedManifest.toolRunId !== parsedOriginalToolRun.id ||
      parsedManifest.toolName !==
        parsedOriginalToolRun.toolName ||
      parsedManifest.toolVersion !==
        parsedOriginalToolRun.toolVersion ||
      parsedManifest.inputSchemaHash !==
        parsedOriginalToolRun.inputSchemaHash ||
      parsedManifest.canonicalInputHash !==
        parsedOriginalToolRun.canonicalInputHash ||
      parsedManifest.idempotencyKey !==
        parsedOriginalToolRun.idempotencyKey
    ) {
      throw new RecoveryReadbackSourceInvalidError(allowlistId);
    }
    deepFreeze(parsedManifest);
    deepFreeze(parsedContext);
    deepFreeze(parsedOriginalToolRun);
    assertContextMatchesRetrySafety(definition, parsedContext);
    this.assertRegistryMetadataUnchanged(definition);

    let resolvedSource: RecoveryReadbackResolvedSource;
    try {
      resolvedSource = RecoveryReadbackResolvedSourceSchema.parse(
        definition.resolveSource(
          parsedOriginalToolRun,
          parsedManifest,
        ),
      );
    } catch {
      throw new RecoveryReadbackSourceInvalidError(allowlistId);
    }
    const resourceScheme = resolvedSource.resourceRef.slice(
      0,
      resolvedSource.resourceRef.indexOf(":"),
    );
    if (
      !definition.allowedResourceSchemes.includes(resourceScheme)
    ) {
      throw new RecoveryReadbackSourceInvalidError(allowlistId);
    }
    if (
      parsedManifest.resourceRef !== null &&
      parsedManifest.resourceRef !== resolvedSource.resourceRef
    ) {
      throw new RecoveryReadbackSourceInvalidError(allowlistId);
    }
    deepFreeze(resolvedSource);

    let candidate: unknown;
    try {
      candidate = await definition.buildArguments(
        parsedManifest,
        parsedContext,
        resolvedSource,
      );
    } catch {
      throw new RecoveryReadbackArgumentsInvalidError(allowlistId, [
        {
          path: "arguments",
          message: "Host buildArguments failed.",
        },
      ]);
    }

    let validatedInput: ValidatedToolInput;
    try {
      validatedInput = await this.tools.validateInput(
        definition.name,
        candidate,
      );
    } catch (error) {
      safeToolInputDetails(allowlistId, error);
    }

    if (
      validatedInput.toolName !== definition.name ||
      validatedInput.toolVersion !== definition.version ||
      validatedInput.inputSchemaHash !== definition.schemaHash
    ) {
      throw new RecoveryReadbackToolMismatchError(allowlistId, [
        {
          path: "validatedInput",
          message:
            "Validated input token does not match the registered readback tool.",
        },
      ]);
    }

    return Object.freeze(
      RecoveryReadbackPreparedInvocationSchema.parse({
        protocolVersion: definition.protocolVersion,
        allowlistId: definition.allowlistId,
        allowlistVersion: definition.allowlistVersion,
        toolName: definition.name,
        toolVersion: definition.version,
        inputSchemaHash: definition.schemaHash,
        resolvedSource,
        validatedInput,
      }),
    );
  }

  async validatePersistedInput(
    allowlistId: string,
    allowlistVersion: string,
    input: unknown,
  ): Promise<ValidatedToolInput> {
    const definition = this.getExact(
      allowlistId,
      allowlistVersion,
    );
    this.assertRegistryMetadataUnchanged(definition);
    const validatedInput = await this.tools.validateInput(
      definition.name,
      input,
    );
    if (
      validatedInput.toolName !== definition.name ||
      validatedInput.toolVersion !== definition.version ||
      validatedInput.inputSchemaHash !== definition.schemaHash ||
      validatedInput.mode !== "read"
    ) {
      throw new RecoveryReadbackToolMismatchError(
        allowlistId,
        [
          {
            path: "validatedInput",
            message:
              "Persisted input does not match the exact readback tool.",
          },
        ],
      );
    }
    return validatedInput;
  }

  validateResult(
    allowlistId: string,
    allowlistVersion: string,
    result: unknown,
  ): RecoveryReadbackValidatedResult {
    const definition = this.getExact(
      allowlistId,
      allowlistVersion,
    );
    this.assertRegistryMetadataUnchanged(definition);

    let parsedResult: unknown;
    let metadata: RecoveryReadbackResultMetadata;
    try {
      parsedResult = definition.resultSchema.parse(result);
      deepFreeze(parsedResult);
      metadata = RecoveryReadbackResultMetadataSchema.parse(
        definition.extractResultMetadata(parsedResult),
      );
    } catch {
      throw new RecoveryReadbackResultContractInvalidError(
        allowlistId,
      );
    }

    let canonicalBytes: number;
    try {
      canonicalBytes = Buffer.byteLength(
        canonicalJson(parsedResult),
        "utf8",
      );
    } catch {
      throw new RecoveryReadbackResultContractInvalidError(
        allowlistId,
      );
    }
    if (canonicalBytes > definition.maximumPayloadBytes) {
      throw new RecoveryReadbackResultContractInvalidError(
        allowlistId,
      );
    }

    return Object.freeze(
      RecoveryReadbackValidatedResultSchema.parse({
        result: parsedResult,
        metadata: Object.freeze(metadata),
        canonicalBytes,
      }),
    );
  }

  private assertRegistryMetadataUnchanged(
    definition: RegisteredRecoveryReadbackTool,
  ): void {
    let metadata: ReturnType<ToolRegistry["get"]>;
    try {
      metadata = this.tools.get(definition.name);
    } catch {
      throw new RecoveryReadbackToolMismatchError(definition.allowlistId, [
        {
          path: "name",
          message: "Registered tool is no longer available.",
        },
      ]);
    }
    if (
      metadata.version !== definition.version ||
      metadata.inputSchemaHash !== definition.schemaHash ||
      metadata.mode !== "read"
    ) {
      throw new RecoveryReadbackToolMismatchError(definition.allowlistId, [
        {
          path: "registryMetadata",
          message: "Registered tool metadata changed after allowlist creation.",
        },
      ]);
    }
  }
}

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (seen.has(value)) {
    return;
  }
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    deepFreeze(
      (value as Record<PropertyKey, unknown>)[key],
      seen,
    );
  }
  Object.freeze(value);
}
