import type Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { phase3Step2Migration } from "./001-phase3-step2.js";
import { phase3Step3Migration } from "./002-phase3-step3.js";
import { phase3Step4Migration } from "./003-phase3-step4.js";
import { phase3Step6_3_1Migration } from "./004-phase3-step6-3-1.js";

export const PHASE3_STORAGE_MIGRATIONS = [
  phase3Step2Migration,
  phase3Step3Migration,
  phase3Step4Migration,
  phase3Step6_3_1Migration,
] as const;

export function migrateStorage(database: Database.Database) {
  return runMigrations(database, PHASE3_STORAGE_MIGRATIONS);
}
