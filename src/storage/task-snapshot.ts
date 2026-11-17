import type Database from "better-sqlite3";

import { CheckpointStore } from "./checkpoint-store.js";
import { ApprovalRepository } from "./approval-repository.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { MessageRepository } from "./message-repository.js";
import { ModelCallRepository } from "./model-call-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryEvidenceReadRepository } from "./recovery-evidence-read-repository.js";
import { RecoveryEvidenceReadAttemptRepository } from "./recovery-evidence-read-attempt-repository.js";
import { RecoveryEvidenceReadbackRequestRepository } from "./recovery-evidence-readback-request-repository.js";
import { RecoveryEvidenceSubmissionRepository } from "./recovery-evidence-submission-repository.js";
import { RecoveryEvidenceVerificationCheckRepository } from "./recovery-evidence-verification-check-repository.js";
import { RecoveryEvidenceVerificationRepository } from "./recovery-evidence-verification-repository.js";
import { RecoveryLegacyAttestationRepository } from "./recovery-legacy-attestation-repository.js";
import { RecoveryReviewRepository } from "./recovery-review-repository.js";
import { RecoveryReviewOperationRepository } from "./recovery-review-operation-repository.js";
import { SequenceAllocator } from "./sequences.js";
import { TaskLeaseRepository } from "./task-lease-repository.js";
import { TaskRepository } from "./task-repository.js";
import { ToolRunRepository } from "./tool-run-repository.js";
import { runInTransaction } from "./transaction.js";
import type { TaskSnapshot } from "./types.js";

export class TaskSnapshotReader {
  private readonly tasks: TaskRepository;
  private readonly leases: TaskLeaseRepository;
  private readonly messages: MessageRepository;
  private readonly modelCalls: ModelCallRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly plans: ExecutionPlanRepository;
  private readonly planSteps: PlanStepRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly approvals: ApprovalRepository;
  private readonly recoveryReviews: RecoveryReviewRepository;
  private readonly recoveryEvidenceReadbackRequests: RecoveryEvidenceReadbackRequestRepository;
  private readonly recoveryEvidenceReadAttempts: RecoveryEvidenceReadAttemptRepository;
  private readonly recoveryEvidenceReads: RecoveryEvidenceReadRepository;
  private readonly recoveryEvidenceVerificationChecks: RecoveryEvidenceVerificationCheckRepository;
  private readonly recoveryEvidenceVerifications: RecoveryEvidenceVerificationRepository;
  private readonly recoveryEvidenceSubmissions: RecoveryEvidenceSubmissionRepository;
  private readonly recoveryLegacyAttestations: RecoveryLegacyAttestationRepository;
  private readonly recoveryReviewOperations: RecoveryReviewOperationRepository;

  constructor(private readonly database: Database.Database) {
    const sequences = new SequenceAllocator(database);
    this.tasks = new TaskRepository(database);
    this.leases = new TaskLeaseRepository(database);
    this.messages = new MessageRepository(database, sequences);
    this.modelCalls = new ModelCallRepository(database);
    this.events = new EventRepository(database, sequences);
    this.checkpoints = new CheckpointStore(database, sequences);
    this.plans = new ExecutionPlanRepository(database);
    this.planSteps = new PlanStepRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    this.approvals = new ApprovalRepository(database);
    this.recoveryReviews = new RecoveryReviewRepository(database);
    this.recoveryEvidenceReadbackRequests =
      new RecoveryEvidenceReadbackRequestRepository(database);
    this.recoveryEvidenceReadAttempts =
      new RecoveryEvidenceReadAttemptRepository(database);
    this.recoveryEvidenceReads = new RecoveryEvidenceReadRepository(database);
    this.recoveryEvidenceVerificationChecks =
      new RecoveryEvidenceVerificationCheckRepository(database);
    this.recoveryEvidenceVerifications =
      new RecoveryEvidenceVerificationRepository(database);
    this.recoveryEvidenceSubmissions =
      new RecoveryEvidenceSubmissionRepository(database);
    this.recoveryLegacyAttestations =
      new RecoveryLegacyAttestationRepository(database);
    this.recoveryReviewOperations =
      new RecoveryReviewOperationRepository(database);
  }

  load(taskId: string): TaskSnapshot {
    const read = (): TaskSnapshot => {
      const executionPlans = this.plans.listByTask(taskId);
      return {
        task: this.tasks.get(taskId),
        lease: this.leases.getByTask(taskId) ?? null,
        messages: this.messages.listByTask(taskId),
        modelCalls: this.modelCalls.listByTask(taskId),
        events: this.events.listByTask(taskId),
        checkpoints: this.checkpoints.listByTask(taskId),
        executionPlans,
        agentExecutionPlans: executionPlans.filter(
          (plan) => plan.purpose === "agent",
        ),
        recoveryEvidencePlans: executionPlans.filter(
          (plan) => plan.purpose === "recovery_evidence",
        ),
        planSteps: this.planSteps.listByTask(taskId),
        toolRuns: this.toolRuns.listByTask(taskId),
        approvals: this.approvals.listByTask(taskId),
        recoveryReviews: this.recoveryReviews.listByTask(taskId),
        recoveryEvidenceReadbackRequests:
          this.recoveryEvidenceReadbackRequests.listByTask(taskId),
        recoveryEvidenceReadAttempts:
          this.recoveryEvidenceReadAttempts.listByTask(taskId),
        recoveryEvidenceReads:
          this.recoveryEvidenceReads.listByTask(taskId),
        recoveryEvidenceVerificationChecks:
          this.recoveryEvidenceVerificationChecks.listByTask(taskId),
        recoveryEvidenceVerifications:
          this.recoveryEvidenceVerifications.listByTask(taskId),
        recoveryEvidenceSubmissions:
          this.recoveryEvidenceSubmissions.listByTask(taskId),
        recoveryLegacyAttestations:
          this.recoveryLegacyAttestations.listByTask(taskId),
        recoveryReviewOperations:
          this.recoveryReviewOperations.listByTask(taskId),
      };
    };

    return this.database.inTransaction
      ? read()
      : runInTransaction(this.database, read);
  }
}
