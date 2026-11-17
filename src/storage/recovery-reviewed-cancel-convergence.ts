import type Database from "better-sqlite3";

import { resolveUnknownWriteSettlement } from "../recovery/recovery-unknown-write-settlement.js";
import type { EvidencePayloadStore } from "../recovery/evidence-payload-store.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskSnapshotReader } from "./task-snapshot.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import type { TaskSnapshot } from "./types.js";
import type { StorageWritePermit } from "./write-boundary.js";

/** Cancels queued descendants only after every Unknown Write has a verified final review. */
export function convergeReviewedCancelInCurrentTransaction(
  database: Database.Database,
  snapshot: TaskSnapshot,
  payloadStore: EvidencePayloadStore,
  permit: StorageWritePermit,
  now: string,
): boolean {
  if (!database.inTransaction || snapshot.task.status !== "waiting_review" ||
      snapshot.task.cancelRequestedAt === null ||
      snapshot.recoveryReviews.some((review) => ["pending", "unresolved"].includes(review.status)) ||
      snapshot.approvals.some((approval) => approval.status === "pending") ||
      snapshot.toolRuns.some((run) => ["running", "interrupted", "awaiting_approval"].includes(run.status)) ||
      snapshot.planSteps.some((step) => ["running", "interrupted", "awaiting_approval", "waiting_review"].includes(step.status)) ||
      snapshot.planSteps.some((step) => step.status === "queued" &&
        snapshot.toolRuns.some((run) => run.planStepId === step.id && run.status !== "queued"))) {
    return false;
  }
  const settlements = snapshot.toolRuns.filter((run) => run.mode === "write" && run.status === "unknown")
    .map((run) => resolveUnknownWriteSettlement(snapshot, run.id, payloadStore));
  if (settlements.some((value) => value === "open_unknown" || value === "state_inconsistent")) return false;

  const runs = new ToolRunRepository(database);
  const steps = new PlanStepRepository(database);
  const plans = new ExecutionPlanRepository(database);
  const events = new EventRepository(database, new SequenceAllocator(database));
  for (const step of snapshot.planSteps.filter((item) => item.status === "queued")) {
    for (const run of snapshot.toolRuns.filter((item) => item.planStepId === step.id)) {
      runs.transition(run.id, ["queued"], {
        expectedVersion: run.version, status: "cancelled", finishedAt: now, updatedAt: now,
      }, permit);
      events.append({ taskId: snapshot.task.id, traceId: snapshot.task.traceId,
        type: "tool.cancelled", entityType: "tool_run", entityId: run.id,
        payload: { reasonCode: "TASK_CANCELLED_AFTER_FINAL_REVIEW" } }, now, permit);
    }
    steps.updateStatusCas(step.id, "queued", step.version, "cancelled", now, permit);
    events.append({ taskId: snapshot.task.id, traceId: snapshot.task.traceId,
      type: "plan_step.cancelled", entityType: "plan_step", entityId: step.id,
      payload: { reasonCode: "TASK_CANCELLED_AFTER_FINAL_REVIEW" } }, now, permit);
  }
  const latest = new TaskSnapshotReader(database).load(snapshot.task.id);
  for (const plan of latest.executionPlans.filter((item) => item.status === "active")) {
    if (latest.planSteps.filter((step) => step.planId === plan.id)
      .some((step) => !["completed", "failed", "skipped", "cancelled"].includes(step.status))) {
      throw new Error("Reviewed cancellation did not converge all active plan steps.");
    }
    plans.updateStatusCas(plan.id, "active", plan.version, "cancelled", now, permit);
  }
  return true;
}
