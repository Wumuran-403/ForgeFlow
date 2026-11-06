import { AppError } from "../shared/errors.js";
import type { TaskSnapshot } from "../storage/index.js";

export function assertSafeToStartPersistentRun(
  snapshot: TaskSnapshot,
): void {
  const recoveryRequired =
    snapshot.modelCalls.some((call) =>
      ["requested", "interrupted"].includes(call.status),
    ) ||
    snapshot.toolRuns.some((run) =>
      [
        "queued",
        "awaiting_approval",
        "running",
        "interrupted",
        "unknown",
      ].includes(run.status),
    ) ||
    snapshot.planSteps.some(
      (step) => step.status !== "completed" && step.status !== "skipped",
    ) ||
    snapshot.approvals.some((approval) => approval.status === "pending") ||
    snapshot.recoveryReviews.some((review) =>
      ["pending", "unresolved"].includes(review.status),
    );

  if (recoveryRequired) {
    throw new AppError({
      code: "PERSISTENT_RECOVERY_REQUIRED",
      message: "Task contains an incomplete execution boundary that requires recovery.",
      statusCode: 409,
      details: [],
    });
  }
}
