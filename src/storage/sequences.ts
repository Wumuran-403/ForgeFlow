import type Database from "better-sqlite3";

import { AppError } from "../shared/errors.js";
import { assertWriteTransaction } from "./transaction.js";

interface NextSequenceRow {
  next_sequence: number;
}

export class SequenceAllocator {
  constructor(private readonly database: Database.Database) {}

  nextMessageSequence(taskId: string): number {
    this.assertTransaction();
    const row = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM messages
          WHERE task_id = ?
        `,
      )
      .get(taskId) as NextSequenceRow;
    return row.next_sequence;
  }

  nextCheckpointSequence(taskId: string): number {
    this.assertTransaction();
    const row = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence
          FROM checkpoints
          WHERE task_id = ?
        `,
      )
      .get(taskId) as NextSequenceRow;
    return row.next_sequence;
  }

  nextEventSequence(taskId: string, updatedAt: string): number {
    this.assertTransaction();
    const row = this.database
      .prepare(
        `
          UPDATE tasks
          SET last_event_sequence = last_event_sequence + 1,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
          RETURNING last_event_sequence AS next_sequence
        `,
      )
      .get(updatedAt, taskId) as NextSequenceRow | undefined;

    if (row === undefined) {
      throw new AppError({
        code: "TASK_NOT_FOUND",
        message: "Task was not found while allocating an event sequence.",
        statusCode: 404,
        details: [],
      });
    }

    return row.next_sequence;
  }

  nextModelCallAttempt(taskId: string, iteration: number): number {
    this.assertTransaction();
    const row = this.database
      .prepare(
        `
          SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_sequence
          FROM model_calls
          WHERE task_id = ? AND iteration = ?
        `,
      )
      .get(taskId, iteration) as NextSequenceRow;
    return row.next_sequence;
  }

  private assertTransaction(): void {
    assertWriteTransaction(this.database);
  }
}
