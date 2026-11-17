import { AppError } from "../shared/errors.js";
import { resolveUnknownWriteSettlement } from "../recovery/recovery-unknown-write-settlement.js";
import type { EvidencePayloadStore } from "../recovery/evidence-payload-store.js";
import type { TaskSnapshot, ToolRunRecord } from "./types.js";

function blocked(code: string): never {
  throw new AppError({
    code,
    message: "The write cannot be admitted in the current execution state.",
    statusCode: 409,
    details: [],
  });
}

/** Runs only inside the immediate transaction which begins the ToolRun. */
export function assertMultiWriteBarrier(
  snapshot: TaskSnapshot,
  target: ToolRunRecord,
  payloadStore?: EvidencePayloadStore,
): void {
  if (target.mode !== "write" || target.taskId !== snapshot.task.id) {
    blocked("WRITE_BARRIER_TARGET_INCONSISTENT");
  }
  const active = snapshot.agentExecutionPlans.filter((plan) => plan.status === "active");
  if (active.length !== 1) blocked(active.length === 0 ? "WRITE_BARRIER_NO_ACTIVE_PLAN" : "WRITE_BARRIER_MULTIPLE_ACTIVE_PLANS");
  const currentPlan = active[0]!;
  const targetStep = snapshot.planSteps.find((step) => step.id === target.planStepId);
  if (targetStep?.planId !== currentPlan.id || targetStep.kind !== "write") {
    blocked("WRITE_BARRIER_TARGET_INCONSISTENT");
  }
  const order = (run: ToolRunRecord): readonly [number, number] => {
    const step = snapshot.planSteps.find((item) => item.id === run.planStepId);
    if (step === undefined || step.taskId !== snapshot.task.id || step.kind !== "write") {
      blocked("WRITE_BARRIER_ORDER_INCONSISTENT");
    }
    return [step.stepIndex, run.originalIndex];
  };
  const writes = snapshot.toolRuns.filter((run) => run.mode === "write");
  for (const run of writes) {
    const step = snapshot.planSteps.find((item) => item.id === run.planStepId);
    if (step === undefined) blocked("WRITE_BARRIER_ORDER_INCONSISTENT");
    if (step.planId !== currentPlan.id && run.status === "unknown") {
      const settlement = payloadStore === undefined
        ? "open_unknown"
        : resolveUnknownWriteSettlement(snapshot, run.id, payloadStore);
      if (settlement !== "resolved_success") blocked("WRITE_BARRIER_HISTORICAL_UNKNOWN");
    }
  }
  const currentWrites = writes.filter((run) =>
    snapshot.planSteps.some((step) => step.id === run.planStepId && step.planId === currentPlan.id));
  const positions = new Set<string>();
  for (const run of currentWrites) {
    const [stepIndex, originalIndex] = order(run);
    const key = `${stepIndex}:${originalIndex}`;
    if (positions.has(key)) blocked("WRITE_BARRIER_ORDER_INCONSISTENT");
    positions.add(key);
  }
  const [targetStepIndex, targetIndex] = order(target);
  for (const run of currentWrites) {
    if (run.id === target.id) continue;
    const [stepIndex, originalIndex] = order(run);
    const earlier = stepIndex < targetStepIndex ||
      (stepIndex === targetStepIndex && originalIndex < targetIndex);
    if (!earlier && run.status !== "queued") blocked("WRITE_BARRIER_LATER_WRITE_STARTED");
    if (!earlier) continue;
    if (run.status === "unknown") {
      const settlement = payloadStore === undefined
        ? "open_unknown"
        : resolveUnknownWriteSettlement(snapshot, run.id, payloadStore);
      if (settlement !== "resolved_success") blocked("WRITE_BARRIER_EARLIER_UNKNOWN");
    } else if (run.status !== "succeeded") {
      blocked("WRITE_BARRIER_EARLIER_WRITE_NOT_SUCCEEDED");
    }
  }
}
