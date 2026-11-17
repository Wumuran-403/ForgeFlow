import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

export const phase6_3AnonymousBudgetMigration: Migration = {
  version: 12,
  name: "phase6_3_anonymous_global_budget",
  up: (database: Database.Database) => {
    database.exec(`
      CREATE TABLE global_model_budget_days (
        budget_date TEXT PRIMARY KEY,
        settled_tokens INTEGER NOT NULL DEFAULT 0 CHECK (settled_tokens >= 0),
        reserved_tokens INTEGER NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
        provider_tokens INTEGER NOT NULL DEFAULT 0 CHECK (provider_tokens >= 0),
        estimated_tokens INTEGER NOT NULL DEFAULT 0 CHECK (estimated_tokens >= 0),
        unknown_tokens INTEGER NOT NULL DEFAULT 0 CHECK (unknown_tokens >= 0),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE global_model_budget_reservations (
        id TEXT PRIMARY KEY,
        budget_date TEXT NOT NULL REFERENCES global_model_budget_days(budget_date) ON DELETE RESTRICT,
        reserved_tokens INTEGER NOT NULL CHECK (reserved_tokens > 0),
        charged_tokens INTEGER CHECK (charged_tokens IS NULL OR charged_tokens >= 0),
        status TEXT NOT NULL CHECK (status IN ('reserved', 'settled')),
        usage_source TEXT CHECK (usage_source IS NULL OR usage_source IN ('provider', 'estimated', 'unknown')),
        created_at TEXT NOT NULL,
        settled_at TEXT
      );

      CREATE INDEX ix_global_model_budget_reservations_day_status
        ON global_model_budget_reservations(budget_date, status, created_at);
    `);
  },
};
