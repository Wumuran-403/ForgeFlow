import { z } from "zod";

import { AppError } from "../shared/errors.js";
import {
  JsonValueSchema,
  RecoveryEvidenceAvailabilityResultStatusSchema,
  RecoveryEvidenceDigestProtocolSchema,
  RecoveryEvidenceIntegrityStatusSchema,
  RecoveryEvidencePayloadStorageModeSchema,
  RecoveryEvidencePayloadTypeSchema,
  type JsonValue,
  type RecoveryEvidenceSubmissionRecord,
} from "../storage/types.js";
import { RecoveryVerifiedEvidencePayloadInvalidError } from "./recovery-contract-errors.js";
import type { EvidencePayloadStore } from "./evidence-payload-store.js";
import {
  RecoveryReadbackResultSchema,
  computeJsonPayloadDigest,
  computeRawPayloadDigest,
  computeReadbackResultPayloadDigest,
  type RecoveryReadbackResult,
} from "./recovery-evidence.js";
import {
  RecoveryVerifierPayloadSchema,
  type RecoveryVerifierPayload,
} from "./recovery-verifier-registry.js";

const Sha256DigestSchema = z.string().regex(/^sha256:[0-9a-f]{64}$/);
const StoreRefPattern =
  /^evidence-file:sha256\/([0-9a-f]{64})$/;

export const RecoveryEvidencePayloadIntegrityReasonCodeSchema = z.enum([
  "EVIDENCE_PAYLOAD_INTEGRITY_MATCHED",
  "EVIDENCE_PAYLOAD_STORE_REF_INVALID",
  "EVIDENCE_PAYLOAD_DIGEST_INVALID",
  "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
  "ENOENT",
  "EVIDENCE_PAYLOAD_STORE_IO_ERROR",
  "EVIDENCE_PAYLOAD_JSON_INVALID",
  "EVIDENCE_PAYLOAD_READBACK_RESULT_INVALID",
  "EVIDENCE_PAYLOAD_SEMANTIC_DIGEST_MISMATCH",
  "EVIDENCE_PAYLOAD_EXTERNAL_REFERENCE_UNSUPPORTED",
]);

export type RecoveryEvidencePayloadIntegrityReasonCode = z.infer<
  typeof RecoveryEvidencePayloadIntegrityReasonCodeSchema
>;

const RecoveryEvidencePayloadIntegrityManifestSchema = z
  .object({
    payloadType: RecoveryEvidencePayloadTypeSchema,
    payloadDigestProtocol: RecoveryEvidenceDigestProtocolSchema,
    payloadDigest: Sha256DigestSchema,
    payloadStoreRef: z.string().min(1).nullable(),
    payloadStorageMode: RecoveryEvidencePayloadStorageModeSchema,
  })
  .strict();

export type RecoveryEvidencePayloadIntegrityManifest = Pick<
  RecoveryEvidenceSubmissionRecord,
  | "payloadType"
  | "payloadDigestProtocol"
  | "payloadDigest"
  | "payloadStoreRef"
  | "payloadStorageMode"
>;

export const RecoveryEvidencePayloadIntegrityResultSchema = z
  .object({
    availabilityStatus:
      RecoveryEvidenceAvailabilityResultStatusSchema.extract([
        "available",
        "unavailable",
      ]),
    integrityStatus: RecoveryEvidenceIntegrityStatusSchema,
    actualStorageDigest: Sha256DigestSchema.nullable(),
    actualSemanticDigest: Sha256DigestSchema.nullable(),
    reasonCode: RecoveryEvidencePayloadIntegrityReasonCodeSchema,
    redactedSummary: z.string().trim().min(1).max(500),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.availabilityStatus === "unavailable" &&
      (value.integrityStatus !== "not_checked" ||
        value.actualStorageDigest !== null ||
        value.actualSemanticDigest !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["integrityStatus"],
        message:
          "Unavailable payloads must not claim observed integrity digests.",
      });
    }
    if (
      value.availabilityStatus === "available" &&
      value.integrityStatus === "not_checked"
    ) {
      context.addIssue({
        code: "custom",
        path: ["integrityStatus"],
        message: "Available payloads must include an integrity result.",
      });
    }
    if (
      value.integrityStatus === "matched" &&
      (value.actualStorageDigest === null ||
        value.actualSemanticDigest === null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["actualSemanticDigest"],
        message: "Matched integrity requires both observed digests.",
      });
    }
    if (
      (value.integrityStatus === "matched") !==
      (value.reasonCode === "EVIDENCE_PAYLOAD_INTEGRITY_MATCHED")
    ) {
      context.addIssue({
        code: "custom",
        path: ["reasonCode"],
        message:
          "Matched integrity and success reason code must agree.",
      });
    }
  });

export type RecoveryEvidencePayloadIntegrityResult = z.infer<
  typeof RecoveryEvidencePayloadIntegrityResultSchema
>;

export function verifyRecoveryEvidencePayloadIntegrity(
  manifest: RecoveryEvidencePayloadIntegrityManifest,
  payloadStore: EvidencePayloadStore,
): RecoveryEvidencePayloadIntegrityResult {
  return loadRecoveryEvidencePayloadWithIntegrity(
    manifest,
    payloadStore,
  ).result;
}

type VerifiedEvidencePayloadContent =
  | {
      readonly payloadType: "raw_bytes";
      readonly bytes: Uint8Array;
    }
  | {
      readonly payloadType: "json";
      readonly structuredValue: JsonValue;
    }
  | {
      readonly payloadType: "readback_result";
      readonly readbackResult: RecoveryReadbackResult;
    };

export interface VerifiedEvidencePayload {
  readonly payloadType: RecoveryEvidencePayloadIntegrityManifest["payloadType"];
  readonly provenance: "declared_payload";
}

export interface LoadedRecoveryEvidencePayload {
  readonly result: RecoveryEvidencePayloadIntegrityResult;
  readonly payload: VerifiedEvidencePayload | null;
}

const verifiedPayloadContents = new WeakMap<
  VerifiedEvidencePayload,
  VerifiedEvidencePayloadContent
>();

export function loadRecoveryEvidencePayloadWithIntegrity(
  manifest: RecoveryEvidencePayloadIntegrityManifest,
  payloadStore: EvidencePayloadStore,
): LoadedRecoveryEvidencePayload {
  if (manifest.payloadType === "external_reference") {
    return withoutVerifiedPayload(
      unavailableResult(
        "EVIDENCE_PAYLOAD_EXTERNAL_REFERENCE_UNSUPPORTED",
        "External reference payload requires a controlled adapter.",
      ),
    );
  }

  const parsedManifest =
    RecoveryEvidencePayloadIntegrityManifestSchema.safeParse({
      payloadType: manifest.payloadType,
      payloadDigestProtocol: manifest.payloadDigestProtocol,
      payloadDigest: manifest.payloadDigest,
      payloadStoreRef: manifest.payloadStoreRef,
      payloadStorageMode: manifest.payloadStorageMode,
    });
  if (!parsedManifest.success) {
    const digestInvalid = parsedManifest.error.issues.some(
      (issue) =>
        issue.path[0] === "payloadDigest" ||
        issue.path[0] === "payloadDigestProtocol",
    );
    return withoutVerifiedPayload(
      digestInvalid
        ? unavailableResult(
            "EVIDENCE_PAYLOAD_DIGEST_INVALID",
            "Evidence payload digest binding is invalid.",
          )
        : unavailableResult(
            "EVIDENCE_PAYLOAD_STORE_REF_INVALID",
            "Evidence payload storage reference is invalid.",
          ),
    );
  }

  const storeRefMatch =
    parsedManifest.data.payloadStorageMode ===
    "content_addressed_file"
      ? StoreRefPattern.exec(
          parsedManifest.data.payloadStoreRef ?? "",
        )
      : null;
  if (storeRefMatch === null) {
    return withoutVerifiedPayload(
      unavailableResult(
        "EVIDENCE_PAYLOAD_STORE_REF_INVALID",
        "Evidence payload storage reference is invalid.",
      ),
    );
  }

  const expectedStorageDigest = `sha256:${storeRefMatch[1]}`;
  let bytes: Uint8Array;
  try {
    bytes = payloadStore.read(
      parsedManifest.data.payloadStoreRef as string,
      expectedStorageDigest,
    );
  } catch (error) {
    return withoutVerifiedPayload(classifyStoreReadError(error));
  }

  const actualStorageDigest = computeRawPayloadDigest(bytes);
  if (actualStorageDigest !== expectedStorageDigest) {
    return withoutVerifiedPayload(
      mismatchResult(
        "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
        "Stored payload bytes do not match the storage digest.",
        actualStorageDigest,
        null,
      ),
    );
  }

  const expectedProtocol =
    parsedManifest.data.payloadType === "raw_bytes"
      ? "sha256-raw-v1"
      : "jcs-sha256-v1";
  if (
    parsedManifest.data.payloadDigestProtocol !== expectedProtocol
  ) {
    return withoutVerifiedPayload(
      mismatchResult(
        "EVIDENCE_PAYLOAD_DIGEST_INVALID",
        "Evidence payload type and digest protocol do not match.",
        actualStorageDigest,
        null,
      ),
    );
  }

  const semanticResult = computeSemanticDigest(
    parsedManifest.data.payloadType,
    bytes,
  );
  if (semanticResult.status === "invalid") {
    return withoutVerifiedPayload(
      mismatchResult(
        semanticResult.reasonCode,
        semanticResult.redactedSummary,
        actualStorageDigest,
        null,
      ),
    );
  }
  if (
    semanticResult.actualSemanticDigest !==
    parsedManifest.data.payloadDigest
  ) {
    return withoutVerifiedPayload(
      mismatchResult(
        "EVIDENCE_PAYLOAD_SEMANTIC_DIGEST_MISMATCH",
        "Payload semantic digest does not match the manifest digest.",
        actualStorageDigest,
        semanticResult.actualSemanticDigest,
      ),
    );
  }

  return {
    result: integrityResult({
      availabilityStatus: "available",
      integrityStatus: "matched",
      actualStorageDigest,
      actualSemanticDigest: semanticResult.actualSemanticDigest,
      reasonCode: "EVIDENCE_PAYLOAD_INTEGRITY_MATCHED",
      redactedSummary:
        "Evidence payload storage and semantic digests match.",
    }),
    payload: createVerifiedEvidencePayload(semanticResult.content),
  };
}

export function materializeVerifiedEvidencePayload(
  payload: VerifiedEvidencePayload,
): RecoveryVerifierPayload {
  const content = verifiedPayloadContents.get(payload);
  if (content === undefined) {
    throw new RecoveryVerifiedEvidencePayloadInvalidError();
  }

  if (content.payloadType === "raw_bytes") {
    const verifierPayload = RecoveryVerifierPayloadSchema.parse({
      payloadType: "raw_bytes",
      bytes: new Uint8Array(content.bytes),
      structuredValue: null,
      readbackResult: null,
    });
    return Object.freeze(verifierPayload);
  }
  if (content.payloadType === "json") {
    const parsed = RecoveryVerifierPayloadSchema.parse({
      payloadType: "json",
      bytes: null,
      structuredValue: structuredClone(content.structuredValue),
      readbackResult: null,
    });
    return Object.freeze({
      ...parsed,
      structuredValue: freezeJsonTree(
        parsed.structuredValue,
      ) as JsonValue,
    });
  }
  const parsed = RecoveryVerifierPayloadSchema.parse({
    payloadType: "readback_result",
    bytes: null,
    structuredValue: null,
    readbackResult: structuredClone(content.readbackResult),
  });
  return Object.freeze({
    ...parsed,
    readbackResult: freezeJsonTree(
      parsed.readbackResult,
    ) as RecoveryReadbackResult,
  });
}

type SemanticDigestResult =
  | {
      readonly status: "valid";
      readonly actualSemanticDigest: string;
      readonly content: VerifiedEvidencePayloadContent;
    }
  | {
      readonly status: "invalid";
      readonly reasonCode:
        | "EVIDENCE_PAYLOAD_JSON_INVALID"
        | "EVIDENCE_PAYLOAD_READBACK_RESULT_INVALID";
      readonly redactedSummary: string;
    };

function computeSemanticDigest(
  payloadType: RecoveryEvidencePayloadIntegrityManifest["payloadType"],
  bytes: Uint8Array,
): SemanticDigestResult {
  if (payloadType === "raw_bytes") {
    return {
      status: "valid",
      actualSemanticDigest: computeRawPayloadDigest(bytes),
      content: {
        payloadType: "raw_bytes",
        bytes: new Uint8Array(bytes),
      },
    };
  }

  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      status: "invalid",
      reasonCode: "EVIDENCE_PAYLOAD_JSON_INVALID",
      redactedSummary:
        "Evidence payload is not valid UTF-8 JSON.",
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      status: "invalid",
      reasonCode: "EVIDENCE_PAYLOAD_JSON_INVALID",
      redactedSummary: "Evidence payload is not valid JSON.",
    };
  }

  if (payloadType === "json") {
    try {
      const structuredValue = JsonValueSchema.parse(parsed);
      return {
        status: "valid",
        actualSemanticDigest:
          computeJsonPayloadDigest(structuredValue),
        content: {
          payloadType: "json",
          structuredValue,
        },
      };
    } catch {
      return {
        status: "invalid",
        reasonCode: "EVIDENCE_PAYLOAD_JSON_INVALID",
        redactedSummary:
          "Evidence payload is not valid canonical JSON input.",
      };
    }
  }

  const parsedReadback =
    RecoveryReadbackResultSchema.safeParse(parsed);
  if (!parsedReadback.success) {
    return {
      status: "invalid",
      reasonCode: "EVIDENCE_PAYLOAD_READBACK_RESULT_INVALID",
      redactedSummary:
        "Readback payload does not match the recovery readback schema.",
    };
  }

  try {
    return {
      status: "valid",
      actualSemanticDigest: computeReadbackResultPayloadDigest(
        parsedReadback.data,
      ),
      content: {
        payloadType: "readback_result",
        readbackResult: parsedReadback.data,
      },
    };
  } catch {
    return {
      status: "invalid",
      reasonCode: "EVIDENCE_PAYLOAD_JSON_INVALID",
      redactedSummary:
        "Readback payload is not valid canonical JSON input.",
    };
  }
}

function createVerifiedEvidencePayload(
  content: VerifiedEvidencePayloadContent,
): VerifiedEvidencePayload {
  const payload: VerifiedEvidencePayload = Object.freeze({
    payloadType: content.payloadType,
    provenance: "declared_payload",
  });
  verifiedPayloadContents.set(
    payload,
    Object.freeze(
      content.payloadType === "raw_bytes"
        ? {
            payloadType: content.payloadType,
            bytes: new Uint8Array(content.bytes),
          }
        : content,
    ),
  );
  return payload;
}

function withoutVerifiedPayload(
  result: RecoveryEvidencePayloadIntegrityResult,
): LoadedRecoveryEvidencePayload {
  return {
    result: integrityResult(result),
    payload: null,
  };
}

function freezeJsonTree(value: unknown): unknown {
  if (Array.isArray(value)) {
    return Object.freeze(value.map(freezeJsonTree));
  }
  if (value !== null && typeof value === "object") {
    return Object.freeze(
      Object.fromEntries(
        Object.entries(value).map(([key, nested]) => [
          key,
          freezeJsonTree(nested),
        ]),
      ),
    );
  }
  return value;
}

function classifyStoreReadError(
  error: unknown,
): RecoveryEvidencePayloadIntegrityResult {
  if (
    error instanceof AppError &&
    error.code === "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH"
  ) {
    return mismatchResult(
      "EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH",
      "Stored payload bytes do not match the storage digest.",
      null,
      null,
    );
  }
  if (hasErrorCode(error, "ENOENT")) {
    return unavailableResult(
      "ENOENT",
      "Evidence payload is missing.",
    );
  }
  return unavailableResult(
    "EVIDENCE_PAYLOAD_STORE_IO_ERROR",
    "Evidence payload storage could not be read.",
  );
}

function unavailableResult(
  reasonCode: RecoveryEvidencePayloadIntegrityReasonCode,
  redactedSummary: string,
): RecoveryEvidencePayloadIntegrityResult {
  return {
    availabilityStatus: "unavailable",
    integrityStatus: "not_checked",
    actualStorageDigest: null,
    actualSemanticDigest: null,
    reasonCode,
    redactedSummary,
  };
}

function mismatchResult(
  reasonCode: RecoveryEvidencePayloadIntegrityReasonCode,
  redactedSummary: string,
  actualStorageDigest: string | null,
  actualSemanticDigest: string | null,
): RecoveryEvidencePayloadIntegrityResult {
  return {
    availabilityStatus: "available",
    integrityStatus: "mismatch",
    actualStorageDigest,
    actualSemanticDigest,
    reasonCode,
    redactedSummary,
  };
}

function integrityResult(
  result: RecoveryEvidencePayloadIntegrityResult,
): RecoveryEvidencePayloadIntegrityResult {
  return RecoveryEvidencePayloadIntegrityResultSchema.parse(result);
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
