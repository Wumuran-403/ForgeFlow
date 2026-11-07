import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import type { RecoveryEvidenceReadRecord } from "./types.js";
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
    createdAt: z.string().min(1),
  })
  .strict();

export type CreateRecoveryEvidenceReadInput = z.input<
  typeof CreateRecoveryEvidenceReadInputSchema
>;

interface RecoveryEvidenceReadRow {
  id: string;
  task_id: string;
  review_id: string;
  tool_run_id: string;
  evidence_envelope_digest: string;
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
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_reads (
            id, task_id, review_id, tool_run_id,
            evidence_envelope_digest, created_at
          ) VALUES (?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.toolRunId,
        parsed.evidenceEnvelopeDigest,
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
}
