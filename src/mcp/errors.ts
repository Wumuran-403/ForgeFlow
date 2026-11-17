import { AppError } from "../shared/errors.js";

export class McpConfigurationError extends AppError {
  constructor(message: string) {
    super({ code: "MCP_CONFIGURATION_INVALID", message, statusCode: 500, details: [] });
  }
}

export class McpConnectionError extends AppError {
  constructor(message: string, cause?: unknown) {
    super({ code: "MCP_CONNECTION_FAILED", message, statusCode: 502, details: [], cause });
  }
}

export class McpToolUnauthorizedError extends AppError {
  constructor(toolName: string) {
    super({
      code: "MCP_TOOL_UNAUTHORIZED",
      message: `MCP tool '${toolName}' is not enabled by trusted server configuration.`,
      statusCode: 403,
      details: [],
    });
  }
}

export class McpToolResultError extends AppError {
  constructor(code: string, message: string, cause?: unknown) {
    super({ code, message, statusCode: 502, details: [], cause });
  }
}
