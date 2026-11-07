import { createHash } from "node:crypto";

import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
  type CanonicalJsonValue,
} from "../shared/canonical-json.js";

const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);

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

const EvidenceBaseSchema = z
  .object({
    schemaVersion: z.literal("forgeflow.recovery-evidence.v1"),
    evidenceRef: z.string().trim().min(1),
    outcome: z.enum([
      "observed_succeeded",
      "observed_not_executed",
      "inconclusive",
    ]),
    sourceObservedAt: IsoUtcTimestampSchema,
    submittedAt: IsoUtcTimestampSchema,
    verifiedAt: IsoUtcTimestampSchema.nullable(),
    resourceRef: z.string().trim().min(1).nullable(),
    resourceVersion: z.string().trim().min(1).nullable(),
    taskId: z.string().trim().min(1),
    toolRunId: z.string().trim().min(1),
    toolName: z.string().trim().min(1),
    toolVersion: z.string().trim().min(1),
    inputSchemaHash: Sha256DigestSchema,
    canonicalInputHash: Sha256DigestSchema,
    idempotencyKey: Sha256DigestSchema,
    payloadType: z.enum([
      "raw_bytes",
      "json",
      "external_reference",
      "readback_result",
    ]),
    payloadDigestProtocol: z.enum([
      "sha256-raw-v1",
      "jcs-sha256-v1",
      "adapter-content-sha256-v1",
    ]),
    payloadDigest: Sha256DigestSchema,
    redactedSummary: z.string().nullable(),
  })
  .strict();

const ManualReviewEvidenceSchema = EvidenceBaseSchema.extend({
  sourceType: z.literal("manual_review"),
  actorId: z.string().min(1),
  verifierId: z.null(),
  verificationId: z.null(),
}).strict();

const SystemVerificationEvidenceSchema = EvidenceBaseSchema.extend({
  sourceType: z.literal("system_verification"),
  actorId: z.null(),
  verifierId: z.string().min(1),
  verificationId: z.string().min(1),
}).strict();

export const RecoveryEvidenceEnvelopeSchema = z
  .discriminatedUnion("sourceType", [
    ManualReviewEvidenceSchema,
    SystemVerificationEvidenceSchema,
  ])
  .superRefine((value, context) => {
    if (
      value.payloadType === "external_reference" &&
      (value.resourceRef === null || value.resourceVersion === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resourceRef"],
        message:
          "External references require resourceRef and resourceVersion.",
      });
    }
    const expectedDigestProtocol =
      value.payloadType === "raw_bytes"
        ? "sha256-raw-v1"
        : value.payloadType === "external_reference"
          ? "adapter-content-sha256-v1"
          : "jcs-sha256-v1";
    if (value.payloadDigestProtocol !== expectedDigestProtocol) {
      context.addIssue({
        code: "custom",
        path: ["payloadDigestProtocol"],
        message: "Payload type and digest protocol do not match.",
      });
    }
  });

export type RecoveryEvidenceEnvelope = z.infer<
  typeof RecoveryEvidenceEnvelopeSchema
>;

export const RecoveryReadbackResultSchema = z
  .object({
    resourceRef: z.string().trim().min(1),
    resourceVersion: z.string().trim().min(1),
    observedAt: IsoUtcTimestampSchema,
    outcome: z.enum([
      "observed_succeeded",
      "observed_not_executed",
      "inconclusive",
    ]),
    result: z.unknown(),
  })
  .strict();

export type RecoveryReadbackResult = z.infer<
  typeof RecoveryReadbackResultSchema
>;

export function computeRecoveryEvidenceEnvelopeDigest(
  input: RecoveryEvidenceEnvelope,
): string {
  const parsed = RecoveryEvidenceEnvelopeSchema.parse(input);
  return sha256CanonicalJson(recoveryEvidenceDigestInput(parsed));
}

export function computeRawPayloadDigest(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function computeJsonPayloadDigest(value: CanonicalJsonValue): string {
  return sha256CanonicalJson(value);
}

export function computeReadbackResultPayloadDigest(
  result: RecoveryReadbackResult,
): string {
  return sha256CanonicalJson(RecoveryReadbackResultSchema.parse(result));
}

export function computeExternalReferencePayloadDigest(
  actualContent: Uint8Array | CanonicalJsonValue,
): {
  readonly payloadDigest: string;
  readonly payloadDigestProtocol: "adapter-content-sha256-v1";
} {
  const payloadDigest =
    actualContent instanceof Uint8Array
      ? computeRawPayloadDigest(actualContent)
      : sha256CanonicalJson(actualContent);
  return {
    payloadDigest,
    payloadDigestProtocol: "adapter-content-sha256-v1",
  };
}

function recoveryEvidenceDigestInput(
  value: RecoveryEvidenceEnvelope,
): CanonicalJsonValue {
  return {
    schemaVersion: value.schemaVersion,
    evidenceRef: value.evidenceRef,
    sourceType: value.sourceType,
    outcome: value.outcome,
    sourceObservedAt: value.sourceObservedAt,
    resourceRef: value.resourceRef,
    resourceVersion: value.resourceVersion,
    taskId: value.taskId,
    toolRunId: value.toolRunId,
    toolName: value.toolName,
    toolVersion: value.toolVersion,
    inputSchemaHash: value.inputSchemaHash,
    canonicalInputHash: value.canonicalInputHash,
    idempotencyKey: value.idempotencyKey,
    actorId: value.actorId,
    verifierId: value.verifierId,
    verificationId: value.verificationId,
    payloadType: value.payloadType,
    payloadDigestProtocol: value.payloadDigestProtocol,
    payloadDigest: value.payloadDigest,
  };
}

export function canonicalRecoveryEvidenceEnvelope(
  input: RecoveryEvidenceEnvelope,
): string {
  return canonicalJson(recoveryEvidenceDigestInput(input));
}
