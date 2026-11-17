import { describe, expect, it } from "vitest";

import { deriveBomSummary } from "../../web/src/lib/bom-summary.js";
import type { TaskDetail } from "../../web/src/lib/types.js";

function detail(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    workflowId: "stm32-bom-recovery",
    toolRuns: [
      { toolName: "bom_get_items", status: "succeeded", output: { lines: [
        { partNumber: "STM32F103C8T6", designator: "U1" },
        { partNumber: "X32258MSB4SI", designator: "Y1" },
      ] } },
      { toolName: "inventory_lookup", status: "succeeded", output: { partNumber: "STM32F103C8T6", requiredQuantity: 2000, available: 1050, leadTimeDays: 7 } },
      { toolName: "inventory_lookup", status: "succeeded", output: { partNumber: "X32258MSB4SI", requiredQuantity: 2000, available: 400, leadTimeDays: 12 } },
      { toolName: "procurement_create_draft", status: "succeeded", output: { draft: { id: "draft-1" } } },
      { toolName: "procurement_get_drafts", status: "succeeded", output: { drafts: [{ id: "draft-1" }] } },
    ],
    approvals: [],
    ...overrides,
  } as TaskDetail;
}

describe("STM32 business result summary", () => {
  it("derives shortages and a confirmed draft from persisted tool results", () => {
    const result = deriveBomSummary(detail());
    expect(result?.complete).toBe(true);
    expect(result?.shortages.map((item) => [item.partNumber, item.shortage])).toEqual([
      ["STM32F103C8T6", 950], ["X32258MSB4SI", 1600],
    ]);
    expect(result?.draft).toBe("created");
    expect(result?.readbackConfirmed).toBe(true);
  });

  it("does not claim the full inventory was checked from partial or malformed outputs", () => {
    const task = detail();
    const result = deriveBomSummary(detail({ toolRuns: task.toolRuns.filter((run) => run.toolName !== "inventory_lookup" || (run.output as { partNumber?: string }).partNumber !== "X32258MSB4SI") }));
    expect(result?.complete).toBe(false);
    expect(result?.checkedCount).toBe(1);
  });

  it("keeps unknown and rejected writes distinct from created drafts", () => {
    const task = detail();
    const reads = task.toolRuns.filter((run) => !run.toolName.startsWith("procurement_"));
    expect(deriveBomSummary(detail({ toolRuns: [...reads, { ...task.toolRuns[3]!, status: "unknown", output: null }] }))?.draft).toBe("unknown");
    expect(deriveBomSummary(detail({
      toolRuns: [...reads, { ...task.toolRuns[3]!, status: "skipped", output: null }],
      approvals: [{ toolName: "procurement_create_draft", status: "rejected" }],
    } as Partial<TaskDetail>))?.draft).toBe("rejected");
  });

  it("shows no shortage only after every BOM part has a valid inventory result", () => {
    const task = detail();
    const result = deriveBomSummary(detail({ toolRuns: task.toolRuns.map((run) => run.toolName === "inventory_lookup" ? { ...run, output: { ...(run.output as object), available: 3000 } } : run) }));
    expect(result?.complete).toBe(true);
    expect(result?.shortages).toEqual([]);
  });
});
