import "dotenv/config";

import { closeDatabase, migrateStorage, openDatabase } from "../storage/index.js";
import { loadConfig } from "../config/env.js";
import { ContextManager } from "../context/index.js";
import { LoopGuard } from "../loop-guard/index.js";
import { DeepSeekProvider } from "../provider/deepseek-provider.js";
import { AppError } from "../shared/errors.js";
import { WebAuth } from "./auth.js";
import { loadWebConfig } from "./config.js";
import { createWebServer } from "./server-factory.js";
import { GlobalModelBudgetProvider } from "./global-model-budget.js";
import {
  WebTaskService,
  type WebProviderMode,
} from "./task-service.js";

async function main(): Promise<void> {
  const webConfig = loadWebConfig();
  const appConfig = loadConfig();
  const database = openDatabase(webConfig.databasePath);
  migrateStorage(database);

  const providerMode = createProviderMode(appConfig, webConfig, database);
  const service = new WebTaskService(
    database,
    webConfig,
    providerMode,
    new ContextManager(appConfig.context),
    new LoopGuard(appConfig.loopGuard),
  );
  const auth = new WebAuth({
    sessionSecret: webConfig.sessionSecret,
    sessionTtlSeconds: webConfig.sessionTtlSeconds,
    secureCookies: webConfig.secureCookies,
  });
  const server = createWebServer({
    config: webConfig,
    service,
    auth,
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(webConfig.port, webConfig.host, () => resolve());
  });
  process.stdout.write(
    `ForgeFlow Web listening on http://${webConfig.host}:${webConfig.port}\n`,
  );
  process.stdout.write(`Provider: ${providerMode.label}\n`);

  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await service.stop();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    closeDatabase(database);
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

function createProviderMode(
  config: ReturnType<typeof loadConfig>,
  webConfig: ReturnType<typeof loadWebConfig>,
  database: ReturnType<typeof openDatabase>,
): WebProviderMode {
  if (config.llm.provider === "mock") {
    return { kind: "mock", label: "Mock" };
  }
  if (
    config.llm.baseUrl === undefined ||
    config.llm.apiKey === undefined
  ) {
    throw new AppError({
      code: "WEB_PROVIDER_CONFIGURATION_INVALID",
      message: "DeepSeek provider configuration is incomplete.",
      statusCode: 500,
    });
  }
  if (!webConfig.allowPaidProvider) {
    throw new AppError({
      code: "WEB_PAID_PROVIDER_DISABLED",
      message: "The paid provider is disabled by the web cost policy.",
      statusCode: 500,
    });
  }
  if (webConfig.globalModelTokenBudgetPerDay <= 0) {
    throw new AppError({
      code: "WEB_GLOBAL_MODEL_BUDGET_REQUIRED",
      message: "A positive global daily model token budget is required for DeepSeek.",
      statusCode: 500,
    });
  }
  const provider = new DeepSeekProvider({
    apiKey: config.llm.apiKey,
    baseUrl: config.llm.baseUrl,
    timeoutMs: config.llm.timeoutMs,
    maxRetries: config.llm.maxRetries,
  });
  return {
    kind: "deepseek",
    label: "DeepSeek",
    model: config.llm.model,
    provider: new GlobalModelBudgetProvider(database, provider, {
      maxTokensPerDay: webConfig.globalModelTokenBudgetPerDay,
      maxConcurrentCalls: webConfig.globalProviderConcurrency,
      reservedCompletionTokens: config.context.reservedCompletionTokens,
    }),
  };
}

main().catch((error: unknown) => {
  const code = error instanceof AppError ? error.code : "WEB_STARTUP_FAILED";
  const message =
    error instanceof AppError ? error.message : "The web server failed to start.";
  process.stderr.write(`${code}: ${message}\n`);
  process.exitCode = 1;
});
