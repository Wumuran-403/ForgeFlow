import type Database from "better-sqlite3";

import { runMigrations } from "../migrations.js";
import { phase3Step2Migration } from "./001-phase3-step2.js";
import { phase3Step3Migration } from "./002-phase3-step3.js";
import { phase3Step4Migration } from "./003-phase3-step4.js";
import { phase3Step6_3_1Migration } from "./004-phase3-step6-3-1.js";
import { phase3Step6_3_2Migration } from "./005-phase3-step6-3-2.js";
import { phase3Step6_3_2_1Migration } from "./006-phase3-step6-3-2-1.js";
import { phase3Step6_3_3_1Migration } from "./007-phase3-step6-3-3-1.js";
import { phase3Step6_3_4_2Migration } from "./008-phase3-step6-3-4-2.js";
import { phase3Step6_3_4_4Migration } from "./009-phase3-step6-3-4-4.js";
import { phase4_3TokenBudgetMigration } from "./010-phase4-3-token-budget.js";
import { phase6_1EvaluationMigration } from "./011-phase6-1-evaluation.js";
import { phase6_3AnonymousBudgetMigration } from "./012-phase6-3-anonymous-budget.js";

export const PHASE3_STORAGE_MIGRATIONS = [
  phase3Step2Migration,
  phase3Step3Migration,
  phase3Step4Migration,
  phase3Step6_3_1Migration,
  phase3Step6_3_2Migration,
  phase3Step6_3_2_1Migration,
  phase3Step6_3_3_1Migration,
  phase3Step6_3_4_2Migration,
  phase3Step6_3_4_4Migration,
  phase4_3TokenBudgetMigration,
] as const;

export const STORAGE_MIGRATIONS = [
  ...PHASE3_STORAGE_MIGRATIONS,
  phase6_1EvaluationMigration,
  phase6_3AnonymousBudgetMigration,
] as const;

export function migrateStorage(database: Database.Database) {
  return runMigrations(database, STORAGE_MIGRATIONS);
}
