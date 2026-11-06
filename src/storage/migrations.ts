import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  assertSynchronousFunction,
  assertSynchronousResult,
  runInTransaction,
  type SynchronousOperation,
} from "./transaction.js";

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly up: SynchronousOperation<undefined, [Database.Database]>;
}

export interface MigrationResult {
  readonly appliedVersions: readonly number[];
  readonly currentVersion: number;
}

interface AppliedMigrationRow {
  version: number;
  name: string;
}

const SCHEMA_MIGRATIONS_DDL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY CHECK (version > 0),
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )
`;

function validateMigrations(migrations: readonly Migration[]): readonly Migration[] {
  const versions = new Set<number>();
  const sorted = [...migrations].sort((left, right) => left.version - right.version);

  for (const migration of sorted) {
    assertSynchronousFunction(migration.up);

    if (!Number.isInteger(migration.version) || migration.version <= 0) {
      throw new AppError({
        code: "MIGRATION_VERSION_INVALID",
        message: "Migration versions must be positive integers.",
        statusCode: 500,
        details: [],
      });
    }

    if (migration.name.trim().length === 0) {
      throw new AppError({
        code: "MIGRATION_NAME_INVALID",
        message: "Migration names must not be empty.",
        statusCode: 500,
        details: [],
      });
    }

    if (versions.has(migration.version)) {
      throw new AppError({
        code: "MIGRATION_VERSION_DUPLICATE",
        message: "Migration versions must be unique.",
        statusCode: 500,
        details: [],
      });
    }

    versions.add(migration.version);
  }

  return sorted;
}

export function runMigrations(
  database: Database.Database,
  migrations: readonly Migration[],
): MigrationResult {
  const sortedMigrations = validateMigrations(migrations);

  return runInTransaction(database, () => {
    database.exec(SCHEMA_MIGRATIONS_DDL);
    const appliedRows = database
      .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
      .all() as AppliedMigrationRow[];
    const providedVersions = new Set(
      sortedMigrations.map((migration) => migration.version),
    );

    for (const row of appliedRows) {
      if (!providedVersions.has(row.version)) {
        throw new AppError({
          code: "MIGRATION_HISTORY_UNKNOWN",
          message: `Applied migration ${row.version} is not available.`,
          statusCode: 500,
          details: [],
        });
      }

      const migration = sortedMigrations.find(
        (candidate) => candidate.version === row.version,
      );
      if (migration === undefined || migration.name !== row.name) {
        throw new AppError({
          code: "MIGRATION_HISTORY_MISMATCH",
          message: `Applied migration ${row.version} does not match its definition.`,
          statusCode: 500,
          details: [],
        });
      }
    }

    const appliedVersions = new Set(appliedRows.map((row) => row.version));
    const insertMigration = database.prepare(
      "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
    );
    const newlyApplied: number[] = [];

    for (const migration of sortedMigrations) {
      if (appliedVersions.has(migration.version)) {
        continue;
      }

      assertSynchronousFunction(migration.up);
      const result = migration.up(database);
      assertSynchronousResult(result);
      insertMigration.run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      );
      newlyApplied.push(migration.version);
    }

    return {
      appliedVersions: newlyApplied,
      currentVersion: Math.max(
        0,
        ...appliedRows.map((row) => row.version),
        ...newlyApplied,
      ),
    };
  });
}
