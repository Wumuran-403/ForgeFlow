import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";

import {
  closeDatabase,
  openDatabase,
  runMigrations,
  type ForgeFlowDatabase,
  type Migration,
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

describe("migration runner", () => {
  it("applies migrations once and records schema versions", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    const migrations: Migration[] = [
      {
        version: 1,
        name: "create_notes",
        up: (db) => {
          db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
        },
      },
      {
        version: 2,
        name: "seed_note",
        up: (db) => {
          db.prepare("INSERT INTO notes (body) VALUES (?)").run("first");
        },
      },
    ];

    expect(runMigrations(database, migrations)).toEqual({
      appliedVersions: [1, 2],
      currentVersion: 2,
    });
    expect(runMigrations(database, migrations)).toEqual({
      appliedVersions: [],
      currentVersion: 2,
    });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get(),
    ).toEqual({ count: 2 });
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM notes").get(),
    ).toEqual({ count: 1 });
  });

  it("rolls back the full migration run when any migration fails", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);

    expect(() =>
      runMigrations(database as ForgeFlowDatabase, [
        {
          version: 1,
          name: "create_notes",
          up: (db) => {
            db.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY)");
          },
        },
        {
          version: 2,
          name: "failing_migration",
          up: (db) => {
            db.exec("CREATE TABLE transient (id INTEGER PRIMARY KEY)");
            throw new Error("migration failed");
          },
        },
      ]),
    ).toThrow("migration failed");

    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
    ).toEqual([]);
  });

  it("does not commit an async migration callback", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    let beforeAwaitExecuted = false;
    let afterAwaitExecuted = false;
    const migrations: Migration[] = [
      {
        version: 1,
        name: "async_migration",
        up: (async (db: Database.Database) => {
          beforeAwaitExecuted = true;
          db.exec("CREATE TABLE should_rollback (id INTEGER PRIMARY KEY)");
          await Promise.resolve();
          afterAwaitExecuted = true;
        }) as never,
      },
    ];

    expect(() => runMigrations(database as ForgeFlowDatabase, migrations))
      .toThrowError(/synchronous/i);
    expect(beforeAwaitExecuted).toBe(false);
    expect(afterAwaitExecuted).toBe(false);
    expect(
      database
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
        )
        .all(),
    ).toEqual([]);
  });

  it("rejects async migration callbacks in the TypeScript contract", () => {
    if (false) {
      const migration: Migration = {
        version: 1,
        name: "invalid_async",
        // @ts-expect-error Async migration callbacks are not accepted.
        up: async () => undefined,
      };
      void migration;
    }
  });

  it("rejects an applied migration whose name changed", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    runMigrations(database, [
      {
        version: 1,
        name: "original_name",
        up: (db) => {
          db.exec("CREATE TABLE original_table (id INTEGER PRIMARY KEY)");
        },
      },
    ]);

    expect(() =>
      runMigrations(database as ForgeFlowDatabase, [
        {
          version: 1,
          name: "changed_name",
          up: () => undefined,
        },
      ]),
    ).toThrowError(/does not match/i);
  });
});
