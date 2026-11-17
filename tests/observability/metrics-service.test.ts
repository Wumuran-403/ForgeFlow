import { describe, expect, it } from "vitest";

import { McpStdioClientAdapter, createInventoryDemoMcpConfig, registerMcpTools } from "../../src/mcp/index.js";
import { ObservabilityMetricsService } from "../../src/observability/index.js";
import { PersistenceCoordinator } from "../../src/persistence/index.js";
import { MockLLMProvider } from "../../src/provider/index.js";
import { ReadWorkerPool, TaskPlanner, TaskScheduler, WriteExecutor } from "../../src/scheduler/index.js";
import { closeDatabase, ExecutionUnitOfWork, migrateStorage, openDatabase, TaskLeaseManager } from "../../src/storage/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("ObservabilityMetricsService", () => {
  it("aggregates task, tool, estimated token, latency, and MCP data from SQLite", async () => {
    const database = openDatabase(":memory:");
    const client = new McpStdioClientAdapter(createInventoryDemoMcpConfig());
    try {
      migrateStorage(database);
      await client.connect();
      const registry = new ToolRegistry();
      const [mapped] = await registerMcpTools(registry, client);
      if (mapped === undefined) throw new Error("MCP tool was not mapped.");
      const taskId = "observability-mcp-task";
      new ExecutionUnitOfWork(database).createTask({ taskId, traceId: "metrics:test:1", objective: "Query deterministic MCP inventory.", systemPrompt: "Use the MCP tool.", maxModelTurns: 3, maxToolCalls: 2 });
      const scheduler = new TaskScheduler({ registry, planner: new TaskPlanner(registry),
        readWorkerPool: new ReadWorkerPool(registry), writeExecutor: new WriteExecutor(registry, { approvalHandler: { request: async () => ({ status: "approved" }) } }) });
      await new PersistenceCoordinator({ database, leaseManager: new TaskLeaseManager(database), registry, scheduler,
        provider: new MockLLMProvider([{ content: "Search.", toolCalls: [{ id: "metrics-mcp", name: mapped.localName, arguments: { query: "stm32" } }] }, "Done."]), model: "mock-metrics" })
        .run(taskId, "metrics-owner");
      const summary = new ObservabilityMetricsService(database).summary("metrics:");
      expect(summary.tasks).toMatchObject({ total: 1, byStatus: { completed: 1 } });
      expect(summary.tools).toMatchObject({ total: 1, failed: 0, byStatus: { succeeded: 1 } });
      expect(summary.tokens.provider).toBe(0);
      expect(summary.tokens.estimated).toBeGreaterThan(0);
      expect(summary.latency.completedTasks).toBe(1);
      expect(summary.mcp).toEqual({ calls: 1, succeeded: 1, failed: 0 });
      expect(summary.ratios.taskSuccess).toEqual({ numerator: 1, denominator: 1 });
      expect(summary.ratios.toolSuccess).toEqual({ numerator: 1, denominator: 1 });
      expect(summary.ratios.mcpSuccess).toEqual({ numerator: 1, denominator: 1 });
    } finally {
      await client.close();
      closeDatabase(database);
    }
  }, 20_000);
});
