import { z } from "zod";

import type {
  AgentMessage,
  ModelRequest,
  ModelResponse,
  TokenUsageAggregate,
} from "../provider/types.js";
import type { TaskSchedulerContext } from "../scheduler/types.js";
import type { ToolMode } from "../tools/types.js";
import type { LoopGuardDecision, LoopGuardRound } from "../loop-guard/index.js";
import type { ToolCall } from "../provider/types.js";

export const AgentLimitsSchema = z
  .object({
    maxModelTurns: z.number().int().positive().default(10),
    maxToolCalls: z.number().int().nonnegative().default(20),
  })
  .strict();

export const AgentRunInputSchema = z
  .object({
    objective: z.string().trim().min(1),
    systemPrompt: z.string().trim().min(1).optional(),
  })
  .strict();

export type AgentLimits = z.infer<typeof AgentLimitsSchema>;
export type AgentRunInput = z.input<typeof AgentRunInputSchema>;

export type AgentRunStatus =
  | "completed"
  | "cancelled"
  | "limit_reached"
  | "failed"
  | "paused"
  | "write_outcome_unknown";

export type AgentStopReason =
  | "final_response"
  | "max_model_requests"
  | "max_tool_calls"
  | "context_budget_exceeded"
  | "task_token_budget_exhausted"
  | "global_model_budget_exhausted"
  | "cancelled"
  | "provider_error"
  | "empty_response"
  | "loop_detected"
  | "write_outcome_unknown"
  | "persistence_failed";

export type AgentToolResultStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown"
  | "timed_out"
  | "cancelled";

export interface AgentToolError {
  code: string;
  message: string;
  details: ReadonlyArray<{
    path: string;
    message: string;
  }>;
}

export interface AgentToolResult {
  originalIndex?: number;
  toolCallId: string;
  toolName: string;
  mode?: ToolMode;
  status: AgentToolResultStatus;
  output?: unknown;
  error?: AgentToolError;
}

export interface AgentRunResult {
  taskId: string;
  status: AgentRunStatus;
  stopReason: AgentStopReason;
  messages: readonly AgentMessage[];
  toolResults: readonly AgentToolResult[];
  modelRequests: number;
  toolCalls: number;
  finalAnswer?: string;
}

export interface AgentPersistenceAdapter {
  readonly taskId: string;
  readonly initialMessages: readonly AgentMessage[];
  readonly initialModelRequests: number;
  readonly initialToolCalls: number;
  beginModelCall(request: ModelRequest, iteration: number): string;
  failModelCall(
    modelCallId: string,
    status: "failed" | "cancelled" | "interrupted",
    durationMs: number,
    error: AgentToolError,
  ): void;
  completeModelResponse(input: {
    readonly modelCallId: string;
    readonly response: ModelResponse;
    readonly durationMs: number;
  }): Promise<void>;
  getLoopGuardHistory(toolCalls: readonly ToolCall[]): {
    readonly eligible: boolean;
    readonly rounds: readonly LoopGuardRound[];
  };
  pauseForLoopGuard(
    toolCalls: readonly ToolCall[],
    decision: LoopGuardDecision,
  ): void;
  getTokenBudgetState(): {
    readonly maxTokens: number | null;
    readonly usage: TokenUsageAggregate;
  };
  pauseForTokenBudget(input: {
    readonly estimatedNextPromptTokens: number;
    readonly reservedCompletionTokens: number;
    readonly conservativeUnknownTokens: number;
    readonly usageUncertain: boolean;
  }): void;
  pauseForGlobalModelBudget(input: {
    readonly estimatedNextPromptTokens: number;
    readonly reservedCompletionTokens: number;
    readonly reason: "daily_budget_exhausted" | "provider_concurrency_exhausted";
  }): void;
  createSchedulerContext(signal: AbortSignal): TaskSchedulerContext;
  finishRun(result: AgentRunResult): void;
}
