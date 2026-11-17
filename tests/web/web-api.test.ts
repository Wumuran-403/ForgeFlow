import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { WebAuth } from "../../src/web/auth.js";
import type { WebConfig } from "../../src/web/config.js";
import { createWebServer } from "../../src/web/server-factory.js";
import { GlobalModelBudgetProvider } from "../../src/web/global-model-budget.js";
import { WebTaskService } from "../../src/web/task-service.js";
import type { WebProviderMode } from "../../src/web/task-service.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

const config: WebConfig = {
  host: "127.0.0.1",
  port: 0,
  sessionSecret: "test-session-secret-that-is-long-enough",
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
  approvalTimeoutMs: 10_000,
  allowPaidProvider: false,
  globalProviderConcurrency: 2,
  globalModelTokenBudgetPerDay: 0,
  publicEvaluationRunEnabled: true,
  evaluationRunsPerHour: 3,
  databasePath: ":memory:",
  environment: "test",
};

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(":memory:");
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

describe("ForgeFlow web API", () => {
  it("runs the allowlisted MCP workflow through stdio and persists its execution chain", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      const workflows = await getJson<Array<{ id: string; name: string }>>(`${baseUrl}/api/workflows`, cookie);
      expect(workflows).toContainEqual(expect.objectContaining({ id: "stm32-mcp-inventory-audit" }));
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST", headers: requestHeaders(cookie),
        body: JSON.stringify({ workflowId: "stm32-mcp-inventory-audit", objective: "Query the allowlisted STM32 MCP inventory and summarize availability.", buildQuantity: 2_000 }),
      });
      expect(created.status).toBe(202);
      const payload = await created.json() as { data: { id: string } };
      const detail = await waitFor(async () => {
        const current = await getJson<TaskDetailEnvelope>(`${baseUrl}/api/tasks/${payload.data.id}`, cookie);
        return current.persistedStatus === "completed" ? current : undefined;
      }, 15_000);
      expect(detail.toolRuns).toEqual([expect.objectContaining({ toolName: "mcp_inventory_inventory_search", status: "succeeded" })]);
      expect(detail.events.some((event) => event.type === "tool.intent_committed")).toBe(true);
      expect(detail.events.some((event) => event.type === "tool.succeeded")).toBe(true);
      expect(detail.checkpoints.length).toBeGreaterThan(0);
      const metrics = await getJson<{ mcp: { calls: number; succeeded: number }; ratios: { mcpSuccess: { numerator: number; denominator: number } } }>(`${baseUrl}/api/metrics/summary`, cookie);
      expect(metrics.mcp).toMatchObject({ calls: 1, succeeded: 1 });
      expect(metrics.ratios.mcpSuccess).toEqual({ numerator: 1, denominator: 1 });

      const arbitrary = await fetch(`${baseUrl}/api/tasks`, { method: "POST", headers: requestHeaders(cookie),
        body: JSON.stringify({ workflowId: "stm32-mcp-inventory-audit", objective: "Attempt to override the MCP server configuration.", buildQuantity: 1, mcpServerUrl: "http://attacker.invalid", command: "evil" }) });
      expect(arbitrary.status).toBe(400);
    } finally { await close(); }
  }, 20_000);

  it("limits evaluation concurrency and execution frequency", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      const start = () => fetch(`${baseUrl}/api/evals/run`, { method: "POST", headers: requestHeaders(cookie) });
      const concurrent = await Promise.all([start(), start()]);
      expect(concurrent.map((response) => response.status).sort()).toEqual([201, 409]);
      expect((await start()).status).toBe(201);
      expect((await start()).status).toBe(201);
      expect((await start()).status).toBe(429);
      const history = await getJson<Array<{ id: string }>>(`${baseUrl}/api/evals`, cookie);
      expect(history).toHaveLength(3);
    } finally { await close(); }
  }, 30_000);

  it("creates isolated guest actors and rejects cross-guest task and approval access", async () => {
    const { baseUrl, cookie: firstCookie, close } = await startTestServer();
    try {
      const firstSession = await getJson<{ actorId: string; kind: string }>(`${baseUrl}/api/auth/session`, firstCookie);
      const refreshed = await fetch(`${baseUrl}/api/auth/session`, { headers: { cookie: firstCookie } });
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("set-cookie")).toBeNull();
      expect((await refreshed.json() as { data: { actorId: string } }).data.actorId).toBe(firstSession.actorId);

      const secondSessionResponse = await fetch(`${baseUrl}/api/auth/session`);
      const secondCookie = secondSessionResponse.headers.get("set-cookie")!.split(";", 1)[0]!;
      const secondSession = await secondSessionResponse.json() as { data: { actorId: string } };
      expect(secondSession.data.actorId).not.toBe(firstSession.actorId);

      const createdResponse = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(firstCookie),
        body: JSON.stringify({
          workflowId: "stm32-bom-recovery",
          objective: "Inspect the STM32 BOM and prepare a local draft after guest approval.",
          buildQuantity: 2_000,
        }),
      });
      const created = await createdResponse.json() as { data: { id: string } };
      const approval = await waitFor(async () => {
        const approvals = await getJson<Array<{ id: string }>>(`${baseUrl}/api/approvals`, firstCookie);
        return approvals[0];
      });

      expect((await fetch(`${baseUrl}/api/tasks/${created.data.id}`, { headers: { cookie: secondCookie } })).status).toBe(404);
      expect(await getJson<unknown[]>(`${baseUrl}/api/tasks`, secondCookie)).toHaveLength(0);
      expect(await getJson<unknown[]>(`${baseUrl}/api/approvals`, secondCookie)).toHaveLength(0);
      const crossGuestApproval = await fetch(`${baseUrl}/api/approvals/${approval.id}/approve`, {
        method: "POST",
        headers: requestHeaders(secondCookie),
        body: JSON.stringify({}),
      });
      expect(crossGuestApproval.status).toBe(404);
    } finally { await close(); }
  });

  it("rate limits anonymous guest session issuance by network source", async () => {
    const { baseUrl, close } = await startTestServer(
      { kind: "mock", label: "Mock" },
      { guestSessionRateLimitPerMinute: 2 },
    );
    try {
      expect((await fetch(`${baseUrl}/api/auth/session`)).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/auth/session`)).status).toBe(429);
    } finally { await close(); }
  });

  it("keeps public evaluation history readable when execution is disabled", async () => {
    const { baseUrl, cookie, close } = await startTestServer(
      { kind: "mock", label: "Mock" },
      { publicEvaluationRunEnabled: false },
    );
    try {
      expect((await fetch(`${baseUrl}/api/evals`, { headers: { cookie } })).status).toBe(200);
      expect((await fetch(`${baseUrl}/api/evals/run`, {
        method: "POST", headers: requestHeaders(cookie), body: JSON.stringify({}),
      })).status).toBe(403);
    } finally { await close(); }
  });

  it("enforces the per-guest daily real-model task quota", async () => {
    let calls = 0;
    const mode: WebProviderMode = {
      kind: "deepseek", label: "DeepSeek", model: "quota-test", provider: {
        async generate() {
          calls += 1;
          return { message: { role: "assistant", content: "Quota test completed." }, usage: { source: "provider", totalTokens: 10 } };
        },
      },
    };
    const { baseUrl, cookie, close } = await startTestServer(mode, {
      guestDailyModelTaskLimit: 1,
    });
    try {
      const input = {
        workflowId: "stm32-inventory-audit",
        objective: "Audit the STM32 inventory under the guest model task quota.",
        buildQuantity: 2_000,
      };
      const first = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST", headers: requestHeaders(cookie), body: JSON.stringify(input),
      });
      expect(first.status).toBe(202);
      const firstBody = await first.json() as { data: { id: string } };
      await waitFor(async () => {
        const task = await getJson<TaskDetailEnvelope>(`${baseUrl}/api/tasks/${firstBody.data.id}`, cookie);
        return task.persistedStatus === "completed" ? task : undefined;
      });
      const second = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST", headers: requestHeaders(cookie), body: JSON.stringify(input),
      });
      expect(second.status).toBe(429);
      expect((await second.json() as { error: { code: string } }).error.code).toBe("WEB_DAILY_MODEL_TASK_LIMIT");
      expect(calls).toBe(1);
    } finally { await close(); }
  });

  it("pauses before a paid provider call when the persistent global budget is exhausted", async () => {
    let providerCalls = 0;
    const budgeted = new GlobalModelBudgetProvider(database as ForgeFlowDatabase, {
      async generate() {
        providerCalls += 1;
        return { message: { role: "assistant", content: "must not run" }, usage: { source: "provider", totalTokens: 1 } };
      },
    }, {
      maxTokensPerDay: 1,
      maxConcurrentCalls: 1,
      reservedCompletionTokens: 1,
    });
    const { baseUrl, cookie, close } = await startTestServer({
      kind: "deepseek", label: "DeepSeek", model: "paid-test", provider: budgeted,
    });
    try {
      const response = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({
          workflowId: "stm32-inventory-audit",
          objective: "Audit the STM32 inventory without exceeding the global paid budget.",
          buildQuantity: 2_000,
        }),
      });
      const created = await response.json() as { data: { id: string } };
      const detail = await waitFor(async () => {
        const current = await getJson<TaskDetailEnvelope>(`${baseUrl}/api/tasks/${created.data.id}`, cookie);
        return current.persistedStatus === "paused" ? current : undefined;
      });
      expect(providerCalls).toBe(0);
      expect(detail.events.some((event) => event.type === "global_model_budget_exhausted")).toBe(true);
      expect(detail.checkpoints.some((checkpoint) => checkpoint.reason === "global_model_budget_exhausted")).toBe(true);
      expect((await fetch(`${baseUrl}/api/tasks/${created.data.id}/resume`, {
        method: "POST", headers: requestHeaders(cookie), body: JSON.stringify({}),
      })).status).toBe(409);
    } finally { await close(); }
  });

  it("serves persisted observability metrics and evaluation reports", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      expect((await fetch(`${baseUrl}/api/metrics/summary`)).status).toBe(401);
      const runResponse = await fetch(`${baseUrl}/api/evals/run`, {
        method: "POST",
        headers: requestHeaders(cookie),
      });
      expect(runResponse.status).toBe(201);
      const runEnvelope = await runResponse.json() as { data: { id: string; aggregate: { caseCount: number; passedCount: number } } };
      expect(runEnvelope.data.aggregate).toEqual(expect.objectContaining({ caseCount: 30, passedCount: 30 }));
      const summary = await getJson<{ evaluations: { runs: number; completed: number }; tokens: { provider: number; estimated: number } }>(`${baseUrl}/api/metrics/summary`, cookie);
      expect(summary.evaluations).toEqual({ runs: 1, completed: 1, failed: 0 });
      expect(summary.tokens).toMatchObject({ provider: 0, estimated: 0 });
      const history = await getJson<Array<{ id: string }>>(`${baseUrl}/api/evals`, cookie);
      expect(history.map((run) => run.id)).toContain(runEnvelope.data.id);
      const report = await getJson<{ run: { id: string }; cases: unknown[] }>(`${baseUrl}/api/evals/${runEnvelope.data.id}`, cookie);
      expect(report.run.id).toBe(runEnvelope.data.id);
      expect(report.cases).toHaveLength(30);
      expect(JSON.stringify(report)).not.toContain("actor-a");
      expect(JSON.stringify(report)).not.toContain("private task objective");
    } finally { await close(); }
  }, 30_000);

  it("rate limits task creation attempts per authenticated actor", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const response = await fetch(`${baseUrl}/api/tasks`, {
          method: "POST",
          headers: requestHeaders(cookie),
          body: JSON.stringify({ workflowId: "invalid", objective: "short" }),
        });
        expect(response.status).toBe(400);
      }
      const limited = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({ workflowId: "invalid", objective: "short" }),
      });
      expect(limited.status).toBe(429);
    } finally {
      await close();
    }
  });

  it("shows an orphaned approval as interrupted after a server restart", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const first = new WebTaskService(activeDatabase, config, { kind: "mock", label: "Mock" });
    const created = first.createTask({
      actorId: "actor-a",
      workflowId: "stm32-bom-recovery",
      objective: "Check the STM32 BOM and create a local draft after approval.",
      buildQuantity: 2_000,
    });
    try {
      await waitFor(async () => first.listApprovals("actor-a").length > 0 ? true : undefined);
      const restarted = new WebTaskService(activeDatabase, config, { kind: "mock", label: "Mock" });
      const task = restarted.getTask("actor-a", created.id);
      expect(task.status).toBe("waiting_approval");
      expect(task.active).toBe(false);
      expect(task.pendingApprovalCount).toBe(1);
      expect(restarted.listApprovals("actor-a")).toHaveLength(1);
      expect(task.toolRuns.some((run) => run.toolName === "procurement_create_draft" && run.status === "succeeded")).toBe(false);
    } finally {
      await first.stop();
    }
  });

  it("keeps approval pending across a service restart and resumes one approved write", async () => {
    const fileDatabase = openDatabase((temporaryDatabase as TemporaryDatabase).path);
    migrateStorage(fileDatabase);
    const first = new WebTaskService(fileDatabase, config, { kind: "mock", label: "Mock" });
    const created = first.createTask({
      actorId: "actor-a", workflowId: "stm32-bom-recovery",
      objective: "Check the STM32 BOM and create a local draft after approval.", buildQuantity: 2_000,
    });
    const pending = await waitFor(async () => first.listApprovals("actor-a")[0]);
    await first.stop();
    closeDatabase(fileDatabase);
    const reopenedDatabase = openDatabase((temporaryDatabase as TemporaryDatabase).path);
    const restarted = new WebTaskService(reopenedDatabase, config, { kind: "mock", label: "Mock" });
    expect(restarted.listApprovals("actor-a")[0]?.id).toBe(pending.id);
    expect(restarted.getTask("actor-a", created.id).toolRuns.find((run) => run.toolName === "procurement_create_draft")?.status).toBe("awaiting_approval");
    restarted.decideApproval({ actorId: "actor-a", approvalId: pending.id, decision: "approved" });
    expect(() => restarted.decideApproval({ actorId: "actor-a", approvalId: pending.id, decision: "approved" })).toThrow();
    restarted.resumeTask("actor-a", created.id);
    const completed = await waitFor(async () => {
      const task = restarted.getTask("actor-a", created.id);
      return task.status === "completed" ? task : undefined;
    });
    expect(completed.toolRuns.filter((run) => run.toolName === "procurement_create_draft" && run.status === "succeeded")).toHaveLength(1);
    expect(completed.toolRuns.find((run) => run.toolName === "procurement_get_drafts")?.output).toMatchObject({ count: 1 });
    await restarted.stop();
    closeDatabase(reopenedDatabase);
  });

  it("pauses and resumes a Web model call through authenticated controls", async () => {
    let calls = 0;
    const mode: WebProviderMode = { kind: "deepseek", label: "DeepSeek", model: "test", provider: {
      async generate(_request, options) {
        calls += 1;
        if (calls === 1) await new Promise<void>((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
        return { message: { role: "assistant", content: "Recovered after pause." }, usage: { source: "unknown" } };
      },
    } };
    const { baseUrl, cookie, close } = await startTestServer(mode);
    try {
      const created = await fetch(`${baseUrl}/api/tasks`, { method: "POST", headers: requestHeaders(cookie),
        body: JSON.stringify({ workflowId: "stm32-inventory-audit", objective: "Audit the local STM32 BOM after a pause.", buildQuantity: 2_000 }) });
      const { data: task } = await created.json() as { data: { id: string } };
      const unauthenticated = await fetch(`${baseUrl}/api/tasks/${task.id}/pause`, { method: "POST", headers: { "x-forgeflow-client": "web" } });
      expect(unauthenticated.status).toBe(401);
      const pause = await fetch(`${baseUrl}/api/tasks/${task.id}/pause`, { method: "POST", headers: requestHeaders(cookie) });
      expect(pause.status).toBe(200);
      await waitFor(async () => (await getJson<TaskDetailEnvelope>(`${baseUrl}/api/tasks/${task.id}`, cookie)).persistedStatus === "paused" ? true : undefined);
      const resume = await fetch(`${baseUrl}/api/tasks/${task.id}/resume`, { method: "POST", headers: requestHeaders(cookie) });
      expect(resume.status).toBe(200);
      const completed = await waitFor(async () => {
        const detail = await getJson<TaskDetailEnvelope>(`${baseUrl}/api/tasks/${task.id}`, cookie);
        return detail.persistedStatus === "completed" ? detail : undefined;
      });
      expect(completed.finalAnswer).toBe("Recovered after pause.");
      expect(calls).toBe(2);
    } finally { await close(); }
  });

  it("cancels a pending approval without executing its write", async () => {
    const service = new WebTaskService(database as ForgeFlowDatabase, config, { kind: "mock", label: "Mock" });
    const created = service.createTask({
      actorId: "actor-a", workflowId: "stm32-bom-recovery",
      objective: "Review the STM32 BOM and prepare a local draft only if approved.", buildQuantity: 2_000,
    });
    await waitFor(async () => service.listApprovals("actor-a")[0]);
    service.cancelTask("actor-a", created.id);
    const cancelled = await waitFor(async () => {
      const task = service.getTask("actor-a", created.id);
      return task.persistedStatus === "cancelled" ? task : undefined;
    });
    expect(cancelled.approvals[0]?.status).toBe("cancelled");
    expect(cancelled.toolRuns.find((run) => run.toolName === "procurement_create_draft")?.status).toBe("cancelled");
    expect(() => service.resumeTask("actor-a", created.id)).toThrow();
    await service.stop();
  });

  it("requires the exact HTTPS origin for production writes", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const productionConfig = { ...config, publicOrigin: "https://forgeflow.example", secureCookies: true };
    const service = new WebTaskService(activeDatabase, productionConfig, { kind: "mock", label: "Mock" });
    const auth = new WebAuth({ sessionSecret: config.sessionSecret, sessionTtlSeconds: 3600, secureCookies: true });
    const server = createWebServer({ config: productionConfig, service, auth });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("No server port");
      const sessionUrl = `http://127.0.0.1:${address.port}/api/auth/session`;
      const session = await fetch(sessionUrl);
      expect(session.status).toBe(200);
      const cookie = session.headers.get("set-cookie")!;
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      const url = `http://127.0.0.1:${address.port}/api/tasks`;
      const headers = { cookie: cookie.split(";")[0]!, "content-type": "application/json", "x-forgeflow-client": "web" };
      const body = JSON.stringify({ workflowId: "invalid", objective: "short" });
      expect((await fetch(url, { method: "POST", headers, body })).status).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "http://forgeflow.example" }, body })).status).toBe(403);
      expect((await fetch(url, { method: "POST", headers: { ...headers, origin: "https://forgeflow.example" }, body })).status).toBe(400);
    } finally {
      await service.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("uses a guest session, runs a real backend approval, and restores task state by polling", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      const unauthenticated = await fetch(`${baseUrl}/api/tasks`);
      expect(unauthenticated.status).toBe(401);
      const internalRoute = await fetch(`${baseUrl}/internal/recovery-review/authenticate`);
      expect(internalRoute.status).toBe(404);
      const removedLoginRoute = await fetch(`${baseUrl}/api/auth/login`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({ accessToken: "no-longer-accepted" }),
      });
      expect(removedLoginRoute.status).toBe(404);

      const tamperedCookie = `${cookie.slice(0, -1)}${
        cookie.endsWith("a") ? "b" : "a"
      }`;
      const tamperedSession = await fetch(`${baseUrl}/api/tasks`, {
        headers: { cookie: tamperedCookie },
      });
      expect(tamperedSession.status).toBe(401);

      const crossOriginWrite = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: {
          ...requestHeaders(cookie),
          origin: "https://untrusted.example",
        },
        body: JSON.stringify({
          workflowId: "stm32-inventory-audit",
          objective: "Attempt a cross-origin task creation request.",
        }),
      });
      expect(crossOriginWrite.status).toBe(403);

      const invalidPayload = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({
          workflowId: "stm32-bom-recovery",
          objective: "short",
        }),
      });
      expect(invalidPayload.status).toBe(400);

      const workflows = await getJson<Array<{ id: string; defaultObjective: string }>>(
        `${baseUrl}/api/workflows`,
        cookie,
      );
      const workflow = workflows.find(
        (candidate) => candidate.id === "stm32-bom-recovery",
      );
      expect(workflow).toBeDefined();

      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({
          workflowId: workflow!.id,
          objective: workflow!.defaultObjective,
          buildQuantity: 2_000,
        }),
      });
      expect(created.status).toBe(202);
      const task = (await created.json()) as {
        data: { id: string };
      };

      const pending = await waitFor(async () => {
        const approvals = await getJson<Array<{
          id: string;
          taskId: string;
          status: string;
        }>>(`${baseUrl}/api/approvals`, cookie);
        return approvals.find((approval) => approval.taskId === task.data.id);
      });
      expect(pending?.status).toBe("pending");

      const approvalDecision = await fetch(
        `${baseUrl}/api/approvals/${pending!.id}/approve`,
        {
          method: "POST",
          headers: requestHeaders(cookie),
          body: JSON.stringify({ reason: "Approved by web integration test." }),
        },
      );
      expect(approvalDecision.status).toBe(200);

      const detail = await waitFor(async () => {
        const current = await getJson<TaskDetailEnvelope>(
          `${baseUrl}/api/tasks/${task.data.id}`,
          cookie,
        );
        return current.status === "completed" ? current : undefined;
      }, 10_000);

      expect(detail.persistedStatus).toBe("completed");
      expect(detail.finalAnswer).toContain("Re-reading confirmed 1");
      expect(
        detail.toolRuns.find((run) => run.toolName === "procurement_create_draft")
          ?.status,
      ).toBe("succeeded");
      expect(
        detail.toolRuns.find((run) => run.toolName === "procurement_get_drafts")
          ?.output,
      ).toMatchObject({ count: 1 });
      expect(detail.approvals[0]?.status).toBe("approved");

      const refreshed = await getJson<TaskDetailEnvelope>(
        `${baseUrl}/api/tasks/${task.data.id}`,
        cookie,
      );
      expect(refreshed.id).toBe(task.data.id);
    } finally {
      await close();
    }
  });

  it("persists a rejected approval as a skipped write without creating a draft", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({
          workflowId: "stm32-bom-recovery",
          objective:
            "Run the STM32 BOM workflow for 2,000 boards and request a simulated draft.",
          buildQuantity: 2_000,
        }),
      });
      const task = (await created.json()) as { data: { id: string } };
      const pending = await waitFor(async () => {
        const approvals = await getJson<Array<{ id: string; taskId: string }>>(
          `${baseUrl}/api/approvals`,
          cookie,
        );
        return approvals.find((approval) => approval.taskId === task.data.id);
      });
      await fetch(`${baseUrl}/api/approvals/${pending!.id}/reject`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({ reason: "Rejected by test." }),
      });

      const detail = await waitFor(async () => {
        const current = await getJson<TaskDetailEnvelope>(
          `${baseUrl}/api/tasks/${task.data.id}`,
          cookie,
        );
        return current.status === "completed" ? current : undefined;
      }, 10_000);
      expect(
        detail.toolRuns.find((run) => run.toolName === "procurement_create_draft")
          ?.status,
      ).toBe("skipped");
      expect(
        detail.toolRuns.find((run) => run.toolName === "procurement_get_drafts")
          ?.output,
      ).toMatchObject({ count: 0 });
      expect(detail.approvals[0]?.status).toBe("rejected");
    } finally {
      await close();
    }
  });

  it("runs the second workflow as a true read-only audit", async () => {
    const { baseUrl, cookie, close } = await startTestServer();
    try {
      const created = await fetch(`${baseUrl}/api/tasks`, {
        method: "POST",
        headers: requestHeaders(cookie),
        body: JSON.stringify({
          workflowId: "stm32-inventory-audit",
          objective:
            "Audit the STM32 BOM and inventory for 2,000 boards without performing writes.",
          buildQuantity: 2_000,
        }),
      });
      const task = (await created.json()) as { data: { id: string } };
      const detail = await waitFor(async () => {
        const current = await getJson<TaskDetailEnvelope>(
          `${baseUrl}/api/tasks/${task.data.id}`,
          cookie,
        );
        return current.status === "completed" ? current : undefined;
      }, 10_000);
      expect(detail.toolRuns.every((run) => !run.toolName.startsWith("procurement_"))).toBe(
        true,
      );
      expect(detail.finalAnswer).toContain("short 950");
      expect(detail.finalAnswer).toContain("short 1600");
      expect(detail.tokenBudget.maxTokens).toBe(50_000);
      expect(detail.tokenBudget.usedTokens).toBeGreaterThan(0);
      expect(detail.tokenUsage.estimated?.totalTokens).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  it("isolates task listing and lookup by authenticated actor identity", async () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const service = new WebTaskService(activeDatabase, config, {
      kind: "mock",
      label: "Mock",
    });
    const created = service.createTask({
      actorId: "actor-a",
      workflowId: "stm32-inventory-audit",
      objective:
        "Audit the STM32 BOM and inventory for 2,000 boards without writes.",
      buildQuantity: 2_000,
    });

    expect(service.listTasks("actor-b")).toEqual([]);
    expect(() => service.getTask("actor-b", created.id)).toThrowError(
      /Task was not found/,
    );
    expect(service.listTasks("actor-a").map((task) => task.id)).toContain(
      created.id,
    );
    expect(service.metricsSummary("actor-b").tasks.total).toBe(0);
    expect(service.metricsSummary("actor-a").tasks.total).toBe(1);
    await service.stop();
  });
});

interface TaskDetailEnvelope {
  id: string;
  status: string;
  persistedStatus: string;
  finalAnswer: string | null;
  tokenUsage: {
    totalTokens?: number;
    provider?: { totalTokens?: number };
    estimated?: { totalTokens?: number };
  };
  tokenBudget: {
    maxTokens: number | null;
    usedTokens: number;
    remainingTokens: number | null;
    exhausted: boolean;
  };
  toolRuns: Array<{
    toolName: string;
    status: string;
    output: unknown;
  }>;
  events: Array<{ type: string }>;
  checkpoints: Array<{ sequence: number; reason: string }>;
  approvals: Array<{ status: string }>;
}

async function startTestServer(
  providerMode: WebProviderMode = { kind: "mock", label: "Mock" },
  configOverrides: Partial<WebConfig> = {},
): Promise<{
  baseUrl: string;
  cookie: string;
  close(): Promise<void>;
}> {
  const activeDatabase = database as ForgeFlowDatabase;
  const serverConfig = { ...config, ...configOverrides };
  const service = new WebTaskService(activeDatabase, serverConfig, providerMode);
  const auth = new WebAuth({
    sessionSecret: serverConfig.sessionSecret,
    sessionTtlSeconds: serverConfig.sessionTtlSeconds,
    secureCookies: serverConfig.secureCookies,
  });
  const server = createWebServer({
    config: { ...serverConfig, port: 0 },
    service,
    auth,
    staticDirectory: "web/dist",
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Test server did not expose a TCP port.");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const session = await fetch(`${baseUrl}/api/auth/session`);
  expect(session.status).toBe(200);
  const setCookie = session.headers.get("set-cookie");
  expect(setCookie).toContain("forgeflow_session=");
  return {
    baseUrl,
    cookie: setCookie!.split(";")[0]!,
    close: async () => {
      await service.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function requestHeaders(cookie: string): Record<string, string> {
  return {
    cookie,
    "content-type": "application/json",
    "x-forgeflow-client": "web",
  };
}

async function getJson<T>(url: string, cookie: string): Promise<T> {
  const response = await fetch(url, {
    headers: {
      cookie,
      "x-forgeflow-client": "web",
    },
  });
  expect(response.status).toBe(200);
  const payload = (await response.json()) as { data: T };
  return payload.data;
}

async function waitFor<T>(
  load: () => Promise<T | undefined>,
  timeoutMs = 5_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await load();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for web task state.");
}
