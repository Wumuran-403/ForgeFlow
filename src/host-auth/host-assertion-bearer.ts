import { AppError } from "../shared/errors.js";
import { canonicalJson } from "../shared/canonical-json.js";
import { HostAssertionV1Schema } from "./host-assertion.js";

const PREFIX = "forgeflow-host-assertion.v1.";
const MAX_ENCODED_LENGTH = 24_000;

export function encodeHostAssertionBearerToken(input: unknown): string {
  const assertion = HostAssertionV1Schema.parse(input);
  const bytes = Buffer.from(canonicalJson(assertion), "utf8");
  return `${PREFIX}${bytes.toString("base64url")}`;
}

export function decodeHostAssertionBearerToken(input: string): unknown {
  if (
    input.length <= PREFIX.length ||
    input.length > MAX_ENCODED_LENGTH ||
    !input.startsWith(PREFIX)
  ) {
    throw bearerError();
  }
  const encoded = input.slice(PREFIX.length);
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw bearerError();
  }

  let parsed: unknown;
  try {
    const bytes = Buffer.from(encoded, "base64url");
    if (bytes.toString("base64url") !== encoded) {
      throw bearerError();
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    if (error instanceof AppError) {
      throw error;
    }
    throw bearerError();
  }

  let assertion;
  try {
    assertion = HostAssertionV1Schema.parse(parsed);
  } catch {
    throw bearerError();
  }
  if (encodeHostAssertionBearerToken(assertion) !== input) {
    throw bearerError();
  }
  return assertion;
}

function bearerError(): AppError {
  return new AppError({
    code: "HOST_ASSERTION_BEARER_INVALID",
    message: "Host assertion bearer token is invalid.",
    statusCode: 401,
    details: [],
  });
}
