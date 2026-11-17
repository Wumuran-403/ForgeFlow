# ForgeFlow

ForgeFlow is a TypeScript / Node.js agent runtime focused on resumable execution,
tool orchestration, and observable hardware engineering workflows.

> Current status: **Batch C accepted; Batch D local deployment verified; Phase 3 backend Recovery MVP accepted; Phase 4 accepted; Phase 5 accepted; Phase 6.1–6.2 accepted; Phase 6.3 anonymous Web product integration implemented**.
> ForgeFlow includes the agent and scheduler core, SQLite-backed execution,
> an offline STM32 BOM demo, a DeepSeek provider, and a Web application.
> Public HTTPS deployment awaits a server and domain. Production recovery entry
> points remain closed; remote MCP and external business
> integrations are not part of v0.1.

The R2-B Write Barrier runs in the same SQLite transaction as persistent
ToolRun admission. Persistent Agent Writes require the Scheduler, execution
bridge, and approval path. The Final RecoveryReview core remains callable only
from internal trusted code and tests. It has no Web or Host business route:
authenticated manual attestation issuance is still incomplete, so Unknown
Write final decisions remain unavailable to operators.

R3 adds abrupt-process recovery verification with independent Node.js processes
and file-backed SQLite. An unfinished Read can be reclaimed after lease expiry;
a completed Read is not repeated; an interrupted ModelCall is recorded before
continuation; and a Write that was running when its process exited is atomically
settled to immutable `unknown` with the Task in `waiting_review`. Such a Write is
never retried and its descendants remain blocked. Pending Web approvals survive
process restart and still require an explicit authenticated decision. Manual
attestation and Final RecoveryReview production routes remain deferred and
closed.

Browser-driven Recovery E2E remains pending. Authenticated Manual Attestation
and the Final RecoveryReview Host/Web decision entry remain deferred and closed;
neither item is reported as Phase 3 PASS.

## Context Management

Phase 4.1 uses one deterministic Context Manager in front of every
`LLMProvider`, so Mock and DeepSeek receive the same selected message contract.
It always retains system messages, the latest user task, and the newest complete
Assistant ToolCall / Tool Result exchange. Older history is admitted from newest
to oldest while it fits the input budget. Large Tool Results are replaced only
in the provider request by a `TRUNCATED_CONTEXT_ONLY` preview; the complete
message, ToolRun output, Event, and Checkpoint data remain unchanged in SQLite.
No summarization model call is made.

Configure the deterministic limits with:

```dotenv
LLM_CONTEXT_MAX_TOKENS=16384
LLM_CONTEXT_RESERVED_COMPLETION_TOKENS=2048
LLM_TOOL_RESULT_MAX_TOKENS=1024
```

If the system prompt, current task, tool definitions, and newest required tool
exchange cannot fit, execution stops with `context_budget_exceeded` before a new
provider request. Provider-returned token usage is stored as `provider`; missing
usage is locally estimated and stored as `estimated`. Task totals keep provider
and estimated subtotals separate and use `mixed` when both occur.

## Loop Guard

Phase 4.2 derives a SHA-256 signature from each tool name and RFC 8785-style
canonical JSON arguments. It detects three identical no-progress calls, a
two-call short cycle repeated three times, and three identical failed attempts.
Thresholds and the bounded recovery window are configurable:

```dotenv
LOOP_GUARD_REPEAT_THRESHOLD=3
LOOP_GUARD_CYCLE_REPETITIONS=3
LOOP_GUARD_FAILURE_THRESHOLD=3
LOOP_GUARD_MAX_HISTORY_ROUNDS=12
```

Persistent detection is reconstructed from SQLite plans and ToolRuns, not from
trimmed provider context. The guard runs after a model plan is persisted but
before Scheduler dispatch, approval, or any tool side effect. It atomically
skips the intact unstarted batch, records one `loop_detected` Event and
Checkpoint, and moves the Task through the legal pause transition. The Web
workspace keeps Resume disabled while that persisted cause remains unresolved;
Execution History displays the non-sensitive signature, reason, tool names,
repeat count, and threshold. Successful writes and changed read-result digests
count as observable progress. Unknown writes remain governed by Phase 3 and are
never retried.

## Task Token Budget

Phase 4.3 adds a cumulative per-task Token budget persisted in SQLite. Web tasks
default to the following configurable limit:

```dotenv
WEB_DEFAULT_TOKEN_BUDGET=50000
```

Every completed ModelCall keeps its own `provider` or `estimated` Usage source.
Task aggregation preserves separate Provider and Estimated totals instead of
presenting estimates as billed Provider usage. Before each new model request,
the Agent builds the actual ContextManager request and evaluates
`persistedUsage + estimatedNextPromptTokens + reservedCompletionTokens`. When
that projection exceeds the Task limit, ForgeFlow sends no further Provider request and atomically records a
`token_budget_exhausted` Event, a Checkpoint, and a legal paused state under the
current validated Lease/Fencing ownership. Each historical call with
indeterminate usage is conservatively budgeted as one full context rather than
treated as free. Restart and Resume cannot reset or bypass that budget boundary. A final response that needs no
subsequent model request remains a valid completion. The reserve is a preflight
guard, not an absolute billing cap: actual completion usage can still differ
from the estimate.

Dashboard, Agent Workspace, and Execution History show real aggregate totals,
Provider/Estimated breakdowns, remaining Task budget, and persisted Loop Guard
or Token Budget stops. Loop Guard and budget-paused tasks keep Cancel available,
while Resume remains disabled until a future authorized resolution workflow is
implemented.

Phase 6.3 keeps these Task-level limits and adds a persistent global model budget
at the Provider dispatch boundary. Anonymous Guest sessions do not weaken the
Task budget, Loop Guard, approval, or Recovery controls.

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

## STM32 BOM Demo

Run the deterministic offline walkthrough:

```bash
pnpm demo:mock --auto-approve
```

Run it with a real DeepSeek model after setting `LLM_API_KEY` (and optionally
`LLM_MODEL` / `LLM_BASE_URL`) in the environment or `.env`:

```bash
pnpm demo:deepseek
```

The demo reads the bundled STM32F103C8T6 BOM for a 2,000-board build, checks
simulated inventory, identifies shortages, asks for approval before creating a
local procurement draft, then re-reads the draft state. Use `--reject` to verify
that rejection creates no draft. No real inventory or procurement system is
contacted.

The BOM, inventory, and procurement drafts are in-memory demo data. SQLite
persists Agent execution state such as model calls, plans, ToolRuns, events, and
checkpoints. Approval is enforced by WriteExecutor before execution; SQLite does
not make the simulated inventory or procurement records durable business data.

Verified in the portfolio MVP:

- Mock mode completes the full BOM, inventory, approval, write, and readback flow offline.
- DeepSeek Provider request/response and tool-calling contracts are covered by tests.
- Real DeepSeek `deepseek-chat` smoke testing passed with BOM, inventory, approval, write, and readback tool calls.

Not implemented or verified in v0.1: real inventory/ERP/procurement integration,
streaming, remote HTTP MCP, public HTTPS deployment, and production recovery
entry points.

## Local MCP Demo

Phase 5.1 uses the official split MCP TypeScript SDK v2 packages and a real
stdio child process. The deterministic server exposes `inventory.search`; the
ForgeFlow adapter initializes the server, discovers its JSON Schema, maps it to
the namespaced internal tool `mcp_inventory_inventory_search`, and validates
arguments again through the existing ToolRegistry.

Run the standalone server (it waits for an MCP host on stdin/stdout):

```bash
pnpm mcp:demo
```

The executable path, arguments, namespace, and Read/Write policy come only from
the server-side `createInventoryDemoMcpConfig()` allowlist. No Web input can add
an MCP command or URL. MCP security annotations never grant Write access; a
trusted Write mapping still passes through Scheduler approval, the SQLite
Multi-Write Barrier, Lease/Fencing, ToolRun, Event, and Checkpoint flow. Child
processes receive a minimal environment without API keys, results are restricted
to validated text/JSON and a configured byte limit, and timeout, cancellation,
disconnect, and `isError` remain failures. Remote HTTP MCP, OAuth, marketplace
discovery, and arbitrary user-configured servers are outside Phase 5.1.

## Evaluation and Metrics

Phase 6.1 adds a versioned 30-case deterministic suite covering normal tools,
invalid input, inventory shortage, specification/tool errors, Loop Guard,
recovery classification, and one real local stdio MCP execution. Every run has
an independent ID and persists its case observations, verdicts, failure reasons,
metric numerators/denominators, provider/config identity, and aggregate report in
SQLite migration v11. Evaluation tools use fresh deterministic demo state and do
not write ordinary user tasks or shared demo data.

Run the suite against a dedicated local database:

```bash
pnpm eval:phase6 -- data/evaluation.db
```

Metrics distinguish Provider-reported tokens from local estimates. Unknown
Writes never count as successful recovery. A zero denominator is reported as a
zero-valued metric with its denominator retained, rather than an invented rate.
The authenticated backend exposes persisted task/tool status, latency, Loop
Guard, recovery, MCP and evaluation aggregates through the API routes below.

Phase 6.2 renders those aggregates in the Dashboard with explicit
Provider-versus-estimated token accounting and `N/A` for ratios whose
denominator is zero. The Evaluation Center can reconstruct historical reports
from SQLite or run only the fixed server-owned suite; simultaneous runs are
rejected and starts are rate limited per actor. Evaluation records contain
suite observations rather than private Web task content.

Agent Workspace also exposes the fixed `STM32 MCP Inventory Audit` workflow.
The server—not the browser—starts the allowlisted local stdio process, maps its
tool through ToolRegistry, and executes it through the existing Scheduler,
ToolRun, Event, and Checkpoint path. The UI provides no MCP URL, command,
executable path, or process-argument input.

## Web Application

The portfolio web application exposes the real Agent runtime through a
same-origin Node.js API, with SQLite-backed task state and polling progress.

Configure at least:

```dotenv
WEB_SESSION_SECRET=choose-at-least-32-random-characters
```

Start the API and Vite development server together:

```bash
pnpm dev:web
```

Open `http://127.0.0.1:5174`. ForgeFlow creates a signed anonymous Guest
session automatically and opens the Dashboard without registration or login.
The visitor-facing Web interface is presented in Simplified Chinese; tool names,
event IDs, and structured audit JSON keep their original technical identifiers.
For the STM32 BOM procurement demo, Workspace and Execution History put a
human-readable shortage and procurement outcome above the technical audit tabs.
The summary is derived from persisted ToolRuns, and an unknown write remains
explicitly unconfirmed. The local simulated procurement draft itself is
in-memory demo data and may not survive a server restart.
For this demo, the raw Mock final answer is secondary and expandable because
context trimming can omit earlier tool results; the business summary uses the
complete persisted ToolRuns instead.

Build and run the production bundle:

```bash
pnpm web:build
pnpm web:start
```

Open `http://127.0.0.1:8787`. Use `WEB_HOST=0.0.0.0` behind a future container
or reverse-proxy deployment, and enable `WEB_SECURE_COOKIES=true` for HTTPS.

The web API uses:

- `GET /api/dashboard`
- `GET /api/workflows`
- `GET|POST /api/tasks`
- `GET /api/tasks/:id`
- `GET /api/tasks/:id/events`
- `POST /api/tasks/:id/pause`
- `POST /api/tasks/:id/resume`
- `POST /api/tasks/:id/cancel`
- `GET /api/approvals`
- `POST /api/approvals/:id/approve`
- `POST /api/approvals/:id/reject`
- `GET /api/metrics/summary`
- `POST /api/evals/run`
- `GET /api/evals`
- `GET /api/evals/:id`

The server creates a cryptographically random Guest identity and signs it in an
HttpOnly, SameSite=Strict session cookie. The browser cannot choose its actor
identity. Task, approval, control, and history operations remain scoped to that
Guest on the server. Production HTTPS uses Secure cookies, and state-changing
requests still require the configured exact Origin. The DeepSeek API key remains
server-side and is never sent to the browser.

Approval decisions are enforced by the backend and block `WriteExecutor` until
the operator responds. Pending approvals and their decisions are stored in SQLite.
After restart, the operator can decide a pending approval, then explicitly resume
the task. Paused and interrupted tasks can also be resumed when recovery checks
permit it. Unknown writes stay blocked for manual review. SQLite persists Agent
execution state, while BOM, inventory, and procurement draft data remain
in-memory demo data.

Verified in Batch C acceptance: production frontend build, API authentication, task
creation, polling after refresh, backend approval, rejection, execution history,
and a browser-driven Mock workflow. Public HTTPS deployment is not yet verified
and belongs to Batch D.

### Deployment Preconfiguration

Batch D provides a Docker Compose deployment with Caddy as the only public
service. Set a DNS A/AAAA record for the server, allow inbound ports 80 and 443,
and copy `deploy.env.example` to the gitignored `deploy.env`. Replace the domain
and session secret with private values. Keep this file readable only
by the deployment operator.

```bash
docker compose --env-file deploy.env up -d --build
docker compose --env-file deploy.env ps
```

Open `https://<FORGEFLOW_DOMAIN>`. Caddy obtains and renews the HTTPS certificate.
The Node API is reachable only on the Compose network. Production config requires
an exact HTTPS `WEB_PUBLIC_ORIGIN`, secure session cookies, and a matching Origin
on write requests. Cookies are also HttpOnly and SameSite=Strict. The session
secret and optional DeepSeek key are injected through Compose
environment variables and never built into the image. The API logs only request
ID, method, status, and duration; it omits headers, bodies, and query strings.

The `forgeflow_data` volume contains `/app/data/forgeflow.db` and the reserved
`/app/data/evidence` directory. The Web demo currently writes no evidence files;
its BOM, inventory, and procurement drafts are in-memory. SQLite stores task
history. After a server restart, an unfinished Web task is displayed as
**Interrupted · review needed**. A pending approval remains queryable and can
be decided after the old lease is released or expires. Resuming is explicit;
the server never treats a lost approval as granted or retries an unknown write.

Make a consistent SQLite backup while the service is running, then copy it off
the server. Back up any evidence files from the same point in time if this
directory is used by a future workflow:

```bash
docker compose --env-file deploy.env exec -T web node scripts/backup-sqlite.mjs /app/data/forgeflow.db /app/data/backups/forgeflow.db
docker compose --env-file deploy.env cp web:/app/data/backups/forgeflow.db ./forgeflow-backup.db
docker compose --env-file deploy.env cp web:/app/data/evidence ./evidence-backup
```

To restore a backup already placed at `/app/data/backups/forgeflow.db` in the
volume, stop Web first, replace the database while no process has it open, then
start Web. Restore matching evidence files before starting if applicable:

```bash
docker compose --env-file deploy.env stop web
docker compose --env-file deploy.env run --no-deps --rm --entrypoint sh web -c 'cp /app/data/backups/forgeflow.db /app/data/forgeflow.db && rm -f /app/data/forgeflow.db-wal /app/data/forgeflow.db-shm'
docker compose --env-file deploy.env up -d web
```

For a public DeepSeek demo, set `LLM_PROVIDER=deepseek`,
`WEB_ALLOW_PAID_PROVIDER=true`, `LLM_API_KEY`, and a positive
`WEB_GLOBAL_MODEL_TOKEN_BUDGET_PER_DAY` in `deploy.env`. Guest task frequency,
active-task, daily paid-task, model-turn, tool-call, and Task token limits remain
in force. Global Provider concurrency is checked before dispatch. Daily global
usage and in-flight reservations are stored in SQLite, so a new Guest cookie or
service restart cannot reset the site-wide budget. Provider usage is settled as
actual when reported; Estimated or Unknown usage is charged conservatively and
never presented as billed Provider usage. Guest-session issuance has an
auxiliary per-network-source rate limit. Public Evaluation execution is disabled
by default and its fixed reports remain readable. Public deployment and real
DeepSeek Web E2E require separate live verification.

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
