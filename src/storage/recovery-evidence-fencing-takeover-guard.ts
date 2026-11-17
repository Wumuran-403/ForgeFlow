import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import { EventRepository } from "./event-repository.js";
import type { EventRecord, TaskLeaseRecord } from "./types.js";
import { SequenceAllocator } from "./sequences.js";
import {
  TaskLeaseManager,
  type OwnedTask,
} from "./task-lease-manager.js";
import { TaskLeaseRepository } from "./task-lease-repository.js";

const ClaimRecoveryEvidenceOwnershipInputSchema = z
  .object({
    taskId: z.string().trim().min(1),
    ownerId: z.string().trim().min(1),
  })
  .strict();

const OwnershipSchema = z
  .object({
    taskId: z.string().trim().min(1),
    leaseToken: z.string().min(1),
    fencingToken: z.number().int().positive(),
  })
  .strict();

const LeaseClaimEventInputSchema = z
  .object({
    ownership: OwnershipSchema,
    leaseClaimEventId: z.uuid(),
  })
  .strict();

const InterruptedClaimBindingInputSchema =
  LeaseClaimEventInputSchema.extend({
    dispatchEventId: z.uuid(),
    interruptedEventId: z.uuid(),
  }).strict();

const PreparedClaimBindingInputSchema =
  LeaseClaimEventInputSchema.extend({
    preparedEventId: z.uuid(),
  }).strict();

export type RecoveryEvidenceTakeoverClaimResult =
  | {
      readonly status: "ready";
      readonly leaseRecord: TaskLeaseRecord;
      readonly leaseClaimEventId: string;
      readonly ownership: OwnedTask;
    }
  | {
      readonly status: "in_progress";
      readonly taskId: string;
      readonly leaseRecord: TaskLeaseRecord;
    }
  | {
      readonly status: "lease_conflict";
      readonly taskId: string;
      readonly reasonCode: "TASK_LEASE_CLAIM_CONFLICT";
    }
  | {
      readonly status: "state_inconsistent";
      readonly taskId: string;
      readonly reasonCode:
        | "TASK_NOT_FOUND"
        | "TASK_LEASE_TASK_TERMINAL"
        | "TASK_LEASE_CLAIM_EVENT_INVALID";
    };

export interface VerifiedRecoveryEvidenceLeaseClaim {
  readonly event: EventRecord;
  readonly taskId: string;
  readonly fencingToken: number;
}

export class RecoveryEvidenceFencingTakeoverGuard {
  private readonly leases: TaskLeaseRepository;
  private readonly events: EventRepository;

  constructor(
    database: Database.Database,
    private readonly leaseManager: TaskLeaseManager =
      new TaskLeaseManager(database),
  ) {
    this.leases = new TaskLeaseRepository(database);
    this.events = new EventRepository(
      database,
      new SequenceAllocator(database),
    );
  }

  claimRecoveryEvidenceOwnership(
    taskId: string,
    ownerId: string,
  ): RecoveryEvidenceTakeoverClaimResult {
    const parsed =
      ClaimRecoveryEvidenceOwnershipInputSchema.parse({
        taskId,
        ownerId,
      });

    try {
      const claimed = this.leaseManager.claimWithClaimEvent(
        parsed.taskId,
        parsed.ownerId,
      );
      const leaseToken = claimed.leaseRecord.leaseToken;
      if (leaseToken === null) {
        return {
          status: "state_inconsistent",
          taskId: parsed.taskId,
          reasonCode: "TASK_LEASE_CLAIM_EVENT_INVALID",
        };
      }
      return {
        status: "ready",
        leaseRecord: claimed.leaseRecord,
        leaseClaimEventId: claimed.leaseClaimEventId,
        ownership: {
          taskId: claimed.leaseRecord.taskId,
          leaseToken,
          fencingToken: claimed.leaseRecord.fencingToken,
        },
      };
    } catch (error) {
      return this.classifyClaimFailure(parsed.taskId, error);
    }
  }

  assertLeaseClaimEvent(input: {
    readonly ownership: OwnedTask;
    readonly leaseClaimEventId: string;
  }): VerifiedRecoveryEvidenceLeaseClaim {
    const parsed = LeaseClaimEventInputSchema.parse(input);
    this.leaseManager.assertOwned(
      parsed.ownership.taskId,
      parsed.ownership.leaseToken,
      parsed.ownership.fencingToken,
    );
    const currentLease = this.leases.getByTask(
      parsed.ownership.taskId,
    );
    const claimEvent = this.events
      .listByTask(parsed.ownership.taskId)
      .find((event) => event.id === parsed.leaseClaimEventId);
    if (
      claimEvent === undefined ||
      claimEvent.taskId !== parsed.ownership.taskId ||
      claimEvent.type !== "lease.claimed" ||
      claimEvent.entityType !== "task_lease" ||
      claimEvent.entityId !== parsed.ownership.taskId ||
      claimEvent.payload.fencingToken !==
        parsed.ownership.fencingToken ||
      typeof claimEvent.payload.ownerId !== "string" ||
      claimEvent.payload.ownerId !== currentLease?.ownerId
    ) {
      throw leaseClaimError(
        "RECOVERY_EVIDENCE_LEASE_CLAIM_INVALID",
        "Recovery evidence Lease Claim Event is invalid.",
      );
    }
    return {
      event: claimEvent,
      taskId: parsed.ownership.taskId,
      fencingToken: parsed.ownership.fencingToken,
    };
  }

  assertInterruptedClaimBinding(input: {
    readonly ownership: OwnedTask;
    readonly leaseClaimEventId: string;
    readonly dispatchEventId: string;
    readonly interruptedEventId: string;
  }): void {
    const parsed =
      InterruptedClaimBindingInputSchema.parse(input);
    const claim = this.assertLeaseClaimEvent({
      ownership: parsed.ownership,
      leaseClaimEventId: parsed.leaseClaimEventId,
    });
    const events = this.events.listByTask(
      parsed.ownership.taskId,
    );
    const dispatch = events.find(
      (event) => event.id === parsed.dispatchEventId,
    );
    const interrupted = events.find(
      (event) => event.id === parsed.interruptedEventId,
    );
    if (
      dispatch?.type !==
        "recovery.evidence.read_attempt_dispatching" ||
      interrupted?.type !==
        "recovery.evidence.read_attempt_interrupted" ||
      claim.event.sequence <= dispatch.sequence ||
      claim.event.sequence >= interrupted.sequence
    ) {
      throw leaseClaimError(
        "RECOVERY_EVIDENCE_LEASE_CLAIM_SEQUENCE_INVALID",
        "Interrupted Event Lease Claim sequence is invalid.",
      );
    }
  }

  assertPreparedClaimBinding(input: {
    readonly ownership: OwnedTask;
    readonly leaseClaimEventId: string;
    readonly preparedEventId: string;
  }): void {
    const parsed =
      PreparedClaimBindingInputSchema.parse(input);
    const claim = this.assertLeaseClaimEvent({
      ownership: parsed.ownership,
      leaseClaimEventId: parsed.leaseClaimEventId,
    });
    const prepared = this.events
      .listByTask(parsed.ownership.taskId)
      .find((event) => event.id === parsed.preparedEventId);
    if (
      prepared?.type !==
        "recovery.evidence.read_attempt_prepared" ||
      claim.event.sequence >= prepared.sequence
    ) {
      throw leaseClaimError(
        "RECOVERY_EVIDENCE_LEASE_CLAIM_SEQUENCE_INVALID",
        "Prepared Event Lease Claim sequence is invalid.",
      );
    }
  }

  private classifyClaimFailure(
    taskId: string,
    error: unknown,
  ): RecoveryEvidenceTakeoverClaimResult {
    const code = appErrorCode(error);
    if (code === "TASK_NOT_FOUND" || code === "TASK_LEASE_TASK_TERMINAL") {
      return {
        status: "state_inconsistent",
        taskId,
        reasonCode: code,
      };
    }
    if (code === "TASK_LEASE_CLAIM_EVENT_INVALID") {
      return {
        status: "state_inconsistent",
        taskId,
        reasonCode: "TASK_LEASE_CLAIM_EVENT_INVALID",
      };
    }
    if (code === "TASK_LEASE_UNAVAILABLE") {
      const current = this.leases.getByTask(taskId);
      if (current !== undefined && this.leaseManager.hasActiveLease(taskId)) {
        return {
          status: "in_progress",
          taskId,
          leaseRecord: current,
        };
      }
      return {
        status: "lease_conflict",
        taskId,
        reasonCode: "TASK_LEASE_CLAIM_CONFLICT",
      };
    }
    throw error;
  }
}

function appErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return undefined;
}

function leaseClaimError(code: string, message: string): AppError {
  return new AppError({
    code,
    message,
    statusCode: 409,
    details: [],
  });
}
