import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_DATABASE_PATH } from "../../src/config/env.js";
import {
  closeDatabase,
  DATABASE_BUSY_TIMEOUT_MS,
  openDatabase,
  resolveDatabasePath,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("SQLite database foundation", () => {
  it("initializes a file-backed database with durable pragmas", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);

    expect(existsSync(temporaryDatabase.path)).toBe(true);
    expect(database.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(database.pragma("synchronous", { simple: true })).toBe(2);
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(database.pragma("busy_timeout", { simple: true })).toBe(
      DATABASE_BUSY_TIMEOUT_MS,
    );
  });

  it("applies connection initialization to every new connection", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const secondConnection = openDatabase(temporaryDatabase.path);

    try {
      for (const connection of [database, secondConnection]) {
        expect(connection.pragma("journal_mode", { simple: true })).toBe("wal");
        expect(connection.pragma("synchronous", { simple: true })).toBe(2);
        expect(connection.pragma("foreign_keys", { simple: true })).toBe(1);
        expect(connection.pragma("busy_timeout", { simple: true })).toBe(
          DATABASE_BUSY_TIMEOUT_MS,
        );
      }
    } finally {
      closeDatabase(secondConnection);
    }
  });

  it("keeps temporary test paths separate from the production default", () => {
    temporaryDatabase = createTemporaryDatabase();
    const productionPath = resolveDatabasePath(DEFAULT_DATABASE_PATH);
    const productionExistedBefore = existsSync(productionPath);

    expect(temporaryDatabase.path).not.toBe(
      productionPath,
    );
    expect(resolve(temporaryDatabase.path)).toContain("forgeflow-sqlite-");

    database = openDatabase(temporaryDatabase.path);

    expect(existsSync(temporaryDatabase.path)).toBe(true);
    expect(existsSync(productionPath)).toBe(productionExistedBefore);
  });

  it("resolves relative paths against an explicit base directory", () => {
    temporaryDatabase = createTemporaryDatabase();

    expect(
      resolveDatabasePath("nested/app.db", temporaryDatabase.directory),
    ).toBe(resolve(temporaryDatabase.directory, "nested/app.db"));
  });

  it("supports an in-memory connection without a filesystem path", () => {
    database = openDatabase(":memory:");

    expect(database.pragma("journal_mode", { simple: true })).toBe("memory");
    expect(database.pragma("foreign_keys", { simple: true })).toBe(1);
  });
});
