import { z } from "zod";

import type { ToolCall } from "../provider/types.js";
import type { ToolMode } from "../tools/types.js";
import { computeToolCallSignature } from "./tool-call-signature.js";

export const LoopGuardOptionsSchema = z
  .object({
    consecutiveRepeatThreshold: z.number().int().min(2).default(3),
    cycleRepetitions: z.number().int().min(2).default(3),
    failureThreshold: z.number().int().min(2).default(3),
    maxHistoryRounds: z.number().int().min(6).default(12),
  })
  .strict()
  .superRefine((value, context) => {
    const required = Math.max(
      value.consecutiveRepeatThreshold,
      value.cycleRepetitions * 2,
      value.failureThreshold,
    );
    if (value.maxHistoryRounds < required) {
      context.addIssue({
        code: "custom",
        path: ["maxHistoryRounds"],
        message: `History must retain at least ${required} rounds.`,
      });
    }
  });

export type LoopGuardOptions = z.input<typeof LoopGuardOptionsSchema>;

export type LoopGuardOutcome =
  | "succeeded"
  | "failed"
  | "timed_out"
  | "cancelled"
  | "skipped"
  | "unknown";

export interface LoopGuardEntry {
  readonly signature: string;
  readonly toolName: string;
  readonly mode?: ToolMode;
  readonly outcome: LoopGuardOutcome;
  /** Digest only; the original tool result never enters Loop Guard state. */
  readonly resultDigest?: string;
}

export interface LoopGuardRound {
  readonly entries: readonly LoopGuardEntry[];
}

export type LoopDetectionReason =
  | "consecutive_repeat"
  | "short_cycle"
  | "no_progress_failure";

export interface LoopGuardDecision {
  readonly reason: LoopDetectionReason;
  readonly signature: string;
  readonly toolNames: readonly string[];
  readonly repeatCount: number;
  readonly threshold: number;
  readonly period?: 2;
}

export class LoopGuard {
  readonly options: z.output<typeof LoopGuardOptionsSchema>;

  constructor(options: LoopGuardOptions = {}) {
    this.options = LoopGuardOptionsSchema.parse(options);
  }

  evaluate(
    history: readonly LoopGuardRound[],
    proposedCalls: readonly ToolCall[],
  ): LoopGuardDecision | undefined {
    // A model round is the unit of detection. Multi-call batches are excluded
    // so normal read parallelism cannot be mistaken for an across-round loop.
    if (proposedCalls.length !== 1) return undefined;
    const proposed = computeToolCallSignature(proposedCalls[0] as ToolCall);
    const rounds = history.slice(-this.options.maxHistoryRounds);
    const singles = rounds.map(singleEntry);

    const failureCount = countFailureTail(singles, proposed.signature);
    if (failureCount + 1 >= this.options.failureThreshold) {
      return {
        reason: "no_progress_failure",
        signature: proposed.signature,
        toolNames: [proposed.toolName],
        repeatCount: failureCount + 1,
        threshold: this.options.failureThreshold,
      };
    }

    const repeatCount = countNoProgressTail(singles, proposed.signature) + 1;
    if (repeatCount >= this.options.consecutiveRepeatThreshold) {
      return {
        reason: "consecutive_repeat",
        signature: proposed.signature,
        toolNames: [proposed.toolName],
        repeatCount,
        threshold: this.options.consecutiveRepeatThreshold,
      };
    }

    const sequence = [...singles, proposedEntry(proposed)].slice(
      -(this.options.cycleRepetitions * 2),
    );
    if (isTwoCycle(sequence, this.options.cycleRepetitions)) {
      const first = sequence[0] as LoopGuardEntry;
      const second = sequence[1] as LoopGuardEntry;
      return {
        reason: "short_cycle",
        signature: proposed.signature,
        toolNames: [first.toolName, second.toolName],
        repeatCount: this.options.cycleRepetitions,
        threshold: this.options.cycleRepetitions,
        period: 2,
      };
    }
    return undefined;
  }
}

function singleEntry(round: LoopGuardRound): LoopGuardEntry | undefined {
  return round.entries.length === 1 ? round.entries[0] : undefined;
}

function proposedEntry(value: { signature: string; toolName: string }): LoopGuardEntry {
  return { ...value, outcome: "skipped" };
}

function countFailureTail(
  entries: readonly (LoopGuardEntry | undefined)[],
  signature: string,
): number {
  let count = 0;
  let resultDigest: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.signature !== signature ||
        (entry.outcome !== "failed" && entry.outcome !== "timed_out")) break;
    if (resultDigest !== undefined && entry.resultDigest !== resultDigest) break;
    resultDigest = entry.resultDigest;
    count += 1;
  }
  return count;
}

function countNoProgressTail(
  entries: readonly (LoopGuardEntry | undefined)[],
  signature: string,
): number {
  let count = 0;
  let resultDigest: string | undefined;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry === undefined || entry.signature !== signature || entry.outcome === "unknown") break;
    if (entry.mode === "write" && entry.outcome === "succeeded") break;
    if (entry.resultDigest !== undefined) {
      if (resultDigest !== undefined && resultDigest !== entry.resultDigest) break;
      resultDigest = entry.resultDigest;
    }
    count += 1;
  }
  return count;
}

function isTwoCycle(
  entries: readonly (LoopGuardEntry | undefined)[],
  repetitions: number,
): boolean {
  if (entries.length !== repetitions * 2 || entries.some((entry) => entry === undefined)) {
    return false;
  }
  const resolved = entries as readonly LoopGuardEntry[];
  if (resolved[0]?.signature === resolved[1]?.signature) return false;
  if (resolved.some((entry) => entry.outcome === "unknown" ||
      (entry.mode === "write" && entry.outcome === "succeeded"))) return false;
  const resultDigestBySignature = new Map<string, string>();
  for (const entry of resolved) {
    if (entry.outcome !== "succeeded" || entry.resultDigest === undefined) continue;
    const previous = resultDigestBySignature.get(entry.signature);
    if (previous !== undefined && previous !== entry.resultDigest) return false;
    resultDigestBySignature.set(entry.signature, entry.resultDigest);
  }
  return resolved.every((entry, index) =>
    entry.signature === resolved[index % 2]?.signature,
  );
}
