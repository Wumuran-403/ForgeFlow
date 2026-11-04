import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ToolCall } from "../../src/provider/types.js";
import { ReadWorkerPool } from "../../src/scheduler/read-worker-pool.js";
import { TaskPlanner } from "../../src/scheduler/planner.js";
import { TaskScheduler } from "../../src/scheduler/task-scheduler.js";
import type {
  WriteApprovalDecision,
  WriteApprovalHandler,
} from "../../src/scheduler/types.js";
import { WriteExecutor } from "../../src/scheduler/write-executor.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const inputSchema = z
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

function call(id: string, name: string, key: string): ToolCall {
  return {
    id,
    name,
    arguments: { key },
  };
}

function createScheduler(
  registry: ToolRegistry,
  options: {
    approvalHandler?: WriteApprovalHandler;
  } = {},
): TaskScheduler {
  return new TaskScheduler({
    registry,
    planner: new TaskPlanner(registry),
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, {
      ...(options.approvalHandler === undefined
        ? {}
        : { approvalHandler: options.approvalHandler }),
    }),
  });
}

function context(signal = new AbortController().signal) {
  return {
    taskId: "task-scheduler",
    signal,
  };
}

function registerRead(
  registry: ToolRegistry,
  name: string,
  execute: (input: { key: string }) => unknown,
  timeoutMs = 1_000,
): void {
  registry.register({
    name,
    description: `Read through ${name}.`,
    mode: "read",
    inputSchema,
    timeoutMs,
    execute,
  });
}

function registerWrite(
  registry: ToolRegistry,
  name: string,
  execute: (input: { key: string }) => unknown,
  requiresApproval = false,
): void {
  registry.register({
    name,
    description: `Write through ${name}.`,
    mode: "write",
    inputSchema,
    timeoutMs: 1_000,
    requiresApproval,
    execute,
  });
}

describe("TaskScheduler", () => {
  it("executes a single read batch", async () => {
    const registry = new ToolRegistry();
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const result = await createScheduler(registry).execute(
      [call("call-1", "read_one", "one")],
      context(),
    );

    expect(result.termination).toBe("completed");
    expect(result.results).toEqual([
      {
        originalIndex: 0,
        toolCallId: "call-1",
        toolName: "read_one",
        mode: "read",
        status: "succeeded",
        output: { key: "one" },
      },
    ]);
  });

  it("executes consecutive reads concurrently and preserves result order", async () => {
    const registry = new ToolRegistry();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    let active = 0;
    let maxActive = 0;
    registerRead(registry, "read_one", async ({ key }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (key === "one") {
        firstStarted.resolve();
        await releaseFirst.promise;
      } else {
        secondStarted.resolve();
        await releaseSecond.promise;
      }
      active -= 1;
      return { key };
    });
    const execution = createScheduler(registry).execute(
      [call("call-1", "read_one", "one"), call("call-2", "read_one", "two")],
      context(),
    );

    await Promise.all([firstStarted.promise, secondStarted.promise]);
    expect(active).toBe(2);
    releaseSecond.resolve();
    releaseFirst.resolve();
    const result = await execution;

    expect(maxActive).toBe(2);
    expect(result.results.map((item) => item.toolCallId)).toEqual([
      "call-1",
      "call-2",
    ]);
  });

  it("waits for a read batch before starting a write barrier", async () => {
    const registry = new ToolRegistry();
    const readStarted = deferred<void>();
    const releaseRead = deferred<void>();
    const events: string[] = [];
    registerRead(registry, "read_one", async ({ key }) => {
      events.push("read:start");
      readStarted.resolve();
      await releaseRead.promise;
      events.push("read:end");
      return { key };
    });
    registerWrite(registry, "write_one", ({ key }) => {
      events.push("write");
      return { key };
    });
    const execution = createScheduler(registry).execute(
      [call("call-read", "read_one", "r"), call("call-write", "write_one", "w")],
      context(),
    );

    await readStarted.promise;
    expect(events).toEqual(["read:start"]);
    releaseRead.resolve();
    const result = await execution;

    expect(events).toEqual(["read:start", "read:end", "write"]);
    expect(result.results.map((item) => item.mode)).toEqual(["read", "write"]);
  });

  it("executes Read, Write, Read in plan order", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registerRead(registry, "read_one", ({ key }) => {
      events.push(`read:${key}`);
      return { key };
    });
    registerWrite(registry, "write_one", ({ key }) => {
      events.push("write");
      return { key };
    });

    const result = await createScheduler(registry).execute(
      [
        call("call-r1", "read_one", "r1"),
        call("call-r2", "read_one", "r2"),
        call("call-w", "write_one", "w"),
        call("call-r3", "read_one", "r3"),
      ],
      context(),
    );

    expect(events).toEqual(["read:r1", "read:r2", "write", "read:r3"]);
    expect(result.results.map((item) => item.toolCallId)).toEqual([
      "call-r1",
      "call-r2",
      "call-w",
      "call-r3",
    ]);
  });

  it("never overlaps multiple write steps", async () => {
    const registry = new ToolRegistry();
    const firstStarted = deferred<void>();
    const secondStarted = deferred<void>();
    const releaseFirst = deferred<void>();
    const releaseSecond = deferred<void>();
    let activeWrites = 0;
    let maxActiveWrites = 0;
    registerWrite(registry, "write_one", async ({ key }) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      firstStarted.resolve();
      await releaseFirst.promise;
      activeWrites -= 1;
      return { key };
    });
    registerWrite(registry, "write_two", async ({ key }) => {
      activeWrites += 1;
      maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
      secondStarted.resolve();
      await releaseSecond.promise;
      activeWrites -= 1;
      return { key };
    });
    const execution = createScheduler(registry).execute(
      [call("call-w1", "write_one", "w1"), call("call-w2", "write_two", "w2")],
      context(),
    );

    await firstStarted.promise;
    let secondHasStarted = false;
    void secondStarted.promise.then(() => {
      secondHasStarted = true;
    });
    await Promise.resolve();
    expect(secondHasStarted).toBe(false);
    releaseFirst.resolve();
    await secondStarted.promise;
    releaseSecond.resolve();
    await execution;

    expect(maxActiveWrites).toBe(1);
  });

  it("handles unknown tools independently and continues the plan", async () => {
    const registry = new ToolRegistry();
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const result = await createScheduler(registry).execute(
      [
        call("call-r1", "read_one", "one"),
        call("call-unknown", "missing_tool", "x"),
        call("call-r2", "read_one", "two"),
      ],
      context(),
    );

    expect(result.termination).toBe("completed");
    expect(result.results).toMatchObject([
      { toolCallId: "call-r1", status: "succeeded" },
      {
        toolCallId: "call-unknown",
        status: "failed",
        error: { code: "TOOL_NOT_FOUND" },
      },
      { toolCallId: "call-r2", status: "succeeded" },
    ]);
  });

  it("keeps successful reads when another read in the batch fails", async () => {
    const registry = new ToolRegistry();
    registerRead(registry, "read_one", ({ key }) => {
      if (key === "fail") {
        throw new Error("private read failure");
      }
      return { key };
    });
    const result = await createScheduler(registry).execute(
      [call("call-ok", "read_one", "ok"), call("call-fail", "read_one", "fail")],
      context(),
    );

    expect(result.results.map((item) => item.status)).toEqual([
      "succeeded",
      "failed",
    ]);
    expect(JSON.stringify(result)).not.toContain("private read failure");
  });

  it("keeps read timeout results independent", async () => {
    vi.useFakeTimers();
    try {
      const registry = new ToolRegistry();
      const release = deferred<void>();
      const started = deferred<void>();
      registerRead(
        registry,
        "read_one",
        async ({ key }) => {
          if (key === "slow") {
            started.resolve();
            await release.promise;
          }
          return { key };
        },
        100,
      );
      const execution = createScheduler(registry).execute(
        [call("call-slow", "read_one", "slow"), call("call-fast", "read_one", "fast")],
        context(),
      );

      await started.promise;
      await vi.advanceTimersByTimeAsync(100);
      release.resolve();
      const result = await execution;

      expect(result.results.map((item) => item.status)).toEqual([
        "timed_out",
        "succeeded",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks later calls skipped when a write is rejected", async () => {
    const registry = new ToolRegistry();
    registerWrite(registry, "write_one", ({ key }) => ({ key }), true);
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const result = await createScheduler(registry, {
      approvalHandler: {
        async request(): Promise<WriteApprovalDecision> {
          return { status: "rejected" };
        },
      },
    }).execute(
      [call("call-write", "write_one", "w"), call("call-read", "read_one", "r")],
      context(),
    );

    expect(result.termination).toBe("completed");
    expect(result.results.map((item) => item.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(result.results[1]?.error?.code).toBe("PRIOR_WRITE_DID_NOT_SUCCEED");
  });

  it("stops later steps and marks skipped after a write outcome is unknown", async () => {
    const registry = new ToolRegistry();
    registerWrite(registry, "write_one", () => {
      throw new Error("private write failure");
    });
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const result = await createScheduler(registry).execute(
      [call("call-write", "write_one", "w"), call("call-read", "read_one", "r")],
      context(),
    );

    expect(result.termination).toBe("write_outcome_unknown");
    expect(result.results[0]).toMatchObject({
      status: "unknown",
      error: { code: "WRITE_OUTCOME_UNKNOWN" },
    });
    expect(result.results[1]).toMatchObject({
      status: "skipped",
      error: { code: "PRIOR_WRITE_OUTCOME_UNKNOWN" },
    });
  });

  it("marks all unstarted calls cancelled after task cancellation", async () => {
    const registry = new ToolRegistry();
    const controller = new AbortController();
    const started = deferred<void>();
    const release = deferred<void>();
    registerRead(registry, "read_one", async ({ key }) => {
      started.resolve();
      await release.promise;
      return { key };
    });
    const execution = createScheduler(registry).execute(
      [call("call-r1", "read_one", "r1"), call("call-r2", "read_one", "r2")],
      context(controller.signal),
    );

    await started.promise;
    controller.abort();
    release.resolve();
    const result = await execution;

    expect(result.termination).toBe("cancelled");
    expect(result.results.map((item) => item.status)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("rejects scheduler components that use different registry instances", () => {
    const registry = new ToolRegistry();
    const otherRegistry = new ToolRegistry();

    expect(
      () =>
        new TaskScheduler({
          registry,
          planner: new TaskPlanner(otherRegistry),
          readWorkerPool: new ReadWorkerPool(registry),
          writeExecutor: new WriteExecutor(registry),
        }),
    ).toThrowError(/same ToolRegistry/);
  });
});
