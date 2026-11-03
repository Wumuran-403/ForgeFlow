# ForgeFlow

ForgeFlow is a TypeScript / Node.js agent runtime focused on resumable execution,
tool orchestration, and observable hardware engineering workflows.

> Current status: **Phase 0 only**. The project currently provides the engineering
> baseline, validated configuration, a minimal provider contract, and a local Mock
> provider. Agent execution, persistence, MCP, and evaluation are not implemented yet.

## Requirements

- Node.js 22.12 or newer (Node.js 24 LTS recommended)
- pnpm 11 or newer

## Start

```bash
pnpm install
pnpm dev
```

The default Mock mode does not need an API key. `pnpm dev` starts the Phase 0
health-check CLI in watch mode.

To customize local settings, create `.env` from `.env.example`. Do not commit
`.env` or place credentials in source files.

## Verification

```bash
pnpm test
pnpm typecheck
```

## Phase 0 Scope

- TypeScript strict mode and Node.js ESM
- Zod-based environment validation
- Minimal `LLMProvider` contract and deterministic `MockLLMProvider`
- Structured application errors without internal stack or secret exposure
- Vitest unit tests and a local health-check CLI
- Project-level development, security, and documentation conventions in `AGENTS.md`

The authoritative project requirements are in
[`docs/PROJECT_SPEC.md`](docs/PROJECT_SPEC.md).
