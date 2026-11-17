import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceDigestProtocolSchema,
  RecoveryEvidenceOutcomeSchema,
  RecoveryEvidencePayloadStorageModeSchema,
  RecoveryEvidencePayloadTypeSchema,
  RecoveryReviewSourceSchema,
  type RecoveryEvidenceSubmissionRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryEvidenceSubmissionInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    toolRunId: z.string().min(1),
    operationId: z.string().min(1),
    requestKey: Sha256DigestSchema,
    decisionVersion: z.number().int().positive(),
    sourceType: RecoveryReviewSourceSchema,
    outcome: RecoveryEvidenceOutcomeSchema,
    evidenceRef: z.string().trim().min(1),
    resourceRef: z.string().trim().min(1).nullable(),
    resourceVersion: z.string().trim().min(1).nullable(),
    sourceObservedAt: z.string().min(1),
    submittedAt: z.string().min(1),
    actorId: z.string().trim().min(1).nullable(),
    verifierId: z.string().trim().min(1).nullable(),
    verificationId: z.string().trim().min(1).nullable(),
    payloadType: RecoveryEvidencePayloadTypeSchema,
    payloadDigestProtocol: RecoveryEvidenceDigestProtocolSchema,
    payloadDigest: Sha256DigestSchema,
    envelopeDigest: Sha256DigestSchema,
    payloadStoreRef: z.string().min(1).nullable(),
    payloadStorageMode: RecoveryEvidencePayloadStorageModeSchema,
    appliedEventId: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

export type CreateRecoveryEvidenceSubmissionInput = z.input<
  typeof CreateRecoveryEvidenceSubmissionInputSchema
>;

interface RecoveryEvidenceSubmissionRow {
  id: string;
  task_id: string;
  review_id: string;
  tool_run_id: string;
  operation_id: string;
  request_key: string;
  decision_version: number;
  source_type: string;
  outcome: string;
  evidence_ref: string;
  resource_ref: string | null;
  resource_version: string | null;
  source_observed_at: string;
  submitted_at: string;
  actor_id: string | null;
  verifier_id: string | null;
  verification_id: string | null;
  payload_type: string;
  payload_digest_protocol: string;
  payload_digest: string;
  envelope_digest: string;
  payload_store_ref: string | null;
  payload_storage_mode: string;
  applied_event_id: string;
  created_at: string;
}

function mapRecoveryEvidenceSubmissionRow(
  row: RecoveryEvidenceSubmissionRow,
): RecoveryEvidenceSubmissionRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    toolRunId: row.tool_run_id,
    operationId: row.operation_id,
    requestKey: row.request_key,
    decisionVersion: row.decision_version,
    sourceType: RecoveryReviewSourceSchema.parse(row.source_type),
    outcome: RecoveryEvidenceOutcomeSchema.parse(row.outcome),
    evidenceRef: row.evidence_ref,
    resourceRef: row.resource_ref,
    resourceVersion: row.resource_version,
    sourceObservedAt: row.source_observed_at,
    submittedAt: row.submitted_at,
    actorId: row.actor_id,
    verifierId: row.verifier_id,
    verificationId: row.verification_id,
    payloadType: RecoveryEvidencePayloadTypeSchema.parse(row.payload_type),
    payloadDigestProtocol: RecoveryEvidenceDigestProtocolSchema.parse(
      row.payload_digest_protocol,
    ),
    payloadDigest: row.payload_digest,
    envelopeDigest: row.envelope_digest,
    payloadStoreRef: row.payload_store_ref,
    payloadStorageMode: RecoveryEvidencePayloadStorageModeSchema.parse(
      row.payload_storage_mode,
    ),
    appliedEventId: row.applied_event_id,
    createdAt: row.created_at,
  };
}

export class RecoveryEvidenceSubmissionRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreateRecoveryEvidenceSubmissionInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceSubmissionRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreateRecoveryEvidenceSubmissionInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_submissions (
            id, task_id, review_id, tool_run_id, operation_id,
            request_key, decision_version, source_type, outcome,
            evidence_ref, resource_ref, resource_version,
            source_observed_at, submitted_at, actor_id, verifier_id,
            verification_id, payload_type, payload_digest_protocol,
            payload_digest, envelope_digest, payload_store_ref,
            payload_storage_mode, applied_event_id, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?, ?, ?
          )
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.toolRunId,
        parsed.operationId,
        parsed.requestKey,
        parsed.decisionVersion,
        parsed.sourceType,
        parsed.outcome,
        parsed.evidenceRef,
        parsed.resourceRef,
        parsed.resourceVersion,
        parsed.sourceObservedAt,
        parsed.submittedAt,
        parsed.actorId,
        parsed.verifierId,
        parsed.verificationId,
        parsed.payloadType,
        parsed.payloadDigestProtocol,
        parsed.payloadDigest,
        parsed.envelopeDigest,
        parsed.payloadStoreRef,
        parsed.payloadStorageMode,
        parsed.appliedEventId,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryEvidenceSubmissionRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_evidence_submissions WHERE id = ?")
      .get(id) as RecoveryEvidenceSubmissionRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_SUBMISSION_NOT_FOUND",
        message: "Recovery evidence submission was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceSubmissionRow(row);
  }

  getByRequestKey(
    requestKey: string,
  ): RecoveryEvidenceSubmissionRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_submissions WHERE request_key = ?",
      )
      .get(requestKey) as RecoveryEvidenceSubmissionRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceSubmissionRow(row);
  }

  getByOperation(
    operationId: string,
  ): RecoveryEvidenceSubmissionRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_submissions WHERE operation_id = ?",
      )
      .get(operationId) as RecoveryEvidenceSubmissionRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceSubmissionRow(row);
  }

  listByTask(taskId: string): readonly RecoveryEvidenceSubmissionRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_submissions
            WHERE task_id = ?
            ORDER BY decision_version, created_at, id
          `,
        )
        .all(taskId) as RecoveryEvidenceSubmissionRow[]
    ).map(mapRecoveryEvidenceSubmissionRow);
  }
}
