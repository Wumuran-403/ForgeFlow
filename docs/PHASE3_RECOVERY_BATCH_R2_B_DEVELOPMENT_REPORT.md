# Phase 3 Recovery Batch R2-B Development Report

## Result

R2-B closes ordinary persistent Write admission in the tested single-process SQLite path. **Final Decision Production Entry remains Closed.** There is no Host or Web Final Decision business route. The existing authenticated Host protocol has `final_decision` and `read_replay` access, but no authenticated manual attestation issuance operation; the stored-evidence verification service records `unverified`. The R2-A `manual_attested` fixture is test-only. The generic Verification UoW now rejects direct `manual_attested` recording, and Final Decision rejects unverified manual evidence. No verification requirement was lowered.

## Changed files

- Policy and atomic admission: `src/storage/recovery-multi-write-barrier-policy.ts`, `src/storage/execution-unit-of-work.ts`, `src/persistence/execution-bridge.ts`, `src/persistence/coordinator.ts`.
- Write bypass and control convergence: `src/agent/agent-runner.ts`, `src/storage/execution-state-machine.ts`, `src/storage/recovery-reviewed-cancel-convergence.ts`, `src/storage/recovery-review-final-decision-unit-of-work.ts`, `src/storage/recovery-evidence-unit-of-work.ts`.
- Tests: `tests/storage/recovery-multi-write-barrier.test.ts`, `tests/unit/agent-runner-write-admission.test.ts`, `tests/integration/persistent-execution.test.ts`, `tests/recovery/recovery-review-final-decision.test.ts`, `tests/storage/recovery-evidence-uow.test.ts`; status text in `README.md` and this report.
- No dependency or schema migration was added.

## Write admission and bypass closure

`PersistentExecutionBridge.beforeExecute()` refreshes the persisted state and calls `beginOwnedToolRunAfterWriteBarrier()`. One `BEGIN IMMEDIATE` transaction rechecks ExecutionAuthority, lease/fencing, Task running status, ToolRun and PlanStep versions/status, Plan identity, and the Write Barrier before changing ToolRun to running and appending Event/Checkpoint. Read ToolRuns share the generic state checks and skip only the Write ordering policy. The Barrier rejects historical or earlier unresolved Unknown, earlier nonterminal/failed Write, ambiguous ordering, non-active or multiple active Agent Plans, and prematurely started later Write. A resolved-success predecessor is admitted only when the Evidence Payload Store is supplied and the R2-A resolver verifies its stored audit chain. A resolved-not-executed predecessor remains blocked. Completed Agent Plans now transition to terminal status in the result transaction, allowing the next Model Plan to be the sole active Plan.

Production call-site inventory: `WriteExecutor.execute()` is the only ordinary Write caller of `ToolRegistry.executeValidated()`; it retains approval and calls `persistence.beforeExecute()` before the tool side effect. `ReadWorkerPool.execute()` is the other `executeValidated()` caller and uses Read admission. `AgentRunner.executeToolCall()` is the only direct `registry.execute()` fallback; it now rejects Write, and persistent AgentRunner construction without a Scheduler fails closed. `PersistenceCoordinator` composes the Scheduler and Bridge; RecoveryManager's scheduler-less Bridge is used for Read recovery only. Web Task Service uses PersistenceCoordinator and the persisted approval registry. Registry standalone/Mock tests remain available. The legacy unowned `ExecutionUnitOfWork.beginToolRun()` has no production caller; it remains for existing storage fixtures and must not be wired into ordinary business execution.

## Pause, Cancel, and replay

Pause intent now blocks `waiting_review -> running`. Final Decision preserves Cancel intent and, when Cancel commits first, cancels queued descendants and converges the Task in the same decision transaction. When Decision commits first but leaves queued descendants, a subsequent Cancel through `ExecutionStateMachine` with an Evidence Payload Store verifies every Unknown settlement, cancels queued descendants, and converges the Task atomically. Original Unknown ToolRun remains `unknown`. Terminal Task rejects a new lease or decision; Terminal Replay remains read-only. Exact Replay does not append another Event or Checkpoint. Web does not supply an Evidence Payload Store because Final Decision has no Web entry; the internal reviewed-cancel path must be supplied with the store by a future trusted Host composition.

## Verification

- `pnpm typecheck`: passed.
- Targeted SQLite, AgentRunner, STM32 Mock demo, and Web API tests: passed after fixing active Plan settlement and post-approval snapshot refresh.
- `pnpm test`: 76 files, 735 tests passed.
- `git diff --check`: no whitespace errors (Git emitted Windows line-ending notices).
- Tests cover blocked waiting_review/Unknown/skipped Write, sequential competing admissions from two SQLite connections for one ToolRun, transaction rollback, stale Fencing, Scheduler-less Write, approved Write, Pause and both Cancel/Decision commit orders, terminal/replay behavior, and invalid manual Verification. No real DeepSeek call was made.

## Remaining gates

Before opening the Host Final Decision entry, implement and test authenticated Manual Attestation issuance with persisted SourceContract/Evidence/Verification binding, and complete automatic Host Verifier end-to-end validation if that role is to be enabled. R3 retains forced process-termination recovery, full browser recovery E2E, and wider process-level race/fault tests. Public deployment and Phase 4–6 were outside this batch. No Git Commit was created.
