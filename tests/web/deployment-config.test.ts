import { describe, expect, it } from "vitest";
import { loadWebConfig } from "../../src/web/config.js";

const base = {
  NODE_ENV: "production",
  WEB_SESSION_SECRET: "test-session-secret-longer-than-32-characters",
};

describe("production web configuration", () => {
  it("requires an exact HTTPS public origin and secure cookies", () => {
    expect(() => loadWebConfig(base)).toThrow();
    expect(() => loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: "http://forgeflow.example" })).toThrow();
    expect(() => loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: "https://forgeflow.example/" })).toThrow();
    expect(() => loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: "https://forgeflow.example", WEB_SECURE_COOKIES: "false" })).toThrow();
    expect(() => loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: "https://forgeflow.example", WEB_SESSION_SECRET: "replace-with-a-long-random-private-session-secret" })).toThrow();
    const config = loadWebConfig({ ...base, WEB_PUBLIC_ORIGIN: "https://forgeflow.example" });
    expect(config.secureCookies).toBe(true);
    expect(config.publicOrigin).toBe("https://forgeflow.example");
    expect(config.defaultTokenBudget).toBe(50_000);
    expect(config.publicEvaluationRunEnabled).toBe(false);
    expect(config.globalModelTokenBudgetPerDay).toBe(0);
    expect(() => loadWebConfig({
      ...base,
      WEB_PUBLIC_ORIGIN: "https://forgeflow.example",
      WEB_DEFAULT_TOKEN_BUDGET: "999",
    })).toThrow();
  });
});
