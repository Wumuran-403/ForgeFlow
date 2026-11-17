import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import { z } from "zod";

import { AppError } from "../../shared/errors.js";
import {
  Ed25519HostAuthenticationAdapter,
} from "../../host-auth/ed25519-host-authentication-adapter.js";
import {
  decodeHostAssertionBearerToken,
} from "../../host-auth/host-assertion-bearer.js";
import type {
  HostAuthenticationConfigV1,
} from "../../host-auth/host-authentication-config.js";
import {
  HostRecoveryReviewAccessSchema,
} from "../../host-auth/host-assertion.js";
import {
  RecoveryReviewHostGateway,
  assertAuthenticatedHostRequestContext,
} from "../recovery-review-host-gateway.js";

const MAX_REQUEST_BYTES = 8_192;

const AuthenticationProbeRequestSchema = z
  .object({
    access: HostRecoveryReviewAccessSchema,
  })
  .strict();

export interface RecoveryReviewHostServerOptions {
  readonly config: HostAuthenticationConfigV1;
  readonly host?: string;
  readonly port?: number;
  readonly now?: () => Date;
  readonly createNonce?: () => string;
}

export interface RecoveryReviewHostServerHandle {
  readonly host: string;
  readonly port: number;
  readonly url: string;
  close(): Promise<void>;
}

export async function startRecoveryReviewHostServer(
  options: RecoveryReviewHostServerOptions,
): Promise<RecoveryReviewHostServerHandle> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1") {
    throw serverError();
  }
  const adapter = new Ed25519HostAuthenticationAdapter(
    options.config,
    options.now,
  );
  const gateway = new RecoveryReviewHostGateway(
    adapter,
    options.now,
    options.createNonce,
  );
  const server = createServer((request, response) => {
    void handleRequest(request, response, gateway);
  });

  await listen(server, options.port ?? 0, host);
  const address = server.address();
  if (address === null || typeof address === "string") {
    await closeServer(server);
    throw serverError();
  }
  return {
    host,
    port: address.port,
    url: `http://${host}:${address.port}`,
    close: () => closeServer(server),
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  gateway: RecoveryReviewHostGateway,
): Promise<void> {
  try {
    if (
      request.method !== "POST" ||
      request.url !== "/internal/recovery-review/authenticate"
    ) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    if (!isLoopback(request.socket.remoteAddress)) {
      sendJson(response, 403, { error: "host_gateway_denied" });
      return;
    }

    const assertionToken = readBearerToken(request);
    const assertion = decodeHostAssertionBearerToken(assertionToken);
    const body = AuthenticationProbeRequestSchema.parse(
      JSON.parse(await readBody(request)),
    );
    const context = gateway.createContext({
      assertion,
      access: body.access,
    });
    const claims = assertAuthenticatedHostRequestContext(context);

    response.setHeader("cache-control", "no-store");
    sendJson(response, 200, {
      authenticated: true,
      actorId: claims.actorId,
      actorType: claims.actorType,
      issuerScope: claims.issuerScope,
      access: claims.allowedAccess,
      authenticationEvidenceId: claims.authenticationEvidenceId,
      requestNonce: claims.requestNonce,
      expiresAt: claims.expiresAt,
    });
  } catch (error) {
    const appError = error instanceof AppError ? error : undefined;
    sendJson(response, appError?.statusCode ?? 400, {
      error:
        appError?.code === "HOST_AUTHENTICATION_INVALID"
          ? "authentication_invalid"
          : appError?.code === "RECOVERY_REVIEW_HOST_GATEWAY_DENIED"
            ? "host_gateway_denied"
            : appError?.code === "HOST_ASSERTION_BEARER_INVALID"
              ? "authentication_invalid"
              : "request_invalid",
    });
  }
}

function readBearerToken(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (header === undefined) {
    throw bearerError();
  }
  const match = /^Bearer (.+)$/.exec(header);
  if (match === null || match[1] === undefined) {
    throw bearerError();
  }
  return match[1];
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_REQUEST_BYTES) {
      throw requestError();
    }
    chunks.push(bytes);
  }
  if (size === 0) {
    throw requestError();
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    throw requestError();
  }
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: Record<string, unknown>,
): void {
  if (response.headersSent || response.writableEnded) {
    return;
  }
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.end(JSON.stringify(body));
}

function isLoopback(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function listen(server: Server, port: number, host: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

function bearerError(): AppError {
  return new AppError({
    code: "HOST_ASSERTION_BEARER_INVALID",
    message: "Host assertion bearer token is invalid.",
    statusCode: 401,
    details: [],
  });
}

function requestError(): AppError {
  return new AppError({
    code: "HOST_AUTH_REQUEST_INVALID",
    message: "Host authentication request is invalid.",
    statusCode: 400,
    details: [],
  });
}

function serverError(): AppError {
  return new AppError({
    code: "HOST_CONTROL_SERVER_INVALID",
    message: "Host control server configuration is invalid.",
    statusCode: 500,
    details: [],
  });
}
