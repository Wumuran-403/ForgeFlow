import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceReadAttemptStatusSchema,
  RecoveryEvidenceReadbackConsistencyModeSchema,
  RecoveryEvidenceReadbackRetrySafetySchema,
  type RecoveryEvidenceReadAttemptRecord,
  type RecoveryEvidenceReadAttemptStatus,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const CreatePreparedRecoveryEvidenceReadAttemptInputSchema = z
  .object({
    id: z.string().min(1),
    taskId: z.string().min(1),
    readbackRequestId: z.string().min(1),
    readToolRunId: z.string().min(1),
    attemptNumber: z.number().int().positive(),
    retrySafety: RecoveryEvidenceReadbackRetrySafetySchema,
    consistencyMode: RecoveryEvidenceReadbackConsistencyModeSchema,
    preparedAt: z.string().min(1),
    lastEventId: z.string().min(1),
    createdAt: z.string().min(1),
  })
  .strict();

const TransitionRecoveryEvidenceReadAttemptInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    status: RecoveryEvidenceReadAttemptStatusSchema,
    dispatchingAt: z.string().min(1).nullable().optional(),
    interruptedAt: z.string().min(1).nullable().optional(),
    completedAt: z.string().min(1).nullable().optional(),
    observedAt: z.string().min(1).nullable().optional(),
    resourceVersion: z.string().min(1).nullable().optional(),
    resourceEtag: z.string().min(1).nullable().optional(),
    resultDigest: Sha256DigestSchema.nullable().optional(),
    resultPayloadStoreRef: z.string().min(1).nullable().optional(),
    reasonCode: z.string().trim().min(1).nullable().optional(),
    lastEventId: z.string().min(1),
    updatedAt: z.string().min(1),
  })
  .strict();

export type CreatePreparedRecoveryEvidenceReadAttemptInput = z.input<
  typeof CreatePreparedRecoveryEvidenceReadAttemptInputSchema
>;
export type TransitionRecoveryEvidenceReadAttemptInput = z.input<
  typeof TransitionRecoveryEvidenceReadAttemptInputSchema
>;

interface RecoveryEvidenceReadAttemptRow {
  id: string;
  task_id: string;
  readback_request_id: string;
  read_tool_run_id: string;
  attempt_number: number;
  retry_safety: string;
  consistency_mode: string;
  attempt_status: string;
  prepared_at: string;
  dispatching_at: string | null;
  interrupted_at: string | null;
  completed_at: string | null;
  observed_at: string | null;
  resource_version: string | null;
  resource_etag: string | null;
  result_digest: string | null;
  result_payload_store_ref: string | null;
  reason_code: string | null;
  last_event_id: string;
  version: number;
  created_at: string;
  updated_at: string;
}

function mapRecoveryEvidenceReadAttemptRow(
  row: RecoveryEvidenceReadAttemptRow,
): RecoveryEvidenceReadAttemptRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    readbackRequestId: row.readback_request_id,
    readToolRunId: row.read_tool_run_id,
    attemptNumber: row.attempt_number,
    retrySafety: RecoveryEvidenceReadbackRetrySafetySchema.parse(
      row.retry_safety,
    ),
    consistencyMode: RecoveryEvidenceReadbackConsistencyModeSchema.parse(
      row.consistency_mode,
    ),
    status: RecoveryEvidenceReadAttemptStatusSchema.parse(
      row.attempt_status,
    ),
    preparedAt: row.prepared_at,
    dispatchingAt: row.dispatching_at,
    interruptedAt: row.interrupted_at,
    completedAt: row.completed_at,
    observedAt: row.observed_at,
    resourceVersion: row.resource_version,
    resourceEtag: row.resource_etag,
    resultDigest: row.result_digest,
    resultPayloadStoreRef: row.result_payload_store_ref,
    reasonCode: row.reason_code,
    lastEventId: row.last_event_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const ALLOWED_TRANSITIONS: Readonly<
  Record<RecoveryEvidenceReadAttemptStatus, readonly RecoveryEvidenceReadAttemptStatus[]>
> = {
  prepared: ["dispatching", "cancelled", "blocked_by_intent"],
  dispatching: [
    "completed",
    "interrupted",
    "failed",
    "timed_out",
    "cancelled",
  ],
  interrupted: [],
  completed: [],
  failed: [],
  timed_out: [],
  cancelled: [],
  blocked_by_intent: [],
};

export class RecoveryEvidenceReadAttemptRepository {
  constructor(private readonly database: Database.Database) {}

  insertPrepared(
    input: CreatePreparedRecoveryEvidenceReadAttemptInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadAttemptRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      CreatePreparedRecoveryEvidenceReadAttemptInputSchema.parse(input);
    this.database
      .prepare(
        `
          INSERT INTO recovery_evidence_read_attempts (
            id, task_id, readback_request_id, read_tool_run_id,
            attempt_number, retry_safety, consistency_mode, attempt_status,
            prepared_at, last_event_id, version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'prepared', ?, ?, 1, ?, ?)
        `,
      )
      .run(
        parsed.id,
        parsed.taskId,
        parsed.readbackRequestId,
        parsed.readToolRunId,
        parsed.attemptNumber,
        parsed.retrySafety,
        parsed.consistencyMode,
        parsed.preparedAt,
        parsed.lastEventId,
        parsed.createdAt,
        parsed.createdAt,
      );
    return this.get(parsed.id);
  }

  transition(
    id: string,
    input: TransitionRecoveryEvidenceReadAttemptInput,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadAttemptRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed =
      TransitionRecoveryEvidenceReadAttemptInputSchema.parse(input);
    const current = this.get(id);
    if (
      current.version !== parsed.expectedVersion ||
      !ALLOWED_TRANSITIONS[current.status].includes(parsed.status)
    ) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READ_ATTEMPT_STATE_CONFLICT",
        message: "Recovery evidence read attempt transition is invalid.",
        statusCode: 409,
        details: [],
      });
    }

    const result = this.database
      .prepare(
        `
          UPDATE recovery_evidence_read_attempts
          SET attempt_status = ?,
              dispatching_at = ?,
              interrupted_at = ?,
              completed_at = ?,
              observed_at = ?,
              resource_version = ?,
              resource_etag = ?,
              result_digest = ?,
              result_payload_store_ref = ?,
              reason_code = ?,
              last_event_id = ?,
              version = version + 1,
              updated_at = ?
          WHERE id = ? AND version = ?
        `,
      )
      .run(
        parsed.status,
        valueOrCurrent(parsed.dispatchingAt, current.dispatchingAt),
        valueOrCurrent(parsed.interruptedAt, current.interruptedAt),
        valueOrCurrent(parsed.completedAt, current.completedAt),
        valueOrCurrent(parsed.observedAt, current.observedAt),
        valueOrCurrent(parsed.resourceVersion, current.resourceVersion),
        valueOrCurrent(parsed.resourceEtag, current.resourceEtag),
        valueOrCurrent(parsed.resultDigest, current.resultDigest),
        valueOrCurrent(
          parsed.resultPayloadStoreRef,
          current.resultPayloadStoreRef,
        ),
        valueOrCurrent(parsed.reasonCode, current.reasonCode),
        parsed.lastEventId,
        parsed.updatedAt,
        id,
        parsed.expectedVersion,
      );
    if (result.changes !== 1) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READ_ATTEMPT_STATE_CONFLICT",
        message: "Recovery evidence read attempt changed during transition.",
        statusCode: 409,
        details: [],
      });
    }
    return this.get(id);
  }

  nextAttemptNumber(
    taskId: string,
    readbackRequestId: string,
    readToolRunId: string,
  ): number {
    const row = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(attempt_number), 0) + 1 AS next_number
          FROM recovery_evidence_read_attempts
          WHERE task_id = ?
            AND readback_request_id = ?
            AND read_tool_run_id = ?
        `,
      )
      .get(taskId, readbackRequestId, readToolRunId) as {
      next_number: number;
    };
    return row.next_number;
  }

  get(id: string): RecoveryEvidenceReadAttemptRecord {
    const row = this.database
      .prepare("SELECT * FROM recovery_evidence_read_attempts WHERE id = ?")
      .get(id) as RecoveryEvidenceReadAttemptRow | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READ_ATTEMPT_NOT_FOUND",
        message: "Recovery evidence read attempt was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return mapRecoveryEvidenceReadAttemptRow(row);
  }

  listByTask(taskId: string): readonly RecoveryEvidenceReadAttemptRecord[] {
    return (
      this.database
        .prepare(
          `
            SELECT * FROM recovery_evidence_read_attempts
            WHERE task_id = ?
            ORDER BY readback_request_id, read_tool_run_id, attempt_number
          `,
        )
        .all(taskId) as RecoveryEvidenceReadAttemptRow[]
    ).map(mapRecoveryEvidenceReadAttemptRow);
  }
}

function valueOrCurrent<T>(
  value: T | undefined,
  current: T,
): T {
  return value === undefined ? current : value;
}
