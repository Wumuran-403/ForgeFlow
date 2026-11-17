import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import {
  assertRecoveryEvidenceRecoveryPreflightCapability,
  assertRecoveryEvidenceRecoveryPreflightResult,
  type RecoveryEvidenceRecoveryPreflightResult,
} from "../recovery/recovery-evidence-recovery-preflight.js";
import { AppError } from "../shared/errors.js";
import { computeCanonicalInputHash } from "../tools/fingerprint.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryEvidenceFencingTakeoverGuard } from "./recovery-evidence-fencing-takeover-guard.js";
import { RecoveryEvidenceReadAttemptRepository } from "./recovery-evidence-read-attempt-repository.js";
import {
  RecoveryEvidenceInterruptLineageV1Schema,
  RecoveryEvidencePrepareLineageV1Schema,
  validateRecoveryEvidenceLineagePair,
  type RecoveryEvidenceInterruptLineageV1,
  type RecoveryEvidencePrepareLineageV1,
} from "./recovery-evidence-recovery-lineage.js";
import { RecoveryEvidenceReadbackRequestRepository } from "./recovery-evidence-readback-request-repository.js";
import { RecoveryEvidenceReadbackReservationRepository } from "./recovery-evidence-readback-reservation-repository.js";
import { RecoveryEvidenceStateTransitionUnitOfWork } from "./recovery-evidence-state-transition-unit-of-work.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { TaskRepository } from "./task-repository.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import {
  type EventRecord,
  type RecoveryEvidenceReadAttemptRecord,
  type RecoveryEvidenceReadbackRequestRecord,
  type TaskRecord,
} from "./types.js";
import { runInTransaction } from "./transaction.js";
import { createStorageWritePermit } from "./write-boundary.js";

const OwnershipSchema = z
  .object({
    taskId: z.string().trim().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const FullRecoveryInputSchema = z
  .object({
    ownership: OwnershipSchema,
    currentLeaseClaimEventId: z.uuid(),
    expectedTaskVersion: z.number().int().positive(),
    requestId: z.string().trim().min(1),
    priorAttemptId: z.string().trim().min(1),
    expectedPriorAttemptVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    recoveryOperationId: z.uuid(),
    newAttemptId: z.uuid().optional(),
    pauseClearEventId: z.uuid().optional(),
    preflightResult: z.unknown().optional(),
  })
  .strict();

export type RecoverOwnedRecoveryEvidenceReadAttemptInput = z.input<
  typeof FullRecoveryInputSchema
>;

export type RecoveryEvidenceFullRecoveryStatus =
  | "prepared"
  | "cancel_required"
  | "pause_blocked"
  | "manual_review"
  | "preflight_required"
  | "retry_assessment_unavailable";

export interface RecoveryEvidenceFullRecoveryResult {
  readonly status: RecoveryEvidenceFullRecoveryStatus;
  readonly replayed: boolean;
  readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
  readonly newAttempt: RecoveryEvidenceReadAttemptRecord | null;
  readonly interruptionEventId: string | null;
  readonly preparedEventId: string | null;
  readonly pauseClearEventId: string | null;
  readonly retryAssessment: "passed" | "failed" | "not_evaluated";
  readonly preflightReasonCode: string | null;
}

export class RecoveryEvidenceFullRecoveryUnitOfWork {
  private readonly tasks: TaskRepository;
  private readonly requests: RecoveryEvidenceReadbackRequestRepository;
  private readonly reservations: RecoveryEvidenceReadbackReservationRepository;
  private readonly attempts: RecoveryEvidenceReadAttemptRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly plans: ExecutionPlanRepository;
  private readonly events: EventRepository;
  private readonly takeoverGuard: RecoveryEvidenceFencingTakeoverGuard;
  private readonly stateTransitions: RecoveryEvidenceStateTransitionUnitOfWork;

  constructor(
    private readonly database: Database.Database,
    private readonly assertAuthority: () => void,
    private readonly leaseManager: TaskLeaseManager,
    now: () => Date = () => new Date(),
  ) {
    const sequences = new SequenceAllocator(database);
    this.tasks = new TaskRepository(database);
    this.requests = new RecoveryEvidenceReadbackRequestRepository(database);
    this.reservations =
      new RecoveryEvidenceReadbackReservationRepository(database);
    this.attempts = new RecoveryEvidenceReadAttemptRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    this.planSteps = new PlanStepRepository(database);
    this.plans = new ExecutionPlanRepository(database);
    this.events = new EventRepository(database, sequences);
    this.takeoverGuard = new RecoveryEvidenceFencingTakeoverGuard(
      database,
      leaseManager,
    );
    this.stateTransitions =
      new RecoveryEvidenceStateTransitionUnitOfWork(
        database,
        assertAuthority,
        leaseManager,
        now,
      );
  }

  recoverOwnedRecoveryEvidenceReadAttempt(
    input: RecoverOwnedRecoveryEvidenceReadAttemptInput,
  ): RecoveryEvidenceFullRecoveryResult {
    const parsed = FullRecoveryInputSchema.parse(input);
    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        this.leaseManager.assertOwned(
          parsed.ownership.taskId,
          parsed.ownership.leaseToken,
          parsed.ownership.fencingToken,
        );
        this.assertAuthority();
        const task = this.tasks.get(parsed.ownership.taskId);
        if (task.status !== "waiting_review") {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_TASK_INVALID",
            "Full recovery requires a waiting_review task.",
          );
        }
        this.takeoverGuard.assertLeaseClaimEvent({
          ownership: parsed.ownership,
          leaseClaimEventId: parsed.currentLeaseClaimEventId,
        });
        const events = this.events.listByTask(task.id);
        const preparedReplay = this.findPreparedReplay(
          events,
          parsed.recoveryOperationId,
        );
        if (preparedReplay !== undefined) {
          if (
            preparedReplay.prepare.taskId !== task.id ||
            preparedReplay.prepare.readbackRequestId !==
              parsed.requestId ||
            preparedReplay.prepare.priorAttemptId !==
              parsed.priorAttemptId ||
            (parsed.newAttemptId !== undefined &&
              parsed.newAttemptId !==
                preparedReplay.prepare.newAttemptId)
          ) {
            throw fullRecoveryError(
              "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
              "Prepared Lineage identity conflicts with the current Replay request.",
            );
          }
          const request = this.requests.get(parsed.requestId);
          const priorAttempt = this.attempts.get(
            parsed.priorAttemptId,
          );
          const run = this.toolRuns.get(request.readToolRunId);
          const step = this.planSteps.get(request.planStepId);
          const plan = this.plans.get(request.executionPlanId);
          const reservation =
            this.reservations.getByRequestId(request.id);
          if (reservation === undefined) {
            throw fullRecoveryError(
              "RECOVERY_EVIDENCE_FULL_RECOVERY_BINDING_INVALID",
              "Full Recovery replay requires a completed Reservation.",
            );
          }
          return this.replayPreparedRecovery({
            parsed,
            task,
            request,
            priorAttempt,
            run,
            step,
            plan,
            reservation,
            events,
            preparedEvent: preparedReplay.event,
            prepare: preparedReplay.prepare,
          });
        }

        const request = this.requests.get(parsed.requestId);
        const priorAttempt = this.attempts.get(parsed.priorAttemptId);
        const run = this.toolRuns.get(request.readToolRunId);
        const step = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        const reservation = this.reservations.getByRequestId(request.id);
        this.assertPersistedBindings({
          task,
          request,
          priorAttempt,
          run,
          step,
          plan,
          reservation,
        });
        if (reservation === undefined) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_BINDING_INVALID",
            "Full recovery requires a completed Reservation.",
          );
        }
        if (
          task.version !== parsed.expectedTaskVersion ||
          priorAttempt.version !==
            parsed.expectedPriorAttemptVersion ||
          run.version !== parsed.expectedToolRunVersion ||
          step.version !== parsed.expectedPlanStepVersion ||
          plan.version !== parsed.expectedPlanVersion
        ) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_VERSION_CONFLICT",
            "Recovery state changed before preparation.",
          );
        }

        if (task.cancelRequestedAt !== null) {
          return noRecoveryResult(
            "cancel_required",
            priorAttempt,
            "not_evaluated",
            null,
          );
        }
        if (task.pauseRequestedAt !== null) {
          return noRecoveryResult(
            "pause_blocked",
            priorAttempt,
            "not_evaluated",
            null,
          );
        }

        let interruptEvent = this.findInterruptEvent(
          events,
          parsed.recoveryOperationId,
        );
        const interruptExisted = interruptEvent !== undefined;
        let interrupt: RecoveryEvidenceInterruptLineageV1 | undefined;
        let workingAttempt = priorAttempt;
        let workingRun = run;
        let workingStep = step;
        if (interruptEvent !== undefined) {
          interrupt = RecoveryEvidenceInterruptLineageV1Schema.parse(
            interruptEvent.payload,
          );
          this.assertInterruptIdentity({
            task,
            request,
            priorAttempt,
            interruptEvent,
            interrupt,
          });
          if (
            interrupt.controlIntentKind === "cancel" ||
            interrupt.resumeEligible !== true ||
            interrupt.retryAssessment !== "passed"
          ) {
            return noRecoveryResult(
              "manual_review",
              priorAttempt,
              interrupt.retryAssessment,
              interrupt.reasonCode,
            );
          }
          if (
            priorAttempt.status !== "interrupted" ||
            workingRun.status !== "interrupted" ||
            workingStep.status !== "interrupted" ||
            plan.status !== "active"
          ) {
            throw fullRecoveryError(
              "RECOVERY_EVIDENCE_FULL_RECOVERY_STATE_INVALID",
              "Interrupted recovery state is not resumable.",
            );
          }
        }

        const preflight = this.resolvePreflight(
          parsed.preflightResult,
          task,
          request,
          run,
          reservation,
        );
        if (preflight.state === undefined) {
          return noRecoveryResult(
            "preflight_required",
            priorAttempt,
            "not_evaluated",
            null,
          );
        }
        if (preflight.state !== "passed") {
          return noRecoveryResult(
            preflight.state === "not_evaluated"
              ? "retry_assessment_unavailable"
              : "manual_review",
            priorAttempt,
            preflight.state,
            preflight.reasonCode,
          );
        }

        if (interruptEvent === undefined) {
          if (priorAttempt.status !== "dispatching") {
            throw fullRecoveryError(
              "RECOVERY_EVIDENCE_FULL_RECOVERY_STATE_INVALID",
              "Full recovery requires a dispatching or interrupted Attempt.",
            );
          }
          const dispatchEvent = events.find(
            (event) => event.id === priorAttempt.lastEventId,
          );
          const dispatchFencingToken = this.assertDispatchEvent(
            dispatchEvent,
            priorAttempt,
          );
          const currentClaim =
            this.takeoverGuard.assertLeaseClaimEvent({
              ownership: parsed.ownership,
              leaseClaimEventId:
                parsed.currentLeaseClaimEventId,
            });
          if (
            dispatchEvent === undefined ||
            currentClaim.event.sequence <= dispatchEvent.sequence
          ) {
            throw fullRecoveryError(
              "RECOVERY_EVIDENCE_LEASE_CLAIM_SEQUENCE_INVALID",
              "Lease Claim Event must follow the Dispatch Event.",
            );
          }
          const fullInterrupt = this.buildFullInterruptLineage({
            recoveryOperationId: parsed.recoveryOperationId,
            task,
            request,
            attempt: priorAttempt,
            reservation,
            dispatchEvent: dispatchEvent!,
            dispatchFencingToken,
            leaseClaimEventId:
              parsed.currentLeaseClaimEventId,
            fencingToken: parsed.ownership.fencingToken,
          });
          workingAttempt = this.stateTransitions
            .transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
              {
                ownership: parsed.ownership,
                expectedTaskVersion: parsed.expectedTaskVersion,
                attemptId: priorAttempt.id,
                expectedAttemptVersion:
                  parsed.expectedPriorAttemptVersion,
                status: "interrupted",
                reasonCode: fullInterrupt.reasonCode,
                recoveryLineage: fullInterrupt,
              },
              permit,
            );
          workingRun = this.toolRuns.get(request.readToolRunId);
          workingStep = this.planSteps.get(request.planStepId);
          interruptEvent = this.events
            .listByTask(task.id)
            .find(
              (event) => event.id === workingAttempt.lastEventId,
            );
          if (interruptEvent === undefined) {
            throw fullRecoveryError(
              "RECOVERY_EVIDENCE_FULL_RECOVERY_INTERRUPT_MISSING",
              "Interrupted Event was not persisted.",
            );
          }
          interrupt = fullInterrupt;
        } else {
          this.assertTaskVersion(task, parsed.expectedTaskVersion);
        }
        if (interrupt === undefined || interruptEvent === undefined) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_INTERRUPT_MISSING",
            "Valid Interrupted Lineage is required.",
          );
        }
        this.assertInterruptRequestBindings({
          task,
          request,
          priorAttempt,
          reservation,
          interrupt,
        });
        const currentClaim =
          this.takeoverGuard.assertLeaseClaimEvent({
            ownership: parsed.ownership,
            leaseClaimEventId:
              parsed.currentLeaseClaimEventId,
          });
        const pauseContinuation = this.resolvePauseContinuation({
          task,
          interrupt,
          interruptEvent,
          pauseClearEventId: parsed.pauseClearEventId,
          events,
        });

        const activeAttempts = this.attempts
          .listByTask(task.id)
          .filter(
            (attempt) =>
              attempt.readbackRequestId === request.id &&
              attempt.readToolRunId === request.readToolRunId &&
              ["prepared", "dispatching"].includes(attempt.status),
          );
        if (activeAttempts.length !== 0) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_READ_ATTEMPT_ACTIVE",
            "Full recovery cannot create another active Attempt.",
          );
        }
        const nextAttemptNumber = this.attempts.nextAttemptNumber(
          task.id,
          request.id,
          request.readToolRunId,
        );
        if (
          nextAttemptNumber !== workingAttempt.attemptNumber + 1
        ) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_ATTEMPT_NUMBER_INVALID",
            "Recovered Attempt number must follow the interrupted Attempt.",
          );
        }
        const newAttemptId =
          parsed.newAttemptId ?? randomUUID();
        if (
          newAttemptId === priorAttempt.id ||
          this.attempts
            .listByTask(task.id)
            .some((attempt) => attempt.id === newAttemptId) ||
          this.events
            .listByTask(task.id)
            .some(
              (event) =>
                event.type ===
                  "recovery.evidence.read_attempt_prepared" &&
                event.entityId === newAttemptId,
            )
        ) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_NEW_ATTEMPT_CONFLICT",
            "New Attempt identity is already used.",
          );
        }

        const leaseClaimEvent = currentClaim;
        if (
          interrupt.controlIntentKind === "pause" &&
          pauseContinuation !== undefined &&
          leaseClaimEvent.event.sequence <=
            pauseContinuation.clearEvent.sequence
        ) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_RESUME_CLAIM_INVALID",
            "Resume Owner Claim Event must follow Pause Clear.",
          );
        }
        if (
          pauseContinuation === undefined &&
          interruptExisted &&
          interruptEvent.sequence > leaseClaimEvent.event.sequence
        ) {
          throw fullRecoveryError(
            "RECOVERY_EVIDENCE_FULL_RECOVERY_CLAIM_INVALID",
            "Recovery Owner Claim Event does not follow history.",
          );
        }

        const prepare =
          this.buildPreparedLineage({
            interrupt,
            interruptEvent,
            priorAttempt: workingAttempt,
            newAttemptId,
            newAttemptNumber: nextAttemptNumber,
            leaseClaimEventId:
              parsed.currentLeaseClaimEventId,
            fencingToken: parsed.ownership.fencingToken,
            pauseClearEventId:
              pauseContinuation?.clearEvent.id,
          });
        validateRecoveryEvidenceLineagePair({
          interrupt,
          prepare,
          interruptionEventId: interruptEvent.id,
        });

        const currentTask = this.tasks.get(task.id);
        const newAttempt =
          this.stateTransitions
            .prepareRecoveredReadAttemptInCurrentTransaction(
              {
                ownership: parsed.ownership,
                currentLeaseClaimEventId:
                  parsed.currentLeaseClaimEventId,
                expectedTaskVersion: currentTask.version,
                priorAttemptId: workingAttempt.id,
                expectedPriorAttemptVersion:
                  workingAttempt.version,
                expectedToolRunVersion: workingRun.version,
                expectedPlanStepVersion: workingStep.version,
                expectedPlanVersion: plan.version,
                newAttemptId,
                newAttemptNumber: nextAttemptNumber,
                preparedLineage: prepare,
              },
              permit,
            );
        const preparedEventId = newAttempt.lastEventId;
        return {
          status: "prepared",
          replayed: false,
          priorAttempt: workingAttempt,
          newAttempt,
          interruptionEventId: interruptEvent.id,
          preparedEventId,
          pauseClearEventId:
            pauseContinuation?.clearEvent.id ?? null,
          retryAssessment: "passed",
          preflightReasonCode: null,
        } as const;
      },
      "immediate",
    );
  }

  private replayPreparedRecovery(input: {
    readonly parsed: z.output<typeof FullRecoveryInputSchema>;
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly run: ReturnType<ToolRunRepository["get"]>;
    readonly step: ReturnType<PlanStepRepository["get"]>;
    readonly plan: ReturnType<ExecutionPlanRepository["get"]>;
    readonly reservation: NonNullable<
      ReturnType<
        RecoveryEvidenceReadbackReservationRepository["getByRequestId"]
      >
    >;
    readonly events: readonly EventRecord[];
    readonly preparedEvent: EventRecord;
    readonly prepare: RecoveryEvidencePrepareLineageV1;
  }): RecoveryEvidenceFullRecoveryResult {
    const interruptEvent = input.events.find(
      (event) => event.id === input.prepare.interruptionEventId,
    );
    if (
      interruptEvent === undefined ||
      interruptEvent.type !==
        "recovery.evidence.read_attempt_interrupted"
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Prepared Lineage references an invalid Interrupted Event.",
      );
    }
    const interrupt = RecoveryEvidenceInterruptLineageV1Schema.parse(
      interruptEvent.payload,
    );
    const pair = validateRecoveryEvidenceLineagePair({
      interrupt,
      prepare: input.prepare,
      interruptionEventId: interruptEvent.id,
    });
    this.assertReplayIdentity({
      task: input.task,
      request: input.request,
      priorAttempt: input.priorAttempt,
      interrupt,
      prepare: pair.prepare!,
    });
    if (
      input.priorAttempt.status !== "interrupted" ||
      input.priorAttempt.lastEventId !== interruptEvent.id
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Prior Attempt no longer matches the historical interruption.",
      );
    }
    this.assertInterruptRequestBindings({
      task: input.task,
      request: input.request,
      priorAttempt: input.priorAttempt,
      reservation: input.reservation,
      interrupt,
    });
    if (
      input.parsed.newAttemptId !== undefined &&
      input.parsed.newAttemptId !== pair.prepare!.newAttemptId
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Prepared Lineage is bound to a different New Attempt.",
      );
    }
    const newAttempt = this.attempts.get(pair.prepare!.newAttemptId);
    if (
      input.preparedEvent.entityType !==
        "recovery_evidence_read_attempt" ||
      input.preparedEvent.entityId !==
        pair.prepare!.newAttemptId ||
      input.preparedEvent.payload.readAttemptId !==
        pair.prepare!.newAttemptId ||
      input.preparedEvent.payload.attemptStatus !== "prepared" ||
      newAttempt.taskId !== input.task.id ||
      newAttempt.readbackRequestId !== input.request.id ||
      newAttempt.readToolRunId !== input.request.readToolRunId ||
      newAttempt.attemptNumber !==
        pair.prepare!.newAttemptNumber ||
      newAttempt.lastEventId !== input.preparedEvent.id &&
      !["dispatching", "completed", "failed", "timed_out", "interrupted", "cancelled", "blocked_by_intent"].includes(
        newAttempt.status,
      )
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "New Attempt does not match Prepared Lineage.",
      );
    }
    this.assertHistoricalClaimBindings({
      taskId: input.task.id,
      interrupt,
      interruptEvent,
      prepare: pair.prepare!,
      preparedEvent: input.preparedEvent,
      events: input.events,
    });
    this.assertHistoricalPauseClear({
      taskId: input.task.id,
      interrupt,
      interruptEvent,
      prepare: pair.prepare!,
      preparedEvent: input.preparedEvent,
      events: input.events,
    });
    this.assertPreparedReplayDownstream({
      event: input.preparedEvent,
      attempt: newAttempt,
      run: this.toolRuns.get(input.request.readToolRunId),
      step: this.planSteps.get(input.request.planStepId),
      plan: this.plans.get(input.request.executionPlanId),
    });
    return {
      status: "prepared",
      replayed: true,
      priorAttempt: input.priorAttempt,
      newAttempt,
      interruptionEventId: interruptEvent.id,
      preparedEventId: input.preparedEvent.id,
      pauseClearEventId: pair.prepare!.pauseClearEventId ?? null,
      retryAssessment: interrupt.retryAssessment,
      preflightReasonCode: null,
    };
  }

  private assertPersistedBindings(input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly run: ReturnType<ToolRunRepository["get"]>;
    readonly step: ReturnType<PlanStepRepository["get"]>;
    readonly plan: ReturnType<ExecutionPlanRepository["get"]>;
    readonly reservation: ReturnType<
      RecoveryEvidenceReadbackReservationRepository["getByRequestId"]
    >;
  }): void {
    if (
      input.request.taskId !== input.task.id ||
      input.priorAttempt.taskId !== input.task.id ||
      input.priorAttempt.readbackRequestId !== input.request.id ||
      input.priorAttempt.readToolRunId !==
        input.request.readToolRunId ||
      input.priorAttempt.retrySafety !== input.request.retrySafety ||
      input.priorAttempt.consistencyMode !==
        input.request.consistencyMode ||
      input.run.taskId !== input.task.id ||
      input.run.id !== input.request.readToolRunId ||
      input.run.planStepId !== input.step.id ||
      input.run.mode !== "read" ||
      input.run.toolName !== input.request.readToolName ||
      input.run.toolVersion !== input.request.readToolVersion ||
      input.run.inputSchemaHash !==
        input.request.readToolSchemaHash ||
      input.step.taskId !== input.task.id ||
      input.step.planId !== input.plan.id ||
      input.plan.taskId !== input.task.id ||
      input.plan.purpose !== "recovery_evidence" ||
      input.step.kind !== "read_batch" ||
      input.reservation === undefined ||
      input.reservation.status !== "completed" ||
      input.reservation.taskId !== input.task.id ||
      input.reservation.requestId !== input.request.id ||
      input.reservation.readToolRunId !== input.request.readToolRunId ||
      input.reservation.readAttemptId !== input.priorAttempt.id ||
      input.reservation.executionPlanId !==
        input.request.executionPlanId ||
      input.reservation.planStepId !== input.request.planStepId ||
      input.reservation.verificationCheckId !==
        input.request.verificationCheckId
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_BINDING_INVALID",
        "Recovery persisted bindings are invalid.",
      );
    }
  }

  private resolvePreflight(
    result: unknown,
    task: TaskRecord,
    request: RecoveryEvidenceReadbackRequestRecord,
    readRun: ReturnType<ToolRunRepository["get"]>,
    reservation: NonNullable<
      ReturnType<
        RecoveryEvidenceReadbackReservationRepository["getByRequestId"]
      >
    >,
  ):
    | RecoveryEvidenceRecoveryPreflightResult
    | { readonly state: undefined; readonly reasonCode: null } {
    if (result === undefined) {
      return { state: undefined, reasonCode: null };
    }
    const parsed =
      assertRecoveryEvidenceRecoveryPreflightResult(result, {
        requestId: request.id,
      });
    if (parsed.state === "passed") {
      assertRecoveryEvidenceRecoveryPreflightCapability(
        parsed.capability,
        {
          taskId: task.id,
          requestId: request.id,
          readToolRunId: readRun.id,
          allowlistId: request.allowlistId,
          allowlistVersion: request.allowlistVersion,
          readToolName: request.readToolName,
          readToolVersion: request.readToolVersion,
          readToolSchemaHash: request.readToolSchemaHash,
          requestIntentDigest: reservation.requestIntentDigest,
          retrySafety: request.retrySafety,
          consistencyMode: request.consistencyMode,
          expectedResourceVersion: request.expectedResourceVersion,
          expectedEtag: request.expectedEtag,
          canonicalInputHash: computeCanonicalInputHash(readRun.input),
          retryAssessment: "passed",
        },
      );
    }
    return parsed;
  }

  private buildFullInterruptLineage(input: {
    readonly recoveryOperationId: string;
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly reservation: NonNullable<
      ReturnType<
        RecoveryEvidenceReadbackReservationRepository["getByRequestId"]
      >
    >;
    readonly dispatchEvent: EventRecord;
    readonly dispatchFencingToken: number;
    readonly leaseClaimEventId: string;
    readonly fencingToken: number;
  }): RecoveryEvidenceInterruptLineageV1 {
    return RecoveryEvidenceInterruptLineageV1Schema.parse({
      lineageSchemaVersion: "recovery-evidence-lineage.v1",
      recoveryOperationId: input.recoveryOperationId,
      recoveryPhase: "interrupt",
      taskId: input.task.id,
      readbackRequestId: input.request.id,
      readToolRunId: input.request.readToolRunId,
      readAttemptId: input.attempt.id,
      attemptNumber: input.attempt.attemptNumber,
      attemptStatus: "interrupted",
      priorAttemptId: input.attempt.id,
      priorAttemptNumber: input.attempt.attemptNumber,
      dispatchEventId: input.dispatchEvent.id,
      dispatchFencingToken: input.dispatchFencingToken,
      leaseClaimEventId: input.leaseClaimEventId,
      fencingToken: input.fencingToken,
      interruptionCause: "recovery_takeover",
      reasonCode: "RETRY_SAFE_TAKEOVER",
      retryAssessment: "passed",
      resumeEligible: true,
      retrySafety: input.request.retrySafety,
      consistencyMode: input.request.consistencyMode,
      allowlistId: input.request.allowlistId,
      allowlistVersion: input.request.allowlistVersion,
      readToolName: input.request.readToolName,
      readToolVersion: input.request.readToolVersion,
      readToolSchemaHash: input.request.readToolSchemaHash,
      requestIntentDigest:
        input.reservation.requestIntentDigest,
      expectedResourceVersion:
        input.request.expectedResourceVersion,
      expectedEtag: input.request.expectedEtag,
    });
  }

  private buildPreparedLineage(input: {
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
    readonly interruptEvent: EventRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly newAttemptId: string;
    readonly newAttemptNumber: number;
    readonly leaseClaimEventId: string;
    readonly fencingToken: number;
    readonly pauseClearEventId: string | undefined;
  }): RecoveryEvidencePrepareLineageV1 {
    return RecoveryEvidencePrepareLineageV1Schema.parse({
      lineageSchemaVersion: input.interrupt.lineageSchemaVersion,
      recoveryOperationId: input.interrupt.recoveryOperationId,
      recoveryPhase: "prepare",
      taskId: input.interrupt.taskId,
      readbackRequestId: input.interrupt.readbackRequestId,
      readToolRunId: input.interrupt.readToolRunId,
      readAttemptId: input.newAttemptId,
      attemptNumber: input.newAttemptNumber,
      attemptStatus: "prepared",
      priorAttemptId: input.priorAttempt.id,
      priorAttemptNumber: input.priorAttempt.attemptNumber,
      interruptionEventId: input.interruptEvent.id,
      newAttemptId: input.newAttemptId,
      newAttemptNumber: input.newAttemptNumber,
      leaseClaimEventId: input.leaseClaimEventId,
      fencingToken: input.fencingToken,
      retrySafety: input.interrupt.retrySafety,
      consistencyMode: input.interrupt.consistencyMode,
      allowlistId: input.interrupt.allowlistId,
      allowlistVersion: input.interrupt.allowlistVersion,
      readToolName: input.interrupt.readToolName,
      readToolVersion: input.interrupt.readToolVersion,
      readToolSchemaHash: input.interrupt.readToolSchemaHash,
      requestIntentDigest: input.interrupt.requestIntentDigest,
      expectedResourceVersion:
        input.interrupt.expectedResourceVersion,
      expectedEtag: input.interrupt.expectedEtag,
      ...(input.pauseClearEventId === undefined
        ? {}
        : { pauseClearEventId: input.pauseClearEventId }),
    });
  }

  private findPreparedReplay(
    events: readonly EventRecord[],
    recoveryOperationId: string,
  ):
    | {
        readonly event: EventRecord;
        readonly prepare: RecoveryEvidencePrepareLineageV1;
      }
    | undefined {
    const matching = events.filter(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_prepared" &&
        event.entityType === "recovery_evidence_read_attempt" &&
        event.payload.recoveryOperationId === recoveryOperationId &&
        event.payload.recoveryPhase === "prepare" &&
        event.payload.readAttemptId === event.entityId &&
        event.payload.newAttemptId === event.entityId &&
        event.payload.attemptStatus === "prepared",
    );
    if (matching.length === 0) {
      return undefined;
    }
    if (matching.length !== 1) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT",
        "Recovery Operation ID has multiple Prepared Events.",
      );
    }
    return {
      event: matching[0]!,
      prepare: RecoveryEvidencePrepareLineageV1Schema.parse(
        matching[0]!.payload,
      ),
    };
  }

  private findInterruptEvent(
    events: readonly EventRecord[],
    recoveryOperationId: string,
  ): EventRecord | undefined {
    const matching = events.filter(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_interrupted" &&
        event.entityType === "recovery_evidence_read_attempt" &&
        event.payload.recoveryOperationId === recoveryOperationId &&
        event.payload.recoveryPhase === "interrupt" &&
        event.payload.readAttemptId === event.entityId &&
        event.payload.attemptStatus === "interrupted",
    );
    if (matching.length > 1) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT",
        "Recovery Operation ID has multiple Interrupted Events.",
      );
    }
    return matching[0];
  }

  private assertInterruptIdentity(input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly interruptEvent: EventRecord;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
  }): void {
    if (
      input.interrupt.taskId !== input.task.id ||
      input.interrupt.readbackRequestId !== input.request.id ||
      input.interrupt.readToolRunId !== input.request.readToolRunId ||
      input.interrupt.priorAttemptId !== input.priorAttempt.id ||
      input.interrupt.priorAttemptNumber !==
        input.priorAttempt.attemptNumber ||
      input.interruptEvent.entityId !== input.priorAttempt.id ||
      input.interruptEvent.entityType !==
        "recovery_evidence_read_attempt" ||
      input.interruptEvent.taskId !== input.task.id
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Interrupted Lineage identity is inconsistent.",
      );
    }
  }

  private assertInterruptRequestBindings(input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly reservation: NonNullable<
      ReturnType<
        RecoveryEvidenceReadbackReservationRepository["getByRequestId"]
      >
    >;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
  }): void {
    if (
      input.interrupt.taskId !== input.task.id ||
      input.interrupt.readbackRequestId !== input.request.id ||
      input.interrupt.readToolRunId !==
        input.request.readToolRunId ||
      input.interrupt.priorAttemptId !== input.priorAttempt.id ||
      input.interrupt.priorAttemptNumber !==
        input.priorAttempt.attemptNumber ||
      input.interrupt.retrySafety !== input.request.retrySafety ||
      input.interrupt.consistencyMode !==
        input.request.consistencyMode ||
      input.interrupt.allowlistId !== input.request.allowlistId ||
      input.interrupt.allowlistVersion !==
        input.request.allowlistVersion ||
      input.interrupt.readToolName !== input.request.readToolName ||
      input.interrupt.readToolVersion !==
        input.request.readToolVersion ||
      input.interrupt.readToolSchemaHash !==
        input.request.readToolSchemaHash ||
      input.interrupt.requestIntentDigest !==
        input.reservation.requestIntentDigest ||
      input.interrupt.expectedResourceVersion !==
        input.request.expectedResourceVersion ||
      input.interrupt.expectedEtag !== input.request.expectedEtag
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Interrupted Lineage does not match persisted Request identity.",
      );
    }
  }

  private assertReplayIdentity(input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly priorAttempt: RecoveryEvidenceReadAttemptRecord;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
    readonly prepare: RecoveryEvidencePrepareLineageV1;
  }): void {
    this.assertInterruptIdentity({
      task: input.task,
      request: input.request,
      priorAttempt: input.priorAttempt,
      interruptEvent: this.events
        .listByTask(input.task.id)
        .find(
          (event) =>
            event.id === input.prepare.interruptionEventId,
        )!,
      interrupt: input.interrupt,
    });
    if (
      input.prepare.taskId !== input.task.id ||
      input.prepare.readbackRequestId !== input.request.id ||
      input.prepare.readToolRunId !==
        input.request.readToolRunId ||
      input.prepare.priorAttemptId !== input.priorAttempt.id
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT",
        "Prepared Lineage identity is inconsistent.",
      );
    }
  }

  private resolvePauseContinuation(input: {
    readonly task: TaskRecord;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
    readonly interruptEvent: EventRecord;
    readonly pauseClearEventId: string | undefined;
    readonly events: readonly EventRecord[];
  }):
    | {
        readonly clearEvent: EventRecord;
      }
    | undefined {
    if (input.interrupt.controlIntentKind !== "pause") {
      if (input.pauseClearEventId !== undefined) {
        throw fullRecoveryError(
          "RECOVERY_EVIDENCE_PAUSE_CLEAR_INVALID",
          "Pause Clear is only valid for Pause interruption.",
        );
      }
      return undefined;
    }
    if (input.task.pauseRequestedAt !== null) {
      return undefined;
    }
    if (input.pauseClearEventId === undefined) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_PAUSE_CLEAR_REQUIRED",
        "Pause Resume requires a Clear Event.",
      );
    }
    const clearEvent = input.events.find(
      (event) =>
        event.id === input.pauseClearEventId &&
        event.type === "recovery.evidence.pause_cleared",
    );
    const pauseRequestEvent = input.events.find(
      (event) =>
        event.id === input.interrupt.pauseRequestEventId &&
        event.type === "recovery.evidence.pause_requested",
    );
    const latestPauseEvent = [...input.events]
      .reverse()
      .find(
        (event) =>
          event.type === "recovery.evidence.pause_requested",
      );
    if (
      clearEvent === undefined ||
      pauseRequestEvent === undefined ||
      clearEvent.taskId !== input.task.id ||
      clearEvent.entityId !== input.task.id ||
      clearEvent.payload.clearedPauseEventId !==
        pauseRequestEvent.id ||
      clearEvent.payload.clearedPauseEventSequence !==
        pauseRequestEvent.sequence ||
      clearEvent.sequence <= pauseRequestEvent.sequence ||
      clearEvent.sequence <= input.interruptEvent.sequence ||
      latestPauseEvent?.id !== pauseRequestEvent.id
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_PAUSE_CLEAR_INVALID",
        "Pause Clear Event is not bound to the interruption generation.",
      );
    }
    return { clearEvent };
  }

  private assertHistoricalClaimBindings(input: {
    readonly taskId: string;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
    readonly interruptEvent: EventRecord;
    readonly prepare: RecoveryEvidencePrepareLineageV1;
    readonly preparedEvent: EventRecord;
    readonly events: readonly EventRecord[];
  }): void {
    const dispatchEvent = input.events.find(
      (event) => event.id === input.interrupt.dispatchEventId,
    );
    const interruptClaim = input.events.find(
      (event) =>
        event.id === input.interrupt.leaseClaimEventId,
    );
    const prepareClaim = input.events.find(
      (event) =>
        event.id === input.prepare.leaseClaimEventId,
    );
    if (
      dispatchEvent?.type !==
        "recovery.evidence.read_attempt_dispatching" ||
      interruptClaim?.type !== "lease.claimed" ||
      prepareClaim?.type !== "lease.claimed" ||
      interruptClaim.entityId !== input.taskId ||
      prepareClaim.entityId !== input.taskId ||
      interruptClaim.payload.fencingToken !==
        input.interrupt.fencingToken ||
      prepareClaim.payload.fencingToken !==
        input.prepare.fencingToken ||
      dispatchEvent.sequence >= interruptClaim.sequence ||
      interruptClaim.sequence >= input.interruptEvent.sequence ||
      prepareClaim.sequence >= input.preparedEvent.sequence
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Historical Claim / Dispatch sequence is invalid.",
      );
    }
  }

  private assertHistoricalPauseClear(input: {
    readonly taskId: string;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
    readonly interruptEvent: EventRecord;
    readonly prepare: RecoveryEvidencePrepareLineageV1;
    readonly preparedEvent: EventRecord;
    readonly events: readonly EventRecord[];
  }): void {
    if (input.interrupt.controlIntentKind !== "pause") {
      if (input.prepare.pauseClearEventId !== undefined) {
        throw fullRecoveryError(
          "RECOVERY_EVIDENCE_PAUSE_CLEAR_INVALID",
          "Non-Pause Prepared Lineage cannot include Pause Clear.",
        );
      }
      return;
    }
    if (input.prepare.pauseClearEventId === undefined) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_PAUSE_CLEAR_REQUIRED",
        "Pause Prepared Lineage requires Pause Clear.",
      );
    }
    const pauseRequest = input.events.find(
      (event) =>
        event.id === input.interrupt.pauseRequestEventId &&
        event.type === "recovery.evidence.pause_requested",
    );
    const clear = input.events.find(
      (event) =>
        event.id === input.prepare.pauseClearEventId &&
        event.type === "recovery.evidence.pause_cleared",
    );
    if (
      pauseRequest === undefined ||
      clear === undefined ||
      clear.entityId !== input.taskId ||
      clear.payload.clearedPauseEventId !== pauseRequest.id ||
      clear.payload.clearedPauseEventSequence !==
        pauseRequest.sequence ||
      pauseRequest.sequence >= input.interruptEvent.sequence ||
      input.interruptEvent.sequence >= clear.sequence ||
      clear.sequence >= input.preparedEvent.sequence
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_PAUSE_CLEAR_INVALID",
        "Historical Pause Clear binding is invalid.",
      );
    }
  }

  private assertPreparedReplayDownstream(input: {
    readonly event: EventRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly run: ReturnType<ToolRunRepository["get"]>;
    readonly step: ReturnType<PlanStepRepository["get"]>;
    readonly plan: ReturnType<ExecutionPlanRepository["get"]>;
  }): void {
    if (
      input.attempt.lastEventId !== input.event.id &&
      input.attempt.status === "prepared"
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Prepared Attempt last Event is inconsistent.",
      );
    }
    const valid =
      (input.attempt.status === "prepared" &&
        input.run.status === "queued" &&
        ["queued", "running"].includes(input.step.status) &&
        input.plan.status === "active") ||
      (input.attempt.status === "dispatching" &&
        input.run.status === "running" &&
        input.step.status === "running" &&
        input.plan.status === "active") ||
      (input.attempt.status === "completed" &&
        input.run.status === "succeeded" &&
        input.step.status === "completed" &&
        ["active", "completed"].includes(input.plan.status)) ||
      (input.attempt.status === "failed" &&
        input.run.status === "failed" &&
        input.step.status === "failed" &&
        input.plan.status === "failed") ||
      (input.attempt.status === "timed_out" &&
        input.run.status === "timed_out" &&
        input.step.status === "failed" &&
        input.plan.status === "failed") ||
      (input.attempt.status === "interrupted" &&
        input.run.status === "interrupted" &&
        input.step.status === "interrupted" &&
        input.plan.status === "active") ||
      (input.attempt.status === "cancelled" &&
        input.run.status === "cancelled" &&
        input.step.status === "cancelled" &&
        input.plan.status === "cancelled") ||
      (input.attempt.status === "blocked_by_intent" &&
        input.run.status === "queued" &&
        ["queued", "running"].includes(input.step.status) &&
        input.plan.status === "active");
    if (!valid) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT",
        "Prepared Attempt downstream state is invalid.",
      );
    }
  }

  private assertDispatchEvent(
    event: EventRecord | undefined,
    attempt: RecoveryEvidenceReadAttemptRecord,
  ): number {
    const fencingToken = event?.payload.fencingToken;
    if (
      event === undefined ||
      event.type !==
        "recovery.evidence.read_attempt_dispatching" ||
      event.entityType !== "recovery_evidence_read_attempt" ||
      event.entityId !== attempt.id ||
      event.payload.readAttemptId !== attempt.id ||
      event.payload.attemptStatus !== "dispatching" ||
      typeof fencingToken !== "number" ||
      !Number.isInteger(fencingToken) ||
      fencingToken <= 0
    ) {
      throw fullRecoveryError(
        "RECOVERY_EVIDENCE_FULL_RECOVERY_DISPATCH_INVALID",
        "Dispatch Event binding is invalid.",
      );
    }
    return fencingToken;
  }

  private assertTaskVersion(task: TaskRecord, expected: number): void {
    if (task.version !== expected) {
      throw fullRecoveryError(
        "TASK_STATE_CONFLICT",
        "Task changed before Full Recovery preparation.",
      );
    }
  }
}

function noRecoveryResult(
  status:
    | "cancel_required"
    | "pause_blocked"
    | "manual_review"
    | "preflight_required"
    | "retry_assessment_unavailable",
  priorAttempt: RecoveryEvidenceReadAttemptRecord,
  retryAssessment: "passed" | "failed" | "not_evaluated",
  preflightReasonCode: string | null,
): RecoveryEvidenceFullRecoveryResult {
  return {
    status,
    replayed: false,
    priorAttempt,
    newAttempt: null,
    interruptionEventId: null,
    preparedEventId: null,
    pauseClearEventId: null,
    retryAssessment,
    preflightReasonCode,
  };
}

function fullRecoveryError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    statusCode: 409,
    details: [],
  });
}
