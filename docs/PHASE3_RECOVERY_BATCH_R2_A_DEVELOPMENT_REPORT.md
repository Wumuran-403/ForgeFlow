# Phase 3 Recovery Batch R2-A Development Report

## Result and scope

R2-A implements an internal Final RecoveryReview decision path for an Unknown Write. The highest claim is **internal SQLite integration (L2)**. The production Final Decision entry remains **Closed**: no Web or Host business route calls this service. R2-B and R3 are not started.

## Changed files

- Authorization and identity: `src/recovery/recovery-review-final-decision-authorization.ts`, `src/recovery/recovery-review-final-decision-service.ts`.
- Settlement and read-only replay: `src/recovery/recovery-unknown-write-settlement.ts`, `src/recovery/recovery-review-terminal-replay-service.ts`.
- Atomic storage: `src/storage/recovery-review-final-decision-unit-of-work.ts`, `src/storage/recovery-review-final-convergence-capability.ts`, `src/storage/recovery-review-repository.ts`, `src/storage/execution-state-machine.ts`.
- Tests and status: `tests/recovery/recovery-review-final-authorization.test.ts`, `tests/recovery/recovery-review-final-decision.test.ts`, `README.md`, this report.

## Implemented behavior

- Final Decision and read-only Replay capabilities originate from G2 authenticated Host Context. Human Reviewer and Host Verifier roles are distinct. WeakMap-backed claims bind Task, Review, original Unknown Write, operation, decision version, payload digest, SourceContract digest, request key, actor, access, nonce, and expiry. Cloned or forged objects are rejected.
- The service computes the canonical decision digest and existing operation request key itself. The UoW checks the current lease/fencing token inside `BEGIN IMMEDIATE`, looks up the request key before version CAS, validates selected persisted Evidence and Verification, and enforces SourceContractV1 for `confirmed_not_executed`.
- One `StorageWritePermit` covers Review CAS, original PlanStep convergence, Final Decision Event, Operation, downstream ToolRun/PlanStep skip events and CAS, Plan status, Task terminal transition, and final Checkpoint. Original Unknown Write ToolRun stays `unknown`. The shared read-only resolver classifies open, resolved success, resolved not executed, and inconsistent audit state.
- Terminal Replay uses a separate `read_replay` capability and only reads SQLite and stored evidence. It neither claims a terminal lease nor writes an Event or Checkpoint.

## Verification

- `pnpm typecheck`: passed.
- Targeted Final Authorization and SQLite decision tests: 2 files, 10 tests passed.
- `pnpm test`: 74 files, 716 tests passed after the final audit-chain checks.
- `git diff --check`: no whitespace errors.
- Tests cover both final decisions, 1:N downstream skip, Task terminal results, exact replay, invalid Host capability, missing evidence, failed verification, SourceContract mismatch, decision version conflict, unchanged original ToolRun, and checkpoint-triggered full rollback.

## Remaining work and limits

- R2-B must implement Multi-Write Barrier and close ordinary Write bypasses. Until then, R2-A is not a production-safe Final Decision entrance.
- R3 retains abrupt process termination, browser recovery E2E, wider concurrency and fault injection. The automatic Host Verifier path is guarded by the existing controlled readback bindings but was not exercised end to end in this batch. The manual integration fixture creates an immutable `manual_attested` verification through internal repositories; the current stored-evidence verification service emits `unverified`, so a production manual attestation issuance flow is still required before an operator entry can open.
- No public deployment, DeepSeek call, schema migration, dependency change, or Git Commit was made.
