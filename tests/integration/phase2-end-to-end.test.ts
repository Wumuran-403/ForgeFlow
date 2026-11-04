import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import type {
  LLMProvider,
} from "../../src/provider/types.js";
import {
  MockLLMProvider,
  type MockProviderResponse,
} from "../../src/provider/mock-provider.js";
import { ReadWorkerPool } from "../../src/scheduler/read-worker-pool.js";
import { TaskPlanner } from "../../src/scheduler/planner.js";
import { TaskScheduler } from "../../src/scheduler/task-scheduler.js";
import type {
  WriteApprovalDecision,
  WriteApprovalHandler,
  WriteApprovalRequest,
} from "../../src/scheduler/types.js";
import { WriteExecutor } from "../../src/scheduler/write-executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionContext, ToolMode } from "../../src/tools/types.js";

const bomInputSchema = z.object({}).strict();
const inventoryInputSchema = z
  .object({
    partNumber: z.string().trim().min(1).default("STM32F103C8T6"),
  })
  .strict();
const updateInputSchema = z
  .object({
    note: z.string().trim().min(1),
  })
  .strict();
const reportInputSchema = z
  .object({
    format: z.enum(["json", "markdown"]).default("json"),
  })
  .strict();

type HarnessEventType =
  | "tool_start"
  | "tool_end"
  | "approval_request"
  | "approval_decision";

interface HarnessEvent {
  type: HarnessEventType;
  toolCallId: string;
  toolName: string;
  mode?: ToolMode;
  at: number;
  status?: string;
}

interface HarnessOptions {
  maxReadConcurrency?: number;
  timeoutMs?: number;
  holdReadIds?: readonly string[];
  holdWriteIds?: readonly string[];
  failReadIds?: readonly string[];
  unknownWriteIds?: readonly string[];
  onToolStart?: (event: HarnessEvent) => void;
  approvalHandler?: (
    request: WriteApprovalRequest,
    options: { signal?: AbortSignal },
  ) => Promise<WriteApprovalDecision>;
}

class BomHarness {
  readonly registry = new ToolRegistry();
  readonly scheduler: TaskScheduler;
  readonly events: HarnessEvent[] = [];
  readonly approvalRequests: WriteApprovalRequest[] = [];
  readonly executionCounts = new Map<string, number>();
  maxActiveReads = 0;
  maxActiveWrites = 0;
  overlapViolations = 0;
  private activeReads = 0;
  private activeWrites = 0;
  private revision = 0;
  private readonly heldReadIds: Set<string>;
  private readonly heldWriteIds: Set<string>;
  private readonly failedReadIds: Set<string>;
  private readonly unknownWriteIds: Set<string>;
  private readonly releasedReadIds = new Set<string>();
  private readonly releasedWriteIds = new Set<string>();
  private readonly readRelease = new Map<string, () => void>();
  private readonly writeRelease = new Map<string, () => void>();
  private readonly eventWaiters: Array<{
    type: HarnessEventType;
    toolCallId: string;
    resolve: () => void;
  }> = [];
  private readonly onToolStart:
    | ((event: HarnessEvent) => void)
    | undefined;

  constructor(options: HarnessOptions = {}) {
    this.heldReadIds = new Set(options.holdReadIds);
    this.heldWriteIds = new Set(options.holdWriteIds);
    this.failedReadIds = new Set(options.failReadIds);
    this.unknownWriteIds = new Set(options.unknownWriteIds);
    this.onToolStart = options.onToolStart;
    const timeoutMs = options.timeoutMs ?? 10_000;
    const customApproval = options.approvalHandler;
    const approvalHandler: WriteApprovalHandler = {
      request: async (request, approvalOptions) => {
        this.approvalRequests.push(request);
        this.recordEvent("approval_request", request.toolCallId, request.toolName);
        const decision =
          customApproval === undefined
            ? ({ status: "approved" } satisfies WriteApprovalDecision)
            : await customApproval(request, approvalOptions);
        this.recordEvent(
          "approval_decision",
          request.toolCallId,
          request.toolName,
          undefined,
          decision.status,
        );
        return decision;
      },
    };

    this.registry.register({
      name: "bom_get_items",
      description: "Read the local simulated BOM.",
      mode: "read",
      inputSchema: bomInputSchema,
      timeoutMs,
      execute: async (_input, context) =>
        this.executeRead("bom_get_items", context, async () => ({
          revision: this.revision,
          lines: [
            {
              designator: "U1",
              partNumber: "STM32F103C8T6",
              quantity: 1,
            },
          ],
        })),
    });
    this.registry.register({
      name: "inventory_lookup",
      description: "Read the local simulated inventory.",
      mode: "read",
      inputSchema: inventoryInputSchema,
      timeoutMs,
      execute: async ({ partNumber }, context) =>
        this.executeRead("inventory_lookup", context, async () => ({
          partNumber,
          available: 1_050,
          sufficient: true,
        })),
    });
    this.registry.register({
      name: "bom_update",
      description: "Update the local simulated BOM.",
      mode: "write",
      inputSchema: updateInputSchema,
      timeoutMs,
      requiresApproval: true,
      execute: async ({ note }, context) =>
        this.executeWrite("bom_update", context, async () => {
          this.revision += 1;
          return {
            revision: this.revision,
            note,
          };
        }),
    });
    this.registry.register({
      name: "production_report_generate",
      description: "Generate a local production preparation report.",
      mode: "write",
      inputSchema: reportInputSchema,
      timeoutMs,
      requiresApproval: true,
      execute: async ({ format }, context) =>
        this.executeWrite("production_report_generate", context, async () => ({
          format,
          revision: this.revision,
          status: "ready",
        })),
    });

    this.scheduler = new TaskScheduler({
      registry: this.registry,
      planner: new TaskPlanner(this.registry),
      readWorkerPool: new ReadWorkerPool(this.registry, {
        maxConcurrency: options.maxReadConcurrency ?? 3,
        defaultTimeoutMs: timeoutMs,
      }),
      writeExecutor: new WriteExecutor(this.registry, {
        defaultTimeoutMs: timeoutMs,
        approvalTimeoutMs: timeoutMs,
        approvalHandler,
      }),
    });
  }

  releaseRead(toolCallId: string): void {
    this.releasedReadIds.add(toolCallId);
    this.readRelease.get(toolCallId)?.();
  }

  releaseWrite(toolCallId: string): void {
    this.releasedWriteIds.add(toolCallId);
    this.writeRelease.get(toolCallId)?.();
  }

  waitForEvent(type: HarnessEventType, toolCallId: string): Promise<void> {
    if (
      this.events.some(
        (event) => event.type === type && event.toolCallId === toolCallId,
      )
    ) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.eventWaiters.push({ type, toolCallId, resolve });
    });
  }

  event(type: HarnessEventType, toolCallId: string): HarnessEvent {
    const event = this.events.find(
      (candidate) =>
        candidate.type === type && candidate.toolCallId === toolCallId,
    );
    if (event === undefined) {
      throw new Error(`Missing event ${type}:${toolCallId}`);
    }
    return event;
  }

  private async executeRead(
    toolName: string,
    context: ToolExecutionContext | undefined,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const callId = context?.toolCallId ?? "missing-context";
    this.executionCounts.set(callId, (this.executionCounts.get(callId) ?? 0) + 1);
    this.begin("read", toolName, callId);
    let status = "succeeded";

    try {
      if (this.heldReadIds.has(callId) && !this.releasedReadIds.has(callId)) {
        await new Promise<void>((resolve) => {
          this.readRelease.set(callId, resolve);
        });
      }

      if (this.failedReadIds.has(callId)) {
        throw new Error("private simulated read failure");
      }

      return await operation();
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      this.end("read", toolName, callId, status);
    }
  }

  private async executeWrite(
    toolName: string,
    context: ToolExecutionContext | undefined,
    operation: () => Promise<unknown>,
  ): Promise<unknown> {
    const callId = context?.toolCallId ?? "missing-context";
    this.executionCounts.set(callId, (this.executionCounts.get(callId) ?? 0) + 1);
    this.begin("write", toolName, callId);
    let status = "succeeded";

    try {
      if (this.heldWriteIds.has(callId) && !this.releasedWriteIds.has(callId)) {
        await new Promise<void>((resolve) => {
          this.writeRelease.set(callId, resolve);
        });
      }

      if (this.unknownWriteIds.has(callId)) {
        throw new Error(`private write failure ${callId}`);
      }

      return await operation();
    } catch (error) {
      status = "failed";
      throw error;
    } finally {
      this.end("write", toolName, callId, status);
    }
  }

  private begin(mode: ToolMode, toolName: string, toolCallId: string): void {
    if (mode === "read") {
      if (this.activeWrites > 0) {
        this.overlapViolations += 1;
      }
      this.activeReads += 1;
      this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads);
    } else {
      if (this.activeReads > 0 || this.activeWrites > 0) {
        this.overlapViolations += 1;
      }
      this.activeWrites += 1;
      this.maxActiveWrites = Math.max(this.maxActiveWrites, this.activeWrites);
    }

    this.recordEvent("tool_start", toolCallId, toolName, mode);
  }

  private end(
    mode: ToolMode,
    toolName: string,
    toolCallId: string,
    status: string,
  ): void {
    if (mode === "read") {
      this.activeReads -= 1;
    } else {
      this.activeWrites -= 1;
    }
    this.recordEvent("tool_end", toolCallId, toolName, mode, status);
  }

  private recordEvent(
    type: HarnessEventType,
    toolCallId: string,
    toolName: string,
    mode?: ToolMode,
    status?: string,
  ): void {
    this.events.push({
      type,
      toolCallId,
      toolName,
      ...(mode === undefined ? {} : { mode }),
      at: performance.now(),
      ...(status === undefined ? {} : { status }),
    });

    if (type === "tool_start") {
      this.onToolStart?.(this.events[this.events.length - 1] as HarnessEvent);
    }

    for (let index = this.eventWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.eventWaiters[index];
      if (
        waiter?.type === type &&
        waiter.toolCallId === toolCallId
      ) {
        this.eventWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  return {
    id,
    name,
    arguments: args,
  };
}

function createRunner(
  harness: BomHarness,
  provider: LLMProvider,
  taskId: string,
): AgentRunner {
  return new AgentRunner({
    provider,
    registry: harness.registry,
    scheduler: harness.scheduler,
    model: "mock-model",
    taskIdFactory: () => taskId,
  });
}

function mockStep(content: string): MockProviderResponse {
  return { content };
}

describe("Phase 2 end-to-end scheduler", () => {
  it("runs the full BOM, inventory, update, reread, and report workflow", async () => {
    const harness = new BomHarness({
      holdReadIds: ["call-r1", "call-r2"],
    });
    const executeValidatedSpy = vi.spyOn(
      harness.registry,
      "executeValidated",
    );
    const bypassSpy = vi.spyOn(harness.registry, "execute");
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-r1", "bom_get_items"),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
          toolCall("call-w1", "bom_update", {
            note: "Add validated footprint note",
          }),
          toolCall("call-r3", "bom_get_items"),
          toolCall("call-w2", "production_report_generate", {
            format: "json",
          }),
        ],
      },
      mockStep("Phase 2 workflow completed successfully."),
    ]);
    const execution = createRunner(harness, provider, "phase2-e2e").run({
      objective: "Run the complete production readiness workflow.",
    });

    await Promise.all([
      harness.waitForEvent("tool_start", "call-r1"),
      harness.waitForEvent("tool_start", "call-r2"),
    ]);
    expect(harness.maxActiveReads).toBe(2);
    expect(
      harness.events.some((event) => event.toolCallId === "call-w1"),
    ).toBe(false);

    harness.releaseRead("call-r2");
    await harness.waitForEvent("tool_end", "call-r2");
    expect(
      harness.events.some((event) => event.toolCallId === "call-w1"),
    ).toBe(false);

    harness.releaseRead("call-r1");
    const result = await execution;

    expect(result).toMatchObject({
      status: "completed",
      stopReason: "final_response",
      finalAnswer: "Phase 2 workflow completed successfully.",
      modelRequests: 2,
      toolCalls: 5,
    });
    expect(result.toolResults.map((item) => item.toolCallId)).toEqual([
      "call-r1",
      "call-r2",
      "call-w1",
      "call-r3",
      "call-w2",
    ]);
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(result.toolResults[0]).toMatchObject({
      originalIndex: 0,
      mode: "read",
      output: { revision: 0 },
    });
    expect(result.toolResults[3]).toMatchObject({
      originalIndex: 3,
      mode: "read",
      output: { revision: 1 },
    });
    expect(result.toolResults[4]).toMatchObject({
      originalIndex: 4,
      mode: "write",
      output: { revision: 1, status: "ready" },
    });

    const readTwoStart = harness.event("tool_start", "call-r2").at;
    const readOneEnd = harness.event("tool_end", "call-r1").at;
    const readTwoEnd = harness.event("tool_end", "call-r2").at;
    const writeOneStart = harness.event("tool_start", "call-w1").at;
    const writeOneEnd = harness.event("tool_end", "call-w1").at;
    const readThreeStart = harness.event("tool_start", "call-r3").at;
    const readThreeEnd = harness.event("tool_end", "call-r3").at;
    const writeOneApproval = harness.event("approval_request", "call-w1").at;
    const writeTwoApproval = harness.event("approval_request", "call-w2").at;
    const writeTwoStart = harness.event("tool_start", "call-w2").at;

    expect(readOneEnd).toBeGreaterThan(readTwoStart);
    expect(harness.maxActiveReads).toBeLessThanOrEqual(3);
    expect(writeOneStart).toBeGreaterThanOrEqual(
      Math.max(readOneEnd, readTwoEnd),
    );
    expect(writeOneApproval).toBeGreaterThanOrEqual(
      Math.max(readOneEnd, readTwoEnd),
    );
    expect(readThreeStart).toBeGreaterThanOrEqual(writeOneEnd);
    expect(writeTwoApproval).toBeGreaterThanOrEqual(readThreeEnd);
    expect(writeTwoStart).toBeGreaterThanOrEqual(readThreeEnd);
    expect(harness.maxActiveWrites).toBe(1);
    expect(harness.overlapViolations).toBe(0);
    expect(harness.approvalRequests.map((request) => request.toolCallId)).toEqual([
      "call-w1",
      "call-w2",
    ]);
    expect(executeValidatedSpy).toHaveBeenCalledTimes(5);
    expect(bypassSpy).not.toHaveBeenCalled();

    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(
      toolMessages.map((message) =>
        message.role === "tool" ? message.toolCallId : "",
      ),
    ).toEqual(result.toolResults.map((item) => item.toolCallId));
    expect(provider.consumedResponseCount).toBe(2);
  });

  it("marks a rejected write and later calls skipped, then allows replanning", async () => {
    const harness = new BomHarness({
      approvalHandler: async (request) =>
        request.toolCallId === "call-w1"
          ? { status: "rejected" }
          : { status: "approved" },
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-r1", "bom_get_items"),
          toolCall("call-w1", "bom_update", { note: "Rejected update" }),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
        ],
      },
      mockStep("The rejected write was handled with a new plan."),
    ]);

    const result = await createRunner(harness, provider, "phase2-reject").run({
      objective: "Handle a rejected BOM update.",
    });

    expect(result.status).toBe("completed");
    expect(result.modelRequests).toBe(2);
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "succeeded",
      "skipped",
      "skipped",
    ]);
    expect(harness.executionCounts.get("call-w1")).toBeUndefined();
    expect(harness.executionCounts.get("call-r2")).toBeUndefined();
    expect(provider.requests[1]?.messages.filter((message) => message.role === "tool"))
      .toHaveLength(3);
    expect(provider.consumedResponseCount).toBe(2);
  });

  it("stops after an unknown write and never retries or requests another LLM turn", async () => {
    const harness = new BomHarness({
      unknownWriteIds: ["call-w1"],
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-r1", "bom_get_items"),
          toolCall("call-w1", "bom_update", { note: "Unknown update" }),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
        ],
      },
      mockStep("This response must not be requested."),
    ]);

    const result = await createRunner(harness, provider, "phase2-unknown").run({
      objective: "Exercise an unknown BOM update.",
    });

    expect(result).toMatchObject({
      status: "write_outcome_unknown",
      stopReason: "write_outcome_unknown",
      modelRequests: 1,
      toolCalls: 3,
    });
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "succeeded",
      "unknown",
      "skipped",
    ]);
    expect(harness.executionCounts.get("call-w1")).toBe(1);
    expect(harness.executionCounts.get("call-r2")).toBeUndefined();
    expect(provider.consumedResponseCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private write failure");
  });

  it("keeps all three read results when one read in the batch fails", async () => {
    const harness = new BomHarness({
      failReadIds: ["call-r2"],
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-r1", "bom_get_items"),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
          toolCall("call-r3", "bom_get_items"),
        ],
      },
      mockStep("The partial read failure was handled."),
    ]);

    const result = await createRunner(harness, provider, "phase2-read-failure").run({
      objective: "Handle one failed read.",
    });

    expect(result.status).toBe("completed");
    expect(result.toolResults.map((item) => item.toolCallId)).toEqual([
      "call-r1",
      "call-r2",
      "call-r3",
    ]);
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(
      provider.requests[1]?.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(3);
    expect(provider.consumedResponseCount).toBe(2);
    expect(JSON.stringify(result)).not.toContain(
      "private simulated read failure",
    );
  });

  it("cancels a running read batch and never starts queued work", async () => {
    const controller = new AbortController();
    const harness = new BomHarness({
      maxReadConcurrency: 2,
      holdReadIds: ["call-r1", "call-r2"],
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-r1", "bom_get_items"),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
          toolCall("call-r3", "bom_get_items"),
        ],
      },
      mockStep("This response must not be requested."),
    ]);
    const execution = createRunner(
      harness,
      provider,
      "phase2-read-cancel",
    ).run(
      { objective: "Cancel a read batch." },
      { signal: controller.signal },
    );

    await Promise.all([
      harness.waitForEvent("tool_start", "call-r1"),
      harness.waitForEvent("tool_start", "call-r2"),
    ]);
    controller.abort();
    harness.releaseRead("call-r1");
    harness.releaseRead("call-r2");
    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(harness.executionCounts.get("call-r3")).toBeUndefined();
    expect(
      harness.events.some(
        (event) => event.type === "tool_start" && event.toolCallId === "call-r3",
      ),
    ).toBe(false);
    expect(provider.consumedResponseCount).toBe(1);
  });

  it("cancels while waiting for write approval without executing the write", async () => {
    const controller = new AbortController();
    const approvalStarted = deferred<void>();
    const approvalDecision = deferred<WriteApprovalDecision>();
    const harness = new BomHarness({
      approvalHandler: async () => {
        approvalStarted.resolve();
        return approvalDecision.promise;
      },
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-w1", "bom_update", { note: "Cancel this update" }),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
        ],
      },
      mockStep("This response must not be requested."),
    ]);
    const execution = createRunner(
      harness,
      provider,
      "phase2-approval-cancel",
    ).run(
      { objective: "Cancel during approval." },
      { signal: controller.signal },
    );

    await approvalStarted.promise;
    controller.abort();
    approvalDecision.resolve({ status: "approved" });
    const result = await execution;

    expect(result.status).toBe("cancelled");
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(harness.executionCounts.get("call-w1")).toBeUndefined();
    expect(harness.executionCounts.get("call-r2")).toBeUndefined();
    expect(provider.consumedResponseCount).toBe(1);
  });

  it("returns unknown after a started write is cancelled and skips later work", async () => {
    const controller = new AbortController();
    const harness = new BomHarness({
      holdWriteIds: ["call-w1"],
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-w1", "bom_update", { note: "Cancel during write" }),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
        ],
      },
      mockStep("This response must not be requested."),
    ]);
    const execution = createRunner(
      harness,
      provider,
      "phase2-write-cancel",
    ).run(
      { objective: "Cancel after write execution starts." },
      { signal: controller.signal },
    );

    await harness.waitForEvent("tool_start", "call-w1");
    controller.abort();
    harness.releaseWrite("call-w1");
    const result = await execution;

    expect(result).toMatchObject({
      status: "write_outcome_unknown",
      stopReason: "write_outcome_unknown",
    });
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "unknown",
      "skipped",
    ]);
    expect(harness.executionCounts.get("call-w1")).toBe(1);
    expect(harness.executionCounts.get("call-r2")).toBeUndefined();
    expect(provider.consumedResponseCount).toBe(1);
  });

  it("preserves a successful write when cancellation happens before the next model response", async () => {
    const controller = new AbortController();
    const harness = new BomHarness({
      onToolStart: (event) => {
        if (event.toolCallId === "call-r2") {
          controller.abort();
        }
      },
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-w1", "bom_update", {
            note: "Completed before cancellation",
          }),
          toolCall("call-r2", "inventory_lookup", {
            partNumber: "STM32F103C8T6",
          }),
        ],
      },
      mockStep("This response must not be requested."),
    ]);

    const result = await createRunner(
      harness,
      provider,
      "phase2-success-then-cancel",
    ).run(
      { objective: "Cancel after a successful write." },
      { signal: controller.signal },
    );

    expect(result.status).toBe("cancelled");
    expect(result.modelRequests).toBe(1);
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "succeeded",
      "cancelled",
    ]);
    expect(result.toolResults[0]?.toolCallId).toBe("call-w1");
    expect(provider.consumedResponseCount).toBe(1);
  });
});

function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}
