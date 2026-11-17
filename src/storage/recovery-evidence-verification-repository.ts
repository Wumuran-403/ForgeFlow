import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceAuthenticityStatusSchema,
  RecoveryEvidenceAvailabilityResultStatusSchema,
  RecoveryEvidenceIntegrityStatusSchema,
  RecoveryEvidenceReadbackProvenanceSchema,
  RecoveryEvidenceVerificationResultStatusSchema,
  type RecoveryEvidenceVerificationRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryEvidenceVerificationInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    readbackRequestId: z.string().min(1).nullable(),
    evidenceReadId: z.string().min(1).nullable(),
    readAttemptId: z.string().min(1).nullable(),
    verificationCheckId: z.string().trim().min(1),
    readbackResultProvenance:
      RecoveryEvidenceReadbackProvenanceSchema,
    verifierId: z.string().trim().min(1),
    verifierVersion: z.string().trim().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().trim().min(1).nullable(),
    allowlistVersion: z.string().trim().min(1).nullable(),
    requestKey: Sha256DigestSchema,
    availabilityStatus: RecoveryEvidenceAvailabilityResultStatusSchema,
    integrityStatus: RecoveryEvidenceIntegrityStatusSchema,
    authenticityStatus: RecoveryEvidenceAuthenticityStatusSchema,
    verificationStatus:
      RecoveryEvidenceVerificationResultStatusSchema,
    expectedPayloadDigest: Sha256DigestSchema,
    observedPayloadDigest: Sha256DigestSchema.nullable(),
    reasonCode: z.string().trim().min(1),
    redactedSummary: z.string().trim().min(1).max(500).nullable(),
    availabilityEventId: z.string().min(1),
    verificationEventId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.verificationStatus === "not_run") !==
      (value.verificationEventId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["verificationEventId"],
        message:
          "Verification event presence must match verification status.",
      });
    }
  });

export type CreateRecoveryEvidenceVerificationInput = z.input<
  typeof CreateRecoveryEvidenceVerificationInputSchema
>;

interface RecoveryEvidenceVerificationRow {
  id: string;
  task_id: string;
  review_id: string;
  evidence_submission_id: string;
  original_tool_run_id: string;
  readback_request_id: string | null;
  evidence_read_id: string | null;
  read_attempt_id: string | null;
  verification_check_id: string;
  readback_result_provenance: string;
  verifier_id: string;
  verifier_version: string;
  verifier_config_digest: string;
  allowlist_id: string | null;
  allowlist_version: string | null;
  request_key: string;
  availability_status: string;
  integrity_status: string;
  authenticity_status: string;
  verification_status: string;
  expected_payload_digest: string;
  observed_payload_digest: string | null;
  reason_code: string;
  redacted_summary: string | null;
  availability_event_id: string;
  verification_event_id: string | null;
  created_at: string;
}

function mapRecoveryEvidenceVerificationRow(
  row: RecoveryEvidenceVerificationRow,
): RecoveryEvidenceVerificationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    evidenceSubmissionId: row.evidence_submission_id,
    originalToolRunId: row.original_tool_run_id,
    readbackRequestId: row.readback_request_id,
    evidenceReadId: row.evidence_read_id,
    readAttemptId: row.read_attempt_id,
    verificationCheckId: row.verification_check_id,
    readbackResultProvenance:
      RecoveryEvidenceReadbackProvenanceSchema.parse(
        row.readback_result_provenance,
      ),
    verifierId: row.verifier_id,
    verifierVersion: row.verifier_version,
    verifierConfigDigest: row.verifier_config_digest,
    allowlistId: row.allowlist_id,
    allowlistVersion: row.allowlist_version,
    requestKey: row.request_key,
    availabilityStatus:
      RecoveryEvidenceAvailabilityResultStatusSchema.parse(
        row.availability_status,
      ),
    integrityStatus: RecoveryEvidenceIntegrityStatusSchema.parse(
      row.integrity_status,
    ),
    authenticityStatus: RecoveryEvidenceAuthenticityStatusSchema.parse(
      row.authenticity_status,
    ),
    verificationStatus:
      RecoveryEvidenceVerificationResultStatusSchema.parse(
        row.verification_status,
      ),
    expectedPayloadDigest: row.expected_payload_digest,
    observedPayloadDigest: row.observed_payload_digest,
    reasonCode: row.reason_code,
    redactedSummary: row.redacted_summary,
    availabilityEventId: row.availability_event_id,
    verificationEventId: row.verification_event_id,
    createdAt: row.created_at,
  };
}

export class RecoveryEvidenceVerificationRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreateRecoveryEvidenceVerificationInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceVerificationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreateRecoveryEvidenceVerificationInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_verifications (
            id, task_id, review_id, evidence_submission_id,
            original_tool_run_id, readback_request_id, evidence_read_id,
            read_attempt_id, verification_check_id,
            readback_result_provenance, verifier_id, verifier_version,
            verifier_config_digest, allowlist_id, allowlist_version,
            request_key, availability_status, integrity_status,
            authenticity_status, verification_status,
            expected_payload_digest, observed_payload_digest,
            reason_code, redacted_summary, availability_event_id,
            verification_event_id, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?, ?
          )
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.evidenceSubmissionId,
        parsed.originalToolRunId,
        parsed.readbackRequestId,
        parsed.evidenceReadId,
        parsed.readAttemptId,
        parsed.verificationCheckId,
        parsed.readbackResultProvenance,
        parsed.verifierId,
        parsed.verifierVersion,
        parsed.verifierConfigDigest,
        parsed.allowlistId,
        parsed.allowlistVersion,
        parsed.requestKey,
        parsed.availabilityStatus,
        parsed.integrityStatus,
        parsed.authenticityStatus,
        parsed.verificationStatus,
        parsed.expectedPayloadDigest,
        parsed.observedPayloadDigest,
        parsed.reasonCode,
        parsed.redactedSummary,
        parsed.availabilityEventId,
        parsed.verificationEventId,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryEvidenceVerificationRecord {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_verifications WHERE id = ?",
      )
      .get(id) as RecoveryEvidenceVerificationRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_VERIFICATION_NOT_FOUND",
        message: "Recovery evidence verification was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceVerificationRow(row);
  }

  getByCheckId(
    taskId: string,
    verificationCheckId: string,
  ): RecoveryEvidenceVerificationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM recovery_evidence_verifications
          WHERE task_id = ? AND verification_check_id = ?
        `,
      )
      .get(taskId, verificationCheckId) as
      | RecoveryEvidenceVerificationRow
      | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceVerificationRow(row);
  }

  getByRequestKey(
    requestKey: string,
  ): RecoveryEvidenceVerificationRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_verifications WHERE request_key = ?",
      )
      .get(requestKey) as
      | RecoveryEvidenceVerificationRow
      | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceVerificationRow(row);
  }

  listByTask(
    taskId: string,
  ): readonly RecoveryEvidenceVerificationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_verifications
            WHERE task_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(taskId) as RecoveryEvidenceVerificationRow[]
    ).map(mapRecoveryEvidenceVerificationRow);
  }
}
