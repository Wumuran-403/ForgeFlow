import type { ToolRegistry } from "../tools/registry.js";
import {
  computeCanonicalInputHash,
  computeToolInputSchemaHash,
} from "../tools/fingerprint.js";
import type {
  ApprovalRecord,
  RecoveryReviewRecord,
  TaskSnapshot,
  ToolRunRecord,
} from "../storage/index.js";
import type {
  RecoveryClassification,
  RecoveryFinding,
  RecoveryReport,
} from "./recovery-types.js";

const CLASSIFICATION_PRIORITY: readonly RecoveryClassification[] = [
  "state_inconsistent",
  "cancel_pending",
  "write_outcome_unknown",
  "review_pending",
  "approval_pending",
  "pause_pending",
  "model_call_interrupted",
  "read_interrupted",
  "safe_to_resume",
];

const RECOMMENDED_ACTIONS: Record<RecoveryClassification, string> = {
  state_inconsistent: "manual_inspection",
  cancel_pending: "complete_cancel_flow",
  write_outcome_unknown: "manual_write_review",
  review_pending: "continue_recovery_review",
  approval_pending: "wait_for_approval",
  pause_pending: "complete_pause_flow",
  model_call_interrupted: "rebuild_model_request",
  read_interrupted: "retry_or_reconcile_read",
  safe_to_resume: "eligible_for_resume",
};

export function selectPrimaryRecoveryClassification(
  findings: readonly RecoveryFinding[],
): RecoveryClassification {
  if (findings.length === 0) {
    return "safe_to_resume";
  }
  const present = new Set(findings.map((finding) => finding.classification));
  return (
    CLASSIFICATION_PRIORITY.find((classification) =>
      present.has(classification),
    ) ?? "state_inconsistent"
  );
}

export interface RecoveryClassifierOptions {
  readonly registry?: ToolRegistry;
}

export class RecoveryClassifier {
  private readonly registry: ToolRegistry | undefined;

  constructor(options: RecoveryClassifierOptions = {}) {
    this.registry = options.registry;
  }

  classify(
    snapshot: TaskSnapshot,
    input: {
      readonly fencingToken: number;
      readonly inspectedAt: string;
    },
  ): RecoveryReport {
    const findings = collectFindings(snapshot, this.registry);
    const primaryClassification =
      selectPrimaryRecoveryClassification(findings);
    const blockingReasons =
      primaryClassification === "safe_to_resume"
        ? []
        : [
            ...new Set(
              findings
                .filter(
                  (finding) =>
                    finding.classification === primaryClassification,
                )
                .map((finding) => finding.code),
            ),
          ];

    return {
      taskId: snapshot.task.id,
      classification: primaryClassification,
      primaryClassification,
      findings,
      blockingReasons,
      recommendedNextAction:
        RECOMMENDED_ACTIONS[primaryClassification],
      inspectedAt: input.inspectedAt,
      fencingToken: input.fencingToken,
    };
  }
}

function collectFindings(
  snapshot: TaskSnapshot,
  registry: ToolRegistry | undefined,
): readonly RecoveryFinding[] {
  const findings: RecoveryFinding[] = [];
  const add = (
    classification: RecoveryClassification,
    code: string,
    summary: string,
    entityType: RecoveryFinding["entityType"],
    entityId: string,
  ): void => {
    findings.push({
      classification,
      code,
      summary,
      entityType,
      entityId,
    });
  };

  if (snapshot.task.cancelRequestedAt !== null) {
    add(
      "cancel_pending",
      "CANCEL_INTENT_PRESENT",
      "Task has a persisted cancel intent.",
      "task",
      snapshot.task.id,
    );
  }
  if (snapshot.task.status === "cancel_requested") {
    add(
      "cancel_pending",
      "TASK_CANCEL_REQUESTED",
      "Task is waiting for cancellation cleanup.",
      "task",
      snapshot.task.id,
    );
  }
  if (
    snapshot.task.status === "pause_requested" ||
    snapshot.task.pauseRequestedAt !== null
  ) {
    add(
      "pause_pending",
      "PAUSE_INTENT_PRESENT",
      "Task has a pending pause intent.",
      "task",
      snapshot.task.id,
    );
  }

  for (const modelCall of snapshot.modelCalls) {
    if (modelCall.status === "requested") {
      add(
        "model_call_interrupted",
        "MODEL_CALL_REQUESTED",
        "A requested Model Call has no persisted response.",
        "model_call",
        modelCall.id,
      );
    } else if (modelCall.status === "interrupted") {
      add(
        "model_call_interrupted",
        "MODEL_CALL_INTERRUPTED",
        "A previous Model Call was interrupted.",
        "model_call",
        modelCall.id,
      );
    }
  }

  const planStepById = new Map(
    snapshot.planSteps.map((step) => [step.id, step]),
  );
  const toolRunsByStep = new Map<string, ToolRunRecord[]>();
  const toolRunById = new Map(
    snapshot.toolRuns.map((run) => [run.id, run]),
  );
  const approvalByToolRun = new Map(
    snapshot.approvals.map((approval) => [
      approval.toolRunId,
      approval,
    ]),
  );
  const recoveryReviewByToolRun = new Map(
    snapshot.recoveryReviews.map((review) => [
      review.toolRunId,
      review,
    ]),
  );
  for (const toolRun of snapshot.toolRuns) {
    const list = toolRunsByStep.get(toolRun.planStepId) ?? [];
    list.push(toolRun);
    toolRunsByStep.set(toolRun.planStepId, list);
  }

  for (const step of snapshot.planSteps) {
    const relatedRuns = toolRunsByStep.get(step.id) ?? [];
    if (
      (step.kind === "read_batch" || step.kind === "write") &&
      relatedRuns.length === 0
    ) {
      add(
        "state_inconsistent",
        "PLAN_STEP_WITHOUT_TOOL_RUN",
        "A tool PlanStep has no persisted ToolRun.",
        "plan_step",
        step.id,
      );
    }
    if (
      step.kind === "read_batch" &&
      relatedRuns.some((run) => run.mode !== "read")
    ) {
      add(
        "state_inconsistent",
        "PLAN_STEP_MODE_MISMATCH",
        "Read PlanStep contains a non-read ToolRun.",
        "plan_step",
        step.id,
      );
    }
    if (
      step.kind === "write" &&
      relatedRuns.some((run) => run.mode !== "write")
    ) {
      add(
        "state_inconsistent",
        "PLAN_STEP_MODE_MISMATCH",
        "Write PlanStep contains a non-write ToolRun.",
        "plan_step",
        step.id,
      );
    }
    if (
      step.status === "completed" &&
      relatedRuns.some((run) =>
        ["queued", "awaiting_approval", "running", "interrupted"].includes(
          run.status,
        ),
      )
    ) {
      add(
        "state_inconsistent",
        "COMPLETED_STEP_WITH_ACTIVE_RUN",
        "Completed PlanStep contains an active ToolRun.",
        "plan_step",
        step.id,
      );
    }
    if (step.status === "interrupted") {
      add(
        step.kind === "write"
          ? "write_outcome_unknown"
          : "read_interrupted",
        "PLAN_STEP_INTERRUPTED",
        "PlanStep was interrupted before completion.",
        "plan_step",
        step.id,
      );
    }
    if (step.status === "waiting_review") {
      add(
        "review_pending",
        "PLAN_STEP_WAITING_REVIEW",
        "PlanStep is waiting for recovery review.",
        "plan_step",
        step.id,
      );
    }
    const terminalToolStatuses = new Set([
      "succeeded",
      "failed",
      "timed_out",
      "cancelled",
      "skipped",
    ]);
    const nonTerminalStepStatuses = new Set([
      "queued",
      "running",
      "interrupted",
    ]);
    if (
      nonTerminalStepStatuses.has(step.status) &&
      relatedRuns.length > 0 &&
      relatedRuns.every((run) => terminalToolStatuses.has(run.status)) &&
      !relatedRuns.some(
        (run) =>
          approvalByToolRun.has(run.id) ||
          recoveryReviewByToolRun.has(run.id),
      )
    ) {
      add(
        "state_inconsistent",
        "NON_TERMINAL_STEP_WITH_TERMINAL_RUNS",
        "Non-terminal PlanStep has no active ToolRuns.",
        "plan_step",
        step.id,
      );
    }
  }

  for (const run of snapshot.toolRuns) {
    const step = planStepById.get(run.planStepId);
    if (step === undefined) {
      add(
        "state_inconsistent",
        "TOOL_RUN_ORPHANED",
        "ToolRun references a missing PlanStep.",
        "tool_run",
        run.id,
      );
      continue;
    }
    if (
      (run.mode === "read" && step.kind !== "read_batch") ||
      (run.mode === "write" && step.kind !== "write")
    ) {
      add(
        "state_inconsistent",
        "TOOL_RUN_MODE_MISMATCH",
        "ToolRun mode does not match its PlanStep kind.",
        "tool_run",
        run.id,
      );
    }
    if (registry !== undefined) {
      checkToolDefinition(run, registry, add);
    }
    if (run.mode === "read") {
      if (run.status === "running" || run.status === "interrupted") {
        add(
          "read_interrupted",
          run.status === "running"
            ? "READ_RUN_LEFT_RUNNING"
            : "READ_RUN_INTERRUPTED",
          "Read ToolRun did not reach a final result.",
          "tool_run",
          run.id,
        );
      } else if (run.status === "queued") {
        add(
          "safe_to_resume",
          "QUEUED_READ_NOT_STARTED",
          "Queued read has not started and may be considered by later recovery steps.",
          "tool_run",
          run.id,
        );
      }
      if (run.status === "unknown") {
        add(
          "state_inconsistent",
          "READ_RUN_UNKNOWN",
          "Read ToolRun cannot use the unknown state.",
          "tool_run",
          run.id,
        );
      }
    } else {
      if (run.status === "running" || run.status === "unknown") {
        add(
          "write_outcome_unknown",
          run.status === "running"
            ? "WRITE_RUN_LEFT_RUNNING"
            : "WRITE_RUN_UNKNOWN",
          "Write outcome is unknown and must not be retried automatically.",
          "tool_run",
          run.id,
        );
      } else if (run.status === "queued") {
        if (run.requiresApproval) {
          const approval = approvalByToolRun.get(run.id);
          if (approval?.status === "pending") {
            add(
              "approval_pending",
              "QUEUED_WRITE_APPROVAL_PENDING",
              "Queued write is waiting for approval.",
              "tool_run",
              run.id,
            );
          } else if (approval?.status === "approved") {
            add(
              "safe_to_resume",
              "QUEUED_WRITE_APPROVED_NOT_STARTED",
              "Queued write is approved but has not started.",
              "tool_run",
              run.id,
            );
          } else if (
            approval?.status === "rejected" ||
            approval?.status === "expired" ||
            approval?.status === "cancelled"
          ) {
            add(
              "state_inconsistent",
              "QUEUED_WRITE_APPROVAL_INVALID",
              "Queued write has a terminal non-approved Approval.",
              "tool_run",
              run.id,
            );
          } else {
            add(
              "approval_pending",
              "QUEUED_WRITE_APPROVAL_PENDING",
              "Queued write still requires an approval decision.",
              "tool_run",
              run.id,
            );
          }
        } else {
          add(
            "safe_to_resume",
            "QUEUED_WRITE_NOT_STARTED",
            "Queued write has not started and requires no approval.",
            "tool_run",
            run.id,
          );
        }
      } else if (run.status === "awaiting_approval") {
        add(
          "approval_pending",
          "WRITE_RUN_AWAITING_APPROVAL",
          "Write is waiting for approval.",
          "tool_run",
          run.id,
        );
      }
    }
  }

  for (const approval of snapshot.approvals) {
    checkApproval(approval, toolRunById, add);
    if (approval.status === "pending") {
      add(
        "approval_pending",
        "APPROVAL_PENDING",
        "A pending Approval must be resolved before normal execution.",
        "approval",
        approval.id,
      );
    }
  }

  for (const review of snapshot.recoveryReviews) {
    checkRecoveryReview(review, toolRunById, add);
    if (review.status === "pending" || review.status === "unresolved") {
      add(
        "review_pending",
        "RECOVERY_REVIEW_ACTIVE",
        "An active RecoveryReview blocks normal execution.",
        "recovery_review",
        review.id,
      );
    }
  }

  const assistantToolCallIds = new Set<string>();
  const toolMessageCountByTaskAndCallId = new Map<string, number>();
  for (const message of snapshot.messages) {
    if (message.role === "assistant") {
      for (const toolCall of message.toolCalls ?? []) {
        assistantToolCallIds.add(toolCall.id);
      }
    } else if (
      message.role === "tool" &&
      message.toolCallId !== null &&
      !assistantToolCallIds.has(message.toolCallId)
    ) {
      add(
        "state_inconsistent",
        "TOOL_MESSAGE_WITHOUT_CALL",
        "Tool Message references a missing assistant Tool Call.",
        "message",
        message.id,
      );
    }
    if (message.role === "tool" && message.toolCallId !== null) {
      if (message.taskId !== snapshot.task.id) {
        add(
          "state_inconsistent",
          "TOOL_MESSAGE_TASK_MISMATCH",
          "Tool Message belongs to a different Task.",
          "message",
          message.id,
        );
        continue;
      }
      const key = `${message.taskId}\u0000${message.toolCallId}`;
      toolMessageCountByTaskAndCallId.set(
        key,
        (toolMessageCountByTaskAndCallId.get(key) ?? 0) + 1,
      );
    }
  }

  const terminalStatusesRequiringMessage = new Set([
    "succeeded",
    "failed",
    "timed_out",
    "cancelled",
    "skipped",
  ]);
  for (const run of snapshot.toolRuns) {
    if (terminalStatusesRequiringMessage.has(run.status)) {
      const key = `${run.taskId}\u0000${run.toolCallId}`;
      const messageCount =
        toolMessageCountByTaskAndCallId.get(key) ?? 0;
      if (messageCount !== 1) {
        add(
          "state_inconsistent",
          run.status === "succeeded"
            ? "SUCCEEDED_TOOL_RESULT_MESSAGE_INVALID"
            : "TERMINAL_TOOL_RESULT_MESSAGE_INVALID",
          "Terminal ToolRun must have exactly one Tool Message.",
          "tool_run",
          run.id,
        );
      }
    }
  }

  if (
    snapshot.task.status === "waiting_approval" &&
    !snapshot.approvals.some((approval) =>
      ["pending", "approved"].includes(approval.status),
    )
  ) {
    add(
      "state_inconsistent",
      "WAITING_APPROVAL_WITHOUT_APPROVAL",
      "Task is waiting for approval but has no pending Approval.",
      "task",
      snapshot.task.id,
    );
  }
  if (
    snapshot.task.status === "waiting_review" &&
    !snapshot.recoveryReviews.some((review) =>
      ["pending", "unresolved"].includes(review.status),
    ) &&
    !snapshot.toolRuns.some(
      (run) => run.mode === "write" && run.status === "unknown",
    )
  ) {
    add(
      "state_inconsistent",
      "WAITING_REVIEW_WITHOUT_REVIEW",
      "Task is waiting for review but has no active RecoveryReview.",
      "task",
      snapshot.task.id,
    );
  }

  return findings;
}

function checkToolDefinition(
  run: ToolRunRecord,
  registry: ToolRegistry,
  add: (
    classification: RecoveryClassification,
    code: string,
    summary: string,
    entityType: RecoveryFinding["entityType"],
    entityId: string,
  ) => void,
): void {
  try {
    const tool = registry.get(run.toolName);
    let schemaMatches = true;
    try {
      schemaMatches =
        computeToolInputSchemaHash(tool.inputSchema) ===
        run.inputSchemaHash;
    } catch {
      schemaMatches = false;
    }
    const canonicalMatches =
      computeCanonicalInputHash(run.input) === run.canonicalInputHash;
    if (
      tool.version !== run.toolVersion ||
      tool.mode !== run.mode ||
      tool.requiresApproval !== run.requiresApproval ||
      !schemaMatches ||
      !canonicalMatches
    ) {
      add(
        "state_inconsistent",
        "TOOL_DEFINITION_CHANGED",
        "Persisted ToolRun definition no longer matches the current tool.",
        "tool_run",
        run.id,
      );
    }
  } catch {
    add(
      "state_inconsistent",
      "TOOL_NOT_REGISTERED",
      "Persisted ToolRun references a tool that is not registered.",
      "tool_run",
      run.id,
    );
  }
}

function checkApproval(
  approval: ApprovalRecord,
  toolRunById: ReadonlyMap<string, ToolRunRecord>,
  add: (
    classification: RecoveryClassification,
    code: string,
    summary: string,
    entityType: RecoveryFinding["entityType"],
    entityId: string,
  ) => void,
): void {
  const run = toolRunById.get(approval.toolRunId);
  if (
    run === undefined ||
    run.toolVersion !== approval.toolVersion ||
    run.canonicalInputHash !== approval.canonicalInputHash
  ) {
    add(
      "state_inconsistent",
      "APPROVAL_BINDING_MISMATCH",
      "Approval is not bound to its persisted ToolRun definition.",
      "approval",
      approval.id,
    );
  }
}

function checkRecoveryReview(
  review: RecoveryReviewRecord,
  toolRunById: ReadonlyMap<string, ToolRunRecord>,
  add: (
    classification: RecoveryClassification,
    code: string,
    summary: string,
    entityType: RecoveryFinding["entityType"],
    entityId: string,
  ) => void,
): void {
  const run = toolRunById.get(review.toolRunId);
  if (
    run === undefined ||
    run.mode !== "write" ||
    run.status !== "unknown"
  ) {
    add(
      "state_inconsistent",
      "RECOVERY_REVIEW_TARGET_INVALID",
      "RecoveryReview does not reference an unknown write ToolRun.",
      "recovery_review",
      review.id,
    );
  }
}
