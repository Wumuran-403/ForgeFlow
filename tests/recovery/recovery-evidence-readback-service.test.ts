import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

import {
  RecoveryEvidenceReadbackService,
  RecoveryReadbackToolRegistry,
  RecoveryVerifierHostBindingProvider,
  RecoveryVerifierRegistry,
  RecoveryVerifierRuntime,
  computeRecoveryReadbackAllowlistVersion,
  type PrepareRecoveryEvidenceReadbackInput,
  type RecoveryReadbackToolDefinition,
} from "../../src/recovery/index.js";
import {
  CheckpointStore,
  EventRepository,
  ExecutionPlanRepository,
  PlanStepRepository,
  RecoveryEvidenceReadbackReservationUnitOfWork,
  TaskSnapshotReader,
  ToolRunRepository,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { RecoveryEvidenceReadAttemptRepository } from "../../src/storage/recovery-evidence-read-attempt-repository.js";
import { RecoveryEvidenceReadbackRequestRepository } from "../../src/storage/recovery-evidence-readback-request-repository.js";
import { RecoveryEvidenceReadbackReservationRepository } from "../../src/storage/recovery-evidence-readback-reservation-repository.js";
import { RecoveryReviewOperationRepository } from "../../src/storage/recovery-review-operation-repository.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import { computeToolInputSchemaHash } from "../../src/tools/fingerprint.js";
import { ToolRegistry } from "../../src/tools/registry.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";
import {
  createRecoveryEvidenceUowFixture,
  type RecoveryEvidenceUowFixture,
} from "../storage/recovery-evidence-uow-fixture.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
});

afterEach(() => {
  vi.restoreAllMocks();
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("RecoveryEvidenceReadbackService", () => {
  it("creates Reservation and complete Transaction A without executing a Read Tool", async () => {
    const fixture = createServiceFixture("transaction-a");
    const before = fixture.snapshot();

    const prepared = await fixture.service.prepareReadback(
      fixture.input(),
    );

    expect(prepared).toMatchObject({
      state: "request",
      replayed: false,
      request: {
        taskId: fixture.uow.taskId,
        reviewId: fixture.uow.reviewId,
        evidenceSubmissionId: fixture.uow.evidenceSubmissionId,
        originalToolRunId: fixture.uow.originalToolRunId,
        allowlistId: fixture.allowlistId,
        allowlistVersion: fixture.allowlistVersion,
        verificationCheckId: fixture.verificationCheckId,
      },
      reservation: {
        status: "completed",
        reservationVersion: 2,
      },
    });
    const request = prepared.request as NonNullable<
      typeof prepared.request
    >;
    expect(fixture.reservationIds()).toEqual({
      requestId: request.id,
      operationId: request.operationId,
      executionPlanId: request.executionPlanId,
      planStepId: request.planStepId,
      readToolRunId: request.readToolRunId,
      readAttemptId:
        prepared.reservation?.readAttemptId,
    });
    const after = fixture.snapshot();
    expect(
      after.executionPlans.find(
        (plan) => plan.id === request.executionPlanId,
      ),
    ).toMatchObject({
      purpose: "recovery_evidence",
      status: "active",
      version: 3,
    });
    expect(
      after.planSteps.find((step) => step.id === request.planStepId),
    ).toMatchObject({ kind: "read_batch", status: "queued" });
    expect(
      after.toolRuns.find((run) => run.id === request.readToolRunId),
    ).toMatchObject({ mode: "read", status: "queued" });
    expect(after.recoveryEvidenceReadAttempts).toEqual([
      expect.objectContaining({
        readbackRequestId: request.id,
        readToolRunId: request.readToolRunId,
        attemptNumber: 1,
        status: "prepared",
      }),
    ]);
    expect(
      after.events.filter(
        (event) => event.type === "recovery.readback_requested",
      ),
    ).toHaveLength(1);
    const operation = after.recoveryReviewOperations.find(
      (candidate) => candidate.id === request.operationId,
    );
    const recomputedPayloadDigest =
      computeRecoveryEvidenceReadbackOperationPayloadDigest({
        evidenceSubmissionId: request.evidenceSubmissionId,
        originalUnknownToolRunId: request.originalToolRunId,
        verifierId: request.verifierId,
        verifierVersion: request.verifierVersion,
        verifierConfigDigest: request.verifierConfigDigest,
        allowlistId: request.allowlistId,
        allowlistVersion: request.allowlistVersion,
        readToolName: request.readToolName,
        readToolVersion: request.readToolVersion,
        readToolSchemaHash: request.readToolSchemaHash,
        expectedResourceVersion:
          request.expectedResourceVersion,
        expectedEtag: request.expectedEtag,
        verificationCheckId: request.verificationCheckId,
        expectedDecisionVersion:
          operation?.expectedDecisionVersion as number,
      });
    expect(operation).toMatchObject({
      operation: "request_readback",
      status: "accepted",
      operationPayloadDigest: recomputedPayloadDigest,
      requestKey: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(request.requestKey).toBe(
      computeRecoveryReviewOperationRequestKey({
        reviewId: request.reviewId,
        expectedDecisionVersion:
          operation?.expectedDecisionVersion as number,
        operation: "request_readback",
        operationPayloadDigest: recomputedPayloadDigest,
        actorId: "host-reviewer",
      }),
    );
    expect(
      after.checkpoints.filter(
        (checkpoint) =>
          checkpoint.reason === "recovery_readback_requested",
      ),
    ).toHaveLength(1);
    expect(after.task.status).toBe("waiting_review");
    expect(
      after.toolRuns.find(
        (run) => run.id === fixture.uow.originalToolRunId,
      )?.status,
    ).toBe("unknown");
    expect(
      after.planSteps.find(
        (step) =>
          step.id ===
          before.toolRuns.find(
            (run) => run.id === fixture.uow.originalToolRunId,
          )?.planStepId,
      ),
    ).toEqual(
      before.planSteps.find(
        (step) =>
          step.id ===
          before.toolRuns.find(
            (run) => run.id === fixture.uow.originalToolRunId,
          )?.planStepId,
      ),
    );
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.resolveSource).toHaveBeenCalledTimes(1);
    expect(fixture.buildArguments).toHaveBeenCalledTimes(1);
  });

  it("replays completed Reservations without Host callbacks", async () => {
    const fixture = createServiceFixture("completed-replay");
    const first = await fixture.service.prepareReadback(fixture.input());
    const before = fixture.snapshot();

    const second = await fixture.service.prepareReadback(
      fixture.input(),
    );

    expect(second).toMatchObject({
      state: "request",
      replayed: true,
      request: { id: first.request?.id },
      reservation: { status: "completed" },
    });
    expect(fixture.resolveSource).toHaveBeenCalledTimes(1);
    expect(fixture.buildArguments).toHaveBeenCalledTimes(1);
    expect(fixture.verifierBindingLookup).toHaveBeenCalledTimes(1);
    expect(fixture.execute).not.toHaveBeenCalled();
    const after = fixture.snapshot();
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  });

  it("returns in_progress without Host callbacks for a competing owner", async () => {
    const fixture = createServiceFixture("in-progress");
    const reservation =
      fixture.reservationUnitOfWork.acquireOwned(
        fixture.reservationAcquireInput("competitor"),
      );
    expect(reservation.state).toBe("acquired");

    const result = await fixture.service.prepareReadback(
      fixture.input(),
    );

    expect(result).toMatchObject({
      state: "in_progress",
      replayed: true,
      request: null,
      reservation: {
        id: reservation.reservation?.id,
        status: "preparing",
      },
    });
    expect(fixture.resolveSource).not.toHaveBeenCalled();
    expect(fixture.buildArguments).not.toHaveBeenCalled();
    expect(fixture.verifierBindingLookup).not.toHaveBeenCalled();
  });

  it("lets the original owner reenter with its ownerToken and prepare", async () => {
    const fixture = createServiceFixture("owner-reentry");
    const reservation =
      fixture.reservationUnitOfWork.acquireOwned(
        fixture.reservationAcquireInput("owner-reentry"),
      );
    if (reservation.ownerToken === null) {
      throw new Error("Expected owner token.");
    }

    const result = await fixture.service.prepareReadback({
      ...fixture.input(),
      ownerToken: reservation.ownerToken,
    });

    expect(result.state).toBe("request");
    expect(result.reservation).toMatchObject({
      id: reservation.reservation?.id,
      status: "completed",
    });
    expect(fixture.resolveSource).toHaveBeenCalledTimes(1);
  });

  it("takes over stale ownership with fixed Reservation IDs", async () => {
    const fixture = createServiceFixture("stale-takeover");
    const reservation =
      fixture.reservationUnitOfWork.acquireOwned(
        fixture.reservationAcquireInput("stale-takeover"),
      );
    const original = reservation.reservation;
    if (original === null) {
      throw new Error("Expected reservation.");
    }
    fixture.uow.leaseManager.release(
      fixture.uow.taskId,
      fixture.uow.ownership.leaseToken,
      fixture.uow.ownership.fencingToken,
    );
    const replacement = fixture.uow.leaseManager.claim(
      fixture.uow.taskId,
      "takeover-owner",
    );
    if (replacement.leaseToken === null) {
      throw new Error("Expected replacement lease.");
    }
    const ownership = {
      taskId: fixture.uow.taskId,
      leaseToken: replacement.leaseToken,
      fencingToken: replacement.fencingToken,
    };

    const result = await fixture.service.prepareReadback({
      ...fixture.input(),
      ownership,
      expectedTaskVersion:
        fixture.snapshot().task.version,
    });

    expect(result.request).toMatchObject({
      id: original.requestId,
      operationId: original.operationId,
      executionPlanId: original.executionPlanId,
      planStepId: original.planStepId,
      readToolRunId: original.readToolRunId,
    });
    expect(result.reservation).toMatchObject({
      id: original.id,
      reservationVersion: 3,
      ownerFencingToken: replacement.fencingToken,
    });
  });

  it("reclaims abandoned Reservation after fencing takeover", async () => {
    const fixture = createServiceFixture("abandoned-reclaim");
    const acquired =
      fixture.reservationUnitOfWork.acquireOwned(
        fixture.reservationAcquireInput("abandoned-reclaim"),
      );
    if (
      acquired.reservation === null ||
      acquired.ownerToken === null
    ) {
      throw new Error("Expected owned reservation.");
    }
    fixture.reservationUnitOfWork.abandonOwned({
      ownership: fixture.uow.ownership,
      reservationId: acquired.reservation.id,
      expectedReservationVersion:
        acquired.reservation.reservationVersion,
      ownerToken: acquired.ownerToken,
      requestIntent: fixture.inputIntent(),
    });
    fixture.uow.leaseManager.release(
      fixture.uow.taskId,
      fixture.uow.ownership.leaseToken,
      fixture.uow.ownership.fencingToken,
    );
    const replacement = fixture.uow.leaseManager.claim(
      fixture.uow.taskId,
      "abandoned-reclaimer",
    );
    if (replacement.leaseToken === null) {
      throw new Error("Expected replacement lease.");
    }

    const result = await fixture.service.prepareReadback({
      ...fixture.input(),
      ownership: {
        taskId: fixture.uow.taskId,
        leaseToken: replacement.leaseToken,
        fencingToken: replacement.fencingToken,
      },
      expectedTaskVersion:
        fixture.snapshot().task.version,
    });

    expect(result.state).toBe("request");
    expect(result.reservation).toMatchObject({
      id: acquired.reservation.id,
      status: "completed",
      reservationVersion: 4,
    });
  });

  it("rejects different Request Intent before Host callbacks", async () => {
    const fixture = createServiceFixture("intent-conflict");
    fixture.reservationUnitOfWork.acquireOwned(
      fixture.reservationAcquireInput("intent-conflict"),
    );

    await expect(
      fixture.service.prepareReadback({
        ...fixture.input(),
        allowlistId: "different_allowlist",
      }),
    ).rejects.toMatchObject({
      code:
        "RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT",
    });
    expect(fixture.resolveSource).not.toHaveBeenCalled();
    expect(fixture.buildArguments).not.toHaveBeenCalled();
  });

  it("replays historical Requests without Host callbacks and rejects mismatched intent", async () => {
    const fixture = createServiceFixture("historical-replay");
    const historical = createHistoricalRequest(fixture);
    const before = fixture.snapshot();

    const replay = await fixture.service.prepareReadback(
      fixture.input(),
    );
    expect(replay).toMatchObject({
      state: "request",
      replayed: true,
      reservation: null,
      request: { id: historical.id },
    });
    expect(fixture.resolveSource).not.toHaveBeenCalled();
    expect(fixture.buildArguments).not.toHaveBeenCalled();
    expect(fixture.snapshot().events).toHaveLength(
      before.events.length,
    );

    await expect(
      fixture.service.prepareReadback({
        ...fixture.input(),
        expectedResourceVersion: "8",
      }),
    ).rejects.toMatchObject({
      code:
        "RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT",
    });
  });

  it("fails closed and abandons Reservation when Host preparation fails", async () => {
    const fixture = createServiceFixture("host-preparation-fail", {
      bindingActive: false,
    });

    await expect(
      fixture.service.prepareReadback(fixture.input()),
    ).rejects.toMatchObject({
      code: "RECOVERY_VERIFIER_BINDING_NOT_FOUND",
    });

    expect(
      new RecoveryEvidenceReadbackReservationRepository(
        fixture.database,
      ).getByLogicalIdentity({
        taskId: fixture.uow.taskId,
        reviewId: fixture.uow.reviewId,
        evidenceSubmissionId:
          fixture.uow.evidenceSubmissionId,
        originalToolRunId:
          fixture.uow.originalToolRunId,
      }),
    ).toMatchObject({
      status: "abandoned",
      reservationVersion: 2,
    });
    expect(fixture.execute).not.toHaveBeenCalled();
    expect(fixture.snapshot().recoveryEvidenceReadbackRequests).toHaveLength(
      0,
    );
  });

  it("rejects invalid Original Unknown Write bindings before Host callbacks", async () => {
    const fixture = createServiceFixture("invalid-original");
    const before = fixture.snapshot();

    await expect(
      fixture.service.prepareReadback({
        ...fixture.input(),
        originalToolRunId: "different-write-run",
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_READBACK_PREPARATION_FAILED",
    });
    expect(fixture.resolveSource).not.toHaveBeenCalled();
    expect(fixture.buildArguments).not.toHaveBeenCalled();
    expect(fixture.snapshot().events).toHaveLength(
      before.events.length,
    );
  });

  it("rejects missing allowlist versions and resource schemes outside the immutable contract", async () => {
    const missing = createServiceFixture("missing-allowlist");
    await expect(
      missing.service.prepareReadback({
        ...missing.input(),
        allowlistId: "missing_allowlist",
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_ALLOWLIST_VERSION_UNAVAILABLE",
    });
    expect(missing.resolveSource).not.toHaveBeenCalled();

    const scheme = createServiceFixture("scheme", {
      resourceScheme: "ledger",
    });
    await expect(
      scheme.service.prepareReadback(scheme.input()),
    ).rejects.toMatchObject({
      code: "RECOVERY_READBACK_SOURCE_INVALID",
    });
    expect(scheme.execute).not.toHaveBeenCalled();
  });

  it("rejects new Requests under Cancel/Pause intent without Transaction A writes", async () => {
    for (const intent of ["cancel", "pause"] as const) {
      const fixture = createServiceFixture(`intent-${intent}`);
      setTaskIntent(fixture.database, fixture.uow.taskId, intent);
      const before = fixture.snapshot();

      await expect(
        fixture.service.prepareReadback(fixture.input()),
      ).rejects.toMatchObject({
        code: "RECOVERY_EVIDENCE_INTENT_BLOCKED",
      });
      const after = fixture.snapshot();
      expect(after.recoveryEvidenceReadbackRequests).toHaveLength(0);
      expect(after.executionPlans).toHaveLength(
        before.executionPlans.length,
      );
      expect(after.events).toHaveLength(before.events.length);
      expect(fixture.execute).not.toHaveBeenCalled();
    }
  });

  it("fails closed before callbacks on Review decision mismatch or stale Task version", async () => {
    const reviewMismatch = createServiceFixture(
      "review-version-mismatch",
    );
    await expect(
      reviewMismatch.service.prepareReadback({
        ...reviewMismatch.input(),
        expectedDecisionVersion: 0,
      }),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_REVIEW_BINDING_INVALID",
    });
    expect(reviewMismatch.resolveSource).not.toHaveBeenCalled();
    expect(reviewMismatch.buildArguments).not.toHaveBeenCalled();

    const staleTask = createServiceFixture("stale-task");
    const staleInput = staleTask.input();
    staleTask.database
      .prepare(
        "UPDATE tasks SET version = version + 1 WHERE id = ?",
      )
      .run(staleTask.uow.taskId);
    await expect(
      staleTask.service.prepareReadback(staleInput),
    ).rejects.toMatchObject({
      code: "TASK_STATE_CONFLICT",
    });
    expect(staleTask.resolveSource).not.toHaveBeenCalled();
  });

  it("rolls back every Transaction A write point on injected failure", async () => {
    const failures: Array<{
      readonly name: string;
      install: () => void;
    }> = [
      {
        name: "plan",
        install: () =>
          vi
            .spyOn(ExecutionPlanRepository.prototype, "insert")
            .mockImplementationOnce(() => {
              throw new Error("plan failure");
            }),
      },
      {
        name: "step",
        install: () =>
          vi
            .spyOn(PlanStepRepository.prototype, "insert")
            .mockImplementationOnce(() => {
              throw new Error("step failure");
            }),
      },
      {
        name: "tool-run",
        install: () =>
          vi
            .spyOn(ToolRunRepository.prototype, "createIntent")
            .mockImplementationOnce(() => {
              throw new Error("tool-run failure");
            }),
      },
      {
        name: "operation",
        install: () =>
          vi
            .spyOn(
              RecoveryReviewOperationRepository.prototype,
              "append",
            )
            .mockImplementationOnce(() => {
              throw new Error("operation failure");
            }),
      },
      {
        name: "request",
        install: () =>
          vi
            .spyOn(
              RecoveryEvidenceReadbackRequestRepository.prototype,
              "insert",
            )
            .mockImplementationOnce(() => {
              throw new Error("request failure");
            }),
      },
      {
        name: "attempt",
        install: () =>
          vi
            .spyOn(
              RecoveryEvidenceReadAttemptRepository.prototype,
              "insertPrepared",
            )
            .mockImplementationOnce(() => {
              throw new Error("attempt failure");
            }),
      },
      {
        name: "event",
        install: () =>
          vi
            .spyOn(EventRepository.prototype, "append")
            .mockImplementationOnce(() => {
              throw new Error("event failure");
            }),
      },
      {
        name: "checkpoint",
        install: () =>
          vi
            .spyOn(CheckpointStore.prototype, "append")
            .mockImplementationOnce(() => {
              throw new Error("checkpoint failure");
            }),
      },
      {
        name: "reservation-complete",
        install: () =>
          vi
            .spyOn(
              RecoveryEvidenceReadbackReservationRepository.prototype,
              "complete",
            )
            .mockImplementationOnce(() => {
              throw new Error("reservation complete failure");
            }),
      },
    ];

    for (const failure of failures) {
      const fixture = createServiceFixture(
        `fault-${failure.name}`,
      );
      const before = fixture.snapshot();
      failure.install();

      await expect(
        fixture.service.prepareReadback(fixture.input()),
      ).rejects.toMatchObject({
        code: "RECOVERY_EVIDENCE_READBACK_PREPARATION_FAILED",
      });
      vi.restoreAllMocks();

      const after = fixture.snapshot();
      expect(
        after.recoveryEvidenceReadbackRequests,
        failure.name,
      ).toHaveLength(0);
      expect(
        after.executionPlans.length,
        failure.name,
      ).toBe(before.executionPlans.length);
      expect(
        after.planSteps.length,
        failure.name,
      ).toBe(before.planSteps.length);
      expect(
        after.toolRuns.length,
        failure.name,
      ).toBe(before.toolRuns.length);
      expect(
        after.recoveryEvidenceReadAttempts.length,
        failure.name,
      ).toBe(before.recoveryEvidenceReadAttempts.length);
      expect(after.events.length, failure.name).toBe(
        before.events.length,
      );
      expect(after.checkpoints.length, failure.name).toBe(
        before.checkpoints.length,
      );
      expect(
        new RecoveryEvidenceReadbackReservationRepository(
          fixture.database,
        ).getByLogicalIdentity({
          taskId: fixture.uow.taskId,
          reviewId: fixture.uow.reviewId,
          evidenceSubmissionId:
            fixture.uow.evidenceSubmissionId,
          originalToolRunId:
            fixture.uow.originalToolRunId,
        })?.status,
        failure.name,
      ).toBe("abandoned");
    }
  });
});

interface ServiceFixture {
  readonly database: ForgeFlowDatabase;
  readonly uow: RecoveryEvidenceUowFixture;
  readonly service: RecoveryEvidenceReadbackService;
  readonly reservationUnitOfWork: RecoveryEvidenceReadbackReservationUnitOfWork;
  readonly allowlistId: string;
  readonly allowlistVersion: string;
  readonly verificationCheckId: string;
  readonly resolveSource: ReturnType<typeof vi.fn>;
  readonly buildArguments: ReturnType<typeof vi.fn>;
  readonly verifierBindingLookup: ReturnType<typeof vi.spyOn>;
  readonly execute: ReturnType<typeof vi.fn>;
  readonly input: () => PrepareRecoveryEvidenceReadbackInput;
  readonly inputIntent: () => {
    readonly reviewId: string;
    readonly evidenceSubmissionId: string;
    readonly originalToolRunId: string;
    readonly allowlistId: string;
    readonly verificationCheckId: string;
    readonly expectedDecisionVersion: number;
    readonly expectedResourceVersion: string | null;
    readonly expectedEtag: string | null;
  };
  readonly reservationAcquireInput: (suffix: string) => {
    readonly ownership: RecoveryEvidenceUowFixture["ownership"];
    readonly expectedTaskVersion: number;
    readonly requestIntent: ReturnType<ServiceFixture["inputIntent"]>;
    readonly requestId: string;
    readonly operationId: string;
    readonly executionPlanId: string;
    readonly planStepId: string;
    readonly readToolRunId: string;
    readonly readAttemptId: string;
  };
  readonly reservationIds: () => {
    readonly requestId: string | undefined;
    readonly operationId: string | undefined;
    readonly executionPlanId: string | undefined;
    readonly planStepId: string | undefined;
    readonly readToolRunId: string | undefined;
    readonly readAttemptId: string | undefined;
  };
  readonly snapshot: () => ReturnType<TaskSnapshotReader["load"]>;
}

const toolInputSchema = z
  .object({
    resourceRef: z.string().min(1),
    limit: z.number().int().positive(),
    expectedVersion: z.string().min(1).optional(),
    expectedEtag: z.string().min(1).optional(),
  })
  .strict();

const toolResultSchema = z
  .object({
    accepted: z.boolean(),
    receipt: z.string().min(1),
    resourceVersion: z.string().min(1).nullable(),
    resourceEtag: z.string().min(1).nullable(),
  })
  .strict();

function createServiceFixture(
  suffix: string,
  options: {
    readonly bindingActive?: boolean;
    readonly resourceScheme?: string;
  } = {},
): ServiceFixture {
  const activeDatabase = database as ForgeFlowDatabase;
  const uow = createRecoveryEvidenceUowFixture(
    activeDatabase,
    suffix,
  );
  const execute = vi.fn(async () => ({
    accepted: true,
    receipt: "receipt-1",
    resourceVersion: "7",
    resourceEtag: "etag-7",
  }));
  const tools = new ToolRegistry();
  tools.register({
    name: "inventory_lookup",
    description: "Read inventory state.",
    mode: "read",
    version: "1",
    timeoutMs: 1_000,
    inputSchema: toolInputSchema,
    execute,
  });
  const readbackRegistry = new RecoveryReadbackToolRegistry(tools);
  const resolveSource = vi.fn(
    (
      originalRun: {
        readonly taskId: string;
        readonly id: string;
      },
      evidence: {
        readonly taskId: string;
        readonly toolRunId: string;
        readonly resourceRef: string | null;
      },
    ) => {
      expect(originalRun.taskId).toBe(evidence.taskId);
      expect(originalRun.id).toBe(evidence.toolRunId);
      if (evidence.resourceRef === null) {
        throw new Error("Expected resource reference.");
      }
      return {
        resourceRef:
          options.resourceScheme === undefined
            ? evidence.resourceRef
            : `${options.resourceScheme}://part/STM32`,
        resourceVersionHint: "7",
        resourceEtagHint: "etag-7",
      };
    },
  );
  const buildArguments = vi.fn(
    (
      _evidence: unknown,
      context: {
        readonly expectedResourceVersion: string | null;
        readonly expectedEtag: string | null;
      },
      source: { readonly resourceRef: string },
    ) => ({
      resourceRef: source.resourceRef,
      limit: 10,
      ...(context.expectedResourceVersion === null
        ? {}
        : { expectedVersion: context.expectedResourceVersion }),
      ...(context.expectedEtag === null
        ? {}
        : { expectedEtag: context.expectedEtag }),
    }),
  );
  const allowlistMetadata = {
    protocolVersion:
      "forgeflow.recovery-readback-contract.v1" as const,
    allowlistId: `inventory_readback_${suffix}`,
    sourceResolverId: "inventory_source",
    sourceResolverVersion: "1",
    argumentBuilderId: "inventory_arguments",
    argumentBuilderVersion: "1",
    toolName: "inventory_lookup",
    toolVersion: "1",
    toolInputSchemaHash:
      computeToolInputSchemaHash(toolInputSchema),
    resultSchemaId: "inventory_result",
    resultSchemaVersion: "1",
    resultSchemaHash:
      computeToolInputSchemaHash(toolResultSchema),
    resourceMetadataExtractorId: "inventory_metadata",
    resourceMetadataExtractorVersion: "1",
    allowedResourceSchemes: ["inventory"],
    retrySafety: "version_conditional" as const,
    consistencyMode:
      "etag_or_resource_version" as const,
    timeoutMs: 1_000,
    maximumPayloadBytes: 4_096,
    sensitiveOutputPolicy: {
      classification: "internal" as const,
      mode: "allow" as const,
      redactionProfile: null,
    },
  };
  const allowlistVersion =
    computeRecoveryReadbackAllowlistVersion(allowlistMetadata);
  const {
    toolName,
    toolVersion,
    toolInputSchemaHash,
    ...allowlistContract
  } = allowlistMetadata;
  const definition: RecoveryReadbackToolDefinition = {
    ...allowlistContract,
    allowlistVersion,
    name: toolName,
    version: toolVersion,
    schemaHash: toolInputSchemaHash,
    mode: "read",
    inputSchema: toolInputSchema,
    resolveSource,
    buildArguments,
    resultSchema: toolResultSchema,
    extractResultMetadata: (result) => {
      const parsed = toolResultSchema.parse(result);
      return {
        resourceVersion: parsed.resourceVersion,
        resourceEtag: parsed.resourceEtag,
      };
    },
  };
  readbackRegistry.register(definition);
  const bindingProvider =
    new RecoveryVerifierHostBindingProvider([
      {
        verifierId: "host_verifier",
        verifierVersion: "1",
        timeoutMs: 1_000,
        ruleConfig: { ruleset: "readback" },
        active: options.bindingActive ?? true,
      },
    ]);
  const runtime = new RecoveryVerifierRuntime(
    new RecoveryVerifierRegistry(),
    bindingProvider,
  );
  const verifierBindingLookup = vi.spyOn(
    runtime,
    "getBindingForNewCheck",
  );
  const verificationCheckId = `service-check-${suffix}`;
  const service = new RecoveryEvidenceReadbackService({
    database: activeDatabase,
    leaseManager: uow.leaseManager,
    readbackToolRegistry: readbackRegistry,
    verifierRuntime: runtime,
    hostVerifierId: "host_verifier",
    hostActorId: "host-reviewer",
    hostAllowlistVersions: {
      [allowlistMetadata.allowlistId]: allowlistVersion,
    },
    assertAuthority: () => uow.authority.assertActive(),
    now: () => new Date("2026-11-08T00:00:00.000Z"),
  });
  const reservationUnitOfWork =
    new RecoveryEvidenceReadbackReservationUnitOfWork(
      activeDatabase,
      () => uow.authority.assertActive(),
      uow.leaseManager,
      { now: () => new Date("2026-11-08T00:00:00.000Z") },
    );
  const snapshotReader = new TaskSnapshotReader(activeDatabase);

  const inputIntent = () => ({
    reviewId: uow.reviewId,
    evidenceSubmissionId: uow.evidenceSubmissionId,
    originalToolRunId: uow.originalToolRunId,
    allowlistId: allowlistMetadata.allowlistId,
    verificationCheckId,
    expectedDecisionVersion: uow.expectedDecisionVersion,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
  });
  const input = (): PrepareRecoveryEvidenceReadbackInput => ({
    ownership: uow.ownership,
    expectedTaskVersion:
      snapshotReader.load(uow.taskId).task.version,
    reviewId: uow.reviewId,
    evidenceSubmissionId: uow.evidenceSubmissionId,
    originalToolRunId: uow.originalToolRunId,
    verificationCheckId,
    allowlistId: allowlistMetadata.allowlistId,
    expectedDecisionVersion: uow.expectedDecisionVersion,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
  });

  return {
    database: activeDatabase,
    uow,
    service,
    reservationUnitOfWork,
    allowlistId: allowlistMetadata.allowlistId,
    allowlistVersion,
    verificationCheckId,
    resolveSource,
    buildArguments,
    verifierBindingLookup,
    execute,
    input,
    inputIntent,
    reservationAcquireInput: (workerSuffix) => ({
      ownership: uow.ownership,
      expectedTaskVersion:
        snapshotReader.load(uow.taskId).task.version,
      requestIntent: inputIntent(),
      requestId: `reservation-request-${suffix}-${workerSuffix}`,
      operationId: `reservation-operation-${suffix}-${workerSuffix}`,
      executionPlanId: `reservation-plan-${suffix}-${workerSuffix}`,
      planStepId: `reservation-step-${suffix}-${workerSuffix}`,
      readToolRunId: `reservation-run-${suffix}-${workerSuffix}`,
      readAttemptId: `reservation-attempt-${suffix}-${workerSuffix}`,
    }),
    reservationIds: () => {
      const request = snapshotReader
        .load(uow.taskId)
        .recoveryEvidenceReadbackRequests.at(-1);
      return {
        requestId: request?.id,
        operationId: request?.operationId,
        executionPlanId: request?.executionPlanId,
        planStepId: request?.planStepId,
        readToolRunId: request?.readToolRunId,
        readAttemptId: request
          ? new RecoveryEvidenceReadAttemptRepository(
              activeDatabase,
            )
              .listByTask(uow.taskId)
              .find(
                (attempt) =>
                  attempt.readbackRequestId === request.id,
              )?.id
          : undefined,
      };
    },
    snapshot: () => snapshotReader.load(uow.taskId),
  };
}

function createHistoricalRequest(fixture: ServiceFixture) {
  const actorId = "host-reviewer";
  const readRun = fixture
    .snapshot()
    .toolRuns.find(
      (run) => run.id === fixture.uow.readToolRunId,
    );
  if (readRun === undefined) {
    throw new Error("Historical recovery read run is missing.");
  }
  const operationPayloadDigest =
    computeRecoveryEvidenceReadbackOperationPayloadDigest({
      evidenceSubmissionId: fixture.uow.evidenceSubmissionId,
      originalUnknownToolRunId:
        fixture.uow.originalToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
      allowlistId: fixture.allowlistId,
      allowlistVersion: fixture.allowlistVersion,
      readToolName: readRun.toolName,
      readToolVersion: readRun.toolVersion,
      readToolSchemaHash: readRun.inputSchemaHash,
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
      verificationCheckId: fixture.verificationCheckId,
      expectedDecisionVersion: fixture.uow.expectedDecisionVersion,
    });
  return fixture.uow.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
    {
      ownership: fixture.uow.ownership,
      expectedTaskVersion:
        fixture.snapshot().task.version,
      requestId: "historical-request",
      operationId: "historical-operation",
      readAttemptId: "historical-attempt",
      reviewId: fixture.uow.reviewId,
      evidenceSubmissionId: fixture.uow.evidenceSubmissionId,
      originalToolRunId: fixture.uow.originalToolRunId,
      expectedDecisionVersion: fixture.uow.expectedDecisionVersion,
      actorId,
      operationPayloadDigest,
      requestKey: computeRecoveryReviewOperationRequestKey({
        reviewId: fixture.uow.reviewId,
        expectedDecisionVersion:
          fixture.uow.expectedDecisionVersion,
        operation: "request_readback",
        operationPayloadDigest,
        actorId,
      }),
      executionPlanId: fixture.uow.executionPlanId,
      planStepId: fixture.uow.planStepId,
      readToolRunId: fixture.uow.readToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
      allowlistId: fixture.allowlistId,
      allowlistVersion: fixture.allowlistVersion,
      readToolName: readRun.toolName,
      readToolVersion: readRun.toolVersion,
      readToolSchemaHash: readRun.inputSchemaHash,
      retrySafety: "version_conditional",
      consistencyMode: "etag_or_resource_version",
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
      verificationCheckId: fixture.verificationCheckId,
    },
  ).request;
}

function setTaskIntent(
  activeDatabase: ForgeFlowDatabase,
  taskId: string,
  intent: "cancel" | "pause",
): void {
  const column =
    intent === "cancel"
      ? "cancel_requested_at"
      : "pause_requested_at";
  activeDatabase
    .prepare(
      `
        UPDATE tasks
        SET ${column} = ?, version = version + 1
        WHERE id = ?
      `,
    )
    .run("2026-11-08T00:00:01.000Z", taskId);
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
