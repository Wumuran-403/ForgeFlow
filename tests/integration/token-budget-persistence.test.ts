import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";

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

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("persistent task token budget", () => {
  it("reserves a full context for unknown historical usage instead of treating it as zero", async () => {
    const database = openDatabase(":memory:");
    try {
      migrateStorage(database);
      const taskId = "phase4-token-budget-unknown-reserve";
      new ExecutionUnitOfWork(database).createTask({
        taskId,
        traceId: `trace-${taskId}`,
        objective: "Fail closed when historical model usage is unknown.",
        systemPrompt: "Respect conservative budget accounting.",
        maxModelTurns: 4,
        maxToolCalls: 4,
        maxTokens: 10_000,
        tokenUsage: { source: "unknown", unknownCalls: 1 },
      });
      let providerCalls = 0;
      const registry = createRegistry();
      const result = await new PersistenceCoordinator({
        database,
        leaseManager: new TaskLeaseManager(database),
        provider: {
          async generate() {
            providerCalls += 1;
            return { message: { role: "assistant", content: "Must not run." }, usage: { source: "unknown" } };
          },
        },
        registry,
        scheduler: createScheduler(registry),
        model: "budget-mock",
      }).run(taskId, "unknown-budget-owner");

      expect(result).toMatchObject({
        status: "paused",
        stopReason: "task_token_budget_exhausted",
        modelRequests: 0,
      });
      expect(providerCalls).toBe(0);
      const event = new TaskSnapshotReader(database).load(taskId).events
        .find((item) => item.type === "token_budget_exhausted");
      expect(event?.payload).toMatchObject({
        usageUncertain: true,
        conservativeUnknownTokens: 16_384,
        reason: "next_request_preflight",
      });
    } finally {
      closeDatabase(database);
    }
  });

  it("blocks the next provider request when persisted usage plus preflight reserve exceeds budget", async () => {
    const database = openDatabase(":memory:");
    try {
      migrateStorage(database);
      const taskId = "phase4-token-budget-mixed";
      new ExecutionUnitOfWork(database).createTask({
        taskId,
        traceId: `trace-${taskId}`,
        objective: "Perform two distinct reads and respect the token budget.",
        systemPrompt: "Use deterministic reads.",
        maxModelTurns: 8,
        maxToolCalls: 8,
        maxTokens: 5_000,
      });
      const registry = createRegistry();
      let providerCalls = 0;
      let toolExecutions = 0;
      registry.register({
        name: "budget_read",
        description: "Read a deterministic value.",
        mode: "read",
        version: "1",
        inputSchema: z.object({ id: z.number().int() }).strict(),
        execute: async ({ id }) => {
          toolExecutions += 1;
          return { id, value: `value-${id}` };
        },
      });
      const provider: LLMProvider = {
        async generate() {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              message: {
                role: "assistant",
                content: "First read.",
                toolCalls: [{ id: "budget-call-1", name: "budget_read", arguments: { id: 1 } }],
              },
              usage: {
                promptTokens: 2_000,
                completionTokens: 1_000,
                totalTokens: 3_000,
                source: "provider",
              },
            };
          }
          throw new Error("Token budget failed to block the second provider request.");
        },
      };
      const result = await new PersistenceCoordinator({
        database,
        leaseManager: new TaskLeaseManager(database),
        provider,
        registry,
        scheduler: createScheduler(registry),
        model: "budget-mock",
      }).run(taskId, "budget-owner");

      expect(result).toMatchObject({
        status: "paused",
        stopReason: "task_token_budget_exhausted",
        modelRequests: 1,
      });
      expect(providerCalls).toBe(1);
      expect(toolExecutions).toBe(1);
      const snapshot = new TaskSnapshotReader(database).load(taskId);
      expect(snapshot.task).toMatchObject({ status: "paused", maxTokens: 5_000 });
      expect(snapshot.task.tokenUsage.source).toBe("provider");
      expect(snapshot.task.tokenUsage.provider).toMatchObject({ totalTokens: 3_000 });
      expect(snapshot.modelCalls).toHaveLength(1);
      expect(snapshot.events.filter((event) => event.type === "token_budget_exhausted"))
        .toHaveLength(1);
      expect(snapshot.events.find((event) => event.type === "token_budget_exhausted")?.payload)
        .toMatchObject({
          maxTokens: 5_000,
          providerTokens: 3_000,
          providerCalls: 1,
          estimatedCalls: 0,
          reservedCompletionTokens: 2_048,
          usageUncertain: false,
          reason: "next_request_preflight",
        });
      expect(snapshot.checkpoints.some((checkpoint) =>
        checkpoint.reason === "token_budget_exhausted" &&
        checkpoint.budget.maxTokens === 5_000 &&
        checkpoint.taskStatus === "paused"))
        .toBe(true);
    } finally {
      closeDatabase(database);
    }
  });

  it("restores an exhausted persisted budget after reopening SQLite and sends no provider request", async () => {
    const directory = mkdtempSync(join(tmpdir(), "forgeflow-token-budget-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "budget.db");
    let database: ForgeFlowDatabase = openDatabase(path);
    migrateStorage(database);
    const taskId = "phase4-token-budget-restart";
    new ExecutionUnitOfWork(database).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: "Do not spend more tokens after restart.",
      systemPrompt: "Respect the persisted task budget.",
      maxModelTurns: 8,
      maxToolCalls: 8,
      maxTokens: 50,
      tokenUsage: {
        totalTokens: 75,
        source: "provider",
        provider: { totalTokens: 75 },
        providerCalls: 1,
      },
    });
    closeDatabase(database);
    database = openDatabase(path);
    try {
      migrateStorage(database);
      let providerCalls = 0;
      const registry = createRegistry();
      const provider: LLMProvider = {
        async generate() {
          providerCalls += 1;
          return {
            message: { role: "assistant", content: "Must not run." },
            usage: { source: "unknown" },
          };
        },
      };
      const coordinator = new PersistenceCoordinator({
        database,
        leaseManager: new TaskLeaseManager(database),
        provider,
        registry,
        scheduler: createScheduler(registry),
        model: "budget-mock",
      });
      const result = await coordinator.run(taskId, "restart-budget-owner");
      expect(result).toMatchObject({
        status: "paused",
        stopReason: "task_token_budget_exhausted",
        modelRequests: 0,
      });
      expect(providerCalls).toBe(0);
      await expect(coordinator.resume(taskId, "resume-budget-owner")).rejects.toMatchObject({
        code: "TASK_TOKEN_BUDGET_EXHAUSTED",
      });
      expect(providerCalls).toBe(0);
      expect(new TaskSnapshotReader(database).load(taskId).events
        .filter((event) => event.type === "token_budget_exhausted"))
        .toHaveLength(1);
    } finally {
      closeDatabase(database);
    }
  });
});

function createRegistry(): ToolRegistry {
  return new ToolRegistry();
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
