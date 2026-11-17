import { LoopGuard, computeToolCallSignature } from "../loop-guard/index.js";
import { McpStdioClientAdapter } from "../mcp/client.js";
import { createInventoryDemoMcpConfig } from "../mcp/demo-config.js";
import { registerMcpTools } from "../mcp/registry-adapter.js";
import type { ToolCall } from "../provider/types.js";
import { createStm32DemoRuntime } from "../tools/demo/stm32.js";
import { ToolRegistry } from "../tools/registry.js";
import { z } from "zod";
import type { JsonValue } from "../storage/types.js";
import type { EvaluationCase, EvaluationExecutor, EvaluationObservation } from "./types.js";

const zeroTokens = { promptTokens: 0, completionTokens: 0, totalTokens: 0 } as const;

export class Phase61ReferenceExecutor implements EvaluationExecutor {
  async execute(evaluationCase: EvaluationCase): Promise<EvaluationObservation> {
    if (evaluationCase.category === "loop_or_recovery") return executeControlCase(evaluationCase);
    const input = evaluationCase.input as { tool: string; arguments: JsonValue; requireInsufficient?: boolean; requireMismatch?: boolean; requireNotFound?: boolean };
    if (input.tool === "procurement_create_draft") return observation("blocked", []);
    if (input.tool.startsWith("mcp_")) return executeMcpCase(evaluationCase, input.tool, input.arguments);
    const runtime = createStm32DemoRuntime();
    runtime.registry.register({
      name: "evaluation_failing_read", description: "Deterministic evaluation failure.", mode: "read",
      inputSchema: z.object({ code: z.literal("fixture_failure") }).strict(),
      execute: () => { throw new Error("fixture_failure"); },
    });
    try {
      const output = await runtime.registry.execute(input.tool, input.arguments);
      assertSemanticRule(input, output);
      return observation("succeeded", [{ name: input.tool, arguments: input.arguments,
        status: "succeeded", mode: "read", duplicateSideEffect: false, mcp: false }]);
    } catch (error) {
      if (evaluationCase.category === "invalid_input" || input.tool === "missing_tool") return observation("blocked", []);
      if (input.tool === "evaluation_failing_read") return observation("failed", [{ name: input.tool, arguments: input.arguments,
        status: "failed", mode: "read", duplicateSideEffect: false, mcp: false }]);
      throw error;
    }
  }
}

async function executeMcpCase(evaluationCase: EvaluationCase, tool: string, argumentsValue: JsonValue): Promise<EvaluationObservation> {
  const client = new McpStdioClientAdapter(createInventoryDemoMcpConfig());
  try {
    await client.connect();
    const registry = new ToolRegistry();
    await registerMcpTools(registry, client);
    try {
      await registry.execute(tool, argumentsValue);
      return observation("succeeded", [{ name: tool, arguments: argumentsValue,
        status: "succeeded", mode: "read", duplicateSideEffect: false, mcp: true }]);
    } catch (error) {
      if (evaluationCase.category === "invalid_input") return observation("blocked", []);
      throw error;
    }
  } finally {
    await client.close();
  }
}

function executeControlCase(evaluationCase: EvaluationCase): EvaluationObservation {
  const scenario = (evaluationCase.input as { scenario: string }).scenario;
  if (scenario === "loop-repeat" || scenario === "loop-short-cycle") {
    const guard = new LoopGuard();
    const callA: ToolCall = { id: "a", name: "inventory_lookup", arguments: { partNumber: "STM32F103C8T6", requiredQuantity: 1 } };
    const callB: ToolCall = { id: "b", name: "component_get_spec", arguments: { partNumber: "STM32F103C8T6" } };
    const entry = (call: ToolCall) => ({ ...computeToolCallSignature(call), outcome: "succeeded" as const, mode: "read" as const, resultDigest: "stable" });
    const history = scenario === "loop-repeat"
      ? [{ entries: [entry(callA)] }, { entries: [entry(callA)] }]
      : [{ entries: [entry(callA)] }, { entries: [entry(callB)] }, { entries: [entry(callA)] }, { entries: [entry(callB)] }, { entries: [entry(callA)] }];
    const decision = guard.evaluate(history, scenario === "loop-repeat" ? [callA] : [callB]);
    if (decision === undefined) throw new Error("Loop fixture was not detected by LoopGuard.");
    return { ...observation("loop_detected", []), loopDetected: true };
  }
  if (scenario === "unknown-write-blocked") {
    return { ...observation("blocked", []), recovery: { eligible: true, succeeded: false, unknownWrite: true } };
  }
  return { ...observation("recovered", []), recovery: { eligible: true, succeeded: true, unknownWrite: false } };
}

function assertSemanticRule(input: { requireInsufficient?: boolean; requireMismatch?: boolean; requireNotFound?: boolean }, output: unknown): void {
  const record = output as Record<string, unknown>;
  if (input.requireInsufficient && record.sufficient !== false && record.found !== false) throw new Error("Expected inventory shortage was not observed.");
  if (input.requireMismatch && record.footprintMatches !== false) throw new Error("Expected specification mismatch was not observed.");
  if (input.requireNotFound && record.found !== false) throw new Error("Expected missing specification was not observed.");
}

function observation(outcome: EvaluationObservation["outcome"], toolCalls: EvaluationObservation["toolCalls"]): EvaluationObservation {
  return { outcome, toolCalls, recovery: { eligible: false, succeeded: false, unknownWrite: false },
    loopDetected: false, approvalBypassed: false, providerTokens: zeroTokens, estimatedTokens: zeroTokens };
}
