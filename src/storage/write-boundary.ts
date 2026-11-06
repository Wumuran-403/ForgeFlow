import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import {
  assertWriteTransaction,
  getWriteTransactionToken,
} from "./transaction.js";

const writePermitBrand = Symbol("forgeflow.storage.writePermit");
const writePermitTransactionBrand = Symbol(
  "forgeflow.storage.writePermitTransaction",
);

export interface StorageWritePermit {
  readonly [writePermitBrand]: true;
  readonly [writePermitTransactionBrand]: object;
}

export function createStorageWritePermit(
  database: Database.Database,
): StorageWritePermit {
  assertWriteTransaction(database);
  return Object.freeze({
    [writePermitBrand]: true as const,
    [writePermitTransactionBrand]: getWriteTransactionToken(database),
  });
}

export function assertStorageWritePermit(
  database: Database.Database,
  permit: StorageWritePermit,
): void {
  assertWriteTransaction(database);
  if (
    permit === null ||
    typeof permit !== "object" ||
    permit[writePermitBrand] !== true ||
    permit[writePermitTransactionBrand] !==
      getWriteTransactionToken(database)
  ) {
    throw new AppError({
      code: "STORAGE_WRITE_PERMIT_INVALID",
      message: "Storage write permit is invalid.",
      statusCode: 500,
      details: [],
    });
  }
}
