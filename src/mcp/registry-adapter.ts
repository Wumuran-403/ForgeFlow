import { z } from "zod";

import { ToolNameSchema } from "../shared/tool-name.js";
import type { ToolRegistry } from "../tools/registry.js";
import { McpConfigurationError } from "./errors.js";
import type { McpStdioClientAdapter } from "./client.js";
import type { McpMappedTool } from "./types.js";

export async function registerMcpTools(
  registry: ToolRegistry,
  client: McpStdioClientAdapter,
  signal?: AbortSignal,
): Promise<readonly McpMappedTool[]> {
  const discovered = await client.listTools(signal === undefined ? {} : { signal });
  const mapped: McpMappedTool[] = [];
  const localNames = new Set<string>();

  for (const tool of discovered) {
    const policy = client.getPolicy(tool.remoteName);
    if (policy === undefined) continue;
    const localName = toLocalToolName(client.namespace, tool.remoteName);
    if (localNames.has(localName) || registry.has(localName)) {
      throw new McpConfigurationError(`MCP tool mapping collision for '${localName}'.`);
    }
    localNames.add(localName);
    let inputSchema: z.ZodType<unknown>;
    try {
      if (tool.inputSchema.type !== "object") {
        throw new TypeError("MCP tool inputs must use a top-level object schema.");
      }
      inputSchema = z.fromJSONSchema(tool.inputSchema);
      z.toJSONSchema(inputSchema, { target: "draft-07", io: "input", unrepresentable: "throw" });
    } catch (error) {
      throw new McpConfigurationError(
        `MCP input schema for '${tool.remoteName}' cannot be mapped safely: ${String(error)}`,
      );
    }
    const requiresApproval = policy.mode === "write"
      ? true
      : policy.requiresApproval ?? false;
    registry.register({
      name: localName,
      description: tool.description,
      mode: policy.mode,
      version: "mcp-v2",
      inputSchema,
      timeoutMs: policy.timeoutMs,
      requiresApproval,
      execute: async (input, context) => client.callTool(
        tool.remoteName,
        input,
        context?.signal === undefined ? {} : { signal: context.signal },
      ),
    });
    mapped.push({
      remoteName: tool.remoteName,
      localName,
      mode: policy.mode,
      requiresApproval,
    });
  }

  for (const policyName of client.getPolicyNames()) {
    if (!mapped.some((tool) => tool.remoteName === policyName)) {
      throw new McpConfigurationError(
        `Configured MCP tool '${policyName}' was not advertised by the server.`,
      );
    }
  }
  return mapped;
}

function toLocalToolName(namespace: string, remoteName: string): string {
  const normalized = remoteName.toLowerCase().replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return ToolNameSchema.parse(`mcp_${namespace}_${normalized}`);
}
