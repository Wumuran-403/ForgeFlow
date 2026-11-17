import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import Database from "better-sqlite3";

const [sourceArgument, destinationArgument] = process.argv.slice(2);
if (!sourceArgument || !destinationArgument) {
  process.stderr.write("Usage: node scripts/backup-sqlite.mjs <source.db> <backup.db>\n");
  process.exitCode = 2;
} else {
  const source = resolve(sourceArgument);
  const destination = resolve(destinationArgument);
  if (source === destination) {
    process.stderr.write("Source and backup paths must differ.\n");
    process.exitCode = 2;
  } else {
    let database;
    try {
      mkdirSync(dirname(destination), { recursive: true });
      database = new Database(source, { readonly: true, fileMustExist: true });
      await database.backup(destination);
      const backup = new Database(destination, { readonly: true, fileMustExist: true });
      try {
        const result = backup.pragma("integrity_check", { simple: true });
        if (result !== "ok") throw new Error("Backup integrity check failed.");
      } finally {
        backup.close();
      }
      process.stdout.write(`SQLite backup verified: ${destination}\n`);
    } catch {
      process.stderr.write("SQLite backup failed. Check paths, permissions, and free space.\n");
      process.exitCode = 1;
    } finally {
      database?.close();
    }
  }
}
