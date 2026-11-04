import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import type { ToolCall } from "../../src/provider/types.js";
import { TaskPlanner } from "../../src/scheduler/planner.js";
import type {
  PlannedKnownToolCall,
  ScheduleStep,
} from "../../src/scheduler/types.js";
import { ToolRegistryLockedError } from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const emptyInputSchema = z.object({}).strict();

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "inventory_read_a",
    description: "Read inventory A.",
    mode: "read",
    inputSchema: emptyInputSchema,
    timeoutMs: 100,
    execute: () => ({ value: "a" }),
  });
  registry.register({
    name: "inventory_read_b",
    description: "Read inventory B.",
    mode: "read",
    inputSchema: emptyInputSchema,
    timeoutMs: 200,
    requiresApproval: true,
    execute: () => ({ value: "b" }),
  });
  registry.register({
    name: "inventory_write_a",
    description: "Write inventory A.",
    mode: "write",
    inputSchema: emptyInputSchema,
    timeoutMs: 300,
    execute: () => ({ written: "a" }),
  });
  registry.register({
    name: "inventory_write_b",
    description: "Write inventory B.",
    mode: "write",
    inputSchema: emptyInputSchema,
    timeoutMs: 400,
    requiresApproval: false,
    execute: () => ({ written: "b" }),
  });
  return registry;
}

function call(id: string, name: string): ToolCall {
  return {
    id,
    name,
    arguments: {},
  };
}

const readA = call("call-read-a", "inventory_read_a");
const readB = call("call-read-b", "inventory_read_b");
const writeA = call("call-write-a", "inventory_write_a");
const writeB = call("call-write-b", "inventory_write_b");
const unknown = call("call-unknown", "missing_tool");

function plannedCalls(steps: readonly ScheduleStep[]): PlannedKnownToolCall[] {
  return steps.flatMap((step) => {
    if (step.kind === "read_batch") {
      return step.items;
    }
    return step.kind === "write" ? [step.item] : [];
  });
}

describe("TaskPlanner", () => {
  it("creates one read batch for a single read call", () => {
    const planner = new TaskPlanner(createRegistry());

    expect(planner.plan([readA])).toEqual([
      {
        kind: "read_batch",
        items: [
          {
            originalIndex: 0,
            toolCallId: "call-read-a",
            toolName: "inventory_read_a",
            arguments: {},
            mode: "read",
            timeoutMs: 100,
            requiresApproval: false,
          },
        ],
      },
    ]);
  });

  it("merges consecutive read calls into one batch", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([readA, readB]);

    expect(plan).toHaveLength(1);
    expect(plan[0]).toMatchObject({
      kind: "read_batch",
      items: [
        { toolCallId: "call-read-a", originalIndex: 0 },
        { toolCallId: "call-read-b", originalIndex: 1 },
      ],
    });
  });

  it("creates an independent write step for a single write call", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([writeA]);

    expect(plan).toEqual([
      {
        kind: "write",
        item: {
          originalIndex: 0,
          toolCallId: "call-write-a",
          toolName: "inventory_write_a",
          arguments: {},
          mode: "write",
          timeoutMs: 300,
          requiresApproval: true,
        },
      },
    ]);
  });

  it("keeps consecutive write calls as independent steps", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([writeA, writeB]);

    expect(plan.map((step) => step.kind)).toEqual(["write", "write"]);
    expect(plan).toMatchObject([
      {
        kind: "write",
        item: { toolCallId: "call-write-a", originalIndex: 0 },
      },
      {
        kind: "write",
        item: { toolCallId: "call-write-b", originalIndex: 1 },
      },
    ]);
  });

  it("plans R1, R2, W1, R3, W2 in the required barrier order", () => {
    const planner = new TaskPlanner(createRegistry());
    const readC = call("call-read-c", "inventory_read_a");
    const plan = planner.plan([readA, readB, writeA, readC, writeB]);

    expect(plan.map((step) => step.kind)).toEqual([
      "read_batch",
      "write",
      "read_batch",
      "write",
    ]);
    expect(plan).toMatchObject([
      {
        kind: "read_batch",
        items: [{ toolCallId: "call-read-a" }, { toolCallId: "call-read-b" }],
      },
      { kind: "write", item: { toolCallId: "call-write-a" } },
      { kind: "read_batch", items: [{ toolCallId: "call-read-c" }] },
      { kind: "write", item: { toolCallId: "call-write-b" } },
    ]);
  });

  it("creates an independent unknown-tool barrier", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([readA, unknown, readB]);

    expect(plan.map((step) => step.kind)).toEqual([
      "read_batch",
      "unknown_tool",
      "read_batch",
    ]);
    expect(plan[1]).toMatchObject({
      kind: "unknown_tool",
      reason: "not_registered",
      item: {
        originalIndex: 1,
        toolCallId: "call-unknown",
        toolName: "missing_tool",
      },
    });
  });

  it("never classifies an unknown tool as read", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([unknown]);

    expect(plan).toHaveLength(1);
    expect(plan[0]?.kind).toBe("unknown_tool");
    expect(plan[0]?.kind).not.toBe("read_batch");
    if (plan[0]?.kind === "unknown_tool") {
      expect(plan[0].item.mode).toBeUndefined();
      expect(plan[0].item.timeoutMs).toBeUndefined();
      expect(plan[0].item.requiresApproval).toBeUndefined();
    }
  });

  it("preserves every original Tool Call ID", () => {
    const planner = new TaskPlanner(createRegistry());
    const calls = [readA, readB, writeA, unknown, writeB];
    const plan = planner.plan(calls);

    expect(
      plan.flatMap((step) =>
        step.kind === "read_batch"
          ? step.items.map((item) => item.toolCallId)
          : [step.item.toolCallId],
      ),
    ).toEqual(calls.map((toolCall) => toolCall.id));
  });

  it("preserves every original index", () => {
    const planner = new TaskPlanner(createRegistry());
    const calls = [readA, readB, writeA, unknown, writeB];
    const plan = planner.plan(calls);

    expect(
      plan.flatMap((step) =>
        step.kind === "read_batch"
          ? step.items.map((item) => item.originalIndex)
          : [step.item.originalIndex],
      ),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it("carries timeout and approval metadata from the registry", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([readA, readB, writeA, writeB]);

    expect(plannedCalls(plan)).toMatchObject([
      { timeoutMs: 100, requiresApproval: false, mode: "read" },
      { timeoutMs: 200, requiresApproval: true, mode: "read" },
      { timeoutMs: 300, requiresApproval: true, mode: "write" },
      { timeoutMs: 400, requiresApproval: false, mode: "write" },
    ]);
  });

  it("returns an empty plan for empty Tool Calls", () => {
    const planner = new TaskPlanner(createRegistry());

    expect(planner.plan([])).toEqual([]);
  });

  it("does not mutate or reorder the input Tool Calls", () => {
    const planner = new TaskPlanner(createRegistry());
    const calls = [readB, writeA, readA, unknown, writeB];
    const snapshot = structuredClone(calls);

    planner.plan(calls);

    expect(calls).toEqual(snapshot);
    expect(calls.map((toolCall) => toolCall.id)).toEqual(
      snapshot.map((toolCall) => toolCall.id),
    );
  });

  it("does not merge reads across write or unknown barriers", () => {
    const planner = new TaskPlanner(createRegistry());
    const plan = planner.plan([readA, writeA, readB, unknown, readA]);

    expect(plan.map((step) => step.kind)).toEqual([
      "read_batch",
      "write",
      "read_batch",
      "unknown_tool",
      "read_batch",
    ]);
    expect(
      plan
        .filter((step) => step.kind === "read_batch")
        .map((step) => (step.kind === "read_batch" ? step.items.length : 0)),
    ).toEqual([1, 1, 1]);
  });

  it("treats missing or malformed metadata as an unknown barrier", () => {
    const registry = createRegistry();
    const planner = new TaskPlanner(registry);
    const metadata = registry.get("inventory_read_a");
    const get = registry.get.bind(registry);
    vi.spyOn(registry, "get").mockImplementation((name) =>
      name === "inventory_read_a"
        ? {
            ...metadata,
            timeoutMs: 0,
          }
        : get(name),
    );

    expect(planner.plan([readA, readB])).toMatchObject([
      {
        kind: "unknown_tool",
        reason: "invalid_metadata",
        item: { toolCallId: "call-read-a", originalIndex: 0 },
      },
      {
        kind: "read_batch",
        items: [{ toolCallId: "call-read-b", originalIndex: 1 }],
      },
    ]);
  });

  it("uses locked registry metadata without exposing or executing tools", () => {
    const registry = createRegistry();
    const planner = new TaskPlanner(registry);
    const executeSpy = vi.spyOn(registry, "execute");
    const lease = registry.acquireExecutionLease();

    try {
      expect(planner.plan([readA, writeA]).map((step) => step.kind)).toEqual([
        "read_batch",
        "write",
      ]);
      expect(() => registry.unregister("inventory_read_a")).toThrow(
        ToolRegistryLockedError,
      );
      expect(executeSpy).not.toHaveBeenCalled();
    } finally {
      lease.release();
    }
  });
});
