import {
  createPublicKey,
  randomUUID,
  sign,
  type KeyObject,
} from "node:crypto";

import { AppError } from "../shared/errors.js";
import {
  HostAssertionV1Schema,
  canonicalHostAssertionSigningInput,
  type HostRecoveryReviewScope,
} from "./host-assertion.js";
import {
  HostAuthenticationConfigV1Schema,
  type HostAuthenticationConfigV1,
} from "./host-authentication-config.js";
import { encodeHostAssertionBearerToken } from "./host-assertion-bearer.js";

export interface IssueHostAssertionInput {
  readonly config: unknown;
  readonly keyId: string;
  readonly privateKey: KeyObject;
  readonly scopeSubset?: readonly HostRecoveryReviewScope[];
  readonly assertionId?: string;
  readonly ttlSeconds?: number;
  readonly now?: Date;
}

export function issueHostAssertion(input: IssueHostAssertionInput): string {
  const config = HostAuthenticationConfigV1Schema.parse(input.config);
  const mapping = config.trustedKeys.find(
    (key) => key.keyId === input.keyId,
  );
  if (mapping === undefined || mapping.status !== "active") {
    throw signingError();
  }
  if (
    createPublicKey(input.privateKey)
      .export({ type: "spki", format: "der" })
      .compare(
        createPublicKey(mapping.publicKeyPem).export({
          type: "spki",
          format: "der",
        }),
      ) !== 0
  ) {
    throw signingError();
  }

  const scopes = input.scopeSubset ?? mapping.allowedScopes;
  if (
    scopes.length === 0 ||
    scopes.some((scope) => !mapping.allowedScopes.includes(scope))
  ) {
    throw signingError();
  }
  const now = input.now ?? new Date();
  const ttlSeconds = input.ttlSeconds ?? config.maximumAssertionTtlSeconds;
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds <= 0 ||
    ttlSeconds > config.maximumAssertionTtlSeconds
  ) {
    throw signingError();
  }

  const claims = {
    issuer: mapping.issuer,
    audience: config.audience,
    actorId: mapping.actorId,
    actorType: mapping.actorType,
    role: mapping.role,
    scopes: [...scopes],
    issuedAt: now.toISOString(),
    notBefore: now.toISOString(),
    expiresAt: new Date(now.getTime() + ttlSeconds * 1_000).toISOString(),
    assertionId: input.assertionId ?? randomUUID(),
  };
  const unsigned = {
    schemaVersion: "forgeflow.host-assertion.v1" as const,
    keyId: mapping.keyId,
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
    input.privateKey,
  ).toString("base64url");

  return encodeHostAssertionBearerToken({
    ...unsigned,
    signature,
  });
}

export function assertMappingMatchesPrivateKey(
  config: HostAuthenticationConfigV1,
  keyId: string,
  privateKey: KeyObject,
): void {
  const mapping = config.trustedKeys.find((key) => key.keyId === keyId);
  if (
    mapping === undefined ||
    createPublicKey(privateKey)
      .export({ type: "spki", format: "der" })
      .compare(
        createPublicKey(mapping.publicKeyPem).export({
          type: "spki",
          format: "der",
        }),
      ) !== 0
  ) {
    throw signingError();
  }
}

function signingError(): AppError {
  return new AppError({
    code: "HOST_ASSERTION_SIGNING_DENIED",
    message: "Host assertion signing request was denied.",
    statusCode: 409,
    details: [],
  });
}
