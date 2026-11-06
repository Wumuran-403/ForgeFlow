import { createHash } from "node:crypto";

import { AppError } from "./errors.js";

export type CanonicalJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CanonicalJsonValue[]
  | { readonly [key: string]: CanonicalJsonValue };

export class CanonicalJsonError extends AppError {
  constructor() {
    super({
      code: "CANONICAL_JSON_INVALID",
      message: "Value is not valid canonical JSON input.",
      statusCode: 500,
      details: [],
    });
  }
}

function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

export function assertCanonicalJsonValue(
  value: unknown,
  ancestors = new WeakSet<object>(),
): asserts value is CanonicalJsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return;
  }

  if (typeof value === "number") {
    if (Number.isFinite(value) && !Object.is(value, -0)) {
      return;
    }
    throw new CanonicalJsonError();
  }

  if (typeof value !== "object") {
    throw new CanonicalJsonError();
  }

  if (ancestors.has(value)) {
    throw new CanonicalJsonError();
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const keys = Reflect.ownKeys(value);
      if (
        keys.length !== value.length + 1 ||
        keys.at(-1) !== "length"
      ) {
        throw new CanonicalJsonError();
      }
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) {
          throw new CanonicalJsonError();
        }
        assertCanonicalJsonValue(value[index], ancestors);
      }
      return;
    }

    if (!isPlainObject(value)) {
      throw new CanonicalJsonError();
    }

    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") {
        throw new CanonicalJsonError();
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        !descriptor.enumerable
      ) {
        throw new CanonicalJsonError();
      }
      assertCanonicalJsonValue(descriptor.value, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function serializeCanonicalJson(value: CanonicalJsonValue): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "boolean") {
    return value ? "true" : "false";
  }
  if (typeof value === "number") {
    return JSON.stringify(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(serializeCanonicalJson).join(",")}]`;
  }

  const record = value as { readonly [key: string]: CanonicalJsonValue };
  const entries = Object.keys(record)
    .sort()
    .map(
      (key) =>
        `${JSON.stringify(key)}:${serializeCanonicalJson(record[key] as CanonicalJsonValue)}`,
    );
  return `{${entries.join(",")}}`;
}

export function canonicalJson(value: unknown): string {
  assertCanonicalJsonValue(value);
  return serializeCanonicalJson(value);
}

export function sha256CanonicalJson(value: unknown): string {
  const digest = createHash("sha256")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
