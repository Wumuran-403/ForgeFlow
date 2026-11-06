import type Database from "better-sqlite3";

import { CheckpointStore } from "./checkpoint-store.js";
import { ApprovalRepository } from "./approval-repository.js";
import { EventRepository } from "./event-repository.js";
import { ExecutionPlanRepository } from "./execution-plan-repository.js";
import { MessageRepository } from "./message-repository.js";
import { ModelCallRepository } from "./model-call-repository.js";
import { PlanStepRepository } from "./plan-step-repository.js";
import { RecoveryReviewRepository } from "./recovery-review-repository.js";
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
  }

  load(taskId: string): TaskSnapshot {
    const read = (): TaskSnapshot => ({
      task: this.tasks.get(taskId),
      lease: this.leases.getByTask(taskId) ?? null,
      messages: this.messages.listByTask(taskId),
      modelCalls: this.modelCalls.listByTask(taskId),
      events: this.events.listByTask(taskId),
      checkpoints: this.checkpoints.listByTask(taskId),
      executionPlans: this.plans.listByTask(taskId),
      planSteps: this.planSteps.listByTask(taskId),
      toolRuns: this.toolRuns.listByTask(taskId),
      approvals: this.approvals.listByTask(taskId),
      recoveryReviews: this.recoveryReviews.listByTask(taskId),
    });

    return this.database.inTransaction
      ? read()
      : runInTransaction(this.database, read);
  }
}
