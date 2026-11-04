import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import { ReadWorkerPool } from "../../src/scheduler/read-worker-pool.js";
import { TaskPlanner } from "../../src/scheduler/planner.js";
import { TaskScheduler } from "../../src/scheduler/task-scheduler.js";
import type {
  WriteApprovalDecision,
  WriteApprovalHandler,
} from "../../src/scheduler/types.js";
import { WriteExecutor } from "../../src/scheduler/write-executor.js";
import { ToolRegistryLockedError } from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const inputSchema = z
  .object({
    key: z.string().min(1),
  })
  .strict();

function createScheduler(
  registry: ToolRegistry,
  approvalHandler?: WriteApprovalHandler,
): TaskScheduler {
  return new TaskScheduler({
    registry,
    planner: new TaskPlanner(registry),
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, {
      ...(approvalHandler === undefined ? {} : { approvalHandler }),
    }),
  });
}

function registerRead(
  registry: ToolRegistry,
  name: string,
  execute: (input: { key: string }) => unknown,
): void {
  registry.register({
    name,
    description: `Read through ${name}.`,
    mode: "read",
    inputSchema,
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
    requiresApproval,
    execute,
  });
}

function toolCall(id: string, name: string, key: string) {
  return {
    id,
    name,
    arguments: { key },
  };
}

describe("AgentRunner with TaskScheduler", () => {
  it("executes a complete mixed batch through the injected scheduler", async () => {
    const registry = new ToolRegistry();
    const events: string[] = [];
    registerRead(registry, "read_one", ({ key }) => {
      events.push(`read:${key}`);
      return { key };
    });
    registerWrite(registry, "write_one", ({ key }) => {
      events.push(`write:${key}`);
      return { key };
    }, true);
    const handler: WriteApprovalHandler = {
      async request(): Promise<WriteApprovalDecision> {
        events.push("approval");
        return { status: "approved" };
      },
    };
    const scheduler = createScheduler(registry, handler);
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-r1", "read_one", "r1"),
          toolCall("call-r2", "read_one", "r2"),
          toolCall("call-w", "write_one", "w"),
          toolCall("call-r3", "read_one", "r3"),
        ],
      },
      {
        content: "All scheduled tools completed.",
      },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      scheduler,
      model: "mock-model",
      taskIdFactory: () => "task-agent-scheduler",
    }).run({ objective: "Run the mixed schedule." });

    expect(result).toMatchObject({
      status: "completed",
      stopReason: "final_response",
      modelRequests: 2,
      toolCalls: 4,
      finalAnswer: "All scheduled tools completed.",
    });
    expect(result.toolResults.map((item) => item.toolCallId)).toEqual([
      "call-r1",
      "call-r2",
      "call-w",
      "call-r3",
    ]);
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(result.toolResults.map((item) => item.originalIndex)).toEqual([
      0, 1, 2, 3,
    ]);
    expect(result.toolResults.map((item) => item.mode)).toEqual([
      "read",
      "read",
      "write",
      "read",
    ]);
    expect(events).toEqual([
      "read:r1",
      "read:r2",
      "approval",
      "write:w",
      "read:r3",
    ]);

    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(
      toolMessages.map((message) => (message.role === "tool" ? message.toolCallId : "")),
    ).toEqual(["call-r1", "call-r2", "call-w", "call-r3"]);
    expect(provider.consumedResponseCount).toBe(2);
  });

  it("stops without another model request when a write outcome is unknown", async () => {
    const registry = new ToolRegistry();
    registerWrite(registry, "write_one", () => {
      throw new Error("private write failure");
    });
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-w", "write_one", "w"),
          toolCall("call-r", "read_one", "r"),
        ],
      },
      { content: "This response must not be requested." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      scheduler: createScheduler(registry),
      model: "mock-model",
    }).run({ objective: "Exercise an unknown write." });

    expect(result).toMatchObject({
      status: "write_outcome_unknown",
      stopReason: "write_outcome_unknown",
      modelRequests: 1,
      toolCalls: 2,
    });
    expect(result.finalAnswer).toBeUndefined();
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "unknown",
      "skipped",
    ]);
    expect(provider.consumedResponseCount).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private write failure");
  });

  it("continues to the next model turn after an approval rejection", async () => {
    const registry = new ToolRegistry();
    const writeExecute = vi.fn(() => ({ written: true }));
    registerWrite(registry, "write_one", writeExecute, true);
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-w", "write_one", "w"),
          toolCall("call-r", "read_one", "r"),
        ],
      },
      { content: "I can replan without the rejected write." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      scheduler: createScheduler(registry, {
        async request(): Promise<WriteApprovalDecision> {
          return { status: "rejected" };
        },
      }),
      model: "mock-model",
    }).run({ objective: "Handle a rejected write." });

    expect(result.status).toBe("completed");
    expect(result.modelRequests).toBe(2);
    expect(result.toolResults.map((item) => item.status)).toEqual([
      "skipped",
      "skipped",
    ]);
    expect(writeExecute).not.toHaveBeenCalled();
    expect(provider.consumedResponseCount).toBe(2);
  });

  it("rejects an over-budget batch before invoking the scheduler", async () => {
    const registry = new ToolRegistry();
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    const scheduler = createScheduler(registry);
    const executeSpy = vi.spyOn(scheduler, "execute");
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          toolCall("call-1", "read_one", "r1"),
          toolCall("call-2", "read_one", "r2"),
          toolCall("call-3", "read_one", "r3"),
        ],
      },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      scheduler,
      model: "mock-model",
      maxToolCalls: 2,
    }).run({ objective: "Reject an over-budget batch." });

    expect(result).toMatchObject({
      status: "limit_reached",
      stopReason: "max_tool_calls",
      toolCalls: 3,
    });
    expect(executeSpy).not.toHaveBeenCalled();
    expect(provider.consumedResponseCount).toBe(1);
    expect(result.toolResults).toEqual([]);
  });

  it("holds the registry lease across scheduling and the next model turn", async () => {
    const registry = new ToolRegistry();
    registerRead(registry, "read_one", ({ key }) => ({ key }));
    let lockObserved = false;
    let modelTurn = 0;
    const provider = {
      async generate() {
        modelTurn += 1;
        if (modelTurn === 1) {
          return {
            message: {
              role: "assistant" as const,
              content: "",
              toolCalls: [toolCall("call-1", "read_one", "r1")],
            },
            usage: { source: "unknown" as const },
          };
        }

        try {
          registry.unregister("read_one");
        } catch (error) {
          lockObserved = error instanceof ToolRegistryLockedError;
        }

        return {
          message: {
            role: "assistant" as const,
            content: "Lease remained active.",
          },
          usage: { source: "unknown" as const },
        };
      },
    };

    const result = await new AgentRunner({
      provider,
      registry,
      scheduler: createScheduler(registry),
      model: "mock-model",
    }).run({ objective: "Check registry locking." });

    expect(result.status).toBe("completed");
    expect(lockObserved).toBe(true);
    expect(() => registry.unregister("read_one")).not.toThrow();
  });

  it("rejects scheduler injection with a different registry", () => {
    const registry = new ToolRegistry();
    const otherRegistry = new ToolRegistry();

    expect(
      () =>
        new AgentRunner({
          provider: new MockLLMProvider(),
          registry,
          scheduler: createScheduler(otherRegistry),
          model: "mock-model",
        }),
    ).toThrowError(/same ToolRegistry/);
  });
});
