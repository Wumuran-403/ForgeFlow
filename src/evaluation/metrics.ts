import { canonicalJson } from "../shared/canonical-json.js";
import type {
  EvaluationAggregate,
  EvaluationCase,
  EvaluationMetric,
  EvaluationObservation,
  EvaluationVerdict,
} from "./types.js";

export interface EvaluatedCase {
  readonly evaluationCase: EvaluationCase;
  readonly observation: EvaluationObservation | null;
  readonly verdict: EvaluationVerdict;
  readonly latencyMs: number;
}

export function judgeCase(
  evaluationCase: EvaluationCase,
  observation: EvaluationObservation,
): EvaluationVerdict {
  const unmatchedActual = [...observation.toolCalls];
  let correctToolCalls = 0;
  for (const expected of evaluationCase.expectation.toolCalls) {
    const index = unmatchedActual.findIndex((actual) =>
      actual.name === expected.name && actual.status === expected.status &&
      canonicalJson(actual.arguments) === canonicalJson(expected.arguments));
    if (index >= 0) {
      correctToolCalls += 1;
      unmatchedActual.splice(index, 1);
    }
  }
  const reasons: string[] = [];
  if (observation.outcome !== evaluationCase.expectation.outcome) reasons.push("outcome_mismatch");
  if (correctToolCalls !== evaluationCase.expectation.toolCalls.length) reasons.push("required_tool_call_mismatch");
  if (unmatchedActual.length > 0) reasons.push("unexpected_tool_call");
  if (observation.loopDetected !== evaluationCase.expectation.loopExpected) reasons.push("loop_detection_mismatch");
  if (evaluationCase.expectation.recoveryMustSucceed &&
      (!observation.recovery.succeeded || observation.recovery.unknownWrite)) reasons.push("recovery_not_successful");
  if (observation.approvalBypassed) reasons.push("write_approval_bypassed");
  return {
    passed: reasons.length === 0,
    reasons,
    correctToolCalls,
    expectedToolCalls: evaluationCase.expectation.toolCalls.length,
    unexpectedToolCalls: unmatchedActual.length,
  };
}

function ratioMetric(name: string, numerator: number, denominator: number, exclusions: number, definition: string): EvaluationMetric {
  return { name, value: denominator === 0 ? 0 : numerator / denominator,
    numerator, denominator, unit: "ratio", exclusions, definition };
}

function percentile(values: readonly number[], percentileValue: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(percentileValue * sorted.length) - 1);
  return sorted[index] ?? 0;
}

export function calculateMetrics(results: readonly EvaluatedCase[]): EvaluationAggregate {
  const withObservations = results.filter((item): item is EvaluatedCase & { observation: EvaluationObservation } => item.observation !== null);
  const passedCount = results.filter((item) => item.verdict.passed).length;
  const expectedCalls = results.reduce((total, item) => total + item.verdict.expectedToolCalls, 0);
  const unexpectedCalls = results.reduce((total, item) => total + item.verdict.unexpectedToolCalls, 0);
  const correctCalls = results.reduce((total, item) => total + item.verdict.correctToolCalls, 0);
  const recoveryCases = withObservations.filter((item) => item.evaluationCase.expectation.recoveryEligible);
  const recovered = recoveryCases.filter((item) => item.observation.recovery.succeeded && !item.observation.recovery.unknownWrite).length;
  const writeExecutions = withObservations.flatMap((item) => item.observation.toolCalls)
    .filter((call) => call.mode === "write" && call.status === "succeeded");
  const duplicateWrites = writeExecutions.filter((call) => call.duplicateSideEffect).length;
  const latencies = results.map((item) => item.latencyMs);
  const loopCases = withObservations.filter((item) => item.evaluationCase.expectation.loopExpected);
  const loopHits = loopCases.filter((item) => item.observation.loopDetected).length;
  const mcpCalls = withObservations.flatMap((item) => item.observation.toolCalls).filter((call) => call.mcp);
  const mcpSuccesses = mcpCalls.filter((call) => call.status === "succeeded").length;
  const providerTokens = withObservations.reduce((total, item) => total + item.observation.providerTokens.totalTokens, 0);
  const estimatedTokens = withObservations.reduce((total, item) => total + item.observation.estimatedTokens.totalTokens, 0);
  const averageLatency = latencies.length === 0 ? 0 : latencies.reduce((sum, value) => sum + value, 0) / latencies.length;
  const metrics: EvaluationMetric[] = [
    ratioMetric("task_success_rate", passedCount, results.length, 0, "Passed evaluation cases / all cases in the completed run."),
    ratioMetric("tool_call_accuracy", correctCalls, expectedCalls + unexpectedCalls, 0, "Correct expected name+canonical-arguments+status matches / (expected calls + unexpected calls)."),
    ratioMetric("recovery_success_rate", recovered, recoveryCases.length, results.length - recoveryCases.length, "Recovered eligible cases excluding unknown writes / recovery-eligible cases."),
    ratioMetric("duplicate_execution_rate", duplicateWrites, writeExecutions.length, 0, "Observed duplicate succeeded write side effects / succeeded write executions; unknown writes are excluded."),
    { name: "average_task_latency_ms", value: averageLatency, numerator: latencies.reduce((sum, value) => sum + value, 0), denominator: latencies.length, unit: "milliseconds", exclusions: 0, definition: "Mean runner-observed case latency for all cases." },
    { name: "p50_task_latency_ms", value: percentile(latencies, 0.5), numerator: null, denominator: latencies.length, unit: "milliseconds", exclusions: 0, definition: "Nearest-rank P50 of runner-observed case latency." },
    { name: "p95_task_latency_ms", value: percentile(latencies, 0.95), numerator: null, denominator: latencies.length, unit: "milliseconds", exclusions: 0, definition: "Nearest-rank P95 of runner-observed case latency." },
    { name: "provider_token_usage", value: providerTokens, numerator: providerTokens, denominator: withObservations.length, unit: "tokens", exclusions: results.length - withObservations.length, definition: "Sum of Provider-reported total tokens only." },
    { name: "estimated_token_usage", value: estimatedTokens, numerator: estimatedTokens, denominator: withObservations.length, unit: "tokens", exclusions: results.length - withObservations.length, definition: "Sum of locally estimated total tokens only; never billed usage." },
    ratioMetric("loop_detection_rate", loopHits, loopCases.length, results.length - loopCases.length, "Expected loop cases with persisted-equivalent detection / expected loop cases."),
    ratioMetric("mcp_tool_execution_success_rate", mcpSuccesses, mcpCalls.length, results.length - withObservations.filter((item) => item.evaluationCase.expectation.mcpExpected).length, "Succeeded MCP tool executions / attempted MCP tool executions."),
  ];
  return { caseCount: results.length, passedCount, failedCount: results.length - passedCount, metrics };
}
