import type { ToolCall } from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolMode } from "../tools/types.js";
import { TaskPlanner } from "./planner.js";
import { ReadWorkerPool } from "./read-worker-pool.js";
import type {
  ReadToolResult,
  SchedulePlan,
  ScheduledToolResult,
  ScheduledToolResultStatus,
  TaskSchedulerContext,
  TaskSchedulerResult,
  TaskSchedulerTermination,
  ToolResultError,
} from "./types.js";
import { WriteExecutor } from "./write-executor.js";
import type { WriteToolResult } from "./types.js";

export interface TaskSchedulerOptions {
  readonly registry: ToolRegistry;
  readonly planner: TaskPlanner;
  readonly readWorkerPool: ReadWorkerPool;
  readonly writeExecutor: WriteExecutor;
}

function schedulerError(
  code: string,
  message: string,
): ToolResultError {
  return {
    code,
    message,
    details: [],
  };
}

function toScheduledReadResult(result: ReadToolResult): ScheduledToolResult {
  return {
    originalIndex: result.originalIndex,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    mode: "read",
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function toScheduledWriteResult(result: WriteToolResult): ScheduledToolResult {
  return {
    originalIndex: result.originalIndex,
    toolCallId: result.toolCallId,
    toolName: result.toolName,
    mode: "write",
    status: result.status,
    ...(result.output === undefined ? {} : { output: result.output }),
    ...(result.error === undefined ? {} : { error: result.error }),
  };
}

function collectModes(plan: SchedulePlan): ReadonlyMap<number, ToolMode> {
  const modes = new Map<number, ToolMode>();

  for (const step of plan) {
    if (step.kind === "read_batch") {
      for (const item of step.items) {
        modes.set(item.originalIndex, "read");
      }
    } else if (step.kind === "write") {
      modes.set(step.item.originalIndex, "write");
    }
  }

  return modes;
}

export class TaskScheduler {
  readonly registry: ToolRegistry;
  private readonly planner: TaskPlanner;
  private readonly readWorkerPool: ReadWorkerPool;
  private readonly writeExecutor: WriteExecutor;

  constructor(options: TaskSchedulerOptions) {
    if (
      options.planner.registry !== options.registry ||
      options.readWorkerPool.registry !== options.registry ||
      options.writeExecutor.registry !== options.registry
    ) {
      throw new AppError({
        code: "SCHEDULER_REGISTRY_MISMATCH",
        message: "All scheduler components must share the same ToolRegistry.",
        statusCode: 500,
        details: [],
      });
    }

    this.registry = options.registry;
    this.planner = options.planner;
    this.readWorkerPool = options.readWorkerPool;
    this.writeExecutor = options.writeExecutor;
  }

  async execute(
    toolCalls: readonly ToolCall[],
    context: TaskSchedulerContext,
  ): Promise<TaskSchedulerResult> {
    const plan = this.planner.plan(toolCalls);
    const modes = collectModes(plan);
    const results: Array<ScheduledToolResult | undefined> = new Array(
      toolCalls.length,
    );
    let termination: TaskSchedulerTermination = "completed";

    if (context.signal.aborted) {
      this.fillUnstarted(
        results,
        toolCalls,
        modes,
        "cancelled",
        schedulerError(
          "SCHEDULER_CANCELLED",
          "The tool call was not started because the task was cancelled.",
        ),
      );
      return {
        termination: "cancelled",
        results: this.finalizeResults(results, toolCalls),
      };
    }

    for (const step of plan) {
      if (context.signal.aborted) {
        termination = "cancelled";
        this.fillUnstarted(
          results,
          toolCalls,
          modes,
          "cancelled",
          schedulerError(
            "SCHEDULER_CANCELLED",
            "The tool call was not started because the task was cancelled.",
          ),
        );
        break;
      }

      if (step.kind === "read_batch") {
        try {
          const readResults = await this.readWorkerPool.execute(
            step.items,
            context,
          );
          for (const result of readResults) {
            results[result.originalIndex] = toScheduledReadResult(result);
          }

          if (
            context.signal.aborted ||
            readResults.some((result) => result.status === "cancelled")
          ) {
            termination = "cancelled";
            this.fillUnstarted(
              results,
              toolCalls,
              modes,
              "cancelled",
              schedulerError(
                "SCHEDULER_CANCELLED",
                "The tool call was not started because the task was cancelled.",
              ),
            );
            break;
          }
        } catch {
          for (const item of step.items) {
            results[item.originalIndex] = {
              originalIndex: item.originalIndex,
              toolCallId: item.toolCallId,
              toolName: item.toolName,
              mode: "read",
              status: "failed",
              error: schedulerError(
                "READ_BATCH_FAILED",
                "The read batch failed without exposing internal error details.",
              ),
            };
          }
        }
        continue;
      }

      if (step.kind === "unknown_tool") {
        results[step.item.originalIndex] = {
          originalIndex: step.item.originalIndex,
          toolCallId: step.item.toolCallId,
          toolName: step.item.toolName,
          status: "failed",
          error:
            step.reason === "not_registered"
              ? schedulerError(
                  "TOOL_NOT_FOUND",
                  `Tool "${step.item.toolName}" is not registered.`,
                )
              : schedulerError(
                  "TOOL_DEFINITION_INVALID",
                  `Tool "${step.item.toolName}" has invalid metadata.`,
                ),
        };
        continue;
      }

      try {
        const writeResult = await this.writeExecutor.execute(step.item, context);
        results[writeResult.originalIndex] =
          toScheduledWriteResult(writeResult);

        if (writeResult.status === "unknown") {
          termination = "write_outcome_unknown";
          this.fillUnstarted(
            results,
            toolCalls,
            modes,
            "skipped",
            schedulerError(
              "PRIOR_WRITE_OUTCOME_UNKNOWN",
              "The tool call was skipped because a prior write outcome is unknown.",
            ),
          );
          break;
        }

        if (writeResult.status === "cancelled") {
          termination = "cancelled";
          this.fillUnstarted(
            results,
            toolCalls,
            modes,
            "cancelled",
            schedulerError(
              "SCHEDULER_CANCELLED",
              "The tool call was not started because the task was cancelled.",
            ),
          );
          break;
        }

        if (
          writeResult.status === "failed" ||
          writeResult.status === "skipped"
        ) {
          this.fillUnstarted(
            results,
            toolCalls,
            modes,
            "skipped",
            schedulerError(
              "PRIOR_WRITE_DID_NOT_SUCCEED",
              "The tool call was skipped because a prior write did not succeed.",
            ),
          );
          break;
        }
      } catch {
        results[step.item.originalIndex] = {
          originalIndex: step.item.originalIndex,
          toolCallId: step.item.toolCallId,
          toolName: step.item.toolName,
          mode: "write",
          status: "unknown",
          error: schedulerError(
            "WRITE_OUTCOME_UNKNOWN",
            "The write outcome is unknown and must not be retried automatically.",
          ),
        };
        termination = "write_outcome_unknown";
        this.fillUnstarted(
          results,
          toolCalls,
          modes,
          "skipped",
          schedulerError(
            "PRIOR_WRITE_OUTCOME_UNKNOWN",
            "The tool call was skipped because a prior write outcome is unknown.",
          ),
        );
        break;
      }
    }

    if (termination === "completed") {
      for (const [index, toolCall] of toolCalls.entries()) {
        if (results[index] !== undefined) {
          continue;
        }

        results[index] = {
          originalIndex: index,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          ...(modes.has(index)
            ? { mode: modes.get(index) as ToolMode }
            : {}),
          status: "failed",
          error: schedulerError(
            "SCHEDULER_PLAN_INCOMPLETE",
            "The scheduler did not produce a result for this tool call.",
          ),
        };
      }
    }

    return {
      termination,
      results: this.finalizeResults(results, toolCalls),
    };
  }

  private fillUnstarted(
    results: Array<ScheduledToolResult | undefined>,
    toolCalls: readonly ToolCall[],
    modes: ReadonlyMap<number, ToolMode>,
    status: Extract<ScheduledToolResultStatus, "skipped" | "cancelled">,
    error: ToolResultError,
  ): void {
    for (const [index, toolCall] of toolCalls.entries()) {
      if (results[index] !== undefined) {
        continue;
      }

      results[index] = {
        originalIndex: index,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        ...(modes.has(index)
          ? { mode: modes.get(index) as ToolMode }
          : {}),
        status,
        error,
      };
    }
  }

  private finalizeResults(
    results: Array<ScheduledToolResult | undefined>,
    toolCalls: readonly ToolCall[],
  ): readonly ScheduledToolResult[] {
    return Array.from({ length: toolCalls.length }, (_unused, index) => {
      const result = results[index];
      if (result !== undefined) {
        return result;
      }

      const toolCall = toolCalls[index];
      if (toolCall === undefined) {
        throw new AppError({
          code: "SCHEDULER_RESULT_MISSING",
          message: "A scheduled tool result is missing.",
          statusCode: 500,
          details: [],
        });
      }

      return {
        originalIndex: index,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "failed",
        error: schedulerError(
          "SCHEDULER_RESULT_MISSING",
          "The scheduler did not produce a result for this tool call.",
        ),
      };
    });
  }
}
