import type Database from "better-sqlite3";

import { TaskStatusSchema } from "../storage/index.js";
import type {
  RecoveryCandidate,
  RecoveryLeaseState,
} from "./recovery-types.js";

interface CandidateRow {
  id: string;
  trace_id: string;
  status: string;
  owner_id: string | null;
  expires_at: string | null;
  released_at: string | null;
  fencing_token: number | null;
}

export interface RecoveryScannerOptions {
  readonly now?: () => Date;
}

export class RecoveryScanner {
  private readonly now: () => Date;

  constructor(
    private readonly database: Database.Database,
    options: RecoveryScannerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  scan(): readonly RecoveryCandidate[] {
    const now = this.now().toISOString();
    const rows = this.database
      .prepare(
        `
          SELECT
            task.id,
            task.trace_id,
            task.status,
            lease.owner_id,
            lease.expires_at,
            lease.released_at,
            lease.fencing_token
          FROM tasks AS task
          LEFT JOIN task_leases AS lease
            ON lease.task_id = task.id
          WHERE task.status NOT IN ('completed', 'failed', 'cancelled')
            AND (
              lease.task_id IS NULL
              OR lease.owner_id IS NULL
              OR lease.expires_at <= ?
            )
          ORDER BY task.created_at, task.id
        `,
      )
      .all(now) as CandidateRow[];

    return rows.map((row) => ({
      taskId: row.id,
      status: TaskStatusSchema.parse(row.status),
      traceId: row.trace_id,
      leaseState: resolveLeaseState({
        ownerId: row.owner_id,
        expiresAt: row.expires_at,
        releasedAt: row.released_at,
        now,
      }),
      fencingToken: row.fencing_token,
    }));
  }
}

function resolveLeaseState(input: {
  readonly ownerId: string | null;
  readonly expiresAt: string | null;
  readonly releasedAt: string | null;
  readonly now: string;
}): RecoveryLeaseState {
  if (input.ownerId === null) {
    return input.releasedAt === null ? "missing" : "released";
  }
  return input.expiresAt !== null && input.expiresAt <= input.now
    ? "expired"
    : "expired";
}
