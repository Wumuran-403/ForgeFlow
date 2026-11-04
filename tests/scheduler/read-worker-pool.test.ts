import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ReadWorkerPool } from "../../src/scheduler/read-worker-pool.js";
import type {
  PlannedKnownToolCall,
  PlannedToolCall,
  PlannedUnknownToolCall,
} from "../../src/scheduler/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionContext } from "../../src/tools/types.js";

const readInputSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

class ControlledReadGate {
  active = 0;
  maxActive = 0;
  readonly started: string[] = [];
  readonly completed: string[] = [];
  readonly contexts: ToolExecutionContext[] = [];
  readonly failKeys = new Set<string>();
  private readonly openKeys = new Set<string>();
  private readonly releaseWaiters = new Map<string, Array<() => void>>();
  private readonly startWaiters: Array<{
    count: number;
    resolve: () => void;
  }> = [];
  private readonly completionWaiters: Array<{
    key: string;
    resolve: () => void;
  }> = [];

  async execute(
    input: { key: string },
    context?: ToolExecutionContext,
  ): Promise<unknown> {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(input.key);
    if (context !== undefined) {
      this.contexts.push(context);
    }
    this.notifyStarted();

    try {
      if (this.failKeys.has(input.key)) {
        throw new Error("private read failure detail");
      }

      if (!this.openKeys.has(input.key)) {
        await new Promise<void>((resolve) => {
          const waiters = this.releaseWaiters.get(input.key) ?? [];
          waiters.push(resolve);
          this.releaseWaiters.set(input.key, waiters);
        });
      }

      return { key: input.key };
    } finally {
      this.active -= 1;
      this.completed.push(input.key);
      this.notifyCompleted(input.key);
    }
  }

  waitForStartCount(count: number): Promise<void> {
    if (this.started.length >= count) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.startWaiters.push({ count, resolve });
    });
  }

  waitForCompletion(key: string): Promise<void> {
    if (this.completed.includes(key)) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => {
      this.completionWaiters.push({ key, resolve });
    });
  }

  release(key: string): void {
    this.openKeys.add(key);
    const waiters = this.releaseWaiters.get(key) ?? [];
    this.releaseWaiters.delete(key);
    for (const resolve of waiters) {
      resolve();
    }
  }

  releaseAll(keys: readonly string[]): void {
    for (const key of keys) {
      this.release(key);
    }
  }

  private notifyStarted(): void {
    for (let index = this.startWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.startWaiters[index];
      if (waiter !== undefined && this.started.length >= waiter.count) {
        this.startWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }

  private notifyCompleted(key: string): void {
    for (let index = this.completionWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.completionWaiters[index];
      if (waiter?.key === key) {
        this.completionWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

function createGateRegistry(gate: ControlledReadGate): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "inventory_read",
    description: "Execute a controlled read.",
    mode: "read",
    inputSchema: readInputSchema,
    timeoutMs: 100,
    execute: gate.execute.bind(gate),
  });
  return registry;
}

function plannedRead(
  key: string,
  originalIndex: number,
): PlannedKnownToolCall {
  return {
    originalIndex,
    toolCallId: `call-${key}`,
    toolName: "inventory_read",
    arguments: { key },
    mode: "read",
    timeoutMs: 100,
    requiresApproval: false,
  };
}

const context = {
  taskId: "task-read-pool",
  signal: new AbortController().signal,
} satisfies Parameters<ReadWorkerPool["execute"]>[1];

describe("ReadWorkerPool", () => {
  it("rejects invalid maxConcurrency values", () => {
    const registry = new ToolRegistry();

    for (const maxConcurrency of [0, -1, 1.5, Number.NaN]) {
      expect(
        () => new ReadWorkerPool(registry, { maxConcurrency }),
      ).toThrowError(/configuration is invalid/i);
    }
  });

  it("allows three read tools to overlap by default", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate));
    const tasks = [
      plannedRead("r1", 0),
      plannedRead("r2", 1),
      plannedRead("r3", 2),
    ];

    const execution = pool.execute(tasks, context);
    await gate.waitForStartCount(3);

    expect(gate.active).toBe(3);
    expect(gate.maxActive).toBe(3);
    expect(gate.started).toEqual(["r1", "r2", "r3"]);

    gate.releaseAll(["r1", "r2", "r3"]);
    await expect(execution).resolves.toMatchObject([
      { toolCallId: "call-r1", status: "succeeded" },
      { toolCallId: "call-r2", status: "succeeded" },
      { toolCallId: "call-r3", status: "succeeded" },
    ]);
    expect(pool.activeTaskCount).toBe(0);
    expect(gate.active).toBe(0);
  });

  it("never exceeds the default limit of three with queued tasks", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate));
    const keys = ["r1", "r2", "r3", "r4", "r5"];
    const execution = pool.execute(
      keys.map((key, index) => plannedRead(key, index)),
      context,
    );

    await gate.waitForStartCount(3);
    expect(gate.started).toEqual(["r1", "r2", "r3"]);
    expect(gate.active).toBe(3);

    gate.releaseAll(keys);
    const results = await execution;

    expect(results).toHaveLength(5);
    expect(gate.started).toEqual(keys);
    expect(gate.maxActive).toBeLessThanOrEqual(3);
    expect(pool.activeTaskCount).toBe(0);
  });

  it("honors a custom concurrency limit of two", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate), {
      maxConcurrency: 2,
    });
    const keys = ["r1", "r2", "r3", "r4"];
    const execution = pool.execute(
      keys.map((key, index) => plannedRead(key, index)),
      context,
    );

    await gate.waitForStartCount(2);
    expect(gate.started).toEqual(["r1", "r2"]);
    expect(gate.active).toBe(2);

    gate.releaseAll(keys);
    await execution;

    expect(gate.started).toEqual(keys);
    expect(gate.maxActive).toBe(2);
    expect(pool.activeTaskCount).toBe(0);
  });

  it("returns results in original order when completion order is reversed", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate));
    const tasks = [
      plannedRead("r1", 0),
      plannedRead("r2", 1),
      plannedRead("r3", 2),
    ];
    const execution = pool.execute(tasks, context);

    await gate.waitForStartCount(3);
    gate.release("r3");
    await gate.waitForCompletion("r3");
    gate.release("r1");
    gate.release("r2");

    const results = await execution;
    expect(results.map((result) => result.toolCallId)).toEqual([
      "call-r1",
      "call-r2",
      "call-r3",
    ]);
    expect(results.map((result) => result.originalIndex)).toEqual([0, 1, 2]);
    expect(gate.completed[0]).toBe("r3");
  });

  it("isolates a single read failure from successful reads", async () => {
    const gate = new ControlledReadGate();
    gate.failKeys.add("r2");
    const pool = new ReadWorkerPool(createGateRegistry(gate));
    const tasks = [
      plannedRead("r1", 0),
      plannedRead("r2", 1),
      plannedRead("r3", 2),
    ];

    const execution = pool.execute(tasks, context);
    await gate.waitForStartCount(3);
    gate.releaseAll(["r1", "r2", "r3"]);
    const results = await execution;

    expect(results.map((result) => result.status)).toEqual([
      "succeeded",
      "failed",
      "succeeded",
    ]);
    expect(results[1]).toMatchObject({
      toolCallId: "call-r2",
      error: { code: "TOOL_EXECUTION_FAILED" },
    });
    expect(JSON.stringify(results)).not.toContain("private read failure detail");
    expect(pool.activeTaskCount).toBe(0);
  });

  it("does not execute a read tool when Zod validation fails", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(() => ({ unexpected: true }));
    registry.register({
      name: "inventory_read",
      description: "Validate before executing.",
      mode: "read",
      inputSchema: readInputSchema,
      timeoutMs: 100,
      execute,
    });
    const pool = new ReadWorkerPool(registry);
    const task = {
      ...plannedRead("invalid", 0),
      arguments: {},
    };

    const results = await pool.execute([task], context);

    expect(results[0]).toMatchObject({
      toolCallId: "call-invalid",
      status: "failed",
      error: { code: "TOOL_INPUT_INVALID" },
    });
    expect(execute).not.toHaveBeenCalled();
    expect(pool.activeTaskCount).toBe(0);
  });

  it("rejects an unknown tool before entering read execution", async () => {
    const registry = new ToolRegistry();
    const executeSpy = vi.spyOn(registry, "executeValidated");
    const pool = new ReadWorkerPool(registry);
    const unknownTask: PlannedUnknownToolCall = {
      originalIndex: 0,
      toolCallId: "call-unknown",
      toolName: "missing_read",
      arguments: {},
    };

    const results = await pool.execute([unknownTask], context);

    expect(results[0]).toMatchObject({
      toolCallId: "call-unknown",
      status: "failed",
      error: { code: "TOOL_NOT_FOUND" },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("rejects a write task without executing the write tool", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(() => ({ written: true }));
    registry.register({
      name: "inventory_write",
      description: "Must not run in a read pool.",
      mode: "write",
      inputSchema: readInputSchema,
      timeoutMs: 100,
      execute,
    });
    const pool = new ReadWorkerPool(registry);
    const writeTask: PlannedKnownToolCall = {
      originalIndex: 0,
      toolCallId: "call-write",
      toolName: "inventory_write",
      arguments: { key: "write" },
      mode: "write",
      timeoutMs: 100,
      requiresApproval: true,
    };

    const results = await pool.execute([writeTask], context);

    expect(results[0]).toMatchObject({
      toolCallId: "call-write",
      status: "failed",
      error: { code: "INVALID_READ_TASK" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("passes taskId, toolCallId, and independent combined signals to each tool", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate), {
      maxConcurrency: 2,
    });
    const tasks = [plannedRead("r1", 0), plannedRead("r2", 1)];
    const execution = pool.execute(tasks, context);

    await gate.waitForStartCount(2);
    gate.releaseAll(["r1", "r2"]);
    await execution;

    expect(gate.contexts).toHaveLength(2);
    expect(
      gate.contexts.map((toolContext) => ({
        taskId: toolContext.taskId,
        toolCallId: toolContext.toolCallId,
      })),
    ).toEqual([
      {
        taskId: "task-read-pool",
        toolCallId: "call-r1",
      },
      {
        taskId: "task-read-pool",
        toolCallId: "call-r2",
      },
    ]);
    expect(gate.contexts[0]?.signal).toBeInstanceOf(AbortSignal);
    expect(gate.contexts[1]?.signal).toBeInstanceOf(AbortSignal);
    expect(gate.contexts[0]?.signal).not.toBe(context.signal);
    expect(gate.contexts[1]?.signal).not.toBe(context.signal);
    expect(gate.contexts[0]?.signal).not.toBe(gate.contexts[1]?.signal);
  });

  it("parses JSON string arguments before Registry validation", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate));
    const task = {
      ...plannedRead("r1", 0),
      arguments: JSON.stringify({ key: "r1" }),
    };
    const execution = pool.execute([task], context);

    await gate.waitForStartCount(1);
    gate.releaseAll(["r1"]);
    await expect(execution).resolves.toMatchObject([
      {
        toolCallId: "call-r1",
        status: "succeeded",
        output: { key: "r1" },
      },
    ]);
  });

  it("returns an empty result for an empty read batch", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate));

    await expect(pool.execute([], context)).resolves.toEqual([]);
    expect(pool.activeTaskCount).toBe(0);
    expect(gate.started).toEqual([]);
  });

  it("has zero active tasks after every result settles", async () => {
    const gate = new ControlledReadGate();
    const pool = new ReadWorkerPool(createGateRegistry(gate));
    const tasks: PlannedToolCall[] = [
      plannedRead("r1", 0),
      plannedRead("r2", 1),
    ];
    const execution = pool.execute(tasks, context);

    await gate.waitForStartCount(2);
    expect(pool.activeTaskCount).toBe(2);
    gate.releaseAll(["r1", "r2"]);
    await execution;

    expect(pool.activeTaskCount).toBe(0);
    expect(gate.active).toBe(0);
  });
});
