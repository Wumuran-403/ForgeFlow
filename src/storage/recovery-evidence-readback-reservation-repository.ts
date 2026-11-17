import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceReadbackReservationStatusSchema,
  type RecoveryEvidenceReadbackReservationRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const OwnerTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);
const NonEmptyStringSchema = z.string().min(1);

const RecoveryEvidenceReadbackReservationInputSchema = z
  .object({
    id: NonEmptyStringSchema,
    taskId: NonEmptyStringSchema,
    reviewId: NonEmptyStringSchema,
    evidenceSubmissionId: NonEmptyStringSchema,
    originalToolRunId: NonEmptyStringSchema,
    requestId: NonEmptyStringSchema,
    operationId: NonEmptyStringSchema,
    executionPlanId: NonEmptyStringSchema,
    planStepId: NonEmptyStringSchema,
    readToolRunId: NonEmptyStringSchema,
    readAttemptId: NonEmptyStringSchema,
    verificationCheckId: NonEmptyStringSchema,
    requestIntentDigest: Sha256DigestSchema,
    ownerToken: OwnerTokenSchema,
    ownerFencingToken: z.number().int().positive(),
    createdAt: NonEmptyStringSchema,
  })
  .strict();

const RecoveryEvidenceReadbackReservationTransitionInputSchema = z
  .object({
    id: NonEmptyStringSchema,
    expectedReservationVersion: z.number().int().positive(),
    ownerToken: OwnerTokenSchema,
    ownerFencingToken: z.number().int().positive(),
    updatedAt: NonEmptyStringSchema,
  })
  .strict();

const RecoveryEvidenceReadbackReservationTakeoverInputSchema = z
  .object({
    id: NonEmptyStringSchema,
    expectedReservationVersion: z.number().int().positive(),
    previousOwnerFencingToken: z.number().int().positive(),
    newOwnerToken: OwnerTokenSchema,
    newOwnerFencingToken: z.number().int().positive(),
    updatedAt: NonEmptyStringSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.newOwnerFencingToken <= value.previousOwnerFencingToken) {
      context.addIssue({
        code: "custom",
        path: ["newOwnerFencingToken"],
        message: "Reservation takeover fencing must strictly increase.",
      });
    }
  });

export type RecoveryEvidenceReadbackReservationInput = z.input<
  typeof RecoveryEvidenceReadbackReservationInputSchema
>;
export type RecoveryEvidenceReadbackReservationTransitionInput = z.input<
  typeof RecoveryEvidenceReadbackReservationTransitionInputSchema
>;
export type RecoveryEvidenceReadbackReservationTakeoverInput = z.input<
  typeof RecoveryEvidenceReadbackReservationTakeoverInputSchema
>;

interface RecoveryEvidenceReadbackReservationRow {
  id: string;
  task_id: string;
  review_id: string;
  evidence_submission_id: string;
  original_tool_run_id: string;
  request_id: string;
  operation_id: string;
  execution_plan_id: string;
  plan_step_id: string;
  read_tool_run_id: string;
  read_attempt_id: string;
  verification_check_id: string;
  request_intent_digest: string;
  owner_token: string;
  owner_fencing_token: number;
  status: string;
  reservation_version: number;
  created_at: string;
  updated_at: string;
}

function mapRecoveryEvidenceReadbackReservationRow(
  row: RecoveryEvidenceReadbackReservationRow,
): RecoveryEvidenceReadbackReservationRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    reviewId: row.review_id,
    evidenceSubmissionId: row.evidence_submission_id,
    originalToolRunId: row.original_tool_run_id,
    requestId: row.request_id,
    operationId: row.operation_id,
    executionPlanId: row.execution_plan_id,
    planStepId: row.plan_step_id,
    readToolRunId: row.read_tool_run_id,
    readAttemptId: row.read_attempt_id,
    verificationCheckId: row.verification_check_id,
    requestIntentDigest: row.request_intent_digest,
    ownerToken: row.owner_token,
    ownerFencingToken: row.owner_fencing_token,
    status: RecoveryEvidenceReadbackReservationStatusSchema.parse(
      row.status,
    ),
    reservationVersion: row.reservation_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class RecoveryEvidenceReadbackReservationRepository {
  constructor(private readonly database: Database.Database) {}

  insert(
    input: RecoveryEvidenceReadbackReservationInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadbackReservationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      RecoveryEvidenceReadbackReservationInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_readback_request_reservations (
            id, task_id, review_id, evidence_submission_id,
            original_tool_run_id, request_id, operation_id,
            execution_plan_id, plan_step_id, read_tool_run_id,
            read_attempt_id, verification_check_id,
            request_intent_digest, owner_token, owner_fencing_token,
            status, reservation_version, created_at, updated_at
          ) VALUES (
            ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
            'preparing', 1, ?, ?
          )
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.reviewId,
        parsed.evidenceSubmissionId,
        parsed.originalToolRunId,
        parsed.requestId,
        parsed.operationId,
        parsed.executionPlanId,
        parsed.planStepId,
        parsed.readToolRunId,
        parsed.readAttemptId,
        parsed.verificationCheckId,
        parsed.requestIntentDigest,
        parsed.ownerToken,
        parsed.ownerFencingToken,
        parsed.createdAt,
        parsed.createdAt,
      );
    return this.getById(parsed.id);
  }

  getById(
    id: string,
  ): RecoveryEvidenceReadbackReservationRecord {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM recovery_evidence_readback_request_reservations
          WHERE id = ?
        `,
      )
      .get(id) as
      | RecoveryEvidenceReadbackReservationRow
      | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READBACK_RESERVATION_NOT_FOUND",
        message: "Recovery evidence readback reservation was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceReadbackReservationRow(row);
  }

  getByLogicalIdentity(input: {
    readonly taskId: string;
    readonly reviewId: string;
    readonly evidenceSubmissionId: string;
    readonly originalToolRunId: string;
  }): RecoveryEvidenceReadbackReservationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM recovery_evidence_readback_request_reservations
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
      ) as RecoveryEvidenceReadbackReservationRow | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceReadbackReservationRow(row);
  }

  getByRequestId(
    requestId: string,
  ): RecoveryEvidenceReadbackReservationRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT *
          FROM recovery_evidence_readback_request_reservations
          WHERE request_id = ?
        `,
      )
      .get(requestId) as
      | RecoveryEvidenceReadbackReservationRow
      | undefined;
    return row === undefined
      ? undefined
      : mapRecoveryEvidenceReadbackReservationRow(row);
  }

  takeover(
    input: RecoveryEvidenceReadbackReservationTakeoverInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadbackReservationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      RecoveryEvidenceReadbackReservationTakeoverInputSchema.parse(input);
    const result = this.database
      .prepare(
        `
          UPDATE recovery_evidence_readback_request_reservations
          SET owner_token = ?,
              owner_fencing_token = ?,
              status = 'preparing',
              reservation_version = reservation_version + 1,
              updated_at = ?
          WHERE id = ?
            AND status IN ('preparing', 'abandoned')
            AND owner_fencing_token = ?
            AND reservation_version = ?
        `,
      )
      .run(
        parsed.newOwnerToken,
        parsed.newOwnerFencingToken,
        parsed.updatedAt,
        parsed.id,
        parsed.previousOwnerFencingToken,
        parsed.expectedReservationVersion,
      );
    if (result.changes !== 1) {
      throw reservationConflict();
    }
    return this.getById(parsed.id);
  }

  abandon(
    input: RecoveryEvidenceReadbackReservationTransitionInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadbackReservationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      RecoveryEvidenceReadbackReservationTransitionInputSchema.parse(input);
    const result = this.database
      .prepare(
        `
          UPDATE recovery_evidence_readback_request_reservations
          SET status = 'abandoned',
              reservation_version = reservation_version + 1,
              updated_at = ?
          WHERE id = ?
            AND status = 'preparing'
            AND owner_token = ?
            AND owner_fencing_token = ?
            AND reservation_version = ?
        `,
      )
      .run(
        parsed.updatedAt,
        parsed.id,
        parsed.ownerToken,
        parsed.ownerFencingToken,
        parsed.expectedReservationVersion,
      );
    if (result.changes !== 1) {
      throw reservationConflict();
    }
    return this.getById(parsed.id);
  }

  complete(
    input: RecoveryEvidenceReadbackReservationTransitionInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadbackReservationRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      RecoveryEvidenceReadbackReservationTransitionInputSchema.parse(input);
    const result = this.database
      .prepare(
        `
          UPDATE recovery_evidence_readback_request_reservations
          SET status = 'completed',
              reservation_version = reservation_version + 1,
              updated_at = ?
          WHERE id = ?
            AND status = 'preparing'
            AND owner_token = ?
            AND owner_fencing_token = ?
            AND reservation_version = ?
        `,
      )
      .run(
        parsed.updatedAt,
        parsed.id,
        parsed.ownerToken,
        parsed.ownerFencingToken,
        parsed.expectedReservationVersion,
      );
    if (result.changes !== 1) {
      throw reservationConflict();
    }
    this.assertCompletedInvariant(parsed.id);
    return this.getById(parsed.id);
  }

  assertCompletedInvariant(id: string): void {
    const row = this.database
      .prepare(
        `
          SELECT 1
          FROM recovery_evidence_readback_request_reservations AS reservation
          JOIN recovery_evidence_readback_requests AS request
            ON request.id = reservation.request_id
            AND request.task_id = reservation.task_id
            AND request.review_id = reservation.review_id
            AND request.evidence_submission_id =
              reservation.evidence_submission_id
            AND request.original_tool_run_id =
              reservation.original_tool_run_id
            AND request.operation_id = reservation.operation_id
            AND request.execution_plan_id =
              reservation.execution_plan_id
            AND request.plan_step_id = reservation.plan_step_id
            AND request.read_tool_run_id =
              reservation.read_tool_run_id
            AND request.verification_check_id =
              reservation.verification_check_id
          JOIN recovery_review_operations AS operation
            ON operation.id = reservation.operation_id
            AND operation.task_id = reservation.task_id
            AND operation.review_id = reservation.review_id
            AND operation.request_key = request.request_key
          JOIN execution_plans AS plan
            ON plan.id = reservation.execution_plan_id
            AND plan.task_id = reservation.task_id
          JOIN plan_steps AS step
            ON step.id = reservation.plan_step_id
            AND step.task_id = reservation.task_id
            AND step.plan_id = plan.id
          JOIN tool_runs AS read_run
            ON read_run.id = reservation.read_tool_run_id
            AND read_run.task_id = reservation.task_id
            AND read_run.plan_step_id = step.id
          JOIN recovery_evidence_read_attempts AS attempt
            ON attempt.id = reservation.read_attempt_id
            AND attempt.task_id = reservation.task_id
            AND attempt.readback_request_id = request.id
            AND attempt.read_tool_run_id = read_run.id
          JOIN events AS request_event
            ON request_event.id = operation.applied_event_id
            AND request_event.task_id = reservation.task_id
          WHERE reservation.id = ?
            AND reservation.status = 'completed'
            AND operation.operation = 'request_readback'
            AND operation.status = 'accepted'
            AND operation.result_plan_id =
              reservation.execution_plan_id
            AND operation.result_tool_run_id =
              reservation.read_tool_run_id
            AND request_event.type = 'recovery.readback_requested'
            AND plan.purpose = 'recovery_evidence'
            AND plan.status = 'active'
            AND step.kind = 'read_batch'
            AND step.status = 'queued'
            AND read_run.mode = 'read'
            AND read_run.status = 'queued'
            AND attempt.attempt_status = 'prepared'
            AND attempt.attempt_number = 1
        `,
      )
      .get(id);
    if (row === undefined) {
      throw new AppError({
        code:
          "RECOVERY_EVIDENCE_READBACK_RESERVATION_COMPLETION_INCONSISTENT",
        message:
          "Completed recovery readback reservation does not match Transaction A.",
        statusCode: 409,
        details: [],
      });
    }
  }

  assertCompletedIdentityInvariant(id: string): void {
    const row = this.database
      .prepare(
        `
          SELECT 1
          FROM recovery_evidence_readback_request_reservations AS reservation
          JOIN recovery_evidence_readback_requests AS request
            ON request.id = reservation.request_id
            AND request.task_id = reservation.task_id
            AND request.review_id = reservation.review_id
            AND request.evidence_submission_id =
              reservation.evidence_submission_id
            AND request.original_tool_run_id =
              reservation.original_tool_run_id
            AND request.operation_id = reservation.operation_id
            AND request.execution_plan_id =
              reservation.execution_plan_id
            AND request.plan_step_id = reservation.plan_step_id
            AND request.read_tool_run_id =
              reservation.read_tool_run_id
            AND request.verification_check_id =
              reservation.verification_check_id
          JOIN recovery_review_operations AS operation
            ON operation.id = reservation.operation_id
            AND operation.task_id = reservation.task_id
            AND operation.review_id = reservation.review_id
            AND operation.request_key = request.request_key
          JOIN execution_plans AS plan
            ON plan.id = reservation.execution_plan_id
            AND plan.task_id = reservation.task_id
          JOIN plan_steps AS step
            ON step.id = reservation.plan_step_id
            AND step.task_id = reservation.task_id
            AND step.plan_id = plan.id
          JOIN tool_runs AS read_run
            ON read_run.id = reservation.read_tool_run_id
            AND read_run.task_id = reservation.task_id
            AND read_run.plan_step_id = step.id
          JOIN recovery_evidence_read_attempts AS attempt
            ON attempt.id = reservation.read_attempt_id
            AND attempt.task_id = reservation.task_id
            AND attempt.readback_request_id = request.id
            AND attempt.read_tool_run_id = read_run.id
            AND attempt.attempt_number = 1
          JOIN events AS request_event
            ON request_event.id = operation.applied_event_id
            AND request_event.task_id = reservation.task_id
          WHERE reservation.id = ?
            AND reservation.status = 'completed'
            AND operation.operation = 'request_readback'
            AND operation.status = 'accepted'
            AND operation.result_plan_id =
              reservation.execution_plan_id
            AND operation.result_tool_run_id =
              reservation.read_tool_run_id
            AND request_event.type = 'recovery.readback_requested'
            AND plan.purpose = 'recovery_evidence'
            AND step.kind = 'read_batch'
            AND read_run.mode = 'read'
        `,
      )
      .get(id);
    if (row === undefined) {
      throw new AppError({
        code:
          "RECOVERY_EVIDENCE_READBACK_RESERVATION_COMPLETION_INCONSISTENT",
        message:
          "Completed recovery readback reservation identity is inconsistent.",
        statusCode: 409,
        details: [],
      });
    }
  }
}

function reservationConflict(): AppError {
  return new AppError({
    code: "RECOVERY_EVIDENCE_READBACK_RESERVATION_CONFLICT",
    message: "Recovery evidence readback reservation changed.",
    statusCode: 409,
    details: [],
  });
}
