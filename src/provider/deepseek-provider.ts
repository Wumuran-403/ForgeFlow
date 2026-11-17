import { z } from "zod";

import { AppError } from "../shared/errors.js";
import { ToolNameSchema } from "../shared/tool-name.js";
import {
  ModelResponseSchema,
  type GenerateOptions,
  type LLMProvider,
  type ModelRequest,
  type ModelResponse,
  type ToolCall,
} from "./types.js";

const DeepSeekProviderOptionsSchema = z
  .object({
    apiKey: z.string().trim().min(1),
    baseUrl: z.url(),
    timeoutMs: z.number().int().positive().default(60_000),
    maxRetries: z.number().int().nonnegative().default(2),
  })
  .strict();

const ChatCompletionResponseSchema = z
  .object({
    id: z.string().optional(),
    choices: z
      .array(
        z.object({
          finish_reason: z.string().nullable().optional(),
          message: z.object({
            content: z.string().nullable().optional(),
            tool_calls: z
              .array(
                z.object({
                  id: z.string().min(1),
                  type: z.literal("function"),
                  function: z.object({
                    name: z.string().min(1),
                    arguments: z.unknown(),
                  }),
                }),
              )
              .optional(),
          }),
        }),
      )
      .min(1),
    usage: z
      .object({
        prompt_tokens: z.number().int().nonnegative().optional(),
        completion_tokens: z.number().int().nonnegative().optional(),
        total_tokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  })
  .passthrough();

export type DeepSeekFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface DeepSeekProviderOptions {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly fetch?: DeepSeekFetch;
}

export class DeepSeekProvider implements LLMProvider {
  private readonly apiKey: string;
  private readonly endpoint: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fetchImpl: DeepSeekFetch;

  constructor(options: DeepSeekProviderOptions) {
    const parsed = DeepSeekProviderOptionsSchema.parse({
      apiKey: options.apiKey,
      baseUrl: options.baseUrl,
      timeoutMs: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
    this.apiKey = parsed.apiKey;
    this.endpoint = `${parsed.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    this.timeoutMs = parsed.timeoutMs;
    this.maxRetries = parsed.maxRetries;
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async generate(
    request: ModelRequest,
    options: GenerateOptions = {},
  ): Promise<ModelResponse> {
    for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
      try {
        return await this.generateOnce(request, options);
      } catch (error) {
        if (
          !shouldRetry(error) ||
          attempt === this.maxRetries ||
          options.signal?.aborted === true
        ) {
          throw error;
        }
        await waitForRetry(attempt, options.signal);
      }
    }
    throw providerError("DEEPSEEK_REQUEST_FAILED", "The provider request failed.");
  }

  private async generateOnce(
    request: ModelRequest,
    options: GenerateOptions,
  ): Promise<ModelResponse> {
    const timeoutController = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, this.timeoutMs);
    const signal =
      options.signal === undefined
        ? timeoutController.signal
        : AbortSignal.any([options.signal, timeoutController.signal]);

    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(toChatCompletionRequest(request)),
        signal,
      });

      if (!response.ok) {
        throw providerError(
          "DEEPSEEK_HTTP_ERROR",
          `The provider returned HTTP ${response.status}.`,
          response.status === 429 ? 429 : 502,
          response.status === 429 || response.status >= 500,
        );
      }

      let raw: unknown;
      try {
        raw = await response.json();
      } catch {
        throw providerError(
          "DEEPSEEK_RESPONSE_INVALID",
          "The provider returned invalid JSON.",
          502,
        );
      }
      const parsed = ChatCompletionResponseSchema.safeParse(raw);
      if (!parsed.success) {
        throw providerError(
          "DEEPSEEK_RESPONSE_INVALID",
          "The provider response did not match the chat completion contract.",
          502,
        );
      }

      const choice = parsed.data.choices[0]!;
      const toolCalls = parseToolCalls(choice.message.tool_calls ?? []);
      const usage = parsed.data.usage;
      const hasProviderUsage = usage !== undefined &&
        (usage.prompt_tokens !== undefined ||
          usage.completion_tokens !== undefined ||
          usage.total_tokens !== undefined);
      const modelResponse = ModelResponseSchema.safeParse({
        message: {
          role: "assistant",
          content: choice.message.content ?? "",
          ...(toolCalls.length === 0 ? {} : { toolCalls }),
        },
        usage: {
          ...(usage?.prompt_tokens === undefined
            ? {}
            : { promptTokens: usage.prompt_tokens }),
          ...(usage?.completion_tokens === undefined
            ? {}
            : { completionTokens: usage.completion_tokens }),
          ...(usage?.total_tokens === undefined
            ? {}
            : { totalTokens: usage.total_tokens }),
          source: hasProviderUsage ? "provider" : "unknown",
        },
        ...(choice.finish_reason === null ||
        choice.finish_reason === undefined
          ? {}
          : { finishReason: choice.finish_reason }),
        ...(parsed.data.id === undefined
          ? {}
          : { requestId: parsed.data.id }),
      });
      if (!modelResponse.success) {
        throw providerError(
          "DEEPSEEK_RESPONSE_INVALID",
          "The provider response could not be represented as a model response.",
          502,
        );
      }
      return modelResponse.data;
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      if (options.signal?.aborted === true) {
        throw providerError(
          "DEEPSEEK_REQUEST_ABORTED",
          "The provider request was aborted.",
          499,
        );
      }
      if (timedOut) {
        throw providerError(
          "DEEPSEEK_REQUEST_TIMEOUT",
          "The provider request timed out.",
          504,
        );
      }
      throw providerError(
        "DEEPSEEK_NETWORK_ERROR",
        "The provider could not be reached.",
        502,
        true,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

function toChatCompletionRequest(request: ModelRequest): Record<string, unknown> {
  const messages = request.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "tool",
        tool_call_id: message.toolCallId,
        content: message.content,
      };
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      return {
        role: "assistant",
        content: message.content,
        tool_calls: message.toolCalls.map((toolCall) => ({
          id: toolCall.id,
          type: "function",
          function: {
            name: toolCall.name,
            arguments:
              typeof toolCall.arguments === "string"
                ? toolCall.arguments
                : JSON.stringify(toolCall.arguments),
          },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });

  return {
    model: request.model,
    messages,
    ...(request.temperature === undefined
      ? {}
      : { temperature: request.temperature }),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: "function",
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            },
          })),
          tool_choice: "auto",
        }),
  };
}

function parseToolCalls(
  toolCalls: readonly {
    readonly id: string;
    readonly function: {
      readonly name: string;
      readonly arguments: unknown;
    };
  }[],
): readonly ToolCall[] {
  return toolCalls.map((toolCall) => {
    const parsedName = ToolNameSchema.safeParse(toolCall.function.name);
    if (!parsedName.success) {
      throw providerError(
        "DEEPSEEK_TOOL_CALL_INVALID",
        "A provider tool call contained an invalid tool name.",
        502,
      );
    }
    return {
      id: toolCall.id,
      name: parsedName.data,
      arguments: parseToolArguments(toolCall.function.arguments),
    };
  });
}

function parseToolArguments(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value !== "string") {
    throw providerError(
      "DEEPSEEK_TOOL_ARGUMENTS_INVALID",
      "A provider tool call contained invalid arguments.",
      502,
    );
  }
  if (value.trim() === "") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw providerError(
      "DEEPSEEK_TOOL_ARGUMENTS_INVALID",
      "A provider tool call contained invalid JSON arguments.",
      502,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw providerError(
      "DEEPSEEK_TOOL_ARGUMENTS_INVALID",
      "Provider tool arguments must be a JSON object.",
      502,
    );
  }
  return parsed as Record<string, unknown>;
}

function shouldRetry(error: unknown): boolean {
  return (
    error instanceof AppError &&
    ["DEEPSEEK_NETWORK_ERROR", "DEEPSEEK_HTTP_ERROR"].includes(error.code) &&
    error.details.some((detail) => detail.path === "retryable")
  );
}

async function waitForRetry(
  attempt: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  const delayMs = Math.min(250 * 2 ** attempt, 2_000);
  await new Promise<void>((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(
        providerError(
          "DEEPSEEK_REQUEST_ABORTED",
          "The provider request was aborted.",
          499,
        ),
      );
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, delayMs);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(
        providerError(
          "DEEPSEEK_REQUEST_ABORTED",
          "The provider request was aborted.",
          499,
        ),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function providerError(
  code: string,
  message: string,
  statusCode = 502,
  retryable = false,
): AppError {
  return new AppError({
    code,
    message,
    statusCode,
    details: retryable
      ? [{ path: "retryable", message: "transient provider failure" }]
      : [],
  });
}
