import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  PlanStepRepository,
  runInTransaction,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { PersistenceCoordinator } from "../../src/persistence/index.js";
import { MockLLMProvider, type MockProviderStep } from "../../src/provider/mock-provider.js";
import type {
  GenerateOptions,
  LLMProvider,
  ModelRequest,
  ModelResponse,
} from "../../src/provider/types.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
  type WriteApprovalDecision,
  type WriteApprovalHandler,
} from "../../src/scheduler/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";
import type { ToolDefinition } from "../../src/tools/types.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
});

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("persistent AgentRunner and TaskScheduler integration", () => {
  it("persists requested Model Calls before Provider and runs Read batches in parallel", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-read");
    const executionEvents: string[] = [];
    let activeReads = 0;
    let maxActiveReads = 0;
    const registry = new ToolRegistry();
    registry.register(readTool("bom_get_items", executionEvents, async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 30));
      activeReads -= 1;
      return { items: ["U1"] };
    }));
    registry.register(readTool("inventory_lookup", executionEvents, async () => {
      activeReads += 1;
      maxActiveReads = Math.max(maxActiveReads, activeReads);
      await new Promise((resolve) => setTimeout(resolve, 1));
      activeReads -= 1;
      return { available: 10 };
    }));
    const provider = new InspectingProvider(
      [
        {
          content: "Read BOM and inventory.",
          toolCalls: [
            { id: "call-bom", name: "bom_get_items", arguments: {} },
            {
              id: "call-inventory",
              name: "inventory_lookup",
              arguments: { partNumber: "STM32" },
            },
          ],
        },
        "Reads complete.",
      ],
      () => {
        const call = new TaskSnapshotReader(activeDatabase)
          .load("task-read")
          .modelCalls.at(-1);
        expect(call?.status).toBe("requested");
      },
    );
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    const result = await coordinator.run("task-read", "worker-read");

    expect(result.status).toBe("completed");
    expect(provider.consumedResponseCount).toBe(2);
    expect(maxActiveReads).toBe(2);
    expect(executionEvents).toEqual(
      expect.arrayContaining(["bom_get_items:start", "inventory_lookup:start"]),
    );
    const snapshot = new TaskSnapshotReader(activeDatabase).load("task-read");
    expect(snapshot.task.status).toBe("completed");
    expect(snapshot.lease?.ownerId).toBeNull();
    expect(snapshot.modelCalls.map((call) => call.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(snapshot.toolRuns.map((run) => run.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(snapshot.planSteps.map((step) => step.status)).toEqual([
      "completed",
    ]);
    expect(snapshot.approvals).toHaveLength(0);
    expect(
      snapshot.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(2);
    expect(
      snapshot.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-bom", "call-inventory"]);
    expect(snapshot.events.some((event) => event.type === "tool.intent_committed")).toBe(
      true,
    );
  });

  it("keeps Writes serial, approval-gated, and persists each result", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-write");
    let activeWrites = 0;
    let maxActiveWrites = 0;
    const writeCalls: string[] = [];
    const registry = new ToolRegistry();
    registry.register(writeTool(async ({ revision }) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      writeCalls.push(revision);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeWrites -= 1;
      return { revision };
    }));
    const approvalHandler = vi.fn<WriteApprovalHandler["request"]>(
      async () => ({ status: "approved" }),
    );
    const provider = new MockLLMProvider([
      {
        content: "Update BOM twice.",
        toolCalls: [
          {
            id: "call-write-1",
            name: "bom_update",
            arguments: { revision: "A" },
          },
          {
            id: "call-write-2",
            name: "bom_update",
            arguments: { revision: "B" },
          },
        ],
      },
      "Writes complete.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      approvalHandler,
    );

    const result = await coordinator.run("task-write", "worker-write");

    expect(result.status).toBe("completed");
    expect(maxActiveWrites).toBe(1);
    expect(writeCalls).toEqual(["A", "B"]);
    expect(approvalHandler).toHaveBeenCalledTimes(2);
    const snapshot = new TaskSnapshotReader(activeDatabase).load("task-write");
    expect(snapshot.toolRuns.map((run) => run.status)).toEqual([
      "succeeded",
      "succeeded",
    ]);
    expect(snapshot.planSteps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  it("does not invoke a tool when its persisted Intent fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-intent-failure");
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register(readTool("bom_get_items", [], execute));
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_tool_intent
        BEFORE INSERT ON events
        WHEN NEW.type = 'tool.intent_committed'
        BEGIN
          SELECT RAISE(ABORT, 'intent rejected');
        END
      `,
    );
    const provider = new MockLLMProvider([
      {
        content: "Call the read tool.",
        toolCalls: [
          { id: "call-intent", name: "bom_get_items", arguments: {} },
        ],
      },
      "Could not execute.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    await expect(
      coordinator.run("task-intent-failure", "worker-intent"),
    ).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-intent-failure",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("queued");
  });

  it("records Write as unknown when result persistence fails and stops further calls", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-write-unknown");
    const execute = vi.fn(async () => ({ updated: true }));
    const registry = new ToolRegistry();
    registry.register(writeTool(execute));
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_tool_success_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'tool.succeeded'
        BEGIN
          SELECT RAISE(ABORT, 'result event rejected');
        END
      `,
    );
    const provider = new MockLLMProvider([
      {
        content: "Update BOM.",
        toolCalls: [
          {
            id: "call-write-unknown",
            name: "bom_update",
            arguments: { revision: "A" },
          },
        ],
      },
      "Must not be requested.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    const result = await coordinator.run("task-write-unknown", "worker-unknown");

    expect(result.status).toBe("write_outcome_unknown");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider.consumedResponseCount).toBe(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-write-unknown",
    );
    expect(snapshot.task.status).toBe("waiting_review");
    expect(snapshot.toolRuns[0]?.status).toBe("unknown");
    expect(snapshot.planSteps[0]?.status).toBe("waiting_review");
  });

  it("maps Write exceptions, timeouts, and non-JSON output to unknown", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const cases = [
      {
        taskId: "write-throw",
        execute: async () => {
          throw new Error("writer failed");
        },
        options: {},
      },
      {
        taskId: "write-timeout",
        execute: async () => {
          await new Promise((resolve) => setTimeout(resolve, 80));
          return { updated: true };
        },
        options: { timeoutMs: 10 },
      },
      {
        taskId: "write-bigint",
        execute: async () => ({ updated: 1n }),
        options: {},
      },
    ] as const;

    for (const testCase of cases) {
      createTask(activeDatabase, testCase.taskId);
      const registry = new ToolRegistry();
      const execute = vi.fn(testCase.execute);
      registry.register({
        ...writeTool(execute),
        ...testCase.options,
      });
      const provider = new MockLLMProvider([
        {
          content: "Update BOM.",
          toolCalls: [
            {
              id: `call-${testCase.taskId}`,
              name: "bom_update",
              arguments: { revision: "A" },
            },
          ],
        },
        "Must not be requested.",
      ]);
      const coordinator = createCoordinator(
        activeDatabase,
        registry,
        provider,
        { status: "approved" },
      );

      const result = await coordinator.run(testCase.taskId, "worker-write-case");
      expect(result.status).toBe("write_outcome_unknown");
      expect(provider.consumedResponseCount).toBe(1);
      expect(execute).toHaveBeenCalledTimes(1);
      const snapshot = new TaskSnapshotReader(activeDatabase).load(
        testCase.taskId,
      );
      expect(snapshot.toolRuns[0]?.status).toBe("unknown");
      expect(snapshot.planSteps[0]?.status).toBe("waiting_review");
      expect(snapshot.task.status).toBe("waiting_review");
    }
  });

  it("maps cancellation after Write start to unknown", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "write-cancelled-running");
    let releaseTool: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const registry = new ToolRegistry();
    registry.register(writeTool(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      return { updated: true };
    }));
    const provider = new MockLLMProvider([
      {
        content: "Update BOM.",
        toolCalls: [
          {
            id: "call-write-cancelled-running",
            name: "bom_update",
            arguments: { revision: "A" },
          },
        ],
      },
      "Must not be requested.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );
    const controller = new AbortController();
    const runPromise = coordinator.run(
      "write-cancelled-running",
      "worker-write-cancel",
      { signal: controller.signal },
    );
    await started;
    controller.abort();
    releaseTool?.();

    const result = await runPromise;
    expect(result.status).toBe("write_outcome_unknown");
    expect(provider.consumedResponseCount).toBe(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "write-cancelled-running",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("unknown");
    expect(snapshot.task.status).toBe("waiting_review");
  });

  it("keeps the running Intent when unknown persistence also fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "write-unknown-persist-fails");
    const execute = vi.fn(async () => ({ updated: true }));
    const registry = new ToolRegistry();
    registry.register(writeTool(execute));
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_write_terminal_events
        BEFORE INSERT ON events
        WHEN NEW.type IN ('tool.succeeded', 'tool.unknown')
        BEGIN
          SELECT RAISE(ABORT, 'write terminal event rejected');
        END
      `,
    );
    const provider = new MockLLMProvider([
      {
        content: "Update BOM.",
        toolCalls: [
          {
            id: "call-write-unknown-persist-fails",
            name: "bom_update",
            arguments: { revision: "A" },
          },
        ],
      },
      "Must not be requested.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    const result = await coordinator.run(
      "write-unknown-persist-fails",
      "worker-write-unknown-fail",
    );
    expect(result.status).toBe("write_outcome_unknown");
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider.consumedResponseCount).toBe(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "write-unknown-persist-fails",
    );
    expect(snapshot.task.status).toBe("running");
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(snapshot.lease?.ownerId).toBeNull();
  });

  it("persists a rejected approval as skipped without invoking the Write", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-write-rejected");
    const execute = vi.fn(async () => ({ updated: true }));
    const registry = new ToolRegistry();
    registry.register(writeTool(execute));
    const provider = new MockLLMProvider([
      {
        content: "Update BOM.",
        toolCalls: [
          {
            id: "call-write-rejected",
            name: "bom_update",
            arguments: { revision: "A" },
          },
        ],
      },
      "Update was not approved.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "rejected", reason: "Not approved in test." },
    );

    const result = await coordinator.run(
      "task-write-rejected",
      "worker-rejected",
    );

    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-write-rejected",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("skipped");
    expect(snapshot.planSteps[0]?.status).toBe("skipped");
    expect(
      snapshot.messages.find(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "call-write-rejected",
      ),
    ).toBeDefined();
  });

  it("rejects a persistent entry when no valid Lease is owned", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-no-lease");
    const registry = new ToolRegistry();
    const provider = new MockLLMProvider("unused");
    const manager = new TaskLeaseManager(activeDatabase);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
      manager,
    );

    await expect(
      coordinator.runOwned("task-no-lease", {
        taskId: "task-no-lease",
        leaseToken: "missing",
        fencingToken: 1,
      }),
    ).rejects.toThrowError(/ownership is invalid/i);
    expect(provider.consumedResponseCount).toBe(0);
  });

  it("requires recovery for every incomplete execution boundary", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    const toolExecute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register(readTool("bom_get_items", [], toolExecute));
    const provider = new MockLLMProvider("must not run");
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    createTask(activeDatabase, "gate-requested-model");
    unitOfWork.beginModelCall({
      taskId: "gate-requested-model",
      iteration: 1,
      request: {
        model: "mock-model",
        messages: [{ role: "user", content: "pending" }],
        tools: [],
      },
    });

    const runningRead = seedPersistentPlan(
      activeDatabase,
      "gate-running-read",
      "read",
    );
    unitOfWork.beginToolRun({
      toolRunId: runningRead.toolRunId,
      status: "running",
    });

    const runningWrite = seedPersistentPlan(
      activeDatabase,
      "gate-running-write",
      "write",
    );
    unitOfWork.beginToolRun({
      toolRunId: runningWrite.toolRunId,
      status: "running",
    });

    const interrupted = seedPersistentPlan(
      activeDatabase,
      "gate-interrupted-step",
      "read",
    );
    runInTransaction(
      activeDatabase,
      () => {
        const permit = createStorageWritePermit(activeDatabase);
        return new PlanStepRepository(activeDatabase).updateStatus(
          interrupted.planStepId,
          "interrupted",
          "2026-01-01T00:00:05.000Z",
          permit,
        );
      },
      "immediate",
    );

    const waitingReview = seedPersistentPlan(
      activeDatabase,
      "gate-waiting-review",
      "write",
    );
    unitOfWork.beginToolRun({
      toolRunId: waitingReview.toolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: waitingReview.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });

    const queued = seedPersistentPlan(
      activeDatabase,
      "gate-queued-intent",
      "read",
    );

    const taskIds = [
      "gate-requested-model",
      "gate-running-read",
      "gate-running-write",
      "gate-interrupted-step",
      "gate-waiting-review",
      "gate-queued-intent",
    ] as const;
    const beforeMessageCounts = new Map(
      taskIds.map((taskId) => [
        taskId,
        new TaskSnapshotReader(activeDatabase).load(taskId).messages.length,
      ]),
    );

    for (const taskId of taskIds) {
      await expect(
        coordinator.run(taskId, `worker-${taskId}`),
      ).rejects.toMatchObject({
        code: "PERSISTENT_RECOVERY_REQUIRED",
      });
      const snapshot = new TaskSnapshotReader(activeDatabase).load(taskId);
      expect(snapshot.lease?.ownerId).toBeNull();
      expect(snapshot.messages).toHaveLength(
        beforeMessageCounts.get(taskId) as number,
      );
    }

    expect(provider.consumedResponseCount).toBe(0);
    expect(toolExecute).not.toHaveBeenCalled();
    expect(
      new TaskSnapshotReader(activeDatabase).load("gate-requested-model")
        .modelCalls[0]?.status,
    ).toBe("requested");
    expect(
      new TaskSnapshotReader(activeDatabase).load("gate-running-read")
        .toolRuns[0]?.status,
    ).toBe("running");
    expect(
      new TaskSnapshotReader(activeDatabase).load("gate-waiting-review")
        .toolRuns[0]?.status,
    ).toBe("unknown");
    expect(queued.taskId).toBe("gate-queued-intent");
  });

  it("rejects expired leases and stale fencing tokens before Provider calls", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-stale-lease");
    let nowMs = Date.parse("2026-01-01T00:00:00.000Z");
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 1_000,
      now: () => new Date(nowMs),
    });
    const registry = new ToolRegistry();
    const provider = new MockLLMProvider("unused");
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
      manager,
    );
    const first = manager.claim("task-stale-lease", "worker-a");

    nowMs += 1_001;
    await expect(
      coordinator.runOwned("task-stale-lease", {
        taskId: "task-stale-lease",
        leaseToken: first.leaseToken as string,
        fencingToken: first.fencingToken,
      }),
    ).rejects.toThrowError(/ownership is invalid/i);
    expect(provider.consumedResponseCount).toBe(0);

    const replacement = manager.claim("task-stale-lease", "worker-b");
    await expect(
      coordinator.runOwned("task-stale-lease", {
        taskId: "task-stale-lease",
        leaseToken: first.leaseToken as string,
        fencingToken: first.fencingToken,
      }),
    ).rejects.toThrowError(/ownership is invalid/i);
    expect(replacement.fencingToken).toBe(first.fencingToken + 1);
    expect(provider.consumedResponseCount).toBe(0);
  });

  it("does not commit a Model Call response and assistant Message separately", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-model-atomic");
    const registry = new ToolRegistry();
    const provider = new MockLLMProvider("Final response.");
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_model_response_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'model_response'
        BEGIN
          SELECT RAISE(ABORT, 'model response checkpoint rejected');
        END
      `,
    );
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    const result = await coordinator.run("task-model-atomic", "worker-model");

    expect(result.status).toBe("failed");
    expect(provider.consumedResponseCount).toBe(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-model-atomic",
    );
    expect(snapshot.modelCalls[0]?.status).toBe("requested");
    expect(
      snapshot.messages.some((message) => message.role === "assistant"),
    ).toBe(false);
  });

  it("keeps Read result, Tool Message, and PlanStep update atomic", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-read-atomic");
    const execute = vi.fn(async () => ({ items: ["U1"] }));
    const registry = new ToolRegistry();
    registry.register(readTool("bom_get_items", [], execute));
    const provider = new MockLLMProvider([
      {
        content: "Read BOM.",
        toolCalls: [
          { id: "call-read-atomic", name: "bom_get_items", arguments: {} },
        ],
      },
      "Read failed.",
    ]);
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_read_result_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'tool_result'
        BEGIN
          SELECT RAISE(ABORT, 'read result checkpoint rejected');
        END
      `,
    );
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
    );

    const result = await coordinator.run(
      "task-read-atomic",
      "worker-read-atomic",
    );
    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("persistence_failed");
    expect(provider.consumedResponseCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-read-atomic",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(snapshot.planSteps[0]?.status).toBe("running");
    expect(
      snapshot.messages.some(
        (message) =>
          message.role === "tool" &&
          message.toolCallId === "call-read-atomic",
      ),
    ).toBe(false);
    expect(snapshot.lease?.ownerId).toBeNull();
  });

  it("heartbeats through long Provider execution and stops before release", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-heartbeat-provider");
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 120,
    });
    const registry = new ToolRegistry();
    const provider = new InspectingProvider(
      ["Finished."],
      () => undefined,
      80,
    );
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
      manager,
      20,
    );

    const result = await coordinator.run(
      "task-heartbeat-provider",
      "worker-heartbeat",
    );
    expect(result.status).toBe("completed");
    const first = new TaskSnapshotReader(activeDatabase).load(
      "task-heartbeat-provider",
    );
    const heartbeatCount = first.events.filter(
      (event) => event.type === "lease.heartbeat",
    ).length;
    expect(heartbeatCount).toBeGreaterThanOrEqual(2);
    expect(first.lease?.ownerId).toBeNull();

    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = new TaskSnapshotReader(activeDatabase).load(
      "task-heartbeat-provider",
    );
    expect(
      second.events.filter((event) => event.type === "lease.heartbeat"),
    ).toHaveLength(heartbeatCount);
  });

  it("heartbeats while ApprovalHandler is waiting", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-heartbeat-approval");
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 160,
    });
    const registry = new ToolRegistry();
    registry.register(writeTool(async ({ revision }) => ({ revision })));
    const provider = new MockLLMProvider([
      {
        content: "Update BOM.",
        toolCalls: [
          {
            id: "call-heartbeat-approval",
            name: "bom_update",
            arguments: { revision: "A" },
          },
        ],
      },
      "Done.",
    ]);
    const approvalHandler = async () => {
      await new Promise((resolve) => setTimeout(resolve, 90));
      return { status: "approved" as const };
    };
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      approvalHandler,
      manager,
      20,
    );

    await coordinator.run("task-heartbeat-approval", "worker-approval");
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-heartbeat-approval",
    );
    expect(
      snapshot.events.filter((event) => event.type === "lease.heartbeat")
        .length,
    ).toBeGreaterThanOrEqual(2);
  });

  it("stops new Provider and Tool calls after Heartbeat failure", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-heartbeat-failure");
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 120,
    });
    vi.spyOn(manager, "heartbeat").mockImplementation(() => {
      throw new Error("heartbeat failed");
    });
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = new ToolRegistry();
    registry.register(readTool("bom_get_items", [], execute));
    const provider = new InspectingProvider(
      [
        {
          content: "Read BOM.",
          toolCalls: [
            { id: "call-heartbeat-fail", name: "bom_get_items", arguments: {} },
          ],
        },
        "Must not be requested.",
      ],
      () => undefined,
      70,
    );
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
      manager,
      15,
    );

    await expect(
      coordinator.run("task-heartbeat-failure", "worker-fail"),
    ).rejects.toThrow(/heartbeat/i);
    expect(provider.callCount).toBe(1);
    expect(execute).not.toHaveBeenCalled();
  });

  it("prevents a started Write from committing after Heartbeat ownership fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-write-heartbeat");
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 200,
    });
    let writeStarted = false;
    const originalHeartbeat = manager.heartbeat.bind(manager);
    vi.spyOn(manager, "heartbeat").mockImplementation((...args) => {
      if (writeStarted) {
        throw new Error("heartbeat ownership lost");
      }
      return originalHeartbeat(...args);
    });
    const execute = vi.fn(async () => {
      writeStarted = true;
      await new Promise((resolve) => setTimeout(resolve, 80));
      return { updated: true };
    });
    const registry = new ToolRegistry();
    registry.register(writeTool(execute));
    const provider = new MockLLMProvider([
      {
        content: "Update BOM.",
        toolCalls: [
          {
            id: "call-write-heartbeat",
            name: "bom_update",
            arguments: { revision: "A" },
          },
        ],
      },
      "Must not be requested.",
    ]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
      manager,
      15,
    );

    await expect(
      coordinator.run("task-write-heartbeat", "worker-write-fail"),
    ).rejects.toThrow(/heartbeat/i);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(provider.consumedResponseCount).toBe(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-write-heartbeat",
    );
    expect(snapshot.task.status).toBe("running");
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(
      snapshot.messages.some((message) => message.role === "tool"),
    ).toBe(false);
  });

  it("cleans up the Lease after Provider and Scheduler exceptions", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-provider-error");
    const registry = new ToolRegistry();
    const providerError = new MockLLMProvider([{ error: new Error("provider failed") }]);
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      providerError,
      { status: "approved" },
    );

    const providerResult = await coordinator.run(
      "task-provider-error",
      "worker-provider-error",
    );
    expect(providerResult.status).toBe("failed");
    expect(
      new TaskSnapshotReader(activeDatabase).load("task-provider-error").lease
        ?.ownerId,
    ).toBeNull();

    createTask(activeDatabase, "task-scheduler-error");
    const schedulerProvider = new MockLLMProvider([
      {
        content: "Call a tool.",
        toolCalls: [
          { id: "call-scheduler-error", name: "bom_get_items", arguments: {} },
        ],
      },
    ]);
    registry.register(readTool("bom_get_items", [], async () => ({ ok: true })));
    const schedulerCoordinator = createCoordinator(
      activeDatabase,
      registry,
      schedulerProvider,
      { status: "approved" },
    );
    const currentScheduler = (schedulerCoordinator as unknown as {
      options: { scheduler: TaskScheduler };
    }).options.scheduler;
    vi.spyOn(currentScheduler, "execute").mockRejectedValue(
      new Error("scheduler failed"),
    );

    await expect(
      schedulerCoordinator.run("task-scheduler-error", "worker-scheduler-error"),
    ).rejects.toThrow("scheduler failed");
    expect(
      new TaskSnapshotReader(activeDatabase).load("task-scheduler-error").lease
        ?.ownerId,
    ).toBeNull();
  });

  it("surfaces Lease Release failures explicitly", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-release-failure");
    const manager = new TaskLeaseManager(activeDatabase);
    vi.spyOn(manager, "release").mockImplementation(() => {
      throw new Error("release failed");
    });
    const registry = new ToolRegistry();
    const provider = new MockLLMProvider("Finished.");
    const coordinator = createCoordinator(
      activeDatabase,
      registry,
      provider,
      { status: "approved" },
      manager,
    );

    await expect(
      coordinator.run("task-release-failure", "worker-release-failure"),
    ).rejects.toMatchObject({
      code: "TASK_LEASE_RELEASE_FAILED",
    });
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "task-release-failure",
    );
    expect(snapshot.task.status).toBe("completed");
    expect(snapshot.lease?.ownerId).toBe("worker-release-failure");
  });
});

class InspectingProvider implements LLMProvider {
  private readonly mock: MockLLMProvider;
  private providerCallCount = 0;
  constructor(
    script: readonly MockProviderStep[],
    private readonly inspect: () => void,
    private readonly delayMs = 0,
  ) {
    this.mock = new MockLLMProvider(script);
  }

  get consumedResponseCount(): number {
    return this.mock.consumedResponseCount;
  }

  get callCount(): number {
    return this.providerCallCount;
  }

  async generate(
    request: ModelRequest,
    options?: GenerateOptions,
  ): Promise<ModelResponse> {
    this.providerCallCount += 1;
    this.inspect();
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    return this.mock.generate(request, options);
  }
}

function createCoordinator(
  database: ForgeFlowDatabase,
  registry: ToolRegistry,
  provider: LLMProvider,
  approval: WriteApprovalHandler["request"] | WriteApprovalDecision,
  leaseManager = new TaskLeaseManager(database),
  heartbeatIntervalMs?: number,
): PersistenceCoordinator {
  const approvalHandler: WriteApprovalHandler = {
    request:
      typeof approval === "function"
        ? approval
        : async () => approval,
  };
  const planner = new TaskPlanner(registry);
  const scheduler = new TaskScheduler({
    registry,
    planner,
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, {
      approvalHandler,
      approvalTimeoutMs: 5_000,
    }),
  });
  return new PersistenceCoordinator({
    database,
    leaseManager,
    provider,
    registry,
    scheduler,
    model: "mock-model",
    ...(heartbeatIntervalMs === undefined ? {} : { heartbeatIntervalMs }),
  });
}

function readTool(
  name: string,
  executionEvents: string[],
  execute: ToolDefinition<Record<string, unknown>, unknown>["execute"],
): ToolDefinition<Record<string, unknown>, unknown> {
  return {
    name,
    description: `Read tool ${name}`,
    mode: "read",
    inputSchema: z.record(z.string(), z.unknown()),
    execute: async (input, context) => {
      executionEvents.push(`${name}:start`);
      const snapshot = new TaskSnapshotReader(
        database as ForgeFlowDatabase,
      ).load(context?.taskId as string);
      expect(snapshot.toolRuns.find((run) => run.toolCallId === context?.toolCallId)?.status).toBe(
        "running",
      );
      return execute(input, context);
    },
  };
}

function writeTool(
  execute: ToolDefinition<{ revision: string }, unknown>["execute"],
): ToolDefinition<{ revision: string }, unknown> {
  return {
    name: "bom_update",
    description: "Update BOM revision.",
    mode: "write",
    inputSchema: z.object({ revision: z.string().min(1) }).strict(),
    execute,
  };
}

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Run the persistent integration test",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function seedPersistentPlan(
  database: ForgeFlowDatabase,
  taskId: string,
  mode: "read" | "write",
): {
  readonly taskId: string;
  readonly planStepId: string;
  readonly toolRunId: string;
} {
  const unitOfWork = new ExecutionUnitOfWork(database);
  createTask(database, taskId);
  const call = unitOfWork.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Create a persisted plan" }],
      tools: [],
    },
  });
  const inputSchema = z.object({}).strict();
  const toolName = mode === "read" ? "bom_get_items" : "bom_update";
  const callId = `call-${taskId}`;
  const planStepId = `step-${taskId}`;
  const toolRunId = `run-${taskId}`;
  unitOfWork.completeModelCallWithPlan({
    modelCallId: call.id,
    durationMs: 1,
    response: {
      message: {
        role: "assistant",
        content: "Plan persisted.",
        toolCalls: [{ id: callId, name: toolName, arguments: {} }],
      },
      usage: { source: "provider" },
    },
    plan: {
      id: `plan-${taskId}`,
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
          toolCallId: callId,
          originalIndex: 0,
          toolName,
          toolVersion: "1",
          inputSchemaHash: computeToolInputSchemaHash(inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode,
          requiresApproval: mode === "write",
          input: {},
        },
      ],
    },
  });
  return { taskId, planStepId, toolRunId };
}
