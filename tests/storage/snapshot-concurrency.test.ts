import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ModelResponse } from "../../src/provider/types.js";
import {
  ApprovalRepository,
  CheckpointStore,
  closeDatabase,
  EventRepository,
  ExecutionPlanRepository,
  ExecutionUnitOfWork,
  MessageRepository,
  migrateStorage,
  openDatabase,
  PlanStepRepository,
  RecoveryReviewRepository,
  runInTransaction,
  SequenceAllocator,
  TaskRepository,
  TaskLeaseRepository,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let readerDatabase: ForgeFlowDatabase | undefined;
let writerDatabase: ForgeFlowDatabase | undefined;

afterEach(() => {
  if (readerDatabase !== undefined) {
    closeDatabase(readerDatabase);
    readerDatabase = undefined;
  }
  if (writerDatabase !== undefined) {
    closeDatabase(writerDatabase);
    writerDatabase = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
  vi.restoreAllMocks();
});

describe("TaskSnapshot read consistency", () => {
  it("keeps one WAL snapshot while another connection commits", () => {
    temporaryDatabase = createTemporaryDatabase();
    readerDatabase = openDatabase(temporaryDatabase.path);
    migrateStorage(readerDatabase);

    const unitOfWork = new ExecutionUnitOfWork(readerDatabase);
    unitOfWork.createTask({
      taskId: "task-snapshot",
      traceId: "trace-snapshot",
      objective: "Read a consistent BOM snapshot",
      systemPrompt: "You are ForgeFlow.",
      maxModelTurns: 10,
      maxToolCalls: 20,
    });

    writerDatabase = openDatabase(temporaryDatabase.path);
    const writer = writerDatabase;
    const originalGet = TaskRepository.prototype.get;
    let injectedWrite = false;

    vi.spyOn(TaskRepository.prototype, "get").mockImplementation(
      function (this: TaskRepository, taskId: string) {
        const task = originalGet.call(this, taskId);
        if (!injectedWrite) {
          injectedWrite = true;
          expect(readerDatabase?.inTransaction).toBe(true);
          appendSnapshotData(writer, taskId);
        }
        return task;
      },
    );

    const first = new TaskSnapshotReader(readerDatabase).load(
      "task-snapshot",
    );

    expect(first.task.lastEventSequence).toBe(1);
    expect(first.messages).toHaveLength(2);
    expect(first.events).toHaveLength(1);
    expect(first.checkpoints).toHaveLength(1);

    vi.restoreAllMocks();
    const second = new TaskSnapshotReader(readerDatabase).load(
      "task-snapshot",
    );

    expect(second.task.lastEventSequence).toBe(2);
    expect(second.messages).toHaveLength(3);
    expect(second.events).toHaveLength(2);
    expect(second.checkpoints).toHaveLength(2);
    expect(second.messages.at(-1)?.content).toBe(
      "Committed by the writer connection",
    );
  });

  it("keeps lease state on the same WAL snapshot", () => {
    temporaryDatabase = createTemporaryDatabase();
    readerDatabase = openDatabase(temporaryDatabase.path);
    migrateStorage(readerDatabase);
    new ExecutionUnitOfWork(readerDatabase).createTask({
      taskId: "task-snapshot",
      traceId: "trace-snapshot",
      objective: "Read a consistent lease snapshot",
      systemPrompt: "You are ForgeFlow.",
      maxModelTurns: 10,
      maxToolCalls: 20,
    });

    writerDatabase = openDatabase(temporaryDatabase.path);
    const originalGet = TaskRepository.prototype.get;
    let injectedWrite = false;
    vi.spyOn(TaskRepository.prototype, "get").mockImplementation(
      function (this: TaskRepository, taskId: string) {
        const task = originalGet.call(this, taskId);
        if (!injectedWrite) {
          injectedWrite = true;
          expect(readerDatabase?.inTransaction).toBe(true);
          new TaskLeaseManager(writerDatabase as ForgeFlowDatabase, {
            now: () => new Date("2026-01-01T00:00:00.000Z"),
          }).claim(taskId, "worker-b");
        }
        return task;
      },
    );

    const first = new TaskSnapshotReader(readerDatabase).load(
      "task-snapshot",
    );
    expect(first.lease).toBeNull();

    vi.restoreAllMocks();
    const second = new TaskSnapshotReader(readerDatabase).load(
      "task-snapshot",
    );
    expect(second.lease).toMatchObject({
      ownerId: "worker-b",
      fencingToken: 1,
    });
  });

  it("keeps Step 3 execution tables on the same WAL snapshot", () => {
    temporaryDatabase = createTemporaryDatabase();
    readerDatabase = openDatabase(temporaryDatabase.path);
    migrateStorage(readerDatabase);
    createInitialPlan(readerDatabase);

    writerDatabase = openDatabase(temporaryDatabase.path);
    const writer = writerDatabase;
    const originalListByTask =
      ExecutionPlanRepository.prototype.listByTask;
    let injectedWrite = false;

    vi.spyOn(
      ExecutionPlanRepository.prototype,
      "listByTask",
    ).mockImplementation(
      function (this: ExecutionPlanRepository, taskId: string) {
        const plans = originalListByTask.call(this, taskId);
        if (!injectedWrite) {
          injectedWrite = true;
          expect(readerDatabase?.inTransaction).toBe(true);
          appendStep3SnapshotData(writer, taskId, plans[0]?.id as string);
        }
        return plans;
      },
    );

    const first = new TaskSnapshotReader(readerDatabase).load(
      "task-snapshot",
    );
    expect(first.lease).toBeNull();
    expect(first.executionPlans).toHaveLength(1);
    expect(first.executionPlans[0]?.status).toBe("active");
    expect(first.messages).toHaveLength(3);
    expect(first.events).toHaveLength(5);
    expect(first.checkpoints).toHaveLength(3);
    expect(first.planSteps).toHaveLength(1);
    expect(first.toolRuns).toHaveLength(1);
    expect(first.approvals).toHaveLength(0);
    expect(first.recoveryReviews).toHaveLength(0);

    vi.restoreAllMocks();
    const second = new TaskSnapshotReader(readerDatabase).load(
      "task-snapshot",
    );
    expect(second.lease).toMatchObject({
      ownerId: "snapshot-worker",
      fencingToken: 1,
    });
    expect(second.executionPlans).toHaveLength(1);
    expect(second.executionPlans[0]?.status).toBe("completed");
    expect(second.messages).toHaveLength(4);
    expect(second.events).toHaveLength(6);
    expect(second.checkpoints).toHaveLength(4);
    expect(second.planSteps).toHaveLength(4);
    expect(second.toolRuns).toHaveLength(4);
    expect(second.approvals).toHaveLength(1);
    expect(second.recoveryReviews).toHaveLength(1);
    expect(
      second.planSteps.map((step) => step.stepIndex),
    ).toEqual([0, 1, 2, 3]);
  });
});

function appendSnapshotData(
  database: ForgeFlowDatabase,
  taskId: string,
): void {
  runInTransaction(
    database,
    () => {
      const permit = createStorageWritePermit(database);
      const sequences = new SequenceAllocator(database);
      const now = "2026-01-01T00:00:03.000Z";
      const message = new MessageRepository(database, sequences).append(
        {
          taskId,
          role: "user",
          content: "Committed by the writer connection",
        },
        now,
        permit,
      );
      const event = new EventRepository(database, sequences).append(
        {
          taskId,
          traceId: "trace-snapshot",
          type: "snapshot.concurrent_write",
          payload: { messageSequence: message.sequence },
        },
        now,
        permit,
      );
      new CheckpointStore(database, sequences).append(
        {
          taskId,
          reason: "snapshot_concurrent_write",
          taskStatus: "queued",
          lastMessageSequence: message.sequence,
          modelIteration: 0,
          lastEventSequence: event.sequence,
          budget: {
            maxModelTurns: 10,
            maxToolCalls: 20,
          },
          metadata: {},
        },
        now,
        permit,
      );
    },
    "immediate",
  );
}

function createInitialPlan(database: ForgeFlowDatabase): void {
  const unitOfWork = new ExecutionUnitOfWork(database);
  unitOfWork.createTask({
    taskId: "task-snapshot",
    traceId: "trace-snapshot",
    objective: "Read a consistent execution snapshot",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
  const modelCall = unitOfWork.beginModelCall({
    taskId: "task-snapshot",
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Create a plan" }],
      tools: [],
    },
  });
  const inputSchema = z.object({}).strict();
  const response: ModelResponse = {
    message: {
      role: "assistant",
      content: "Plan prepared.",
      toolCalls: [
        {
          id: "call-initial",
          name: "bom_get_items",
          arguments: {},
        },
      ],
    },
    usage: { source: "provider" },
  };
  unitOfWork.completeModelCallWithPlan({
    modelCallId: modelCall.id,
    response,
    durationMs: 10,
    plan: {
      id: "plan-snapshot",
      version: 1,
      steps: [
        {
          id: "step-initial",
          stepIndex: 0,
          kind: "read_batch",
        },
      ],
      toolRuns: [
        {
          id: "run-initial",
          planStepId: "step-initial",
          toolCallId: "call-initial",
          originalIndex: 0,
          toolName: "bom_get_items",
          toolVersion: "1",
          inputSchemaHash: computeToolInputSchemaHash(inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "read",
          requiresApproval: false,
          input: {},
        },
      ],
    },
  });
}

function appendStep3SnapshotData(
  database: ForgeFlowDatabase,
  taskId: string,
  planId: string,
): void {
  runInTransaction(
    database,
    () => {
      const permit = createStorageWritePermit(database);
      const now = "2026-01-01T00:00:03.000Z";
      const sequences = new SequenceAllocator(database);
      const inputSchemaHash = `sha256:${"a".repeat(64)}`;
      const canonicalInputHash = computeCanonicalInputHash({});
      const planSteps = new PlanStepRepository(database);
      const toolRuns = new ToolRunRepository(database);

      new TaskLeaseRepository(database).claim(
        {
          taskId,
          ownerId: "snapshot-worker",
          leaseToken: "snapshot-lease-token",
          claimedAt: now,
          expiresAt: "2026-01-01T00:01:00.000Z",
        },
        permit,
      );

      planSteps.insert(
        {
          id: "step-late-read",
          taskId,
          planId,
          stepIndex: 1,
          kind: "read_batch",
          status: "queued",
          createdAt: now,
        },
        permit,
      );
      toolRuns.createIntent(
        {
          id: "run-late-read",
          taskId,
          planStepId: "step-late-read",
          toolCallId: "call-late-read",
          originalIndex: 1,
          toolName: "bom_get_items",
          toolVersion: "1",
          inputSchemaHash,
          canonicalInputHash,
          mode: "read",
          requiresApproval: false,
          status: "queued",
          input: {},
          idempotencyKey: `sha256:${"b".repeat(64)}`,
          attemptNo: 1,
          createdAt: now,
        },
        permit,
      );

      planSteps.insert(
        {
          id: "step-late-approval",
          taskId,
          planId,
          stepIndex: 2,
          kind: "write",
          status: "awaiting_approval",
          createdAt: now,
        },
        permit,
      );
      toolRuns.createIntent(
        {
          id: "run-late-approval",
          taskId,
          planStepId: "step-late-approval",
          toolCallId: "call-late-approval",
          originalIndex: 2,
          toolName: "bom_update",
          toolVersion: "1",
          inputSchemaHash,
          canonicalInputHash,
          mode: "write",
          requiresApproval: true,
          status: "queued",
          input: {},
          idempotencyKey: `sha256:${"c".repeat(64)}`,
          attemptNo: 1,
          createdAt: now,
        },
        permit,
      );
      new ApprovalRepository(database).createPending(
        {
          id: "approval-late",
          taskId,
          toolRunId: "run-late-approval",
          toolVersion: "1",
          canonicalInputHash,
          request: { description: "Late approval" },
          requestedAt: now,
          expiresAt: null,
        },
        permit,
      );

      planSteps.insert(
        {
          id: "step-late-review",
          taskId,
          planId,
          stepIndex: 3,
          kind: "write",
          status: "waiting_review",
          createdAt: now,
        },
        permit,
      );
      toolRuns.createIntent(
        {
          id: "run-late-review",
          taskId,
          planStepId: "step-late-review",
          toolCallId: "call-late-review",
          originalIndex: 3,
          toolName: "bom_update",
          toolVersion: "1",
          inputSchemaHash,
          canonicalInputHash,
          mode: "write",
          requiresApproval: true,
          status: "queued",
          input: {},
          idempotencyKey: `sha256:${"d".repeat(64)}`,
          attemptNo: 1,
          createdAt: now,
        },
        permit,
      );
      toolRuns.transition(
        "run-late-review",
        ["queued"],
        {
          status: "running",
          startedAt: now,
          updatedAt: now,
        },
        permit,
      );
      toolRuns.transition(
        "run-late-review",
        ["running"],
        {
          status: "unknown",
          finishedAt: now,
          updatedAt: now,
          error: {
            code: "WRITE_OUTCOME_UNKNOWN",
            message: "Write outcome is unknown.",
            details: [],
          },
        },
        permit,
      );
      new RecoveryReviewRepository(database).createPending(
        {
          id: "review-late",
          taskId,
          toolRunId: "run-late-review",
          note: null,
          createdAt: now,
        },
        permit,
      );

      database
        .prepare(
          `
            UPDATE execution_plans
            SET status = 'completed', updated_at = ?
            WHERE id = ?
          `,
        )
        .run(now, planId);
      const message = new MessageRepository(database, sequences).append(
        {
          taskId,
          role: "user",
          content: "Committed together with the execution snapshot.",
        },
        now,
        permit,
      );
      const event = new EventRepository(database, sequences).append(
        {
          taskId,
          traceId: "trace-snapshot",
          type: "snapshot.complete_commit",
          payload: { messageSequence: message.sequence },
        },
        now,
        permit,
      );
      new CheckpointStore(database, sequences).append(
        {
          taskId,
          reason: "snapshot_complete_commit",
          taskStatus: "running",
          lastMessageSequence: message.sequence,
          modelIteration: 1,
          planVersion: 1,
          lastEventSequence: event.sequence,
          budget: { maxModelTurns: 10, maxToolCalls: 20 },
          metadata: {},
        },
        now,
        permit,
      );
    },
    "immediate",
  );
}
