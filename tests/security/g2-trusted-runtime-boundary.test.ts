import { generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, resolve } from "node:path";

import {
  LanguageVariant,
  SyntaxKind,
  computeLineStarts,
  createScanner,
} from "typescript/unstable/ast";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { AgentRunner } from "../../src/agent/agent-runner.js";
import {
  Ed25519HostAuthenticationAdapter,
} from "../../src/host-auth/ed25519-host-authentication-adapter.js";
import {
  canonicalHostAssertionSigningInput,
} from "../../src/host-auth/host-assertion.js";
import {
  RecoveryReviewHostGateway,
  assertAuthenticatedHostRequestContext,
} from "../../src/host/recovery-review-host-gateway.js";
import * as recoveryPublicApi from "../../src/recovery/index.js";
import { MockLLMProvider } from "../../src/provider/mock-provider.js";
import {
  JsonValueSchema,
  decodeJson,
} from "../../src/storage/index.js";
import {
  ToolNotFoundError,
} from "../../src/tools/errors.js";
import { ToolRegistry } from "../../src/tools/registry.js";

describe("G2 trusted runtime boundary", () => {
  it("has no dynamic JavaScript execution or module-loading entry in src", () => {
    const findings = scanSourceTree(resolve("src"));

    expect(findings).toEqual([]);
  });

  it("does not declare runtime JavaScript sandbox / dynamic loader dependencies", () => {
    const packageJson = JSON.parse(
      readFileSync("package.json", "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const dependencies = new Set([
      ...Object.keys(packageJson.dependencies ?? {}),
      ...Object.keys(packageJson.devDependencies ?? {}),
    ]);

    for (const forbidden of [
      "isolated-vm",
      "quickjs-emscripten",
      "vm2",
      "node-eval",
      "dynamic-import-loader",
    ]) {
      expect(dependencies.has(forbidden)).toBe(false);
    }
  });

  it("treats model tool-call arguments as data and does not execute JavaScript", async () => {
    const property = "__forgeflow_tcb_execution_probe__";
    const globalRecord = globalThis as typeof globalThis &
      Record<string, unknown>;
    delete globalRecord[property];

    const registry = new ToolRegistry();
    registry.register({
      name: "trusted_echo",
      description: "Echo validated data.",
      mode: "read",
      inputSchema: z.object({ code: z.string() }).strict(),
      timeoutMs: 1_000,
      requiresApproval: false,
      execute: async (input) => input.code,
    });
    const provider = new MockLLMProvider([
      {
        content: "",
        toolCalls: [
          {
            id: "call-data-only",
            name: "trusted_echo",
            arguments: {
              code: `globalThis.${property} = true; process.exit(1);`,
            },
          },
        ],
      },
      "done",
    ]);
    const runner = new AgentRunner({
      provider,
      registry,
      model: "mock-model",
      maxModelTurns: 2,
      maxToolCalls: 1,
    });

    const result = await runner.run({ objective: "Treat code as data." });

    expect(result.status).toBe("completed");
    expect(Object.hasOwn(globalRecord, property)).toBe(false);
    await expect(
      registry.execute("./untrusted-module.js", {}),
    ).rejects.toBeInstanceOf(ToolNotFoundError);
  });

  it("decodes persisted JSON as data without executing code", () => {
    const value = decodeJson(
      JsonValueSchema,
      JSON.stringify({
        source: "persisted",
        expression: "globalThis.__persisted_execution_probe__ = true",
      }),
      "test.payload_json",
    );

    expect(value).toEqual({
      source: "persisted",
      expression: "globalThis.__persisted_execution_probe__ = true",
    });
    expect(
      Object.hasOwn(
        globalThis,
        "__persisted_execution_probe__",
      ),
    ).toBe(false);
  });

  it("rejects data-shaped objects as AuthenticatedHostRequestContext", () => {
    const forged = {
      contextId: "context",
      actorId: "reviewer-1",
      actorType: "human_reviewer",
      issuerScope: "manual_reviewer",
      allowedAccess: "final_decision",
      authenticationEvidenceId:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      assertionId: "assertion",
      requestNonce: "nonce",
      issuedAt: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      code: "globalThis.__context_execution_probe__ = true",
    };

    expect(() =>
      assertAuthenticatedHostRequestContext(forged),
    ).toThrowError(
      expect.objectContaining({
        code: "AUTHENTICATED_HOST_REQUEST_CONTEXT_INVALID",
      }),
    );
    expect(
      Object.hasOwn(globalThis, "__context_execution_probe__"),
    ).toBe(false);
  });

  it("keeps Gateway / Adapter / Context creator out of the recovery public barrel", () => {
    for (const forbiddenExport of [
      "RecoveryReviewHostGateway",
      "Ed25519HostAuthenticationAdapter",
      "createAuthenticatedHostRequestContext",
      "createAuthenticatedHostRequestContextForGateway",
    ]) {
      expect(forbiddenExport in recoveryPublicApi).toBe(false);
    }
  });

  it("keeps Gateway imports out of ordinary runtime modules", () => {
    for (const path of [
      "src/agent/agent-runner.ts",
      "src/tools/registry.ts",
      "src/provider/mock-provider.ts",
      "src/recovery/recovery-manager.ts",
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toContain("recovery-review-host-gateway");
      expect(source).not.toContain("authenticated-host-request-context");
    }
  });

  it("documents accepted TCB risk: trusted in-process code can self-mint Context", () => {
    const pair = generateKeyPairSync("ed25519");
    const publicKeyPem = pair.publicKey
      .export({ type: "spki", format: "pem" })
      .toString();
    const fixedNow = new Date("2026-01-01T00:01:00.000Z");
    const config = {
      schemaVersion: "forgeflow.host-authentication-config.v1" as const,
      audience: "forgeflow.step6_3_5.recovery-review",
      maximumAssertionTtlSeconds: 300,
      clockSkewSeconds: 5,
      trustedKeys: [
        {
          keyId: "trusted-code-key",
          issuer: "trusted-code-issuer",
          publicKeyPem,
          actorId: "trusted-code-actor",
          actorType: "human_reviewer" as const,
          role: "manual_reviewer" as const,
          allowedScopes: [
            "recovery_review.final_decision" as const,
            "recovery_review.read_replay" as const,
          ],
          status: "active" as const,
        },
      ],
      revokedAssertionIds: [],
    };
    const claims = {
      issuer: "trusted-code-issuer",
      audience: "forgeflow.step6_3_5.recovery-review",
      actorId: "trusted-code-actor",
      actorType: "human_reviewer" as const,
      role: "manual_reviewer" as const,
      scopes: [
        "recovery_review.final_decision" as const,
        "recovery_review.read_replay" as const,
      ],
      issuedAt: "2026-01-01T00:00:00.000Z",
      notBefore: "2026-01-01T00:00:00.000Z",
      expiresAt: "2026-01-01T00:05:00.000Z",
      assertionId: "trusted-code-assertion",
    };
    const unsigned = {
      schemaVersion: "forgeflow.host-assertion.v1" as const,
      keyId: "trusted-code-key",
      claims,
      signature: "A".repeat(86),
    };
    const assertion = {
      ...unsigned,
      signature: sign(
        null,
        Buffer.from(
          canonicalHostAssertionSigningInput(unsigned),
          "utf8",
        ),
        pair.privateKey,
      ).toString("base64url"),
    };
    const gateway = new RecoveryReviewHostGateway(
      new Ed25519HostAuthenticationAdapter(
        config,
        () => fixedNow,
      ),
      () => fixedNow,
      () => "trusted-code-nonce",
    );

    const context = gateway.createContext({
      assertion,
      access: "final_decision",
    });

    // Accepted under Option B: this code executes inside the trusted process.
    expect(
      assertAuthenticatedHostRequestContext(context),
    ).toMatchObject({
      actorId: "trusted-code-actor",
      actorType: "human_reviewer",
      issuerScope: "manual_reviewer",
      allowedAccess: "final_decision",
    });
  });
});

interface DynamicExecutionFinding {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
}

function scanSourceTree(root: string): readonly DynamicExecutionFinding[] {
  const findings: DynamicExecutionFinding[] = [];
  for (const file of walkTypeScriptFiles(root)) {
    findings.push(...scanTypeScriptFile(file));
  }
  return findings;
}

function walkTypeScriptFiles(directory: string): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(path));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(path);
    }
  }
  return files;
}

function scanTypeScriptFile(
  path: string,
): readonly DynamicExecutionFinding[] {
  const sourceText = readFileSync(path, "utf8");
  const lineStarts = computeLineStarts(sourceText);
  const scanner = createScanner(
    true,
    LanguageVariant.Standard,
    sourceText,
    0,
    sourceText.length,
  );
  const tokens: ScannedToken[] = [];
  while (true) {
    const kind = scanner.scan();
    if (kind === SyntaxKind.EndOfFile) {
      break;
    }
    tokens.push({
      kind,
      text: scanner.getTokenText(),
      value:
        kind === SyntaxKind.StringLiteral
          ? scanner.getTokenValue()
          : null,
      start: scanner.getTokenStart(),
    });
  }
  const findings: DynamicExecutionFinding[] = [];
  const forbiddenModules = new Set([
    "node:vm",
    "vm",
    "node:child_process",
    "child_process",
    "node:worker_threads",
    "worker_threads",
  ]);

  const report = (token: ScannedToken, kind: string): void => {
    const position = lineAndCharacter(lineStarts, token.start);
    findings.push({
      file: relative(process.cwd(), path),
      line: position + 1,
      kind,
    });
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    const next = tokens[index + 1];
    const previous = tokens[index - 1];

    if (
      token.value !== null &&
      (forbiddenModules.has(token.value) ||
        ["eval", "Function", "require", "createRequire"].includes(
          token.value,
        ))
    ) {
      report(token, `string:${token.value}`);
    }
    if (
      token.text === "eval" ||
      token.text === "require" ||
      token.text === "createRequire"
    ) {
      report(token, `identifier:${token.text}`);
    }
    if (
      token.text === "import" &&
      next?.kind === SyntaxKind.OpenParenToken
    ) {
      report(token, "dynamic-import");
    }
    if (
      token.text === "Function" &&
      (next?.kind === SyntaxKind.OpenParenToken ||
        previous?.text === "new")
    ) {
      report(token, "Function-execution");
    }
    if (
      token.text === "Worker" &&
      previous?.text === "new"
    ) {
      report(token, "worker-thread");
    }
    if (
      ["dlopen", "_compile", "eval"].includes(token.text) &&
      previous?.kind === SyntaxKind.DotToken
    ) {
      report(token, `property-call:${token.text}`);
    }
    if (
      ["setTimeout", "setInterval"].includes(token.text) &&
      next?.kind === SyntaxKind.OpenParenToken &&
      tokens[index + 2]?.kind === SyntaxKind.StringLiteral
    ) {
      report(token, `string-callback:${token.text}`);
    }
  }
  return findings;
}

interface ScannedToken {
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly value: string | null;
  readonly start: number;
}

function lineAndCharacter(
  lineStarts: readonly number[],
  position: number,
): number {
  let line = 0;
  while (
    line + 1 < lineStarts.length &&
    lineStarts[line + 1]! <= position
  ) {
    line += 1;
  }
  return line;
}
