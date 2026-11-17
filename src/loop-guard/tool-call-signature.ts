import { canonicalJson, sha256Text } from "../shared/canonical-json.js";

const SIGNATURE_DOMAIN = "forgeflow.tool-call-signature.v1";

export interface ToolCallSignature {
  readonly signature: string;
  readonly toolName: string;
}

export function computeToolCallSignature(
  toolCall: { readonly name: string; readonly arguments: unknown },
): ToolCallSignature {
  const input = parseArguments(toolCall.arguments);
  const canonical = canonicalJson({
    toolName: toolCall.name,
    arguments: input,
  });
  return {
    toolName: toolCall.name,
    signature: sha256Text(`${SIGNATURE_DOMAIN}\n${canonical}`),
  };
}

function parseArguments(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { malformedJsonDigest: sha256Text(value) };
  }
}
