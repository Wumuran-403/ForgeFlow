import type { TaskStatus } from "../storage/index.js";
import type { ReadToolResult } from "../scheduler/index.js";

export type RecoveryClassification =
  | "safe_to_resume"
  | "read_interrupted"
  | "write_outcome_unknown"
  | "model_call_interrupted"
  | "approval_pending"
  | "review_pending"
  | "pause_pending"
  | "cancel_pending"
  | "state_inconsistent";

export type RecoveryEntityType =
  | "task"
  | "model_call"
  | "plan_step"
  | "tool_run"
  | "approval"
  | "recovery_review"
  | "message";

export interface RecoveryFinding {
  readonly classification: RecoveryClassification;
  readonly code: string;
  readonly summary: string;
  readonly entityType: RecoveryEntityType;
  readonly entityId: string;
}

export interface RecoveryReport {
  readonly taskId: string;
  readonly classification: RecoveryClassification;
  readonly primaryClassification: RecoveryClassification;
  readonly findings: readonly RecoveryFinding[];
  readonly blockingReasons: readonly string[];
  readonly recommendedNextAction: string;
  readonly inspectedAt: string;
  readonly fencingToken: number;
}

export type RecoveryLeaseState = "missing" | "released" | "expired";

export interface RecoveryCandidate {
  readonly taskId: string;
  readonly status: TaskStatus;
  readonly traceId: string;
  readonly leaseState: RecoveryLeaseState;
  readonly fencingToken: number | null;
}

export interface RecoveryInspectionOwnership {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export interface ReadRecoveryResult {
  readonly taskId: string;
  readonly status: "completed" | "no_work";
  readonly report: RecoveryReport;
  readonly requeuedCount: number;
  readonly results: readonly ReadToolResult[];
}

export interface ReadRecoveryOptions {
  readonly signal?: AbortSignal;
}
