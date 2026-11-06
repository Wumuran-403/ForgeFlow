import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import { MessageToolCallsSchema, type MessageRecord } from "./types.js";
import { decodeJson, encodeJson } from "./json-codec.js";
import type { SequenceAllocator } from "./sequences.js";
import {
  MessageRoleSchema,
  NewMessageInputSchema,
  type NewMessageInput,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface MessageRow {
  id: string;
  task_id: string;
  sequence: number;
  role: string;
  content: string;
  tool_call_id: string | null;
  tool_calls_json: string | null;
  created_at: string;
}

function mapMessageRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    role: MessageRoleSchema.parse(row.role),
    content: row.content,
    toolCallId: row.tool_call_id,
    toolCalls:
      row.tool_calls_json === null
        ? null
        : decodeJson(
            MessageToolCallsSchema,
            row.tool_calls_json,
            "messages.tool_calls_json",
          ),
    createdAt: row.created_at,
  };
}

export class MessageRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly sequences: SequenceAllocator,
  ) {}

  append(
    input: NewMessageInput,
    now: string,
    permit: StorageWritePermit,
  ): MessageRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed = NewMessageInputSchema.parse(input);
    const sequence = this.sequences.nextMessageSequence(parsed.taskId);
    const id = randomUUID();

    this.database
      .prepare(
        `
          INSERT INTO messages (
            id, task_id, sequence, role, content,
            tool_call_id, tool_calls_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        parsed.taskId,
        sequence,
        parsed.role,
        parsed.content,
        parsed.toolCallId ?? null,
        parsed.toolCalls === undefined
          ? null
          : encodeJson(
              MessageToolCallsSchema,
              parsed.toolCalls,
              "messages.tool_calls_json",
            ),
        now,
      );

    return {
      id,
      taskId: parsed.taskId,
      sequence,
      role: parsed.role,
      content: parsed.content,
      toolCallId: parsed.toolCallId ?? null,
      toolCalls: parsed.toolCalls ?? null,
      createdAt: now,
    };
  }

  listByTask(taskId: string): readonly MessageRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM messages WHERE task_id = ? ORDER BY sequence",
        )
        .all(taskId) as MessageRow[]
    ).map(mapMessageRow);
  }
}
