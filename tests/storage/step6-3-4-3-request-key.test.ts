import { afterEach, describe, expect, it, vi } from "vitest";

import {
  TaskSnapshotReader,
  closeDatabase,
  computeRecoveryEvidenceVerificationRequestKey,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  canonicalRecoveryEvidenceVerificationRequestKeyInput,
} from "../../src/storage/recovery-evidence-verification-keys.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";
import {
  createRecoveryEvidenceUowFixture,
  type RecoveryEvidenceUowFixture,
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

describe("Step 6.3.4.3 verification request key", () => {
  it("canonicalizes Stored V0 readback fields as explicit nulls", () => {
    const fixture = openFixture("request-key-null");
    const input = requestKeyInput(fixture, "check-null");

    const canonical =
      canonicalRecoveryEvidenceVerificationRequestKeyInput(input);
    for (const field of [
      "allowlistId",
      "allowlistVersion",
      "readToolName",
      "readToolVersion",
      "readToolSchemaHash",
    ]) {
      expect(canonical).toContain(`"${field}":null`);
    }
    expect(computeRecoveryEvidenceVerificationRequestKey(input)).toBe(
      computeRecoveryEvidenceVerificationRequestKey({ ...input }),
    );
  });

  it("uses persisted V1 binding when Check ID exists despite current V2 config", () => {
    const fixture = openFixture("request-key-v1");
    const v1 = checkInput(fixture, "check-v1");
    const created =
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(v1);
    const before = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    const v2 = checkInput(fixture, "check-v1", {
      verifierVersion: "2",
      verifierConfigDigest: digest("8"),
    });

    const replayed =
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(v2);
    expect(replayed).toMatchObject({
      replayed: true,
      state: "pending",
      verification: null,
      check: {
        id: created.check.id,
        verifierVersion: "1",
        verifierConfigDigest: digest("6"),
        requestKey: created.check.requestKey,
      },
    });
    const after = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(after.recoveryEvidenceVerificationChecks).toHaveLength(1);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  });

  it("returns persisted Verification result for Check replay", () => {
    const fixture = openFixture("request-key-verification");
    const input = checkInput(fixture, "check-with-verification");
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(input);
    fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
      ownership: fixture.ownership,
      expectedTaskVersion: currentTaskVersion(fixture),
      verificationId: "verification-replay",
      verificationCheckId: input.verificationCheckId,
      requestKey: input.requestKey,
      readbackResultProvenance: "declared_payload",
      availabilityStatus: "available",
      integrityStatus: "matched",
      authenticityStatus: "unverified",
      verificationStatus: "not_run",
      observedPayloadDigest: digest("c"),
      reasonCode: "VERIFIER_NOT_EXECUTED",
      redactedSummary: null,
    });

    const replayed =
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(fixture, "check-with-verification", {
          verifierVersion: "2",
          verifierConfigDigest: digest("8"),
        }),
      );
    expect(replayed).toMatchObject({
      replayed: true,
      state: "verification",
      verification: {
        id: "verification-replay",
        verificationCheckId: input.verificationCheckId,
      },
    });
  });

  it("resolves a stale Snapshot race inside the UoW transaction", () => {
    const fixture = openFixture("request-key-race");
    const staleSnapshot = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(staleSnapshot.recoveryEvidenceVerificationChecks).toHaveLength(0);
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
      checkInput(fixture, "check-race"),
    );

    const concurrent = fixture.unitOfWork
      .createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(fixture, "check-race", {
          verifierVersion: "2",
          verifierConfigDigest: digest("8"),
        }),
      );
    expect(concurrent).toMatchObject({
      state: "pending",
      check: {
        verifierVersion: "1",
        verifierConfigDigest: digest("6"),
      },
    });
  });

  it("allows the same Check ID across different Tasks", () => {
    const first = openFixture("request-key-task-a");
    const second = createRecoveryEvidenceUowFixture(
      first.database,
      "request-key-task-b",
    );
    const firstCheck =
      first.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(first, "shared-check-id"),
      );
    const secondCheck =
      second.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(second, "shared-check-id"),
      );

    expect(firstCheck.check.taskId).toBe(first.taskId);
    expect(secondCheck.check.taskId).toBe(second.taskId);
    expect(firstCheck.check.requestKey).not.toBe(
      secondCheck.check.requestKey,
    );
  });

  it("rejects the same Check ID with different logical identity", () => {
    const fixture = openFixture("request-key-conflict");
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
      checkInput(fixture, "check-conflict"),
    );
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(fixture, "check-conflict", {
          reviewId: "different-review",
        }),
      ),
    ).toThrow(/different logical identity|CHECK_ID_CONFLICT/i);
  });

  it("allows existing Check replay but blocks a new Check under cancel intent", () => {
    const fixture = openFixture("request-key-cancel");
    const existing = checkInput(fixture, "check-before-cancel");
    fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(existing);
    fixture.database
      .prepare(
        `
          UPDATE tasks
          SET cancel_requested_at = ?, version = version + 1
          WHERE id = ?
        `,
      )
      .run("2026-11-08T01:00:00.000Z", fixture.taskId);

    expect(
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(fixture, "check-before-cancel", {
          verifierVersion: "2",
          verifierConfigDigest: digest("8"),
        }),
      ),
    ).toMatchObject({
      replayed: true,
      state: "pending",
      check: { verifierVersion: "1" },
    });
    expect(() =>
      fixture.unitOfWork.createOwnedRecoveryEvidenceVerificationCheck(
        checkInput(fixture, "check-after-cancel"),
      ),
    ).toThrow(/cancel|pause|intent/i);
  });

  it("resolves the host binding lazily only after transactional Check ID miss", () => {
    const fixture = openFixture("lazy-binding");
    const firstProvider = vi.fn(() => ({
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
    }));
    const first =
      fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        lazyCheckInput(fixture, "check-lazy"),
        firstProvider,
      );
    expect(first.state).toBe("created");
    expect(firstProvider).toHaveBeenCalledTimes(1);

    const replayProvider = vi.fn(() => {
      throw new Error("current host binding must not execute");
    });
    const pending =
      fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        lazyCheckInput(fixture, "check-lazy"),
        replayProvider,
      );
    expect(pending).toMatchObject({
      state: "pending",
      replayed: true,
      check: {
        verifierId: "host_verifier",
        verifierVersion: "1",
        verifierConfigDigest: digest("6"),
      },
    });
    expect(replayProvider).not.toHaveBeenCalled();

    fixture.unitOfWork.recordOwnedRecoveryEvidenceVerification({
      ownership: fixture.ownership,
      expectedTaskVersion: currentTaskVersion(fixture),
      verificationId: "verification-lazy",
      verificationCheckId: "check-lazy",
      requestKey: first.check.requestKey,
      readbackResultProvenance: "declared_payload",
      availabilityStatus: "available",
      integrityStatus: "matched",
      authenticityStatus: "unverified",
      verificationStatus: "passed",
      observedPayloadDigest: digest("c"),
      reasonCode: "EXPECTED_STATE",
      redactedSummary: "Expected state.",
    });
    expect(
      fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        lazyCheckInput(fixture, "check-lazy"),
        replayProvider,
      ),
    ).toMatchObject({
      state: "verification",
      replayed: true,
      verification: { id: "verification-lazy" },
    });
    expect(replayProvider).not.toHaveBeenCalled();
  });

  it("rolls back a lazy binding failure without Check, Event, or Checkpoint writes", () => {
    const fixture = openFixture("lazy-binding-failure");
    const before = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );

    expect(() =>
      fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        lazyCheckInput(fixture, "check-lazy-failure"),
        () => {
          throw new Error("host binding exploded with a secret");
        },
      ),
    ).toThrow(/host binding is unavailable/i);

    const after = new TaskSnapshotReader(fixture.database).load(
      fixture.taskId,
    );
    expect(after.recoveryEvidenceVerificationChecks).toHaveLength(0);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
  });

  it("checks authority before lazy binding and rejects Check identity conflicts before the provider", () => {
    const fixture = openFixture("lazy-binding-authority");
    fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
      lazyCheckInput(fixture, "check-lazy-existing"),
      () => ({
        verifierId: "host_verifier",
        verifierVersion: "1",
        verifierConfigDigest: digest("6"),
      }),
    );
    const conflictProvider = vi.fn(() => ({
      verifierId: "host_verifier",
      verifierVersion: "2",
      verifierConfigDigest: digest("8"),
    }));
    expect(() =>
      fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        lazyCheckInput(fixture, "check-lazy-existing", {
          reviewId: "different-review",
        }),
        conflictProvider,
      ),
    ).toThrow(/different logical identity|CHECK_ID_CONFLICT/i);
    expect(conflictProvider).not.toHaveBeenCalled();

    fixture.authority.revoke(new Error("heartbeat failed"));
    const authorityProvider = vi.fn(() => ({
      verifierId: "host_verifier",
      verifierVersion: "1",
      verifierConfigDigest: digest("6"),
    }));
    expect(() =>
      fixture.unitOfWork.createOwnedStoredEvidenceVerificationCheck(
        lazyCheckInput(fixture, "check-authority-lazy"),
        authorityProvider,
      ),
    ).toThrow(/authority/i);
    expect(authorityProvider).not.toHaveBeenCalled();
  });
});

function openFixture(suffix: string): RecoveryEvidenceUowFixture {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  return createRecoveryEvidenceUowFixture(database, suffix);
}

function checkInput(
  fixture: RecoveryEvidenceUowFixture,
  verificationCheckId: string,
  overrides: {
    readonly reviewId?: string;
    readonly verifierVersion?: string;
    readonly verifierConfigDigest?: string;
  } = {},
) {
  const reviewId = overrides.reviewId ?? fixture.reviewId;
  const verifierVersion = overrides.verifierVersion ?? "1";
  const verifierConfigDigest =
    overrides.verifierConfigDigest ?? digest("6");
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: currentTaskVersion(fixture),
    checkRecordId: `${fixture.taskId}-${verificationCheckId}-record`,
    reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    verificationCheckId,
    requestKey: computeRecoveryEvidenceVerificationRequestKey(
      requestKeyInput(
        fixture,
        verificationCheckId,
        reviewId,
        verifierVersion,
        verifierConfigDigest,
      ),
    ),
    checkOrigin: "stored_evidence_v0" as const,
    verifierId: "host_verifier",
    verifierVersion,
    verifierConfigDigest,
    allowlistId: null,
    allowlistVersion: null,
    readToolName: null,
    readToolVersion: null,
    readToolSchemaHash: null,
    expectedPayloadDigest: digest("c"),
  };
}

function requestKeyInput(
  fixture: RecoveryEvidenceUowFixture,
  verificationCheckId: string,
  reviewId = fixture.reviewId,
  verifierVersion = "1",
  verifierConfigDigest = digest("6"),
) {
  return {
    taskId: fixture.taskId,
    reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    verificationCheckId,
    checkOrigin: "stored_evidence_v0" as const,
    verifierId: "host_verifier",
    verifierVersion,
    verifierConfigDigest,
    allowlistId: null,
    allowlistVersion: null,
    readToolName: null,
    readToolVersion: null,
    readToolSchemaHash: null,
    expectedPayloadDigest: digest("c"),
  };
}

function currentTaskVersion(
  fixture: RecoveryEvidenceUowFixture,
): number {
  return new TaskSnapshotReader(fixture.database).load(fixture.taskId)
    .task.version;
}

function lazyCheckInput(
  fixture: RecoveryEvidenceUowFixture,
  verificationCheckId: string,
  overrides: {
    readonly reviewId?: string;
  } = {},
) {
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: currentTaskVersion(fixture),
    checkRecordId: `record-${verificationCheckId}`,
    reviewId: overrides.reviewId ?? fixture.reviewId,
    evidenceSubmissionId: fixture.evidenceSubmissionId,
    originalToolRunId: fixture.originalToolRunId,
    verificationCheckId,
    expectedPayloadDigest: digest("c"),
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
