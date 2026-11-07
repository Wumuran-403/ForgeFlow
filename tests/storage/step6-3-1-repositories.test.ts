import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ModelResponse } from "../../src/provider/types.js";
import {
  closeDatabase,
  EventRepository,
  ExecutionPlanRepository,
  ExecutionUnitOfWork,
  MessageRepository,
  migrateStorage,
  openDatabase,
  PlanStepRepository,
  RecoveryEvidenceReadRepository,
  RecoveryLegacyAttestationRepository,
  RecoveryReviewOperationRepository,
  RecoveryReviewRepository,
  runInTransaction,
  SequenceAllocator,
  TaskSnapshotReader,
  ToolRunRepository,
  type ForgeFlowDatabase,
  type SynchronousOperation,
} from "../../src/storage/index.js";
import {
  createStorageWritePermit,
  type StorageWritePermit,
} from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

beforeEach(() => {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
});

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("Step 6.3.1 repositories and snapshot", () => {
  it("persists purpose-aware plans and recovery evidence rows in one snapshot", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createEvidenceFixture(activeDatabase);
    const plans = new ExecutionPlanRepository(activeDatabase);

    expect(plans.listAgentByTask("task-evidence").map((plan) => plan.id)).toEqual([
      "agent-plan",
    ]);
    expect(
      plans.listRecoveryEvidenceByTask("task-evidence").map((plan) => plan.id),
    ).toEqual(["evidence-plan"]);
    expect(
      plans.getLatestByPurpose("task-evidence", "agent"),
    ).toMatchObject({
      id: "agent-plan",
      purpose: "agent",
    });

    const reader = new TaskSnapshotReader(activeDatabase);
    const databasePrototype = Object.getPrototypeOf(
      activeDatabase,
    ) as {
      transaction: ForgeFlowDatabase["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionCount = 0;
    databasePrototype.transaction = function (
      this: ForgeFlowDatabase,
      ...args: Parameters<ForgeFlowDatabase["transaction"]>
    ) {
      transactionCount += 1;
      return originalTransaction.apply(this, args);
    };

    let snapshot;
    try {
      snapshot = reader.load("task-evidence");
    } finally {
      databasePrototype.transaction = originalTransaction;
    }

    expect(transactionCount).toBe(1);
    expect(snapshot.executionPlans).toHaveLength(2);
    expect(snapshot.agentExecutionPlans).toEqual([
      expect.objectContaining({
        id: "agent-plan",
        purpose: "agent",
      }),
    ]);
    expect(snapshot.recoveryEvidencePlans).toEqual([
      expect.objectContaining({
        id: "evidence-plan",
        purpose: "recovery_evidence",
      }),
    ]);
    expect(
      snapshot.recoveryReviews.find(
        (review) => review.id === fixture.v1ReviewId,
      ),
    ).toMatchObject({
      status: "pending",
      reviewProtocolVersion: 1,
      decisionVersion: 0,
      evidencePayloadDigest: digest("a"),
      evidencePayloadType: "json",
      evidenceDigestProtocol: "jcs-sha256-v1",
      evidenceEnvelopeDigest: digest("b"),
      actorId: "reviewer-host",
      verifierId: null,
      verificationId: null,
      sourceObservedAt: timestamp,
      submittedAt: timestamp,
      verifiedAt: null,
    });
    expect(snapshot.recoveryEvidenceReads).toEqual([
      expect.objectContaining({
        taskId: "task-evidence",
        reviewId: fixture.v1ReviewId,
        toolRunId: "evidence-run",
      }),
    ]);
    expect(snapshot.recoveryLegacyAttestations).toEqual([
      expect.objectContaining({
        taskId: "task-evidence",
        originalReviewId: fixture.legacyReviewId,
        result: "confirms_original",
      }),
    ]);
    expect(snapshot.recoveryReviewOperations).toEqual([
      expect.objectContaining({
        taskId: "task-evidence",
        reviewId: fixture.v1ReviewId,
        operation: "request_readback",
        expectedDecisionVersion: 0,
        resultingDecisionVersion: 1,
        resultPlanId: "evidence-plan",
        resultToolRunId: "evidence-run",
        appliedEventId: fixture.eventId,
      }),
    ]);
  });

  it("confines the legacy decision repository method to protocol v0", () => {
    const activeDatabase = database as ForgeFlowDatabase;
    const fixture = createEvidenceFixture(activeDatabase);

    expect(() =>
      writeWithPermit(activeDatabase, (permit) =>
        new RecoveryReviewRepository(activeDatabase).decide(
          fixture.v1ReviewId,
          {
            status: "unresolved",
            note: "Protocol v1 decisions require the owned entry point.",
            sourceType: "manual_review",
            evidenceRef: "audit://review/update",
            decidedAt: timestamp,
          },
          permit,
        ),
      ),
    ).toThrowError(/not active/i);
  });
});

interface EvidenceFixture {
  readonly v1ReviewId: string;
  readonly legacyReviewId: string;
  readonly eventId: string;
}

function createEvidenceFixture(
  database: ForgeFlowDatabase,
): EvidenceFixture {
  const unitOfWork = new ExecutionUnitOfWork(database);
  unitOfWork.createTask({
    taskId: "task-evidence",
    traceId: "trace-evidence",
    objective: "Persist recovery evidence contract rows",
    systemPrompt: "You are ForgeFlow.",
    maxModelTurns: 10,
    maxToolCalls: 20,
  });
  const modelCall = unitOfWork.beginModelCall(modelRequest);
  unitOfWork.completeModelCall({
    modelCallId: modelCall.id,
    response: modelResponse,
    durationMs: 10,
  });

  const plans = new ExecutionPlanRepository(database);
  const steps = new PlanStepRepository(database);
  const toolRuns = new ToolRunRepository(database);
  const reviews = new RecoveryReviewRepository(database);
  const messages = new MessageRepository(database, new SequenceAllocator(database));
  const events = new EventRepository(database, new SequenceAllocator(database));

  const v1ReviewId = "review-v1";
  const legacyReviewId = "review-legacy";
  let eventId = "";

  writeWithPermit(database, (permit) => {
    plans.insert(
      {
        id: "agent-plan",
        taskId: "task-evidence",
        version: 1,
        sourceModelCallId: modelCall.id,
        purpose: "agent",
        status: "active",
        createdAt: timestamp,
      },
      permit,
    );
    steps.insert(
      {
        id: "agent-step",
        taskId: "task-evidence",
        planId: "agent-plan",
        stepIndex: 0,
        kind: "write",
        status: "waiting_review",
        createdAt: timestamp,
      },
      permit,
    );
    const originalRun = toolRuns.createIntent(
      {
        id: "original-write-run",
        taskId: "task-evidence",
        planStepId: "agent-step",
        toolCallId: "call-original-write",
        originalIndex: 0,
        toolName: "bom_update",
        toolVersion: "1",
        inputSchemaHash: digest("1"),
        canonicalInputHash: digest("2"),
        mode: "write",
        requiresApproval: true,
        status: "queued",
        input: {},
        idempotencyKey: digest("3"),
        attemptNo: 1,
        createdAt: timestamp,
      },
      permit,
    );
    toolRuns.transition(
      originalRun.id,
      ["queued"],
      {
        status: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
      },
      permit,
    );
    toolRuns.transition(
      originalRun.id,
      ["running"],
      {
        status: "unknown",
        finishedAt: timestamp,
        updatedAt: timestamp,
        error: {
          code: "WRITE_OUTCOME_UNKNOWN",
          message: "Write outcome is unknown.",
          details: [],
        },
      },
      permit,
    );
    messages.append(
      {
        taskId: "task-evidence",
        role: "tool",
        toolCallId: originalRun.toolCallId,
        content: '{"status":"unknown"}',
      },
      timestamp,
      permit,
    );
    reviews.createPending(
      {
        id: v1ReviewId,
        taskId: "task-evidence",
        toolRunId: originalRun.id,
        note: "Protocol v1 evidence review.",
        reviewProtocolVersion: 1,
        decisionVersion: 0,
        evidencePayloadDigest: digest("a"),
        evidencePayloadType: "json",
        evidenceDigestProtocol: "jcs-sha256-v1",
        evidenceEnvelopeDigest: digest("b"),
        actorId: "reviewer-host",
        verifierId: null,
        verificationId: null,
        sourceObservedAt: timestamp,
        submittedAt: timestamp,
        verifiedAt: null,
        createdAt: timestamp,
      },
      permit,
    );

    steps.insert(
      {
        id: "legacy-step",
        taskId: "task-evidence",
        planId: "agent-plan",
        stepIndex: 1,
        kind: "write",
        status: "waiting_review",
        createdAt: timestamp,
      },
      permit,
    );
    const legacyRun = toolRuns.createIntent(
      {
        id: "legacy-write-run",
        taskId: "task-evidence",
        planStepId: "legacy-step",
        toolCallId: "call-legacy-write",
        originalIndex: 1,
        toolName: "bom_update",
        toolVersion: "1",
        inputSchemaHash: digest("4"),
        canonicalInputHash: digest("5"),
        mode: "write",
        requiresApproval: true,
        status: "queued",
        input: {},
        idempotencyKey: digest("6"),
        attemptNo: 1,
        createdAt: timestamp,
      },
      permit,
    );
    toolRuns.transition(
      legacyRun.id,
      ["queued"],
      {
        status: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
      },
      permit,
    );
    toolRuns.transition(
      legacyRun.id,
      ["running"],
      {
        status: "unknown",
        finishedAt: timestamp,
        updatedAt: timestamp,
        error: {
          code: "WRITE_OUTCOME_UNKNOWN",
          message: "Write outcome is unknown.",
          details: [],
        },
      },
      permit,
    );
    messages.append(
      {
        taskId: "task-evidence",
        role: "tool",
        toolCallId: legacyRun.toolCallId,
        content: '{"status":"unknown"}',
      },
      timestamp,
      permit,
    );
    reviews.createPending(
      {
        id: legacyReviewId,
        taskId: "task-evidence",
        toolRunId: legacyRun.id,
        note: "Legacy review.",
        createdAt: timestamp,
      },
      permit,
    );

    plans.insert(
      {
        id: "evidence-plan",
        taskId: "task-evidence",
        version: 2,
        sourceModelCallId: modelCall.id,
        purpose: "recovery_evidence",
        status: "active",
        createdAt: timestamp,
      },
      permit,
    );
    steps.insert(
      {
        id: "evidence-step",
        taskId: "task-evidence",
        planId: "evidence-plan",
        stepIndex: 0,
        kind: "read_batch",
        status: "running",
        createdAt: timestamp,
      },
      permit,
    );
    const evidenceRun = toolRuns.createIntent(
      {
        id: "evidence-run",
        taskId: "task-evidence",
        planStepId: "evidence-step",
        toolCallId: "evidence-call",
        originalIndex: 0,
        toolName: "ledger.read",
        toolVersion: "1",
        inputSchemaHash: digest("7"),
        canonicalInputHash: digest("8"),
        mode: "read",
        requiresApproval: false,
        status: "queued",
        input: {},
        idempotencyKey: digest("9"),
        attemptNo: 1,
        createdAt: timestamp,
      },
      permit,
    );
    toolRuns.transition(
      evidenceRun.id,
      ["queued"],
      {
        status: "running",
        startedAt: timestamp,
        updatedAt: timestamp,
      },
      permit,
    );
    toolRuns.transition(
      evidenceRun.id,
      ["running"],
      {
        status: "succeeded",
        output: { accepted: true },
        finishedAt: timestamp,
        updatedAt: timestamp,
      },
      permit,
    );
    messages.append(
      {
        taskId: "task-evidence",
        role: "tool",
        toolCallId: evidenceRun.toolCallId,
        content: '{"status":"succeeded"}',
      },
      timestamp,
      permit,
    );
    steps.updateStatus(
      evidenceRun.planStepId,
      "completed",
      timestamp,
      permit,
    );

    new RecoveryEvidenceReadRepository(database).insert(
      {
        id: "evidence-read",
        taskId: "task-evidence",
        reviewId: v1ReviewId,
        toolRunId: evidenceRun.id,
        evidenceEnvelopeDigest: digest("b"),
        createdAt: timestamp,
      },
      permit,
    );
    new RecoveryLegacyAttestationRepository(database).append(
      {
        id: "legacy-attestation",
        taskId: "task-evidence",
        originalReviewId: legacyReviewId,
        attestationVersion: 1,
        requestKey: digest("c"),
        evidenceEnvelopeDigest: digest("d"),
        evidenceRef: "audit://legacy/attestation",
        sourceType: "manual_review",
        actorId: "reviewer-host",
        verifierId: null,
        verificationId: null,
        sourceObservedAt: timestamp,
        submittedAt: timestamp,
        verifiedAt: timestamp,
        result: "confirms_original",
        createdAt: timestamp,
      },
      permit,
    );
    const event = events.append(
      {
        taskId: "task-evidence",
        traceId: "trace-evidence",
        type: "recovery.readback_requested",
        entityType: "recovery_review",
        entityId: v1ReviewId,
        payload: { operation: "request_readback" },
      },
      timestamp,
      permit,
    );
    new RecoveryReviewOperationRepository(database).append(
      {
        id: "readback-operation",
        taskId: "task-evidence",
        reviewId: v1ReviewId,
        requestKey: digest("e"),
        operation: "request_readback",
        expectedDecisionVersion: 0,
        resultingDecisionVersion: 1,
        status: "applied",
        evidenceEnvelopeDigest: null,
        resultPlanId: "evidence-plan",
        resultToolRunId: "evidence-run",
        appliedEventId: event.id,
        createdAt: timestamp,
      },
      permit,
    );
    eventId = event.id;
  });

  return {
    v1ReviewId,
    legacyReviewId,
    eventId,
  };
}

function writeWithPermit<T>(
  database: ForgeFlowDatabase,
  operation: SynchronousOperation<T, [StorageWritePermit]>,
): T {
  return runInTransaction(
    database,
    () => operation(createStorageWritePermit(database)),
    "immediate",
  );
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

const timestamp = "2026-01-01T00:00:00.000Z";
const modelRequest: Parameters<ExecutionUnitOfWork["beginModelCall"]>[0] = {
  taskId: "task-evidence",
  iteration: 1,
  request: {
    model: "mock-model",
    messages: [{ role: "user", content: "Persist evidence." }],
    tools: [],
  },
};
const modelResponse: ModelResponse = {
  message: {
    role: "assistant",
    content: "Evidence fixture prepared.",
  },
  usage: { source: "provider" },
};
