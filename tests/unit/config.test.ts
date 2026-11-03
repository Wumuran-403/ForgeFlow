import { describe, expect, it } from "vitest";

import { loadConfig } from "../../src/config/env.js";
import { ConfigurationError } from "../../src/shared/errors.js";

describe("loadConfig", () => {
  it("defaults to a runnable mock provider without an API key", () => {
    const config = loadConfig({});

    expect(config.llm.provider).toBe("mock");
    expect(config.llm.model).toBe("mock-model");
    expect(config.llm.apiKey).toBeUndefined();
  });

  it("requires provider credentials for DeepSeek", () => {
    expect(() => loadConfig({ LLM_PROVIDER: "deepseek" })).toThrow(ConfigurationError);

    try {
      loadConfig({ LLM_PROVIDER: "deepseek" });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      expect((error as ConfigurationError).details.map((detail) => detail.path)).toEqual([
        "LLM_MODEL",
        "LLM_BASE_URL",
        "LLM_API_KEY",
      ]);
    }
  });

  it("rejects invalid numeric limits", () => {
    expect(() => loadConfig({ LLM_TIMEOUT_MS: "0" })).toThrow(ConfigurationError);
    expect(() => loadConfig({ LLM_MAX_RETRIES: "-1" })).toThrow(ConfigurationError);
  });
});
