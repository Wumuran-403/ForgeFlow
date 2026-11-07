import { TaskLeaseManager } from "../storage/index.js";
import { AppError } from "../shared/errors.js";

export interface LeaseHeartbeatOwnership {
  readonly taskId: string;
  readonly leaseToken: string;
  readonly fencingToken: number;
}

export class ExecutionAuthority {
  private readonly abortController = new AbortController();
  private revokedReason: unknown;

  get signal(): AbortSignal {
    return this.abortController.signal;
  }

  get failure(): unknown {
    return this.revokedReason;
  }

  get revoked(): boolean {
    return this.revokedReason !== undefined;
  }

  assertActive(): void {
    if (this.revokedReason !== undefined) {
      throw new AppError({
        code: "EXECUTION_AUTHORITY_REVOKED",
        message: "The current execution no longer has local commit authority.",
        statusCode: 409,
        details: [],
        cause: this.revokedReason,
      });
    }
  }

  revoke(error: unknown): void {
    if (this.revokedReason !== undefined) {
      return;
    }
    // Set the revocation marker before abort so listeners cannot observe an
    // aborted signal while commit authority is still considered valid.
    this.revokedReason = error;
    this.abortController.abort(error);
  }
}

export class LeaseHeartbeat {
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly manager: TaskLeaseManager,
    private readonly ownership: LeaseHeartbeatOwnership,
    private readonly intervalMs: number,
    private readonly authority: ExecutionAuthority,
  ) {}

  get signal(): AbortSignal {
    return this.authority.signal;
  }

  get failure(): unknown {
    return this.authority.failure;
  }

  start(): void {
    this.timer = setInterval(() => {
      try {
        this.manager.heartbeat(
          this.ownership.taskId,
          this.ownership.leaseToken,
          this.ownership.fencingToken,
        );
      } catch (error) {
        this.fail(error);
      }
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private fail(error: unknown): void {
    if (this.authority.revoked) {
      return;
    }
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.authority.revoke(error);
  }
}
