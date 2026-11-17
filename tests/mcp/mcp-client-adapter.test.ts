import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  McpConnectionError,
  McpStdioClientAdapter,
  McpToolResultError,
  McpToolUnauthorizedError,
  createInventoryDemoMcpConfig,
  registerMcpTools,
  type TrustedMcpStdioServerConfig,
} from "../../src/mcp/index.js";
import { ToolInputValidationError } from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";

const clients: McpStdioClientAdapter[] = [];

afterEach(async () => {
  await Promise.all(clients.splice(0).map(async (client) => client.close()));
});

describe("MCP stdio client adapter", () => {
  it("initializes a real local server, discovers its schema, and calls inventory.search", async () => {
    const client = track(new McpStdioClientAdapter(createInventoryDemoMcpConfig()));
    await client.connect();
    const tools = await client.listTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      remoteName: "inventory.search",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
        },
      },
    });

    const result = await client.callTool("inventory.search", {
      query: "stm32f407",
      minimumAvailable: 100,
    });
    expect(result).toMatchObject({
      structuredContent: {
        count: 1,
        items: [{ sku: "STM32F407VGT6", available: 128 }],
      },
    });
  });

  it("maps only trusted tools into the internal Registry and validates inputs locally", async () => {
    const client = track(new McpStdioClientAdapter(createInventoryDemoMcpConfig()));
    await client.connect();
    const registry = new ToolRegistry();
    const mapped = await registerMcpTools(registry, client);
    expect(mapped).toEqual([{
      remoteName: "inventory.search",
      localName: "mcp_inventory_inventory_search",
      mode: "read",
      requiresApproval: false,
    }]);
    expect(registry.get(mapped[0]!.localName)).toMatchObject({ mode: "read" });
    await expect(registry.execute(mapped[0]!.localName, { query: "stm32" }))
      .resolves.toMatchObject({ structuredContent: { count: 3 } });
    await expect(registry.execute(mapped[0]!.localName, { query: "" }))
      .rejects.toBeInstanceOf(ToolInputValidationError);
    await expect(client.callTool("inventory.delete", {}))
      .rejects.toBeInstanceOf(McpToolUnauthorizedError);
  });

  it("propagates timeout, cancellation, disconnect, and explicit close", async () => {
    const client = track(new McpStdioClientAdapter(createFixtureConfig()));
    await client.connect();
    await client.listTools();

    await expect(client.callTool("test.delay", { milliseconds: 250 }))
      .rejects.toMatchObject({ code: "MCP_TOOL_CALL_TIMEOUT" });

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    await expect(client.callTool(
      "test.delay",
      { milliseconds: 250 },
      { signal: controller.signal },
    )).rejects.toMatchObject({ code: "MCP_TOOL_CALL_CANCELLED" });

    await expect(client.callTool("test.error", { code: "expected" }))
      .rejects.toBeInstanceOf(McpToolResultError);
    await expect(client.callTool("test.large", { size: 512 }))
      .rejects.toMatchObject({ code: "MCP_TOOL_OUTPUT_TOO_LARGE" });

    await expect(client.callTool("test.crash", { confirm: "crash" }))
      .rejects.toBeInstanceOf(McpConnectionError);
    await client.close();
    await expect(client.callTool("test.delay", { milliseconds: 1 }))
      .rejects.toBeInstanceOf(McpConnectionError);
  });
});

function track(client: McpStdioClientAdapter): McpStdioClientAdapter {
  clients.push(client);
  return client;
}

function createFixtureConfig(): TrustedMcpStdioServerConfig {
  return {
    serverId: "test-fixture",
    namespace: "fixture",
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./fixture-server.ts", import.meta.url))],
    env: minimalEnvironment(),
    tools: [
      { remoteName: "test.delay", mode: "read", timeoutMs: 50 },
      { remoteName: "test.crash", mode: "read", timeoutMs: 1_000 },
      { remoteName: "test.error", mode: "read", timeoutMs: 1_000 },
      { remoteName: "test.large", mode: "read", timeoutMs: 1_000, maxOutputBytes: 64 },
    ],
  };
}

function minimalEnvironment(): Record<string, string> {
  const output: Record<string, string> = {};
  for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
    const value = process.env[name];
    if (value !== undefined) output[name] = value;
  }
  return output;
}
