# Phase 4.1 Context Manager Development Report

## Result

Phase 4.1 implements a deterministic Context Manager shared by Mock and
DeepSeek execution through `AgentRunner`. It makes no additional summarization
model calls. Provider requests are bounded before dispatch; SQLite messages,
ToolRun outputs, Events, Checkpoints, and recovery evidence remain unchanged.

Phase 3 remains accepted at the backend Recovery MVP boundary. Browser-driven
Recovery E2E is still Pending. Authenticated Manual Attestation and the Final
RecoveryReview Host/Web decision entry remain Deferred and Closed.

## Changed files

- Context construction and usage accounting: `src/context/context-manager.ts`,
  `src/context/token-usage.ts`, `src/context/index.ts`.
- Runtime integration: `src/agent/agent-runner.ts`, `src/agent/types.ts`,
  `src/persistence/coordinator.ts`, `src/web/task-service.ts`,
  `src/web/server.ts`.
- Provider and persisted usage contracts: `src/provider/types.ts`,
  `src/provider/mock-provider.ts`, `src/provider/deepseek-provider.ts`,
  `src/storage/types.ts`, `src/storage/task-repository.ts`,
  `src/storage/execution-unit-of-work.ts`, `web/src/lib/types.ts`.
- Configuration and documentation: `.env.example`, `compose.yaml`,
  `deploy.env.example`, `README.md`, and this report.
- Tests: `tests/context/context-manager.test.ts`,
  `tests/integration/context-persistence.test.ts`,
  `tests/integration/recovery-process.test.ts`,
  `tests/provider/deepseek-provider.test.ts`, `tests/unit/config.test.ts`.

No dependency or SQLite schema migration was added.

## Interface and processing point

`ContextManager.build()` receives the provider-independent model, messages, and
tool definitions and returns the exact `ModelRequest` plus budget diagnostics.
`AgentRunner` calls it immediately before `beginModelCall()` and
`LLMProvider.generate()`. Consequently the persisted ModelCall request is the
actual bounded request sent to either provider, while the canonical task message
history remains complete.

Production Web configuration injects one Context Manager through
`WebTaskService -> PersistenceCoordinator -> AgentRunner`. Direct AgentRunner
and demo compositions use the same deterministic defaults unless a manager or
options are supplied explicitly.

## Budget and trimming policy

- Input budget is `maxContextTokens - reservedCompletionTokens`.
- All system messages and the latest user task are mandatory.
- The newest Assistant ToolCall plus its Tool Results is selected as one atomic
  unit. Tool messages are never selected without their Assistant ToolCall.
- Older atomic exchanges and ordinary messages are selected newest-first while
  they fit.
- Tool Result content above `maxToolResultTokens` becomes a deterministic
  `TRUNCATED_CONTEXT_ONLY` preview containing safe identity/status fields and an
  explicit reference to the persisted complete ToolRun result.
- If mandatory content and tool definitions cannot fit, execution returns
  `limit_reached / context_budget_exceeded` before invoking the provider. No
  repeated compression or model-call loop is started.

Defaults are 16,384 maximum context tokens, 2,048 reserved completion tokens,
and 1,024 tokens per Tool Result preview. The estimator is deliberately local
and deterministic (`ceil(serialized characters / 4)`); it is a budget heuristic,
not claimed as provider billing usage.

## Token usage

Each completed ModelCall keeps its own `ModelUsage.source`:

- Provider-returned counts remain `provider`; a missing total is derived only
  when provider prompt and completion counts are both present.
- Missing or count-less usage is estimated locally and stored as `estimated`.
- DeepSeek no longer labels an absent usage object as provider usage.

Task aggregation is recomputed from persisted completed ModelCalls after every
response. It exposes combined totals, separate provider and estimated subtotals,
call counts, and `source: mixed` when both sources occur. Estimated counts are
therefore never presented as actual provider consumption.

## Recovery compatibility

The Context Manager operates on a copy of loaded messages. The persistent
integration test proves that a large Tool Result remains complete in both the
message table and ToolRun output while only the next ModelCall request contains
the preview. The real-process recovery test resumes after a completed Read and
verifies that the rebuilt request still contains the original Assistant
ToolCall and matching Tool Result without re-executing the Read. Existing
Unknown Write, approval, Lease/Fencing, and checkpoint tests remain unchanged.

## Verification

- Context, provider, Agent, persistent execution, and real-process recovery
  targeted run: 9 files, 77 tests passed.
- `pnpm test`: 79 files, 752 tests passed.
- `pnpm typecheck`: passed.
- `pnpm web:build`: passed; 2,077 modules transformed.
- `git -c core.safecrlf=false diff --check`: passed with no output.

No real DeepSeek request was made. No Git Commit was created.

## Deferred

- Phase 4.2 Loop Guard and repeated-call/cycle policies were not started.
- Phase 4.3 was not authorized or defined for implementation in this batch and
  was not started.
- Any later model-generated historical summary or more accurate provider-
  specific tokenizer integration is outside Phase 4.1.
- Phase 5 MCP, Phase 6 evaluation/observability expansion, and public deployment
  were not started.
