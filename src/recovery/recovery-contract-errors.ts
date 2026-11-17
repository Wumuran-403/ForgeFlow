import { AppError, type AppErrorDetail } from "../shared/errors.js";

export class RecoveryVerifierDefinitionInvalidError extends AppError {
  constructor(details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_VERIFIER_DEFINITION_INVALID",
      message: "Recovery verifier definition is invalid.",
      statusCode: 400,
      details,
    });
  }
}

export class RecoveryVerifierAlreadyRegisteredError extends AppError {
  constructor(verifierId: string) {
    super({
      code: "RECOVERY_VERIFIER_ALREADY_REGISTERED",
      message: `Recovery verifier "${verifierId}" is already registered.`,
      statusCode: 409,
      details: [{ path: "id", message: "Verifier id must be unique." }],
    });
  }
}

export class RecoveryVerifierNotFoundError extends AppError {
  constructor(verifierId: string) {
    super({
      code: "RECOVERY_VERIFIER_NOT_FOUND",
      message: `Recovery verifier "${verifierId}" is not registered.`,
      statusCode: 404,
      details: [{ path: "verifierId", message: "No registered verifier matches." }],
    });
  }
}

export class RecoveryVerifierCompatibilityError extends AppError {
  constructor(verifierId: string, details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_VERIFIER_INCOMPATIBLE",
      message: `Recovery verifier "${verifierId}" cannot handle the requested evidence.`,
      statusCode: 409,
      details,
    });
  }
}

export class RecoveryVerifierResultInvalidError extends AppError {
  constructor(details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_VERIFIER_RESULT_INVALID",
      message: "Recovery verifier returned an invalid result.",
      statusCode: 400,
      details,
    });
  }
}

export class RecoveryVerifierBindingDefinitionInvalidError extends AppError {
  constructor(details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_VERIFIER_BINDING_DEFINITION_INVALID",
      message: "Recovery verifier host binding definition is invalid.",
      statusCode: 400,
      details,
    });
  }
}

export class RecoveryVerifierBindingNotFoundError extends AppError {
  constructor(details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_VERIFIER_BINDING_NOT_FOUND",
      message: "Recovery verifier host binding is unavailable.",
      statusCode: 404,
      details,
    });
  }
}

export class RecoveryVerifiedEvidencePayloadInvalidError extends AppError {
  constructor() {
    super({
      code: "RECOVERY_VERIFIED_EVIDENCE_PAYLOAD_INVALID",
      message: "Verified evidence payload handoff is invalid.",
      statusCode: 500,
      details: [],
    });
  }
}

export class RecoveryReadbackDefinitionInvalidError extends AppError {
  constructor(details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_READBACK_DEFINITION_INVALID",
      message: "Recovery readback tool definition is invalid.",
      statusCode: 400,
      details,
    });
  }
}

export class RecoveryReadbackAlreadyRegisteredError extends AppError {
  constructor(allowlistId: string) {
    super({
      code: "RECOVERY_READBACK_ALREADY_REGISTERED",
      message: `Recovery readback allowlist "${allowlistId}" is already registered.`,
      statusCode: 409,
      details: [{ path: "allowlistId", message: "Allowlist id must be unique." }],
    });
  }
}

export class RecoveryReadbackNotFoundError extends AppError {
  constructor(allowlistId: string) {
    super({
      code: "RECOVERY_READBACK_NOT_FOUND",
      message: `Recovery readback allowlist "${allowlistId}" is not registered.`,
      statusCode: 404,
      details: [{ path: "allowlistId", message: "No registered allowlist matches." }],
    });
  }
}

export class RecoveryReadbackToolMismatchError extends AppError {
  constructor(allowlistId: string, details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_READBACK_TOOL_MISMATCH",
      message: `Recovery readback allowlist "${allowlistId}" does not match ToolRegistry metadata.`,
      statusCode: 409,
      details,
    });
  }
}

export class RecoveryReadbackToolForbiddenError extends AppError {
  constructor(toolName: string) {
    super({
      code: "RECOVERY_READBACK_TOOL_FORBIDDEN",
      message: `Tool "${toolName}" is not allowed as a recovery readback tool.`,
      statusCode: 400,
      details: [
        {
          path: "name",
          message: "Generic URL fetching is not a valid recovery readback contract.",
        },
      ],
    });
  }
}

export class RecoveryReadbackVersionMismatchError extends AppError {
  constructor(allowlistId: string) {
    super({
      code: "RECOVERY_READBACK_VERSION_MISMATCH",
      message: `Recovery readback allowlist "${allowlistId}" does not match its immutable contract version.`,
      statusCode: 409,
      details: [
        {
          path: "allowlistVersion",
          message: "Contract digest must equal allowlistVersion.",
        },
      ],
    });
  }
}

export class RecoveryReadbackVersionRequiredError extends AppError {
  constructor(allowlistId: string) {
    super({
      code: "RECOVERY_READBACK_VERSION_REQUIRED",
      message: `Recovery readback allowlist "${allowlistId}" has multiple versions.`,
      statusCode: 400,
      details: [
        {
          path: "allowlistVersion",
          message: "An exact allowlistVersion is required.",
        },
      ],
    });
  }
}

export class RecoveryReadbackSourceInvalidError extends AppError {
  constructor(allowlistId: string) {
    super({
      code: "RECOVERY_READBACK_SOURCE_INVALID",
      message: `Recovery readback source is invalid for allowlist "${allowlistId}".`,
      statusCode: 409,
      details: [],
    });
  }
}

export class RecoveryReadbackResultContractInvalidError extends AppError {
  constructor(allowlistId: string) {
    super({
      code: "RECOVERY_READBACK_RESULT_CONTRACT_INVALID",
      message: `Recovery readback result is invalid for allowlist "${allowlistId}".`,
      statusCode: 409,
      details: [],
    });
  }
}

export class RecoveryReadbackArgumentsInvalidError extends AppError {
  constructor(allowlistId: string, details: readonly AppErrorDetail[]) {
    super({
      code: "RECOVERY_READBACK_ARGUMENTS_INVALID",
      message: `Recovery readback arguments are invalid for allowlist "${allowlistId}".`,
      statusCode: 400,
      details,
    });
  }
}
