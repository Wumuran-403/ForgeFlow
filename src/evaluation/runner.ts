import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { runInTransaction } from "../storage/transaction.js";
import { EvaluationRepository, type EvaluationRunRecord } from "./repository.js";
import { calculateMetrics, judgeCase, type EvaluatedCase } from "./metrics.js";
import { EvaluationObservationSchema, type EvaluationExecutor, type EvaluationSuite, type EvaluationVerdict } from "./types.js";

export interface EvaluationRunnerOptions {
  readonly providerId: string;
  readonly configVersion: string;
  readonly now?: () => Date;
  readonly monotonicNow?: () => number;
}

export class EvaluationRunner {
  private readonly repository: EvaluationRepository;
  private readonly now: () => Date;
  private readonly monotonicNow: () => number;

  constructor(
    private readonly database: Database.Database,
    private readonly executor: EvaluationExecutor,
    private readonly options: EvaluationRunnerOptions,
  ) {
    this.repository = new EvaluationRepository(database);
    this.now = options.now ?? (() => new Date());
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
  }

  async run(suite: EvaluationSuite): Promise<EvaluationRunRecord> {
    if (suite.cases.length === 0) throw new Error("Evaluation suite must not be empty.");
    const runId = `eval-${randomUUID()}`;
    this.repository.createRun({ id: runId, suiteVersion: suite.version,
      providerId: this.options.providerId, configVersion: this.options.configVersion,
      caseCount: suite.cases.length, startedAt: this.now().toISOString() });
    const evaluated: EvaluatedCase[] = [];
    try {
      for (const evaluationCase of suite.cases) {
        const started = this.monotonicNow();
        try {
          const observation = EvaluationObservationSchema.parse(await this.executor.execute(evaluationCase));
          const latencyMs = Math.max(0, Math.round(this.monotonicNow() - started));
          const verdict = judgeCase(evaluationCase, observation);
          runInTransaction(this.database, () => this.repository.addCaseResult({
            id: `case-result-${randomUUID()}`, runId, evaluationCase,
            status: verdict.passed ? "passed" : "failed", observation, verdict,
            error: null, latencyMs, createdAt: this.now().toISOString(),
          }));
          evaluated.push({ evaluationCase, observation, verdict, latencyMs });
        } catch (error) {
          const latencyMs = Math.max(0, Math.round(this.monotonicNow() - started));
          const persistedError = safeError(error);
          const verdict: EvaluationVerdict = { passed: false, reasons: ["executor_error"], correctToolCalls: 0,
            expectedToolCalls: evaluationCase.expectation.toolCalls.length, unexpectedToolCalls: 0 };
          runInTransaction(this.database, () => this.repository.addCaseResult({
            id: `case-result-${randomUUID()}`, runId, evaluationCase, status: "error",
            observation: null, verdict, error: persistedError, latencyMs,
            createdAt: this.now().toISOString(),
          }));
          evaluated.push({ evaluationCase, observation: null, verdict, latencyMs });
        }
      }
      const aggregate = calculateMetrics(evaluated);
      this.repository.completeRun(runId, aggregate, this.now().toISOString());
      return this.repository.getRun(runId);
    } catch (error) {
      this.repository.failRun(runId, safeError(error), this.now().toISOString());
      throw error;
    }
  }
}

function safeError(error: unknown): { code: string; message: string; details: readonly { path: string; message: string }[] } {
  if (typeof error === "object" && error !== null && "code" in error && "message" in error &&
      typeof error.code === "string" && typeof error.message === "string") {
    return { code: error.code, message: error.message, details: [] };
  }
  return { code: "EVALUATION_CASE_FAILED", message: error instanceof Error ? error.message : "Evaluation case failed.", details: [] };
}
