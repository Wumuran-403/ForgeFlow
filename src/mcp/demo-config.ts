import { fileURLToPath } from "node:url";

import type { TrustedMcpStdioServerConfig } from "./types.js";

export function createInventoryDemoMcpConfig(): TrustedMcpStdioServerConfig {
  return {
    serverId: "inventory-demo",
    namespace: "inventory",
    command: process.execPath,
    args: ["--import", "tsx", fileURLToPath(new URL("./demo-server.ts", import.meta.url))],
    env: minimalChildEnvironment(),
    connectTimeoutMs: 10_000,
    tools: [
      {
        remoteName: "inventory.search",
        mode: "read",
        requiresApproval: false,
        timeoutMs: 5_000,
        maxOutputBytes: 65_536,
      },
    ],
  };
}

function minimalChildEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const name of ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "COMSPEC"]) {
    const value = process.env[name];
    if (value !== undefined) environment[name] = value;
  }
  return environment;
}
