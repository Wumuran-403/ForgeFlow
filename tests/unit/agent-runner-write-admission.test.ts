import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import type { AgentPersistenceAdapter } from "../../src/agent/types.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("AgentRunner direct execution boundary", () => {
  it("fails closed when persistent execution has no Scheduler", () => {
    expect(() => new AgentRunner({
      provider: new MockLLMProvider("unused"), registry: new ToolRegistry(),
      model: "mock", persistence: {} as AgentPersistenceAdapter,
    })).toThrow();
  });

  it("does not dispatch a direct Write without a Scheduler", async () => {
    const registry = new ToolRegistry();
    const execute = vi.fn(async () => ({ written: true }));
    registry.register({ name: "write_demo", description: "Demo write", mode: "write",
      inputSchema: z.object({}).strict(), execute });
    const result = await new AgentRunner({
      provider: new MockLLMProvider([
        { content: "", toolCalls: [{ id: "call-write", name: "write_demo", arguments: {} }] },
        "Write rejected.",
      ]),
      registry, model: "mock",
    }).run({ objective: "Try a direct write." });
    expect(execute).not.toHaveBeenCalled();
    expect(result.toolResults[0]?.status).toBe("failed");
  });
});
