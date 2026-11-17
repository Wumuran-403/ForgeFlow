import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  Ed25519HostAuthenticationAdapter,
} from "../host-auth/ed25519-host-authentication-adapter.js";
import {
  HostActorTypeSchema,
  HostIssuerRoleSchema,
  HostRecoveryReviewAccessSchema,
  accessToScope,
  type HostRecoveryReviewAccess,
} from "../host-auth/host-assertion.js";
import {
  AuthenticatedHostRequestContextClaimsSchema,
  type AuthenticatedHostRequestContext,
  type AuthenticatedHostRequestContextClaims,
} from "./authenticated-host-request-context.js";

const AuthenticateHostGatewayRequestSchema = z
  .object({
    assertion: z.unknown(),
    access: HostRecoveryReviewAccessSchema,
  })
  .strict();

const contexts = new WeakMap<
  object,
  Readonly<AuthenticatedHostRequestContextClaims>
>();

export class RecoveryReviewHostGateway {
  constructor(
    private readonly authenticationAdapter: Ed25519HostAuthenticationAdapter,
    private readonly now: () => Date = () => new Date(),
    private readonly createNonce: () => string = randomUUID,
  ) {
    if (
      !(authenticationAdapter instanceof
        Ed25519HostAuthenticationAdapter)
    ) {
      throw gatewayError();
    }
  }

  createContext(input: {
    readonly assertion: unknown;
    readonly access: HostRecoveryReviewAccess;
  }): AuthenticatedHostRequestContext {
    const parsed = AuthenticateHostGatewayRequestSchema.parse(input);
    const principal = this.authenticationAdapter.authenticate(
      parsed.assertion,
    );
    const requiredScope = accessToScope(parsed.access);
    if (!principal.scopes.includes(requiredScope)) {
      throw gatewayError();
    }

    const now = this.now();
    if (Date.parse(principal.expiresAt) <= now.getTime()) {
      throw gatewayError();
    }

    return createAuthenticatedHostRequestContext({
      contextId: randomUUID(),
      actorId: principal.actorId,
      actorType: principal.actorType,
      issuerScope: principal.issuerScope,
      allowedAccess: parsed.access,
      authenticationEvidenceId:
        principal.authenticationEvidenceId,
      assertionId: principal.assertionId,
      requestNonce: this.createNonce(),
      issuedAt: now.toISOString(),
      expiresAt: principal.expiresAt,
    });
  }
}

export function assertAuthenticatedHostRequestContext(
  context: unknown,
  expected?: {
    readonly access?: HostRecoveryReviewAccess;
    readonly actorId?: string;
    readonly actorType?: z.infer<typeof HostActorTypeSchema>;
    readonly issuerScope?: z.infer<typeof HostIssuerRoleSchema>;
  },
): Readonly<AuthenticatedHostRequestContextClaims> {
  if (
    context === null ||
    typeof context !== "object" ||
    !contexts.has(context)
  ) {
    throw contextError();
  }
  const claims = contexts.get(context)!;
  if (
    (expected?.access !== undefined &&
      claims.allowedAccess !== expected.access) ||
    (expected?.actorId !== undefined &&
      claims.actorId !== expected.actorId) ||
    (expected?.actorType !== undefined &&
      claims.actorType !== expected.actorType) ||
    (expected?.issuerScope !== undefined &&
      claims.issuerScope !== expected.issuerScope)
  ) {
    throw contextError();
  }
  return claims;
}

function createAuthenticatedHostRequestContext(
  input: AuthenticatedHostRequestContextClaims,
): AuthenticatedHostRequestContext {
  const claims = AuthenticatedHostRequestContextClaimsSchema.parse(input);
  const context = Object.freeze({}) as AuthenticatedHostRequestContext;
  contexts.set(context, Object.freeze({ ...claims }));
  return context;
}

function gatewayError(): AppError {
  return new AppError({
    code: "RECOVERY_REVIEW_HOST_GATEWAY_DENIED",
    message: "Recovery review host gateway request was denied.",
    statusCode: 403,
    details: [],
  });
}

function contextError(): AppError {
  return new AppError({
    code: "AUTHENTICATED_HOST_REQUEST_CONTEXT_INVALID",
    message: "Authenticated host request context is invalid.",
    statusCode: 409,
    details: [],
  });
}
