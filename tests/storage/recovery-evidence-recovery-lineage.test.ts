import { describe, expect, it } from "vitest";

import {
  RecoveryEvidenceInterruptLineageV1Schema,
  RecoveryEvidenceLineageV1Schema,
  RecoveryEvidencePrepareLineageV1Schema,
  canonicalRecoveryEvidenceLineageV1,
  validateRecoveryEvidenceLineagePair,
  validateRecoveryEvidenceLineageV1,
} from "../../src/storage/recovery-evidence-recovery-lineage.js";

const RECOVERY_OPERATION_ID =
  "11111111-1111-4111-8111-111111111111";
const OTHER_RECOVERY_OPERATION_ID =
  "99999999-9999-4999-8999-999999999999";
const DISPATCH_EVENT_ID =
  "22222222-2222-4222-8222-222222222222";
const INTERRUPTION_EVENT_ID =
  "33333333-3333-4333-8333-333333333333";
const LEASE_CLAIM_EVENT_ID =
  "44444444-4444-4444-8444-444444444444";
const RESUME_LEASE_CLAIM_EVENT_ID =
  "55555555-5555-4555-8555-555555555555";
const PAUSE_REQUEST_EVENT_ID =
  "66666666-6666-4666-8666-666666666666";
const PAUSE_CLEAR_EVENT_ID =
  "77777777-7777-4777-8777-777777777777";
const CANCEL_INTENT_EVENT_ID =
  "88888888-8888-4888-8888-888888888888";

function interruptLineage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    lineageSchemaVersion: "recovery-evidence-lineage.v1",
    recoveryOperationId: RECOVERY_OPERATION_ID,
    recoveryPhase: "interrupt",
    taskId: "task-lineage",
    readbackRequestId: "request-lineage",
    readToolRunId: "read-run-lineage",
    readAttemptId: "attempt-1",
    attemptNumber: 1,
    priorAttemptId: "attempt-1",
    priorAttemptNumber: 1,
    attemptStatus: "interrupted",
    dispatchEventId: DISPATCH_EVENT_ID,
    dispatchFencingToken: 1,
    leaseClaimEventId: LEASE_CLAIM_EVENT_ID,
    fencingToken: 2,
    interruptionCause: "retry_unsafe",
    reasonCode: "RETRY_UNSAFE",
    retryAssessment: "failed",
    resumeEligible: false,
    retrySafety: "version_conditional",
    consistencyMode: "etag_or_resource_version",
    allowlistId: "inventory_readback",
    allowlistVersion: "a".repeat(64),
    readToolName: "inventory_lookup",
    readToolVersion: "1",
    readToolSchemaHash: `sha256:${"b".repeat(64)}`,
    requestIntentDigest: `sha256:${"c".repeat(64)}`,
    expectedResourceVersion: "7",
    expectedEtag: null,
    ...overrides,
  };
}

function pauseInterruptLineage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return interruptLineage({
    interruptionCause: "pause_intent",
    reasonCode: "PAUSE_INTERRUPTED",
    retryAssessment: "passed",
    resumeEligible: true,
    controlIntentKind: "pause",
    controlIntentEventId: PAUSE_REQUEST_EVENT_ID,
    pauseRequestEventId: PAUSE_REQUEST_EVENT_ID,
    ...overrides,
  });
}

function prepareLineage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    lineageSchemaVersion: "recovery-evidence-lineage.v1",
    recoveryOperationId: RECOVERY_OPERATION_ID,
    recoveryPhase: "prepare",
    taskId: "task-lineage",
    readbackRequestId: "request-lineage",
    readToolRunId: "read-run-lineage",
    readAttemptId: "attempt-2",
    attemptNumber: 2,
    attemptStatus: "prepared",
    priorAttemptId: "attempt-1",
    priorAttemptNumber: 1,
    interruptionEventId: INTERRUPTION_EVENT_ID,
    newAttemptId: "attempt-2",
    newAttemptNumber: 2,
    leaseClaimEventId: RESUME_LEASE_CLAIM_EVENT_ID,
    fencingToken: 3,
    pauseClearEventId: PAUSE_CLEAR_EVENT_ID,
    retrySafety: "version_conditional",
    consistencyMode: "etag_or_resource_version",
    allowlistId: "inventory_readback",
    allowlistVersion: "a".repeat(64),
    readToolName: "inventory_lookup",
    readToolVersion: "1",
    readToolSchemaHash: `sha256:${"b".repeat(64)}`,
    requestIntentDigest: `sha256:${"c".repeat(64)}`,
    expectedResourceVersion: "7",
    expectedEtag: null,
    ...overrides,
  };
}

describe("RecoveryEvidenceLineageV1", () => {
  it("accepts legal Interrupt and Prepare payloads", () => {
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage(),
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        prepareLineage(),
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidenceLineageV1Schema.safeParse(
        interruptLineage(),
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidenceLineageV1Schema.safeParse(
        prepareLineage(),
      ).success,
    ).toBe(true);
  });

  it("uses one root operation identity across phases", () => {
    const result = validateRecoveryEvidenceLineagePair({
      interrupt: pauseInterruptLineage(),
      prepare: prepareLineage(),
      interruptionEventId: INTERRUPTION_EVENT_ID,
    });
    expect(result.interrupt.recoveryPhase).toBe("interrupt");
    expect(result.prepare?.recoveryPhase).toBe("prepare");
    expect(result.prepare?.recoveryOperationId).toBe(
      result.interrupt.recoveryOperationId,
    );
  });

  it("allows different Lease Claim Events for interruption and Resume", () => {
    const result = validateRecoveryEvidenceLineagePair({
      interrupt: pauseInterruptLineage(),
      prepare: prepareLineage(),
      interruptionEventId: INTERRUPTION_EVENT_ID,
    });
    expect(result.interrupt.leaseClaimEventId).toBe(
      LEASE_CLAIM_EVENT_ID,
    );
    expect(result.prepare?.leaseClaimEventId).toBe(
      RESUME_LEASE_CLAIM_EVENT_ID,
    );
  });

  it("requires an Event ID only when Prepare lineage exists", () => {
    expect(
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
      }).prepare,
    ).toBeNull();

    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage(),
      }),
    ).toThrow(/Interrupted Event/i);

    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage(),
        interruptionEventId: CANCEL_INTENT_EVENT_ID,
      }),
    ).toThrow(/Interrupted Event/i);
  });

  it("rejects identity mismatches against the expected binding", () => {
    expect(() =>
      validateRecoveryEvidenceLineageV1(interruptLineage(), {
        taskId: "other-task",
      }),
    ).toThrow(/identity/i);
    expect(() =>
      validateRecoveryEvidenceLineageV1(interruptLineage(), {
        readbackRequestId: "other-request",
      }),
    ).toThrow(/identity/i);
    expect(() =>
      validateRecoveryEvidenceLineageV1(interruptLineage(), {
        readToolRunId: "other-run",
      }),
    ).toThrow(/identity/i);
  });

  it("rejects invalid root IDs and phase-local Attempt mismatches", () => {
    expect(
      RecoveryEvidenceLineageV1Schema.safeParse(
        interruptLineage({
          recoveryOperationId: "not-a-uuid",
        }),
      ).success,
    ).toBe(false);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({ readAttemptId: "other-attempt" }),
      ).success,
    ).toBe(false);
    expect(
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        prepareLineage({ readAttemptId: "other-attempt" }),
      ).success,
    ).toBe(false);
  });

  it("rejects non-contiguous attempt numbers", () => {
    const result =
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        prepareLineage({ newAttemptNumber: 3 }),
      );
    expect(result.success).toBe(false);
  });

  it("keeps Prepared attemptNumber compatible with Stage 3.2", () => {
    const parsed = RecoveryEvidencePrepareLineageV1Schema.parse(
      prepareLineage(),
    );
    expect(parsed.attemptNumber).toBe(parsed.newAttemptNumber);
    expect(parsed.attemptNumber).toBe(
      parsed.priorAttemptNumber + 1,
    );
    expect({
      readAttemptId: parsed.readAttemptId,
      attemptNumber: parsed.attemptNumber,
      attemptStatus: parsed.attemptStatus,
      recoveryOperationId: parsed.recoveryOperationId,
      priorAttemptId: parsed.priorAttemptId,
      interruptionEventId: parsed.interruptionEventId,
      newAttemptId: parsed.newAttemptId,
      fencingToken: parsed.fencingToken,
    }).toMatchObject({
      readAttemptId: "attempt-2",
      attemptNumber: 2,
      attemptStatus: "prepared",
      recoveryOperationId: RECOVERY_OPERATION_ID,
      priorAttemptId: "attempt-1",
      interruptionEventId: INTERRUPTION_EVENT_ID,
      newAttemptId: "attempt-2",
      fencingToken: 3,
    });
    expect(
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        prepareLineage({ attemptNumber: 3 }),
      ).success,
    ).toBe(false);
  });

  it("rejects incomplete Interrupted and Prepared references", () => {
    const missingInterruption = prepareLineage();
    delete missingInterruption.interruptionEventId;
    expect(
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        missingInterruption,
      ).success,
    ).toBe(false);

    const missingLeaseClaim = interruptLineage();
    delete missingLeaseClaim.leaseClaimEventId;
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        missingLeaseClaim,
      ).success,
    ).toBe(false);

    const missingNewAttempt = prepareLineage();
    delete missingNewAttempt.newAttemptId;
    expect(
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        missingNewAttempt,
      ).success,
    ).toBe(false);
  });

  it("rejects Prepare-only fields in Interrupted payloads", () => {
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({
          interruptionEventId: INTERRUPTION_EVENT_ID,
          newAttemptId: "attempt-2",
          newAttemptNumber: 2,
          pauseClearEventId: PAUSE_CLEAR_EVENT_ID,
        }),
      ).success,
    ).toBe(false);
  });

  it("enforces retryAssessment and resumeEligible consistency", () => {
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        pauseInterruptLineage(),
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        pauseInterruptLineage({
          retryAssessment: "not_evaluated",
          resumeEligible: false,
        }),
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage(),
      ).success,
    ).toBe(true);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({
          controlIntentKind: "cancel",
          controlIntentEventId: CANCEL_INTENT_EVENT_ID,
          retryAssessment: "not_evaluated",
          resumeEligible: false,
          interruptionCause: "cancel_intent",
          reasonCode: "CANCEL_INTERRUPTED",
        }),
      ).success,
    ).toBe(true);

    for (const invalid of [
      { retryAssessment: "passed", resumeEligible: false },
      { retryAssessment: "failed", resumeEligible: true },
      { retryAssessment: "not_evaluated", resumeEligible: true },
    ]) {
      expect(
        RecoveryEvidenceInterruptLineageV1Schema.safeParse(
          interruptLineage(invalid),
        ).success,
      ).toBe(false);
    }
  });

  it("enforces Retry Safety and Consistency combinations", () => {
    const validCases = [
      {
        retrySafety: "immutable",
        consistencyMode: "immutable_version",
        expectedResourceVersion: null,
        expectedEtag: null,
      },
      {
        retrySafety: "version_conditional",
        consistencyMode: "etag_or_resource_version",
        expectedResourceVersion: "7",
        expectedEtag: null,
      },
    ];
    for (const valid of validCases) {
      expect(
        RecoveryEvidenceInterruptLineageV1Schema.safeParse(
          interruptLineage(valid),
        ).success,
      ).toBe(true);
    }

    const invalidCases = [
      {
        retrySafety: "immutable",
        consistencyMode: "etag_or_resource_version",
        expectedResourceVersion: "7",
        expectedEtag: null,
      },
      {
        retrySafety: "immutable",
        consistencyMode: "immutable_version",
        expectedResourceVersion: "7",
        expectedEtag: null,
      },
      {
        retrySafety: "version_conditional",
        consistencyMode: "immutable_version",
        expectedResourceVersion: null,
        expectedEtag: null,
      },
      {
        retrySafety: "version_conditional",
        consistencyMode: "etag_or_resource_version",
        expectedResourceVersion: null,
        expectedEtag: null,
      },
    ];
    for (const invalid of invalidCases) {
      expect(
        RecoveryEvidenceInterruptLineageV1Schema.safeParse(
          interruptLineage(invalid),
        ).success,
      ).toBe(false);
    }
  });

  it("enforces Control Intent identity bindings", () => {
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({
          controlIntentKind: "cancel",
        }),
      ).success,
    ).toBe(false);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({
          controlIntentEventId: CANCEL_INTENT_EVENT_ID,
        }),
      ).success,
    ).toBe(false);
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        pauseInterruptLineage({
          pauseRequestEventId: CANCEL_INTENT_EVENT_ID,
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        pauseInterruptLineage({ pauseRequestEventId: undefined }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({
          pauseRequestEventId: PAUSE_REQUEST_EVENT_ID,
        }),
      ).success,
    ).toBe(false);

    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({
          controlIntentKind: "cancel",
          controlIntentEventId: CANCEL_INTENT_EVENT_ID,
          pauseRequestEventId: PAUSE_REQUEST_EVENT_ID,
          retryAssessment: "not_evaluated",
          resumeEligible: false,
        }),
      ).success,
    ).toBe(false);
  });

  it("rejects unknown payload fields", () => {
    expect(
      RecoveryEvidenceInterruptLineageV1Schema.safeParse(
        interruptLineage({ unexpected: true }),
      ).success,
    ).toBe(false);
    expect(
      RecoveryEvidencePrepareLineageV1Schema.safeParse(
        prepareLineage({ unexpected: true }),
      ).success,
    ).toBe(false);
  });

  it("rejects cross-phase root and identity inconsistency", () => {
    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage({
          recoveryOperationId: OTHER_RECOVERY_OPERATION_ID,
        }),
        interruptionEventId: INTERRUPTION_EVENT_ID,
      }),
    ).toThrow(/recoveryOperationId/i);

    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage({
          priorAttemptNumber: 2,
          attemptNumber: 3,
          newAttemptNumber: 3,
        }),
        interruptionEventId: INTERRUPTION_EVENT_ID,
      }),
    ).toThrow(/identity/i);

    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage({ taskId: "other-task" }),
        interruptionEventId: INTERRUPTION_EVENT_ID,
      }),
    ).toThrow(/identity/i);

    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage({ readToolRunId: "other-run" }),
        interruptionEventId: INTERRUPTION_EVENT_ID,
      }),
    ).toThrow(/identity/i);

    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: pauseInterruptLineage(),
        prepare: prepareLineage(),
        interruptionEventId: CANCEL_INTENT_EVENT_ID,
      }),
    ).toThrow(/Interrupted Event/i);
  });

  it("produces stable canonical payloads regardless of key order", () => {
    const lineage = interruptLineage();
    const reordered = Object.fromEntries(
      Object.entries(lineage).reverse(),
    );
    expect(canonicalRecoveryEvidenceLineageV1(reordered)).toBe(
      canonicalRecoveryEvidenceLineageV1(lineage),
    );
  });

  it("rejects a non-resumable interruption as a Prepare predecessor", () => {
    expect(() =>
      validateRecoveryEvidenceLineagePair({
        interrupt: interruptLineage(),
        prepare: prepareLineage(),
        interruptionEventId: INTERRUPTION_EVENT_ID,
      }),
    ).toThrow(/non-resumable/i);
  });
});
