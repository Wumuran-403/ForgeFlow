import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceReadbackConsistencyModeSchema,
  RecoveryEvidenceReadbackRetrySafetySchema,
  type RecoveryEvidenceReadbackRequestRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreateRecoveryEvidenceReadbackRequestInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    reviewId: z.string().min(1),
    evidenceSubmissionId: z.string().min(1),
    originalToolRunId: z.string().min(1),
    requestKey: Sha256DigestSchema,
    operationId: z.string().min(1),
    executionPlanId: z.string().min(1),
    planStepId: z.string().min(1),
    readToolRunId: z.string().min(1),
    verifierId: z.string().trim().min(1),
    verifierVersion: z.string().trim().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    allowlistId: z.string().trim().min(1),
    allowlistVersion: z.string().trim().min(1),
    readToolName: z.string().trim().min(1),
    readToolVersion: z.string().trim().min(1),
    readToolSchemaHash: Sha256DigestSchema,
    retrySafety: RecoveryEvidenceReadbackRetrySafetySchema,
    consistencyMode: RecoveryEvidenceReadbackConsistencyModeSchema,
    expectedResourceVersion: z.string().trim().min(1).nullable(),
    expectedEtag: z.string().trim().min(1).nullable(),
    verificationCheckId: z.string().trim().min(1),
    createdAt: z.string().min(1),
  })
  .strict()
  .superRefine((value, context) => {
    const expectedBinding =
      value.expectedResourceVersion !== null || value.expectedEtag !== null;
    if (value.retrySafety === "immutable") {
      if (
        value.consistencyMode !== "immutable_version" ||
        expectedBinding
      ) {
        context.addIssue({
          code: "custom",
          path: ["retrySafety"],
          message: "Immutable requests cannot define version expectations.",
        });
      }
      return;
    }
    if (
      value.consistencyMode !== "etag_or_resource_version" ||
      !expectedBinding
    ) {
      context.addIssue({
        code: "custom",
        path: ["retrySafety"],
        message:
          "Version-conditional requests require an expected version or ETag.",
      });
    }
  });

export type CreateRecoveryEvidenceReadbackRequestInput = z.input<
  typeof CreateRecoveryEvidenceReadbackRequestInputSchema
>;

interface RecoveryEvidenceReadbackRequestRow {
  id: string;
  task_id: string;
  review_id: string;
  evidence_submission_id: string;
  original_tool_run_id: string;
  request_key: string;
  operation_id: string;
  execution_plan_id: string;
  plan_step_id: string;
  read_tool_run_id: string;
  verifier_id: string;
  verifier_version: string;
  verifier_config_digest: string;
  allowlist_id: string;
  allowlist_version: string;
  read_tool_name: string;
  read_tool_version: string;
  read_tool_schema_hash: string;
  retry_safety: string;
  consistency_mode: string;
  expected_resource_version: string | null;
  expected_etag: string | null;
  verification_check_id: string;
  created_at: string;
}

function mapRecoveryEvidenceReadbackRequestRow(
  row: RecoveryEvidenceReadbackRequestRow,
): RecoveryEvidenceReadbackRequestRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    evidenceSubmissionId: row.evidence_submission_id,
    originalToolRunId: row.original_tool_run_id,
    requestKey: row.request_key,
    operationId: row.operation_id,
    executionPlanId: row.execution_plan_id,
    planStepId: row.plan_step_id,
    readToolRunId: row.read_tool_run_id,
    verifierId: row.verifier_id,
    verifierVersion: row.verifier_version,
    verifierConfigDigest: row.verifier_config_digest,
    allowlistId: row.allowlist_id,
    allowlistVersion: row.allowlist_version,
    readToolName: row.read_tool_name,
    readToolVersion: row.read_tool_version,
    readToolSchemaHash: row.read_tool_schema_hash,
    retrySafety:
      RecoveryEvidenceReadbackRetrySafetySchema.parse(row.retry_safety),
    consistencyMode:
      RecoveryEvidenceReadbackConsistencyModeSchema.parse(
        row.consistency_mode,
      ),
    expectedResourceVersion: row.expected_resource_version,
    expectedEtag: row.expected_etag,
    verificationCheckId: row.verification_check_id,
    createdAt: row.created_at,
  };
}

export class RecoveryEvidenceReadbackRequestRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: CreateRecoveryEvidenceReadbackRequestInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadbackRequestRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreateRecoveryEvidenceReadbackRequestInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_readback_requests (
            id, task_id, review_id, evidence_submission_id,
            original_tool_run_id, request_key, operation_id,
            execution_plan_id, plan_step_id, read_tool_run_id,
            verifier_id, verifier_version, verifier_config_digest,
            allowlist_id, allowlist_version, read_tool_name,
            read_tool_version, read_tool_schema_hash, retry_safety,
            consistency_mode, expected_resource_version, expected_etag,
            verification_check_id, created_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            ?, ?, ?, ?, ?
          )
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.evidenceSubmissionId,
        parsed.originalToolRunId,
        parsed.requestKey,
        parsed.operationId,
        parsed.executionPlanId,
        parsed.planStepId,
        parsed.readToolRunId,
        parsed.verifierId,
        parsed.verifierVersion,
        parsed.verifierConfigDigest,
        parsed.allowlistId,
        parsed.allowlistVersion,
        parsed.readToolName,
        parsed.readToolVersion,
        parsed.readToolSchemaHash,
        parsed.retrySafety,
        parsed.consistencyMode,
        parsed.expectedResourceVersion,
        parsed.expectedEtag,
        parsed.verificationCheckId,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  get(id: string): RecoveryEvidenceReadbackRequestRecord {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_readback_requests WHERE id = ?",
      )
      .get(id) as RecoveryEvidenceReadbackRequestRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READBACK_REQUEST_NOT_FOUND",
        message: "Recovery evidence readback request was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceReadbackRequestRow(row);
  }

  getByRequestKey(
    requestKey: string,
  ): RecoveryEvidenceReadbackRequestRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_readback_requests WHERE request_key = ?",
      )
      .get(requestKey) as RecoveryEvidenceReadbackRequestRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceReadbackRequestRow(row);
  }

  getByLogicalIdentity(input: {
    readonly taskId: string;
    readonly reviewId: string;
    readonly evidenceSubmissionId: string;
    readonly originalToolRunId: string;
  }): RecoveryEvidenceReadbackRequestRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM recovery_evidence_readback_requests
          WHERE task_id = ?
            AND review_id = ?
            AND evidence_submission_id = ?
            AND original_tool_run_id = ?
        `,
      )
      .get(
        input.taskId,
        input.reviewId,
        input.evidenceSubmissionId,
        input.originalToolRunId,
      ) as RecoveryEvidenceReadbackRequestRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceReadbackRequestRow(row);
  }

  getByOperationId(
    operationId: string,
  ): RecoveryEvidenceReadbackRequestRecord | undefined {
    const row = this.database
      .prepare(
        "SELECT * FROM recovery_evidence_readback_requests WHERE operation_id = ?",
      )
      .get(operationId) as RecoveryEvidenceReadbackRequestRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceReadbackRequestRow(row);
  }

  listByTask(
    taskId: string,
  ): readonly RecoveryEvidenceReadbackRequestRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_readback_requests
            WHERE task_id = ?
            ORDER BY created_at, id
          `,
        )
        .all(taskId) as RecoveryEvidenceReadbackRequestRow[]
    ).map(mapRecoveryEvidenceReadbackRequestRow);
  }
}
