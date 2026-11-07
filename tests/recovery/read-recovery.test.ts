import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  runInTransaction,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { RecoveryManager } from "../../src/recovery/index.js";
import { PersistenceCoordinator } from "../../src/persistence/index.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
} from "../../src/scheduler/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";
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
  vi.restoreAllMocks();
});

describe("Read recovery", () => {
  it("retries a leftover running Read and preserves its identity fields", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ value: "recovered" }));
    const registry = createReadRegistry({ read_target: execute });
    const plan = seedReadPlan(
      activeDatabase,
      registry,
      "recover-running-read",
      ["read_target"],
    );
    new ExecutionUnitOfWork(activeDatabase).beginToolRun({
      toolRunId: plan.toolRunIds[0] as string,
      status: "running",
    });
    const before = new TaskSnapshotReader(activeDatabase).load(
      "recover-running-read",
    ).toolRuns[0];
    const manager = createManager(activeDatabase, registry);

    const result = await manager.recoverReadRuns(
      "recover-running-read",
      "worker-read",
    );

    expect(result.status).toBe("completed");
    expect(result.requeuedCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "recover-running-read",
    );
    expect(snapshot.toolRuns).toHaveLength(1);
    expect(snapshot.toolRuns[0]).toMatchObject({
      id: before?.id,
      toolCallId: before?.toolCallId,
      originalIndex: before?.originalIndex,
      toolVersion: before?.toolVersion,
      inputSchemaHash: before?.inputSchemaHash,
      canonicalInputHash: before?.canonicalInputHash,
      idempotencyKey: before?.idempotencyKey,
      status: "succeeded",
      output: { value: "recovered" },
    });
    expect(snapshot.planSteps[0]?.status).toBe("completed");
    expect(snapshot.task.status).toBe("running");
    expect(snapshot.messages.filter((message) => message.role === "tool")).toHaveLength(
      1,
    );
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({ type: "recovery.read_retried" }),
    );
    expect(snapshot.lease?.ownerId).toBeNull();
  });

  it("requeues an interrupted Read and executes a queued Read as first start", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const interruptedExecute = vi.fn(async () => ({ value: "interrupted" }));
    const interruptedRegistry = createReadRegistry({
      read_interrupted: interruptedExecute,
    });
    const interrupted = seedReadPlan(
      activeDatabase,
      interruptedRegistry,
      "recover-interrupted-read",
      ["read_interrupted"],
    );
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    unitOfWork.beginToolRun({
      toolRunId: interrupted.toolRunIds[0] as string,
      status: "running",
    });
    const run = new TaskSnapshotReader(activeDatabase).load(
      "recover-interrupted-read",
    ).toolRuns[0];
    runInTransaction(
      activeDatabase,
      () => {
        const permit = createStorageWritePermit(activeDatabase);
        return new ToolRunRepository(activeDatabase).transition(
          interrupted.toolRunIds[0] as string,
          ["running"],
          {
            expectedVersion: run?.version as number,
            status: "interrupted",
            updatedAt: timestamp,
          },
          permit,
        );
      },
      "immediate",
    );
    await createManager(
      activeDatabase,
      interruptedRegistry,
    ).recoverReadRuns("recover-interrupted-read", "worker-interrupted");
    expect(interruptedExecute).toHaveBeenCalledTimes(1);

    const queuedExecute = vi.fn(async () => ({ value: "queued" }));
    const queuedRegistry = createReadRegistry({ read_queued: queuedExecute });
    seedReadPlan(
      activeDatabase,
      queuedRegistry,
      "recover-queued-read",
      ["read_queued"],
    );
    const report = await createManager(
      activeDatabase,
      queuedRegistry,
    ).recoverReadRuns("recover-queued-read", "worker-queued");
    expect(report.requeuedCount).toBe(0);
    expect(queuedExecute).toHaveBeenCalledTimes(1);
    await expect(
      createManager(activeDatabase, queuedRegistry).recoverReadRuns(
        "recover-queued-read",
        "worker-queued-again",
      ),
    ).resolves.toMatchObject({
      status: "no_work",
    });
  });

  it("does not retry succeeded, failed, timed out, cancelled, or skipped Reads", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = createReadRegistry({ read_terminal: execute });
    const statuses = [
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "skipped",
    ] as const;

    for (const status of statuses) {
      const taskId = `terminal-${status}`;
      const plan = seedReadPlan(activeDatabase, registry, taskId, [
        "read_terminal",
      ]);
      const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
      unitOfWork.beginToolRun({
        toolRunId: plan.toolRunIds[0] as string,
        status: "running",
      });
      unitOfWork.completeToolRun({
        toolRunId: plan.toolRunIds[0] as string,
        status,
        ...(status === "succeeded"
          ? { output: { ok: true } }
          : {
              error: {
                code: `READ_${status.toUpperCase()}`,
                message: `Read ${status}.`,
                details: [],
              },
            }),
      });
    }

    for (const status of statuses) {
      const result = await createManager(
        activeDatabase,
        registry,
      ).recoverReadRuns(`terminal-${status}`, `worker-${status}`);
      expect(result.status).toBe("no_work");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects succeeded Read without its persisted Tool Message", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = createReadRegistry({ read_succeeded: execute });
    const plan = seedReadPlan(activeDatabase, registry, "read-missing-message", [
      "read_succeeded",
    ]);
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    unitOfWork.beginToolRun({
      toolRunId: plan.toolRunIds[0] as string,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: plan.toolRunIds[0] as string,
      status: "succeeded",
      output: { ok: true },
    });
    activeDatabase
      .prepare(
        `
          DELETE FROM messages
          WHERE task_id = ? AND role = 'tool'
        `,
      )
      .run("read-missing-message");

    await expect(
      createManager(activeDatabase, registry).recoverReadRuns(
        "read-missing-message",
        "worker-missing-message",
      ),
    ).rejects.toMatchObject({
      code: "READ_RECOVERY_BLOCKED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([
    ["version", "tool_version = '999'"],
    [
      "schema",
      `input_schema_hash = 'sha256:${"a".repeat(64)}'`,
    ],
    [
      "input",
      `canonical_input_hash = 'sha256:${"b".repeat(64)}'`,
    ],
  ])("rejects a %s mismatch before invoking the Read", async (_name, update) => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ dangerous: true }));
    const registry = createReadRegistry({ read_guard: execute });
    const plan = seedReadPlan(activeDatabase, registry, "read-guard", [
      "read_guard",
    ]);
    activeDatabase
      .prepare(`UPDATE tool_runs SET ${update} WHERE id = ?`)
      .run(plan.toolRunIds[0]);

    await expect(
      createManager(activeDatabase, registry).recoverReadRuns(
        "read-guard",
        "worker-guard",
      ),
    ).rejects.toMatchObject({
      code: "READ_RECOVERY_BLOCKED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects persisted Read input that no longer passes Zod validation", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ dangerous: true }));
    const registry = createReadRegistry({ read_zod_guard: execute });
    const plan = seedReadPlan(activeDatabase, registry, "read-zod-guard", [
      "read_zod_guard",
    ]);
    const invalidInput = { unexpected: true };
    activeDatabase
      .prepare(
        `
          UPDATE tool_runs
          SET input_json = ?, canonical_input_hash = ?
          WHERE id = ?
        `,
      )
      .run(
        JSON.stringify(invalidInput),
        computeCanonicalInputHash(invalidInput),
        plan.toolRunIds[0],
      );

    await expect(
      createManager(activeDatabase, registry).recoverReadRuns(
        "read-zod-guard",
        "worker-zod-guard",
      ),
    ).rejects.toMatchObject({
      code: "READ_RECOVERY_BLOCKED",
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not invoke Read when Intent Commit fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = createReadRegistry({ read_intent: execute });
    seedReadPlan(activeDatabase, registry, "read-intent-failure", [
      "read_intent",
    ]);
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_read_intent
        BEFORE INSERT ON events
        WHEN NEW.type = 'tool.intent_committed'
        BEGIN
          SELECT RAISE(ABORT, 'read intent rejected');
        END
      `,
    );

    await createManager(activeDatabase, registry).recoverReadRuns(
      "read-intent-failure",
      "worker-intent",
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it("does not return a success result when Read Result Commit fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ ok: true }));
    const registry = createReadRegistry({ read_commit: execute });
    seedReadPlan(activeDatabase, registry, "read-result-failure", [
      "read_commit",
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

    await expect(
      createManager(activeDatabase, registry).recoverReadRuns(
        "read-result-failure",
        "worker-result",
      ),
    ).rejects.toBeInstanceOf(Error);
    expect(execute).toHaveBeenCalledTimes(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-result-failure",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(
      snapshot.messages.some((message) => message.role === "tool"),
    ).toBe(false);
    expect(snapshot.lease?.ownerId).toBeNull();
  });

  it("uses ReadWorkerPool concurrency and persists results in originalIndex order", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    let active = 0;
    let maxActive = 0;
    const first = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 30));
      active -= 1;
      return { value: "first" };
    });
    const second = vi.fn(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active -= 1;
      return { value: "second" };
    });
    const registry = createReadRegistry({
      read_first: first,
      read_second: second,
    });
    seedReadPlan(activeDatabase, registry, "read-parallel", [
      "read_first",
      "read_second",
    ]);
    const result = await createManager(
      activeDatabase,
      registry,
      new ReadWorkerPool(registry, { maxConcurrency: 2 }),
    ).recoverReadRuns("read-parallel", "worker-parallel");

    expect(maxActive).toBe(2);
    expect(result.results.map((item) => item.originalIndex)).toEqual([0, 1]);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-parallel",
    );
    expect(
      snapshot.messages
        .filter((message) => message.role === "tool")
        .map((message) => message.toolCallId),
    ).toEqual(["call-read-parallel-0", "call-read-parallel-1"]);
  });

  it("keeps successful Reads when a sibling Read fails", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const good = vi.fn(async () => ({ value: "good" }));
    const bad = vi.fn(async () => {
      throw new Error("bad read");
    });
    const registry = createReadRegistry({ read_good: good, read_bad: bad });
    seedReadPlan(activeDatabase, registry, "read-partial", [
      "read_good",
      "read_bad",
    ]);

    const result = await createManager(
      activeDatabase,
      registry,
    ).recoverReadRuns("read-partial", "worker-partial");
    expect(result.results.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
    ]);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-partial",
    );
    expect(snapshot.toolRuns.map((run) => run.status)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect(snapshot.planSteps[0]?.status).toBe("completed");
  });

  it("rejects every higher-priority recovery blocker", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const readExecute = vi.fn(async () => ({ ok: true }));
    const writeExecute = vi.fn(async () => ({ ok: true }));
    const registry = createReadRegistry({
      read_target: readExecute,
      write_target_no_approval: writeExecute,
      write_target: vi.fn(async () => ({ ok: true })),
    });
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    const taskIds: string[] = [];

    const cancelled = seedReadPlan(
      activeDatabase,
      registry,
      "blocked-cancel",
      ["read_target"],
    );
    activeDatabase
      .prepare("UPDATE tasks SET cancel_requested_at = ? WHERE id = ?")
      .run(timestamp, "blocked-cancel");
    taskIds.push(cancelled.taskId);

    const paused = seedReadPlan(
      activeDatabase,
      registry,
      "blocked-pause",
      ["read_target"],
    );
    activeDatabase
      .prepare("UPDATE tasks SET pause_requested_at = ? WHERE id = ?")
      .run(timestamp, "blocked-pause");
    taskIds.push(paused.taskId);

    const model = seedReadPlan(
      activeDatabase,
      registry,
      "blocked-model",
      ["read_target"],
    );
    unitOfWork.beginModelCall({
      taskId: "blocked-model",
      iteration: 2,
      request: {
        model: "mock-model",
        messages: [{ role: "user", content: "pending" }],
        tools: [],
      },
    });
    taskIds.push(model.taskId);

    const unknown = seedMixedPlan(
      activeDatabase,
      registry,
      "blocked-unknown-write",
    );
    unitOfWork.beginToolRun({
      toolRunId: unknown.writeToolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: unknown.writeToolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    taskIds.push(unknown.taskId);

    const reviewed = seedMixedPlan(
      activeDatabase,
      registry,
      "blocked-active-review",
    );
    unitOfWork.beginToolRun({
      toolRunId: reviewed.writeToolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: reviewed.writeToolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork.requestRecoveryReview({
      toolRunId: reviewed.writeToolRunId,
      note: null,
    });
    taskIds.push(reviewed.taskId);

    const approvalPending = seedMixedPlan(
      activeDatabase,
      registry,
      "blocked-approval-pending",
      "write_target",
    );
    unitOfWork.requestApproval({
      toolRunId: approvalPending.writeToolRunId,
      request: { description: "approve" },
    });
    taskIds.push(approvalPending.taskId);

    const barrier = seedMixedPlan(
      activeDatabase,
      registry,
      "blocked-write-barrier",
    );
    taskIds.push(barrier.taskId);

    for (const taskId of taskIds) {
      await expect(
        createManager(activeDatabase, registry).recoverReadRuns(
          taskId,
          `worker-${taskId}`,
        ),
      ).rejects.toMatchObject({
        code: "READ_RECOVERY_BLOCKED",
      });
    }
    expect(readExecute).not.toHaveBeenCalled();
    expect(writeExecute).not.toHaveBeenCalled();
  });

  it("stops starting new Reads after Heartbeat failure", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const managerLease = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 200,
    });
    vi.spyOn(managerLease, "heartbeat").mockImplementation(() => {
      throw new Error("heartbeat failed");
    });
    const first = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { value: "first" };
    });
    const second = vi.fn(async () => ({ value: "second" }));
    const registry = createReadRegistry({ read_first: first, read_second: second });
    seedReadPlan(activeDatabase, registry, "read-heartbeat-failure", [
      "read_first",
      "read_second",
    ]);
    const manager = createManager(
      activeDatabase,
      registry,
      new ReadWorkerPool(registry, { maxConcurrency: 1 }),
      managerLease,
    );

    await expect(
      manager.recoverReadRuns("read-heartbeat-failure", "worker-heartbeat"),
    ).rejects.toThrow(/heartbeat/i);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-heartbeat-failure",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(
      snapshot.messages.some((message) => message.role === "tool"),
    ).toBe(false);
  });

  it("does not commit a failed Read after Heartbeat revocation", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const managerLease = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 200,
    });
    vi.spyOn(managerLease, "heartbeat").mockImplementation(() => {
      throw new Error("heartbeat failed");
    });
    const execute = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      throw new Error("read failed after revocation");
    });
    const registry = createReadRegistry({ read_failure: execute });
    seedReadPlan(activeDatabase, registry, "read-heartbeat-throw", [
      "read_failure",
    ]);
    const manager = createManager(
      activeDatabase,
      registry,
      new ReadWorkerPool(registry),
      managerLease,
    );

    await expect(
      manager.recoverReadRuns("read-heartbeat-throw", "worker-heartbeat-throw"),
    ).rejects.toThrow(/heartbeat/i);
    expect(execute).toHaveBeenCalledTimes(1);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-heartbeat-throw",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(
      snapshot.messages.some((message) => message.role === "tool"),
    ).toBe(false);
  });

  it("prevents an old Worker from committing after Lease replacement", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    let releaseRead: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const execute = vi.fn(async () => {
      markStarted?.();
      await new Promise<void>((resolve) => {
        releaseRead = resolve;
      });
      return { value: "stale" };
    });
    const registry = createReadRegistry({ read_target: execute });
    seedReadPlan(activeDatabase, registry, "read-stale-worker", [
      "read_target",
    ]);
    const managerLease = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 10_000,
    });
    const manager = createManager(
      activeDatabase,
      registry,
      new ReadWorkerPool(registry),
      managerLease,
    );
    const recovery = manager.recoverReadRuns(
      "read-stale-worker",
      "worker-old",
    );
    await started;
    const currentLease = new TaskSnapshotReader(activeDatabase).load(
      "read-stale-worker",
    ).lease;
    managerLease.release(
      "read-stale-worker",
      currentLease?.leaseToken as string,
      currentLease?.fencingToken as number,
    );
    const replacement = managerLease.claim(
      "read-stale-worker",
      "worker-new",
    );
    releaseRead?.();

    await expect(recovery).rejects.toBeInstanceOf(Error);
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-stale-worker",
    );
    expect(snapshot.toolRuns[0]?.status).toBe("running");
    expect(
      snapshot.messages.some((message) => message.role === "tool"),
    ).toBe(false);
    managerLease.release(
      "read-stale-worker",
      replacement.leaseToken as string,
      replacement.fencingToken,
    );
  });

  it("releases Read Recovery Lease and allows PersistentCoordinator to start the next Model Call", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const execute = vi.fn(async () => ({ value: "recovered" }));
    const registry = createReadRegistry({ read_target: execute });
    const plan = seedReadPlan(activeDatabase, registry, "read-lifecycle", [
      "read_target",
    ]);
    new ExecutionUnitOfWork(activeDatabase).beginToolRun({
      toolRunId: plan.toolRunIds[0] as string,
      status: "running",
    });
    const leaseManager = new TaskLeaseManager(activeDatabase, {
      now: () => new Date(timestamp),
    });
    const recovery = createManager(
      activeDatabase,
      registry,
      new ReadWorkerPool(registry),
      leaseManager,
    );

    await recovery.recoverReadRuns("read-lifecycle", "recovery-worker");
    const recovered = new TaskSnapshotReader(activeDatabase).load(
      "read-lifecycle",
    );
    expect(recovered.task.status).toBe("running");
    expect(recovered.lease).toMatchObject({
      ownerId: null,
      fencingToken: 1,
    });

    const planner = new TaskPlanner(registry);
    const scheduler = new TaskScheduler({
      registry,
      planner,
      readWorkerPool: new ReadWorkerPool(registry),
      writeExecutor: new WriteExecutor(registry, {
        approvalHandler: { request: async () => ({ status: "approved" }) },
      }),
    });
    const provider = new MockLLMProvider("Final answer.");
    const coordinator = new PersistenceCoordinator({
      database: activeDatabase,
      leaseManager,
      provider,
      registry,
      scheduler,
      model: "mock-model",
    });
    const result = await coordinator.run("read-lifecycle", "coordinator-worker");

    expect(result.status).toBe("completed");
    expect(provider.consumedResponseCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);
    const final = new TaskSnapshotReader(activeDatabase).load("read-lifecycle");
    expect(final.task.status).toBe("completed");
    expect(final.lease).toMatchObject({
      ownerId: null,
      fencingToken: 2,
    });
    expect(final.modelCalls).toHaveLength(2);
    expect(final.modelCalls[1]).toMatchObject({
      iteration: 2,
      attemptNo: 1,
      status: "completed",
    });
    expect(
      final.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(1);
    expect(final.toolRuns[0]?.status).toBe("succeeded");
  });
});

function createManager(
  database: ForgeFlowDatabase,
  registry: ToolRegistry,
  readWorkerPool = new ReadWorkerPool(registry),
  leaseManager = new TaskLeaseManager(database, {
    now: () => new Date(timestamp),
  }),
): RecoveryManager {
  return new RecoveryManager({
    database,
    leaseManager,
    registry,
    readWorkerPool,
    heartbeatIntervalMs: 5,
    now: () => new Date(timestamp),
  });
}

function createReadRegistry(
  tools: Record<string, () => Promise<unknown>>,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const [name, execute] of Object.entries(tools)) {
    registry.register({
      name,
      description: `Recovery tool ${name}`,
      mode: name.startsWith("write_") ? "write" : "read",
      version: "1",
      inputSchema: z.object({}).strict(),
      requiresApproval:
        name.startsWith("write_") && !name.endsWith("_no_approval"),
      execute,
    });
  }
  return registry;
}

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Recover read operations",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

interface SeededPlan {
  readonly taskId: string;
  readonly planId: string;
  readonly planStepId: string;
  readonly toolRunIds: readonly string[];
}

function seedReadPlan(
  database: ForgeFlowDatabase,
  registry: ToolRegistry,
  taskId: string,
  toolNames: readonly string[],
): SeededPlan {
  createTask(database, taskId);
  const unitOfWork = new ExecutionUnitOfWork(database);
  const modelCall = unitOfWork.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Create reads" }],
      tools: [],
    },
  });
  const planId = `plan-${taskId}`;
  const planStepId = `step-${taskId}`;
  const toolCallIds = toolNames.map(
    (_toolName, index) => `call-${taskId}-${index}`,
  );
  const toolRunIds = toolNames.map(
    (_toolName, index) => `run-${taskId}-${index}`,
  );
  unitOfWork.completeModelCallWithPlan({
    modelCallId: modelCall.id,
    durationMs: 1,
    response: {
      message: {
        role: "assistant",
        content: "Read plan.",
        toolCalls: toolNames.map((toolName, index) => ({
          id: toolCallIds[index] as string,
          name: toolName,
          arguments: {},
        })),
      },
      usage: { source: "provider" },
    },
    plan: {
      id: planId,
      version: 1,
      steps: [
        {
          id: planStepId,
          stepIndex: 0,
          kind: "read_batch",
        },
      ],
      toolRuns: toolNames.map((toolName, index) => {
        const tool = registry.get(toolName);
        return {
          id: toolRunIds[index] as string,
          planStepId,
          toolCallId: toolCallIds[index] as string,
          originalIndex: index,
          toolName,
          toolVersion: tool.version,
          inputSchemaHash: computeToolInputSchemaHash(tool.inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "read" as const,
          requiresApproval: tool.requiresApproval,
          input: {},
        };
      }),
    },
  });
  return { taskId, planId, planStepId, toolRunIds };
}

function seedMixedPlan(
  database: ForgeFlowDatabase,
  registry: ToolRegistry,
  taskId: string,
  writeToolName = "write_target_no_approval",
): {
  readonly taskId: string;
  readonly writeToolRunId: string;
  readonly readToolRunId: string;
} {
  createTask(database, taskId);
  const unitOfWork = new ExecutionUnitOfWork(database);
  const modelCall = unitOfWork.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Create mixed plan" }],
      tools: [],
    },
  });
  const writeTool = registry.get(writeToolName);
  const readTool = registry.get("read_target");
  const writeToolRunId = `write-run-${taskId}`;
  const readToolRunId = `read-run-${taskId}`;
  unitOfWork.completeModelCallWithPlan({
    modelCallId: modelCall.id,
    durationMs: 1,
    response: {
      message: {
        role: "assistant",
        content: "Mixed plan.",
        toolCalls: [
          {
            id: `write-call-${taskId}`,
            name: writeToolName,
            arguments: {},
          },
          {
            id: `read-call-${taskId}`,
            name: "read_target",
            arguments: {},
          },
        ],
      },
      usage: { source: "provider" },
    },
    plan: {
      id: `plan-${taskId}`,
      version: 1,
      steps: [
        {
          id: `write-step-${taskId}`,
          stepIndex: 0,
          kind: "write",
        },
        {
          id: `read-step-${taskId}`,
          stepIndex: 1,
          kind: "read_batch",
        },
      ],
      toolRuns: [
        {
          id: writeToolRunId,
          planStepId: `write-step-${taskId}`,
          toolCallId: `write-call-${taskId}`,
          originalIndex: 0,
          toolName: writeToolName,
          toolVersion: writeTool.version,
          inputSchemaHash: computeToolInputSchemaHash(writeTool.inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "write",
          requiresApproval: writeTool.requiresApproval,
          input: {},
        },
        {
          id: readToolRunId,
          planStepId: `read-step-${taskId}`,
          toolCallId: `read-call-${taskId}`,
          originalIndex: 1,
          toolName: "read_target",
          toolVersion: readTool.version,
          inputSchemaHash: computeToolInputSchemaHash(readTool.inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "read",
          requiresApproval: readTool.requiresApproval,
          input: {},
        },
      ],
    },
  });
  return { taskId, writeToolRunId, readToolRunId };
}

const timestamp = "2026-01-01T00:00:00.000Z";
