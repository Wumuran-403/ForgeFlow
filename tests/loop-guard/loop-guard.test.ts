import { describe, expect, it } from "vitest";

import {
  LoopGuard,
  computeToolCallSignature,
  type LoopGuardEntry,
  type LoopGuardRound,
} from "../../src/loop-guard/index.js";

function call(id: string, name: string, argumentsValue: Record<string, unknown>) {
  return { id, name, arguments: argumentsValue };
}

function entry(
  name: string,
  argumentsValue: Record<string, unknown>,
  overrides: Partial<LoopGuardEntry> = {},
): LoopGuardRound {
  return {
    entries: [{
      ...computeToolCallSignature({ name, arguments: argumentsValue }),
      mode: "read",
      outcome: "succeeded",
      resultDigest: "same-result",
      ...overrides,
    }],
  };
}

describe("LoopGuard", () => {
  it("canonicalizes argument key order without storing argument text", () => {
    const left = computeToolCallSignature({ name: "read_part", arguments: { b: 2, a: 1 } });
    const right = computeToolCallSignature({ name: "read_part", arguments: { a: 1, b: 2 } });
    expect(left.signature).toBe(right.signature);
    expect(left.signature).toMatch(/^[a-f0-9]{64}$/);
    expect(left).not.toHaveProperty("arguments");
    expect(computeToolCallSignature({ name: "read_other", arguments: { a: 1, b: 2 } }).signature)
      .not.toBe(left.signature);
    expect(computeToolCallSignature({ name: "read_part", arguments: { a: 2, b: 2 } }).signature)
      .not.toBe(left.signature);
  });

  it("does not trigger for normal distinct calls", () => {
    const guard = new LoopGuard();
    expect(guard.evaluate([
      entry("read_part", { id: 1 }),
      entry("read_part", { id: 2 }),
    ], [call("c3", "read_part", { id: 3 })])).toBeUndefined();
  });

  it("detects A-A-A before the third dispatch", () => {
    const guard = new LoopGuard();
    expect(guard.evaluate([
      entry("read_part", { id: 1 }),
      entry("read_part", { id: 1 }),
    ], [call("c3", "read_part", { id: 1 })])).toMatchObject({
      reason: "consecutive_repeat",
      repeatCount: 3,
      threshold: 3,
    });
  });

  it("detects A-B-A-B-A-B before the sixth dispatch", () => {
    const guard = new LoopGuard();
    expect(guard.evaluate([
      entry("read_a", { id: 1 }),
      entry("read_b", { id: 2 }),
      entry("read_a", { id: 1 }),
      entry("read_b", { id: 2 }),
      entry("read_a", { id: 1 }),
    ], [call("b3", "read_b", { id: 2 })])).toMatchObject({
      reason: "short_cycle",
      period: 2,
      repeatCount: 3,
    });
  });

  it("detects the third identical failure as no progress", () => {
    const guard = new LoopGuard();
    expect(guard.evaluate([
      entry("unstable_read", { id: 1 }, { outcome: "failed", resultDigest: "same-error" }),
      entry("unstable_read", { id: 1 }, { outcome: "failed", resultDigest: "same-error" }),
    ], [call("f3", "unstable_read", { id: 1 })])).toMatchObject({
      reason: "no_progress_failure",
      repeatCount: 3,
    });
    expect(guard.evaluate([
      entry("unstable_read", { id: 1 }, { outcome: "failed", resultDigest: "error-a" }),
      entry("unstable_read", { id: 1 }, { outcome: "failed", resultDigest: "error-b" }),
    ], [call("f4", "unstable_read", { id: 1 })])).toBeUndefined();
  });

  it("does not classify a multi-call read batch as a single repeated round", () => {
    const guard = new LoopGuard();
    const batch = {
      entries: [
        entry("read_part", { id: 1 }).entries[0] as LoopGuardEntry,
        entry("read_part", { id: 2 }).entries[0] as LoopGuardEntry,
      ],
    };
    expect(guard.evaluate([batch, batch], [
      call("a", "read_part", { id: 1 }),
      call("b", "read_part", { id: 2 }),
    ])).toBeUndefined();
  });

  it("resets repetition when a read result changes or a write succeeds", () => {
    const guard = new LoopGuard();
    expect(guard.evaluate([
      entry("read_part", { id: 1 }, { resultDigest: "old" }),
      entry("read_part", { id: 1 }, { resultDigest: "new" }),
    ], [call("r3", "read_part", { id: 1 })])).toBeUndefined();
    expect(guard.evaluate([
      entry("write_part", { id: 1 }, { mode: "write", outcome: "succeeded" }),
      entry("write_part", { id: 1 }, { mode: "write", outcome: "failed" }),
    ], [call("w3", "write_part", { id: 1 })])).toBeUndefined();
  });
});
