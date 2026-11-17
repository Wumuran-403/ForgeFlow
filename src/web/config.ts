import { z } from "zod";

import { ConfigurationError } from "../shared/errors.js";

const optionalNonEmptyString = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
  z.string().trim().min(1).optional(),
);

const booleanFromEnvironment = z.preprocess((value) => {
  if (typeof value !== "string") return value;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  return value;
}, z.boolean());

const WebConfigSchema = z.object({
  WEB_HOST: z.string().trim().min(1).default("127.0.0.1"),
  WEB_PORT: z.coerce.number().int().min(1).max(65_535).default(8787),
  WEB_SESSION_SECRET: z.string().min(32),
  WEB_SESSION_TTL_SECONDS: z.coerce.number().int().min(300).max(2_592_000).default(604_800),
  WEB_SECURE_COOKIES: booleanFromEnvironment.optional(),
  WEB_PUBLIC_ORIGIN: optionalNonEmptyString,
  WEB_TRUST_PROXY: booleanFromEnvironment.default(false),
  WEB_GUEST_SESSION_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(20),
  WEB_GUEST_TASK_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1_000).default(10),
  WEB_MAX_ACTIVE_TASKS: z.coerce.number().int().min(1).max(10).default(2),
  WEB_DAILY_TASK_LIMIT: z.coerce.number().int().min(1).max(1_000).default(25),
  WEB_GUEST_DAILY_MODEL_TASK_LIMIT: z.coerce.number().int().min(1).max(1_000).default(5),
  WEB_DEFAULT_MODEL_TURNS: z.coerce.number().int().min(1).max(20).default(8),
  WEB_DEFAULT_TOOL_CALLS: z.coerce.number().int().min(0).max(100).default(20),
  WEB_DEFAULT_TOKEN_BUDGET: z.coerce.number().int().min(1_000).max(10_000_000).default(50_000),
  WEB_APPROVAL_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(1_800_000).default(300_000),
  WEB_ALLOW_PAID_PROVIDER: booleanFromEnvironment.default(false),
  WEB_GLOBAL_PROVIDER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(2),
  WEB_GLOBAL_MODEL_TOKEN_BUDGET_PER_DAY: z.coerce.number().int().min(0).max(1_000_000_000).default(0),
  WEB_ENABLE_PUBLIC_EVALUATION_RUN: booleanFromEnvironment.optional(),
  WEB_EVALUATION_RUNS_PER_HOUR: z.coerce.number().int().min(1).max(100).default(3),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  DATABASE_PATH: optionalNonEmptyString,
});

export interface WebConfig {
  readonly host: string;
  readonly port: number;
  readonly sessionSecret: string;
  readonly sessionTtlSeconds: number;
  readonly secureCookies: boolean;
  readonly publicOrigin?: string;
  readonly trustProxy: boolean;
  readonly guestSessionRateLimitPerMinute: number;
  readonly guestTaskRateLimitPerMinute: number;
  readonly maxActiveTasks: number;
  readonly dailyTaskLimit: number;
  readonly guestDailyModelTaskLimit: number;
  readonly defaultModelTurns: number;
  readonly defaultToolCalls: number;
  readonly defaultTokenBudget: number;
  readonly approvalTimeoutMs: number;
  readonly allowPaidProvider: boolean;
  readonly globalProviderConcurrency: number;
  readonly globalModelTokenBudgetPerDay: number;
  readonly publicEvaluationRunEnabled: boolean;
  readonly evaluationRunsPerHour: number;
  readonly databasePath: string;
  readonly environment: "development" | "test" | "production";
}

export function loadWebConfig(environment: NodeJS.ProcessEnv = process.env): WebConfig {
  const parsed = WebConfigSchema.safeParse(environment);
  if (!parsed.success) {
    throw new ConfigurationError(parsed.error.issues.map((issue) => ({
      path: issue.path.join("."), message: issue.message,
    })));
  }
  const publicOrigin = parsed.data.WEB_PUBLIC_ORIGIN;
  if (parsed.data.NODE_ENV === "production" && publicOrigin === undefined) {
    throw new ConfigurationError([{ path: "WEB_PUBLIC_ORIGIN", message: "Required in production." }]);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.WEB_SECURE_COOKIES === false) {
    throw new ConfigurationError([{ path: "WEB_SECURE_COOKIES", message: "Must be enabled in production." }]);
  }
  if (parsed.data.NODE_ENV === "production" && parsed.data.WEB_SESSION_SECRET.startsWith("replace-with-")) {
    throw new ConfigurationError([{ path: "WEB_SESSION_SECRET", message: "Replace example credentials before production deployment." }]);
  }
  if (publicOrigin !== undefined) {
    let parsedOrigin: URL;
    try { parsedOrigin = new URL(publicOrigin); }
    catch { throw new ConfigurationError([{ path: "WEB_PUBLIC_ORIGIN", message: "Must be a valid origin." }]); }
    if (parsedOrigin.origin !== publicOrigin ||
        (parsed.data.NODE_ENV === "production" && parsedOrigin.protocol !== "https:")) {
      throw new ConfigurationError([{ path: "WEB_PUBLIC_ORIGIN", message: "Must be an exact HTTPS origin in production." }]);
    }
  }
  return {
    host: parsed.data.WEB_HOST,
    port: parsed.data.WEB_PORT,
    sessionSecret: parsed.data.WEB_SESSION_SECRET,
    sessionTtlSeconds: parsed.data.WEB_SESSION_TTL_SECONDS,
    secureCookies: parsed.data.WEB_SECURE_COOKIES ?? parsed.data.NODE_ENV === "production",
    ...(publicOrigin === undefined ? {} : { publicOrigin }),
    trustProxy: parsed.data.WEB_TRUST_PROXY,
    guestSessionRateLimitPerMinute: parsed.data.WEB_GUEST_SESSION_RATE_LIMIT_PER_MINUTE,
    guestTaskRateLimitPerMinute: parsed.data.WEB_GUEST_TASK_RATE_LIMIT_PER_MINUTE,
    maxActiveTasks: parsed.data.WEB_MAX_ACTIVE_TASKS,
    dailyTaskLimit: parsed.data.WEB_DAILY_TASK_LIMIT,
    guestDailyModelTaskLimit: parsed.data.WEB_GUEST_DAILY_MODEL_TASK_LIMIT,
    defaultModelTurns: parsed.data.WEB_DEFAULT_MODEL_TURNS,
    defaultToolCalls: parsed.data.WEB_DEFAULT_TOOL_CALLS,
    defaultTokenBudget: parsed.data.WEB_DEFAULT_TOKEN_BUDGET,
    approvalTimeoutMs: parsed.data.WEB_APPROVAL_TIMEOUT_MS,
    allowPaidProvider: parsed.data.WEB_ALLOW_PAID_PROVIDER,
    globalProviderConcurrency: parsed.data.WEB_GLOBAL_PROVIDER_CONCURRENCY,
    globalModelTokenBudgetPerDay: parsed.data.WEB_GLOBAL_MODEL_TOKEN_BUDGET_PER_DAY,
    publicEvaluationRunEnabled: parsed.data.WEB_ENABLE_PUBLIC_EVALUATION_RUN ?? parsed.data.NODE_ENV !== "production",
    evaluationRunsPerHour: parsed.data.WEB_EVALUATION_RUNS_PER_HOUR,
    databasePath: parsed.data.DATABASE_PATH ?? "data/forgeflow.db",
    environment: parsed.data.NODE_ENV,
  };
}
