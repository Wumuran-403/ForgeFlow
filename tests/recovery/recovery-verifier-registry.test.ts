import { describe, expect, it } from "vitest";

import {
  RecoveryVerifierAlreadyRegisteredError,
  RecoveryVerifierCompatibilityError,
  RecoveryVerifierDefinitionInvalidError,
  RecoveryVerifierNotFoundError,
  RecoveryVerifierResultInvalidError,
} from "../../src/recovery/recovery-contract-errors.js";
import {
  RecoveryVerifierRegistry,
  type RecoveryVerifierCompatibilityInput,
  type RecoveryVerifierContext,
  type RecoveryVerifierDefinition,
  type RecoveryVerifierResult,
} from "../../src/recovery/recovery-verifier-registry.js";

const VERIFICATION_ID = "verification-contract";

function context(
  overrides: Partial<RecoveryVerifierContext> = {},
): RecoveryVerifierContext {
  return {
    taskId: "task-contract",
    reviewId: "review-contract",
    originalToolRunId: "write-run-contract",
    evidenceSubmissionId: "submission-contract",
    verificationId: VERIFICATION_ID,
    verificationCheckId: "check-verifier-contract",
    verifierConfigDigest: `sha256:${"e".repeat(64)}`,
    payloadType: "json",
    sourceType: "system_verification",
    verificationStartedAt: "2026-11-07T01:02:00.000Z",
    authenticatedActorId: null,
    trustAnchorId: "host-trust-anchor",
    readbackToolRunId: null,
    toolMessageId: null,
    ...overrides,
  };
}

function result(
  overrides: Partial<RecoveryVerifierResult> = {},
): RecoveryVerifierResult {
  return {
    status: "passed",
    reasonCode: "EXPECTED_STATE_OBSERVED",
    redactedSummary: "Expected state was observed.",
    integrity: "matched",
    authenticity: "system_verified",
    ...overrides,
  };
}

function verifier(): RecoveryVerifierDefinition {
  return {
    id: "host_verifier",
    version: "1",
    description: "Host-owned inventory verifier.",
    allowedPayloadTypes: ["json"],
    allowedSourceTypes: ["system_verification"],
    readbackRequired: false,
    verify: () => result(),
  };
}

describe("RecoveryVerifierRegistry", () => {
  it("registers a host-owned verifier and resolves it without fallback", () => {
    const registry = new RecoveryVerifierRegistry();
    registry.register(verifier());

    expect(registry.get("host_verifier")).toMatchObject({
      id: "host_verifier",
      version: "1",
      allowedPayloadTypes: ["json"],
      allowedSourceTypes: ["system_verification"],
      readbackRequired: false,
      allowlistId: null,
    });
    expect(() => registry.get("model_selected_verifier")).toThrow(
      RecoveryVerifierNotFoundError,
    );
  });

  it("rejects duplicate verifier ids", () => {
    const registry = new RecoveryVerifierRegistry();
    registry.register(verifier());
    expect(() => registry.register(verifier())).toThrow(
      RecoveryVerifierAlreadyRegisteredError,
    );
  });

  it("rejects verifier definitions without a host verify function", () => {
    const registry = new RecoveryVerifierRegistry();
    expect(() =>
      registry.register({
        ...verifier(),
        verify: "model_callback",
      } as unknown as RecoveryVerifierDefinition),
    ).toThrow(RecoveryVerifierDefinitionInvalidError);
  });

  it("rejects unsupported payload, source, and missing readback", () => {
    const registry = new RecoveryVerifierRegistry();
    registry.register(verifier());

    expect(() =>
      registry.resolve({
        verifierId: "host_verifier",
        payloadType: "raw_bytes",
        sourceType: "system_verification",
        hasReadback: false,
      }),
    ).toThrow(RecoveryVerifierCompatibilityError);

    expect(() =>
      registry.resolve({
        verifierId: "host_verifier",
        payloadType: "json",
        sourceType: "manual_review",
        hasReadback: false,
      }),
    ).toThrow(RecoveryVerifierCompatibilityError);

    registry.register({
      ...verifier(),
      id: "readback_verifier",
      allowedPayloadTypes: ["readback_result"],
      readbackRequired: true,
      allowlistId: "inventory_readback",
    });
    expect(() =>
      registry.resolve({
        verifierId: "readback_verifier",
        payloadType: "readback_result",
        sourceType: "system_verification",
        hasReadback: false,
      }),
    ).toThrow(RecoveryVerifierCompatibilityError);
  });

  it("rejects review-final and availability values in verifier results", () => {
    const registry = new RecoveryVerifierRegistry();
    registry.register(verifier());

    for (const status of [
      "unavailable",
      "confirmed_succeeded",
      "confirmed_not_executed",
    ]) {
      expect(() =>
        registry.validateResult(
          "host_verifier",
          { ...result(), status },
          context(),
        ),
      ).toThrow(RecoveryVerifierResultInvalidError);
    }
  });

  it("keeps authenticity host-bound instead of trusting verifier claims", () => {
    const registry = new RecoveryVerifierRegistry();
    registry.register(verifier());
    registry.register({
      ...verifier(),
      id: "manual_verifier",
      allowedSourceTypes: ["manual_review"],
    });

    expect(() =>
      registry.validateResult(
        "host_verifier",
        result({ authenticity: "system_verified" }),
        context({ trustAnchorId: null }),
      ),
    ).toThrow(RecoveryVerifierResultInvalidError);

    expect(() =>
      registry.validateResult(
        "manual_verifier",
        result({ authenticity: "manual_attested" }),
        context({
          sourceType: "manual_review",
          authenticatedActorId: null,
          trustAnchorId: null,
        }),
      ),
    ).toThrow(RecoveryVerifierResultInvalidError);

    expect(
      registry.validateResult(
        "manual_verifier",
        result({ authenticity: "manual_attested" }),
        context({
          sourceType: "manual_review",
          authenticatedActorId: "host-reviewer",
          trustAnchorId: null,
        }),
      ),
    ).toMatchObject({
      authenticity: "manual_attested",
    });

    expect(
      registry.validateResult(
        "host_verifier",
        result({ authenticity: "system_verified" }),
        context(),
      ),
    ).toMatchObject({
      status: "passed",
      integrity: "matched",
      authenticity: "system_verified",
    });
  });

  it("rejects invalid payload/source enum values at the public boundary", () => {
    const registry = new RecoveryVerifierRegistry();
    registry.register(verifier());

    expect(() =>
      registry.resolve({
        verifierId: "host_verifier",
        payloadType: "model_payload",
        sourceType: "system_verification",
        hasReadback: false,
      } as unknown as RecoveryVerifierCompatibilityInput),
    ).toThrow(RecoveryVerifierCompatibilityError);
  });
});
