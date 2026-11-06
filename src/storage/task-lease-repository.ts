import type Database from "better-sqlite3";

import type { TaskLeaseRecord } from "./types.js";
import {
  assertStorageWritePermit,
  type StorageWritePermit,
} from "./write-boundary.js";

interface TaskLeaseRow {
  task_id: string;
  owner_id: string | null;
  lease_token: string | null;
  fencing_token: number;
  expires_at: string | null;
  heartbeat_at: string;
  released_at: string | null;
  updated_at: string;
}

function mapTaskLeaseRow(row: TaskLeaseRow): TaskLeaseRecord {
  return {
    taskId: row.task_id,
    ownerId: row.owner_id,
    leaseToken: row.lease_token,
    fencingToken: row.fencing_token,
    expiresAt: row.expires_at,
    heartbeatAt: row.heartbeat_at,
    releasedAt: row.released_at,
    updatedAt: row.updated_at,
  };
}

export interface ClaimTaskLeaseInput {
  readonly taskId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly expiresAt: string;
  readonly claimedAt: string;
}

export class TaskLeaseRepository {
  constructor(private readonly database: Database.Database) {}

  claim(
    input: ClaimTaskLeaseInput,
    permit: StorageWritePermit,
  ): TaskLeaseRecord | undefined {
    assertStorageWritePermit(this.database, permit);
    const row = this.database
      .prepare(
        `
          INSERT INTO task_leases (
            task_id, owner_id, lease_token, fencing_token,
            expires_at, heartbeat_at, released_at, updated_at
          ) VALUES (?, ?, ?, 1, ?, ?, NULL, ?)
          ON CONFLICT(task_id) DO UPDATE SET
            owner_id = excluded.owner_id,
            lease_token = excluded.lease_token,
            fencing_token = task_leases.fencing_token + 1,
            expires_at = excluded.expires_at,
            heartbeat_at = excluded.heartbeat_at,
            released_at = NULL,
            updated_at = excluded.updated_at
          WHERE task_leases.owner_id IS NULL
             OR task_leases.expires_at <= excluded.heartbeat_at
          RETURNING *
        `,
      )
      .get(
        input.taskId,
        input.ownerId,
        input.leaseToken,
        input.expiresAt,
        input.claimedAt,
        input.claimedAt,
      ) as TaskLeaseRow | undefined;
    return row === undefined ? undefined : mapTaskLeaseRow(row);
  }

  heartbeat(
    taskId: string,
    leaseToken: string,
    fencingToken: number,
    heartbeatAt: string,
    expiresAt: string,
    permit: StorageWritePermit,
  ): TaskLeaseRecord | undefined {
    assertStorageWritePermit(this.database, permit);
    const row = this.database
      .prepare(
        `
          UPDATE task_leases
          SET heartbeat_at = ?,
              expires_at = ?,
              updated_at = ?
          WHERE task_id = ?
            AND owner_id IS NOT NULL
            AND lease_token = ?
            AND fencing_token = ?
            AND expires_at > ?
          RETURNING *
        `,
      )
      .get(
        heartbeatAt,
        expiresAt,
        heartbeatAt,
        taskId,
        leaseToken,
        fencingToken,
        heartbeatAt,
      ) as TaskLeaseRow | undefined;
    return row === undefined ? undefined : mapTaskLeaseRow(row);
  }

  release(
    taskId: string,
    leaseToken: string,
    fencingToken: number,
    releasedAt: string,
    permit: StorageWritePermit,
  ): TaskLeaseRecord | undefined {
    assertStorageWritePermit(this.database, permit);
    const row = this.database
      .prepare(
        `
          UPDATE task_leases
          SET owner_id = NULL,
              lease_token = NULL,
              expires_at = NULL,
              released_at = ?,
              updated_at = ?
          WHERE task_id = ?
            AND owner_id IS NOT NULL
            AND lease_token = ?
            AND fencing_token = ?
          RETURNING *
        `,
      )
      .get(
        releasedAt,
        releasedAt,
        taskId,
        leaseToken,
        fencingToken,
      ) as TaskLeaseRow | undefined;
    return row === undefined ? undefined : mapTaskLeaseRow(row);
  }

  getByTask(taskId: string): TaskLeaseRecord | undefined {
    const row = this.database
      .prepare("SELECT * FROM task_leases WHERE task_id = ?")
      .get(taskId) as TaskLeaseRow | undefined;
    return row === undefined ? undefined : mapTaskLeaseRow(row);
  }
}
