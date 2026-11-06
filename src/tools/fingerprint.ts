import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
  sha256Text,
} from "../shared/canonical-json.js";
import type { RegisteredToolMetadata } from "./types.js";

const IDEMPOTENCY_DOMAIN = "forgeflow.tool-idempotency.v1";

export interface ToolIdempotencyInput {
  readonly taskId: string;
  readonly planVersion: number;
  readonly originalIndex: number;
  readonly toolName: string;
  readonly toolVersion: string;
  readonly inputSchemaHash: string;
  readonly canonicalInputHash: string;
}

export function computeToolInputSchemaHash(
  inputSchema: z.ZodType<unknown>,
): string {
  const schema = z.toJSONSchema(inputSchema, {
    target: "draft-07",
    io: "input",
    unrepresentable: "throw",
  });
  return sha256CanonicalJson(
    JSON.parse(JSON.stringify(schema)) as unknown,
  );
}

export function computeCanonicalInputHash(input: unknown): string {
  return sha256CanonicalJson(input);
}

export function computeToolDefinitionFingerprint(
  tool: RegisteredToolMetadata,
  validatedInput: unknown,
): {
  readonly toolVersion: string;
  readonly inputSchemaHash: string;
  readonly canonicalInputHash: string;
  readonly mode: RegisteredToolMetadata["mode"];
  readonly requiresApproval: boolean;
} {
  return {
    toolVersion: tool.version,
    inputSchemaHash: computeToolInputSchemaHash(tool.inputSchema),
    canonicalInputHash: computeCanonicalInputHash(validatedInput),
    mode: tool.mode,
    requiresApproval: tool.requiresApproval,
  };
}

export function computeIdempotencyKey(
  input: ToolIdempotencyInput,
): string {
  const canonicalPayload = canonicalJson([
    input.taskId,
    input.planVersion,
    input.originalIndex,
    input.toolName,
    input.toolVersion,
    input.inputSchemaHash,
    input.canonicalInputHash,
  ]);
  return `sha256:${sha256Text(`${IDEMPOTENCY_DOMAIN}\n${canonicalPayload}`)}`;
}
