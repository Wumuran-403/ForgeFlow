# Phase 3 Recovery Batch R3 Report

## Result

R3 completes the automatic recovery backend and its real-process SQLite test
coverage. A killed running Write now converges in one controlled transaction to
an immutable `unknown` ToolRun, a `waiting_review` PlanStep and Task, a pending
RecoveryReview, audit Events, and a Checkpoint. It is not retried and later
Writes remain blocked. **Final Decision Production Entry remains Closed.** R2-C
manual attestation, Host Final Decision routing, Web decision controls, and the
automatic Host Verifier remain deferred.

The backend Recovery MVP is complete. The overall browser-driven R3 acceptance
is not claimed as fully verified because this run's Codex Work environment had
local browser control disabled. The React application and API started normally,
the production frontend built successfully, and the real Web API recovery flows
passed, but no Browser UI result is reported as PASS.

## Changed files

- `src/storage/execution-unit-of-work.ts`: added the atomic, lease/fencing-owned
  running-Write-to-Unknown recovery transaction.
- `src/recovery/recovery-manager.ts`: performs safe running Write convergence
  before classifying an expired task, then releases the inspection lease.
- `tests/integration/recovery-process-worker.ts`: independent Node.js worker for
  abrupt Read, Write, terminal, Web, and lease-race scenarios.
- `tests/integration/recovery-process.test.ts`: real file-backed SQLite process,
  restart, Web API, rollback, duplicate-operation, and fencing tests.
- `README.md`: records the R3 automatic recovery behavior and deferred manual
  review boundary.
- `docs/PHASE3_RECOVERY_BATCH_R3_REPORT.md`: this report.

No dependency or schema migration was added.

## Real process interruption

The tests fork separate Node.js processes with `tsx`, use a real SQLite file,
wait until the selected execution boundary, and terminate the worker with
`SIGKILL` before reopening the database in a new process context.

- Running Read: the persisted intent remains `running`; after simulated lease
  expiry a new owner requeues and executes it once, records
  `recovery.read_retried`, and the Task completes.
- Completed Read followed by an interrupted ModelCall: the Read result remains
  persisted and is not executed again; the requested ModelCall is settled as
  `interrupted` before continuation.
- Waiting approval: after the Web process is killed, the pending approval is
  still queryable. It is never auto-approved; one approval succeeds, a duplicate
  returns 409, and concurrent duplicate Resume calls yield one success and one
  409 without a second Write side effect.
- Running Write: recovery produces `unknown` plus `waiting_review`, leaves the
  second Write queued, creates one review, and rejects continuation. The original
  Unknown ToolRun remains unchanged.
- Terminal Task: restart cannot acquire a new Task lease or execute again.

The demo's BOM, inventory, and procurement state remains in memory. Persisted
execution records do not claim that an external business side effect was
restored or confirmed.

## Pause, Resume, Cancel, and Web API

The real Web API test creates a Task, pauses it while its ModelCall is active,
kills the service process, starts a new service on the same SQLite file, and
resumes to terminal completion. A second live Task is cancelled while active;
it reaches `cancelled`, starts no tool call, and rejects Resume with 409. Existing
Web API regression coverage verifies task progress, event/checkpoint history,
approval, rejection, and authentication. The `waiting_review` UI source keeps
Resume unavailable and displays that manual review is required without exposing
a Final Decision button; this run did not claim browser visual verification.

## Concurrency and failure safety

- Two independent Node.js processes race for one Task lease; exactly one claims
  it and the other is rejected.
- An SQLite trigger forces RecoveryReview insertion failure; the entire Unknown
  convergence rolls back, leaving Task and ToolRun `running` with no partial
  review. Removing the trigger allows the complete transaction to commit.
- The pre-restart lease/fencing token cannot write after takeover.
- Duplicate approval, concurrent duplicate Resume, terminal Resume, and Unknown
  continuation do not create duplicate tool side effects.
- R2-B Write Barrier regression tests pass after restart-related changes.

## Commands and results

- `pnpm exec vitest run tests/integration/recovery-process.test.ts --reporter=verbose`:
  1 file, 7 tests passed.
- Recovery/Web targeted command covering `tests/recovery`, persistent execution,
  Web API, Host auth, and the process suite: 19 files, 231 tests passed.
- `pnpm typecheck`: passed.
- `pnpm web:build`: passed; 2,077 modules transformed.
- `pnpm test`: 77 files, 742 tests passed.
- `git -c core.safecrlf=false diff --check`: passed with no output.

No real DeepSeek call was made. No Git Commit was created.

## Deferred and unverified

- Browser-driven Web Recovery E2E is unverified in this run because local browser
  control was disabled by the host Work setting. It must be rerun in a browser-
  enabled environment before overall R3 acceptance is recorded as fully PASS.
- Authenticated Manual Attestation issuance, human Verification workflow, Host
  Final Decision route, Web Final RecoveryReview controls, and full automatic
  Host Verifier integration remain in the Deferred Backlog.
- Phase 4-6 and public deployment were not started.

**Recovery MVP status:** backend automatic recovery is complete and regression-
clean; overall R3 is an acceptance candidate with Browser UI E2E outstanding.
