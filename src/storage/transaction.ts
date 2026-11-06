import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";

type NonThenable<T> = T extends PromiseLike<unknown> ? never : T;

export type SynchronousOperation<
  T = undefined,
  TArguments extends unknown[] = [],
> = (...args: TArguments) => NonThenable<T>;

export type TransactionMode = "deferred" | "immediate" | "exclusive";

interface WriteTransactionContext {
  readonly token: object;
  depth: number;
}

const writeTransactionContexts = new WeakMap<
  Database.Database,
  WriteTransactionContext
>();

export class AsyncTransactionForbiddenError extends AppError {
  constructor() {
    super({
      code: "ASYNC_TRANSACTION_FORBIDDEN",
      message: "SQLite transaction callbacks must be synchronous.",
      statusCode: 500,
      details: [],
    });
  }
}

export function assertSynchronousFunction(value: unknown): void {
  if (typeof value !== "function") {
    throw new AsyncTransactionForbiddenError();
  }

  const tag = Object.prototype.toString.call(value);
  if (
    tag === "[object AsyncFunction]" ||
    tag === "[object AsyncGeneratorFunction]"
  ) {
    throw new AsyncTransactionForbiddenError();
  }
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === "object" || typeof value === "function") &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

export function assertSynchronousResult(value: unknown): void {
  if (isThenable(value)) {
    throw new AsyncTransactionForbiddenError();
  }
}

export function assertWriteTransaction(
  database: Database.Database,
): void {
  if (
    !database.inTransaction ||
    !writeTransactionContexts.has(database)
  ) {
    throw new AppError({
      code: "WRITE_TRANSACTION_REQUIRED",
      message: "A write operation requires an immediate transaction.",
      statusCode: 500,
      details: [],
    });
  }
}

export function getWriteTransactionToken(
  database: Database.Database,
): object {
  assertWriteTransaction(database);
  const context = writeTransactionContexts.get(database);
  if (context === undefined) {
    throw new AppError({
      code: "WRITE_TRANSACTION_REQUIRED",
      message: "A write operation requires an immediate transaction.",
      statusCode: 500,
      details: [],
    });
  }
  return context.token;
}

export function runInTransaction<T>(
  database: Database.Database,
  operation: SynchronousOperation<T>,
  mode: TransactionMode = "deferred",
): T {
  assertSynchronousFunction(operation);

  const transaction = database.transaction(() => {
    const usesWriteLock = mode === "immediate" || mode === "exclusive";
    let previousContext: WriteTransactionContext | undefined;
    if (usesWriteLock) {
      previousContext = writeTransactionContexts.get(database);
      writeTransactionContexts.set(
        database,
        previousContext === undefined
          ? { token: Object.freeze({}), depth: 1 }
          : { ...previousContext, depth: previousContext.depth + 1 },
      );
    }

    try {
      const result = operation();
      assertSynchronousResult(result);
      return result;
    } finally {
      if (usesWriteLock) {
        if (
          previousContext === undefined ||
          previousContext.depth === 0
        ) {
          writeTransactionContexts.delete(database);
        } else {
          writeTransactionContexts.set(database, previousContext);
        }
      }
    }
  });

  if (mode === "immediate") {
    return transaction.immediate();
  }

  if (mode === "exclusive") {
    return transaction.exclusive();
  }

  return transaction.deferred();
}
