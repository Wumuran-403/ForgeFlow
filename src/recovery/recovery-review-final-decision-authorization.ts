import { z } from "zod";

import { assertAuthenticatedHostRequestContext } from "../host/recovery-review-host-gateway.js";
import type { AuthenticatedHostRequestContext } from "../host/authenticated-host-request-context.js";
import { AppError } from "../shared/errors.js";

const Digest = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const Identity = z.object({
  taskId: z.string().min(1), reviewId: z.string().min(1),
  originalUnknownWriteToolRunId: z.string().min(1),
  operation: z.enum(["confirm_succeeded", "confirm_not_executed"]),
  expectedDecisionVersion: z.number().int().nonnegative(),
  operationPayloadDigest: Digest, sourceContractDigest: Digest.nullable(),
  requestKey: Digest,
}).strict();

export type FinalDecisionIdentity = z.infer<typeof Identity>;
export type FinalDecisionAccess = "final_decision" | "read_replay";
export interface FinalDecisionAuthorization { readonly __finalDecisionAuthorization: unique symbol }
export interface FinalDecisionClaims extends FinalDecisionIdentity {
  readonly access: FinalDecisionAccess;
  readonly actorId: string;
  readonly actorType: "human_reviewer" | "host_verifier";
  readonly requestNonce: string;
  readonly expiresAt: string;
}

const issued = new WeakMap<object, Readonly<FinalDecisionClaims>>();

function issue(context: AuthenticatedHostRequestContext, identity: FinalDecisionIdentity,
  access: FinalDecisionAccess, actorType: FinalDecisionClaims["actorType"]): FinalDecisionAuthorization {
  const host = assertAuthenticatedHostRequestContext(context, {
    access, actorType, issuerScope: actorType === "human_reviewer" ? "manual_reviewer" : "host_verifier",
  });
  if (Date.parse(host.expiresAt) <= Date.now()) throw denied();
  const claims = Object.freeze({ ...Identity.parse(identity), access, actorId: host.actorId,
    actorType, requestNonce: host.requestNonce, expiresAt: host.expiresAt });
  const capability = Object.freeze({}) as FinalDecisionAuthorization;
  issued.set(capability, claims);
  return capability;
}

export function issueManualFinalDecisionAuthorization(
  context: AuthenticatedHostRequestContext, identity: FinalDecisionIdentity,
  access: FinalDecisionAccess,
): FinalDecisionAuthorization {
  return issue(context, identity, access, "human_reviewer");
}

export function issueVerifierFinalDecisionAuthorization(
  context: AuthenticatedHostRequestContext, identity: FinalDecisionIdentity,
  access: FinalDecisionAccess,
): FinalDecisionAuthorization {
  return issue(context, identity, access, "host_verifier");
}

export function assertFinalDecisionAuthorization(
  authorization: unknown, expected: FinalDecisionIdentity & { readonly access: FinalDecisionAccess },
): Readonly<FinalDecisionClaims> {
  const claims = readFinalDecisionAuthorizationClaims(authorization, expected.access);
  if (claims === undefined || Object.entries(expected).some(([key, value]) =>
    claims[key as keyof FinalDecisionClaims] !== value)) throw denied();
  return claims;
}

export function readFinalDecisionAuthorizationClaims(
  authorization: unknown, access: FinalDecisionAccess,
): Readonly<FinalDecisionClaims> {
  if (authorization === null || typeof authorization !== "object") throw denied();
  const claims = issued.get(authorization);
  if (claims === undefined || claims.access !== access || Date.parse(claims.expiresAt) <= Date.now()) throw denied();
  return claims;
}

function denied(): AppError {
  return new AppError({ code: "RECOVERY_REVIEW_FINAL_AUTHORIZATION_DENIED",
    message: "Final recovery review authorization is invalid.", statusCode: 403, details: [] });
}
