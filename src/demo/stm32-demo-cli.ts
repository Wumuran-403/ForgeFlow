import "dotenv/config";

import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { DeepSeekProvider } from "../provider/deepseek-provider.js";
import type { LLMProvider } from "../provider/types.js";
import type {
  WriteApprovalDecision,
  WriteApprovalHandler,
  WriteApprovalRequest,
} from "../scheduler/index.js";
import { AppError } from "../shared/errors.js";
import {
  createMockStm32DemoProvider,
  runStm32AgentDemo,
  type Stm32AgentDemoResult,
} from "./stm32-agent-demo.js";

const DEFAULT_DEEPSEEK_BASE_URL = "https://api.deepseek.com";
const DEFAULT_DEEPSEEK_MODEL = "deepseek-chat";

async function main(): Promise<void> {
  const args = new Set(process.argv.slice(2));
  const mode = args.has("--mock") ? "mock" : "deepseek";
  const autoApprove = args.has("--auto-approve");
  const rejectWrites = args.has("--reject");
  const abortController = new AbortController();
  const onSignal = (): void => abortController.abort();
  process.once("SIGINT", onSignal);

  const readline =
    autoApprove || rejectWrites
      ? undefined
      : createInterface({ input, output });
  const approvalHandler: WriteApprovalHandler = {
    request: async (
      request: WriteApprovalRequest,
    ): Promise<WriteApprovalDecision> => {
      output.write(
        `\n[approval] ${request.toolName}\n${JSON.stringify(request.input, null, 2)}\n`,
      );
      if (rejectWrites) {
        return { status: "rejected", reason: "Rejected by --reject." };
      }
      if (autoApprove) {
        return { status: "approved" };
      }
      const answer =
        (await readline?.question("Approve this simulated write? [y/N] ")) ?? "n";
      return answer.trim().toLowerCase() === "y"
        ? { status: "approved" }
        : { status: "rejected", reason: "Rejected by the operator." };
    },
  };

  try {
    const provider = createProvider(mode);
    const result = await runStm32AgentDemo({
      provider: provider.instance,
      model: provider.model,
      approvalHandler,
      maxModelTurns: parsePositiveInteger(
        process.env.DEMO_MAX_MODEL_TURNS,
        10,
        "DEMO_MAX_MODEL_TURNS",
      ),
      maxToolCalls: parsePositiveInteger(
        process.env.DEMO_MAX_TOOL_CALLS,
        24,
        "DEMO_MAX_TOOL_CALLS",
      ),
      signal: abortController.signal,
    });
    printResult(result, provider.label);
  } finally {
    process.removeListener("SIGINT", onSignal);
    readline?.close();
  }
}

function createProvider(mode: "mock" | "deepseek"): {
  readonly instance: LLMProvider;
  readonly model: string;
  readonly label: string;
} {
  if (mode === "mock") {
    return {
      instance: createMockStm32DemoProvider(),
      model: "mock-model",
      label: "Mock (offline)",
    };
  }

  const apiKey = process.env.LLM_API_KEY?.trim();
  if (apiKey === undefined || apiKey === "") {
    throw new AppError({
      code: "DEEPSEEK_API_KEY_REQUIRED",
      message: "LLM_API_KEY is required for pnpm demo:deepseek.",
      statusCode: 500,
    });
  }
  const model = process.env.LLM_MODEL?.trim() || DEFAULT_DEEPSEEK_MODEL;
  const baseUrl = process.env.LLM_BASE_URL?.trim() || DEFAULT_DEEPSEEK_BASE_URL;
  return {
    instance: new DeepSeekProvider({
      apiKey,
      baseUrl,
      timeoutMs: parsePositiveInteger(
        process.env.LLM_TIMEOUT_MS,
        60_000,
        "LLM_TIMEOUT_MS",
      ),
      maxRetries: parseNonNegativeInteger(
        process.env.LLM_MAX_RETRIES,
        2,
        "LLM_MAX_RETRIES",
      ),
    }),
    model,
    label: `DeepSeek (${model})`,
  };
}

function printResult(
  result: Stm32AgentDemoResult,
  providerLabel: string,
): void {
  const { run, snapshot, drafts } = result;
  output.write(`\nForgeFlow STM32 BOM demo\n`);
  output.write(`Provider: ${providerLabel}\n`);
  output.write(`Task: ${snapshot.task.id}\n`);
  output.write(`Task status: ${snapshot.task.status}\n`);
  output.write(`Run status: ${run.status} (${run.stopReason})\n`);
  output.write(
    `Model requests: ${run.modelRequests}; tool calls: ${run.toolCalls}; ` +
      `tokens: ${snapshot.task.tokenUsage.totalTokens ?? "unknown"}\n`,
  );

  output.write(`\nModel activity:\n`);
  for (const modelCall of snapshot.modelCalls) {
    const toolCallCount = modelCall.response?.message.toolCalls?.length ?? 0;
    output.write(
      `- turn ${modelCall.iteration}: ${modelCall.status}; ` +
        `${toolCallCount} tool call(s); ` +
        `finish=${modelCall.finishReason ?? "unknown"}\n`,
    );
  }

  output.write(`\nTool activity:\n`);
  if (snapshot.toolRuns.length === 0) {
    output.write(`- none\n`);
  }
  for (const toolRun of snapshot.toolRuns) {
    output.write(
      `- [${toolRun.mode}] ${toolRun.toolName}: ${toolRun.status}\n` +
        `  input: ${formatJson(toolRun.input)}\n` +
        `  output: ${formatJson(toolRun.output)}\n`,
    );
  }

  const writeRun = snapshot.toolRuns.find(
    (toolRun) => toolRun.toolName === "procurement_create_draft",
  );
  output.write(`\nApproval outcome:\n`);
  output.write(
    writeRun === undefined
      ? `- procurement write was not requested\n`
      : `- procurement write: ${writeRun.status}\n`,
  );
  output.write(`Drafts confirmed by in-memory re-read: ${drafts.length}\n`);

  output.write(`\nFinal report:\n${run.finalAnswer ?? "(no final answer)"}\n`);
  if (snapshot.task.status !== "completed" || run.status !== "completed") {
    process.exitCode = 1;
  }
}

function parsePositiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new AppError({
      code: "DEMO_CONFIGURATION_INVALID",
      message: `${name} must be a positive integer.`,
      statusCode: 500,
    });
  }
  return parsed;
}

function parseNonNegativeInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = value === undefined || value.trim() === ""
    ? fallback
    : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new AppError({
      code: "DEMO_CONFIGURATION_INVALID",
      message: `${name} must be a non-negative integer.`,
      statusCode: 500,
    });
  }
  return parsed;
}

function formatJson(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return "undefined";
  }
  return serialized.length <= 500
    ? serialized
    : `${serialized.slice(0, 497)}...`;
}

main().catch((error: unknown) => {
  const message =
    error instanceof AppError
      ? `${error.code}: ${error.message}`
      : "INTERNAL_ERROR: The demo failed.";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
