import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

import Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";

export const DATABASE_BUSY_TIMEOUT_MS = 5_000;

export type ForgeFlowDatabase = Database.Database;

export interface DatabasePragmaSnapshot {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeout: number;
}

export interface OpenDatabaseOptions {
  baseDirectory?: string;
}

function readPragma(
  database: ForgeFlowDatabase,
  pragma: string,
): unknown {
  return database.pragma(pragma, { simple: true });
}

export function resolveDatabasePath(
  databasePath: string,
  baseDirectory: string = process.cwd(),
): string {
  const trimmedPath = databasePath.trim();
  if (trimmedPath.length === 0) {
    throw new AppError({
      code: "DATABASE_PATH_INVALID",
      message: "DATABASE_PATH must not be empty.",
      statusCode: 500,
      details: [],
    });
  }

  if (trimmedPath === ":memory:" || isAbsolute(trimmedPath)) {
    return trimmedPath;
  }

  return resolve(baseDirectory, trimmedPath);
}

export function configureDatabaseConnection(
  database: ForgeFlowDatabase,
): DatabasePragmaSnapshot {
  database.pragma("foreign_keys = ON");
  database.pragma(`busy_timeout = ${DATABASE_BUSY_TIMEOUT_MS}`);
  database.pragma("journal_mode = WAL");
  database.pragma("synchronous = FULL");

  const snapshot: DatabasePragmaSnapshot = {
    journalMode: String(readPragma(database, "journal_mode")),
    synchronous: Number(readPragma(database, "synchronous")),
    foreignKeys: Number(readPragma(database, "foreign_keys")),
    busyTimeout: Number(readPragma(database, "busy_timeout")),
  };
  const expectedJournalMode = database.memory ? "memory" : "wal";

  if (
    snapshot.journalMode !== expectedJournalMode ||
    snapshot.synchronous !== 2 ||
    snapshot.foreignKeys !== 1 ||
    snapshot.busyTimeout !== DATABASE_BUSY_TIMEOUT_MS
  ) {
    throw new AppError({
      code: "DATABASE_PRAGMA_INVALID",
      message: "SQLite connection configuration is invalid.",
      statusCode: 500,
      details: [],
    });
  }

  return snapshot;
}

export function openDatabase(
  databasePath: string,
  options: OpenDatabaseOptions = {},
): ForgeFlowDatabase {
  const resolvedPath = resolveDatabasePath(
    databasePath,
    options.baseDirectory,
  );

  if (resolvedPath !== ":memory:") {
    mkdirSync(dirname(resolvedPath), { recursive: true });
  }

  const database = new Database(resolvedPath, {
    timeout: DATABASE_BUSY_TIMEOUT_MS,
  });

  try {
    configureDatabaseConnection(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function closeDatabase(database: ForgeFlowDatabase): void {
  if (database.open) {
    database.close();
  }
}
