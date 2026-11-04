import { randomUUID } from "node:crypto";

import { z } from "zod";

import { AppError } from "../shared/errors.js";
import type {
  ScheduledToolResult,
  TaskScheduler,
} from "../scheduler/index.js";
import {
  ToolExecutionError,
  ToolInputValidationError,
  ToolNotFoundError,
} from "../tools/errors.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  ModelResponseSchema,
  type AgentMessage,
  type LLMProvider,
  type ModelToolDefinition,
  type ToolCall,
} from "../provider/types.js";
import {
  AgentLimitsSchema,
  AgentRunInputSchema,
  type AgentLimits,
  type AgentRunInput,
  type AgentRunResult,
  type AgentToolError,
  type AgentToolResult,
} from "./types.js";

const DEFAULT_SYSTEM_PROMPT =
  "You are ForgeFlow, a careful engineering agent. Use tools when needed and report only supported conclusions.";

export interface AgentRunnerOptions {
  provider: LLMProvider;
  registry: ToolRegistry;
  model: string;
  maxModelTurns?: number;
  /** @deprecated Use maxModelTurns. */
  maxIterations?: number;
  maxToolCalls?: number;
  systemPrompt?: string;
  taskIdFactory?: () => string;
  scheduler?: TaskScheduler;
}

export interface AgentRunOptions {
  signal?: AbortSignal;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function toAgentToolError(error: unknown): AgentToolError {
  if (
    error instanceof ToolNotFoundError ||
    error instanceof ToolInputValidationError ||
    error instanceof ToolExecutionError
  ) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: "TOOL_EXECUTION_FAILED",
    message: "The tool failed without exposing internal error details.",
    details: [],
  };
}

interface SerializedToolExchange {
  result: AgentToolResult;
  content: string;
}

function createOutputSerializationFailure(result: AgentToolResult): AgentToolResult {
  return {
    ...(result.originalIndex === undefined
      ? {}
      : { originalIndex: result.originalIndex }),
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    ...(result.mode === undefined ? {} : { mode: result.mode }),
    status: "failed",
    error: {
      code: "TOOL_OUTPUT_NOT_SERIALIZABLE",
      message: "Tool output must be JSON-compatible data.",
      details: [
        {
          path: "output",
          message: "Return JSON-compatible values without cycles or BigInt.",
        },
      ],
    },
  };
}

function serializeToolExchange(result: AgentToolResult): SerializedToolExchange {
  try {
    const content = JSON.stringify(
      result.status === "succeeded"
        ? {
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            status: result.status,
            output: result.output,
          }
        : {
            toolCallId: result.toolCallId,
            toolName: result.toolName,
            status: result.status,
            error: result.error,
          },
    );

    if (content === undefined) {
      throw new TypeError("Tool output is not JSON-serializable.");
    }

    return { result, content };
  } catch {
    const failedResult = createOutputSerializationFailure(result);
    return {
      result: failedResult,
      content: JSON.stringify({
        toolCallId: failedResult.toolCallId,
        toolName: failedResult.toolName,
        status: failedResult.status,
        error: failedResult.error,
      }),
    };
  }
}

function fromScheduledToolResult(result: ScheduledToolResult): AgentToolResult {
  if (result.status === "succeeded") {
    return {
      originalIndex: result.originalIndex,
      toolCallId: result.toolCallId,
      toolName: result.toolName,
      ...(result.mode === undefined ? {} : { mode: result.mode }),
      status: "succeeded",
      ...(result.output === undefined ? {} : { output: result.output }),
    };
  }

  return {
    originalIndex: result.originalIndex,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    ...(result.mode === undefined ? {} : { mode: result.mode }),
    status: result.status,
    ...(result.error === undefined
      ? {
          error: {
            code: "TOOL_EXECUTION_FAILED",
            message: "The tool did not return a safe error detail.",
            details: [],
          },
        }
      : { error: result.error }),
  };
}

export class AgentRunner {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly limits: AgentLimits;
  private readonly systemPrompt: string;
  private readonly taskIdFactory: () => string;
  private readonly scheduler: TaskScheduler | undefined;

  constructor(options: AgentRunnerOptions) {
    this.provider = options.provider;
    this.registry = options.registry;
    this.model = options.model;
    this.limits = AgentLimitsSchema.parse({
      maxModelTurns: options.maxModelTurns ?? options.maxIterations ?? 10,
      maxToolCalls: options.maxToolCalls ?? 20,
    });
    this.systemPrompt = options.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
    this.taskIdFactory = options.taskIdFactory ?? randomUUID;
    this.scheduler = options.scheduler;

    if (
      this.scheduler !== undefined &&
      this.scheduler.registry !== this.registry
    ) {
      throw new AppError({
        code: "AGENT_SCHEDULER_REGISTRY_MISMATCH",
        message: "AgentRunner and TaskScheduler must share the same ToolRegistry.",
        statusCode: 500,
        details: [],
      });
    }
  }

  async run(
    input: AgentRunInput,
    options: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    const lease = this.registry.acquireExecutionLease();

    try {
      return await this.runWithStableDefinitions(input, options);
    } finally {
      lease.release();
    }
  }

  private async runWithStableDefinitions(
    input: AgentRunInput,
    options: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const parsedInput = AgentRunInputSchema.parse(input);
    const taskId = this.taskIdFactory();
    const executionSignal = options.signal ?? new AbortController().signal;
    const messages: AgentMessage[] = [
      {
        role: "system",
        content: parsedInput.systemPrompt ?? this.systemPrompt,
      },
      {
        role: "user",
        content: parsedInput.objective,
      },
    ];
    const toolResults: AgentToolResult[] = [];
    let modelRequests = 0;
    let toolCalls = 0;

    if (isAborted(options.signal)) {
      return this.createResult({
        taskId,
        status: "cancelled",
        stopReason: "cancelled",
        messages,
        toolResults,
        modelRequests,
        toolCalls,
      });
    }

    while (true) {
      if (isAborted(options.signal)) {
        return this.createResult({
          taskId,
          status: "cancelled",
          stopReason: "cancelled",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
        });
      }

      if (modelRequests >= this.limits.maxModelTurns) {
        return this.createResult({
          taskId,
          status: "limit_reached",
          stopReason: "max_model_requests",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
        });
      }

      let response;
      modelRequests += 1;
      try {
        const rawResponse = await this.provider.generate(
          {
            model: this.model,
            messages,
            tools: this.getModelTools(),
          },
          options.signal === undefined ? {} : { signal: options.signal },
        );

        if (isAborted(options.signal)) {
          return this.createResult({
            taskId,
            status: "cancelled",
            stopReason: "cancelled",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }

        response = ModelResponseSchema.parse(rawResponse);
      } catch {
        const cancelled = isAborted(options.signal);
        return this.createResult({
          taskId,
          status: cancelled ? "cancelled" : "failed",
          stopReason: cancelled ? "cancelled" : "provider_error",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
        });
      }

      messages.push(response.message);

      const responseToolCalls = response.message.toolCalls ?? [];
      if (responseToolCalls.length === 0) {
        if (response.message.content.trim() === "") {
          return this.createResult({
            taskId,
            status: "failed",
            stopReason: "empty_response",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }

        return this.createResult({
          taskId,
          status: "completed",
          stopReason: "final_response",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
          finalAnswer: response.message.content,
        });
      }

      toolCalls += responseToolCalls.length;
      if (toolCalls > this.limits.maxToolCalls) {
        return this.createResult({
          taskId,
          status: "limit_reached",
          stopReason: "max_tool_calls",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
        });
      }

      if (this.scheduler !== undefined) {
        const scheduled = await this.scheduler.execute(responseToolCalls, {
          taskId,
          signal: executionSignal,
        });

        for (const scheduledResult of scheduled.results) {
          const exchange = serializeToolExchange(
            fromScheduledToolResult(scheduledResult),
          );
          toolResults.push(exchange.result);
          messages.push({
            role: "tool",
            toolCallId: exchange.result.toolCallId,
            content: exchange.content,
          });
        }

        if (scheduled.termination === "cancelled") {
          return this.createResult({
            taskId,
            status: "cancelled",
            stopReason: "cancelled",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }

        if (scheduled.termination === "write_outcome_unknown") {
          return this.createResult({
            taskId,
            status: "write_outcome_unknown",
            stopReason: "write_outcome_unknown",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }

        continue;
      }

      for (const toolCall of responseToolCalls) {
        if (isAborted(options.signal)) {
          return this.createResult({
            taskId,
            status: "cancelled",
            stopReason: "cancelled",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }

        const exchange = serializeToolExchange(
          await this.executeToolCall(toolCall, taskId, executionSignal),
        );
        toolResults.push(exchange.result);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: exchange.content,
        });
      }
    }
  }

  private async executeToolCall(
    toolCall: ToolCall,
    taskId: string,
    signal: AbortSignal,
  ): Promise<AgentToolResult> {
    let input: unknown = toolCall.arguments;

    if (typeof toolCall.arguments === "string") {
      try {
        input = JSON.parse(toolCall.arguments);
      } catch {
        return {
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          status: "failed",
          error: {
            code: "TOOL_ARGUMENTS_JSON_INVALID",
            message: "Tool arguments were not valid JSON.",
            details: [
              {
                path: "arguments",
                message: "Provide a valid JSON object matching the tool schema.",
              },
            ],
          },
        };
      }
    }

    try {
      const output = await this.registry.execute(toolCall.name, input, {
        taskId,
        toolCallId: toolCall.id,
        signal,
      });
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "succeeded",
        output,
      };
    } catch (error) {
      return {
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "failed",
        error: toAgentToolError(error),
      };
    }
  }

  private getModelTools(): ModelToolDefinition[] {
    return this.registry.list().map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: z.toJSONSchema(tool.inputSchema, {
        target: "draft-07",
        io: "input",
        unrepresentable: "throw",
      }),
    }));
  }

  private createResult(
    result: Omit<AgentRunResult, "finalAnswer"> & { finalAnswer?: string },
  ): AgentRunResult {
    return {
      taskId: result.taskId,
      status: result.status,
      stopReason: result.stopReason,
      messages: [...result.messages],
      toolResults: [...result.toolResults],
      modelRequests: result.modelRequests,
      toolCalls: result.toolCalls,
      ...(result.finalAnswer === undefined ? {} : { finalAnswer: result.finalAnswer }),
    };
  }
}
