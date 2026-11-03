import "dotenv/config";

import { randomUUID } from "node:crypto";

import { loadConfig } from "./config/env.js";
import { runHealthCheck } from "./health.js";
import { MockLLMProvider } from "./provider/mock-provider.js";
import { AppError, toErrorResponse } from "./shared/errors.js";

async function main(): Promise<void> {
  const requestId = randomUUID();

  try {
    const config = loadConfig();

    if (config.llm.provider !== "mock") {
      throw new AppError({
        code: "PROVIDER_NOT_IMPLEMENTED",
        message: "DeepSeek support is reserved for Phase 4.",
        statusCode: 501,
      });
    }

    const report = await runHealthCheck(config, new MockLLMProvider());
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const response = toErrorResponse(error, requestId);
    process.stderr.write(`${JSON.stringify(response, null, 2)}\n`);
    process.exitCode = 1;
  }
}

void main();
