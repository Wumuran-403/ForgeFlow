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
  type RecoveryEvidenceInterruptLineageV1,
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

const InterruptOwnedRecoveryEvidenceReadAttemptInputSchema = z
  .object({
    ownership: OwnershipSchema,
    currentLeaseClaimEventId: z.uuid(),
    expectedTaskVersion: z.number().int().positive(),
    requestId: z.string().trim().min(1),
    priorAttemptId: z.string().trim().min(1),
    expectedAttemptVersion: z.number().int().positive(),
    recoveryOperationId: z.uuid(),
    preflightResult: z.unknown().optional(),
  })
  .strict();

export type InterruptOwnedRecoveryEvidenceReadAttemptInput = z.input<
  typeof InterruptOwnedRecoveryEvidenceReadAttemptInputSchema
>;

export type RecoveryEvidenceInterruptionStatus =
  | "interrupted_cancel_pending"
  | "interrupted_pause_pending"
  | "interrupted_retry_unsafe"
  | "full_recovery_required"
  | "retry_assessment_unavailable";

export interface RecoveryEvidenceInterruptionResult {
  readonly status: RecoveryEvidenceInterruptionStatus;
  readonly replayed: boolean;
  readonly attempt: RecoveryEvidenceReadAttemptRecord;
  readonly interruptionEventId: string | null;
  readonly retryAssessment: "passed" | "failed" | "not_evaluated";
  readonly preflightReasonCode: string | null;
  readonly recommendedNextAction:
    | "stage3_3_cancel"
    | "await_pause_clear"
    | "manual_review"
    | "stage3_4_full_recovery";
}

interface InterruptionDecision {
  readonly status: Exclude<
    RecoveryEvidenceInterruptionStatus,
    "full_recovery_required" | "retry_assessment_unavailable"
  >;
  readonly interruptionCause: string;
  readonly reasonCode: string;
  readonly retryAssessment: "passed" | "failed" | "not_evaluated";
  readonly recommendedNextAction:
    | "stage3_3_cancel"
    | "await_pause_clear"
    | "manual_review";
  readonly controlIntent?:
    | {
        readonly controlIntentKind: "cancel";
        readonly controlIntentEventId: string;
      }
    | {
        readonly controlIntentKind: "pause";
        readonly controlIntentEventId: string;
        readonly pauseRequestEventId: string;
      };
  readonly preflightReasonCode: string | null;
}

type InterruptionDecisionOutcome =
  | InterruptionDecision
  | {
      readonly status: "full_recovery_required";
      readonly retryAssessment: "passed";
      readonly preflightReasonCode: string | null;
    }
  | {
      readonly status: "retry_assessment_unavailable";
      readonly retryAssessment: "not_evaluated";
      readonly preflightReasonCode: string | null;
    };

interface ResolvedControlIntent {
  readonly kind: "cancel" | "pause";
  readonly eventId: string;
  readonly pauseRequestEventId?: string;
}

export class RecoveryEvidenceInterruptionUnitOfWork {
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

  interruptOwnedRecoveryEvidenceReadAttempt(
    input: InterruptOwnedRecoveryEvidenceReadAttemptInput,
  ): RecoveryEvidenceInterruptionResult {
    const parsed =
      InterruptOwnedRecoveryEvidenceReadAttemptInputSchema.parse(input);

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
          throw interruptionError(
            "RECOVERY_EVIDENCE_INTERRUPTION_TASK_INVALID",
            "Recovery evidence interruption requires waiting_review.",
          );
        }
        const request = this.requests.get(parsed.requestId);
        const attempt = this.attempts.get(parsed.priorAttemptId);
        const readRun = this.toolRuns.get(request.readToolRunId);
        const planStep = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        const reservation = this.reservations.getByRequestId(request.id);
        this.assertPersistedBindings({
          task,
          request,
          attempt,
          readRun,
          planStep,
          plan,
          reservation,
        });
        if (reservation === undefined) {
          throw interruptionError(
            "RECOVERY_EVIDENCE_INTERRUPTION_BINDING_INVALID",
            "Recovery evidence Reservation binding is invalid.",
          );
        }

        this.takeoverGuard.assertLeaseClaimEvent({
          ownership: parsed.ownership,
          leaseClaimEventId: parsed.currentLeaseClaimEventId,
        });

        const events = this.events.listByTask(task.id);
        const replayLineage = this.findReplayLineage(
          events,
          parsed.recoveryOperationId,
        );
        if (replayLineage !== undefined) {
          this.assertReplayIdentity(replayLineage, {
            task,
            request,
            attempt,
          });
          const replayed = this.stateTransitions
            .transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
              {
                ownership: parsed.ownership,
                expectedTaskVersion: parsed.expectedTaskVersion,
                attemptId: attempt.id,
                expectedAttemptVersion:
                  parsed.expectedAttemptVersion,
                status: "interrupted",
                reasonCode: replayLineage.reasonCode,
                recoveryLineage: replayLineage,
              },
              permit,
            );
          return this.resultFromLineage(
            replayLineage,
            replayed,
            true,
          );
        }

        if (attempt.status !== "dispatching") {
          throw interruptionError(
            "RECOVERY_EVIDENCE_INTERRUPTION_STATE_INVALID",
            "Interruption-only recovery requires a dispatching Attempt.",
          );
        }
        const dispatchEvent = events.find(
          (event) => event.id === attempt.lastEventId,
        );
        const dispatchFencingToken =
          this.assertDispatchEvent(dispatchEvent, attempt);
        const currentClaim =
          this.takeoverGuard.assertLeaseClaimEvent({
            ownership: parsed.ownership,
            leaseClaimEventId: parsed.currentLeaseClaimEventId,
          });
        if (
          currentClaim.event.sequence <= dispatchEvent!.sequence
        ) {
          throw interruptionError(
            "RECOVERY_EVIDENCE_LEASE_CLAIM_SEQUENCE_INVALID",
            "Lease Claim Event must follow the old Dispatch Event.",
          );
        }

        const controlIntent = this.resolveControlIntent(
          task,
          events,
        );
        const preflight = this.resolvePreflight(
          parsed.preflightResult,
          task,
          request,
          readRun,
          reservation,
        );
        const decision = this.resolveDecision(
          controlIntent,
          preflight,
        );
        if (
          decision.status === "full_recovery_required" ||
          decision.status === "retry_assessment_unavailable"
        ) {
          return {
            status: decision.status,
            replayed: false,
            attempt,
            interruptionEventId: null,
            retryAssessment: decision.retryAssessment,
            preflightReasonCode: decision.preflightReasonCode,
            recommendedNextAction:
              decision.status === "full_recovery_required"
                ? "stage3_4_full_recovery"
                : "manual_review",
          };
        }

        const lineage = this.buildLineage({
          recoveryOperationId: parsed.recoveryOperationId,
          task,
          request,
          attempt,
          reservation,
          dispatchEvent: dispatchEvent!,
          dispatchFencingToken,
          leaseClaimEventId: parsed.currentLeaseClaimEventId,
          fencingToken: parsed.ownership.fencingToken,
          decision,
        });
        const interrupted = this.stateTransitions
          .transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
            {
              ownership: parsed.ownership,
              expectedTaskVersion: parsed.expectedTaskVersion,
              attemptId: attempt.id,
              expectedAttemptVersion: parsed.expectedAttemptVersion,
              status: "interrupted",
              reasonCode: lineage.reasonCode,
              recoveryLineage: lineage,
            },
            permit,
          );
        this.takeoverGuard.assertInterruptedClaimBinding({
          ownership: parsed.ownership,
          leaseClaimEventId: parsed.currentLeaseClaimEventId,
          dispatchEventId: lineage.dispatchEventId,
          interruptedEventId: interrupted.lastEventId,
        });
        return this.resultFromLineage(
          lineage,
          interrupted,
          false,
          decision.preflightReasonCode,
        );
      },
      "immediate",
    );
  }

  private assertPersistedBindings(input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly attempt: RecoveryEvidenceReadAttemptRecord;
    readonly readRun: ReturnType<ToolRunRepository["get"]>;
    readonly planStep: ReturnType<PlanStepRepository["get"]>;
    readonly plan: ReturnType<ExecutionPlanRepository["get"]>;
    readonly reservation: ReturnType<
      RecoveryEvidenceReadbackReservationRepository["getByRequestId"]
    >;
  }): void {
    if (
      input.request.taskId !== input.task.id ||
      input.attempt.taskId !== input.task.id ||
      input.attempt.readbackRequestId !== input.request.id ||
      input.attempt.readToolRunId !== input.request.readToolRunId ||
      input.attempt.retrySafety !== input.request.retrySafety ||
      input.attempt.consistencyMode !==
        input.request.consistencyMode ||
      input.readRun.taskId !== input.task.id ||
      input.readRun.id !== input.request.readToolRunId ||
      input.readRun.planStepId !== input.planStep.id ||
      input.planStep.taskId !== input.task.id ||
      input.planStep.planId !== input.plan.id ||
      input.plan.taskId !== input.task.id ||
      input.plan.purpose !== "recovery_evidence" ||
      input.planStep.kind !== "read_batch" ||
      input.reservation === undefined ||
      input.reservation.status !== "completed" ||
      input.reservation.taskId !== input.task.id ||
      input.reservation.requestId !== input.request.id ||
      input.reservation.readToolRunId !== input.request.readToolRunId ||
      input.reservation.readAttemptId !== input.attempt.id
    ) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_INTERRUPTION_BINDING_INVALID",
        "Recovery evidence interruption bindings are invalid.",
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
      throw interruptionError(
        "RECOVERY_EVIDENCE_INTERRUPTION_DISPATCH_INVALID",
        "Recovery evidence Dispatch Event binding is invalid.",
      );
    }
    return fencingToken;
  }

  private resolveControlIntent(
    task: TaskRecord,
    events: readonly EventRecord[],
  ): ResolvedControlIntent | undefined {
    if (task.cancelRequestedAt !== null) {
      const event = this.findLatestIntentEvent(
        events,
        "recovery.evidence.cancel_requested",
        "cancelRequestedAt",
        task.cancelRequestedAt,
      );
      return { kind: "cancel", eventId: event.id };
    }
    if (task.pauseRequestedAt !== null) {
      const event = this.findLatestIntentEvent(
        events,
        "recovery.evidence.pause_requested",
        "pauseRequestedAt",
        task.pauseRequestedAt,
      );
      return {
        kind: "pause",
        eventId: event.id,
        pauseRequestEventId: event.id,
      };
    }
    return undefined;
  }

  private findLatestIntentEvent(
    events: readonly EventRecord[],
    type: string,
    field: "cancelRequestedAt" | "pauseRequestedAt",
    value: string,
  ): EventRecord {
    const event = [...events]
      .reverse()
      .find(
        (candidate) =>
          candidate.type === type &&
          candidate.payload[field] === value,
      );
    if (event === undefined) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_INTENT_EVENT_INVALID",
        "Persisted recovery evidence control intent Event is missing.",
      );
    }
    return event;
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
  ): RecoveryEvidenceRecoveryPreflightResult | undefined {
    if (result === undefined) {
      return undefined;
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

  private resolveDecision(
    intent: ResolvedControlIntent | undefined,
    preflight: RecoveryEvidenceRecoveryPreflightResult | undefined,
  ): InterruptionDecisionOutcome {
    if (intent?.kind === "cancel") {
      return {
        status: "interrupted_cancel_pending",
        interruptionCause: "cancel_intent",
        reasonCode: "RECOVERY_CANCEL_INTERRUPTED",
        retryAssessment: "not_evaluated",
        recommendedNextAction: "stage3_3_cancel",
        controlIntent: {
          controlIntentKind: "cancel",
          controlIntentEventId: intent.eventId,
        },
        preflightReasonCode: null,
      };
    }

    if (preflight === undefined) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_PREFLIGHT_REQUIRED",
        "Recovery evidence interruption requires a Preflight result.",
      );
    }
    const retryAssessment = preflight.retryAssessment;
    const preflightReasonCode =
      preflight.state === "passed" ? null : preflight.reasonCode;

    if (intent?.kind === "pause") {
      return {
        status: "interrupted_pause_pending",
        interruptionCause: "pause_intent",
        reasonCode:
          retryAssessment === "passed"
            ? "RECOVERY_PAUSE_INTERRUPTED"
            : retryAssessment === "failed"
              ? "RECOVERY_PAUSE_RETRY_UNSAFE"
              : "RECOVERY_PAUSE_RETRY_NOT_EVALUATED",
        retryAssessment,
        recommendedNextAction:
          retryAssessment === "passed"
            ? "await_pause_clear"
            : "manual_review",
        controlIntent: {
          controlIntentKind: "pause",
          controlIntentEventId: intent.eventId,
          pauseRequestEventId:
            intent.pauseRequestEventId as string,
        },
        preflightReasonCode,
      };
    }

    if (retryAssessment === "passed") {
      return {
        status: "full_recovery_required",
        retryAssessment,
        preflightReasonCode,
      };
    }
    if (retryAssessment === "not_evaluated") {
      return {
        status: "retry_assessment_unavailable",
        retryAssessment,
        preflightReasonCode,
      };
    }
    return {
      status: "interrupted_retry_unsafe",
      interruptionCause: "retry_unsafe",
      reasonCode: preflightReasonCode as string,
      retryAssessment: "failed",
      recommendedNextAction: "manual_review",
      preflightReasonCode,
    };
  }

  private buildLineage(input: {
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
    readonly decision: InterruptionDecision;
  }): RecoveryEvidenceInterruptLineageV1 {
    const lineage: RecoveryEvidenceInterruptLineageV1 =
      RecoveryEvidenceInterruptLineageV1Schema.parse({
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
        interruptionCause: input.decision.interruptionCause,
        reasonCode: input.decision.reasonCode,
        retryAssessment: input.decision.retryAssessment,
        resumeEligible:
          input.decision.retryAssessment === "passed",
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
        ...(input.decision.controlIntent === undefined
          ? {}
          : input.decision.controlIntent),
      });
    if (
      input.dispatchFencingToken >= input.fencingToken
    ) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_INTERRUPTION_FENCING_INVALID",
        "Interruption fencing must exceed Dispatch fencing.",
      );
    }
    return lineage;
  }

  private findReplayLineage(
    events: readonly EventRecord[],
    recoveryOperationId: string,
  ): RecoveryEvidenceInterruptLineageV1 | undefined {
    const matching = events.filter(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_interrupted" &&
        event.payload.recoveryOperationId === recoveryOperationId &&
        event.payload.recoveryPhase === "interrupt",
    );
    if (matching.length === 0) {
      return undefined;
    }
    if (matching.length !== 1) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT",
        "Recovery Operation ID has multiple interruption records.",
      );
    }
    const parsed = RecoveryEvidenceInterruptLineageV1Schema.safeParse(
      matching[0]!.payload,
    );
    if (!parsed.success) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_REPLAY_INCONSISTENT",
        "Persisted interruption lineage is invalid.",
      );
    }
    return parsed.data;
  }

  private assertReplayIdentity(
    lineage: RecoveryEvidenceInterruptLineageV1,
    persisted: {
      readonly task: TaskRecord;
      readonly request: RecoveryEvidenceReadbackRequestRecord;
      readonly attempt: RecoveryEvidenceReadAttemptRecord;
    },
  ): void {
    if (
      lineage.taskId !== persisted.task.id ||
      lineage.readbackRequestId !== persisted.request.id ||
      lineage.readToolRunId !== persisted.request.readToolRunId ||
      lineage.priorAttemptId !== persisted.attempt.id ||
      lineage.priorAttemptNumber !== persisted.attempt.attemptNumber
    ) {
      throw interruptionError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT",
        "Recovery Operation ID is bound to different persisted identity.",
      );
    }
  }

  private resultFromLineage(
    lineage: RecoveryEvidenceInterruptLineageV1,
    attempt: RecoveryEvidenceReadAttemptRecord,
    replayed: boolean,
    preflightReasonCode?: string | null,
  ): RecoveryEvidenceInterruptionResult {
    const replayPreflightReasonCode =
      lineage.controlIntentKind === "cancel" ||
      lineage.retryAssessment === "passed"
        ? null
        : lineage.reasonCode;
    const common = {
      replayed,
      attempt,
      interruptionEventId: attempt.lastEventId,
      retryAssessment: lineage.retryAssessment,
      preflightReasonCode:
        preflightReasonCode !== undefined
          ? preflightReasonCode
          : replayPreflightReasonCode,
    } as const;
    if (lineage.controlIntentKind === "cancel") {
      return {
        ...common,
        status: "interrupted_cancel_pending",
        recommendedNextAction: "stage3_3_cancel",
      };
    }
    if (lineage.controlIntentKind === "pause") {
      return {
        ...common,
        status: "interrupted_pause_pending",
        recommendedNextAction:
          lineage.retryAssessment === "passed"
            ? "await_pause_clear"
            : "manual_review",
      };
    }
    if (lineage.retryAssessment === "failed") {
      return {
        ...common,
        status: "interrupted_retry_unsafe",
        recommendedNextAction: "manual_review",
      };
    }
    throw interruptionError(
      "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_REPLAY_INCONSISTENT",
      "Interruption lineage has no supported interruption-only branch.",
    );
  }
}

function interruptionError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    statusCode: 409,
    details: [],
  });
}
