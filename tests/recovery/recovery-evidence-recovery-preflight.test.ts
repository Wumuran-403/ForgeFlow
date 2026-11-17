import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  RecoveryEvidenceReadbackReservationUnitOfWork,
  TaskSnapshotReader,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import {
  RecoveryReadbackToolRegistry,
  computeRecoveryReadbackAllowlistVersion,
  type RecoveryReadbackAllowlistContractMetadata,
  type RecoveryReadbackToolDefinition,
} from "../../src/recovery/recovery-readback-tool-registry.js";
import {
  assertRecoveryEvidenceRecoveryPreflightCapability,
  assessRecoveryEvidenceRetryBinding,
  prepareRecoveryEvidenceRecoveryPreflight,
} from "../../src/recovery/recovery-evidence-recovery-preflight.js";
import * as recoveryPublicApi from "../../src/recovery/index.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  DISPATCH_ALLOWLIST_ID,
  DISPATCH_INPUT_SCHEMA,
  DISPATCH_READ_TOOL_SCHEMA_HASH,
} from "../storage/recovery-evidence-dispatch-contract.js";
import {
  createRecoveryEvidenceUowFixture,
  type RecoveryEvidenceUowFixture,
} from "../storage/recovery-evidence-uow-fixture.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
  vi.restoreAllMocks();
});

describe("RecoveryEvidenceRecoveryPreflight", () => {
  it("issues a capability for an exact historical contract", async () => {
    const prepared = openPreflightFixture("preflight-pass");
    const before = snapshot(prepared.fixture);
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const result = await prepareRecoveryEvidenceRecoveryPreflight({
      database: prepared.fixture.database,
      registry: prepared.registry,
      requestId: prepared.request.id,
      expectedTaskId: prepared.fixture.taskId,
      expectedReadToolRunId: prepared.fixture.readToolRunId,
      expectedAllowlistId: DISPATCH_ALLOWLIST_ID,
      expectedAllowlistVersion: prepared.allowlistVersion,
      expectedRequestIntentDigest: prepared.requestIntentDigest,
    });
    expect(result).toMatchObject({
      state: "passed",
      retryAssessment: "passed",
    });
    if (result.state !== "passed") {
      throw new Error("Expected passed preflight.");
    }
    expect(Object.isFrozen(result.capability)).toBe(true);
    expect(
      assertRecoveryEvidenceRecoveryPreflightCapability(
        result.capability,
        {
          taskId: prepared.fixture.taskId,
          requestId: prepared.request.id,
          readToolRunId: prepared.fixture.readToolRunId,
          requestIntentDigest: prepared.requestIntentDigest,
        },
      ),
    ).toMatchObject({
      allowlistId: DISPATCH_ALLOWLIST_ID,
      allowlistVersion: prepared.allowlistVersion,
      readToolName: prepared.fixture.readToolName,
      readToolVersion: prepared.fixture.readToolVersion,
      readToolSchemaHash: prepared.fixture.readToolSchemaHash,
    });
    expect(executeValidated).not.toHaveBeenCalled();
    expect(prepared.execute).not.toHaveBeenCalled();
    const after = snapshot(prepared.fixture);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  });

  it("does not expose the capability issuer through the public barrel", () => {
    expect(
      "prepareRecoveryEvidenceRecoveryPreflight" in
        recoveryPublicApi,
    ).toBe(false);
    expect(
      "assertRecoveryEvidenceRecoveryPreflightCapability" in
        recoveryPublicApi,
    ).toBe(false);
  });

  it("returns not_evaluated when the historical allowlist version is missing", async () => {
    const prepared = openPreflightFixture("preflight-missing-version", {
      requestAllowlistVersion: "b".repeat(64),
    });
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const result = await prepareRecoveryEvidenceRecoveryPreflight({
      database: prepared.fixture.database,
      registry: prepared.registry,
      requestId: prepared.request.id,
    });
    expect(result).toEqual({
      state: "not_evaluated",
      retryAssessment: "not_evaluated",
      reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
    });
    expect("capability" in result).toBe(false);
    expect(executeValidated).not.toHaveBeenCalled();
    expect(prepared.execute).not.toHaveBeenCalled();
  });

  it("rejects a recomputed allowlist contract digest mismatch", async () => {
    const prepared = openPreflightFixture(
      "preflight-allowlist-digest-mismatch",
    );
    const exact = prepared.registry.getExact(
      DISPATCH_ALLOWLIST_ID,
      prepared.allowlistVersion,
    );
    vi.spyOn(prepared.registry, "getExact").mockReturnValue(
      Object.freeze({
        ...exact,
        timeoutMs: exact.timeoutMs + 1,
      }),
    );
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      retryAssessment: "failed",
      reasonCode: "RECOVERY_CONTRACT_MISMATCH",
    });
  });

  it("rejects request intent digest mismatch", async () => {
    const prepared = openPreflightFixture("preflight-intent-mismatch");
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
        expectedRequestIntentDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).resolves.toMatchObject({
      state: "failed",
      retryAssessment: "failed",
      reasonCode: "REQUEST_INTENT_DIGEST_MISMATCH",
    });
  });

  it.each(["tool-name", "tool-version", "schema-hash"] as const)(
    "rejects %s mismatch with the exact registry contract",
    async (mismatch) => {
      const prepared = openPreflightFixture(
        `preflight-${mismatch}`,
        mismatch === "tool-name"
          ? {
              registryToolName: "other_inventory_lookup",
              persistedToolName: "inventory_lookup",
            }
          : mismatch === "tool-version"
            ? {
                registryToolVersion: "2",
                persistedToolVersion: "1",
              }
            : {
                registrySchema: DISPATCH_INPUT_SCHEMA.extend({
                  extra: z.string().optional(),
                }),
                persistedSchemaHash:
                  DISPATCH_READ_TOOL_SCHEMA_HASH,
              },
      );
      await expect(
        prepareRecoveryEvidenceRecoveryPreflight({
          database: prepared.fixture.database,
          registry: prepared.registry,
          requestId: prepared.request.id,
        }),
      ).resolves.toMatchObject({
        state: "failed",
        reasonCode: "RECOVERY_CONTRACT_MISMATCH",
      });
    },
  );

  it("rejects canonicalInputHash mismatch", async () => {
    const prepared = openPreflightFixture(
      "preflight-canonical-mismatch",
      {
        canonicalInputHash: `sha256:${"e".repeat(64)}`,
      },
    );
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    const result = await prepareRecoveryEvidenceRecoveryPreflight({
      database: prepared.fixture.database,
      registry: prepared.registry,
      requestId: prepared.request.id,
    });
    expect(result).toMatchObject({
      state: "failed",
      retryAssessment: "failed",
      reasonCode: "CANONICAL_INPUT_HASH_MISMATCH",
    });
    expect("capability" in result).toBe(false);
    expect(executeValidated).not.toHaveBeenCalled();
    expect(prepared.execute).not.toHaveBeenCalled();
  });

  it("rejects persisted normalized input that no longer validates", async () => {
    const prepared = openPreflightFixture(
      "preflight-invalid-persisted-input",
      {
        registrySchema: DISPATCH_INPUT_SCHEMA.extend({
          limit: z.number().int().min(20),
        }),
      },
    );
    const executeValidated = vi.spyOn(
      ToolRegistry.prototype,
      "executeValidated",
    );
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
      }),
    ).resolves.toEqual({
      state: "failed",
      retryAssessment: "failed",
      reasonCode: "PERSISTED_INPUT_INVALID",
    });
    expect(executeValidated).not.toHaveBeenCalled();
    expect(prepared.execute).not.toHaveBeenCalled();
  });

  it("accepts immutable + immutable_version without expected binding", async () => {
    const prepared = openPreflightFixture("preflight-immutable", {
      retrySafety: "immutable",
      consistencyMode: "immutable_version",
      expectedResourceVersion: null,
      expectedEtag: null,
    });
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
      }),
    ).resolves.toMatchObject({
      state: "passed",
      retryAssessment: "passed",
    });
  });

  it("accepts version_conditional with resource version or ETag", async () => {
    const version = openPreflightFixture(
      "preflight-version-conditional",
      {
        expectedResourceVersion: "7",
        expectedEtag: null,
      },
    );
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: version.fixture.database,
        registry: version.registry,
        requestId: version.request.id,
      }),
    ).resolves.toMatchObject({ state: "passed" });
    closeCurrentDatabase();
    const etag = openPreflightFixture(
      "preflight-etag-conditional",
      {
        expectedResourceVersion: null,
        expectedEtag: "etag-7",
      },
    );
    const etagResult =
      await prepareRecoveryEvidenceRecoveryPreflight({
        database: etag.fixture.database,
        registry: etag.registry,
        requestId: etag.request.id,
      });
    expect(etagResult).toMatchObject({ state: "passed" });
  });

  it("rejects undefined Retry Safety / Consistency combinations", () => {
    expect(
      assessRecoveryEvidenceRetryBinding({
        retrySafety: "immutable",
        consistencyMode: "immutable_version",
        expectedResourceVersion: "7",
        expectedEtag: null,
      }),
    ).toMatchObject({
      retryAssessment: "failed",
      reasonCode: "RETRY_BINDING_UNSAFE",
    });
    expect(
      assessRecoveryEvidenceRetryBinding({
        retrySafety: "version_conditional",
        consistencyMode: "etag_or_resource_version",
        expectedResourceVersion: null,
        expectedEtag: null,
      }),
    ).toMatchObject({
      retryAssessment: "failed",
      reasonCode: "EXPECTED_RESOURCE_BINDING_REQUIRED",
    });
  });

  it("rejects wrong expected Task, Request and ToolRun bindings", async () => {
    const prepared = openPreflightFixture("preflight-wrong-binding");
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
        expectedTaskId: "other-task",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      reasonCode: "RECOVERY_PREFLIGHT_BINDING_MISMATCH",
    });
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
        expectedAllowlistId: "other_allowlist",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      reasonCode: "RECOVERY_PREFLIGHT_BINDING_MISMATCH",
    });
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
        expectedAllowlistVersion: "9".repeat(64),
      }),
    ).resolves.toMatchObject({
      state: "failed",
      reasonCode: "RECOVERY_PREFLIGHT_BINDING_MISMATCH",
    });
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: prepared.request.id,
        expectedReadToolRunId: "other-run",
      }),
    ).resolves.toMatchObject({
      state: "failed",
      reasonCode: "RECOVERY_PREFLIGHT_BINDING_MISMATCH",
    });
    await expect(
      prepareRecoveryEvidenceRecoveryPreflight({
        database: prepared.fixture.database,
        registry: prepared.registry,
        requestId: "missing-request",
      }),
    ).resolves.toMatchObject({
      state: "not_evaluated",
      reasonCode: "RECOVERY_CONTRACT_UNAVAILABLE",
    });
  });

  it("rejects forged, spread and JSON-cloned capabilities", async () => {
    const prepared = openPreflightFixture("preflight-capability-clone");
    const result = await prepareRecoveryEvidenceRecoveryPreflight({
      database: prepared.fixture.database,
      registry: prepared.registry,
      requestId: prepared.request.id,
    });
    if (result.state !== "passed") {
      throw new Error("Expected passed preflight.");
    }
    for (const capability of [
      {},
      { ...result.capability },
      JSON.parse(JSON.stringify(result.capability)) as unknown,
    ]) {
      expect(() =>
        assertRecoveryEvidenceRecoveryPreflightCapability(capability),
      ).toThrow(/capability/i);
    }
    expect(() =>
      assertRecoveryEvidenceRecoveryPreflightCapability(
        result.capability,
        { requestId: "other-request" },
      ),
    ).toThrow(/capability/i);
    expect(() =>
      assertRecoveryEvidenceRecoveryPreflightCapability(
        result.capability,
        { allowlistVersion: "9".repeat(64) },
      ),
    ).toThrow(/capability/i);
  });
});

interface PreflightFixture {
  readonly fixture: RecoveryEvidenceUowFixture;
  readonly registry: RecoveryReadbackToolRegistry;
  readonly request: ReturnType<
    RecoveryEvidenceUowFixture["unitOfWork"]["createOwnedRecoveryEvidenceReadbackRequest"]
  >["request"];
  readonly allowlistVersion: string;
  readonly requestIntentDigest: string;
  readonly execute: ReturnType<typeof vi.fn>;
}

interface RegistryFixture {
  readonly registry: RecoveryReadbackToolRegistry;
  readonly allowlistVersion: string;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly schemaHash: string;
  readonly execute: ReturnType<typeof vi.fn>;
}

function openPreflightFixture(
  suffix: string,
  options: {
    readonly requestAllowlistVersion?: string;
    readonly persistedToolName?: string;
    readonly persistedToolVersion?: string;
    readonly persistedSchemaHash?: string;
    readonly registryToolName?: string;
    readonly registryToolVersion?: string;
    readonly registrySchema?: z.ZodType<unknown>;
    readonly canonicalInputHash?: string;
    readonly retrySafety?: "immutable" | "version_conditional";
    readonly consistencyMode?:
      | "immutable_version"
      | "etag_or_resource_version";
    readonly expectedResourceVersion?: string | null;
    readonly expectedEtag?: string | null;
  } = {},
): PreflightFixture {
  const registryFixture = createRegistryFixture(options);
  const readToolInput = {
    resourceRef: "inventory://part/STM32",
    limit: 10,
  };
  const canonicalInputHash =
    options.canonicalInputHash ??
    computeCanonicalInputHash(readToolInput);
  const allowlistVersion =
    options.requestAllowlistVersion ??
    registryFixture.allowlistVersion;
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  const fixture = createRecoveryEvidenceUowFixture(
    database,
    suffix,
    {
      allowlistVersion,
      readToolName:
        options.persistedToolName ?? registryFixture.toolName,
      readToolVersion:
        options.persistedToolVersion ?? registryFixture.toolVersion,
      readToolSchemaHash:
        options.persistedSchemaHash ?? registryFixture.schemaHash,
      readToolInput,
      canonicalInputHash,
    },
  );
  const reservations =
    new RecoveryEvidenceReadbackReservationUnitOfWork(
      fixture.database,
      () => fixture.authority.assertActive(),
      fixture.leaseManager,
      { now: () => new Date("2026-11-08T00:04:00.000Z") },
    );
  const input = requestInput(fixture, suffix, options);
  const requestIntent = {
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    allowlistId: DISPATCH_ALLOWLIST_ID,
    verificationCheckId: fixture.verificationCheckId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    expectedResourceVersion:
      options.expectedResourceVersion === undefined
        ? "7"
        : options.expectedResourceVersion,
    expectedEtag:
      options.expectedEtag === undefined
        ? "etag-7"
        : options.expectedEtag,
  };
  const acquired = reservations.acquireOwned({
    ownership: fixture.ownership,
    expectedTaskVersion: snapshot(fixture).task.version,
    requestIntent,
    requestId: input.requestId,
    operationId: input.operationId,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    readAttemptId: input.readAttemptId,
  });
  if (acquired.state !== "acquired" || acquired.ownerToken === null) {
    throw new Error("Expected acquired preflight Reservation.");
  }
  let request: PreflightFixture["request"] | undefined;
  reservations.completeOwned(
    {
      ownership: fixture.ownership,
      reservationId: acquired.reservation.id,
      expectedReservationVersion:
        acquired.reservation.reservationVersion,
      ownerToken: acquired.ownerToken,
      requestIntent,
    },
    ({ task }) => {
      request =
        fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest({
          ...input,
          expectedTaskVersion: task.version,
        }).request;
    },
  );
  if (request === undefined) {
    throw new Error("Expected preflight Request.");
  }
  return {
    fixture,
    registry: registryFixture.registry,
    request,
    allowlistVersion,
    requestIntentDigest:
      acquired.reservation.requestIntentDigest,
    execute: registryFixture.execute,
  };
}

function createRegistryFixture(options: {
  readonly registryToolName?: string;
  readonly registryToolVersion?: string;
  readonly registrySchema?: z.ZodType<unknown>;
  readonly retrySafety?: "immutable" | "version_conditional";
  readonly consistencyMode?:
    | "immutable_version"
    | "etag_or_resource_version";
}): RegistryFixture {
  const toolName =
    options.registryToolName ?? "inventory_lookup";
  const toolVersion = options.registryToolVersion ?? "1";
  const inputSchema =
    options.registrySchema ?? DISPATCH_INPUT_SCHEMA;
  const schemaHash = computeSchemaHash(inputSchema);
  const retrySafety =
    options.retrySafety ??
    (options.consistencyMode === "immutable_version"
      ? "immutable"
      : "version_conditional");
  const consistencyMode =
    options.consistencyMode ??
    (retrySafety === "immutable"
      ? "immutable_version"
      : "etag_or_resource_version");
  const resultSchema = z.object({
    accepted: z.boolean(),
  }).strict();
  const definitionBase: Omit<
    RecoveryReadbackToolDefinition,
    "allowlistVersion"
  > = {
    protocolVersion: "forgeflow.recovery-readback-contract.v1",
    sourceResolverId: "inventory_source",
    sourceResolverVersion: "1",
    argumentBuilderId: "inventory_arguments",
    argumentBuilderVersion: "1",
    name: toolName,
    version: toolVersion,
    schemaHash,
    allowlistId: DISPATCH_ALLOWLIST_ID,
    resultSchemaId: "inventory_result",
    resultSchemaVersion: "1",
    resultSchemaHash: computeSchemaHash(resultSchema),
    resourceMetadataExtractorId: "inventory_metadata",
    resourceMetadataExtractorVersion: "1",
    allowedResourceSchemes: ["inventory"],
    mode: "read",
    retrySafety,
    consistencyMode,
    inputSchema,
    timeoutMs: 1_000,
    maximumPayloadBytes: 16_384,
    sensitiveOutputPolicy: {
      classification: "internal",
      mode: "allow",
      redactionProfile: null,
    },
    resolveSource: (originalToolRun, manifest) => {
      const input = originalToolRun.input as {
        resourceRef?: unknown;
      };
      if (typeof input.resourceRef !== "string") {
        throw new Error("Preflight source invalid.");
      }
      return {
        resourceRef: input.resourceRef,
        resourceVersionHint: manifest.resourceVersion,
        resourceEtagHint: null,
      };
    },
    buildArguments: (manifest, context, source) => {
      const value: Record<string, unknown> = {
        resourceRef: source.resourceRef,
        limit: 10,
      };
      if (context.expectedResourceVersion !== null) {
        value.expectedVersion = context.expectedResourceVersion;
      }
      if (context.expectedEtag !== null) {
        value.expectedEtag = context.expectedEtag;
      }
      void manifest;
      return value;
    },
    resultSchema,
    extractResultMetadata: (result) => {
      resultSchema.parse(result);
      return {
        resourceVersion: null,
        resourceEtag: null,
      };
    },
  };
  const contract = contractMetadata(definitionBase);
  const allowlistVersion =
    computeRecoveryReadbackAllowlistVersion(contract);
  const execute = vi.fn(async () => ({ accepted: true }));
  const tools = new ToolRegistry();
  tools.register({
    name: toolName,
    description: "Recovery preflight test tool.",
    mode: "read",
    version: toolVersion,
    timeoutMs: 1_000,
    inputSchema,
    execute,
  });
  const registry = new RecoveryReadbackToolRegistry(tools);
  registry.register({
    ...definitionBase,
    allowlistVersion,
  });
  return {
    registry,
    allowlistVersion,
    toolName,
    toolVersion,
    schemaHash,
    execute,
  };
}

function contractMetadata(
  definition: Omit<
    RecoveryReadbackToolDefinition,
    "allowlistVersion"
  >,
): RecoveryReadbackAllowlistContractMetadata {
  return {
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
  };
}

function requestInput(
  fixture: RecoveryEvidenceUowFixture,
  suffix: string,
  options: {
    readonly retrySafety?: "immutable" | "version_conditional";
    readonly consistencyMode?:
      | "immutable_version"
      | "etag_or_resource_version";
    readonly expectedResourceVersion?: string | null;
    readonly expectedEtag?: string | null;
  },
) {
  const actorId = "reviewer-host";
  const expectedResourceVersion =
    options.expectedResourceVersion === undefined
      ? "7"
      : options.expectedResourceVersion;
  const expectedEtag =
    options.expectedEtag === undefined
      ? "etag-7"
      : options.expectedEtag;
  const retrySafety =
    options.retrySafety ??
    (options.consistencyMode === "immutable_version"
      ? "immutable"
      : "version_conditional");
  const consistencyMode =
    options.consistencyMode ??
    (retrySafety === "immutable"
      ? "immutable_version"
      : "etag_or_resource_version");
  const operationPayloadDigest =
    computeRecoveryEvidenceReadbackOperationPayloadDigest({
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalUnknownToolRunId: fixture.originalToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("7"),
      allowlistId: DISPATCH_ALLOWLIST_ID,
      allowlistVersion: fixture.allowlistVersion,
      readToolName: fixture.readToolName,
      readToolVersion: fixture.readToolVersion,
      readToolSchemaHash: fixture.readToolSchemaHash,
      expectedResourceVersion,
      expectedEtag,
      verificationCheckId: fixture.verificationCheckId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
    });
  const requestKey = computeRecoveryReviewOperationRequestKey({
    reviewId: fixture.reviewId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    operation: "request_readback",
    operationPayloadDigest,
    actorId,
  });
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: snapshot(fixture).task.version,
    requestId: `preflight-request-${suffix}`,
    operationId: `preflight-operation-${suffix}`,
    readAttemptId: `preflight-attempt-${suffix}`,
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    actorId,
    operationPayloadDigest,
    requestKey,
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    verifierId: "host_verifier",
    verifierVersion: "1",
    verifierConfigDigest: digest("7"),
    allowlistId: DISPATCH_ALLOWLIST_ID,
    allowlistVersion: fixture.allowlistVersion,
    readToolName: fixture.readToolName,
    readToolVersion: fixture.readToolVersion,
    readToolSchemaHash: fixture.readToolSchemaHash,
    retrySafety,
    consistencyMode,
    expectedResourceVersion,
    expectedEtag,
    verificationCheckId: fixture.verificationCheckId,
  };
}

function snapshot(fixture: RecoveryEvidenceUowFixture) {
  return new TaskSnapshotReader(fixture.database).load(fixture.taskId);
}

function closeCurrentDatabase(): void {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
}

const computeSchemaHash = computeToolInputSchemaHash;

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
