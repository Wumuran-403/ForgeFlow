import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  decodeHostAssertionBearerToken,
  encodeHostAssertionBearerToken,
} from "../../src/host-auth/host-assertion-bearer.js";
import {
  issueHostAssertion,
} from "../../src/host-auth/host-assertion-signer.js";
import {
  startRecoveryReviewHostServer,
  type RecoveryReviewHostServerHandle,
} from "../../src/host/http/recovery-review-host-server.js";
import {
  claimsForKeyId,
  createHostAuthFixture,
  now,
  signAssertion,
} from "../host-auth/host-auth-fixture.js";

const servers: RecoveryReviewHostServerHandle[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

describe("recovery review Host HTTP authentication", () => {
  it("rejects non-loopback binding and does not import signer code", async () => {
    const fixture = createHostAuthFixture();
    await expect(
      startRecoveryReviewHostServer({
        config: fixture.config,
        host: "0.0.0.0",
        now: () => now,
      }),
    ).rejects.toMatchObject({
      code: "HOST_CONTROL_SERVER_INVALID",
    });
    expect(
      readFileSync(
        "src/host/http/recovery-review-host-server.ts",
        "utf8",
      ),
    ).not.toContain("host-assertion-signer");
  });

  it("authenticates Human and Verifier bearer assertions over loopback HTTP", async () => {
    const fixture = createHostAuthFixture();
    const server = await startRecoveryReviewHostServer({
      config: fixture.config,
      now: () => now,
      createNonce: () => "http-request-nonce",
    });
    servers.push(server);

    const human = await requestHost(
      server.url,
      issueHostAssertion({
        config: fixture.config,
        keyId: "human-reviewer-key-1",
        privateKey: fixture.humanPrivateKey,
        now,
        assertionId: "human-http-assertion",
      }),
      "final_decision",
    );
    const verifier = await requestHost(
      server.url,
      issueHostAssertion({
        config: fixture.config,
        keyId: "host-verifier-key-1",
        privateKey: fixture.verifierPrivateKey,
        now,
        assertionId: "verifier-http-assertion",
      }),
      "read_replay",
    );

    expect(human.statusCode).toBe(200);
    expect(human.body).toMatchObject({
      authenticated: true,
      actorId: "reviewer-1",
      actorType: "human_reviewer",
      issuerScope: "manual_reviewer",
      access: "final_decision",
      requestNonce: "http-request-nonce",
    });
    expect(verifier.statusCode).toBe(200);
    expect(verifier.body).toMatchObject({
      actorId: "verifier-service-1",
      actorType: "host_verifier",
      issuerScope: "host_verifier",
      access: "read_replay",
    });
    expect(server.host).toBe("127.0.0.1");
    expect(JSON.stringify(human.body)).not.toContain(
      "forgeflow-host-assertion",
    );
  });

  it("rejects missing, malformed, tampered, expired, and wrong-audience credentials", async () => {
    const fixture = createHostAuthFixture();
    const server = await startRecoveryReviewHostServer({
      config: fixture.config,
      now: () => now,
    });
    servers.push(server);

    const missing = await requestHost(server.url, undefined, "final_decision");
    expect(missing.statusCode).toBe(401);

    const malformed = await requestHost(
      server.url,
      "not-a-valid-token",
      "final_decision",
    );
    expect(malformed.statusCode).toBe(401);

    const valid = issueHostAssertion({
      config: fixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: fixture.humanPrivateKey,
      now,
    });
    const decoded = decodeHostAssertionBearerToken(valid) as {
      signature: string;
    };
    const tampered = encodeHostAssertionBearerToken({
      ...decoded,
      signature: "A".repeat(86),
    });
    expect(
      (await requestHost(server.url, tampered, "final_decision"))
        .statusCode,
    ).toBe(401);

    const expired = issueHostAssertion({
      config: fixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: fixture.humanPrivateKey,
      now: new Date("2025-12-31T23:50:00.000Z"),
    });
    expect(
      (await requestHost(server.url, expired, "final_decision"))
        .statusCode,
    ).toBe(401);

    const wrongAudience = signAssertion(
      fixture.humanPrivateKey,
      "human-reviewer-key-1",
      claimsForKeyId(fixture.config, "human-reviewer-key-1", {
        audience: "wrong-audience",
      }),
    );
    expect(
      (await requestHost(
        server.url,
        encodeHostAssertionBearerToken(wrongAudience),
        "final_decision",
      )).statusCode,
    ).toBe(401);
  });

  it("rejects scope escalation and identity fields in the HTTP DTO", async () => {
    const fixture = createHostAuthFixture();
    const server = await startRecoveryReviewHostServer({
      config: fixture.config,
      now: () => now,
    });
    servers.push(server);

    const finalOnly = issueHostAssertion({
      config: fixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: fixture.humanPrivateKey,
      scopeSubset: ["recovery_review.final_decision"],
      now,
    });
    expect(
      (await requestHost(server.url, finalOnly, "read_replay"))
        .statusCode,
    ).toBe(403);

    const valid = issueHostAssertion({
      config: fixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: fixture.humanPrivateKey,
      now,
    });
    const injected = await requestHost(
      server.url,
      valid,
      "final_decision",
      {
        actorId: "reviewer-2",
        actorType: "host_verifier",
        issuerScope: "host_verifier",
      },
    );
    expect(injected.statusCode).toBe(400);
  });

  it("rejects revoked assertions and revoked key mappings over HTTP", async () => {
    const assertionFixture = createHostAuthFixture({
      config: {
        revokedAssertionIds: ["revoked-http-assertion"],
      },
    });
    const assertionServer = await startRecoveryReviewHostServer({
      config: assertionFixture.config,
      now: () => now,
    });
    servers.push(assertionServer);
    const revokedAssertion = issueHostAssertion({
      config: assertionFixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: assertionFixture.humanPrivateKey,
      assertionId: "revoked-http-assertion",
      now,
    });
    expect(
      (await requestHost(
        assertionServer.url,
        revokedAssertion,
        "final_decision",
      )).statusCode,
    ).toBe(401);

    const keyFixture = createHostAuthFixture();
    const revokedKeyConfig = {
      ...keyFixture.config,
      trustedKeys: keyFixture.config.trustedKeys.map((key) =>
        key.keyId === "human-reviewer-key-1"
          ? { ...key, status: "revoked" as const }
          : key,
      ),
    };
    const keyServer = await startRecoveryReviewHostServer({
      config: revokedKeyConfig,
      now: () => now,
    });
    servers.push(keyServer);
    const revokedKeyToken = issueHostAssertion({
      config: keyFixture.config,
      keyId: "human-reviewer-key-1",
      privateKey: keyFixture.humanPrivateKey,
      now,
    });
    expect(
      (await requestHost(
        keyServer.url,
        revokedKeyToken,
        "final_decision",
      )).statusCode,
    ).toBe(401);
  });

  it("authenticates through a separate Node worker process", async () => {
    const fixture = createHostAuthFixture();
    const server = await startRecoveryReviewHostServer({
      config: fixture.config,
      now: () => now,
      createNonce: () => "worker-request-nonce",
    });
    servers.push(server);
    const token = issueHostAssertion({
      config: fixture.config,
      keyId: "host-verifier-key-1",
      privateKey: fixture.verifierPrivateKey,
      now,
      assertionId: "worker-assertion",
    });
    const worker = fork(
      resolve("tests/integration/host-auth-http-worker.ts"),
      [JSON.stringify({
        url: server.url,
        token,
        access: "final_decision",
      })],
      {
        execArgv: ["--import", "tsx"],
        stdio: ["ignore", "ignore", "ignore", "ipc"],
      },
    );

    const result = await waitForWorker(worker);
    expect(result).toMatchObject({
      statusCode: 200,
      body: {
        authenticated: true,
        actorType: "host_verifier",
        requestNonce: "worker-request-nonce",
      },
    });
  });
});

async function requestHost(
  baseUrl: string,
  token: string | undefined,
  access: "final_decision" | "read_replay",
  extraBody: Record<string, unknown> = {},
): Promise<{ readonly statusCode: number; readonly body: unknown }> {
  const url = new URL(`${baseUrl}/internal/recovery-review/authenticate`);
  const body = JSON.stringify({ access, ...extraBody });
  return new Promise((resolvePromise, reject) => {
    const requestHandle = request({
      host: url.hostname,
      port: url.port,
      path: url.pathname,
      method: "POST",
      headers: {
        ...(token === undefined
          ? {}
          : { authorization: `Bearer ${token}` }),
        "content-type": "application/json",
        "content-length": Buffer.byteLength(body),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        resolvePromise({
          statusCode: response.statusCode ?? 0,
          body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
        });
      });
    });
    requestHandle.on("error", reject);
    requestHandle.end(body);
  });
}

function waitForWorker(worker: ChildProcess): Promise<unknown> {
  return new Promise((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      worker.kill();
      reject(new Error("Host auth worker timed out."));
    }, 10_000);
    worker.once("message", (message) => {
      clearTimeout(timer);
      worker.kill();
      resolvePromise(message);
    });
    worker.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    worker.once("exit", (code) => {
      if (code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Host auth worker exited with ${code}.`));
      }
    });
  });
}
