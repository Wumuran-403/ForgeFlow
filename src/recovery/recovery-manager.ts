import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  PersistentExecutionBridge,
  ExecutionAuthority,
  LeaseHeartbeat,
} from "../persistence/index.js";
import {
  ReadWorkerPool,
  type PlannedKnownToolCall,
} from "../scheduler/index.js";
import {
  ExecutionStateMachine,
  ExecutionUnitOfWork,
  TaskLeaseManager,
  TaskSnapshotReader,
  type PlanStepRecord,
  type TaskSnapshot,
  type ToolRunRecord,
} from "../storage/index.js";
import type { ToolRegistry } from "../tools/registry.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../tools/fingerprint.js";
import type { ValidatedToolInput } from "../tools/types.js";
import { RecoveryClassifier } from "./recovery-classifier.js";
import { RecoveryScanner } from "./recovery-scanner.js";
import type {
  RecoveryCandidate,
  RecoveryClassification,
  RecoveryInspectionOwnership,
  RecoveryReport,
  ReadRecoveryOptions,
  ReadRecoveryResult,
} from "./recovery-types.js";

export interface RecoveryManagerOptions {
  readonly database: Database.Database;
  readonly leaseManager: TaskLeaseManager;
  readonly registry?: ToolRegistry;
  readonly now?: () => Date;
  readonly readWorkerPool?: ReadWorkerPool;
  readonly heartbeatIntervalMs?: number;
}

const READ_RECOVERY_BLOCKING_CLASSIFICATIONS = new Set<RecoveryClassification>([
  "state_inconsistent",
  "cancel_pending",
  "write_outcome_unknown",
  "review_pending",
  "approval_pending",
  "pause_pending",
  "model_call_interrupted",
]);

export class RecoveryManager {
  private readonly snapshotReader: TaskSnapshotReader;
  private readonly scanner: RecoveryScanner;
  private readonly classifier: RecoveryClassifier;
  private readonly now: () => Date;
  private readonly stateMachine: ExecutionStateMachine;
  private readonly readWorkerPool: ReadWorkerPool | undefined;
  private readonly heartbeatIntervalMs: number;

  constructor(private readonly options: RecoveryManagerOptions) {
    this.snapshotReader = new TaskSnapshotReader(options.database);
    this.scanner = new RecoveryScanner(options.database, {
      ...(options.now === undefined ? {} : { now: options.now }),
    });
    this.classifier = new RecoveryClassifier({
      ...(options.registry === undefined ? {} : { registry: options.registry }),
    });
    this.now = options.now ?? (() => new Date());
    this.stateMachine = new ExecutionStateMachine(
      options.database,
      options.leaseManager,
      options.now === undefined ? {} : { now: options.now },
    );
    this.readWorkerPool =
      options.readWorkerPool ??
      (options.registry === undefined
        ? undefined
        : new ReadWorkerPool(options.registry));
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      options.leaseManager.recommendedHeartbeatIntervalMs;
    if (
      !Number.isInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs <= 0
    ) {
      throw new AppError({
        code: "RECOVERY_HEARTBEAT_INTERVAL_INVALID",
        message: "Recovery heartbeat interval must be a positive integer.",
        statusCode: 500,
        details: [],
      });
    }
  }

  scan(): readonly RecoveryCandidate[] {
    return this.scanner.scan();
  }

  recoverTask(taskId: string, ownerId: string): RecoveryReport {
    return this.inspectTask(taskId, ownerId);
  }

  async recoverReadRuns(
    taskId: string,
    ownerId: string,
    options: ReadRecoveryOptions = {},
  ): Promise<ReadRecoveryResult> {
    const ownership = this.claimInspectionLease(taskId, ownerId);
    const authority = new ExecutionAuthority();
    const heartbeat = new LeaseHeartbeat(
      this.options.leaseManager,
      ownership,
      this.heartbeatIntervalMs,
      authority,
    );
    heartbeat.start();
    const signal =
      options.signal === undefined
        ? heartbeat.signal
        : AbortSignal.any([options.signal, heartbeat.signal]);
    let result: ReadRecoveryResult | undefined;
    let failure: unknown;

    try {
      result = await this.executeReadRecovery(ownership, signal, authority);
      if (heartbeat.failure !== undefined) {
        throw new AppError({
          code: "TASK_LEASE_HEARTBEAT_FAILED",
          message: "Task lease heartbeat failed during read recovery.",
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
              message: "Task lease heartbeat failed during read recovery.",
              statusCode: 409,
              details: [],
              cause: heartbeat.failure,
            });
    }
    await heartbeat.stop();

    let releaseFailure: unknown;
    try {
      this.releaseInspectionLease(ownership);
    } catch (error) {
      releaseFailure = error;
    }

    if (failure !== undefined && releaseFailure !== undefined) {
      throw new AggregateError(
        [failure, releaseFailure],
        "Read recovery and lease release both failed.",
      );
    }
    if (releaseFailure !== undefined) {
      throw new AppError({
        code: "RECOVERY_LEASE_RELEASE_FAILED",
        message: "Read recovery lease could not be released.",
        statusCode: 500,
        details: [],
        cause: releaseFailure,
      });
    }
    if (failure !== undefined) {
      throw failure;
    }
    return result as ReadRecoveryResult;
  }

  inspectTask(taskId: string, ownerId: string): RecoveryReport {
    const ownership = this.claimInspectionLease(taskId, ownerId);
    let report: RecoveryReport | undefined;
    let failure: unknown;
    try {
      report = this.inspectOwnedTask(ownership);
    } catch (error) {
      failure = error;
    }

    let releaseFailure: unknown;
    try {
      this.releaseInspectionLease(ownership);
    } catch (error) {
      releaseFailure = error;
    }

    if (failure !== undefined && releaseFailure !== undefined) {
      throw new AggregateError(
        [failure, releaseFailure],
        "Recovery inspection and lease release both failed.",
      );
    }
    if (releaseFailure !== undefined) {
      throw new AppError({
        code: "RECOVERY_LEASE_RELEASE_FAILED",
        message: "Recovery inspection lease could not be released.",
        statusCode: 500,
        details: [],
        cause: releaseFailure,
      });
    }
    if (failure !== undefined) {
      throw failure;
    }
    return report as RecoveryReport;
  }

  claimInspectionLease(
    taskId: string,
    ownerId: string,
  ): RecoveryInspectionOwnership {
    const lease = this.options.leaseManager.claim(taskId, ownerId);
    return {
      taskId,
      leaseToken: lease.leaseToken as string,
      fencingToken: lease.fencingToken,
    };
  }

  inspectOwnedTask(
    ownership: RecoveryInspectionOwnership,
  ): RecoveryReport {
    this.options.leaseManager.assertOwned(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
    let snapshot;
    try {
      snapshot = this.snapshotReader.load(ownership.taskId);
    } catch {
      const inspectedAt = this.now().toISOString();
      const report: RecoveryReport = {
        taskId: ownership.taskId,
        classification: "state_inconsistent",
        primaryClassification: "state_inconsistent",
        findings: [
          {
            classification: "state_inconsistent",
            code: "SNAPSHOT_INVALID",
            summary: "Persisted TaskSnapshot data could not be decoded safely.",
            entityType: "task",
            entityId: ownership.taskId,
          },
        ],
        blockingReasons: ["SNAPSHOT_INVALID"],
        recommendedNextAction: "manual_inspection",
        inspectedAt,
        fencingToken: ownership.fencingToken,
      };
      new ExecutionUnitOfWork(
        this.options.database,
        this.options.leaseManager,
      ).recordRecoveryInspectionWithoutSnapshot({
        ownership,
        expectedTaskVersion: this.options.database
          .prepare("SELECT version FROM tasks WHERE id = ?")
          .pluck()
          .get(ownership.taskId) as number,
        classification: "state_inconsistent",
        findingCount: 1,
        recommendedNextAction: "manual_inspection",
        inspectedAt,
      });
      return report;
    }
    const report = this.classifier.classify(snapshot, {
      fencingToken: ownership.fencingToken,
      inspectedAt: this.now().toISOString(),
    });
    new ExecutionUnitOfWork(
      this.options.database,
      this.options.leaseManager,
    ).recordRecoveryInspection({
      ownership,
      expectedTaskVersion: snapshot.task.version,
      classification: report.primaryClassification,
      findingCount: report.findings.length,
      recommendedNextAction: report.recommendedNextAction,
      inspectedAt: report.inspectedAt,
    });
    return report;
  }

  private async executeReadRecovery(
    ownership: RecoveryInspectionOwnership,
    signal: AbortSignal,
    authority: ExecutionAuthority,
  ): Promise<ReadRecoveryResult> {
    const report = this.inspectOwnedTask(ownership);
    this.assertReadRecoveryAllowed(report);
    let snapshot = this.snapshotReader.load(ownership.taskId);
    const step = findEarliestUnfinishedPlanStep(snapshot);
    if (step === undefined) {
      return {
        taskId: ownership.taskId,
        status: "no_work",
        report,
        requeuedCount: 0,
        results: [],
      };
    }
    if (step.kind !== "read_batch") {
      throw new AppError({
        code: "READ_RECOVERY_BLOCKED",
        message: "Read recovery cannot cross an unfinished non-read barrier.",
        statusCode: 409,
        details: [{ path: "planStepId", message: "Read barrier is blocked." }],
      });
    }

    const initialRuns = snapshot.toolRuns
      .filter(
        (run) =>
          run.planStepId === step.id &&
          run.mode === "read" &&
          ["queued", "running", "interrupted"].includes(run.status),
      )
      .sort((left, right) => left.originalIndex - right.originalIndex);
    if (initialRuns.length === 0) {
      return {
        taskId: ownership.taskId,
        status: "no_work",
        report,
        requeuedCount: 0,
        results: [],
      };
    }
    if (this.options.registry === undefined) {
      throw new AppError({
        code: "READ_RECOVERY_REGISTRY_REQUIRED",
        message: "Read recovery requires the active ToolRegistry.",
        statusCode: 500,
        details: [],
      });
    }
    if (this.readWorkerPool === undefined) {
      throw new AppError({
        code: "READ_RECOVERY_POOL_REQUIRED",
        message: "Read recovery requires a ReadWorkerPool.",
        statusCode: 500,
        details: [],
      });
    }
    const validatedInputs = new Map<string, ValidatedToolInput>();
    for (const run of initialRuns) {
      validatedInputs.set(
        run.toolCallId,
        await this.validateReadRun(run, this.options.registry),
      );
      authority.assertActive();
    }

    if (snapshot.task.status === "queued") {
      this.stateMachine.transitionTask({
        ...ownership,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "queued",
        status: "running",
      });
      snapshot = this.snapshotReader.load(ownership.taskId);
    } else if (snapshot.task.status !== "running") {
      throw this.readRecoveryBlocked("Task is not running.");
    }

    let currentStep = snapshot.planSteps.find((item) => item.id === step.id);
    if (currentStep === undefined) {
      throw this.readRecoveryBlocked("Read PlanStep disappeared.");
    }
    if (
      currentStep.status === "queued" ||
      currentStep.status === "interrupted"
    ) {
      this.stateMachine.transitionPlanStep({
        ...ownership,
        expectedTaskVersion: snapshot.task.version,
        planStepId: currentStep.id,
        expectedStatus: currentStep.status,
        expectedVersion: currentStep.version,
        status: "running",
      });
      snapshot = this.snapshotReader.load(ownership.taskId);
      currentStep = snapshot.planSteps.find((item) => item.id === step.id);
    }
    if (currentStep?.status !== "running") {
      throw this.readRecoveryBlocked("Read PlanStep is not recoverable.");
    }

    let requeuedCount = 0;
    for (const initialRun of initialRuns) {
      let run = this.findRun(snapshot, initialRun.id);
      let requeued = false;
      if (run.status === "running") {
        this.stateMachine.transitionToolRun({
          ...ownership,
          expectedTaskVersion: snapshot.task.version,
          toolRunId: run.id,
          expectedStatus: "running",
          expectedVersion: run.version,
          status: "interrupted",
        });
        requeued = true;
        snapshot = this.snapshotReader.load(ownership.taskId);
        run = this.findRun(snapshot, initialRun.id);
      }
      if (run.status === "interrupted") {
        this.stateMachine.transitionToolRun({
          ...ownership,
          expectedTaskVersion: snapshot.task.version,
          toolRunId: run.id,
          expectedStatus: "interrupted",
          expectedVersion: run.version,
          status: "queued",
        });
        requeued = true;
        snapshot = this.snapshotReader.load(ownership.taskId);
      }
      if (requeued) {
        requeuedCount += 1;
      }
    }

    const tasks = initialRuns.map((run) => {
      const current = this.findRun(snapshot, run.id);
      if (current.status !== "queued") {
        throw this.readRecoveryBlocked("Read ToolRun is not safely queued.");
      }
      const metadata = this.options.registry?.get(current.toolName);
      if (metadata === undefined) {
        throw this.readRecoveryBlocked("Read tool is unavailable.");
      }
      const task: PlannedKnownToolCall = {
        originalIndex: current.originalIndex,
        toolCallId: current.toolCallId,
        toolName: current.toolName,
        arguments: toToolCallArguments(current.input),
        mode: "read",
        timeoutMs: metadata.timeoutMs,
        requiresApproval: metadata.requiresApproval,
      };
      return task;
    });
    const bridge = new PersistentExecutionBridge({
      database: this.options.database,
      leaseManager: this.options.leaseManager,
      stateMachine: this.stateMachine,
      registry: this.options.registry,
      snapshot,
      ownership,
      authority,
    });
    authority.assertActive();
    const results = await this.readWorkerPool.execute(
      tasks,
      {
        taskId: ownership.taskId,
        signal,
        persistence: bridge,
        validatedInputs,
      },
    );
    const latest = this.snapshotReader.load(ownership.taskId);
    new ExecutionUnitOfWork(
      this.options.database,
      this.options.leaseManager,
    ).recordReadRecovery({
      ownership,
      expectedTaskVersion: latest.task.version,
      requeuedCount,
      attemptedCount: results.length,
      succeededCount: results.filter((result) => result.status === "succeeded")
        .length,
      failedCount: results.filter((result) => result.status !== "succeeded")
        .length,
      inspectedAt: this.now().toISOString(),
    }, () => authority.assertActive());
    return {
      taskId: ownership.taskId,
      status: "completed",
      report,
      requeuedCount,
      results,
    };
  }

  private assertReadRecoveryAllowed(report: RecoveryReport): void {
    if (
      report.primaryClassification !== "safe_to_resume" &&
      report.primaryClassification !== "read_interrupted"
    ) {
      throw this.readRecoveryBlocked(
        `Recovery classification ${report.primaryClassification} blocks reads.`,
      );
    }
    const blocking = report.findings.find((finding) =>
      READ_RECOVERY_BLOCKING_CLASSIFICATIONS.has(
        finding.classification,
      ),
    );
    if (blocking !== undefined) {
      throw this.readRecoveryBlocked(
        `Recovery finding ${blocking.code} blocks reads.`,
      );
    }
  }

  private async validateReadRun(
    run: ToolRunRecord,
    registry: ToolRegistry,
  ): Promise<ValidatedToolInput> {
    let tool;
    try {
      tool = registry.get(run.toolName);
    } catch {
      throw this.readRecoveryBlocked("Read tool is not registered.");
    }
    if (
      run.mode !== "read" ||
      tool.mode !== "read" ||
      tool.version !== run.toolVersion ||
      tool.requiresApproval !== run.requiresApproval ||
      computeToolInputSchemaHash(tool.inputSchema) !==
        run.inputSchemaHash ||
      computeCanonicalInputHash(run.input) !== run.canonicalInputHash
    ) {
      throw this.readRecoveryBlocked(
        "Read tool definition no longer matches the persisted ToolRun.",
      );
    }
    try {
      const validated = await registry.validateInput(run.toolName, run.input);
      if (
        validated.mode !== "read" ||
        validated.requiresApproval !== run.requiresApproval
      ) {
        throw this.readRecoveryBlocked(
          "Validated read metadata no longer matches the persisted ToolRun.",
        );
      }
      return validated;
    } catch {
      throw this.readRecoveryBlocked("Read input validation failed.");
    }
  }

  private findRun(snapshot: TaskSnapshot, toolRunId: string): ToolRunRecord {
    const run = snapshot.toolRuns.find((candidate) => candidate.id === toolRunId);
    if (run === undefined) {
      throw this.readRecoveryBlocked("Read ToolRun disappeared.");
    }
    return run;
  }

  private readRecoveryBlocked(message: string): AppError {
    return new AppError({
      code: "READ_RECOVERY_BLOCKED",
      message,
      statusCode: 409,
      details: [],
    });
  }

  releaseInspectionLease(
    ownership: RecoveryInspectionOwnership,
  ): void {
    this.options.leaseManager.release(
      ownership.taskId,
      ownership.leaseToken,
      ownership.fencingToken,
    );
  }

  inspectCandidates(ownerId: string): readonly RecoveryReport[] {
    const reports: RecoveryReport[] = [];
    for (const candidate of this.scan()) {
      try {
        reports.push(this.inspectTask(candidate.taskId, ownerId));
      } catch (error) {
        if (
          !(
            error instanceof AppError &&
            error.code === "TASK_LEASE_UNAVAILABLE"
          )
        ) {
          throw error;
        }
      }
    }
    return reports;
  }
}

function findEarliestUnfinishedPlanStep(
  snapshot: TaskSnapshot,
): PlanStepRecord | undefined {
  const plans = [...snapshot.agentExecutionPlans].sort(
    (left, right) => left.version - right.version,
  );
  for (const plan of plans) {
    const steps = snapshot.planSteps
      .filter((step) => step.planId === plan.id)
      .sort((left, right) => left.stepIndex - right.stepIndex);
    for (const step of steps) {
      if (
        !["completed", "skipped", "failed", "cancelled"].includes(
          step.status,
        )
      ) {
        return step;
      }
    }
  }
  return undefined;
}

function toToolCallArguments(
  input: ToolRunRecord["input"],
): string | Record<string, unknown> {
  if (
    typeof input === "string" ||
    (typeof input === "object" && input !== null && !Array.isArray(input))
  ) {
    return input as string | Record<string, unknown>;
  }
  throw new AppError({
    code: "READ_RECOVERY_BLOCKED",
    message: "Persisted read input is not a valid tool argument object.",
    statusCode: 409,
    details: [],
  });
}
