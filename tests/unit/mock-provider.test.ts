import { describe, expect, it } from "vitest";

import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import type { ModelRequest } from "../../src/provider/types.js";

const request: ModelRequest = {
  model: "mock-model",
  messages: [{ role: "user", content: "health check" }],
  tools: [],
};

describe("MockLLMProvider", () => {
  it("returns a deterministic response and estimated usage", async () => {
    const provider = new MockLLMProvider("ready");
    const response = await provider.generate(request);

    expect(response.message).toEqual({
      role: "assistant",
      content: "ready",
    });
    expect(response.usage.source).toBe("estimated");
    expect(response.usage.totalTokens).toBeGreaterThan(0);
    expect(provider.consumedResponseCount).toBe(1);
  });

  it("does not perform work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new MockLLMProvider();

    await expect(provider.generate(request, { signal: controller.signal })).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    });
    expect(provider.consumedResponseCount).toBe(0);
  });

  it("returns three scripted responses in order and then reports exhaustion", async () => {
    const provider = new MockLLMProvider([
      "Round one",
      {
        content: "Round two",
        toolCalls: [
          {
            id: "call-2",
            name: "inventory_lookup",
            arguments: { partNumber: "STM32F103C8T6" },
          },
        ],
      },
      "Round three",
    ]);

    const first = await provider.generate(request);
    const second = await provider.generate(request);
    const third = await provider.generate(request);

    expect([first.message.content, second.message.content, third.message.content]).toEqual([
      "Round one",
      "Round two",
      "Round three",
    ]);
    expect(second.message.toolCalls).toEqual([
      {
        id: "call-2",
        name: "inventory_lookup",
        arguments: { partNumber: "STM32F103C8T6" },
      },
    ]);
    expect(provider.requests).toHaveLength(3);
    expect(provider.consumedResponseCount).toBe(3);
    await expect(provider.generate(request)).rejects.toMatchObject({
      code: "MOCK_SCRIPT_EXHAUSTED",
    });
    expect(provider.consumedResponseCount).toBe(3);
  });

  it("throws a scripted provider error and can continue with the next step", async () => {
    const providerError = new Error("simulated provider outage");
    const provider = new MockLLMProvider([
      { error: providerError },
      { content: "recovered" },
    ]);

    await expect(provider.generate(request)).rejects.toBe(providerError);
    expect(provider.consumedResponseCount).toBe(1);

    await expect(provider.generate(request)).resolves.toMatchObject({
      message: { content: "recovered" },
    });
    expect(provider.consumedResponseCount).toBe(2);
  });

  it("stores independent request history snapshots", async () => {
    const provider = new MockLLMProvider(["first", "second"]);
    const mutableRequest: ModelRequest = structuredClone(request);

    await provider.generate(mutableRequest);
    mutableRequest.messages[0] = { role: "user", content: "mutated after the first call" };
    await provider.generate(mutableRequest);

    const history = provider.requests;
    expect(history).toHaveLength(2);
    expect(history[0]?.messages[0]).toEqual({
      role: "user",
      content: "health check",
    });
    expect(history[1]?.messages[0]).toEqual({
      role: "user",
      content: "mutated after the first call",
    });
  });
});
