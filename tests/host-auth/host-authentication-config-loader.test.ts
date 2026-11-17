import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  loadHostAuthenticationConfigFromFile,
} from "../../src/host-auth/host-authentication-config-loader.js";
import {
  HostAuthenticationConfigV1Schema,
} from "../../src/host-auth/host-authentication-config.js";
import { createHostAuthFixture } from "./host-auth-fixture.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forgeflow-host-auth-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("host authentication config loader", () => {
  it("loads strict public-key and revocation config from disk", () => {
    const fixture = createHostAuthFixture();
    const path = join(root, "host-auth.json");
    const config = {
      ...fixture.config,
      revokedAssertionIds: ["revoked-assertion"],
    };
    writeFileSync(path, JSON.stringify(config), "utf8");

    expect(loadHostAuthenticationConfigFromFile(path)).toEqual(
      HostAuthenticationConfigV1Schema.parse(config),
    );
  });

  it("rejects missing, invalid, or schema-invalid config", () => {
    expect(() =>
      loadHostAuthenticationConfigFromFile(join(root, "missing.json")),
    ).toThrowError(
      expect.objectContaining({
        code: "HOST_AUTHENTICATION_CONFIG_INVALID",
      }),
    );

    const malformed = join(root, "malformed.json");
    writeFileSync(malformed, "{not-json", "utf8");
    expect(() =>
      loadHostAuthenticationConfigFromFile(malformed),
    ).toThrow();

    const invalid = join(root, "invalid.json");
    writeFileSync(
      invalid,
      JSON.stringify({ schemaVersion: "wrong" }),
      "utf8",
    );
    expect(() =>
      loadHostAuthenticationConfigFromFile(invalid),
    ).toThrow();
  });
});
