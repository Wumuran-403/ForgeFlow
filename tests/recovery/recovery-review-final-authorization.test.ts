import { afterEach, describe, expect, it, vi } from "vitest";

import { createHostAuthFixture, now } from "../host-auth/host-auth-fixture.js";
import { issueManualFinalDecisionAuthorization, issueVerifierFinalDecisionAuthorization,
  assertFinalDecisionAuthorization } from "../../src/recovery/recovery-review-final-decision-authorization.js";

afterEach(() => vi.useRealTimers());

const digest = `sha256:${"a".repeat(64)}`;
const identity = {
  taskId: "task-1", reviewId: "review-1", originalUnknownWriteToolRunId: "write-1",
  operation: "confirm_succeeded" as const, expectedDecisionVersion: 2,
  operationPayloadDigest: digest, sourceContractDigest: null, requestKey: digest,
};

describe("Final Decision Host authorization", () => {
  it("binds exact request identity to a real authenticated Human context", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const host = createHostAuthFixture();
    const context = host.gateway.createContext({ access: "final_decision",
      assertion: host.issueAssertion(host.humanPrivateKey, "human-reviewer-key-1") });
    const auth = issueManualFinalDecisionAuthorization(context, identity, "final_decision");
    expect(assertFinalDecisionAuthorization(auth, { ...identity, access: "final_decision" }).actorType).toBe("human_reviewer");
    for (const mismatch of [{ taskId: "other" }, { reviewId: "other" }, { requestKey: `sha256:${"b".repeat(64)}` },
      { expectedDecisionVersion: 3 }, { operation: "confirm_not_executed" as const }]) {
      expect(() => assertFinalDecisionAuthorization(auth, { ...identity, ...mismatch, access: "final_decision" })).toThrow();
    }
    expect(() => assertFinalDecisionAuthorization(auth, { ...identity, access: "read_replay" })).toThrow();
    expect(() => issueVerifierFinalDecisionAuthorization(context, identity, "final_decision")).toThrow();
    expect(() => assertFinalDecisionAuthorization({ ...auth }, { ...identity, access: "final_decision" })).toThrow();
    expect(() => assertFinalDecisionAuthorization({} as typeof auth, { ...identity, access: "final_decision" })).toThrow();
    expect(() => issueManualFinalDecisionAuthorization({} as typeof context, identity, "final_decision")).toThrow();
    vi.setSystemTime(new Date("2026-01-01T00:06:00.000Z"));
    expect(() => assertFinalDecisionAuthorization(auth, { ...identity, access: "final_decision" })).toThrow();
  });

  it("issues a separate read-only authorization without write access", () => {
    vi.useFakeTimers(); vi.setSystemTime(now);
    const host = createHostAuthFixture();
    const context = host.gateway.createContext({ access: "read_replay",
      assertion: host.issueAssertion(host.verifierPrivateKey, "host-verifier-key-1") });
    const auth = issueVerifierFinalDecisionAuthorization(context, identity, "read_replay");
    expect(assertFinalDecisionAuthorization(auth, { ...identity, access: "read_replay" }).actorType).toBe("host_verifier");
    expect(() => assertFinalDecisionAuthorization(auth, { ...identity, access: "final_decision" })).toThrow();
  });
});
