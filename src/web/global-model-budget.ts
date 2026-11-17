import { randomUUID } from "node:crypto";

import { estimateJsonTokens } from "../context/index.js";
import type {
  GenerateOptions,
  LLMProvider,
  ModelRequest,
  ModelResponse,
  ModelUsage,
} from "../provider/types.js";
import { AppError } from "../shared/errors.js";
import { runInTransaction, type ForgeFlowDatabase } from "../storage/index.js";

export interface GlobalModelBudgetOptions {
  readonly maxTokensPerDay: number;
  readonly maxConcurrentCalls: number;
  readonly reservedCompletionTokens: number;
  readonly now?: () => Date;
}

export interface GlobalModelBudgetSnapshot {
  readonly budgetDate: string;
  readonly maxTokens: number;
  readonly settledTokens: number;
  readonly reservedTokens: number;
  readonly remainingTokens: number;
  readonly providerTokens: number;
  readonly estimatedTokens: number;
  readonly unknownTokens: number;
}

interface ReservationRow {
  readonly id: string;
  readonly budget_date: string;
  readonly reserved_tokens: number;
  readonly status: "reserved" | "settled";
}

interface BudgetDayRow {
  readonly settled_tokens: number;
  readonly reserved_tokens: number;
  readonly provider_tokens: number;
  readonly estimated_tokens: number;
  readonly unknown_tokens: number;
}

export class GlobalModelBudgetProvider implements LLMProvider {
  private activeCalls = 0;

  constructor(
    private readonly database: ForgeFlowDatabase,
    private readonly provider: LLMProvider,
    readonly options: GlobalModelBudgetOptions,
  ) {
    if (options.maxTokensPerDay <= 0 || options.maxConcurrentCalls <= 0 ||
        options.reservedCompletionTokens < 0) {
      throw new AppError({
        code: "GLOBAL_MODEL_BUDGET_CONFIGURATION_INVALID",
        message: "Global model budget configuration is invalid.",
        statusCode: 500,
      });
    }
  }

  async generate(
    request: ModelRequest,
    options: GenerateOptions = {},
  ): Promise<ModelResponse> {
    if (options.signal?.aborted === true) {
      throw new AppError({
        code: "MODEL_CALL_CANCELLED",
        message: "The model call was cancelled.",
        statusCode: 499,
      });
    }
    if (this.activeCalls >= this.options.maxConcurrentCalls) {
      throw new AppError({
        code: "GLOBAL_PROVIDER_CONCURRENCY_EXHAUSTED",
        message: "The global provider concurrency limit has been reached.",
        statusCode: 429,
      });
    }

    this.activeCalls += 1;
    let reservationId: string | undefined;
    try {
      const reservedTokens = Math.max(
        1,
        estimateJsonTokens(request) + this.options.reservedCompletionTokens,
      );
      reservationId = this.reserve(reservedTokens);
      try {
        const response = await this.provider.generate(request, options);
        this.settle(reservationId, response.usage);
        return response;
      } catch (error) {
        this.settle(reservationId, { source: "unknown" });
        throw error;
      }
    } finally {
      this.activeCalls -= 1;
    }
  }

  snapshot(date = this.options.now?.() ?? new Date()): GlobalModelBudgetSnapshot {
    const budgetDate = toBudgetDate(date);
    const row = this.database.prepare(`
      SELECT settled_tokens, reserved_tokens, provider_tokens,
             estimated_tokens, unknown_tokens
      FROM global_model_budget_days
      WHERE budget_date = ?
    `).get(budgetDate) as BudgetDayRow | undefined;
    const settledTokens = row?.settled_tokens ?? 0;
    const reservedTokens = row?.reserved_tokens ?? 0;
    return {
      budgetDate,
      maxTokens: this.options.maxTokensPerDay,
      settledTokens,
      reservedTokens,
      remainingTokens: Math.max(
        0,
        this.options.maxTokensPerDay - settledTokens - reservedTokens,
      ),
      providerTokens: row?.provider_tokens ?? 0,
      estimatedTokens: row?.estimated_tokens ?? 0,
      unknownTokens: row?.unknown_tokens ?? 0,
    };
  }

  private reserve(reservedTokens: number): string {
    const now = this.options.now?.() ?? new Date();
    const timestamp = now.toISOString();
    const budgetDate = toBudgetDate(now);
    return runInTransaction(this.database, () => {
      this.database.prepare(`
        INSERT OR IGNORE INTO global_model_budget_days (
          budget_date, settled_tokens, reserved_tokens, provider_tokens,
          estimated_tokens, unknown_tokens, updated_at
        ) VALUES (?, 0, 0, 0, 0, 0, ?)
      `).run(budgetDate, timestamp);
      const day = this.database.prepare(`
        SELECT settled_tokens, reserved_tokens, provider_tokens,
               estimated_tokens, unknown_tokens
        FROM global_model_budget_days
        WHERE budget_date = ?
      `).get(budgetDate) as BudgetDayRow;
      if (day.settled_tokens + day.reserved_tokens + reservedTokens >
          this.options.maxTokensPerDay) {
        throw new AppError({
          code: "GLOBAL_MODEL_BUDGET_EXHAUSTED",
          message: "The global daily model budget is exhausted.",
          statusCode: 429,
        });
      }
      const id = randomUUID();
      this.database.prepare(`
        INSERT INTO global_model_budget_reservations (
          id, budget_date, reserved_tokens, charged_tokens, status,
          usage_source, created_at, settled_at
        ) VALUES (?, ?, ?, NULL, 'reserved', NULL, ?, NULL)
      `).run(id, budgetDate, reservedTokens, timestamp);
      this.database.prepare(`
        UPDATE global_model_budget_days
        SET reserved_tokens = reserved_tokens + ?, updated_at = ?
        WHERE budget_date = ?
      `).run(reservedTokens, timestamp, budgetDate);
      return id;
    }, "immediate");
  }

  private settle(reservationId: string, usage: ModelUsage): void {
    const timestamp = (this.options.now?.() ?? new Date()).toISOString();
    runInTransaction(this.database, () => {
      const reservation = this.database.prepare(`
        SELECT id, budget_date, reserved_tokens, status
        FROM global_model_budget_reservations
        WHERE id = ?
      `).get(reservationId) as ReservationRow | undefined;
      if (reservation === undefined || reservation.status === "settled") {
        return;
      }
      const reportedTokens = usage.totalTokens;
      const source = usage.source === "provider" && reportedTokens !== undefined
        ? "provider"
        : usage.source === "estimated" && reportedTokens !== undefined
          ? "estimated"
          : "unknown";
      const chargedTokens = source === "provider"
        ? reportedTokens as number
        : Math.max(reservation.reserved_tokens, reportedTokens ?? 0);
      this.database.prepare(`
        UPDATE global_model_budget_reservations
        SET charged_tokens = ?, status = 'settled', usage_source = ?, settled_at = ?
        WHERE id = ? AND status = 'reserved'
      `).run(chargedTokens, source, timestamp, reservationId);
      this.database.prepare(`
        UPDATE global_model_budget_days
        SET reserved_tokens = reserved_tokens - ?,
            settled_tokens = settled_tokens + ?,
            provider_tokens = provider_tokens + ?,
            estimated_tokens = estimated_tokens + ?,
            unknown_tokens = unknown_tokens + ?,
            updated_at = ?
        WHERE budget_date = ?
      `).run(
        reservation.reserved_tokens,
        chargedTokens,
        source === "provider" ? chargedTokens : 0,
        source === "estimated" ? chargedTokens : 0,
        source === "unknown" ? chargedTokens : 0,
        timestamp,
        reservation.budget_date,
      );
    }, "immediate");
  }
}

function toBudgetDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}
