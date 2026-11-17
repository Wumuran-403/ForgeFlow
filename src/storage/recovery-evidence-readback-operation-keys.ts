import { sha256CanonicalJson } from "../shared/canonical-json.js";

export interface RecoveryEvidenceReadbackOperationPayload {
  readonly evidenceSubmissionId: string;
  readonly originalUnknownToolRunId: string;
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly verifierConfigDigest: string;
  readonly allowlistId: string;
  readonly allowlistVersion: string;
  readonly readToolName: string;
  readonly readToolVersion: string;
  readonly readToolSchemaHash: string;
  readonly expectedResourceVersion: string | null;
  readonly expectedEtag: string | null;
  readonly verificationCheckId: string;
  readonly expectedDecisionVersion: number;
}

export function computeRecoveryEvidenceReadbackOperationPayloadDigest(
  payload: RecoveryEvidenceReadbackOperationPayload,
): string {
  return sha256CanonicalJson([
    "forgeflow.recovery-evidence-readback.v1",
    {
      evidenceSubmissionId: payload.evidenceSubmissionId,
      originalUnknownToolRunId: payload.originalUnknownToolRunId,
      verifierId: payload.verifierId,
      verifierVersion: payload.verifierVersion,
      verifierConfigDigest: payload.verifierConfigDigest,
      allowlistId: payload.allowlistId,
      allowlistVersion: payload.allowlistVersion,
      readToolName: payload.readToolName,
      readToolVersion: payload.readToolVersion,
      readToolSchemaHash: payload.readToolSchemaHash,
      expectedResourceVersion: payload.expectedResourceVersion,
      expectedEtag: payload.expectedEtag,
      verificationCheckId: payload.verificationCheckId,
      expectedDecisionVersion: payload.expectedDecisionVersion,
    },
  ]);
}
