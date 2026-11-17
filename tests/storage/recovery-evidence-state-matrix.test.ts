import { describe, expect, it } from "vitest";

import {
  RecoveryEvidenceTransitionTargetSchema,
  resolveRecoveryEvidenceStateMatrix,
  type RecoveryEvidenceStateMatrixInput,
} from "../../src/storage/recovery-evidence-state-matrix.js";

const active = {
  toolRunStatus: "running",
  planStepStatus: "running",
  planStatus: "active",
  planPurpose: "recovery_evidence",
  planStepKind: "read_batch",
} as const;

describe("RecoveryEvidenceStateMatrix", () => {
  it.each([
    [
      "first dispatch",
      {
        target: "dispatching",
        attemptStatus: "prepared",
        toolRunStatus: "queued",
        planStepStatus: "queued",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
      {
        attemptStatus: "dispatching",
        toolRunStatus: "running",
        planStepStatus: "running",
        planStatus: "active",
      },
    ],
    [
      "retry dispatch",
      {
        target: "dispatching",
        attemptStatus: "prepared",
        toolRunStatus: "queued",
        planStepStatus: "running",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
      {
        attemptStatus: "dispatching",
        toolRunStatus: "running",
        planStepStatus: "running",
        planStatus: "active",
      },
    ],
    [
      "pause before dispatch",
      {
        target: "blocked_by_intent",
        attemptStatus: "prepared",
        toolRunStatus: "queued",
        planStepStatus: "queued",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
      {
        attemptStatus: "blocked_by_intent",
        toolRunStatus: "queued",
        planStepStatus: "queued",
        planStatus: "active",
      },
    ],
    [
      "pause before retry dispatch",
      {
        target: "blocked_by_intent",
        attemptStatus: "prepared",
        toolRunStatus: "queued",
        planStepStatus: "running",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
      {
        attemptStatus: "blocked_by_intent",
        toolRunStatus: "queued",
        planStepStatus: "running",
        planStatus: "active",
      },
    ],
    [
      "failure",
      {
        target: "failed",
        attemptStatus: "dispatching",
        ...active,
      },
      {
        attemptStatus: "failed",
        toolRunStatus: "failed",
        planStepStatus: "failed",
        planStatus: "failed",
      },
    ],
    [
      "timeout",
      {
        target: "timed_out",
        attemptStatus: "dispatching",
        ...active,
      },
      {
        attemptStatus: "timed_out",
        toolRunStatus: "timed_out",
        planStepStatus: "failed",
        planStatus: "failed",
      },
    ],
    [
      "interruption",
      {
        target: "interrupted",
        attemptStatus: "dispatching",
        ...active,
      },
      {
        attemptStatus: "interrupted",
        toolRunStatus: "interrupted",
        planStepStatus: "interrupted",
        planStatus: "active",
      },
    ],
    [
      "active cancel",
      {
        target: "cancelled",
        attemptStatus: "dispatching",
        ...active,
      },
      {
        attemptStatus: "cancelled",
        toolRunStatus: "cancelled",
        planStepStatus: "cancelled",
        planStatus: "cancelled",
      },
    ],
    [
      "blocked request cancel",
      {
        target: "cancelled",
        attemptStatus: "blocked_by_intent",
        toolRunStatus: "queued",
        planStepStatus: "running",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
      {
        attemptStatus: "blocked_by_intent",
        toolRunStatus: "cancelled",
        planStepStatus: "cancelled",
        planStatus: "cancelled",
      },
    ],
    [
      "interrupted request cancel",
      {
        target: "cancelled",
        attemptStatus: "interrupted",
        toolRunStatus: "interrupted",
        planStepStatus: "interrupted",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
      {
        attemptStatus: "interrupted",
        toolRunStatus: "cancelled",
        planStepStatus: "cancelled",
        planStatus: "cancelled",
      },
    ],
  ] as const)(
    "allows %s",
    (_label, input, expected) => {
      expect(
        resolveRecoveryEvidenceStateMatrix(
          input as RecoveryEvidenceStateMatrixInput,
        ),
      ).toMatchObject(expected);
    },
  );

  it.each([
    [
      "terminal attempt reuse",
      {
        target: "dispatching",
        attemptStatus: "failed",
        toolRunStatus: "queued",
        planStepStatus: "queued",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
    ],
    [
      "agent plan",
      {
        target: "dispatching",
        attemptStatus: "prepared",
        toolRunStatus: "queued",
        planStepStatus: "queued",
        planStatus: "active",
        planPurpose: "agent",
        planStepKind: "read_batch",
      },
    ],
    [
      "write plan step",
      {
        target: "dispatching",
        attemptStatus: "prepared",
        toolRunStatus: "queued",
        planStepStatus: "queued",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "write",
      },
    ],
    [
      "inconsistent active execution",
      {
        target: "failed",
        attemptStatus: "dispatching",
        toolRunStatus: "queued",
        planStepStatus: "running",
        planStatus: "active",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
    ],
    [
      "cancel terminal attempt",
      {
        target: "cancelled",
        attemptStatus: "timed_out",
        toolRunStatus: "timed_out",
        planStepStatus: "failed",
        planStatus: "failed",
        planPurpose: "recovery_evidence",
        planStepKind: "read_batch",
      },
    ],
  ] as const)(
    "rejects %s",
    (_label, input) => {
      expect(() =>
        resolveRecoveryEvidenceStateMatrix(
          input as RecoveryEvidenceStateMatrixInput,
        ),
      ).toThrow(/state transition is invalid/i);
    },
  );

  const terminalAttemptStatuses = [
    "failed",
    "timed_out",
    "cancelled",
    "completed",
  ] as const;
  it.each(
    RecoveryEvidenceTransitionTargetSchema.options.flatMap((target) =>
      terminalAttemptStatuses.map((attemptStatus) => [
        target,
        attemptStatus,
      ] as const),
    ),
  )(
    "rejects target %s from terminal Attempt %s",
    (target, attemptStatus) => {
      expect(() =>
        resolveRecoveryEvidenceStateMatrix({
          target,
          attemptStatus,
          toolRunStatus: "running",
          planStepStatus: "running",
          planStatus: "active",
          planPurpose: "recovery_evidence",
          planStepKind: "read_batch",
        }),
      ).toThrow(/state transition is invalid/i);
    },
  );
});
