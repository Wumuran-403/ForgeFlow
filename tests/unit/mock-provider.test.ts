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
  });

  it("does not perform work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();

    const provider = new MockLLMProvider();

    await expect(provider.generate(request, { signal: controller.signal })).rejects.toMatchObject({
      code: "REQUEST_ABORTED",
    });
  });
});
