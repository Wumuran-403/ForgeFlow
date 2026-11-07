import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryLegacyAttestationResultSchema,
  RecoveryReviewSourceSchema,
  type RecoveryLegacyAttestationRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryLegacyAttestationInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    originalReviewId: z.string().min(1),
    attestationVersion: z.number().int().positive(),
    requestKey: Sha256DigestSchema,
    evidenceEnvelopeDigest: Sha256DigestSchema,
    evidenceRef: z.string().trim().min(1),
    sourceType: RecoveryReviewSourceSchema,
    actorId: z.string().trim().min(1).nullable(),
    verifierId: z.string().trim().min(1).nullable(),
    verificationId: z.string().trim().min(1).nullable(),
    sourceObservedAt: z.string().min(1),
    submittedAt: z.string().min(1),
    verifiedAt: z.string().min(1),
    result: RecoveryLegacyAttestationResultSchema,
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.sourceType === "manual_review") {
      if (value.actorId === null) {
        context.addIssue({
          code: "custom",
          path: ["actorId"],
          message: "Manual review attestations require an actorId.",
        });
      }
      if (value.verifierId !== null || value.verificationId !== null) {
        context.addIssue({
          code: "custom",
          path: ["verifierId"],
          message: "Manual review attestations cannot define verifier fields.",
        });
      }
      return;
    }
    if (value.actorId !== null) {
      context.addIssue({
        code: "custom",
        path: ["actorId"],
        message: "System attestations cannot define an actorId.",
      });
    }
    if (value.verifierId === null || value.verificationId === null) {
      context.addIssue({
        code: "custom",
        path: ["verifierId"],
        message: "System attestations require verifier identity fields.",
      });
    }
  });

export type CreateRecoveryLegacyAttestationInput = z.input<
  typeof CreateRecoveryLegacyAttestationInputSchema
>;

interface RecoveryLegacyAttestationRow {
  id: string;
  task_id: string;
  original_review_id: string;
  attestation_version: number;
  request_key: string;
  evidence_envelope_digest: string;
  evidence_ref: string;
  source_type: string;
  actor_id: string | null;
  verifier_id: string | null;
  verification_id: string | null;
  source_observed_at: string;
  submitted_at: string;
  verified_at: string;
  result: string;
  created_at: string;
}

function mapRecoveryLegacyAttestationRow(
  row: RecoveryLegacyAttestationRow,
): RecoveryLegacyAttestationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    originalReviewId: row.original_review_id,
    attestationVersion: row.attestation_version,
    requestKey: row.request_key,
    evidenceEnvelopeDigest: row.evidence_envelope_digest,
    evidenceRef: row.evidence_ref,
    sourceType: RecoveryReviewSourceSchema.parse(row.source_type),
    actorId: row.actor_id,
    verifierId: row.verifier_id,
    verificationId: row.verification_id,
    sourceObservedAt: row.source_observed_at,
    submittedAt: row.submitted_at,
    verifiedAt: row.verified_at,
    result: RecoveryLegacyAttestationResultSchema.parse(row.result),
    createdAt: row.created_at,
  };
}

export class RecoveryLegacyAttestationRepository {
  constructor(private readonly database: Database.Database) {}

  append(
    input: CreateRecoveryLegacyAttestationInput,
    permit: StorageWritePermit,
  ): RecoveryLegacyAttestationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreateRecoveryLegacyAttestationInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_legacy_attestations (
            id, task_id, original_review_id, attestation_version,
            request_key, evidence_envelope_digest, evidence_ref,
            source_type, actor_id, verifier_id, verification_id,
            source_observed_at, submitted_at, verified_at,
            result, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.originalReviewId,
        parsed.attestationVersion,
        parsed.requestKey,
        parsed.evidenceEnvelopeDigest,
        parsed.evidenceRef,
        parsed.sourceType,
        parsed.actorId,
        parsed.verifierId,
        parsed.verificationId,
        parsed.sourceObservedAt,
        parsed.submittedAt,
        parsed.verifiedAt,
        parsed.result,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryLegacyAttestationRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_legacy_attestations WHERE id = ?")
      .get(id) as RecoveryLegacyAttestationRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_LEGACY_ATTESTATION_NOT_FOUND",
        message: "Recovery legacy attestation was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryLegacyAttestationRow(row);
  }

  getByRequestKey(
    requestKey: string,
  ): RecoveryLegacyAttestationRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_legacy_attestations WHERE request_key = ?",
      )
      .get(requestKey) as RecoveryLegacyAttestationRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryLegacyAttestationRow(row);
  }

  listByTask(taskId: string): readonly RecoveryLegacyAttestationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_legacy_attestations
            WHERE task_id = ?
            ORDER BY original_review_id, attestation_version
          `,
        )
        .all(taskId) as RecoveryLegacyAttestationRow[]
    ).map(mapRecoveryLegacyAttestationRow);
  }

  listByReview(
    reviewId: string,
  ): readonly RecoveryLegacyAttestationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_legacy_attestations
            WHERE original_review_id = ?
            ORDER BY attestation_version
          `,
        )
        .all(reviewId) as RecoveryLegacyAttestationRow[]
    ).map(mapRecoveryLegacyAttestationRow);
  }
}
