import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  assertRecoveryEvidenceControlledReadCapability,
  type RecoveryEvidenceControlledReadCapability,
} from "./recovery-evidence-read-capability.js";
import {
  RecoveryEvidencePayloadStorageModeSchema,
  type RecoveryEvidenceReadRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryEvidenceReadInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    toolRunId: z.string().min(1),
    evidenceEnvelopeDigest: Sha256DigestSchema,
    evidenceSubmissionId: z.string().min(1).nullable().default(null),
    readbackRequestId: z.string().min(1).nullable().default(null),
    readAttemptId: z.string().min(1).nullable().default(null),
    verificationCheckId: z.string().min(1).nullable().default(null),
    observedAt: z.string().min(1).nullable().default(null),
    resourceVersion: z.string().min(1).nullable().default(null),
    resourceEtag: z.string().min(1).nullable().default(null),
    resultPayloadDigest: Sha256DigestSchema.nullable().default(null),
    resultPayloadStoreRef: z.string().min(1).nullable().default(null),
    resultPayloadStorageMode:
      RecoveryEvidencePayloadStorageModeSchema.nullable().default(null),
    createdAt: z.string().min(1),
  })
  .strict();

const CreateControlledRecoveryEvidenceReadInputSchema =
  CreateRecoveryEvidenceReadInputSchema.extend({
    evidenceSubmissionId: z.string().min(1),
    readbackRequestId: z.string().min(1),
    readAttemptId: z.string().min(1),
    verificationCheckId: z.string().min(1),
    observedAt: z.string().min(1),
    resultPayloadDigest: Sha256DigestSchema,
    resultPayloadStoreRef: z.string().min(1),
    resultPayloadStorageMode: z.literal("content_addressed_file"),
  });

export type CreateRecoveryEvidenceReadInput = z.input<
  typeof CreateRecoveryEvidenceReadInputSchema
>;
export type CreateControlledRecoveryEvidenceReadInput = z.input<
  typeof CreateControlledRecoveryEvidenceReadInputSchema
>;

interface RecoveryEvidenceReadRow {
  id: string;
  task_id: string;
  review_id: string;
  tool_run_id: string;
  evidence_envelope_digest: string;
  evidence_submission_id: string | null;
  readback_request_id: string | null;
  read_attempt_id: string | null;
  verification_check_id: string | null;
  observed_at: string | null;
  resource_version: string | null;
  resource_etag: string | null;
  result_payload_digest: string | null;
  result_payload_store_ref: string | null;
  result_payload_storage_mode: string | null;
  created_at: string;
}

function mapRecoveryEvidenceReadRow(
  row: RecoveryEvidenceReadRow,
): RecoveryEvidenceReadRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    toolRunId: row.tool_run_id,
    evidenceEnvelopeDigest: row.evidence_envelope_digest,
    evidenceSubmissionId: row.evidence_submission_id,
    readbackRequestId: row.readback_request_id,
    readAttemptId: row.read_attempt_id,
    verificationCheckId: row.verification_check_id,
    observedAt: row.observed_at,
    resourceVersion: row.resource_version,
    resourceEtag: row.resource_etag,
    resultPayloadDigest: row.result_payload_digest,
    resultPayloadStoreRef: row.result_payload_store_ref,
    resultPayloadStorageMode:
      row.result_payload_storage_mode === null
        ? null
        : RecoveryEvidencePayloadStorageModeSchema.parse(
            row.result_payload_storage_mode,
          ),
    createdAt: row.created_at,
  };
}

export class RecoveryEvidenceReadRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreateRecoveryEvidenceReadInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed = CreateRecoveryEvidenceReadInputSchema.parse(input);
    if (
      parsed.evidenceSubmissionId !== null ||
      parsed.readbackRequestId !== null ||
      parsed.readAttemptId !== null ||
      parsed.verificationCheckId !== null ||
      parsed.observedAt !== null ||
      parsed.resourceVersion !== null ||
      parsed.resourceEtag !== null ||
      parsed.resultPayloadDigest !== null ||
      parsed.resultPayloadStoreRef !== null ||
      parsed.resultPayloadStorageMode !== null
    ) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_CONTROLLED_READ_REQUIRED",
        message: "Controlled recovery evidence reads must use insertControlled().",
        statusCode: 409,
        details: [],
      });
    }
    return this.insertParsed(parsed, permit);
  }

  insertControlled(
    input: CreateControlledRecoveryEvidenceReadInput,
    permit: StorageWritePermit,
    capability: RecoveryEvidenceControlledReadCapability,
  ): RecoveryEvidenceReadRecord {
    assertRecoveryEvidenceControlledReadCapability(capability);
    assertStorageWritePermit(this.database, permit);
    return this.insertParsed(
      CreateControlledRecoveryEvidenceReadInputSchema.parse(input),
      permit,
    );
  }

  private insertParsed(
    parsed: z.output<typeof CreateRecoveryEvidenceReadInputSchema>,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadRecord {
    assertStorageWritePermit(this.database, permit);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_reads (
            id, task_id, review_id, tool_run_id,
            evidence_envelope_digest, evidence_submission_id,
            readback_request_id, read_attempt_id,
            verification_check_id, observed_at, resource_version,
            resource_etag, result_payload_digest,
            result_payload_store_ref, result_payload_storage_mode,
            created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.toolRunId,
        parsed.evidenceEnvelopeDigest,
        parsed.evidenceSubmissionId,
        parsed.readbackRequestId,
        parsed.readAttemptId,
        parsed.verificationCheckId,
        parsed.observedAt,
        parsed.resourceVersion,
        parsed.resourceEtag,
        parsed.resultPayloadDigest,
        parsed.resultPayloadStoreRef,
        parsed.resultPayloadStorageMode,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryEvidenceReadRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_evidence_reads WHERE id = ?")
      .get(id) as RecoveryEvidenceReadRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READ_NOT_FOUND",
        message: "Recovery evidence read was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceReadRow(row);
  }

  listByTask(taskId: string): readonly RecoveryEvidenceReadRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_reads
            WHERE task_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(taskId) as RecoveryEvidenceReadRow[]
    ).map(mapRecoveryEvidenceReadRow);
  }

  listByReview(reviewId: string): readonly RecoveryEvidenceReadRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_reads
            WHERE review_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(reviewId) as RecoveryEvidenceReadRow[]
    ).map(mapRecoveryEvidenceReadRow);
  }

  getByVerificationCheckId(
    taskId: string,
    verificationCheckId: string,
  ): RecoveryEvidenceReadRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM recovery_evidence_reads
          WHERE task_id = ? AND verification_check_id = ?
        `,
      )
      .get(taskId, verificationCheckId) as
      | RecoveryEvidenceReadRow
      | undefined;
    return row === undefined ? undefined : mapRecoveryEvidenceReadRow(row);
  }
}
