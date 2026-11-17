import { afterEach, describe, expect, it } from "vitest";

import { EvaluationRepository, EvaluationRunner, PHASE6_1_EVALUATION_SUITE, Phase61ReferenceExecutor, type EvaluationExecutor, type EvaluationObservation } from "../../src/evaluation/index.js";
import { closeDatabase, migrateStorage, openDatabase } from "../../src/storage/index.js";
import { createTemporaryDatabase, type TemporaryDatabase } from "../storage/test-database.js";

const temporaryDatabases: TemporaryDatabase[] = [];
afterEach(() => { for (const temporary of temporaryDatabases.splice(0)) temporary.cleanup(); });

class ExpectedExecutor implements EvaluationExecutor {
  async execute(evaluationCase: (typeof PHASE6_1_EVALUATION_SUITE.cases)[number]): Promise<EvaluationObservation> {
    return {
      outcome: evaluationCase.expectation.outcome,
      toolCalls: evaluationCase.expectation.toolCalls.map((call) => ({ ...call, mode: "read" as const, duplicateSideEffect: false, mcp: evaluationCase.expectation.mcpExpected })),
      recovery: { eligible: evaluationCase.expectation.recoveryEligible, succeeded: evaluationCase.expectation.recoveryMustSucceed, unknownWrite: evaluationCase.id === "unknown-write-blocked" },
      loopDetected: evaluationCase.expectation.loopExpected, approvalBypassed: false,
      providerTokens: { promptTokens: 2, completionTokens: 1, totalTokens: 3 },
      estimatedTokens: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
    };
  }
}

describe("EvaluationRunner", () => {
  it("persists isolated runs and rebuilds reports after reopening SQLite", async () => {
    const temporary = createTemporaryDatabase(); temporaryDatabases.push(temporary);
    let database = openDatabase(temporary.path); migrateStorage(database);
    const runner = new EvaluationRunner(database, new ExpectedExecutor(), { providerId: "mock", configVersion: "test-v1" });
    const first = await runner.run(PHASE6_1_EVALUATION_SUITE);
    const second = await runner.run(PHASE6_1_EVALUATION_SUITE);
    expect(first.id).not.toBe(second.id);
    expect(first.aggregate).toMatchObject({ caseCount: 30, passedCount: 30 });
    closeDatabase(database);
    database = openDatabase(temporary.path); migrateStorage(database);
    const repository = new EvaluationRepository(database);
    expect(repository.listRuns()).toHaveLength(2);
    expect(repository.listCaseResults(first.id)).toHaveLength(30);
    expect(repository.getRun(first.id).aggregate?.metrics.find((metric) => metric.name === "provider_token_usage")?.value).toBe(90);
    expect(repository.getRun(first.id).aggregate?.metrics.find((metric) => metric.name === "estimated_token_usage")?.value).toBe(60);
    closeDatabase(database);
  });

  it("executes all 30 fixed cases against deterministic tools, LoopGuard, and real MCP stdio", async () => {
    const database = openDatabase(":memory:"); migrateStorage(database);
    try {
      const run = await new EvaluationRunner(database, new Phase61ReferenceExecutor(), { providerId: "mock+deterministic-tools", configVersion: "phase6.1-v1" }).run(PHASE6_1_EVALUATION_SUITE);
      expect(run.aggregate).toMatchObject({ caseCount: 30, passedCount: 30, failedCount: 0 });
      expect(run.aggregate?.metrics.find((metric) => metric.name === "mcp_tool_execution_success_rate")?.value).toBe(1);
    } finally { closeDatabase(database); }
  }, 30_000);
});
