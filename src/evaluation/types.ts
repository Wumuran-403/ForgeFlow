import { z } from "zod";

import { JsonValueSchema } from "../storage/types.js";

export const EvaluationCategorySchema = z.enum([
  "normal",
  "invalid_input",
  "inventory_shortage",
  "spec_or_tool_error",
  "loop_or_recovery",
]);

export const EvaluationToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: JsonValueSchema,
  status: z.enum(["succeeded", "failed", "rejected", "unknown", "skipped"]),
  mode: z.enum(["read", "write"]),
  duplicateSideEffect: z.boolean().default(false),
  mcp: z.boolean().default(false),
}).strict();

export const ExpectedToolCallSchema = z.object({
  name: z.string().min(1),
  arguments: JsonValueSchema,
  status: z.enum(["succeeded", "failed", "rejected", "unknown", "skipped"]),
}).strict();

export const EvaluationExpectationSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "blocked", "recovered", "loop_detected"]),
  toolCalls: z.array(ExpectedToolCallSchema),
  recoveryEligible: z.boolean().default(false),
  recoveryMustSucceed: z.boolean().default(false),
  loopExpected: z.boolean().default(false),
  mcpExpected: z.boolean().default(false),
}).strict();

export const EvaluationCaseSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  category: EvaluationCategorySchema,
  title: z.string().min(1),
  input: JsonValueSchema,
  expectation: EvaluationExpectationSchema,
}).strict();

const TokenCountsSchema = z.object({
  promptTokens: z.number().int().nonnegative(),
  completionTokens: z.number().int().nonnegative(),
  totalTokens: z.number().int().nonnegative(),
}).strict();

export const EvaluationObservationSchema = z.object({
  outcome: z.enum(["succeeded", "failed", "blocked", "recovered", "loop_detected"]),
  toolCalls: z.array(EvaluationToolCallSchema),
  recovery: z.object({
    eligible: z.boolean(),
    succeeded: z.boolean(),
    unknownWrite: z.boolean(),
  }).strict(),
  loopDetected: z.boolean(),
  approvalBypassed: z.boolean(),
  providerTokens: TokenCountsSchema,
  estimatedTokens: TokenCountsSchema,
}).strict();

export const EvaluationVerdictSchema = z.object({
  passed: z.boolean(),
  reasons: z.array(z.string()),
  correctToolCalls: z.number().int().nonnegative(),
  expectedToolCalls: z.number().int().nonnegative(),
  unexpectedToolCalls: z.number().int().nonnegative(),
}).strict();

export const EvaluationMetricSchema = z.object({
  name: z.string().min(1),
  value: z.number().finite(),
  numerator: z.number().finite().nullable(),
  denominator: z.number().finite().nullable(),
  unit: z.enum(["ratio", "milliseconds", "tokens", "count"]),
  exclusions: z.number().int().nonnegative(),
  definition: z.string().min(1),
}).strict();

export const EvaluationAggregateSchema = z.object({
  caseCount: z.number().int().positive(),
  passedCount: z.number().int().nonnegative(),
  failedCount: z.number().int().nonnegative(),
  metrics: z.array(EvaluationMetricSchema),
}).strict();

export type EvaluationCategory = z.infer<typeof EvaluationCategorySchema>;
export type EvaluationCase = z.infer<typeof EvaluationCaseSchema>;
export type EvaluationObservation = z.infer<typeof EvaluationObservationSchema>;
export type EvaluationVerdict = z.infer<typeof EvaluationVerdictSchema>;
export type EvaluationMetric = z.infer<typeof EvaluationMetricSchema>;
export type EvaluationAggregate = z.infer<typeof EvaluationAggregateSchema>;

export interface EvaluationSuite {
  readonly version: string;
  readonly cases: readonly EvaluationCase[];
}

export interface EvaluationExecutor {
  execute(evaluationCase: EvaluationCase): Promise<EvaluationObservation>;
}
