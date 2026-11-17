import { z } from "zod";

import {
  canonicalJson,
  sha256CanonicalJson,
} from "../shared/canonical-json.js";
import { AppError } from "../shared/errors.js";

const NonEmptyStringSchema = z.string().trim().min(1);
const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const IsoUtcTimestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/,
    "Expected an ISO-8601 UTC timestamp.",
  )
  .refine(
    (value) => !Number.isNaN(Date.parse(value)),
    "Expected a valid ISO-8601 UTC timestamp.",
  );

const TargetResourceIdentitySchema = z
  .object({
    resourceType: NonEmptyStringSchema,
    resourceRef: NonEmptyStringSchema,
    resourceVersion: NonEmptyStringSchema.nullable(),
  })
  .strict();

const QueryScopeSchema = z
  .object({
    kind: z.enum(["exact_resource", "resource_collection"]),
    selector: NonEmptyStringSchema,
  })
  .strict();

const ObservationTimeWindowSchema = z
  .object({
    startsAt: IsoUtcTimestampSchema,
    endsAt: IsoUtcTimestampSchema,
  })
  .strict()
  .refine(
    (value) => Date.parse(value.startsAt) <= Date.parse(value.endsAt),
    {
      path: ["endsAt"],
      message: "Observation time window must not end before it starts.",
    },
  );

const CoverageCompletenessSchema = z
  .object({
    isComplete: z.literal(true),
    coveredSelectors: z
      .array(NonEmptyStringSchema)
      .min(1)
      .superRefine((values, context) => {
        if (new Set(values).size !== values.length) {
          context.addIssue({
            code: "custom",
            message: "Covered selectors must be unique.",
          });
        }
      }),
  })
  .strict();

const CommonSourceContractShape = {
  sourceContractSchemaVersion: z.literal(
    "forgeflow.recovery-source-contract.v1",
  ),
  taskId: NonEmptyStringSchema,
  reviewId: NonEmptyStringSchema,
  originalUnknownWriteToolRunId: NonEmptyStringSchema,
  targetResourceIdentity: TargetResourceIdentitySchema,
  queryScope: QueryScopeSchema,
  observationTimeWindow: ObservationTimeWindowSchema,
  coverageCompleteness: CoverageCompletenessSchema,
  sourceObservedAt: IsoUtcTimestampSchema,
  payloadDigest: Sha256DigestSchema,
} as const;

export const RecoverySystemVerifiedSourceContractV1Schema = z
  .object({
    ...CommonSourceContractShape,
    sourceContractAuthority: z.literal("system_verified"),
    sourceType: z.literal("system_verification"),
    provenance: z.literal("controlled_runtime_read"),
    negativeObservationSemantics: z.enum([
      "authoritative_absence",
      "authoritative_non_execution_marker",
    ]),
    result: z.literal("passed"),
    verifierBinding: z
      .object({
        verifierId: NonEmptyStringSchema,
        verifierVersion: NonEmptyStringSchema,
        verifierConfigDigest: Sha256DigestSchema,
        verificationId: NonEmptyStringSchema,
        bindingDigest: Sha256DigestSchema,
        verificationResult: z.literal("passed"),
      })
      .strict(),
  })
  .strict();

export const RecoveryManualAttestedSourceContractV1Schema = z
  .object({
    ...CommonSourceContractShape,
    sourceContractAuthority: z.literal("manual_attested"),
    sourceType: z.literal("manual_review"),
    provenance: z.literal("declared_payload"),
    negativeObservationSemantics: z.literal(
      "manual_attested_non_execution",
    ),
    result: z.enum(["passed", "inconclusive", "not_run"]),
    manualAttestation: z
      .object({
        actorId: NonEmptyStringSchema,
        actorType: z.literal("human_reviewer"),
        attestationId: NonEmptyStringSchema,
        attestationDigest: Sha256DigestSchema,
        responsibilityStatement: z.string().trim().min(1).max(2_000),
      })
      .strict(),
  })
  .strict();

export const RecoverySourceContractV1Schema = z
  .discriminatedUnion("sourceContractAuthority", [
    RecoverySystemVerifiedSourceContractV1Schema,
    RecoveryManualAttestedSourceContractV1Schema,
  ])
  .superRefine((value, context) => {
    const startsAt = Date.parse(value.observationTimeWindow.startsAt);
    const endsAt = Date.parse(value.observationTimeWindow.endsAt);
    const observedAt = Date.parse(value.sourceObservedAt);
    if (observedAt < startsAt || observedAt > endsAt) {
      context.addIssue({
        code: "custom",
        path: ["sourceObservedAt"],
        message:
          "sourceObservedAt must fall inside the observation time window.",
      });
    }
    if (
      !value.coverageCompleteness.coveredSelectors.includes(
        value.queryScope.selector,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["coverageCompleteness", "coveredSelectors"],
        message:
          "Coverage must include the declared query scope selector.",
      });
    }
  });

export type RecoverySourceContractV1 = z.infer<
  typeof RecoverySourceContractV1Schema
>;
export type RecoverySystemVerifiedSourceContractV1 = z.infer<
  typeof RecoverySystemVerifiedSourceContractV1Schema
>;
export type RecoveryManualAttestedSourceContractV1 = z.infer<
  typeof RecoveryManualAttestedSourceContractV1Schema
>;

export const RecoverySourceContractExpectedBindingsSchema = z
  .object({
    taskId: NonEmptyStringSchema,
    reviewId: NonEmptyStringSchema,
    originalUnknownWriteToolRunId: NonEmptyStringSchema,
    sourceContractAuthority: z.enum([
      "system_verified",
      "manual_attested",
    ]),
  })
  .strict();

export type RecoverySourceContractExpectedBindings = z.input<
  typeof RecoverySourceContractExpectedBindingsSchema
>;

export function canonicalRecoverySourceContractV1(
  input: unknown,
): string {
  return canonicalJson(
    RecoverySourceContractV1Schema.parse(input),
  );
}

export function computeRecoverySourceContractDigest(
  input: unknown,
): string {
  return sha256CanonicalJson(
    RecoverySourceContractV1Schema.parse(input),
  );
}

export function validateRecoverySourceContractV1(
  input: unknown,
  expected: RecoverySourceContractExpectedBindings,
): RecoverySourceContractV1 {
  const contract = RecoverySourceContractV1Schema.parse(input);
  const expectedBindings =
    RecoverySourceContractExpectedBindingsSchema.parse(expected);

  if (
    contract.taskId !== expectedBindings.taskId ||
    contract.reviewId !== expectedBindings.reviewId ||
    contract.originalUnknownWriteToolRunId !==
      expectedBindings.originalUnknownWriteToolRunId ||
    contract.sourceContractAuthority !==
      expectedBindings.sourceContractAuthority
  ) {
    throw new AppError({
      code: "RECOVERY_SOURCE_CONTRACT_BINDING_MISMATCH",
      message:
        "Recovery source contract bindings do not match the expected identity.",
      statusCode: 409,
      details: [],
    });
  }

  return contract;
}
