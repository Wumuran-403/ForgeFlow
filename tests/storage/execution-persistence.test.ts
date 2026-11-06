import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ModelRequest, ModelResponse } from "../../src/provider/types.js";
import {
  ApprovalRepository,
  closeDatabase,
  ExecutionPlanRepository,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  PlanStepRepository,
  RecoveryReviewRepository,
  runInTransaction,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
  type JsonValue,
  type SynchronousOperation,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  computeCanonicalInputHash,
  computeIdempotencyKey,
  computeToolDefinitionFingerprint,
} from "../../src/tools/fingerprint.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

const readInputSchema = z.object({}).strict();
const writeInputSchema = z
  .object({
    revision: z.string().trim().min(1),
    note: z.string().optional(),
  })
  .strict();

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
let unitOfWork: ExecutionUnitOfWork | undefined;
let registry: ToolRegistry | undefined;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  unitOfWork = new ExecutionUnitOfWork(database);
  registry = createTestRegistry();
});

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
  unitOfWork = undefined;
  registry = undefined;
});

describe("Step 3 execution persistence", () => {
  it("persists a model assistant message, plan, tool definition, and hashes atomically", () => {
    const fixture = createPlanFixture("write");
    const snapshot = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");

    expect(snapshot.executionPlans).toHaveLength(1);
    expect(snapshot.executionPlans[0]).toMatchObject({
      id: fixture.planId,
      version: 1,
      sourceModelCallId: fixture.modelCallId,
      status: "active",
    });
    expect(snapshot.planSteps).toHaveLength(1);
    expect(snapshot.planSteps[0]).toMatchObject({
      id: fixture.planStepId,
      kind: "write",
      status: "queued",
    });
    expect(snapshot.toolRuns).toHaveLength(1);
    expect(snapshot.toolRuns[0]).toMatchObject({
      id: fixture.toolRunId,
      toolCallId: fixture.toolCallId,
      originalIndex: 0,
      toolVersion: "2.0",
      mode: "write",
      requiresApproval: true,
      status: "queued",
      canonicalInputHash: computeCanonicalInputHash(fixture.input),
    });
    expect(snapshot.toolRuns[0]?.inputSchemaHash).toMatch(
      /^sha256:[0-9a-f]{64}$/,
    );
    expect(snapshot.toolRuns[0]?.idempotencyKey).toBe(
      computeIdempotencyKey({
        taskId: "task-step3",
        planVersion: 1,
        originalIndex: 0,
        toolName: "bom_update",
        toolVersion: "2.0",
        inputSchemaHash: snapshot.toolRuns[0]?.inputSchemaHash as string,
        canonicalInputHash: fixture.canonicalInputHash,
      }),
    );
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "assistant",
      toolCalls: [{ id: fixture.toolCallId }],
    });
    expect(snapshot.events.map((event) => event.type)).toEqual(
      expect.arrayContaining([
        "llm.responded",
        "plan.created",
        "tool.queued",
      ]),
    );
    expect(snapshot.checkpoints.at(-1)?.reason).toBe(
      "model_response_plan",
    );
  });

  it("rolls back assistant, plan, tool runs, events, and checkpoint on failure", () => {
    const setup = prepareModelTurn("read");
    database?.exec(
      `
        CREATE TRIGGER reject_tool_run
        BEFORE INSERT ON tool_runs
        BEGIN
          SELECT RAISE(ABORT, 'tool run rejected');
        END
      `,
    );

    expect(() =>
      unitOfWork?.completeModelCallWithPlan(setup.input),
    ).toThrow("tool run rejected");

    const snapshot = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    expect(snapshot.modelCalls[0]?.status).toBe("requested");
    expect(snapshot.messages.some((message) => message.role === "assistant")).toBe(
      false,
    );
    expect(snapshot.executionPlans).toHaveLength(0);
    expect(snapshot.planSteps).toHaveLength(0);
    expect(snapshot.toolRuns).toHaveLength(0);
    expect(snapshot.events.some((event) => event.type === "plan.created")).toBe(
      false,
    );
  });

  it("rejects every cross-task composite relationship", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.createTask({
      taskId: "task-other",
      traceId: "trace-other",
      objective: "Other task",
      systemPrompt: "You are ForgeFlow.",
      maxModelTurns: 10,
      maxToolCalls: 20,
    });
    const otherModelCall = unitOfWork?.beginModelCall({
      taskId: "task-other",
      iteration: 1,
      request: modelRequest,
    });
    const activeDatabase = database as ForgeFlowDatabase;

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new ExecutionPlanRepository(activeDatabase).insert(
          {
            id: "plan-cross-model-call",
            taskId: "task-step3",
            version: 2,
            sourceModelCallId: otherModelCall?.id as string,
            status: "active",
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new PlanStepRepository(activeDatabase).insert(
          {
            id: "step-cross-task",
            taskId: "task-other",
            planId: fixture.planId,
            stepIndex: 1,
            kind: "read_batch",
            status: "queued",
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new ToolRunRepository(activeDatabase).createIntent(
          {
            id: "run-cross-task",
            taskId: "task-other",
            planStepId: fixture.planStepId,
            toolCallId: "call-cross-task",
            originalIndex: 1,
            toolName: "bom_update",
            toolVersion: "2.0",
            inputSchemaHash: hashA,
            canonicalInputHash: hashB,
            mode: "write",
            requiresApproval: true,
            status: "queued",
            input: fixture.input,
            idempotencyKey: hashC,
            attemptNo: 1,
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new ToolRunRepository(activeDatabase).createIntent(
          {
            id: "run-mode-mismatch",
            taskId: "task-step3",
            planStepId: fixture.planStepId,
            toolCallId: "call-mode-mismatch",
            originalIndex: 1,
            toolName: "bom_get_items",
            toolVersion: "1",
            inputSchemaHash: hashA,
            canonicalInputHash: hashB,
            mode: "read",
            requiresApproval: false,
            status: "queued",
            input: {},
            idempotencyKey: hashC,
            attemptNo: 1,
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow(/does not match plan step kind/i);

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new ApprovalRepository(activeDatabase).createPending(
          {
            id: "approval-cross-task",
            taskId: "task-other",
            toolRunId: fixture.toolRunId,
            toolVersion: "1",
            canonicalInputHash: fixture.canonicalInputHash,
            request: fixture.input,
            requestedAt: timestamp,
            expiresAt: null,
          },
          permit,
        ),
      ),
    ).toThrow();

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new RecoveryReviewRepository(activeDatabase).createPending(
          {
            id: "review-cross-task",
            taskId: "task-other",
            toolRunId: fixture.toolRunId,
            note: null,
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();
  });

  it("persists approval, tool result, tool message, and plan-step completion atomically", () => {
    const fixture = createPlanFixture("write");
    expect(() =>
      unitOfWork?.requestApproval({
        toolRunId: fixture.toolRunId,
        request: {
          toolName: "bom_update",
          description: "Update BOM revision",
          input: fixture.input,
        },
      }),
    ).not.toThrow();

    let snapshot = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    const approval = snapshot.approvals[0];
    expect(approval).toMatchObject({
      status: "pending",
      toolVersion: "2.0",
      canonicalInputHash: fixture.canonicalInputHash,
    });

    expect(() =>
      unitOfWork?.decideApproval({
        approvalId: approval?.id as string,
        status: "approved",
        reason: "Reviewed locally",
      }),
    ).not.toThrow();
    const approvedSnapshot = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    expect(approvedSnapshot.task.status).toBe("waiting_approval");
    expect(approvedSnapshot.toolRuns[0]?.status).toBe("queued");
    expect(approvedSnapshot.planSteps[0]?.status).toBe("queued");
    expect(
      approvedSnapshot.events.some((event) => event.type === "tool.started"),
    ).toBe(false);
    expect(() =>
      unitOfWork?.beginToolRun({
        toolRunId: fixture.toolRunId,
        status: "running",
      }),
    ).not.toThrow();
    expect(() =>
      unitOfWork?.completeToolRun({
        toolRunId: fixture.toolRunId,
        status: "succeeded",
        output: { revision: "B", updated: true },
      }),
    ).not.toThrow();

    snapshot = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    expect(snapshot.approvals[0]?.status).toBe("approved");
    expect(snapshot.toolRuns[0]).toMatchObject({
      status: "succeeded",
      output: { revision: "B", updated: true },
    });
    expect(snapshot.planSteps[0]?.status).toBe("completed");
    expect(snapshot.messages.at(-1)).toMatchObject({
      role: "tool",
      toolCallId: fixture.toolCallId,
    });
    expect(snapshot.events.at(-1)?.type).toBe("tool.succeeded");
  });

  it("rolls back tool result, message, and plan-step status together", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.beginToolRun({
      toolRunId: fixture.toolRunId,
      status: "running",
    });
    database?.exec(
      `
        CREATE TRIGGER reject_tool_result_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'tool_result'
        BEGIN
          SELECT RAISE(ABORT, 'tool result checkpoint rejected');
        END
      `,
    );

    expect(() =>
      unitOfWork?.completeToolRun({
        toolRunId: fixture.toolRunId,
        status: "succeeded",
        output: { updated: true },
      }),
    ).toThrow("tool result checkpoint rejected");

    const snapshot = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(snapshot.planSteps[0]?.status).toBe("running");
    expect(
      snapshot.messages.some((message) => message.role === "tool"),
    ).toBe(false);
    expect(
      snapshot.events.some((event) => event.type === "tool.succeeded"),
    ).toBe(false);
  });

  it("rolls back approval, tool state, and task state together", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.requestApproval({
      toolRunId: fixture.toolRunId,
      request: { toolName: "bom_update" },
    });
    const before = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    database?.exec(
      `
        CREATE TRIGGER reject_approval_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'approval_decided'
        BEGIN
          SELECT RAISE(ABORT, 'approval checkpoint rejected');
        END
      `,
    );

    expect(() =>
      unitOfWork?.decideApproval({
        approvalId: before.approvals[0]?.id as string,
        status: "approved",
      }),
    ).toThrow("approval checkpoint rejected");

    const after = new TaskSnapshotReader(
      database as ForgeFlowDatabase,
    ).load("task-step3");
    expect(after.approvals[0]?.status).toBe("pending");
    expect(after.toolRuns[0]?.status).toBe("awaiting_approval");
    expect(after.task.status).toBe("waiting_approval");
  });

  it("rejects a stale approval binding and keeps only one approval row", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.requestApproval({
      toolRunId: fixture.toolRunId,
      request: { toolName: "bom_update" },
    });
    const activeDatabase = database as ForgeFlowDatabase;
    const snapshot = new TaskSnapshotReader(activeDatabase).load("task-step3");
    const approval = snapshot.approvals[0];

    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE approvals SET canonical_input_hash = ? WHERE id = ?",
        )
        .run(hashA, approval?.id),
    ).toThrowError(/does not match/i);
    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE approvals SET tool_version = '9.0' WHERE id = ?",
        )
        .run(approval?.id),
    ).toThrowError(/does not match/i);
    expect(
      new ApprovalRepository(activeDatabase).get(approval?.id as string)
        .canonicalInputHash,
    ).toBe(fixture.canonicalInputHash);

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new ApprovalRepository(activeDatabase).createPending(
          {
            id: "approval-duplicate",
            taskId: "task-step3",
            toolRunId: fixture.toolRunId,
            toolVersion: "2.0",
            canonicalInputHash: fixture.canonicalInputHash,
            request: fixture.input,
            requestedAt: timestamp,
            expiresAt: null,
          },
          permit,
        ),
      ),
    ).toThrow();
  });

  it("blocks completed steps until an unknown write is reviewed as successful", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.beginToolRun({
      toolRunId: fixture.toolRunId,
      status: "running",
    });

    expect(() =>
      unitOfWork?.completeToolRun({
        toolRunId: fixture.toolRunId,
        status: "unknown",
        error: {
          code: "WRITE_OUTCOME_UNKNOWN",
          message: "Write outcome is unknown.",
          details: [],
        },
        planStepStatus: "waiting_review",
      }),
    ).not.toThrow();
    expect(() =>
      unitOfWork?.requestRecoveryReview({
        toolRunId: fixture.toolRunId,
        note: "Verify the external BOM revision.",
      }),
    ).not.toThrow();

    const activeDatabase = database as ForgeFlowDatabase;
    const review = new RecoveryReviewRepository(
      activeDatabase,
    ).getByToolRun(fixture.toolRunId);
    expect(review?.status).toBe("pending");
    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new RecoveryReviewRepository(activeDatabase).createPending(
          {
            id: "review-duplicate",
            taskId: "task-step3",
            toolRunId: fixture.toolRunId,
            note: null,
            createdAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrow();
    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new PlanStepRepository(activeDatabase).updateStatus(
          fixture.planStepId,
          "completed",
          timestamp,
          permit,
        ),
      ),
    ).toThrow(/blocking tool run/);

    unitOfWork?.decideRecoveryReview({
      recoveryReviewId: review?.id as string,
      status: "unresolved",
      note: "Audit still in progress.",
      sourceType: "manual_review",
      evidenceRef: null,
    });
    const unresolvedSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-step3",
    );
    expect(unresolvedSnapshot.task.status).toBe("waiting_review");
    expect(unresolvedSnapshot.planSteps[0]?.status).toBe("waiting_review");
    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new PlanStepRepository(activeDatabase).updateStatus(
          fixture.planStepId,
          "completed",
          timestamp,
          permit,
        ),
      ),
    ).toThrow(/blocking tool run/);

    unitOfWork?.decideRecoveryReview({
      recoveryReviewId: review?.id as string,
      status: "confirmed_succeeded",
      note: "External audit confirmed success.",
      sourceType: "manual_review",
      evidenceRef: "audit://bom/123",
    });
    const snapshot = new TaskSnapshotReader(activeDatabase).load("task-step3");
    expect(snapshot.recoveryReviews).toHaveLength(1);
    expect(snapshot.recoveryReviews[0]?.status).toBe(
      "confirmed_succeeded",
    );
    expect(snapshot.task.status).toBe("waiting_review");
    expect(snapshot.planSteps[0]?.status).toBe("completed");
    expect(snapshot.toolRuns[0]).toMatchObject({
      status: "unknown",
      output: null,
    });
    expect(
      snapshot.events.some((event) => event.type === "tool.succeeded"),
    ).toBe(false);
  });

  it("rejects completed steps for confirmed_not_executed write reviews", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.beginToolRun({
      toolRunId: fixture.toolRunId,
      status: "running",
    });
    unitOfWork?.completeToolRun({
      toolRunId: fixture.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork?.requestRecoveryReview({
      toolRunId: fixture.toolRunId,
      note: null,
    });
    const activeDatabase = database as ForgeFlowDatabase;
    const review = new RecoveryReviewRepository(
      activeDatabase,
    ).getByToolRun(fixture.toolRunId);

    unitOfWork?.decideRecoveryReview({
      recoveryReviewId: review?.id as string,
      status: "confirmed_not_executed",
      note: "The external write was not received.",
      sourceType: "manual_review",
      evidenceRef: "ticket://review/456",
    });
    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new PlanStepRepository(activeDatabase).updateStatus(
          fixture.planStepId,
          "completed",
          timestamp,
          permit,
        ),
      ),
    ).toThrow(/blocking tool run/);
    expect(
      new TaskSnapshotReader(activeDatabase).load("task-step3"),
    ).toMatchObject({
      task: { status: "waiting_review" },
      planSteps: [{ status: "failed" }],
      toolRuns: [{ status: "unknown" }],
    });
  });

  it("does not resume a task with cancel intent when a review is confirmed", () => {
    const fixture = createPlanFixture("write");
    unitOfWork?.beginToolRun({
      toolRunId: fixture.toolRunId,
      status: "running",
    });
    unitOfWork?.completeToolRun({
      toolRunId: fixture.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork?.requestRecoveryReview({
      toolRunId: fixture.toolRunId,
      note: null,
    });

    const activeDatabase = database as ForgeFlowDatabase;
    activeDatabase
      .prepare(
        `
          UPDATE tasks
          SET cancel_requested_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(timestamp, timestamp, "task-step3");
    const review = new RecoveryReviewRepository(
      activeDatabase,
    ).getByToolRun(fixture.toolRunId);

    unitOfWork?.decideRecoveryReview({
      recoveryReviewId: review?.id as string,
      status: "confirmed_succeeded",
      note: "External system confirms success.",
      sourceType: "system_verification",
      evidenceRef: "audit://external/789",
    });

    const snapshot = new TaskSnapshotReader(activeDatabase).load("task-step3");
    expect(snapshot.task).toMatchObject({
      status: "waiting_review",
      cancelRequestedAt: timestamp,
    });
    expect(snapshot.planSteps[0]?.status).toBe("completed");
    expect(snapshot.toolRuns[0]).toMatchObject({
      status: "unknown",
      output: null,
    });
    expect(
      snapshot.events.filter((event) => event.type === "tool.started"),
    ).toHaveLength(1);
    expect(
      snapshot.events.some((event) => event.type === "tool.succeeded"),
    ).toBe(false);
  });
});

interface PlanFixture {
  readonly modelCallId: string;
  readonly planId: string;
  readonly planStepId: string;
  readonly toolRunId: string;
  readonly toolCallId: string;
  readonly input: { readonly [key: string]: JsonValue };
  readonly canonicalInputHash: string;
}

function createPlanFixture(
  mode: "read" | "write",
): PlanFixture {
  const setup = prepareModelTurn(mode);
  unitOfWork?.completeModelCallWithPlan(setup.input);
  return setup.fixture;
}

function prepareModelTurn(mode: "read" | "write"): {
  readonly input: Parameters<
    ExecutionUnitOfWork["completeModelCallWithPlan"]
  >[0];
  readonly fixture: PlanFixture;
} {
  unitOfWork?.createTask({
    taskId: "task-step3",
    traceId: "trace-step3",
    objective: "Persist an execution plan",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
  const modelCall = unitOfWork?.beginModelCall({
    taskId: "task-step3",
    iteration: 1,
    request: modelRequest,
  });
  const toolName = mode === "read" ? "bom_get_items" : "bom_update";
  const input: { readonly [key: string]: JsonValue } =
    mode === "read" ? {} : { revision: "B", note: "Approved update" };
  const tool = (registry as ToolRegistry).get(toolName);
  const fingerprint = computeToolDefinitionFingerprint(tool, input);
  const toolCallId = `call-${mode}`;
  const planId = `plan-${mode}`;
  const planStepId = `step-${mode}`;
  const toolRunId = `run-${mode}`;
  const response: ModelResponse = {
    message: {
      role: "assistant",
      content: "Prepared an execution plan.",
      toolCalls: [{ id: toolCallId, name: toolName, arguments: input }],
    },
    usage: {
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      source: "provider",
    },
    finishReason: "tool_calls",
  };

  return {
    input: {
      modelCallId: modelCall?.id as string,
      response,
      durationMs: 20,
      plan: {
        id: planId,
        version: 1,
        steps: [
          {
            id: planStepId,
            stepIndex: 0,
            kind: mode === "read" ? "read_batch" : "write",
          },
        ],
        toolRuns: [
          {
            id: toolRunId,
            planStepId,
            toolCallId,
            originalIndex: 0,
            toolName,
            ...fingerprint,
            input,
          },
        ],
      },
    },
    fixture: {
      modelCallId: modelCall?.id as string,
      planId,
      planStepId,
      toolRunId,
      toolCallId,
      input,
      canonicalInputHash: fingerprint.canonicalInputHash,
    },
  };
}

function createTestRegistry(): ToolRegistry {
  const readTool: ToolDefinition<Record<string, never>> = {
    name: "bom_get_items",
    description: "Read BOM items.",
    mode: "read",
    inputSchema: readInputSchema,
    execute: () => ({}),
  };
  const writeTool: ToolDefinition<z.infer<typeof writeInputSchema>> = {
    name: "bom_update",
    description: "Update a BOM revision.",
    mode: "write",
    version: "2.0",
    inputSchema: writeInputSchema,
    execute: ({ revision }) => ({ revision }),
  };
  const toolRegistry = new ToolRegistry();
  toolRegistry.register(readTool);
  toolRegistry.register(writeTool);
  return toolRegistry;
}

function writeWithPermit<T>(
  activeDatabase: ForgeFlowDatabase,
  operation: SynchronousOperation<
    T,
    [ReturnType<typeof createStorageWritePermit>]
  >,
): T {
  return runInTransaction(
    activeDatabase,
    () => operation(createStorageWritePermit(activeDatabase)),
    "immediate",
  );
}

const timestamp = "2026-01-01T00:00:03.000Z";
const hashA = `sha256:${"a".repeat(64)}`;
const hashB = `sha256:${"b".repeat(64)}`;
const hashC = `sha256:${"c".repeat(64)}`;

const modelRequest: ModelRequest = {
  model: "mock-model",
  messages: [{ role: "user", content: "Persist an execution plan" }],
  tools: [],
};
