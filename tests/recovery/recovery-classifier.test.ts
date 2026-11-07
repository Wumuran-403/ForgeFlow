import { describe, expect, it } from "vitest";

import {
  RecoveryClassifier,
  selectPrimaryRecoveryClassification,
  type RecoveryClassification,
  type RecoveryFinding,
} from "../../src/recovery/index.js";
import type {
  ApprovalRecord,
  ModelCallRecord,
  PlanStepRecord,
  RecoveryReviewRecord,
  TaskRecord,
  TaskSnapshot,
  ToolRunRecord,
} from "../../src/storage/index.js";

describe("RecoveryClassifier", () => {
  const classifier = new RecoveryClassifier();

  it("classifies a clean queued task as safe_to_resume", () => {
    const report = classifier.classify(baseSnapshot(), {
      fencingToken: 1,
      inspectedAt: timestamp,
    });

    expect(report).toMatchObject({
      classification: "safe_to_resume",
      recommendedNextAction: "eligible_for_resume",
      findings: [],
      blockingReasons: [],
    });
  });

  it("retains all findings while applying the required priority order", () => {
    const snapshot = baseSnapshot({
      toolRuns: [
        toolRun({ id: "read-run", mode: "read", status: "interrupted" }),
        toolRun({
          id: "write-run",
          mode: "write",
          status: "running",
          planStepId: "write-step",
        }),
      ],
      planSteps: [
        planStep({
          id: "read-step",
          kind: "read_batch",
          status: "interrupted",
        }),
        planStep({
          id: "write-step",
          kind: "write",
          status: "running",
        }),
      ],
      modelCalls: [
        modelCall({
          id: "model-requested",
          status: "requested",
        }),
      ],
    });

    const report = classifier.classify(snapshot, {
      fencingToken: 7,
      inspectedAt: timestamp,
    });

    expect(report.primaryClassification).toBe("write_outcome_unknown");
    expect(
      report.findings.map((finding) => finding.classification),
    ).toEqual(
      expect.arrayContaining([
        "write_outcome_unknown",
        "read_interrupted",
        "model_call_interrupted",
      ]),
    );
  });

  it("prioritizes state inconsistency and cancel intent", () => {
    const inconsistent = classifier.classify(
      baseSnapshot({
        toolRuns: [
          toolRun({
            id: "orphan",
            planStepId: "missing-step",
            mode: "read",
            status: "interrupted",
          }),
        ],
        task: taskRecord({
          status: "cancel_requested",
          cancelRequestedAt: timestamp,
        }),
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(inconsistent.primaryClassification).toBe(
      "state_inconsistent",
    );

    const cancelled = classifier.classify(
      baseSnapshot({
        task: taskRecord({
          status: "cancel_requested",
          cancelRequestedAt: timestamp,
        }),
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(cancelled.primaryClassification).toBe("cancel_pending");
  });

  it("identifies requested Model Calls, approvals, reviews, pause, and cancel", () => {
    const requested = classifier.classify(
      baseSnapshot({
        modelCalls: [modelCall({ status: "requested" })],
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(requested.primaryClassification).toBe(
      "model_call_interrupted",
    );

    const approval = classifier.classify(
      baseSnapshot({
        task: taskRecord({ status: "waiting_approval" }),
        planSteps: [
          planStep({
            kind: "write",
            status: "awaiting_approval",
          }),
        ],
        toolRuns: [
          toolRun({
            mode: "write",
            status: "awaiting_approval",
          }),
        ],
        approvals: [approvalRecord({ status: "pending" })],
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(approval.primaryClassification).toBe("approval_pending");

    const review = classifier.classify(
      baseSnapshot({
        task: taskRecord({ status: "waiting_review" }),
        planSteps: [
          planStep({
            kind: "write",
            status: "waiting_review",
          }),
        ],
        toolRuns: [
          toolRun({
            mode: "write",
            status: "unknown",
          }),
        ],
        recoveryReviews: [
          reviewRecord({ status: "unresolved" }),
        ],
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(review.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "review_pending",
          code: "RECOVERY_REVIEW_ACTIVE",
        }),
        expect.objectContaining({
          classification: "write_outcome_unknown",
        }),
      ]),
    );

    const paused = classifier.classify(
      baseSnapshot({
        task: taskRecord({
          status: "pause_requested",
          pauseRequestedAt: timestamp,
        }),
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(paused.primaryClassification).toBe("pause_pending");

    const cancelled = classifier.classify(
      baseSnapshot({
        task: taskRecord({
          status: "cancel_requested",
          cancelRequestedAt: timestamp,
        }),
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(cancelled.primaryClassification).toBe("cancel_pending");
  });

  it("does not include raw tool input or message content in reports", () => {
    const secret = "SUPER_SECRET_TOOL_INPUT";
    const report = classifier.classify(
      baseSnapshot({
        messages: [
          {
            id: "message-secret",
            taskId: taskId,
            sequence: 1,
            role: "user",
            content: "private user message",
            toolCallId: null,
            toolCalls: null,
            createdAt: timestamp,
          },
        ],
        toolRuns: [
          toolRun({
            mode: "write",
            status: "running",
            input: { credential: secret },
          }),
        ],
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );

    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("private user message");
  });

  it("requires exactly one Tool Message for every terminal ToolRun", () => {
    const terminalStatuses = [
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "skipped",
    ] as const;

    for (const status of terminalStatuses) {
      const missing = classifier.classify(
        baseSnapshot({
          planSteps: [planStep({ status: "completed" })],
          toolRuns: [toolRun({ status })],
        }),
        { fencingToken: 1, inspectedAt: timestamp },
      );
      expect(missing.findings).toContainEqual(
        expect.objectContaining({
          classification: "state_inconsistent",
          code:
            status === "succeeded"
              ? "SUCCEEDED_TOOL_RESULT_MESSAGE_INVALID"
              : "TERMINAL_TOOL_RESULT_MESSAGE_INVALID",
        }),
      );

      const duplicate = classifier.classify(
        baseSnapshot({
          messages: [
            messageRecord({
              id: "tool-message-1",
              role: "tool",
              toolCallId: "call-tool",
            }),
            messageRecord({
              id: "tool-message-2",
              role: "tool",
              toolCallId: "call-tool",
            }),
          ],
          planSteps: [planStep({ status: "completed" })],
          toolRuns: [toolRun({ status })],
        }),
        { fencingToken: 1, inspectedAt: timestamp },
      );
      expect(duplicate.findings).toContainEqual(
        expect.objectContaining({
          classification: "state_inconsistent",
        }),
      );
    }
  });

  it("does not require Tool Messages for queued, running, or interrupted runs", () => {
    for (const status of ["queued", "running", "interrupted"] as const) {
      const report = classifier.classify(
        baseSnapshot({
          planSteps: [planStep({ status: "running" })],
          toolRuns: [toolRun({ status })],
        }),
        { fencingToken: 1, inspectedAt: timestamp },
      );
      expect(
        report.findings.some(
          (item) =>
            item.code === "TERMINAL_TOOL_RESULT_MESSAGE_INVALID" ||
            item.code === "SUCCEEDED_TOOL_RESULT_MESSAGE_INVALID",
        ),
      ).toBe(false);
    }
  });

  it("detects non-terminal PlanStep with only terminal ToolRuns", () => {
    const report = classifier.classify(
      baseSnapshot({
        messages: [
          messageRecord({
            id: "tool-message",
            role: "tool",
            toolCallId: "call-tool",
          }),
        ],
        planSteps: [planStep({ status: "running" })],
        toolRuns: [toolRun({ status: "succeeded" })],
      }),
      { fencingToken: 1, inspectedAt: timestamp },
    );
    expect(report.primaryClassification).toBe("state_inconsistent");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "NON_TERMINAL_STEP_WITH_TERMINAL_RUNS",
      }),
    );
  });
});

describe("selectPrimaryRecoveryClassification", () => {
  it("uses the fixed priority order", () => {
    const order: RecoveryClassification[] = [
      "state_inconsistent",
      "cancel_pending",
      "write_outcome_unknown",
      "review_pending",
      "approval_pending",
      "pause_pending",
      "model_call_interrupted",
      "read_interrupted",
    ];

    for (let index = 0; index < order.length; index += 1) {
      const findings = order.slice(index).map((classification) =>
        finding(classification),
      );
      expect(selectPrimaryRecoveryClassification(findings)).toBe(
        order[index],
      );
    }
  });
});

const taskId = "task-recovery";
const timestamp = "2026-01-01T00:00:00.000Z";

function baseSnapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    task: taskRecord(),
    lease: null,
    messages: [],
    modelCalls: [],
    executionPlans: [],
    agentExecutionPlans: [],
    recoveryEvidencePlans: [],
    planSteps: [],
    toolRuns: [],
    approvals: [],
    recoveryReviews: [],
    recoveryEvidenceReads: [],
    recoveryLegacyAttestations: [],
    recoveryReviewOperations: [],
    events: [],
    checkpoints: [],
    ...overrides,
  };
}

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: taskId,
    traceId: "trace-recovery",
    status: "queued",
    objective: "Recover task",
    systemPrompt: "You are ForgeFlow.",
    currentIteration: 0,
    maxModelTurns: 10,
    maxToolCalls: 20,
    tokenUsage: { source: "unknown" },
    version: 1,
    cancelRequestedAt: null,
    pauseRequestedAt: null,
    lastEventSequence: 0,
    finalAnswer: null,
    lastError: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    completedAt: null,
    ...overrides,
  };
}

function planStep(
  overrides: Partial<PlanStepRecord> = {},
): PlanStepRecord {
  return {
    id: "read-step",
    taskId,
    planId: "plan-recovery",
    stepIndex: 0,
    kind: "read_batch",
    status: "running",
    version: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function toolRun(
  overrides: Partial<ToolRunRecord> = {},
): ToolRunRecord {
  const mode = overrides.mode ?? "read";
  return {
    id: "tool-run",
    taskId,
    planStepId: "read-step",
    toolCallId: "call-tool",
    originalIndex: 0,
    toolName: "bom_get_items",
    toolVersion: "1",
    inputSchemaHash: `sha256:${"a".repeat(64)}`,
    canonicalInputHash: `sha256:${"b".repeat(64)}`,
    mode,
    requiresApproval: mode === "write",
    status: "running",
    input: {},
    output: null,
    error: null,
    idempotencyKey: `sha256:${"c".repeat(64)}`,
    attemptNo: 1,
    startedAt: timestamp,
    finishedAt: null,
    version: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function modelCall(
  overrides: Partial<ModelCallRecord> = {},
): ModelCallRecord {
  return {
    id: "model-call",
    taskId,
    iteration: 1,
    attemptNo: 1,
    status: "requested",
    request: {
      model: "mock-model",
      messages: [],
      tools: [],
    },
    response: null,
    usage: null,
    finishReason: null,
    providerRequestId: null,
    durationMs: null,
    error: null,
    startedAt: timestamp,
    finishedAt: null,
    ...overrides,
  };
}

function approvalRecord(
  overrides: Partial<ApprovalRecord> = {},
): ApprovalRecord {
  return {
    id: "approval",
    taskId,
    toolRunId: "tool-run",
    status: "pending",
    toolVersion: "1",
    canonicalInputHash: `sha256:${"b".repeat(64)}`,
    request: {},
    reason: null,
    requestedAt: timestamp,
    expiresAt: null,
    decidedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    ...overrides,
  };
}

function reviewRecord(
  overrides: Partial<RecoveryReviewRecord> = {},
): RecoveryReviewRecord {
  return {
    id: "review",
    taskId,
    toolRunId: "tool-run",
    status: "unresolved",
    note: null,
    sourceType: "manual_review",
    evidenceRef: "audit://review",
    reviewProtocolVersion: 0,
    decisionVersion: 0,
    evidencePayloadDigest: null,
    evidencePayloadType: null,
    evidenceDigestProtocol: null,
    evidenceEnvelopeDigest: null,
    actorId: null,
    verifierId: null,
    verificationId: null,
    sourceObservedAt: null,
    submittedAt: null,
    verifiedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    decidedAt: timestamp,
    ...overrides,
  };
}

function finding(
  classification: RecoveryClassification,
): RecoveryFinding {
  return {
    classification,
    code: classification.toUpperCase(),
    summary: classification,
    entityType: "task",
    entityId: taskId,
  };
}

function messageRecord(input: {
  readonly id: string;
  readonly role: "user" | "tool";
  readonly toolCallId?: string;
}) {
  return {
    id: input.id,
    taskId,
    sequence: 1,
    role: input.role,
    content: input.role === "tool" ? '{"status":"succeeded"}' : "message",
    toolCallId: input.toolCallId ?? null,
    toolCalls: null,
    createdAt: timestamp,
  } as const;
}
