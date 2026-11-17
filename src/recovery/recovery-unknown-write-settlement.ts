import { z } from "zod";

import type { TaskSnapshot } from "../storage/types.js";
import type { EvidencePayloadStore } from "./evidence-payload-store.js";
import { computeRecoverySourceContractDigest, validateRecoverySourceContractV1 } from "./recovery-source-contract.js";

export type UnknownWriteSettlement = "open_unknown" | "resolved_success" |
  "resolved_not_executed" | "state_inconsistent";

export function resolveUnknownWriteSettlement(snapshot: TaskSnapshot, toolRunId: string,
  payloadStore: EvidencePayloadStore): UnknownWriteSettlement {
  const run = snapshot.toolRuns.find((item) => item.id === toolRunId);
  if (run?.status !== "unknown" || run.mode !== "write" || run.taskId !== snapshot.task.id) return "state_inconsistent";
  const review = snapshot.recoveryReviews.find((item) => item.toolRunId === run.id);
  const step = snapshot.planSteps.find((item) => item.id === run.planStepId);
  if (step === undefined) return "state_inconsistent";
  if (review === undefined || ["pending", "unresolved"].includes(review.status)) {
    return step.status === "waiting_review" ? "open_unknown" : "state_inconsistent";
  }
  const operationType = review.status === "confirmed_succeeded" ? "confirm_succeeded" : "confirm_not_executed";
  const operations = snapshot.recoveryReviewOperations.filter((item) =>
    item.reviewId === review.id && item.operation === operationType && item.resultingDecisionVersion === review.decisionVersion);
  if (operations.length !== 1) return "state_inconsistent";
  const operation = operations[0]!;
  const event = snapshot.events.find((item) => item.id === operation.appliedEventId);
  const payload = event?.payload as Record<string, unknown> | undefined;
  if (operation.status !== "applied" || operation.taskId !== snapshot.task.id ||
      operation.expectedDecisionVersion + 1 !== review.decisionVersion ||
      event?.type !== "recovery.review.final_decision" || event.entityId !== review.id ||
      payload?.operationId !== operation.id || payload.requestKey !== operation.requestKey ||
      payload.reviewId !== review.id || payload.originalUnknownWriteToolRunId !== run.id ||
      payload.decision !== review.status || payload.actorId !== operation.actorId ||
      !["human_reviewer", "host_verifier"].includes(String(payload.actorType)) ||
      payload.operationPayloadDigest !== operation.operationPayloadDigest ||
      payload.decisionVersion !== operation.resultingDecisionVersion ||
      review.actorId !== (payload.actorType === "human_reviewer" ? operation.actorId : null) ||
      review.verifierId !== (payload.actorType === "host_verifier" ? operation.actorId : null)) return "state_inconsistent";
  const evidence = snapshot.recoveryEvidenceSubmissions.find((item) => item.id === payload.evidenceSubmissionId);
  if (evidence === undefined || evidence.taskId !== snapshot.task.id || evidence.reviewId !== review.id ||
      evidence.toolRunId !== run.id || evidence.envelopeDigest !== review.evidenceEnvelopeDigest ||
      evidence.payloadDigest !== review.evidencePayloadDigest || evidence.evidenceRef !== review.evidenceRef ||
      operation.evidenceEnvelopeDigest !== evidence.envelopeDigest ||
      (evidence.sourceType === "manual_review" ? evidence.actorId : evidence.verifierId) !== operation.actorId ||
      review.sourceType !== evidence.sourceType) return "state_inconsistent";
  const submissionOperation = snapshot.recoveryReviewOperations.find((item) => item.id === evidence.operationId);
  const submissionEvent = snapshot.events.find((item) => item.id === evidence.appliedEventId);
  if (submissionOperation?.operation !== "submit_evidence" ||
      submissionOperation.requestKey !== evidence.requestKey ||
      submissionOperation.appliedEventId !== submissionEvent?.id ||
      submissionEvent.type !== "recovery.evidence.submitted" ||
      submissionEvent.payload.evidenceSubmissionId !== evidence.id ||
      submissionEvent.payload.envelopeDigest !== evidence.envelopeDigest) return "state_inconsistent";
  const check = snapshot.recoveryEvidenceVerificationChecks.find((item) => item.verificationCheckId === payload.verificationCheckId);
  const verification = snapshot.recoveryEvidenceVerifications.find((item) => item.id === payload.verificationId);
  if (check === undefined || verification === undefined ||
      check.taskId !== snapshot.task.id || check.reviewId !== review.id || check.originalToolRunId !== run.id ||
      check.evidenceSubmissionId !== evidence.id || verification.verificationCheckId !== check.verificationCheckId ||
      verification.taskId !== snapshot.task.id || verification.reviewId !== review.id ||
      verification.originalToolRunId !== run.id || verification.evidenceSubmissionId !== evidence.id ||
      verification.availabilityStatus !== "available" || verification.integrityStatus !== "matched" ||
      verification.verificationStatus === "failed" || verification.expectedPayloadDigest !== evidence.payloadDigest ||
      verification.observedPayloadDigest !== evidence.payloadDigest ||
      check.expectedPayloadDigest !== evidence.payloadDigest ||
      check.verifierId !== verification.verifierId ||
      check.verifierConfigDigest !== verification.verifierConfigDigest ||
      check.requestKey !== verification.requestKey ||
      !snapshot.events.some((item) => item.id === verification.availabilityEventId &&
        item.type === "recovery.evidence.availability_checked") ||
      (evidence.sourceType === "system_verification" &&
        (verification.verificationStatus !== "passed" || verification.authenticityStatus !== "system_verified" ||
         verification.readbackResultProvenance !== "controlled_runtime_read")) ||
      (evidence.sourceType === "manual_review" && verification.authenticityStatus !== "manual_attested")) {
    return "state_inconsistent";
  }
  try {
    if (evidence.payloadStoreRef === null) return "state_inconsistent";
    payloadStore.read(evidence.payloadStoreRef, evidence.payloadDigest);
    if (review.status === "confirmed_not_executed") {
      if (payload.sourceContractDigest !== evidence.payloadDigest ||
          evidence.outcome !== "observed_not_executed") return "state_inconsistent";
      const bytes = payloadStore.read(evidence.payloadStoreRef, evidence.payloadDigest);
      const contract = validateRecoverySourceContractV1(z.json().parse(JSON.parse(Buffer.from(bytes).toString("utf8"))), {
        taskId: snapshot.task.id, reviewId: review.id, originalUnknownWriteToolRunId: run.id,
        sourceContractAuthority: payload.actorType === "human_reviewer" ? "manual_attested" : "system_verified",
      });
      if (computeRecoverySourceContractDigest(contract) !== evidence.payloadDigest ||
          contract.sourceType !== evidence.sourceType || contract.sourceObservedAt !== evidence.sourceObservedAt ||
          contract.targetResourceIdentity.resourceRef !== evidence.resourceRef ||
          contract.queryScope.selector !== evidence.resourceRef ||
          (contract.sourceContractAuthority === "manual_attested" && contract.manualAttestation.actorId !== operation.actorId) ||
          (contract.sourceContractAuthority === "manual_attested" && contract.result !== verification.verificationStatus) ||
          (contract.sourceContractAuthority === "system_verified" &&
            (contract.verifierBinding.verifierId !== verification.verifierId ||
             contract.verifierBinding.verifierConfigDigest !== verification.verifierConfigDigest ||
             contract.verifierBinding.verificationId !== verification.id ||
             contract.payloadDigest !== snapshot.recoveryEvidenceReads.find((item) => item.id === verification.evidenceReadId)?.resultPayloadDigest)) ||
          step.status !== "failed") return "state_inconsistent";
      const downstream = snapshot.planSteps.filter((item) => item.planId === step.planId && item.stepIndex > step.stepIndex);
      if (downstream.some((item) => item.status !== "skipped" ||
          snapshot.toolRuns.some((tool) => tool.planStepId === item.id && tool.status !== "skipped") ||
          !snapshot.events.some((audit) => audit.type === "plan_step.skipped" && audit.entityId === item.id &&
            audit.payload.operationId === operation.id && audit.payload.upstreamDecisionEventId === event.id &&
            audit.payload.requestKey === operation.requestKey) ||
          snapshot.toolRuns.some((tool) => tool.planStepId === item.id &&
            !snapshot.events.some((audit) => audit.type === "tool.skipped" && audit.entityId === tool.id &&
              audit.payload.operationId === operation.id && audit.payload.upstreamDecisionEventId === event.id &&
              audit.payload.requestKey === operation.requestKey)))) return "state_inconsistent";
      return "resolved_not_executed";
    }
    if (payload.sourceContractDigest !== null || evidence.outcome !== "observed_succeeded" ||
        step.status !== "completed") return "state_inconsistent";
    return "resolved_success";
  } catch {
    return "state_inconsistent";
  }
}
