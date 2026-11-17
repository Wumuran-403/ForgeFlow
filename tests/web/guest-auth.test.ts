import { describe, expect, it } from "vitest";

import { WebAuth } from "../../src/web/auth.js";

describe("anonymous guest session", () => {
  it("issues unique signed HttpOnly guest cookies and re-authenticates them", () => {
    const auth = new WebAuth({
      sessionSecret: "guest-session-secret-that-is-long-enough",
      sessionTtlSeconds: 3_600,
      secureCookies: true,
      now: () => new Date("2026-11-16T00:00:00.000Z"),
    });
    const first = auth.createGuestSession();
    const second = auth.createGuestSession();
    expect(first.user.kind).toBe("guest");
    expect(first.user.actorId).toMatch(/^guest_[A-Za-z0-9_-]{32}$/);
    expect(first.user.actorId).not.toBe(second.user.actorId);
    expect(first.cookie).toContain("HttpOnly");
    expect(first.cookie).toContain("SameSite=Strict");
    expect(first.cookie).toContain("Secure");
    expect(auth.authenticate(first.cookie)).toEqual(first.user);
    const restartedAuth = new WebAuth({
      sessionSecret: "guest-session-secret-that-is-long-enough",
      sessionTtlSeconds: 3_600,
      secureCookies: true,
      now: () => new Date("2026-11-16T00:00:01.000Z"),
    });
    expect(restartedAuth.authenticate(first.cookie)).toEqual(first.user);
  });

  it("rejects tampered and expired cookies without revealing an actor", () => {
    let now = new Date("2026-11-16T00:00:00.000Z");
    const auth = new WebAuth({
      sessionSecret: "guest-session-secret-that-is-long-enough",
      sessionTtlSeconds: 300,
      secureCookies: false,
      now: () => now,
    });
    const session = auth.createGuestSession();
    const token = session.cookie.split(";", 1)[0]!;
    expect(() => auth.authenticate(`${token.slice(0, -1)}x`)).toThrowError(
      expect.objectContaining({ code: "WEB_AUTH_REQUIRED" }),
    );
    now = new Date("2026-11-16T00:05:01.000Z");
    expect(() => auth.authenticate(token)).toThrowError(
      expect.objectContaining({ code: "WEB_AUTH_REQUIRED" }),
    );
  });
});
