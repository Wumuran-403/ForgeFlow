import { z } from "zod";

export const ToolCallSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()),
  })
  .strict();

export const AgentMessageSchema = z.discriminatedUnion("role", [
  z
    .object({
      role: z.literal("system"),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      role: z.literal("user"),
      content: z.string(),
    })
    .strict(),
  z
    .object({
      role: z.literal("assistant"),
      content: z.string(),
      toolCalls: z.array(ToolCallSchema).optional(),
    })
    .strict(),
  z
    .object({
      role: z.literal("tool"),
      toolCallId: z.string().min(1),
      content: z.string(),
    })
    .strict(),
]);

export const ModelUsageSchema = z
  .object({
    promptTokens: z.number().int().nonnegative().optional(),
    completionTokens: z.number().int().nonnegative().optional(),
    totalTokens: z.number().int().nonnegative().optional(),
    source: z.enum(["provider", "estimated", "unknown"]),
  })
  .strict();

export const ModelToolDefinitionSchema = z
  .object({
    name: z.string().min(1),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
  })
  .strict();

export const ModelRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(AgentMessageSchema),
    tools: z.array(ModelToolDefinitionSchema),
    temperature: z.number().min(0).max(2).optional(),
  })
  .strict();

export const AssistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z.string(),
    toolCalls: z.array(ToolCallSchema).optional(),
  })
  .strict();

export const ModelResponseSchema = z
  .object({
    message: AssistantMessageSchema,
    usage: ModelUsageSchema,
    finishReason: z.string().optional(),
    requestId: z.string().optional(),
  })
  .strict();

export type ToolCall = z.infer<typeof ToolCallSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
export type ModelUsage = z.infer<typeof ModelUsageSchema>;
export type ModelToolDefinition = z.infer<typeof ModelToolDefinitionSchema>;
export type ModelRequest = z.infer<typeof ModelRequestSchema>;
export type AssistantMessage = z.infer<typeof AssistantMessageSchema>;
export type ModelResponse = z.infer<typeof ModelResponseSchema>;

export interface GenerateOptions {
  signal?: AbortSignal;
}

export interface LLMProvider {
  generate(request: ModelRequest, options?: GenerateOptions): Promise<ModelResponse>;
}
