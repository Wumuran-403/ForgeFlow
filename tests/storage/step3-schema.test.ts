import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
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

describe("Step 3 execution schema", () => {
  it("defines required columns and composite same-task foreign keys", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const requiredColumns: Record<string, readonly string[]> = {
      execution_plans: [
        "task_id",
        "version",
        "source_model_call_id",
        "status",
        "created_at",
        "updated_at",
      ],
      plan_steps: [
        "task_id",
        "plan_id",
        "step_index",
        "kind",
        "status",
      ],
      tool_runs: [
        "task_id",
        "plan_step_id",
        "call_id",
        "original_index",
        "tool_name",
        "tool_version",
        "input_schema_hash",
        "canonical_input_hash",
        "mode",
        "requires_approval",
        "status",
        "input_json",
        "idempotency_key",
        "attempt_no",
      ],
      approvals: [
        "task_id",
        "tool_run_id",
        "status",
        "tool_version",
        "canonical_input_hash",
        "request_json",
        "requested_at",
      ],
      recovery_reviews: [
        "task_id",
        "tool_run_id",
        "status",
        "created_at",
        "updated_at",
      ],
    };

    for (const [table, columns] of Object.entries(requiredColumns)) {
      const tableInfo = activeDatabase.pragma(`table_info(${table})`) as Array<{
        name: string;
        notnull: number;
      }>;
      for (const column of columns) {
        expect(tableInfo.find((item) => item.name === column)?.notnull).toBe(1);
      }
    }

    expect(
      activeDatabase.pragma("foreign_key_list(execution_plans)"),
    ).toContainEqual(
      expect.objectContaining({
        table: "model_calls",
        from: "task_id",
        to: "task_id",
      }),
    );
    expect(
      activeDatabase.pragma("foreign_key_list(plan_steps)"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "execution_plans",
          from: "task_id",
          to: "task_id",
        }),
        expect.objectContaining({
          table: "execution_plans",
          from: "plan_id",
          to: "id",
        }),
      ]),
    );
    expect(
      activeDatabase.pragma("foreign_key_list(tool_runs)"),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          table: "plan_steps",
          from: "task_id",
          to: "task_id",
        }),
        expect.objectContaining({
          table: "plan_steps",
          from: "plan_step_id",
          to: "id",
        }),
      ]),
    );
  });

  it("defines status CHECKs, single-record uniques, and completion triggers", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const sql = (
      activeDatabase
        .prepare(
          `
            SELECT name, sql
            FROM sqlite_master
            WHERE sql IS NOT NULL
          `,
        )
        .all() as Array<{ name: string; sql: string }>
    ).map((row) => row.sql).join("\n");

    expect(sql).toContain("'awaiting_approval'");
    expect(sql).toContain("'confirmed_not_executed'");
    expect(sql).toContain("ux_approvals_one_per_run");
    expect(sql).toContain("ux_recovery_reviews_one_per_run");
    expect(sql).toContain("plan_steps_completion_guard");
    expect(sql).toContain("plan step has blocking tool run");
  });
});
