import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import { z } from "zod";

import { decodeJson, encodeJson } from "./json-codec.js";
import type { SequenceAllocator } from "./sequences.js";
import {
  CheckpointBudgetSchema,
  CheckpointMetadataSchema,
  TaskStatusSchema,
  type CheckpointRecord,
  type TaskStatus,
} from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

const NewCheckpointInputSchema = z
  .object({
    taskId: z.string().min(1),
    reason: z.string().trim().min(1),
    taskStatus: TaskStatusSchema,
    lastMessageSequence: z.number().int().nonnegative(),
    modelIteration: z.number().int().nonnegative(),
    planVersion: z.number().int().positive().nullable().default(null),
    lastEventSequence: z.number().int().nonnegative(),
    budget: CheckpointBudgetSchema,
    metadata: CheckpointMetadataSchema.default({}),
  })
  .strict();

export type NewCheckpointInput = z.input<typeof NewCheckpointInputSchema>;

interface CheckpointRow {
  id: string;
  task_id: string;
  sequence: number;
  reason: string;
  task_status: string;
  last_message_sequence: number;
  model_iteration: number;
  plan_version: number | null;
  last_event_sequence: number;
  budget_json: string;
  metadata_json: string;
  created_at: string;
}

function mapCheckpointRow(row: CheckpointRow): CheckpointRecord {
  return {
    id: row.id,
    taskId: row.task_id,
    sequence: row.sequence,
    reason: row.reason,
    taskStatus: TaskStatusSchema.parse(row.task_status),
    lastMessageSequence: row.last_message_sequence,
    modelIteration: row.model_iteration,
    planVersion: row.plan_version,
    lastEventSequence: row.last_event_sequence,
    budget: decodeJson(
      CheckpointBudgetSchema,
      row.budget_json,
      "checkpoints.budget_json",
    ),
    metadata: decodeJson(
      CheckpointMetadataSchema,
      row.metadata_json,
      "checkpoints.metadata_json",
    ),
    createdAt: row.created_at,
  };
}

export class CheckpointStore {
  constructor(
    private readonly database: Database.Database,
    private readonly sequences: SequenceAllocator,
  ) {}

  append(
    input: NewCheckpointInput,
    now: string,
    permit: StorageWritePermit,
  ): CheckpointRecord {
    assertStorageWritePermit(this.database, permit);
    const parsed = NewCheckpointInputSchema.parse(input);
    const sequence = this.sequences.nextCheckpointSequence(parsed.taskId);
    const id = randomUUID();

    this.database
      .prepare(
        `
          INSERT INTO checkpoints (
            id, task_id, sequence, reason, task_status,
            last_message_sequence, model_iteration, plan_version,
            last_event_sequence, budget_json, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        id,
        parsed.taskId,
        sequence,
        parsed.reason,
        parsed.taskStatus,
        parsed.lastMessageSequence,
        parsed.modelIteration,
        parsed.planVersion,
        parsed.lastEventSequence,
        encodeJson(
          CheckpointBudgetSchema,
          parsed.budget,
          "checkpoints.budget_json",
        ),
        encodeJson(
          CheckpointMetadataSchema,
          parsed.metadata,
          "checkpoints.metadata_json",
        ),
        now,
      );

    return {
      id,
      taskId: parsed.taskId,
      sequence,
      reason: parsed.reason,
      taskStatus: parsed.taskStatus as TaskStatus,
      lastMessageSequence: parsed.lastMessageSequence,
      modelIteration: parsed.modelIteration,
      planVersion: parsed.planVersion,
      lastEventSequence: parsed.lastEventSequence,
      budget: parsed.budget,
      metadata: parsed.metadata,
      createdAt: now,
    };
  }

  loadLatest(taskId: string): CheckpointRecord | undefined {
    const row = this.database
      .prepare(
        `
          SELECT * FROM checkpoints
          WHERE task_id = ?
          ORDER BY sequence DESC
          LIMIT 1
        `,
      )
      .get(taskId) as CheckpointRow | undefined;
    return row === undefined ? undefined : mapCheckpointRow(row);
  }

  listByTask(taskId: string): readonly CheckpointRecord[] {
    return (
      this.database
        .prepare(
          "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY sequence",
        )
        .all(taskId) as CheckpointRow[]
    ).map(mapCheckpointRow);
  }
}
