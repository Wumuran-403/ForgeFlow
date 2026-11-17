import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  Ed25519HostAuthenticationAdapter,
} from "../../src/host-auth/ed25519-host-authentication-adapter.js";
import {
  HostAuthenticationConfigV1Schema,
} from "../../src/host-auth/host-authentication-config.js";
import {
  claimsForKeyId,
  createHostAuthFixture,
  signAssertion,
} from "./host-auth-fixture.js";

describe("Ed25519HostAuthenticationAdapter", () => {
  it("authenticates Human and Verifier principals with real signatures", () => {
    const fixture = createHostAuthFixture();
    const human = fixture.adapter.authenticate(
      fixture.issueAssertion(
        fixture.humanPrivateKey,
        "human-reviewer-key-1",
      ),
    );
    const verifier = fixture.adapter.authenticate(
      fixture.issueAssertion(
        fixture.verifierPrivateKey,
        "host-verifier-key-1",
      ),
    );

    expect(human).toMatchObject({
      actorId: "reviewer-1",
      actorType: "human_reviewer",
      role: "manual_reviewer",
      issuerScope: "manual_reviewer",
    });
    expect(verifier).toMatchObject({
      actorId: "verifier-service-1",
      actorType: "host_verifier",
      role: "host_verifier",
      issuerScope: "host_verifier",
    });
    expect(human.authenticationEvidenceId).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(JSON.stringify(human)).not.toContain("PRIVATE KEY");
  });

  it("rejects invalid signatures and unknown key IDs", () => {
    const fixture = createHostAuthFixture();
    const assertion = fixture.issueAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
    ) as { signature: string };

    expect(() =>
      fixture.adapter.authenticate({
        ...assertion,
        signature: "A".repeat(86),
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
    );
    expect(() =>
      fixture.adapter.authenticate({
        ...assertion,
        keyId: "unknown-key",
      }),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
    );
  });

  it("rejects signed claims that do not match trusted key mapping", () => {
    const fixture = createHostAuthFixture();
    const mismatches = [
      { actorId: "reviewer-2" },
      { role: "host_verifier" as const, actorType: "host_verifier" as const },
      { issuer: "unauthorized-issuer" },
    ];

    for (const overrides of mismatches) {
      const claims = claimsForKeyId(
        fixture.config,
        "human-reviewer-key-1",
        overrides,
      );
      const assertion = signAssertion(
        fixture.humanPrivateKey,
        "human-reviewer-key-1",
        claims,
      );
      expect(() => fixture.adapter.authenticate(assertion)).toThrowError(
        expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
      );
    }

    const narrowConfig = {
      ...fixture.config,
      trustedKeys: fixture.config.trustedKeys.map((key) =>
        key.keyId === "human-reviewer-key-1"
          ? {
              ...key,
              allowedScopes: ["recovery_review.final_decision" as const],
            }
          : key,
      ),
    };
    const narrowAdapter = new Ed25519HostAuthenticationAdapter(
      narrowConfig,
      () => new Date("2026-01-01T00:01:00.000Z"),
    );
    const scopeEscalation = signAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        scopes: [
          "recovery_review.final_decision",
          "recovery_review.read_replay",
        ],
      }),
    );
    expect(() =>
      narrowAdapter.authenticate(scopeEscalation),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
    );
  });

  it("rejects wrong audience, expired assertions, future notBefore, and excessive TTL", () => {
    const fixture = createHostAuthFixture();

    const assertions = [
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        audience: "other-audience",
      }),
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        issuedAt: "2025-12-31T23:50:00.000Z",
        notBefore: "2025-12-31T23:50:00.000Z",
        expiresAt: "2026-01-01T00:00:30.000Z",
      }),
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        issuedAt: "2026-01-01T00:00:00.000Z",
        notBefore: "2026-01-01T00:02:00.000Z",
        expiresAt: "2026-01-01T00:05:00.000Z",
      }),
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        issuedAt: "2026-01-01T00:00:00.000Z",
        notBefore: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:10:00.000Z",
      }),
    ];

    for (const claims of assertions) {
      expect(() =>
        fixture.adapter.authenticate(
          signAssertion(
            fixture.humanPrivateKey,
            "human-reviewer-key-1",
            claims,
          ),
        ),
      ).toThrowError(
        expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
      );
    }
  });

  it("rejects revoked assertions and revoked keys", () => {
    const revokedAssertionFixture = createHostAuthFixture({
      config: {
        revokedAssertionIds: ["manual_reviewer-assertion-1"],
      },
    });
    expect(() =>
      revokedAssertionFixture.adapter.authenticate(
        revokedAssertionFixture.issueAssertion(
          revokedAssertionFixture.humanPrivateKey,
          "human-reviewer-key-1",
        ),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
    );

    const base = createHostAuthFixture();
    const revokedKeyConfig = {
      ...base.config,
      trustedKeys: base.config.trustedKeys.map((key) =>
        key.keyId === "human-reviewer-key-1"
          ? { ...key, status: "revoked" as const }
          : key,
      ),
    };
    const revokedKeyAdapter = new Ed25519HostAuthenticationAdapter(
      revokedKeyConfig,
      () => new Date("2026-01-01T00:01:00.000Z"),
    );
    expect(() =>
      revokedKeyAdapter.authenticate(
        base.issueAssertion(
          base.humanPrivateKey,
          "human-reviewer-key-1",
        ),
      ),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
    );
  });

  it("rejects duplicate mappings and private key material in config", () => {
    const fixture = createHostAuthFixture();
    const humanMapping = fixture.config.trustedKeys[0]!;

    expect(() =>
      HostAuthenticationConfigV1Schema.parse({
        ...fixture.config,
        trustedKeys: [
          humanMapping,
          {
            ...humanMapping,
            keyId: "second-human-key",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      HostAuthenticationConfigV1Schema.parse({
        ...fixture.config,
        privateKeyPem: "must-not-be-accepted",
      }),
    ).toThrow();
    expect(() =>
      HostAuthenticationConfigV1Schema.parse({
        ...fixture.config,
        trustedKeys: fixture.config.trustedKeys.map((key) =>
          key.keyId === "host-verifier-key-1"
            ? { ...key, actorId: "reviewer-1" }
            : key,
        ),
      }),
    ).toThrow();
  });

  it("rejects a non-Ed25519 public key", () => {
    const fixture = createHostAuthFixture();
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const rsaPublicKey = rsa.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const config = {
      ...fixture.config,
      trustedKeys: [
        {
          ...fixture.config.trustedKeys[0]!,
          publicKeyPem: rsaPublicKey,
        },
      ],
    };

    expect(() =>
      new Ed25519HostAuthenticationAdapter(config),
    ).toThrowError(
      expect.objectContaining({ code: "HOST_AUTHENTICATION_INVALID" }),
    );
  });
});
