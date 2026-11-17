import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

import { AppError } from "../shared/errors.js";

export const SESSION_COOKIE_NAME = "forgeflow_session";

const SessionPayloadSchema = z.object({
  sub: z.string().regex(/^guest_[A-Za-z0-9_-]{32}$/),
  kind: z.literal("guest"),
  iat: z.number().int().positive(),
  exp: z.number().int().positive(),
  nonce: z.string().min(16),
}).strict();

export interface AuthenticatedWebUser {
  readonly actorId: string;
  readonly kind: "guest";
}

export class WebAuth {
  constructor(private readonly options: {
    readonly sessionSecret: string;
    readonly sessionTtlSeconds: number;
    readonly secureCookies: boolean;
    readonly now?: () => Date;
  }) {}

  createGuestSession(): { readonly user: AuthenticatedWebUser; readonly cookie: string } {
    const nowSeconds = this.nowSeconds();
    const actorId = `guest_${randomBytes(24).toString("base64url")}`;
    const payload = Buffer.from(JSON.stringify({
      sub: actorId,
      kind: "guest",
      iat: nowSeconds,
      exp: nowSeconds + this.options.sessionTtlSeconds,
      nonce: randomBytes(16).toString("base64url"),
    })).toString("base64url");
    const token = `${payload}.${this.sign(payload)}`;
    return {
      user: { actorId, kind: "guest" },
      cookie: serializeSessionCookie(token, this.options.sessionTtlSeconds, this.options.secureCookies),
    };
  }

  authenticate(cookieHeader: string | undefined): AuthenticatedWebUser {
    const token = parseCookies(cookieHeader)[SESSION_COOKIE_NAME];
    if (token === undefined) throw this.unauthorized();
    const [payload, signature, ...rest] = token.split(".");
    if (payload === undefined || signature === undefined || rest.length > 0 ||
        !constantTimeEqual(signature, this.sign(payload))) {
      throw this.unauthorized();
    }
    let decoded: unknown;
    try { decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown; }
    catch { throw this.unauthorized(); }
    const session = SessionPayloadSchema.safeParse(decoded);
    const now = this.nowSeconds();
    if (!session.success || session.data.exp <= now || session.data.iat > now) {
      throw this.unauthorized();
    }
    return { actorId: session.data.sub, kind: "guest" };
  }

  private nowSeconds(): number {
    return Math.floor((this.options.now?.() ?? new Date()).getTime() / 1_000);
  }

  private sign(payload: string): string {
    return createHmac("sha256", this.options.sessionSecret).update(payload).digest("base64url");
  }

  private unauthorized(): AppError {
    return new AppError({
      code: "WEB_AUTH_REQUIRED",
      message: "A valid guest session is required.",
      statusCode: 401,
    });
  }
}

function constantTimeEqual(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name.length > 0) cookies[name] = value;
  }
  return cookies;
}

function serializeSessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  return [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
