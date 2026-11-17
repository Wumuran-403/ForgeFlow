import {
  createReadStream,
  existsSync,
  statSync,
} from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";

import { z } from "zod";

import {
  AppError,
  toErrorResponse,
} from "../shared/errors.js";
import { WebAuth, type AuthenticatedWebUser } from "./auth.js";
import type { WebConfig } from "./config.js";
import { WebTaskService } from "./task-service.js";

const CreateTaskSchema = z
  .object({
    workflowId: z.string().min(1),
    objective: z.string().trim().min(10).max(4_000),
    buildQuantity: z.number().int().min(1).max(100_000).optional(),
  })
  .strict();

const ApprovalDecisionSchema = z
  .object({
    decision: z.enum(["approved", "rejected"]),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const MAX_BODY_BYTES = 64 * 1024;

export interface WebServerOptions {
  readonly config: WebConfig;
  readonly service: WebTaskService;
  readonly auth: WebAuth;
  readonly staticDirectory?: string;
  readonly now?: () => Date;
}

export function createWebServer(options: WebServerOptions) {
  const staticDirectory = resolve(
    options.staticDirectory ?? resolve(process.cwd(), "web", "dist"),
  );
  const guestSessionAttempts = new Map<string, { count: number; resetAt: number }>();
  const taskAttempts = new Map<string, { count: number; resetAt: number }>();

  return createServer(async (request, response) => {
    const requestId = randomUUID();
    const startedAt = Date.now();
    response.once("finish", () => {
      process.stdout.write(JSON.stringify({
        event: "web.request",
        requestId,
        method: request.method,
        status: response.statusCode,
        durationMs: Date.now() - startedAt,
      }) + "\n");
    });
    applySecurityHeaders(response);
    try {
      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? "localhost"}`,
      );
      if (url.pathname.startsWith("/internal/") || url.pathname.startsWith("/recovery/")) {
        throw new AppError({
          code: "WEB_ROUTE_NOT_FOUND",
          message: "Route was not found.",
          statusCode: 404,
        });
      }
      if (url.pathname.startsWith("/api/")) {
        await handleApiRequest({
          request,
          response,
          url,
          requestId,
          options,
          guestSessionAttempts,
          taskAttempts,
        });
        return;
      }
      serveStatic(response, url.pathname, staticDirectory);
    } catch (error) {
      if (error instanceof z.ZodError) {
        sendJson(response, 400, {
          data: null,
          error: {
            code: "WEB_REQUEST_INVALID",
            message: "Request payload is invalid.",
            details: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
          requestId,
        });
        return;
      }
      sendJson(
        response,
        error instanceof AppError ? error.statusCode : 500,
        toErrorResponse(error, requestId),
      );
    }
  });
}

async function handleApiRequest(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly url: URL;
  readonly requestId: string;
  readonly options: WebServerOptions;
  readonly guestSessionAttempts: Map<string, { count: number; resetAt: number }>;
  readonly taskAttempts: Map<string, { count: number; resetAt: number }>;
}): Promise<void> {
  const { request, response, url, options } = input;
  if (request.method === "GET" && url.pathname === "/api/health") {
    sendJson(response, 200, {
      data: {
        status: "ok",
        service: "forgeflow-web",
        environment: options.config.environment,
      },
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/auth/session") {
    let user: AuthenticatedWebUser;
    try {
      user = options.auth.authenticate(request.headers.cookie);
    } catch {
      checkRateLimit(
        networkRateLimitKey(request, options.config),
        input.guestSessionAttempts,
        options.config.guestSessionRateLimitPerMinute,
        "WEB_GUEST_SESSION_RATE_LIMIT",
      );
      const session = options.auth.createGuestSession();
      user = session.user;
      response.setHeader("set-cookie", session.cookie);
    }
    sendJson(response, 200, {
      data: {
        ...user,
        capabilities: {
          runEvaluation: options.config.publicEvaluationRunEnabled,
        },
      },
    });
    return;
  }

  const user = options.auth.authenticate(request.headers.cookie);

  const segments = url.pathname.split("/").filter(Boolean);

  if (request.method === "GET" && url.pathname === "/api/dashboard") {
    sendJson(response, 200, {
      data: await options.service.dashboard(user.actorId),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/metrics/summary") {
    sendJson(response, 200, { data: options.service.metricsSummary(user.actorId) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/evals") {
    const limit = parsePositiveQueryInteger(url.searchParams.get("limit"), 50, 100);
    sendJson(response, 200, { data: options.service.evaluationHistory(limit) });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/evals/run") {
    assertClientRequest(request, options.config);
    if (!options.config.publicEvaluationRunEnabled) {
      throw new AppError({
        code: "WEB_EVALUATION_RUN_DISABLED",
        message: "Public evaluation execution is disabled; persisted reports remain available.",
        statusCode: 403,
      });
    }
    sendJson(response, 201, { data: await options.service.runEvaluation() });
    return;
  }

  if (request.method === "GET" && segments.length === 3 && segments[1] === "evals") {
    sendJson(response, 200, { data: options.service.evaluationReport(segments[2]!) });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/workflows") {
    sendJson(response, 200, { data: options.service.listWorkflows() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/tasks") {
    const limit = parsePositiveQueryInteger(url.searchParams.get("limit"), 50, 100);
    sendJson(response, 200, {
      data: options.service.listTasks(user.actorId, limit),
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/tasks") {
    assertClientRequest(request, options.config);
    checkRateLimit(
      user.actorId,
      input.taskAttempts,
      options.config.guestTaskRateLimitPerMinute,
      "WEB_TASK_RATE_LIMIT",
    );
    const body = CreateTaskSchema.parse(await readJsonBody(request));
    sendJson(response, 202, {
      data: options.service.createTask({
        actorId: user.actorId,
        workflowId: body.workflowId,
        objective: body.objective,
        ...(body.buildQuantity === undefined
          ? {}
          : { buildQuantity: body.buildQuantity }),
      }),
    });
    return;
  }

  if (
    request.method === "POST" && segments.length === 4 &&
    segments[1] === "tasks" && ["pause", "resume", "cancel"].includes(segments[3]!)
  ) {
    assertClientRequest(request, options.config);
    const taskId = segments[2]!;
    const action = segments[3]!;
    sendJson(response, 200, { data: action === "pause"
      ? options.service.pauseTask(user.actorId, taskId)
      : action === "resume"
        ? options.service.resumeTask(user.actorId, taskId)
        : options.service.cancelTask(user.actorId, taskId) });
    return;
  }

  if (
    request.method === "GET" &&
    segments.length === 4 &&
    segments[1] === "tasks" &&
    segments[3] === "events"
  ) {
    const taskId = segments[2]!;
    const after = parseNonNegativeQueryInteger(
      url.searchParams.get("after"),
      0,
    );
    sendJson(response, 200, {
      data: options.service.getTaskEvents(user.actorId, taskId, after),
    });
    return;
  }

  if (
    request.method === "GET" &&
    segments.length === 3 &&
    segments[1] === "tasks"
  ) {
    sendJson(response, 200, {
      data: options.service.getTask(user.actorId, segments[2]!),
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/approvals") {
    sendJson(response, 200, {
      data: options.service.listApprovals(user.actorId),
    });
    return;
  }

  if (
    request.method === "POST" &&
    segments.length === 4 &&
    segments[1] === "approvals" &&
    ["approve", "reject"].includes(segments[3]!)
  ) {
    assertClientRequest(request, options.config);
    const body = ApprovalDecisionSchema.partial().parse(
      await readOptionalJsonBody(request),
    );
    const pathDecision = segments[3] === "approve" ? "approved" : "rejected";
    if (body.decision !== undefined && body.decision !== pathDecision) {
      throw new AppError({
        code: "WEB_APPROVAL_DECISION_MISMATCH",
        message: "Approval route and decision do not match.",
        statusCode: 400,
      });
    }
    sendJson(response, 200, {
      data: options.service.decideApproval({
        actorId: user.actorId,
        approvalId: segments[2]!,
        decision: pathDecision,
        ...(body.reason === undefined ? {} : { reason: body.reason }),
      }),
    });
    return;
  }

  throw new AppError({
    code: "WEB_ROUTE_NOT_FOUND",
    message: "API route was not found.",
    statusCode: 404,
  });
}

function serveStatic(
  response: ServerResponse,
  pathname: string,
  staticDirectory: string,
): void {
  if (!existsSync(staticDirectory)) {
    throw new AppError({
      code: "WEB_FRONTEND_NOT_BUILT",
      message: "The web frontend has not been built. Run pnpm web:build.",
      statusCode: 503,
    });
  }
  const relativePath =
    pathname === "/" ? "index.html" : decodeURIComponent(pathname).replace(/^\/+/, "");
  const requestedPath = resolve(staticDirectory, relativePath);
  const insideRoot =
    requestedPath === staticDirectory ||
    requestedPath.startsWith(`${staticDirectory}${sep}`);
  const filePath =
    insideRoot && existsSync(requestedPath) && statSync(requestedPath).isFile()
      ? requestedPath
      : resolve(staticDirectory, "index.html");
  if (!existsSync(filePath)) {
    throw new AppError({
      code: "WEB_FRONTEND_NOT_BUILT",
      message: "The web frontend has not been built. Run pnpm web:build.",
      statusCode: 503,
    });
  }
  response.statusCode = 200;
  response.setHeader("content-type", contentType(filePath));
  response.setHeader(
    "cache-control",
    filePath.endsWith("index.html")
      ? "no-cache"
      : "public, max-age=31536000, immutable",
  );
  createReadStream(filePath).pipe(response);
}

function contentType(filePath: string): string {
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
  }[extname(filePath)] ?? "application/octet-stream";
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new AppError({
        code: "WEB_BODY_TOO_LARGE",
        message: "Request body exceeds the web API limit.",
        statusCode: 413,
      });
    }
    chunks.push(buffer);
  }
  if (size === 0) {
    throw new AppError({
      code: "WEB_BODY_REQUIRED",
      message: "A JSON request body is required.",
      statusCode: 400,
    });
  }
  if (!String(request.headers["content-type"]).startsWith("application/json")) {
    throw new AppError({
      code: "WEB_CONTENT_TYPE_INVALID",
      message: "Content-Type must be application/json.",
      statusCode: 415,
    });
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new AppError({
      code: "WEB_JSON_INVALID",
      message: "Request body must be valid JSON.",
      statusCode: 400,
    });
  }
}

async function readOptionalJsonBody(
  request: IncomingMessage,
): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (contentLength === 0) {
    return {};
  }
  return readJsonBody(request);
}

function assertClientRequest(request: IncomingMessage, config: WebConfig): void {
  if (request.headers["x-forgeflow-client"] !== "web") {
    throw new AppError({
      code: "WEB_CLIENT_HEADER_REQUIRED",
      message: "The ForgeFlow web client header is required.",
      statusCode: 403,
    });
  }
  const origin = request.headers.origin;
  if (origin === undefined && config.publicOrigin !== undefined) {
    throw new AppError({code: "WEB_ORIGIN_REQUIRED", message: "Request origin is required.", statusCode: 403});
  }
  if (origin !== undefined) {
    let parsedOrigin: URL;
    try {
      parsedOrigin = new URL(origin);
    } catch {
      throw new AppError({
        code: "WEB_ORIGIN_INVALID",
        message: "Request origin is invalid.",
        statusCode: 403,
      });
    }
    const expectedOrigin = config.publicOrigin ??
      `http://${request.headers.host ?? ""}`;
    if (parsedOrigin.origin !== expectedOrigin || origin !== parsedOrigin.origin) {
      throw new AppError({
        code: "WEB_ORIGIN_REJECTED",
        message: "Cross-origin write requests are not allowed.",
        statusCode: 403,
      });
    }
  }
}

function checkRateLimit(
  key: string,
  attempts: Map<string, { count: number; resetAt: number }>,
  limit: number,
  code: string,
): void {
  const now = Date.now();
  const current = attempts.get(key);
  const entry =
    current === undefined || current.resetAt <= now
      ? { count: 0, resetAt: now + 60_000 }
      : current;
  if (entry.count >= limit) {
    throw new AppError({
      code,
      message: "Too many requests. Try again later.",
      statusCode: 429,
    });
  }
  entry.count += 1;
  attempts.set(key, entry);
}

function networkRateLimitKey(request: IncomingMessage, config: WebConfig): string {
  if (config.trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const first = Array.isArray(forwarded) ? forwarded[0] : forwarded?.split(",")[0];
    if (first !== undefined && first.trim().length > 0) return first.trim();
  }
  return request.socket.remoteAddress ?? "unknown";
}

function parsePositiveQueryInteger(
  value: string | null,
  fallback: number,
  maximum: number,
): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0
    ? Math.min(parsed, maximum)
    : fallback;
}

function parseNonNegativeQueryInteger(
  value: string | null,
  fallback: number,
): number {
  if (value === null) {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown,
): void {
  if (response.headersSent) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function applySecurityHeaders(response: ServerResponse): void {
  response.setHeader("x-content-type-options", "nosniff");
  response.setHeader("x-frame-options", "DENY");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader(
    "content-security-policy",
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  );
}

export type { AuthenticatedWebUser };
