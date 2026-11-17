import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
} from "../shared/canonical-json.js";

export const RecoveryEvidenceReadbackRequestIntentInputSchema = z
  .object({
    taskId: z.string().trim().min(1),
    reviewId: z.string().trim().min(1),
    evidenceSubmissionId: z.string().trim().min(1),
    originalToolRunId: z.string().trim().min(1),
    allowlistId: z.string().trim().min(1),
    verificationCheckId: z.string().trim().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    expectedResourceVersion: z.string().trim().min(1).nullable(),
    expectedEtag: z.string().trim().min(1).nullable(),
  })
  .strict();

export type RecoveryEvidenceReadbackRequestIntentInput = z.input<
  typeof RecoveryEvidenceReadbackRequestIntentInputSchema
>;

export function canonicalRecoveryEvidenceReadbackRequestIntent(
  input: RecoveryEvidenceReadbackRequestIntentInput,
): string {
  const parsed =
    RecoveryEvidenceReadbackRequestIntentInputSchema.parse(input);
  return canonicalJson([
    "forgeflow.recovery-evidence-readback-request-intent.v1",
    {
      taskId: parsed.taskId,
      reviewId: parsed.reviewId,
      evidenceSubmissionId: parsed.evidenceSubmissionId,
      originalToolRunId: parsed.originalToolRunId,
      allowlistId: parsed.allowlistId,
      verificationCheckId: parsed.verificationCheckId,
      expectedDecisionVersion: parsed.expectedDecisionVersion,
      expectedResourceVersion: parsed.expectedResourceVersion,
      expectedEtag: parsed.expectedEtag,
    },
  ]);
}

export function computeRecoveryEvidenceReadbackRequestIntentDigest(
  input: RecoveryEvidenceReadbackRequestIntentInput,
): string {
  const parsed =
    RecoveryEvidenceReadbackRequestIntentInputSchema.parse(input);
  return sha256CanonicalJson([
    "forgeflow.recovery-evidence-readback-request-intent.v1",
    {
      taskId: parsed.taskId,
      reviewId: parsed.reviewId,
      evidenceSubmissionId: parsed.evidenceSubmissionId,
      originalToolRunId: parsed.originalToolRunId,
      allowlistId: parsed.allowlistId,
      verificationCheckId: parsed.verificationCheckId,
      expectedDecisionVersion: parsed.expectedDecisionVersion,
      expectedResourceVersion: parsed.expectedResourceVersion,
      expectedEtag: parsed.expectedEtag,
    },
  ]);
}
