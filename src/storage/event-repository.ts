import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { decodeJson, encodeJson } from "./json-codec.js";
import type { SequenceAllocator } from "./sequences.js";
import {
  EventPayloadSchema,
  type EventRecord,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const NewEventInputSchema = z
  .object({
    taskId: z.string().min(1),
    traceId: z.string().min(1),
    type: z.string().trim().min(1),
    entityType: z.string().min(1).optional(),
    entityId: z.string().min(1).optional(),
    payload: EventPayloadSchema.default({}),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      (value.entityType === undefined) !==
      (value.entityId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["entityType"],
        message: "entityType and entityId must be provided together.",
      });
    }
  });

export type NewEventInput = z.input<typeof NewEventInputSchema>;

interface EventRow {
  id: string;
  task_id: string;
  sequence: number;
  trace_id: string;
  type: string;
  entity_type: string | null;
  entity_id: string | null;
  payload_json: string;
  created_at: string;
}

function mapEventRow(row: EventRow): EventRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    traceId: row.trace_id,
    type: row.type,
    entityType: row.entity_type,
    entityId: row.entity_id,
    payload: decodeJson(
      EventPayloadSchema,
      row.payload_json,
      "events.payload_json",
    ),
    createdAt: row.created_at,
  };
}

export class EventRepository {
  constructor(
    private readonly database: Database.Database,
    private readonly sequences: SequenceAllocator,
  ) {}

  append(
    input: NewEventInput,
    now: string,
    permit: StorageWritePermit,
  ): EventRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed = NewEventInputSchema.parse(input);
    const sequence = this.sequences.nextEventSequence(parsed.taskId, now);
    const id = randomUUID();

    this.database
      .prepare(
        `
          INSERT INTO events (
            id, task_id, sequence, trace_id, type,
            entity_type, entity_id, payload_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        parsed.taskId,
        sequence,
        parsed.traceId,
        parsed.type,
        parsed.entityType ?? null,
        parsed.entityId ?? null,
        encodeJson(
          EventPayloadSchema,
          parsed.payload,
          "events.payload_json",
        ),
        now,
      );

    return {
      id,
      taskId: parsed.taskId,
      sequence,
      traceId: parsed.traceId,
      type: parsed.type,
      entityType: parsed.entityType ?? null,
      entityId: parsed.entityId ?? null,
      payload: parsed.payload,
      createdAt: now,
    };
  }

  listByTask(taskId: string): readonly EventRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM events WHERE task_id = ? ORDER BY sequence",
        )
        .all(taskId) as EventRow[]
    ).map(mapEventRow);
  }
}
