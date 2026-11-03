export interface AppErrorDetail {
  path: string;
  message: string;
}

export interface AppErrorOptions {
  code: string;
  message: string;
  statusCode?: number;
  details?: readonly AppErrorDetail[];
  cause?: unknown;
}

export interface ErrorResponse {
  data: null;
  error: {
    code: string;
    message: string;
    details: readonly AppErrorDetail[];
  };
  requestId: string;
}

export class AppError extends Error {
  readonly code: string;
  readonly statusCode: number;
  readonly details: readonly AppErrorDetail[];

  constructor(options: AppErrorOptions) {
    super(options.message, { cause: options.cause });
    this.name = new.target.name;
    this.code = options.code;
    this.statusCode = options.statusCode ?? 500;
    this.details = options.details ?? [];
  }
}

export class ConfigurationError extends AppError {
  constructor(details: readonly AppErrorDetail[]) {
    super({
      code: "CONFIGURATION_INVALID",
      message: "Environment configuration is invalid.",
      statusCode: 500,
      details,
    });
  }
}

export function toErrorResponse(error: unknown, requestId: string): ErrorResponse {
  if (error instanceof AppError) {
    return {
      data: null,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
      requestId,
    };
  }

  return {
    data: null,
    error: {
      code: "INTERNAL_ERROR",
      message: "An internal error occurred.",
      details: [],
    },
    requestId,
  };
}
