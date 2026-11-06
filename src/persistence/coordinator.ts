import {
  AgentRunner,
  type AgentRunOptions,
} from "../agent/agent-runner.js";
import type { AgentRunInput, AgentRunResult } from "../agent/types.js";
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
import { PersistentExecutionBridge } from "./execution-bridge.js";
import { assertSafeToStartPersistentRun } from "./recovery-gate.js";

export interface PersistenceCoordinatorOptions {
  readonly database: ForgeFlowDatabase;
  readonly leaseManager: TaskLeaseManager;
  readonly provider: LLMProvider;
  readonly registry: ToolRegistry;
  readonly scheduler: TaskScheduler;
  readonly model: string;
  readonly systemPrompt?: string;
  readonly heartbeatIntervalMs?: number;
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
    const lease = this.options.leaseManager.claim(taskId, ownerId);
    const ownership = {
      taskId,
      leaseToken: lease.leaseToken as string,
      fencingToken: lease.fencingToken,
    };
    const heartbeat = new LeaseHeartbeat(
      this.options.leaseManager,
      ownership,
      this.heartbeatIntervalMs,
    );
    heartbeat.start();
    const executionSignal =
      runOptions.signal === undefined
        ? heartbeat.signal
        : AbortSignal.any([runOptions.signal, heartbeat.signal]);
    let result: AgentRunResult | undefined;
    let failure: unknown;

    try {
      result = await this.executeOwned(taskId, ownership, {
        signal: executionSignal,
      });
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
      failure = error;
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
    return this.executeOwned(taskId, ownership, runOptions);
  }

  private async executeOwned(
    taskId: string,
    ownership: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    },
    runOptions: AgentRunOptions,
  ): Promise<AgentRunResult> {
    let snapshot = this.snapshotReader.load(taskId);
    assertSafeToStartPersistentRun(snapshot);
    if (snapshot.task.status !== "queued" && snapshot.task.status !== "running") {
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
    }

    const bridge = new PersistentExecutionBridge({
      database: this.options.database,
      leaseManager: this.options.leaseManager,
      stateMachine: this.stateMachine,
      scheduler: this.options.scheduler,
      registry: this.options.registry,
      snapshot,
      ownership,
    });
    const runner = new AgentRunner({
      provider: this.options.provider,
      registry: this.options.registry,
      model: this.options.model,
      scheduler: this.options.scheduler,
      persistence: bridge,
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

class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;
  private readonly abortController = new AbortController();
  private heartbeatFailure: unknown;

  constructor(
    private readonly manager: TaskLeaseManager,
    private readonly ownership: {
      readonly taskId: string;
      readonly leaseToken: string;
      readonly fencingToken: number;
    },
    private readonly intervalMs: number,
  ) {}

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get failure(): unknown {
    return this.heartbeatFailure;
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.manager.heartbeat(
          this.ownership.taskId,
          this.ownership.leaseToken,
          this.ownership.fencingToken,
        );
      } catch (error) {
        this.fail(error);
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fail(error: unknown): void {
    if (this.heartbeatFailure !== undefined) {
      return;
    }
    this.heartbeatFailure = error;
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.abortController.abort(error);
  }
}
