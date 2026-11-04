import { AppError, type AppErrorDetail } from "../shared/errors.js";

export class ToolAlreadyRegisteredError extends AppError {
  constructor(toolName: string) {
    super({
      code: "TOOL_ALREADY_REGISTERED",
      message: `Tool "${toolName}" is already registered.`,
      statusCode: 409,
      details: [{ path: "name", message: "Tool name must be unique." }],
    });
  }
}

export class ToolDefinitionInvalidError extends AppError {
  constructor(toolName: string, details: readonly AppErrorDetail[]) {
    super({
      code: "TOOL_DEFINITION_INVALID",
      message: `Tool "${toolName}" has an invalid definition.`,
      statusCode: 400,
      details,
    });
  }
}

export class ToolNotFoundError extends AppError {
  constructor(toolName: string) {
    super({
      code: "TOOL_NOT_FOUND",
      message: `Tool "${toolName}" is not registered.`,
      statusCode: 404,
      details: [{ path: "name", message: "No registered tool matches this name." }],
    });
  }
}

export class ToolInputValidationError extends AppError {
  constructor(toolName: string, details: readonly AppErrorDetail[]) {
    super({
      code: "TOOL_INPUT_INVALID",
      message: `Input validation failed for tool "${toolName}".`,
      statusCode: 400,
      details,
    });
  }
}

export class ToolExecutionError extends AppError {
  constructor(toolName: string, cause: unknown) {
    super({
      code: "TOOL_EXECUTION_FAILED",
      message: `Tool "${toolName}" failed during execution.`,
      statusCode: 500,
      cause,
    });
  }
}

export class ToolRegistryLockedError extends AppError {
  constructor() {
    super({
      code: "TOOL_REGISTRY_LOCKED",
      message: "Tool definitions cannot be changed during an active Agent run.",
      statusCode: 409,
      details: [
        {
          path: "registry",
          message: "Wait for the active run to finish before changing tools.",
        },
      ],
    });
  }
}

export class ToolValidatedInputInvalidError extends AppError {
  constructor(toolName: string) {
    super({
      code: "TOOL_VALIDATED_INPUT_INVALID",
      message: "Validated tool input is not valid for the current tool definition.",
      statusCode: 409,
      details: [
        {
          path: "input",
          message: `Validated input for tool "${toolName}" cannot be executed.`,
        },
      ],
    });
  }
}
