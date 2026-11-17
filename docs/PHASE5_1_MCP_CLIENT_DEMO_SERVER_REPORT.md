# Phase 5.1 MCP Client + Local Demo Server Report

## 结论

Phase 4.3 Preflight Budget 补丁与 Phase 5.1 已完成。ForgeFlow 现在能通过官方
MCP TypeScript SDK v2 启动真实本地 stdio 子进程、完成 initialize、发现并映射
工具，再由现有 Agent / ToolRegistry / Scheduler / SQLite 执行链调用。未开始
Phase 6、远程 MCP 或公网部署，未修改登录架构，未创建 Git Commit。

## Phase 4.3 Preflight Budget 补丁

- ContextManager 先构建实际 Provider 请求；Runner 使用其
  `estimatedPromptTokens` 与 `reservedCompletionTokens`。
- 在有效 ExecutionAuthority、Lease 与 Fencing 下读取 SQLite 累计 Usage。
- 当 `persistedUsage + estimatedNextPromptTokens + reservedCompletionTokens >
  maxTokens` 时，不创建 ModelCall、不调用 Provider，并复用合法的
  `token_budget_exhausted` Event / Checkpoint / paused 事务。
- 历史 Unknown Usage 不按零处理：每个未计量调用按一个完整
  `maxContextTokens` 加入预算投影，但不篡改 Provider / Estimated 统计口径。
- 该检查是保守 preflight，不承诺绝对计费硬上限；Provider 实际 completion
  用量仍可能偏离 reserve。

## MCP SDK 与实现

- 实际安装：`@modelcontextprotocol/client@2.4.0`、
  `@modelcontextprotocol/server@2.4.0`；Node 要求 `>=20`，项目为 `>=22.12`；
  现有 Zod `4.6.7` 用作 Standard Schema 与内部校验。
- `McpStdioClientAdapter` 使用 v2 的 `Client` 和 `StdioClientTransport`，支持
  initialize、分页 Tools List、Tool Call、timeout、Abort、断连处理和 close。
- MCP JSON Schema 经 `z.fromJSONSchema` 映射，输入仍由 ForgeFlow
  ToolRegistry 校验；结果只接受受限 text / JSON，执行 canonical JSON 与字节
  上限检查。`isError`、非法结构、超限、timeout、cancel 和断连均保持失败。
- Demo Server 使用 `serveStdio`，真实暴露 `inventory.search`，对确定性 STM32
  库存执行结构化筛选；错误参数在工具执行前被 Schema 拒绝。

## ToolRegistry / Scheduler 安全接入

- `inventory.search` 映射为 `mcp_inventory_inventory_search`，避免覆盖内置工具。
- 只有服务端静态 allowlist 中的工具会注册；调用端不能指定命令、参数列表、
  可执行路径或远程 URL。子进程不继承 API Key，只获得最小运行环境。
- Read / Write 完全由可信本地 Policy 指定，不读取 MCP Server annotations 授权。
- Write Policy 强制 `requiresApproval=true`。集成测试实际通过 Scheduler approval
  和 `beginOwnedToolRunAfterWriteBarrier`，因此保留 Multi-Write Barrier、
  Lease/Fencing、ToolRun、Event 与 Checkpoint 语义。
- Agent 的真实 SQLite E2E 已验证 MCP Read 的 `tool.intent_committed`、
  `tool.succeeded`、Tool Message、ToolRun 与 Checkpoint 可追踪。

## 实际修改文件

- Budget：`src/agent/agent-runner.ts`、`src/agent/types.ts`、
  `src/persistence/execution-bridge.ts`、
  `src/storage/execution-state-machine.ts`。
- MCP：`src/mcp/client.ts`、`src/mcp/demo-config.ts`、
  `src/mcp/demo-server.ts`、`src/mcp/errors.ts`、`src/mcp/index.ts`、
  `src/mcp/registry-adapter.ts`、`src/mcp/types.ts`。
- Dependencies / commands：`package.json`、`pnpm-lock.yaml`。
- Tests：`tests/mcp/fixture-server.ts`、
  `tests/mcp/mcp-client-adapter.test.ts`、
  `tests/integration/mcp-persistent-agent.test.ts`、
  `tests/integration/token-budget-persistence.test.ts`、
  `tests/unit/agent-loop.test.ts`。
- Docs：`README.md`、`docs/PHASE4_3_BUDGET_WEB_INTEGRATION_REPORT.md`、本报告。

## 实际验证

- MCP Client / Registry / persistent Agent 定向测试：2 files / 5 tests passed。
- Budget preflight + R3 real-process recovery：2 files / 10 tests passed。
- Context / Loop Guard / Scheduler / Registry / Write Barrier 定向回归：
  16 files / 140 tests passed。
- `pnpm typecheck` — passed。
- `pnpm web:build` — passed，2077 modules transformed。
- `pnpm test` — 84 files / 771 tests passed。
- `pnpm audit --prod` — no known vulnerabilities。
- `git -c core.safecrlf=false diff --check` — passed。

未调用真实 DeepSeek API。第一次全量并行运行暴露了 Unknown Usage 过度阻断
R3 Resume 的问题；修正为完整 context 保守预留后，R3 定向测试与标准全量命令
均通过。报告只采用修正后的最终成功结果。

## 已知限制与 Phase 5 后续

- 本批次只支持静态配置的本地 stdio Server；远程 HTTP、OAuth、Marketplace、
  Resources、Prompts 和动态 Server 管理未实现。
- Phase 5.1 MCP 适配器已供服务端代码与 Agent Runtime 使用，但没有加入 Web
  用户可配置入口；匿名用户不能选择或启动 MCP Server。
- 首版结果面只接受 text 与 structured JSON；图片、音频、Resource 内容块会
  fail closed。Demo 库存仍是确定性内存数据，不是生产库存系统。
- Phase 3 Browser Recovery E2E 仍为 Pending；Manual Final RecoveryReview 与
  Host 决策入口仍为 Deferred/Closed。
