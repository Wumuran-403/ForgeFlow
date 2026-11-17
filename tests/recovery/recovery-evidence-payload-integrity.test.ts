import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  FileEvidencePayloadStore,
  RecoveryEvidencePayloadIntegrityResultSchema,
  RecoveryVerifiedEvidencePayloadInvalidError,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeReadbackResultPayloadDigest,
  verifyRecoveryEvidencePayloadIntegrity,
  type EvidencePayloadStore,
  type RecoveryEvidencePayloadIntegrityManifest,
  type RecoveryReadbackResult,
} from "../../src/recovery/index.js";
import {
  loadRecoveryEvidencePayloadWithIntegrity,
  materializeVerifiedEvidencePayload,
  type VerifiedEvidencePayload,
} from "../../src/recovery/recovery-evidence-payload-integrity.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";

let rootDirectory: string;
let payloadStore: FileEvidencePayloadStore;

beforeEach(() => {
  rootDirectory = mkdtempSync(join(tmpdir(), "forgeflow-integrity-"));
  payloadStore = new FileEvidencePayloadStore(
    join(rootDirectory, "evidence"),
  );
});

afterEach(() => {
  rmSync(rootDirectory, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("recovery evidence payload runtime integrity", () => {
  it("verifies raw byte storage and semantic digests", () => {
    const bytes = Buffer.from("authoritative raw evidence", "utf8");
    const digest = computeRawPayloadDigest(bytes);
    const manifest = storeManifest(bytes, {
      payloadType: "raw_bytes",
      payloadDigestProtocol: "sha256-raw-v1",
      payloadDigest: digest,
    });

    const result = verifyRecoveryEvidencePayloadIntegrity(
      manifest,
      payloadStore,
    );

    expect(result).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "matched",
      actualStorageDigest: digest,
      actualSemanticDigest: digest,
      reasonCode: "EVIDENCE_PAYLOAD_INTEGRITY_MATCHED",
    });
    expect(
      RecoveryEvidencePayloadIntegrityResultSchema.parse(result),
    ).toEqual(result);
  });

  it("separates storage bytes from JSON JCS semantic digest", () => {
    const value = {
      zeta: "last",
      alpha: { enabled: true, count: 2 },
    };
    const bytes = Buffer.from(
      '{"zeta":"last","alpha":{"count":2,"enabled":true}}',
      "utf8",
    );
    const storageDigest = computeRawPayloadDigest(bytes);
    const semanticDigest = computeJsonPayloadDigest(value);
    const manifest = storeManifest(bytes, {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: semanticDigest,
    });

    const result = verifyRecoveryEvidencePayloadIntegrity(
      manifest,
      payloadStore,
    );

    expect(storageDigest).not.toBe(semanticDigest);
    expect(result).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "matched",
      actualStorageDigest: storageDigest,
      actualSemanticDigest: semanticDigest,
    });
  });

  it("validates readback_result before computing its canonical digest", () => {
    const readback: RecoveryReadbackResult = {
      resourceRef: "ledger://write/1",
      resourceVersion: "etag-1",
      observedAt: "2026-01-01T00:00:00.000Z",
      outcome: "observed_succeeded",
      result: {
        accepted: true,
        receipt: "receipt-1",
      },
    };
    const bytes = Buffer.from(
      '{"result":{"receipt":"receipt-1","accepted":true},"outcome":"observed_succeeded","observedAt":"2026-01-01T00:00:00.000Z","resourceVersion":"etag-1","resourceRef":"ledger://write/1"}',
      "utf8",
    );
    const semanticDigest =
      computeReadbackResultPayloadDigest(readback);
    const manifest = storeManifest(bytes, {
      payloadType: "readback_result",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: semanticDigest,
    });

    expect(
      verifyRecoveryEvidencePayloadIntegrity(
        manifest,
        payloadStore,
      ),
    ).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "matched",
      actualStorageDigest: computeRawPayloadDigest(bytes),
      actualSemanticDigest: semanticDigest,
    });
  });

  it("classifies file replacement as an available storage mismatch without inventing an actual digest", () => {
    const bytes = Buffer.from("original evidence", "utf8");
    const digest = computeRawPayloadDigest(bytes);
    const manifest = storeManifest(bytes, {
      payloadType: "raw_bytes",
      payloadDigestProtocol: "sha256-raw-v1",
      payloadDigest: digest,
    });
    writeFileSync(
      storedPayloadPath(digest),
      Buffer.from("replaced evidence"),
    );

    const result = verifyRecoveryEvidencePayloadIntegrity(
      manifest,
      payloadStore,
    );

    expect(result).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "mismatch",
      actualStorageDigest: null,
      actualSemanticDigest: null,
      reasonCode: "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
    });
    expect(JSON.stringify(result)).not.toContain(rootDirectory);
  });

  it("reports a semantic digest mismatch from independently computed content", () => {
    const value = { receipt: "receipt-1", accepted: true };
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const manifest = storeManifest(bytes, {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: digest("f"),
    });

    const result = verifyRecoveryEvidencePayloadIntegrity(
      manifest,
      payloadStore,
    );

    expect(result).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "mismatch",
      actualStorageDigest: computeRawPayloadDigest(bytes),
      actualSemanticDigest: computeJsonPayloadDigest(value),
      reasonCode: "EVIDENCE_PAYLOAD_SEMANTIC_DIGEST_MISMATCH",
    });
  });

  it("rejects invalid store references before calling the payload store", () => {
    const read = vi.fn<EvidencePayloadStore["read"]>();
    const result = verifyRecoveryEvidencePayloadIntegrity(
      {
        payloadType: "raw_bytes",
        payloadDigestProtocol: "sha256-raw-v1",
        payloadDigest: digest("a"),
        payloadStoreRef: "C:\\private\\evidence.bin",
        payloadStorageMode: "content_addressed_file",
      },
      { put: vi.fn(), read },
    );

    expect(result).toMatchObject({
      availabilityStatus: "unavailable",
      integrityStatus: "not_checked",
      actualStorageDigest: null,
      actualSemanticDigest: null,
      reasonCode: "EVIDENCE_PAYLOAD_STORE_REF_INVALID",
    });
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("C:\\\\private");
  });

  it("maps a missing payload file to ENOENT without exposing its path", () => {
    const digestValue = digest("b");
    const result = verifyRecoveryEvidencePayloadIntegrity(
      {
        payloadType: "raw_bytes",
        payloadDigestProtocol: "sha256-raw-v1",
        payloadDigest: digestValue,
        payloadStoreRef: storeRef(digestValue),
        payloadStorageMode: "content_addressed_file",
      },
      payloadStore,
    );

    expect(result).toMatchObject({
      availabilityStatus: "unavailable",
      integrityStatus: "not_checked",
      actualStorageDigest: null,
      actualSemanticDigest: null,
      reasonCode: "ENOENT",
    });
    expect(JSON.stringify(result)).not.toContain(rootDirectory);
  });

  it("maps ordinary I/O failures to a redacted result", () => {
    const secretPath = join(rootDirectory, "private", "secret.bin");
    const result = verifyRecoveryEvidencePayloadIntegrity(
      {
        payloadType: "raw_bytes",
        payloadDigestProtocol: "sha256-raw-v1",
        payloadDigest: digest("c"),
        payloadStoreRef: storeRef(digest("c")),
        payloadStorageMode: "content_addressed_file",
      },
      {
        put: vi.fn(),
        read: () => {
          throw Object.assign(
            new Error(`EACCES ${secretPath} RAW_PAYLOAD_SECRET`),
            { code: "EACCES" },
          );
        },
      },
    );

    expect(result).toMatchObject({
      availabilityStatus: "unavailable",
      integrityStatus: "not_checked",
      reasonCode: "EVIDENCE_PAYLOAD_STORE_IO_ERROR",
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(secretPath);
    expect(serialized).not.toContain("RAW_PAYLOAD_SECRET");
    expect(serialized).not.toContain("EACCES");
  });

  it("fails external_reference closed without network or store access", () => {
    const read = vi.fn<EvidencePayloadStore["read"]>();
    const result = verifyRecoveryEvidencePayloadIntegrity(
      {
        payloadType: "external_reference",
        payloadDigestProtocol: "adapter-content-sha256-v1",
        payloadDigest: digest("d"),
        payloadStoreRef: null,
        payloadStorageMode: "reference_only",
      },
      { put: vi.fn(), read },
    );

    expect(result).toMatchObject({
      availabilityStatus: "unavailable",
      integrityStatus: "not_checked",
      actualStorageDigest: null,
      actualSemanticDigest: null,
      reasonCode:
        "EVIDENCE_PAYLOAD_EXTERNAL_REFERENCE_UNSUPPORTED",
    });
    expect(read).not.toHaveBeenCalled();
  });

  it("rejects malformed manifest digests and protocol pairings", () => {
    const bytes = Buffer.from("payload", "utf8");
    const digestValue = computeRawPayloadDigest(bytes);
    const store = payloadStore.put(bytes, digestValue);

    expect(
      verifyRecoveryEvidencePayloadIntegrity(
        {
          payloadType: "raw_bytes",
          payloadDigestProtocol: "sha256-raw-v1",
          payloadDigest: "not-a-digest",
          payloadStoreRef: store.storeRef,
          payloadStorageMode: "content_addressed_file",
        },
        payloadStore,
      ),
    ).toMatchObject({
      availabilityStatus: "unavailable",
      integrityStatus: "not_checked",
      reasonCode: "EVIDENCE_PAYLOAD_DIGEST_INVALID",
    });

    expect(
      verifyRecoveryEvidencePayloadIntegrity(
        {
          payloadType: "json",
          payloadDigestProtocol: "sha256-raw-v1",
          payloadDigest: digestValue,
          payloadStoreRef: store.storeRef,
          payloadStorageMode: "content_addressed_file",
        },
        payloadStore,
      ),
    ).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "mismatch",
      actualStorageDigest: digestValue,
      actualSemanticDigest: null,
      reasonCode: "EVIDENCE_PAYLOAD_DIGEST_INVALID",
    });
  });

  it("classifies malformed JSON and invalid readback schemas", () => {
    const invalidJson = Buffer.from("{not-json", "utf8");
    const invalidJsonManifest = storeManifest(invalidJson, {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: computeRawPayloadDigest(invalidJson),
    });
    const jsonResult = verifyRecoveryEvidencePayloadIntegrity(
      invalidJsonManifest,
      payloadStore,
    );
    expect(jsonResult).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "mismatch",
      actualStorageDigest:
        computeRawPayloadDigest(invalidJson),
      actualSemanticDigest: null,
      reasonCode: "EVIDENCE_PAYLOAD_JSON_INVALID",
    });

    const invalidReadback = Buffer.from(
      canonicalJson({
        resourceRef: "ledger://write/1",
        resourceVersion: "etag-1",
        observedAt: "not-a-timestamp",
        outcome: "observed_succeeded",
        result: null,
      }),
      "utf8",
    );
    const invalidReadbackManifest = storeManifest(
      invalidReadback,
      {
        payloadType: "readback_result",
        payloadDigestProtocol: "jcs-sha256-v1",
        payloadDigest: computeRawPayloadDigest(invalidReadback),
      },
    );
    expect(
      verifyRecoveryEvidencePayloadIntegrity(
        invalidReadbackManifest,
        payloadStore,
      ),
    ).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "mismatch",
      actualStorageDigest:
        computeRawPayloadDigest(invalidReadback),
      actualSemanticDigest: null,
      reasonCode:
        "EVIDENCE_PAYLOAD_READBACK_RESULT_INVALID",
    });
  });

  it("returns only v8 availability and integrity statuses", () => {
    const result = verifyRecoveryEvidencePayloadIntegrity(
      {
        payloadType: "raw_bytes",
        payloadDigestProtocol: "sha256-raw-v1",
        payloadDigest: digest("e"),
        payloadStoreRef: storeRef(digest("e")),
        payloadStorageMode: "content_addressed_file",
      },
      payloadStore,
    );
    expect(result.availabilityStatus).toBe("unavailable");
    expect(result.integrityStatus).toBe("not_checked");
    expect(() =>
      RecoveryEvidencePayloadIntegrityResultSchema.parse({
        ...result,
        availabilityStatus: "digest_mismatch",
      }),
    ).toThrow();
    expect(() =>
      RecoveryEvidencePayloadIntegrityResultSchema.parse({
        ...result,
        integrityStatus: "unknown",
      }),
    ).toThrow();
  });

  it("does not retain or expose the original payload", () => {
    const payloadSecret = "PAYLOAD_CONTENT_MUST_NOT_ESCAPE";
    const bytes = Buffer.from(payloadSecret, "utf8");
    const manifest = storeManifest(bytes, {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: computeJsonPayloadDigest(payloadSecret),
    });
    const result = verifyRecoveryEvidencePayloadIntegrity(
      manifest,
      payloadStore,
    );

    expect(result.integrityStatus).toBe("mismatch");
    expect(Object.keys(result)).not.toContain("payload");
    expect(JSON.stringify(result)).not.toContain(payloadSecret);
  });

  it("uses one store read for integrity and verified payload handoff", () => {
    const value = {
      receipt: "receipt-1",
      accepted: true,
    };
    const bytes = Buffer.from(canonicalJson(value), "utf8");
    const manifest = storeManifest(bytes, {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: computeJsonPayloadDigest(value),
    });
    const read = vi.fn(
      payloadStore.read.bind(payloadStore),
    );

    const loaded = loadRecoveryEvidencePayloadWithIntegrity(
      manifest,
      {
        put: payloadStore.put.bind(payloadStore),
        read,
      },
    );

    expect(read).toHaveBeenCalledTimes(1);
    expect(loaded.result).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "matched",
    });
    expect(loaded.payload).toMatchObject({
      payloadType: "json",
      provenance: "declared_payload",
    });
    const materialized = materializeVerifiedEvidencePayload(
      loaded.payload as VerifiedEvidencePayload,
    );
    expect(materialized).toMatchObject({
      payloadType: "json",
      bytes: null,
      structuredValue: value,
      readbackResult: null,
    });
    expect(Object.isFrozen(materialized)).toBe(true);
    expect(
      Object.isFrozen(materialized.structuredValue),
    ).toBe(true);
    expect(
      Object.keys(loaded.payload as VerifiedEvidencePayload),
    ).not.toEqual(
      expect.arrayContaining(["bytes", "path", "fileHandle"]),
    );
    expect(JSON.stringify(loaded.payload)).not.toContain(rootDirectory);
  });

  it("does not issue a verified payload when integrity fails", () => {
    const bytes = Buffer.from("integrity failure", "utf8");
    const manifest = storeManifest(bytes, {
      payloadType: "json",
      payloadDigestProtocol: "jcs-sha256-v1",
      payloadDigest: digest("f"),
    });

    const loaded = loadRecoveryEvidencePayloadWithIntegrity(
      manifest,
      payloadStore,
    );

    expect(loaded.result.integrityStatus).toBe("mismatch");
    expect(loaded.payload).toBeNull();
  });

  it("rejects forged verified payload handles before materialization", () => {
    expect(() =>
      materializeVerifiedEvidencePayload({
        payloadType: "json",
        provenance: "declared_payload",
      }),
    ).toThrow(RecoveryVerifiedEvidencePayloadInvalidError);
  });
});

function storeManifest(
  bytes: Uint8Array,
  input: Pick<
    RecoveryEvidencePayloadIntegrityManifest,
    | "payloadType"
    | "payloadDigestProtocol"
    | "payloadDigest"
  >,
): RecoveryEvidencePayloadIntegrityManifest {
  const stored = payloadStore.put(
    bytes,
    computeRawPayloadDigest(bytes),
  );
  return {
    ...input,
    payloadStoreRef: stored.storeRef,
    payloadStorageMode: stored.storageMode,
  };
}

function storedPayloadPath(digestValue: string): string {
  return join(
    rootDirectory,
    "evidence",
    `${digestValue.slice("sha256:".length)}.bin`,
  );
}

function storeRef(digestValue: string): string {
  return `evidence-file:sha256/${digestValue.slice(
    "sha256:".length,
  )}`;
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
