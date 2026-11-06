import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import type { ModelResponse } from "../../src/provider/types.js";
import {
  canTransitionPlanStepStatus,
  canTransitionTaskStatus,
  canTransitionToolRunStatus,
  closeDatabase,
  ExecutionStateMachine,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  TaskLeaseManager,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
  type PlanStepStatus,
  type TaskStatus,
  type ToolRunStatus,
} from "../../src/storage/index.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
const workers: ChildProcess[] = [];
const casWorkerPath = fileURLToPath(
  new URL("./state-cas-worker.ts", import.meta.url),
);

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
});

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.connected) {
      worker.disconnect();
    }
    if (!worker.killed) {
      worker.kill();
    }
  }
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("ExecutionStateMachine transition matrix", () => {
  it("validates the complete TaskStatus transition matrix", () => {
    const expected: Record<TaskStatus, readonly TaskStatus[]> = {
      queued: ["running", "cancel_requested"],
      running: [
        "pause_requested",
        "cancel_requested",
        "waiting_approval",
        "waiting_review",
        "completed",
        "failed",
      ],
      pause_requested: ["paused", "waiting_review", "cancel_requested"],
      paused: ["running", "cancel_requested"],
      cancel_requested: ["cancelled", "waiting_review"],
      waiting_approval: ["running", "cancel_requested", "failed"],
      waiting_review: ["running", "failed", "cancelled"],
      completed: [],
      failed: [],
      cancelled: [],
    };
    const statuses = Object.keys(expected) as TaskStatus[];

    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionTaskStatus(from, to)).toBe(
          expected[from].includes(to),
        );
      }
    }
  });

  it("validates Read and Write ToolRun transitions separately", () => {
    const expectedRead: Record<ToolRunStatus, readonly ToolRunStatus[]> = {
      queued: ["running", "failed", "skipped", "cancelled"],
      awaiting_approval: [],
      running: [
        "succeeded",
        "failed",
        "timed_out",
        "cancelled",
        "interrupted",
      ],
      interrupted: ["queued", "failed", "skipped", "cancelled"],
      succeeded: [],
      failed: [],
      timed_out: [],
      unknown: [],
      cancelled: [],
      skipped: [],
    };
    const expectedWrite: Record<ToolRunStatus, readonly ToolRunStatus[]> = {
      queued: [
        "awaiting_approval",
        "running",
        "failed",
        "skipped",
        "cancelled",
      ],
      awaiting_approval: [
        "queued",
        "running",
        "failed",
        "skipped",
        "cancelled",
      ],
      running: ["succeeded", "unknown"],
      interrupted: [],
      succeeded: [],
      failed: [],
      timed_out: [],
      unknown: [],
      cancelled: [],
      skipped: [],
    };
    const statuses = Object.keys(expectedRead) as ToolRunStatus[];

    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionToolRunStatus("read", from, to)).toBe(
          expectedRead[from].includes(to),
        );
        expect(canTransitionToolRunStatus("write", from, to)).toBe(
          expectedWrite[from].includes(to),
        );
      }
    }
  });

  it("validates the complete PlanStepStatus transition matrix", () => {
    const expected: Record<PlanStepStatus, readonly PlanStepStatus[]> = {
      queued: [
        "running",
        "awaiting_approval",
        "failed",
        "skipped",
        "cancelled",
      ],
      running: [
        "completed",
        "failed",
        "cancelled",
        "waiting_review",
        "interrupted",
      ],
      awaiting_approval: ["running", "failed", "skipped", "cancelled"],
      waiting_review: ["completed", "failed", "cancelled"],
      interrupted: ["running", "failed", "skipped", "cancelled"],
      completed: [],
      failed: [],
      skipped: [],
      cancelled: [],
    };
    const statuses = Object.keys(expected) as PlanStepStatus[];
    for (const from of statuses) {
      for (const to of statuses) {
        expect(canTransitionPlanStepStatus(from, to)).toBe(
          expected[from].includes(to),
        );
      }
    }
    expect(canTransitionPlanStepStatus("waiting_review", "running")).toBe(
      false,
    );
  });
});

describe("lease-guarded CAS state updates", () => {
  it("requires current ownership and rejects stale Task versions", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "task-state");
    const manager = createManager(activeDatabase);
    const lease = manager.claim("task-state", "worker-a");
    const stateMachine = createStateMachine(activeDatabase, manager);
    const before = new TaskSnapshotReader(activeDatabase).load("task-state");
    const transitionInput = {
      taskId: "task-state",
      leaseToken: lease.leaseToken as string,
      fencingToken: lease.fencingToken,
      expectedTaskVersion: before.task.version,
      expectedStatus: "queued" as const,
      status: "running" as const,
    };

    const running = stateMachine.transitionTask(transitionInput);
    expect(running.task.status).toBe("running");
    expect(() => stateMachine.transitionTask(transitionInput)).toThrowError(
      /Task changed/i,
    );

    manager.release(
      "task-state",
      lease.leaseToken as string,
      lease.fencingToken,
    );
    const replacement = manager.claim("task-state", "worker-b");
    expect(replacement.fencingToken).toBe(lease.fencingToken + 1);
    expect(() =>
      stateMachine.transitionTask({
        ...transitionInput,
        expectedTaskVersion: running.task.version,
        expectedStatus: "running",
        status: "pause_requested",
      }),
    ).toThrowError(/ownership is invalid/i);
  });

  it(
    "prevents two database connections from overwriting the same Task CAS",
    async () => {
      const activeDatabase = database as ForgeFlowDatabase;
      createTask(activeDatabase, "task-cas");
      const manager = createManager(activeDatabase);
      const lease = manager.claim("task-cas", "worker-a");
      const snapshot = new TaskSnapshotReader(activeDatabase).load("task-cas");
      const config = {
        databasePath: temporaryDatabase?.path as string,
        taskId: "task-cas",
        leaseToken: lease.leaseToken as string,
        fencingToken: lease.fencingToken,
        expectedTaskVersion: snapshot.task.version,
        now: timestamp,
      };
      const first = await startCasWorker(config);
      const second = await startCasWorker(config);
      const results = await Promise.all([
        runCasWorker(first),
        runCasWorker(second),
      ]);

      expect(
        results.filter((result) => result.status === "succeeded"),
      ).toHaveLength(1);
      expect(
        results.filter((result) => result.status === "rejected"),
      ).toHaveLength(1);
      const final = new TaskSnapshotReader(activeDatabase).load("task-cas");
      expect(final.task.status).toBe("running");
      expect(
        final.events.filter((event) => event.type === "task.transitioned"),
      ).toHaveLength(1);
    },
    15_000,
  );

  it("enforces Read/Write ToolRun transitions under an owned task", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const read = createPlanTask(activeDatabase, "read", "read-state");
    const manager = createManager(activeDatabase);
    const claimed = manager.claim("read-state", "worker-a");
    const lease = {
      leaseToken: claimed.leaseToken as string,
      fencingToken: claimed.fencingToken,
    };
    const stateMachine = createStateMachine(activeDatabase, manager);
    let snapshot = new TaskSnapshotReader(activeDatabase).load("read-state");

    snapshot = stateMachine.transitionToolRun({
      taskId: "read-state",
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      expectedTaskVersion: snapshot.task.version,
      toolRunId: read.toolRunId,
      expectedStatus: "queued",
      expectedVersion: snapshot.toolRuns[0]?.version as number,
      status: "running",
      startedAt: timestamp,
    });
    expect(snapshot.toolRuns[0]?.status).toBe("running");

    snapshot = stateMachine.transitionToolRun({
      taskId: "read-state",
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      expectedTaskVersion: snapshot.task.version,
      toolRunId: read.toolRunId,
      expectedStatus: "running",
      expectedVersion: snapshot.toolRuns[0]?.version as number,
      status: "failed",
      error: {
        code: "READ_FAILED",
        message: "Read failed.",
        details: [],
      },
      finishedAt: timestamp,
    });
    expect(snapshot.toolRuns[0]?.status).toBe("failed");

    const write = createPlanTask(activeDatabase, "write", "write-state");
    const claimedWrite = manager.claim("write-state", "worker-b");
    const writeLease = {
      leaseToken: claimedWrite.leaseToken as string,
      fencingToken: claimedWrite.fencingToken,
    };
    const writeMachine = createStateMachine(activeDatabase, manager);
    let writeSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "write-state",
    );
    writeSnapshot = writeMachine.transitionToolRun({
      taskId: "write-state",
      leaseToken: writeLease.leaseToken,
      fencingToken: writeLease.fencingToken,
      expectedTaskVersion: writeSnapshot.task.version,
      toolRunId: write.toolRunId,
      expectedStatus: "queued",
      expectedVersion: writeSnapshot.toolRuns[0]?.version as number,
      status: "running",
      startedAt: timestamp,
    });
    expect(() =>
      writeMachine.transitionToolRun({
        taskId: "write-state",
        leaseToken: writeLease.leaseToken,
        fencingToken: writeLease.fencingToken,
        expectedTaskVersion: writeSnapshot.task.version,
        toolRunId: write.toolRunId,
        expectedStatus: "running",
        expectedVersion: writeSnapshot.toolRuns[0]?.version as number,
        status: "failed",
      }),
    ).toThrowError(/Invalid tool run transition/i);
  });

  it("allows Read crashes to interrupt but requires Write crashes to review", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const manager = createManager(activeDatabase);
    const stateMachine = createStateMachine(activeDatabase, manager);

    const read = createPlanTask(activeDatabase, "read", "read-crash");
    const readLease = manager.claim("read-crash", "worker-read");
    const readLeaseRef = {
      leaseToken: readLease.leaseToken as string,
      fencingToken: readLease.fencingToken,
    };
    let readSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "read-crash",
    );
    readSnapshot = stateMachine.transitionPlanStep({
      taskId: "read-crash",
      ...readLeaseRef,
      expectedTaskVersion: readSnapshot.task.version,
      planStepId: read.planStepId,
      expectedStatus: "queued",
      expectedVersion: readSnapshot.planSteps[0]?.version as number,
      status: "running",
    });
    readSnapshot = stateMachine.transitionToolRun({
      taskId: "read-crash",
      ...readLeaseRef,
      expectedTaskVersion: readSnapshot.task.version,
      toolRunId: read.toolRunId,
      expectedStatus: "queued",
      expectedVersion: readSnapshot.toolRuns[0]?.version as number,
      status: "running",
      startedAt: timestamp,
    });
    readSnapshot = stateMachine.transitionPlanStep({
      taskId: "read-crash",
      ...readLeaseRef,
      expectedTaskVersion: readSnapshot.task.version,
      planStepId: read.planStepId,
      expectedStatus: "running",
      expectedVersion: readSnapshot.planSteps[0]?.version as number,
      status: "interrupted",
    });
    expect(readSnapshot.planSteps[0]?.status).toBe("interrupted");

    const write = createPlanTask(activeDatabase, "write", "write-crash");
    const writeLease = manager.claim("write-crash", "worker-write");
    const writeLeaseRef = {
      leaseToken: writeLease.leaseToken as string,
      fencingToken: writeLease.fencingToken,
    };
    let writeSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "write-crash",
    );
    writeSnapshot = stateMachine.transitionPlanStep({
      taskId: "write-crash",
      ...writeLeaseRef,
      expectedTaskVersion: writeSnapshot.task.version,
      planStepId: write.planStepId,
      expectedStatus: "queued",
      expectedVersion: writeSnapshot.planSteps[0]?.version as number,
      status: "running",
    });
    writeSnapshot = stateMachine.transitionToolRun({
      taskId: "write-crash",
      ...writeLeaseRef,
      expectedTaskVersion: writeSnapshot.task.version,
      toolRunId: write.toolRunId,
      expectedStatus: "queued",
      expectedVersion: writeSnapshot.toolRuns[0]?.version as number,
      status: "running",
      startedAt: timestamp,
    });
    writeSnapshot = stateMachine.transitionToolRun({
      taskId: "write-crash",
      ...writeLeaseRef,
      expectedTaskVersion: writeSnapshot.task.version,
      toolRunId: write.toolRunId,
      expectedStatus: "running",
      expectedVersion: writeSnapshot.toolRuns[0]?.version as number,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      finishedAt: timestamp,
    });
    expect(() =>
      stateMachine.transitionPlanStep({
        taskId: "write-crash",
        ...writeLeaseRef,
        expectedTaskVersion: writeSnapshot.task.version,
        planStepId: write.planStepId,
        expectedStatus: "running",
        expectedVersion: writeSnapshot.planSteps[0]?.version as number,
        status: "interrupted",
      }),
    ).toThrowError(/Only a Read Batch/i);
    writeSnapshot = stateMachine.transitionPlanStep({
      taskId: "write-crash",
      ...writeLeaseRef,
      expectedTaskVersion: writeSnapshot.task.version,
      planStepId: write.planStepId,
      expectedStatus: "running",
      expectedVersion: writeSnapshot.planSteps[0]?.version as number,
      status: "waiting_review",
    });
    expect(writeSnapshot.planSteps[0]?.status).toBe("waiting_review");
    expect(writeSnapshot.toolRuns[0]?.status).toBe("unknown");
  });

  it("applies PlanStep CAS and blocks completed with active execution", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const plan = createPlanTask(activeDatabase, "read", "plan-state");
    const manager = createManager(activeDatabase);
    const claimed = manager.claim("plan-state", "worker-a");
    const lease = {
      leaseToken: claimed.leaseToken as string,
      fencingToken: claimed.fencingToken,
    };
    const stateMachine = createStateMachine(activeDatabase, manager);
    let snapshot = new TaskSnapshotReader(activeDatabase).load("plan-state");

    snapshot = stateMachine.transitionPlanStep({
      taskId: "plan-state",
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      expectedTaskVersion: snapshot.task.version,
      planStepId: plan.planStepId,
      expectedStatus: "queued",
      expectedVersion: snapshot.planSteps[0]?.version as number,
      status: "running",
    });
    expect(snapshot.planSteps[0]?.status).toBe("running");

    expect(() =>
      stateMachine.transitionTask({
        taskId: "plan-state",
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "running",
        status: "completed",
      }),
    ).toThrowError(/active (?:tool run|plan step)/i);
  });

  it("blocks cancellation and resume when recovery constraints are active", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const plan = createPlanTask(activeDatabase, "write", "review-state");
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    unitOfWork.beginToolRun({
      toolRunId: plan.toolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: plan.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork.requestRecoveryReview({
      toolRunId: plan.toolRunId,
      note: null,
    });

    const manager = createManager(activeDatabase);
    const claimed = manager.claim("review-state", "worker-a");
    const lease = {
      leaseToken: claimed.leaseToken as string,
      fencingToken: claimed.fencingToken,
    };
    const stateMachine = createStateMachine(activeDatabase, manager);
    let snapshot = new TaskSnapshotReader(activeDatabase).load("review-state");
    expect(snapshot.task.status).toBe("waiting_review");

    expect(() =>
      stateMachine.transitionTask({
        taskId: "review-state",
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "waiting_review",
        status: "running",
      }),
    ).toThrowError(/recovery review is active/i);
    expect(() =>
      stateMachine.transitionTask({
        taskId: "review-state",
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "waiting_review",
        status: "failed",
      }),
    ).toThrowError(/active recovery review/i);

    expect(() =>
      stateMachine.transitionTask({
        taskId: "review-state",
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "waiting_review",
        status: "cancelled",
      }),
    ).toThrowError(/active recovery review/i);

    const review = snapshot.recoveryReviews[0];
    unitOfWork.decideRecoveryReview({
      recoveryReviewId: review?.id as string,
      status: "confirmed_succeeded",
      note: "Confirmed.",
      sourceType: "manual_review",
      evidenceRef: "audit://step4",
    });
    snapshot = new TaskSnapshotReader(activeDatabase).load("review-state");
    snapshot = stateMachine.requestCancel({
      taskId: "review-state",
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
      expectedTaskVersion: snapshot.task.version,
    });
    expect(snapshot.task).toMatchObject({
      status: "waiting_review",
      cancelRequestedAt: timestamp,
    });

    expect(() =>
      stateMachine.transitionTask({
        taskId: "review-state",
        leaseToken: lease.leaseToken,
        fencingToken: lease.fencingToken,
        expectedTaskVersion: snapshot.task.version,
        expectedStatus: "waiting_review",
        status: "running",
      }),
    ).toThrowError(/cancel intent/i);
  });

  it("blocks failed with active work and cancelled with pending approval", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const manager = createManager(activeDatabase);
    const stateMachine = createStateMachine(activeDatabase, manager);

    const failedPlan = createPlanTask(activeDatabase, "write", "failed-work");
    const failedLease = manager.claim("failed-work", "worker-failed");
    let failedSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "failed-work",
    );
    failedSnapshot = stateMachine.transitionToolRun({
      taskId: "failed-work",
      leaseToken: failedLease.leaseToken as string,
      fencingToken: failedLease.fencingToken,
      expectedTaskVersion: failedSnapshot.task.version,
      toolRunId: failedPlan.toolRunId,
      expectedStatus: "queued",
      expectedVersion: failedSnapshot.toolRuns[0]?.version as number,
      status: "running",
      startedAt: timestamp,
    });
    expect(() =>
      stateMachine.transitionTask({
        taskId: "failed-work",
        leaseToken: failedLease.leaseToken as string,
        fencingToken: failedLease.fencingToken,
        expectedTaskVersion: failedSnapshot.task.version,
        expectedStatus: "running",
        status: "failed",
      }),
    ).toThrowError(/active (?:plan step|tool run)/i);

    const cancelledPlan = createPlanTask(
      activeDatabase,
      "write",
      "cancelled-approval",
    );
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    unitOfWork.requestApproval({
      toolRunId: cancelledPlan.toolRunId,
      request: { toolName: "bom_update" },
    });
    const cancelLease = manager.claim(
      "cancelled-approval",
      "worker-cancel",
    );
    let cancelSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "cancelled-approval",
    );
    cancelSnapshot = stateMachine.requestCancel({
      taskId: "cancelled-approval",
      leaseToken: cancelLease.leaseToken as string,
      fencingToken: cancelLease.fencingToken,
      expectedTaskVersion: cancelSnapshot.task.version,
    });
    expect(cancelSnapshot.task.status).toBe("cancel_requested");
    expect(() =>
      stateMachine.transitionTask({
        taskId: "cancelled-approval",
        leaseToken: cancelLease.leaseToken as string,
        fencingToken: cancelLease.fencingToken,
        expectedTaskVersion: cancelSnapshot.task.version,
        expectedStatus: "cancel_requested",
        status: "cancelled",
      }),
    ).toThrowError(/active (?:plan step|tool run)|pending approval/i);
  });

  it("distinguishes terminal Review conclusions from unresolved Unknown Writes", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    const manager = createManager(activeDatabase);
    const stateMachine = createStateMachine(activeDatabase, manager);

    const succeeded = createPlanTask(
      activeDatabase,
      "write",
      "review-terminal-succeeded",
    );
    unitOfWork.beginToolRun({
      toolRunId: succeeded.toolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: succeeded.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork.requestRecoveryReview({
      toolRunId: succeeded.toolRunId,
      note: null,
    });
    let succeededSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "review-terminal-succeeded",
    );
    unitOfWork.decideRecoveryReview({
      recoveryReviewId: succeededSnapshot.recoveryReviews[0]?.id as string,
      status: "confirmed_succeeded",
      note: "Confirmed by audit.",
      sourceType: "manual_review",
      evidenceRef: "audit://terminal/succeeded",
    });
    const succeededLease = manager.claim(
      "review-terminal-succeeded",
      "worker-succeeded",
    );
    succeededSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "review-terminal-succeeded",
    );
    succeededSnapshot = stateMachine.transitionTask({
      taskId: "review-terminal-succeeded",
      leaseToken: succeededLease.leaseToken as string,
      fencingToken: succeededLease.fencingToken,
      expectedTaskVersion: succeededSnapshot.task.version,
      expectedStatus: "waiting_review",
      status: "cancelled",
    });
    expect(succeededSnapshot.task.status).toBe("cancelled");
    expect(succeededSnapshot.toolRuns[0]?.status).toBe("unknown");
    expect(succeededSnapshot.planSteps[0]?.status).toBe("completed");

    const notExecuted = createPlanTask(
      activeDatabase,
      "write",
      "review-terminal-not-executed",
    );
    unitOfWork.beginToolRun({
      toolRunId: notExecuted.toolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: notExecuted.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork.requestRecoveryReview({
      toolRunId: notExecuted.toolRunId,
      note: null,
    });
    let notExecutedSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "review-terminal-not-executed",
    );
    unitOfWork.decideRecoveryReview({
      recoveryReviewId: notExecutedSnapshot.recoveryReviews[0]?.id as string,
      status: "confirmed_not_executed",
      note: "Confirmed not executed.",
      sourceType: "manual_review",
      evidenceRef: "audit://terminal/not-executed",
    });
    const notExecutedLease = manager.claim(
      "review-terminal-not-executed",
      "worker-not-executed",
    );
    notExecutedSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "review-terminal-not-executed",
    );
    notExecutedSnapshot = stateMachine.transitionTask({
      taskId: "review-terminal-not-executed",
      leaseToken: notExecutedLease.leaseToken as string,
      fencingToken: notExecutedLease.fencingToken,
      expectedTaskVersion: notExecutedSnapshot.task.version,
      expectedStatus: "waiting_review",
      status: "failed",
    });
    expect(notExecutedSnapshot.task.status).toBe("failed");
    expect(notExecutedSnapshot.toolRuns[0]?.status).toBe("unknown");
    expect(notExecutedSnapshot.planSteps[0]?.status).toBe("failed");
  });
});

interface PlanFixture {
  readonly taskId: string;
  readonly planStepId: string;
  readonly toolRunId: string;
}

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "State machine test",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function createPlanTask(
  database: ForgeFlowDatabase,
  mode: "read" | "write",
  taskId: string,
): PlanFixture {
  const unitOfWork = new ExecutionUnitOfWork(database);
  createTask(database, taskId);
  const call = unitOfWork.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Create a plan" }],
      tools: [],
    },
  });
  const inputSchema = z.object({}).strict();
  const toolName = mode === "read" ? "bom_get_items" : "bom_update";
  const callId = `call-${taskId}`;
  const response: ModelResponse = {
    message: {
      role: "assistant",
      content: "Plan prepared.",
      toolCalls: [{ id: callId, name: toolName, arguments: {} }],
    },
    usage: { source: "provider" },
  };
  const planStepId = `step-${taskId}`;
  const toolRunId = `run-${taskId}`;
  unitOfWork.completeModelCallWithPlan({
    modelCallId: call.id,
    response,
    durationMs: 10,
    plan: {
      id: `plan-${taskId}`,
      version: 1,
      steps: [
        {
          id: planStepId,
          stepIndex: 0,
          kind: mode === "read" ? "read_batch" : "write",
        },
      ],
      toolRuns: [
        {
          id: toolRunId,
          planStepId,
          toolCallId: callId,
          originalIndex: 0,
          toolName,
          toolVersion: "1",
          inputSchemaHash: computeToolInputSchemaHash(inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode,
          requiresApproval: mode === "write",
          input: {},
        },
      ],
    },
  });
  return { taskId, planStepId, toolRunId };
}

function createManager(database: ForgeFlowDatabase): TaskLeaseManager {
  return new TaskLeaseManager(database, {
    leaseTtlMs: 30_000,
    now: () => new Date(timestamp),
  });
}

function createStateMachine(
  database: ForgeFlowDatabase,
  manager: TaskLeaseManager,
): ExecutionStateMachine {
  return new ExecutionStateMachine(database, manager, {
    now: () => new Date(timestamp),
  });
}

const timestamp = "2026-01-01T00:00:00.000Z";

interface CasWorkerResult {
  readonly type: "complete";
  readonly status: "succeeded" | "rejected";
  readonly code?: string;
}

function startCasWorker(config: {
  databasePath: string;
  taskId: string;
  leaseToken: string;
  fencingToken: number;
  expectedTaskVersion: number;
  now: string;
}): Promise<ChildProcess> {
  const worker = fork(casWorkerPath, [JSON.stringify(config)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workers.push(worker);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("CAS worker did not become ready."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
      ) {
        cleanup();
        resolve(worker);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(new Error(`CAS worker exited before readiness: ${String(code)}`));
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}

function runCasWorker(worker: ChildProcess): Promise<CasWorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("CAS worker timed out."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete"
      ) {
        cleanup();
        resolve(message as CasWorkerResult);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(new Error(`CAS worker exited with code ${String(code)}`));
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.send({ type: "start" });
  });
}
