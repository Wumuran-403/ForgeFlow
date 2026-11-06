import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { createTemporaryDatabase } from "./test-database.js";

const require = createRequire(import.meta.url);

describe("storage module import safety", () => {
  it("does not create the production database or directory on import", () => {
    const temporaryDatabase = createTemporaryDatabase();
    const configModuleUrl = pathToFileURL(
      resolve("src/config/env.ts"),
    ).href;
    const databaseModuleUrl = pathToFileURL(
      resolve("src/storage/database.ts"),
    ).href;
    const loaderUrl = pathToFileURL(require.resolve("tsx")).href;
    const script = `
      const { existsSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      const configModule = await import(${JSON.stringify(configModuleUrl)});
      const databaseModule = await import(${JSON.stringify(databaseModuleUrl)});
      const config = configModule.loadConfig({});
      const databasePath = databaseModule.resolveDatabasePath(config.database.path);
      console.log(JSON.stringify({
        databasePath,
        fileExists: existsSync(databasePath),
        directoryExists: existsSync(dirname(databasePath))
      }));
    `;

    try {
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          loaderUrl,
          "--input-type=module",
          "--eval",
          script,
        ],
        {
          cwd: temporaryDatabase.directory,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_ENV: "test",
          },
        },
      );

      expect(child.status, child.stderr).toBe(0);
      const output = JSON.parse(child.stdout.trim()) as {
        databasePath: string;
        fileExists: boolean;
        directoryExists: boolean;
      };

      expect(output.databasePath).toBe(
        resolve(temporaryDatabase.directory, "data", "forgeflow.db"),
      );
      expect(output.fileExists).toBe(false);
      expect(output.directoryExists).toBe(false);
    } finally {
      temporaryDatabase.cleanup();
    }
  });
});
