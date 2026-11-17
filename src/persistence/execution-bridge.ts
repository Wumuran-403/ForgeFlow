import { randomUUID } from "node:crypto";

import type { AgentPersistenceAdapter, AgentRunResult, AgentToolError } from "../agent/types.js";
import type {
  AgentMessage,
  ModelRequest,
  ModelResponse,
  ToolCall,
} from "../provider/types.js";
import type {
  SchedulePlan,
  TaskScheduler,
  TaskSchedulerContext,
  ToolExecutionPersistence,
} from "../scheduler/index.js";
import { ExecutionAuthority } from "./lease-heartbeat.js";
import { assertCanonicalJsonValue } from "../shared/canonical-json.js";
import { AppError } from "../shared/errors.js";
import {
  ExecutionStateMachine,
  ExecutionUnitOfWork,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
  type TaskSnapshot,
} from "../storage/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EvidencePayloadStore } from "../recovery/evidence-payload-store.js";
import {
  computeToolDefinitionFingerprint,
} from "../tools/fingerprint.js";
import type { ValidatedToolInput } from "../tools/types.js";
import {
  computeToolCallSignature,
  type LoopGuardDecision,
  type LoopGuardEntry,
  type LoopGuardRound,
} from "../loop-guard/index.js";
import { sha256CanonicalJson } from "../shared/canonical-json.js";

interface BridgeOptions {
  readonly database: ForgeFlowDatabase;
  readonly leaseManager: TaskLeaseManager;
  readonly stateMachine: ExecutionStateMachine;
  readonly scheduler?: TaskScheduler;
  readonly registry: ToolRegistry;
  readonly finalReviewPayloadStore?: EvidencePayloadStore;
  readonly snapshot: TaskSnapshot;
  readonly ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  };
  readonly authority: ExecutionAuthority;
}

export class PersistentExecutionBridge
  implements AgentPersistenceAdapter, ToolExecutionPersistence
{
  readonly taskId: string;
  readonly initialMessages: readonly AgentMessage[];
  readonly initialModelRequests: number;
  readonly initialToolCalls: number;
  private snapshot: TaskSnapshot;
  private schedulePlan: SchedulePlan | undefined;
  private validatedInputs = new Map<string, ValidatedToolInput>();
  private readonly unitOfWork: ExecutionUnitOfWork;
  private readonly toolRuns: ToolRunRepository;
  private readonly snapshotReader: TaskSnapshotReader;

  constructor(private readonly options: BridgeOptions) {
    this.taskId = options.snapshot.task.id;
    this.snapshot = options.snapshot;
    this.initialMessages = options.snapshot.messages.map(toAgentMessage);
    this.initialModelRequests = options.snapshot.modelCalls.length;
    this.initialToolCalls = options.snapshot.toolRuns.length;
    this.unitOfWork = new ExecutionUnitOfWork(
      options.database,
      options.leaseManager,
      options.finalReviewPayloadStore,
    );
    this.toolRuns = new ToolRunRepository(options.database);
    this.snapshotReader = new TaskSnapshotReader(options.database);
  }

  beginModelCall(request: ModelRequest, iteration: number): string {
    this.options.authority.assertActive();
    const call = this.unitOfWork.beginModelCall({
      taskId: this.taskId,
      iteration,
      request,
    }, this.ownershipContext(), () =>
      this.options.authority.assertActive());
    this.refresh();
    return call.id;
  }

  failModelCall(
    modelCallId: string,
    status: "failed" | "cancelled" | "interrupted",
    durationMs: number,
    error: AgentToolError,
  ): void {
    this.options.authority.assertActive();
    this.unitOfWork.failModelCall({
      modelCallId,
      status,
      durationMs,
      error: toPersistedError(error),
    }, this.ownershipContext(), () =>
      this.options.authority.assertActive());
    this.refresh();
  }

  async completeModelResponse(input: {
    readonly modelCallId: string;
    readonly response: ModelResponse;
    readonly durationMs: number;
  }): Promise<void> {
    this.options.authority.assertActive();
    if (this.options.scheduler === undefined) {
      throw new AppError({
        code: "SCHEDULER_REQUIRED",
        message: "A scheduler is required to persist model execution plans.",
        statusCode: 500,
        details: [],
      });
    }
    const toolCalls = input.response.message.toolCalls ?? [];
    if (toolCalls.length === 0) {
      this.schedulePlan = undefined;
      this.validatedInputs = new Map();
      this.unitOfWork.completeModelCall({
        modelCallId: input.modelCallId,
        response: input.response,
        durationMs: input.durationMs,
      }, this.ownershipContext(), () =>
        this.options.authority.assertActive());
      this.refresh();
      return;
    }

    const plan = this.options.scheduler.plan(toolCalls);
    const validatedInputs = new Map<string, ValidatedToolInput>();
    const planSteps = [];
    const toolRuns = [];

    for (const [stepIndex, step] of plan.entries()) {
      const stepId = randomUUID();
      const kind = step.kind;
      planSteps.push({
        id: stepId,
        stepIndex,
        kind,
      });
      if (kind === "unknown_tool") {
        continue;
      }
      const items = kind === "read_batch" ? step.items : [step.item];
      for (const item of items) {
        const parsed = parseToolArguments(item.arguments);
        const validated = await this.options.registry.validateInput(
          item.toolName,
          parsed,
        );
        validatedInputs.set(item.toolCallId, validated);
        const metadata = this.options.registry.get(item.toolName);
        const fingerprint = computeToolDefinitionFingerprint(
          metadata,
          validated.value,
        );
        assertCanonicalJsonValue(validated.value);
        toolRuns.push({
          id: randomUUID(),
          planStepId: stepId,
          toolCallId: item.toolCallId,
          originalIndex: item.originalIndex,
          toolName: item.toolName,
          ...fingerprint,
          input: validated.value,
        });
      }
    }

    const nextPlanVersion =
      Math.max(
        0,
        ...this.snapshot.executionPlans.map((planRecord) => planRecord.version),
      ) + 1;
    this.unitOfWork.completeModelCallWithPlan({
      modelCallId: input.modelCallId,
      response: input.response,
      durationMs: input.durationMs,
      plan: {
        id: randomUUID(),
        version: nextPlanVersion,
        steps: planSteps,
        toolRuns,
      },
    }, this.ownershipContext(), () =>
      this.options.authority.assertActive());
    this.schedulePlan = plan;
    this.validatedInputs = validatedInputs;
    this.refresh();
  }

  createSchedulerContext(signal: AbortSignal): TaskSchedulerContext {
    return {
      taskId: this.taskId,
      signal,
      persistence: this,
      validatedInputs: this.validatedInputs,
      ...(this.schedulePlan === undefined
        ? {}
        : { schedulePlan: this.schedulePlan }),
    };
  }

  getLoopGuardHistory(toolCalls: readonly ToolCall[]): {
    readonly eligible: boolean;
    readonly rounds: readonly LoopGuardRound[];
  } {
    this.options.authority.assertActive();
    this.refresh();
    const callIds = new Set(toolCalls.map((call) => call.id));
    const currentRuns = this.snapshot.toolRuns.filter((run) => callIds.has(run.toolCallId));
    if (currentRuns.length !== callIds.size || currentRuns.some((run) => run.status !== "queued")) {
      return { eligible: false, rounds: [] };
    }
    const currentStepIds = new Set(currentRuns.map((run) => run.planStepId));
    const currentPlanIds = new Set(this.snapshot.planSteps
      .filter((step) => currentStepIds.has(step.id))
      .map((step) => step.planId));
    if (currentPlanIds.size !== 1) return { eligible: false, rounds: [] };
    const currentPlanId = [...currentPlanIds][0] as string;
    const currentPlan = this.snapshot.executionPlans.find((plan) => plan.id === currentPlanId);
    if (currentPlan?.status !== "active") return { eligible: false, rounds: [] };

    const rounds = this.snapshot.agentExecutionPlans
      .filter((plan) => plan.id !== currentPlanId)
      .sort((left, right) => left.version - right.version)
      .map((plan): LoopGuardRound => {
        const stepIds = new Set(this.snapshot.planSteps
          .filter((step) => step.planId === plan.id)
          .map((step) => step.id));
        const entries = this.snapshot.toolRuns
          .filter((run) => stepIds.has(run.planStepId))
          .sort((left, right) => left.originalIndex - right.originalIndex)
          .filter((run) => ["succeeded", "failed", "timed_out", "cancelled", "skipped", "unknown"].includes(run.status))
          .map((run): LoopGuardEntry => ({
            ...computeToolCallSignature({ name: run.toolName, arguments: run.input }),
            mode: run.mode,
            outcome: run.status as LoopGuardEntry["outcome"],
            ...(run.output !== null
              ? { resultDigest: sha256CanonicalJson(run.output) }
              : run.error === null ? {} : { resultDigest: sha256CanonicalJson(run.error) }),
          }));
        return { entries };
      });
    return { eligible: true, rounds };
  }

  pauseForLoopGuard(
    toolCalls: readonly ToolCall[],
    decision: LoopGuardDecision,
  ): void {
    this.options.authority.assertActive();
    this.refresh();
    this.snapshot = this.options.stateMachine.pauseForLoopGuard({
      ...this.ownershipContext(),
      expectedTaskVersion: this.snapshot.task.version,
      toolCallIds: toolCalls.map((call) => call.id),
      decision,
    });
  }

  getTokenBudgetState() {
    this.options.authority.assertActive();
    this.options.leaseManager.assertOwned(
      this.taskId,
      this.options.ownership.leaseToken,
      this.options.ownership.fencingToken,
    );
    this.refresh();
    return {
      maxTokens: this.snapshot.task.maxTokens,
      usage: this.snapshot.task.tokenUsage,
    };
  }

  pauseForTokenBudget(input: {
    readonly estimatedNextPromptTokens: number;
    readonly reservedCompletionTokens: number;
    readonly conservativeUnknownTokens: number;
    readonly usageUncertain: boolean;
  }): void {
    this.options.authority.assertActive();
    this.refresh();
    this.snapshot = this.options.stateMachine.pauseForTokenBudget({
      ...this.ownershipContext(),
      expectedTaskVersion: this.snapshot.task.version,
      ...input,
    });
  }

  pauseForGlobalModelBudget(input: {
    readonly estimatedNextPromptTokens: number;
    readonly reservedCompletionTokens: number;
    readonly reason: "daily_budget_exhausted" | "provider_concurrency_exhausted";
  }): void {
    this.options.authority.assertActive();
    this.refresh();
    this.snapshot = this.options.stateMachine.pauseForGlobalModelBudget({
      ...this.ownershipContext(),
      expectedTaskVersion: this.snapshot.task.version,
      ...input,
    });
  }

  finishRun(result: AgentRunResult): void {
    this.options.authority.assertActive();
    if (result.status === "limit_reached") {
      this.finalizeUnstartedToolRuns();
    }
    const snapshot = this.snapshotReader.load(this.taskId);
    if (result.status === "write_outcome_unknown") {
      return;
    }
    if (result.status === "paused") {
      return;
    }
    if (result.stopReason === "persistence_failed") {
      return;
    }
    if (result.status === "completed") {
      this.options.stateMachine.transitionTask({
        ...this.ownershipContext(),
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: snapshot.task.status,
        status: "completed",
        finalAnswer: result.finalAnswer,
      });
      return;
    }
    if (result.status === "cancelled") {
      if (snapshot.task.status === "running") {
        this.options.stateMachine.requestCancel({
          ...this.ownershipContext(),
          expectedTaskVersion: snapshot.task.version,
        });
      }
      return;
    }
    if (snapshot.task.status === "running") {
      this.options.stateMachine.transitionTask({
        ...this.ownershipContext(),
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "running",
        status: "failed",
      });
    }
  }

  beforeExecute(task: { readonly toolCallId: string }): void {
    this.options.authority.assertActive();
    this.refresh();
    const run = this.findToolRun(task.toolCallId);
    if (run.status !== "queued") {
      throw new AppError({
        code: "TOOL_RUN_ALREADY_STARTED",
        message: "Persisted tool run is not queued for a new execution.",
        statusCode: 409,
        details: [],
      });
    }
    const step = this.snapshot.planSteps.find((item) => item.id === run.planStepId);
    if (step === undefined) {
      throw new AppError({
        code: "TOOL_RUN_ADMISSION_STATE_CONFLICT",
        message: "The persisted plan step is missing.",
        statusCode: 409,
        details: [],
      });
    }
    this.unitOfWork.beginOwnedToolRunAfterWriteBarrier({
      toolRunId: run.id,
      expectedToolRunVersion: run.version,
      expectedPlanStepVersion: step.version,
      ownership: this.ownershipContext(),
    }, () => this.options.authority.assertActive());
    this.refresh();
  }

  persistReadResult(
    task: { readonly toolCallId: string },
    result: {
      readonly status: "succeeded" | "failed" | "timed_out" | "cancelled";
      readonly output?: unknown;
      readonly error?: AgentToolError;
    },
  ): void {
    this.options.authority.assertActive();
    let status = result.status;
    let output = result.output;
    let error = result.error;
    if (status === "succeeded") {
      try {
        assertCanonicalJsonValue(output);
      } catch {
        status = "failed";
        output = undefined;
        error = {
          code: "TOOL_OUTPUT_NOT_SERIALIZABLE",
          message: "Tool output must be JSON-compatible data.",
          details: [],
        };
      }
    }
    const run = this.findToolRun(task.toolCallId);
    this.unitOfWork.completeOwnedToolRun({
      toolRunId: run.id,
      expectedToolRunVersion: run.version,
      status,
      ...(output === undefined ? {} : { output: output as never }),
      ...(error === undefined ? {} : { error: toPersistedError(error) }),
      ownership: this.ownershipContext(),
    }, () => this.options.authority.assertActive());
    this.refresh();
  }

  persistWriteResult(
    task: { readonly toolCallId: string },
    result: {
      readonly status: "succeeded" | "failed" | "skipped" | "unknown" | "cancelled";
      readonly output?: unknown;
      readonly error?: AgentToolError;
    },
  ): void {
    this.options.authority.assertActive();
    this.refresh();
    const run = this.findToolRun(task.toolCallId);
    if (run.status === "awaiting_approval" &&
        this.snapshot.approvals.some((approval) => approval.toolRunId === run.id && approval.status === "pending") &&
        ["cancelled", "skipped"].includes(result.status)) {
      return;
    }
    if (run.status === "unknown" && result.status === "unknown") {
      return;
    }
    if ((run.status === "skipped" && result.status === "skipped") ||
        (run.status === "cancelled" && result.status === "cancelled")) {
      return;
    }
    if (
      ["queued", "awaiting_approval"].includes(run.status) &&
      result.status !== "succeeded"
    ) {
      this.unitOfWork.finalizeOwnedToolRunBeforeStart({
        toolRunId: run.id,
        expectedToolRunVersion: run.version,
        status:
          result.status === "cancelled"
            ? "cancelled"
            : result.status === "skipped"
              ? "skipped"
              : "failed",
        error:
          result.error === undefined
            ? {
                code: "WRITE_PRE_EXECUTION_FAILED",
                message: "The write was not started.",
                details: [],
              }
            : toPersistedError(result.error),
        ownership: this.ownershipContext(),
      }, () => this.options.authority.assertActive());
      this.refresh();
      return;
    }
    const status =
      result.status === "succeeded" ? "succeeded" : "unknown";
    try {
      this.unitOfWork.completeOwnedToolRun({
        toolRunId: run.id,
        expectedToolRunVersion: run.version,
        status,
        ...(status === "succeeded" && result.output !== undefined
          ? { output: result.output as never }
          : {}),
        ...(result.error === undefined
          ? {}
          : { error: toPersistedError(result.error) }),
        ownership: this.ownershipContext(),
      }, () => this.options.authority.assertActive());
      this.refresh();
      if (result.status !== "succeeded" && status !== "unknown") {
        throw new AppError({
          code: "WRITE_OUTCOME_UNKNOWN",
          message: "The write outcome is unknown.",
          statusCode: 409,
          details: [],
        });
      }
    } catch (error) {
      this.refresh();
      const current = this.findToolRun(task.toolCallId);
      if (current.status === "unknown") {
        throw error;
      }
      this.unitOfWork.completeOwnedToolRun({
        toolRunId: current.id,
        expectedToolRunVersion: current.version,
        status: "unknown",
        error: {
          code: "WRITE_OUTCOME_UNKNOWN",
          message: "The write outcome is unknown and must not be retried.",
          details: [],
        },
        ownership: this.ownershipContext(),
      }, () => this.options.authority.assertActive());
      this.refresh();
      throw error;
    }
  }

  private findToolRun(toolCallId: string) {
    const run = this.toolRuns
      .listByTask(this.taskId)
      .find((candidate) => candidate.toolCallId === toolCallId);
    if (run === undefined) {
      throw new AppError({
        code: "TOOL_RUN_NOT_FOUND",
        message: "Persisted tool run was not found for the tool call.",
        statusCode: 404,
        details: [],
      });
    }
    return run;
  }

  private finalizeUnstartedToolRuns(): void {
    const unstarted = this.toolRuns
      .listByTask(this.taskId)
      .filter((run) => ["queued", "awaiting_approval"].includes(run.status));
    for (const run of unstarted) {
      this.unitOfWork.finalizeOwnedToolRunBeforeStart({
        toolRunId: run.id,
        expectedToolRunVersion: run.version,
        status: "skipped",
        error: {
          code: "TOOL_CALL_LIMIT_REACHED",
          message:
            "The tool call was not started because the task reached its configured limit.",
          details: [],
        },
        ownership: this.ownershipContext(),
      }, () => this.options.authority.assertActive());
      this.refresh();
    }
  }

  private refresh(): void {
    this.snapshot = this.snapshotReader.load(this.taskId);
  }

  private ownershipContext() {
    return {
      taskId: this.taskId,
      leaseToken: this.options.ownership.leaseToken,
      fencingToken: this.options.ownership.fencingToken,
    };
  }
}

function parseToolArguments(argumentsValue: ToolCall["arguments"]): unknown {
  if (typeof argumentsValue !== "string") {
    return argumentsValue;
  }
  try {
    return JSON.parse(argumentsValue) as unknown;
  } catch {
    throw new AppError({
      code: "TOOL_ARGUMENTS_JSON_INVALID",
      message: "Tool arguments were not valid JSON.",
      statusCode: 400,
      details: [],
    });
  }
}

function toAgentMessage(message: TaskSnapshot["messages"][number]): AgentMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content,
      ...(message.toolCalls === null
        ? {}
        : { toolCalls: [...message.toolCalls] }),
    };
  }
  if (message.role === "tool") {
    return {
      role: "tool",
      toolCallId: message.toolCallId as string,
      content: message.content,
    };
  }
  return {
    role: message.role,
    content: message.content,
  };
}

function toPersistedError(error: AgentToolError) {
  return {
    code: error.code,
    message: error.message,
    details: [...error.details],
  };
}
