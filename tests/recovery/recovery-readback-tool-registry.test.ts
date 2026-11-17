import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

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
} from "../../src/recovery/recovery-contract-errors.js";
import type { RecoveryEvidenceEnvelope } from "../../src/recovery/recovery-evidence.js";
import {
  assertRecoveryEvidenceDispatchPreflightCapability,
  prepareRecoveryEvidenceDispatchPreflight,
} from "../../src/recovery/recovery-evidence-dispatch-preflight.js";
import {
  RecoveryReadbackToolRegistry,
  computeRecoveryReadbackAllowlistVersion,
  type RecoveryReadbackAllowlistContractMetadata,
  type RecoveryReadbackOriginalWriteContext,
  type RecoveryReadbackRequestContext,
  type RecoveryReadbackToolDefinition,
} from "../../src/recovery/recovery-readback-tool-registry.js";
import { computeToolInputSchemaHash } from "../../src/tools/fingerprint.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const inputSchema = z
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
    receipt: z.string().trim().min(1),
    resourceVersion: z.string().trim().min(1).nullable(),
    resourceEtag: z.string().trim().min(1).nullable(),
  })
  .strict();

const manifest: RecoveryEvidenceEnvelope = {
  schemaVersion: "forgeflow.recovery-evidence.v1",
  evidenceRef: "evidence://readback/1",
  sourceType: "system_verification",
  outcome: "observed_succeeded",
  sourceObservedAt: "2026-11-07T01:00:00.000Z",
  submittedAt: "2026-11-07T01:01:00.000Z",
  verifiedAt: null,
  resourceRef: "inventory://part/STM32",
  resourceVersion: "7",
  taskId: "task-readback",
  toolRunId: "write-run-readback",
  toolName: "inventory_update",
  toolVersion: "1",
  inputSchemaHash: `sha256:${"a".repeat(64)}`,
  canonicalInputHash: `sha256:${"b".repeat(64)}`,
  idempotencyKey: `sha256:${"c".repeat(64)}`,
  actorId: null,
  verifierId: "host_verifier",
  verificationId: "verification-readback",
  payloadType: "json",
  payloadDigestProtocol: "jcs-sha256-v1",
  payloadDigest: `sha256:${"d".repeat(64)}`,
  redactedSummary: "sanitized",
};

const originalToolRun: RecoveryReadbackOriginalWriteContext = {
  id: "write-run-readback",
  taskId: "task-readback",
  toolName: "inventory_update",
  toolVersion: "1",
  inputSchemaHash: manifest.inputSchemaHash,
  canonicalInputHash: manifest.canonicalInputHash,
  mode: "write",
  status: "unknown",
  input: {
    resourceRef: "inventory://part/STM32",
  },
  idempotencyKey: manifest.idempotencyKey,
};

function requestContext(
  overrides: Partial<RecoveryReadbackRequestContext> = {},
): RecoveryReadbackRequestContext {
  return {
    taskId: "task-readback",
    reviewId: "review-readback",
    evidenceSubmissionId: "submission-readback",
    verificationCheckId: "check-readback",
    readbackRequestId: "readback-request",
    expectedResourceVersion: null,
    expectedEtag: null,
    ...overrides,
  };
}

function definition(
  overrides: Partial<RecoveryReadbackToolDefinition> = {},
): RecoveryReadbackToolDefinition {
  const base: Omit<
    RecoveryReadbackToolDefinition,
    "allowlistVersion"
  > = {
    protocolVersion: "forgeflow.recovery-readback-contract.v1",
    sourceResolverId: "inventory_source",
    sourceResolverVersion: "1",
    argumentBuilderId: "inventory_arguments",
    argumentBuilderVersion: "1",
    name: "inventory_lookup",
    version: "2",
    schemaHash: computeToolInputSchemaHash(inputSchema),
    allowlistId: "inventory_readback",
    resultSchemaId: "inventory_result",
    resultSchemaVersion: "1",
    resultSchemaHash: computeToolInputSchemaHash(resultSchema),
    resourceMetadataExtractorId: "inventory_metadata",
    resourceMetadataExtractorVersion: "1",
    allowedResourceSchemes: ["inventory"],
    mode: "read",
    retrySafety: "immutable",
    consistencyMode: "immutable_version",
    inputSchema,
    timeoutMs: 1_000,
    maximumPayloadBytes: 1_024,
    sensitiveOutputPolicy: {
      classification: "internal",
      mode: "allow",
      redactionProfile: null,
    },
    resolveSource: (run, evidence) => {
      expect(Object.isFrozen(run)).toBe(true);
      expect(Object.isFrozen(evidence)).toBe(true);
      const input = run.input as {
        readonly resourceRef: string;
      };
      return {
        resourceRef: input.resourceRef,
        resourceVersionHint: evidence.resourceVersion,
        resourceEtagHint: null,
      };
    },
    buildArguments: (evidence, context, source) => {
      const candidate: Record<string, unknown> = {
        resourceRef: source.resourceRef,
        limit: 10,
      };
      if (context.expectedResourceVersion !== null) {
        candidate.expectedVersion = context.expectedResourceVersion;
      }
      if (context.expectedEtag !== null) {
        candidate.expectedEtag = context.expectedEtag;
      }
      void evidence;
      return candidate;
    },
    resultSchema,
    extractResultMetadata: (result) => {
      const parsed = result as z.output<typeof resultSchema>;
      return {
        resourceVersion: parsed.resourceVersion,
        resourceEtag: parsed.resourceEtag,
      };
    },
  };
  const merged = {
    ...base,
    ...overrides,
  };
  const contract = contractMetadata(merged);
  return {
    ...merged,
    allowlistVersion:
      overrides.allowlistVersion ??
      computeRecoveryReadbackAllowlistVersion(contract),
  };
}

function contractMetadata(
  tool: Omit<RecoveryReadbackToolDefinition, "allowlistVersion">,
): RecoveryReadbackAllowlistContractMetadata {
  return {
    protocolVersion: tool.protocolVersion,
    allowlistId: tool.allowlistId,
    sourceResolverId: tool.sourceResolverId,
    sourceResolverVersion: tool.sourceResolverVersion,
    argumentBuilderId: tool.argumentBuilderId,
    argumentBuilderVersion: tool.argumentBuilderVersion,
    toolName: tool.name,
    toolVersion: tool.version,
    toolInputSchemaHash: tool.schemaHash,
    resultSchemaId: tool.resultSchemaId,
    resultSchemaVersion: tool.resultSchemaVersion,
    resultSchemaHash: tool.resultSchemaHash,
    resourceMetadataExtractorId:
      tool.resourceMetadataExtractorId,
    resourceMetadataExtractorVersion:
      tool.resourceMetadataExtractorVersion,
    allowedResourceSchemes: [...tool.allowedResourceSchemes],
    retrySafety: tool.retrySafety,
    consistencyMode: tool.consistencyMode,
    timeoutMs: tool.timeoutMs,
    maximumPayloadBytes: tool.maximumPayloadBytes,
    sensitiveOutputPolicy: tool.sensitiveOutputPolicy,
  };
}

function createRegistry(
  options: {
    readonly mode?: "read" | "write";
    readonly version?: string;
    readonly schema?: z.ZodType<unknown>;
  } = {},
): {
  readonly tools: ToolRegistry;
  readonly allowlists: RecoveryReadbackToolRegistry;
  readonly execute: ReturnType<typeof vi.fn>;
} {
  const execute = vi.fn(async () => ({ status: "ok" }));
  const tools = new ToolRegistry();
  tools.register({
    name: "inventory_lookup",
    description: "Read inventory state.",
    mode: options.mode ?? "read",
    version: options.version ?? "2",
    timeoutMs: 1_000,
    inputSchema: options.schema ?? inputSchema,
    execute,
  });
  return {
    tools,
    allowlists: new RecoveryReadbackToolRegistry(tools),
    execute,
  };
}

describe("RecoveryReadbackToolRegistry", () => {
  it("builds an exact dispatch preflight from the immutable contract", () => {
    const fixture = createRegistry();
    const allowlist = definition();
    fixture.allowlists.register(allowlist);

    const capability = prepareRecoveryEvidenceDispatchPreflight({
      registry: fixture.allowlists,
      allowlistId: allowlist.allowlistId,
      expectedAllowlistContractDigest:
        allowlist.allowlistVersion,
    });

    expect(
      assertRecoveryEvidenceDispatchPreflightCapability(capability),
    ).toEqual({
      allowlistId: allowlist.allowlistId,
      allowlistVersion: allowlist.allowlistVersion,
      allowlistContractDigest: allowlist.allowlistVersion,
      readToolName: allowlist.name,
      readToolVersion: allowlist.version,
      readToolSchemaHash: allowlist.schemaHash,
      retrySafety: allowlist.retrySafety,
      consistencyMode: allowlist.consistencyMode,
    });
    expect(Object.isFrozen(capability)).toBe(true);
    expect(() =>
      assertRecoveryEvidenceDispatchPreflightCapability({}),
    ).toThrow(/preflight is invalid/i);
    expect(() =>
      assertRecoveryEvidenceDispatchPreflightCapability({
        ...capability,
      }),
    ).toThrow(/preflight is invalid/i);
    expect(() =>
      assertRecoveryEvidenceDispatchPreflightCapability(
        JSON.parse(JSON.stringify(capability)) as unknown,
      ),
    ).toThrow(/preflight is invalid/i);
    expect(() =>
      assertRecoveryEvidenceDispatchPreflightCapability({
        registry: fixture.allowlists,
        allowlistId: allowlist.allowlistId,
        expectedAllowlistContractDigest:
          allowlist.allowlistVersion,
      } as never),
    ).toThrow(/preflight is invalid/i);
    expect(() =>
      prepareRecoveryEvidenceDispatchPreflight({
        registry: {
          getExact: () => allowlist,
        } as never,
        allowlistId: allowlist.allowlistId,
        expectedAllowlistContractDigest:
          allowlist.allowlistVersion,
      }),
    ).toThrow(/preflight is invalid/i);
  });

  it("registers immutable versions and prepares host-built arguments without execution", async () => {
    const fixture = createRegistry();
    const v1 = definition();
    const v2 = definition({
      maximumPayloadBytes: 2_048,
    });
    fixture.allowlists.register(v1);
    fixture.allowlists.register(v2);

    expect(fixture.allowlists.listVersions("inventory_readback")).toEqual(
      [v1.allowlistVersion, v2.allowlistVersion].sort(),
    );
    expect(() =>
      fixture.allowlists.get("inventory_readback"),
    ).toThrow(RecoveryReadbackVersionRequiredError);

    const immutable = await fixture.allowlists.prepareArguments(
      v1.allowlistId,
      v1.allowlistVersion,
      manifest,
      requestContext(),
      originalToolRun,
    );
    expect(immutable).toMatchObject({
      protocolVersion:
        "forgeflow.recovery-readback-contract.v1",
      allowlistId: v1.allowlistId,
      allowlistVersion: v1.allowlistVersion,
      toolName: v1.name,
      toolVersion: v1.version,
      inputSchemaHash: v1.schemaHash,
      resolvedSource: {
        resourceRef: "inventory://part/STM32",
        resourceVersionHint: "7",
      },
    });
    expect(immutable.validatedInput.value).toMatchObject({
      resourceRef: "inventory://part/STM32",
      limit: 10,
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("binds every contract field into the allowlist version digest", () => {
    const base = definition();
    const variants = [
      definition({ timeoutMs: 2_000 }),
      definition({ maximumPayloadBytes: 2_048 }),
      definition({
        sensitiveOutputPolicy: {
          classification: "confidential",
          mode: "redact",
          redactionProfile: "secrets-v1",
        },
      }),
      definition({ sourceResolverId: "other_source" }),
      definition({ sourceResolverVersion: "2" }),
      definition({ argumentBuilderId: "other_builder" }),
      definition({ argumentBuilderVersion: "2" }),
      definition({ resultSchemaId: "other_result" }),
      definition({ resultSchemaVersion: "2" }),
      definition({
        resourceMetadataExtractorId: "other_extractor",
      }),
      definition({
        resourceMetadataExtractorVersion: "2",
      }),
      definition({
        allowedResourceSchemes: ["ledger"],
      }),
    ];

    for (const variant of variants) {
      expect(variant.allowlistVersion).not.toBe(
        base.allowlistVersion,
      );
    }
    expect(
      computeRecoveryReadbackAllowlistVersion(
        contractMetadata(base),
      ),
    ).toBe(base.allowlistVersion);
  });

  it("rejects a mismatched allowlist version and duplicate version", () => {
    const fixture = createRegistry();
    const current = definition();
    const changedContract = definition({
      timeoutMs: 2_000,
      allowlistVersion: current.allowlistVersion,
    });

    expect(() =>
      fixture.allowlists.register(changedContract),
    ).toThrow(RecoveryReadbackVersionMismatchError);

    fixture.allowlists.register(current);
    expect(() =>
      fixture.allowlists.register(current),
    ).toThrow(RecoveryReadbackAlreadyRegisteredError);
  });

  it("rejects invalid component metadata and result schema hash", () => {
    const fixture = createRegistry();
    const missingResolver = {
      ...definition(),
      sourceResolverId: "",
    } as RecoveryReadbackToolDefinition;
    expect(() =>
      fixture.allowlists.register(missingResolver),
    ).toThrow(RecoveryReadbackDefinitionInvalidError);

    expect(() =>
      fixture.allowlists.register(
        definition({
          resultSchemaHash: `sha256:${"f".repeat(64)}`,
        }),
      ),
    ).toThrow(RecoveryReadbackToolMismatchError);

    expect(() =>
      fixture.allowlists.register(
        {
          ...definition(),
          sensitiveOutputPolicy: {
            classification: "confidential",
            mode: "redact",
            redactionProfile: null,
          },
        },
      ),
    ).toThrow(RecoveryReadbackDefinitionInvalidError);
  });

  it("rejects write tools and forbidden retry/consistency modes", () => {
    const writeFixture = createRegistry({ mode: "write" });
    expect(() =>
      writeFixture.allowlists.register(definition()),
    ).toThrow(RecoveryReadbackToolMismatchError);

    const fixture = createRegistry();
    expect(() =>
      fixture.allowlists.register({
        ...definition(),
        retrySafety: "mutable_current_state",
      } as unknown as RecoveryReadbackToolDefinition),
    ).toThrow(RecoveryReadbackDefinitionInvalidError);
    expect(() =>
      fixture.allowlists.register({
        ...definition(),
        consistencyMode: "current_state_only",
      } as unknown as RecoveryReadbackToolDefinition),
    ).toThrow(RecoveryReadbackDefinitionInvalidError);
    expect(() =>
      fixture.allowlists.register(
        definition({
          retrySafety: "version_conditional",
          consistencyMode: "immutable_version",
        }),
      ),
    ).toThrow(RecoveryReadbackDefinitionInvalidError);
  });

  it("rejects registry version, input schema hash, and timeout mismatches", () => {
    const versionFixture = createRegistry({ version: "3" });
    expect(() =>
      versionFixture.allowlists.register(definition()),
    ).toThrow(RecoveryReadbackToolMismatchError);

    const schemaFixture = createRegistry();
    expect(() =>
      schemaFixture.allowlists.register(
        definition({
          schemaHash: `sha256:${"f".repeat(64)}`,
        }),
      ),
    ).toThrow(RecoveryReadbackToolMismatchError);
    expect(() =>
      schemaFixture.allowlists.register(
        definition({
          timeoutMs: 2_000,
        }),
      ),
    ).toThrow(RecoveryReadbackToolMismatchError);
  });

  it("rejects generic URL fetching contracts and unsafe resolved sources", async () => {
    const fixture = createRegistry();
    expect(() =>
      fixture.allowlists.register(
        definition({
          name: "fetch_url",
        }),
      ),
    ).toThrow(RecoveryReadbackToolForbiddenError);

    const unsafe = definition({
      resolveSource: () => ({
        resourceRef: "https://untrusted.example",
        resourceVersionHint: null,
        resourceEtagHint: null,
      }),
    });
    fixture.allowlists.register(unsafe);
    await expect(
      fixture.allowlists.prepareArguments(
        unsafe.allowlistId,
        unsafe.allowlistVersion,
        manifest,
        requestContext(),
        originalToolRun,
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackSourceInvalidError);
  });

  it("rejects mismatched original writes and manifest resource bindings", async () => {
    const fixture = createRegistry();
    const current = definition();
    fixture.allowlists.register(current);

    await expect(
      fixture.allowlists.prepareArguments(
        current.allowlistId,
        current.allowlistVersion,
        manifest,
        requestContext(),
        {
          ...originalToolRun,
          id: "different-write-run",
        },
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackSourceInvalidError);

    await expect(
      fixture.allowlists.prepareArguments(
        current.allowlistId,
        current.allowlistVersion,
        {
          ...manifest,
          toolVersion: "2",
        },
        requestContext(),
        originalToolRun,
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackSourceInvalidError);

    const mismatchedSource = definition({
      sourceResolverVersion: "2",
      resolveSource: () => ({
        resourceRef: "inventory://different",
        resourceVersionHint: null,
        resourceEtagHint: null,
      }),
    });
    fixture.allowlists.register(mismatchedSource);
    await expect(
      fixture.allowlists.prepareArguments(
        mismatchedSource.allowlistId,
        mismatchedSource.allowlistVersion,
        manifest,
        requestContext(),
        originalToolRun,
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackSourceInvalidError);
  });

  it("only accepts host-built input through ToolRegistry validation", async () => {
    const fixture = createRegistry();
    const current = definition();
    fixture.allowlists.register(current);

    await expect(
      fixture.allowlists.prepareArguments(
        current.allowlistId,
        current.allowlistVersion,
        manifest,
        {
          ...requestContext(),
          toolName: "fetch_url",
          arguments: { url: "https://untrusted.example" },
        },
        originalToolRun,
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackArgumentsInvalidError);

    const invalidCandidate = definition({
      allowlistId: "invalid_candidate",
      buildArguments: () => ({ unexpected: true }),
    });
    fixture.allowlists.register(invalidCandidate);
    await expect(
      fixture.allowlists.prepareArguments(
        invalidCandidate.allowlistId,
        invalidCandidate.allowlistVersion,
        manifest,
        requestContext(),
        originalToolRun,
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackArgumentsInvalidError);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("enforces version-conditional request binding without executing", async () => {
    const fixture = createRegistry();
    const immutable = definition();
    const versioned = definition({
      allowlistId: "inventory_readback_versioned",
      retrySafety: "version_conditional",
      consistencyMode: "etag_or_resource_version",
    });
    fixture.allowlists.register(immutable);
    fixture.allowlists.register(versioned);

    await expect(
      fixture.allowlists.prepareArguments(
        immutable.allowlistId,
        immutable.allowlistVersion,
        manifest,
        requestContext({ expectedEtag: "unexpected" }),
        originalToolRun,
      ),
    ).rejects.toBeInstanceOf(RecoveryReadbackArgumentsInvalidError);

    const prepared = await fixture.allowlists.prepareArguments(
      versioned.allowlistId,
      versioned.allowlistVersion,
      manifest,
      requestContext({
        expectedResourceVersion: "7",
        expectedEtag: "etag-7",
      }),
      originalToolRun,
    );
    expect(prepared.validatedInput.value).toMatchObject({
      expectedVersion: "7",
      expectedEtag: "etag-7",
    });
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("validates result schema, metadata, and payload size limits", () => {
    const fixture = createRegistry();
    const current = definition({
      maximumPayloadBytes: 256,
    });
    fixture.allowlists.register(current);
    const valid = fixture.allowlists.validateResult(
      current.allowlistId,
      current.allowlistVersion,
      {
        accepted: true,
        receipt: "receipt-1",
        resourceVersion: "7",
        resourceEtag: "etag-7",
      },
    );

    expect(valid.metadata).toEqual({
      resourceVersion: "7",
      resourceEtag: "etag-7",
    });
    expect(valid.canonicalBytes).toBeGreaterThan(0);
    expect(
      fixture.allowlists.validateResult(
        current.allowlistId,
        current.allowlistVersion,
        {
          accepted: true,
          receipt: "receipt-2",
          resourceVersion: null,
          resourceEtag: null,
        },
      ).metadata,
    ).toEqual({
      resourceVersion: null,
      resourceEtag: null,
    });
    expect(() =>
      fixture.allowlists.validateResult(
        current.allowlistId,
        current.allowlistVersion,
        {
          accepted: "yes",
          receipt: "receipt-1",
          resourceVersion: "7",
          resourceEtag: "etag-7",
        },
      ),
    ).toThrow(RecoveryReadbackResultContractInvalidError);
    expect(() =>
      fixture.allowlists.validateResult(
        current.allowlistId,
        current.allowlistVersion,
        {
          accepted: true,
          receipt: "x".repeat(200),
          resourceVersion: "7",
          resourceEtag: "etag-7",
        },
      ),
    ).toThrow(RecoveryReadbackResultContractInvalidError);
    expect(fixture.execute).not.toHaveBeenCalled();
  });

  it("fails closed for missing historical exact versions", () => {
    const fixture = createRegistry();
    const current = definition();
    fixture.allowlists.register(current);

    expect(() =>
      fixture.allowlists.getExact(
        current.allowlistId,
        "f".repeat(64),
      ),
    ).toThrow(RecoveryReadbackNotFoundError);
  });
});
