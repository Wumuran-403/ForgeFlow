import {
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileEvidencePayloadStore,
  RecoveryVerifierBindingNotFoundError,
  RecoveryVerifierHostBindingProvider,
  RecoveryVerifierRegistry,
  RecoveryVerifierRuntime,
  RecoveryVerifierRuntimeExecutionResultSchema,
  RecoveryEvidenceEnvelopeSchema,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeReadbackResultPayloadDigest,
  type RecoveryEvidenceEnvelope,
  type RecoveryEvidencePayloadIntegrityManifest,
  type RecoveryReadbackResult,
  type RecoveryVerifierContext,
  type RecoveryVerifierDefinition,
  type RecoveryVerifierHostBinding,
  type RecoveryVerifierHostBindingDefinition,
  type RecoveryVerifierInput,
  type RecoveryVerifierResult,
} from "../../src/recovery/index.js";
import {
  loadRecoveryEvidencePayloadWithIntegrity,
  type VerifiedEvidencePayload,
} from "../../src/recovery/recovery-evidence-payload-integrity.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";

let rootDirectory: string;
let payloadStore: FileEvidencePayloadStore;

beforeEach(() => {
  rootDirectory = mkdtempSync(join(tmpdir(), "forgeflow-verifier-"));
  payloadStore = new FileEvidencePayloadStore(
    join(rootDirectory, "evidence"),
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(rootDirectory, { recursive: true, force: true });
});

describe("RecoveryVerifierHostBindingProvider", () => {
  it("produces stable bindings and includes timeout in the config digest", () => {
    const definition = bindingDefinition();
    const first = new RecoveryVerifierHostBindingProvider([
      definition,
    ]).getForNewCheck("host_verifier");
    const second = new RecoveryVerifierHostBindingProvider([
      definition,
    ]).getForNewCheck("host_verifier");
    const shorterTimeout =
      new RecoveryVerifierHostBindingProvider([
        {
          ...definition,
          timeoutMs: 50,
        },
      ]).getForNewCheck("host_verifier");

    expect(first.verifierConfigDigest).toBe(
      second.verifierConfigDigest,
    );
    expect(first.effectiveConfig.timeoutMs).toBe(1_000);
    expect(shorterTimeout.verifierConfigDigest).not.toBe(
      first.verifierConfigDigest,
    );
    expect(shorterTimeout.effectiveConfig.timeoutMs).toBe(50);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.effectiveConfig)).toBe(true);
    expect(
      Object.isFrozen(first.effectiveConfig.ruleConfig),
    ).toBe(true);
  });

  it("uses the active binding for new checks while preserving historical exact bindings", () => {
    const historicalBinding =
      new RecoveryVerifierHostBindingProvider([
        bindingDefinition({
          active: true,
          timeoutMs: 75,
          ruleConfig: { ruleset: "v1" },
        }),
      ]).getForNewCheck("host_verifier");

    const provider = new RecoveryVerifierHostBindingProvider([
      bindingDefinition({
        active: false,
        timeoutMs: 75,
        ruleConfig: { ruleset: "v1" },
      }),
      bindingDefinition({
        active: true,
        timeoutMs: 250,
        ruleConfig: { ruleset: "v2" },
      }),
    ]);
    const current = provider.getForNewCheck("host_verifier");
    const restored = provider.restore({
      verifierId: historicalBinding.verifierId,
      verifierVersion: historicalBinding.verifierVersion,
      verifierConfigDigest:
        historicalBinding.verifierConfigDigest,
    });

    expect(current.verifierConfigDigest).not.toBe(
      restored.verifierConfigDigest,
    );
    expect(restored.timeoutMs).toBe(75);
    expect(current.timeoutMs).toBe(250);
  });

  it("fails closed when the exact persisted binding is unavailable", () => {
    const provider = new RecoveryVerifierHostBindingProvider([
      bindingDefinition(),
    ]);

    expect(() =>
      provider.restore({
        verifierId: "host_verifier",
        verifierVersion: "1",
        verifierConfigDigest: `sha256:${"f".repeat(64)}`,
      }),
    ).toThrow(RecoveryVerifierBindingNotFoundError);
  });
});

describe("RecoveryVerifierRuntime", () => {
  it("resolves and invokes the exact host verifier with only read-only business input", async () => {
    const fixture = createVerifiedJsonFixture();
    const verify = vi.fn(
      (
        input: RecoveryVerifierInput,
        context: RecoveryVerifierContext,
      ): RecoveryVerifierResult => {
        expect(Object.isFrozen(input)).toBe(true);
        expect(Object.isFrozen(input.payload)).toBe(true);
        expect(Object.isFrozen(input.payload.structuredValue)).toBe(
          true,
        );
        expect(Object.isFrozen(context)).toBe(true);
        expect(input.payload.structuredValue).toMatchObject({
          receipt: "receipt-1",
          accepted: true,
        });
        expect(context.trustAnchorId).toBeNull();
        expect(context.readbackToolRunId).toBeNull();
        expect(context.toolMessageId).toBeNull();
        return {
          status: "passed",
          reasonCode: "EXPECTED_STATE_OBSERVED",
          redactedSummary: "Expected state was observed.",
          integrity: "mismatch",
          authenticity: "unverified",
        };
      },
    );
    const runtime = createRuntime({
      verify,
    });
    const binding = runtime.getBindingForNewCheck("host_verifier");

    const result = await runtime.executePersisted({
      binding,
      manifest: fixture.manifest,
      verifiedPayload: fixture.verifiedPayload,
      context: context(binding),
    });

    expect(result).toMatchObject({
      status: "passed",
      reasonCode: "EXPECTED_STATE_OBSERVED",
      integrityStatus: "matched",
      authenticityStatus: "unverified",
      verificationEventRequired: true,
    });
    expect(
      RecoveryVerifierRuntimeExecutionResultSchema.parse(result),
    ).toEqual(result);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(verify.mock.calls[0]).toHaveLength(2);
    expect(Object.keys(verify.mock.calls[0]?.[0] ?? {})).toEqual([
      "manifest",
      "payload",
    ]);
    expect(
      Object.isFrozen(verify.mock.calls[0]?.[1]),
    ).toBe(true);
  });

  it("fails closed for registry version and config digest mismatches", async () => {
    const fixture = createVerifiedJsonFixture();
    const verify = vi.fn(() => verifierResult());
    const bindingProvider = new RecoveryVerifierHostBindingProvider([
      bindingDefinition(),
    ]);
    const versionMismatchRuntime = new RecoveryVerifierRuntime(
      registryFor({
        ...verifierDefinition(),
        version: "2",
        verify,
      }),
      bindingProvider,
    );
    const binding =
      versionMismatchRuntime.getBindingForNewCheck(
        "host_verifier",
      );

    const versionMismatch =
      await versionMismatchRuntime.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: fixture.verifiedPayload,
        context: context(binding),
      });
    expect(versionMismatch).toMatchObject({
      status: "not_run",
      reasonCode: "VERIFIER_VERSION_MISMATCH",
      verificationEventRequired: false,
    });
    expect(verify).not.toHaveBeenCalled();

    const runtime = createRuntime({ verify });
    const digestMismatch =
      await runtime.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: fixture.verifiedPayload,
        context: context({
          ...binding,
          verifierConfigDigest: `sha256:${"e".repeat(64)}`,
        }),
      });
    expect(digestMismatch).toMatchObject({
      status: "not_run",
      reasonCode: "VERIFIER_CONFIG_DIGEST_MISMATCH",
      verificationEventRequired: false,
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("fails closed when the verifier or exact binding is unavailable", async () => {
    const fixture = createVerifiedJsonFixture();
    const binding = new RecoveryVerifierHostBindingProvider([
      bindingDefinition(),
    ]).getForNewCheck("host_verifier");

    const missingVerifier = new RecoveryVerifierRuntime(
      new RecoveryVerifierRegistry(),
      new RecoveryVerifierHostBindingProvider([bindingDefinition()]),
    );
    expect(
      await missingVerifier.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: fixture.verifiedPayload,
        context: context(binding),
      }),
    ).toMatchObject({
      status: "not_run",
      reasonCode: "VERIFIER_NOT_REGISTERED",
    });

    const otherBindingRuntime = new RecoveryVerifierRuntime(
      registryFor(verifierDefinition()),
      new RecoveryVerifierHostBindingProvider([
        bindingDefinition({
          timeoutMs: 2_000,
          ruleConfig: { ruleset: "different" },
        }),
      ]),
    );
    expect(
      await otherBindingRuntime.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: fixture.verifiedPayload,
        context: context(binding),
      }),
    ).toMatchObject({
      status: "not_run",
      reasonCode: "VERIFIER_BINDING_UNAVAILABLE",
    });
  });

  it("executes a historical persisted binding without adopting the active host config", async () => {
    const fixture = createVerifiedJsonFixture();
    const verify = vi.fn(() => verifierResult());
    const provider = new RecoveryVerifierHostBindingProvider([
      bindingDefinition({
        active: false,
        timeoutMs: 75,
        ruleConfig: { ruleset: "v1" },
      }),
      bindingDefinition({
        active: true,
        timeoutMs: 250,
        ruleConfig: { ruleset: "v2" },
      }),
    ]);
    const historicalBinding =
      new RecoveryVerifierHostBindingProvider([
        bindingDefinition({
          active: true,
          timeoutMs: 75,
          ruleConfig: { ruleset: "v1" },
        }),
      ]).getForNewCheck("host_verifier");
    const runtime = new RecoveryVerifierRuntime(
      registryFor(verifierDefinition({ verify })),
      provider,
    );

    const result = await runtime.executePersisted({
      binding: historicalBinding,
      manifest: fixture.manifest,
      verifiedPayload: fixture.verifiedPayload,
      context: context(historicalBinding),
    });

    expect(result.status).toBe("passed");
    expect(
      runtime.getBindingForNewCheck("host_verifier")
        .verifierConfigDigest,
    ).not.toBe(historicalBinding.verifierConfigDigest);
    expect(verify).toHaveBeenCalledTimes(1);
  });

  it("maps rejects, synchronous failures, and invalid results to inconclusive", async () => {
    const fixture = createVerifiedJsonFixture();
    const binding = new RecoveryVerifierHostBindingProvider([
      bindingDefinition(),
    ]).getForNewCheck("host_verifier");

    for (const verify of [
      vi.fn(async () => {
        throw new Error("secret reject");
      }),
      vi.fn(() => {
        throw new Error("secret sync failure");
      }),
      vi.fn(() => ({
        status: "confirmed_succeeded",
      }) as never),
      vi.fn(
        (): RecoveryVerifierResult => ({
          ...verifierResult(),
          authenticity: "system_verified",
        }),
      ),
    ]) {
      const runtime = new RecoveryVerifierRuntime(
        registryFor(
          verifierDefinition({
            verify,
          }),
        ),
        new RecoveryVerifierHostBindingProvider([
          bindingDefinition(),
        ]),
      );
      const result = await runtime.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: fixture.verifiedPayload,
        context: context(binding),
      });
      expect(result).toMatchObject({
        status: "inconclusive",
        integrityStatus: "matched",
        authenticityStatus: "unverified",
        verificationEventRequired: true,
      });
      expect(JSON.stringify(result)).not.toContain("secret");
    }
  });

  it("settles timeout once and consumes a late resolve", async () => {
    vi.useFakeTimers();
    const fixture = createVerifiedJsonFixture();
    const deferred = createDeferred<RecoveryVerifierResult>();
    const verify = vi.fn(() => deferred.promise);
    const runtime = createRuntime({ verify, timeoutMs: 10 });
    const binding = runtime.getBindingForNewCheck("host_verifier");

    const execution = runtime.executePersisted({
      binding,
      manifest: fixture.manifest,
      verifiedPayload: fixture.verifiedPayload,
      context: context(binding),
    });
    await vi.advanceTimersByTimeAsync(11);
    const result = await execution;

    expect(result).toMatchObject({
      status: "inconclusive",
      reasonCode: "VERIFIER_TIMEOUT",
      verificationEventRequired: true,
    });
    deferred.resolve(verifierResult());
    await Promise.resolve();
    await Promise.resolve();
    expect(result.status).toBe("inconclusive");
  });

  it("safely consumes a rejection that arrives after timeout", async () => {
    vi.useFakeTimers();
    const fixture = createVerifiedJsonFixture();
    const deferred = createDeferred<RecoveryVerifierResult>();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const runtime = createRuntime({
        verify: () => deferred.promise,
        timeoutMs: 10,
      });
      const binding =
        runtime.getBindingForNewCheck("host_verifier");
      const execution = runtime.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: fixture.verifiedPayload,
        context: context(binding),
      });

      await vi.advanceTimersByTimeAsync(11);
      expect(await execution).toMatchObject({
        status: "inconclusive",
        reasonCode: "VERIFIER_TIMEOUT",
      });

      deferred.reject(new Error("late secret rejection"));
      await vi.runAllTicks();
      await Promise.resolve();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("contracts that a verifier requiring readback cannot consume a declared readback_result", async () => {
    const fixture = createVerifiedReadbackFixture();
    expect(fixture.verifiedPayload.provenance).toBe(
      "declared_payload",
    );
    const verify = vi.fn(() => verifierResult());
    const registry = registryFor({
      ...verifierDefinition(),
      readbackRequired: true,
      allowlistId: "inventory_readback",
      allowedPayloadTypes: ["readback_result"],
      verify,
    });
    const runtime = new RecoveryVerifierRuntime(
      registry,
      new RecoveryVerifierHostBindingProvider([
        bindingDefinition(),
      ]),
    );
    const binding = runtime.getBindingForNewCheck("host_verifier");

    const result = await runtime.executePersisted({
      binding,
      manifest: fixture.manifest,
      verifiedPayload: fixture.verifiedPayload,
      context: context(binding, {
        payloadType: "readback_result",
      }),
    });

    expect(result).toMatchObject({
      status: "not_run",
      reasonCode: "VERIFIER_INCOMPATIBLE",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("refuses forged verified payload handles without invoking a verifier", async () => {
    const fixture = createVerifiedJsonFixture();
    const verify = vi.fn(() => verifierResult());
    const runtime = createRuntime({ verify });
    const binding = runtime.getBindingForNewCheck("host_verifier");
    const forged = {
      payloadType: "json",
      provenance: "declared_payload",
    } as VerifiedEvidencePayload;

    expect(
      await runtime.executePersisted({
        binding,
        manifest: fixture.manifest,
        verifiedPayload: forged,
        context: context(binding),
      }),
    ).toMatchObject({
      status: "not_run",
      reasonCode: "VERIFIED_PAYLOAD_INVALID",
      integrityStatus: "not_checked",
    });
    expect(verify).not.toHaveBeenCalled();
  });
});

function createRuntime(options: {
  readonly verify: RecoveryVerifierDefinition["verify"];
  readonly timeoutMs?: number;
  readonly version?: string;
}): RecoveryVerifierRuntime {
  return new RecoveryVerifierRuntime(
    registryFor(
      verifierDefinition({
        version: options.version ?? "1",
        verify: options.verify,
      }),
    ),
    new RecoveryVerifierHostBindingProvider([
      bindingDefinition({
        timeoutMs: options.timeoutMs ?? 1_000,
      }),
    ]),
  );
}

function registryFor(
  definition: RecoveryVerifierDefinition,
): RecoveryVerifierRegistry {
  const registry = new RecoveryVerifierRegistry();
  registry.register(definition);
  return registry;
}

function bindingDefinition(
  overrides: Partial<RecoveryVerifierHostBindingDefinition> = {},
): RecoveryVerifierHostBindingDefinition {
  return {
    verifierId: "host_verifier",
    verifierVersion: "1",
    timeoutMs: 1_000,
    ruleConfig: {
      ruleset: "inventory",
    },
    active: true,
    ...overrides,
  };
}

function verifierDefinition(
  overrides: Partial<RecoveryVerifierDefinition> = {},
): RecoveryVerifierDefinition {
  return {
    id: "host_verifier",
    version: "1",
    description: "Host-owned inventory verifier.",
    allowedPayloadTypes: ["json"],
    allowedSourceTypes: ["system_verification"],
    readbackRequired: false,
    verify: () => verifierResult(),
    ...overrides,
  };
}

function verifierResult(): RecoveryVerifierResult {
  return {
    status: "passed",
    reasonCode: "EXPECTED_STATE_OBSERVED",
    redactedSummary: "Expected state was observed.",
    integrity: "matched",
    authenticity: "unverified",
  };
}

function context(
  binding: Pick<
    RecoveryVerifierHostBinding,
    "verifierConfigDigest"
  >,
  overrides: Partial<RecoveryVerifierContext> = {},
): RecoveryVerifierContext {
  return {
    taskId: "task-verifier",
    reviewId: "review-verifier",
    originalToolRunId: "write-run-verifier",
    evidenceSubmissionId: "submission-verifier",
    verificationId: "verification-verifier",
    verificationCheckId: "check-verifier",
    verifierConfigDigest: binding.verifierConfigDigest,
    payloadType: "json",
    sourceType: "system_verification",
    verificationStartedAt: "2026-11-08T00:00:00.000Z",
    authenticatedActorId: null,
    trustAnchorId: null,
    readbackToolRunId: null,
    toolMessageId: null,
    ...overrides,
  };
}

function createVerifiedJsonFixture(): {
  readonly manifest: RecoveryEvidenceEnvelope;
  readonly verifiedPayload: VerifiedEvidencePayload;
} {
  const value = {
    receipt: "receipt-1",
    accepted: true,
  };
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  const storageDigest = computeRawPayloadDigest(bytes);
  const integrityManifest = manifestFor({
    payloadType: "json",
    payloadDigestProtocol: "jcs-sha256-v1",
    payloadDigest: computeJsonPayloadDigest(value),
    payloadStoreRef: payloadStore.put(
      bytes,
      storageDigest,
    ).storeRef,
  });
  const loaded = loadRecoveryEvidencePayloadWithIntegrity(
    integrityManifest,
    payloadStore,
  );
  if (loaded.payload === null) {
    throw new Error("Expected a verified JSON payload.");
  }
  return {
    manifest: verifierEnvelope(integrityManifest),
    verifiedPayload: loaded.payload,
  };
}

function createVerifiedReadbackFixture(): {
  readonly manifest: RecoveryEvidenceEnvelope;
  readonly verifiedPayload: VerifiedEvidencePayload;
} {
  const readback: RecoveryReadbackResult = {
    resourceRef: "ledger://write/1",
    resourceVersion: "etag-1",
    observedAt: "2026-11-08T00:00:00.000Z",
    outcome: "observed_succeeded",
    result: {
      receipt: "receipt-1",
      accepted: true,
    },
  };
  const bytes = Buffer.from(canonicalJson(readback), "utf8");
  const storageDigest = computeRawPayloadDigest(bytes);
  const integrityManifest = manifestFor({
    payloadType: "readback_result",
    payloadDigestProtocol: "jcs-sha256-v1",
    payloadDigest: computeReadbackResultPayloadDigest(readback),
    payloadStoreRef: payloadStore.put(
      bytes,
      storageDigest,
    ).storeRef,
    resourceRef: readback.resourceRef,
    resourceVersion: readback.resourceVersion,
  });
  const loaded = loadRecoveryEvidencePayloadWithIntegrity(
    integrityManifest,
    payloadStore,
  );
  if (loaded.payload === null) {
    throw new Error("Expected a verified readback payload.");
  }
  return {
    manifest: verifierEnvelope(integrityManifest),
    verifiedPayload: loaded.payload,
  };
}

function manifestFor(input: {
  readonly payloadType: "json" | "readback_result";
  readonly payloadDigestProtocol: "jcs-sha256-v1";
  readonly payloadDigest: string;
  readonly payloadStoreRef: string;
  readonly resourceRef?: string;
  readonly resourceVersion?: string;
}): RecoveryEvidenceEnvelope &
  Pick<
    RecoveryEvidencePayloadIntegrityManifest,
    "payloadStoreRef" | "payloadStorageMode"
  > {
  return {
    schemaVersion: "forgeflow.recovery-evidence.v1",
    evidenceRef: "audit://evidence/runtime-1",
    sourceType: "system_verification",
    outcome: "observed_succeeded",
    sourceObservedAt: "2026-11-08T00:00:00.000Z",
    submittedAt: "2026-11-08T00:00:01.000Z",
    verifiedAt: null,
    resourceRef: input.resourceRef ?? null,
    resourceVersion: input.resourceVersion ?? null,
    taskId: "task-verifier",
    toolRunId: "write-run-verifier",
    toolName: "inventory.update",
    toolVersion: "1",
    inputSchemaHash: digest("a"),
    canonicalInputHash: digest("b"),
    idempotencyKey: digest("c"),
    actorId: null,
    verifierId: "host_verifier",
    verificationId: "verification-verifier",
    payloadType: input.payloadType,
    payloadDigestProtocol: input.payloadDigestProtocol,
    payloadDigest: input.payloadDigest,
    redactedSummary: "Host evidence.",
    payloadStoreRef: input.payloadStoreRef,
    payloadStorageMode: "content_addressed_file",
  };
}

function verifierEnvelope(
  integrityManifest: RecoveryEvidenceEnvelope &
    Pick<
      RecoveryEvidencePayloadIntegrityManifest,
      "payloadStoreRef" | "payloadStorageMode"
    >,
): RecoveryEvidenceEnvelope {
  const value: Record<string, unknown> = {
    ...integrityManifest,
  };
  delete value.payloadStoreRef;
  delete value.payloadStorageMode;
  return RecoveryEvidenceEnvelopeSchema.parse(value);
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
  readonly reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
