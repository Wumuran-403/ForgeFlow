import { afterEach, describe, expect, it } from "vitest";

import type {
  ModelRequest,
  ModelResponse,
} from "../../src/provider/types.js";
import {
  closeDatabase,
  EventRepository,
  ExecutionUnitOfWork,
  MessageRepository,
  migrateStorage,
  ModelCallRepository,
  openDatabase,
  runInTransaction,
  SequenceAllocator,
  TaskRepository,
  TaskSnapshotReader,
  type ForgeFlowDatabase,
} from "../../src/storage/index.js";
import { createStorageWritePermit } from "../../src/storage/write-boundary.js";
import {
  createTemporaryDatabase,
  type TemporaryDatabase,
} from "./test-database.js";

let temporaryDatabase: TemporaryDatabase | undefined;
let database: ForgeFlowDatabase | undefined;
let unitOfWork: ExecutionUnitOfWork | undefined;
let snapshotReader: TaskSnapshotReader | undefined;
let taskRepository: TaskRepository | undefined;
let messageRepository: MessageRepository | undefined;
let modelCallRepository: ModelCallRepository | undefined;
let eventRepository: EventRepository | undefined;

const taskInput = {
  taskId: "task-001",
  traceId: "trace-001",
  objective: "Inspect a BOM",
  systemPrompt: "You are ForgeFlow.",
  maxModelTurns: 10,
  maxToolCalls: 20,
};

const modelRequest: ModelRequest = {
  model: "mock-model",
  messages: [
    {
      role: "user",
      content: "Inspect a BOM",
    },
  ],
  tools: [],
};

const modelResponse: ModelResponse = {
  message: {
    role: "assistant",
    content: "BOM inspected",
  },
  usage: {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    source: "provider",
  },
  finishReason: "stop",
  requestId: "provider-request-001",
};

function initialize(): void {
  temporaryDatabase = createTemporaryDatabase();
  database = openDatabase(temporaryDatabase.path);
  migrateStorage(database);
  const allocator = new SequenceAllocator(database);
  unitOfWork = new ExecutionUnitOfWork(database);
  snapshotReader = new TaskSnapshotReader(database);
  taskRepository = new TaskRepository(database);
  messageRepository = new MessageRepository(database, allocator);
  modelCallRepository = new ModelCallRepository(database);
  eventRepository = new EventRepository(database, allocator);
}

afterEach(() => {
  if (database !== undefined) {
    closeDatabase(database);
    database = undefined;
  }
  temporaryDatabase?.cleanup();
  temporaryDatabase = undefined;
  unitOfWork = undefined;
  snapshotReader = undefined;
  taskRepository = undefined;
  messageRepository = undefined;
  modelCallRepository = undefined;
  eventRepository = undefined;
});

describe("Step 2 repositories and unit of work", () => {
  it("creates and reads a task with initial messages, event, and checkpoint", () => {
    initialize();
    const snapshot = unitOfWork?.createTask(taskInput);

    expect(snapshot?.task).toMatchObject({
      id: "task-001",
      traceId: "trace-001",
      status: "queued",
      objective: "Inspect a BOM",
      currentIteration: 0,
      lastEventSequence: 1,
    });
    expect(snapshot?.messages.map((message) => message.role)).toEqual([
      "system",
      "user",
    ]);
    expect(snapshot?.messages.map((message) => message.sequence)).toEqual([1, 2]);
    expect(snapshot?.events).toHaveLength(1);
    expect(snapshot?.events[0]).toMatchObject({
      sequence: 1,
      type: "task.created",
    });
    expect(snapshot?.checkpoints).toHaveLength(1);
    expect(snapshot?.checkpoints[0]).toMatchObject({
      sequence: 1,
      reason: "task_created",
      taskStatus: "queued",
      lastMessageSequence: 2,
      lastEventSequence: 1,
    });
    expect(taskRepository?.get("task-001")).toEqual(snapshot?.task);
  });

  it("enforces message sequence uniqueness and allocates the next sequence", () => {
    initialize();
    unitOfWork?.createTask(taskInput);

    const next = runInTransaction(
      database as ForgeFlowDatabase,
      () => {
        const permit = createStorageWritePermit(
          database as ForgeFlowDatabase,
        );
        return messageRepository?.append(
          {
            taskId: "task-001",
            role: "user",
            content: "Another message",
          },
          "2026-01-01T00:00:03.000Z",
          permit,
        );
      },
      "immediate",
    );

    expect(next?.sequence).toBe(3);
    expect(() =>
      database
        ?.prepare(
          `
            INSERT INTO messages
              (id, task_id, sequence, role, content, created_at)
            VALUES
              ('duplicate', 'task-001', 3, 'user', 'duplicate', '2026-01-01')
          `,
        )
        .run(),
    ).toThrow();
  });

  it("records separate model-call attempts and completes a response atomically", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    const first = unitOfWork?.beginModelCall({
      taskId: "task-001",
      iteration: 1,
      request: modelRequest,
    });
    const second = unitOfWork?.beginModelCall({
      taskId: "task-001",
      iteration: 1,
      request: modelRequest,
    });

    expect(first?.attemptNo).toBe(1);
    expect(second?.attemptNo).toBe(2);
    expect(
      modelCallRepository?.listByTask("task-001").map((call) => call.status),
    ).toEqual(["requested", "requested"]);

    const snapshot = unitOfWork?.completeModelCall({
      modelCallId: second?.id as string,
      response: modelResponse,
      durationMs: 25,
    });

    expect(snapshot?.modelCalls.find((call) => call.id === second?.id)).toMatchObject({
      status: "completed",
      response: {
        message: {
          content: "BOM inspected",
        },
      },
      usage: {
        totalTokens: 15,
      },
      durationMs: 25,
    });
    expect(snapshot?.messages.at(-1)).toMatchObject({
      role: "assistant",
      content: "BOM inspected",
      sequence: 3,
    });
    expect(snapshot?.events.map((event) => event.type)).toEqual([
      "task.created",
      "llm.requested",
      "llm.requested",
      "llm.responded",
    ]);
    expect(snapshot?.checkpoints.at(-1)).toMatchObject({
      reason: "model_response",
      lastMessageSequence: 3,
      modelIteration: 1,
    });
  });

  it("keeps events append-only and sequences unique", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    const nextEvent = runInTransaction(
      database as ForgeFlowDatabase,
      () => {
        const permit = createStorageWritePermit(
          database as ForgeFlowDatabase,
        );
        return eventRepository?.append(
          {
            taskId: "task-001",
            traceId: "trace-001",
            type: "test.event",
            payload: {
              value: "second",
            },
          },
          "2026-01-01T00:00:03.000Z",
          permit,
        );
      },
      "immediate",
    );

    expect(nextEvent?.sequence).toBe(2);
    expect(() =>
      database
        ?.prepare("UPDATE events SET type = 'changed' WHERE sequence = 1")
        .run(),
    ).toThrow(/append-only/);
    expect(() =>
      database?.prepare("DELETE FROM events WHERE sequence = 1").run(),
    ).toThrow(/append-only/);
    expect(() =>
      database
        ?.prepare(
          `
            INSERT INTO events
              (id, task_id, sequence, trace_id, type, payload_json, created_at)
            VALUES
              ('dup-event', 'task-001', 2, 'trace-001', 'duplicate', '{}', '2026-01-01')
          `,
        )
        .run(),
    ).toThrow();
  });

  it("validates JSON on write and rejects corrupted JSON on read", () => {
    initialize();
    unitOfWork?.createTask(taskInput);

    expect(() =>
      runInTransaction(
        database as ForgeFlowDatabase,
        () => {
          const permit = createStorageWritePermit(
            database as ForgeFlowDatabase,
          );
          return eventRepository?.append(
            {
              taskId: "task-001",
              traceId: "trace-001",
              type: "invalid.payload",
              payload: {
                unsupported: 1n,
              },
            },
            "2026-01-01T00:00:03.000Z",
            permit,
          );
        },
        "immediate",
      ),
    ).toThrowError(/Persisted JSON data is invalid/);

    database
      ?.prepare(
        "UPDATE tasks SET token_usage_json = '{not-json' WHERE id = 'task-001'",
      )
      .run();
    expect(() => taskRepository?.get("task-001")).toThrowError(
      /Persisted JSON data is invalid/,
    );
  });

  it("reads the basic TaskSnapshot in one transaction", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    expect(database?.inTransaction).toBe(false);
    const databasePrototype = Object.getPrototypeOf(
      database as ForgeFlowDatabase,
    ) as {
      transaction: ForgeFlowDatabase["transaction"];
    };
    const originalTransaction = databasePrototype.transaction;
    let transactionCount = 0;
    databasePrototype.transaction = function (
      this: ForgeFlowDatabase,
      ...args: Parameters<ForgeFlowDatabase["transaction"]>
    ) {
      transactionCount += 1;
      return originalTransaction.apply(this, args);
    };

    let snapshot;
    try {
      snapshot = snapshotReader?.load("task-001");
    } finally {
      databasePrototype.transaction = originalTransaction;
    }

    expect(transactionCount).toBe(1);
    expect(snapshot).toMatchObject({
      task: {
        id: "task-001",
      },
    });
    expect(snapshot?.messages).toHaveLength(2);
    expect(snapshot?.modelCalls).toHaveLength(0);
    expect(snapshot?.events).toHaveLength(1);
    expect(snapshot?.checkpoints).toHaveLength(1);
    expect(snapshot?.executionPlans).toHaveLength(0);
    expect(snapshot?.planSteps).toHaveLength(0);
    expect(snapshot?.toolRuns).toHaveLength(0);
    expect(snapshot?.approvals).toHaveLength(0);
    expect(snapshot?.recoveryReviews).toHaveLength(0);
  });

  it("rolls back the entire task creation when a later insert fails", () => {
    initialize();
    database?.exec(
      `
        CREATE TRIGGER reject_message
        BEFORE INSERT ON messages
        BEGIN
          SELECT RAISE(ABORT, 'message rejected');
        END
      `,
    );

    expect(() => unitOfWork?.createTask(taskInput)).toThrow("message rejected");
    expect(
      database?.prepare("SELECT COUNT(*) AS count FROM tasks").get(),
    ).toEqual({ count: 0 });
    expect(
      database?.prepare("SELECT COUNT(*) AS count FROM messages").get(),
    ).toEqual({ count: 0 });
    expect(
      database?.prepare("SELECT COUNT(*) AS count FROM events").get(),
    ).toEqual({ count: 0 });
    expect(
      database?.prepare("SELECT COUNT(*) AS count FROM checkpoints").get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back model response, message, event, and checkpoint together", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    const call = unitOfWork?.beginModelCall({
      taskId: "task-001",
      iteration: 1,
      request: modelRequest,
    });
    database?.exec(
      `
        CREATE TRIGGER reject_model_checkpoint
        BEFORE INSERT ON checkpoints
        WHEN NEW.reason = 'model_response'
        BEGIN
          SELECT RAISE(ABORT, 'checkpoint rejected');
        END
      `,
    );

    expect(() =>
      unitOfWork?.completeModelCall({
        modelCallId: call?.id as string,
        response: modelResponse,
        durationMs: 25,
      }),
    ).toThrow("checkpoint rejected");

    expect(modelCallRepository?.get(call?.id as string).status).toBe("requested");
    expect(
      database
        ?.prepare(
          "SELECT COUNT(*) AS count FROM messages WHERE role = 'assistant'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        ?.prepare(
          "SELECT COUNT(*) AS count FROM events WHERE type = 'llm.responded'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(
      database
        ?.prepare(
          "SELECT COUNT(*) AS count FROM checkpoints WHERE reason = 'model_response'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("rolls back task status when the paired event insert fails", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    database?.exec(
      `
        CREATE TRIGGER reject_status_event
        BEFORE INSERT ON events
        WHEN NEW.type = 'task.status_changed'
        BEGIN
          SELECT RAISE(ABORT, 'event rejected');
        END
      `,
    );

    expect(() => unitOfWork?.updateTaskStatus("task-001", "running")).toThrow(
      "event rejected",
    );
    expect(taskRepository?.get("task-001").status).toBe("queued");
    expect(
      database
        ?.prepare(
          "SELECT COUNT(*) AS count FROM events WHERE type = 'task.status_changed'",
        )
        .get(),
    ).toEqual({ count: 0 });
  });

  it("records model call failures and interrupted attempts", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    const call = unitOfWork?.beginModelCall({
      taskId: "task-001",
      iteration: 1,
      request: modelRequest,
    });

    const snapshot = unitOfWork?.failModelCall({
      modelCallId: call?.id as string,
      status: "interrupted",
      durationMs: 10,
      error: {
        code: "PROVIDER_INTERRUPTED",
        message: "Provider call was interrupted.",
        details: [],
      },
    });

    expect(snapshot?.modelCalls[0]).toMatchObject({
      status: "interrupted",
      error: {
        code: "PROVIDER_INTERRUPTED",
      },
    });
    expect(snapshot?.events.at(-1)?.type).toBe("llm.interrupted");
    expect(snapshot?.checkpoints.at(-1)?.reason).toBe("model_call_finished");
  });

  it("blocks direct repository mutations outside an immediate write transaction", () => {
    initialize();
    unitOfWork?.createTask(taskInput);
    const call = unitOfWork?.beginModelCall({
      taskId: "task-001",
      iteration: 1,
      request: modelRequest,
    });

    expect(() =>
      taskRepository?.updateStatus(
        "task-001",
        "running",
        "2026-01-01T00:00:03.000Z",
        {} as never,
      ),
    ).toThrowError(/immediate transaction/i);
    expect(() =>
      modelCallRepository?.complete(
        call?.id as string,
        modelResponse,
        25,
        "2026-01-01T00:00:03.000Z",
        {} as never,
      ),
    ).toThrowError(/immediate transaction/i);
    expect(() =>
      modelCallRepository?.fail(
        call?.id as string,
        "failed",
        25,
        {
          code: "TEST_FAILURE",
          message: "Test failure.",
          details: [],
        },
        "2026-01-01T00:00:03.000Z",
        {} as never,
      ),
    ).toThrowError(/immediate transaction/i);

    expect(taskRepository?.get("task-001").status).toBe("queued");
    expect(modelCallRepository?.get(call?.id as string).status).toBe(
      "requested",
    );
  });

  it("does not treat a deferred read transaction as write authorization", () => {
    initialize();
    unitOfWork?.createTask(taskInput);

    expect(() =>
      runInTransaction(
        database as ForgeFlowDatabase,
        () => createStorageWritePermit(database as ForgeFlowDatabase),
        "deferred",
      ),
    ).toThrowError(/immediate transaction/i);
  });
});
