import { setTimeout as delay } from "node:timers/promises";

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

function createServer(): McpServer {
  const server = new McpServer({ name: "forgeflow-mcp-test-fixture", version: "1.0.0" });
  server.registerTool(
    "test.delay",
    { inputSchema: z.object({ milliseconds: z.number().int().min(1).max(5_000) }).strict() },
    async ({ milliseconds }, context) => {
      await delay(milliseconds, undefined, { signal: context.mcpReq.signal });
      return { content: [{ type: "text", text: "finished" }] };
    },
  );
  server.registerTool(
    "test.crash",
    { inputSchema: z.object({ confirm: z.literal("crash") }).strict() },
    async () => {
      process.exitCode = 23;
      setImmediate(() => process.exit(23));
      await delay(1_000);
      return { content: [{ type: "text", text: "unreachable" }] };
    },
  );
  server.registerTool(
    "test.error",
    { inputSchema: z.object({ code: z.literal("expected") }).strict() },
    async () => ({
      isError: true,
      content: [{ type: "text", text: "fixture failure" }],
    }),
  );
  server.registerTool(
    "test.large",
    { inputSchema: z.object({ size: z.literal(512) }).strict() },
    async () => ({ content: [{ type: "text", text: "x".repeat(512) }] }),
  );
  return server;
}

serveStdio(createServer);
