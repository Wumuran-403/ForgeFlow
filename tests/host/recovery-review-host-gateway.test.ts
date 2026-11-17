import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import * as recoveryPublicApi from "../../src/recovery/index.js";
import * as hostContextApi from
  "../../src/host/authenticated-host-request-context.js";
import type {
  AuthenticatedHostRequestContext,
} from "../../src/host/authenticated-host-request-context.js";
import {
  assertAuthenticatedHostRequestContext,
} from "../../src/host/recovery-review-host-gateway.js";
import {
  createHostAuthFixture,
  claimsForKeyId,
  signAssertion,
} from "../host-auth/host-auth-fixture.js";

describe("RecoveryReviewHostGateway", () => {
  it("creates opaque Human and Verifier contexts with derived scope", () => {
    const fixture = createHostAuthFixture();
    const humanContext = fixture.gateway.createContext({
      assertion: fixture.issueAssertion(
        fixture.humanPrivateKey,
        "human-reviewer-key-1",
      ),
      access: "final_decision",
    });
    const verifierContext = fixture.gateway.createContext({
      assertion: fixture.issueAssertion(
        fixture.verifierPrivateKey,
        "host-verifier-key-1",
      ),
      access: "read_replay",
    });

    expect(
      assertAuthenticatedHostRequestContext(humanContext),
    ).toMatchObject({
      actorId: "reviewer-1",
      actorType: "human_reviewer",
      issuerScope: "manual_reviewer",
      allowedAccess: "final_decision",
      requestNonce: "gateway-request-nonce",
    });
    expect(
      assertAuthenticatedHostRequestContext(verifierContext),
    ).toMatchObject({
      actorId: "verifier-service-1",
      actorType: "host_verifier",
      issuerScope: "host_verifier",
      allowedAccess: "read_replay",
    });
  });

  it("rejects Context clones, casts, JSON roundtrips, and cross-access use", () => {
    const fixture = createHostAuthFixture();
    const context = fixture.gateway.createContext({
      assertion: fixture.issueAssertion(
        fixture.humanPrivateKey,
        "human-reviewer-key-1",
      ),
      access: "final_decision",
    });

    expect(() =>
      assertAuthenticatedHostRequestContext({ ...context }),
    ).toThrow();
    expect(() =>
      assertAuthenticatedHostRequestContext(
        JSON.parse(JSON.stringify(context)) as unknown,
      ),
    ).toThrow();
    expect(() =>
      assertAuthenticatedHostRequestContext(
        {} as AuthenticatedHostRequestContext,
      ),
    ).toThrow();
    expect(() =>
      assertAuthenticatedHostRequestContext(context, {
        access: "read_replay",
      }),
    ).toThrow();
  });

  it("rejects scope escalation and identity fields supplied by the request DTO", () => {
    const fixture = createHostAuthFixture();
    const finalOnlyClaims = claimsForKeyId(
      fixture.config,
      "human-reviewer-key-1",
      {
        scopes: ["recovery_review.final_decision"],
      },
    );
    const finalOnlyAssertion = signAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
      finalOnlyClaims,
    );

    expect(() =>
      fixture.gateway.createContext({
        assertion: finalOnlyAssertion,
        access: "read_replay",
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "RECOVERY_REVIEW_HOST_GATEWAY_DENIED",
      }),
    );
    expect(() =>
      fixture.gateway.createContext({
        assertion: finalOnlyAssertion,
        access: "final_decision",
        actorId: "reviewer-2",
        actorType: "host_verifier",
        issuerScope: "host_verifier",
      } as never),
    ).toThrow();
  });

  it("rejects cross-actor, cross-role, cross-issuer, and cross-key signatures", () => {
    const fixture = createHostAuthFixture();
    const verifierClaims = claimsForKeyId(
      fixture.config,
      "host-verifier-key-1",
    );
    const humanClaims = claimsForKeyId(
      fixture.config,
      "human-reviewer-key-1",
      {
        actorId: "reviewer-2",
        role: "host_verifier",
        actorType: "host_verifier",
        issuer: "unauthorized-issuer",
      },
    );

    expect(() =>
      fixture.gateway.createContext({
        assertion: signAssertion(
          fixture.humanPrivateKey,
          "host-verifier-key-1",
          verifierClaims,
        ),
        access: "final_decision",
      }),
    ).toThrow();
    expect(() =>
      fixture.gateway.createContext({
        assertion: signAssertion(
          fixture.humanPrivateKey,
          "human-reviewer-key-1",
          humanClaims,
        ),
        access: "final_decision",
      }),
    ).toThrow();
  });

  it("does not expose Gateway or Context creators through recovery public API", () => {
    expect(
      "RecoveryReviewHostGateway" in recoveryPublicApi,
    ).toBe(false);
    expect(
      "createAuthenticatedHostRequestContextForGateway" in
        recoveryPublicApi,
    ).toBe(false);
    expect(
      "Ed25519HostAuthenticationAdapter" in recoveryPublicApi,
    ).toBe(false);
    expect(
      "createAuthenticatedHostRequestContext" in hostContextApi,
    ).toBe(false);
  });

  it("keeps Gateway and Context imports out of ordinary business modules", () => {
    const modules = [
      "src/agent/agent-runner.ts",
      "src/tools/registry.ts",
      "src/recovery/recovery-manager.ts",
    ];

    for (const path of modules) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("recovery-review-host-gateway");
      expect(source).not.toContain(
        "authenticated-host-request-context",
      );
    }
  });
});
