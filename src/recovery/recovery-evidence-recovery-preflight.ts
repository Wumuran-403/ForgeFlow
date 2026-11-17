import type Database from "better-sqlite3";
import { z } from "zod";

import { AppError } from "../shared/errors.js";
import { ToolInputValidationError } from "../tools/errors.js";
import { computeCanonicalInputHash } from "../tools/fingerprint.js";
import {
  RecoveryReadbackAllowlistContractMetadataSchema,
  RecoveryReadbackToolRegistry,
  computeRecoveryReadbackAllowlistVersion,
} from "./recovery-readback-tool-registry.js";
import {
  RecoveryEvidenceReadbackConsistencyModeSchema,
  RecoveryEvidenceReadbackRetrySafetySchema,
} from "../storage/types.js";
import { computeRecoveryEvidenceReadbackRequestIntentDigest } from "../storage/recovery-evidence-readback-reservation-keys.js";
import { RecoveryEvidenceReadbackReservationRepository } from "../storage/recovery-evidence-readback-reservation-repository.js";
import { RecoveryEvidenceReadbackRequestRepository } from "../storage/recovery-evidence-readback-request-repository.js";
import { RecoveryReviewOperationRepository } from "../storage/recovery-review-operation-repository.js";
import { TaskRepository } from "../storage/task-repository.js";
import { ToolRunRepository } from "../storage/tool-run-repository.js";

const InputSchema = z
  .object({
    requestId: z.string().min(1),
    expectedTaskId: z.string().min(1).optional(),
    expectedReadToolRunId: z.string().min(1).optional(),
    expectedAllowlistId: z.string().min(1).optional(),
    expectedAllowlistVersion: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
    expectedRequestIntentDigest: z
      .string()
      .regex(/^sha256:[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();

const RetryBindingSchema = z
  .object({
    retrySafety: RecoveryEvidenceReadbackRetrySafetySchema,
    consistencyMode:
      RecoveryEvidenceReadbackConsistencyModeSchema,
    expectedResourceVersion: z.string().min(1).nullable(),
    expectedEtag: z.string().min(1).nullable(),
  })
  .strict();

export interface RecoveryEvidenceRecoveryPreflightInput {
  readonly database: Database.Database;
  readonly registry: RecoveryReadbackToolRegistry;
  readonly requestId: string;
  readonly expectedTaskId?: string;
  readonly expectedReadToolRunId?: string;
  readonly expectedAllowlistId?: string;
  readonly expectedAllowlistVersion?: string;
  readonly expectedRequestIntentDigest?: string;
}

export interface RecoveryEvidenceRecoveryPreflightBinding {
  readonly taskId: string;
  readonly requestId: string;
  readonly readToolRunId: string;
  readonly allowlistId: string;
  readonly allowlistVersion: string;
  readonly readToolName: string;
  readonly readToolVersion: string;
  readonly readToolSchemaHash: string;
  readonly requestIntentDigest: string;
  readonly retrySafety: z.output<
    typeof RecoveryEvidenceReadbackRetrySafetySchema
  >;
  readonly consistencyMode: z.output<
    typeof RecoveryEvidenceReadbackConsistencyModeSchema
  >;
  readonly expectedResourceVersion: string | null;
  readonly expectedEtag: string | null;
  readonly canonicalInputHash: string;
  readonly retryAssessment: "passed";
}

declare const recoveryEvidenceRecoveryPreflightBrand: unique symbol;

export interface RecoveryEvidenceRecoveryPreflightCapability {
  readonly [recoveryEvidenceRecoveryPreflightBrand]: true;
}

export type RecoveryEvidenceRecoveryPreflightResult =
  | {
      readonly state: "passed";
      readonly retryAssessment: "passed";
      readonly capability:
        RecoveryEvidenceRecoveryPreflightCapability;
    }
  | {
      readonly state: "failed" | "not_evaluated";
      readonly retryAssessment: "failed" | "not_evaluated";
      readonly reasonCode: string;
    };

export type RecoveryEvidenceRetryBindingAssessment =
  | {
      readonly retryAssessment: "passed";
    }
  | {
      readonly retryAssessment: "failed";
      readonly reasonCode:
        | "RETRY_BINDING_UNSAFE"
        | "EXPECTED_RESOURCE_BINDING_REQUIRED";
    };

const capabilities = new WeakMap<
  object,
  Readonly<RecoveryEvidenceRecoveryPreflightBinding>
>();
const resultBindings = new WeakMap<
  object,
  Readonly<
    Partial<RecoveryEvidenceRecoveryPreflightBinding>
  >
>();

export function assessRecoveryEvidenceRetryBinding(
  input: unknown,
): RecoveryEvidenceRetryBindingAssessment {
  let parsed: z.output<typeof RetryBindingSchema>;
  try {
    parsed = RetryBindingSchema.parse(input);
  } catch {
    return {
      retryAssessment: "failed",
      reasonCode: "RETRY_BINDING_UNSAFE",
    };
  }
  const hasExpected =
    parsed.expectedResourceVersion !== null ||
    parsed.expectedEtag !== null;
  if (
    parsed.retrySafety === "immutable" &&
    parsed.consistencyMode === "immutable_version" &&
    !hasExpected
  ) {
    return { retryAssessment: "passed" };
  }
  if (
    parsed.retrySafety === "version_conditional" &&
    parsed.consistencyMode === "etag_or_resource_version"
  ) {
    return hasExpected
      ? { retryAssessment: "passed" }
      : {
          retryAssessment: "failed",
          reasonCode: "EXPECTED_RESOURCE_BINDING_REQUIRED",
        };
  }
  return {
    retryAssessment: "failed",
    reasonCode: "RETRY_BINDING_UNSAFE",
  };
}

export async function prepareRecoveryEvidenceRecoveryPreflight(
  input: RecoveryEvidenceRecoveryPreflightInput,
): Promise<RecoveryEvidenceRecoveryPreflightResult> {
  const fail = (
    state: "failed" | "not_evaluated",
    reasonCode: string,
  ): RecoveryEvidenceRecoveryPreflightResult =>
    failure(state, reasonCode, input.requestId);
  if (!(input.registry instanceof RecoveryReadbackToolRegistry)) {
    return fail(
      "not_evaluated",
      "RECOVERY_CONTRACT_UNAVAILABLE",
    );
  }
  let parsed: z.output<typeof InputSchema>;
  try {
    parsed = InputSchema.parse({
      requestId: input.requestId,
      ...(input.expectedTaskId === undefined
        ? {}
        : { expectedTaskId: input.expectedTaskId }),
      ...(input.expectedReadToolRunId === undefined
        ? {}
        : { expectedReadToolRunId: input.expectedReadToolRunId }),
      ...(input.expectedAllowlistId === undefined
        ? {}
        : { expectedAllowlistId: input.expectedAllowlistId }),
      ...(input.expectedAllowlistVersion === undefined
        ? {}
        : {
            expectedAllowlistVersion:
              input.expectedAllowlistVersion,
          }),
      ...(input.expectedRequestIntentDigest === undefined
        ? {}
        : {
            expectedRequestIntentDigest:
              input.expectedRequestIntentDigest,
          }),
    });
  } catch {
    return fail(
      "failed",
      "RECOVERY_PREFLIGHT_INPUT_INVALID",
    );
  }

  const tasks = new TaskRepository(input.database);
  const requests = new RecoveryEvidenceReadbackRequestRepository(
    input.database,
  );
  const operations = new RecoveryReviewOperationRepository(
    input.database,
  );
  const reservations =
    new RecoveryEvidenceReadbackReservationRepository(
      input.database,
    );
  const toolRuns = new ToolRunRepository(input.database);

  let request;
  let task;
  let operation;
  let reservation;
  let readRun;
  try {
    request = requests.get(parsed.requestId);
    task = tasks.get(request.taskId);
    operation = operations.get(request.operationId);
    reservation = reservations.getByRequestId(request.id);
    readRun = toolRuns.get(request.readToolRunId);
  } catch {
    return fail(
      "not_evaluated",
      "RECOVERY_CONTRACT_UNAVAILABLE",
    );
  }

  if (
    (parsed.expectedTaskId !== undefined &&
      parsed.expectedTaskId !== request.taskId) ||
    (parsed.expectedReadToolRunId !== undefined &&
      parsed.expectedReadToolRunId !== request.readToolRunId) ||
    (parsed.expectedAllowlistId !== undefined &&
      parsed.expectedAllowlistId !== request.allowlistId) ||
    (parsed.expectedAllowlistVersion !== undefined &&
      parsed.expectedAllowlistVersion !==
        request.allowlistVersion)
  ) {
    return fail("failed", "RECOVERY_PREFLIGHT_BINDING_MISMATCH");
  }
  if (
    task.status !== "waiting_review" ||
    operation.taskId !== task.id ||
    operation.reviewId !== request.reviewId ||
    operation.operation !== "request_readback" ||
    operation.status !== "accepted" ||
    operation.resultPlanId !== request.executionPlanId ||
    operation.resultToolRunId !== request.readToolRunId ||
    operation.resultingDecisionVersion !==
      operation.expectedDecisionVersion + 1 ||
    reservation === undefined ||
    reservation.status !== "completed" ||
    reservation.taskId !== request.taskId ||
    reservation.requestId !== request.id ||
    reservation.operationId !== request.operationId ||
    reservation.executionPlanId !==
      request.executionPlanId ||
    reservation.planStepId !== request.planStepId ||
    reservation.readToolRunId !== request.readToolRunId ||
    reservation.verificationCheckId !==
      request.verificationCheckId
  ) {
    return fail("failed", "RECOVERY_PREFLIGHT_BINDING_INVALID");
  }

  const recomputedIntentDigest =
    computeRecoveryEvidenceReadbackRequestIntentDigest({
      taskId: request.taskId,
      reviewId: request.reviewId,
      evidenceSubmissionId: request.evidenceSubmissionId,
      originalToolRunId: request.originalToolRunId,
      allowlistId: request.allowlistId,
      verificationCheckId: request.verificationCheckId,
      expectedDecisionVersion: operation.expectedDecisionVersion,
      expectedResourceVersion: request.expectedResourceVersion,
      expectedEtag: request.expectedEtag,
    });
  if (
    reservation.requestIntentDigest !== recomputedIntentDigest ||
    (parsed.expectedRequestIntentDigest !== undefined &&
      parsed.expectedRequestIntentDigest !==
        recomputedIntentDigest)
  ) {
    return fail(
      "failed",
      "REQUEST_INTENT_DIGEST_MISMATCH",
    );
  }

  const retryAssessment =
    assessRecoveryEvidenceRetryBinding({
      retrySafety: request.retrySafety,
      consistencyMode: request.consistencyMode,
      expectedResourceVersion: request.expectedResourceVersion,
      expectedEtag: request.expectedEtag,
    });
  if (retryAssessment.retryAssessment !== "passed") {
    return fail("failed", retryAssessment.reasonCode);
  }

  let definition;
  try {
    definition = input.registry.getExact(
      request.allowlistId,
      request.allowlistVersion,
    );
  } catch {
    return fail(
      "not_evaluated",
      "RECOVERY_CONTRACT_UNAVAILABLE",
    );
  }
  const allowlistContract =
    RecoveryReadbackAllowlistContractMetadataSchema.parse({
      protocolVersion: definition.protocolVersion,
      allowlistId: definition.allowlistId,
      sourceResolverId: definition.sourceResolverId,
      sourceResolverVersion: definition.sourceResolverVersion,
      argumentBuilderId: definition.argumentBuilderId,
      argumentBuilderVersion: definition.argumentBuilderVersion,
      toolName: definition.name,
      toolVersion: definition.version,
      toolInputSchemaHash: definition.schemaHash,
      resultSchemaId: definition.resultSchemaId,
      resultSchemaVersion: definition.resultSchemaVersion,
      resultSchemaHash: definition.resultSchemaHash,
      resourceMetadataExtractorId:
        definition.resourceMetadataExtractorId,
      resourceMetadataExtractorVersion:
        definition.resourceMetadataExtractorVersion,
      allowedResourceSchemes: [
        ...definition.allowedResourceSchemes,
      ],
      retrySafety: definition.retrySafety,
      consistencyMode: definition.consistencyMode,
      timeoutMs: definition.timeoutMs,
      maximumPayloadBytes: definition.maximumPayloadBytes,
      sensitiveOutputPolicy: definition.sensitiveOutputPolicy,
    });
  const allowlistContractDigest =
    computeRecoveryReadbackAllowlistVersion(allowlistContract);
  if (
    allowlistContractDigest !== request.allowlistVersion ||
    definition.allowlistVersion !== allowlistContractDigest ||
    definition.allowlistId !== request.allowlistId ||
    definition.name !== request.readToolName ||
    definition.version !== request.readToolVersion ||
    definition.schemaHash !== request.readToolSchemaHash ||
    definition.retrySafety !== request.retrySafety ||
    definition.consistencyMode !== request.consistencyMode ||
    readRun.taskId !== request.taskId ||
    readRun.id !== request.readToolRunId ||
    readRun.mode !== "read" ||
    readRun.toolName !== request.readToolName ||
    readRun.toolVersion !== request.readToolVersion ||
    readRun.inputSchemaHash !== request.readToolSchemaHash
  ) {
    return fail("failed", "RECOVERY_CONTRACT_MISMATCH");
  }

  const canonicalInputHash = computeCanonicalInputHash(
    readRun.input,
  );
  if (
    canonicalInputHash !== readRun.canonicalInputHash
  ) {
    return fail(
      "failed",
      "CANONICAL_INPUT_HASH_MISMATCH",
    );
  }

  let validatedInput;
  try {
    validatedInput =
      await input.registry.validatePersistedInput(
        request.allowlistId,
        request.allowlistVersion,
        readRun.input,
      );
  } catch (error) {
    if (error instanceof ToolInputValidationError) {
      return fail("failed", "PERSISTED_INPUT_INVALID");
    }
    return fail(
      "not_evaluated",
      "RECOVERY_CONTRACT_UNAVAILABLE",
    );
  }
  if (
    validatedInput.toolName !== request.readToolName ||
    validatedInput.toolVersion !== request.readToolVersion ||
    validatedInput.inputSchemaHash !==
      request.readToolSchemaHash ||
    computeCanonicalInputHash(validatedInput.value) !==
      canonicalInputHash
  ) {
    return fail("failed", "PERSISTED_INPUT_INVALID");
  }

  const binding: RecoveryEvidenceRecoveryPreflightBinding =
    Object.freeze({
      taskId: task.id,
      requestId: request.id,
      readToolRunId: readRun.id,
      allowlistId: request.allowlistId,
      allowlistVersion: request.allowlistVersion,
      readToolName: request.readToolName,
      readToolVersion: request.readToolVersion,
      readToolSchemaHash: request.readToolSchemaHash,
      requestIntentDigest: recomputedIntentDigest,
      retrySafety: request.retrySafety,
      consistencyMode: request.consistencyMode,
      expectedResourceVersion:
        request.expectedResourceVersion,
      expectedEtag: request.expectedEtag,
      canonicalInputHash,
      retryAssessment: "passed",
    });
  const capability = Object.freeze({}) as
    RecoveryEvidenceRecoveryPreflightCapability;
  capabilities.set(capability, binding);
  const result: RecoveryEvidenceRecoveryPreflightResult = Object.freeze({
    state: "passed",
    retryAssessment: "passed",
    capability,
  });
  resultBindings.set(result, binding);
  return result;
}

export function assertRecoveryEvidenceRecoveryPreflightCapability(
  capability: unknown,
  expected: Partial<
    RecoveryEvidenceRecoveryPreflightBinding
  > = {},
): Readonly<RecoveryEvidenceRecoveryPreflightBinding> {
  if (
    capability === null ||
    typeof capability !== "object" ||
    !capabilities.has(capability)
  ) {
    throw capabilityError();
  }
  const binding = capabilities.get(capability)!;
  for (const [key, value] of Object.entries(expected)) {
    if (
      value !==
      binding[key as keyof RecoveryEvidenceRecoveryPreflightBinding]
    ) {
      throw capabilityError();
    }
  }
  return binding;
}

export function assertRecoveryEvidenceRecoveryPreflightResult(
  result: unknown,
  expected: Partial<
    RecoveryEvidenceRecoveryPreflightBinding
  > = {},
): RecoveryEvidenceRecoveryPreflightResult {
  if (
    result === null ||
    typeof result !== "object" ||
    !resultBindings.has(result)
  ) {
    throw capabilityError();
  }
  const binding = resultBindings.get(result)!;
  for (const [key, value] of Object.entries(expected)) {
    if (
      value !==
      binding[key as keyof RecoveryEvidenceRecoveryPreflightBinding]
    ) {
      throw capabilityError();
    }
  }
  if (
    "state" in result &&
    result.state === "passed" &&
    "capability" in result
  ) {
    assertRecoveryEvidenceRecoveryPreflightCapability(
      result.capability,
      expected,
    );
  }
  return result as RecoveryEvidenceRecoveryPreflightResult;
}

function failure(
  state: "failed" | "not_evaluated",
  reasonCode: string,
  requestId: string,
): RecoveryEvidenceRecoveryPreflightResult {
  const result: RecoveryEvidenceRecoveryPreflightResult = Object.freeze({
    state,
    retryAssessment: state,
    reasonCode,
  });
  resultBindings.set(result, { requestId });
  return result;
}

function capabilityError(): AppError {
  return new AppError({
    code:
      "RECOVERY_EVIDENCE_RECOVERY_PREFLIGHT_CAPABILITY_INVALID",
    message:
      "Recovery evidence recovery preflight capability is invalid.",
    statusCode: 409,
    details: [],
  });
}
