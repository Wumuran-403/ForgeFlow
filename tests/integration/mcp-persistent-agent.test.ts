import { afterEach, describe, expect, it } from "vitest";

import {
  McpStdioClientAdapter,
  createInventoryDemoMcpConfig,
  registerMcpTools,
} from "../../src/mcp/index.js";
import { PersistenceCoordinator } from "../../src/persistence/coordinator.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
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

const clients: McpStdioClientAdapter[] = [];
const databases: ForgeFlowDatabase[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
  for (const database of databases.splice(0)) closeDatabase(database);
});

describe("persistent Agent MCP integration", () => {
  it("runs a discovered MCP read through Scheduler and persists ToolRun, Event, and Checkpoint", async () => {
    const client = new McpStdioClientAdapter(createInventoryDemoMcpConfig());
    clients.push(client);
    await client.connect();
    const registry = new ToolRegistry();
    const [mapped] = await registerMcpTools(registry, client);
    expect(mapped).toBeDefined();
    const scheduler = createScheduler(registry);
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateStorage(database);
    const taskId = "phase5-mcp-persistent-read";
    new ExecutionUnitOfWork(database).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: "Find STM32 microcontrollers in the local MCP demo inventory.",
      systemPrompt: "Use the configured inventory tool.",
      maxModelTurns: 4,
      maxToolCalls: 4,
      maxTokens: 50_000,
    });
    const provider = new MockLLMProvider([
      {
        content: "Querying the MCP inventory.",
        toolCalls: [{
          id: "mcp-search-call",
          name: mapped!.localName,
          arguments: { query: "stm32", minimumAvailable: 10 },
        }],
      },
      "The demo inventory contains matching STM32 parts.",
    ]);

    const result = await new PersistenceCoordinator({
      database,
      leaseManager: new TaskLeaseManager(database),
      provider,
      registry,
      scheduler,
      model: "mock-mcp",
    }).run(taskId, "mcp-test-owner");

    expect(result).toMatchObject({ status: "completed", stopReason: "final_response" });
    expect(result.toolResults).toEqual([
      expect.objectContaining({
        toolName: "mcp_inventory_inventory_search",
        mode: "read",
        status: "succeeded",
        output: expect.objectContaining({ structuredContent: expect.objectContaining({ count: 3 }) }),
      }),
    ]);
    const snapshot = new TaskSnapshotReader(database).load(taskId);
    expect(snapshot.toolRuns).toEqual([
      expect.objectContaining({
        toolName: "mcp_inventory_inventory_search",
        mode: "read",
        status: "succeeded",
      }),
    ]);
    expect(snapshot.events.some((event) => event.type === "tool.intent_committed")).toBe(true);
    expect(snapshot.events.some((event) => event.type === "tool.succeeded")).toBe(true);
    expect(snapshot.checkpoints.length).toBeGreaterThan(0);
    expect(snapshot.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "mcp-search-call"))
      .toBe(true);
  });

  it("keeps a trusted MCP write mapping behind Scheduler approval", async () => {
    const config = createInventoryDemoMcpConfig();
    const client = new McpStdioClientAdapter({
      ...config,
      tools: [{
        remoteName: "inventory.search",
        mode: "write",
        requiresApproval: true,
        timeoutMs: 5_000,
      }],
    });
    clients.push(client);
    await client.connect();
    const registry = new ToolRegistry();
    const [mapped] = await registerMcpTools(registry, client);
    let approvalRequests = 0;
    const scheduler = new TaskScheduler({
      registry,
      planner: new TaskPlanner(registry),
      readWorkerPool: new ReadWorkerPool(registry),
      writeExecutor: new WriteExecutor(registry, {
        approvalHandler: {
          request: async () => {
            approvalRequests += 1;
            return { status: "approved" };
          },
        },
      }),
    });
    const database = openDatabase(":memory:");
    databases.push(database);
    migrateStorage(database);
    const taskId = "phase5-mcp-write-safety";
    new ExecutionUnitOfWork(database).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: "Exercise the trusted MCP write policy through approval and barrier.",
      systemPrompt: "Use the configured tool once.",
      maxModelTurns: 4,
      maxToolCalls: 4,
      maxTokens: 50_000,
    });
    const result = await new PersistenceCoordinator({
      database,
      leaseManager: new TaskLeaseManager(database),
      provider: new MockLLMProvider([
        {
          content: "Calling the write-classified MCP tool.",
          toolCalls: [{
            id: "mcp-write-shaped-call",
            name: mapped!.localName,
            arguments: { query: "stm32" },
          }],
        },
        "Write-classified MCP tool completed through the controlled path.",
      ]),
      registry,
      scheduler,
      model: "mock-mcp-write",
    }).run(taskId, "mcp-write-owner");

    expect(approvalRequests).toBe(1);
    expect(result).toMatchObject({ status: "completed" });
    const snapshot = new TaskSnapshotReader(database).load(taskId);
    expect(snapshot.toolRuns).toEqual([
      expect.objectContaining({ mode: "write", status: "succeeded" }),
    ]);
    expect(snapshot.events.some((event) => event.type === "tool.intent_committed")).toBe(true);
  });
});

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
