import { afterEach, describe, expect, it } from "vitest";

import {
  PHASE3_STORAGE_MIGRATIONS,
  RecoveryEvidenceReadbackRequestRepository,
  TaskSnapshotReader,
  closeDatabase,
  computeRecoveryEvidenceReadbackOperationPayloadDigest,
  migrateStorage,
  openDatabase,
  runMigrations,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { computeRecoveryReviewOperationRequestKey } from "../../src/storage/recovery-review-operation-keys.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";
import {
  createRecoveryEvidenceUowFixture,
} from "./recovery-evidence-uow-fixture.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("Step 6.3.4.4 reservation schema", () => {
  it("upgrades v8 to v9 and creates reservation constraints with triggers", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(
      activeDatabase,
      PHASE3_STORAGE_MIGRATIONS.slice(0, 8),
    );

    expect(migrateStorage(activeDatabase)).toMatchObject({
      appliedVersions: [9, 10, 11, 12],
      currentVersion: 12,
    });
    expect(
      activeDatabase.pragma(
        "table_info(recovery_evidence_readback_request_reservations)",
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "request_intent_digest" }),
        expect.objectContaining({ name: "owner_token" }),
        expect.objectContaining({ name: "owner_fencing_token" }),
        expect.objectContaining({ name: "reservation_version" }),
      ]),
    );
    expect(
      activeDatabase
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'trigger'
              AND name IN (
                'recovery_evidence_readback_reservations_validate_insert',
                'recovery_evidence_readback_reservations_validate_transition',
                'recovery_evidence_readback_reservations_reject_delete'
              )
            ORDER BY name
          `,
        )
        .all(),
    ).toHaveLength(3);
    expect(
      activeDatabase.prepare(
        "PRAGMA foreign_key_check(recovery_evidence_readback_request_reservations)",
      ).all(),
    ).toEqual([]);
    const uniqueIndexes = uniqueIndexColumnSets(
      activeDatabase,
      "recovery_evidence_readback_request_reservations",
    );
    expect(uniqueIndexes).toEqual(
      expect.arrayContaining([
        [
          "task_id",
          "review_id",
          "evidence_submission_id",
          "original_tool_run_id",
        ],
        ["task_id", "verification_check_id"],
        ["request_id"],
        ["operation_id"],
        ["execution_plan_id"],
        ["plan_step_id"],
        ["read_tool_run_id"],
        ["read_attempt_id"],
      ]),
    );
  });

  it("rolls back v9 when reservation schema creation fails", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(
      activeDatabase,
      PHASE3_STORAGE_MIGRATIONS.slice(0, 8),
    );
    activeDatabase.exec(
      "CREATE TABLE recovery_evidence_readback_request_reservations (id TEXT PRIMARY KEY)",
    );

    expect(() => migrateStorage(activeDatabase)).toThrow(
      /already exists/i,
    );
    expect(
      activeDatabase
        .prepare("SELECT MAX(version) AS version FROM schema_migrations")
        .get(),
    ).toEqual({ version: 8 });
    expect(
      activeDatabase
        .prepare(
          `
            SELECT COUNT(*) AS count
            FROM sqlite_master
            WHERE name =
              'ix_recovery_evidence_readback_reservations_task_status'
          `,
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("keeps historical v8 Requests readable without backfilled Reservations", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const activeDatabase = database;
    runMigrations(
      activeDatabase,
      PHASE3_STORAGE_MIGRATIONS.slice(0, 8),
    );
    // The historical fixture uses today's TaskRepository while deliberately
    // keeping migration history at v8. Add the future nullable column only for
    // fixture construction, then remove it so migrateStorage still exercises v10.
    activeDatabase.exec("ALTER TABLE tasks ADD COLUMN max_tokens INTEGER");
    const fixture = createRecoveryEvidenceUowFixture(
      activeDatabase,
      "reservation-history",
    );
    const input = createHistoricalRequestInput(fixture);
    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceReadbackRequest(
        input,
      );
    activeDatabase.exec("ALTER TABLE tasks DROP COLUMN max_tokens");

    migrateStorage(activeDatabase);

    expect(
      activeDatabase
        .prepare(
          "SELECT COUNT(*) AS count FROM recovery_evidence_readback_request_reservations",
        )
        .get(),
    ).toEqual({ count: 0 });
    const repository = new RecoveryEvidenceReadbackRequestRepository(
      activeDatabase,
    );
    expect(
      repository.getByLogicalIdentity({
        taskId: fixture.taskId,
        reviewId: fixture.reviewId,
        evidenceSubmissionId: fixture.evidenceSubmissionId,
        originalToolRunId: fixture.originalToolRunId,
      }),
    ).toMatchObject({
      id: created.request.id,
      operationId: created.operation.id,
      readToolRunId: fixture.readToolRunId,
      verificationCheckId: fixture.verificationCheckId,
    });
  });
});

function createHistoricalRequestInput(
  fixture: ReturnType<typeof createRecoveryEvidenceUowFixture>,
) {
  const actorId = "reviewer-host";
  const operationPayloadDigest =
    computeRecoveryEvidenceReadbackOperationPayloadDigest({
      evidenceSubmissionId: fixture.evidenceSubmissionId,
      originalUnknownToolRunId: fixture.originalToolRunId,
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("7"),
      allowlistId: "inventory_readback",
      allowlistVersion: "1",
      readToolName: "inventory_lookup",
      readToolVersion: "1",
      readToolSchemaHash: digest("3"),
      expectedResourceVersion: "7",
      expectedEtag: "etag-7",
      verificationCheckId: fixture.verificationCheckId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
    });
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: new TaskSnapshotReader(
      fixture.database,
    ).load(fixture.taskId).task.version,
    requestId: "history-request",
    operationId: "history-operation",
    readAttemptId: "history-attempt",
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    expectedDecisionVersion: fixture.expectedDecisionVersion,
    actorId,
    operationPayloadDigest,
    requestKey: computeRecoveryReviewOperationRequestKey({
      reviewId: fixture.reviewId,
      expectedDecisionVersion: fixture.expectedDecisionVersion,
      operation: "request_readback",
      operationPayloadDigest,
      actorId,
    }),
    executionPlanId: fixture.executionPlanId,
    planStepId: fixture.planStepId,
    readToolRunId: fixture.readToolRunId,
    verifierId: "host_verifier",
    verifierVersion: "1",
    verifierConfigDigest: digest("7"),
    allowlistId: "inventory_readback",
    allowlistVersion: "1",
    readToolName: "inventory_lookup",
    readToolVersion: "1",
    readToolSchemaHash: digest("3"),
    retrySafety: "version_conditional" as const,
    consistencyMode: "etag_or_resource_version" as const,
    expectedResourceVersion: "7",
    expectedEtag: "etag-7",
    verificationCheckId: fixture.verificationCheckId,
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}

function uniqueIndexColumnSets(
  activeDatabase: ForgeFlowDatabase,
  table: string,
): string[][] {
  const indexes = activeDatabase.pragma(
    `index_list(${table})`,
  ) as Array<{ name: string; unique: number }>;
  return indexes
    .filter((index) => index.unique === 1)
    .map((index) =>
      (
        activeDatabase.pragma(
          `index_info(${index.name})`,
        ) as Array<{ name: string }>
      ).map((column) => column.name),
    );
}
