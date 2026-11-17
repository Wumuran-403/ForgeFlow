import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LoopGuard } from "../../src/loop-guard/index.js";
import { PersistenceCoordinator } from "../../src/persistence/coordinator.js";
import { PersistentExecutionBridge } from "../../src/persistence/execution-bridge.js";
import { ExecutionAuthority } from "../../src/persistence/lease-heartbeat.js";
import type { LLMProvider } from "../../src/provider/types.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
} from "../../src/scheduler/index.js";
import { AppError } from "../../src/shared/errors.js";
import {
  closeDatabase,
  ExecutionUnitOfWork,
  ExecutionStateMachine,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { computeToolDefinitionFingerprint } from "../../src/tools/fingerprint.js";

describe("Loop Guard persistent execution", () => {
  let database: ForgeFlowDatabase;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrateStorage(database);
  });

  afterEach(() => closeDatabase(database));

  it("atomically pauses and skips an intact repeated batch before its side effect", async () => {
    const taskId = "phase4-loop-guard-persistent";
    new ExecutionUnitOfWork(database).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: "Stop a repeated inventory lookup.",
      systemPrompt: "Use evidence and stop when there is no progress.",
      maxModelTurns: 8,
      maxToolCalls: 8,
    });
    let executions = 0;
    let providerCalls = 0;
    const registry = new ToolRegistry();
    registry.register({
      name: "inventory_read",
      description: "Read deterministic inventory.",
      mode: "read",
      version: "1",
      inputSchema: z.object({ part: z.string() }).strict(),
      execute: async ({ part }) => {
        executions += 1;
        return { part, quantity: 7 };
      },
    });
    const provider: LLMProvider = {
      async generate() {
        providerCalls += 1;
        if (providerCalls <= 3) {
          return {
            message: {
              role: "assistant",
              content: "Retrying the same read.",
              toolCalls: [{
                id: `read-${providerCalls}`,
                name: "inventory_read",
                arguments: { part: "P-1" },
              }],
            },
            usage: { source: "unknown" },
          };
        }
        return {
          message: { role: "assistant", content: "Should not be reached." },
          usage: { source: "unknown" },
        };
      },
    };
    const scheduler = createScheduler(registry);
    const coordinator = new PersistenceCoordinator({
      database,
      leaseManager: new TaskLeaseManager(database),
      provider,
      registry,
      scheduler,
      model: "loop-guard-mock",
      loopGuard: new LoopGuard(),
    });

    const result = await coordinator.run(taskId, "loop-owner");

    // Diagnostic context is included in assertion output if setup regresses.
    expect(result).toMatchObject({ status: "paused", stopReason: "loop_detected" });
    expect(providerCalls).toBe(3);
    expect(executions).toBe(2);
    const snapshot = new TaskSnapshotReader(database).load(taskId);
    expect(snapshot.task.status).toBe("paused");
    expect(snapshot.toolRuns.filter((run) => run.status === "succeeded")).toHaveLength(2);
    expect(snapshot.toolRuns.filter((run) => run.status === "skipped")).toHaveLength(1);
    expect(snapshot.toolRuns.find((run) => run.toolCallId === "read-1")?.status).toBe("succeeded");
    expect(snapshot.toolRuns.find((run) => run.toolCallId === "read-3")?.status).toBe("skipped");
    expect(snapshot.events.filter((event) => event.type === "loop_detected")).toHaveLength(1);
    expect(snapshot.events.find((event) => event.type === "loop_detected")?.payload)
      .toMatchObject({
        reason: "consecutive_repeat",
        toolNames: ["inventory_read"],
        repeatCount: 3,
        threshold: 3,
      });
    expect(snapshot.checkpoints.find((checkpoint) => checkpoint.reason === "loop_detected"))
      .toMatchObject({
      reason: "loop_detected",
      taskStatus: "paused",
    });
    expect(snapshot.messages.filter((message) => message.role === "tool")).toHaveLength(3);
    expect(snapshot.messages.at(-1)?.content).toContain("LOOP_GUARD_BLOCKED");

    const restarted = new PersistenceCoordinator({
      database,
      leaseManager: new TaskLeaseManager(database),
      provider,
      registry,
      scheduler,
      model: "loop-guard-mock",
      loopGuard: new LoopGuard(),
    });
    await expect(restarted.resume(taskId, "restart-owner")).rejects.toMatchObject({
      code: "TASK_LOOP_GUARD_BLOCKED",
    } satisfies Partial<AppError>);
    expect(providerCalls).toBe(3);
    expect(executions).toBe(2);
    expect(new TaskSnapshotReader(database).load(taskId).events
      .filter((event) => event.type === "loop_detected")).toHaveLength(1);
  });

  it("rebuilds the no-progress window after closing and reopening a file database", () => {
    const directory = mkdtempSync(join(tmpdir(), "forgeflow-loop-guard-"));
    const path = join(directory, "restart.db");
    let fileDatabase = openDatabase(path);
    try {
      migrateStorage(fileDatabase);
      const taskId = "phase4-loop-guard-restart";
      const unit = new ExecutionUnitOfWork(fileDatabase);
      unit.createTask({
        taskId,
        traceId: `trace-${taskId}`,
        objective: "Recover the loop window.",
        systemPrompt: "Use persisted execution history.",
        maxModelTurns: 8,
        maxToolCalls: 8,
      });
      const registry = new ToolRegistry();
      registry.register({
        name: "inventory_read",
        description: "Read deterministic inventory.",
        mode: "read",
        version: "1",
        inputSchema: z.object({ part: z.string() }).strict(),
        execute: async ({ part }) => ({ part, quantity: 7 }),
      });
      const input = { part: "P-1" };
      const fingerprint = computeToolDefinitionFingerprint(registry.get("inventory_read"), input);
      for (let iteration = 1; iteration <= 3; iteration += 1) {
        const toolCall = callForIteration(iteration);
        const modelCall = unit.beginModelCall({
          taskId,
          iteration,
          request: {
            model: "loop-guard-mock",
            messages: [{ role: "user", content: "Read inventory." }],
            tools: [],
          },
        });
        unit.completeModelCallWithPlan({
          modelCallId: modelCall.id,
          durationMs: 1,
          response: {
            message: { role: "assistant", content: "Reading.", toolCalls: [toolCall] },
            usage: { source: "unknown" },
          },
          plan: {
            id: `restart-plan-${iteration}`,
            version: iteration,
            steps: [{ id: `restart-step-${iteration}`, stepIndex: 0, kind: "read_batch" }],
            toolRuns: [{
              id: `restart-run-${iteration}`,
              planStepId: `restart-step-${iteration}`,
              toolCallId: toolCall.id,
              originalIndex: 0,
              toolName: toolCall.name,
              ...fingerprint,
              input,
            }],
          },
        });
        if (iteration <= 2) {
          unit.beginToolRun({ toolRunId: `restart-run-${iteration}`, status: "running" });
          unit.completeToolRun({
            toolRunId: `restart-run-${iteration}`,
            status: "succeeded",
            output: { part: "P-1", quantity: 7 },
          });
        }
      }
      closeDatabase(fileDatabase);
      fileDatabase = openDatabase(path);
      migrateStorage(fileDatabase);

      const leases = new TaskLeaseManager(fileDatabase);
      const lease = leases.claim(taskId, "restart-owner");
      const ownership = {
        taskId,
        leaseToken: lease.leaseToken as string,
        fencingToken: lease.fencingToken,
      };
      const thirdCall = callForIteration(3);
      const bridge = new PersistentExecutionBridge({
        database: fileDatabase,
        leaseManager: leases,
        stateMachine: new ExecutionStateMachine(fileDatabase, leases),
        registry,
        snapshot: new TaskSnapshotReader(fileDatabase).load(taskId),
        ownership,
        authority: new ExecutionAuthority(),
      });
      const restored = bridge.getLoopGuardHistory([thirdCall]);
      expect(restored.eligible).toBe(true);
      const decision = new LoopGuard().evaluate(restored.rounds, [thirdCall]);
      expect(decision).toMatchObject({
        reason: "consecutive_repeat",
        repeatCount: 3,
      });
      bridge.pauseForLoopGuard([thirdCall], decision as NonNullable<typeof decision>);
      expect(new TaskSnapshotReader(fileDatabase).load(taskId).task.status).toBe("paused");
      leases.release(taskId, ownership.leaseToken, ownership.fencingToken);
    } finally {
      closeDatabase(fileDatabase);
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function callForIteration(iteration: number) {
  return {
    id: `restart-call-${iteration}`,
    name: "inventory_read",
    arguments: { part: "P-1" },
  };
}

function createScheduler(registry: ToolRegistry): TaskScheduler {
  return new TaskScheduler({
    registry,
    planner: new TaskPlanner(registry),
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, {
      approvalHandler: { request: async () => ({ status: "approved" }) },
    }),
  });
}
