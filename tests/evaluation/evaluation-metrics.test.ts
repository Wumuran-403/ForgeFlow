import { describe, expect, it } from "vitest";

import { calculateMetrics, judgeCase, type EvaluatedCase } from "../../src/evaluation/index.js";
import type { EvaluationCase, EvaluationObservation } from "../../src/evaluation/types.js";

const baseCase: EvaluationCase = {
  id: "metric-case", category: "normal", title: "metric case", input: {},
  expectation: { outcome: "succeeded", toolCalls: [{ name: "inventory_lookup", arguments: { partNumber: "A" }, status: "succeeded" }],
    recoveryEligible: false, recoveryMustSucceed: false, loopExpected: false, mcpExpected: false },
};

function observation(overrides: Partial<EvaluationObservation> = {}): EvaluationObservation {
  return { outcome: "succeeded", toolCalls: [{ name: "inventory_lookup", arguments: { partNumber: "A" }, status: "succeeded", mode: "read", duplicateSideEffect: false, mcp: false }],
    recovery: { eligible: false, succeeded: false, unknownWrite: false }, loopDetected: false,
    approvalBypassed: false, providerTokens: { promptTokens: 10, completionTokens: 2, totalTokens: 12 },
    estimatedTokens: { promptTokens: 3, completionTokens: 1, totalTokens: 4 }, ...overrides };
}

describe("evaluation metrics", () => {
  it("judges canonical arguments structurally and rejects unexpected calls", () => {
    const reordered = observation({ toolCalls: [{ name: "inventory_lookup", arguments: { partNumber: "A" }, status: "succeeded", mode: "read", duplicateSideEffect: false, mcp: false }] });
    expect(judgeCase(baseCase, reordered).passed).toBe(true);
    const extra = observation({ toolCalls: [...reordered.toolCalls, { name: "bom_get_items", arguments: {}, status: "succeeded", mode: "read", duplicateSideEffect: false, mcp: false }] });
    expect(judgeCase(baseCase, extra)).toMatchObject({ passed: false, unexpectedToolCalls: 1 });
  });

  it("separates token sources and never counts unknown write as recovered", () => {
    const recoveryCase: EvaluationCase = { ...baseCase, id: "recovery-case", category: "loop_or_recovery",
      expectation: { outcome: "blocked", toolCalls: [], recoveryEligible: true, recoveryMustSucceed: false, loopExpected: false, mcpExpected: false } };
    const unknown = observation({ outcome: "blocked", toolCalls: [], recovery: { eligible: true, succeeded: true, unknownWrite: true } });
    const results: EvaluatedCase[] = [
      { evaluationCase: baseCase, observation: observation(), verdict: judgeCase(baseCase, observation()), latencyMs: 10 },
      { evaluationCase: recoveryCase, observation: unknown, verdict: judgeCase(recoveryCase, unknown), latencyMs: 30 },
    ];
    const metrics = new Map(calculateMetrics(results).metrics.map((metric) => [metric.name, metric]));
    expect(metrics.get("provider_token_usage")?.value).toBe(24);
    expect(metrics.get("estimated_token_usage")?.value).toBe(8);
    expect(metrics.get("recovery_success_rate")?.value).toBe(0);
    expect(metrics.get("average_task_latency_ms")?.value).toBe(20);
    expect(metrics.get("p95_task_latency_ms")?.value).toBe(30);
  });
});
