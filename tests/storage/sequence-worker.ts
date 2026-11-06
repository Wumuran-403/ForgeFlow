import { randomUUID } from "node:crypto";

import { z } from "zod";

import type { ModelRequest } from "../../src/provider/types.js";
import {
  CheckpointStore,
  closeDatabase,
  MessageRepository,
  ModelCallRepository,
  openDatabase,
  runInTransaction,
  SequenceAllocator,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";

const WorkerConfigSchema = z
  .object({
    databasePath: z.string().min(1),
    taskId: z.string().min(1),
    workerId: z.string().min(1),
    iterations: z.number().int().positive(),
  })
  .strict();

const StartMessageSchema = z
  .object({
    type: z.literal("start"),
  })
  .strict();

type WorkerConfig = z.infer<typeof WorkerConfigSchema>;

const modelRequest: ModelRequest = {
  model: "mock-model",
  messages: [{ role: "user", content: "Sequence concurrency test" }],
  tools: [],
};

const config = WorkerConfigSchema.parse(
  JSON.parse(process.argv[2] ?? "null") as unknown,
);
const database = openDatabase(config.databasePath);

process.once("message", (message: unknown) => {
  const start = StartMessageSchema.safeParse(message);
  if (!start.success) {
    failAndExit("WORKER_START_MESSAGE_INVALID");
    return;
  }

  try {
    const sequences = appendSequences(database, config);
    sendAndExit(
      {
        type: "complete",
        sequences,
      },
      0,
    );
  } catch {
    failAndExit("WORKER_SEQUENCE_WRITE_FAILED");
  }
});

process.send?.({ type: "ready" });

function appendSequences(
  activeDatabase: ForgeFlowDatabase,
  activeConfig: WorkerConfig,
) {
  const messages: number[] = [];
  const checkpoints: number[] = [];
  const modelCalls: number[] = [];
  const now = "2026-01-01T00:00:03.000Z";

  for (let index = 0; index < activeConfig.iterations; index += 1) {
    messages.push(
      runInTransaction(
        activeDatabase,
        () => {
          const permit = createStorageWritePermit(activeDatabase);
          const sequences = new SequenceAllocator(activeDatabase);
          return new MessageRepository(activeDatabase, sequences).append(
            {
              taskId: activeConfig.taskId,
              role: "user",
              content: `${activeConfig.workerId}:message:${index}`,
            },
            now,
            permit,
          ).sequence;
        },
        "immediate",
      ),
    );

    checkpoints.push(
      runInTransaction(
        activeDatabase,
        () => {
          const permit = createStorageWritePermit(activeDatabase);
          const sequences = new SequenceAllocator(activeDatabase);
          return new CheckpointStore(activeDatabase, sequences).append(
            {
              taskId: activeConfig.taskId,
              reason: `${activeConfig.workerId}:checkpoint:${index}`,
              taskStatus: "queued",
              lastMessageSequence: 2,
              modelIteration: 0,
              lastEventSequence: 1,
              budget: {
                maxModelTurns: 10,
                maxToolCalls: 20,
              },
              metadata: {},
            },
            now,
            permit,
          ).sequence;
        },
        "immediate",
      ),
    );

    modelCalls.push(
      runInTransaction(
        activeDatabase,
        () => {
          const permit = createStorageWritePermit(activeDatabase);
          const sequences = new SequenceAllocator(activeDatabase);
          const attemptNo = sequences.nextModelCallAttempt(
            activeConfig.taskId,
            1,
          );
          return new ModelCallRepository(activeDatabase).createRequested(
            {
              id: randomUUID(),
              taskId: activeConfig.taskId,
              iteration: 1,
              attemptNo,
              request: modelRequest,
              startedAt: now,
            },
            permit,
          ).attemptNo;
        },
        "immediate",
      ),
    );
  }

  return { messages, checkpoints, modelCalls };
}

function failAndExit(code: string): void {
  sendAndExit(
    {
      type: "error",
      code,
    },
    1,
  );
}

function sendAndExit(message: unknown, exitCode: number): void {
  closeDatabase(database);
  if (process.send === undefined) {
    process.exit(exitCode);
  }
  process.send(message, () => {
    process.exit(exitCode);
  });
}
