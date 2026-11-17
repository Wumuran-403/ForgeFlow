import {
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ExecutionAuthority } from "../../src/persistence/index.js";
import {
  FileEvidencePayloadStore,
  RecoveryEvidenceVerificationService,
  RecoveryVerifierHostBindingProvider,
  RecoveryVerifierRegistry,
  RecoveryVerifierRuntime,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  type EvidencePayloadStore,
  type RecoveryVerifierDefinition,
  type RecoveryVerifierHostBindingDefinition,
  type RecoveryVerifierResult,
} from "../../src/recovery/index.js";
import {
  EventRepository,
  SequenceAllocator,
  TaskLeaseManager,
  TaskSnapshotReader,
  closeDatabase,
  migrateStorage,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
  type RecoveryEvidencePayloadType,
  type RecoveryReviewSource,
} from "../../src/storage/index.js";
import { RecoveryReviewOperationRepository } from "../../src/storage/recovery-review-operation-repository.js";
import { RecoveryEvidenceSubmissionRepository } from "../../src/storage/recovery-evidence-submission-repository.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import { computeCanonicalInputHash } from "../../src/tools/fingerprint.js";
import { canonicalJson } from "../../src/shared/canonical-json.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "../storage/test-database.js";
import {
  createRecoveryReviewFixture,
} from "./review-operation-fixture.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

beforeEach(() => {
  fixtureActions.clear();
  latestFixtureAction = undefined;
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("RecoveryEvidenceVerificationService", () => {
  it("persists passed evidence verification with availability and verification events", async () => {
    const fixture = createFixture("passed", {
      payload: jsonPayloadSpec({
        accepted: true,
        secret: "PAYLOAD_SECRET_MUST_NOT_LEAK",
      }),
      verify: () => verifierResult("passed"),
    });

    const result = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );

    expect(result).toMatchObject({
      state: "verification",
      replayed: false,
      verification: {
        availabilityStatus: "available",
        integrityStatus: "matched",
        authenticityStatus: "unverified",
        verificationStatus: "passed",
        readbackResultProvenance: "declared_payload",
        observedPayloadDigest: fixture.semanticDigest,
      },
    });
    expect(fixture.readSpy).toHaveBeenCalledTimes(1);
    expect(fixture.verify).toHaveBeenCalledTimes(1);
    const snapshot = fixture.snapshot();
    expect(snapshot.recoveryEvidenceVerificationChecks).toHaveLength(1);
    expect(snapshot.recoveryEvidenceVerifications).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.availability_checked",
      ),
    ).toHaveLength(1);
    expect(
      snapshot.events.filter(
        (event) =>
          event.type === "recovery.evidence.verification_completed",
      ),
    ).toHaveLength(1);
    expect(snapshot.task.status).toBe("waiting_review");
    expect(JSON.stringify(result)).not.toContain(
      "PAYLOAD_SECRET_MUST_NOT_LEAK",
    );
    expect(JSON.stringify(snapshot.events)).not.toContain(
      "PAYLOAD_SECRET_MUST_NOT_LEAK",
    );
  });

  it("persists failed and inconclusive verifier results", async () => {
    for (const status of ["failed", "inconclusive"] as const) {
      const fixture = createFixture(`result-${status}`, {
        verify: () => verifierResult(status),
      });
      const result = await fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      );
      expect(result.verification).toMatchObject({
        verificationStatus: status,
        authenticityStatus: "unverified",
      });
      expect(
        result.verification?.verificationEventId,
      ).not.toBeNull();
    }
  });

  it("replays persisted verification without payload read, verifier call, or audit writes", async () => {
    const fixture = createFixture("replay");
    const bindingProvider = vi.spyOn(
      fixture.runtime,
      "getBindingForNewCheck",
    );
    const first = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    const afterFirst = fixture.snapshot();
    setTaskIntent(fixture.database, fixture.taskId, "pause");

    const second = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    const afterSecond = fixture.snapshot();

    expect(first.replayed).toBe(false);
    expect(second).toMatchObject({
      state: "verification",
      replayed: true,
      verification: { id: first.verification?.id },
    });
    expect(fixture.readSpy).toHaveBeenCalledTimes(1);
    expect(fixture.verify).toHaveBeenCalledTimes(1);
    expect(bindingProvider).toHaveBeenCalledTimes(1);
    expect(afterSecond.events).toHaveLength(afterFirst.events.length);
    expect(afterSecond.checkpoints).toHaveLength(
      afterFirst.checkpoints.length,
    );
  });

  it("replays a historical Check when the current Host has no active binding or verifier", async () => {
    const fixture = createFixture("historical-binding");
    const first = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    const unavailableProvider =
      new RecoveryVerifierHostBindingProvider([
        bindingDefinition({
          active: false,
          timeoutMs: 25,
          ruleConfig: { ruleset: "v2" },
        }),
      ]);
    const unavailableRuntime = new RecoveryVerifierRuntime(
      new RecoveryVerifierRegistry(),
      unavailableProvider,
    );
    const bindingLookup = vi.spyOn(
      unavailableRuntime,
      "getBindingForNewCheck",
    );
    const replayService = new RecoveryEvidenceVerificationService({
      database: fixture.database,
      leaseManager: fixture.leaseManager,
      payloadStore: fixture.payloadStore,
      verifierRuntime: unavailableRuntime,
      hostVerifierId: "host_verifier",
      assertAuthority: () => fixture.authority.assertActive(),
      now: fixture.now,
      idFactory: fixture.idFactory,
    });

    const replay = await replayService.verifyStoredEvidence(
      verificationInput(fixture),
    );

    expect(replay).toMatchObject({
      state: "verification",
      replayed: true,
      verification: { id: first.verification?.id },
    });
    expect(bindingLookup).not.toHaveBeenCalled();
    expect(fixture.readSpy).toHaveBeenCalledTimes(1);
    expect(fixture.verify).toHaveBeenCalledTimes(1);
  });

  it("does not create a Check or audit rows when lazy Host binding resolution fails", async () => {
    const fixture = createFixture("binding-miss-failure");
    const before = fixture.snapshot();
    const bindingLookup = vi
      .spyOn(fixture.runtime, "getBindingForNewCheck")
      .mockImplementation(() => {
        throw new Error("SECRET_HOST_BINDING_FAILURE");
      });

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code:
        "RECOVERY_EVIDENCE_VERIFICATION_HOST_BINDING_UNAVAILABLE",
    });
    const after = fixture.snapshot();
    expect(bindingLookup).toHaveBeenCalledTimes(1);
    expect(after.recoveryEvidenceVerificationChecks).toHaveLength(0);
    expect(after.recoveryEvidenceVerifications).toHaveLength(0);
    expect(after.events).toHaveLength(before.events.length);
    expect(after.checkpoints).toHaveLength(before.checkpoints.length);
    expect(fixture.readSpy).not.toHaveBeenCalled();
  });

  it("does not create a Check when Cancel intent already exists", async () => {
    const fixture = createFixture("intent-before-check");
    setTaskIntent(fixture.database, fixture.taskId, "cancel");

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_INTENT_BLOCKED",
    });
    expect(
      fixture.snapshot().recoveryEvidenceVerificationChecks,
    ).toHaveLength(0);
    expect(fixture.readSpy).not.toHaveBeenCalled();
    expect(fixture.verify).not.toHaveBeenCalled();
  });

  it("returns a pending Check replay before Cancel/Pause gates", async () => {
    const fixture = createFixture("pending-replay", {
      read(
        store,
      ) {
        return (storeRef: string, expectedDigest: string) => {
          setTaskIntent(
            fixtureDatabase(),
            fixture.taskId,
            "pause",
          );
          return store.read(storeRef, expectedDigest);
        };
      },
    });

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_INTENT_BLOCKED",
    });
    expect(fixture.verify).not.toHaveBeenCalled();
    const pending = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );

    expect(pending).toMatchObject({
      state: "pending",
      replayed: true,
      verification: null,
    });
    expect(fixture.snapshot().recoveryEvidenceVerifications).toHaveLength(
      0,
    );
    expect(fixture.readSpy).toHaveBeenCalledTimes(1);
  });

  it("does not persist verification after authority revocation during execution", async () => {
    const fixture = createFixture("authority", {
      verify: () => {
        fixtureAuthority().revoke(new Error("heartbeat failed"));
        return verifierResult("passed");
      },
    });

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "EXECUTION_AUTHORITY_REVOKED",
    });
    expect(fixture.snapshot().recoveryEvidenceVerifications).toHaveLength(
      0,
    );
    expect(
      fixture.snapshot().recoveryEvidenceVerificationChecks,
    ).toHaveLength(1);
  });

  it("does not persist verification after lease expiry during execution", async () => {
    const fixture = createFixture("lease-expiry", {
      verify: () => {
        fixtureExpireLease();
        return verifierResult("passed");
      },
    });

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "TASK_LEASE_NOT_OWNED",
    });
    expect(fixture.snapshot().recoveryEvidenceVerifications).toHaveLength(
      0,
    );
  });

  it("does not allow lease expiry to replay a persisted verification", async () => {
    const fixture = createFixture("replay-lease-expiry");
    const first = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    const beforeReplay = fixture.snapshot();
    fixtureExpireLease();

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "TASK_LEASE_NOT_OWNED",
    });
    const afterReplay = fixture.snapshot();
    expect(
      afterReplay.recoveryEvidenceVerifications.find(
        (candidate) => candidate.id === first.verification?.id,
      ),
    ).toBeDefined();
    expect(afterReplay.events).toHaveLength(beforeReplay.events.length);
    expect(afterReplay.checkpoints).toHaveLength(
      beforeReplay.checkpoints.length,
    );
  });

  it("does not persist verification after fencing ownership changes", async () => {
    const fixture = createFixture("fencing", {
      verify: () => {
        const ownership = fixture.ownership;
        fixture.leaseManager.release(
          ownership.taskId,
          ownership.leaseToken,
          ownership.fencingToken,
        );
        fixture.leaseManager.claim(ownership.taskId, "replacement-worker");
        return verifierResult("passed");
      },
    });

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "TASK_LEASE_NOT_OWNED",
    });
    expect(fixture.snapshot().recoveryEvidenceVerifications).toHaveLength(
      0,
    );
  });

  it("does not persist a result when Cancel/Pause intent appears during verifier execution", async () => {
    const fixture = createFixture("intent-during-verifier", {
      verify: () => {
        setTaskIntent(fixtureDatabase(), fixture.taskId, "cancel");
        return verifierResult("passed");
      },
    });

    await expect(
      fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      ),
    ).rejects.toMatchObject({
      code: "RECOVERY_EVIDENCE_INTENT_BLOCKED",
    });
    const snapshot = fixture.snapshot();
    expect(snapshot.recoveryEvidenceVerificationChecks).toHaveLength(1);
    expect(snapshot.recoveryEvidenceVerifications).toHaveLength(0);
    expect(fixture.verify).toHaveBeenCalledTimes(1);
  });

  it("maps unavailable payload cases to not_run with only an availability event", async () => {
    const scenarios = [
      {
        suffix: "invalid-ref",
        spec: jsonPayloadSpec(
          { receipt: "receipt-1" },
          { storeRef: "C:\\private\\evidence.bin" },
        ),
        expectedReason: "EVIDENCE_PAYLOAD_STORE_REF_INVALID",
        mutate: () => undefined,
        read: undefined,
      },
      {
        suffix: "missing",
        spec: jsonPayloadSpec({ receipt: "receipt-1" }),
        expectedReason: "ENOENT",
        mutate: (fixture: VerificationFixture) => {
          unlinkSync(fixture.payloadPath());
        },
        read: undefined,
      },
      {
        suffix: "io",
        spec: jsonPayloadSpec({ receipt: "receipt-1" }),
        expectedReason: "EVIDENCE_PAYLOAD_STORE_IO_ERROR",
        mutate: () => undefined,
        read: (
          _store: FileEvidencePayloadStore,
        ) => {
          return () => {
            throw Object.assign(
              new Error(
                "EACCES C:\\private\\evidence.bin RAW_PAYLOAD",
              ),
              { code: "EACCES" },
            );
          };
        },
      },
      {
        suffix: "external",
        spec: externalPayloadSpec(),
        expectedReason:
          "EVIDENCE_PAYLOAD_EXTERNAL_REFERENCE_UNSUPPORTED",
        mutate: () => undefined,
        read: undefined,
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createFixture(scenario.suffix, {
        payload: scenario.spec,
        ...(scenario.read === undefined
          ? {}
          : { read: scenario.read }),
      });
      scenario.mutate(fixture);
      const result = await fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      );
      expect(result.verification).toMatchObject({
        availabilityStatus: "unavailable",
        integrityStatus: "not_checked",
        verificationStatus: "not_run",
        reasonCode: scenario.expectedReason,
        verificationEventId: null,
        authenticityStatus: "unverified",
      });
      expect(fixture.verify).not.toHaveBeenCalled();
      expect(
        fixture.snapshot().events.filter(
          (event) =>
            event.type ===
            "recovery.evidence.verification_completed",
        ),
      ).toHaveLength(0);
      expect(JSON.stringify(result)).not.toContain("C:\\\\private");
      expect(JSON.stringify(result)).not.toContain("RAW_PAYLOAD");
    }
  });

  it("maps readable integrity failures to available/mismatch and not_run", async () => {
    const scenarios = [
      {
        suffix: "storage-mismatch",
        spec: rawPayloadSpec(Buffer.from("original", "utf8")),
        mutate: (fixture: VerificationFixture) => {
          writeFileSync(fixture.payloadPath(), "replaced");
        },
        expectedReason:
          "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
      },
      {
        suffix: "semantic-mismatch",
        spec: jsonPayloadSpec(
          { receipt: "receipt-1" },
          { payloadDigest: digest("f") },
        ),
        mutate: () => undefined,
        expectedReason:
          "EVIDENCE_PAYLOAD_SEMANTIC_DIGEST_MISMATCH",
      },
      {
        suffix: "invalid-json",
        spec: rawManifestSpec(
          Buffer.from("{not-json", "utf8"),
          "json",
          "jcs-sha256-v1",
          digest("f"),
        ),
        mutate: () => undefined,
        expectedReason: "EVIDENCE_PAYLOAD_JSON_INVALID",
      },
      {
        suffix: "invalid-readback",
        spec: rawManifestSpec(
          Buffer.from(
            canonicalJson({
              resourceRef: "ledger://write/1",
              resourceVersion: "1",
              observedAt: "invalid",
              outcome: "observed_succeeded",
              result: null,
            }),
            "utf8",
          ),
          "readback_result",
          "jcs-sha256-v1",
          digest("f"),
        ),
        mutate: () => undefined,
        expectedReason:
          "EVIDENCE_PAYLOAD_READBACK_RESULT_INVALID",
      },
    ];

    for (const scenario of scenarios) {
      const fixture = createFixture(scenario.suffix, {
        payload: scenario.spec,
      });
      scenario.mutate(fixture);
      const result = await fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      );
      expect(result.verification).toMatchObject({
        availabilityStatus: "available",
        integrityStatus: "mismatch",
        verificationStatus: "not_run",
        reasonCode: scenario.expectedReason,
        verificationEventId: null,
        authenticityStatus: "unverified",
      });
      expect(fixture.verify).not.toHaveBeenCalled();
    }
  });

  it("persists verifier resolution failures as matched integrity and not_run", async () => {
    const cases: readonly {
      readonly suffix: string;
      readonly registry: RecoveryVerifierRegistry;
      readonly expectedReason: string;
    }[] = [
      {
        suffix: "registry-miss",
        registry: new RecoveryVerifierRegistry(),
        expectedReason: "VERIFIER_NOT_REGISTERED",
      },
      {
        suffix: "version-mismatch",
        registry: registryFor({
          ...verifierDefinition(),
          version: "2",
        }),
        expectedReason: "VERIFIER_VERSION_MISMATCH",
      },
      {
        suffix: "incompatible",
        registry: registryFor({
          ...verifierDefinition(),
          allowedPayloadTypes: ["raw_bytes"],
        }),
        expectedReason: "VERIFIER_INCOMPATIBLE",
      },
    ];

    for (const current of cases) {
      const fixture = createFixture(current.suffix, {
        registry: current.registry,
      });
      const result = await fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      );
      expect(result.verification).toMatchObject({
        availabilityStatus: "available",
        integrityStatus: "matched",
        verificationStatus: "not_run",
        reasonCode: current.expectedReason,
        verificationEventId: null,
      });
    }
  });

  it("persists verifier config digest mismatch as not_run", async () => {
    const fixture = createFixture("config-mismatch");
    const runtime = {
      getBindingForNewCheck: () =>
        fixture.runtime.getBindingForNewCheck("host_verifier"),
      executePersisted: async () => ({
        status: "not_run",
        reasonCode: "VERIFIER_CONFIG_DIGEST_MISMATCH",
        redactedSummary:
          "Verifier context does not match the persisted binding.",
        integrityStatus: "matched",
        authenticityStatus: "unverified",
        verificationEventRequired: false,
      }),
    } as unknown as RecoveryVerifierRuntime;
    const service = new RecoveryEvidenceVerificationService({
      database: fixture.database,
      leaseManager: fixture.leaseManager,
      payloadStore: fixture.payloadStore,
      verifierRuntime: runtime,
      hostVerifierId: "host_verifier",
      assertAuthority: () => fixture.authority.assertActive(),
      idFactory: fixture.idFactory,
      now: fixture.now,
    });

    const result = await service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    expect(result.verification).toMatchObject({
      verificationStatus: "not_run",
      reasonCode: "VERIFIER_CONFIG_DIGEST_MISMATCH",
      verificationEventId: null,
    });
  });

  it("maps synchronous throws and rejected promises to inconclusive", async () => {
    for (const scenario of [
      {
        suffix: "sync-throw",
        verify: (() => {
          throw new Error("SECRET_SYNC_FAILURE");
        }) as RecoveryVerifierDefinition["verify"],
      },
      {
        suffix: "async-reject",
        verify: (async () => {
          throw new Error("SECRET_ASYNC_FAILURE");
        }) as RecoveryVerifierDefinition["verify"],
      },
    ]) {
      const fixture = createFixture(scenario.suffix, {
        verify: scenario.verify,
      });
      const result = await fixture.service.verifyStoredEvidence(
        verificationInput(fixture),
      );
      expect(result.verification).toMatchObject({
        availabilityStatus: "available",
        integrityStatus: "matched",
        verificationStatus: "inconclusive",
        reasonCode: "VERIFIER_REJECTED",
        authenticityStatus: "unverified",
      });
      expect(result.verification?.verificationEventId).not.toBeNull();
      expect(JSON.stringify(result)).not.toContain("SECRET_");
    }
  });

  it("persists timeout as inconclusive with a verification event", async () => {
    vi.useFakeTimers();
    const fixture = createFixture("timeout", {
      timeoutMs: 10,
      verify: () => new Promise<RecoveryVerifierResult>(() => undefined),
    });

    const execution = fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    await vi.advanceTimersByTimeAsync(11);
    const result = await execution;

    expect(result.verification).toMatchObject({
      availabilityStatus: "available",
      integrityStatus: "matched",
      verificationStatus: "inconclusive",
      reasonCode: "VERIFIER_TIMEOUT",
      authenticityStatus: "unverified",
    });
    expect(result.verification?.verificationEventId).not.toBeNull();
  });

  it("keeps declared readback payload provenance separate from controlled readback", async () => {
    const readback = {
      resourceRef: "ledger://write/1",
      resourceVersion: "etag-1",
      observedAt: "2026-11-08T00:00:00.000Z",
      outcome: "observed_succeeded" as const,
      result: { accepted: true },
    };
    const fixture = createFixture("declared-readback", {
      payload: readbackPayloadSpec(readback),
      verifier: {
        ...verifierDefinition(),
        allowedPayloadTypes: ["readback_result"],
        readbackRequired: true,
        allowlistId: "inventory_readback",
      },
    });

    const result = await fixture.service.verifyStoredEvidence(
      verificationInput(fixture),
    );
    expect(result.verification).toMatchObject({
      readbackResultProvenance: "declared_payload",
      verificationStatus: "not_run",
      reasonCode: "VERIFIER_INCOMPATIBLE",
      verificationEventId: null,
    });
  });
});

interface VerificationFixture {
  readonly database: ForgeFlowDatabase;
  readonly taskId: string;
  readonly reviewId: string;
  readonly submissionId: string;
  readonly originalToolRunId: string;
  readonly expectedTaskVersion: number;
  readonly ownership: {
    readonly taskId: string;
    readonly leaseToken: string;
    readonly fencingToken: number;
  };
  readonly leaseManager: TaskLeaseManager;
  readonly authority: ExecutionAuthority;
  readonly payloadStore: EvidencePayloadStore;
  readonly fileStore: FileEvidencePayloadStore;
  readonly payloadStorageDigest: string;
  readonly semanticDigest: string;
  readonly runtime: RecoveryVerifierRuntime;
  readonly service: RecoveryEvidenceVerificationService;
  readonly verify: ReturnType<typeof vi.fn>;
  readonly readSpy: ReturnType<typeof vi.fn>;
  readonly idFactory: () => string;
  readonly now: () => Date;
  readonly snapshot: () => ReturnType<TaskSnapshotReader["load"]>;
  readonly payloadPath: () => string;
}

interface PayloadSpec {
  readonly bytes: Uint8Array | null;
  readonly payloadType: RecoveryEvidencePayloadType;
  readonly payloadDigestProtocol:
    | "sha256-raw-v1"
    | "jcs-sha256-v1"
    | "adapter-content-sha256-v1";
  readonly payloadDigest: string;
  readonly storeRef?: string | null;
  readonly payloadStorageMode?:
    | "content_addressed_file"
    | "reference_only";
}

function createFixture(
  suffix: string,
  options: {
    readonly payload?: PayloadSpec;
    readonly verify?: RecoveryVerifierDefinition["verify"];
    readonly verifier?: RecoveryVerifierDefinition;
    readonly registry?: RecoveryVerifierRegistry;
    readonly timeoutMs?: number;
    readonly read?: (
      store: FileEvidencePayloadStore,
    ) => (storeRef: string, expectedDigest: string) => Uint8Array;
  } = {},
): VerificationFixture {
  const activeDatabase = database as ForgeFlowDatabase;
  const review = createRecoveryReviewFixture(
    activeDatabase,
    `verification-${suffix}`,
  );
  const fileStore = new FileEvidencePayloadStore(
    join(
      temporaryDatabase?.directory as string,
      `evidence-${suffix}`,
    ),
  );
  const spec = options.payload ?? jsonPayloadSpec({ accepted: true });
  const storageDigest =
    spec.bytes === null
      ? digest("0")
      : computeRawPayloadDigest(spec.bytes);
  const stored =
    spec.bytes === null
      ? null
      : fileStore.put(spec.bytes, storageDigest);
  const storeRef =
    spec.storeRef === undefined
      ? (stored?.storeRef ?? null)
      : spec.storeRef;
  const payloadStorageMode =
    spec.payloadStorageMode ??
    (spec.bytes === null
      ? "reference_only"
      : "content_addressed_file");
  const submissionId = `submission-${suffix}`;
  const requestKey = computeCanonicalInputHash(
    `stored-verification-${suffix}`,
  );
  const now = "2026-11-08T00:00:00.000Z";

  runInTransaction(
    activeDatabase,
    () => {
      const permit = createStorageWritePermit(activeDatabase);
      const event = new EventRepository(
        activeDatabase,
        new SequenceAllocator(activeDatabase),
      ).append(
        {
          taskId: review.taskId,
          traceId: `trace-${review.taskId}`,
          type: "recovery.evidence.submitted",
          entityType: "recovery_review",
          entityId: review.reviewId,
          payload: {
            evidenceSubmissionId: submissionId,
            evidenceRef: `audit://${submissionId}`,
            envelopeDigest: digest("b"),
          },
        },
        now,
        permit,
      );
      const operation = new RecoveryReviewOperationRepository(
        activeDatabase,
      ).append(
        {
          id: `operation-${suffix}`,
          taskId: review.taskId,
          reviewId: review.reviewId,
          requestKey,
          operation: "submit_evidence",
          expectedDecisionVersion: 0,
          resultingDecisionVersion: 1,
          status: "applied",
          actorId: "evidence-submitter",
          operationPayloadDigest: digest("a"),
          evidenceEnvelopeDigest: digest("b"),
          resultPlanId: null,
          resultToolRunId: null,
          appliedEventId: event.id,
          createdAt: now,
        },
        permit,
      );
      new RecoveryEvidenceSubmissionRepository(
        activeDatabase,
      ).insert(
        {
          id: submissionId,
          taskId: review.taskId,
          reviewId: review.reviewId,
          toolRunId: review.toolRunId,
          operationId: operation.id,
          requestKey,
          decisionVersion: 1,
          sourceType:
            "system_verification" as RecoveryReviewSource,
          outcome: "observed_succeeded",
          evidenceRef: `audit://${submissionId}`,
          resourceRef: "inventory://part/STM32",
          resourceVersion: "7",
          sourceObservedAt: now,
          submittedAt: now,
          actorId: null,
          verifierId: "evidence-submitter",
          verificationId: `submitted-verification-${suffix}`,
          payloadType: spec.payloadType,
          payloadDigestProtocol: spec.payloadDigestProtocol,
          payloadDigest: spec.payloadDigest,
          envelopeDigest: digest("b"),
          payloadStoreRef: storeRef,
          payloadStorageMode,
          appliedEventId: event.id,
          createdAt: now,
        },
        permit,
      );
    },
    "immediate",
  );

  let nowMs = Date.parse(now);
  const leaseManager = new TaskLeaseManager(activeDatabase, {
    leaseTtlMs: 60_000,
    now: () => new Date(nowMs),
  });
  const lease = leaseManager.claim(
    review.taskId,
    `verification-worker-${suffix}`,
  );
  if (lease.leaseToken === null) {
    throw new Error("Verification fixture lease token is missing.");
  }
  const authority = new ExecutionAuthority();
  const verify = vi.fn(options.verify ?? (() => verifierResult()));
  const registry =
    options.registry ??
    registryFor(
      options.verifier ??
        verifierDefinition({ verify }),
    );
  const bindingProvider =
    new RecoveryVerifierHostBindingProvider([
      bindingDefinition({
        timeoutMs: options.timeoutMs ?? 1_000,
      }),
    ]);
  const runtime = new RecoveryVerifierRuntime(
    registry,
    bindingProvider,
  );
  const realRead = fileStore.read.bind(fileStore);
  const readSpy = vi.fn(
    options.read === undefined
      ? realRead
      : options.read(fileStore),
  );
  const payloadStore: EvidencePayloadStore = {
    put: fileStore.put.bind(fileStore),
    read: readSpy,
  };
  let idCounter = 0;
  const idFactory = () => `${suffix}-id-${++idCounter}`;
  const snapshotReader = new TaskSnapshotReader(activeDatabase);
  const expectedTaskVersion =
    snapshotReader.load(review.taskId).task.version;
  const service = new RecoveryEvidenceVerificationService({
    database: activeDatabase,
    leaseManager,
    payloadStore,
    verifierRuntime: runtime,
    hostVerifierId: "host_verifier",
    assertAuthority: () => authority.assertActive(),
    now: () => new Date(nowMs),
    idFactory,
  });

  const fixture: VerificationFixture = {
    database: activeDatabase,
    taskId: review.taskId,
    reviewId: review.reviewId,
    submissionId,
    originalToolRunId: review.toolRunId,
    expectedTaskVersion,
    ownership: {
      taskId: review.taskId,
      leaseToken: lease.leaseToken,
      fencingToken: lease.fencingToken,
    },
    leaseManager,
    authority,
    payloadStore,
    fileStore,
    payloadStorageDigest: storageDigest,
    semanticDigest: spec.payloadDigest,
    runtime,
    service,
    verify,
    readSpy,
    idFactory,
    now: () => new Date(nowMs),
    snapshot: () => snapshotReader.load(review.taskId),
    payloadPath: () =>
      join(
        temporaryDatabase?.directory as string,
        `evidence-${suffix}`,
        `${storageDigest.slice("sha256:".length)}.bin`,
      ),
  };
  latestFixtureAction = {
    authority,
    leaseManager,
    expireLease: () => {
      nowMs += 61_000;
    },
  };
  fixtureActions.set(review.taskId, latestFixtureAction);
  return fixture;
}

const fixtureActions = new Map<
  string,
  {
    readonly authority: ExecutionAuthority;
    readonly leaseManager: TaskLeaseManager;
    readonly expireLease: () => void;
  }
>();
let latestFixtureAction:
  | {
      readonly authority: ExecutionAuthority;
      readonly leaseManager: TaskLeaseManager;
      readonly expireLease: () => void;
    }
  | undefined;

function fixtureAuthority(): ExecutionAuthority {
  if (latestFixtureAction === undefined) {
    throw new Error("Fixture authority is missing.");
  }
  return latestFixtureAction.authority;
}

function fixtureExpireLease(): void {
  if (latestFixtureAction === undefined) {
    throw new Error("Fixture lease manager is missing.");
  }
  latestFixtureAction.expireLease();
}

function fixtureDatabase(): ForgeFlowDatabase {
  return database as ForgeFlowDatabase;
}

function verificationInput(fixture: VerificationFixture) {
  return {
    ownership: fixture.ownership,
    expectedTaskVersion: fixture.expectedTaskVersion,
    reviewId: fixture.reviewId,
    evidenceSubmissionId: fixture.submissionId,
    verificationCheckId: `check-${fixture.taskId}`,
  };
}

function setTaskIntent(
  activeDatabase: ForgeFlowDatabase,
  taskId: string,
  intent: "cancel" | "pause",
): void {
  const column =
    intent === "cancel" ? "cancel_requested_at" : "pause_requested_at";
  activeDatabase
    .prepare(
      `
        UPDATE tasks
        SET ${column} = ?, version = version + 1
        WHERE id = ?
      `,
    )
    .run("2026-11-08T00:00:05.000Z", taskId);
}

function registryFor(
  definition: RecoveryVerifierDefinition,
): RecoveryVerifierRegistry {
  const registry = new RecoveryVerifierRegistry();
  registry.register(definition);
  return registry;
}

function verifierDefinition(
  overrides: Partial<RecoveryVerifierDefinition> = {},
): RecoveryVerifierDefinition {
  return {
    id: "host_verifier",
    version: "1",
    description: "Host-owned stored evidence verifier.",
    allowedPayloadTypes: ["json"],
    allowedSourceTypes: ["system_verification"],
    readbackRequired: false,
    verify: () => verifierResult(),
    ...overrides,
  };
}

function bindingDefinition(
  overrides: Partial<RecoveryVerifierHostBindingDefinition> = {},
): RecoveryVerifierHostBindingDefinition {
  return {
    verifierId: "host_verifier",
    verifierVersion: "1",
    timeoutMs: 1_000,
    ruleConfig: { ruleset: "stored-evidence" },
    active: true,
    ...overrides,
  };
}

function verifierResult(
  status: "passed" | "failed" | "inconclusive" = "passed",
): RecoveryVerifierResult {
  return {
    status,
    reasonCode:
      status === "passed"
        ? "EXPECTED_STATE_OBSERVED"
        : "EVIDENCE_INCONCLUSIVE",
    redactedSummary: "Stored evidence verification result.",
    integrity: "matched",
    authenticity: "unverified",
  };
}

function jsonPayloadSpec(
  value: unknown,
  overrides: Partial<PayloadSpec> = {},
): PayloadSpec {
  const bytes = Buffer.from(
    canonicalJson(value as never),
    "utf8",
  );
  return rawManifestSpec(
    bytes,
    "json",
    "jcs-sha256-v1",
    computeJsonPayloadDigest(value as never),
    overrides,
  );
}

function rawPayloadSpec(bytes: Uint8Array): PayloadSpec {
  return rawManifestSpec(
    bytes,
    "raw_bytes",
    "sha256-raw-v1",
    computeRawPayloadDigest(bytes),
  );
}

function readbackPayloadSpec(readback: {
  readonly resourceRef: string;
  readonly resourceVersion: string;
  readonly observedAt: string;
  readonly outcome: "observed_succeeded";
  readonly result: unknown;
}): PayloadSpec {
  return rawManifestSpec(
    Buffer.from(canonicalJson(readback as never), "utf8"),
    "readback_result",
    "jcs-sha256-v1",
    computeJsonPayloadDigest(readback as never),
  );
}

function externalPayloadSpec(): PayloadSpec {
  return {
    bytes: null,
    payloadType: "external_reference",
    payloadDigestProtocol: "adapter-content-sha256-v1",
    payloadDigest: digest("e"),
    storeRef: null,
    payloadStorageMode: "reference_only",
  };
}

function rawManifestSpec(
  bytes: Uint8Array,
  payloadType: RecoveryEvidencePayloadType,
  payloadDigestProtocol: PayloadSpec["payloadDigestProtocol"],
  payloadDigest: string,
  overrides: Partial<PayloadSpec> = {},
): PayloadSpec {
  return {
    bytes,
    payloadType,
    payloadDigestProtocol,
    payloadDigest,
    ...overrides,
  };
}

function digest(character: string): string {
  return `sha256:${character.repeat(64)}`;
}
