import {
  AgentRunner,
  type AgentRunOptions,
} from "../agent/agent-runner.js";
import type { AgentRunInput, AgentRunResult } from "../agent/types.js";
import type { ContextManager } from "../context/index.js";
import type { LoopGuard } from "../loop-guard/index.js";
import type { LLMProvider } from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import type { TaskScheduler } from "../scheduler/index.js";
import {
  ExecutionStateMachine,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../storage/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { EvidencePayloadStore } from "../recovery/evidence-payload-store.js";
import { resolveUnknownWriteSettlement } from "../recovery/recovery-unknown-write-settlement.js";
import { PersistentExecutionBridge } from "./execution-bridge.js";
import {
  ExecutionAuthority,
  LeaseHeartbeat,
} from "./lease-heartbeat.js";
import { assertSafeToStartPersistentRun } from "./recovery-gate.js";

export interface PersistenceCoordinatorOptions {
  readonly database: ForgeFlowDatabase;
  readonly leaseManager: TaskLeaseManager;
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly scheduler: TaskScheduler;
  readonly finalReviewPayloadStore?: EvidencePayloadStore;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly heartbeatIntervalMs?: number;
  readonly contextManager?: ContextManager;
  readonly loopGuard?: LoopGuard;
}

export class PersistenceCoordinator {
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly stateMachine: ExecutionStateMachine;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly options: PersistenceCoordinatorOptions) {
    this.snapshotReader = new TaskSnapshotReader(options.database);
    this.stateMachine = new ExecutionStateMachine(
      options.database,
      options.leaseManager,
    );
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      options.leaseManager.recommendedHeartbeatIntervalMs;
    if (
      !Number.isInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs <= 0
    ) {
      throw new AppError({
        code: "PERSISTENCE_HEARTBEAT_INTERVAL_INVALID",
        message: "Heartbeat interval must be a positive integer.",
        statusCode: 500,
        details: [],
      });
    }
  }

  async run(
    taskId: string,
    ownerId: string,
    runOptions: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.runInternal(taskId, ownerId, runOptions, false);
  }

  async resume(
    taskId: string,
    ownerId: string,
    runOptions: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    return this.runInternal(taskId, ownerId, runOptions, true);
  }

  private async runInternal(
    taskId: string,
    ownerId: string,
    runOptions: AgentRunOptions,
    resume: boolean,
  ): Promise<AgentRunResult> {
    const lease = this.options.leaseManager.claim(taskId, ownerId);
    const ownership = {
      taskId,
      leaseToken: lease.leaseToken as string,
      fencingToken: lease.fencingToken,
    };
    const authority = new ExecutionAuthority();
    const heartbeat = new LeaseHeartbeat(
      this.options.leaseManager,
      ownership,
      this.heartbeatIntervalMs,
      authority,
    );
    heartbeat.start();
    const executionSignal =
      runOptions.signal === undefined
        ? heartbeat.signal
        : AbortSignal.any([runOptions.signal, heartbeat.signal]);
    let result: AgentRunResult | undefined;
    let failure: unknown;

    try {
      result = await this.executeOwned(
        taskId,
        ownership,
        authority,
        { signal: executionSignal },
        resume,
      );
      if (heartbeat.failure !== undefined) {
        throw new AppError({
          code: "TASK_LEASE_HEARTBEAT_FAILED",
          message: "Task lease heartbeat failed during persistent execution.",
          statusCode: 409,
          details: [],
          cause: heartbeat.failure,
        });
      }
    } catch (error) {
      failure =
        heartbeat.failure === undefined
          ? error
          : new AppError({
              code: "TASK_LEASE_HEARTBEAT_FAILED",
              message: "Task lease heartbeat failed during persistent execution.",
              statusCode: 409,
              details: [],
              cause: heartbeat.failure,
            });
    }
    await heartbeat.stop();

    let releaseFailure: unknown;
    try {
      this.options.leaseManager.release(
        taskId,
        ownership.leaseToken,
        ownership.fencingToken,
      );
    } catch (error) {
      releaseFailure = error;
    }

    if (failure !== undefined && releaseFailure !== undefined) {
      throw new AggregateError(
        [failure, releaseFailure],
        "Persistent execution and lease release both failed.",
      );
    }
    if (releaseFailure !== undefined) {
      throw new AppError({
        code: "TASK_LEASE_RELEASE_FAILED",
        message: "Persistent execution completed but lease release failed.",
        statusCode: 500,
        details: [],
        cause: releaseFailure,
      });
    }
    if (failure !== undefined) {
      throw failure;
    }
    return result as AgentRunResult;
  }

  async runOwned(
    taskId: string,
    ownership: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    },
    runOptions: AgentRunOptions = {},
  ): Promise<AgentRunResult> {
    if (ownership.taskId !== taskId) {
      throw new AppError({
        code: "TASK_LEASE_NOT_OWNED",
        message: "Task lease ownership does not match the task.",
        statusCode: 409,
        details: [],
      });
    }
    this.options.leaseManager.assertOwned(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
    return this.executeOwned(
      taskId,
      ownership,
      new ExecutionAuthority(),
      runOptions,
    );
  }

  private async executeOwned(
    taskId: string,
    ownership: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    },
    authority: ExecutionAuthority,
    runOptions: AgentRunOptions,
    resume = false,
  ): Promise<AgentRunResult> {
    let snapshot = this.snapshotReader.load(taskId);
    if (!resume) assertSafeToStartPersistentRun(snapshot);
    else {
      if (snapshot.task.status === "paused" &&
          snapshot.events.some((event) => event.type === "loop_detected")) {
        throw new AppError({
          code: "TASK_LOOP_GUARD_BLOCKED",
          message: "Task remains paused because the detected loop has not been resolved.",
          statusCode: 409,
          details: [],
        });
      }
      if (snapshot.task.status === "paused" &&
          snapshot.events.some((event) => event.type === "token_budget_exhausted")) {
        throw new AppError({
          code: "TASK_TOKEN_BUDGET_EXHAUSTED",
          message: "Task remains paused because its cumulative token budget is exhausted.",
          statusCode: 409,
          details: [],
        });
      }
      if (snapshot.task.cancelRequestedAt !== null ||
          snapshot.recoveryReviews.some((review) => ["pending", "unresolved"].includes(review.status)) ||
          snapshot.toolRuns.some((run) => (run.status === "unknown" &&
            (this.options.finalReviewPayloadStore === undefined ||
              resolveUnknownWriteSettlement(snapshot, run.id, this.options.finalReviewPayloadStore) !== "resolved_success")) ||
            (run.mode === "write" && run.status === "running")) ||
          snapshot.approvals.some((approval) => approval.status === "pending")) {
        throw new AppError({ code: "TASK_RECOVERY_BLOCKED", message: "Task has an unresolved recovery boundary.", statusCode: 409 });
      }
    }
    if (!["queued", "running", ...(resume ? ["paused", "waiting_approval"] : [])].includes(snapshot.task.status)) {
      throw new AppError({
        code: "TASK_NOT_EXECUTABLE",
        message: "Task is not in an executable state.",
        statusCode: 409,
        details: [],
      });
    }
    if (snapshot.task.status === "queued") {
      this.stateMachine.transitionTask({
        ...ownership,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "queued",
        status: "running",
      });
      snapshot = this.snapshotReader.load(taskId);
    } else if (resume && (snapshot.task.status === "paused" || snapshot.task.status === "waiting_approval")) {
      this.stateMachine.transitionTask({
        ...ownership,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: snapshot.task.status,
        status: "running",
      });
      snapshot = this.snapshotReader.load(taskId);
    }

    const bridge = new PersistentExecutionBridge({
      database: this.options.database,
      leaseManager: this.options.leaseManager,
      stateMachine: this.stateMachine,
      scheduler: this.options.scheduler,
      registry: this.options.registry,
      ...(this.options.finalReviewPayloadStore === undefined ? {} :
        { finalReviewPayloadStore: this.options.finalReviewPayloadStore }),
      snapshot,
      ownership,
      authority,
    });
    const runner = new AgentRunner({
      provider: this.options.provider,
      registry: this.options.registry,
      model: this.options.model,
      scheduler: this.options.scheduler,
      persistence: bridge,
      ...(this.options.contextManager === undefined
        ? {}
        : { contextManager: this.options.contextManager }),
      ...(this.options.loopGuard === undefined
        ? {}
        : { loopGuard: this.options.loopGuard }),
      maxModelTurns: snapshot.task.maxModelTurns,
      maxToolCalls: snapshot.task.maxToolCalls,
      ...(this.options.systemPrompt === undefined
        ? {}
        : { systemPrompt: this.options.systemPrompt }),
    });
    return runner.run(
      { objective: snapshot.task.objective } satisfies AgentRunInput,
      runOptions,
    );
  }
}
