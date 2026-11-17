import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ContextManager } from "../../src/context/index.js";
import { PersistenceCoordinator } from "../../src/persistence/coordinator.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import { RecoveryManager } from "../../src/recovery/recovery-manager.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
} from "../../src/scheduler/index.js";
import {
  closeDatabase,
  ExecutionStateMachine,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import { WebAuth } from "../../src/web/auth.js";
import type { WebConfig } from "../../src/web/config.js";
import { createWebServer } from "../../src/web/server-factory.js";
import {
  WebTaskService,
  type WebProviderMode,
} from "../../src/web/task-service.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";

const workerPath = fileURLToPath(
  new URL("./recovery-process-worker.ts", import.meta.url),
);
const workers: ChildProcess[] = [];
let temporaryDatabase: TemporaryDatabase;
let database: ForgeFlowDatabase | undefined;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
});

afterEach(async () => {
  for (const worker of workers.splice(0)) {
    if (worker.exitCode === null && worker.signalCode === null) {
      await killWorker(worker);
    }
  }
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase.cleanup();
  vi.restoreAllMocks();
});

describe("Phase 3 abrupt process recovery", () => {
  it("takes over an expired lease, retries only an unfinished Read, and completes", async () => {
    const taskId = "r3-running-read";
    const worker = startWorker(taskId, "running_read");
    await waitForWorkerMessage(worker, "read_running");
    await killWorker(worker);

    const activeDatabase = reopen();
    const stale = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(stale.toolRuns[0]?.status).toBe("running");
    expect(stale.checkpoints.some((item) => item.reason === "tool_intent")).toBe(true);
    const leases = futureLeaseManager(activeDatabase);
    const execute = vi.fn(async () => ({ value: "recovered-read" }));
    const registry = createRegistry(execute);
    const recovered = await new RecoveryManager({
      database: activeDatabase,
      leaseManager: leases,
      registry,
      heartbeatIntervalMs: 5,
      now: futureNow,
    }).recoverReadRuns(taskId, "r3-read-takeover");
    expect(recovered.requeuedCount).toBe(1);
    expect(execute).toHaveBeenCalledTimes(1);

    const result = await createCoordinator(
      activeDatabase,
      leases,
      registry,
      new MockLLMProvider("Recovered task completed."),
    ).run(taskId, "r3-read-continuation");
    expect(result.status).toBe("completed");
    const completed = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(completed.task.status).toBe("completed");
    expect(completed.messages.filter((item) => item.role === "tool")).toHaveLength(1);
    expect(completed.events.some((item) => item.type === "recovery.read_retried")).toBe(true);
  });

  it("does not repeat a completed Read after process exit during the next ModelCall", async () => {
    const taskId = "r3-completed-read";
    const worker = startWorker(taskId, "completed_read");
    await waitForWorkerMessage(worker, "read_completed");
    await killWorker(worker);

    const activeDatabase = reopen();
    const leases = futureLeaseManager(activeDatabase);
    const ownership = claim(leases, taskId, "r3-model-recovery");
    let snapshot = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(snapshot.toolRuns[0]?.status).toBe("succeeded");
    const requested = snapshot.modelCalls.find((item) => item.status === "requested");
    expect(requested).toBeDefined();
    new ExecutionUnitOfWork(activeDatabase, leases).failModelCall(
      {
        modelCallId: requested!.id,
        status: "interrupted",
        durationMs: 0,
        error: {
          code: "MODEL_CALL_INTERRUPTED",
          message: "Model call was interrupted by process exit.",
          details: [],
        },
      },
      ownership,
    );
    leases.release(taskId, ownership.leaseToken, ownership.fencingToken);
    const execute = vi.fn(async () => ({ value: "must-not-repeat" }));
    const registry = createRegistry(execute);
    const resumeProvider = new MockLLMProvider("Continued without repeating the read.");
    const result = await createCoordinator(
      activeDatabase,
      leases,
      registry,
      resumeProvider,
      new ContextManager({
        maxContextTokens: 800,
        reservedCompletionTokens: 100,
        maxToolResultTokens: 80,
      }),
    ).resume(taskId, "r3-model-continuation");
    expect(result.status).toBe("completed");
    expect(execute).not.toHaveBeenCalled();
    snapshot = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(snapshot.modelCalls.some((item) => item.status === "interrupted")).toBe(true);
    expect(snapshot.messages.filter((item) => item.role === "tool")).toHaveLength(1);
    const resumedRequest = resumeProvider.requests[0];
    expect(resumedRequest?.messages.some((message) =>
      message.role === "assistant" && message.toolCalls?.some((call) => call.id === "read-1"),
    )).toBe(true);
    expect(resumedRequest?.messages.some((message) =>
      message.role === "tool" && message.toolCallId === "read-1",
    )).toBe(true);
  });

  it("atomically turns a killed running Write into immutable unknown and blocks continuation", async () => {
    const taskId = "r3-running-write";
    const worker = startWorker(taskId, "running_write");
    await waitForWorkerMessage(worker, "write_running");
    await killWorker(worker);

    const activeDatabase = reopen();
    const stale = new TaskSnapshotReader(activeDatabase).load(taskId);
    const oldLease = stale.lease;
    expect(stale.toolRuns.map((item) => item.status)).toEqual(["running", "queued"]);
    activeDatabase.exec(`
      CREATE TRIGGER fail_recovery_review
      BEFORE INSERT ON recovery_reviews
      BEGIN
        SELECT RAISE(ABORT, 'recovery review rejected');
      END
    `);
    const leases = futureLeaseManager(activeDatabase);
    expect(() => new RecoveryManager({
      database: activeDatabase,
      leaseManager: leases,
      now: futureNow,
    }).recoverTask(taskId, "r3-write-recovery-failed")).toThrow();
    let after = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(after.task.status).toBe("running");
    expect(after.toolRuns[0]?.status).toBe("running");
    expect(after.recoveryReviews).toHaveLength(0);
    activeDatabase.exec("DROP TRIGGER fail_recovery_review");

    const report = new RecoveryManager({
      database: activeDatabase,
      leaseManager: leases,
      now: futureNow,
    }).recoverTask(taskId, "r3-write-recovery");
    expect(report.primaryClassification).toBe("write_outcome_unknown");
    after = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(after.task.status).toBe("waiting_review");
    expect(after.toolRuns.map((item) => item.status)).toEqual(["unknown", "queued"]);
    expect(after.planSteps.map((item) => item.status)).toEqual(["waiting_review", "queued"]);
    expect(after.recoveryReviews).toHaveLength(1);
    expect(after.checkpoints.some((item) => item.reason === "recovery_inspected")).toBe(true);
    expect(after.checkpoints.some((item) => item.reason === "recovery_write_interrupted")).toBe(true);

    const execute = vi.fn(async () => ({ written: true }));
    const registry = createRegistry(vi.fn(async () => ({ ok: true })), execute);
    await expect(createCoordinator(
      activeDatabase,
      leases,
      registry,
      new MockLLMProvider("must not continue"),
    ).resume(taskId, "r3-dangerous-resume")).rejects.toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(() => new ExecutionStateMachine(activeDatabase, leases).requestCancel({
      taskId,
      leaseToken: oldLease!.leaseToken as string,
      fencingToken: oldLease!.fencingToken,
      expectedTaskVersion: after.task.version,
    })).toThrow();
  });

  it("does not acquire a lease or execute again for a terminal task after restart", async () => {
    const taskId = "r3-terminal";
    const worker = startWorker(taskId, "terminal");
    await waitForWorkerMessage(worker, "terminal");
    await killWorker(worker);
    const activeDatabase = reopen();
    const snapshot = new TaskSnapshotReader(activeDatabase).load(taskId);
    expect(snapshot.task.status).toBe("completed");
    expect(snapshot.checkpoints.at(-1)?.taskStatus).toBe("completed");
    expect(() => futureLeaseManager(activeDatabase).claim(taskId, "terminal-restart")).toThrow();
  });

  it("allows exactly one of two real processes to acquire the task lease", async () => {
    const taskId = "r3-process-lease-race";
    const setup = openDatabase(temporaryDatabase.path);
    migrateStorage(setup);
    new ExecutionUnitOfWork(setup).createTask({
      taskId,
      traceId: `trace-${taskId}`,
      objective: "Compete for the same task lease.",
      systemPrompt: "You are ForgeFlow.",
      maxModelTurns: 2,
      maxToolCalls: 2,
    });
    closeDatabase(setup);

    const first = startWorker(taskId, "lease_compete");
    const second = startWorker(taskId, "lease_compete");
    await Promise.all([
      waitForWorkerMessage(first, "lease_ready"),
      waitForWorkerMessage(second, "lease_ready"),
    ]);
    const results = Promise.all([
      waitForWorkerMessage(first, "lease_result"),
      waitForWorkerMessage(second, "lease_result"),
    ]);
    first.send({ phase: "go" });
    second.send({ phase: "go" });
    const settled = await results;
    expect(settled.filter((item) => item.acquired === true)).toHaveLength(1);
    expect(settled.filter((item) => item.acquired === false)).toHaveLength(1);
  });

  it("keeps approval pending across a killed Web process and executes one approved Write", async () => {
    const worker = startWorker("r3-web-approval-worker", "web_mock");
    const ready = await waitForWorkerMessage(worker, "web_ready");
    const cookie = await login(ready.url as string);
    const taskId = await createWebTask(ready.url as string, cookie, "stm32-bom-recovery");
    const pending = await waitFor(async () => {
      const approvals = await getJson<Array<{ id: string; taskId: string; status: string }>>(
        `${String(ready.url)}/api/approvals`, cookie,
      );
      return approvals.find((item) => item.taskId === taskId);
    });
    expect(pending.status).toBe("pending");
    await killWorker(worker);

    const activeDatabase = reopen();
    expireAndRelease(activeDatabase, taskId);
    const restarted = await startParentWeb(activeDatabase, { kind: "mock", label: "Mock" });
    try {
      const restartedCookie = cookie;
      const approvals = await getJson<Array<{ id: string; taskId: string; status: string }>>(
        `${restarted.url}/api/approvals`, restartedCookie,
      );
      expect(approvals.find((item) => item.id === pending.id)?.status).toBe("pending");
      const approved = await fetch(`${restarted.url}/api/approvals/${pending.id}/approve`, {
        method: "POST",
        headers: requestHeaders(restartedCookie),
        body: JSON.stringify({ reason: "R3 restart approval." }),
      });
      expect(approved.status).toBe(200);
      const duplicate = await fetch(`${restarted.url}/api/approvals/${pending.id}/approve`, {
        method: "POST",
        headers: requestHeaders(restartedCookie),
        body: JSON.stringify({ reason: "duplicate" }),
      });
      expect(duplicate.status).toBe(409);
      const [resume, duplicateResume] = await Promise.all([
        fetch(`${restarted.url}/api/tasks/${taskId}/resume`, {
          method: "POST",
          headers: requestHeaders(restartedCookie),
        }),
        fetch(`${restarted.url}/api/tasks/${taskId}/resume`, {
          method: "POST",
          headers: requestHeaders(restartedCookie),
        }),
      ]);
      expect([resume.status, duplicateResume.status].sort()).toEqual([200, 409]);
      const completed = await waitFor(async () => {
        const task = await getJson<WebTaskDetail>(
          `${restarted.url}/api/tasks/${taskId}`,
          restartedCookie,
        );
        return task.persistedStatus === "completed" ? task : undefined;
      }, 12_000);
      expect(completed.toolRuns.filter((item) =>
        item.toolName === "procurement_create_draft" && item.status === "succeeded")).toHaveLength(1);
      expect(completed.events.length).toBeGreaterThan(0);
      expect(completed.checkpoints.some((item) => item.reason === "approval_decided")).toBe(true);
    } finally {
      await restarted.close();
    }
  }, 20_000);

  it("pauses through Web API, restarts, resumes, then cancels without new dispatch", async () => {
    const worker = startWorker("r3-web-pause-worker", "web_pause");
    const ready = await waitForWorkerMessage(worker, "web_ready");
    const modelRunning = waitForWorkerMessage(worker, "model_running");
    const cookie = await login(String(ready.url));
    const taskId = await createWebTask(String(ready.url), cookie, "stm32-inventory-audit");
    await modelRunning;
    const pause = await fetch(`${String(ready.url)}/api/tasks/${taskId}/pause`, {
      method: "POST",
      headers: requestHeaders(cookie),
    });
    expect(pause.status).toBe(200);
    await waitFor(async () => {
      const task = await getJson<WebTaskDetail>(`${String(ready.url)}/api/tasks/${taskId}`, cookie);
      return task.persistedStatus === "paused" ? task : undefined;
    });
    await killWorker(worker);

    const activeDatabase = reopen();
    let providerCalls = 0;
    const providerMode: WebProviderMode = {
      kind: "deepseek",
      label: "DeepSeek",
      model: "r3-parent-provider",
      provider: {
        async generate(_request, options) {
          providerCalls += 1;
          if (providerCalls === 1) {
            return {
              message: { role: "assistant", content: "Recovered Web task completed." },
              usage: { source: "unknown" },
            };
          }
          await new Promise<void>((_resolve, reject) => {
            options?.signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
          });
          throw new Error("unreachable");
        },
      },
    };
    const restarted = await startParentWeb(activeDatabase, providerMode);
    try {
      const restartedCookie = cookie;
      const resume = await fetch(`${restarted.url}/api/tasks/${taskId}/resume`, {
        method: "POST",
        headers: requestHeaders(restartedCookie),
      });
      expect(resume.status).toBe(200);
      const completed = await waitFor(async () => {
        const task = await getJson<WebTaskDetail>(`${restarted.url}/api/tasks/${taskId}`, restartedCookie);
        return task.persistedStatus === "completed" ? task : undefined;
      });
      expect(completed.finalAnswer).toBe("Recovered Web task completed.");
      expect(providerCalls).toBe(1);

      const cancelTaskId = await createWebTask(restarted.url, restartedCookie, "stm32-inventory-audit");
      await waitFor(async () => {
        const task = await getJson<WebTaskDetail>(`${restarted.url}/api/tasks/${cancelTaskId}`, restartedCookie);
        return task.active ? task : undefined;
      });
      const cancel = await fetch(`${restarted.url}/api/tasks/${cancelTaskId}/cancel`, {
        method: "POST",
        headers: requestHeaders(restartedCookie),
      });
      expect(cancel.status).toBe(200);
      const cancelled = await waitFor(async () => {
        const task = await getJson<WebTaskDetail>(`${restarted.url}/api/tasks/${cancelTaskId}`, restartedCookie);
        return task.persistedStatus === "cancelled" ? task : undefined;
      });
      expect(cancelled.toolRuns).toHaveLength(0);
      const resumeCancelled = await fetch(`${restarted.url}/api/tasks/${cancelTaskId}/resume`, {
        method: "POST",
        headers: requestHeaders(restartedCookie),
      });
      expect(resumeCancelled.status).toBe(409);
    } finally {
      await restarted.close();
    }
  }, 20_000);
});

interface WebTaskDetail {
  readonly persistedStatus: string;
  readonly active: boolean;
  readonly finalAnswer: string | null;
  readonly toolRuns: readonly { readonly toolName: string; readonly status: string }[];
  readonly events: readonly { readonly type: string }[];
  readonly checkpoints: readonly { readonly reason: string }[];
}

function startWorker(taskId: string, scenario: string): ChildProcess {
  const worker = fork(
    workerPath,
    [JSON.stringify({ databasePath: temporaryDatabase.path, taskId, scenario })],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  workers.push(worker);
  return worker;
}

function waitForWorkerMessage(worker: ChildProcess, phase: string): Promise<Record<string, unknown>> {
  let stderr = "";
  worker.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Worker did not reach ${phase}.\n${stderr}`));
    }, 12_000);
    const onMessage = (message: unknown): void => {
      if (typeof message === "object" && message !== null &&
          "phase" in message && message.phase === phase) {
        cleanup();
        resolve(message as Record<string, unknown>);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`Worker exited before ${phase} (${String(code)}).\n${stderr}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.on("exit", onExit);
  });
}

function killWorker(worker: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    worker.once("error", reject);
    worker.once("exit", () => resolve());
    worker.kill("SIGKILL");
  });
}

function reopen(): ForgeFlowDatabase {
  database = openDatabase(temporaryDatabase.path);
  return database;
}

function futureNow(): Date {
  return new Date(Date.now() + 120_000);
}

function futureLeaseManager(activeDatabase: ForgeFlowDatabase): TaskLeaseManager {
  return new TaskLeaseManager(activeDatabase, { now: futureNow, leaseTtlMs: 30_000 });
}

function claim(manager: TaskLeaseManager, taskId: string, ownerId: string) {
  const lease = manager.claim(taskId, ownerId);
  return {
    taskId,
    leaseToken: lease.leaseToken as string,
    fencingToken: lease.fencingToken,
  };
}

function expireAndRelease(activeDatabase: ForgeFlowDatabase, taskId: string): void {
  const manager = futureLeaseManager(activeDatabase);
  const ownership = claim(manager, taskId, "r3-expiry-takeover");
  manager.release(taskId, ownership.leaseToken, ownership.fencingToken);
}

function createRegistry(
  readExecute: () => Promise<unknown>,
  writeExecute: () => Promise<unknown> = async () => ({ written: true }),
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "process_read",
    description: "Controlled process recovery read.",
    mode: "read",
    version: "1",
    inputSchema: z.object({}).strict(),
    execute: readExecute,
  });
  registry.register({
    name: "process_write",
    description: "Controlled process recovery write.",
    mode: "write",
    version: "1",
    requiresApproval: true,
    inputSchema: z.object({ sequence: z.number().int().positive() }).strict(),
    execute: writeExecute,
  });
  return registry;
}

function createCoordinator(
  activeDatabase: ForgeFlowDatabase,
  leases: TaskLeaseManager,
  registry: ToolRegistry,
  provider: MockLLMProvider,
  contextManager?: ContextManager,
): PersistenceCoordinator {
  const scheduler = new TaskScheduler({
    registry,
    planner: new TaskPlanner(registry),
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, {
      approvalHandler: { request: async () => ({ status: "approved" }) },
    }),
  });
  return new PersistenceCoordinator({
    database: activeDatabase,
    leaseManager: leases,
    provider,
    registry,
    scheduler,
    model: "mock-r3",
    heartbeatIntervalMs: 5,
    ...(contextManager === undefined ? {} : { contextManager }),
  });
}

function webConfig(databasePath: string): WebConfig {
  return {
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
    databasePath,
    environment: "test",
  };
}

async function startParentWeb(activeDatabase: ForgeFlowDatabase, providerMode: WebProviderMode) {
  const config = webConfig(temporaryDatabase.path);
  const service = new WebTaskService(activeDatabase, config, providerMode);
  const auth = new WebAuth({
    sessionSecret: config.sessionSecret,
    sessionTtlSeconds: config.sessionTtlSeconds,
    secureCookies: false,
  });
  const server = createWebServer({ config, service, auth });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No Web port.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await service.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function login(url: string): Promise<string> {
  const response = await fetch(`${url}/api/auth/session`);
  expect(response.status).toBe(200);
  return response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
}

async function createWebTask(url: string, cookie: string, workflowId: string): Promise<string> {
  const response = await fetch(`${url}/api/tasks`, {
    method: "POST",
    headers: requestHeaders(cookie),
    body: JSON.stringify({
      workflowId,
      objective: "Run the R3 process recovery Web scenario against the real backend.",
      buildQuantity: 2_000,
    }),
  });
  expect(response.status).toBe(202);
  const body = await response.json() as { data: { id: string } };
  return body.data.id;
}

function requestHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    "content-type": "application/json",
    "x-forgeflow-client": "web",
  };
}

async function getJson<T>(url: string, cookie: string): Promise<T> {
  const response = await fetch(url, { headers: { cookie } });
  expect(response.status).toBe(200);
  return (await response.json() as { data: T }).data;
}

async function waitFor<T>(read: () => Promise<T | undefined>, timeoutMs = 8_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for R3 recovery state.");
}
