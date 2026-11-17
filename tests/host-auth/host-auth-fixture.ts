import {
  generateKeyPairSync,
  sign,
  type KeyObject,
} from "node:crypto";

import {
  HostAssertionV1Schema,
  canonicalHostAssertionSigningInput,
  type HostAssertionV1Claims,
  type HostIssuerRole,
} from "../../src/host-auth/host-assertion.js";
import {
  Ed25519HostAuthenticationAdapter,
} from "../../src/host-auth/ed25519-host-authentication-adapter.js";
import type { HostAuthenticationConfigV1 } from "../../src/host-auth/host-authentication-config.js";
import { RecoveryReviewHostGateway } from "../../src/host/recovery-review-host-gateway.js";

export const now = new Date("2026-01-01T00:01:00.000Z");

export interface HostAuthFixture {
  readonly config: HostAuthenticationConfigV1;
  readonly adapter: Ed25519HostAuthenticationAdapter;
  readonly gateway: RecoveryReviewHostGateway;
  readonly humanPrivateKey: KeyObject;
  readonly verifierPrivateKey: KeyObject;
  readonly issueAssertion: (
    privateKey: KeyObject,
    keyId: string,
    claimsOverrides?: Partial<HostAssertionV1Claims>,
  ) => unknown;
}

export function createHostAuthFixture(input?: {
  readonly config?: Partial<HostAuthenticationConfigV1>;
  readonly now?: Date;
}): HostAuthFixture {
  const human = generateKeyPairSync("ed25519");
  const verifier = generateKeyPairSync("ed25519");
  const humanPublicKey = human.publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();
  const verifierPublicKey = verifier.publicKey.export({
    type: "spki",
    format: "pem",
  }).toString();

  const config = {
    schemaVersion: "forgeflow.host-authentication-config.v1",
    audience: "forgeflow.step6_3_5.recovery-review",
    maximumAssertionTtlSeconds: 300,
    clockSkewSeconds: 5,
    trustedKeys: [
      {
        keyId: "human-reviewer-key-1",
        issuer: "local-host-auth",
        publicKeyPem: humanPublicKey,
        actorId: "reviewer-1",
        actorType: "human_reviewer",
        role: "manual_reviewer",
        allowedScopes: [
          "recovery_review.final_decision",
          "recovery_review.read_replay",
        ],
        status: "active",
      },
      {
        keyId: "host-verifier-key-1",
        issuer: "local-host-auth",
        publicKeyPem: verifierPublicKey,
        actorId: "verifier-service-1",
        actorType: "host_verifier",
        role: "host_verifier",
        allowedScopes: [
          "recovery_review.final_decision",
          "recovery_review.read_replay",
        ],
        status: "active",
      },
    ],
    revokedAssertionIds: [],
    ...input?.config,
  } satisfies HostAuthenticationConfigV1;

  const fixedNow = input?.now ?? now;
  const adapter = new Ed25519HostAuthenticationAdapter(
    config,
    () => fixedNow,
  );
  const gateway = new RecoveryReviewHostGateway(
    adapter,
    () => fixedNow,
    () => "gateway-request-nonce",
  );

  return {
    config,
    adapter,
    gateway,
    humanPrivateKey: human.privateKey,
    verifierPrivateKey: verifier.privateKey,
    issueAssertion: (privateKey, keyId, claimsOverrides) =>
      signAssertion(
        privateKey,
        keyId,
        claimsForKeyId(config, keyId, claimsOverrides),
      ),
  };
}

export function claimsForKeyId(
  config: HostAuthenticationConfigV1,
  keyId: string,
  overrides: Partial<HostAssertionV1Claims> = {},
): HostAssertionV1Claims {
  const mapping = config.trustedKeys.find((key) => key.keyId === keyId);
  if (mapping === undefined) {
    throw new Error("Missing key mapping.");
  }
  return {
    issuer: mapping.issuer,
    audience: config.audience,
    actorId: mapping.actorId,
    actorType: mapping.actorType,
    role: mapping.role,
    scopes: [...mapping.allowedScopes],
    issuedAt: "2026-01-01T00:00:00.000Z",
    notBefore: "2026-01-01T00:00:00.000Z",
    expiresAt: "2026-01-01T00:05:00.000Z",
    assertionId: `${mapping.role}-assertion-1`,
    ...overrides,
  };
}

export function signAssertion(
  privateKey: KeyObject,
  keyId: string,
  claims: HostAssertionV1Claims,
): unknown {
  const unsigned = {
    schemaVersion: "forgeflow.host-assertion.v1",
    keyId,
    claims,
    signature: "A".repeat(86),
  };
  HostAssertionV1Schema.parse(unsigned);
  const signature = sign(
    null,
    Buffer.from(
      canonicalHostAssertionSigningInput(unsigned),
      "utf8",
    ),
    privateKey,
  ).toString("base64url");
  return {
    ...unsigned,
    signature,
  };
}

export function roleForFixture(
  role: HostIssuerRole,
): {
  readonly keyId: string;
  readonly privateKey: (fixture: HostAuthFixture) => KeyObject;
} {
  return role === "manual_reviewer"
    ? {
        keyId: "human-reviewer-key-1",
        privateKey: (fixture) => fixture.humanPrivateKey,
      }
    : {
        keyId: "host-verifier-key-1",
        privateKey: (fixture) => fixture.verifierPrivateKey,
      };
}
