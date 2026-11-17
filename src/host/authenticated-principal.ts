import { z } from "zod";

import {
  HostActorTypeSchema,
  HostIssuerRoleSchema,
  HostRecoveryReviewScopeSchema,
} from "../host-auth/host-assertion.js";

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
  )
  .refine((value) => !Number.isNaN(Date.parse(value)));

export const AuthenticatedPrincipalSchema = z
  .object({
    actorId: NonEmptyStringSchema,
    actorType: HostActorTypeSchema,
    role: HostIssuerRoleSchema,
    issuerScope: HostIssuerRoleSchema,
    scopes: z.array(HostRecoveryReviewScopeSchema).min(1).readonly(),
    issuer: NonEmptyStringSchema,
    keyId: NonEmptyStringSchema,
    assertionId: NonEmptyStringSchema,
    authenticationEvidenceId: Sha256DigestSchema,
    authenticatedAt: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
  })
  .strict();

export type AuthenticatedPrincipal = z.infer<
  typeof AuthenticatedPrincipalSchema
>;
