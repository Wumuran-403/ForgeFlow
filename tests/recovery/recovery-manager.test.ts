import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  ApprovalRepository,
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  runInTransaction,
  TaskLeaseManager,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  RecoveryManager,
  RecoveryScanner,
} from "../../src/recovery/index.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";

const workerPath = fileURLToPath(
  new URL("./recovery-inspect-worker.ts", import.meta.url),
);
const workers: ChildProcess[] = [];
let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

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
  vi.restoreAllMocks();
});

describe("RecoveryScanner", () => {
  it("finds queued and abandoned running tasks but excludes valid leases", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);
    createTask(activeDatabase, "scan-queued");
    createTask(activeDatabase, "scan-running");
    unitOfWork.updateTaskStatus("scan-running", "running");
    createTask(activeDatabase, "scan-active-lease");
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 30_000,
      now: () => new Date(timestamp),
    });
    manager.claim("scan-active-lease", "worker-active");

    const candidates = new RecoveryScanner(activeDatabase, {
      now: () => new Date(timestamp),
    }).scan();
    expect(candidates.map((candidate) => candidate.taskId)).toEqual(
      expect.arrayContaining(["scan-queued", "scan-running"]),
    );
    expect(candidates.map((candidate) => candidate.taskId)).not.toContain(
      "scan-active-lease",
    );
  });

  it("reports released and expired leases as recoverable", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    let nowMs = Date.parse(timestamp);
    const manager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 1_000,
      now: () => new Date(nowMs),
    });
    createTask(activeDatabase, "scan-released");
    const released = manager.claim("scan-released", "worker-a");
    manager.release(
      "scan-released",
      released.leaseToken as string,
      released.fencingToken,
    );

    createTask(activeDatabase, "scan-expired");
    manager.claim("scan-expired", "worker-b");
    nowMs += 1_001;

    const candidates = new RecoveryScanner(activeDatabase, {
      now: () => new Date(nowMs),
    }).scan();
    expect(
      candidates.find((candidate) => candidate.taskId === "scan-released")
        ?.leaseState,
    ).toBe("released");
    expect(
      candidates.find((candidate) => candidate.taskId === "scan-expired")
        ?.leaseState,
    ).toBe("expired");
  });
});

describe("RecoveryManager", () => {
  it("classifies Read, Write, Model Call, Approval, Review, Pause, and Cancel states", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const registry = createRegistry();
    const manager = createRecoveryManager(activeDatabase, registry);
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);

    createTask(activeDatabase, "report-safe");
    expect(
      manager.inspectTask("report-safe", "worker-safe").primaryClassification,
    ).toBe("safe_to_resume");

    createTask(activeDatabase, "report-requested");
    unitOfWork.beginModelCall({
      taskId: "report-requested",
      iteration: 1,
      request: {
        model: "mock-model",
        messages: [{ role: "user", content: "waiting" }],
        tools: [],
      },
    });
    expect(
      manager.inspectTask("report-requested", "worker-model")
        .primaryClassification,
    ).toBe("model_call_interrupted");

    const read = seedPlan(activeDatabase, registry, "report-read", "read");
    unitOfWork.beginToolRun({
      toolRunId: read.toolRunId,
      status: "running",
    });
    const readReport = manager.inspectTask("report-read", "worker-read");
    expect(readReport.primaryClassification).toBe("read_interrupted");

    const write = seedPlan(activeDatabase, registry, "report-write", "write");
    unitOfWork.beginToolRun({
      toolRunId: write.toolRunId,
      status: "running",
    });
    const writeReport = manager.inspectTask("report-write", "worker-write");
    expect(writeReport.primaryClassification).toBe(
      "write_outcome_unknown",
    );

    const approval = seedPlan(
      activeDatabase,
      registry,
      "report-approval",
      "write",
    );
    unitOfWork.requestApproval({
      toolRunId: approval.toolRunId,
      request: { description: "approve" },
    });
    expect(
      manager.inspectTask("report-approval", "worker-approval")
        .primaryClassification,
    ).toBe("approval_pending");

    const review = seedPlan(
      activeDatabase,
      registry,
      "report-review",
      "write",
    );
    unitOfWork.beginToolRun({
      toolRunId: review.toolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: review.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    unitOfWork.requestRecoveryReview({
      toolRunId: review.toolRunId,
      note: null,
    });
    const reviewReport = manager.inspectTask(
      "report-review",
      "worker-review",
    );
    expect(reviewReport.primaryClassification).toBe(
      "write_outcome_unknown",
    );
    expect(reviewReport.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          classification: "review_pending",
        }),
      ]),
    );

    createTask(activeDatabase, "report-pause");
    unitOfWork.updateTaskStatus("report-pause", "pause_requested");
    expect(
      manager.inspectTask("report-pause", "worker-pause")
        .primaryClassification,
    ).toBe("pause_pending");

    createTask(activeDatabase, "report-cancel");
    unitOfWork.updateTaskStatus("report-cancel", "cancel_requested");
    expect(
      manager.inspectTask("report-cancel", "worker-cancel")
        .primaryClassification,
    ).toBe("cancel_pending");
  });

  it("distinguishes queued ToolRuns from interrupted and unknown outcomes", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const registry = createRegistry();
    const manager = createRecoveryManager(activeDatabase, registry);
    const unitOfWork = new ExecutionUnitOfWork(activeDatabase);

    const queuedRead = seedPlan(
      activeDatabase,
      registry,
      "queued-read",
      "read",
    );
    const readReport = manager.inspectTask("queued-read", "worker-queued-read");
    expect(readReport.primaryClassification).toBe("safe_to_resume");
    expect(readReport.findings).toContainEqual(
      expect.objectContaining({
        code: "QUEUED_READ_NOT_STARTED",
        classification: "safe_to_resume",
      }),
    );
    expect(
      readReport.findings.some(
        (finding) =>
          finding.classification === "read_interrupted" ||
          finding.classification === "write_outcome_unknown",
      ),
    ).toBe(false);

    const queuedWrite = seedPlan(
      activeDatabase,
      registry,
      "queued-write-no-approval",
      "write",
      "bom_update_no_approval",
    );
    const noApprovalReport = manager.inspectTask(
      "queued-write-no-approval",
      "worker-queued-write",
    );
    expect(noApprovalReport.primaryClassification).toBe("safe_to_resume");
    expect(noApprovalReport.findings).toContainEqual(
      expect.objectContaining({
        code: "QUEUED_WRITE_NOT_STARTED",
      }),
    );
    expect(
      noApprovalReport.findings.some(
        (finding) =>
          finding.classification === "write_outcome_unknown",
      ),
    ).toBe(false);

    const pendingWrite = seedPlan(
      activeDatabase,
      registry,
      "queued-write-pending",
      "write",
    );
    createApproval(
      activeDatabase,
      "queued-write-pending",
      pendingWrite.toolRunId,
      "pending",
    );
    const pendingReport = manager.inspectTask(
      "queued-write-pending",
      "worker-write-pending",
    );
    expect(pendingReport.primaryClassification).toBe("approval_pending");
    expect(pendingReport.findings).toContainEqual(
      expect.objectContaining({
        code: "QUEUED_WRITE_APPROVAL_PENDING",
      }),
    );

    const approvedWrite = seedPlan(
      activeDatabase,
      registry,
      "queued-write-approved",
      "write",
    );
    createApproval(
      activeDatabase,
      "queued-write-approved",
      approvedWrite.toolRunId,
      "approved",
    );
    const approvedReport = manager.inspectTask(
      "queued-write-approved",
      "worker-write-approved",
    );
    expect(approvedReport.primaryClassification).toBe("safe_to_resume");
    expect(approvedReport.findings).toContainEqual(
      expect.objectContaining({
        code: "QUEUED_WRITE_APPROVED_NOT_STARTED",
      }),
    );
    expect(
      approvedReport.findings.some(
        (finding) =>
          finding.classification === "write_outcome_unknown",
      ),
    ).toBe(false);

    const rejectedWrite = seedPlan(
      activeDatabase,
      registry,
      "queued-write-rejected",
      "write",
    );
    createApproval(
      activeDatabase,
      "queued-write-rejected",
      rejectedWrite.toolRunId,
      "rejected",
    );
    const rejectedReport = manager.inspectTask(
      "queued-write-rejected",
      "worker-write-rejected",
    );
    expect(rejectedReport.primaryClassification).toBe(
      "state_inconsistent",
    );
    expect(rejectedReport.findings).toContainEqual(
      expect.objectContaining({
        code: "QUEUED_WRITE_APPROVAL_INVALID",
      }),
    );

    const interruptedRead = seedPlan(
      activeDatabase,
      registry,
      "interrupted-read",
      "read",
    );
    unitOfWork.beginToolRun({
      toolRunId: interruptedRead.toolRunId,
      status: "running",
    });
    const run = new TaskSnapshotReader(activeDatabase).load(
      "interrupted-read",
    ).toolRuns[0];
    runInTransaction(
      activeDatabase,
      () => {
        const permit = createStorageWritePermit(activeDatabase);
        return new ToolRunRepository(activeDatabase).transition(
          interruptedRead.toolRunId,
          ["running"],
          {
            expectedVersion: run?.version as number,
            status: "interrupted",
            updatedAt: timestamp,
          },
          permit,
        );
      },
      "immediate",
    );
    expect(
      manager.inspectTask("interrupted-read", "worker-interrupted-read")
        .primaryClassification,
    ).toBe("read_interrupted");

    const runningRead = seedPlan(
      activeDatabase,
      registry,
      "running-read-final",
      "read",
    );
    unitOfWork.beginToolRun({
      toolRunId: runningRead.toolRunId,
      status: "running",
    });
    expect(
      manager.inspectTask("running-read-final", "worker-running-read")
        .primaryClassification,
    ).toBe("read_interrupted");

    const runningWrite = seedPlan(
      activeDatabase,
      registry,
      "running-write-final",
      "write",
    );
    unitOfWork.beginToolRun({
      toolRunId: runningWrite.toolRunId,
      status: "running",
    });
    expect(
      manager.inspectTask("running-write-final", "worker-running-write")
        .primaryClassification,
    ).toBe("write_outcome_unknown");

    const unknownWrite = seedPlan(
      activeDatabase,
      registry,
      "unknown-write-final",
      "write",
    );
    unitOfWork.beginToolRun({
      toolRunId: unknownWrite.toolRunId,
      status: "running",
    });
    unitOfWork.completeToolRun({
      toolRunId: unknownWrite.toolRunId,
      status: "unknown",
      error: {
        code: "WRITE_OUTCOME_UNKNOWN",
        message: "Write outcome is unknown.",
        details: [],
      },
      planStepStatus: "waiting_review",
    });
    expect(
      manager.inspectTask("unknown-write-final", "worker-unknown-write")
        .primaryClassification,
    ).toBe("write_outcome_unknown");

    const multiple = seedTwoQueuedReads(activeDatabase, registry);
    const multipleReport = manager.inspectTask(
      "multiple-queued",
      "worker-multiple",
    );
    expect(multipleReport.primaryClassification).toBe("safe_to_resume");
    expect(
      multipleReport.findings.filter(
        (finding) => finding.code === "QUEUED_READ_NOT_STARTED",
      ),
    ).toHaveLength(2);
    const finalSnapshot = new TaskSnapshotReader(activeDatabase).load(
      "multiple-queued",
    );
    expect(
      finalSnapshot.toolRuns.filter((toolRun) => toolRun.status === "queued"),
    ).toHaveLength(2);
    expect(
      finalSnapshot.messages.filter((message) => message.role === "tool"),
    ).toHaveLength(0);

    expect(queuedRead.toolRunId).toBeDefined();
    expect(queuedWrite.toolRunId).toBeDefined();
    expect(multiple.taskId).toBe("multiple-queued");
  });

  it("prioritizes state inconsistency detected from Tool Version mismatch", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const registry = createRegistry();
    const plan = seedPlan(
      activeDatabase,
      registry,
      "report-inconsistent",
      "read",
    );
    activeDatabase
      .prepare("UPDATE tool_runs SET tool_version = '999' WHERE id = ?")
      .run(plan.toolRunId);

    const report = createRecoveryManager(
      activeDatabase,
      registry,
    ).inspectTask("report-inconsistent", "worker-inconsistent");
    expect(report.primaryClassification).toBe("state_inconsistent");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "TOOL_DEFINITION_CHANGED",
      }),
    );
  });

  it("returns state_inconsistent for corrupted persisted JSON without losing ownership cleanup", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "report-corrupt-json");
    activeDatabase
      .prepare("UPDATE tasks SET token_usage_json = '{broken' WHERE id = ?")
      .run("report-corrupt-json");

    const report = createRecoveryManager(activeDatabase).inspectTask(
      "report-corrupt-json",
      "worker-corrupt",
    );
    expect(report.primaryClassification).toBe("state_inconsistent");
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        code: "SNAPSHOT_INVALID",
      }),
    );
    expect(
      activeDatabase
        .prepare("SELECT owner_id FROM task_leases WHERE task_id = ?")
        .get("report-corrupt-json"),
    ).toEqual({ owner_id: null });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count FROM events
            WHERE task_id = ? AND type = 'recovery.inspected'
          `,
        )
        .get("report-corrupt-json"),
    ).toEqual({ count: 1 });
  });

  it("writes a safe recovery Event and Checkpoint and releases the Lease", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "report-event");
    const report = createRecoveryManager(activeDatabase).inspectTask(
      "report-event",
      "worker-event",
    );
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "report-event",
    );

    expect(report.classification).toBe("safe_to_resume");
    expect(snapshot.lease?.ownerId).toBeNull();
    expect(snapshot.events).toContainEqual(
      expect.objectContaining({
        type: "recovery.inspected",
        payload: expect.objectContaining({
          classification: "safe_to_resume",
        }),
      }),
    );
    expect(snapshot.checkpoints).toContainEqual(
      expect.objectContaining({
        reason: "recovery_inspected",
      }),
    );
    expect(JSON.stringify(snapshot.events.at(-1)?.payload)).not.toContain(
      "private user message",
    );
  });

  it("rolls back inspection Event when Checkpoint fails and releases the Lease", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    createTask(activeDatabase, "report-atomic");
    activeDatabase.exec(
      `
        CREATE TRIGGER reject_recovery_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'recovery_inspected'
        BEGIN
          SELECT RAISE(ABORT, 'recovery checkpoint rejected');
        END
      `,
    );
    const manager = createRecoveryManager(activeDatabase);

    expect(() =>
      manager.inspectTask("report-atomic", "worker-atomic"),
    ).toThrow("recovery checkpoint rejected");
    const snapshot = new TaskSnapshotReader(activeDatabase).load(
      "report-atomic",
    );
    expect(
      snapshot.events.some((event) => event.type === "recovery.inspected"),
    ).toBe(false);
    expect(snapshot.lease?.ownerId).toBeNull();
  });

  it("claims expired leases, increments fencing, and releases after inspection", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    let nowMs = Date.parse(timestamp);
    const leaseManager = new TaskLeaseManager(activeDatabase, {
      leaseTtlMs: 1_000,
      now: () => new Date(nowMs),
    });
    createTask(activeDatabase, "report-expired");
    const old = leaseManager.claim("report-expired", "worker-old");
    nowMs += 1_001;

    const report = createRecoveryManager(
      activeDatabase,
      createRegistry(),
      leaseManager,
      () => nowMs,
    ).inspectTask("report-expired", "worker-new");
    expect(report.fencingToken).toBe(old.fencingToken + 1);
    expect(
      new TaskSnapshotReader(activeDatabase).load("report-expired").lease,
    ).toMatchObject({
      ownerId: null,
      fencingToken: old.fencingToken + 1,
    });
  });

  it(
    "allows only one of two concurrent RecoveryManagers to inspect a Task",
    async () => {
      const activeDatabase = database as ForgeFlowDatabase;
      createTask(activeDatabase, "report-concurrent");
      const config = {
        databasePath: temporaryDatabase?.path as string,
        taskId: "report-concurrent",
        now: timestamp,
      };
      const first = await startWorker({ ...config, ownerId: "worker-a" });
      const second = await startWorker({ ...config, ownerId: "worker-b" });
      const starts = await Promise.all([
        beginInspection(first),
        beginInspection(second),
      ]);

      expect(
        starts.filter((result) => result.type === "claimed"),
      ).toHaveLength(1);
      expect(
        starts.filter(
          (result) =>
            result.type === "complete" &&
            result.code === "TASK_LEASE_UNAVAILABLE",
        ),
      ).toHaveLength(1);
      const winner =
        starts[0]?.type === "claimed" ? first : second;
      const completed = await finishInspection(winner);
      expect(completed).toMatchObject({
        status: "inspected",
        classification: "safe_to_resume",
      });
      expect(
        new TaskSnapshotReader(activeDatabase).load("report-concurrent")
          .lease?.ownerId,
      ).toBeNull();
    },
    15_000,
  );
});

interface WorkerResult {
  readonly type: "complete";
  readonly status: "inspected" | "rejected";
  readonly code?: string;
}

type BeginInspectionResult =
  | { readonly type: "claimed" }
  | WorkerResult;

function createRecoveryManager(
  database: ForgeFlowDatabase,
  registry?: ToolRegistry,
  leaseManager = new TaskLeaseManager(database, {
    now: () => new Date(timestamp),
  }),
  now: () => number = () => Date.parse(timestamp),
): RecoveryManager {
  return new RecoveryManager({
    database,
    leaseManager,
    ...(registry === undefined ? {} : { registry }),
    now: () => new Date(now()),
  });
}

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Recover this task",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function createRegistry(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register({
    name: "bom_get_items",
    description: "Read BOM items.",
    mode: "read",
    version: "1",
    inputSchema: z.object({}).strict(),
    execute: () => ({}),
  });
  registry.register({
    name: "bom_update",
    description: "Update BOM revision.",
    mode: "write",
    version: "1",
    inputSchema: z.object({}).strict(),
    execute: () => ({}),
  });
  registry.register({
    name: "bom_update_no_approval",
    description: "Update BOM without approval.",
    mode: "write",
    version: "1",
    inputSchema: z.object({}).strict(),
    requiresApproval: false,
    execute: () => ({}),
  });
  return registry;
}

function seedPlan(
  database: ForgeFlowDatabase,
  registry: ToolRegistry,
  taskId: string,
  mode: "read" | "write",
  requestedToolName?: string,
): { readonly toolRunId: string } {
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
  const toolName =
    requestedToolName ??
    (mode === "read" ? "bom_get_items" : "bom_update");
  const tool = registry.get(toolName);
  const callId = `call-${taskId}`;
  const planStepId = `step-${taskId}`;
  const toolRunId = `run-${taskId}`;
  unitOfWork.completeModelCallWithPlan({
    modelCallId: call.id,
    durationMs: 1,
    response: {
      message: {
        role: "assistant",
        content: "Plan.",
        toolCalls: [{ id: callId, name: toolName, arguments: {} }],
      },
      usage: { source: "provider" },
    },
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
          toolVersion: tool.version,
          inputSchemaHash: computeToolInputSchemaHash(tool.inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode,
          requiresApproval: tool.requiresApproval,
          input: {},
        },
      ],
    },
  });
  return { toolRunId };
}

function seedTwoQueuedReads(
  database: ForgeFlowDatabase,
  registry: ToolRegistry,
): { readonly taskId: string } {
  const taskId = "multiple-queued";
  const unitOfWork = new ExecutionUnitOfWork(database);
  const tool = registry.get("bom_get_items");
  const callIdA = "call-multiple-a";
  const callIdB = "call-multiple-b";
  const planStepId = "step-multiple";
  createTask(database, taskId);
  const modelCall = unitOfWork.beginModelCall({
    taskId,
    iteration: 1,
    request: {
      model: "mock-model",
      messages: [{ role: "user", content: "Create two reads" }],
      tools: [],
    },
  });
  unitOfWork.completeModelCallWithPlan({
    modelCallId: modelCall.id,
    durationMs: 1,
    response: {
      message: {
        role: "assistant",
        content: "Read twice.",
        toolCalls: [
          { id: callIdA, name: "bom_get_items", arguments: {} },
          { id: callIdB, name: "bom_get_items", arguments: {} },
        ],
      },
      usage: { source: "provider" },
    },
    plan: {
      id: "plan-multiple",
      version: 1,
      steps: [
        {
          id: planStepId,
          stepIndex: 0,
          kind: "read_batch",
        },
      ],
      toolRuns: [
        {
          id: "run-multiple-a",
          planStepId,
          toolCallId: callIdA,
          originalIndex: 0,
          toolName: "bom_get_items",
          toolVersion: tool.version,
          inputSchemaHash: computeToolInputSchemaHash(tool.inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "read",
          requiresApproval: false,
          input: {},
        },
        {
          id: "run-multiple-b",
          planStepId,
          toolCallId: callIdB,
          originalIndex: 1,
          toolName: "bom_get_items",
          toolVersion: tool.version,
          inputSchemaHash: computeToolInputSchemaHash(tool.inputSchema),
          canonicalInputHash: computeCanonicalInputHash({}),
          mode: "read",
          requiresApproval: false,
          input: {},
        },
      ],
    },
  });
  return { taskId };
}

function createApproval(
  database: ForgeFlowDatabase,
  taskId: string,
  toolRunId: string,
  status: "pending" | "approved" | "rejected",
): void {
  const snapshot = new TaskSnapshotReader(database).load(taskId);
  const run = snapshot.toolRuns.find((candidate) => candidate.id === toolRunId);
  if (run === undefined) {
    throw new Error("ToolRun not found for approval fixture.");
  }
  runInTransaction(
    database,
    () => {
      const permit = createStorageWritePermit(database);
      const repository = new ApprovalRepository(database);
      const approval = repository.createPending(
        {
          id: `approval-${toolRunId}`,
          taskId,
          toolRunId,
          toolVersion: run.toolVersion,
          canonicalInputHash: run.canonicalInputHash,
          request: { summary: "approval fixture" },
          requestedAt: timestamp,
          expiresAt: null,
        },
        permit,
      );
      if (status !== "pending") {
        repository.decide(
          approval.id,
          status,
          status === "rejected" ? "rejected fixture" : null,
          timestamp,
          permit,
        );
      }
    },
    "immediate",
  );
}

const timestamp = "2026-01-01T00:00:00.000Z";

function startWorker(config: {
  databasePath: string;
  taskId: string;
  ownerId: string;
  now: string;
}): Promise<ChildProcess> {
  const worker = fork(workerPath, [JSON.stringify(config)], {
    execArgv: ["--import", "tsx"],
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  workers.push(worker);

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Recovery worker did not become ready."));
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
      reject(
        new Error(`Recovery worker exited before readiness: ${String(code)}`),
      );
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

function beginInspection(
  worker: ChildProcess,
): Promise<BeginInspectionResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Recovery worker timed out."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        (message.type === "complete" || message.type === "claimed")
      ) {
        cleanup();
        resolve(message as BeginInspectionResult);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(
          new Error(`Recovery worker exited with code ${String(code)}`),
        );
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

function finishInspection(worker: ChildProcess): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Recovery worker finish timed out."));
    }, 15_000);
    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete"
      ) {
        cleanup();
        resolve(message as WorkerResult);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(
          new Error(`Recovery worker exited with code ${String(code)}`),
        );
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.send({ type: "finish" });
  });
}
