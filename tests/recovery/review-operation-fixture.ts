import {
  ExecutionUnitOfWork,
  RecoveryReviewRepository,
  runInTransaction,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { computeCanonicalInputHash } from "../../src/tools/fingerprint.js";

export interface RecoveryReviewFixture {
  readonly taskId: string;
  readonly reviewId: string;
  readonly toolRunId: string;
  readonly taskVersion: number;
}

export function createRecoveryReviewFixture(
  database: ForgeFlowDatabase,
  suffix: string,
  options: {
    readonly reviewProtocolVersion?: number;
  } = {},
): RecoveryReviewFixture {
  const taskId = `task-review-${suffix}`;
  const planId = `plan-review-${suffix}`;
  const planStepId = `step-review-${suffix}`;
  const toolRunId = `run-review-${suffix}`;
  const toolCallId = `call-review-${suffix}`;
  const reviewId = `review-${suffix}`;
  const unitOfWork = new ExecutionUnitOfWork(database);

  unitOfWork.createTask({
    taskId,
    traceId: `trace-review-${suffix}`,
    objective: "Exercise lease-owned recovery review operations.",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
  const modelCall = unitOfWork.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Perform a write." }],
      tools: [],
    },
  });
  unitOfWork.completeModelCallWithPlan({
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
      id: planId,
      version: 1,
      steps: [
        {
          id: planStepId,
          stepIndex: 0,
          kind: "write",
        },
      ],
      toolRuns: [
        {
          id: toolRunId,
          planStepId,
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
  unitOfWork.beginToolRun({
    toolRunId,
    status: "running",
  });
  unitOfWork.completeToolRun({
    toolRunId,
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
      new RecoveryReviewRepository(database).createPending(
        {
          id: reviewId,
          taskId,
          toolRunId,
          note: "Review fixture.",
          reviewProtocolVersion:
            options.reviewProtocolVersion ?? 1,
          decisionVersion: 0,
          actorId: "reviewer-host",
          submittedAt: timestamp,
          createdAt: timestamp,
        },
        permit,
      );
    },
    "immediate",
  );

  const snapshot = new TaskSnapshotReader(database).load(taskId);
  return {
    taskId,
    reviewId,
    toolRunId,
    taskVersion: snapshot.task.version,
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

export const reviewOperationTimestamp = "2026-01-01T00:00:00.000Z";
const timestamp = reviewOperationTimestamp;
