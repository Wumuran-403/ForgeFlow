import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
} from "../shared/canonical-json.js";

const NonEmptyStringSchema = z.string().trim().min(1);
const IsoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    "Expected an ISO-8601 UTC timestamp.",
  )
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Expected a valid ISO-8601 UTC timestamp.",
  );

export const HostActorTypeSchema = z.enum([
  "human_reviewer",
  "host_verifier",
]);

export const HostIssuerRoleSchema = z.enum([
  "manual_reviewer",
  "host_verifier",
]);

export const HostRecoveryReviewScopeSchema = z.enum([
  "recovery_review.final_decision",
  "recovery_review.read_replay",
]);

export const HostRecoveryReviewAccessSchema = z.enum([
  "final_decision",
  "read_replay",
]);

export type HostActorType = z.infer<typeof HostActorTypeSchema>;
export type HostIssuerRole = z.infer<typeof HostIssuerRoleSchema>;
export type HostRecoveryReviewScope = z.infer<
  typeof HostRecoveryReviewScopeSchema
>;
export type HostRecoveryReviewAccess = z.infer<
  typeof HostRecoveryReviewAccessSchema
>;

export function issuerScopeForHostRole(
  role: HostIssuerRole,
): "manual_reviewer" | "host_verifier" {
  return role;
}

export function actorTypeForHostRole(
  role: HostIssuerRole,
): HostActorType {
  return role === "manual_reviewer"
    ? "human_reviewer"
    : "host_verifier";
}

export function accessToScope(
  access: HostRecoveryReviewAccess,
): HostRecoveryReviewScope {
  return access === "final_decision"
    ? "recovery_review.final_decision"
    : "recovery_review.read_replay";
}

const HostAssertionClaimsV1Schema = z
  .object({
    issuer: NonEmptyStringSchema,
    audience: NonEmptyStringSchema,
    actorId: NonEmptyStringSchema,
    actorType: HostActorTypeSchema,
    role: HostIssuerRoleSchema,
    scopes: z
      .array(HostRecoveryReviewScopeSchema)
      .min(1)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "Assertion scopes must be unique.",
          });
        }
      }),
    issuedAt: IsoUtcTimestampSchema,
    notBefore: IsoUtcTimestampSchema,
    expiresAt: IsoUtcTimestampSchema,
    assertionId: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorType !== actorTypeForHostRole(value.role)) {
      context.addIssue({
        code: "custom",
        path: ["actorType"],
        message: "Actor type does not match the assertion role.",
      });
    }
    if (Date.parse(value.expiresAt) <= Date.parse(value.notBefore)) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Assertion expiry must be after notBefore.",
      });
    }
    if (Date.parse(value.notBefore) < Date.parse(value.issuedAt)) {
      context.addIssue({
        code: "custom",
        path: ["notBefore"],
        message: "notBefore cannot precede issuedAt.",
      });
    }
  });

export const HostAssertionV1Schema = z
  .object({
    schemaVersion: z.literal("forgeflow.host-assertion.v1"),
    keyId: NonEmptyStringSchema,
    claims: HostAssertionClaimsV1Schema,
    signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
  })
  .strict();

export type HostAssertionV1 = z.infer<typeof HostAssertionV1Schema>;
export type HostAssertionV1Claims = z.infer<
  typeof HostAssertionClaimsV1Schema
>;

export function canonicalHostAssertionSigningInput(
  input: unknown,
): string {
  const assertion = HostAssertionV1Schema.parse(input);
  return canonicalJson({
    schemaVersion: assertion.schemaVersion,
    keyId: assertion.keyId,
    claims: assertion.claims,
  });
}

export function computeHostAssertionDigest(input: unknown): string {
  const assertion = HostAssertionV1Schema.parse(input);
  return sha256CanonicalJson(assertion);
}
