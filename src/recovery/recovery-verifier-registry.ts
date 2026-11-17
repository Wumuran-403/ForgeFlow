import { z } from "zod";

import {
  JsonValueSchema,
  RecoveryEvidencePayloadTypeSchema,
  RecoveryReviewSourceSchema,
} from "../storage/types.js";
import {
  RecoveryVerifierAlreadyRegisteredError,
  RecoveryVerifierCompatibilityError,
  RecoveryVerifierDefinitionInvalidError,
  RecoveryVerifierNotFoundError,
  RecoveryVerifierResultInvalidError,
} from "./recovery-contract-errors.js";
import {
  RecoveryEvidenceEnvelopeSchema,
  RecoveryReadbackResultSchema,
  type RecoveryEvidenceEnvelope,
} from "./recovery-evidence.js";

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

export const RecoveryVerifierIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Verifier ids must use lowercase host-stable identifiers.",
  );

const RecoveryVerifierAllowlistIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(128)
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "Allowlist ids must use lowercase host-stable identifiers.",
  );

export const RecoveryVerifierAllowedPayloadTypesSchema = z
  .array(RecoveryEvidencePayloadTypeSchema)
  .min(1)
  .max(4)
  .refine(
    (values) => new Set(values).size === values.length,
    "Allowed payload types must be unique.",
  );

export const RecoveryVerifierAllowedSourceTypesSchema = z
  .array(RecoveryReviewSourceSchema)
  .min(1)
  .max(2)
  .refine(
    (values) => new Set(values).size === values.length,
    "Allowed source types must be unique.",
  );

export const RecoveryVerifierDefinitionMetadataSchema = z
  .object({
    id: RecoveryVerifierIdSchema,
    version: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(1_000),
    allowedPayloadTypes: RecoveryVerifierAllowedPayloadTypesSchema,
    allowedSourceTypes: RecoveryVerifierAllowedSourceTypesSchema,
    readbackRequired: z.boolean(),
    allowlistId: RecoveryVerifierAllowlistIdSchema.nullable().default(null),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.readbackRequired) {
      if (value.allowlistId === null) {
        context.addIssue({
          code: "custom",
          path: ["allowlistId"],
          message: "Readback-required verifiers must select a host allowlist.",
        });
      }
      if (!value.allowedPayloadTypes.includes("readback_result")) {
        context.addIssue({
          code: "custom",
          path: ["allowedPayloadTypes"],
          message:
            "Readback-required verifiers must allow readback_result payloads.",
        });
      }
    } else if (value.allowlistId !== null) {
      context.addIssue({
        code: "custom",
        path: ["allowlistId"],
        message: "Verifiers without readback must not define an allowlist.",
      });
    }
  });

export const RecoveryVerifierDefinitionSchema = z
  .object({
    id: RecoveryVerifierIdSchema,
    version: z.string().trim().min(1).max(64),
    description: z.string().trim().min(1).max(1_000),
    allowedPayloadTypes: RecoveryVerifierAllowedPayloadTypesSchema,
    allowedSourceTypes: RecoveryVerifierAllowedSourceTypesSchema,
    readbackRequired: z.boolean(),
    allowlistId: RecoveryVerifierAllowlistIdSchema.nullable().default(null),
    verify: z.custom<RecoveryVerifierDefinition["verify"]>(
      (value) => typeof value === "function",
      "Recovery verifiers require a host verify function.",
    ),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.readbackRequired) {
      if (value.allowlistId === null) {
        context.addIssue({
          code: "custom",
          path: ["allowlistId"],
          message: "Readback-required verifiers must select a host allowlist.",
        });
      }
      if (!value.allowedPayloadTypes.includes("readback_result")) {
        context.addIssue({
          code: "custom",
          path: ["allowedPayloadTypes"],
          message:
            "Readback-required verifiers must allow readback_result payloads.",
        });
      }
    } else if (value.allowlistId !== null) {
      context.addIssue({
        code: "custom",
        path: ["allowlistId"],
        message: "Verifiers without readback must not define an allowlist.",
      });
    }
  });

export const RecoveryVerifierPayloadSchema = z
  .object({
    payloadType: RecoveryEvidencePayloadTypeSchema,
    bytes: z.instanceof(Uint8Array).nullable(),
    structuredValue: JsonValueSchema.nullable(),
    readbackResult: RecoveryReadbackResultSchema.nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    const contentCount =
      Number(value.bytes !== null) +
      Number(value.structuredValue !== null) +
      Number(value.readbackResult !== null);

    if (value.payloadType === "raw_bytes") {
      if (value.bytes === null || contentCount !== 1) {
        context.addIssue({
          code: "custom",
          path: ["bytes"],
          message: "raw_bytes payloads require only bytes.",
        });
      }
      return;
    }

    if (value.payloadType === "json") {
      if (value.structuredValue === null || contentCount !== 1) {
        context.addIssue({
          code: "custom",
          path: ["structuredValue"],
          message: "json payloads require only structuredValue.",
        });
      }
      return;
    }

    if (value.payloadType === "readback_result") {
      if (value.readbackResult === null || contentCount !== 1) {
        context.addIssue({
          code: "custom",
          path: ["readbackResult"],
          message: "readback_result payloads require only readbackResult.",
        });
      }
      return;
    }

    if (contentCount !== 1) {
      context.addIssue({
        code: "custom",
        path: ["payloadType"],
        message:
          "external_reference payloads require exactly one adapter-loaded content representation.",
      });
    }
  });

export const RecoveryVerifierInputSchema = z
  .object({
    manifest: RecoveryEvidenceEnvelopeSchema,
    payload: RecoveryVerifierPayloadSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (value.manifest.payloadType !== value.payload.payloadType) {
      context.addIssue({
        code: "custom",
        path: ["payload", "payloadType"],
        message: "Verifier payload type must match the evidence manifest.",
      });
    }
  });

export const RecoveryVerifierContextSchema = z
  .object({
    taskId: z.string().trim().min(1),
    reviewId: z.string().trim().min(1),
    originalToolRunId: z.string().trim().min(1),
    evidenceSubmissionId: z.string().trim().min(1),
    verificationId: z.string().trim().min(1),
    verificationCheckId: z.string().trim().min(1),
    verifierConfigDigest: Sha256DigestSchema,
    payloadType: RecoveryEvidencePayloadTypeSchema,
    sourceType: RecoveryReviewSourceSchema,
    verificationStartedAt: IsoUtcTimestampSchema,
    authenticatedActorId: z.string().trim().min(1).nullable(),
    trustAnchorId: z.string().trim().min(1).nullable(),
    readbackToolRunId: z.string().trim().min(1).nullable(),
    toolMessageId: z.string().trim().min(1).nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.sourceType === "manual_review" &&
      value.trustAnchorId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["trustAnchorId"],
        message: "Manual review context cannot claim a system trust anchor.",
      });
    }
    if (
      value.sourceType === "system_verification" &&
      value.authenticatedActorId !== null
    ) {
      context.addIssue({
        code: "custom",
        path: ["authenticatedActorId"],
        message:
          "System verification context cannot impersonate a manual actor.",
      });
    }
    const hasReadback =
      value.readbackToolRunId !== null || value.toolMessageId !== null;
    if (
      hasReadback &&
      (value.readbackToolRunId === null || value.toolMessageId === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["readbackToolRunId"],
        message:
          "Controlled readback requires both tool run and tool message identifiers.",
      });
    }
  });

export const RecoveryVerifierResultSchema = z
  .object({
    status: z.enum(["passed", "failed", "inconclusive"]),
    reasonCode: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .regex(/^[A-Z][A-Z0-9_]*$/),
    redactedSummary: z.string().trim().min(1).max(500),
    integrity: z.enum(["not_checked", "matched", "mismatch"]),
    authenticity: z.enum([
      "unverified",
      "manual_attested",
      "system_verified",
    ]),
  })
  .strict();

export const RecoveryVerifierCompatibilityInputSchema = z
  .object({
    verifierId: RecoveryVerifierIdSchema,
    payloadType: RecoveryEvidencePayloadTypeSchema,
    sourceType: RecoveryReviewSourceSchema,
    hasReadback: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.payloadType === "readback_result" && !value.hasReadback) {
      context.addIssue({
        code: "custom",
        path: ["hasReadback"],
        message: "readback_result evidence requires a controlled readback.",
      });
    }
  });

export type RecoveryVerifierPayload = z.infer<
  typeof RecoveryVerifierPayloadSchema
>;
export type RecoveryVerifierInput = z.infer<
  typeof RecoveryVerifierInputSchema
>;
export type RecoveryVerifierContext = z.infer<
  typeof RecoveryVerifierContextSchema
>;
export type RecoveryVerifierResult = z.infer<
  typeof RecoveryVerifierResultSchema
>;
export type RecoveryVerifierCompatibilityInput = z.input<
  typeof RecoveryVerifierCompatibilityInputSchema
>;

export interface RecoveryVerifierDefinition {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly allowedPayloadTypes: readonly RecoveryVerifierInput["payload"]["payloadType"][];
  readonly allowedSourceTypes: readonly RecoveryEvidenceEnvelope["sourceType"][];
  readonly readbackRequired: boolean;
  readonly allowlistId?: string | null;
  verify(
    input: RecoveryVerifierInput,
    context: RecoveryVerifierContext,
  ): RecoveryVerifierResult | Promise<RecoveryVerifierResult>;
}

export interface RegisteredRecoveryVerifier {
  readonly id: string;
  readonly version: string;
  readonly description: string;
  readonly allowedPayloadTypes: readonly RecoveryVerifierInput["payload"]["payloadType"][];
  readonly allowedSourceTypes: readonly RecoveryEvidenceEnvelope["sourceType"][];
  readonly readbackRequired: boolean;
  readonly allowlistId: string | null;
  readonly verify: RecoveryVerifierDefinition["verify"];
}

function toDetails(
  issues: readonly {
    readonly path: readonly PropertyKey[];
    readonly message: string;
  }[],
): readonly { path: string; message: string }[] {
  return issues.map((issue) => ({
    path: issue.path.map(String).join(".") || "verifier",
    message: issue.message,
  }));
}

function freezeVerifier(
  definition: RecoveryVerifierDefinition,
): RegisteredRecoveryVerifier {
  const parsed = RecoveryVerifierDefinitionSchema.parse(definition);

  return Object.freeze({
    id: parsed.id,
    version: parsed.version,
    description: parsed.description,
    allowedPayloadTypes: Object.freeze([...parsed.allowedPayloadTypes]),
    allowedSourceTypes: Object.freeze([...parsed.allowedSourceTypes]),
    readbackRequired: parsed.readbackRequired,
    allowlistId: parsed.allowlistId,
    verify: definition.verify,
  });
}

export class RecoveryVerifierRegistry {
  private readonly verifiers = new Map<string, RegisteredRecoveryVerifier>();

  register(definition: RecoveryVerifierDefinition): void {
    let registered: RegisteredRecoveryVerifier;
    try {
      registered = freezeVerifier(definition);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new RecoveryVerifierDefinitionInvalidError(
          toDetails(error.issues),
        );
      }
      throw error;
    }

    if (this.verifiers.has(registered.id)) {
      throw new RecoveryVerifierAlreadyRegisteredError(registered.id);
    }
    this.verifiers.set(registered.id, registered);
  }

  get(verifierId: string): RegisteredRecoveryVerifier {
    const verifier = this.verifiers.get(verifierId);
    if (verifier === undefined) {
      throw new RecoveryVerifierNotFoundError(verifierId);
    }
    return verifier;
  }

  resolve(
    input: RecoveryVerifierCompatibilityInput,
  ): RegisteredRecoveryVerifier {
    let parsed: z.output<
      typeof RecoveryVerifierCompatibilityInputSchema
    >;
    try {
      parsed = RecoveryVerifierCompatibilityInputSchema.parse(input);
    } catch (error) {
      if (error instanceof z.ZodError) {
        const verifierId =
          typeof input === "object" &&
          input !== null &&
          "verifierId" in input &&
          typeof input.verifierId === "string"
            ? input.verifierId
            : "unknown";
        throw new RecoveryVerifierCompatibilityError(
          verifierId,
          toDetails(error.issues),
        );
      }
      throw error;
    }
    const verifier = this.get(parsed.verifierId);
    const details: { path: string; message: string }[] = [];

    if (!verifier.allowedPayloadTypes.includes(parsed.payloadType)) {
      details.push({
        path: "payloadType",
        message: "Verifier does not allow this payload type.",
      });
    }
    if (!verifier.allowedSourceTypes.includes(parsed.sourceType)) {
      details.push({
        path: "sourceType",
        message: "Verifier does not allow this source type.",
      });
    }
    if (verifier.readbackRequired && !parsed.hasReadback) {
      details.push({
        path: "hasReadback",
        message: "Verifier requires a controlled readback.",
      });
    }
    if (details.length > 0) {
      throw new RecoveryVerifierCompatibilityError(verifier.id, details);
    }
    return verifier;
  }

  validateResult(
    verifierId: string,
    result: unknown,
    context: unknown,
  ): RecoveryVerifierResult {
    this.get(verifierId);
    let parsedContext: RecoveryVerifierContext;
    let parsedResult: RecoveryVerifierResult;
    try {
      parsedContext = RecoveryVerifierContextSchema.parse(context);
      parsedResult = RecoveryVerifierResultSchema.parse(result);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new RecoveryVerifierResultInvalidError(
          toDetails(error.issues),
        );
      }
      throw error;
    }

    this.resolve({
      verifierId,
      payloadType: parsedContext.payloadType,
      sourceType: parsedContext.sourceType,
      hasReadback:
        parsedContext.readbackToolRunId !== null &&
        parsedContext.toolMessageId !== null,
    });

    const details: { path: string; message: string }[] = [];
    if (
      parsedResult.authenticity === "manual_attested" &&
      (parsedContext.sourceType !== "manual_review" ||
        parsedContext.authenticatedActorId === null)
    ) {
      details.push({
        path: "authenticity",
        message:
          "manual_attested requires an authenticated manual-review actor.",
      });
    }
    if (
      parsedResult.authenticity === "system_verified" &&
      (parsedContext.sourceType !== "system_verification" ||
        parsedContext.trustAnchorId === null)
    ) {
      details.push({
        path: "authenticity",
        message:
          "system_verified requires a host-configured trust anchor.",
      });
    }
    if (details.length > 0) {
      throw new RecoveryVerifierResultInvalidError(details);
    }

    return Object.freeze({ ...parsedResult });
  }
}
