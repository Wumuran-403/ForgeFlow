import { AppError } from "../shared/errors.js";
import type {
  RecoveryEvidenceSubmissionRecord,
  ToolRunRecord,
} from "../storage/types.js";
import {
  RecoveryEvidenceEnvelopeSchema,
  type RecoveryEvidenceEnvelope,
} from "./recovery-evidence.js";

export function buildRecoveryEvidenceEnvelopeFromRecord(
  manifest: RecoveryEvidenceSubmissionRecord,
  toolRun: ToolRunRecord,
): RecoveryEvidenceEnvelope {
  if (
    manifest.payloadType === "external_reference" &&
    (manifest.resourceRef === null ||
      manifest.resourceVersion === null)
  ) {
    throw new AppError({
      code: "RECOVERY_EVIDENCE_SUBMISSION_BINDING_INVALID",
      message: "External evidence reference metadata is incomplete.",
      statusCode: 409,
      details: [],
    });
  }
  if (
    manifest.taskId !== toolRun.taskId ||
    manifest.toolRunId !== toolRun.id
  ) {
    throw new AppError({
      code: "RECOVERY_EVIDENCE_SUBMISSION_BINDING_INVALID",
      message: "Evidence submission does not match its original ToolRun.",
      statusCode: 409,
      details: [],
    });
  }
  return RecoveryEvidenceEnvelopeSchema.parse({
    schemaVersion: "forgeflow.recovery-evidence.v1",
    evidenceRef: manifest.evidenceRef,
    sourceType: manifest.sourceType,
    outcome: manifest.outcome,
    sourceObservedAt: manifest.sourceObservedAt,
    submittedAt: manifest.submittedAt,
    verifiedAt: null,
    resourceRef: manifest.resourceRef,
    resourceVersion: manifest.resourceVersion,
    taskId: manifest.taskId,
    toolRunId: manifest.toolRunId,
    toolName: toolRun.toolName,
    toolVersion: toolRun.toolVersion,
    inputSchemaHash: toolRun.inputSchemaHash,
    canonicalInputHash: toolRun.canonicalInputHash,
    idempotencyKey: toolRun.idempotencyKey,
    actorId: manifest.actorId,
    verifierId: manifest.verifierId,
    verificationId: manifest.verificationId,
    payloadType: manifest.payloadType,
    payloadDigestProtocol: manifest.payloadDigestProtocol,
    payloadDigest: manifest.payloadDigest,
    redactedSummary: null,
  });
}
