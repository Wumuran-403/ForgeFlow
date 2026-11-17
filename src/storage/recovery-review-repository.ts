import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceDigestProtocolSchema,
  RecoveryEvidencePayloadTypeSchema,
  RecoveryReviewSourceSchema,
  RecoveryReviewStatusSchema,
  type RecoveryReviewRecord,
  type RecoveryEvidenceDigestProtocol,
  type RecoveryEvidencePayloadType,
  type RecoveryReviewSource,
  type RecoveryReviewStatus,
} from "./types.js";
import { assertTaskAcceptsActiveExecution } from "./task-invariants.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface RecoveryReviewRow {
  id: string;
  task_id: string;
  tool_run_id: string;
  status: string;
  note: string | null;
  source_type: string | null;
  evidence_ref: string | null;
  review_protocol_version: number;
  decision_version: number;
  evidence_payload_digest: string | null;
  evidence_payload_type: string | null;
  evidence_digest_protocol: string | null;
  evidence_envelope_digest: string | null;
  actor_id: string | null;
  verifier_id: string | null;
  verification_id: string | null;
  source_observed_at: string | null;
  submitted_at: string | null;
  verified_at: string | null;
  created_at: string;
  updated_at: string;
  decided_at: string | null;
}

function mapRecoveryReviewRow(
  row: RecoveryReviewRow,
): RecoveryReviewRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    toolRunId: row.tool_run_id,
    status: RecoveryReviewStatusSchema.parse(row.status),
    note: row.note,
    sourceType:
      row.source_type === null
        ? null
        : RecoveryReviewSourceSchema.parse(row.source_type),
    evidenceRef: row.evidence_ref,
    reviewProtocolVersion: row.review_protocol_version,
    decisionVersion: row.decision_version,
    evidencePayloadDigest: row.evidence_payload_digest,
    evidencePayloadType:
      row.evidence_payload_type === null
        ? null
        : RecoveryEvidencePayloadTypeSchema.parse(
            row.evidence_payload_type,
          ),
    evidenceDigestProtocol:
      row.evidence_digest_protocol === null
        ? null
        : RecoveryEvidenceDigestProtocolSchema.parse(
            row.evidence_digest_protocol,
          ),
    evidenceEnvelopeDigest: row.evidence_envelope_digest,
    actorId: row.actor_id,
    verifierId: row.verifier_id,
    verificationId: row.verification_id,
    sourceObservedAt: row.source_observed_at,
    submittedAt: row.submitted_at,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    decidedAt: row.decided_at,
  };
}

export interface CreateRecoveryReviewInput {
  readonly id: string;
  readonly taskId: string;
  readonly toolRunId: string;
  readonly note: string | null;
  readonly createdAt: string;
  readonly reviewProtocolVersion?: number;
  readonly decisionVersion?: number;
  readonly evidencePayloadDigest?: string | null;
  readonly evidencePayloadType?: RecoveryEvidencePayloadType | null;
  readonly evidenceDigestProtocol?: RecoveryEvidenceDigestProtocol | null;
  readonly evidenceEnvelopeDigest?: string | null;
  readonly actorId?: string | null;
  readonly verifierId?: string | null;
  readonly verificationId?: string | null;
  readonly sourceObservedAt?: string | null;
  readonly submittedAt?: string | null;
  readonly verifiedAt?: string | null;
}

export interface DecideRecoveryReviewRecordInput {
  readonly status: Exclude<RecoveryReviewStatus, "pending">;
  readonly note: string | null;
  readonly sourceType: RecoveryReviewSource;
  readonly evidenceRef: string | null;
  readonly decidedAt: string;
}

export class RecoveryReviewRepository {
  constructor(private readonly database: Database.Database) {}

  createPending(
    input: CreateRecoveryReviewInput,
    permit: StorageWritePermit,
  ): RecoveryReviewRecord {
    assertStorageWritePermit(this.database, permit);
    assertTaskAcceptsActiveExecution(this.database, input.taskId);
    this.database
      .prepare(
        `
          INSERT INTO recovery_reviews (
            id, task_id, tool_run_id, status, note,
            review_protocol_version, decision_version,
            evidence_payload_digest, evidence_payload_type,
            evidence_digest_protocol, evidence_envelope_digest,
            actor_id, verifier_id, verification_id,
            source_observed_at, submitted_at, verified_at,
            created_at, updated_at
          ) VALUES (
            ?, ?, ?, 'pending', ?,
            ?, ?,
            ?, ?,
            ?, ?,
            ?, ?, ?,
            ?, ?, ?,
            ?, ?
          )
        `,
      )
      .run(
        input.id,
        input.taskId,
        input.toolRunId,
        input.note,
        input.reviewProtocolVersion ?? 0,
        input.decisionVersion ?? 0,
        input.evidencePayloadDigest ?? null,
        input.evidencePayloadType ?? null,
        input.evidenceDigestProtocol ?? null,
        input.evidenceEnvelopeDigest ?? null,
        input.actorId ?? null,
        input.verifierId ?? null,
        input.verificationId ?? null,
        input.sourceObservedAt ?? null,
        input.submittedAt ?? null,
        input.verifiedAt ?? null,
        input.createdAt,
        input.createdAt,
      );
    return this.get(input.id);
  }

  decide(
    id: string,
    input: DecideRecoveryReviewRecordInput,
    permit: StorageWritePermit,
  ): RecoveryReviewRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database
      .prepare(
        `
          UPDATE recovery_reviews
          SET status = ?,
              note = ?,
              source_type = ?,
              evidence_ref = ?,
              decided_at = ?,
              updated_at = ?
          WHERE id = ?
            AND status IN ('pending', 'unresolved')
            AND review_protocol_version = 0
        `,
      )
      .run(
        RecoveryReviewStatusSchema.parse(input.status),
        input.note,
        RecoveryReviewSourceSchema.parse(input.sourceType),
        input.evidenceRef,
        input.decidedAt,
        input.decidedAt,
        id,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "RECOVERY_REVIEW_STATE_CONFLICT",
        message: "Recovery review is not active.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  finalizeCas(input: {
    readonly id: string;
    readonly taskId: string;
    readonly expectedDecisionVersion: number;
    readonly status: "confirmed_succeeded" | "confirmed_not_executed";
    readonly note: string | null;
    readonly sourceType: RecoveryReviewSource;
    readonly evidenceRef: string;
    readonly evidencePayloadDigest: string;
    readonly evidencePayloadType: RecoveryEvidencePayloadType;
    readonly evidenceDigestProtocol: RecoveryEvidenceDigestProtocol;
    readonly evidenceEnvelopeDigest: string;
    readonly actorId: string | null;
    readonly verifierId: string | null;
    readonly verificationId: string | null;
    readonly sourceObservedAt: string;
    readonly submittedAt: string;
    readonly verifiedAt: string | null;
    readonly decidedAt: string;
  }, permit: StorageWritePermit): RecoveryReviewRecord {
    assertStorageWritePermit(this.database, permit);
    const result = this.database.prepare(`
      UPDATE recovery_reviews SET status = ?, note = ?, source_type = ?, evidence_ref = ?,
        decision_version = decision_version + 1, evidence_payload_digest = ?,
        evidence_payload_type = ?, evidence_digest_protocol = ?, evidence_envelope_digest = ?,
        actor_id = ?, verifier_id = ?, verification_id = ?, source_observed_at = ?,
        submitted_at = ?, verified_at = ?, decided_at = ?, updated_at = ?
      WHERE id = ? AND task_id = ? AND review_protocol_version >= 1
        AND status IN ('pending', 'unresolved') AND decision_version = ?
    `).run(input.status, input.note, input.sourceType, input.evidenceRef,
      input.evidencePayloadDigest, input.evidencePayloadType, input.evidenceDigestProtocol,
      input.evidenceEnvelopeDigest, input.actorId, input.verifierId, input.verificationId,
      input.sourceObservedAt, input.submittedAt, input.verifiedAt, input.decidedAt,
      input.decidedAt, input.id, input.taskId, input.expectedDecisionVersion);
    if (result.changes !== 1) throw new AppError({ code: "RECOVERY_REVIEW_DECISION_VERSION_CONFLICT",
      message: "Recovery review decision version has changed.", statusCode: 409, details: [] });
    return this.get(input.id);
  }

  get(id: string): RecoveryReviewRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_reviews WHERE id = ?")
      .get(id) as RecoveryReviewRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_REVIEW_NOT_FOUND",
        message: "Recovery review was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryReviewRow(row);
  }

  getByToolRun(toolRunId: string): RecoveryReviewRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM recovery_reviews WHERE tool_run_id = ?")
      .get(toolRunId) as RecoveryReviewRow | undefined;
    return row === undefined ? undefined : mapRecoveryReviewRow(row);
  }

  listByTask(taskId: string): readonly RecoveryReviewRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_reviews
            WHERE task_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(taskId) as RecoveryReviewRow[]
    ).map(mapRecoveryReviewRow);
  }
}
