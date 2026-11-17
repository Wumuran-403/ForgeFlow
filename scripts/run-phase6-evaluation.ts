import "dotenv/config";

import { resolve } from "node:path";

import { EvaluationRunner, PHASE6_1_EVALUATION_SUITE, Phase61ReferenceExecutor } from "../src/evaluation/index.js";
import { closeDatabase, migrateStorage, openDatabase } from "../src/storage/index.js";

const databaseArgument = process.argv.slice(2).find((argument) => argument !== "--");
const databasePath = resolve(databaseArgument ?? "data/evaluation.db");
const database = openDatabase(databasePath);
try {
  migrateStorage(database);
  const result = await new EvaluationRunner(database, new Phase61ReferenceExecutor(), {
    providerId: "mock+deterministic-tools",
    configVersion: "phase6.1-v1",
  }).run(PHASE6_1_EVALUATION_SUITE);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  closeDatabase(database);
}
