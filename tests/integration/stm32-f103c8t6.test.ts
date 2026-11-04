import { describe, expect, it } from "vitest";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import {
  createStm32F103C8T6Registry,
  STM32_TOOL_NAMES,
} from "../../src/tools/demo/stm32.js";

describe("STM32F103C8T6 Phase 1 scenario", () => {
  it("completes a three-round BOM, inventory, and specification review", async () => {
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-bom-001",
            name: STM32_TOOL_NAMES.bomGetItems,
            arguments: {},
          },
        ],
      },
      {
        content: "",
        toolCalls: [
          {
            id: "call-stock-002",
            name: STM32_TOOL_NAMES.inventoryLookup,
            arguments: {
              partNumber: "STM32F103C8T6",
              requiredQuantity: 1,
            },
          },
          {
            id: "call-spec-003",
            name: STM32_TOOL_NAMES.componentGetSpec,
            arguments: {
              partNumber: "STM32F103C8T6",
              expectedFootprint: "LQFP-48",
            },
          },
        ],
      },
      {
        content:
          "STM32F103C8T6 review complete: BOM fields are complete, demo inventory is sufficient, and the LQFP-48 footprint matches. No write actions were performed.",
      },
    ]);
    const result = await new AgentRunner({
      provider,
      registry: createStm32F103C8T6Registry(),
      model: "mock-model",
      taskIdFactory: () => "stm32-review-001",
    }).run({
      objective:
        "Review the STM32F103C8T6 design BOM, inventory, and LQFP-48 specification.",
    });

    expect(result.status).toBe("completed");
    expect(result.stopReason).toBe("final_response");
    expect(result.modelRequests).toBe(3);
    expect(result.toolCalls).toBe(3);
    expect(result.finalAnswer).toContain("STM32F103C8T6");
    expect(result.finalAnswer).toContain("LQFP-48");

    expect(result.toolResults).toMatchObject([
      {
        toolCallId: "call-bom-001",
        status: "succeeded",
        output: {
          summary: {
            lineCount: 4,
            missingRequiredFields: [],
          },
        },
      },
      {
        toolCallId: "call-stock-002",
        status: "succeeded",
        output: {
          available: 1050,
          sufficient: true,
        },
      },
      {
        toolCallId: "call-spec-003",
        status: "succeeded",
        output: {
          footprintMatches: true,
          specification: {
            package: "LQFP-48",
          },
        },
      },
    ]);

    const toolMessages = result.messages.filter((message) => message.role === "tool");
    expect(
      toolMessages.map((message) => (message.role === "tool" ? message.toolCallId : "")),
    ).toEqual(["call-bom-001", "call-stock-002", "call-spec-003"]);

    expect(provider.requests).toHaveLength(3);
    expect(provider.consumedResponseCount).toBe(3);
    expect(
      provider.requests[1]?.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(1);
    expect(
      provider.requests[2]?.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(3);
    expect(
      provider.requests[0]?.tools.map((tool) => tool.name),
    ).toEqual(["bom_get_items", "inventory_lookup", "component_get_spec"]);

    const toolCallAssistantMessages = result.messages.filter(
      (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
    );
    expect(toolCallAssistantMessages).toHaveLength(2);
    expect(toolCallAssistantMessages[1]).toMatchObject({
      role: "assistant",
      toolCalls: [
        { id: "call-stock-002", name: "inventory_lookup" },
        { id: "call-spec-003", name: "component_get_spec" },
      ],
    });
  });
});
