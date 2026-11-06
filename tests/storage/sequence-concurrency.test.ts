import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeDatabase,
  ExecutionUnitOfWork,
  migrateStorage,
  openDatabase,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

const WORKER_TIMEOUT_MS = 15_000;
const ITERATIONS_PER_WORKER = 12;
const workerPath = fileURLToPath(
  new URL("./sequence-worker.ts", import.meta.url),
);

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
const workers: ChildProcess[] = [];

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.connected) {
      worker.disconnect();
    }
    if (!worker.killed) {
      worker.kill();
    }
  }
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
});

describe("SequenceAllocator multi-connection safety", () => {
  it(
    "allocates unique message, checkpoint, and model-call sequences across writers",
    async () => {
      temporaryDatabase = createTemporaryDatabase();
      database = openDatabase(temporaryDatabase.path);
      migrateStorage(database);
      new ExecutionUnitOfWork(database).createTask({
        taskId: "task-concurrent",
        traceId: "trace-concurrent",
        objective: "Exercise sequence allocation",
        systemPrompt: "You are ForgeFlow.",
        maxModelTurns: 10,
        maxToolCalls: 20,
      });

      const first = await startWorker("worker-a", temporaryDatabase.path);
      const second = await startWorker("worker-b", temporaryDatabase.path);
      const results = await Promise.all([
        runWorker(first),
        runWorker(second),
      ]);
      const expectedCount = ITERATIONS_PER_WORKER * results.length;

      expect(collectColumn(database, "messages", "sequence")).toEqual(
        range(1, expectedCount + 2),
      );
      expect(collectColumn(database, "checkpoints", "sequence")).toEqual(
        range(1, expectedCount + 1),
      );
      expect(
        collectColumn(database, "model_calls", "attempt_no"),
      ).toEqual(range(1, expectedCount));
    },
    WORKER_TIMEOUT_MS,
  );
});

interface WorkerResult {
  type: "complete";
  sequences: {
    messages: number[];
    checkpoints: number[];
    modelCalls: number[];
  };
}

function startWorker(
  workerId: string,
  databasePath: string,
): Promise<ChildProcess> {
  const worker = fork(
    workerPath,
    [
      JSON.stringify({
        databasePath,
        taskId: "task-concurrent",
        workerId,
        iterations: ITERATIONS_PER_WORKER,
      }),
    ],
    {
      execArgv: ["--import", "tsx"],
      stdio: ["ignore", "ignore", "pipe", "ipc"],
    },
  );
  workers.push(worker);

  let stderr = "";
  worker.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`Sequence worker did not become ready.\n${stderr}`));
    }, WORKER_TIMEOUT_MS);

    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
      ) {
        cleanup();
        resolve(worker);
      }
    };
    const onExit = (code: number | null): void => {
      cleanup();
      reject(
        new Error(
          `Sequence worker exited before readiness (${String(code)}).\n${stderr}`,
        ),
      );
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };

    worker.on("message", onMessage);
    worker.once("exit", onExit);
  });
}

function runWorker(worker: ChildProcess): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Sequence worker timed out."));
    }, WORKER_TIMEOUT_MS);

    const onMessage = (message: unknown): void => {
      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "error"
      ) {
        cleanup();
        reject(
          new Error(
            "code" in message && typeof message.code === "string"
              ? message.code
              : "WORKER_FAILED",
          ),
        );
        return;
      }

      if (
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "complete"
      ) {
        cleanup();
        resolve(message as WorkerResult);
      }
    };
    const onExit = (code: number | null): void => {
      if (code !== 0) {
        cleanup();
        reject(
          new Error(`Sequence worker exited with code ${String(code)}.`),
        );
      }
    };
    const cleanup = (): void => {
      clearTimeout(timeout);
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    };

    worker.on("message", onMessage);
    worker.once("exit", onExit);
    worker.send({ type: "start" });
  });
}

function collectColumn(
  activeDatabase: ForgeFlowDatabase,
  table: "messages" | "checkpoints" | "model_calls",
  column: "sequence" | "attempt_no",
): number[] {
  return (
    activeDatabase
      .prepare(
        `SELECT ${column} AS value
         FROM ${table}
         WHERE task_id = ?
         ORDER BY ${column}`,
      )
      .all("task-concurrent") as Array<{ value: number }>
  ).map((row) => row.value);
}

function range(first: number, last: number): number[] {
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}
