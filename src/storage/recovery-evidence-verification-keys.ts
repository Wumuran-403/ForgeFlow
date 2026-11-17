import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
} from "../shared/canonical-json.js";
import { RecoveryEvidenceVerificationCheckOriginSchema } from "./types.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

export const RecoveryEvidenceVerificationRequestKeyInputSchema =
  z
    .object({
      taskId: z.string().trim().min(1),
      reviewId: z.string().trim().min(1),
      evidenceSubmissionId: z.string().trim().min(1),
      originalToolRunId: z.string().trim().min(1),
      verificationCheckId: z.string().trim().min(1),
      checkOrigin: RecoveryEvidenceVerificationCheckOriginSchema,
      verifierId: z.string().trim().min(1),
      verifierVersion: z.string().trim().min(1),
      verifierConfigDigest: Sha256DigestSchema,
      allowlistId: z.string().trim().min(1).nullable(),
      allowlistVersion: z.string().trim().min(1).nullable(),
      readToolName: z.string().trim().min(1).nullable(),
      readToolVersion: z.string().trim().min(1).nullable(),
      readToolSchemaHash: Sha256DigestSchema.nullable(),
      expectedPayloadDigest: Sha256DigestSchema,
    })
    .strict()
    .superRefine((value, context) => {
      const readbackFields = [
        value.allowlistId,
        value.allowlistVersion,
        value.readToolName,
        value.readToolVersion,
        value.readToolSchemaHash,
      ];
      if (
        value.checkOrigin === "stored_evidence_v0" &&
        readbackFields.some((field) => field !== null)
      ) {
        context.addIssue({
          code: "custom",
          path: ["checkOrigin"],
          message:
            "Stored Evidence V0 must use explicit NULL readback configuration.",
        });
      }
    });

export type RecoveryEvidenceVerificationRequestKeyInput = z.input<
  typeof RecoveryEvidenceVerificationRequestKeyInputSchema
>;

export function canonicalRecoveryEvidenceVerificationRequestKeyInput(
  input: RecoveryEvidenceVerificationRequestKeyInput,
): string {
  const parsed =
    RecoveryEvidenceVerificationRequestKeyInputSchema.parse(input);
  return canonicalJson([
    "forgeflow.recovery-evidence-verification.v1",
    canonicalVerificationBinding(parsed),
  ]);
}

export function computeRecoveryEvidenceVerificationRequestKey(
  input: RecoveryEvidenceVerificationRequestKeyInput,
): string {
  const parsed =
    RecoveryEvidenceVerificationRequestKeyInputSchema.parse(input);
  return sha256CanonicalJson([
    "forgeflow.recovery-evidence-verification.v1",
    canonicalVerificationBinding(parsed),
  ]);
}

function canonicalVerificationBinding(
  input: z.output<
    typeof RecoveryEvidenceVerificationRequestKeyInputSchema
  >,
) {
  return {
    taskId: input.taskId,
    reviewId: input.reviewId,
    evidenceSubmissionId: input.evidenceSubmissionId,
    originalToolRunId: input.originalToolRunId,
    verificationCheckId: input.verificationCheckId,
    checkOrigin: input.checkOrigin,
    verifierId: input.verifierId,
    verifierVersion: input.verifierVersion,
    verifierConfigDigest: input.verifierConfigDigest,
    allowlistId: input.allowlistId,
    allowlistVersion: input.allowlistVersion,
    readToolName: input.readToolName,
    readToolVersion: input.readToolVersion,
    readToolSchemaHash: input.readToolSchemaHash,
    expectedPayloadDigest: input.expectedPayloadDigest,
  };
}
