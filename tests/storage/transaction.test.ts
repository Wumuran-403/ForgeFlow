import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  openDatabase,
  runInTransaction,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  assertStorageWritePermit,
  createStorageWritePermit,
} from "../../src/storage/write-boundary.js";
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

describe("synchronous transaction wrapper", () => {
  it("commits a synchronous callback result", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");

    const result = runInTransaction(database, () => {
      expect(database?.inTransaction).toBe(true);
      database
        ?.prepare("INSERT INTO items (name) VALUES (?)")
        .run("committed");
      return "ok";
    });

    expect(result).toBe("ok");
    expect(database.inTransaction).toBe(false);
    expect(
      database.prepare("SELECT name FROM items").all(),
    ).toEqual([{ name: "committed" }]);
  });

  it("rejects a thenable before commit and rolls back writes", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");

    expect(() =>
      runInTransaction(
        database as ForgeFlowDatabase,
        (() => {
          (database as ForgeFlowDatabase)
            .prepare("INSERT INTO items (name) VALUES (?)")
            .run("must rollback");
          return Promise.resolve();
        }) as never,
      ),
    ).toThrowError(/synchronous/i);

    expect(database.inTransaction).toBe(false);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM items").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects an async callback before its body starts", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    database.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT NOT NULL)");
    let beforeAwaitExecuted = false;
    let afterAwaitExecuted = false;

    expect(() =>
      runInTransaction(
        database as ForgeFlowDatabase,
        (async () => {
          beforeAwaitExecuted = true;
          await Promise.resolve();
          afterAwaitExecuted = true;
        }) as never,
      ),
    ).toThrowError(/synchronous/i);

    expect(beforeAwaitExecuted).toBe(false);
    expect(afterAwaitExecuted).toBe(false);
    expect(database.inTransaction).toBe(false);
    expect(
      database.prepare("SELECT COUNT(*) AS count FROM items").get(),
    ).toEqual({ count: 0 });
  });

  it("rejects promise-returning callbacks in the TypeScript contract", () => {
    if (false) {
      // @ts-expect-error Async transaction callbacks are not accepted.
      runInTransaction({} as ForgeFlowDatabase, async () => undefined);
    }
  });

  it("invalidates a storage write permit after its transaction commits", () => {
    temporaryDatabase = createTemporaryDatabase();
    database = openDatabase(temporaryDatabase.path);
    let permit:
      | ReturnType<typeof createStorageWritePermit>
      | undefined;

    runInTransaction(
      database,
      () => {
        permit = createStorageWritePermit(database as ForgeFlowDatabase);
        expect(database?.inTransaction).toBe(true);
      },
      "immediate",
    );

    expect(permit).toBeDefined();
    expect(() =>
      runInTransaction(
        database as ForgeFlowDatabase,
        () =>
          assertStorageWritePermit(
            database as ForgeFlowDatabase,
            permit as ReturnType<typeof createStorageWritePermit>,
          ),
        "immediate",
      ),
    ).toThrowError(/permit is invalid/i);
  });
});
