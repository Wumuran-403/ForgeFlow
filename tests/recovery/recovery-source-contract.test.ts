import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  FileEvidencePayloadStore,
  RecoverySourceContractV1Schema,
  canonicalRecoverySourceContractV1,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeRecoverySourceContractDigest,
  validateRecoverySourceContractV1,
  verifyRecoveryEvidencePayloadIntegrity,
  type RecoveryEvidencePayloadIntegrityManifest,
} from "../../src/recovery/index.js";
import {
  loadRecoveryEvidencePayloadWithIntegrity,
  materializeVerifiedEvidencePayload,
} from "../../src/recovery/recovery-evidence-payload-integrity.js";

const taskId = "task-source-contract";
const reviewId = "review-source-contract";
const toolRunId = "tool-run-unknown-write";

let rootDirectory: string;
let payloadStore: FileEvidencePayloadStore;

beforeEach(() => {
  rootDirectory = mkdtempSync(join(tmpdir(), "forgeflow-source-contract-"));
  payloadStore = new FileEvidencePayloadStore(
    join(rootDirectory, "evidence"),
  );
});

afterEach(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
});

describe("RecoverySourceContractV1", () => {
  it("accepts isolated system-verified and manual-attested variants", () => {
    const system = validSystemContract();
    const manual = validManualContract();

    expect(RecoverySourceContractV1Schema.parse(system)).toEqual(system);
    expect(RecoverySourceContractV1Schema.parse(manual)).toEqual(manual);
    expect(
      validateRecoverySourceContractV1(system, {
        taskId,
        reviewId,
        originalUnknownWriteToolRunId: toolRunId,
        sourceContractAuthority: "system_verified",
      }),
    ).toEqual(system);
    expect(
      validateRecoverySourceContractV1(manual, {
        taskId,
        reviewId,
        originalUnknownWriteToolRunId: toolRunId,
        sourceContractAuthority: "manual_attested",
      }),
    ).toEqual(manual);
  });

  it("rejects unknown fields and self-referential sourceContractDigest", () => {
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...validSystemContract(),
        sourceContractDigest: digest("a"),
      }),
    ).toThrow();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...validManualContract(),
        verifierBinding: validSystemContract().verifierBinding,
      }),
    ).toThrow();
  });

  it("produces stable canonical JSON independent of input key order", () => {
    const first = validSystemContract();
    const second = {
      verifierBinding: first.verifierBinding,
      result: first.result,
      sourceObservedAt: first.sourceObservedAt,
      payloadDigest: first.payloadDigest,
      coverageCompleteness: first.coverageCompleteness,
      observationTimeWindow: first.observationTimeWindow,
      queryScope: first.queryScope,
      targetResourceIdentity: first.targetResourceIdentity,
      originalUnknownWriteToolRunId:
        first.originalUnknownWriteToolRunId,
      reviewId: first.reviewId,
      taskId: first.taskId,
      sourceContractSchemaVersion:
        first.sourceContractSchemaVersion,
      sourceContractAuthority: first.sourceContractAuthority,
      sourceType: first.sourceType,
      provenance: first.provenance,
      negativeObservationSemantics:
        first.negativeObservationSemantics,
    };

    expect(canonicalRecoverySourceContractV1(first)).toBe(
      canonicalRecoverySourceContractV1(second),
    );
  });

  it("computes a stable digest over the canonical contract without self-reference", () => {
    const contract = validManualContract();
    const digestValue = computeRecoverySourceContractDigest(contract);

    expect(digestValue).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(computeRecoverySourceContractDigest(contract)).toBe(digestValue);
    expect(
      digestValue,
    ).toBe(
      computeJsonPayloadDigest(
        RecoverySourceContractV1Schema.parse(contract),
      ),
    );
    expect(contract).not.toHaveProperty("sourceContractDigest");
  });

  it("rejects mismatched task, review, unknown write, and authority bindings", () => {
    const contract = validSystemContract();

    for (const expected of [
      {
        taskId: "other-task",
        reviewId,
        originalUnknownWriteToolRunId: toolRunId,
        sourceContractAuthority: "system_verified" as const,
      },
      {
        taskId,
        reviewId: "other-review",
        originalUnknownWriteToolRunId: toolRunId,
        sourceContractAuthority: "system_verified" as const,
      },
      {
        taskId,
        reviewId,
        originalUnknownWriteToolRunId: "other-tool-run",
        sourceContractAuthority: "system_verified" as const,
      },
      {
        taskId,
        reviewId,
        originalUnknownWriteToolRunId: toolRunId,
        sourceContractAuthority: "manual_attested" as const,
      },
    ]) {
      expect(() =>
        validateRecoverySourceContractV1(contract, expected),
      ).toThrowError(
        expect.objectContaining({
          code: "RECOVERY_SOURCE_CONTRACT_BINDING_MISMATCH",
        }),
      );
    }
  });

  it("rejects missing target, query, time, coverage, and payload bindings", () => {
    const requiredFields = [
      "targetResourceIdentity",
      "queryScope",
      "observationTimeWindow",
      "coverageCompleteness",
      "payloadDigest",
    ] as const;

    for (const field of requiredFields) {
      const candidate = { ...validManualContract() } as Record<
        string,
        unknown
      >;
      delete candidate[field];
      expect(() => RecoverySourceContractV1Schema.parse(candidate)).toThrow();
    }
  });

  it("rejects manual contracts that claim runtime or system-verified provenance", () => {
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...validManualContract(),
        provenance: "controlled_runtime_read",
      }),
    ).toThrow();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...validManualContract(),
        sourceContractAuthority: "system_verified",
      }),
    ).toThrow();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...validSystemContract(),
        sourceType: "manual_review",
      }),
    ).toThrow();
  });

  it("rejects missing verifier binding and failed verification claims", () => {
    const withoutBinding = { ...validSystemContract() } as Record<
      string,
      unknown
    >;
    delete withoutBinding.verifierBinding;
    expect(() =>
      RecoverySourceContractV1Schema.parse(withoutBinding),
    ).toThrow();

    const system = validSystemContract();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...system,
        verifierBinding: {
          ...system.verifierBinding,
          verificationResult: "failed",
        },
      }),
    ).toThrow();
  });

  it("rejects unsafe manual identity and result claims", () => {
    const manual = validManualContract();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...manual,
        manualAttestation: {
          ...manual.manualAttestation,
          actorType: "host_verifier",
        },
      }),
    ).toThrow();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...manual,
        result: "failed",
      }),
    ).toThrow();
  });

  it("rejects observations outside the declared window and incomplete coverage", () => {
    const manual = validManualContract();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...manual,
        sourceObservedAt: "2026-01-01T00:06:00.000Z",
      }),
    ).toThrow();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...manual,
        coverageCompleteness: {
          isComplete: true,
          coveredSelectors: ["different-selector"],
        },
      }),
    ).toThrow();
    expect(() =>
      RecoverySourceContractV1Schema.parse({
        ...manual,
        coverageCompleteness: {
          isComplete: false,
          coveredSelectors: [manual.queryScope.selector],
        },
      }),
    ).toThrow();
  });

  it("roundtrips through the existing Payload Store and verifies the contract digest", () => {
    const contract = validSystemContract();
    const canonical = canonicalRecoverySourceContractV1(contract);
    const contractDigest =
      computeRecoverySourceContractDigest(contract);
    const bytes = Buffer.from(canonical, "utf8");
    const manifest = storeJsonContract(bytes, contractDigest);

    const loaded = loadRecoveryEvidencePayloadWithIntegrity(
      manifest,
      payloadStore,
    );

    expect(loaded.result).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "matched",
      actualSemanticDigest: contractDigest,
    });
    expect(loaded.payload).not.toBeNull();
    const materialized = materializeVerifiedEvidencePayload(
      loaded.payload!,
    );
    expect(materialized.payloadType).toBe("json");
    expect(
      computeRecoverySourceContractDigest(
        materialized.structuredValue,
      ),
    ).toBe(contractDigest);
    expect(
      RecoverySourceContractV1Schema.parse(
        materialized.structuredValue,
      ),
    ).toEqual(contract);
  });

  it("rejects tampered stored contract bytes through existing integrity checks", () => {
    const contract = validManualContract();
    const canonical = canonicalRecoverySourceContractV1(contract);
    const contractDigest =
      computeRecoverySourceContractDigest(contract);
    const bytes = Buffer.from(canonical, "utf8");
    const stored = payloadStore.put(
      bytes,
      computeRawPayloadDigest(bytes),
    );
    const manifest = {
      payloadType: "json" as const,
      payloadDigestProtocol: "jcs-sha256-v1" as const,
      payloadDigest: contractDigest,
      payloadStoreRef: stored.storeRef,
      payloadStorageMode: stored.storageMode,
    };

    writeFileSync(storedPayloadPath(bytes), Buffer.from("{}", "utf8"));

    expect(
      verifyRecoveryEvidencePayloadIntegrity(manifest, payloadStore),
    ).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "mismatch",
      actualStorageDigest: null,
      actualSemanticDigest: null,
      reasonCode: "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
    });
  });

  it("rejects malformed persisted JSON without issuing a contract", () => {
    const malformed = Buffer.from("{not-json", "utf8");
    const manifest: RecoveryEvidencePayloadIntegrityManifest = {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: computeRawPayloadDigest(malformed),
      payloadStoreRef: payloadStore.put(
        malformed,
        computeRawPayloadDigest(malformed),
      ).storeRef,
      payloadStorageMode: "content_addressed_file",
    };

    const loaded = loadRecoveryEvidencePayloadWithIntegrity(
      manifest,
      payloadStore,
    );

    expect(loaded.payload).toBeNull();
    expect(loaded.result.reasonCode).toBe(
      "EVIDENCE_PAYLOAD_JSON_INVALID",
    );
  });
});

function validSystemContract() {
  return {
    sourceContractSchemaVersion:
      "forgeflow.recovery-source-contract.v1" as const,
    sourceContractAuthority: "system_verified" as const,
    sourceType: "system_verification" as const,
    taskId,
    reviewId,
    originalUnknownWriteToolRunId: toolRunId,
    targetResourceIdentity: {
      resourceType: "ledger_entry",
      resourceRef: "ledger://orders/42",
      resourceVersion: "etag-42",
    },
    queryScope: {
      kind: "exact_resource" as const,
      selector: "ledger://orders/42",
    },
    observationTimeWindow: {
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-01T00:05:00.000Z",
    },
    coverageCompleteness: {
      isComplete: true as const,
      coveredSelectors: ["ledger://orders/42"],
    },
    negativeObservationSemantics:
      "authoritative_non_execution_marker" as const,
    provenance: "controlled_runtime_read" as const,
    result: "passed" as const,
    sourceObservedAt: "2026-01-01T00:02:00.000Z",
    payloadDigest: digest("1"),
    verifierBinding: {
      verifierId: "ledger-verifier",
      verifierVersion: "1.0.0",
      verifierConfigDigest: digest("2"),
      verificationId: "verification-42",
      bindingDigest: digest("3"),
      verificationResult: "passed" as const,
    },
  };
}

function validManualContract() {
  return {
    sourceContractSchemaVersion:
      "forgeflow.recovery-source-contract.v1" as const,
    sourceContractAuthority: "manual_attested" as const,
    sourceType: "manual_review" as const,
    taskId,
    reviewId,
    originalUnknownWriteToolRunId: toolRunId,
    targetResourceIdentity: {
      resourceType: "ledger_entry",
      resourceRef: "ledger://orders/42",
      resourceVersion: null,
    },
    queryScope: {
      kind: "exact_resource" as const,
      selector: "ledger://orders/42",
    },
    observationTimeWindow: {
      startsAt: "2026-01-01T00:00:00.000Z",
      endsAt: "2026-01-01T00:05:00.000Z",
    },
    coverageCompleteness: {
      isComplete: true as const,
      coveredSelectors: ["ledger://orders/42"],
    },
    negativeObservationSemantics:
      "manual_attested_non_execution" as const,
    provenance: "declared_payload" as const,
    result: "not_run" as const,
    sourceObservedAt: "2026-01-01T00:03:00.000Z",
    payloadDigest: digest("4"),
    manualAttestation: {
      actorId: "reviewer-1",
      actorType: "human_reviewer" as const,
      attestationId: "attestation-42",
      attestationDigest: digest("5"),
      responsibilityStatement:
        "I reviewed the authoritative source and attest to non-execution.",
    },
  };
}

function storeJsonContract(
  bytes: Uint8Array,
  semanticDigest: string,
): RecoveryEvidencePayloadIntegrityManifest {
  const stored = payloadStore.put(
    bytes,
    computeRawPayloadDigest(bytes),
  );
  return {
    payloadType: "json",
    payloadDigestProtocol: "jcs-sha256-v1",
    payloadDigest: semanticDigest,
    payloadStoreRef: stored.storeRef,
    payloadStorageMode: stored.storageMode,
  };
}

function storedPayloadPath(bytes: Uint8Array): string {
  return join(
    rootDirectory,
    "evidence",
    `${computeRawPayloadDigest(bytes).slice("sha256:".length)}.bin`,
  );
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
