import { Client, SdkError, SdkErrorCode } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { z } from "zod";

import { assertCanonicalJsonValue } from "../shared/canonical-json.js";
import {
  McpConfigurationError,
  McpConnectionError,
  McpToolResultError,
  McpToolUnauthorizedError,
} from "./errors.js";
import {
  McpNamespaceSchema,
  McpToolPolicySchema,
  type McpDiscoveredTool,
  type ParsedMcpToolPolicy,
  type TrustedMcpStdioServerConfig,
} from "./types.js";

const McpAdvertisedToolSchema = z
  .object({
    name: z.string().trim().min(1).max(128),
    description: z.string().default("MCP tool"),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()).optional(),
  })
  .passthrough();

const McpTextContentSchema = z
  .object({ type: z.literal("text"), text: z.string() })
  .passthrough();

export interface McpCallOptions {
  readonly signal?: AbortSignal;
}

export class McpStdioClientAdapter {
  readonly serverId: string;
  readonly namespace: string;
  private readonly policies: ReadonlyMap<string, ParsedMcpToolPolicy>;
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly connectTimeoutMs: number;
  private discovered = new Map<string, McpDiscoveredTool>();
  private connected = false;

  constructor(config: TrustedMcpStdioServerConfig) {
    this.serverId = z.string().trim().min(1).max(64).parse(config.serverId);
    this.namespace = McpNamespaceSchema.parse(config.namespace);
    if (config.command.trim().length === 0 || config.args.some((argument) => argument.includes("\0"))) {
      throw new McpConfigurationError("Trusted MCP stdio command configuration is invalid.");
    }
    const parsedPolicies = config.tools.map((policy) => McpToolPolicySchema.parse(policy));
    if (new Set(parsedPolicies.map((policy) => policy.remoteName)).size !== parsedPolicies.length) {
      throw new McpConfigurationError("Trusted MCP tool policies must use unique remote names.");
    }
    this.policies = new Map(parsedPolicies.map((policy) => [policy.remoteName, policy]));
    this.connectTimeoutMs = z.number().int().positive().max(120_000)
      .parse(config.connectTimeoutMs ?? 10_000);
    this.client = new Client({ name: `forgeflow-${this.serverId}`, version: "0.1.0" });
    this.transport = new StdioClientTransport({
      command: config.command,
      args: [...config.args],
      ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
      ...(config.env === undefined ? {} : { env: { ...config.env } }),
      stderr: "pipe",
      maxBufferSize: 1_048_576,
    });
  }

  async connect(options: McpCallOptions = {}): Promise<void> {
    if (this.connected) return;
    try {
      await this.client.connect(this.transport, {
        timeout: this.connectTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      this.connected = true;
    } catch (error) {
      await this.safeClose();
      throw new McpConnectionError("Failed to initialize the configured MCP stdio server.", error);
    }
  }

  async listTools(options: McpCallOptions = {}): Promise<readonly McpDiscoveredTool[]> {
    this.assertConnected();
    let response;
    try {
      response = await this.client.listTools(undefined, {
        timeout: this.connectTimeoutMs,
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
    } catch (error) {
      throw new McpConnectionError("Failed to list MCP tools.", error);
    }
    const tools = response.tools.map((tool) => {
      const parsed = McpAdvertisedToolSchema.parse(tool);
      return {
        remoteName: parsed.name,
        description: parsed.description,
        inputSchema: parsed.inputSchema,
        ...(parsed.outputSchema === undefined ? {} : { outputSchema: parsed.outputSchema }),
      } satisfies McpDiscoveredTool;
    });
    this.discovered = new Map(tools.map((tool) => [tool.remoteName, tool]));
    return tools;
  }

  async callTool(
    remoteName: string,
    input: unknown,
    options: McpCallOptions = {},
  ): Promise<unknown> {
    this.assertConnected();
    const policy = this.policies.get(remoteName);
    if (policy === undefined) throw new McpToolUnauthorizedError(remoteName);
    const tool = this.discovered.get(remoteName);
    if (tool === undefined) {
      throw new McpToolResultError(
        "MCP_TOOL_NOT_DISCOVERED",
        "MCP tools must be discovered and schema-validated before invocation.",
      );
    }
    let inputSchema: z.ZodType<unknown>;
    try {
      if (tool.inputSchema.type !== "object") {
        throw new TypeError("MCP tool inputs must use a top-level object schema.");
      }
      inputSchema = z.fromJSONSchema(tool.inputSchema);
    } catch (error) {
      throw new McpToolResultError(
        "MCP_TOOL_SCHEMA_INVALID",
        "The MCP tool input schema cannot be validated safely.",
        error,
      );
    }
    const parsedInput = await inputSchema.safeParseAsync(input);
    if (!parsedInput.success) {
      throw new McpToolResultError("MCP_TOOL_INPUT_INVALID", "MCP tool input failed its discovered schema.");
    }
    assertCanonicalJsonValue(parsedInput.data);
    if (parsedInput.data === null || Array.isArray(parsedInput.data) ||
        typeof parsedInput.data !== "object") {
      throw new McpToolResultError(
        "MCP_TOOL_INPUT_INVALID",
        "MCP tool input must be a JSON object.",
      );
    }

    let result;
    try {
      result = await this.client.callTool(
        { name: remoteName, arguments: parsedInput.data as Record<string, unknown> },
        {
          timeout: policy.timeoutMs,
          maxTotalTimeout: policy.timeoutMs,
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        },
      );
    } catch (error) {
      if (options.signal?.aborted === true) {
        throw new McpToolResultError(
          "MCP_TOOL_CALL_CANCELLED",
          "The MCP tool call was cancelled.",
          error,
        );
      }
      if (error instanceof SdkError && error.code === SdkErrorCode.RequestTimeout) {
        throw new McpToolResultError(
          "MCP_TOOL_CALL_TIMEOUT",
          "The MCP tool call exceeded its configured timeout.",
          error,
        );
      }
      throw new McpConnectionError("MCP tool call failed or the server disconnected.", error);
    }
    if (result.isError === true) {
      throw new McpToolResultError(
        "MCP_TOOL_REPORTED_ERROR",
        "The MCP server reported a tool execution error.",
      );
    }
    const content = z.array(McpTextContentSchema).max(64).parse(result.content)
      .map((item) => ({ type: "text" as const, text: item.text }));
    const output = {
      content,
      ...(result.structuredContent === undefined
        ? {}
        : { structuredContent: result.structuredContent }),
    };
    assertCanonicalJsonValue(output);
    const serialized = JSON.stringify(output);
    if (Buffer.byteLength(serialized, "utf8") > policy.maxOutputBytes) {
      throw new McpToolResultError(
        "MCP_TOOL_OUTPUT_TOO_LARGE",
        "The MCP tool result exceeded the configured output limit.",
      );
    }
    return output;
  }

  getPolicy(remoteName: string): ParsedMcpToolPolicy | undefined {
    return this.policies.get(remoteName);
  }

  getPolicyNames(): readonly string[] {
    return [...this.policies.keys()];
  }

  getDiscoveredTool(remoteName: string): McpDiscoveredTool | undefined {
    return this.discovered.get(remoteName);
  }

  async close(): Promise<void> {
    await this.safeClose();
  }

  private assertConnected(): void {
    if (!this.connected) {
      throw new McpConnectionError("MCP client is not connected.");
    }
  }

  private async safeClose(): Promise<void> {
    this.connected = false;
    this.discovered.clear();
    try {
      await this.client.close();
    } catch {
      // Best-effort cleanup after a failed initialize or crashed child.
    }
  }
}
