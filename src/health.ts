import type { AppConfig } from "./config/env.js";
import type { LLMProvider } from "./provider/types.js";

export interface HealthReport {
  status: "ok";
  service: "forgeflow";
  phase: "phase-0";
  provider: "mock";
  model: string;
  mockResponse: string;
}

export async function runHealthCheck(
  config: AppConfig,
  provider: LLMProvider,
): Promise<HealthReport> {
  if (config.llm.provider !== "mock") {
    throw new Error("Phase 0 only supports the mock provider.");
  }

  const response = await provider.generate({
    model: config.llm.model,
    messages: [
      {
        role: "user",
        content: "Confirm that the local mock provider is ready.",
      },
    ],
    tools: [],
  });

  return {
    status: "ok",
    service: "forgeflow",
    phase: "phase-0",
    provider: "mock",
    model: config.llm.model,
    mockResponse: response.message.content,
  };
}
