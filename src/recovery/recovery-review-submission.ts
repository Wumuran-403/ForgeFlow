import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
} from "../shared/canonical-json.js";
import {
  JsonValueSchema,
  type JsonValue,
} from "../storage/index.js";
import {
  RecoveryReadbackResultSchema,
  RecoveryEvidenceEnvelopeSchema,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeReadbackResultPayloadDigest,
  type RecoveryEvidenceEnvelope,
} from "./recovery-evidence.js";

const Sha256HashSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const TimestampSchema = z.string().min(1);

export const RecoveryEvidenceHostContextSchema = z.discriminatedUnion(
  "sourceType",
  [
    z
      .object({
        sourceType: z.literal("manual_review"),
        actorId: z.string().trim().min(1),
      })
      .strict(),
    z
      .object({
        sourceType: z.literal("system_verification"),
        verifierId: z.string().trim().min(1),
        verificationId: z.string().trim().min(1),
      })
      .strict(),
  ],
);

export const RecoveryEvidenceBindingInputSchema = z
  .object({
    toolRunId: z.string().min(1),
    toolName: z.string().trim().min(1),
    toolVersion: z.string().trim().min(1),
    inputSchemaHash: Sha256HashSchema,
    canonicalInputHash: Sha256HashSchema,
    idempotencyKey: Sha256HashSchema,
  })
  .strict();

export const RecoveryEvidencePayloadInputSchema = z
  .object({
    evidenceRef: z.string().trim().min(1),
    outcome: z.enum([
      "observed_succeeded",
      "observed_not_executed",
      "inconclusive",
    ]),
    sourceObservedAt: TimestampSchema,
    resourceRef: z.string().trim().min(1).nullable().default(null),
    resourceVersion: z.string().trim().min(1).nullable().default(null),
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
    payloadContent: JsonValueSchema,
    payloadDigest: Sha256HashSchema,
    redactedSummary: z.string().nullable().default(null),
  })
  .strict();

export const SubmitRecoveryEvidenceInputSchema = z
  .object({
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    binding: RecoveryEvidenceBindingInputSchema,
    host: RecoveryEvidenceHostContextSchema,
    payload: RecoveryEvidencePayloadInputSchema,
    requestKey: Sha256HashSchema,
  })
  .strict();

export type SubmitRecoveryEvidenceInput = z.input<
  typeof SubmitRecoveryEvidenceInputSchema
>;

export const MarkRecoveryReviewUnresolvedInputSchema = z
  .object({
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    actorId: z.string().trim().min(1),
    reason: z.string().trim().min(1),
    referencedEvidenceEnvelopeDigest: Sha256HashSchema.nullable(),
    requestKey: Sha256HashSchema,
  })
  .strict();

export type MarkRecoveryReviewUnresolvedInput = z.input<
  typeof MarkRecoveryReviewUnresolvedInputSchema
>;

export const RecoveryEvidenceAvailabilityStatusSchema = z.enum([
  "never_checked",
  "available",
  "unavailable",
  "expired",
  "replaced",
  "digest_mismatch",
]);

export const RecoveryEvidenceAvailabilityAuditSchema = z
  .object({
    evidenceSubmissionId: z.string().min(1),
    status: RecoveryEvidenceAvailabilityStatusSchema.exclude([
      "never_checked",
    ]),
    checkedAt: z.string().min(1),
    expectedDigest: Sha256HashSchema,
    observedDigest: Sha256HashSchema.nullable(),
    reason: z.string().nullable(),
  })
  .strict();

export type RecoveryEvidenceAvailabilityAudit = z.infer<
  typeof RecoveryEvidenceAvailabilityAuditSchema
>;

export function buildRecoveryEvidenceEnvelope(
  input: SubmitRecoveryEvidenceInput,
  submittedAt: string,
): RecoveryEvidenceEnvelope {
  const parsed = SubmitRecoveryEvidenceInputSchema.parse(input);
  return RecoveryEvidenceEnvelopeSchema.parse({
    schemaVersion: "forgeflow.recovery-evidence.v1",
    evidenceRef: parsed.payload.evidenceRef,
    sourceType: parsed.host.sourceType,
    outcome: parsed.payload.outcome,
    sourceObservedAt: parsed.payload.sourceObservedAt,
    submittedAt,
    verifiedAt: null,
    resourceRef: parsed.payload.resourceRef,
    resourceVersion: parsed.payload.resourceVersion,
    taskId: parsed.taskId,
    toolRunId: parsed.binding.toolRunId,
    toolName: parsed.binding.toolName,
    toolVersion: parsed.binding.toolVersion,
    inputSchemaHash: parsed.binding.inputSchemaHash,
    canonicalInputHash: parsed.binding.canonicalInputHash,
    idempotencyKey: parsed.binding.idempotencyKey,
    actorId:
      parsed.host.sourceType === "manual_review"
        ? parsed.host.actorId
        : null,
    verifierId:
      parsed.host.sourceType === "system_verification"
        ? parsed.host.verifierId
        : null,
    verificationId:
      parsed.host.sourceType === "system_verification"
        ? parsed.host.verificationId
        : null,
    payloadType: parsed.payload.payloadType,
    payloadDigestProtocol: parsed.payload.payloadDigestProtocol,
    payloadDigest: parsed.payload.payloadDigest,
    redactedSummary: parsed.payload.redactedSummary,
  });
}

export function evidenceOperationActorId(
  envelope: RecoveryEvidenceEnvelope,
): string {
  const identity =
    envelope.sourceType === "manual_review"
      ? envelope.actorId
      : envelope.verifierId;
  if (identity === null) {
    throw new Error("Evidence envelope has no trusted host identity.");
  }
  return identity;
}

export function computeSubmittedEvidencePayloadDigest(
  input: z.output<typeof RecoveryEvidencePayloadInputSchema>,
): string {
  if (input.payloadType === "raw_bytes") {
    if (typeof input.payloadContent !== "string") {
      throw new Error("raw_bytes payload content must be base64 text.");
    }
    const bytes = Buffer.from(input.payloadContent, "base64");
    if (bytes.toString("base64") !== input.payloadContent) {
      throw new Error("raw_bytes payload content is not canonical base64.");
    }
    return computeRawPayloadDigest(bytes);
  }
  if (input.payloadType === "json") {
    return computeJsonPayloadDigest(
      input.payloadContent as never,
    );
  }
  if (input.payloadType === "readback_result") {
    return computeReadbackResultPayloadDigest(
      RecoveryReadbackResultSchema.parse(input.payloadContent),
    );
  }
  return input.payloadDigest;
}

export function submittedEvidencePayloadBytes(
  input: z.output<typeof RecoveryEvidencePayloadInputSchema>,
): Uint8Array | null {
  if (input.payloadType === "raw_bytes") {
    if (typeof input.payloadContent !== "string") {
      throw new Error("raw_bytes payload content must be base64 text.");
    }
    const bytes = Buffer.from(input.payloadContent, "base64");
    if (bytes.toString("base64") !== input.payloadContent) {
      throw new Error("raw_bytes payload content is not canonical base64.");
    }
    return bytes;
  }
  if (input.payloadType === "json") {
    return Buffer.from(canonicalJson(input.payloadContent), "utf8");
  }
  if (input.payloadType === "readback_result") {
    return Buffer.from(
      canonicalJson(
        RecoveryReadbackResultSchema.parse(input.payloadContent),
      ),
      "utf8",
    );
  }
  return null;
}

export function computeUnresolvedOperationPayloadDigest(input: {
  readonly reason: string;
  readonly referencedEvidenceEnvelopeDigest: string | null;
}): string {
  return sha256CanonicalJson({
    reason: input.reason,
    referencedEvidenceEnvelopeDigest:
      input.referencedEvidenceEnvelopeDigest,
  } satisfies JsonValue);
}
