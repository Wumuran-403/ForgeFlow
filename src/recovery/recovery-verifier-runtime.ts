import { z } from "zod";

import {
  sha256CanonicalJson,
} from "../shared/canonical-json.js";
import {
  JsonValueSchema,
  RecoveryEvidenceIntegrityStatusSchema,
  RecoveryEvidenceVerificationResultStatusSchema,
  type JsonValue,
  type RecoveryEvidenceVerificationCheckRecord,
} from "../storage/types.js";
import {
  RecoveryVerifierBindingDefinitionInvalidError,
  RecoveryVerifierBindingNotFoundError,
  RecoveryVerifierCompatibilityError,
  RecoveryVerifierNotFoundError,
  RecoveryVerifierResultInvalidError,
  RecoveryVerifiedEvidencePayloadInvalidError,
} from "./recovery-contract-errors.js";
import {
  RecoveryEvidenceEnvelopeSchema,
  type RecoveryEvidenceEnvelope,
} from "./recovery-evidence.js";
import {
  materializeVerifiedEvidencePayload,
  type VerifiedEvidencePayload,
} from "./recovery-evidence-payload-integrity.js";
import {
  RecoveryVerifierContextSchema,
  RecoveryVerifierIdSchema,
  RecoveryVerifierInputSchema,
  RecoveryVerifierRegistry,
  type RecoveryVerifierContext,
  type RecoveryVerifierInput,
  type RecoveryVerifierResult,
  type RegisteredRecoveryVerifier,
} from "./recovery-verifier-registry.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const VerifierVersionSchema = z.string().trim().min(1).max(64);
const TimeoutMsSchema = z
  .number()
  .int()
  .positive()
  .max(2_147_483_647);

const RecoveryVerifierReasonCodeSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Z][A-Z0-9_]*$/);

export const RecoveryVerifierEffectiveConfigSchema = z
  .object({
    protocolVersion: z.literal(
      "forgeflow.recovery-verifier-effective-config.v1",
    ),
    verifierId: RecoveryVerifierIdSchema,
    verifierVersion: VerifierVersionSchema,
    timeoutMs: TimeoutMsSchema,
    ruleConfig: JsonValueSchema,
  })
  .strict();

export type RecoveryVerifierEffectiveConfig = z.infer<
  typeof RecoveryVerifierEffectiveConfigSchema
>;

export const RecoveryVerifierHostBindingDefinitionSchema = z
  .object({
    verifierId: RecoveryVerifierIdSchema,
    verifierVersion: VerifierVersionSchema,
    timeoutMs: TimeoutMsSchema,
    ruleConfig: JsonValueSchema,
    active: z.boolean(),
  })
  .strict();

export type RecoveryVerifierHostBindingDefinition = z.input<
  typeof RecoveryVerifierHostBindingDefinitionSchema
>;

export const RecoveryVerifierHostBindingSchema = z
  .object({
    verifierId: RecoveryVerifierIdSchema,
    verifierVersion: VerifierVersionSchema,
    verifierConfigDigest: Sha256DigestSchema,
    timeoutMs: TimeoutMsSchema,
    effectiveConfig: RecoveryVerifierEffectiveConfigSchema,
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.effectiveConfig.verifierId !== value.verifierId ||
      value.effectiveConfig.verifierVersion !==
        value.verifierVersion ||
      value.effectiveConfig.timeoutMs !== value.timeoutMs ||
      sha256CanonicalJson(value.effectiveConfig) !==
        value.verifierConfigDigest
    ) {
      context.addIssue({
        code: "custom",
        path: ["verifierConfigDigest"],
        message:
          "Verifier host binding does not match its effective config.",
      });
    }
  });

export type RecoveryVerifierHostBinding = z.infer<
  typeof RecoveryVerifierHostBindingSchema
>;

export const RecoveryPersistedVerifierBindingSchema = z
  .object({
    verifierId: RecoveryVerifierIdSchema,
    verifierVersion: VerifierVersionSchema,
    verifierConfigDigest: Sha256DigestSchema,
  })
  .strict();

export type RecoveryPersistedVerifierBinding = Pick<
  RecoveryEvidenceVerificationCheckRecord,
  "verifierId" | "verifierVersion" | "verifierConfigDigest"
>;

const HostBindingDefinitionListSchema = z
  .array(RecoveryVerifierHostBindingDefinitionSchema)
  .min(1);

export class RecoveryVerifierHostBindingProvider {
  private readonly bindingsByDigest = new Map<
    string,
    RecoveryVerifierHostBinding
  >();
  private readonly activeBindings = new Map<
    string,
    RecoveryVerifierHostBinding
  >();

  constructor(
    definitions: readonly RecoveryVerifierHostBindingDefinition[],
  ) {
    let parsedDefinitions;
    try {
      parsedDefinitions = HostBindingDefinitionListSchema.parse(definitions);
    } catch (error) {
      if (error instanceof z.ZodError) {
        throw new RecoveryVerifierBindingDefinitionInvalidError(
          error.issues.map((issue) => ({
            path: issue.path.map(String).join(".") || "binding",
            message: issue.message,
          })),
        );
      }
      throw error;
    }

    for (const definition of parsedDefinitions) {
      const effectiveConfig =
        RecoveryVerifierEffectiveConfigSchema.parse({
          protocolVersion:
            "forgeflow.recovery-verifier-effective-config.v1",
          verifierId: definition.verifierId,
          verifierVersion: definition.verifierVersion,
          timeoutMs: definition.timeoutMs,
          ruleConfig: structuredClone(definition.ruleConfig),
        });
      const parsedBinding =
        RecoveryVerifierHostBindingSchema.parse({
          verifierId: definition.verifierId,
          verifierVersion: definition.verifierVersion,
          verifierConfigDigest:
            sha256CanonicalJson(effectiveConfig),
          timeoutMs: definition.timeoutMs,
          effectiveConfig: freezeEffectiveConfig(effectiveConfig),
        });
      const binding = Object.freeze({
        ...parsedBinding,
        effectiveConfig: freezeEffectiveConfig(
          parsedBinding.effectiveConfig,
        ),
      });
      const bindingKey = verifierBindingKey(binding);
      if (this.bindingsByDigest.has(bindingKey)) {
        throw new RecoveryVerifierBindingDefinitionInvalidError([
          {
            path: "definitions",
            message: "Verifier host bindings must be unique.",
          },
        ]);
      }
      this.bindingsByDigest.set(bindingKey, binding);

      if (definition.active) {
        if (this.activeBindings.has(definition.verifierId)) {
          throw new RecoveryVerifierBindingDefinitionInvalidError([
            {
              path: "active",
              message:
                "Each verifier id requires at most one active host binding.",
            },
          ]);
        }
        this.activeBindings.set(definition.verifierId, binding);
      }
    }
  }

  getForNewCheck(verifierId: string): RecoveryVerifierHostBinding {
    let parsedVerifierId: string;
    try {
      parsedVerifierId = RecoveryVerifierIdSchema.parse(verifierId);
    } catch {
      throw new RecoveryVerifierBindingNotFoundError([
        {
          path: "verifierId",
          message: "Host verifier id is invalid.",
        },
      ]);
    }
    const binding = this.activeBindings.get(parsedVerifierId);
    if (binding === undefined) {
      throw new RecoveryVerifierBindingNotFoundError([
        {
          path: "verifierId",
          message: "No active host binding is configured.",
        },
      ]);
    }
    return binding;
  }

  restore(
    persisted: RecoveryPersistedVerifierBinding,
  ): RecoveryVerifierHostBinding {
    let parsed: RecoveryPersistedVerifierBinding;
    try {
      parsed = RecoveryPersistedVerifierBindingSchema.parse({
        verifierId: persisted.verifierId,
        verifierVersion: persisted.verifierVersion,
        verifierConfigDigest: persisted.verifierConfigDigest,
      });
    } catch {
      throw new RecoveryVerifierBindingNotFoundError([
        {
          path: "binding",
          message: "Persisted verifier binding is invalid.",
        },
      ]);
    }
    const binding = this.bindingsByDigest.get(
      verifierBindingKey(parsed),
    );
    if (binding === undefined) {
      throw new RecoveryVerifierBindingNotFoundError([
        {
          path: "verifierConfigDigest",
          message:
            "The exact persisted verifier binding is unavailable.",
        },
      ]);
    }
    return binding;
  }
}

export const RecoveryVerifierRuntimeExecutionResultSchema = z
  .object({
    status: RecoveryEvidenceVerificationResultStatusSchema,
    reasonCode: RecoveryVerifierReasonCodeSchema,
    redactedSummary: z.string().trim().min(1).max(500),
    integrityStatus: RecoveryEvidenceIntegrityStatusSchema,
    authenticityStatus: z.literal("unverified"),
    verificationEventRequired: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "not_run") {
      if (value.verificationEventRequired) {
        context.addIssue({
          code: "custom",
          path: ["verificationEventRequired"],
          message: "not_run must not request a Verification Event.",
        });
      }
      if (!["not_checked", "matched"].includes(value.integrityStatus)) {
        context.addIssue({
          code: "custom",
          path: ["integrityStatus"],
          message: "not_run requires a safe integrity state.",
        });
      }
      return;
    }
    if (
      value.integrityStatus !== "matched" ||
      !value.verificationEventRequired
    ) {
      context.addIssue({
        code: "custom",
        path: ["integrityStatus"],
        message:
          "Started verifiers require matched integrity and a Verification Event.",
      });
    }
  });

export type RecoveryVerifierRuntimeExecutionResult = z.infer<
  typeof RecoveryVerifierRuntimeExecutionResultSchema
>;

export interface ExecutePersistedRecoveryVerifierInput {
  readonly binding: RecoveryPersistedVerifierBinding;
  readonly manifest: RecoveryEvidenceEnvelope;
  readonly verifiedPayload: VerifiedEvidencePayload;
  readonly context: RecoveryVerifierContext;
}

export class RecoveryVerifierRuntime {
  constructor(
    private readonly registry: RecoveryVerifierRegistry,
    private readonly bindingProvider: RecoveryVerifierHostBindingProvider,
  ) {}

  getBindingForNewCheck(verifierId: string): RecoveryVerifierHostBinding {
    return this.bindingProvider.getForNewCheck(verifierId);
  }

  restoreBinding(
    persisted: RecoveryPersistedVerifierBinding,
  ): RecoveryVerifierHostBinding {
    return this.bindingProvider.restore(persisted);
  }

  async executePersisted(
    input: ExecutePersistedRecoveryVerifierInput,
  ): Promise<RecoveryVerifierRuntimeExecutionResult> {
    let verifierPayload: RecoveryVerifierInput["payload"];
    try {
      verifierPayload = materializeVerifiedEvidencePayload(
        input.verifiedPayload,
      );
    } catch (error) {
      if (error instanceof RecoveryVerifiedEvidencePayloadInvalidError) {
        return notRunResult(
          "VERIFIED_PAYLOAD_INVALID",
          "Verified evidence payload handoff is invalid.",
          "not_checked",
        );
      }
      return notRunResult(
        "VERIFIED_PAYLOAD_INVALID",
        "Verified evidence payload handoff is invalid.",
        "not_checked",
      );
    }

    let binding: RecoveryVerifierHostBinding;
    try {
      binding = this.bindingProvider.restore(input.binding);
    } catch (error) {
      if (error instanceof RecoveryVerifierBindingNotFoundError) {
        return notRunResult(
          "VERIFIER_BINDING_UNAVAILABLE",
          "The exact persisted verifier binding is unavailable.",
          "matched",
        );
      }
      return notRunResult(
        "VERIFIER_BINDING_UNAVAILABLE",
        "The exact persisted verifier binding is unavailable.",
        "matched",
      );
    }

    let manifest: RecoveryEvidenceEnvelope;
    let context: RecoveryVerifierContext;
    try {
      manifest = RecoveryEvidenceEnvelopeSchema.parse(input.manifest);
      context = Object.freeze(
        RecoveryVerifierContextSchema.parse({
          ...input.context,
          verifierConfigDigest: binding.verifierConfigDigest,
          trustAnchorId: null,
          readbackToolRunId: null,
          toolMessageId: null,
        }),
      );
      if (
        input.context.verifierConfigDigest !==
        binding.verifierConfigDigest
      ) {
        return notRunResult(
          "VERIFIER_CONFIG_DIGEST_MISMATCH",
          "Verifier context does not match the persisted binding.",
          "matched",
        );
      }
      if (
        manifest.taskId !== context.taskId ||
        manifest.toolRunId !== context.originalToolRunId ||
        manifest.sourceType !== context.sourceType ||
        verifierPayload.payloadType !== manifest.payloadType
      ) {
        return notRunResult(
          "VERIFIED_PAYLOAD_INVALID",
          "Verified evidence payload does not match the manifest.",
          "matched",
        );
      }
    } catch {
      return notRunResult(
        "VERIFIER_CONTEXT_INVALID",
        "Verifier runtime context is invalid.",
        "matched",
      );
    }

    let verifier: RegisteredRecoveryVerifier;
    try {
      verifier = this.registry.get(binding.verifierId);
      if (verifier.version !== binding.verifierVersion) {
        return notRunResult(
          "VERIFIER_VERSION_MISMATCH",
          "Registry verifier version does not match the persisted binding.",
          "matched",
        );
      }
      verifier = this.registry.resolve({
        verifierId: binding.verifierId,
        payloadType: manifest.payloadType,
        sourceType: manifest.sourceType,
        hasReadback: false,
      });
    } catch (error) {
      if (error instanceof RecoveryVerifierNotFoundError) {
        return notRunResult(
          "VERIFIER_NOT_REGISTERED",
          "The persisted verifier is not registered.",
          "matched",
        );
      }
      if (error instanceof RecoveryVerifierCompatibilityError) {
        return notRunResult(
          "VERIFIER_INCOMPATIBLE",
          "The persisted verifier is incompatible with this evidence.",
          "matched",
        );
      }
      return notRunResult(
        "VERIFIER_RESOLVE_FAILED",
        "The persisted verifier could not be resolved.",
        "matched",
      );
    }

    let verifierInput: RecoveryVerifierInput;
    try {
      const parsedVerifierInput = RecoveryVerifierInputSchema.parse({
        manifest,
        payload: verifierPayload,
      });
      verifierInput = Object.freeze({
        ...parsedVerifierInput,
        manifest: Object.freeze(parsedVerifierInput.manifest),
        payload: Object.freeze({
          ...parsedVerifierInput.payload,
          bytes:
            parsedVerifierInput.payload.bytes === null
              ? null
              : new Uint8Array(
                  parsedVerifierInput.payload.bytes,
                ),
          structuredValue:
            parsedVerifierInput.payload.structuredValue === null
              ? null
              : freezeJsonValue(
                  parsedVerifierInput.payload.structuredValue,
                ),
          readbackResult:
            parsedVerifierInput.payload.readbackResult === null
              ? null
              : (freezeJsonValue(
                  parsedVerifierInput.payload
                    .readbackResult as unknown as JsonValue,
                ) as unknown as RecoveryVerifierInput["payload"]["readbackResult"]),
        }),
      });
    } catch {
      return notRunResult(
        "VERIFIED_PAYLOAD_INVALID",
        "Verified evidence payload does not match the verifier contract.",
        "matched",
      );
    }
    return executeWithTimeout(
      this.registry,
      verifier,
      verifierInput,
      context,
      binding.timeoutMs,
    );
  }
}

async function executeWithTimeout(
  registry: RecoveryVerifierRegistry,
  verifier: RegisteredRecoveryVerifier,
  input: RecoveryVerifierInput,
  context: RecoveryVerifierContext,
  timeoutMs: number,
): Promise<RecoveryVerifierRuntimeExecutionResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: NodeJS.Timeout | undefined;

    const settle = (
      result: RecoveryVerifierRuntimeExecutionResult,
    ): void => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeout !== undefined) {
        clearTimeout(timeout);
      }
      resolve(
        RecoveryVerifierRuntimeExecutionResultSchema.parse(result),
      );
    };

    timeout = setTimeout(() => {
      settle(
        completedResult(
          "inconclusive",
          "VERIFIER_TIMEOUT",
          "Verifier execution timed out.",
        ),
      );
    }, timeoutMs);

    let candidate: RecoveryVerifierResult | Promise<RecoveryVerifierResult>;
    try {
      candidate = verifier.verify(input, context);
    } catch {
      settle(
        completedResult(
          "inconclusive",
          "VERIFIER_REJECTED",
          "Verifier execution failed.",
        ),
      );
      return;
    }

    void Promise.resolve(candidate).then(
      (result) => {
        if (settled) {
          return;
        }
        try {
          const validated = registry.validateResult(
            verifier.id,
            result,
            context,
          );
          settle(
            completedResult(
              validated.status,
              validated.reasonCode,
              validated.redactedSummary,
            ),
          );
        } catch (error) {
          if (error instanceof RecoveryVerifierResultInvalidError) {
            settle(
              completedResult(
                "inconclusive",
                "VERIFIER_RESULT_INVALID",
                "Verifier returned an invalid result.",
              ),
            );
            return;
          }
          settle(
            completedResult(
              "inconclusive",
              "VERIFIER_RESULT_INVALID",
              "Verifier result could not be validated.",
            ),
          );
        }
      },
      () => {
        if (settled) {
          return;
        }
        settle(
          completedResult(
            "inconclusive",
            "VERIFIER_REJECTED",
            "Verifier execution failed.",
          ),
        );
      },
    );
  });
}

function completedResult(
  status: "passed" | "failed" | "inconclusive",
  reasonCode: string,
  redactedSummary: string,
): RecoveryVerifierRuntimeExecutionResult {
  return {
    status,
    reasonCode,
    redactedSummary,
    integrityStatus: "matched",
    authenticityStatus: "unverified",
    verificationEventRequired: true,
  };
}

function notRunResult(
  reasonCode: string,
  redactedSummary: string,
  integrityStatus: "not_checked" | "matched",
): RecoveryVerifierRuntimeExecutionResult {
  return {
    status: "not_run",
    reasonCode,
    redactedSummary,
    integrityStatus,
    authenticityStatus: "unverified",
    verificationEventRequired: false,
  };
}

function verifierBindingKey(input: {
  readonly verifierId: string;
  readonly verifierVersion: string;
  readonly verifierConfigDigest: string;
}): string {
  return [
    input.verifierId,
    input.verifierVersion,
    input.verifierConfigDigest,
  ].join("\u0000");
}

function freezeEffectiveConfig(
  input: RecoveryVerifierEffectiveConfig,
): RecoveryVerifierEffectiveConfig {
  return Object.freeze({
    ...input,
    ruleConfig: freezeJsonValue(input.ruleConfig),
  });
}

function freezeJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonValue));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          freezeJsonValue(nested),
        ]),
      ),
    );
  }
  return value;
}
