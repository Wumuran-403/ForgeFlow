import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

export const phase4_3TokenBudgetMigration: Migration = {
  version: 10,
  name: "phase4_3_task_token_budget",
  up: (database: Database.Database) => {
    database.exec(`
      ALTER TABLE tasks
      ADD COLUMN max_tokens INTEGER
      CHECK (max_tokens IS NULL OR max_tokens > 0)
    `);
  },
};
