import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  RecoveryEvidenceEnvelopeSchema,
  canonicalRecoveryEvidenceEnvelope,
  computeExternalReferencePayloadDigest,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeReadbackResultPayloadDigest,
  computeRecoveryEvidenceEnvelopeDigest,
  type RecoveryEvidenceEnvelope,
} from "../../src/recovery/index.js";
import { CanonicalJsonError } from "../../src/shared/canonical-json.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const hashC = `sha256:${"c".repeat(64)}`;

describe("Recovery evidence contract", () => {
  it("accepts source-specific manual and system evidence envelopes", () => {
    expect(
      RecoveryEvidenceEnvelopeSchema.parse(manualEnvelope()),
    ).toMatchObject({
      sourceType: "manual_review",
      actorId: "reviewer-1",
      verifierId: null,
      verificationId: null,
    });
    expect(
      RecoveryEvidenceEnvelopeSchema.parse(systemEnvelope()),
    ).toMatchObject({
      sourceType: "system_verification",
      actorId: null,
      verifierId: "host-read-verifier",
      verificationId: "verification-1",
    });
  });

  it("rejects source-specific identity fields that do not match", () => {
    expect(() =>
      RecoveryEvidenceEnvelopeSchema.parse({
        ...manualEnvelope(),
        actorId: null,
      }),
    ).toThrow();
    expect(() =>
      RecoveryEvidenceEnvelopeSchema.parse({
        ...manualEnvelope(),
        verifierId: "unexpected-verifier",
      }),
    ).toThrow();
    expect(() =>
      RecoveryEvidenceEnvelopeSchema.parse({
        ...systemEnvelope(),
        actorId: "unexpected-user",
      }),
    ).toThrow();
    expect(() =>
      RecoveryEvidenceEnvelopeSchema.parse({
        ...systemEnvelope(),
        verifierId: null,
      }),
    ).toThrow();
  });

  it("requires immutable reference metadata for external evidence", () => {
    expect(() =>
      RecoveryEvidenceEnvelopeSchema.parse({
        ...systemEnvelope(),
        payloadType: "external_reference",
        payloadDigestProtocol: "adapter-content-sha256-v1",
        resourceRef: null,
        resourceVersion: null,
      }),
    ).toThrow(/resourceRef/i);
    expect(() =>
      RecoveryEvidenceEnvelopeSchema.parse({
        ...manualEnvelope(),
        payloadType: "raw_bytes",
        payloadDigestProtocol: "jcs-sha256-v1",
      }),
    ).toThrow(/digest protocol/i);
  });

  it("keeps the envelope digest stable while excluding display and operation timestamps", () => {
    const first = manualEnvelope();
    const second: RecoveryEvidenceEnvelope = {
      ...first,
      submittedAt: "2026-01-02T00:00:00.000Z",
      verifiedAt: "2026-01-02T01:00:00.000Z",
      redactedSummary: "A different non-authoritative display summary.",
    };

    expect(canonicalRecoveryEvidenceEnvelope(second)).toBe(
      canonicalRecoveryEvidenceEnvelope(first),
    );
    expect(computeRecoveryEvidenceEnvelopeDigest(second)).toBe(
      computeRecoveryEvidenceEnvelopeDigest(first),
    );
  });

  it("changes the envelope digest when an authoritative field changes", () => {
    const original = manualEnvelope();
    const changed = {
      ...original,
      toolVersion: "2",
    };

    expect(computeRecoveryEvidenceEnvelopeDigest(changed)).not.toBe(
      computeRecoveryEvidenceEnvelopeDigest(original),
    );
  });

  it("normalizes object key order without changing arrays", () => {
    const first = manualEnvelope();
    const reordered = Object.fromEntries(
      Object.entries(first).reverse(),
    ) as RecoveryEvidenceEnvelope;

    expect(canonicalRecoveryEvidenceEnvelope(reordered)).toBe(
      canonicalRecoveryEvidenceEnvelope(first),
    );
    expect(
      computeJsonPayloadDigest({ values: [1, 2] }),
    ).toBe(computeJsonPayloadDigest({ values: [1, 2] }));
    expect(
      computeJsonPayloadDigest({ values: [1, 2] }),
    ).not.toBe(computeJsonPayloadDigest({ values: [2, 1] }));
  });

  it("hashes raw bytes and adapter-fetched content rather than a URL string", () => {
    const bytes = new TextEncoder().encode("authoritative payload");
    const expected = `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`;

    expect(computeRawPayloadDigest(bytes)).toBe(expected);
    expect(computeExternalReferencePayloadDigest(bytes)).toEqual({
      payloadDigest: expected,
      payloadDigestProtocol: "adapter-content-sha256-v1",
    });
    expect(
      computeExternalReferencePayloadDigest({
        manufacturer: "Example",
        accepted: true,
      }),
    ).toEqual({
      payloadDigest: computeJsonPayloadDigest({
        manufacturer: "Example",
        accepted: true,
      }),
      payloadDigestProtocol: "adapter-content-sha256-v1",
    });
  });

  it("hashes normalized read-back results deterministically", () => {
    const first = {
      resourceRef: "ledger://write/1",
      resourceVersion: "etag-1",
      observedAt: timestamp,
      outcome: "observed_succeeded" as const,
      result: {
        accepted: true,
        receipt: "receipt-1",
      },
    };

    expect(computeReadbackResultPayloadDigest(first)).toBe(
      computeReadbackResultPayloadDigest({
        ...first,
        result: {
          receipt: "receipt-1",
          accepted: true,
        },
      }),
    );
  });

  it("rejects unsupported canonical JSON values before hashing", () => {
    for (const value of [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      -0,
      1n,
      new Date(timestamp),
    ]) {
      expect(() =>
        computeJsonPayloadDigest(value as never),
      ).toThrow(CanonicalJsonError);
    }
  });
});

function manualEnvelope(): RecoveryEvidenceEnvelope {
  return RecoveryEvidenceEnvelopeSchema.parse({
    schemaVersion: "forgeflow.recovery-evidence.v1",
    evidenceRef: "audit://review/1",
    sourceType: "manual_review",
    outcome: "observed_succeeded",
    sourceObservedAt: timestamp,
    submittedAt: timestamp,
    verifiedAt: null,
    resourceRef: null,
    resourceVersion: null,
    taskId: "task-1",
    toolRunId: "run-1",
    toolName: "bom_update",
    toolVersion: "1",
    inputSchemaHash: hashA,
    canonicalInputHash: hashB,
    idempotencyKey: hashC,
    actorId: "reviewer-1",
    verifierId: null,
    verificationId: null,
    payloadType: "json",
    payloadDigestProtocol: "jcs-sha256-v1",
    payloadDigest: hashA,
    redactedSummary: "Manual review accepted.",
  });
}

function systemEnvelope(): RecoveryEvidenceEnvelope {
  return RecoveryEvidenceEnvelopeSchema.parse({
    ...manualEnvelope(),
    sourceType: "system_verification",
    actorId: null,
    verifierId: "host-read-verifier",
    verificationId: "verification-1",
  });
}
