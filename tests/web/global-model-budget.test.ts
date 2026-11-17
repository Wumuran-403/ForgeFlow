import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { LLMProvider, ModelRequest } from "../../src/provider/types.js";
import { estimateJsonTokens } from "../../src/context/index.js";
import {
  closeDatabase,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { GlobalModelBudgetProvider } from "../../src/web/global-model-budget.js";
import { createTemporaryDatabase, type TemporaryDatabase } from "../storage/test-database.js";

const request: ModelRequest = {
  model: "paid-model",
  messages: [{ role: "user", content: "Inspect the STM32 inventory." }],
  tools: [],
};

let temporary: TemporaryDatabase;
let database: ForgeFlowDatabase;

beforeEach(() => {
  temporary = createTemporaryDatabase();
  database = openDatabase(temporary.path);
  migrateStorage(database);
});

afterEach(() => {
  closeDatabase(database);
  temporary.cleanup();
});

describe("global model budget provider", () => {
  it("persists provider usage and blocks a later request after database reopen", async () => {
    const firstInner: LLMProvider = { async generate() {
      return { message: { role: "assistant", content: "done" }, usage: { source: "provider", totalTokens: 990 } };
    } };
    const first = new GlobalModelBudgetProvider(database, firstInner, {
      maxTokensPerDay: 1_000,
      maxConcurrentCalls: 2,
      reservedCompletionTokens: 10,
      now: () => new Date("2026-11-16T01:00:00.000Z"),
    });
    await first.generate(request);
    expect(first.snapshot()).toMatchObject({
      settledTokens: 990,
      providerTokens: 990,
      reservedTokens: 0,
      remainingTokens: 10,
    });

    closeDatabase(database);
    database = openDatabase(temporary.path);
    migrateStorage(database);
    let calls = 0;
    const restarted = new GlobalModelBudgetProvider(database, { async generate() {
      calls += 1;
      return { message: { role: "assistant", content: "must not run" }, usage: { source: "provider", totalTokens: 1 } };
    } }, {
      maxTokensPerDay: 1_000,
      maxConcurrentCalls: 2,
      reservedCompletionTokens: 10,
      now: () => new Date("2026-11-16T02:00:00.000Z"),
    });
    await expect(restarted.generate(request)).rejects.toMatchObject({
      code: "GLOBAL_MODEL_BUDGET_EXHAUSTED",
    });
    expect(calls).toBe(0);
  });

  it("counts unknown usage conservatively and enforces global concurrency", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const provider = new GlobalModelBudgetProvider(database, { async generate() {
      started?.();
      await hold;
      throw new Error("network result unknown");
    } }, {
      maxTokensPerDay: 10_000,
      maxConcurrentCalls: 1,
      reservedCompletionTokens: 100,
      now: () => new Date("2026-11-16T03:00:00.000Z"),
    });
    const first = provider.generate(request);
    await began;
    await expect(provider.generate(request)).rejects.toMatchObject({
      code: "GLOBAL_PROVIDER_CONCURRENCY_EXHAUSTED",
    });
    release?.();
    await expect(first).rejects.toThrow("network result unknown");
    expect(provider.snapshot()).toMatchObject({ reservedTokens: 0 });
    expect(provider.snapshot().unknownTokens).toBeGreaterThan(0);
  });

  it("atomically prevents two provider instances from over-reserving the same daily budget", async () => {
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    const began = new Promise<void>((resolve) => { started = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const reservation = estimateJsonTokens(request) + 100;
    const first = new GlobalModelBudgetProvider(database, { async generate() {
      started?.();
      await hold;
      return { message: { role: "assistant", content: "done" }, usage: { source: "provider", totalTokens: 1 } };
    } }, {
      maxTokensPerDay: reservation,
      maxConcurrentCalls: 1,
      reservedCompletionTokens: 100,
    });
    let secondCalls = 0;
    const second = new GlobalModelBudgetProvider(database, { async generate() {
      secondCalls += 1;
      return { message: { role: "assistant", content: "must not run" }, usage: { source: "provider", totalTokens: 1 } };
    } }, {
      maxTokensPerDay: reservation,
      maxConcurrentCalls: 1,
      reservedCompletionTokens: 100,
    });
    const firstCall = first.generate(request);
    await began;
    await expect(second.generate(request)).rejects.toMatchObject({
      code: "GLOBAL_MODEL_BUDGET_EXHAUSTED",
    });
    expect(secondCalls).toBe(0);
    release?.();
    await firstCall;
  });
});
