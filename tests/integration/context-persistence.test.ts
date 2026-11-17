import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { ContextManager } from "../../src/context/index.js";
import { PersistenceCoordinator } from "../../src/persistence/coordinator.js";
import type { LLMProvider } from "../../src/provider/types.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
} from "../../src/scheduler/index.js";
import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("Context Manager persistent execution", () => {
  let database: ForgeFlowDatabase;

  beforeEach(() => {
    database = openDatabase(":memory:");
    migrateStorage(database);
  });

  afterEach(() => closeDatabase(database));

  it("compresses only the provider request and keeps original Tool Result audit data", async () => {
    const taskId = "phase4-context-persistence";
    new ExecutionUnitOfWork(database).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: "Read a large result and report it safely.",
      systemPrompt: "Use tool evidence and preserve safety constraints.",
      maxModelTurns: 4,
      maxToolCalls: 4,
    });
    const rows = Array.from({ length: 400 }, (_, index) => ({
      index,
      partNumber: `PART-${index}`,
      note: "large-tool-result".repeat(6),
    }));
    const registry = new ToolRegistry();
    registry.register({
      name: "large_inventory_read",
      description: "Return a large deterministic inventory result.",
      mode: "read",
      version: "1",
      inputSchema: z.object({}).strict(),
      execute: async () => ({ rows }),
    });
    let calls = 0;
    const provider: LLMProvider = {
      async generate() {
        calls += 1;
        if (calls === 1) {
          return {
            message: {
              role: "assistant",
              content: "Reading inventory.",
              toolCalls: [{ id: "large-read-call", name: "large_inventory_read", arguments: {} }],
            },
            usage: {
              promptTokens: 40,
              completionTokens: 10,
              totalTokens: 50,
              source: "provider",
            },
          };
        }
        return {
          message: { role: "assistant", content: "The large read completed." },
          usage: { source: "unknown" },
        };
      },
    };
    const scheduler = new TaskScheduler({
      registry,
      planner: new TaskPlanner(registry),
      readWorkerPool: new ReadWorkerPool(registry),
      writeExecutor: new WriteExecutor(registry, {
        approvalHandler: { request: async () => ({ status: "approved" }) },
      }),
    });
    const contextManager = new ContextManager({
      maxContextTokens: 1_200,
      reservedCompletionTokens: 200,
      maxToolResultTokens: 100,
    });
    const result = await new PersistenceCoordinator({
      database,
      leaseManager: new TaskLeaseManager(database),
      provider,
      registry,
      scheduler,
      model: "shared-context-model",
      contextManager,
    }).run(taskId, "phase4-context-owner");

    expect(result.status).toBe("completed");
    const snapshot = new TaskSnapshotReader(database).load(taskId);
    expect(snapshot.modelCalls).toHaveLength(2);
    expect(snapshot.modelCalls.map((call) => call.usage?.source)).toEqual([
      "provider",
      "estimated",
    ]);
    expect(snapshot.task.tokenUsage).toMatchObject({
      source: "mixed",
      providerCalls: 1,
      estimatedCalls: 1,
      provider: { totalTokens: 50 },
    });
    expect(snapshot.task.tokenUsage.estimated?.totalTokens).toBeGreaterThan(0);

    const originalToolMessage = snapshot.messages.find((message) => message.role === "tool");
    const secondRequestToolMessage = snapshot.modelCalls[1]?.request.messages.find(
      (message) => message.role === "tool",
    );
    expect(originalToolMessage?.content).toContain("PART-399");
    expect(originalToolMessage?.content).not.toContain("_forgeflowContext");
    expect(secondRequestToolMessage?.content).toContain('"truncated":true');
    expect(secondRequestToolMessage?.content).not.toContain("PART-399");
    expect(snapshot.toolRuns[0]?.output).toEqual({ rows });
    expect(snapshot.checkpoints.some((checkpoint) => checkpoint.reason === "model_response"))
      .toBe(true);
  });
});
