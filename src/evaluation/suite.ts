import { EvaluationCaseSchema, type EvaluationCase, type EvaluationSuite } from "./types.js";

const cases: EvaluationCase[] = [];

function add(input: EvaluationCase): void {
  cases.push(EvaluationCaseSchema.parse(input));
}

const normalInputs = [
  ["normal-bom", "bom_get_items", {}],
  ["normal-stock-mcu", "inventory_lookup", { partNumber: "STM32F103C8T6", requiredQuantity: 500 }],
  ["normal-stock-cap", "inventory_lookup", { partNumber: "CL10B104KB8NNNC", requiredQuantity: 4_000 }],
  ["normal-stock-resistor", "inventory_lookup", { partNumber: "RC0603FR-0710KL", requiredQuantity: 2_000 }],
  ["normal-spec", "component_get_spec", { partNumber: "STM32F103C8T6", expectedFootprint: "LQFP-48" }],
  ["normal-mcp-stock", "mcp_inventory_inventory_search", { query: "STM32", minimumAvailable: 1, limit: 5 }],
  ["normal-drafts-read", "procurement_get_drafts", {}],
  ["normal-stock-crystal", "inventory_lookup", { partNumber: "X32258MSB4SI", requiredQuantity: 100 }],
  ["normal-spec-no-footprint", "component_get_spec", { partNumber: "STM32F103C8T6" }],
  ["normal-bom-repeat-read", "bom_get_items", {}],
] as const;

for (const [id, tool, argumentsValue] of normalInputs) {
  add({
    id,
    category: "normal",
    title: `Successful ${tool} execution`,
    input: { tool, arguments: argumentsValue },
    expectation: {
      outcome: "succeeded",
      toolCalls: [{ name: tool, arguments: argumentsValue, status: "succeeded" }],
      recoveryEligible: false,
      recoveryMustSucceed: false,
      loopExpected: false,
      mcpExpected: tool.startsWith("mcp_"),
    },
  });
}

for (const [id, tool, argumentsValue] of [
  ["invalid-stock-part", "inventory_lookup", { requiredQuantity: 1 }],
  ["invalid-stock-quantity", "inventory_lookup", { partNumber: "STM32F103C8T6", requiredQuantity: 0 }],
  ["invalid-spec-part", "component_get_spec", { expectedFootprint: "LQFP-48" }],
  ["invalid-bom-extra", "bom_get_items", { unexpected: true }],
  ["invalid-mcp-limit", "mcp_inventory_inventory_search", { query: "STM32", limit: 0 }],
] as const) {
  add({ id, category: "invalid_input", title: `Reject invalid ${tool} input`,
    input: { tool, arguments: argumentsValue },
    expectation: { outcome: "blocked", toolCalls: [], recoveryEligible: false,
      recoveryMustSucceed: false, loopExpected: false, mcpExpected: false } });
}

for (const [id, partNumber, requiredQuantity] of [
  ["shortage-mcu", "STM32F103C8T6", 2_000],
  ["shortage-crystal", "X32258MSB4SI", 2_000],
  ["shortage-cap", "CL10B104KB8NNNC", 30_000],
  ["shortage-resistor", "RC0603FR-0710KL", 9_000],
  ["shortage-unknown", "UNKNOWN-PART", 10],
] as const) {
  const argumentsValue = { partNumber, requiredQuantity };
  add({ id, category: "inventory_shortage", title: `Detect shortage for ${partNumber}`,
    input: { tool: "inventory_lookup", arguments: argumentsValue, requireInsufficient: true },
    expectation: { outcome: "succeeded", toolCalls: [{ name: "inventory_lookup", arguments: argumentsValue, status: "succeeded" }],
      recoveryEligible: false, recoveryMustSucceed: false, loopExpected: false, mcpExpected: false } });
}

for (const [id, input] of [
  ["spec-footprint-mismatch", { tool: "component_get_spec", arguments: { partNumber: "STM32F103C8T6", expectedFootprint: "QFN-48" }, requireMismatch: true }],
  ["spec-unknown-part", { tool: "component_get_spec", arguments: { partNumber: "UNKNOWN" }, requireNotFound: true }],
  ["tool-not-registered", { tool: "missing_tool", arguments: {} }],
  ["tool-execution-error", { tool: "evaluation_failing_read", arguments: { code: "fixture_failure" } }],
  ["write-approval-denied", { tool: "procurement_create_draft", arguments: { items: [{ partNumber: "STM32F103C8T6", quantity: 1, reason: "shortage" }] } }],
] as const) {
  const tool = input.tool;
  const blocked = id === "tool-not-registered" || id === "write-approval-denied";
  add({ id, category: "spec_or_tool_error", title: id.replaceAll("-", " "), input,
    expectation: { outcome: blocked ? "blocked" : id === "tool-execution-error" ? "failed" : "succeeded",
      toolCalls: blocked ? [] : [{ name: tool, arguments: input.arguments, status: id === "tool-execution-error" ? "failed" : "succeeded" }],
      recoveryEligible: false, recoveryMustSucceed: false, loopExpected: false, mcpExpected: false } });
}

for (const evaluationCase of [
  { id: "loop-repeat", outcome: "loop_detected", loopExpected: true, recoveryEligible: false, recoveryMustSucceed: false },
  { id: "loop-short-cycle", outcome: "loop_detected", loopExpected: true, recoveryEligible: false, recoveryMustSucceed: false },
  { id: "recovery-read", outcome: "recovered", loopExpected: false, recoveryEligible: true, recoveryMustSucceed: true },
  { id: "recovery-model-call", outcome: "recovered", loopExpected: false, recoveryEligible: true, recoveryMustSucceed: true },
  { id: "unknown-write-blocked", outcome: "blocked", loopExpected: false, recoveryEligible: true, recoveryMustSucceed: false },
] as const) {
  add({ id: evaluationCase.id, category: "loop_or_recovery", title: evaluationCase.id.replaceAll("-", " "),
    input: { scenario: evaluationCase.id }, expectation: { outcome: evaluationCase.outcome, toolCalls: [],
      recoveryEligible: evaluationCase.recoveryEligible, recoveryMustSucceed: evaluationCase.recoveryMustSucceed,
      loopExpected: evaluationCase.loopExpected, mcpExpected: false } });
}

if (cases.length !== 30 || new Set(cases.map((item) => item.id)).size !== cases.length) {
  throw new Error("Phase 6.1 evaluation suite must contain exactly 30 unique cases.");
}

export const PHASE6_1_EVALUATION_SUITE: EvaluationSuite = Object.freeze({
  version: "phase6.1-v1",
  cases: Object.freeze(cases),
});
