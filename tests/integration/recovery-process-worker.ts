import { setInterval } from "node:timers";

import { z } from "zod";

import { PersistenceCoordinator } from "../../src/persistence/coordinator.js";
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
} from "../../src/scheduler/index.js";
import {
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
} from "../../src/storage/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { WebAuth } from "../../src/web/auth.js";
import type { WebConfig } from "../../src/web/config.js";
import { createWebServer } from "../../src/web/server-factory.js";
import {
  WebTaskService,
  type WebProviderMode,
} from "../../src/web/task-service.js";

const ConfigSchema = z.object({
  databasePath: z.string().min(1),
  taskId: z.string().min(1),
  scenario: z.enum([
    "running_read",
    "completed_read",
    "running_write",
    "terminal",
    "web_mock",
    "web_pause",
    "lease_compete",
  ]),
}).strict();

const config = ConfigSchema.parse(JSON.parse(process.argv[2] ?? "null"));
const database = openDatabase(config.databasePath);
migrateStorage(database);

function send(message: unknown): void {
  process.send?.(message);
}

function hold(): Promise<never> {
  setInterval(() => undefined, 1_000);
  return new Promise<never>(() => undefined);
}

if (config.scenario === "lease_compete") {
  send({ phase: "lease_ready", taskId: config.taskId });
  process.once("message", () => {
    try {
      const lease = new TaskLeaseManager(database).claim(
        config.taskId,
        `process-${process.pid}`,
      );
      send({
        phase: "lease_result",
        taskId: config.taskId,
        acquired: true,
        fencingToken: lease.fencingToken,
      });
    } catch (error) {
      send({
        phase: "lease_result",
        taskId: config.taskId,
        acquired: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
  await hold();
} else if (config.scenario === "web_mock" || config.scenario === "web_pause") {
  await runWebWorker(config.scenario);
} else {
  await runEngineWorker(config.scenario);
}

async function runEngineWorker(
  scenario: "running_read" | "completed_read" | "running_write" | "terminal",
): Promise<void> {
  const unit = new ExecutionUnitOfWork(database);
  unit.createTask({
    taskId: config.taskId,
    traceId: `trace-${config.taskId}`,
    objective: "Exercise abrupt process recovery.",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 6,
    maxToolCalls: 6,
  });
  const registry = new ToolRegistry();
  registry.register({
    name: "process_read",
    description: "Controlled process recovery read.",
    mode: "read",
    version: "1",
    inputSchema: z.object({}).strict(),
    execute: async () => {
      if (scenario === "running_read") {
        send({ phase: "read_running", taskId: config.taskId });
        return hold();
      }
      return { value: "persisted-read" };
    },
  });
  registry.register({
    name: "process_write",
    description: "Controlled process recovery write.",
    mode: "write",
    version: "1",
    requiresApproval: true,
    inputSchema: z.object({ sequence: z.number().int().positive() }).strict(),
    execute: async () => {
      send({ phase: "write_running", taskId: config.taskId });
      return hold();
    },
  });
  const scheduler = new TaskScheduler({
    registry,
    planner: new TaskPlanner(registry),
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, {
      approvalHandler: { request: async () => ({ status: "approved" }) },
    }),
  });
  const provider: LLMProvider = {
    async generate(
      _request: ModelRequest,
      _options?: GenerateOptions,
    ): Promise<ModelResponse> {
      const snapshot = database.prepare(
        "SELECT COUNT(*) AS count FROM model_calls WHERE task_id = ?",
      ).get(config.taskId) as { count: number };
      if (snapshot.count === 1) {
        return {
          message: {
            role: "assistant",
            content: "Execute the controlled tool.",
            toolCalls: scenario === "running_write"
              ? [
                  { id: "write-1", name: "process_write", arguments: { sequence: 1 } },
                  { id: "write-2", name: "process_write", arguments: { sequence: 2 } },
                ]
              : [{ id: "read-1", name: "process_read", arguments: {} }],
          },
          usage: { source: "unknown" },
        };
      }
      if (scenario === "completed_read") {
        send({ phase: "read_completed", taskId: config.taskId });
        return hold();
      }
      return {
        message: { role: "assistant", content: "Process scenario completed." },
        usage: { source: "unknown" },
      };
    },
  };
  const coordinator = new PersistenceCoordinator({
    database,
    leaseManager: new TaskLeaseManager(database),
    provider,
    registry,
    scheduler,
    model: "mock-process",
    heartbeatIntervalMs: 50,
  });
  const result = await coordinator.run(config.taskId, `worker-${scenario}`);
  send({ phase: "terminal", taskId: config.taskId, status: result.status });
  await hold();
}

async function runWebWorker(scenario: "web_mock" | "web_pause"): Promise<void> {
  const webConfig: WebConfig = {
    host: "127.0.0.1",
    port: 0,
    sessionSecret: "r3-process-session-secret-that-is-long-enough",
    sessionTtlSeconds: 3_600,
    secureCookies: false,
    trustProxy: false,
    guestSessionRateLimitPerMinute: 20,
    guestTaskRateLimitPerMinute: 10,
    maxActiveTasks: 3,
    dailyTaskLimit: 50,
    guestDailyModelTaskLimit: 5,
    defaultModelTurns: 8,
    defaultToolCalls: 20,
    defaultTokenBudget: 50_000,
    approvalTimeoutMs: 60_000,
    allowPaidProvider: false,
    globalProviderConcurrency: 2,
    globalModelTokenBudgetPerDay: 0,
    publicEvaluationRunEnabled: true,
    evaluationRunsPerHour: 3,
    databasePath: config.databasePath,
    environment: "test",
  };
  let calls = 0;
  const providerMode: WebProviderMode = scenario === "web_mock"
    ? { kind: "mock", label: "Mock" }
    : {
        kind: "deepseek",
        label: "DeepSeek",
        model: "r3-controlled-provider",
        provider: {
          async generate(_request, options) {
            calls += 1;
            if (calls === 1) {
              send({ phase: "model_running", taskId: config.taskId });
              await new Promise<void>((_resolve, reject) => {
                options?.signal?.addEventListener(
                  "abort",
                  () => reject(new Error("controlled pause")),
                  { once: true },
                );
              });
            }
            return {
              message: { role: "assistant", content: "Recovered after process restart." },
              usage: { source: "unknown" },
            };
          },
        },
      };
  const service = new WebTaskService(database, webConfig, providerMode);
  const auth = new WebAuth({
    sessionSecret: webConfig.sessionSecret,
    sessionTtlSeconds: webConfig.sessionTtlSeconds,
    secureCookies: webConfig.secureCookies,
  });
  const server = createWebServer({ config: webConfig, service, auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Web worker has no port.");
  send({ phase: "web_ready", taskId: config.taskId, url: `http://127.0.0.1:${address.port}` });
  await hold();
}
