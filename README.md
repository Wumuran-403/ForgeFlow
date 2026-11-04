# ForgeFlow

ForgeFlow is a TypeScript / Node.js agent runtime focused on resumable execution,
tool orchestration, and observable hardware engineering workflows.

> Current status: **Phase 2 complete and integration-verified**. ForgeFlow now includes a deterministic Mock
> provider, validated Tool Registry, bounded Agent Loop, Read/Write planner,
> read worker pool, write approval/executor, timeout/cancellation handling, and
> optional TaskScheduler integration. Persistence, MCP, and evaluation are not
> implemented yet.

## Requirements

- Node.js 22.12 or newer (Node.js 24 LTS recommended)
- pnpm 11 or newer

## Start

```bash
pnpm install
pnpm dev
```

The default Mock mode does not need an API key. `pnpm dev` starts the Phase 2
health-check CLI in watch mode.

To customize local settings, create `.env` from `.env.example`. Do not commit
`.env` or place credentials in source files.

## Verification

```bash
pnpm test
pnpm typecheck
```

## Phase 2 Scope

- TypeScript strict mode and Node.js ESM
- Zod-based environment validation
- Scripted `MockLLMProvider` with multi-turn responses and independent request history
- Tool Registry with registration, lookup, removal, Zod validation, and execution
- Bounded Agent Loop with legacy sequential and optional scheduled tool execution
- Planner-driven read parallelism, write barriers, approval, timeout, and cancellation
- Draft-07 JSON Schema tool parameters generated through Zod 4
- Structured application errors without internal stack or secret exposure
- Vitest unit and integration tests plus a local health-check CLI
- Project-level development, security, and documentation conventions in `AGENTS.md`

Phase 2 intentionally does not include checkpoints, SQLite persistence, MCP,
real DeepSeek calls, context compression, or streaming.

See [`docs/PHASE2_DEVELOPMENT_REPORT.md`](docs/PHASE2_DEVELOPMENT_REPORT.md)
for the complete Phase 2 architecture, acceptance evidence, integration scenarios,
and known limitations.

The authoritative project requirements are in
[`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md).
