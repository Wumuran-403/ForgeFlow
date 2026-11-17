import { AppError } from "../shared/errors.js";
import { TaskSnapshotReader } from "../storage/task-snapshot.js";
import type { ForgeFlowDatabase } from "../storage/index.js";
import type { EvidencePayloadStore } from "./evidence-payload-store.js";
import { assertFinalDecisionAuthorization, readFinalDecisionAuthorizationClaims,
  type FinalDecisionAuthorization } from "./recovery-review-final-decision-authorization.js";
import { computeFinalDecisionIdentity, FinalDecisionInputSchema,
  type FinalDecisionInput } from "./recovery-review-final-decision-service.js";
import { resolveUnknownWriteSettlement } from "./recovery-unknown-write-settlement.js";

export class RecoveryReviewTerminalReplayService {
  private readonly snapshots: TaskSnapshotReader;
  constructor(database: ForgeFlowDatabase, private readonly payloadStore: EvidencePayloadStore) {
    this.snapshots = new TaskSnapshotReader(database);
  }

  replayInternal(input: FinalDecisionInput, authorization: FinalDecisionAuthorization) {
    const parsed = FinalDecisionInputSchema.parse(input);
    const actor = readFinalDecisionAuthorizationClaims(authorization, "read_replay");
    const identity = computeFinalDecisionIdentity(parsed, actor.actorId, actor.actorType);
    assertFinalDecisionAuthorization(authorization, { ...identity, access: "read_replay" });
    const snapshot = this.snapshots.load(parsed.taskId);
    if (!["completed", "failed", "cancelled"].includes(snapshot.task.status)) throw denied();
    const operation = snapshot.recoveryReviewOperations.find((item) => item.requestKey === identity.requestKey);
    const event = snapshot.events.find((item) => item.id === operation?.appliedEventId);
    if (operation === undefined || operation.taskId !== parsed.taskId || operation.reviewId !== parsed.reviewId ||
        operation.operation !== parsed.operation || operation.actorId !== actor.actorId ||
        operation.operationPayloadDigest !== identity.operationPayloadDigest ||
        operation.expectedDecisionVersion !== parsed.expectedDecisionVersion ||
        event?.type !== "recovery.review.final_decision" || event.payload.actorType !== actor.actorType ||
        event.payload.sourceContractDigest !== parsed.sourceContractDigest ||
        event.payload.evidenceSubmissionId !== parsed.evidenceSubmissionId ||
        event.payload.verificationCheckId !== parsed.verificationCheckId ||
        event.payload.verificationId !== parsed.verificationId ||
        resolveUnknownWriteSettlement(snapshot, parsed.originalUnknownWriteToolRunId, this.payloadStore) !==
          (parsed.operation === "confirm_succeeded" ? "resolved_success" : "resolved_not_executed")) throw denied();
    return { state: "replayed" as const, operation, snapshot };
  }
}

function denied(): AppError {
  return new AppError({ code: "RECOVERY_REVIEW_TERMINAL_REPLAY_CONFLICT",
    message: "Terminal recovery review replay is unavailable.", statusCode: 409, details: [] });
}
