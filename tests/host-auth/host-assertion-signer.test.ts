import { describe, expect, it } from "vitest";

import {
  decodeHostAssertionBearerToken,
} from "../../src/host-auth/host-assertion-bearer.js";
import {
  issueHostAssertion,
} from "../../src/host-auth/host-assertion-signer.js";
import {
  claimsForKeyId,
  createHostAuthFixture,
  now,
  signAssertion,
} from "./host-auth-fixture.js";

describe("host assertion signer", () => {
  it("issues real signed Human and Verifier bearer assertions", () => {
    const fixture = createHostAuthFixture();
    const humanToken = issueHostAssertion({
      config: fixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: fixture.humanPrivateKey,
      now,
      assertionId: "human-issued",
    });
    const verifierToken = issueHostAssertion({
      config: fixture.config,
      keyId: "host-verifier-key-1",
      privateKey: fixture.verifierPrivateKey,
      now,
      assertionId: "verifier-issued",
    });

    expect(
      fixture.adapter.authenticate(
        decodeHostAssertionBearerToken(humanToken),
      ),
    ).toMatchObject({
      actorId: "reviewer-1",
      actorType: "human_reviewer",
    });
    expect(
      fixture.adapter.authenticate(
        decodeHostAssertionBearerToken(verifierToken),
      ),
    ).toMatchObject({
      actorId: "verifier-service-1",
      actorType: "host_verifier",
    });
  });

  it("cannot sign another actor or role with the wrong private key", () => {
    const fixture = createHostAuthFixture();

    expect(() =>
      issueHostAssertion({
        config: fixture.config,
        keyId: "human-reviewer-key-1",
        privateKey: fixture.verifierPrivateKey,
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_ASSERTION_SIGNING_DENIED" }),
    );
    expect(() =>
      issueHostAssertion({
        config: fixture.config,
        keyId: "unknown-key",
        privateKey: fixture.humanPrivateKey,
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_ASSERTION_SIGNING_DENIED" }),
    );
  });

  it("rejects scope escalation and excessive TTL", () => {
    const fixture = createHostAuthFixture();

    expect(() =>
      issueHostAssertion({
        config: {
          ...fixture.config,
          trustedKeys: fixture.config.trustedKeys.map((key) =>
            key.keyId === "human-reviewer-key-1"
              ? {
                  ...key,
                  allowedScopes: ["recovery_review.final_decision" as const],
                }
              : key,
          ),
        },
        keyId: "human-reviewer-key-1",
        privateKey: fixture.humanPrivateKey,
        scopeSubset: ["recovery_review.read_replay"],
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_ASSERTION_SIGNING_DENIED" }),
    );
    expect(() =>
      issueHostAssertion({
        config: fixture.config,
        keyId: "human-reviewer-key-1",
        privateKey: fixture.humanPrivateKey,
        ttlSeconds: fixture.config.maximumAssertionTtlSeconds + 1,
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_ASSERTION_SIGNING_DENIED" }),
    );
  });

  it("rejects revoked keys and a signed assertion whose claims do not match", () => {
    const fixture = createHostAuthFixture();
    const revokedConfig = {
      ...fixture.config,
      trustedKeys: fixture.config.trustedKeys.map((key) =>
        key.keyId === "human-reviewer-key-1"
          ? { ...key, status: "revoked" as const }
          : key,
      ),
    };
    expect(() =>
      issueHostAssertion({
        config: revokedConfig,
        keyId: "human-reviewer-key-1",
        privateKey: fixture.humanPrivateKey,
        now,
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_ASSERTION_SIGNING_DENIED" }),
    );

    const assertion = signAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        actorId: "reviewer-2",
      }),
    );
    expect(() => fixture.adapter.authenticate(assertion)).toThrow();
  });
});
