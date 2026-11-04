import type { ToolCall } from "../provider/types.js";
import type { AppErrorDetail } from "../shared/errors.js";
import type {
  ToolExecutionContext,
  ToolMode,
} from "../tools/types.js";

export interface PlannedToolCallBase {
  readonly originalIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: ToolCall["arguments"];
}

export interface PlannedKnownToolCall extends PlannedToolCallBase {
  readonly mode: ToolMode;
  readonly timeoutMs: number;
  readonly requiresApproval: boolean;
}

export interface PlannedUnknownToolCall extends PlannedToolCallBase {
  readonly mode?: undefined;
  readonly timeoutMs?: undefined;
  readonly requiresApproval?: undefined;
}

export type PlannedToolCall =
  | PlannedKnownToolCall
  | PlannedUnknownToolCall;

export interface ReadBatchStep {
  readonly kind: "read_batch";
  readonly items: readonly PlannedKnownToolCall[];
}

export interface WriteStep {
  readonly kind: "write";
  readonly item: PlannedKnownToolCall;
}

export type UnknownToolReason = "not_registered" | "invalid_metadata";

export interface UnknownToolStep {
  readonly kind: "unknown_tool";
  readonly item: PlannedUnknownToolCall;
  readonly reason: UnknownToolReason;
}

export type ScheduleStep = ReadBatchStep | WriteStep | UnknownToolStep;

export type SchedulePlan = readonly ScheduleStep[];

export type SchedulerWorkerContext = Pick<
  ToolExecutionContext,
  "taskId" | "signal"
>;

export type ReadWorkerPoolContext = SchedulerWorkerContext;
export type WriteExecutorContext = SchedulerWorkerContext;

export interface ToolResultError {
  readonly code: string;
  readonly message: string;
  readonly details: readonly AppErrorDetail[];
}

export type ReadToolResultError = ToolResultError;

export type ReadToolResultStatus =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled";

export interface ReadToolResult {
  readonly originalIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: ReadToolResultStatus;
  readonly output?: unknown;
  readonly error?: ReadToolResultError;
}

export interface WriteApprovalRequest {
  readonly taskId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly description: string;
  readonly input: unknown;
}

export type WriteApprovalDecision =
  | { readonly status: "approved" }
  | { readonly status: "rejected"; readonly reason?: string };

export interface WriteApprovalHandler {
  request(
    request: WriteApprovalRequest,
    options: { signal?: AbortSignal },
  ): Promise<WriteApprovalDecision>;
}

export type WriteToolResultStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown"
  | "cancelled";

export interface WriteToolResult {
  readonly originalIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly status: WriteToolResultStatus;
  readonly output?: unknown;
  readonly error?: ToolResultError;
}

export type TaskSchedulerTermination =
  | "completed"
  | "cancelled"
  | "write_outcome_unknown";

export type ScheduledToolResultStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown"
  | "timed_out"
  | "cancelled";

export interface ScheduledToolResult {
  readonly originalIndex: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly mode?: ToolMode;
  readonly status: ScheduledToolResultStatus;
  readonly output?: unknown;
  readonly error?: ToolResultError;
}

export interface TaskSchedulerResult {
  readonly termination: TaskSchedulerTermination;
  readonly results: readonly ScheduledToolResult[];
}

export type TaskSchedulerContext = SchedulerWorkerContext;
