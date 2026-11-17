import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

export const phase6_1EvaluationMigration: Migration = {
  version: 11,
  name: "phase6_1_evaluation_metrics",
  up: (database: Database.Database) => {
    database.exec(`
      CREATE TABLE evaluation_runs (
        id TEXT PRIMARY KEY,
        suite_version TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        config_version TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed')),
        case_count INTEGER NOT NULL CHECK (case_count > 0),
        passed_count INTEGER CHECK (passed_count IS NULL OR passed_count >= 0),
        aggregate_json TEXT,
        error_json TEXT,
        started_at TEXT NOT NULL,
        finished_at TEXT
      );

      CREATE TABLE evaluation_case_results (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE RESTRICT,
        case_id TEXT NOT NULL,
        category TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'error')),
        expected_json TEXT NOT NULL,
        observation_json TEXT,
        verdict_json TEXT NOT NULL,
        error_json TEXT,
        latency_ms INTEGER NOT NULL CHECK (latency_ms >= 0),
        created_at TEXT NOT NULL,
        UNIQUE (run_id, case_id)
      );

      CREATE INDEX ix_evaluation_case_results_run
        ON evaluation_case_results(run_id, category, case_id);

      CREATE TABLE evaluation_metrics (
        run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE RESTRICT,
        metric_name TEXT NOT NULL,
        value REAL NOT NULL,
        numerator REAL,
        denominator REAL,
        unit TEXT NOT NULL,
        exclusions INTEGER NOT NULL DEFAULT 0 CHECK (exclusions >= 0),
        definition TEXT NOT NULL,
        PRIMARY KEY (run_id, metric_name)
      );
    `);
  },
};
