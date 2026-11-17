import type Database from "better-sqlite3";
import { z } from "zod";

import { PersistedErrorSchema } from "../storage/types.js";
import { decodeJson, encodeJson } from "../storage/json-codec.js";
import {
  EvaluationAggregateSchema,
  EvaluationCaseSchema,
  EvaluationMetricSchema,
  EvaluationObservationSchema,
  EvaluationVerdictSchema,
  type EvaluationAggregate,
  type EvaluationCase,
  type EvaluationObservation,
  type EvaluationVerdict,
} from "./types.js";

const RunStatusSchema = z.enum(["running", "completed", "failed"]);

export interface EvaluationRunRecord {
  readonly id: string;
  readonly suiteVersion: string;
  readonly providerId: string;
  readonly configVersion: string;
  readonly status: z.infer<typeof RunStatusSchema>;
  readonly caseCount: number;
  readonly passedCount: number | null;
  readonly aggregate: EvaluationAggregate | null;
  readonly startedAt: string;
  readonly finishedAt: string | null;
}

export interface EvaluationCaseResultRecord {
  readonly caseId: string;
  readonly category: string;
  readonly status: "passed" | "failed" | "error";
  readonly expected: EvaluationCase["expectation"];
  readonly observation: EvaluationObservation | null;
  readonly verdict: EvaluationVerdict;
  readonly latencyMs: number;
  readonly error: z.infer<typeof PersistedErrorSchema> | null;
}

interface RunRow { id: string; suite_version: string; provider_id: string; config_version: string; status: string; case_count: number; passed_count: number | null; aggregate_json: string | null; started_at: string; finished_at: string | null }

export class EvaluationRepository {
  constructor(private readonly database: Database.Database) {}

  createRun(input: { id: string; suiteVersion: string; providerId: string; configVersion: string; caseCount: number; startedAt: string }): void {
    this.database.prepare(`INSERT INTO evaluation_runs (id, suite_version, provider_id, config_version, status, case_count, started_at) VALUES (?, ?, ?, ?, 'running', ?, ?)`)
      .run(input.id, input.suiteVersion, input.providerId, input.configVersion, input.caseCount, input.startedAt);
  }

  addCaseResult(input: { id: string; runId: string; evaluationCase: EvaluationCase; status: "passed" | "failed" | "error"; observation: EvaluationObservation | null; verdict: EvaluationVerdict; error: unknown | null; latencyMs: number; createdAt: string }): void {
    const parsedCase = EvaluationCaseSchema.parse(input.evaluationCase);
    this.database.prepare(`INSERT INTO evaluation_case_results (id, run_id, case_id, category, status, expected_json, observation_json, verdict_json, error_json, latency_ms, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(input.id, input.runId, parsedCase.id, parsedCase.category, input.status,
        JSON.stringify(parsedCase.expectation), input.observation === null ? null : encodeJson(EvaluationObservationSchema, input.observation, "evaluation_case_results.observation_json"),
        encodeJson(EvaluationVerdictSchema, input.verdict, "evaluation_case_results.verdict_json"),
        input.error === null ? null : encodeJson(PersistedErrorSchema, input.error, "evaluation_case_results.error_json"), input.latencyMs, input.createdAt);
  }

  completeRun(runId: string, aggregate: EvaluationAggregate, finishedAt: string): void {
    const parsed = EvaluationAggregateSchema.parse(aggregate);
    const transaction = this.database.transaction(() => {
      for (const metric of parsed.metrics) {
        const value = EvaluationMetricSchema.parse(metric);
        this.database.prepare(`INSERT INTO evaluation_metrics (run_id, metric_name, value, numerator, denominator, unit, exclusions, definition) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(runId, value.name, value.value, value.numerator, value.denominator, value.unit, value.exclusions, value.definition);
      }
      const result = this.database.prepare(`UPDATE evaluation_runs SET status = 'completed', passed_count = ?, aggregate_json = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
        .run(parsed.passedCount, JSON.stringify(parsed), finishedAt, runId);
      if (result.changes !== 1) throw new Error("Evaluation run is not running.");
    });
    transaction();
  }

  failRun(runId: string, error: unknown, finishedAt: string): void {
    this.database.prepare(`UPDATE evaluation_runs SET status = 'failed', error_json = ?, finished_at = ? WHERE id = ? AND status = 'running'`)
      .run(encodeJson(PersistedErrorSchema, error, "evaluation_runs.error_json"), finishedAt, runId);
  }

  getRun(runId: string): EvaluationRunRecord {
    const row = this.database.prepare("SELECT * FROM evaluation_runs WHERE id = ?").get(runId) as RunRow | undefined;
    if (row === undefined) throw new Error(`Evaluation run '${runId}' was not found.`);
    return { id: row.id, suiteVersion: row.suite_version, providerId: row.provider_id,
      configVersion: row.config_version, status: RunStatusSchema.parse(row.status), caseCount: row.case_count,
      passedCount: row.passed_count, aggregate: row.aggregate_json === null ? null : decodeJson(EvaluationAggregateSchema, row.aggregate_json, "evaluation_runs.aggregate_json"),
      startedAt: row.started_at, finishedAt: row.finished_at };
  }

  listRuns(limit = 50): readonly EvaluationRunRecord[] {
    const rows = this.database.prepare("SELECT * FROM evaluation_runs ORDER BY started_at DESC, id DESC LIMIT ?").all(limit) as RunRow[];
    return rows.map((row) => this.getRun(row.id));
  }

  listCaseResults(runId: string): readonly EvaluationCaseResultRecord[] {
    const rows = this.database.prepare("SELECT * FROM evaluation_case_results WHERE run_id = ? ORDER BY case_id").all(runId) as Array<Record<string, unknown>>;
    return rows.map((row) => ({
      caseId: String(row.case_id), category: String(row.category), status: z.enum(["passed", "failed", "error"]).parse(row.status),
      expected: EvaluationCaseSchema.shape.expectation.parse(JSON.parse(String(row.expected_json)) as unknown),
      observation: row.observation_json === null ? null : decodeJson(EvaluationObservationSchema, String(row.observation_json), "evaluation_case_results.observation_json"),
      verdict: decodeJson(EvaluationVerdictSchema, String(row.verdict_json), "evaluation_case_results.verdict_json"),
      latencyMs: Number(row.latency_ms),
      error: row.error_json === null ? null : decodeJson(PersistedErrorSchema, String(row.error_json), "evaluation_case_results.error_json"),
    }));
  }
}
