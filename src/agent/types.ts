import { z } from "zod";

import type { AgentMessage } from "../provider/types.js";
import type { ToolMode } from "../tools/types.js";

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
  | "write_outcome_unknown";

export type AgentStopReason =
  | "final_response"
  | "max_model_requests"
  | "max_tool_calls"
  | "cancelled"
  | "provider_error"
  | "empty_response"
  | "write_outcome_unknown";

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
