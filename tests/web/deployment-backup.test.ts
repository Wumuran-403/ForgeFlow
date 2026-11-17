import { execFileSync } from "node:child_process";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

describe("deployment SQLite backup", () => {
  it("creates a consistent backup that can be restored offline", () => {
    const directory = mkdtempSync(join(tmpdir(), "forgeflow-deploy-backup-"));
    const source = join(directory, "source.db");
    const backup = join(directory, "backup.db");
    const restored = join(directory, "restored.db");
    try {
      const database = new Database(source);
      database.pragma("journal_mode = WAL");
      database.exec("CREATE TABLE sample (value TEXT NOT NULL); INSERT INTO sample VALUES ('persisted');");
      execFileSync(process.execPath, [resolve("scripts/backup-sqlite.mjs"), source, backup], { stdio: "pipe" });
      database.close();
      copyFileSync(backup, restored);
      const recovery = new Database(restored, { readonly: true });
      try {
        expect(recovery.prepare("SELECT value FROM sample").get()).toEqual({ value: "persisted" });
        expect(recovery.pragma("integrity_check", { simple: true })).toBe("ok");
      } finally {
        recovery.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
