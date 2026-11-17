import { randomBytes, randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../shared/errors.js";
import type { ForgeFlowDatabase } from "./database.js";
import {
  RecoveryEvidenceReadbackRequestIntentInputSchema,
  computeRecoveryEvidenceReadbackRequestIntentDigest,
} from "./recovery-evidence-readback-reservation-keys.js";
import { RecoveryEvidenceReadbackReservationRepository } from "./recovery-evidence-readback-reservation-repository.js";
import { RecoveryEvidenceReadbackRequestRepository } from "./recovery-evidence-readback-request-repository.js";
import { RecoveryReviewOperationRepository } from "./recovery-review-operation-repository.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { TaskRepository } from "./task-repository.js";
import {
  assertSynchronousFunction,
  assertSynchronousResult,
  runInTransaction,
} from "./transaction.js";
import type {
  RecoveryEvidenceReadbackReservationRecord,
  RecoveryEvidenceReadbackRequestRecord,
  TaskRecord,
} from "./types.js";
import {
  createStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const OwnershipSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const ReservationIntentSchema = z
  .object({
    reviewId: z.string().trim().min(1),
    evidenceSubmissionId: z.string().trim().min(1),
    originalToolRunId: z.string().trim().min(1),
    allowlistId: z.string().trim().min(1),
    verificationCheckId: z.string().trim().min(1),
    expectedDecisionVersion: z.number().int().nonnegative(),
    expectedResourceVersion: z.string().trim().min(1).nullable(),
    expectedEtag: z.string().trim().min(1).nullable(),
  })
  .strict();

const AcquireReservationInputSchema = z
  .object({
    ownership: OwnershipSchema,
    expectedTaskVersion: z.number().int().positive(),
    requestIntent: ReservationIntentSchema,
    requestId: z.string().min(1),
    operationId: z.string().min(1),
    executionPlanId: z.string().min(1),
    planStepId: z.string().min(1),
    readToolRunId: z.string().min(1),
    readAttemptId: z.string().min(1),
    ownerToken: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  })
  .strict();

const ReservationOwnerInputSchema = z
  .object({
    ownership: OwnershipSchema,
    reservationId: z.string().min(1),
    expectedReservationVersion: z.number().int().positive(),
    ownerToken: z.string().regex(/^[0-9a-f]{64}$/),
    requestIntent: ReservationIntentSchema,
  })
  .strict();

export type AcquireRecoveryEvidenceReadbackReservationInput =
  z.input<typeof AcquireReservationInputSchema>;
export type AbandonRecoveryEvidenceReadbackReservationInput =
  z.input<typeof ReservationOwnerInputSchema>;
export type CompleteRecoveryEvidenceReadbackReservationInput =
  z.input<typeof ReservationOwnerInputSchema>;

export type RecoveryEvidenceReadbackReservationView = Omit<
  RecoveryEvidenceReadbackReservationRecord,
  "ownerToken"
>;

export type RecoveryEvidenceReadbackReservationAcquireResult =
  | {
      readonly state: "acquired";
      readonly reservation: RecoveryEvidenceReadbackReservationView;
      readonly ownerToken: string;
    }
  | {
      readonly state: "reentered";
      readonly reservation: RecoveryEvidenceReadbackReservationView;
      readonly ownerToken: string;
    }
  | {
      readonly state: "in_progress";
      readonly reservation: RecoveryEvidenceReadbackReservationView;
      readonly ownerToken: null;
    }
  | {
      readonly state: "completed";
      readonly reservation: RecoveryEvidenceReadbackReservationView;
      readonly request: RecoveryEvidenceReadbackRequestRecord;
      readonly ownerToken: null;
    }
  | {
      readonly state: "historical_request";
      readonly reservation: null;
      readonly request: RecoveryEvidenceReadbackRequestRecord;
      readonly ownerToken: null;
    };

export interface RecoveryEvidenceReadbackTransactionACompletionContext {
  readonly task: TaskRecord;
  readonly reservation: RecoveryEvidenceReadbackReservationRecord;
  readonly permit: StorageWritePermit;
  readonly now: string;
}

export type RecoveryEvidenceReadbackTransactionACompletion = (
  context: RecoveryEvidenceReadbackTransactionACompletionContext,
) => void;

export interface RecoveryEvidenceReadbackReservationUnitOfWorkOptions {
  readonly now?: () => Date;
}

export class RecoveryEvidenceReadbackReservationUnitOfWork {
  private readonly tasks: TaskRepository;
  private readonly reservations: RecoveryEvidenceReadbackReservationRepository;
  private readonly requests: RecoveryEvidenceReadbackRequestRepository;
  private readonly operations: RecoveryReviewOperationRepository;
  private readonly now: () => Date;

  constructor(
    private readonly database: ForgeFlowDatabase,
    private readonly assertAuthority: () => void,
    private readonly leaseManager: TaskLeaseManager,
    options: RecoveryEvidenceReadbackReservationUnitOfWorkOptions = {},
  ) {
    this.tasks = new TaskRepository(database);
    this.reservations =
      new RecoveryEvidenceReadbackReservationRepository(database);
    this.requests = new RecoveryEvidenceReadbackRequestRepository(database);
    this.operations = new RecoveryReviewOperationRepository(database);
    this.now = options.now ?? (() => new Date());
  }

  acquireOwned(
    input: AcquireRecoveryEvidenceReadbackReservationInput,
  ): RecoveryEvidenceReadbackReservationAcquireResult {
    const parsed = AcquireReservationInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        const requestIntent = {
          taskId: task.id,
          ...parsed.requestIntent,
        };
        const requestIntentDigest =
          computeRecoveryEvidenceReadbackRequestIntentDigest(
            requestIntent,
          );
        const logicalIdentity = {
          taskId: task.id,
          reviewId: parsed.requestIntent.reviewId,
          evidenceSubmissionId:
            parsed.requestIntent.evidenceSubmissionId,
          originalToolRunId:
            parsed.requestIntent.originalToolRunId,
        };
        const existing = this.reservations.getByLogicalIdentity(
          logicalIdentity,
        );
        const nowIso = this.now().toISOString();
        if (existing !== undefined) {
          assertReservationIntentMatches(
            existing,
            requestIntentDigest,
          );
          if (existing.status === "completed") {
            this.reservations.assertCompletedInvariant(existing.id);
            const request = this.requests.get(existing.requestId);
            return {
              state: "completed",
              reservation: reservationView(existing),
              request,
              ownerToken: null,
            };
          }
          if (existing.status === "preparing") {
            if (
              existing.ownerFencingToken ===
              parsed.ownership.fencingToken
            ) {
              if (
                parsed.ownerToken === existing.ownerToken
              ) {
                return {
                  state: "reentered",
                  reservation: reservationView(existing),
                  ownerToken: existing.ownerToken,
                };
              }
              return {
                state: "in_progress",
                reservation: reservationView(existing),
                ownerToken: null,
              };
            }
            if (
              parsed.ownership.fencingToken <=
              existing.ownerFencingToken
            ) {
              throw reservationConflict();
            }
            const takeover = this.reservations.takeover(
              {
                id: existing.id,
                expectedReservationVersion:
                  existing.reservationVersion,
                previousOwnerFencingToken:
                  existing.ownerFencingToken,
                newOwnerToken: createOwnerToken(),
                newOwnerFencingToken:
                  parsed.ownership.fencingToken,
                updatedAt: nowIso,
              },
              permit,
            );
            return {
              state: "acquired",
              reservation: reservationView(takeover),
              ownerToken: takeover.ownerToken,
            };
          }

          if (
            parsed.ownership.fencingToken <=
            existing.ownerFencingToken
          ) {
            throw reservationConflict();
          }
          const reclaimed = this.reservations.takeover(
            {
              id: existing.id,
              expectedReservationVersion:
                existing.reservationVersion,
              previousOwnerFencingToken:
                existing.ownerFencingToken,
              newOwnerToken: createOwnerToken(),
              newOwnerFencingToken:
                parsed.ownership.fencingToken,
              updatedAt: nowIso,
            },
            permit,
          );
          return {
            state: "acquired",
            reservation: reservationView(reclaimed),
            ownerToken: reclaimed.ownerToken,
          };
        }

        const historicalRequest =
          this.requests.getByLogicalIdentity(logicalIdentity);
        if (historicalRequest !== undefined) {
          this.assertHistoricalRequestIntentMatches(
            historicalRequest,
            requestIntent,
          );
          return {
            state: "historical_request",
            reservation: null,
            request: historicalRequest,
            ownerToken: null,
          };
        }

        if (task.version !== parsed.expectedTaskVersion) {
          throw taskVersionConflict();
        }
        const reservation = this.reservations.insert(
          {
            id: randomUUID(),
            ...logicalIdentity,
            requestId: parsed.requestId,
            operationId: parsed.operationId,
            executionPlanId: parsed.executionPlanId,
            planStepId: parsed.planStepId,
            readToolRunId: parsed.readToolRunId,
            readAttemptId: parsed.readAttemptId,
            verificationCheckId:
              parsed.requestIntent.verificationCheckId,
            requestIntentDigest,
            ownerToken: createOwnerToken(),
            ownerFencingToken: parsed.ownership.fencingToken,
            createdAt: nowIso,
          },
          permit,
        );
        return {
          state: "acquired",
          reservation: reservationView(reservation),
          ownerToken: reservation.ownerToken,
        };
      },
      "immediate",
    );
  }

  abandonOwned(
    input: AbandonRecoveryEvidenceReadbackReservationInput,
  ): RecoveryEvidenceReadbackReservationView {
    const parsed = ReservationOwnerInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        const reservation = this.assertOwnedPreparingReservation(
          parsed,
          task,
        );
        return reservationView(this.reservations.abandon(
          {
            id: reservation.id,
            expectedReservationVersion:
              reservation.reservationVersion,
            ownerToken: reservation.ownerToken,
            ownerFencingToken: reservation.ownerFencingToken,
            updatedAt: this.now().toISOString(),
          },
          permit,
        ));
      },
      "immediate",
    );
  }

  completeOwned(
    input: CompleteRecoveryEvidenceReadbackReservationInput,
    completeTransactionA: RecoveryEvidenceReadbackTransactionACompletion,
  ): RecoveryEvidenceReadbackReservationView {
    const parsed = ReservationOwnerInputSchema.parse(input);
    assertSynchronousFunction(completeTransactionA);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.assertOwnedTask(parsed.ownership);
        const reservation = this.assertOwnedPreparingReservation(
          parsed,
          task,
        );
        assertNoRecoveryIntent(task);
        const now = this.now().toISOString();
        const completion = completeTransactionA({
          task,
          reservation,
          permit,
          now,
        });
        assertSynchronousResult(completion);
        this.assertTransactionAIntentMatches(reservation);
        return reservationView(this.reservations.complete(
          {
            id: reservation.id,
            expectedReservationVersion:
              reservation.reservationVersion,
            ownerToken: reservation.ownerToken,
            ownerFencingToken: reservation.ownerFencingToken,
            updatedAt: now,
          },
          permit,
        ));
      },
      "immediate",
    );
  }

  private assertOwnedTask(ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  }): TaskRecord {
    this.leaseManager.assertOwned(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
    this.assertAuthority();
    const task = this.tasks.get(ownership.taskId);
    if (task.status !== "waiting_review") {
      throw new AppError({
        code: "RECOVERY_EVIDENCE_READBACK_RESERVATION_TASK_INVALID",
        message:
          "Recovery readback reservations require a waiting_review task.",
        statusCode: 409,
        details: [],
      });
    }
    return task;
  }

  private assertOwnedPreparingReservation(
    input: z.output<typeof ReservationOwnerInputSchema>,
    task: TaskRecord,
  ): RecoveryEvidenceReadbackReservationRecord {
    const reservation = this.reservations.getById(
      input.reservationId,
    );
    if (
      reservation.taskId !== task.id ||
      reservation.status !== "preparing" ||
      reservation.ownerToken !== input.ownerToken ||
      reservation.ownerFencingToken !==
        input.ownership.fencingToken ||
      reservation.reservationVersion !==
        input.expectedReservationVersion
    ) {
      throw reservationConflict();
    }
    const requestIntentDigest =
      computeRecoveryEvidenceReadbackRequestIntentDigest({
        taskId: task.id,
        ...input.requestIntent,
      });
    assertReservationIntentMatches(
      reservation,
      requestIntentDigest,
    );
    return reservation;
  }

  private assertHistoricalRequestIntentMatches(
    request: RecoveryEvidenceReadbackRequestRecord,
    intent: z.output<typeof RecoveryEvidenceReadbackRequestIntentInputSchema>,
  ): void {
    const operation = this.operations.get(request.operationId);
    if (
      request.reviewId !== intent.reviewId ||
      request.evidenceSubmissionId !== intent.evidenceSubmissionId ||
      request.originalToolRunId !== intent.originalToolRunId ||
      request.verificationCheckId !== intent.verificationCheckId ||
      request.allowlistId !== intent.allowlistId ||
      request.expectedResourceVersion !==
        intent.expectedResourceVersion ||
      request.expectedEtag !== intent.expectedEtag ||
      operation.taskId !== request.taskId ||
      operation.reviewId !== request.reviewId ||
      operation.expectedDecisionVersion !==
        intent.expectedDecisionVersion
    ) {
      throw requestIntentConflict();
    }
  }

  private assertTransactionAIntentMatches(
    reservation: RecoveryEvidenceReadbackReservationRecord,
  ): void {
    const request = this.requests.getByLogicalIdentity({
      taskId: reservation.taskId,
      reviewId: reservation.reviewId,
      evidenceSubmissionId: reservation.evidenceSubmissionId,
      originalToolRunId: reservation.originalToolRunId,
    });
    if (
      request === undefined ||
      request.id !== reservation.requestId
    ) {
      throw completionInconsistent();
    }
    let operation;
    try {
      operation = this.operations.get(request.operationId);
    } catch {
      throw completionInconsistent();
    }
    const requestIntent = {
      taskId: reservation.taskId,
      reviewId: request.reviewId,
      evidenceSubmissionId: request.evidenceSubmissionId,
      originalToolRunId: request.originalToolRunId,
      allowlistId: request.allowlistId,
      verificationCheckId: request.verificationCheckId,
      expectedDecisionVersion: operation.expectedDecisionVersion,
      expectedResourceVersion: request.expectedResourceVersion,
      expectedEtag: request.expectedEtag,
    };
    assertReservationIntentMatches(
      reservation,
      computeRecoveryEvidenceReadbackRequestIntentDigest(
        requestIntent,
      ),
    );
  }
}

function assertNoRecoveryIntent(task: TaskRecord): void {
  if (
    task.cancelRequestedAt !== null ||
    task.pauseRequestedAt !== null
  ) {
    throw new AppError({
      code: "RECOVERY_EVIDENCE_INTENT_BLOCKED",
      message:
        "Cancel or pause intent blocks recovery readback preparation.",
      statusCode: 409,
      details: [],
    });
  }
}

function assertReservationIntentMatches(
  reservation: RecoveryEvidenceReadbackReservationRecord,
  requestIntentDigest: string,
): void {
  if (reservation.requestIntentDigest !== requestIntentDigest) {
    throw requestIntentConflict();
  }
}

function createOwnerToken(): string {
  return randomBytes(32).toString("hex");
}

function reservationView(
  reservation: RecoveryEvidenceReadbackReservationRecord,
): RecoveryEvidenceReadbackReservationView {
  const { ownerToken: _ownerToken, ...view } = reservation;
  return Object.freeze(view);
}

function reservationConflict(): AppError {
  return new AppError({
    code: "RECOVERY_EVIDENCE_READBACK_RESERVATION_CONFLICT",
    message: "Recovery evidence readback reservation changed.",
    statusCode: 409,
    details: [],
  });
}

function taskVersionConflict(): AppError {
  return new AppError({
    code: "TASK_STATE_CONFLICT",
    message: "Task changed before the reservation was created.",
    statusCode: 409,
    details: [],
  });
}

function completionInconsistent(): AppError {
  return new AppError({
    code:
      "RECOVERY_EVIDENCE_READBACK_RESERVATION_COMPLETION_INCONSISTENT",
    message:
      "Recovery evidence readback Reservation does not match Transaction A.",
    statusCode: 409,
    details: [],
  });
}

function requestIntentConflict(): AppError {
  return new AppError({
    code:
      "RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT",
    message:
      "Recovery evidence readback Request Intent does not match.",
    statusCode: 409,
    details: [],
  });
}
