import { readFileSync } from "node:fs";

import { createPrivateKey } from "node:crypto";

import { loadHostAuthenticationConfigFromFile } from "../../src/host-auth/host-authentication-config-loader.js";
import { issueHostAssertion } from "../../src/host-auth/host-assertion-signer.js";
import {
  HostRecoveryReviewScopeSchema,
  type HostRecoveryReviewScope,
} from "../../src/host-auth/host-assertion.js";

const args = parseArgs(process.argv.slice(2));
const config = loadHostAuthenticationConfigFromFile(args.configPath);
const privateKey = createPrivateKey(readFileSync(args.privateKeyPath, "utf8"));
const scopes = args.scopes.length === 0
  ? undefined
  : args.scopes.map((scope) => HostRecoveryReviewScopeSchema.parse(scope));

process.stdout.write(
  `${issueHostAssertion({
    config,
    keyId: args.keyId,
    privateKey,
    ...(scopes === undefined
      ? {}
      : { scopeSubset: scopes satisfies HostRecoveryReviewScope[] }),
    ...(args.assertionId === undefined
      ? {}
      : { assertionId: args.assertionId }),
    ...(args.ttlSeconds === undefined
      ? {}
      : { ttlSeconds: args.ttlSeconds }),
  })}\n`,
);

function parseArgs(argv: readonly string[]): {
  readonly configPath: string;
  readonly keyId: string;
  readonly privateKeyPath: string;
  readonly scopes: readonly string[];
  readonly assertionId?: string;
  readonly ttlSeconds?: number;
} {
  const allowedKeys = new Set([
    "config",
    "key-id",
    "private-key",
    "scope",
    "assertion-id",
    "ttl-seconds",
  ]);
  const values = new Map<string, string[]>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === undefined || value === undefined || !key.startsWith("--")) {
      throw new Error("Invalid host assertion arguments.");
    }
    const keyName = key.slice(2);
    if (!allowedKeys.has(keyName)) {
      throw new Error("Unsupported host assertion argument.");
    }
    const existing = values.get(keyName) ?? [];
    existing.push(value);
    values.set(keyName, existing);
    index += 1;
  }

  const configPath = one(values, "config");
  const keyId = one(values, "key-id");
  const privateKeyPath = one(values, "private-key");
  const assertionId = optionalOne(values, "assertion-id");
  const ttlRaw = optionalOne(values, "ttl-seconds");
  const ttlSeconds =
    ttlRaw === undefined ? undefined : Number.parseInt(ttlRaw, 10);
  return {
    configPath,
    keyId,
    privateKeyPath,
    scopes: values.get("scope") ?? [],
    ...(assertionId === undefined ? {} : { assertionId }),
    ...(ttlSeconds === undefined ? {} : { ttlSeconds }),
  };
}

function one(values: ReadonlyMap<string, string[]>, key: string): string {
  const selected = values.get(key);
  if (selected === undefined || selected.length !== 1) {
    throw new Error(`Expected one --${key} argument.`);
  }
  return selected[0]!;
}

function optionalOne(
  values: ReadonlyMap<string, string[]>,
  key: string,
): string | undefined {
  const selected = values.get(key);
  if (selected === undefined) {
    return undefined;
  }
  if (selected.length !== 1) {
    throw new Error(`Expected at most one --${key} argument.`);
  }
  return selected[0];
}
