import { AppError } from "../shared/errors.js";
import { estimateJsonTokens } from "../context/token-usage.js";
import {
  ModelResponseSchema,
  type GenerateOptions,
  type LLMProvider,
  type ModelRequest,
  type ModelResponse,
  type ModelUsage,
  type ToolCall,
} from "./types.js";

const DEFAULT_MOCK_RESPONSE = "ForgeFlow mock provider is ready.";

export interface MockProviderResponse {
  content: string;
  toolCalls?: ToolCall[];
  usage?: ModelUsage;
  finishReason?: string;
  requestId?: string;
}

export interface MockProviderErrorResponse {
  error: Error;
}

export type MockProviderStep =
  | string
  | MockProviderResponse
  | MockProviderErrorResponse;

function isErrorStep(step: MockProviderStep): step is MockProviderErrorResponse {
  return typeof step === "object" && "error" in step;
}

export class MockLLMProvider implements LLMProvider {
  private readonly steps: readonly MockProviderStep[];
  private readonly repeatLastStep: boolean;
  private readonly recordedRequests: ModelRequest[] = [];
  private nextStepIndex = 0;

  constructor(script: string | readonly MockProviderStep[] = DEFAULT_MOCK_RESPONSE) {
    if (typeof script === "string") {
      this.steps = [script];
      this.repeatLastStep = true;
      return;
    }

    this.steps = [...script];
    this.repeatLastStep = false;
  }

  get requests(): readonly ModelRequest[] {
    return this.recordedRequests.map((request) => structuredClone(request));
  }

  get consumedResponseCount(): number {
    return this.nextStepIndex;
  }

  skipResponses(count: number): void {
    if (!Number.isInteger(count) || count < 0 || count > this.steps.length) {
      throw new AppError({
        code: "MOCK_SCRIPT_POSITION_INVALID",
        message: "The requested mock script position is invalid.",
        statusCode: 500,
      });
    }
    this.nextStepIndex = count;
  }

  async generate(
    request: ModelRequest,
    options: GenerateOptions = {},
  ): Promise<ModelResponse> {
    if (options.signal?.aborted === true) {
      throw new AppError({
        code: "REQUEST_ABORTED",
        message: "The model request was aborted.",
        statusCode: 499,
      });
    }

    if (this.steps.length === 0) {
      throw new AppError({
        code: "MOCK_SCRIPT_EMPTY",
        message: "The mock provider script has no responses.",
        statusCode: 500,
      });
    }

    if (!this.repeatLastStep && this.nextStepIndex >= this.steps.length) {
      throw new AppError({
        code: "MOCK_SCRIPT_EXHAUSTED",
        message: "The mock provider script has no remaining responses.",
        statusCode: 500,
      });
    }

    const stepIndex = this.repeatLastStep ? 0 : this.nextStepIndex;
    const step = this.steps[stepIndex];
    if (step === undefined) {
      throw new AppError({
        code: "MOCK_SCRIPT_INVALID",
        message: "The mock provider could not resolve the next response.",
        statusCode: 500,
      });
    }

    this.nextStepIndex += 1;
    this.recordedRequests.push(structuredClone(request));

    if (isErrorStep(step)) {
      throw step.error;
    }

    const content = typeof step === "string" ? step : step.content;
    const toolCalls = typeof step === "string" ? undefined : step.toolCalls;
    const promptTokens = estimateJsonTokens(request);
    const completionTokens = estimateJsonTokens({
      role: "assistant",
      content,
      ...(toolCalls === undefined ? {} : { toolCalls }),
    });
    const estimatedUsage: ModelUsage = {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      source: "estimated",
    };

    return ModelResponseSchema.parse({
      message: {
        role: "assistant",
        content,
        ...(toolCalls === undefined ? {} : { toolCalls }),
      },
      usage: typeof step === "string" ? estimatedUsage : (step.usage ?? estimatedUsage),
      finishReason:
        typeof step === "string"
          ? "stop"
          : (step.finishReason ?? (toolCalls?.length === 0 ? "stop" : "tool_calls")),
      requestId:
        typeof step === "string" ? `mock-request-${this.nextStepIndex}` : step.requestId,
    });
  }
}
