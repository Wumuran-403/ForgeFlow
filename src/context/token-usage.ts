import type {
  ModelRequest,
  ModelResponse,
  ModelUsage,
  TokenUsageAggregate,
} from "../provider/types.js";
import { ModelResponseSchema, TokenUsageAggregateSchema } from "../provider/types.js";

export function estimateTextTokens(value: string): number {
  return value.length === 0 ? 0 : Math.max(1, Math.ceil(value.length / 4));
}

export function estimateJsonTokens(value: unknown): number {
  return estimateTextTokens(JSON.stringify(value));
}

export function normalizeModelResponseUsage(
  request: ModelRequest,
  response: ModelResponse,
): ModelResponse {
  const usage = normalizeUsage(request, response);
  return ModelResponseSchema.parse({ ...response, usage });
}

export function aggregateModelUsage(
  usages: readonly ModelUsage[],
): TokenUsageAggregate {
  const provider = sumUsages(usages.filter((usage) => usage.source === "provider"));
  const estimated = sumUsages(usages.filter((usage) => usage.source === "estimated"));
  const providerCalls = usages.filter((usage) => usage.source === "provider").length;
  const estimatedCalls = usages.filter((usage) => usage.source === "estimated").length;
  const unknownCalls = usages.length - providerCalls - estimatedCalls;
  const source = providerCalls > 0 && estimatedCalls > 0
    ? "mixed"
    : providerCalls > 0
      ? "provider"
      : estimatedCalls > 0
        ? "estimated"
        : "unknown";
  const combined = combineCounts(provider, estimated);
  return TokenUsageAggregateSchema.parse({
    ...combined,
    source,
    provider,
    estimated,
    providerCalls,
    estimatedCalls,
    unknownCalls,
  });
}

function normalizeUsage(
  request: ModelRequest,
  response: ModelResponse,
): ModelUsage {
  const supplied = response.usage;
  if (supplied.source === "provider" && hasAnyCount(supplied)) {
    return withDerivedTotal(supplied);
  }
  if (supplied.source === "estimated" && hasAnyCount(supplied)) {
    return withDerivedTotal(supplied);
  }
  const promptTokens = estimateJsonTokens(request);
  const completionTokens = estimateJsonTokens(response.message);
  return {
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    source: "estimated",
  };
}

function withDerivedTotal(usage: ModelUsage): ModelUsage {
  if (
    usage.totalTokens === undefined &&
    (usage.promptTokens !== undefined || usage.completionTokens !== undefined)
  ) {
    return {
      ...usage,
      totalTokens: (usage.promptTokens ?? 0) + (usage.completionTokens ?? 0),
    };
  }
  return usage;
}

function hasAnyCount(usage: ModelUsage): boolean {
  return usage.promptTokens !== undefined ||
    usage.completionTokens !== undefined ||
    usage.totalTokens !== undefined;
}

function sumUsages(usages: readonly ModelUsage[]): {
  readonly promptTokens?: number;
  readonly completionTokens?: number;
  readonly totalTokens?: number;
} {
  return {
    ...sumKnown(usages, "promptTokens"),
    ...sumKnown(usages, "completionTokens"),
    ...sumKnown(usages, "totalTokens"),
  };
}

function sumKnown(
  usages: readonly ModelUsage[],
  field: "promptTokens" | "completionTokens" | "totalTokens",
): Record<string, number> {
  const values = usages.flatMap((usage) =>
    usage[field] === undefined ? [] : [usage[field]],
  );
  return values.length === 0
    ? {}
    : { [field]: values.reduce((total, value) => total + value, 0) };
}

function combineCounts(
  first: ReturnType<typeof sumUsages>,
  second: ReturnType<typeof sumUsages>,
): ReturnType<typeof sumUsages> {
  return {
    ...combineField(first, second, "promptTokens"),
    ...combineField(first, second, "completionTokens"),
    ...combineField(first, second, "totalTokens"),
  };
}

function combineField(
  first: ReturnType<typeof sumUsages>,
  second: ReturnType<typeof sumUsages>,
  field: "promptTokens" | "completionTokens" | "totalTokens",
): Record<string, number> {
  const values = [first[field], second[field]].filter(
    (value): value is number => value !== undefined,
  );
  return values.length === 0
    ? {}
    : { [field]: values.reduce((total, value) => total + value, 0) };
}
