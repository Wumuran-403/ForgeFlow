import { randomUUID } from "node:crypto";

import {
  EventRepository,
  ExecutionPlanRepository,
  ExecutionUnitOfWork,
  PlanStepRepository,
  RecoveryEvidenceUnitOfWork,
  RecoveryReviewRepository,
  SequenceAllocator,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  runInTransaction,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { ExecutionAuthority } from "../../src/persistence/index.js";
import { RecoveryEvidenceSubmissionRepository } from "../../src/storage/recovery-evidence-submission-repository.js";
import { RecoveryEvidenceStateTransitionUnitOfWork } from "../../src/storage/recovery-evidence-state-transition-unit-of-work.js";
import { RecoveryReviewOperationRepository } from "../../src/storage/recovery-review-operation-repository.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { computeCanonicalInputHash } from "../../src/tools/fingerprint.js";
import { computeRecoveryEvidenceReadbackRequestIntentDigest } from "../../src/storage/recovery-evidence-readback-reservation-keys.js";
import type { RecoveryEvidenceInterruptLineageV1 } from "../../src/storage/recovery-evidence-recovery-lineage.js";

export interface RecoveryEvidenceUowFixture {
  readonly database: ForgeFlowDatabase;
  readonly unitOfWork: RecoveryEvidenceUnitOfWork;
  readonly stateTransitions: RecoveryEvidenceStateTransitionUnitOfWork;
  readonly leaseManager: TaskLeaseManager;
  readonly authority: ExecutionAuthority;
  readonly ownership: {
    taskId: string;
    leaseToken: string;
    fencingToken: number;
  };
  readonly taskId: string;
  readonly reviewId: string;
  readonly originalToolRunId: string;
  readonly evidenceSubmissionId: string;
  readonly executionPlanId: string;
  readonly planStepId: string;
  readonly readToolRunId: string;
  readonly modelCallId: string;
  readonly expectedTaskVersion: number;
  readonly expectedDecisionVersion: number;
  readonly verificationCheckId: string;
  readonly allowlistVersion: string;
  readonly readToolName: string;
  readonly readToolVersion: string;
  readonly readToolSchemaHash: string;
  readonly readToolInput: unknown;
  readonly canonicalInputHash: string;
}

export interface RecoveryEvidenceInterruptionFixture {
  readonly ownership: RecoveryEvidenceUowFixture["ownership"];
  readonly lineage: RecoveryEvidenceInterruptLineageV1;
}

export function createRecoveryInterruptionFixture(
  fixture: RecoveryEvidenceUowFixture,
  input: {
    readonly attemptId: string;
    readonly reasonCode: string;
    readonly recoveryOperationId?: string;
  },
): RecoveryEvidenceInterruptionFixture {
  const before = new TaskSnapshotReader(fixture.database).load(
    fixture.taskId,
  );
  const attempt = before.recoveryEvidenceReadAttempts.find(
    (candidate) => candidate.id === input.attemptId,
  );
  const dispatchEvent = before.events.find(
    (event) =>
      event.type ===
        "recovery.evidence.read_attempt_dispatching" &&
      event.entityId === input.attemptId &&
      event.payload.readAttemptId === input.attemptId,
  );
  if (
    attempt === undefined ||
    attempt.status !== "dispatching" ||
    dispatchEvent === undefined
  ) {
    throw new Error(
      "Recovery interruption fixture requires a dispatching Attempt.",
    );
  }
  const request = before.recoveryEvidenceReadbackRequests.find(
    (candidate) => candidate.id === attempt.readbackRequestId,
  );
  if (request === undefined) {
    throw new Error("Recovery interruption Request is missing.");
  }

  const currentLease = fixture.leaseManager.assertOwned(
    fixture.taskId,
    fixture.ownership.leaseToken,
    fixture.ownership.fencingToken,
  );
  if (currentLease.leaseToken !== null) {
    fixture.leaseManager.release(
      fixture.taskId,
      fixture.ownership.leaseToken,
      fixture.ownership.fencingToken,
    );
  }
  const replacement = fixture.leaseManager.claim(
    fixture.taskId,
    `interruption-owner-${input.attemptId}`,
  );
  if (replacement.leaseToken === null) {
    throw new Error("Recovery interruption lease claim failed.");
  }
  fixture.ownership.leaseToken = replacement.leaseToken;
  fixture.ownership.fencingToken = replacement.fencingToken;

  const afterClaim = new TaskSnapshotReader(fixture.database).load(
    fixture.taskId,
  );
  const leaseClaimEvent = [...afterClaim.events]
    .reverse()
    .find(
      (event) =>
        event.type === "lease.claimed" &&
        event.payload.fencingToken === replacement.fencingToken,
    );
  if (leaseClaimEvent === undefined) {
    throw new Error("Recovery interruption lease Event is missing.");
  }
  const dispatchFencingToken =
    dispatchEvent.payload.fencingToken;
  if (typeof dispatchFencingToken !== "number") {
    throw new Error("Recovery Dispatch fencing token is invalid.");
  }
  const requestIntentDigest =
    computeRecoveryEvidenceReadbackRequestIntentDigest({
      taskId: fixture.taskId,
      reviewId: fixture.reviewId,
      evidenceSubmissionId: request.evidenceSubmissionId,
      originalToolRunId: request.originalToolRunId,
      allowlistId: request.allowlistId,
      verificationCheckId: request.verificationCheckId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
      expectedResourceVersion: request.expectedResourceVersion,
      expectedEtag: request.expectedEtag,
    });
  const controlIntent =
    afterClaim.task.cancelRequestedAt !== null
      ? {
          controlIntentKind: "cancel" as const,
          controlIntentEventId: [...afterClaim.events]
            .reverse()
            .find(
              (event) =>
                event.type ===
                "recovery.evidence.cancel_requested",
            )?.id,
          retryAssessment: "not_evaluated" as const,
          resumeEligible: false,
          interruptionCause: "cancel_intent",
        }
      : afterClaim.task.pauseRequestedAt !== null
        ? {
            controlIntentKind: "pause" as const,
            controlIntentEventId: [...afterClaim.events]
              .reverse()
              .find(
                (event) =>
                  event.type ===
                  "recovery.evidence.pause_requested",
              )?.id,
            pauseRequestEventId: [...afterClaim.events]
              .reverse()
              .find(
                (event) =>
                  event.type ===
                  "recovery.evidence.pause_requested",
              )?.id,
            retryAssessment: "failed" as const,
            resumeEligible: false,
            interruptionCause: "pause_intent",
          }
        : {
            retryAssessment: "failed" as const,
            resumeEligible: false,
            interruptionCause: "recovery_contract_unavailable",
          };
  if (
    "controlIntentEventId" in controlIntent &&
    controlIntent.controlIntentEventId === undefined
  ) {
    throw new Error("Recovery interruption control Intent is missing.");
  }
  if (
    "pauseRequestEventId" in controlIntent &&
    controlIntent.pauseRequestEventId === undefined
  ) {
    throw new Error("Recovery interruption Pause Event is missing.");
  }

  return {
    ownership: fixture.ownership,
    lineage: {
      lineageSchemaVersion: "recovery-evidence-lineage.v1",
      recoveryOperationId:
        input.recoveryOperationId ?? randomUUID(),
      recoveryPhase: "interrupt",
      taskId: fixture.taskId,
      readbackRequestId: request.id,
      readToolRunId: request.readToolRunId,
      readAttemptId: attempt.id,
      attemptNumber: attempt.attemptNumber,
      attemptStatus: "interrupted",
      priorAttemptId: attempt.id,
      priorAttemptNumber: attempt.attemptNumber,
      dispatchEventId: dispatchEvent.id,
      dispatchFencingToken,
      leaseClaimEventId: leaseClaimEvent.id,
      fencingToken: replacement.fencingToken,
      retrySafety: request.retrySafety,
      consistencyMode: request.consistencyMode,
      allowlistId: request.allowlistId,
      allowlistVersion: request.allowlistVersion,
      readToolName: request.readToolName,
      readToolVersion: request.readToolVersion,
      readToolSchemaHash: request.readToolSchemaHash,
      requestIntentDigest,
      expectedResourceVersion: request.expectedResourceVersion,
      expectedEtag: request.expectedEtag,
      reasonCode: input.reasonCode,
      ...controlIntent,
    },
  };
}

export function createRecoveryEvidenceUowFixture(
  database: ForgeFlowDatabase,
  suffix: string,
  options: {
    readonly allowlistVersion?: string;
    readonly readToolName?: string;
    readonly readToolVersion?: string;
    readonly readToolSchemaHash?: string;
    readonly readToolInput?: unknown;
    readonly canonicalInputHash?: string;
  } = {},
): RecoveryEvidenceUowFixture {
  const taskId = `task-evidence-uow-${suffix}`;
  const traceId = `trace-evidence-uow-${suffix}`;
  const agentPlanId = `plan-agent-${suffix}`;
  const agentStepId = `step-agent-${suffix}`;
  const originalRunId = `run-original-${suffix}`;
  const toolCallId = `call-original-${suffix}`;
  const reviewId = `review-evidence-${suffix}`;
  const submissionId = `submission-evidence-${suffix}`;
  const executionPlanId = `plan-evidence-${suffix}`;
  const planStepId = `step-evidence-${suffix}`;
  const readToolRunId = `run-evidence-${suffix}`;
  const verificationCheckId = `check-evidence-${suffix}`;
  const allowlistVersion = options.allowlistVersion ?? "1";
  const readToolName =
    options.readToolName ?? "inventory_lookup";
  const readToolVersion = options.readToolVersion ?? "1";
  const readToolSchemaHash = options.readToolSchemaHash ?? digest("3");
  const readToolInput = options.readToolInput ?? {
    resourceRef: "inventory://part/STM32",
  };
  const canonicalInputHash =
    options.canonicalInputHash ?? digest("4");
  const submissionRequestKey = computeCanonicalInputHash(
    `submission-${suffix}`,
  );
  const readIdempotencyKey = computeCanonicalInputHash(
    `read-${suffix}`,
  );
  const now = "2026-11-08T00:00:00.000Z";

  const execution = new ExecutionUnitOfWork(database);
  execution.createTask({
    taskId,
    traceId,
    objective: "Exercise recovery evidence persistence.",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
  const modelCall = execution.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Perform a write." }],
      tools: [],
    },
  });
  execution.completeModelCallWithPlan({
    modelCallId: modelCall.id,
    response: {
      message: {
        role: "assistant",
        content: "Prepared a write.",
        toolCalls: [
          {
            id: toolCallId,
            name: "bom_update",
            arguments: {},
          },
        ],
      },
      usage: { source: "provider" },
    },
    durationMs: 10,
    plan: {
      id: agentPlanId,
      version: 1,
      steps: [
        {
          id: agentStepId,
          stepIndex: 0,
          kind: "write",
        },
      ],
      toolRuns: [
        {
          id: originalRunId,
          planStepId: agentStepId,
          toolCallId,
          originalIndex: 0,
          toolName: "bom_update",
          toolVersion: "1",
          inputSchemaHash: digest("1"),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "write",
          requiresApproval: true,
          input: {},
        },
      ],
    },
  });
  execution.beginToolRun({ toolRunId: originalRunId, status: "running" });
  execution.completeToolRun({
    toolRunId: originalRunId,
    status: "unknown",
    error: {
      code: "WRITE_OUTCOME_UNKNOWN",
      message: "Write outcome is unknown.",
      details: [],
    },
    planStepStatus: "waiting_review",
  });

  runInTransaction(
    database,
    () => {
      const permit = createStorageWritePermit(database);
      const sequences = new SequenceAllocator(database);
      new RecoveryReviewRepository(database).createPending(
        {
          id: reviewId,
          taskId,
          toolRunId: originalRunId,
          note: "Evidence UoW fixture.",
          reviewProtocolVersion: 1,
          decisionVersion: 1,
          actorId: "reviewer-host",
          submittedAt: now,
          createdAt: now,
        },
        permit,
      );
      const event = new EventRepository(database, sequences).append(
        {
          taskId,
          traceId,
          type: "recovery.evidence.submitted",
          entityType: "recovery_review",
          entityId: reviewId,
          payload: {
            evidenceSubmissionId: submissionId,
            evidenceRef: `evidence://${submissionId}`,
            envelopeDigest: digest("a"),
          },
        },
        now,
        permit,
      );
      const operation = new RecoveryReviewOperationRepository(database).append(
        {
          id: `operation-submit-${suffix}`,
          taskId,
          reviewId,
          requestKey: submissionRequestKey,
          operation: "submit_evidence",
          expectedDecisionVersion: 0,
          resultingDecisionVersion: 1,
          status: "applied",
          actorId: "host_verifier",
          operationPayloadDigest: digest("a"),
          evidenceEnvelopeDigest: digest("a"),
          resultPlanId: null,
          resultToolRunId: null,
          appliedEventId: event.id,
          createdAt: now,
        },
        permit,
      );
      new RecoveryEvidenceSubmissionRepository(database).insert(
        {
          id: submissionId,
          taskId,
          reviewId,
          toolRunId: originalRunId,
          operationId: operation.id,
          requestKey: submissionRequestKey,
          decisionVersion: 1,
          sourceType: "system_verification",
          outcome: "observed_succeeded",
          evidenceRef: `evidence://${submissionId}`,
          resourceRef: "inventory://part/STM32",
          resourceVersion: "7",
          sourceObservedAt: now,
          submittedAt: now,
          actorId: null,
          verifierId: "host_verifier",
          verificationId: `verification-submit-${suffix}`,
          payloadType: "json",
          payloadDigestProtocol: "jcs-sha256-v1",
          payloadDigest: digest("c"),
          envelopeDigest: digest("a"),
          payloadStoreRef: `evidence-file:sha256/${"c".repeat(64)}`,
          payloadStorageMode: "content_addressed_file",
          appliedEventId: event.id,
          createdAt: now,
        },
        permit,
      );

      const plans = new ExecutionPlanRepository(database);
      plans.insert(
        {
          id: executionPlanId,
          taskId,
          version: 2,
          sourceModelCallId: modelCall.id,
          purpose: "recovery_evidence",
          status: "active",
          createdAt: now,
        },
        permit,
      );
      new PlanStepRepository(database).insert(
        {
          id: planStepId,
          taskId,
          planId: executionPlanId,
          stepIndex: 0,
          kind: "read_batch",
          status: "queued",
          createdAt: now,
        },
        permit,
      );
      new ToolRunRepository(database).createIntent(
        {
          id: readToolRunId,
          taskId,
          planStepId,
          toolCallId: `call-evidence-${suffix}`,
          originalIndex: 0,
          toolName: readToolName,
          toolVersion: readToolVersion,
          inputSchemaHash: readToolSchemaHash,
          canonicalInputHash,
          mode: "read",
          requiresApproval: false,
          status: "queued",
          input: readToolInput as never,
          idempotencyKey: readIdempotencyKey,
          attemptNo: 1,
          createdAt: now,
        },
        permit,
      );
    },
    "immediate",
  );

  const leaseManager = new TaskLeaseManager(database, {
    now: () => new Date(now),
    leaseTtlMs: 60_000,
  });
  const lease = leaseManager.claim(taskId, `worker-${suffix}`);
  if (lease.leaseToken === null) {
    throw new Error("Fixture lease token is missing.");
  }
  const snapshot = new TaskSnapshotReader(database).load(taskId);
  const authority = new ExecutionAuthority();
  return {
    database,
    unitOfWork: new RecoveryEvidenceUnitOfWork(
      database,
      () => authority.assertActive(),
      leaseManager,
    ),
    stateTransitions: new RecoveryEvidenceStateTransitionUnitOfWork(
      database,
      () => authority.assertActive(),
      leaseManager,
    ),
    leaseManager,
    authority,
    ownership: {
      taskId,
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
    },
    taskId,
    reviewId,
    originalToolRunId: originalRunId,
    evidenceSubmissionId: submissionId,
    executionPlanId,
    planStepId,
    readToolRunId,
    modelCallId: modelCall.id,
    expectedTaskVersion: snapshot.task.version,
    expectedDecisionVersion: 1,
    verificationCheckId,
    allowlistVersion,
    readToolName,
    readToolVersion,
    readToolSchemaHash,
    readToolInput,
    canonicalInputHash,
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
