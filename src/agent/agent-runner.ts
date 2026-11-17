import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  ContextBudgetExceededError,
  ContextManager,
  normalizeModelResponseUsage,
  type ContextManagerOptions,
} from "../context/index.js";
import {
  LoopGuard,
  computeToolCallSignature,
  type LoopGuardDecision,
  type LoopGuardOptions,
  type LoopGuardRound,
} from "../loop-guard/index.js";
import { sha256CanonicalJson } from "../shared/canonical-json.js";
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
  type ModelRequest,
  type ModelToolDefinition,
  type ToolCall,
} from "../provider/types.js";
import {
  AgentLimitsSchema,
  AgentRunInputSchema,
  type AgentLimits,
  type AgentPersistenceAdapter,
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
  persistence?: AgentPersistenceAdapter;
  contextManager?: ContextManager;
  context?: ContextManagerOptions;
  loopGuard?: LoopGuard;
  loopGuardOptions?: LoopGuardOptions;
  maxTaskTokens?: number;
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

function toLoopGuardRound(
  calls: readonly ToolCall[],
  results: readonly AgentToolResult[],
): LoopGuardRound {
  const resultById = new Map(results.map((result) => [result.toolCallId, result]));
  return {
    entries: calls.flatMap((call) => {
      const result = resultById.get(call.id);
      if (result === undefined) return [];
      const signature = computeToolCallSignature(call);
      return [{
        ...signature,
        ...(result.mode === undefined ? {} : { mode: result.mode }),
        outcome: result.status,
        ...(result.status === "succeeded" && result.output !== undefined
          ? { resultDigest: sha256CanonicalJson(result.output) }
          : result.error === undefined ? {} : { resultDigest: sha256CanonicalJson(result.error) }),
      }];
    }),
  };
}

function appendLoopBlockedResults(
  calls: readonly ToolCall[],
  toolResults: AgentToolResult[],
  messages: AgentMessage[],
): void {
  for (const [originalIndex, call] of calls.entries()) {
    const exchange = serializeToolExchange({
      originalIndex,
      toolCallId: call.id,
      toolName: call.name,
      status: "skipped",
      error: {
        code: "LOOP_GUARD_BLOCKED",
        message: "Tool dispatch was blocked because Loop Guard detected no progress.",
        details: [],
      },
    });
    toolResults.push(exchange.result);
    messages.push({
      role: "tool",
      toolCallId: call.id,
      content: exchange.content,
    });
  }
}

export class AgentRunner {
  private readonly provider: LLMProvider;
  private readonly registry: ToolRegistry;
  private readonly model: string;
  private readonly limits: AgentLimits;
  private readonly systemPrompt: string;
  private readonly taskIdFactory: () => string;
  private readonly scheduler: TaskScheduler | undefined;
  private readonly persistence: AgentPersistenceAdapter | undefined;
  private readonly contextManager: ContextManager;
  private readonly loopGuard: LoopGuard;
  private readonly maxTaskTokens: number | null;

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
    this.persistence = options.persistence;
    if (options.contextManager !== undefined && options.context !== undefined) {
      throw new AppError({
        code: "CONTEXT_MANAGER_CONFIGURATION_CONFLICT",
        message: "Provide either a ContextManager or Context Manager options, not both.",
        statusCode: 500,
        details: [],
      });
    }
    this.contextManager =
      options.contextManager ?? new ContextManager(options.context);
    if (options.loopGuard !== undefined && options.loopGuardOptions !== undefined) {
      throw new AppError({
        code: "LOOP_GUARD_CONFIGURATION_CONFLICT",
        message: "Provide either a LoopGuard or Loop Guard options, not both.",
        statusCode: 500,
        details: [],
      });
    }
    this.loopGuard = options.loopGuard ?? new LoopGuard(options.loopGuardOptions);
    this.maxTaskTokens = options.maxTaskTokens === undefined
      ? null
      : z.number().int().positive().parse(options.maxTaskTokens);

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
    if (this.persistence !== undefined && this.scheduler === undefined) {
      throw new AppError({
        code: "SCHEDULER_REQUIRED",
        message: "Persistent Agent execution requires a scheduler.",
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
    const result = await this.runLoop(input, options);
    this.persistence?.finishRun(result);
    return result;
  }

  private async runLoop(
    input: AgentRunInput,
    options: AgentRunOptions,
  ): Promise<AgentRunResult> {
    const parsedInput = AgentRunInputSchema.parse(input);
    const taskId = this.persistence?.taskId ?? this.taskIdFactory();
    const executionSignal = options.signal ?? new AbortController().signal;
    const messages: AgentMessage[] =
      this.persistence === undefined
        ? [
            {
              role: "system",
              content: parsedInput.systemPrompt ?? this.systemPrompt,
            },
            {
              role: "user",
              content: parsedInput.objective,
            },
          ]
        : [...this.persistence.initialMessages];
    const toolResults: AgentToolResult[] = [];
    const loopHistory: LoopGuardRound[] = [];
    let modelRequests = this.persistence?.initialModelRequests ?? 0;
    let toolCalls = this.persistence?.initialToolCalls ?? 0;
    let localTokenUsage = 0;

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

    // A process can stop after persisting an assistant tool-call message but
    // before all matching tool results are committed. Resume only the missing
    // calls; completed results already present in the checkpoint are reused.
    if (this.persistence !== undefined && this.scheduler !== undefined) {
      const lastAssistant = [...messages].reverse().find(
        (message) => message.role === "assistant" && (message.toolCalls?.length ?? 0) > 0,
      );
      const answered = new Set(messages.flatMap((message) =>
        message.role === "tool" && message.toolCallId !== undefined
          ? [message.toolCallId]
          : [],
      ));
      const pendingCalls = (lastAssistant?.role === "assistant" ? lastAssistant.toolCalls ?? [] : []).filter(
        (call) => !answered.has(call.id),
      );
      if (pendingCalls.length > 0) {
        const decision = this.evaluateLoopGuard(loopHistory, pendingCalls);
        if (decision !== undefined) {
          this.persistence.pauseForLoopGuard(pendingCalls, decision);
          appendLoopBlockedResults(pendingCalls, toolResults, messages);
          return this.createResult({
            taskId,
            status: "paused",
            stopReason: "loop_detected",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }
        const context = this.persistence.createSchedulerContext(executionSignal);
        const scheduled = await this.scheduler.execute(pendingCalls, {
          ...context,
          taskId,
          signal: executionSignal,
        });
        for (const scheduledResult of scheduled.results) {
          const exchange = serializeToolExchange(fromScheduledToolResult(scheduledResult));
          toolResults.push(exchange.result);
          messages.push({
            role: "tool",
            toolCallId: exchange.result.toolCallId,
            content: exchange.content,
          });
        }
        loopHistory.push(toLoopGuardRound(pendingCalls, scheduled.results.map(fromScheduledToolResult)));
        if (scheduled.termination !== "completed") {
          return this.createResult({
            taskId,
            status: scheduled.termination === "write_outcome_unknown"
              ? "write_outcome_unknown"
              : scheduled.termination === "cancelled" ? "cancelled" : "failed",
            stopReason: scheduled.termination === "persistence_failed"
              ? "persistence_failed"
              : scheduled.termination,
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }
      }
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
      let modelCallId: string | undefined;
      let request: ModelRequest;
      let estimatedNextPromptTokens: number;
      try {
        const context = this.contextManager.build({
          model: this.model,
          messages,
          tools: this.getModelTools(),
        });
        request = context.request;
        estimatedNextPromptTokens = context.estimatedPromptTokens;
      } catch (error) {
        if (error instanceof ContextBudgetExceededError) {
          return this.createResult({
            taskId,
            status: "limit_reached",
            stopReason: "context_budget_exceeded",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }
        throw error;
      }
      const tokenBudget = this.persistence?.getTokenBudgetState() ?? {
        maxTokens: this.maxTaskTokens,
        usage: { source: "estimated" as const, totalTokens: localTokenUsage },
      };
      const unknownUsageCalls = tokenBudget.usage.unknownCalls ?? 0;
      const accountedUsageCalls = (tokenBudget.usage.providerCalls ?? 0) +
        (tokenBudget.usage.estimatedCalls ?? 0) + unknownUsageCalls;
      const unaccountedModelCalls = Math.max(0, modelRequests - accountedUsageCalls);
      const uncertainUsageCalls = unknownUsageCalls + unaccountedModelCalls;
      const usageUncertain = uncertainUsageCalls > 0;
      const conservativeUnknownTokens =
        uncertainUsageCalls * this.contextManager.options.maxContextTokens;
      const persistedUsage = (tokenBudget.usage.totalTokens ?? 0) +
        conservativeUnknownTokens;
      const reservedCompletionTokens =
        this.contextManager.options.reservedCompletionTokens;
      const projectedUsage =
        persistedUsage + estimatedNextPromptTokens + reservedCompletionTokens;
      if (
        tokenBudget.maxTokens !== null &&
        projectedUsage > tokenBudget.maxTokens
      ) {
        this.persistence?.pauseForTokenBudget({
          estimatedNextPromptTokens,
          reservedCompletionTokens,
          conservativeUnknownTokens,
          usageUncertain,
        });
        return this.createResult({
          taskId,
          status: this.persistence === undefined ? "limit_reached" : "paused",
          stopReason: "task_token_budget_exhausted",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
        });
      }
      const requestStartedAt = Date.now();
      modelRequests += 1;
      try {
        modelCallId = this.persistence?.beginModelCall(
          request,
          modelRequests,
        );
        const rawResponse = await this.provider.generate(
          request,
          options.signal === undefined ? {} : { signal: options.signal },
        );

        if (isAborted(options.signal)) {
          if (this.persistence !== undefined && modelCallId !== undefined) {
            this.persistence.failModelCall(
              modelCallId,
              "cancelled",
              Date.now() - requestStartedAt,
              {
                code: "MODEL_CALL_CANCELLED",
                message: "The model call was cancelled.",
                details: [],
              },
            );
          }
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

        response = normalizeModelResponseUsage(
          request,
          ModelResponseSchema.parse(rawResponse),
        );
        localTokenUsage += response.usage.totalTokens ?? 0;
      } catch (error) {
        const cancelled = isAborted(options.signal);
        const globalBudgetReason = resolveGlobalBudgetReason(error);
        if (this.persistence !== undefined && modelCallId !== undefined) {
          this.persistence.failModelCall(
            modelCallId,
            cancelled ? "cancelled" : "failed",
            Date.now() - requestStartedAt,
            {
              code: cancelled ? "MODEL_CALL_CANCELLED"
                : globalBudgetReason === undefined ? "MODEL_CALL_FAILED"
                  : "GLOBAL_MODEL_BUDGET_EXHAUSTED",
              message: cancelled
                ? "The model call was cancelled."
                : globalBudgetReason === undefined
                  ? "The model call failed."
                  : "The model call was blocked by a global cost safeguard.",
              details: [],
            },
          );
        }
        if (!cancelled && globalBudgetReason !== undefined && this.persistence !== undefined) {
          this.persistence.pauseForGlobalModelBudget({
            estimatedNextPromptTokens,
            reservedCompletionTokens,
            reason: globalBudgetReason,
          });
          return this.createResult({
            taskId,
            status: "paused",
            stopReason: "global_model_budget_exhausted",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }
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

      if (this.persistence !== undefined) {
        try {
          await this.persistence.completeModelResponse({
            modelCallId: modelCallId as string,
            response,
            durationMs: Date.now() - requestStartedAt,
          });
        } catch {
          return this.createResult({
            taskId,
            status: "failed",
            stopReason: "provider_error",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }
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

      const loopDecision = this.evaluateLoopGuard(loopHistory, responseToolCalls);
      if (loopDecision !== undefined) {
        this.persistence?.pauseForLoopGuard(responseToolCalls, loopDecision);
        appendLoopBlockedResults(responseToolCalls, toolResults, messages);
        return this.createResult({
          taskId,
          status: "paused",
          stopReason: "loop_detected",
          messages,
          toolResults,
          modelRequests,
          toolCalls,
        });
      }

      if (this.scheduler !== undefined) {
        const schedulerContext =
          this.persistence?.createSchedulerContext(executionSignal) ?? {
            taskId,
            signal: executionSignal,
          };
        const scheduled = await this.scheduler.execute(responseToolCalls, {
          ...schedulerContext,
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
        loopHistory.push(toLoopGuardRound(
          responseToolCalls,
          scheduled.results.map(fromScheduledToolResult),
        ));

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

        if (scheduled.termination === "persistence_failed") {
          return this.createResult({
            taskId,
            status: "failed",
            stopReason: "persistence_failed",
            messages,
            toolResults,
            modelRequests,
            toolCalls,
          });
        }

        continue;
      }

      const currentRoundResults: AgentToolResult[] = [];
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
        currentRoundResults.push(exchange.result);
        messages.push({
          role: "tool",
          toolCallId: toolCall.id,
          content: exchange.content,
        });
      }
      loopHistory.push(toLoopGuardRound(responseToolCalls, currentRoundResults));
    }
  }

  private evaluateLoopGuard(
    localHistory: readonly LoopGuardRound[],
    toolCalls: readonly ToolCall[],
  ): LoopGuardDecision | undefined {
    if (this.persistence !== undefined) {
      const persisted = this.persistence.getLoopGuardHistory(toolCalls);
      if (!persisted.eligible) return undefined;
      return this.loopGuard.evaluate(persisted.rounds, toolCalls);
    }
    return this.loopGuard.evaluate(localHistory, toolCalls);
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
      if (this.registry.get(toolCall.name).mode === "write") {
        throw new AppError({
          code: "WRITE_SCHEDULER_REQUIRED",
          message: "Write tools require the scheduler and its approval path.",
          statusCode: 409,
          details: [],
        });
      }
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

function resolveGlobalBudgetReason(
  error: unknown,
): "daily_budget_exhausted" | "provider_concurrency_exhausted" | undefined {
  if (!(error instanceof AppError)) return undefined;
  if (error.code === "GLOBAL_MODEL_BUDGET_EXHAUSTED") return "daily_budget_exhausted";
  if (error.code === "GLOBAL_PROVIDER_CONCURRENCY_EXHAUSTED") return "provider_concurrency_exhausted";
  return undefined;
}
