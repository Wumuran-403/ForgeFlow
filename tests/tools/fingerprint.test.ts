import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  CanonicalJsonError,
  canonicalJson,
  sha256CanonicalJson,
} from "../../src/shared/canonical-json.js";
import {
  computeCanonicalInputHash,
  computeIdempotencyKey,
  computeToolInputSchemaHash,
} from "../../src/tools/fingerprint.js";

describe("canonical tool fingerprints", () => {
  it("canonicalizes object keys deterministically and preserves array order", () => {
    const first = {
      z: 1,
      a: {
        second: [2, 1],
        first: true,
      },
    };
    const second = {
      a: {
        first: true,
        second: [2, 1],
      },
      z: 1,
    };

    expect(canonicalJson(first)).toBe(
      '{"a":{"first":true,"second":[2,1]},"z":1}',
    );
    expect(sha256CanonicalJson(first)).toBe(sha256CanonicalJson(second));
    expect(computeCanonicalInputHash(first)).toBe(
      computeCanonicalInputHash(second),
    );
  });

  it("rejects -0 and non-JSON values before hashing", () => {
    for (const value of [
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      1n,
      new Date("2026-01-01"),
    ]) {
      expect(() => computeCanonicalInputHash(value)).toThrow(
        CanonicalJsonError,
      );
    }
  });

  it("matches selected RFC 8785 number, string, and UTF-16 ordering vectors", () => {
    expect(
      canonicalJson([
        333333333.33333329,
        1e30,
        4.5,
        2e-3,
        1e-27,
      ]),
    ).toBe("[333333333.3333333,1e+30,4.5,0.002,1e-27]");

    const escaped = "\b\f\n\r\t\"\\\u20ac";
    expect(canonicalJson(escaped)).toBe(JSON.stringify(escaped));

    const astralKey = String.fromCodePoint(0x10000);
    const privateUseKey = "\uE000";
    expect(
      canonicalJson({
        [privateUseKey]: "private-use",
        [astralKey]: "astral",
      }),
    ).toBe(`{"${astralKey}":"astral","${privateUseKey}":"private-use"}`);
  });

  it("keeps schema hashes stable and changes them with schema shape", () => {
    const first = z.object({
      partNumber: z.string(),
      quantity: z.number().int().positive(),
    });
    const sameShape = z.object({
      partNumber: z.string(),
      quantity: z.number().int().positive(),
    });
    const changed = z.object({
      partNumber: z.string(),
      quantity: z.number().int().nonnegative(),
    });

    expect(computeToolInputSchemaHash(first)).toBe(
      computeToolInputSchemaHash(sameShape),
    );
    expect(computeToolInputSchemaHash(first)).not.toBe(
      computeToolInputSchemaHash(changed),
    );
  });

  it("binds idempotency keys to tool version and canonical input hash", () => {
    const base = {
      taskId: "task-1",
      planVersion: 1,
      originalIndex: 0,
      toolName: "inventory_lookup",
      toolVersion: "1",
      inputSchemaHash: `sha256:${"a".repeat(64)}`,
      canonicalInputHash: `sha256:${"b".repeat(64)}`,
    };

    expect(computeIdempotencyKey(base)).toBe(computeIdempotencyKey({ ...base }));
    expect(computeIdempotencyKey(base)).not.toBe(
      computeIdempotencyKey({ ...base, toolVersion: "2" }),
    );
    expect(computeIdempotencyKey(base)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
