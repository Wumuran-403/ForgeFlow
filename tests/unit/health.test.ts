import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import { runHealthCheck } from "../../src/health.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";

describe("runHealthCheck", () => {
  it("reports a ready Mock mode without external credentials", async () => {
    const report = await runHealthCheck(loadConfig({}), new MockLLMProvider());

    expect(report).toMatchObject({
      status: "ok",
      service: "forgeflow",
      phase: "phase-0",
      provider: "mock",
      model: "mock-model",
    });
    expect(report.mockResponse).not.toBe("");
  });
});
