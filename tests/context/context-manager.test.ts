import { describe, expect, it, vi } from "vitest";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import {
  aggregateModelUsage,
  ContextBudgetExceededError,
  ContextManager,
  normalizeModelResponseUsage,
} from "../../src/context/index.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import { DeepSeekProvider, type DeepSeekFetch } from "../../src/provider/deepseek-provider.js";
import type { AgentMessage, LLMProvider, ModelRequest } from "../../src/provider/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const tools = [{
  name: "inventory_lookup",
  description: "Look up inventory.",
  parameters: { type: "object", properties: {} },
}];

describe("ContextManager", () => {
  it("keeps a short conversation unchanged", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "Keep safety constraints." },
      { role: "user", content: "Check the current BOM." },
      { role: "assistant", content: "The BOM is ready." },
    ];
    const built = new ContextManager().build({ model: "mock", messages, tools });

    expect(built.request.messages).toEqual(messages);
    expect(built.omittedMessages).toBe(0);
    expect(built.truncatedToolResults).toBe(0);
  });

  it("selects recent history while retaining system and the latest user task", () => {
    const messages: AgentMessage[] = [
      { role: "system", content: "System safety rule." },
      { role: "user", content: `Old task ${"x".repeat(1_500)}` },
      { role: "assistant", content: `Old answer ${"y".repeat(1_500)}` },
      { role: "user", content: "Current task must remain." },
      { role: "assistant", content: "Recent progress." },
    ];
    const built = new ContextManager({
      maxContextTokens: 400,
      reservedCompletionTokens: 80,
      maxToolResultTokens: 64,
    }).build({ model: "mock", messages, tools: [] });

    expect(built.omittedMessages).toBeGreaterThan(0);
    expect(built.request.messages).toContainEqual(messages[0]);
    expect(built.request.messages).toContainEqual(messages[3]);
    expect(built.request.messages).toContainEqual(messages[4]);
    expect(built.request.messages).not.toContainEqual(messages[1]);
  });

  it("truncates a large Tool Result without orphaning its Assistant ToolCall", () => {
    const originalContent = JSON.stringify({
      toolCallId: "call-large",
      toolName: "inventory_lookup",
      status: "succeeded",
      output: { rows: Array.from({ length: 300 }, (_, index) => ({ index, note: "z".repeat(40) })) },
    });
    const messages: AgentMessage[] = [
      { role: "system", content: "Use tool evidence." },
      { role: "user", content: "Check inventory." },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-large", name: "inventory_lookup", arguments: {} }],
      },
      { role: "tool", toolCallId: "call-large", content: originalContent },
    ];
    const built = new ContextManager({
      maxContextTokens: 1_000,
      reservedCompletionTokens: 100,
      maxToolResultTokens: 80,
    }).build({ model: "mock", messages, tools });

    expect(built.truncatedToolResults).toBe(1);
    const assistant = built.request.messages.find((message) => message.role === "assistant");
    const tool = built.request.messages.find((message) => message.role === "tool");
    expect(assistant?.role === "assistant" ? assistant.toolCalls?.[0]?.id : undefined)
      .toBe("call-large");
    expect(tool?.role === "tool" ? tool.toolCallId : undefined).toBe("call-large");
    expect(tool?.content).toContain('"truncated":true');
    expect(tool?.content).toContain("TRUNCATED_CONTEXT_ONLY");
    expect(messages[3]?.content).toBe(originalContent);
  });

  it("fails closed when required context cannot fit", () => {
    const manager = new ContextManager({
      maxContextTokens: 100,
      reservedCompletionTokens: 20,
      maxToolResultTokens: 64,
    });
    expect(() => manager.build({
      model: "mock",
      messages: [
        { role: "system", content: "s".repeat(1_000) },
        { role: "user", content: "Current task." },
      ],
      tools: [],
    })).toThrow(ContextBudgetExceededError);
  });

  it("prefers provider usage, estimates missing usage, and aggregates sources separately", () => {
    const request: ModelRequest = {
      model: "mock",
      messages: [{ role: "user", content: "Count usage." }],
      tools: [],
    };
    const actual = normalizeModelResponseUsage(request, {
      message: { role: "assistant", content: "Actual." },
      usage: { promptTokens: 10, completionTokens: 4, source: "provider" },
    });
    const estimated = normalizeModelResponseUsage(request, {
      message: { role: "assistant", content: "Estimated." },
      usage: { source: "unknown" },
    });
    const aggregate = aggregateModelUsage([actual.usage, estimated.usage]);

    expect(actual.usage).toEqual({
      promptTokens: 10,
      completionTokens: 4,
      totalTokens: 14,
      source: "provider",
    });
    expect(estimated.usage.source).toBe("estimated");
    expect(estimated.usage.totalTokens).toBeGreaterThan(0);
    expect(aggregate.source).toBe("mixed");
    expect(aggregate.providerCalls).toBe(1);
    expect(aggregate.estimatedCalls).toBe(1);
    expect(aggregate.provider?.totalTokens).toBe(14);
    expect(aggregate.estimated?.totalTokens).toBe(estimated.usage.totalTokens);
  });

  it("stops before calling the provider when the safe minimum exceeds budget", async () => {
    const generate = vi.fn<LLMProvider["generate"]>();
    const result = await new AgentRunner({
      provider: { generate },
      registry: new ToolRegistry(),
      model: "mock",
      context: {
        maxContextTokens: 64,
        reservedCompletionTokens: 16,
        maxToolResultTokens: 64,
      },
    }).run({ objective: "u".repeat(400) });

    expect(result.status).toBe("limit_reached");
    expect(result.stopReason).toBe("context_budget_exceeded");
    expect(result.modelRequests).toBe(0);
    expect(generate).not.toHaveBeenCalled();
  });

  it("applies the same Context Manager path to any LLMProvider implementation", async () => {
    const messagesSeen: AgentMessage[][] = [];
    const provider: LLMProvider = {
      async generate(request) {
        messagesSeen.push([...request.messages]);
        return {
          message: { role: "assistant", content: "Done." },
          usage: { source: "unknown" },
        };
      },
    };
    const mock = new MockLLMProvider("Done.");
    const context = {
      maxContextTokens: 500,
      reservedCompletionTokens: 50,
      maxToolResultTokens: 64,
    };
    await new AgentRunner({ provider, registry: new ToolRegistry(), model: "custom", context })
      .run({ objective: "Use the common manager." });
    await new AgentRunner({ provider: mock, registry: new ToolRegistry(), model: "mock", context })
      .run({ objective: "Use the common manager." });

    expect(messagesSeen[0]).toEqual(mock.requests[0]?.messages);
  });

  it("sends the same managed request contract to Mock and DeepSeek providers", async () => {
    const managed = new ContextManager({
      maxContextTokens: 500,
      reservedCompletionTokens: 50,
      maxToolResultTokens: 64,
    }).build({
      model: "shared-model",
      messages: [
        { role: "system", content: "Shared system prompt." },
        { role: "assistant", content: "old".repeat(600) },
        { role: "user", content: "Current shared task." },
      ],
      tools: [],
    }).request;
    const mock = new MockLLMProvider("Done.");
    let deepSeekBody: { messages?: unknown } = {};
    const fetch = vi.fn<DeepSeekFetch>(async (_input, init) => {
      deepSeekBody = JSON.parse(String(init?.body)) as { messages?: unknown };
      return new Response(JSON.stringify({
        choices: [{ finish_reason: "stop", message: { content: "Done." } }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    });
    const deepSeek = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      maxRetries: 0,
      fetch,
    });

    await mock.generate(managed);
    await deepSeek.generate(managed);

    expect(mock.requests[0]).toEqual(managed);
    expect(deepSeekBody.messages).toEqual(
      managed.messages.map((message) => ({ role: message.role, content: message.content })),
    );
  });
});
