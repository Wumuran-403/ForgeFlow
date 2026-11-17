# Phase 3 Recovery Batch R1 Report

## Scope and result

Batch R1 implements Web Pause, Resume, and Cancel controls; explicit continuation from persisted checkpoints; and SQLite-backed Web approval recovery. Batch R2 Final RecoveryReview remains closed. No public deployment or Git commit was performed.

## Changed files

- Agent continuation: `src/agent/agent-runner.ts`, `src/provider/mock-provider.ts`, `src/demo/stm32-agent-demo.ts`, `src/web/workflows.ts`.
- Persistence and control: `src/persistence/coordinator.ts`, `src/persistence/execution-bridge.ts`, `src/storage/execution-unit-of-work.ts`, `src/storage/execution-state-machine.ts`, `src/storage/task-repository.ts`.
- Web API and UI: `src/web/approvals.ts`, `src/web/task-service.ts`, `src/web/server-factory.ts`, `web/src/lib/api.ts`, `web/src/pages/workspace-page.tsx`.
- Tests and usage: `tests/web/web-api.test.ts`, `README.md`, this report.

## Behavior

- Task control requests persist state through the existing state machine under a task lease and fencing token. Resume claims a new lease and rejects pending approval, cancel intent, unresolved review, and unknown or running Write boundaries.
- Restarted tasks are read from SQLite. Pending Read recovery uses the existing `RecoveryManager`; already persisted tool replies are reused. Model calls left `requested` are marked interrupted before continuation.
- Web approval identity, request, and decision now live in SQLite. Restarted pending approvals remain visible. A decision requires the task lease; the operator must explicitly Resume after deciding an orphaned approval. Duplicate decisions are rejected, and an unapproved Write cannot start.
- Workspace exposes legal control actions and shows interrupted or manual review states. History continues to show persisted events and checkpoints.

## Verification

- `pnpm typecheck`: passed.
- `pnpm web:build`: passed.
- `pnpm vitest run tests/web/web-api.test.ts tests/integration/persistent-execution.test.ts tests/recovery/read-recovery.test.ts`: 3 files, 46 tests passed.
- `pnpm test`: 72 files, 706 tests passed.
- Web tests cover authenticated Pause/Resume, SQLite close/reopen with pending approval followed by one approved Write, cancellation of pending approval without Write, rejection, and duplicate decision rejection. Existing persistent execution and Read recovery suites passed.

## Remaining limits

- Batch R1 does not implement Unknown Write Final RecoveryReview. Such writes remain blocked for manual review; the production decision entrance is closed.
- The restart test closes and reopens SQLite after service shutdown. An abrupt OS process kill and browser-driven recovery sequence remain for Batch R3.
- Demo inventory and procurement drafts are process-local; SQLite persists execution history, not these simulated business records.
- Public HTTPS and live DeepSeek Web recovery were not run in this batch.
