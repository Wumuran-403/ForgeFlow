import type Database from "better-sqlite3";

import { ModelUsageSchema } from "../provider/types.js";
import { decodeJson } from "../storage/json-codec.js";
import { EvaluationRepository } from "../evaluation/repository.js";

interface CountRow { key: string; count: number }

export interface ObservabilitySummary {
  readonly tasks: { readonly total: number; readonly byStatus: Readonly<Record<string, number>> };
  readonly tools: { readonly total: number; readonly failed: number; readonly byStatus: Readonly<Record<string, number>> };
  readonly tokens: { readonly provider: number; readonly estimated: number; readonly unknownCalls: number };
  readonly latency: { readonly completedTasks: number; readonly averageMs: number; readonly p50Ms: number; readonly p95Ms: number };
  readonly loopGuard: { readonly detections: number; readonly affectedTasks: number; readonly byReason: Readonly<Record<string, number>> };
  readonly recovery: { readonly eligibleTasks: number; readonly successfulTasks: number; readonly unknownWriteTasks: number };
  readonly mcp: { readonly calls: number; readonly succeeded: number; readonly failed: number };
  readonly evaluations: { readonly runs: number; readonly completed: number; readonly failed: number };
  readonly ratios: {
    readonly taskSuccess: { readonly numerator: number; readonly denominator: number };
    readonly toolSuccess: { readonly numerator: number; readonly denominator: number };
    readonly recoverySuccess: { readonly numerator: number; readonly denominator: number };
    readonly mcpSuccess: { readonly numerator: number; readonly denominator: number };
  };
}

export class ObservabilityMetricsService {
  constructor(private readonly database: Database.Database) {}

  summary(tracePrefix?: string): ObservabilitySummary {
    const taskFilter = tracePrefix === undefined ? { sql: "", params: [] as unknown[] }
      : { sql: " WHERE trace_id LIKE ?", params: [`${tracePrefix}%`] };
    const statuses = this.database.prepare(`SELECT status AS key, COUNT(*) AS count FROM tasks${taskFilter.sql} GROUP BY status`)
      .all(...taskFilter.params) as CountRow[];
    const byStatus = Object.fromEntries(statuses.map((row) => [row.key, row.count]));
    const total = statuses.reduce((sum, row) => sum + row.count, 0);
    const joinFilter = tracePrefix === undefined ? { sql: "", params: [] as unknown[] }
      : { sql: " WHERE task_id IN (SELECT id FROM tasks WHERE trace_id LIKE ?)", params: [`${tracePrefix}%`] };
    const toolRows = this.database.prepare(`SELECT status AS key, COUNT(*) AS count FROM tool_runs${joinFilter.sql} GROUP BY status`)
      .all(...joinFilter.params) as CountRow[];
    const toolsByStatus = Object.fromEntries(toolRows.map((row) => [row.key, row.count]));
    const modelRows = this.database.prepare(`SELECT usage_json FROM model_calls${joinFilter.sql}${joinFilter.sql === "" ? " WHERE" : " AND"} status = 'completed' AND usage_json IS NOT NULL`)
      .all(...joinFilter.params) as Array<{ usage_json: string }>;
    let provider = 0; let estimated = 0; let unknownCalls = 0;
    for (const row of modelRows) {
      const usage = decodeJson(ModelUsageSchema, row.usage_json, "model_calls.usage_json");
      if (usage.source === "provider") provider += usage.totalTokens ?? 0;
      else if (usage.source === "estimated") estimated += usage.totalTokens ?? 0;
      else unknownCalls += 1;
    }
    const latencyRows = this.database.prepare(`SELECT CAST((julianday(completed_at) - julianday(created_at)) * 86400000 AS INTEGER) AS latency FROM tasks${taskFilter.sql}${taskFilter.sql === "" ? " WHERE" : " AND"} completed_at IS NOT NULL ORDER BY latency`)
      .all(...taskFilter.params) as Array<{ latency: number }>;
    const latencies = latencyRows.map((row) => Math.max(0, row.latency));
    const loop = { ...this.eventCounts("loop_detected", tracePrefix), byReason: this.loopReasons(tracePrefix) };
    const recoveryEligible = this.distinctTaskCount("type IN ('recovery.read_completed', 'recovery.read_retried', 'tool.unknown')", tracePrefix);
    const recoverySuccess = this.recoverySuccessCount(tracePrefix);
    const unknownWriteTasks = this.distinctTaskCount("type = 'tool.unknown'", tracePrefix);
    const mcpFilter = `${joinFilter.sql}${joinFilter.sql === "" ? " WHERE" : " AND"} tool_name LIKE 'mcp_%'`;
    const mcpRows = this.database.prepare(`SELECT status AS key, COUNT(*) AS count FROM tool_runs${mcpFilter} GROUP BY status`).all(...joinFilter.params) as CountRow[];
    const mcpByStatus = Object.fromEntries(mcpRows.map((row) => [row.key, row.count]));
    const evaluationRows = this.database.prepare("SELECT status AS key, COUNT(*) AS count FROM evaluation_runs GROUP BY status").all() as CountRow[];
    const evaluationByStatus = Object.fromEntries(evaluationRows.map((row) => [row.key, row.count]));
    return {
      tasks: { total, byStatus },
      tools: { total: toolRows.reduce((sum, row) => sum + row.count, 0), failed: (toolsByStatus.failed ?? 0) + (toolsByStatus.timed_out ?? 0), byStatus: toolsByStatus },
      tokens: { provider, estimated, unknownCalls },
      latency: { completedTasks: latencies.length, averageMs: average(latencies), p50Ms: percentile(latencies, 0.5), p95Ms: percentile(latencies, 0.95) },
      loopGuard: loop,
      recovery: { eligibleTasks: recoveryEligible, successfulTasks: recoverySuccess, unknownWriteTasks },
      mcp: { calls: mcpRows.reduce((sum, row) => sum + row.count, 0), succeeded: mcpByStatus.succeeded ?? 0, failed: (mcpByStatus.failed ?? 0) + (mcpByStatus.timed_out ?? 0) },
      evaluations: { runs: evaluationRows.reduce((sum, row) => sum + row.count, 0), completed: evaluationByStatus.completed ?? 0, failed: evaluationByStatus.failed ?? 0 },
      ratios: {
        taskSuccess: { numerator: byStatus.completed ?? 0, denominator: (byStatus.completed ?? 0) + (byStatus.failed ?? 0) + (byStatus.cancelled ?? 0) },
        toolSuccess: { numerator: toolsByStatus.succeeded ?? 0, denominator: terminalToolCount(toolsByStatus) },
        recoverySuccess: { numerator: recoverySuccess, denominator: recoveryEligible },
        mcpSuccess: { numerator: mcpByStatus.succeeded ?? 0, denominator: terminalToolCount(mcpByStatus) },
      },
    };
  }

  evaluationHistory(limit = 50) { return new EvaluationRepository(this.database).listRuns(limit); }

  evaluationReport(runId: string) {
    const repository = new EvaluationRepository(this.database);
    return { run: repository.getRun(runId), cases: repository.listCaseResults(runId) };
  }

  private eventCounts(type: string, tracePrefix?: string): { detections: number; affectedTasks: number } {
    const filter = tracePrefix === undefined ? "" : " AND task_id IN (SELECT id FROM tasks WHERE trace_id LIKE ?)";
    const row = this.database.prepare(`SELECT COUNT(*) AS detections, COUNT(DISTINCT task_id) AS affectedTasks FROM events WHERE type = ?${filter}`)
      .get(...(tracePrefix === undefined ? [type] : [type, `${tracePrefix}%`])) as { detections: number; affectedTasks: number };
    return row;
  }

  private distinctTaskCount(condition: string, tracePrefix?: string): number {
    const filter = tracePrefix === undefined ? "" : " AND task_id IN (SELECT id FROM tasks WHERE trace_id LIKE ?)";
    const row = this.database.prepare(`SELECT COUNT(DISTINCT task_id) AS count FROM events WHERE ${condition}${filter}`)
      .get(...(tracePrefix === undefined ? [] : [`${tracePrefix}%`])) as { count: number };
    return row.count;
  }

  private recoverySuccessCount(tracePrefix?: string): number {
    const filter = tracePrefix === undefined ? "" : " AND task.trace_id LIKE ?";
    const row = this.database.prepare(`
      SELECT COUNT(DISTINCT event.task_id) AS count
      FROM events AS event
      JOIN tasks AS task ON task.id = event.task_id
      WHERE event.type IN ('recovery.read_completed', 'recovery.read_retried')
        AND task.status = 'completed'
        AND NOT EXISTS (
          SELECT 1 FROM tool_runs AS tool_run
          WHERE tool_run.task_id = event.task_id AND tool_run.status = 'unknown'
        )${filter}
    `).get(...(tracePrefix === undefined ? [] : [`${tracePrefix}%`])) as { count: number };
    return row.count;
  }

  private loopReasons(tracePrefix?: string): Readonly<Record<string, number>> {
    const filter = tracePrefix === undefined ? "" : " AND task_id IN (SELECT id FROM tasks WHERE trace_id LIKE ?)";
    const rows = this.database.prepare(`
      SELECT COALESCE(json_extract(payload_json, '$.reason'), 'unknown') AS key,
             COUNT(*) AS count
      FROM events
      WHERE type = 'loop_detected'${filter}
      GROUP BY key
    `).all(...(tracePrefix === undefined ? [] : [`${tracePrefix}%`])) as CountRow[];
    return Object.fromEntries(rows.map((row) => [row.key, row.count]));
  }
}

function average(values: readonly number[]): number { return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length; }
function percentile(values: readonly number[], p: number): number { return values.length === 0 ? 0 : values[Math.max(0, Math.ceil(values.length * p) - 1)] ?? 0; }
function terminalToolCount(statuses: Readonly<Record<string, number>>): number {
  return ["succeeded", "failed", "timed_out", "cancelled", "unknown"]
    .reduce((total, status) => total + (statuses[status] ?? 0), 0);
}
