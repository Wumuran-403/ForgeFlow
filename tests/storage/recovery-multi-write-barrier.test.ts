import { describe, expect, it } from "vitest";

import { assertMultiWriteBarrier } from "../../src/storage/recovery-multi-write-barrier-policy.js";
import type { TaskSnapshot, ToolRunRecord } from "../../src/storage/types.js";

function fixture(firstStatus: ToolRunRecord["status"] = "succeeded") {
  const first = { id: "first", taskId: "task", planStepId: "step-1", mode: "write",
    status: firstStatus, originalIndex: 0 } as ToolRunRecord;
  const target = { id: "target", taskId: "task", planStepId: "step-2", mode: "write",
    status: "queued", originalIndex: 1 } as ToolRunRecord;
  const snapshot = {
    task: { id: "task" },
    agentExecutionPlans: [{ id: "plan", taskId: "task", status: "active", purpose: "agent" }],
    planSteps: [
      { id: "step-1", taskId: "task", planId: "plan", kind: "write", stepIndex: 0 },
      { id: "step-2", taskId: "task", planId: "plan", kind: "write", stepIndex: 1 },
    ],
    toolRuns: [first, target],
  } as unknown as TaskSnapshot;
  return { first, target, snapshot };
}

describe("Multi-Write Barrier policy", () => {
  it("admits an ordered Write after a succeeded predecessor", () => {
    const { snapshot, target } = fixture();
    expect(() => assertMultiWriteBarrier(snapshot, target)).not.toThrow();
  });

  it.each(["queued", "running", "unknown", "failed", "skipped"] as const)(
    "blocks a %s predecessor", (status) => {
      const { snapshot, target } = fixture(status);
      expect(() => assertMultiWriteBarrier(snapshot, target)).toThrow();
    },
  );

  it("rejects historical Unknown and ambiguous ordering", () => {
    const { snapshot, target } = fixture();
    const historical = { ...snapshot,
      toolRuns: [...snapshot.toolRuns, { ...snapshot.toolRuns[0]!, id: "historical",
        planStepId: "old-step", status: "unknown" }],
      planSteps: [...snapshot.planSteps, { ...snapshot.planSteps[0]!, id: "old-step", planId: "old-plan" }],
    } as TaskSnapshot;
    expect(() => assertMultiWriteBarrier(historical, target)).toThrow();
    const duplicate = { ...snapshot,
      toolRuns: [...snapshot.toolRuns, { ...snapshot.toolRuns[0]!, id: "duplicate" }],
    } as TaskSnapshot;
    expect(() => assertMultiWriteBarrier(duplicate, target)).toThrow();
  });

  it("rejects a later Write that already started and multiple active plans", () => {
    const { snapshot, first } = fixture();
    const later = { ...snapshot,
      toolRuns: [first, { ...snapshot.toolRuns[1]!, status: "running" }],
    } as TaskSnapshot;
    expect(() => assertMultiWriteBarrier(later, first)).toThrow();
    const ambiguous = { ...snapshot,
      agentExecutionPlans: [...snapshot.agentExecutionPlans, { ...snapshot.agentExecutionPlans[0]!, id: "plan-2" }],
    } as TaskSnapshot;
    expect(() => assertMultiWriteBarrier(ambiguous, snapshot.toolRuns[1]!)).toThrow();
  });
});
