import { z } from "zod";

import { ConfigurationError } from "../shared/errors.js";

export const DEFAULT_DATABASE_PATH = "data/forgeflow.db";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.url().optional(),
);

const envSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    FORGEFLOW_LOG_LEVEL: z
      .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
      .default("info"),
    DATABASE_PATH: optionalNonEmptyString,
    LLM_PROVIDER: z.enum(["mock", "deepseek"]).default("mock"),
    LLM_MODEL: optionalNonEmptyString,
    LLM_BASE_URL: optionalUrl,
    LLM_API_KEY: optionalNonEmptyString,
    LLM_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    LLM_MAX_RETRIES: z.coerce.number().int().nonnegative().default(2),
    LLM_CONTEXT_MAX_TOKENS: z.coerce.number().int().positive().default(16_384),
    LLM_CONTEXT_RESERVED_COMPLETION_TOKENS: z.coerce.number().int().nonnegative().default(2_048),
    LLM_TOOL_RESULT_MAX_TOKENS: z.coerce.number().int().min(64).default(1_024),
    LOOP_GUARD_REPEAT_THRESHOLD: z.coerce.number().int().min(2).default(3),
    LOOP_GUARD_CYCLE_REPETITIONS: z.coerce.number().int().min(2).default(3),
    LOOP_GUARD_FAILURE_THRESHOLD: z.coerce.number().int().min(2).default(3),
    LOOP_GUARD_MAX_HISTORY_ROUNDS: z.coerce.number().int().min(6).default(12),
  })
  .superRefine((value, context) => {
    if (value.LLM_CONTEXT_RESERVED_COMPLETION_TOKENS >= value.LLM_CONTEXT_MAX_TOKENS) {
      context.addIssue({
        code: "custom",
        path: ["LLM_CONTEXT_RESERVED_COMPLETION_TOKENS"],
        message: "Reserved completion tokens must be below the context limit.",
      });
    }
    const loopHistoryRequired = Math.max(
      value.LOOP_GUARD_REPEAT_THRESHOLD,
      value.LOOP_GUARD_CYCLE_REPETITIONS * 2,
      value.LOOP_GUARD_FAILURE_THRESHOLD,
    );
    if (value.LOOP_GUARD_MAX_HISTORY_ROUNDS < loopHistoryRequired) {
      context.addIssue({
        code: "custom",
        path: ["LOOP_GUARD_MAX_HISTORY_ROUNDS"],
        message: `Loop Guard history must retain at least ${loopHistoryRequired} rounds.`,
      });
    }
    if (value.LLM_PROVIDER !== "deepseek") {
      return;
    }

    const requiredFields = ["LLM_MODEL", "LLM_BASE_URL", "LLM_API_KEY"] as const;
    for (const field of requiredFields) {
      if (value[field] === undefined) {
        context.addIssue({
          code: "custom",
          path: [field],
          message: `${field} is required when LLM_PROVIDER=deepseek.`,
        });
      }
    }
  });

export interface AppConfig {
  environment: "development" | "test" | "production";
  logLevel: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
  database: {
    path: string;
  };
  llm: {
    provider: "mock" | "deepseek";
    model: string;
    baseUrl: string | undefined;
    apiKey: string | undefined;
    timeoutMs: number;
    maxRetries: number;
  };
  context: {
    maxContextTokens: number;
    reservedCompletionTokens: number;
    maxToolResultTokens: number;
  };
  loopGuard: {
    consecutiveRepeatThreshold: number;
    cycleRepetitions: number;
    failureThreshold: number;
    maxHistoryRounds: number;
  };
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = envSchema.safeParse(environment);

  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    }));
    throw new ConfigurationError(details);
  }

  const values = result.data;
  const model = values.LLM_MODEL ?? (values.LLM_PROVIDER === "mock" ? "mock-model" : undefined);

  if (model === undefined) {
    throw new ConfigurationError([
      {
        path: "LLM_MODEL",
        message: "LLM_MODEL is required for the selected provider.",
      },
    ]);
  }

  return {
    environment: values.NODE_ENV,
    logLevel: values.FORGEFLOW_LOG_LEVEL,
    database: {
      path: values.DATABASE_PATH ?? DEFAULT_DATABASE_PATH,
    },
    llm: {
      provider: values.LLM_PROVIDER,
      model,
      baseUrl: values.LLM_BASE_URL,
      apiKey: values.LLM_API_KEY,
      timeoutMs: values.LLM_TIMEOUT_MS,
      maxRetries: values.LLM_MAX_RETRIES,
    },
    context: {
      maxContextTokens: values.LLM_CONTEXT_MAX_TOKENS,
      reservedCompletionTokens: values.LLM_CONTEXT_RESERVED_COMPLETION_TOKENS,
      maxToolResultTokens: values.LLM_TOOL_RESULT_MAX_TOKENS,
    },
    loopGuard: {
      consecutiveRepeatThreshold: values.LOOP_GUARD_REPEAT_THRESHOLD,
      cycleRepetitions: values.LOOP_GUARD_CYCLE_REPETITIONS,
      failureThreshold: values.LOOP_GUARD_FAILURE_THRESHOLD,
      maxHistoryRounds: values.LOOP_GUARD_MAX_HISTORY_ROUNDS,
    },
  };
}
