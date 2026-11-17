import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryEvidenceReadAttemptRepository } from "./recovery-evidence-read-attempt-repository.js";
import { RecoveryEvidenceFencingTakeoverGuard } from "./recovery-evidence-fencing-takeover-guard.js";
import {
  RecoveryEvidenceInterruptLineageV1Schema,
  RecoveryEvidencePrepareLineageV1Schema,
  canonicalRecoveryEvidenceLineageV1,
  validateRecoveryEvidenceLineagePair,
  type RecoveryEvidenceInterruptLineageV1,
} from "./recovery-evidence-recovery-lineage.js";
import { RecoveryEvidenceReadRepository } from "./recovery-evidence-read-repository.js";
import { RecoveryEvidenceReadbackRequestRepository } from "./recovery-evidence-readback-request-repository.js";
import {
  RecoveryEvidenceTransitionTargetSchema,
  resolveRecoveryEvidenceStateMatrix,
  type RecoveryEvidenceTransitionTarget,
} from "./recovery-evidence-state-matrix.js";
import { RecoveryEvidenceVerificationCheckRepository } from "./recovery-evidence-verification-check-repository.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskLeaseManager } from "./task-lease-manager.js";
import { TaskRepository } from "./task-repository.js";
import { TaskSnapshotReader } from "./task-snapshot.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import {
  type EventRecord,
  type RecoveryEvidenceReadAttemptRecord,
  type RecoveryEvidenceReadAttemptStatus,
  type RecoveryEvidenceReadbackRequestRecord,
  type TaskRecord,
  type ToolRunRecord,
  type ToolRunStatus,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);

const OwnershipSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const TransitionInputSchema = z
  .object({
    ownership: OwnershipSchema,
    expectedTaskVersion: z.number().int().positive(),
    attemptId: z.string().min(1),
    expectedAttemptVersion: z.number().int().positive(),
    status: RecoveryEvidenceTransitionTargetSchema,
    transitionOperationId: z.string().min(1).optional(),
    intentEventId: z.string().min(1).optional(),
    observedIntentEventId: z.string().min(1).optional(),
    observedIntentKind: z.enum(["cancel", "pause"]).optional(),
    observedAt: z.string().min(1).nullable().default(null),
    resourceVersion: z.string().min(1).nullable().default(null),
    resourceEtag: z.string().min(1).nullable().default(null),
    resultDigest: Sha256DigestSchema.nullable().default(null),
    resultPayloadStoreRef: z.string().min(1).nullable().default(null),
    reasonCode: z.string().trim().min(1).nullable().default(null),
    recoveryLineage:
      RecoveryEvidenceInterruptLineageV1Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status !== "dispatching" && value.reasonCode === null) {
      context.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message: "Non-dispatching terminal attempts require a reason code.",
      });
    }
    if (value.status === "interrupted") {
      if (value.recoveryLineage === undefined) {
        context.addIssue({
          code: "custom",
          path: ["recoveryLineage"],
          message:
            "Interrupted transition requires Recovery Lineage V1.",
        });
      } else if (value.reasonCode !== value.recoveryLineage.reasonCode) {
        context.addIssue({
          code: "custom",
          path: ["reasonCode"],
          message:
            "Transition reasonCode must match Recovery Lineage reasonCode.",
        });
      }
    } else if (value.recoveryLineage !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["recoveryLineage"],
        message:
          "Recovery Lineage is only valid for interrupted transitions.",
      });
    }
  });

export type TransitionOwnedRecoveryEvidenceReadAttemptInput = z.input<
  typeof TransitionInputSchema
>;

const PrepareRecoveredReadAttemptInputSchema = z
  .object({
    ownership: OwnershipSchema,
    currentLeaseClaimEventId: z.uuid(),
    expectedTaskVersion: z.number().int().positive(),
    priorAttemptId: z.string().trim().min(1),
    expectedPriorAttemptVersion: z.number().int().positive(),
    expectedToolRunVersion: z.number().int().positive(),
    expectedPlanStepVersion: z.number().int().positive(),
    expectedPlanVersion: z.number().int().positive(),
    newAttemptId: z.string().trim().min(1),
    newAttemptNumber: z.number().int().positive(),
    preparedLineage: RecoveryEvidencePrepareLineageV1Schema,
  })
  .strict();

export type PrepareRecoveredReadAttemptInput = z.input<
  typeof PrepareRecoveredReadAttemptInputSchema
>;

/**
 * Internal mechanical executor for the Stage 3.1 matrix.
 *
 * Business UoWs must complete their Dispatch / Failure / Recovery gates before
 * invoking this class. It is intentionally not re-exported from the storage
 * public index.
 */
export class RecoveryEvidenceStateTransitionUnitOfWork {
  private readonly tasks: TaskRepository;
  private readonly plans: ExecutionPlanRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly requests: RecoveryEvidenceReadbackRequestRepository;
  private readonly attempts: RecoveryEvidenceReadAttemptRepository;
  private readonly reads: RecoveryEvidenceReadRepository;
  private readonly checks: RecoveryEvidenceVerificationCheckRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly takeoverGuard: RecoveryEvidenceFencingTakeoverGuard;

  constructor(
    private readonly database: Database.Database,
    private readonly assertAuthority: () => void,
    private readonly leaseManager: TaskLeaseManager,
    now: () => Date = () => new Date(),
  ) {
    const sequences = new SequenceAllocator(database);
    this.tasks = new TaskRepository(database);
    this.plans = new ExecutionPlanRepository(database);
    this.planSteps = new PlanStepRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    this.requests = new RecoveryEvidenceReadbackRequestRepository(database);
    this.attempts = new RecoveryEvidenceReadAttemptRepository(database);
    this.reads = new RecoveryEvidenceReadRepository(database);
    this.checks = new RecoveryEvidenceVerificationCheckRepository(database);
    this.events = new EventRepository(database, sequences);
    this.checkpoints = new CheckpointStore(database, sequences);
    this.snapshotReader = new TaskSnapshotReader(database);
    this.takeoverGuard = new RecoveryEvidenceFencingTakeoverGuard(
      database,
      leaseManager,
    );
    this.now = now;
  }

  private readonly now: () => Date;

  transitionOwnedRecoveryEvidenceReadAttempt(
    input: TransitionOwnedRecoveryEvidenceReadAttemptInput,
    currentTransactionPermit: StorageWritePermit,
  ): RecoveryEvidenceReadAttemptRecord {
    return this.transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
      input,
      currentTransactionPermit,
    );
  }

  transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction(
    input: TransitionOwnedRecoveryEvidenceReadAttemptInput,
    currentTransactionPermit: StorageWritePermit,
  ): RecoveryEvidenceReadAttemptRecord {
    const parsed = TransitionInputSchema.parse(input);
    assertStorageWritePermit(this.database, currentTransactionPermit);
    const now = this.now().toISOString();
    const executeTransition = (permit: StorageWritePermit) => {
        const task = this.assertOwnedRecoveryTask(parsed.ownership);
        this.assertAuthority();

        const current = this.attempts.get(parsed.attemptId);
        if (current.taskId !== task.id) {
          throw stateError(
            "RECOVERY_EVIDENCE_ATTEMPT_TASK_MISMATCH",
            "Recovery evidence attempt does not belong to the owned task.",
          );
        }
        const request = this.requests.get(current.readbackRequestId);
        if (
          request.taskId !== task.id ||
          request.readToolRunId !== current.readToolRunId
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_RESULT_BINDING_INVALID",
            "Recovery evidence attempt Request binding is invalid.",
          );
        }
        if (
          parsed.status === "cancelled" &&
          this.findRequestCancelReplay(
            task.id,
            request.id,
            parsed.transitionOperationId,
            parsed.reasonCode,
          ) !== undefined
        ) {
          return current;
        }
        const attemptTransitionReplay =
          this.findAttemptTransitionReplay(
            task.id,
            current.id,
            parsed.status,
            parsed.reasonCode,
            parsed.intentEventId,
            parsed.recoveryLineage,
          );
        if (attemptTransitionReplay !== undefined) {
          if (parsed.status === "interrupted") {
            this.assertInterruptedReplayState(
              task.id,
              current,
              request,
              attemptTransitionReplay,
            );
          }
          return current;
        }
        if (
          parsed.status === "cancelled" &&
          current.status === "completed" &&
          this.isTransactionBComplete(request)
        ) {
          return current;
        }

        this.assertTaskVersion(task, parsed.expectedTaskVersion);
        const readRun = this.toolRuns.get(request.readToolRunId);
        const planStep = this.planSteps.get(request.planStepId);
        const plan = this.plans.get(request.executionPlanId);
        if (
          readRun.taskId !== task.id ||
          readRun.planStepId !== planStep.id ||
          planStep.taskId !== task.id ||
          planStep.planId !== plan.id ||
          plan.taskId !== task.id ||
          plan.purpose !== "recovery_evidence"
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_PLAN_BINDING_INVALID",
            "Recovery evidence plan binding is invalid.",
          );
        }
        if (parsed.recoveryLineage !== undefined) {
          this.assertRecoveryLineageBindings({
            task,
            request,
            current,
            readRun,
            lineage: parsed.recoveryLineage,
            fencingToken: parsed.ownership.fencingToken,
          });
        }

        const transition = resolveRecoveryEvidenceStateMatrix({
          target: parsed.status,
          attemptStatus: current.status,
          toolRunStatus: readRun.status,
          planStepStatus: planStep.status,
          planStatus: plan.status,
          planPurpose: plan.purpose,
          planStepKind: planStep.kind,
        });
        const activeAttempts = this.attempts
          .listByTask(task.id)
          .filter(
            (attempt) =>
              attempt.readbackRequestId === request.id &&
              ["prepared", "dispatching"].includes(attempt.status),
          );
        if (
          transition.requestLevelCancel
            ? activeAttempts.length !== 0
            : activeAttempts.length !== 1 ||
              activeAttempts[0]?.id !== current.id
        ) {
          throw stateError(
            "RECOVERY_EVIDENCE_READ_ATTEMPT_ACTIVE",
            "Recovery evidence request has an inconsistent active Attempt.",
          );
        }

        if (transition.requestLevelCancel) {
          if (parsed.transitionOperationId === undefined) {
            throw stateError(
              "RECOVERY_EVIDENCE_STATE_TRANSITION_INVALID",
              "Request-level cancellation requires a stable operation ID.",
            );
          }
          this.events.append(
            {
              taskId: task.id,
              traceId: task.traceId,
              type: "recovery.evidence.readback_cancelled",
              entityType: "recovery_evidence_readback_request",
              entityId: request.id,
              payload: {
                readbackRequestId: request.id,
                readAttemptId: current.id,
                cancelIntentEventId: parsed.transitionOperationId,
                previousAttemptStatus: current.status,
                reasonCode: parsed.reasonCode,
                fencingToken: parsed.ownership.fencingToken,
              },
            },
            now,
            permit,
          );
        } else {
          this.applyAttemptTransition(
            task,
            current.id,
            parsed.expectedAttemptVersion,
            parsed,
            now,
            parsed.ownership.fencingToken,
            permit,
          );
        }

        const transitionedToolRun =
          transition.toolRunStatus === readRun.status
            ? readRun
            : this.toolRuns.transition(
                readRun.id,
                [readRun.status],
                {
                  expectedVersion: readRun.version,
                  status: transition.toolRunStatus,
                  startedAt:
                    transition.toolRunStatus === "running"
                      ? now
                      : readRun.startedAt,
                  finishedAt: isTerminalToolRunStatus(
                    transition.toolRunStatus,
                  )
                    ? now
                    : readRun.finishedAt,
                  updatedAt: now,
                },
                permit,
              );

        const transitionedStep =
          transition.planStepStatus === planStep.status
            ? planStep
            : this.planSteps.updateStatusCas(
                planStep.id,
                planStep.status,
                planStep.version,
                transition.planStepStatus,
                now,
                permit,
              );

        const transitionedPlan =
          transition.planStatus === plan.status
            ? plan
            : this.plans.updateStatusCas(
                plan.id,
                plan.status,
                plan.version,
                transition.planStatus,
                now,
                permit,
              );

        if (transition.toolRunStatus !== readRun.status) {
          this.events.append(
            {
              taskId: task.id,
              traceId: task.traceId,
              type: toolEventType(transition.toolRunStatus),
              entityType: "tool_run",
              entityId: transitionedToolRun.id,
              payload: {
                readAttemptId: current.id,
                toolRunId: transitionedToolRun.id,
                toolStatus: transitionedToolRun.status,
                fencingToken: parsed.ownership.fencingToken,
              },
            },
            now,
            permit,
          );
        }

        const attempt = transition.attemptChanged
          ? this.attempts.get(current.id)
          : current;
        const lastEventSequence =
          this.snapshotReader.load(task.id).events.at(-1)?.sequence ??
          task.lastEventSequence;
        this.appendCheckpoint(
          task,
          transition.requestLevelCancel
            ? "recovery_readback_cancelled"
            : `recovery_read_attempt_${parsed.status}`,
          lastEventSequence,
          {
            attemptId: attempt.id,
            attemptStatus: attempt.status,
            toolRunStatus: transitionedToolRun.status,
            planStepStatus: transitionedStep.status,
            planStatus: transitionedPlan.status,
            ...(parsed.recoveryLineage === undefined
              ? {}
              : {
                  recoveryOperationId:
                    parsed.recoveryLineage.recoveryOperationId,
                  recoveryPhase: parsed.recoveryLineage.recoveryPhase,
                  retryAssessment:
                    parsed.recoveryLineage.retryAssessment,
                }),
          },
          now,
          permit,
        );
        return attempt;
    };
    return executeTransition(currentTransactionPermit);
  }

  prepareRecoveredReadAttemptInCurrentTransaction(
    input: PrepareRecoveredReadAttemptInput,
    currentTransactionPermit: StorageWritePermit,
  ): RecoveryEvidenceReadAttemptRecord {
    const parsed =
      PrepareRecoveredReadAttemptInputSchema.parse(input);
    assertStorageWritePermit(this.database, currentTransactionPermit);
    const task = this.assertOwnedRecoveryTask(parsed.ownership);
    this.assertAuthority();
    if (task.cancelRequestedAt !== null) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_CANCEL_BLOCKED",
        "Cancel intent blocks recovered Attempt preparation.",
      );
    }
    this.assertTaskVersion(task, parsed.expectedTaskVersion);

    const priorAttempt = this.attempts.get(parsed.priorAttemptId);
    const request = this.requests.get(
      priorAttempt.readbackRequestId,
    );
    const readRun = this.toolRuns.get(request.readToolRunId);
    const planStep = this.planSteps.get(request.planStepId);
    const plan = this.plans.get(request.executionPlanId);
    if (
      priorAttempt.taskId !== task.id ||
      request.taskId !== task.id ||
      priorAttempt.readToolRunId !== request.readToolRunId ||
      priorAttempt.retrySafety !== request.retrySafety ||
      priorAttempt.consistencyMode !== request.consistencyMode ||
      readRun.taskId !== task.id ||
      readRun.planStepId !== planStep.id ||
      readRun.mode !== "read" ||
      readRun.toolName !== request.readToolName ||
      readRun.toolVersion !== request.readToolVersion ||
      readRun.inputSchemaHash !== request.readToolSchemaHash ||
      planStep.taskId !== task.id ||
      planStep.planId !== plan.id ||
      planStep.kind !== "read_batch" ||
      plan.taskId !== task.id ||
      plan.purpose !== "recovery_evidence"
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_BINDING_INVALID",
        "Recovered Attempt preparation binding is invalid.",
      );
    }
    if (
      priorAttempt.status !== "interrupted" ||
      readRun.status !== "interrupted" ||
      planStep.status !== "interrupted" ||
      plan.status !== "active"
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_SOURCE_INVALID",
        "Recovered Attempt preparation source state is invalid.",
      );
    }
    if (
      priorAttempt.version !==
        parsed.expectedPriorAttemptVersion ||
      readRun.version !== parsed.expectedToolRunVersion ||
      planStep.version !== parsed.expectedPlanStepVersion ||
      plan.version !== parsed.expectedPlanVersion
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_VERSION_CONFLICT",
        "Recovered Attempt preparation versions changed.",
      );
    }
    const activeAttempts = this.attempts
      .listByTask(task.id)
      .filter(
        (attempt) =>
          attempt.readbackRequestId === request.id &&
          attempt.readToolRunId === request.readToolRunId &&
          ["prepared", "dispatching"].includes(attempt.status),
      );
    if (activeAttempts.length !== 0) {
      throw stateError(
        "RECOVERY_EVIDENCE_READ_ATTEMPT_ACTIVE",
        "Recovered Attempt preparation has a conflicting active Attempt.",
      );
    }
    const expectedAttemptNumber =
      priorAttempt.attemptNumber + 1;
    if (
      parsed.newAttemptNumber !== expectedAttemptNumber ||
      this.attempts.nextAttemptNumber(
        task.id,
        request.id,
        request.readToolRunId,
      ) !== expectedAttemptNumber
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_ATTEMPT_NUMBER_INVALID",
        "Recovered Attempt number is not the next historical number.",
      );
    }
    if (
      parsed.newAttemptId === priorAttempt.id ||
      this.attempts
        .listByTask(task.id)
        .some((attempt) => attempt.id === parsed.newAttemptId)
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_NEW_ATTEMPT_CONFLICT",
        "Recovered New Attempt identity is already used.",
      );
    }

    const prepare =
      RecoveryEvidencePrepareLineageV1Schema.parse(
        parsed.preparedLineage,
      );
    if (
      prepare.taskId !== task.id ||
      prepare.readbackRequestId !== request.id ||
      prepare.readToolRunId !== request.readToolRunId ||
      prepare.priorAttemptId !== priorAttempt.id ||
      prepare.priorAttemptNumber !== priorAttempt.attemptNumber ||
      prepare.newAttemptId !== parsed.newAttemptId ||
      prepare.newAttemptNumber !== parsed.newAttemptNumber ||
      prepare.readAttemptId !== parsed.newAttemptId ||
      prepare.attemptNumber !== parsed.newAttemptNumber ||
      prepare.leaseClaimEventId !==
        parsed.currentLeaseClaimEventId
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_LINEAGE_BINDING_INVALID",
        "Prepared Lineage does not match recovered Attempt identity.",
      );
    }
    const events = this.events.listByTask(task.id);
    const interruptEvent = events.find(
      (event) => event.id === prepare.interruptionEventId,
    );
    if (
      interruptEvent === undefined ||
      interruptEvent.type !==
        "recovery.evidence.read_attempt_interrupted" ||
      interruptEvent.entityType !==
        "recovery_evidence_read_attempt" ||
      interruptEvent.entityId !== priorAttempt.id
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_INTERRUPTION_INVALID",
        "Prepared Lineage Interrupted Event is invalid.",
      );
    }
    const interrupt =
      RecoveryEvidenceInterruptLineageV1Schema.parse(
        interruptEvent.payload,
      );
    const pair = validateRecoveryEvidenceLineagePair({
      interrupt,
      prepare,
      interruptionEventId: interruptEvent.id,
    });
    if (
      pair.prepare === null ||
      interrupt.controlIntentKind === "cancel" ||
      interrupt.resumeEligible !== true ||
      interrupt.retryAssessment !== "passed"
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_LINEAGE_NOT_RESUMABLE",
        "Interrupted lineage is not eligible for recovered preparation.",
      );
    }
    this.assertInterruptedReplayState(
      task.id,
      priorAttempt,
      request,
      interruptEvent,
    );

    const currentClaim =
      this.takeoverGuard.assertLeaseClaimEvent({
        ownership: parsed.ownership,
        leaseClaimEventId: parsed.currentLeaseClaimEventId,
      });
    this.assertPreparedPauseGeneration({
      task,
      interrupt,
      prepare,
      interruptEvent,
      currentClaimSequence: currentClaim.event.sequence,
      events,
    });
    const duplicatePrepare = events.find(
      (event) =>
        event.type ===
          "recovery.evidence.read_attempt_prepared" &&
        event.payload.recoveryOperationId ===
          prepare.recoveryOperationId &&
        event.payload.recoveryPhase === "prepare",
    );
    if (duplicatePrepare !== undefined) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_REPLAY_REQUIRED",
        "Prepared Recovery already exists and must use Exact Replay.",
      );
    }

    const now = this.now().toISOString();
    this.toolRuns.transition(
      readRun.id,
      ["interrupted"],
      {
        expectedVersion: readRun.version,
        status: "queued",
        startedAt: null,
        finishedAt: null,
        updatedAt: now,
      },
      currentTransactionPermit,
    );
    const toolEvent = this.events.append(
      {
        taskId: task.id,
        traceId: task.traceId,
        type: "tool.queued",
        entityType: "tool_run",
        entityId: readRun.id,
        payload: {
          readAttemptId: parsed.newAttemptId,
          priorAttemptId: priorAttempt.id,
          toolRunId: readRun.id,
          toolStatus: "queued",
          fencingToken: parsed.ownership.fencingToken,
        },
      },
      now,
      currentTransactionPermit,
    );
    this.planSteps.updateStatusCas(
      planStep.id,
      "interrupted",
      planStep.version,
      "running",
      now,
      currentTransactionPermit,
    );
    const preparedEvent = this.events.append(
      {
        taskId: task.id,
        traceId: task.traceId,
        type: "recovery.evidence.read_attempt_prepared",
        entityType: "recovery_evidence_read_attempt",
        entityId: parsed.newAttemptId,
        payload: prepare,
      },
      now,
      currentTransactionPermit,
    );
    if (currentClaim.event.sequence >= preparedEvent.sequence) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_CLAIM_SEQUENCE_INVALID",
        "Prepared Event must follow its current Lease Claim Event.",
      );
    }
    const attempt = this.attempts.insertPrepared(
      {
        id: parsed.newAttemptId,
        taskId: task.id,
        readbackRequestId: request.id,
        readToolRunId: request.readToolRunId,
        attemptNumber: parsed.newAttemptNumber,
        retrySafety: request.retrySafety,
        consistencyMode: request.consistencyMode,
        preparedAt: now,
        lastEventId: preparedEvent.id,
        createdAt: now,
      },
      currentTransactionPermit,
    );
    this.appendCheckpoint(
      task,
      "recovery_read_attempt_prepared",
      preparedEvent.sequence,
      {
        attemptId: attempt.id,
        attemptNumber: attempt.attemptNumber,
        priorAttemptId: priorAttempt.id,
        interruptionEventId: interruptEvent.id,
        preparedEventId: preparedEvent.id,
        toolEventId: toolEvent.id,
        pauseClearEventId:
          prepare.pauseClearEventId ?? null,
        recoveryOperationId: prepare.recoveryOperationId,
      },
      now,
      currentTransactionPermit,
    );
    return attempt;
  }

  private assertOwnedRecoveryTask(ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  }): TaskRecord {
    this.leaseManager.assertOwned(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
    const task = this.tasks.get(ownership.taskId);
    if (task.status !== "waiting_review") {
      throw stateError(
        "RECOVERY_EVIDENCE_TASK_STATE_INVALID",
        "Recovery evidence writes require a waiting_review task.",
      );
    }
    return task;
  }

  private assertTaskVersion(task: TaskRecord, expected: number): void {
    if (task.version !== expected) {
      throw stateError(
        "TASK_STATE_CONFLICT",
        "Task changed before the recovery evidence write.",
      );
    }
  }

  private assertPreparedPauseGeneration(input: {
    readonly task: TaskRecord;
    readonly interrupt: RecoveryEvidenceInterruptLineageV1;
    readonly prepare: z.output<
      typeof RecoveryEvidencePrepareLineageV1Schema
    >;
    readonly interruptEvent: EventRecord;
    readonly currentClaimSequence: number;
    readonly events: readonly EventRecord[];
  }): void {
    if (input.interrupt.controlIntentKind !== "pause") {
      if (input.prepare.pauseClearEventId !== undefined) {
        throw stateError(
          "RECOVERY_EVIDENCE_PREPARE_PAUSE_INVALID",
          "Non-Pause Prepared Lineage cannot include Pause Clear.",
        );
      }
      return;
    }
    if (
      input.task.pauseRequestedAt !== null ||
      input.prepare.pauseClearEventId === undefined
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_PAUSE_INVALID",
        "Pause Resume requires an active-clear Pause generation.",
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
    const latestPause = [...input.events]
      .reverse()
      .find(
        (event) =>
          event.type === "recovery.evidence.pause_requested",
      );
    if (
      pauseRequest === undefined ||
      clear === undefined ||
      clear.taskId !== input.task.id ||
      clear.entityId !== input.task.id ||
      clear.payload.clearedPauseEventId !== pauseRequest.id ||
      clear.payload.clearedPauseEventSequence !==
        pauseRequest.sequence ||
      pauseRequest.sequence >= input.interruptEvent.sequence ||
      input.interruptEvent.sequence >= clear.sequence ||
      clear.sequence >= input.currentClaimSequence ||
      latestPause?.id !== pauseRequest.id
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_PREPARE_PAUSE_INVALID",
        "Pause Clear does not match the resumed interruption generation.",
      );
    }
  }

  private assertRecoveryLineageBindings(input: {
    readonly task: TaskRecord;
    readonly request: RecoveryEvidenceReadbackRequestRecord;
    readonly current: RecoveryEvidenceReadAttemptRecord;
    readonly readRun: ToolRunRecord;
    readonly lineage: RecoveryEvidenceInterruptLineageV1;
    readonly fencingToken: number;
  }): void {
    const events = this.events.listByTask(input.task.id);
    const dispatchEvent = events.find(
      (event) => event.id === input.lineage.dispatchEventId,
    );
    const leaseClaimEvent = events.find(
      (event) => event.id === input.lineage.leaseClaimEventId,
    );
    if (
      input.lineage.taskId !== input.task.id ||
      input.lineage.readbackRequestId !== input.request.id ||
      input.lineage.readToolRunId !== input.request.readToolRunId ||
      input.lineage.readAttemptId !== input.current.id ||
      input.lineage.priorAttemptId !== input.current.id ||
      input.lineage.priorAttemptNumber !== input.current.attemptNumber ||
      input.lineage.attemptStatus !== "interrupted" ||
      input.lineage.fencingToken !== input.fencingToken ||
      input.lineage.readToolName !== input.request.readToolName ||
      input.lineage.readToolVersion !== input.request.readToolVersion ||
      input.lineage.readToolSchemaHash !==
        input.request.readToolSchemaHash ||
      input.lineage.retrySafety !== input.request.retrySafety ||
      input.lineage.consistencyMode !==
        input.request.consistencyMode ||
      input.lineage.allowlistId !== input.request.allowlistId ||
      input.lineage.allowlistVersion !==
        input.request.allowlistVersion ||
      input.lineage.expectedResourceVersion !==
        input.request.expectedResourceVersion ||
      input.lineage.expectedEtag !== input.request.expectedEtag ||
      input.readRun.toolName !== input.request.readToolName ||
      input.readRun.toolVersion !== input.request.readToolVersion ||
      input.readRun.inputSchemaHash !==
        input.request.readToolSchemaHash
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_BINDING_INVALID",
        "Recovery lineage identity does not match persisted state.",
      );
    }
    if (
      dispatchEvent === undefined ||
      dispatchEvent.type !==
        "recovery.evidence.read_attempt_dispatching" ||
      dispatchEvent.entityId !== input.current.id ||
      dispatchEvent.payload.readAttemptId !== input.current.id ||
      dispatchEvent.payload.attemptStatus !== "dispatching" ||
      dispatchEvent.payload.fencingToken !==
        input.lineage.dispatchFencingToken
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_DISPATCH_INVALID",
        "Recovery lineage Dispatch Event binding is invalid.",
      );
    }
    if (
      leaseClaimEvent === undefined ||
      leaseClaimEvent.type !== "lease.claimed" ||
      leaseClaimEvent.entityId !== input.task.id ||
      leaseClaimEvent.payload.fencingToken !==
        input.lineage.fencingToken ||
      leaseClaimEvent.sequence <= dispatchEvent.sequence
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_LEASE_INVALID",
        "Recovery lineage Lease Claim Event binding is invalid.",
      );
    }

    if (input.lineage.controlIntentKind === undefined) {
      if (
        input.task.cancelRequestedAt !== null ||
        input.task.pauseRequestedAt !== null
      ) {
        throw stateError(
          "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_INTENT_INVALID",
          "Recovery lineage omits an active control intent.",
        );
      }
      return;
    }

    const intentEvent = events.find(
      (event) =>
        event.id === input.lineage.controlIntentEventId,
    );
    if (input.lineage.controlIntentKind === "cancel") {
      if (
        input.task.cancelRequestedAt === null ||
        intentEvent?.type !==
          "recovery.evidence.cancel_requested" ||
        intentEvent.entityId !== input.task.id ||
        intentEvent.payload.cancelRequestedAt !==
          input.task.cancelRequestedAt
      ) {
        throw stateError(
          "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_INTENT_INVALID",
          "Recovery lineage Cancel Intent binding is invalid.",
        );
      }
      return;
    }

    if (
      input.task.pauseRequestedAt === null ||
      intentEvent?.type !== "recovery.evidence.pause_requested" ||
      intentEvent.entityId !== input.task.id ||
      intentEvent.payload.pauseRequestedAt !==
        input.task.pauseRequestedAt ||
      input.lineage.pauseRequestEventId !== intentEvent.id
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_INTENT_INVALID",
        "Recovery lineage Pause Intent binding is invalid.",
      );
    }
  }

  private assertInterruptedReplayState(
    taskId: string,
    current: RecoveryEvidenceReadAttemptRecord,
    request: RecoveryEvidenceReadbackRequestRecord,
    event: EventRecord,
  ): void {
    const lineage =
      RecoveryEvidenceInterruptLineageV1Schema.parse(event.payload);
    const events = this.events.listByTask(taskId);
    const dispatchEvent = events.find(
      (candidate) => candidate.id === lineage.dispatchEventId,
    );
    const leaseClaimEvent = events.find(
      (candidate) => candidate.id === lineage.leaseClaimEventId,
    );
    const readRun = this.toolRuns.get(request.readToolRunId);
    const planStep = this.planSteps.get(request.planStepId);
    const plan = this.plans.get(request.executionPlanId);
    if (
      current.status !== "interrupted" ||
      current.lastEventId !== event.id ||
      lineage.taskId !== taskId ||
      lineage.readbackRequestId !== request.id ||
      lineage.readToolRunId !== request.readToolRunId ||
      lineage.readAttemptId !== current.id ||
      lineage.priorAttemptId !== current.id ||
      lineage.attemptNumber !== current.attemptNumber ||
      dispatchEvent === undefined ||
      dispatchEvent.type !==
        "recovery.evidence.read_attempt_dispatching" ||
      dispatchEvent.entityId !== current.id ||
      dispatchEvent.payload.fencingToken !==
        lineage.dispatchFencingToken ||
      leaseClaimEvent === undefined ||
      leaseClaimEvent.type !== "lease.claimed" ||
      leaseClaimEvent.entityId !== taskId ||
      leaseClaimEvent.payload.fencingToken !==
        lineage.fencingToken ||
      leaseClaimEvent.sequence <= dispatchEvent.sequence ||
      leaseClaimEvent.sequence >= event.sequence ||
      readRun.taskId !== taskId ||
      planStep.taskId !== taskId ||
      plan.taskId !== taskId
    ) {
      throw stateError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_REPLAY_INCONSISTENT",
        "Interrupted lineage replay state is inconsistent.",
      );
    }

    if (
      readRun.status === "interrupted" &&
      planStep.status === "interrupted" &&
      plan.status === "active"
    ) {
      return;
    }

    if (
      readRun.status === "cancelled" &&
      planStep.status === "cancelled" &&
      plan.status === "cancelled"
    ) {
      const cancelEvent = events.find(
        (candidate) =>
          candidate.type === "recovery.evidence.readback_cancelled" &&
          candidate.entityId === request.id &&
          candidate.payload.readbackRequestId === request.id &&
          candidate.payload.readAttemptId === current.id &&
          candidate.sequence > event.sequence,
      );
      const toolCancelEvent = events.find(
        (candidate) =>
          candidate.type === "tool.cancelled" &&
          candidate.entityId === readRun.id &&
          candidate.sequence > event.sequence,
      );
      if (
        cancelEvent !== undefined &&
        toolCancelEvent !== undefined
      ) {
        return;
      }
      throw stateError(
        "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_REPLAY_INCONSISTENT",
        "Cancelled downstream state has no matching Request Cancel Event.",
      );
    }

    if (plan.status === "active" && planStep.status === "running") {
      const expectedChildStatus =
        readRun.status === "queued"
          ? "prepared"
          : readRun.status === "running"
            ? "dispatching"
            : null;
      if (expectedChildStatus !== null) {
        const childAttempts = this.attempts
          .listByTask(taskId)
          .filter(
            (candidate) =>
              candidate.id !== current.id &&
              candidate.readbackRequestId === request.id &&
              candidate.readToolRunId === request.readToolRunId &&
              ["prepared", "dispatching"].includes(candidate.status),
          );
        if (
          childAttempts.length === 1 &&
          childAttempts[0]?.status === expectedChildStatus
        ) {
          const child = childAttempts[0]!;
          const prepareEvent = events.find(
            (candidate) =>
              candidate.type ===
                "recovery.evidence.read_attempt_prepared" &&
              candidate.entityId === child.id &&
              candidate.payload.readAttemptId === child.id,
          );
          if (prepareEvent !== undefined) {
            const prepare =
              RecoveryEvidencePrepareLineageV1Schema.safeParse(
                prepareEvent.payload,
              );
            if (prepare.success) {
              validateRecoveryEvidenceLineagePair({
                interrupt: lineage,
                prepare: prepare.data,
                interruptionEventId: event.id,
              });
              return;
            }
          }
        }
      }
    }

    throw stateError(
      "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_REPLAY_INCONSISTENT",
      "Interrupted lineage downstream state evolution is not recognized.",
    );
  }

  private findAttemptTransitionReplay(
    taskId: string,
    attemptId: string,
    status: RecoveryEvidenceTransitionTarget,
    reasonCode: string | null,
    intentEventId: string | undefined,
    recoveryLineage?: RecoveryEvidenceInterruptLineageV1,
  ): EventRecord | undefined {
    const eventType = attemptEventType(status);
    const events = this.events.listByTask(taskId);
    if (status === "interrupted" && recoveryLineage !== undefined) {
      const expectedCanonical =
        canonicalRecoveryEvidenceLineageV1(recoveryLineage);
      const matchingAttemptEvents = events.filter(
        (event) =>
          event.type === eventType &&
          event.entityId === attemptId &&
          event.payload.readAttemptId === attemptId &&
          event.payload.attemptStatus === status,
      );
      const exact = matchingAttemptEvents.find((event) => {
        const parsed =
          RecoveryEvidenceInterruptLineageV1Schema.safeParse(
            event.payload,
          );
        return (
          parsed.success &&
          canonicalRecoveryEvidenceLineageV1(parsed.data) ===
            expectedCanonical
        );
      });
      if (exact !== undefined) {
        return exact;
      }
      const conflictingOperation = events.find(
        (event) =>
          event.type ===
            "recovery.evidence.read_attempt_interrupted" &&
          event.payload.recoveryOperationId ===
            recoveryLineage.recoveryOperationId &&
          event.payload.recoveryPhase === "interrupt",
      );
      if (conflictingOperation !== undefined) {
        throw stateError(
          "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT",
          "Recovery Operation ID is already bound to different lineage.",
        );
      }
      return undefined;
    }
    return events.find(
      (event) =>
        event.type === eventType &&
        event.entityId === attemptId &&
        event.payload.readAttemptId === attemptId &&
        event.payload.attemptStatus === status &&
        event.payload.reasonCode === reasonCode &&
        (intentEventId === undefined
          ? event.payload.intentEventId === undefined ||
            event.payload.intentEventId === null
          : event.payload.intentEventId === intentEventId),
    );
  }

  private findRequestCancelReplay(
    taskId: string,
    requestId: string,
    transitionOperationId: string | undefined,
    reasonCode: string | null,
  ): EventRecord | undefined {
    if (transitionOperationId === undefined) {
      return undefined;
    }
    return this.events
      .listByTask(taskId)
      .find(
        (event) =>
          event.type === "recovery.evidence.readback_cancelled" &&
          event.entityId === requestId &&
          event.payload.readbackRequestId === requestId &&
          event.payload.cancelIntentEventId === transitionOperationId &&
          event.payload.reasonCode === reasonCode,
      );
  }

  private isTransactionBComplete(
    request: RecoveryEvidenceReadbackRequestRecord,
  ): boolean {
    const check = this.checks.getByCheckId(
      request.taskId,
      request.verificationCheckId,
    );
    if (
      check === undefined ||
      check.checkOrigin !== "readback_transaction_b" ||
      check.readbackRequestId !== request.id
    ) {
      return false;
    }
    const read =
      check.evidenceReadId === null
        ? this.reads.getByVerificationCheckId(
            request.taskId,
            request.verificationCheckId,
          )
        : this.reads.get(check.evidenceReadId);
    return (
      read !== undefined &&
      read.readbackRequestId === request.id &&
      read.verificationCheckId === request.verificationCheckId
    );
  }

  private applyAttemptTransition(
    task: TaskRecord,
    attemptId: string,
    expectedAttemptVersion: number,
    transition: {
      readonly status: RecoveryEvidenceTransitionTarget;
      readonly observedAt?: string | null;
      readonly resourceVersion?: string | null;
      readonly resourceEtag?: string | null;
      readonly resultDigest?: string | null;
      readonly resultPayloadStoreRef?: string | null;
      readonly reasonCode?: string | null;
      readonly intentEventId?: string | undefined;
      readonly observedIntentEventId?: string | undefined;
      readonly observedIntentKind?: "cancel" | "pause" | undefined;
      readonly recoveryLineage?:
        | RecoveryEvidenceInterruptLineageV1
        | undefined;
    },
    now: string,
    fencingToken: number,
    permit: StorageWritePermit,
  ): RecoveryEvidenceReadAttemptRecord {
    const current = this.attempts.get(attemptId);
    if (current.taskId !== task.id) {
      throw stateError(
        "RECOVERY_EVIDENCE_ATTEMPT_TASK_MISMATCH",
        "Recovery evidence attempt does not belong to the owned task.",
      );
    }
    const event = this.events.append(
      {
        taskId: task.id,
        traceId: task.traceId,
        type: attemptEventType(transition.status),
        entityType: "recovery_evidence_read_attempt",
        entityId: current.id,
        payload:
          transition.status === "interrupted" &&
          transition.recoveryLineage !== undefined
            ? transition.recoveryLineage
            : {
                readAttemptId: current.id,
                attemptNumber: current.attemptNumber,
                attemptStatus: transition.status,
                fencingToken,
                reasonCode: transition.reasonCode ?? null,
                intentEventId: transition.intentEventId ?? null,
                controlIntentEventId:
                  transition.observedIntentEventId ?? null,
                controlIntentKind:
                  transition.observedIntentKind ?? null,
              },
      },
      now,
      permit,
    );
    if (
      transition.status === "interrupted" &&
      transition.recoveryLineage !== undefined
    ) {
      const leaseClaimEvent = this.events
        .listByTask(task.id)
        .find(
          (candidate) =>
            candidate.id ===
            transition.recoveryLineage?.leaseClaimEventId,
        );
      if (
        leaseClaimEvent === undefined ||
        leaseClaimEvent.sequence >= event.sequence
      ) {
        throw stateError(
          "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_LEASE_INVALID",
          "Lease Claim Event must precede the Interrupted Event.",
        );
      }
    }
    return this.attempts.transition(
      current.id,
      {
        expectedVersion: expectedAttemptVersion,
        status: transition.status,
        dispatchingAt:
          transition.status === "dispatching" ? now : undefined,
        interruptedAt:
          transition.status === "interrupted" ? now : undefined,
        completedAt: terminalAttemptStatuses.has(transition.status)
          ? now
          : undefined,
        observedAt: transition.observedAt,
        resourceVersion: transition.resourceVersion,
        resourceEtag: transition.resourceEtag,
        resultDigest: transition.resultDigest,
        resultPayloadStoreRef: transition.resultPayloadStoreRef,
        reasonCode: transition.reasonCode,
        lastEventId: event.id,
        updatedAt: now,
      },
      permit,
    );
  }

  private appendCheckpoint(
    task: TaskRecord,
    reason: string,
    lastEventSequence: number,
    metadata: Record<string, unknown>,
    now: string,
    permit: StorageWritePermit,
  ): void {
    const snapshot = this.snapshotReader.load(task.id);
    this.checkpoints.append(
      {
        taskId: task.id,
        reason,
        taskStatus: task.status,
        lastMessageSequence: snapshot.messages.at(-1)?.sequence ?? 0,
        modelIteration: task.currentIteration,
        planVersion:
          this.plans.listAgentByTask(task.id).at(-1)?.version ?? null,
        lastEventSequence,
        budget: {
          maxModelTurns: task.maxModelTurns,
          maxToolCalls: task.maxToolCalls,
        },
        metadata,
      },
      now,
      permit,
    );
  }
}

const terminalAttemptStatuses = new Set([
  "failed",
  "timed_out",
  "cancelled",
  "blocked_by_intent",
]);

function attemptEventType(
  status: RecoveryEvidenceReadAttemptStatus,
): string {
  const eventTypeByStatus: Record<string, string> = {
    dispatching: "recovery.evidence.read_attempt_dispatching",
    interrupted: "recovery.evidence.read_attempt_interrupted",
    failed: "recovery.evidence.read_attempt_failed",
    timed_out: "recovery.evidence.read_attempt_timed_out",
    cancelled: "recovery.evidence.read_attempt_cancelled",
    blocked_by_intent:
      "recovery.evidence.read_attempt_blocked_by_intent",
  };
  return eventTypeByStatus[status] ?? "__invalid__";
}

function toolEventType(status: ToolRunStatus): string {
  const eventTypeByStatus: Partial<Record<ToolRunStatus, string>> = {
    running: "tool.started",
    interrupted: "tool.interrupted",
    failed: "tool.failed",
    timed_out: "tool.timed_out",
    cancelled: "tool.cancelled",
  };
  const eventType = eventTypeByStatus[status];
  if (eventType === undefined) {
    throw stateError(
      "RECOVERY_EVIDENCE_STATE_TRANSITION_INVALID",
      "Recovery evidence tool state transition is invalid.",
    );
  }
  return eventType;
}

function isTerminalToolRunStatus(status: ToolRunStatus): boolean {
  return ["succeeded", "failed", "timed_out", "cancelled", "skipped"].includes(
    status,
  );
}

function stateError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    statusCode: 409,
    details: [],
  });
}
