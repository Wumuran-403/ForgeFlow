import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceVerificationCheckOriginSchema,
  type RecoveryEvidenceVerificationCheckRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryEvidenceVerificationCheckInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    readbackRequestId: z.string().min(1).nullable(),
    evidenceReadId: z.string().min(1).nullable(),
    verificationCheckId: z.string().trim().min(1),
    requestKey: Sha256DigestSchema,
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
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.checkOrigin === "readback_transaction_b") {
      if (
        value.readbackRequestId === null ||
        value.evidenceReadId !== null ||
        value.allowlistId === null ||
        value.allowlistVersion === null ||
        value.readToolName === null ||
        value.readToolVersion === null ||
        value.readToolSchemaHash === null
      ) {
        context.addIssue({
          code: "custom",
          path: ["checkOrigin"],
          message: "Readback Transaction B check binding is incomplete.",
        });
      }
    }
  });

export type CreateRecoveryEvidenceVerificationCheckInput = z.input<
  typeof CreateRecoveryEvidenceVerificationCheckInputSchema
>;

interface RecoveryEvidenceVerificationCheckRow {
  id: string;
  task_id: string;
  review_id: string;
  evidence_submission_id: string;
  original_tool_run_id: string;
  readback_request_id: string | null;
  evidence_read_id: string | null;
  verification_check_id: string;
  request_key: string;
  check_origin: string;
  verifier_id: string;
  verifier_version: string;
  verifier_config_digest: string;
  allowlist_id: string | null;
  allowlist_version: string | null;
  read_tool_name: string | null;
  read_tool_version: string | null;
  read_tool_schema_hash: string | null;
  expected_payload_digest: string;
  created_at: string;
}

function mapRecoveryEvidenceVerificationCheckRow(
  row: RecoveryEvidenceVerificationCheckRow,
): RecoveryEvidenceVerificationCheckRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    evidenceSubmissionId: row.evidence_submission_id,
    originalToolRunId: row.original_tool_run_id,
    readbackRequestId: row.readback_request_id,
    evidenceReadId: row.evidence_read_id,
    verificationCheckId: row.verification_check_id,
    requestKey: row.request_key,
    checkOrigin: RecoveryEvidenceVerificationCheckOriginSchema.parse(
      row.check_origin,
    ),
    verifierId: row.verifier_id,
    verifierVersion: row.verifier_version,
    verifierConfigDigest: row.verifier_config_digest,
    allowlistId: row.allowlist_id,
    allowlistVersion: row.allowlist_version,
    readToolName: row.read_tool_name,
    readToolVersion: row.read_tool_version,
    readToolSchemaHash: row.read_tool_schema_hash,
    expectedPayloadDigest: row.expected_payload_digest,
    createdAt: row.created_at,
  };
}

export class RecoveryEvidenceVerificationCheckRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreateRecoveryEvidenceVerificationCheckInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceVerificationCheckRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreateRecoveryEvidenceVerificationCheckInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_verification_checks (
            id, task_id, review_id, evidence_submission_id,
            original_tool_run_id, readback_request_id, evidence_read_id,
            verification_check_id, request_key, check_origin,
            verifier_id, verifier_version, verifier_config_digest,
            allowlist_id, allowlist_version, read_tool_name,
            read_tool_version, read_tool_schema_hash,
            expected_payload_digest, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
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
        parsed.verificationCheckId,
        parsed.requestKey,
        parsed.checkOrigin,
        parsed.verifierId,
        parsed.verifierVersion,
        parsed.verifierConfigDigest,
        parsed.allowlistId,
        parsed.allowlistVersion,
        parsed.readToolName,
        parsed.readToolVersion,
        parsed.readToolSchemaHash,
        parsed.expectedPayloadDigest,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryEvidenceVerificationCheckRecord {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_verification_checks WHERE id = ?",
      )
      .get(id) as RecoveryEvidenceVerificationCheckRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_VERIFICATION_CHECK_NOT_FOUND",
        message: "Recovery evidence verification check was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceVerificationCheckRow(row);
  }

  getByCheckId(
    taskId: string,
    verificationCheckId: string,
  ): RecoveryEvidenceVerificationCheckRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM recovery_evidence_verification_checks
          WHERE task_id = ? AND verification_check_id = ?
        `,
      )
      .get(taskId, verificationCheckId) as
      | RecoveryEvidenceVerificationCheckRow
      | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceVerificationCheckRow(row);
  }

  getByRequestKey(
    requestKey: string,
  ): RecoveryEvidenceVerificationCheckRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_verification_checks WHERE request_key = ?",
      )
      .get(requestKey) as
      | RecoveryEvidenceVerificationCheckRow
      | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceVerificationCheckRow(row);
  }

  listByTask(
    taskId: string,
  ): readonly RecoveryEvidenceVerificationCheckRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_verification_checks
            WHERE task_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(taskId) as RecoveryEvidenceVerificationCheckRow[]
    ).map(mapRecoveryEvidenceVerificationCheckRow);
  }
}
