import { z } from "zod";

import {
  ModelRequestSchema,
  type AgentMessage,
  type ModelRequest,
  type ModelToolDefinition,
} from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import { estimateJsonTokens, estimateTextTokens } from "./token-usage.js";

export const ContextManagerOptionsSchema = z
  .object({
    maxContextTokens: z.number().int().positive().default(16_384),
    reservedCompletionTokens: z.number().int().nonnegative().default(2_048),
    maxToolResultTokens: z.number().int().min(64).default(1_024),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.reservedCompletionTokens >= value.maxContextTokens) {
      context.addIssue({
        code: "custom",
        path: ["reservedCompletionTokens"],
        message: "Reserved completion tokens must be below the context limit.",
      });
    }
  });

export type ContextManagerOptions = z.input<typeof ContextManagerOptionsSchema>;

export interface ContextBuildInput {
  readonly model: string;
  readonly messages: readonly AgentMessage[];
  readonly tools: readonly ModelToolDefinition[];
  readonly temperature?: number;
}

export interface ContextBuildResult {
  readonly request: ModelRequest;
  readonly inputTokenBudget: number;
  readonly estimatedPromptTokens: number;
  readonly omittedMessages: number;
  readonly truncatedToolResults: number;
}

interface MessageUnit {
  readonly startIndex: number;
  readonly messages: readonly AgentMessage[];
  readonly isToolExchange: boolean;
}

export class ContextBudgetExceededError extends AppError {
  constructor(message: string) {
    super({
      code: "CONTEXT_BUDGET_EXCEEDED",
      message,
      statusCode: 409,
      details: [],
    });
  }
}

export class ContextManager {
  readonly options: z.output<typeof ContextManagerOptionsSchema>;

  constructor(options: ContextManagerOptions = {}) {
    this.options = ContextManagerOptionsSchema.parse(options);
  }

  build(input: ContextBuildInput): ContextBuildResult {
    const inputTokenBudget =
      this.options.maxContextTokens - this.options.reservedCompletionTokens;
    const compressed = input.messages.map((message) =>
      message.role === "tool"
        ? compressToolMessage(message, this.options.maxToolResultTokens)
        : structuredClone(message),
    );
    const truncatedToolResults = compressed.filter((message, index) =>
      message.role === "tool" &&
      message.content !== input.messages[index]?.content,
    ).length;
    const requiredIndexes = new Set<number>();
    compressed.forEach((message, index) => {
      if (message.role === "system") requiredIndexes.add(index);
    });
    const latestUserIndex = compressed.findLastIndex((message) => message.role === "user");
    if (latestUserIndex >= 0) requiredIndexes.add(latestUserIndex);

    const units = buildMessageUnits(compressed, requiredIndexes);
    const latestToolUnit = units.findLast((unit) => unit.isToolExchange);
    const selected = new Set<number>(requiredIndexes);
    if (latestToolUnit !== undefined) {
      for (let offset = 0; offset < latestToolUnit.messages.length; offset += 1) {
        selected.add(latestToolUnit.startIndex + offset);
      }
    }

    let request = createRequest(input, compressed, selected);
    let estimatedPromptTokens = estimateJsonTokens(request);
    if (estimatedPromptTokens > inputTokenBudget) {
      throw new ContextBudgetExceededError(
        "The system prompt, current task, tools, and latest tool exchange exceed the context budget.",
      );
    }

    for (const unit of [...units].reverse()) {
      if (unit === latestToolUnit) continue;
      const indexes = unit.messages.map((_message, offset) => unit.startIndex + offset);
      if (indexes.some((index) => selected.has(index))) continue;
      const candidate = new Set(selected);
      indexes.forEach((index) => candidate.add(index));
      const candidateRequest = createRequest(input, compressed, candidate);
      const candidateTokens = estimateJsonTokens(candidateRequest);
      if (candidateTokens <= inputTokenBudget) {
        selected.clear();
        candidate.forEach((index) => selected.add(index));
        request = candidateRequest;
        estimatedPromptTokens = candidateTokens;
      }
    }

    assertToolAssociations(request.messages);
    return {
      request,
      inputTokenBudget,
      estimatedPromptTokens,
      omittedMessages: input.messages.length - request.messages.length,
      truncatedToolResults,
    };
  }
}

function createRequest(
  input: ContextBuildInput,
  messages: readonly AgentMessage[],
  selected: ReadonlySet<number>,
): ModelRequest {
  return ModelRequestSchema.parse({
    model: input.model,
    messages: messages.filter((_message, index) => selected.has(index)),
    tools: input.tools,
    ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
  });
}

function buildMessageUnits(
  messages: readonly AgentMessage[],
  requiredIndexes: ReadonlySet<number>,
): readonly MessageUnit[] {
  const units: MessageUnit[] = [];
  for (let index = 0; index < messages.length; index += 1) {
    if (requiredIndexes.has(index)) continue;
    const message = messages[index]!;
    if (message.role === "tool") continue;
    if (message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0) {
      const expected = new Set(message.toolCalls?.map((call) => call.id));
      const exchange: AgentMessage[] = [message];
      let cursor = index + 1;
      while (cursor < messages.length) {
        const next = messages[cursor]!;
        if (next.role !== "tool" || !expected.has(next.toolCallId)) break;
        exchange.push(next);
        cursor += 1;
      }
      units.push({ startIndex: index, messages: exchange, isToolExchange: true });
      index = cursor - 1;
      continue;
    }
    units.push({ startIndex: index, messages: [message], isToolExchange: false });
  }
  return units;
}

function compressToolMessage(
  message: Extract<AgentMessage, { role: "tool" }>,
  maxTokens: number,
): AgentMessage {
  if (estimateTextTokens(message.content) <= maxTokens) {
    return structuredClone(message);
  }
  const originalCharacters = message.content.length;
  const maxCharacters = maxTokens * 4;
  let parsed: unknown;
  try {
    parsed = JSON.parse(message.content) as unknown;
  } catch {
    parsed = undefined;
  }
  const essential = extractEssentialFields(parsed);
  const base = {
    ...essential,
    _forgeflowContext: {
      truncated: true,
      originalCharacters,
      originalEstimatedTokens: estimateTextTokens(message.content),
      notice: "TRUNCATED_CONTEXT_ONLY; complete ToolRun result is persisted.",
    },
  };
  const emptyPreview = JSON.stringify({ ...base, outputPreview: "" });
  const previewCharacters = Math.max(0, maxCharacters - emptyPreview.length);
  let content = JSON.stringify({
    ...base,
    outputPreview: message.content.slice(0, previewCharacters),
  });
  if (content.length > maxCharacters) {
    content = JSON.stringify({
      _forgeflowContext: {
        truncated: true,
        originalCharacters,
        notice: "TRUNCATED_CONTEXT_ONLY; complete ToolRun result is persisted.",
      },
    });
  }
  return {
    role: "tool",
    toolCallId: message.toolCallId,
    content,
  };
}

function extractEssentialFields(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const record = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const key of ["toolCallId", "toolName", "status"]) {
    if (typeof record[key] === "string") result[key] = record[key].slice(0, 96);
  }
  if (typeof record.error === "object" && record.error !== null) {
    const error = record.error as Record<string, unknown>;
    result.error = {
      ...(typeof error.code === "string" ? { code: error.code.slice(0, 96) } : {}),
      ...(typeof error.message === "string" ? { message: error.message.slice(0, 160) } : {}),
    };
  }
  return result;
}

function assertToolAssociations(messages: readonly AgentMessage[]): void {
  const available = new Set<string>();
  for (const message of messages) {
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) available.add(call.id);
    }
    if (message.role === "tool" && !available.has(message.toolCallId)) {
      throw new ContextBudgetExceededError(
        "Context selection would orphan a Tool Result from its Assistant ToolCall.",
      );
    }
  }
}
