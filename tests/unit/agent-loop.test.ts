import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import type {
  GenerateOptions,
  LLMProvider,
  ModelRequest,
  ModelResponse,
} from "../../src/provider/types.js";
import { AppError } from "../../src/shared/errors.js";
import { ToolRegistryLockedError } from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionContext } from "../../src/tools/types.js";

function createEchoRegistry(
  execute: (input: { label: string }) => Promise<unknown>,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "demo_echo",
    description: "Return a deterministic value.",
    mode: "read",
    inputSchema: z.object({ label: z.string().min(1) }).strict(),
    execute,
  });
  return registry;
}

describe("AgentRunner", () => {
  it("stops a non-persistent run before the next provider request when its token budget is exhausted", async () => {
    const registry = createEchoRegistry(async ({ label }) => ({ label }));
    const provider = new MockLLMProvider([
      {
        content: "Read once.",
        toolCalls: [{ id: "budget-call", name: "demo_echo", arguments: { label: "budget" } }],
        usage: {
          promptTokens: 2_000,
          completionTokens: 1_000,
          totalTokens: 3_000,
          source: "provider",
        },
      },
      "Must not be requested.",
    ]);
    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
      maxTaskTokens: 5_000,
    }).run({ objective: "Respect the task token budget." });

    expect(result).toMatchObject({
      status: "limit_reached",
      stopReason: "task_token_budget_exhausted",
      modelRequests: 1,
    });
    expect(provider.consumedResponseCount).toBe(1);
    expect(result.toolResults).toHaveLength(1);
  });

  it("returns a direct final answer without requesting tools", async () => {
    const provider = new MockLLMProvider(["Direct answer."]);
    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(async ({ label }) => ({ label })),
      model: "mock-model",
      taskIdFactory: () => "task-direct",
    }).run({ objective: "Answer directly." });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("final_response");
    expect(result.finalAnswer).toBe("Direct answer.");
    expect(result.modelRequests).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
      "assistant",
    ]);
  });

  it("executes multiple calls in order and appends one complete assistant tool-call message", async () => {
    const events: string[] = [];
    let activeCalls = 0;
    let maxActiveCalls = 0;
    const registry = createEchoRegistry(async ({ label }) => {
      activeCalls += 1;
      maxActiveCalls = Math.max(maxActiveCalls, activeCalls);
      events.push(`start:${label}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
      events.push(`end:${label}`);
      activeCalls -= 1;
      return { label };
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          { id: "call-1", name: "demo_echo", arguments: { label: "first" } },
          { id: "call-2", name: "demo_echo", arguments: { label: "second" } },
        ],
      },
      { content: "Both tool calls completed." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
      taskIdFactory: () => "task-sequential",
    }).run({ objective: "Run two ordered lookups." });

    expect(events).toEqual([
      "start:first",
      "end:first",
      "start:second",
      "end:second",
    ]);
    expect(maxActiveCalls).toBe(1);
    expect(result.status).toBe("completed");
    expect(result.modelRequests).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(result.toolResults.map((toolResult) => toolResult.toolCallId)).toEqual([
      "call-1",
      "call-2",
    ]);
    expect(provider.consumedResponseCount).toBe(2);

    const toolCallAssistantMessages = result.messages.filter(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 1,
    );
    expect(toolCallAssistantMessages).toHaveLength(1);
    expect(toolCallAssistantMessages[0]).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [
        { id: "call-1", name: "demo_echo" },
        { id: "call-2", name: "demo_echo" },
      ],
    });

    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(
      toolMessages.map((message) => (message.role === "tool" ? message.toolCallId : "")),
    ).toEqual(["call-1", "call-2"]);
  });

  it("completes consecutive model turns that request different tools", async () => {
    const events: string[] = [];
    const registry = new ToolRegistry();
    registry.register({
      name: "inventory_lookup",
      description: "Look up demo inventory.",
      mode: "read",
      inputSchema: z.object({ partNumber: z.string().min(1) }).strict(),
      execute: async ({ partNumber }) => {
        events.push(`inventory:${partNumber}`);
        return { available: 1050, partNumber };
      },
    });
    registry.register({
      name: "component_get_spec",
      description: "Read a demo component specification.",
      mode: "read",
      inputSchema: z.object({ partNumber: z.string().min(1) }).strict(),
      execute: async ({ partNumber }) => {
        events.push(`spec:${partNumber}`);
        return { package: "LQFP-48", partNumber };
      },
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-inventory",
            name: "inventory_lookup",
            arguments: { partNumber: "STM32F103C8T6" },
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            id: "call-spec",
            name: "component_get_spec",
            arguments: { partNumber: "STM32F103C8T6" },
          },
        ],
      },
      { content: "Review complete." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Check inventory and specification." });

    expect(events).toEqual([
      "inventory:STM32F103C8T6",
      "spec:STM32F103C8T6",
    ]);
    expect(result.status).toBe("completed");
    expect(result.modelRequests).toBe(3);
    expect(result.toolCalls).toBe(2);
    expect(result.finalAnswer).toBe("Review complete.");
    expect(provider.consumedResponseCount).toBe(3);
  });

  it("returns a structured tool failure to the model and continues deciding", async () => {
    const registry = createEchoRegistry(async () => {
      throw new Error("private failure detail");
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [{ id: "call-failed", name: "demo_echo", arguments: { label: "bad" } }],
      },
      { content: "The tool failed, so I am reporting the limitation." },
    ]);
    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Exercise tool failure recovery." });

    expect(result.status).toBe("completed");
    expect(result.modelRequests).toBe(2);
    expect(result.toolCalls).toBe(1);
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "call-failed",
      status: "failed",
      error: { code: "TOOL_EXECUTION_FAILED" },
    });
    expect(JSON.stringify(result.messages)).not.toContain("private failure detail");
    expect(result.finalAnswer).toBe("The tool failed, so I am reporting the limitation.");
  });

  it("converts missing, invalid, and malformed JSON tool calls into correlated safe results", async () => {
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          { id: "call-missing", name: "missing_tool", arguments: {} },
          { id: "call-invalid", name: "demo_echo", arguments: { label: 42 } },
          { id: "call-json", name: "demo_echo", arguments: "{not-json" },
        ],
      },
      { content: "I recovered from the malformed tool calls." },
    ]);
    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(async ({ label }) => ({ label })),
      model: "mock-model",
    }).run({ objective: "Exercise malformed tool calls." });

    expect(result.status).toBe("completed");
    expect(result.toolCalls).toBe(3);
    expect(result.toolResults.map((toolResult) => toolResult.toolCallId)).toEqual([
      "call-missing",
      "call-invalid",
      "call-json",
    ]);
    expect(result.toolResults.map((toolResult) => toolResult.error?.code)).toEqual([
      "TOOL_NOT_FOUND",
      "TOOL_INPUT_INVALID",
      "TOOL_ARGUMENTS_JSON_INVALID",
    ]);

    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(
      toolMessages.map((message) => (message.role === "tool" ? message.toolCallId : "")),
    ).toEqual(["call-missing", "call-invalid", "call-json"]);
    expect(toolMessages).toHaveLength(3);
  });

  it("parses JSON string arguments once and passes object arguments without parsing", async () => {
    const receivedLabels: string[] = [];
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-json-string",
            name: "demo_echo",
            arguments: JSON.stringify({ label: "from-json" }),
          },
          {
            id: "call-object",
            name: "demo_echo",
            arguments: { label: "from-object" },
          },
        ],
      },
      { content: "Arguments accepted." },
    ]);
    const registry = createEchoRegistry(async ({ label }) => {
      receivedLabels.push(label);
      return { label };
    });

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Exercise both argument representations." });

    expect(receivedLabels).toEqual(["from-json", "from-object"]);
    expect(result.toolResults.every((toolResult) => toolResult.status === "succeeded")).toBe(
      true,
    );
  });

  it("rejects an over-budget tool-call batch before executing any tool", async () => {
    const execute = vi.fn(async ({ label }: { label: string }) => ({ label }));
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          { id: "call-1", name: "demo_echo", arguments: { label: "one" } },
          { id: "call-2", name: "demo_echo", arguments: { label: "two" } },
          { id: "call-3", name: "demo_echo", arguments: { label: "three" } },
        ],
      },
      { content: "This response must not be requested." },
    ]);
    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(execute),
      model: "mock-model",
      maxToolCalls: 2,
    }).run({ objective: "Reach the tool call limit." });

    expect(result.status).toBe("limit_reached");
    expect(result.stopReason).toBe("max_tool_calls");
    expect(result.modelRequests).toBe(1);
    expect(result.toolCalls).toBe(3);
    expect(result.toolResults).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.messages.filter((message) => message.role === "tool")).toHaveLength(0);
    expect(provider.consumedResponseCount).toBe(1);
  });

  it("stops before exceeding the model request limit", async () => {
    const registry = createEchoRegistry(async ({ label }) => ({ label }));
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [{ id: "call-1", name: "demo_echo", arguments: { label: "one" } }],
      },
      {
        content: "",
        toolCalls: [{ id: "call-2", name: "demo_echo", arguments: { label: "two" } }],
      },
      {
        content: "",
        toolCalls: [{ id: "call-3", name: "demo_echo", arguments: { label: "three" } }],
      },
    ]);
    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
      maxModelTurns: 2,
    }).run({ objective: "Reach the model request limit." });

    expect(result.status).toBe("limit_reached");
    expect(result.stopReason).toBe("max_model_requests");
    expect(result.modelRequests).toBe(2);
    expect(result.toolCalls).toBe(2);
    expect(provider.requests).toHaveLength(2);
  });

  it("does not request the model when cancellation is already requested", async () => {
    const provider = new MockLLMProvider([{ content: "must not be requested" }]);
    const controller = new AbortController();
    controller.abort();

    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(async ({ label }) => ({ label })),
      model: "mock-model",
    }).run(
      { objective: "Cancelled task." },
      {
        signal: controller.signal,
      },
    );

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    expect(result.modelRequests).toBe(0);
    expect(result.toolCalls).toBe(0);
    expect(result.toolResults).toEqual([]);
    expect(provider.consumedResponseCount).toBe(0);
  });

  it("rechecks cancellation after a provider ignores AbortSignal and returns", async () => {
    const controller = new AbortController();
    let providerRequests = 0;
    const provider: LLMProvider = {
      async generate(
        _request: ModelRequest,
        _options?: GenerateOptions,
      ): Promise<ModelResponse> {
        providerRequests += 1;
        controller.abort();
        return {
          message: {
            role: "assistant",
            content: "This late response must be ignored.",
          },
          usage: {
            source: "unknown",
          },
        };
      },
    };

    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(async ({ label }) => ({ label })),
      model: "mock-model",
    }).run(
      { objective: "Cancel after the provider responds." },
      { signal: controller.signal },
    );

    expect(providerRequests).toBe(1);
    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    expect(result.finalAnswer).toBeUndefined();
    expect(result.modelRequests).toBe(1);
    expect(result.toolCalls).toBe(0);
    expect(result.toolResults).toEqual([]);
    expect(result.messages.map((message) => message.role)).toEqual(["system", "user"]);
  });

  it("stops between tool calls on cancellation without converting it to a tool error", async () => {
    const controller = new AbortController();
    const secondExecute = vi.fn(async () => ({ label: "second" }));
    const registry = new ToolRegistry();
    registry.register({
      name: "cancel_first",
      description: "Cancel during the first call.",
      mode: "read",
      inputSchema: z.object({}).strict(),
      execute: () => {
        controller.abort();
        return { cancelled: true };
      },
    });
    registry.register({
      name: "cancel_second",
      description: "Must not run after cancellation.",
      mode: "read",
      inputSchema: z.object({}).strict(),
      execute: secondExecute,
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          { id: "call-cancel", name: "cancel_first", arguments: {} },
          { id: "call-after", name: "cancel_second", arguments: {} },
        ],
      },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run(
      { objective: "Cancel between tool calls." },
      {
        signal: controller.signal,
      },
    );

    expect(result.status).toBe("cancelled");
    expect(result.stopReason).toBe("cancelled");
    expect(result.toolCalls).toBe(2);
    expect(result.toolResults).toHaveLength(1);
    expect(result.toolResults[0]?.toolCallId).toBe("call-cancel");
    expect(secondExecute).not.toHaveBeenCalled();
    expect(provider.consumedResponseCount).toBe(1);
  });

  it("treats empty tool-free responses as a controlled failure", async () => {
    const provider = new MockLLMProvider([{ content: "   " }]);
    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(async ({ label }) => ({ label })),
      model: "mock-model",
    }).run({ objective: "Return an empty response." });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("empty_response");
    expect(result.finalAnswer).toBeUndefined();
    expect(result.modelRequests).toBe(1);
  });

  it("sends draft-07 input JSON Schema as model tool parameters", async () => {
    const schema = z
      .object({
        partNumber: z.string().min(1),
        requiredQuantity: z.number().int().positive().default(1),
      })
      .strict();
    const registry = new ToolRegistry();
    registry.register({
      name: "inventory_lookup",
      description: "Look up inventory.",
      mode: "read",
      inputSchema: schema,
      execute: async () => ({ found: true }),
    });
    const provider = new MockLLMProvider(["schema checked"]);

    await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Inspect the tool schema." });

    const toolDefinition = provider.requests[0]?.tools[0];
    expect(toolDefinition).toEqual({
      name: "inventory_lookup",
      description: "Look up inventory.",
      parameters: z.toJSONSchema(schema, {
        target: "draft-07",
        io: "input",
        unrepresentable: "throw",
      }),
    });
    expect(toolDefinition?.parameters.$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
    expect(toolDefinition?.parameters.strict).toBeUndefined();
  });

  it("converts a BigInt tool output into a correlated safe failure and continues", async () => {
    const registry = new ToolRegistry();
    registry.register({
      name: "bigint_output",
      description: "Return a value that JSON cannot serialize.",
      mode: "read",
      inputSchema: z.object({}).strict(),
      execute: () => ({ value: 1n }),
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [{ id: "call-bigint", name: "bigint_output", arguments: {} }],
      },
      { content: "The serialization failure was handled." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Handle a BigInt tool output." });

    expect(result.status).toBe("completed");
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "call-bigint",
      status: "failed",
      error: { code: "TOOL_OUTPUT_NOT_SERIALIZABLE" },
    });
    expect(result.messages.filter((message) => message.role === "tool")).toMatchObject([
      { toolCallId: "call-bigint" },
    ]);
  });

  it("converts a circular tool output into a correlated safe failure and continues", async () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const registry = new ToolRegistry();
    registry.register({
      name: "circular_output",
      description: "Return a circular object.",
      mode: "read",
      inputSchema: z.object({}).strict(),
      execute: () => circular,
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [{ id: "call-circular", name: "circular_output", arguments: {} }],
      },
      { content: "The circular output was handled safely." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Handle a circular tool output." });

    expect(result.status).toBe("completed");
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "call-circular",
      status: "failed",
      error: { code: "TOOL_OUTPUT_NOT_SERIALIZABLE" },
    });
    expect(result.messages.filter((message) => message.role === "tool")).toMatchObject([
      { toolCallId: "call-circular" },
    ]);
  });

  it("does not expose a sensitive AppError thrown by a tool", async () => {
    const sensitiveValue = "sk-test-secret-value";
    const registry = createEchoRegistry(async () => {
      throw new AppError({
        code: "SENSITIVE_TOOL_FAILURE",
        message: `Authorization failed with ${sensitiveValue}`,
        statusCode: 500,
        details: [{ path: "apiKey", message: sensitiveValue }],
      });
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [{ id: "call-sensitive", name: "demo_echo", arguments: { label: "x" } }],
      },
      { content: "The sensitive failure was sanitized." },
    ]);

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
    }).run({ objective: "Exercise sensitive tool errors." });

    const serialized = JSON.stringify(result);
    expect(result.status).toBe("completed");
    expect(result.toolResults[0]).toMatchObject({
      toolCallId: "call-sensitive",
      status: "failed",
      error: { code: "TOOL_EXECUTION_FAILED" },
    });
    expect(serialized).not.toContain(sensitiveValue);
    expect(serialized).not.toContain("Authorization failed");
    expect(serialized).not.toContain("stack");
  });

  it("reports provider failures directly without creating a tool result", async () => {
    const providerError = new Error("simulated provider outage");
    const provider = new MockLLMProvider([{ error: providerError }]);
    const result = await new AgentRunner({
      provider,
      registry: createEchoRegistry(async ({ label }) => ({ label })),
      model: "mock-model",
    }).run({ objective: "Simulate provider failure." });

    expect(result.status).toBe("failed");
    expect(result.stopReason).toBe("provider_error");
    expect(result.modelRequests).toBe(1);
    expect(result.toolResults).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("simulated provider outage");
  });

  it("passes run context to tools and locks definitions until the run completes", async () => {
    const registry = new ToolRegistry();
    let receivedContext: ToolExecutionContext | undefined;
    let observedLockError = false;
    registry.register({
      name: "context_probe",
      description: "Capture the execution context.",
      mode: "read",
      inputSchema: z.object({ label: z.string().min(1) }).strict(),
      execute: ({ label }, context) => {
        receivedContext = context;
        return { label };
      },
    });
    let modelTurn = 0;
    const provider: LLMProvider = {
      async generate(): Promise<ModelResponse> {
        modelTurn += 1;
        if (modelTurn === 1) {
          try {
            registry.register({
              name: "late_tool",
              description: "Must not be registered during a run.",
              mode: "read",
              inputSchema: z.object({}).strict(),
              execute: () => ({}),
            });
          } catch (error) {
            observedLockError = error instanceof ToolRegistryLockedError;
          }

          return {
            message: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "call-context",
                  name: "context_probe",
                  arguments: { label: "context" },
                },
              ],
            },
            usage: { source: "unknown" },
          };
        }

        return {
          message: {
            role: "assistant",
            content: "Context captured.",
          },
          usage: { source: "unknown" },
        };
      },
    };

    const result = await new AgentRunner({
      provider,
      registry,
      model: "mock-model",
      taskIdFactory: () => "task-stable-definitions",
    }).run({ objective: "Capture execution context." });

    expect(result.status).toBe("completed");
    expect(observedLockError).toBe(true);
    expect(receivedContext).toMatchObject({
      taskId: "task-stable-definitions",
      toolCallId: "call-context",
    });
    expect(receivedContext?.signal).toBeInstanceOf(AbortSignal);

    expect(() =>
      registry.register({
        name: "after_run",
        description: "Registration works after the lease is released.",
        mode: "read",
        inputSchema: z.object({}).strict(),
        execute: () => ({}),
      }),
    ).not.toThrow();
  });

  it("keeps the registry locked until all concurrent Agent runs complete", async () => {
    function deferred(): { promise: Promise<void>; resolve: () => void } {
      let resolve!: () => void;
      const promise = new Promise<void>((complete) => {
        resolve = complete;
      });
      return { promise, resolve };
    }

    const startedA = deferred();
    const startedB = deferred();
    const releaseA = deferred();
    const releaseB = deferred();
    const registry = createEchoRegistry(async ({ label }) => ({ label }));
    const modelResponse = (content: string): ModelResponse => ({
      message: {
        role: "assistant",
        content,
      },
      usage: {
        source: "unknown",
      },
    });
    const providerA: LLMProvider = {
      async generate(): Promise<ModelResponse> {
        startedA.resolve();
        await releaseA.promise;
        return modelResponse("Agent A completed.");
      },
    };
    const providerB: LLMProvider = {
      async generate(): Promise<ModelResponse> {
        startedB.resolve();
        await releaseB.promise;
        return modelResponse("Agent B completed.");
      },
    };

    const runA = new AgentRunner({
      provider: providerA,
      registry,
      model: "mock-model",
      taskIdFactory: () => "task-agent-a",
    }).run({ objective: "Agent A." });
    const runB = new AgentRunner({
      provider: providerB,
      registry,
      model: "mock-model",
      taskIdFactory: () => "task-agent-b",
    }).run({ objective: "Agent B." });

    try {
      await Promise.all([startedA.promise, startedB.promise]);

      expect(() =>
        registry.register({
          name: "concurrent_late_tool",
          description: "Must remain locked while either Agent runs.",
          mode: "read",
          inputSchema: z.object({}).strict(),
          execute: () => ({}),
        }),
      ).toThrow(ToolRegistryLockedError);
      expect(() => registry.unregister("demo_echo")).toThrow(
        ToolRegistryLockedError,
      );

      releaseA.resolve();
      await expect(runA).resolves.toMatchObject({
        status: "completed",
        finalAnswer: "Agent A completed.",
      });

      expect(() =>
        registry.register({
          name: "unexpected_unlock",
          description: "Agent B still holds its lease.",
          mode: "read",
          inputSchema: z.object({}).strict(),
          execute: () => ({}),
        }),
      ).toThrow(ToolRegistryLockedError);
      expect(() => registry.unregister("demo_echo")).toThrow(
        ToolRegistryLockedError,
      );

      releaseB.resolve();
      await expect(runB).resolves.toMatchObject({
        status: "completed",
        finalAnswer: "Agent B completed.",
      });

      expect(() => registry.unregister("demo_echo")).not.toThrow();
    } finally {
      releaseA.resolve();
      releaseB.resolve();
      await Promise.allSettled([runA, runB]);
    }
  });
});
