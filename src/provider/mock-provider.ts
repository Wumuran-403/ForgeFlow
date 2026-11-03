import { AppError } from "../shared/errors.js";
import {
  ModelResponseSchema,
  type GenerateOptions,
  type LLMProvider,
  type ModelRequest,
  type ModelResponse,
} from "./types.js";

const DEFAULT_MOCK_RESPONSE = "ForgeFlow mock provider is ready.";

function estimateTokens(value: string): number {
  return Math.max(1, Math.ceil(value.length / 4));
}

export class MockLLMProvider implements LLMProvider {
  constructor(private readonly responseContent: string = DEFAULT_MOCK_RESPONSE) {}

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

    const serializedPrompt = JSON.stringify(request.messages);
    const promptTokens = estimateTokens(serializedPrompt);
    const completionTokens = estimateTokens(this.responseContent);

    return ModelResponseSchema.parse({
      message: {
        role: "assistant",
        content: this.responseContent,
      },
      usage: {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        source: "estimated",
      },
      finishReason: "stop",
    });
  }
}
