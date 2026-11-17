import { fork, type ChildProcess } from "node:child_process";
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  decodeHostAssertionBearerToken,
} from "../../src/host-auth/host-assertion-bearer.js";
import { createHostAuthFixture } from "../host-auth/host-auth-fixture.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "forgeflow-host-auth-cli-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("host assertion signing CLI", () => {
  it("signs using only the configured keyId mapping", async () => {
    const fixture = createHostAuthFixture({ now: new Date() });
    const configPath = join(root, "host-auth.json");
    const privateKeyPath = join(root, "reviewer.pem");
    writeFileSync(configPath, JSON.stringify(fixture.config), "utf8");
    writeFileSync(
      privateKeyPath,
      fixture.humanPrivateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      "utf8",
    );

    const result = await runSignerCli([
      "--config",
      configPath,
      "--key-id",
      "human-reviewer-key-1",
      "--private-key",
      privateKeyPath,
      "--assertion-id",
      "cli-human-assertion",
    ]);

    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    const assertion = decodeHostAssertionBearerToken(
      result.stdout.trim(),
    );
    expect(
      fixture.adapter.authenticate(assertion),
    ).toMatchObject({
      actorId: "reviewer-1",
      actorType: "human_reviewer",
    });
    expect(result.stdout).not.toContain("PRIVATE KEY");
  });

  it("rejects actor / role override arguments", async () => {
    const fixture = createHostAuthFixture();
    const configPath = join(root, "host-auth.json");
    const privateKeyPath = join(root, "reviewer.pem");
    writeFileSync(configPath, JSON.stringify(fixture.config), "utf8");
    writeFileSync(
      privateKeyPath,
      fixture.humanPrivateKey.export({
        type: "pkcs8",
        format: "pem",
      }),
      "utf8",
    );

    const result = await runSignerCli([
      "--config",
      configPath,
      "--key-id",
      "human-reviewer-key-1",
      "--private-key",
      privateKeyPath,
      "--actor-id",
      "verifier-service-1",
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
  });
});

function runSignerCli(args: readonly string[]): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return new Promise((resolvePromise, reject) => {
    const worker = fork(
      resolve("scripts/host-auth/issue-host-assertion.ts"),
      [...args],
      {
        cwd: resolve("."),
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    collectSignerOutput(worker).then(resolvePromise, reject);
  });
}

function collectSignerOutput(worker: ChildProcess): Promise<{
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}> {
  let stdout = "";
  let stderr = "";
  worker.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  worker.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  return new Promise((resolvePromise, reject) => {
    worker.once("error", reject);
    worker.once("exit", (code) => {
      resolvePromise({ code, stdout, stderr });
    });
  });
}
