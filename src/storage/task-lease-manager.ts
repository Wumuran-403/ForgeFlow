import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import { CheckpointStore } from "./checkpoint-store.js";
import { EventRepository } from "./event-repository.js";
import { SequenceAllocator } from "./sequences.js";
import {
  TaskLeaseRepository,
} from "./task-lease-repository.js";
import { runInTransaction } from "./transaction.js";
import type { TaskLeaseRecord, TaskStatus } from "./types.js";
import { createStorageWritePermit } from "./write-boundary.js";

const DEFAULT_LEASE_TTL_MS = 30_000;

const LeaseReferenceSchema = z
  .object({
    taskId: z.string().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const ClaimLeaseInputSchema = z
  .object({
    taskId: z.string().min(1),
    ownerId: z.string().trim().min(1),
  })
  .strict();

export interface TaskLeaseManagerOptions {
  readonly leaseTtlMs?: number;
  readonly now?: () => Date;
}

export interface OwnedTask {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export interface TaskLeaseClaimResult {
  readonly leaseRecord: TaskLeaseRecord;
  readonly leaseClaimEventId: string;
}

const TERMINAL_TASK_STATUSES = new Set<TaskStatus>([
  "completed",
  "failed",
  "cancelled",
]);

export class TaskLeaseManager {
  private readonly leases: TaskLeaseRepository;
  private readonly events: EventRepository;
  private readonly checkpoints: CheckpointStore;
  private readonly sequences: SequenceAllocator;
  private readonly leaseTtlMsValue: number;
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    options: TaskLeaseManagerOptions = {},
  ) {
    this.leaseTtlMsValue = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    if (!Number.isInteger(this.leaseTtlMsValue) || this.leaseTtlMsValue <= 0) {
      throw new AppError({
        code: "TASK_LEASE_TTL_INVALID",
        message: "Task lease TTL must be a positive integer.",
        statusCode: 500,
        details: [],
      });
    }
    this.now = options.now ?? (() => new Date());
    this.leases = new TaskLeaseRepository(database);
    this.sequences = new SequenceAllocator(database);
    this.events = new EventRepository(database, this.sequences);
    this.checkpoints = new CheckpointStore(database, this.sequences);
  }

  get leaseTtlMs(): number {
    return this.leaseTtlMsValue;
  }

  get recommendedHeartbeatIntervalMs(): number {
    return Math.max(1, Math.floor(this.leaseTtlMsValue / 3));
  }

  claim(taskId: string, ownerId: string): TaskLeaseRecord {
    return this.claimWithClaimEvent(taskId, ownerId).leaseRecord;
  }

  claimWithClaimEvent(
    taskId: string,
    ownerId: string,
  ): TaskLeaseClaimResult {
    const parsed = ClaimLeaseInputSchema.parse({ taskId, ownerId });
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.leaseTtlMsValue).toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.getTaskLeaseView(parsed.taskId);
        if (TERMINAL_TASK_STATUSES.has(task.status)) {
          throw new AppError({
            code: "TASK_LEASE_TASK_TERMINAL",
            message: "A terminal task cannot acquire an execution lease.",
            statusCode: 409,
            details: [],
          });
        }
        const lease = this.leases.claim(
          {
            taskId: parsed.taskId,
            ownerId: parsed.ownerId,
            leaseToken: randomUUID(),
            expiresAt,
            claimedAt: nowIso,
          },
          permit,
        );
        if (lease === undefined) {
          throw new AppError({
            code: "TASK_LEASE_UNAVAILABLE",
            message: "Task already has an active execution lease.",
            statusCode: 409,
            details: [],
          });
        }
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "lease.claimed",
            entityType: "task_lease",
            entityId: task.id,
            payload: {
              ownerId: parsed.ownerId,
              fencingToken: lease.fencingToken,
            },
          },
          nowIso,
          permit,
        );
        this.appendCheckpoint(
          task.id,
          task.traceId,
          "lease_claimed",
          task.status,
          nowIso,
          event.sequence,
          permit,
        );
        if (
          event.taskId !== task.id ||
          event.type !== "lease.claimed" ||
          event.entityType !== "task_lease" ||
          event.entityId !== task.id ||
          event.payload.fencingToken !== lease.fencingToken
        ) {
          throw new AppError({
            code: "TASK_LEASE_CLAIM_EVENT_INVALID",
            message: "Task lease claim Event is inconsistent with the lease.",
            statusCode: 500,
            details: [],
          });
        }
        return {
          leaseRecord: lease,
          leaseClaimEventId: event.id,
        };
      },
      "immediate",
    );
  }

  heartbeat(
    taskId: string,
    leaseToken: string,
    fencingToken: number,
  ): TaskLeaseRecord {
    const parsed = LeaseReferenceSchema.parse({
      taskId,
      leaseToken,
      fencingToken,
    });
    const now = this.now();
    const nowIso = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.leaseTtlMsValue).toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.getTaskLeaseView(parsed.taskId);
        const lease = this.leases.heartbeat(
          parsed.taskId,
          parsed.leaseToken,
          parsed.fencingToken,
          nowIso,
          expiresAt,
          permit,
        );
        if (lease === undefined) {
          throw this.notOwnedError();
        }
        this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "lease.heartbeat",
            entityType: "task_lease",
            entityId: task.id,
            payload: { fencingToken: lease.fencingToken },
          },
          nowIso,
          permit,
        );
        return lease;
      },
      "immediate",
    );
  }

  assertOwned(
    taskId: string,
    leaseToken: string,
    fencingToken: number,
  ): TaskLeaseRecord {
    const parsed = LeaseReferenceSchema.parse({
      taskId,
      leaseToken,
      fencingToken,
    });
    const lease = this.leases.getByTask(parsed.taskId);
    if (
      lease === undefined ||
      lease.ownerId === null ||
      lease.leaseToken !== parsed.leaseToken ||
      lease.fencingToken !== parsed.fencingToken ||
      lease.expiresAt === null ||
      lease.expiresAt <= this.now().toISOString()
    ) {
      throw this.notOwnedError();
    }
    return lease;
  }

  release(
    taskId: string,
    leaseToken: string,
    fencingToken: number,
  ): TaskLeaseRecord {
    const parsed = LeaseReferenceSchema.parse({
      taskId,
      leaseToken,
      fencingToken,
    });
    const nowIso = this.now().toISOString();

    return runInTransaction(
      this.database,
      () => {
        const permit = createStorageWritePermit(this.database);
        const task = this.getTaskLeaseView(parsed.taskId);
        const lease = this.leases.release(
          parsed.taskId,
          parsed.leaseToken,
          parsed.fencingToken,
          nowIso,
          permit,
        );
        if (lease === undefined) {
          throw this.notOwnedError();
        }
        const event = this.events.append(
          {
            taskId: task.id,
            traceId: task.traceId,
            type: "lease.released",
            entityType: "task_lease",
            entityId: task.id,
            payload: { fencingToken: lease.fencingToken },
          },
          nowIso,
          permit,
        );
        this.appendCheckpoint(
          task.id,
          task.traceId,
          "lease_released",
          task.status,
          nowIso,
          event.sequence,
          permit,
        );
        return lease;
      },
      "immediate",
    );
  }

  isExpired(
    taskId: string,
    leaseToken: string,
    fencingToken: number,
  ): boolean {
    const lease = this.leases.getByTask(taskId);
    return (
      lease === undefined ||
      lease.ownerId === null ||
      lease.leaseToken !== leaseToken ||
      lease.fencingToken !== fencingToken ||
      lease.expiresAt === null ||
      lease.expiresAt <= this.now().toISOString()
    );
  }

  hasActiveLease(taskId: string): boolean {
    const lease = this.leases.getByTask(taskId);
    return (
      lease !== undefined &&
      lease.ownerId !== null &&
      lease.expiresAt !== null &&
      lease.expiresAt > this.now().toISOString()
    );
  }

  private appendCheckpoint(
    taskId: string,
    traceId: string,
    reason: string,
    taskStatus: TaskStatus,
    now: string,
    eventSequence: number,
    permit: ReturnType<typeof createStorageWritePermit>,
  ): void {
    const task = this.getTaskLeaseView(taskId);
    const latestMessage = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(sequence), 0) AS sequence
          FROM messages
          WHERE task_id = ?
        `,
      )
      .get(taskId) as { sequence: number };
    const latestPlan = this.database
      .prepare(
        `
          SELECT MAX(version) AS version
          FROM execution_plans
          WHERE task_id = ? AND purpose = 'agent'
        `,
      )
      .get(taskId) as { version: number | null };
    this.checkpoints.append(
      {
        taskId,
        reason,
        taskStatus,
        lastMessageSequence: latestMessage.sequence,
        modelIteration: task.currentIteration,
        planVersion: latestPlan.version,
        lastEventSequence: eventSequence,
        budget: {
          maxModelTurns: task.maxModelTurns,
          maxToolCalls: task.maxToolCalls,
          ...(task.maxTokens === null ? {} : { maxTokens: task.maxTokens }),
        },
        metadata: { traceId },
      },
      now,
      permit,
    );
  }

  private getTaskLeaseView(taskId: string): {
    id: string;
    traceId: string;
    status: TaskStatus;
    currentIteration: number;
    maxModelTurns: number;
    maxToolCalls: number;
    maxTokens: number | null;
  } {
    const row = this.database
      .prepare(
        `
          SELECT id, trace_id, status, current_iteration,
                 max_model_turns, max_tool_calls, max_tokens
          FROM tasks
          WHERE id = ?
        `,
      )
      .get(taskId) as
      | {
          id: string;
          trace_id: string;
          status: TaskStatus;
          current_iteration: number;
          max_model_turns: number;
          max_tool_calls: number;
          max_tokens: number | null;
        }
      | undefined;
    if (row === undefined) {
      throw new AppError({
        code: "TASK_NOT_FOUND",
        message: "Task was not found.",
        statusCode: 404,
        details: [],
      });
    }
    return {
      id: row.id,
      traceId: row.trace_id,
      status: row.status,
      currentIteration: row.current_iteration,
      maxModelTurns: row.max_model_turns,
      maxToolCalls: row.max_tool_calls,
      maxTokens: row.max_tokens,
    };
  }

  private notOwnedError(): AppError {
    return new AppError({
      code: "TASK_LEASE_NOT_OWNED",
      message: "Task lease ownership is invalid or expired.",
      statusCode: 409,
      details: [],
    });
  }
}
