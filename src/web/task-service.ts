import { createHash, randomUUID } from "node:crypto";

import type { ContextManager } from "../context/index.js";
import type { LoopGuard } from "../loop-guard/index.js";
import {
  McpStdioClientAdapter,
  createInventoryDemoMcpConfig,
  registerMcpTools,
} from "../mcp/index.js";
import { createStm32DemoRuntime } from "../tools/demo/stm32.js";
import { RecoveryManager } from "../recovery/recovery-manager.js";
import {
  PersistenceCoordinator,
} from "../persistence/index.js";
import type {
  LLMProvider,
  ModelUsage,
  TokenUsageAggregate,
} from "../provider/types.js";
import {
  ReadWorkerPool,
  TaskPlanner,
  TaskScheduler,
  WriteExecutor,
} from "../scheduler/index.js";
import { AppError } from "../shared/errors.js";
import { ObservabilityMetricsService } from "../observability/index.js";
import { EvaluationRunner, PHASE6_1_EVALUATION_SUITE, Phase61ReferenceExecutor } from "../evaluation/index.js";
import type { EvaluationRunRecord } from "../evaluation/index.js";
import {
  ExecutionUnitOfWork,
  ExecutionStateMachine,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
  type TaskSnapshot,
  type TaskStatus,
} from "../storage/index.js";
import {
  WebApprovalRegistry,
  type WebApprovalView,
} from "./approvals.js";
import type { WebConfig } from "./config.js";
import {
  buildWorkflowObjective,
  createWorkflowMockProvider,
  getWorkflow,
  type WorkflowId,
  WORKFLOWS,
  WorkflowIdSchema,
} from "./workflows.js";

export type WebProviderMode =
  | { readonly kind: "mock"; readonly label: "Mock" }
  | {
      readonly kind: "deepseek";
      readonly label: "DeepSeek";
      readonly provider: LLMProvider;
      readonly model: string;
    };

interface ActiveExecution {
  readonly actorId: string;
  readonly abortController: AbortController;
  promise: Promise<void>;
  error: unknown;
}

interface TaskRow {
  readonly id: string;
  readonly trace_id: string;
  readonly status: string;
  readonly objective: string;
  readonly created_at: string;
  readonly updated_at: string;
  readonly completed_at: string | null;
  readonly max_model_turns: number;
  readonly max_tool_calls: number;
  readonly token_usage_json: string;
}

export interface WebTaskSummary {
  readonly id: string;
  readonly objective: string;
  readonly workflowId: WorkflowId;
  readonly workflowName: string;
  readonly status: TaskStatus | "error" | "interrupted";
  readonly persistedStatus: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly active: boolean;
  readonly pendingApprovalCount: number;
  readonly modelCalls: number;
  readonly maxModelTurns: number;
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly tokenUsage: TokenUsageAggregate;
  readonly tokenBudget: {
    readonly maxTokens: number | null;
    readonly usedTokens: number;
    readonly remainingTokens: number | null;
    readonly exhausted: boolean;
  };
  readonly safeguards: {
    readonly loopGuardTriggered: boolean;
    readonly tokenBudgetExhausted: boolean;
    readonly globalModelBudgetExhausted: boolean;
  };
  readonly finalAnswer: string | null;
  readonly error: { readonly code: string; readonly message: string } | null;
}

export interface WebTaskDetail extends WebTaskSummary {
  readonly messages: readonly {
    readonly sequence: number;
    readonly role: string;
    readonly content: string;
    readonly toolCallId: string | null;
  }[];
  readonly modelCallDetails: readonly {
    readonly iteration: number;
    readonly status: string;
    readonly finishReason: string | null;
    readonly durationMs: number | null;
    readonly usage: ModelUsage | null;
  }[];
  readonly plans: readonly {
    readonly id: string;
    readonly version: number;
    readonly status: string;
    readonly createdAt: string;
  }[];
  readonly planSteps: readonly {
    readonly id: string;
    readonly planId: string;
    readonly stepIndex: number;
    readonly kind: string;
    readonly status: string;
  }[];
  readonly toolRuns: readonly {
    readonly id: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly mode: string;
    readonly status: string;
    readonly input: unknown;
    readonly output: unknown;
    readonly error: unknown;
    readonly startedAt: string | null;
    readonly finishedAt: string | null;
  }[];
  readonly events: readonly {
    readonly sequence: number;
    readonly type: string;
    readonly entityType: string | null;
    readonly entityId: string | null;
    readonly payload: unknown;
    readonly createdAt: string;
  }[];
  readonly checkpoints: readonly {
    readonly sequence: number;
    readonly reason: string;
    readonly taskStatus: string;
    readonly modelIteration: number;
    readonly createdAt: string;
  }[];
  readonly approvals: readonly WebApprovalView[];
  readonly lease: {
    readonly ownerId: string | null;
    readonly fencingToken: number;
    readonly expiresAt: string | null;
    readonly heartbeatAt: string;
  } | null;
}

export interface WebDashboardData {
  readonly stats: {
    readonly totalTasks: number;
    readonly activeTasks: number;
    readonly pendingApprovals: number;
    readonly completedTasks: number;
    readonly failedTasks: number;
  };
  readonly recentTasks: readonly WebTaskSummary[];
  readonly provider: {
    readonly kind: WebProviderMode["kind"];
    readonly label: string;
  };
  readonly workflows: readonly {
    readonly id: WorkflowId;
    readonly name: string;
    readonly description: string;
  }[];
}

export interface WebWorkflowView {
  readonly id: WorkflowId;
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly defaultObjective: string;
}

export class WebTaskService {
  private readonly snapshots: TaskSnapshotReader;
  private readonly approvals: WebApprovalRegistry;
  private readonly active = new Map<string, ActiveExecution>();
  private readonly executionErrors = new Map<string, unknown>();
  private evaluationRun: Promise<EvaluationRunRecord> | undefined;

  constructor(
    private readonly database: ForgeFlowDatabase,
    private readonly config: WebConfig,
    private readonly providerMode: WebProviderMode,
    private readonly contextManager?: ContextManager,
    private readonly loopGuard?: LoopGuard,
  ) {
    this.snapshots = new TaskSnapshotReader(database);
    this.approvals = new WebApprovalRegistry(database);
  }

  listWorkflows(): readonly WebWorkflowView[] {
    return WORKFLOWS.map(({ id, name, description, category, defaultObjective }) => ({
      id,
      name,
      description,
      category,
      defaultObjective,
    }));
  }

  metricsSummary(actorId: string) {
    return new ObservabilityMetricsService(this.database).summary(this.actorPrefix(actorId));
  }

  evaluationHistory(limit = 50) {
    return new ObservabilityMetricsService(this.database).evaluationHistory(limit);
  }

  evaluationReport(runId: string) {
    return new ObservabilityMetricsService(this.database).evaluationReport(runId);
  }

  async runEvaluation(): Promise<EvaluationRunRecord> {
    if (this.evaluationRun !== undefined) {
      throw new AppError({
        code: "WEB_EVALUATION_ALREADY_RUNNING",
        message: "The preset evaluation suite is already running.",
        statusCode: 409,
      });
    }
    const cutoff = new Date(Date.now() - 60 * 60 * 1_000).toISOString();
    const recentRuns = this.database.prepare(`
      SELECT COUNT(*) AS count
      FROM evaluation_runs
      WHERE started_at >= ?
    `).get(cutoff) as { count: number };
    if (recentRuns.count >= this.config.evaluationRunsPerHour) {
      throw new AppError({
        code: "WEB_EVALUATION_RATE_LIMIT",
        message: "The global evaluation start limit has been reached.",
        statusCode: 429,
      });
    }
    const run = new EvaluationRunner(this.database, new Phase61ReferenceExecutor(), {
      providerId: "mock+deterministic-tools",
      configVersion: "phase6.1-v1",
    }).run(PHASE6_1_EVALUATION_SUITE);
    this.evaluationRun = run;
    try {
      return await run;
    } finally {
      this.evaluationRun = undefined;
    }
  }

  async dashboard(actorId: string): Promise<WebDashboardData> {
    const tasks = this.listTasks(actorId, 50);
    const pendingApprovals = this.listApprovals(actorId);
    return {
      stats: {
        totalTasks: tasks.length,
        activeTasks: tasks.filter((task) => task.active).length,
        pendingApprovals: pendingApprovals.length,
        completedTasks: tasks.filter((task) => task.persistedStatus === "completed")
          .length,
        failedTasks: tasks.filter((task) => task.status === "failed" || task.status === "error")
          .length,
      },
      recentTasks: tasks.slice(0, 8),
      provider: {
        kind: this.providerMode.kind,
        label: this.providerMode.label,
      },
      workflows: WORKFLOWS.map(({ id, name, description }) => ({
        id,
        name,
        description,
      })),
    };
  }

  listTasks(actorId: string, limit = 50): readonly WebTaskSummary[] {
    const rows = this.database
      .prepare(
        `
          SELECT id, trace_id, status, objective, created_at, updated_at,
                 completed_at, max_model_turns, max_tool_calls, token_usage_json
          FROM tasks
          WHERE trace_id LIKE ?
          ORDER BY created_at DESC
          LIMIT ?
        `,
      )
      .all(`${this.actorPrefix(actorId)}%`, limit) as TaskRow[];
    return rows.map((row) => this.toSummary(row));
  }

  createTask(input: {
    readonly actorId: string;
    readonly workflowId: string;
    readonly objective: string;
    readonly buildQuantity?: number;
  }): WebTaskSummary {
    const workflowId = WorkflowIdSchema.parse(input.workflowId);
    const workflow = getWorkflow(workflowId);
    const objective = input.objective.trim();
    if (objective.length < 10 || objective.length > 4_000) {
      throw new AppError({
        code: "WEB_TASK_OBJECTIVE_INVALID",
        message: "Task objective must be between 10 and 4,000 characters.",
        statusCode: 400,
      });
    }
    const buildQuantity = input.buildQuantity ?? extractBuildQuantity(objective);
    if (!Number.isInteger(buildQuantity) || buildQuantity < 1 || buildQuantity > 100_000) {
      throw new AppError({
        code: "WEB_BUILD_QUANTITY_INVALID",
        message: "Build quantity must be an integer between 1 and 100,000.",
        statusCode: 400,
      });
    }
    if (this.activeCount(input.actorId) >= this.config.maxActiveTasks) {
      throw new AppError({
        code: "WEB_ACTIVE_TASK_LIMIT",
        message: "The active task limit has been reached.",
        statusCode: 429,
      });
    }
    if (this.dailyTaskCount(input.actorId) >= this.config.dailyTaskLimit) {
      throw new AppError({
        code: "WEB_DAILY_TASK_LIMIT",
        message: "The daily task limit has been reached.",
        statusCode: 429,
      });
    }
    if (this.providerMode.kind === "deepseek" &&
        this.dailyTaskCount(input.actorId) >= this.config.guestDailyModelTaskLimit) {
      throw new AppError({
        code: "WEB_DAILY_MODEL_TASK_LIMIT",
        message: "The guest daily model task limit has been reached.",
        statusCode: 429,
      });
    }

    const taskId = randomUUID();
    const traceId = `${this.actorPrefix(input.actorId)}${workflowId}:${taskId}`;
    new ExecutionUnitOfWork(this.database).createTask({
      taskId,
      traceId,
      objective: buildWorkflowObjective(workflowId, objective, buildQuantity),
      systemPrompt: workflow.systemPrompt,
      maxModelTurns: this.config.defaultModelTurns,
      maxToolCalls: this.config.defaultToolCalls,
      maxTokens: this.config.defaultTokenBudget,
    });
    this.startExecution(input.actorId, taskId, workflowId, buildQuantity);
    return this.getTaskSummary(input.actorId, taskId);
  }

  getTask(actorId: string, taskId: string): WebTaskDetail {
    this.assertTaskOwned(actorId, taskId);
    const runtime = this.active.get(taskId);
    const snapshot = this.snapshots.load(taskId);
    const summary = this.toSummaryFromSnapshot(snapshot, runtime);
    return {
      ...summary,
      messages: snapshot.messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          sequence: message.sequence,
          role: message.role,
          content: message.content,
          toolCallId: message.toolCallId,
        })),
      modelCallDetails: snapshot.modelCalls.map((call) => ({
        iteration: call.iteration,
        status: call.status,
        finishReason: call.finishReason,
        durationMs: call.durationMs,
        usage: call.usage,
      })),
      plans: snapshot.agentExecutionPlans.map((plan) => ({
        id: plan.id,
        version: plan.version,
        status: plan.status,
        createdAt: plan.createdAt,
      })),
      planSteps: snapshot.planSteps.map((step) => ({
        id: step.id,
        planId: step.planId,
        stepIndex: step.stepIndex,
        kind: step.kind,
        status: step.status,
      })),
      toolRuns: snapshot.toolRuns.map((run) => ({
        id: run.id,
        toolCallId: run.toolCallId,
        toolName: run.toolName,
        mode: run.mode,
        status: run.status,
        input: run.input,
        output: run.output,
        error: run.error,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
      events: snapshot.events.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        entityType: event.entityType,
        entityId: event.entityId,
        payload: event.payload,
        createdAt: event.createdAt,
      })),
      checkpoints: snapshot.checkpoints.map((checkpoint) => ({
        sequence: checkpoint.sequence,
        reason: checkpoint.reason,
        taskStatus: checkpoint.taskStatus,
        modelIteration: checkpoint.modelIteration,
        createdAt: checkpoint.createdAt,
      })),
      approvals: this.approvals.listForTask(taskId),
      lease:
        snapshot.lease === null
          ? null
          : {
              ownerId: snapshot.lease.ownerId,
              fencingToken: snapshot.lease.fencingToken,
              expiresAt: snapshot.lease.expiresAt,
              heartbeatAt: snapshot.lease.heartbeatAt,
            },
    };
  }

  getTaskEvents(
    actorId: string,
    taskId: string,
    afterSequence: number,
  ): WebTaskDetail["events"] {
    this.assertTaskOwned(actorId, taskId);
    return this.getTask(actorId, taskId).events.filter(
      (event) => event.sequence > afterSequence,
    );
  }

  listApprovals(actorId: string): readonly WebApprovalView[] {
    const rows = this.database.prepare("SELECT id FROM tasks WHERE trace_id LIKE ?")
      .all(`${this.actorPrefix(actorId)}%`) as Array<{ id: string }>;
    return this.approvals.listPending(rows.map((row) => row.id));
  }

  decideApproval(input: {
    readonly actorId: string;
    readonly approvalId: string;
    readonly decision: "approved" | "rejected";
    readonly reason?: string;
  }): WebApprovalView {
    const approval = this.approvals.get(input.approvalId);
    this.assertTaskOwned(input.actorId, approval.taskId);
    const leases = new TaskLeaseManager(this.database);
    const active = this.active.has(approval.taskId);
    const lease = active ? this.snapshots.load(approval.taskId).lease
      : leases.claim(approval.taskId, `web-approval-${randomUUID()}`);
    if (lease?.leaseToken == null) {
      throw new AppError({ code: "WEB_TASK_LEASE_UNAVAILABLE", message: "Task lease is unavailable.", statusCode: 409 });
    }
    try { return this.approvals.decide(
      input.approvalId,
      input.decision,
      input.reason,
      { taskId: approval.taskId, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken },
      (taskId) => {
        if (!this.active.has(taskId)) return;
        const snapshot = this.snapshots.load(taskId);
        const lease = snapshot.lease;
        if (snapshot.task.status !== "waiting_approval" || lease?.leaseToken == null) return;
        new ExecutionStateMachine(this.database, new TaskLeaseManager(this.database)).transitionTask({
          taskId,
          leaseToken: lease.leaseToken,
          fencingToken: lease.fencingToken,
          expectedTaskVersion: snapshot.task.version,
          expectedStatus: "waiting_approval",
          status: "running",
        });
      },
    ); } finally {
      if (!active) leases.release(approval.taskId, lease.leaseToken, lease.fencingToken);
    }
  }

  pauseTask(actorId: string, taskId: string): WebTaskSummary {
    this.assertTaskOwned(actorId, taskId);
    const active = this.active.get(taskId);
    const snapshot = this.snapshots.load(taskId);
    if (active === undefined || snapshot.task.status !== "running" || snapshot.lease?.leaseToken == null) {
      throw new AppError({ code: "WEB_TASK_NOT_PAUSABLE", message: "Task is not actively running.", statusCode: 409 });
    }
    new ExecutionStateMachine(this.database, new TaskLeaseManager(this.database)).transitionTask({
      taskId, leaseToken: snapshot.lease.leaseToken, fencingToken: snapshot.lease.fencingToken,
      expectedTaskVersion: snapshot.task.version, expectedStatus: "running", status: "pause_requested",
    });
    active.abortController.abort();
    return this.getTaskSummary(actorId, taskId);
  }

  cancelTask(actorId: string, taskId: string): WebTaskSummary {
    this.assertTaskOwned(actorId, taskId);
    const snapshot = this.snapshots.load(taskId);
    const active = this.active.get(taskId);
    const leases = new TaskLeaseManager(this.database);
    const lease = active === undefined
      ? leases.claim(taskId, `web-control-${randomUUID()}`)
      : snapshot.lease;
    if (lease?.leaseToken == null) {
      throw new AppError({ code: "WEB_TASK_LEASE_UNAVAILABLE", message: "Task lease is unavailable.", statusCode: 409 });
    }
    try {
      const ownership = { taskId, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken };
      if (snapshot.task.status === "waiting_approval" && snapshot.approvals.some((item) => item.status === "pending")) {
        this.approvals.cancelPending(taskId, ownership);
      } else {
        new ExecutionStateMachine(this.database, leases).requestCancel({
          ...ownership, expectedTaskVersion: this.snapshots.load(taskId).task.version,
        });
      }
    } finally {
      if (active === undefined) leases.release(taskId, lease.leaseToken, lease.fencingToken);
    }
    active?.abortController.abort();
    if (active === undefined) this.settleRequestedControl(taskId);
    return this.getTaskSummary(actorId, taskId);
  }

  resumeTask(actorId: string, taskId: string): WebTaskSummary {
    this.assertTaskOwned(actorId, taskId);
    if (this.active.has(taskId)) {
      throw new AppError({ code: "WEB_TASK_ALREADY_ACTIVE", message: "Task is already active.", statusCode: 409 });
    }
    let snapshot = this.snapshots.load(taskId);
    if (snapshot.task.status === "pause_requested" || snapshot.task.status === "cancel_requested") {
      this.settleRequestedControl(taskId);
      snapshot = this.snapshots.load(taskId);
    }
    if (!["queued", "running", "paused", "waiting_approval"].includes(snapshot.task.status) ||
        snapshot.task.cancelRequestedAt !== null ||
        snapshot.approvals.some((approval) => approval.status === "pending") ||
        snapshot.toolRuns.some((run) => run.status === "unknown" || (run.mode === "write" && run.status === "running")) ||
        snapshot.events.some((event) => [
          "loop_detected",
          "token_budget_exhausted",
          "global_model_budget_exhausted",
        ].includes(event.type))) {
      throw new AppError({ code: "WEB_TASK_RESUME_BLOCKED", message: "Task requires review or an approval decision before resuming.", statusCode: 409 });
    }
    const workflowId = workflowFromTrace(snapshot.task.traceId);
    const buildQuantity = extractBuildQuantity(snapshot.task.objective);
    this.startExecution(actorId, taskId, workflowId, buildQuantity, true);
    return this.getTaskSummary(actorId, taskId);
  }

  private settleRequestedControl(taskId: string): void {
    const leases = new TaskLeaseManager(this.database);
    const lease = leases.claim(taskId, `web-control-${randomUUID()}`);
    if (lease.leaseToken === null) throw new Error("Claimed lease has no token.");
    try {
      const ownership = { taskId, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken };
      let snapshot = this.snapshots.load(taskId);
      const machine = new ExecutionStateMachine(this.database, leases);
      if (snapshot.task.status === "pause_requested") {
        machine.transitionTask({ ...ownership, expectedTaskVersion: snapshot.task.version,
          expectedStatus: "pause_requested", status: "paused" });
      } else if (snapshot.task.status === "cancel_requested") {
        const unitOfWork = new ExecutionUnitOfWork(this.database, leases);
        for (const run of snapshot.toolRuns.filter((item) => ["queued", "awaiting_approval"].includes(item.status))) {
          unitOfWork.finalizeOwnedToolRunBeforeStart({
            toolRunId: run.id, expectedToolRunVersion: run.version, status: "cancelled",
            error: { code: "TASK_CANCELLED", message: "Task was cancelled before this tool started.", details: [] },
            ownership,
          });
        }
        snapshot = this.snapshots.load(taskId);
        if (!snapshot.toolRuns.some((run) => ["running", "interrupted", "unknown"].includes(run.status))) {
          machine.transitionTask({ ...ownership, expectedTaskVersion: snapshot.task.version,
            expectedStatus: "cancel_requested", status: "cancelled" });
        }
      }
    } finally {
      leases.release(taskId, lease.leaseToken, lease.fencingToken);
    }
  }

  async stop(): Promise<void> {
    const executions = Array.from(this.active.values());
    for (const execution of executions) {
      execution.abortController.abort();
    }
    await Promise.allSettled(executions.map((execution) => execution.promise));
  }

  private startExecution(
    actorId: string,
    taskId: string,
    workflowId: WorkflowId,
    buildQuantity: number,
    resume = false,
  ): void {
    const abortController = new AbortController();
    const execution: ActiveExecution = {
      actorId,
      abortController,
      promise: Promise.resolve(),
      error: undefined,
    };
    execution.promise = this.executeTask(
      taskId,
      workflowId,
      buildQuantity,
      abortController.signal,
      resume,
    )
      .catch((error: unknown) => {
        execution.error = error;
        this.executionErrors.set(taskId, error);
        process.stderr.write(
          `[web] task ${taskId} failed: ${safeErrorCode(error)}\n`,
        );
      })
      .finally(() => {
        this.active.delete(taskId);
        const status = this.snapshots.load(taskId).task.status;
        if (status === "pause_requested" || status === "cancel_requested") {
          try { this.settleRequestedControl(taskId); }
          catch (error) { process.stderr.write(`[web] task ${taskId} control settlement failed: ${safeErrorCode(error)}\n`); }
        }
      });
    this.active.set(taskId, execution);
  }

  private async executeTask(
    taskId: string,
    workflowId: WorkflowId,
    buildQuantity: number,
    signal: AbortSignal,
    resume: boolean,
  ): Promise<void> {
    const runtime = createStm32DemoRuntime();
    const mcpClient = workflowId === "stm32-mcp-inventory-audit"
      ? new McpStdioClientAdapter(createInventoryDemoMcpConfig())
      : undefined;
    try {
      if (mcpClient !== undefined) {
        await mcpClient.connect({ signal });
        await registerMcpTools(runtime.registry, mcpClient, signal);
      }
    if (resume) {
      let recoverySnapshot = this.snapshots.load(taskId);
      if (recoverySnapshot.task.status === "paused" &&
          recoverySnapshot.toolRuns.some((run) => run.mode === "read" && ["queued", "running", "interrupted"].includes(run.status))) {
        const leases = new TaskLeaseManager(this.database);
        const lease = leases.claim(taskId, `web-recovery-${randomUUID()}`);
        if (lease.leaseToken === null) throw new Error("Claimed lease has no token.");
        try {
          new ExecutionStateMachine(this.database, leases).transitionTask({
            taskId, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken,
            expectedTaskVersion: recoverySnapshot.task.version,
            expectedStatus: "paused", status: "running",
          });
        } finally { leases.release(taskId, lease.leaseToken, lease.fencingToken); }
        recoverySnapshot = this.snapshots.load(taskId);
      }
      if (recoverySnapshot.modelCalls.some((call) => call.status === "requested")) {
        const leases = new TaskLeaseManager(this.database);
        const lease = leases.claim(taskId, `web-recovery-${randomUUID()}`);
        if (lease.leaseToken === null) throw new Error("Claimed lease has no token.");
        try {
          const unitOfWork = new ExecutionUnitOfWork(this.database, leases);
          for (const call of recoverySnapshot.modelCalls.filter((item) => item.status === "requested")) {
            unitOfWork.failModelCall({ modelCallId: call.id, status: "interrupted", durationMs: 0,
              error: { code: "MODEL_CALL_INTERRUPTED", message: "Model call was interrupted by process restart.", details: [] } },
              { taskId, leaseToken: lease.leaseToken, fencingToken: lease.fencingToken });
          }
        } finally { leases.release(taskId, lease.leaseToken, lease.fencingToken); }
        recoverySnapshot = this.snapshots.load(taskId);
      }
      if (recoverySnapshot.toolRuns.some((run) => run.mode === "read" && ["queued", "running", "interrupted"].includes(run.status))) {
        await new RecoveryManager({
          database: this.database,
          leaseManager: new TaskLeaseManager(this.database),
          registry: runtime.registry,
        }).recoverReadRuns(taskId, `web-read-recovery-${randomUUID()}`, { signal });
      }
    }
    const planner = new TaskPlanner(runtime.registry);
    const scheduler = new TaskScheduler({
      registry: runtime.registry,
      planner,
      readWorkerPool: new ReadWorkerPool(runtime.registry, {
        maxConcurrency: 4,
      }),
      writeExecutor: new WriteExecutor(runtime.registry, {
        approvalHandler: this.approvals.createHandler(taskId),
        approvalTimeoutMs: this.config.approvalTimeoutMs,
      }),
    });
    const snapshot = this.snapshots.load(taskId);
    const coordinator = new PersistenceCoordinator({
      database: this.database,
      leaseManager: new TaskLeaseManager(this.database),
      provider:
        this.providerMode.kind === "mock"
          ? createWorkflowMockProvider(workflowId, buildQuantity,
              snapshot.modelCalls.filter((call) => call.status === "completed" && call.response?.message.toolCalls?.length).length)
          : this.providerMode.provider,
      registry: runtime.registry,
      scheduler,
      model: this.providerMode.kind === "mock" ? "mock-model" : this.providerMode.model,
      ...(this.contextManager === undefined
        ? {}
        : { contextManager: this.contextManager }),
      ...(this.loopGuard === undefined
        ? {}
        : { loopGuard: this.loopGuard }),
    });
    const result = await (resume ? coordinator.resume(taskId, `web-${randomUUID()}`, {
      signal,
    }) : coordinator.run(taskId, `web-${randomUUID()}`, {
      signal,
    }));
    if (!["completed", "write_outcome_unknown", "cancelled", "paused"].includes(result.status)) {
      throw new AppError({
        code: "WEB_TASK_EXECUTION_FAILED",
        message: `Task finished with status ${result.status}.`,
        statusCode: 500,
      });
    }
    } finally {
      await mcpClient?.close();
    }
  }

  private getTaskSummary(actorId: string, taskId: string): WebTaskSummary {
    this.assertTaskOwned(actorId, taskId);
    return this.toSummaryFromSnapshot(
      this.snapshots.load(taskId),
      this.active.get(taskId),
    );
  }

  private toSummary(row: TaskRow): WebTaskSummary {
    return this.toSummaryFromSnapshot(
      this.snapshots.load(row.id),
      this.active.get(row.id),
    );
  }

  private toSummaryFromSnapshot(
    snapshot: TaskSnapshot,
    runtime: ActiveExecution | undefined,
  ): WebTaskSummary {
    const workflowId = workflowFromTrace(snapshot.task.traceId);
    const pendingApprovalCount = this.approvals
      .listForTask(snapshot.task.id)
      .filter((approval) => approval.status === "pending").length;
    const interrupted = runtime === undefined &&
      !(snapshot.task.status === "waiting_approval" && pendingApprovalCount > 0) &&
      ["queued", "running", "waiting_approval", "pause_requested", "cancel_requested"].includes(snapshot.task.status);
    const executionError =
      runtime?.error ?? this.executionErrors.get(snapshot.task.id);
    const error = interrupted
      ? { code: "WEB_EXECUTION_INTERRUPTED", message: "Execution stopped after a server restart. Review the task before any further write." }
      : executionError === undefined
        ? snapshot.task.lastError === null
          ? null
          : {
              code: snapshot.task.lastError.code,
              message: snapshot.task.lastError.message,
            }
        : {
            code: safeErrorCode(executionError),
            message: "Task execution stopped before a final response.",
          };
    const status: WebTaskSummary["status"] =
      interrupted
        ? "interrupted"
        : pendingApprovalCount > 0
        ? "waiting_approval"
        : error !== null &&
            snapshot.task.status !== "completed" &&
            snapshot.task.status !== "cancelled"
          ? "error"
          : snapshot.task.status;
    return {
      id: snapshot.task.id,
      objective: snapshot.task.objective,
      workflowId,
      workflowName: getWorkflow(workflowId).name,
      status,
      persistedStatus: snapshot.task.status,
      createdAt: snapshot.task.createdAt,
      updatedAt: snapshot.task.updatedAt,
      completedAt: snapshot.task.completedAt,
      active:
        runtime !== undefined ||
        this.active.has(snapshot.task.id),
      pendingApprovalCount,
      modelCalls: snapshot.modelCalls.length,
      maxModelTurns: snapshot.task.maxModelTurns,
      toolCalls: snapshot.toolRuns.length,
      maxToolCalls: snapshot.task.maxToolCalls,
      tokenUsage: snapshot.task.tokenUsage,
      tokenBudget: {
        maxTokens: snapshot.task.maxTokens,
        usedTokens: snapshot.task.tokenUsage.totalTokens ?? 0,
        remainingTokens: snapshot.task.maxTokens === null
          ? null
          : Math.max(0, snapshot.task.maxTokens - (snapshot.task.tokenUsage.totalTokens ?? 0)),
        exhausted: snapshot.task.maxTokens !== null &&
          (snapshot.task.tokenUsage.totalTokens ?? 0) >= snapshot.task.maxTokens,
      },
      safeguards: {
        loopGuardTriggered: snapshot.events.some((event) => event.type === "loop_detected"),
        tokenBudgetExhausted: snapshot.events.some((event) => event.type === "token_budget_exhausted"),
        globalModelBudgetExhausted: snapshot.events.some((event) => event.type === "global_model_budget_exhausted"),
      },
      finalAnswer: snapshot.task.finalAnswer,
      error,
    };
  }

  private activeCount(actorId: string): number {
    return Array.from(this.active.values()).filter(
      (execution) => execution.actorId === actorId,
    ).length;
  }

  private dailyTaskCount(actorId: string): number {
    const row = this.database
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM tasks
          WHERE trace_id LIKE ?
            AND substr(created_at, 1, 10) = ?
        `,
      )
      .get(
        `${this.actorPrefix(actorId)}%`,
        new Date().toISOString().slice(0, 10),
      ) as { count: number };
    return row.count;
  }

  private assertTaskOwned(actorId: string, taskId: string): void {
    if (!this.isTaskOwned(actorId, taskId)) {
      throw new AppError({
        code: "WEB_TASK_NOT_FOUND",
        message: "Task was not found.",
        statusCode: 404,
      });
    }
  }

  private isTaskOwned(actorId: string, taskId: string): boolean {
    const row = this.database
      .prepare("SELECT trace_id FROM tasks WHERE id = ?")
      .get(taskId) as { trace_id: string } | undefined;
    return (
      row !== undefined &&
      row.trace_id.startsWith(this.actorPrefix(actorId))
    );
  }

  private actorPrefix(actorId: string): string {
    return `web:${createHash("sha256").update(actorId).digest("hex").slice(0, 16)}:`;
  }

}

function workflowFromTrace(traceId: string): WorkflowId {
  const workflowId = traceId.split(":")[2];
  const parsed = WorkflowIdSchema.safeParse(workflowId);
  if (!parsed.success) {
    throw new Error("Task workflow could not be resolved.");
  }
  return parsed.data;
}

function extractBuildQuantity(objective: string): number {
  const match = objective.match(
    /\b(\d{1,3}(?:,\d{3})+|\d+)\s*(?:boards?|units?|sets?)\b/i,
  );
  if (match?.[1] === undefined) {
    return 2_000;
  }
  return Number(match[1].replaceAll(",", ""));
}

function safeErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "WEB_INTERNAL_ERROR";
}
