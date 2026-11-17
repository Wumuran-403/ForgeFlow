import { z } from "zod";

import {
  HostActorTypeSchema,
  HostIssuerRoleSchema,
  HostRecoveryReviewAccessSchema,
} from "../host-auth/host-assertion.js";

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
  )
  .refine((value) => !Number.isNaN(Date.parse(value)));

export const AuthenticatedHostRequestContextClaimsSchema = z
  .object({
    contextId: NonEmptyStringSchema,
    actorId: NonEmptyStringSchema,
    actorType: HostActorTypeSchema,
    issuerScope: HostIssuerRoleSchema,
    allowedAccess: HostRecoveryReviewAccessSchema,
    authenticationEvidenceId: Sha256DigestSchema,
    assertionId: NonEmptyStringSchema,
    requestNonce: NonEmptyStringSchema,
    issuedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();

export type AuthenticatedHostRequestContextClaims = z.infer<
  typeof AuthenticatedHostRequestContextClaimsSchema
>;

declare const authenticatedHostRequestContextBrand: unique symbol;

export interface AuthenticatedHostRequestContext {
  readonly [authenticatedHostRequestContextBrand]: true;
}
