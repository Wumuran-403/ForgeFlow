import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryReviewOperationTypeSchema,
  type RecoveryReviewOperationRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryReviewOperationInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    requestKey: Sha256DigestSchema,
    operation: RecoveryReviewOperationTypeSchema,
    expectedDecisionVersion: z.number().int().nonnegative(),
    resultingDecisionVersion: z.number().int().positive(),
    status: z.string().trim().min(1),
    evidenceEnvelopeDigest: Sha256DigestSchema.nullable(),
    resultPlanId: z.string().min(1).nullable(),
    resultToolRunId: z.string().min(1).nullable(),
    appliedEventId: z.string().min(1).nullable(),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.resultingDecisionVersion !== value.expectedDecisionVersion + 1) {
      context.addIssue({
        code: "custom",
        path: ["resultingDecisionVersion"],
        message: "Resulting decision version must advance by exactly one.",
      });
    }
    const hasResultPlan = value.resultPlanId !== null;
    const hasResultToolRun = value.resultToolRunId !== null;
    if (value.operation === "request_readback") {
      if (!hasResultPlan || !hasResultToolRun) {
        context.addIssue({
          code: "custom",
          path: ["resultPlanId"],
          message: "Read-back requests require plan and tool run references.",
        });
      }
    } else if (hasResultPlan || hasResultToolRun) {
      context.addIssue({
        code: "custom",
        path: ["resultPlanId"],
        message: "Only read-back requests may reference result plan rows.",
      });
    }
  });

export type CreateRecoveryReviewOperationInput = z.input<
  typeof CreateRecoveryReviewOperationInputSchema
>;

interface RecoveryReviewOperationRow {
  id: string;
  task_id: string;
  review_id: string;
  request_key: string;
  operation: string;
  expected_decision_version: number;
  resulting_decision_version: number;
  status: string;
  evidence_envelope_digest: string | null;
  result_plan_id: string | null;
  result_tool_run_id: string | null;
  applied_event_id: string | null;
  created_at: string;
}

function mapRecoveryReviewOperationRow(
  row: RecoveryReviewOperationRow,
): RecoveryReviewOperationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    requestKey: row.request_key,
    operation: RecoveryReviewOperationTypeSchema.parse(row.operation),
    expectedDecisionVersion: row.expected_decision_version,
    resultingDecisionVersion: row.resulting_decision_version,
    status: row.status,
    evidenceEnvelopeDigest: row.evidence_envelope_digest,
    resultPlanId: row.result_plan_id,
    resultToolRunId: row.result_tool_run_id,
    appliedEventId: row.applied_event_id,
    createdAt: row.created_at,
  };
}

export class RecoveryReviewOperationRepository {
  constructor(private readonly database: Database.Database) {}

  append(
    input: CreateRecoveryReviewOperationInput,
    permit: StorageWritePermit,
  ): RecoveryReviewOperationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreateRecoveryReviewOperationInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_review_operations (
            id, task_id, review_id, request_key, operation,
            expected_decision_version, resulting_decision_version,
            status, evidence_envelope_digest, result_plan_id,
            result_tool_run_id, applied_event_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.requestKey,
        parsed.operation,
        parsed.expectedDecisionVersion,
        parsed.resultingDecisionVersion,
        parsed.status,
        parsed.evidenceEnvelopeDigest,
        parsed.resultPlanId,
        parsed.resultToolRunId,
        parsed.appliedEventId,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryReviewOperationRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_review_operations WHERE id = ?")
      .get(id) as RecoveryReviewOperationRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_REVIEW_OPERATION_NOT_FOUND",
        message: "Recovery review operation was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryReviewOperationRow(row);
  }

  getByRequestKey(
    requestKey: string,
  ): RecoveryReviewOperationRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_review_operations WHERE request_key = ?",
      )
      .get(requestKey) as RecoveryReviewOperationRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryReviewOperationRow(row);
  }

  listByTask(taskId: string): readonly RecoveryReviewOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_review_operations
            WHERE task_id = ?
            ORDER BY review_id, resulting_decision_version
          `,
        )
        .all(taskId) as RecoveryReviewOperationRow[]
    ).map(mapRecoveryReviewOperationRow);
  }

  listByReview(
    reviewId: string,
  ): readonly RecoveryReviewOperationRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_review_operations
            WHERE review_id = ?
            ORDER BY resulting_decision_version
          `,
        )
        .all(reviewId) as RecoveryReviewOperationRow[]
    ).map(mapRecoveryReviewOperationRow);
  }
}
