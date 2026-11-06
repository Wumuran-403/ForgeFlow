import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ApprovalRepository,
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  PlanStepRepository,
  runInTransaction,
  TaskLeaseManager,
  ToolRunRepository,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
});

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("Step 4 lease schema", () => {
  it("creates task_leases with fencing history and PlanStep version", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const leaseColumns = activeDatabase.pragma(
      "table_info(task_leases)",
    ) as Array<{ name: string; pk: number; notnull: number }>;

    expect(leaseColumns.find((column) => column.name === "task_id")).toMatchObject(
      { pk: 1 },
    );
    for (const column of ["fencing_token", "heartbeat_at", "updated_at"]) {
      expect(
        leaseColumns.find((item) => item.name === column)?.notnull,
      ).toBe(1);
    }
    expect(
      (
        activeDatabase.pragma("table_info(plan_steps)") as Array<{
          name: string;
          notnull: number;
        }>
      ).find((column) => column.name === "version"),
    ).toMatchObject({ notnull: 1 });

    const sql = (
      activeDatabase
        .prepare(
          `
            SELECT sql FROM sqlite_master
            WHERE sql IS NOT NULL
          `,
        )
        .all() as Array<{ sql: string }>
    ).map((row) => row.sql).join("\n");
    expect(sql).toContain("task_leases_reject_delete");
    expect(sql).toContain("task_leases_reject_fencing_regression");
    expect(sql).toContain("tasks_reject_terminal_with_active_review");
    expect(sql).toContain("tasks_reject_terminal_with_active_execution");
  });

  it("retains lease rows and fencing tokens across release", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    new ExecutionUnitOfWork(activeDatabase).createTask({
      taskId: "task-retained-lease",
      traceId: "trace-retained-lease",
      objective: "Retain lease history",
      systemPrompt: "You are ForgeFlow.",
      maxModelTurns: 10,
      maxToolCalls: 20,
    });
    const manager = new TaskLeaseManager(activeDatabase, {
      now: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const lease = manager.claim("task-retained-lease", "worker-a");

    expect(() =>
      activeDatabase
        .prepare("DELETE FROM task_leases WHERE task_id = ?")
        .run("task-retained-lease"),
    ).toThrow(/retained/);
    expect(() =>
      activeDatabase
        .prepare(
          "UPDATE task_leases SET fencing_token = 0 WHERE task_id = ?",
        )
        .run("task-retained-lease"),
    ).toThrow();

    const released = manager.release(
      "task-retained-lease",
      lease.leaseToken as string,
      lease.fencingToken,
    );
    expect(released).toMatchObject({
      fencingToken: 1,
      ownerId: null,
      leaseToken: null,
    });
    expect(
      activeDatabase
        .prepare(
          "SELECT fencing_token FROM task_leases WHERE task_id = ?",
        )
        .get("task-retained-lease"),
    ).toEqual({ fencing_token: 1 });
  });

  it("enforces terminal invariants in SQLite without application helpers", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    for (const status of ["completed", "failed", "cancelled"] as const) {
      const taskId = `task-trigger-active-${status}`;
      createTask(activeDatabase, taskId);
      insertPlan(
        activeDatabase,
        taskId,
        `plan-${taskId}`,
        `step-${taskId}`,
        "queued",
      );
      expect(() =>
        activeDatabase
          .prepare("UPDATE tasks SET status = ? WHERE id = ?")
          .run(status, taskId),
      ).toThrow(/active/);
    }

    const failedPlanTask = "task-trigger-failed-plan";
    createTask(activeDatabase, failedPlanTask);
    insertPlan(
      activeDatabase,
      failedPlanTask,
      "plan-failed-step",
      "step-failed-step",
      "failed",
    );
    expect(() =>
      activeDatabase
        .prepare("UPDATE tasks SET status = 'completed' WHERE id = ?")
        .run(failedPlanTask),
    ).toThrow(/active execution state/i);
    expect(() =>
      activeDatabase
        .prepare("UPDATE tasks SET status = 'failed' WHERE id = ?")
        .run(failedPlanTask),
    ).not.toThrow();

    const terminalInsert = "task-terminal-insert";
    createTask(activeDatabase, terminalInsert);
    insertPlan(
      activeDatabase,
      terminalInsert,
      "plan-terminal-insert",
      "step-terminal-complete",
      "completed",
    );
    activeDatabase
      .prepare("UPDATE tasks SET status = 'completed' WHERE id = ?")
      .run(terminalInsert);
    expect(() =>
      runInTransaction(
        activeDatabase,
        () => {
          const permit = createStorageWritePermit(activeDatabase);
          return new PlanStepRepository(activeDatabase).insert(
            {
              id: "step-after-terminal",
              taskId: terminalInsert,
              planId: "plan-terminal-insert",
              stepIndex: 1,
              kind: "read_batch",
              status: "queued",
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrowError(/terminal task/i);
    expect(() =>
      activeDatabase
        .prepare(
          `
            INSERT INTO plan_steps (
              id, task_id, plan_id, step_index, kind,
              status, created_at, updated_at
            ) VALUES (?, ?, ?, 1, 'read_batch', 'queued', ?, ?)
          `,
        )
        .run(
          "step-after-terminal-raw",
          terminalInsert,
          "plan-terminal-insert",
          "2026-01-01T00:00:00.000Z",
          "2026-01-01T00:00:00.000Z",
        ),
    ).toThrow(/terminal task/i);
    expect(() =>
      runInTransaction(
        activeDatabase,
        () => {
          const permit = createStorageWritePermit(activeDatabase);
          return new ToolRunRepository(activeDatabase).createIntent(
            {
              id: "run-after-terminal",
              taskId: terminalInsert,
              planStepId: "step-terminal-complete",
              toolCallId: "call-after-terminal",
              originalIndex: 0,
              toolName: "inventory_lookup",
              toolVersion: "1",
              inputSchemaHash: `sha256:${"a".repeat(64)}`,
              canonicalInputHash: `sha256:${"b".repeat(64)}`,
              mode: "read",
              requiresApproval: false,
              status: "queued",
              input: {},
              idempotencyKey: `sha256:${"c".repeat(64)}`,
              attemptNo: 1,
              createdAt: "2026-01-01T00:00:00.000Z",
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrowError(/terminal task/i);
    expect(() =>
      runInTransaction(
        activeDatabase,
        () => {
          const permit = createStorageWritePermit(activeDatabase);
          return new ApprovalRepository(activeDatabase).createPending(
            {
              id: "approval-after-terminal",
              taskId: terminalInsert,
              toolRunId: "run-after-terminal",
              toolVersion: "1",
              canonicalInputHash: `sha256:${"b".repeat(64)}`,
              request: {},
              requestedAt: "2026-01-01T00:00:00.000Z",
              expiresAt: null,
            },
            permit,
          );
        },
        "immediate",
      ),
    ).toThrowError(/terminal task/i);
  });
});

function createTask(database: ForgeFlowDatabase, taskId: string): void {
  new ExecutionUnitOfWork(database).createTask({
    taskId,
    traceId: `trace-${taskId}`,
    objective: "Terminal invariant test",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
}

function insertPlan(
  database: ForgeFlowDatabase,
  taskId: string,
  planId: string,
  stepId: string,
  stepStatus: "queued" | "failed" | "completed",
): void {
  const now = "2026-01-01T00:00:00.000Z";
  database
    .prepare(
      `
        INSERT INTO model_calls (
          id, task_id, iteration, attempt_no, status,
          request_json, started_at
        ) VALUES (?, ?, 1, 1, 'requested', '{}', ?)
      `,
    )
    .run(`call-${taskId}`, taskId, now);
  database
    .prepare(
      `
        INSERT INTO execution_plans (
          id, task_id, version, source_model_call_id,
          status, created_at, updated_at
        ) VALUES (?, ?, 1, ?, 'active', ?, ?)
      `,
    )
    .run(planId, taskId, `call-${taskId}`, now, now);
  database
    .prepare(
      `
        INSERT INTO plan_steps (
          id, task_id, plan_id, step_index, kind,
          status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'read_batch', ?, ?, ?)
      `,
    )
    .run(stepId, taskId, planId, stepStatus, now, now);
}
