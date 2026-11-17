import { z } from "zod";

import {
  HostActorTypeSchema,
  HostIssuerRoleSchema,
  HostRecoveryReviewScopeSchema,
  actorTypeForHostRole,
  type HostIssuerRole,
} from "./host-assertion.js";

const NonEmptyStringSchema = z.string().trim().min(1);

export const HostTrustedKeyMappingV1Schema = z
  .object({
    keyId: NonEmptyStringSchema,
    issuer: NonEmptyStringSchema,
    publicKeyPem: z.string().trim().min(1),
    actorId: NonEmptyStringSchema,
    actorType: HostActorTypeSchema,
    role: HostIssuerRoleSchema,
    allowedScopes: z.array(HostRecoveryReviewScopeSchema).min(1),
    status: z.enum(["active", "revoked"]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.actorType !== actorTypeForHostRole(value.role)) {
      context.addIssue({
        code: "custom",
        path: ["actorType"],
        message: "Trusted mapping actor type does not match its role.",
      });
    }
    if (new Set(value.allowedScopes).size !== value.allowedScopes.length) {
      context.addIssue({
        code: "custom",
        path: ["allowedScopes"],
        message: "Allowed scopes must be unique.",
      });
    }
  });

export const HostAuthenticationConfigV1Schema = z
  .object({
    schemaVersion: z.literal("forgeflow.host-authentication-config.v1"),
    audience: NonEmptyStringSchema,
    maximumAssertionTtlSeconds: z.number().int().positive().max(86_400),
    clockSkewSeconds: z.number().int().nonnegative().max(300),
    trustedKeys: z.array(HostTrustedKeyMappingV1Schema).min(1),
    revokedAssertionIds: z.array(NonEmptyStringSchema),
  })
  .strict()
  .superRefine((value, context) => {
    const keyIds = value.trustedKeys.map((key) => key.keyId);
    if (new Set(keyIds).size !== keyIds.length) {
      context.addIssue({
        code: "custom",
        path: ["trustedKeys"],
        message: "Trusted key IDs must be unique.",
      });
    }
    const publicKeys = value.trustedKeys.map((key) =>
      key.publicKeyPem.replace(/\s+/g, ""),
    );
    if (new Set(publicKeys).size !== publicKeys.length) {
      context.addIssue({
        code: "custom",
        path: ["trustedKeys"],
        message: "A public key cannot map to multiple identities.",
      });
    }
    if (
      new Set(value.revokedAssertionIds).size !==
      value.revokedAssertionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["revokedAssertionIds"],
        message: "Revoked assertion IDs must be unique.",
      });
    }
    const actorRoles = new Map<string, HostIssuerRole>();
    for (const key of value.trustedKeys) {
      const existingRole = actorRoles.get(key.actorId);
      if (existingRole !== undefined && existingRole !== key.role) {
        context.addIssue({
          code: "custom",
          path: ["trustedKeys"],
          message:
            "An actor identity cannot span Human Reviewer and Host Verifier roles.",
        });
        break;
      }
      actorRoles.set(key.actorId, key.role);
    }
  });

export type HostTrustedKeyMappingV1 = z.infer<
  typeof HostTrustedKeyMappingV1Schema
>;
export type HostAuthenticationConfigV1 = z.infer<
  typeof HostAuthenticationConfigV1Schema
>;
