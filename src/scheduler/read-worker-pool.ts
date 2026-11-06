import { z } from "zod";

import {
  ToolExecutionError,
  ToolInputValidationError,
  ToolNotFoundError,
  ToolValidatedInputInvalidError,
} from "../tools/errors.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { ToolExecutionContext } from "../tools/types.js";
import { AppError } from "../shared/errors.js";
import type {
  PlannedKnownToolCall,
  PlannedToolCall,
  ReadToolResult,
  ReadToolResultError,
  ReadWorkerPoolContext,
} from "./types.js";
import { createAbortScope } from "./abort.js";

const DEFAULT_MAX_CONCURRENCY = 3;
const DEFAULT_TIMEOUT_MS = 30_000;

const ReadWorkerPoolOptionsSchema = z
  .object({
    maxConcurrency: z.number().int().positive().default(DEFAULT_MAX_CONCURRENCY),
    defaultTimeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
  })
  .strict();

export type ReadWorkerPoolOptions = z.input<typeof ReadWorkerPoolOptionsSchema>;

interface ParsedArguments {
  readonly ok: true;
  readonly value: unknown;
}

interface InvalidArguments {
  readonly ok: false;
  readonly error: ReadToolResultError;
}

function failure(
  task: Pick<PlannedToolCall, "originalIndex" | "toolCallId" | "toolName">,
  error: ReadToolResultError,
  status: "failed" | "timed_out" | "cancelled" = "failed",
): ReadToolResult {
  return {
    originalIndex: task.originalIndex,
    toolCallId: task.toolCallId,
    toolName: task.toolName,
    status,
    error,
  };
}

function invalidReadTaskError(): ReadToolResultError {
  return {
    code: "INVALID_READ_TASK",
    message: "The task is not a valid read tool call.",
    details: [],
  };
}

const READ_CANCELLED_ERROR: ReadToolResultError = {
  code: "TOOL_EXECUTION_CANCELLED",
  message: "The read tool was cancelled.",
  details: [],
};

const READ_TIMEOUT_ERROR: ReadToolResultError = {
  code: "TOOL_EXECUTION_TIMEOUT",
  message: "The read tool timed out.",
  details: [],
};

function parseArguments(
  argumentsValue: PlannedToolCall["arguments"],
): ParsedArguments | InvalidArguments {
  if (typeof argumentsValue !== "string") {
    return { ok: true, value: argumentsValue };
  }

  try {
    return {
      ok: true,
      value: JSON.parse(argumentsValue) as unknown,
    };
  } catch {
    return {
      ok: false,
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

function toSafeReadError(error: unknown): ReadToolResultError {
  if (
    error instanceof ToolNotFoundError ||
    error instanceof ToolInputValidationError ||
    error instanceof ToolExecutionError ||
    error instanceof ToolValidatedInputInvalidError
  ) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: "TOOL_EXECUTION_FAILED",
    message: "The read tool failed without exposing internal error details.",
    details: [],
  };
}

function isSafeReadTask(
  task: PlannedToolCall,
  metadata: {
    name: string;
    mode: string;
    timeoutMs: number;
    requiresApproval: boolean;
  },
): task is PlannedKnownToolCall {
  return (
    Number.isInteger(task.originalIndex) &&
    task.originalIndex >= 0 &&
    task.toolCallId.length > 0 &&
    task.toolName.length > 0 &&
    task.mode === "read" &&
    metadata.name === task.toolName &&
    metadata.mode === "read" &&
    metadata.timeoutMs === task.timeoutMs &&
    metadata.requiresApproval === task.requiresApproval
  );
}

export class ReadWorkerPool {
  private readonly maxConcurrency: number;
  private readonly defaultTimeoutMs: number;
  private activeTasks = 0;

  constructor(
    readonly registry: ToolRegistry,
    options: ReadWorkerPoolOptions = {},
  ) {
    const parsedOptions = ReadWorkerPoolOptionsSchema.safeParse(options);
    if (!parsedOptions.success) {
      throw new AppError({
        code: "READ_WORKER_POOL_CONFIGURATION_INVALID",
        message: "Read worker pool configuration is invalid.",
        statusCode: 400,
        details: [],
      });
    }
    this.maxConcurrency = parsedOptions.data.maxConcurrency;
    this.defaultTimeoutMs = parsedOptions.data.defaultTimeoutMs;
  }

  get activeTaskCount(): number {
    return this.activeTasks;
  }

  async execute(
    tasks: readonly PlannedToolCall[],
    context: ReadWorkerPoolContext,
  ): Promise<readonly ReadToolResult[]> {
    if (tasks.length === 0) {
      return [];
    }

    const results: Array<ReadToolResult | undefined> = new Array(tasks.length);
    const startedToolCalls = new Set<string>();
    const workerCount = Math.min(this.maxConcurrency, tasks.length);
    let nextIndex = 0;

    const runWorker = async (): Promise<void> => {
      while (true) {
        if (context.signal.aborted) {
          return;
        }

        const index = nextIndex;
        nextIndex += 1;
        if (index >= tasks.length) {
          return;
        }

        const task = tasks[index];
        if (task === undefined) {
          return;
        }

        this.activeTasks += 1;
        try {
          results[index] = await this.executeTask(
            task,
            context,
            startedToolCalls,
          );
        } catch (error) {
          results[index] = failure(task, toSafeReadError(error));
        } finally {
          this.activeTasks -= 1;
        }
      }
    };

    await Promise.all(
      Array.from({ length: workerCount }, () => runWorker()),
    );

    return Array.from({ length: tasks.length }, (_unused, index) => {
      const result = results[index];
      if (result !== undefined) {
        return result;
      }

      const task = tasks[index];
      if (task === undefined) {
        throw new AppError({
          code: "READ_WORKER_RESULT_MISSING",
          message: "A read worker result is missing.",
          statusCode: 500,
          details: [],
        });
      }

      return context.signal.aborted
        ? failure(task, READ_CANCELLED_ERROR, "cancelled")
        : failure(task, {
            code: "TOOL_EXECUTION_FAILED",
            message: "The read tool failed without exposing internal error details.",
            details: [],
          });
    }).map((result, index) => {
      const task = tasks[index];
      if (
        task === undefined ||
        task.mode !== "read" ||
        !startedToolCalls.has(task.toolCallId)
      ) {
        return result;
      }
      return persistReadResult(task, result, context);
    });
  }

  private async executeTask(
    task: PlannedToolCall,
    context: ReadWorkerPoolContext,
    startedToolCalls: Set<string>,
  ): Promise<ReadToolResult> {
    let metadata;
    try {
      metadata = this.registry.get(task.toolName);
    } catch (error) {
      return failure(task, toSafeReadError(error));
    }

    if (!isSafeReadTask(task, metadata)) {
      return failure(task, invalidReadTaskError());
    }

    if (context.signal.aborted) {
      return failure(task, READ_CANCELLED_ERROR, "cancelled");
    }

    const parsedArguments = parseArguments(task.arguments);
    if (!parsedArguments.ok) {
      return failure(task, parsedArguments.error);
    }

    let validatedInput;
    try {
      validatedInput =
        context.validatedInputs?.get(task.toolCallId) ??
        (await this.registry.validateInput(
          task.toolName,
          parsedArguments.value,
        ));
    } catch (error) {
      return failure(task, toSafeReadError(error));
    }

    if (context.signal.aborted) {
      return failure(task, READ_CANCELLED_ERROR, "cancelled");
    }

    try {
      context.persistence?.beforeExecute(task, context);
      if (context.persistence !== undefined) {
        startedToolCalls.add(task.toolCallId);
      }
    } catch (error) {
      return failure(task, toSafeReadError(error));
    }

    const abortScope = createAbortScope(context.signal);
    const executionState: {
      termination:
        | "running"
        | "succeeded"
        | "failed"
        | "timed_out"
        | "cancelled";
    } = {
      termination: "running",
    };
    let output: unknown;
    let executionError: unknown;
    const onParentAbort = (): void => {
      if (executionState.termination === "running") {
        executionState.termination = "cancelled";
      }
    };
    context.signal.addEventListener("abort", onParentAbort, { once: true });
    const timeout = setTimeout(() => {
      if (executionState.termination === "running") {
        executionState.termination = "timed_out";
        abortScope.abort();
        context.signal.removeEventListener("abort", onParentAbort);
        abortScope.dispose();
      }
    }, task.timeoutMs ?? this.defaultTimeoutMs);

    if (context.signal.aborted) {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onParentAbort);
      abortScope.dispose();
      return failure(task, READ_CANCELLED_ERROR, "cancelled");
    }

    const toolContext: ToolExecutionContext = {
      taskId: context.taskId,
      toolCallId: task.toolCallId,
      signal: abortScope.signal,
    };

    try {
      output = await this.registry.executeValidated(
        validatedInput,
        toolContext,
      );
      if (executionState.termination === "running") {
        executionState.termination = "succeeded";
      }
    } catch (error) {
      executionError = error;
      if (executionState.termination === "running") {
        executionState.termination = "failed";
      }
    } finally {
      clearTimeout(timeout);
      context.signal.removeEventListener("abort", onParentAbort);
      abortScope.dispose();
    }

    if (executionState.termination === "timed_out") {
      const result = failure(task, READ_TIMEOUT_ERROR, "timed_out");
      return result;
    }

    if (executionState.termination === "cancelled") {
      const result = failure(task, READ_CANCELLED_ERROR, "cancelled");
      return result;
    }

    if (executionState.termination === "failed") {
      const result = failure(task, toSafeReadError(executionError));
      return result;
    }

    return {
      originalIndex: task.originalIndex,
      toolCallId: task.toolCallId,
      toolName: task.toolName,
      status: "succeeded",
      output,
    };
  }
}

function persistReadResult(
  task: PlannedKnownToolCall,
  result: ReadToolResult,
  context: ReadWorkerPoolContext,
): ReadToolResult {
  if (context.persistence === undefined) {
    return result;
  }
  try {
    context.persistence.persistReadResult(task, result);
    return result;
  } catch (error) {
    throw new AppError({
      code: "READ_RESULT_PERSISTENCE_FAILED",
      message: "The read result could not be persisted safely.",
      statusCode: 500,
      details: [],
      cause: error,
    });
  }
}
