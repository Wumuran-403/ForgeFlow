import type Database from "better-sqlite3";

import type { Migration } from "../migrations.js";

const PHASE3_STEP6_3_2_1_SCHEMA = `
  CREATE TRIGGER recovery_review_operations_validate_status_insert
  BEFORE INSERT ON recovery_review_operations
  WHEN NOT (
    (
      NEW.operation = 'request_readback'
      AND NEW.status = 'accepted'
    )
    OR (
      NEW.operation != 'request_readback'
      AND NEW.status = 'applied'
    )
  )
  BEGIN
    SELECT RAISE(ABORT, 'operation and status combination is invalid');
  END;
`;

export const phase3Step6_3_2_1Migration: Migration = {
  version: 6,
  name: "phase3_step6_3_2_1_operation_status_boundary",
  up: (database: Database.Database) => {
    database.exec(PHASE3_STEP6_3_2_1_SCHEMA);
  },
};
