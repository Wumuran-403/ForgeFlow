import { z } from "zod";

import {
  ToolInputValidationError,
  ToolNotFoundError,
  ToolValidatedInputInvalidError,
} from "../tools/errors.js";
import type { ToolRegistry } from "../tools/registry.js";
import { AppError } from "../shared/errors.js";
import type {
  PlannedKnownToolCall,
  PlannedToolCall,
  ToolResultError,
  WriteApprovalHandler,
  WriteExecutorContext,
  WriteToolResult,
} from "./types.js";
import { createAbortScope } from "./abort.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_APPROVAL_TIMEOUT_MS = 30_000;

const WriteExecutorOptionsSchema = z
  .object({
    defaultTimeoutMs: z.number().int().positive().default(DEFAULT_TIMEOUT_MS),
    approvalTimeoutMs: z
      .number()
      .int()
      .positive()
      .default(DEFAULT_APPROVAL_TIMEOUT_MS),
  })
  .strict();

const WriteApprovalDecisionSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("approved"),
    })
    .strict(),
  z
    .object({
      status: z.literal("rejected"),
      reason: z.string().optional(),
    })
    .strict(),
]);

const DEFAULT_APPROVAL_REQUIRED_ERROR: ToolResultError = {
  code: "WRITE_APPROVAL_REQUIRED",
  message: "The write tool requires approval, but no approval handler is available.",
  details: [],
};

const WRITE_CANCELLED_ERROR: ToolResultError = {
  code: "WRITE_CANCELLED",
  message: "The write was cancelled before tool execution started.",
  details: [],
};

const WRITE_OUTCOME_UNKNOWN_ERROR: ToolResultError = {
  code: "WRITE_OUTCOME_UNKNOWN",
  message: "The write outcome is unknown and must not be retried automatically.",
  details: [],
};

const WRITE_APPROVAL_TIMEOUT_ERROR: ToolResultError = {
  code: "WRITE_APPROVAL_TIMEOUT",
  message: "The write approval request timed out before a decision was made.",
  details: [],
};

export interface WriteExecutorOptions {
  readonly approvalHandler?: WriteApprovalHandler;
  readonly defaultTimeoutMs?: number;
  readonly approvalTimeoutMs?: number;
}

interface ParsedArguments {
  readonly ok: true;
  readonly value: unknown;
}

interface InvalidArguments {
  readonly ok: false;
  readonly error: ToolResultError;
}

type ApprovalOutcome =
  | { readonly kind: "decision"; readonly decision: unknown }
  | { readonly kind: "timeout" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "failed" };

function requestApproval(
  handler: WriteApprovalHandler,
  request: Parameters<WriteApprovalHandler["request"]>[0],
  parentSignal: AbortSignal,
  timeoutMs: number,
): Promise<ApprovalOutcome> {
  const abortScope = createAbortScope(parentSignal);
  let settled = false;
  let resolveOutcome:
    | ((outcome: ApprovalOutcome) => void)
    | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const onParentAbort = (): void => {
    finish({ kind: "cancelled" });
  };

  const cleanup = (): void => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    parentSignal.removeEventListener("abort", onParentAbort);
    abortScope.dispose();
  };

  const finish = (outcome: ApprovalOutcome): void => {
    if (settled) {
      return;
    }
    settled = true;
    cleanup();
    resolveOutcome?.(outcome);
  };

  const promise = new Promise<ApprovalOutcome>((resolve) => {
    resolveOutcome = resolve;
  });

  parentSignal.addEventListener("abort", onParentAbort, { once: true });
  if (parentSignal.aborted) {
    finish({ kind: "cancelled" });
  } else {
    timer = setTimeout(() => {
      abortScope.abort();
      finish({ kind: "timeout" });
    }, timeoutMs);

    void Promise.resolve()
      .then(() => handler.request(request, { signal: abortScope.signal }))
      .then(
        (decision) => finish({ kind: "decision", decision }),
        () => finish({ kind: "failed" }),
      );
  }

  return promise;
}

function resultWithStatus(
  task: Pick<PlannedToolCall, "originalIndex" | "toolCallId" | "toolName">,
  status: Exclude<WriteToolResult["status"], "succeeded">,
  error: ToolResultError,
): WriteToolResult {
  return {
    originalIndex: task.originalIndex,
    toolCallId: task.toolCallId,
    toolName: task.toolName,
    status,
    error,
  };
}

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

function toSafePreExecutionError(error: unknown): ToolResultError {
  if (
    error instanceof ToolNotFoundError ||
    error instanceof ToolInputValidationError ||
    error instanceof ToolValidatedInputInvalidError
  ) {
    return {
      code: error.code,
      message: error.message,
      details: error.details,
    };
  }

  return {
    code: "WRITE_PRE_EXECUTION_FAILED",
    message: "The write could not be prepared for execution.",
    details: [],
  };
}

function isSafeWriteTask(
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
    task.mode === "write" &&
    metadata.name === task.toolName &&
    metadata.mode === "write" &&
    metadata.timeoutMs === task.timeoutMs &&
    metadata.requiresApproval === task.requiresApproval
  );
}

function isJsonSerializable(value: unknown): boolean {
  try {
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

export class WriteExecutor {
  private readonly approvalHandler: WriteApprovalHandler | undefined;
  private readonly defaultTimeoutMs: number;
  private readonly approvalTimeoutMs: number;

  constructor(
    readonly registry: ToolRegistry,
    options: WriteExecutorOptions = {},
  ) {
    this.approvalHandler = options.approvalHandler;
    const parsedOptions = WriteExecutorOptionsSchema.safeParse({
      defaultTimeoutMs: options.defaultTimeoutMs,
      approvalTimeoutMs: options.approvalTimeoutMs,
    });
    if (!parsedOptions.success) {
      throw new AppError({
        code: "WRITE_EXECUTOR_CONFIGURATION_INVALID",
        message: "Write executor configuration is invalid.",
        statusCode: 400,
        details: [],
      });
    }
    this.defaultTimeoutMs = parsedOptions.data.defaultTimeoutMs;
    this.approvalTimeoutMs = parsedOptions.data.approvalTimeoutMs;
  }

  async execute(
    task: PlannedToolCall,
    context: WriteExecutorContext,
  ): Promise<WriteToolResult> {
    let metadata;
    try {
      metadata = this.registry.get(task.toolName);
    } catch (error) {
      return resultWithStatus(
        task,
        "failed",
        toSafePreExecutionError(error),
      );
    }

    if (!isSafeWriteTask(task, metadata)) {
      return resultWithStatus(task, "failed", {
        code: "INVALID_WRITE_TASK",
        message: "The task is not a valid write tool call.",
        details: [],
      });
    }

    if (context.signal.aborted) {
      return resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR);
    }

    const parsedArguments = parseArguments(task.arguments);
    if (!parsedArguments.ok) {
      return resultWithStatus(task, "failed", parsedArguments.error);
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
      return resultWithStatus(
        task,
        "failed",
        toSafePreExecutionError(error),
      );
    }

    if (context.signal.aborted) {
      return resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR);
    }

    if (validatedInput.requiresApproval) {
      if (this.approvalHandler === undefined) {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(
            task,
            "skipped",
            DEFAULT_APPROVAL_REQUIRED_ERROR,
          ),
        );
      }

      let approvalInput: unknown;
      try {
        approvalInput = structuredClone(validatedInput.value);
      } catch {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(task, "failed", {
            code: "WRITE_APPROVAL_INPUT_INVALID",
            message: "The write input cannot be prepared for approval.",
            details: [],
          }),
        );
      }

      const approvalOutcome = await requestApproval(
        this.approvalHandler,
        {
          taskId: context.taskId,
          toolCallId: task.toolCallId,
          toolName: task.toolName,
          description: metadata.description,
          input: approvalInput,
        },
        context.signal,
        this.approvalTimeoutMs,
      );

      if (context.signal.aborted) {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR),
        );
      }

      if (approvalOutcome.kind === "timeout") {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(
            task,
            "skipped",
            WRITE_APPROVAL_TIMEOUT_ERROR,
          ),
        );
      }

      if (approvalOutcome.kind === "cancelled") {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR),
        );
      }

      if (approvalOutcome.kind === "failed") {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(task, "failed", {
            code: "WRITE_APPROVAL_FAILED",
            message: "The write approval request failed.",
            details: [],
          }),
        );
      }

      const parsedDecision = WriteApprovalDecisionSchema.safeParse(
        approvalOutcome.decision,
      );
      if (!parsedDecision.success) {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(task, "skipped", {
            code: "WRITE_APPROVAL_INVALID",
            message: "The write approval decision was invalid.",
            details: [],
          }),
        );
      }

      if (parsedDecision.data.status !== "approved") {
        return persistPreExecutionResult(
          context,
          task,
          resultWithStatus(task, "skipped", {
            code: "WRITE_APPROVAL_REJECTED",
            message: "The write tool was not approved.",
            details: [],
          }),
        );
      }
    }

    if (context.signal.aborted) {
      return resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR);
    }

    if (context.signal.aborted) {
      return resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR);
    }

    try {
      context.persistence?.beforeExecute(task, context);
    } catch (error) {
      return resultWithStatus(
        task,
        "failed",
        toSafePreExecutionError(error),
      );
    }

    const abortScope = createAbortScope(context.signal);
    const executionState: {
      termination: "running" | "succeeded" | "failed" | "unknown";
    } = {
      termination: "running",
    };
    let output: unknown;
    const onParentAbort = (): void => {
      if (executionState.termination === "running") {
        executionState.termination = "unknown";
      }
    };
    context.signal.addEventListener("abort", onParentAbort, { once: true });
    const timer = setTimeout(() => {
      if (executionState.termination === "running") {
        executionState.termination = "unknown";
        abortScope.abort();
        context.signal.removeEventListener("abort", onParentAbort);
        abortScope.dispose();
      }
    }, task.timeoutMs ?? this.defaultTimeoutMs);

    if (context.signal.aborted) {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onParentAbort);
      abortScope.dispose();
      return resultWithStatus(task, "cancelled", WRITE_CANCELLED_ERROR);
    }

    try {
      output = await this.registry.executeValidated(validatedInput, {
        taskId: context.taskId,
        toolCallId: task.toolCallId,
        signal: abortScope.signal,
      });
      if (executionState.termination === "running") {
        executionState.termination = "succeeded";
      }
    } catch (error) {
      if (executionState.termination === "running") {
        executionState.termination =
          error instanceof ToolValidatedInputInvalidError
            ? "failed"
            : "unknown";
      }
    } finally {
      clearTimeout(timer);
      context.signal.removeEventListener("abort", onParentAbort);
      abortScope.dispose();
    }

    if (executionState.termination === "failed") {
      return persistWriteResult(context, task, resultWithStatus(task, "unknown", {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "The write outcome is unknown and must not be retried automatically.",
        details: [],
      }));
    }

    if (
      executionState.termination === "unknown" ||
      !isJsonSerializable(output)
    ) {
      return persistWriteResult(
        context,
        task,
        resultWithStatus(task, "unknown", WRITE_OUTCOME_UNKNOWN_ERROR),
      );
    }

    const succeeded = {
      originalIndex: task.originalIndex,
      toolCallId: task.toolCallId,
      toolName: task.toolName,
      status: "succeeded" as const,
      output,
    };
    if (context.persistence === undefined) {
      return succeeded;
    }
    try {
      context.persistence.persistWriteResult(task, succeeded);
      return succeeded;
    } catch {
      const unknown = resultWithStatus(
        task,
        "unknown",
        WRITE_OUTCOME_UNKNOWN_ERROR,
      );
      try {
        context.persistence.persistWriteResult(task, unknown);
      } catch {
        // A dead database leaves the persisted intent as running; Step 6
        // recovery turns that intent into unknown.
      }
      return unknown;
    }
  }
}

function persistWriteResult(
  context: WriteExecutorContext,
  task: PlannedKnownToolCall,
  result: WriteToolResult,
): WriteToolResult {
  if (context.persistence === undefined) {
    return result;
  }
  try {
    context.persistence.persistWriteResult(task, result);
    return result;
  } catch {
    return resultWithStatus(task, "unknown", {
      code: "WRITE_OUTCOME_UNKNOWN",
      message: "The write outcome is unknown and must not be retried automatically.",
      details: [],
    });
  }
}

function persistPreExecutionResult(
  context: WriteExecutorContext,
  task: PlannedKnownToolCall,
  result: WriteToolResult,
): WriteToolResult {
  try {
    context.persistence?.persistWriteResult(task, result);
  } catch {
    // The scheduler still receives the safe skipped/failed result. Step 6
    // handles any persisted pre-execution residue that could not be updated.
  }
  return result;
}
