import { describe, expect, it } from "vitest";

import {
  HostAssertionV1Schema,
  canonicalHostAssertionSigningInput,
  computeHostAssertionDigest,
} from "../../src/host-auth/host-assertion.js";
import {
  claimsForKeyId,
  createHostAuthFixture,
} from "./host-auth-fixture.js";

describe("HostAssertionV1", () => {
  it("accepts signed Human and Verifier assertions", () => {
    const fixture = createHostAuthFixture();
    const human = fixture.issueAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
    );
    const verifier = fixture.issueAssertion(
      fixture.verifierPrivateKey,
      "host-verifier-key-1",
    );

    expect(HostAssertionV1Schema.parse(human)).toMatchObject({
      keyId: "human-reviewer-key-1",
      claims: {
        actorType: "human_reviewer",
        role: "manual_reviewer",
      },
    });
    expect(HostAssertionV1Schema.parse(verifier)).toMatchObject({
      keyId: "host-verifier-key-1",
      claims: {
        actorType: "host_verifier",
        role: "host_verifier",
      },
    });
  });

  it("rejects unknown fields, multiple roles, and malformed signatures", () => {
    const fixture = createHostAuthFixture();
    const assertion = fixture.issueAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
    ) as Record<string, unknown>;

    expect(() =>
      HostAssertionV1Schema.parse({
        ...assertion,
        roles: ["manual_reviewer", "host_verifier"],
      }),
    ).toThrow();
    expect(() =>
      HostAssertionV1Schema.parse({
        ...assertion,
        signature: "short",
      }),
    ).toThrow();
  });

  it("rejects role and actorType mismatch", () => {
    const fixture = createHostAuthFixture();
    const claims = claimsForKeyId(
      fixture.config,
      "host-verifier-key-1",
      { actorType: "human_reviewer" },
    );

    expect(() => HostAssertionV1Schema.parse({
      schemaVersion: "forgeflow.host-assertion.v1",
      keyId: "host-verifier-key-1",
      claims,
      signature: "A".repeat(86),
    })).toThrow();
  });

  it("uses canonical signing input and stable assertion digest", () => {
    const fixture = createHostAuthFixture();
    const assertion = fixture.issueAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
    ) as {
      schemaVersion: string;
      keyId: string;
      claims: unknown;
      signature: string;
    };
    const reordered = {
      signature: assertion.signature,
      claims: assertion.claims,
      keyId: assertion.keyId,
      schemaVersion: assertion.schemaVersion,
    };

    expect(canonicalHostAssertionSigningInput(assertion)).toBe(
      canonicalHostAssertionSigningInput(reordered),
    );
    expect(computeHostAssertionDigest(assertion)).toBe(
      computeHostAssertionDigest(reordered),
    );
  });
});
