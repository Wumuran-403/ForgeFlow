import {
  createPublicKey,
  verify as verifySignature,
  type KeyObject,
} from "node:crypto";

import { AppError } from "../shared/errors.js";
import { sha256CanonicalJson } from "../shared/canonical-json.js";
import {
  AuthenticatedPrincipalSchema,
  type AuthenticatedPrincipal,
} from "../host/authenticated-principal.js";
import {
  HostAuthenticationConfigV1Schema,
  type HostAuthenticationConfigV1,
  type HostTrustedKeyMappingV1,
} from "./host-authentication-config.js";
import {
  HostAssertionV1Schema,
  actorTypeForHostRole,
  canonicalHostAssertionSigningInput,
  computeHostAssertionDigest,
  issuerScopeForHostRole,
  type HostAssertionV1Claims,
} from "./host-assertion.js";

interface TrustedKeyRuntime {
  readonly mapping: HostTrustedKeyMappingV1;
  readonly publicKey: KeyObject;
}

export class Ed25519HostAuthenticationAdapter {
  private readonly config: HostAuthenticationConfigV1;
  private readonly trustedKeys: ReadonlyMap<string, TrustedKeyRuntime>;
  private readonly revokedAssertionIds: ReadonlySet<string>;

  constructor(
    config: unknown,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = HostAuthenticationConfigV1Schema.parse(config);
    const trustedKeys = new Map<string, TrustedKeyRuntime>();
    const keyFingerprints = new Set<string>();

    for (const mapping of this.config.trustedKeys) {
      let publicKey: KeyObject;
      try {
        publicKey = createPublicKey(mapping.publicKeyPem);
      } catch {
        throw authenticationError();
      }
      if (publicKey.asymmetricKeyType !== "ed25519") {
        throw authenticationError();
      }
      const fingerprint = publicKey
        .export({ type: "spki", format: "der" })
        .toString("base64");
      if (keyFingerprints.has(fingerprint)) {
        throw authenticationError();
      }
      keyFingerprints.add(fingerprint);
      trustedKeys.set(
        mapping.keyId,
        Object.freeze({ mapping, publicKey }),
      );
    }

    this.trustedKeys = trustedKeys;
    this.revokedAssertionIds = new Set(
      this.config.revokedAssertionIds,
    );
  }

  authenticate(input: unknown): AuthenticatedPrincipal {
    const assertion = HostAssertionV1Schema.parse(input);
    const trusted = this.trustedKeys.get(assertion.keyId);
    if (
      trusted === undefined ||
      trusted.mapping.status !== "active" ||
      this.revokedAssertionIds.has(assertion.claims.assertionId)
    ) {
      throw authenticationError();
    }

    let signatureValid = false;
    try {
      signatureValid = verifySignature(
        null,
        Buffer.from(canonicalHostAssertionSigningInput(assertion), "utf8"),
        trusted.publicKey,
        Buffer.from(assertion.signature, "base64url"),
      );
    } catch {
      throw authenticationError();
    }
    if (!signatureValid) {
      throw authenticationError();
    }

    const claims = assertion.claims;
    if (
      claims.issuer !== trusted.mapping.issuer ||
      claims.audience !== this.config.audience ||
      claims.actorId !== trusted.mapping.actorId ||
      claims.actorType !== trusted.mapping.actorType ||
      claims.role !== trusted.mapping.role ||
      claims.scopes.some(
        (scope) => !trusted.mapping.allowedScopes.includes(scope),
      )
    ) {
      throw authenticationError();
    }

    this.assertTimeWindow(claims);

    const assertionDigest = computeHostAssertionDigest(assertion);
    const authenticationEvidenceId = sha256CanonicalJson({
      issuer: claims.issuer,
      keyId: assertion.keyId,
      assertionId: claims.assertionId,
      actorId: claims.actorId,
      actorType: claims.actorType,
      role: claims.role,
      audience: claims.audience,
      scopes: [...claims.scopes],
      issuedAt: claims.issuedAt,
      expiresAt: claims.expiresAt,
      assertionDigest,
    });

    const principal = AuthenticatedPrincipalSchema.parse({
      actorId: claims.actorId,
      actorType: actorTypeForHostRole(claims.role),
      role: claims.role,
      issuerScope: issuerScopeForHostRole(claims.role),
      scopes: [...claims.scopes],
      issuer: claims.issuer,
      keyId: assertion.keyId,
      assertionId: claims.assertionId,
      authenticationEvidenceId,
      authenticatedAt: this.now().toISOString(),
      expiresAt: claims.expiresAt,
    });
    return Object.freeze({
      ...principal,
      scopes: Object.freeze([...principal.scopes]),
    });
  }

  private assertTimeWindow(
    claims: HostAssertionV1Claims,
  ): void {
    const now = this.now().getTime();
    const skewMs = this.config.clockSkewSeconds * 1_000;
    const issuedAt = Date.parse(claims.issuedAt);
    const notBefore = Date.parse(claims.notBefore);
    const expiresAt = Date.parse(claims.expiresAt);
    const ttlMs = expiresAt - issuedAt;

    if (
      issuedAt > now + skewMs ||
      notBefore > now + skewMs ||
      expiresAt <= now - skewMs ||
      ttlMs <= 0 ||
      ttlMs > this.config.maximumAssertionTtlSeconds * 1_000
    ) {
      throw authenticationError();
    }
  }
}

function authenticationError(): AppError {
  return new AppError({
    code: "HOST_AUTHENTICATION_INVALID",
    message: "Host authentication assertion is invalid.",
    statusCode: 401,
    details: [],
  });
}
