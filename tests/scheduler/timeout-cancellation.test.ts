import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { ReadWorkerPool } from "../../src/scheduler/read-worker-pool.js";
import type {
  PlannedKnownToolCall,
  WriteApprovalDecision,
  WriteApprovalHandler,
} from "../../src/scheduler/types.js";
import { WriteExecutor } from "../../src/scheduler/write-executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionContext } from "../../src/tools/types.js";

const readInputSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

const writeInputSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

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

class ControlledGate {
  active = 0;
  maxActive = 0;
  readonly started: string[] = [];
  readonly completed: string[] = [];
  readonly contexts: ToolExecutionContext[] = [];
  readonly abortCounts = new Map<string, number>();
  readonly immediateKeys = new Set<string>();
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
  private readonly abortWaiters: Array<{
    key: string;
    resolve: () => void;
  }> = [];

  execute = async (
    input: { key: string },
    context?: ToolExecutionContext,
  ): Promise<unknown> => {
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    this.started.push(input.key);
    if (context !== undefined) {
      this.contexts.push(context);
      context.signal.addEventListener(
        "abort",
        () => {
          this.abortCounts.set(
            input.key,
            (this.abortCounts.get(input.key) ?? 0) + 1,
          );
          this.notifyAborted(input.key);
        },
        { once: true },
      );
    }
    this.notifyStarted();

    try {
      if (!this.immediateKeys.has(input.key)) {
        if (!this.openKeys.has(input.key)) {
          await new Promise<void>((resolve) => {
            const waiters = this.releaseWaiters.get(input.key) ?? [];
            waiters.push(resolve);
            this.releaseWaiters.set(input.key, waiters);
          });
        }
      }

      return { key: input.key };
    } finally {
      this.active -= 1;
      this.completed.push(input.key);
      this.notifyCompleted(input.key);
    }
  };

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

  waitForAbort(key: string): Promise<void> {
    if ((this.abortCounts.get(key) ?? 0) > 0) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.abortWaiters.push({ key, resolve });
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

  private notifyAborted(key: string): void {
    for (let index = this.abortWaiters.length - 1; index >= 0; index -= 1) {
      const waiter = this.abortWaiters[index];
      if (waiter?.key === key) {
        this.abortWaiters.splice(index, 1);
        waiter.resolve();
      }
    }
  }
}

function createReadRegistry(
  gate: ControlledGate,
  timeoutMs = 100,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "inventory_read",
    description: "Controlled read.",
    mode: "read",
    inputSchema: readInputSchema,
    timeoutMs,
    execute: gate.execute,
  });
  return registry;
}

function createWriteRegistry(
  gate: ControlledGate,
  requiresApproval: boolean,
  timeoutMs = 100,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "report_write",
    description: "Controlled write.",
    mode: "write",
    inputSchema: writeInputSchema,
    timeoutMs,
    requiresApproval,
    execute: gate.execute,
  });
  return registry;
}

function plannedRead(key: string, timeoutMs = 100): PlannedKnownToolCall {
  return {
    originalIndex: Number(key.replace(/\D/g, "")) - 1,
    toolCallId: `call-${key}`,
    toolName: "inventory_read",
    arguments: { key },
    mode: "read",
    timeoutMs,
    requiresApproval: false,
  };
}

function plannedWrite(
  key: string,
  timeoutMs: number,
  requiresApproval: boolean,
): PlannedKnownToolCall {
  return {
    originalIndex: 0,
    toolCallId: "call-write",
    toolName: "report_write",
    arguments: { key },
    mode: "write",
    timeoutMs,
    requiresApproval,
  };
}

function context(controller: AbortController) {
  return {
    taskId: "task-step5",
    signal: controller.signal,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Step 5 timeout and cancellation", () => {
  it("rejects non-positive timeout configuration", () => {
    const registry = new ToolRegistry();

    expect(
      () => new ReadWorkerPool(registry, { defaultTimeoutMs: 0 }),
    ).toThrowError(/configuration is invalid/i);
    expect(
      () =>
        new WriteExecutor(registry, {
          defaultTimeoutMs: -1,
        }),
    ).toThrowError(/configuration is invalid/i);
    expect(
      () =>
        new WriteExecutor(registry, {
          approvalTimeoutMs: 0,
        }),
    ).toThrowError(/configuration is invalid/i);
  });

  it("uses the registry default timeout of 30 seconds for a read", async () => {
    const gate = new ControlledGate();
    const pool = new ReadWorkerPool(createReadRegistry(gate, 30_000));
    const controller = new AbortController();
    const execution = pool.execute(
      [plannedRead("r1", 30_000)],
      context(controller),
    );

    await gate.waitForStartCount(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(gate.abortCounts.get("r1")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    await gate.waitForAbort("r1");
    gate.release("r1");
    const results = await execution;

    expect(results[0]).toMatchObject({
      status: "timed_out",
      error: { code: "TOOL_EXECUTION_TIMEOUT" },
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses a custom read timeout and does not cancel another read", async () => {
    const gate = new ControlledGate();
    gate.immediateKeys.add("r2");
    const pool = new ReadWorkerPool(createReadRegistry(gate, 125), {
      maxConcurrency: 2,
    });
    const controller = new AbortController();
    const execution = pool.execute(
      [plannedRead("r1", 125), plannedRead("r2", 125)],
      context(controller),
    );

    await gate.waitForStartCount(2);
    await gate.waitForCompletion("r2");
    await vi.advanceTimersByTimeAsync(124);
    expect(gate.abortCounts.get("r1")).toBeUndefined();

    await vi.advanceTimersByTimeAsync(1);
    expect(gate.abortCounts.get("r1")).toBe(1);
    expect(gate.abortCounts.get("r2")).toBeUndefined();
    gate.release("r1");
    const results = await execution;

    expect(results.map((result) => result.status)).toEqual([
      "timed_out",
      "succeeded",
    ]);
  });

  it("stops queued reads after task cancellation and marks them cancelled", async () => {
    const gate = new ControlledGate();
    const pool = new ReadWorkerPool(createReadRegistry(gate), {
      maxConcurrency: 2,
    });
    const controller = new AbortController();
    const keys = ["r1", "r2", "r3", "r4"];
    const execution = pool.execute(
      keys.map((key) => plannedRead(key)),
      context(controller),
    );

    await gate.waitForStartCount(2);
    controller.abort();
    expect(gate.started).toEqual(["r1", "r2"]);
    expect(gate.contexts[0]?.signal.aborted).toBe(true);
    expect(gate.contexts[1]?.signal.aborted).toBe(true);

    gate.releaseAll(["r1", "r2"]);
    const results = await execution;

    expect(gate.started).toEqual(["r1", "r2"]);
    expect(results.map((result) => result.status)).toEqual([
      "cancelled",
      "cancelled",
      "cancelled",
      "cancelled",
    ]);
    expect(pool.activeTaskCount).toBe(0);
  });

  it("does not release a timed-out read slot until the underlying promise settles", async () => {
    const gate = new ControlledGate();
    const pool = new ReadWorkerPool(createReadRegistry(gate), {
      maxConcurrency: 1,
    });
    const controller = new AbortController();
    const execution = pool.execute(
      [plannedRead("r1", 100), plannedRead("r2", 100)],
      context(controller),
    );
    let settled = false;
    void execution.then(() => {
      settled = true;
    });

    await gate.waitForStartCount(1);
    await vi.advanceTimersByTimeAsync(100);
    await gate.waitForAbort("r1");
    expect(gate.started).toEqual(["r1"]);
    expect(pool.activeTaskCount).toBe(1);
    expect(settled).toBe(false);

    gate.release("r1");
    await gate.waitForStartCount(2);
    expect(gate.started).toEqual(["r1", "r2"]);
    gate.release("r2");
    const results = await execution;

    expect(results.map((result) => result.status)).toEqual([
      "timed_out",
      "succeeded",
    ]);
    expect(pool.activeTaskCount).toBe(0);
  });

  it("waits for a canceled running read to settle before canceling queued work", async () => {
    const gate = new ControlledGate();
    const pool = new ReadWorkerPool(createReadRegistry(gate), {
      maxConcurrency: 1,
    });
    const controller = new AbortController();
    const execution = pool.execute(
      [plannedRead("r1"), plannedRead("r2")],
      context(controller),
    );

    await gate.waitForStartCount(1);
    controller.abort();
    expect(gate.contexts[0]?.signal.aborted).toBe(true);
    expect(gate.started).toEqual(["r1"]);
    expect(pool.activeTaskCount).toBe(1);

    gate.release("r1");
    const results = await execution;

    expect(gate.started).toEqual(["r1"]);
    expect(results.map((result) => result.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
    expect(pool.activeTaskCount).toBe(0);
  });

  it("does not retry a timed-out read", async () => {
    const gate = new ControlledGate();
    const executeSpy = vi.spyOn(gate, "execute");
    const pool = new ReadWorkerPool(createReadRegistry(gate));
    const execution = pool.execute(
      [plannedRead("r1")],
      context(new AbortController()),
    );

    await gate.waitForStartCount(1);
    await vi.advanceTimersByTimeAsync(100);
    gate.release("r1");
    await execution;

    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it("uses an independent AbortController for each read", async () => {
    const gate = new ControlledGate();
    gate.immediateKeys.add("r1");
    gate.immediateKeys.add("r2");
    const pool = new ReadWorkerPool(createReadRegistry(gate), {
      maxConcurrency: 2,
    });
    const controller = new AbortController();

    await pool.execute(
      [plannedRead("r1"), plannedRead("r2")],
      context(controller),
    );

    expect(gate.contexts[0]?.signal).not.toBe(controller.signal);
    expect(gate.contexts[1]?.signal).not.toBe(controller.signal);
    expect(gate.contexts[0]?.signal).not.toBe(gate.contexts[1]?.signal);
  });

  it("leaves a write outcome unknown after execution timeout and never retries", async () => {
    const gate = new ControlledGate();
    const executeSpy = vi.spyOn(gate, "execute");
    const executor = new WriteExecutor(
      createWriteRegistry(gate, false),
    );
    const controller = new AbortController();
    const execution = executor.execute(
      plannedWrite("w1", 100, false),
      context(controller),
    );

    await gate.waitForStartCount(1);
    await vi.advanceTimersByTimeAsync(100);
    await gate.waitForAbort("w1");
    expect(gate.contexts[0]?.signal).not.toBe(controller.signal);

    gate.release("w1");
    const result = await execution;

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "WRITE_OUTCOME_UNKNOWN" },
    });
    expect(executeSpy).toHaveBeenCalledOnce();
  });

  it("skips a write when approval times out and never executes it", async () => {
    const gate = new ControlledGate();
    const executeSpy = vi.spyOn(gate, "execute");
    const approvalStarted = deferred<void>();
    const handler: WriteApprovalHandler = {
      async request() {
        approvalStarted.resolve();
        return new Promise<WriteApprovalDecision>(() => undefined);
      },
    };
    const executor = new WriteExecutor(
      createWriteRegistry(gate, true),
      {
        approvalTimeoutMs: 250,
        approvalHandler: handler,
      },
    );
    const controller = new AbortController();
    const execution = executor.execute(
      plannedWrite("w1", 100, true),
      context(controller),
    );

    await approvalStarted.promise;
    await vi.advanceTimersByTimeAsync(250);
    const result = await execution;

    expect(result).toMatchObject({
      status: "skipped",
      error: { code: "WRITE_APPROVAL_TIMEOUT" },
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores an approval that resolves after the approval timeout", async () => {
    const gate = new ControlledGate();
    const executeSpy = vi.spyOn(gate, "execute");
    const approvalStarted = deferred<void>();
    let resolveApproval:
      | ((decision: WriteApprovalDecision) => void)
      | undefined;
    const handler: WriteApprovalHandler = {
      async request() {
        approvalStarted.resolve();
        return new Promise<WriteApprovalDecision>((resolve) => {
          resolveApproval = resolve;
        });
      },
    };
    const executor = new WriteExecutor(
      createWriteRegistry(gate, true),
      {
        approvalTimeoutMs: 100,
        approvalHandler: handler,
      },
    );

    const execution = executor.execute(
      plannedWrite("w1", 100, true),
      context(new AbortController()),
    );
    await approvalStarted.promise;
    await vi.advanceTimersByTimeAsync(100);
    const result = await execution;

    resolveApproval?.({ status: "approved" });
    await flushMicrotasks();

    expect(result.status).toBe("skipped");
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("cancels during approval without executing the write", async () => {
    const gate = new ControlledGate();
    const executeSpy = vi.spyOn(gate, "execute");
    const approvalStarted = deferred<void>();
    let resolveApproval:
      | ((decision: WriteApprovalDecision) => void)
      | undefined;
    const handler: WriteApprovalHandler = {
      async request() {
        approvalStarted.resolve();
        return new Promise<WriteApprovalDecision>((resolve) => {
          resolveApproval = resolve;
        });
      },
    };
    const executor = new WriteExecutor(
      createWriteRegistry(gate, true),
      {
        approvalTimeoutMs: 1_000,
        approvalHandler: handler,
      },
    );
    const controller = new AbortController();
    const execution = executor.execute(
      plannedWrite("w1", 100, true),
      context(controller),
    );

    await approvalStarted.promise;
    controller.abort();
    resolveApproval?.({ status: "approved" });
    const result = await execution;

    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "WRITE_CANCELLED" },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });

  it("starts tool timeout only after approval completes", async () => {
    const gate = new ControlledGate();
    const approvalStarted = deferred<void>();
    let resolveApproval:
      | ((decision: WriteApprovalDecision) => void)
      | undefined;
    const handler: WriteApprovalHandler = {
      async request() {
        approvalStarted.resolve();
        return new Promise<WriteApprovalDecision>((resolve) => {
          resolveApproval = resolve;
        });
      },
    };
    const executor = new WriteExecutor(
      createWriteRegistry(gate, true),
      {
        approvalTimeoutMs: 1_000,
        approvalHandler: handler,
      },
    );
    const execution = executor.execute(
      plannedWrite("w1", 100, true),
      context(new AbortController()),
    );

    await approvalStarted.promise;
    await vi.advanceTimersByTimeAsync(400);
    resolveApproval?.({ status: "approved" });
    await gate.waitForStartCount(1);

    await vi.advanceTimersByTimeAsync(99);
    expect(gate.abortCounts.get("w1")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    await gate.waitForAbort("w1");
    gate.release("w1");
    const result = await execution;

    expect(result.status).toBe("unknown");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("returns unknown when cancellation occurs after write execution starts", async () => {
    const gate = new ControlledGate();
    const executor = new WriteExecutor(
      createWriteRegistry(gate, false, 1_000),
    );
    const controller = new AbortController();
    const execution = executor.execute(
      plannedWrite("w1", 1_000, false),
      context(controller),
    );

    await gate.waitForStartCount(1);
    controller.abort();
    await gate.waitForAbort("w1");
    gate.release("w1");
    const result = await execution;

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "WRITE_OUTCOME_UNKNOWN" },
    });
  });

  it("keeps a successful write succeeded when cancellation happens afterward", async () => {
    const gate = new ControlledGate();
    gate.immediateKeys.add("w1");
    const executor = new WriteExecutor(
      createWriteRegistry(gate, false, 1_000),
    );
    const controller = new AbortController();

    const result = await executor.execute(
      plannedWrite("w1", 1_000, false),
      context(controller),
    );
    controller.abort();

    expect(result).toMatchObject({
      status: "succeeded",
      output: { key: "w1" },
    });
  });

  it("clears timers after successful read and write execution", async () => {
    const gate = new ControlledGate();
    gate.immediateKeys.add("r1");
    gate.immediateKeys.add("w1");
    const pool = new ReadWorkerPool(createReadRegistry(gate));
    await pool.execute(
      [plannedRead("r1")],
      context(new AbortController()),
    );

    const executor = new WriteExecutor(
      createWriteRegistry(gate, false),
    );
    await executor.execute(
      plannedWrite("w1", 100, false),
      context(new AbortController()),
    );

    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts the approval signal when approval waiting is canceled", async () => {
    const gate = new ControlledGate();
    const approvalStarted = deferred<void>();
    let resolveApproval:
      | ((decision: WriteApprovalDecision) => void)
      | undefined;
    let approvalSignal: AbortSignal | undefined;
    const handler: WriteApprovalHandler = {
      async request(_request, options) {
        approvalSignal = options.signal;
        approvalStarted.resolve();
        return new Promise<WriteApprovalDecision>((resolve) => {
          resolveApproval = resolve;
        });
      },
    };
    const executor = new WriteExecutor(
      createWriteRegistry(gate, true),
      { approvalHandler: handler },
    );
    const controller = new AbortController();
    const execution = executor.execute(
      plannedWrite("w1", 100, true),
      context(controller),
    );

    await approvalStarted.promise;
    controller.abort();
    const result = await execution;
    resolveApproval?.({ status: "approved" });
    await flushMicrotasks();

    expect(result.status).toBe("cancelled");
    expect(approvalSignal?.aborted).toBe(true);
    expect(gate.started).toEqual([]);
  });

  it("cancels after approval but before execution without starting the write", async () => {
    const gate = new ControlledGate();
    const executeSpy = vi.spyOn(gate, "execute");
    const controller = new AbortController();
    const executor = new WriteExecutor(
      createWriteRegistry(gate, true),
      {
        approvalHandler: {
          async request() {
            controller.abort();
            return { status: "approved" };
          },
        },
      },
    );

    const result = await executor.execute(
      plannedWrite("w1", 100, true),
      context(controller),
    );

    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "WRITE_CANCELLED" },
    });
    expect(executeSpy).not.toHaveBeenCalled();
  });
});
