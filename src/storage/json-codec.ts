import type { z } from "zod";

import { AppError } from "../shared/errors.js";

export class PersistedJsonError extends AppError {
  constructor(column: string) {
    super({
      code: "PERSISTED_JSON_INVALID",
      message: "Persisted JSON data is invalid.",
      statusCode: 500,
      details: [{ path: column, message: "JSON validation failed." }],
    });
  }
}

export function encodeJson<T>(
  schema: z.ZodType<T>,
  value: unknown,
  column: string,
): string {
  try {
    const parsed = schema.parse(value);
    return JSON.stringify(parsed);
  } catch (error) {
    throw new PersistedJsonError(column);
  }
}

export function decodeJson<T>(
  schema: z.ZodType<T>,
  value: string,
  column: string,
): T {
  try {
    return schema.parse(JSON.parse(value) as unknown);
  } catch (error) {
    throw new PersistedJsonError(column);
  }
}
