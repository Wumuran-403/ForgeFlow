import { describe, expect, it, vi } from "vitest";

import {
  createMockStm32DemoProvider,
  runStm32AgentDemo,
} from "../../src/demo/stm32-agent-demo.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import type { WriteApprovalHandler } from "../../src/scheduler/index.js";
import {
  STM32_TOOL_NAMES,
  type Stm32ProcurementDraft,
} from "../../src/tools/demo/stm32.js";

function approvalHandler(
  decision:
    | { readonly status: "approved" }
    | { readonly status: "rejected"; readonly reason: string },
): WriteApprovalHandler {
  return {
    request: async () => decision,
  };
}

describe("STM32 BOM agent demo", () => {
  it("completes the offline read, shortage, approved write, and readback flow", async () => {
    const approval = vi.fn<WriteApprovalHandler["request"]>(async () => ({
      status: "approved",
    }));
    const result = await runStm32AgentDemo({
      provider: createMockStm32DemoProvider(),
      model: "mock-model",
      approvalHandler: { request: approval },
      taskId: "stm32-demo-approved",
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.stopReason).toBe("final_response");
    expect(result.snapshot.task.status).toBe("completed");
    expect(result.run.finalAnswer).toContain("short 950");
    expect(result.run.finalAnswer).toContain(
      "Re-reading confirmed 1 simulated procurement draft",
    );
    expect(approval).toHaveBeenCalledTimes(1);
    expect(
      result.snapshot.planSteps.reduce<Record<string, number>>(
        (counts, step) => ({
          ...counts,
          [step.kind]: (counts[step.kind] ?? 0) + 1,
        }),
        {},
      ),
    ).toEqual({
      read_batch: 3,
      write: 1,
    });
    const writeRun = result.snapshot.toolRuns.find(
      (run) => run.toolName === STM32_TOOL_NAMES.procurementCreateDraft,
    );
    expect(writeRun?.status).toBe("succeeded");
    expect(writeRun?.output).toMatchObject({ approval: "approved" });
    expect(
      result.snapshot.toolRuns.find(
        (run) => run.toolName === STM32_TOOL_NAMES.procurementGetDrafts,
      )?.status,
    ).toBe("succeeded");
    expect(result.drafts).toHaveLength(1);
    expect(result.drafts[0]?.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ partNumber: "STM32F103C8T6", quantity: 950 }),
        expect.objectContaining({ partNumber: "X32258MSB4SI", quantity: 1600 }),
      ]),
    );
    expect(result.snapshot.toolRuns).toHaveLength(7);
  });

  it("does not execute the simulated write when approval is rejected", async () => {
    const approval = vi.fn<WriteApprovalHandler["request"]>(async () => ({
      status: "rejected",
      reason: "Portfolio rejection test.",
    }));
    const result = await runStm32AgentDemo({
      provider: createMockStm32DemoProvider(),
      model: "mock-model",
      approvalHandler: { request: approval },
      taskId: "stm32-demo-rejected",
    });

    expect(result.run.status).toBe("completed");
    expect(result.run.finalAnswer).toContain("approval was rejected");
    expect(approval).toHaveBeenCalledTimes(1);
    expect(
      result.snapshot.toolRuns.find(
        (run) => run.toolName === STM32_TOOL_NAMES.procurementCreateDraft,
      )?.status,
    ).toBe("skipped");
    expect(
      result.snapshot.toolRuns.find(
        (run) => run.toolName === STM32_TOOL_NAMES.procurementGetDrafts,
      )?.status,
    ).toBe("succeeded");
    expect(result.drafts).toEqual([] satisfies Stm32ProcurementDraft[]);
  });

  it("stops a repeated tool loop at the configured tool-call limit", async () => {
    const provider = new MockLLMProvider([
      {
        content: "Read the BOM.",
        toolCalls: [
          {
            id: "limit-call-1",
            name: STM32_TOOL_NAMES.bomGetItems,
            arguments: {},
          },
        ],
      },
      {
        content: "Read it again.",
        toolCalls: [
          {
            id: "limit-call-2",
            name: STM32_TOOL_NAMES.bomGetItems,
            arguments: {},
          },
        ],
      },
    ]);
    const result = await runStm32AgentDemo({
      provider,
      model: "mock-model",
      approvalHandler: approvalHandler({ status: "approved" }),
      taskId: "stm32-demo-limit",
      maxModelTurns: 4,
      maxToolCalls: 1,
    });

    expect(result.run.status).toBe("limit_reached");
    expect(result.run.stopReason).toBe("max_tool_calls");
    expect(result.snapshot.task.status).toBe("failed");
    expect(
      result.snapshot.toolRuns.reduce<Record<string, number>>(
        (counts, run) => ({
          ...counts,
          [run.status]: (counts[run.status] ?? 0) + 1,
        }),
        {},
      ),
    ).toEqual({
      succeeded: 1,
      skipped: 1,
    });
    expect(
      result.snapshot.toolRuns.find((run) => run.status === "skipped")?.error
        ?.code,
    ).toBe("TOOL_CALL_LIMIT_REACHED");
    expect(provider.consumedResponseCount).toBe(2);
  });
});
