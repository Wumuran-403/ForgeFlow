import { z } from "zod";

import { ToolNameSchema } from "../shared/tool-name.js";

export const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

export const ToolModeSchema = z.enum(["read", "write"]);

export const ToolMetadataSchema = z
  .object({
    name: ToolNameSchema,
    description: z.string().trim().min(1),
    mode: ToolModeSchema,
  })
  .strict();

export type ToolMode = z.infer<typeof ToolModeSchema>;
export type ToolMetadata = z.infer<typeof ToolMetadataSchema>;

export const ToolRegistrationOptionsSchema = z
  .object({
    version: z.string().trim().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
    requiresApproval: z.boolean().optional(),
  })
  .strict();

export interface ToolExecutionContext {
  taskId: string;
  toolCallId: string;
  signal: AbortSignal;
  fencingToken?: number;
}

export interface ValidatedToolInput {
  readonly toolName: string;
  readonly mode: ToolMode;
  readonly timeoutMs: number;
  readonly requiresApproval: boolean;
  readonly value: unknown;
}

export interface RegisteredToolMetadata extends ToolMetadata {
  readonly version: string;
  readonly inputSchema: z.ZodType<unknown>;
  readonly timeoutMs: number;
  readonly requiresApproval: boolean;
}

export interface ToolDefinition<TInput = unknown, TOutput = unknown> extends ToolMetadata {
  readonly version?: string;
  readonly inputSchema: z.ZodType<TInput>;
  readonly timeoutMs?: number;
  readonly requiresApproval?: boolean;
  execute(
    input: TInput,
    context?: ToolExecutionContext,
  ): TOutput | Promise<TOutput>;
}

export interface ToolRegistryExecutionLease {
  release(): void;
}
