import { AppError } from "../shared/errors.js";
import {
  canTransitionPlanStepStatus,
  canTransitionToolRunStatus,
} from "./execution-state-machine.js";
import {
  ExecutionPlanPurposeSchema,
  ExecutionPlanStatusSchema,
  PlanStepKindSchema,
  PlanStepStatusSchema,
  RecoveryEvidenceReadAttemptStatusSchema,
  ToolRunStatusSchema,
  type ExecutionPlanPurpose,
  type ExecutionPlanStatus,
  type PlanStepKind,
  type PlanStepStatus,
  type RecoveryEvidenceReadAttemptStatus,
  type ToolRunStatus,
} from "./types.js";
import { z } from "zod";

export const RecoveryEvidenceTransitionTargetSchema = z.enum([
  "dispatching",
  "blocked_by_intent",
  "failed",
  "timed_out",
  "cancelled",
  "interrupted",
]);

export type RecoveryEvidenceTransitionTarget = z.infer<
  typeof RecoveryEvidenceTransitionTargetSchema
>;

export interface RecoveryEvidenceStateMatrixInput {
  readonly target: RecoveryEvidenceTransitionTarget;
  readonly attemptStatus: RecoveryEvidenceReadAttemptStatus;
  readonly toolRunStatus: ToolRunStatus;
  readonly planStepStatus: PlanStepStatus;
  readonly planStatus: ExecutionPlanStatus;
  readonly planPurpose: ExecutionPlanPurpose;
  readonly planStepKind: PlanStepKind;
}

export interface RecoveryEvidenceStateMatrixResult {
  readonly attemptStatus: RecoveryEvidenceReadAttemptStatus;
  readonly toolRunStatus: ToolRunStatus;
  readonly planStepStatus: PlanStepStatus;
  readonly planStatus: ExecutionPlanStatus;
  readonly attemptChanged: boolean;
  readonly requestLevelCancel: boolean;
}

const RecoveryEvidenceStateMatrixInputSchema = z
  .object({
    target: RecoveryEvidenceTransitionTargetSchema,
    attemptStatus: RecoveryEvidenceReadAttemptStatusSchema,
    toolRunStatus: ToolRunStatusSchema,
    planStepStatus: PlanStepStatusSchema,
    planStatus: ExecutionPlanStatusSchema,
    planPurpose: ExecutionPlanPurposeSchema,
    planStepKind: PlanStepKindSchema,
  })
  .strict();

export function resolveRecoveryEvidenceStateMatrix(
  input: RecoveryEvidenceStateMatrixInput,
): RecoveryEvidenceStateMatrixResult {
  const parsed = RecoveryEvidenceStateMatrixInputSchema.parse(input);

  if (
    parsed.planPurpose !== "recovery_evidence" ||
    parsed.planStepKind !== "read_batch"
  ) {
    throw invalidTransition();
  }

  switch (parsed.target) {
    case "dispatching":
      requireState(parsed.attemptStatus, ["prepared"]);
      requireState(parsed.planStatus, ["active"]);
      requireState(parsed.toolRunStatus, ["queued"]);
      requireState(parsed.planStepStatus, ["queued", "running"]);
      assertToolTransition(parsed.toolRunStatus, "running");
      if (parsed.planStepStatus === "queued") {
        assertPlanStepTransition(parsed.planStepStatus, "running");
      }
      return {
        attemptStatus: "dispatching",
        toolRunStatus: "running",
        planStepStatus: "running",
        planStatus: "active",
        attemptChanged: true,
        requestLevelCancel: false,
      };

    case "blocked_by_intent":
      requireState(parsed.attemptStatus, ["prepared"]);
      requireState(parsed.planStatus, ["active"]);
      requireState(parsed.toolRunStatus, ["queued"]);
      requireState(parsed.planStepStatus, ["queued", "running"]);
      return {
        attemptStatus: "blocked_by_intent",
        toolRunStatus: "queued",
        planStepStatus: parsed.planStepStatus,
        planStatus: "active",
        attemptChanged: true,
        requestLevelCancel: false,
      };

    case "failed":
      requireActiveExecution(parsed);
      assertToolTransition(parsed.toolRunStatus, "failed");
      assertPlanStepTransition(parsed.planStepStatus, "failed");
      return {
        attemptStatus: "failed",
        toolRunStatus: "failed",
        planStepStatus: "failed",
        planStatus: "failed",
        attemptChanged: true,
        requestLevelCancel: false,
      };

    case "timed_out":
      requireActiveExecution(parsed);
      assertToolTransition(parsed.toolRunStatus, "timed_out");
      assertPlanStepTransition(parsed.planStepStatus, "failed");
      return {
        attemptStatus: "timed_out",
        toolRunStatus: "timed_out",
        planStepStatus: "failed",
        planStatus: "failed",
        attemptChanged: true,
        requestLevelCancel: false,
      };

    case "interrupted":
      requireActiveExecution(parsed);
      assertToolTransition(parsed.toolRunStatus, "interrupted");
      assertPlanStepTransition(parsed.planStepStatus, "interrupted");
      return {
        attemptStatus: "interrupted",
        toolRunStatus: "interrupted",
        planStepStatus: "interrupted",
        planStatus: "active",
        attemptChanged: true,
        requestLevelCancel: false,
      };

    case "cancelled":
      return resolveCancel(parsed);
  }
}

function resolveCancel(
  input: z.output<typeof RecoveryEvidenceStateMatrixInputSchema>,
): RecoveryEvidenceStateMatrixResult {
  if (input.attemptStatus === "prepared") {
    requireState(input.planStatus, ["active"]);
    requireState(input.toolRunStatus, ["queued"]);
    requireState(input.planStepStatus, ["queued", "running"]);
    assertToolTransition(input.toolRunStatus, "cancelled");
    assertPlanStepTransition(input.planStepStatus, "cancelled");
    return {
      attemptStatus: "cancelled",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
      attemptChanged: true,
      requestLevelCancel: false,
    };
  }

  if (input.attemptStatus === "dispatching") {
    requireActiveExecution(input);
    assertToolTransition(input.toolRunStatus, "cancelled");
    assertPlanStepTransition(input.planStepStatus, "cancelled");
    return {
      attemptStatus: "cancelled",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
      attemptChanged: true,
      requestLevelCancel: false,
    };
  }

  if (input.attemptStatus === "blocked_by_intent") {
    requireState(input.planStatus, ["active"]);
    requireState(input.toolRunStatus, ["queued"]);
    requireState(input.planStepStatus, ["queued", "running"]);
    assertToolTransition(input.toolRunStatus, "cancelled");
    assertPlanStepTransition(input.planStepStatus, "cancelled");
    return {
      attemptStatus: "blocked_by_intent",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
      attemptChanged: false,
      requestLevelCancel: true,
    };
  }

  if (input.attemptStatus === "interrupted") {
    requireState(input.planStatus, ["active"]);
    requireState(input.toolRunStatus, ["interrupted"]);
    requireState(input.planStepStatus, ["interrupted"]);
    assertToolTransition(input.toolRunStatus, "cancelled");
    assertPlanStepTransition(input.planStepStatus, "cancelled");
    return {
      attemptStatus: "interrupted",
      toolRunStatus: "cancelled",
      planStepStatus: "cancelled",
      planStatus: "cancelled",
      attemptChanged: false,
      requestLevelCancel: true,
    };
  }

  throw invalidTransition();
}

function requireActiveExecution(input: {
  readonly attemptStatus: RecoveryEvidenceReadAttemptStatus;
  readonly toolRunStatus: ToolRunStatus;
  readonly planStepStatus: PlanStepStatus;
  readonly planStatus: ExecutionPlanStatus;
}): void {
  requireState(input.attemptStatus, ["dispatching"]);
  requireState(input.toolRunStatus, ["running"]);
  requireState(input.planStepStatus, ["running"]);
  requireState(input.planStatus, ["active"]);
}

function requireState<T extends string>(
  actual: T,
  allowed: readonly T[],
): void {
  if (!allowed.includes(actual)) {
    throw invalidTransition();
  }
}

function assertToolTransition(from: ToolRunStatus, to: ToolRunStatus): void {
  if (!canTransitionToolRunStatus("read", from, to)) {
    throw invalidTransition();
  }
}

function assertPlanStepTransition(
  from: PlanStepStatus,
  to: PlanStepStatus,
): void {
  if (!canTransitionPlanStepStatus(from, to)) {
    throw invalidTransition();
  }
}

function invalidTransition(): AppError {
  return new AppError({
    code: "RECOVERY_EVIDENCE_STATE_TRANSITION_INVALID",
    message: "Recovery evidence state transition is invalid.",
    statusCode: 409,
    details: [],
  });
}
