import type { WriteApprovalDecision, WriteApprovalHandler, WriteApprovalRequest } from "../scheduler/index.js";
import { AppError } from "../shared/errors.js";
import {
  ApprovalRepository, ExecutionUnitOfWork, TaskLeaseManager, TaskSnapshotReader, ToolRunRepository,
  type ApprovalRecord, type ForgeFlowDatabase,
  type LeaseOwnershipContext,
} from "../storage/index.js";

export interface WebApprovalView {
  readonly id: string;
  readonly taskId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly description: string;
  readonly input: unknown;
  readonly status: "pending" | "approved" | "rejected" | "cancelled";
  readonly reason: string | null;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
}

interface Waiter {
  resolve(decision: WriteApprovalDecision): void;
  cleanup(): void;
}

export class WebApprovalRegistry {
  private readonly approvals: ApprovalRepository;
  private readonly toolRuns: ToolRunRepository;
  private readonly snapshots: TaskSnapshotReader;
  private readonly unitOfWork: ExecutionUnitOfWork;
  private readonly waiters = new Map<string, Waiter>();

  constructor(database: ForgeFlowDatabase) {
    this.approvals = new ApprovalRepository(database);
    this.toolRuns = new ToolRunRepository(database);
    this.snapshots = new TaskSnapshotReader(database);
    this.unitOfWork = new ExecutionUnitOfWork(database, new TaskLeaseManager(database));
  }

  createHandler(taskId: string): WriteApprovalHandler {
    return { request: (request, options) => this.request(taskId, request, options.signal) };
  }

  listForTask(taskId: string): readonly WebApprovalView[] {
    return this.approvals.listByTask(taskId).map((approval) => this.toView(approval));
  }

  listPending(taskIds: readonly string[]): readonly WebApprovalView[] {
    return taskIds.flatMap((taskId) => this.listForTask(taskId))
      .filter((approval) => approval.status === "pending")
      .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt));
  }

  get(id: string): WebApprovalView {
    return this.toView(this.approvals.get(id));
  }

  cancelPending(taskId: string, ownership: LeaseOwnershipContext): void {
    for (const approval of this.approvals.listByTask(taskId).filter((item) => item.status === "pending")) {
      this.unitOfWork.decideApproval({ approvalId: approval.id, status: "cancelled" }, ownership);
    }
  }

  decide(
    id: string,
    status: "approved" | "rejected",
    reason?: string,
    ownership?: LeaseOwnershipContext,
    beforeResolve?: (taskId: string) => void,
  ): WebApprovalView {
    const current = this.approvals.get(id);
    if (current.status !== "pending") {
      throw new AppError({ code: "WEB_APPROVAL_ALREADY_DECIDED", message: "Approval has already been decided.", statusCode: 409 });
    }
    this.unitOfWork.decideApproval({ approvalId: id, status, ...(reason === undefined ? {} : { reason }) }, ownership);
    beforeResolve?.(current.taskId);
    const waiter = this.waiters.get(id);
    if (waiter !== undefined) {
      this.waiters.delete(id);
      waiter.cleanup();
      waiter.resolve(status === "approved" ? { status } : { status, ...(reason === undefined ? {} : { reason }) });
    }
    return this.get(id);
  }

  private request(taskId: string, request: WriteApprovalRequest, signal?: AbortSignal): Promise<WriteApprovalDecision> {
    const run = this.toolRuns.listByTask(taskId).find((candidate) => candidate.toolCallId === request.toolCallId);
    if (run === undefined || run.mode !== "write" || !run.requiresApproval) {
      throw new AppError({ code: "WEB_APPROVAL_TARGET_INVALID", message: "Approval target is invalid.", statusCode: 409 });
    }
    let approval = this.approvals.getByToolRun(run.id);
    if (approval === undefined) {
      const snapshot = this.snapshots.load(taskId);
      if (snapshot.task.status !== "running" || snapshot.lease?.leaseToken == null) {
        throw new AppError({ code: "WEB_APPROVAL_TASK_NOT_RUNNING", message: "Task is not running under a lease.", statusCode: 409 });
      }
      this.unitOfWork.requestApproval({
        toolRunId: run.id,
        request: { toolName: request.toolName, description: request.description, input: request.input as never },
      }, { taskId, leaseToken: snapshot.lease.leaseToken, fencingToken: snapshot.lease.fencingToken });
      approval = this.approvals.getByToolRun(run.id);
    }
    if (approval === undefined) throw new Error("Approval was not persisted.");
    if (approval.status === "approved") return Promise.resolve({ status: "approved" });
    if (approval.status === "rejected") return Promise.resolve({ status: "rejected", ...(approval.reason === null ? {} : { reason: approval.reason }) });
    if (approval.status !== "pending") {
      throw new AppError({ code: "WEB_APPROVAL_NOT_PENDING", message: "Approval is no longer pending.", statusCode: 409 });
    }
    const id = approval.id;
    return new Promise<WriteApprovalDecision>((resolve, reject) => {
      const onAbort = (): void => {
        this.waiters.delete(id);
        cleanup();
        reject(new Error("Web approval waiter was interrupted."));
      };
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      this.waiters.set(id, { resolve, cleanup });
      if (signal?.aborted) onAbort();
      else signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  private toView(approval: ApprovalRecord): WebApprovalView {
    const run = this.toolRuns.get(approval.toolRunId);
    const request = approval.request;
    const record: Record<string, unknown> = typeof request === "object" && request !== null && !Array.isArray(request)
      ? request as Record<string, unknown> : {};
    return {
      id: approval.id, taskId: approval.taskId, toolCallId: run.toolCallId,
      toolName: run.toolName,
      description: typeof record.description === "string" ? record.description : run.toolName,
      input: record.input ?? run.input,
      status: approval.status === "expired" ? "cancelled" : approval.status,
      reason: approval.reason, requestedAt: approval.requestedAt, decidedAt: approval.decidedAt,
    };
  }
}
