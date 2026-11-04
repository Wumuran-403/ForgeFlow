import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { WriteExecutor } from "../../src/scheduler/write-executor.js";
import type {
  PlannedKnownToolCall,
  WriteApprovalDecision,
  WriteApprovalHandler,
  WriteApprovalRequest,
  WriteExecutorContext,
} from "../../src/scheduler/types.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import type { ToolExecutionContext } from "../../src/tools/types.js";

const transformPartNumber = vi.fn((value: string) =>
  value.trim().toUpperCase(),
);

const writeInputSchema = z
  .object({
    partNumber: z.string().min(1).transform(transformPartNumber),
    quantity: z.number().int().positive().default(1),
  })
  .strict();

function plannedWrite(
  overrides: Partial<PlannedKnownToolCall> = {},
): PlannedKnownToolCall {
  return {
    originalIndex: 0,
    toolCallId: "call-write-001",
    toolName: "report_generate",
    arguments: {
      partNumber: " stm32f103c8t6 ",
      quantity: 2,
    },
    mode: "write",
    timeoutMs: 500,
    requiresApproval: true,
    ...overrides,
  };
}

function createWriteRegistry(
  execute: (
    input: { partNumber: string; quantity: number },
    context?: ToolExecutionContext,
  ) => unknown,
  requiresApproval = true,
): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "report_generate",
    description: "Generate a local demo report.",
    mode: "write",
    inputSchema: writeInputSchema,
    timeoutMs: 500,
    requiresApproval,
    execute,
  });
  return registry;
}

function createContext(): {
  controller: AbortController;
  context: WriteExecutorContext;
} {
  const controller = new AbortController();
  return {
    controller,
    context: {
      taskId: "task-write-001",
      signal: controller.signal,
    },
  };
}

function approvalHandler(
  decision: WriteApprovalDecision,
): WriteApprovalHandler & { request: ReturnType<typeof vi.fn> } {
  return {
    request: vi.fn(async () => decision),
  };
}

describe("WriteExecutor", () => {
  beforeEach(() => {
    transformPartNumber.mockClear();
  });

  it("executes a write after approval using the standardized input", async () => {
    const { controller, context } = createContext();
    let executedInput: { partNumber: string; quantity: number } | undefined;
    let executedContext: ToolExecutionContext | undefined;
    const execute = vi.fn(
      (
        input: { partNumber: string; quantity: number },
        toolContext?: ToolExecutionContext,
      ) => {
        executedInput = input;
        executedContext = toolContext;
        return {
          reportId: "report-001",
          partNumber: input.partNumber,
        };
      },
    );
    const requests: WriteApprovalRequest[] = [];
    const handler: WriteApprovalHandler = {
      async request(request, options) {
        requests.push(request);
        expect(options.signal).toBeInstanceOf(AbortSignal);
        expect(options.signal?.aborted).toBe(false);
        return { status: "approved" };
      },
    };
    const executor = new WriteExecutor(createWriteRegistry(execute), {
      approvalHandler: handler,
    });

    const result = await executor.execute(plannedWrite(), context);

    expect(result).toMatchObject({
      originalIndex: 0,
      toolCallId: "call-write-001",
      toolName: "report_generate",
      status: "succeeded",
      output: {
        reportId: "report-001",
        partNumber: "STM32F103C8T6",
      },
    });
    expect(execute).toHaveBeenCalledOnce();
    expect(transformPartNumber).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      taskId: "task-write-001",
      toolCallId: "call-write-001",
      toolName: "report_generate",
      description: "Generate a local demo report.",
      input: {
        partNumber: "STM32F103C8T6",
        quantity: 2,
      },
    });
    expect(executedInput).toEqual(requests[0]?.input);
    expect(executedInput).not.toBe(requests[0]?.input);
    expect(executedContext).toMatchObject({
      taskId: "task-write-001",
      toolCallId: "call-write-001",
    });
    expect(executedContext?.signal).toBeInstanceOf(AbortSignal);
    expect(executedContext?.signal).not.toBe(controller.signal);
    expect(Object.keys(requests[0] ?? {}).sort()).toEqual([
      "description",
      "input",
      "taskId",
      "toolCallId",
      "toolName",
    ]);
  });

  it("does not execute a rejected write and does not expose the rejection reason", async () => {
    const { context } = createContext();
    const execute = vi.fn(() => ({ written: true }));
    const handler = approvalHandler({
      status: "rejected",
      reason: "API_KEY=secret-rejection-reason",
    });
    const executor = new WriteExecutor(createWriteRegistry(execute), {
      approvalHandler: handler,
    });

    const result = await executor.execute(plannedWrite(), context);

    expect(result).toMatchObject({
      status: "skipped",
      error: { code: "WRITE_APPROVAL_REJECTED" },
    });
    expect(handler.request).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("secret-rejection-reason");
  });

  it("skips an approval-required write when no approval handler exists", async () => {
    const { context } = createContext();
    const execute = vi.fn(() => ({ written: true }));
    const executor = new WriteExecutor(createWriteRegistry(execute));

    const result = await executor.execute(plannedWrite(), context);

    expect(result).toMatchObject({
      status: "skipped",
      error: { code: "WRITE_APPROVAL_REQUIRED" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("executes directly when requiresApproval is explicitly false", async () => {
    const { context } = createContext();
    const execute = vi.fn(() => ({ written: true }));
    const handler = approvalHandler({ status: "approved" });
    const executor = new WriteExecutor(
      createWriteRegistry(execute, false),
      { approvalHandler: handler },
    );
    const task = plannedWrite({ requiresApproval: false });

    const result = await executor.execute(task, context);

    expect(result.status).toBe("succeeded");
    expect(execute).toHaveBeenCalledOnce();
    expect(handler.request).not.toHaveBeenCalled();
  });

  it("rejects a read tool without requesting approval or executing it", async () => {
    const { context } = createContext();
    const registry = new ToolRegistry();
    const execute = vi.fn(() => ({ read: true }));
    registry.register({
      name: "report_generate",
      description: "A read tool must not enter the write executor.",
      mode: "read",
      inputSchema: writeInputSchema,
      timeoutMs: 500,
      execute,
    });
    const handler = approvalHandler({ status: "approved" });
    const executor = new WriteExecutor(registry, {
      approvalHandler: handler,
    });

    const result = await executor.execute(
      plannedWrite({ mode: "read", requiresApproval: false }),
      context,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "INVALID_WRITE_TASK" },
    });
    expect(handler.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects unknown tools without executing or requesting approval", async () => {
    const { context } = createContext();
    const registry = new ToolRegistry();
    const handler = approvalHandler({ status: "approved" });
    const executor = new WriteExecutor(registry, {
      approvalHandler: handler,
    });

    const result = await executor.execute(
      plannedWrite({ toolName: "missing_write" }),
      context,
    );

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "TOOL_NOT_FOUND" },
    });
    expect(handler.request).not.toHaveBeenCalled();
  });

  it("does not request approval or execute when Zod validation fails", async () => {
    const { context } = createContext();
    const execute = vi.fn(() => ({ written: true }));
    const handler = approvalHandler({ status: "approved" });
    const executor = new WriteExecutor(createWriteRegistry(execute), {
      approvalHandler: handler,
    });
    const task = plannedWrite({ arguments: {} });

    const result = await executor.execute(task, context);

    expect(result).toMatchObject({
      status: "failed",
      error: { code: "TOOL_INPUT_INVALID" },
    });
    expect(handler.request).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("prevents the approval callback from mutating the execution input", async () => {
    const { context } = createContext();
    let executedInput: unknown;
    const execute = vi.fn((input: unknown) => {
      executedInput = input;
      return { written: true };
    });
    const handler: WriteApprovalHandler = {
      async request(request) {
        expect(request.input).toEqual({
          partNumber: "STM32F103C8T6",
          quantity: 2,
        });
        (request.input as { partNumber: string }).partNumber = "MUTATED";
        return { status: "approved" };
      },
    };
    const executor = new WriteExecutor(createWriteRegistry(execute), {
      approvalHandler: handler,
    });

    const result = await executor.execute(plannedWrite(), context);

    expect(result.status).toBe("succeeded");
    expect(executedInput).toEqual({
      partNumber: "STM32F103C8T6",
      quantity: 2,
    });
  });

  it("cancels while approval is pending without executing the write", async () => {
    const { controller, context } = createContext();
    const execute = vi.fn(() => ({ written: true }));
    let receiveDecision:
      | ((decision: WriteApprovalDecision) => void)
      | undefined;
    let markApprovalStarted: (() => void) | undefined;
    const approvalStarted = new Promise<void>((resolve) => {
      markApprovalStarted = resolve;
    });
    const handler: WriteApprovalHandler = {
      async request() {
        markApprovalStarted?.();
        return new Promise<WriteApprovalDecision>((resolve) => {
          receiveDecision = resolve;
        });
      },
    };
    const executor = new WriteExecutor(createWriteRegistry(execute), {
      approvalHandler: handler,
    });
    const execution = executor.execute(plannedWrite(), context);

    await approvalStarted;
    controller.abort();
    receiveDecision?.({ status: "approved" });
    const result = await execution;

    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "WRITE_CANCELLED" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("cancels after approval but before execution when the signal is aborted", async () => {
    const { controller, context } = createContext();
    const execute = vi.fn(() => ({ written: true }));
    const handler: WriteApprovalHandler = {
      async request() {
        controller.abort();
        return { status: "approved" };
      },
    };
    const executor = new WriteExecutor(createWriteRegistry(execute), {
      approvalHandler: handler,
    });

    const result = await executor.execute(plannedWrite(), context);

    expect(result).toMatchObject({
      status: "cancelled",
      error: { code: "WRITE_CANCELLED" },
    });
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns unknown after an executed write throws and hides internal details", async () => {
    const { context } = createContext();
    const sensitiveValue = "sk-write-secret";
    const execute = vi.fn(() => {
      throw new Error(`write failed with ${sensitiveValue}`);
    });
    const executor = new WriteExecutor(
      createWriteRegistry(execute, false),
    );

    const result = await executor.execute(
      plannedWrite({ requiresApproval: false }),
      context,
    );

    expect(result).toMatchObject({
      toolCallId: "call-write-001",
      status: "unknown",
      error: { code: "WRITE_OUTCOME_UNKNOWN" },
    });
    expect(JSON.stringify(result)).not.toContain(sensitiveValue);
    expect(JSON.stringify(result)).not.toContain("stack");
  });

  it("returns unknown when an executed write returns BigInt", async () => {
    const { context } = createContext();
    const executor = new WriteExecutor(
      createWriteRegistry(
        () => ({ value: 1n }),
        false,
      ),
    );

    const result = await executor.execute(
      plannedWrite({ requiresApproval: false }),
      context,
    );

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "WRITE_OUTCOME_UNKNOWN" },
    });
  });

  it("returns unknown when an executed write returns a circular object", async () => {
    const { context } = createContext();
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const executor = new WriteExecutor(
      createWriteRegistry(() => circular, false),
    );

    const result = await executor.execute(
      plannedWrite({ requiresApproval: false }),
      context,
    );

    expect(result).toMatchObject({
      status: "unknown",
      error: { code: "WRITE_OUTCOME_UNKNOWN" },
    });
  });

  it("preserves taskId and toolCallId in approval and execution context", async () => {
    const { context } = createContext();
    let approvalRequest: WriteApprovalRequest | undefined;
    let executionContext:
      | { taskId: string; toolCallId: string; signal: AbortSignal }
      | undefined;
    const registry = new ToolRegistry();
    registry.register({
      name: "report_generate",
      description: "Capture context.",
      mode: "write",
      inputSchema: writeInputSchema,
      timeoutMs: 500,
      execute: (_input, toolContext) => {
        executionContext = toolContext;
        return { written: true };
      },
    });
    const executor = new WriteExecutor(registry, {
      approvalHandler: {
        async request(request) {
          approvalRequest = request;
          return { status: "approved" };
        },
      },
    });

    const result = await executor.execute(plannedWrite(), context);

    expect(result).toMatchObject({
      status: "succeeded",
      toolCallId: "call-write-001",
    });
    expect(approvalRequest).toMatchObject({
      taskId: "task-write-001",
      toolCallId: "call-write-001",
    });
    expect(executionContext).toMatchObject({
      taskId: "task-write-001",
      toolCallId: "call-write-001",
    });
    expect(executionContext?.signal).toBeInstanceOf(AbortSignal);
    expect(executionContext?.signal).not.toBe(context.signal);
  });
});
