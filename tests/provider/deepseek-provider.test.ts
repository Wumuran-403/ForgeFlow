import { describe, expect, it, vi } from "vitest";

import {
  DeepSeekProvider,
  type DeepSeekFetch,
} from "../../src/provider/deepseek-provider.js";
import type { ModelRequest } from "../../src/provider/types.js";

const request: ModelRequest = {
  model: "deepseek-chat",
  messages: [
    { role: "system", content: "Use the tools." },
    { role: "user", content: "Review the BOM." },
    {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "call-bom",
          name: "bom_get_items",
          arguments: {},
        },
      ],
    },
    {
      role: "tool",
      toolCallId: "call-bom",
      content: '{"toolName":"bom_get_items","status":"succeeded"}',
    },
  ],
  tools: [
    {
      name: "bom_get_items",
      description: "Read the BOM.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
  ],
};

function completion(
  body: unknown,
  init?: ResponseInit,
): Response {
  return new Response(JSON.stringify(body), {
    status: init?.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

describe("DeepSeekProvider", () => {
  it("sends prior tool results and parses JSON tool-call arguments", async () => {
    const fetch = vi.fn<DeepSeekFetch>(async () =>
      completion({
        id: "response-1",
        choices: [
          {
            finish_reason: "tool_calls",
            message: {
              content: null,
              tool_calls: [
                {
                  id: "call-stock",
                  type: "function",
                  function: {
                    name: "inventory_lookup",
                    arguments:
                      '{"partNumber":"STM32F103C8T6","requiredQuantity":2000}',
                  },
                },
              ],
            },
          },
        ],
        usage: {
          prompt_tokens: 120,
          completion_tokens: 30,
          total_tokens: 150,
        },
      }),
    );
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      fetch,
      maxRetries: 0,
    });

    const response = await provider.generate(request);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.deepseek.test/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      "Bearer test-key",
    );
    const body = JSON.parse(String(init?.body)) as {
      messages: readonly Record<string, unknown>[];
      tools: readonly Record<string, unknown>[];
    };
    expect(body.messages[2]).toMatchObject({
      role: "assistant",
      tool_calls: [
        {
          id: "call-bom",
          type: "function",
          function: { name: "bom_get_items", arguments: "{}" },
        },
      ],
    });
    expect(body.messages[3]).toMatchObject({
      role: "tool",
      tool_call_id: "call-bom",
    });
    expect(body.tools[0]).toMatchObject({
      type: "function",
      function: { name: "bom_get_items" },
    });
    expect(response).toMatchObject({
      message: {
        role: "assistant",
        toolCalls: [
          {
            id: "call-stock",
            name: "inventory_lookup",
            arguments: {
              partNumber: "STM32F103C8T6",
              requiredQuantity: 2000,
            },
          },
        ],
      },
      usage: {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        source: "provider",
      },
      finishReason: "tool_calls",
      requestId: "response-1",
    });
  });

  it("rejects invalid completion responses", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      maxRetries: 0,
      fetch: async () => completion({ choices: [] }),
    });

    await expect(provider.generate(request)).rejects.toMatchObject({
      code: "DEEPSEEK_RESPONSE_INVALID",
    });
  });

  it("does not label missing provider usage as actual usage", async () => {
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      maxRetries: 0,
      fetch: async () => completion({
        choices: [{ finish_reason: "stop", message: { content: "Ready." } }],
      }),
    });

    const response = await provider.generate(request);
    expect(response.usage).toEqual({ source: "unknown" });
  });

  it("retries transient HTTP failures and exposes a bounded provider error", async () => {
    const fetch = vi
      .fn<DeepSeekFetch>()
      .mockResolvedValueOnce(
        completion({ error: "unavailable" }, { status: 503 }),
      )
      .mockResolvedValueOnce(
        completion({
          choices: [
            {
              finish_reason: "stop",
              message: { content: "Ready." },
            },
          ],
        }),
      );
    const provider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      fetch,
      maxRetries: 1,
    });

    await expect(provider.generate(request)).resolves.toMatchObject({
      message: { content: "Ready." },
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("distinguishes timeout and caller abort failures", async () => {
    const hangingFetch: DeepSeekFetch = async (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal?.aborted === true) {
          reject(new DOMException("aborted", "AbortError"));
          return;
        }
        signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
          { once: true },
        );
      });
    const timeoutProvider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      fetch: hangingFetch,
      timeoutMs: 5,
      maxRetries: 0,
    });
    await expect(timeoutProvider.generate(request)).rejects.toMatchObject({
      code: "DEEPSEEK_REQUEST_TIMEOUT",
    });

    const controller = new AbortController();
    controller.abort();
    const abortProvider = new DeepSeekProvider({
      apiKey: "test-key",
      baseUrl: "https://api.deepseek.test",
      fetch: hangingFetch,
      timeoutMs: 50,
      maxRetries: 0,
    });
    await expect(
      abortProvider.generate(request, { signal: controller.signal }),
    ).rejects.toMatchObject({
      code: "DEEPSEEK_REQUEST_ABORTED",
    });
  });
});
