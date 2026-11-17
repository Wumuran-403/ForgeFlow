import { z } from "zod";

import { ToolNameSchema } from "../shared/tool-name.js";
import { ToolModeSchema } from "../tools/types.js";

export const McpToolPolicySchema = z
  .object({
    remoteName: z.string().trim().min(1).max(128),
    mode: ToolModeSchema,
    requiresApproval: z.boolean().optional(),
    timeoutMs: z.number().int().positive().max(300_000).default(30_000),
    maxOutputBytes: z.number().int().positive().max(1_048_576).default(65_536),
  })
  .strict()
  .superRefine((policy, context) => {
    if (policy.mode === "write" && policy.requiresApproval === false) {
      context.addIssue({
        code: "custom",
        path: ["requiresApproval"],
        message: "MCP write tools must require approval.",
      });
    }
  });

export const McpNamespaceSchema = ToolNameSchema.refine(
  (value) => value.length <= 24,
  "MCP namespaces must be at most 24 characters.",
);

export type McpToolPolicy = z.input<typeof McpToolPolicySchema>;
export type ParsedMcpToolPolicy = z.output<typeof McpToolPolicySchema>;

export interface TrustedMcpStdioServerConfig {
  readonly serverId: string;
  readonly namespace: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly connectTimeoutMs?: number;
  readonly tools: readonly McpToolPolicy[];
}

export interface McpDiscoveredTool {
  readonly remoteName: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema?: Readonly<Record<string, unknown>>;
}

export interface McpMappedTool {
  readonly remoteName: string;
  readonly localName: string;
  readonly mode: "read" | "write";
  readonly requiresApproval: boolean;
}
