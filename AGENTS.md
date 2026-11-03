# ForgeFlow Development Conventions

## Required Reading

Before changing the project, read:

1. `README.md`
2. `docs/PROJECT_SPEC.md`
3. `AGENTS.md`

`docs/PROJECT_SPEC.md` is the authoritative requirement baseline.

## Phased Development

- Implement only the phase explicitly requested by the user.
- Do not start the next phase until the current phase has been implemented,
  verified, and summarized.
- Keep changes inside the requested phase and avoid speculative abstractions.
- Before editing, report the expected files, interfaces, dependencies, tests, and
  risks.

Current sequence:

1. Phase 0: engineering baseline and development conventions
2. Phase 1: agent core, Mock provider, and tool-calling loop
3. Phase 2: read-parallel and write-serial scheduler
4. Phase 3: SQLite checkpoints and resume
5. Phase 4: DeepSeek provider, context management, and loop guard
6. Phase 5: MCP client and local demo server
7. Phase 6: observability, evaluation, and dashboard

## TypeScript And Architecture

- TypeScript strict mode is mandatory.
- Use Zod for untrusted configuration, API input, tool input, and persisted JSON.
- Keep provider SDK details behind the `LLMProvider` interface.
- Business logic must not depend on provider-specific response objects.
- Prefer explicit, readable interfaces over architecture-only abstraction.
- Use clear English identifiers in code. Explanations and project documentation may
  be written in Chinese.

## Testing

- Add or update tests with behavior changes.
- Run the relevant tests after each small implementation step.
- Before completing a phase, run `pnpm typecheck` and `pnpm test`.
- Never claim a test or command passed unless it was run successfully.
- Report the actual commands, outcomes, and unresolved risks.

## Security

- Read credentials only from environment variables.
- Commit `.env.example`, never `.env`, real API keys, authorization headers, or
  credential-bearing logs.
- Do not print secret values in terminal output, errors, events, or test snapshots.
- Treat MCP servers and tool output as untrusted input.
- Write tools default to approval-required. The demo must not call real business or
  production systems.

## Dependencies And Documentation

- Use pnpm and keep the lockfile committed.
- Check current official documentation before adding or upgrading an SDK.
- Do not upgrade unrelated dependencies as part of a scoped task.
- Update the README when setup, commands, configuration, or user-visible behavior
  changes.
- Record real measurements only. Do not invent token, latency, success-rate, or cost
  claims.
