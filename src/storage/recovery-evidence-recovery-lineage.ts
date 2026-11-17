import { z } from "zod";

import { canonicalJson } from "../shared/canonical-json.js";
import { AppError } from "../shared/errors.js";
import {
  RecoveryEvidenceReadbackConsistencyModeSchema,
  RecoveryEvidenceReadbackRetrySafetySchema,
} from "./types.js";

export const RECOVERY_EVIDENCE_LINEAGE_SCHEMA_VERSION =
  "recovery-evidence-lineage.v1" as const;

export const RecoveryEvidenceRecoveryPhaseSchema = z.enum([
  "interrupt",
  "prepare",
]);

export const RecoveryEvidenceRetryAssessmentSchema = z.enum([
  "passed",
  "failed",
  "not_evaluated",
]);

const IdentifierSchema = z.string().trim().min(1);
const UuidSchema = z.uuid();
const Sha256DigestSchema = z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/);
const AllowlistVersionSchema = z
  .string()
  .regex(/^[0-9a-f]{64}$/);
const StableReasonCodeSchema = z
  .string()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/);
const InterruptionCauseSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/);

const SharedLineageFields = {
  lineageSchemaVersion: z.literal(
    RECOVERY_EVIDENCE_LINEAGE_SCHEMA_VERSION,
  ),
  recoveryOperationId: UuidSchema,
  taskId: IdentifierSchema,
  readbackRequestId: IdentifierSchema,
  readToolRunId: IdentifierSchema,
  priorAttemptId: IdentifierSchema,
  priorAttemptNumber: z.number().int().positive(),
  retrySafety: RecoveryEvidenceReadbackRetrySafetySchema,
  consistencyMode:
    RecoveryEvidenceReadbackConsistencyModeSchema,
  allowlistId: IdentifierSchema,
  allowlistVersion: AllowlistVersionSchema,
  readToolName: IdentifierSchema,
  readToolVersion: IdentifierSchema,
  readToolSchemaHash: Sha256DigestSchema,
  requestIntentDigest: Sha256DigestSchema,
  expectedResourceVersion: IdentifierSchema.nullable(),
  expectedEtag: IdentifierSchema.nullable(),
} as const;

const SharedLineageFieldsSchema = z
  .object(SharedLineageFields)
  .strict()
  .superRefine((value, context) => {
    const hasExpected =
      value.expectedResourceVersion !== null ||
      value.expectedEtag !== null;
    if (
      (value.retrySafety === "immutable" &&
        (value.consistencyMode !== "immutable_version" || hasExpected)) ||
      (value.retrySafety === "version_conditional" &&
        (value.consistencyMode !== "etag_or_resource_version" ||
          !hasExpected))
    ) {
      context.addIssue({
        code: "custom",
        path: ["retrySafety"],
        message:
          "Recovery lineage retry and consistency bindings are incompatible.",
      });
    }
  });

export const RecoveryEvidenceInterruptLineageV1Schema =
  SharedLineageFieldsSchema.extend({
    recoveryPhase: z.literal("interrupt"),
    readAttemptId: IdentifierSchema,
    attemptNumber: z.number().int().positive(),
    attemptStatus: z.literal("interrupted"),
    dispatchEventId: UuidSchema,
    dispatchFencingToken: z.number().int().positive(),
    leaseClaimEventId: UuidSchema,
    fencingToken: z.number().int().positive(),
    interruptionCause: InterruptionCauseSchema,
    reasonCode: StableReasonCodeSchema,
    retryAssessment: RecoveryEvidenceRetryAssessmentSchema,
    resumeEligible: z.boolean(),
    controlIntentKind: z.enum(["cancel", "pause"]).optional(),
    controlIntentEventId: UuidSchema.optional(),
    pauseRequestEventId: UuidSchema.optional(),
  })
    .strict()
    .superRefine((value, context) => {
      if (value.readAttemptId !== value.priorAttemptId) {
        context.addIssue({
          code: "custom",
          path: ["readAttemptId"],
          message:
            "Interrupted readAttemptId must equal priorAttemptId.",
        });
      }
      if (value.attemptNumber !== value.priorAttemptNumber) {
        context.addIssue({
          code: "custom",
          path: ["attemptNumber"],
          message:
            "Interrupted attemptNumber must equal priorAttemptNumber.",
        });
      }
      if (
        value.fencingToken <= value.dispatchFencingToken
      ) {
        context.addIssue({
          code: "custom",
          path: ["fencingToken"],
          message:
            "Interruption fencing must be greater than dispatch fencing.",
        });
      }
      if (
        value.resumeEligible !==
        (value.retryAssessment === "passed")
      ) {
        context.addIssue({
          code: "custom",
          path: ["resumeEligible"],
          message:
            "resumeEligible must be true exactly when retryAssessment is passed.",
        });
      }
      if (
        (value.controlIntentKind === undefined) !==
        (value.controlIntentEventId === undefined)
      ) {
        context.addIssue({
          code: "custom",
          path: ["controlIntentEventId"],
          message:
            "controlIntentKind and controlIntentEventId must be provided together.",
        });
      }
      if (
        value.controlIntentKind === "cancel" &&
        value.retryAssessment !== "not_evaluated"
      ) {
        context.addIssue({
          code: "custom",
          path: ["retryAssessment"],
          message:
            "Cancel interruption must use retryAssessment=not_evaluated.",
        });
      }
      if (
        value.retryAssessment === "not_evaluated" &&
        value.controlIntentKind === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["retryAssessment"],
          message:
            "not_evaluated requires an explicit Cancel or Pause interruption.",
        });
      }
      if (
        value.controlIntentKind === "pause" &&
        value.pauseRequestEventId === undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["pauseRequestEventId"],
          message:
            "Pause interruption must bind pauseRequestEventId.",
        });
      }
      if (
        value.controlIntentKind === "pause" &&
        value.controlIntentEventId !==
          value.pauseRequestEventId
      ) {
        context.addIssue({
          code: "custom",
          path: ["pauseRequestEventId"],
          message:
            "Pause interruption Event identity must match pauseRequestEventId.",
        });
      }
      if (
        value.controlIntentKind !== "pause" &&
        value.pauseRequestEventId !== undefined
      ) {
        context.addIssue({
          code: "custom",
          path: ["pauseRequestEventId"],
          message:
            "pauseRequestEventId is only valid for Pause interruption.",
        });
      }
    });

export const RecoveryEvidencePrepareLineageV1Schema =
  SharedLineageFieldsSchema.extend({
    recoveryPhase: z.literal("prepare"),
    readAttemptId: IdentifierSchema,
    attemptNumber: z.number().int().positive(),
    attemptStatus: z.literal("prepared"),
    interruptionEventId: UuidSchema,
    newAttemptId: IdentifierSchema,
    newAttemptNumber: z.number().int().positive(),
    leaseClaimEventId: UuidSchema,
    fencingToken: z.number().int().positive(),
    pauseClearEventId: UuidSchema.optional(),
  })
    .strict()
    .superRefine((value, context) => {
      if (value.readAttemptId !== value.newAttemptId) {
        context.addIssue({
          code: "custom",
          path: ["readAttemptId"],
          message:
            "Prepared readAttemptId must equal newAttemptId.",
        });
      }
      if (
        value.priorAttemptNumber + 1 !== value.newAttemptNumber ||
        value.attemptNumber !== value.newAttemptNumber
      ) {
        context.addIssue({
          code: "custom",
          path: ["attemptNumber"],
          message:
            "attemptNumber and newAttemptNumber must equal priorAttemptNumber + 1.",
        });
      }
    });

export const RecoveryEvidenceLineageV1Schema =
  z.discriminatedUnion("recoveryPhase", [
    RecoveryEvidenceInterruptLineageV1Schema,
    RecoveryEvidencePrepareLineageV1Schema,
  ]);

export type RecoveryEvidenceInterruptLineageV1 = z.output<
  typeof RecoveryEvidenceInterruptLineageV1Schema
>;
export type RecoveryEvidencePrepareLineageV1 = z.output<
  typeof RecoveryEvidencePrepareLineageV1Schema
>;
export type RecoveryEvidenceLineageV1 = z.output<
  typeof RecoveryEvidenceLineageV1Schema
>;

export interface RecoveryEvidenceLineageExpectedIdentity {
  readonly taskId?: string;
  readonly readbackRequestId?: string;
  readonly readToolRunId?: string;
  readonly priorAttemptId?: string;
  readonly priorAttemptNumber?: number;
}

export interface RecoveryEvidenceLineagePairInput {
  readonly interrupt: unknown;
  readonly prepare?: unknown;
  readonly interruptionEventId?: string;
  readonly expectedIdentity?: RecoveryEvidenceLineageExpectedIdentity;
}

export interface RecoveryEvidenceLineagePair {
  readonly interrupt: RecoveryEvidenceInterruptLineageV1;
  readonly prepare: RecoveryEvidencePrepareLineageV1 | null;
}

export function validateRecoveryEvidenceLineageV1(
  input: unknown,
  expectedIdentity: RecoveryEvidenceLineageExpectedIdentity = {},
): RecoveryEvidenceLineageV1 {
  const parsed = RecoveryEvidenceLineageV1Schema.parse(input);
  assertExpectedIdentity(parsed, expectedIdentity);
  return parsed;
}

export function validateRecoveryEvidenceLineagePair(
  input: RecoveryEvidenceLineagePairInput,
): RecoveryEvidenceLineagePair {
  const interrupt =
    RecoveryEvidenceInterruptLineageV1Schema.parse(input.interrupt);
  assertExpectedIdentity(interrupt, input.expectedIdentity ?? {});
  if (input.prepare === undefined) {
    return {
      interrupt,
      prepare: null,
    };
  }

  const prepare =
    RecoveryEvidencePrepareLineageV1Schema.parse(input.prepare);
  assertExpectedIdentity(prepare, input.expectedIdentity ?? {});
  if (
    input.interruptionEventId === undefined ||
    prepare.interruptionEventId !== input.interruptionEventId
  ) {
    throw lineageError(
      "Prepare lineage must reference the expected Interrupted Event.",
    );
  }
  if (prepare.recoveryOperationId !== interrupt.recoveryOperationId) {
    throw lineageError(
      "Interrupted and Prepared lineage must share recoveryOperationId.",
    );
  }
  if (
    prepare.taskId !== interrupt.taskId ||
    prepare.readbackRequestId !== interrupt.readbackRequestId ||
    prepare.readToolRunId !== interrupt.readToolRunId ||
    prepare.priorAttemptId !== interrupt.priorAttemptId ||
    prepare.priorAttemptNumber !== interrupt.priorAttemptNumber ||
    prepare.retrySafety !== interrupt.retrySafety ||
    prepare.consistencyMode !== interrupt.consistencyMode ||
    prepare.allowlistId !== interrupt.allowlistId ||
    prepare.allowlistVersion !== interrupt.allowlistVersion ||
    prepare.readToolName !== interrupt.readToolName ||
    prepare.readToolVersion !== interrupt.readToolVersion ||
    prepare.readToolSchemaHash !== interrupt.readToolSchemaHash ||
    prepare.requestIntentDigest !== interrupt.requestIntentDigest ||
    prepare.expectedResourceVersion !==
      interrupt.expectedResourceVersion ||
    prepare.expectedEtag !== interrupt.expectedEtag
  ) {
    throw lineageError(
      "Interrupted and Prepared lineage identity bindings differ.",
    );
  }
  if (interrupt.resumeEligible !== true) {
    throw lineageError(
      "Prepared lineage cannot continue from a non-resumable interruption.",
    );
  }
  if (
    (interrupt.pauseRequestEventId === undefined) !==
    (prepare.pauseClearEventId === undefined)
  ) {
    throw lineageError(
      "Pause interruption and Pause clear lineage bindings differ.",
    );
  }
  if (
    prepare.fencingToken <= interrupt.dispatchFencingToken
  ) {
    throw lineageError(
      "Prepared fencing must exceed the prior Dispatch fencing token.",
    );
  }
  return {
    interrupt,
    prepare,
  };
}

export function canonicalRecoveryEvidenceLineageV1(
  input: unknown,
): string {
  return canonicalJson(
    validateRecoveryEvidenceLineageV1(input),
  );
}

function assertExpectedIdentity(
  lineage: RecoveryEvidenceLineageV1,
  expected: RecoveryEvidenceLineageExpectedIdentity,
): void {
  if (
    (expected.taskId !== undefined &&
      lineage.taskId !== expected.taskId) ||
    (expected.readbackRequestId !== undefined &&
      lineage.readbackRequestId !== expected.readbackRequestId) ||
    (expected.readToolRunId !== undefined &&
      lineage.readToolRunId !== expected.readToolRunId) ||
    (expected.priorAttemptId !== undefined &&
      lineage.priorAttemptId !== expected.priorAttemptId) ||
    (expected.priorAttemptNumber !== undefined &&
      lineage.priorAttemptNumber !== expected.priorAttemptNumber)
  ) {
    throw lineageError(
      "Recovery lineage identity does not match the expected binding.",
    );
  }
}

function lineageError(message: string): AppError {
  return new AppError({
    code: "RECOVERY_EVIDENCE_RECOVERY_LINEAGE_INVALID",
    message,
    statusCode: 409,
    details: [],
  });
}
