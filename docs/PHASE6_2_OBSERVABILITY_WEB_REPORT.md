# Phase 6.2 Observability Web Report

## 结论

Phase 6.2 已完成。现有登录、Actor Isolation、Write Approval、Multi-Write
Barrier、Token Budget、Host Authentication 与 Final RecoveryReview Closed
状态未改变。未进入 Phase 6.3，未部署公网服务。

## 实际修改文件

- 后端：`src/observability/metrics-service.ts`、`src/web/server-factory.ts`、
  `src/web/task-service.ts`、`src/web/workflows.ts`。
- Web：`web/src/app.tsx`、`web/src/components/layout.tsx`、
  `web/src/lib/api.ts`、`web/src/lib/format.ts`、`web/src/lib/types.ts`、
  `web/src/pages/dashboard-page.tsx`、`web/src/pages/evaluation-page.tsx`、
  `web/src/pages/history-page.tsx`、`web/src/pages/workspace-page.tsx`。
- 测试：`tests/observability/metrics-service.test.ts`、
  `tests/web/web-api.test.ts`、`tests/web/web-format.test.ts`。
- 文档：`README.md`、本报告。

## Dashboard

- Dashboard 从 `/api/metrics/summary` 读取真实 SQLite 聚合数据，展示 Task
  状态、Task/Tool/MCP 成功率、Provider/Estimated Token、平均/P50/P95 延迟、
  Loop Guard 原因、Recovery 结果与最近任务。
- Task、Tool、Recovery 与 MCP 比率保留分子/分母；分母为零时 Web 显示
  `N/A`。
- 普通 Task 聚合仍按认证 Actor 过滤；Unknown Write 不计入成功恢复。

## Evaluation Center

- 新增独立 Evaluation Center，可从 SQLite 查询历史 Run、聚合指标和 30 个
  Case 的结构化结果/失败原因。
- 明确显示 Suite 版本、Run ID、时间、Provider/Executor、确定性或模型来源、
  Provider/Estimated Token 与延迟指标。确定性 30/30 不表述为真实模型成功率。
- “Run preset suite” 只调用服务端固定 `EvaluationRunner`，不接收脚本、MCP
  地址或进程参数。服务端同一时刻只允许一个 Run；每 Actor 每分钟最多启动
  3 次。
- Evaluation 结果只包含固定 Suite 的公开评测记录，不关联或返回普通用户的
  Task 内容。自动化测试同时验证普通 Task 指标的 Actor 隔离。

## MCP Web Workflow

- 新增固定 `STM32 MCP Inventory Audit` 工作流。Web 只能选择该 preset，不能
  指定 MCP URL、命令、可执行文件路径或启动参数。
- 后端从静态 allowlist 创建 `McpStdioClientAdapter`，完成 Initialize、Tools
  List 与 Tool Call，并在任务结束或失败时关闭子进程连接。
- MCP 工具映射到现有 ToolRegistry，并经过 AgentRunner、Scheduler、ToolRun、
  Event、Checkpoint 与 Token/Loop Guard 路径。Web 展示工具名、状态、输入、
  有界结果以及 allowlist/schema/output 安全提示。
- 非法附加 MCP 配置被 Zod API Schema 拒绝；MCP Adapter 的 timeout、abort、
  disconnect 与 `isError` 测试继续通过。

## API 与数据隔离

- 复用 `GET /api/metrics/summary`、`GET /api/evals`、
  `GET /api/evals/:id` 与 `POST /api/evals/run`。
- Evaluation 启动使用独立频率计数，不消耗普通 Task 创建额度；并发请求返回
  `409 WEB_EVALUATION_ALREADY_RUNNING`，超限返回 `429`。
- 登录与 HttpOnly Session 架构未修改；普通 Web Session 未获得 Host 权限。

## 浏览器 E2E 实际验证

在本地生产构建、Mock Provider、真实 SQLite 文件与
`http://127.0.0.1:8792` 上完成浏览器驱动验证：

1. 登录后空 Dashboard 的成功率、延迟与 Recovery 比率显示 `N/A`。
2. Evaluation Center 启动固定 Suite，页面显示 SQLite 持久化的 30/30 Case、
   分项指标、确定性来源与 Provider/Estimated Token。
3. Web 选择并运行 MCP preset；真实本地 stdio 子进程返回 3 个 STM32 库存项，
   Task 完成且 `mcp_inventory_inventory_search` 为 `succeeded`。
4. Execution History 显示 MCP ToolRun 输入/结果、`tool.intent_committed`、
   `tool.succeeded` 事件以及 11 个 Checkpoint。
5. 返回 Dashboard 后显示 1 个真实 Task、1 个成功 Tool/MCP 调用、Provider
   Token 0 与 Estimated Token 2,129，来源未混淆。

本轮浏览器 E2E 验证了正常执行路径。MCP 错误、超时与取消由自动化测试验证，
未在浏览器中注入故障；该项不表述为浏览器 PASS。页面已使用响应式 Grid、
可滚动明细表和小屏断点，但本轮未做独立移动设备 viewport 浏览器验收。

## 实际测试结果

- 定向：
  `pnpm exec vitest run tests/web/web-api.test.ts tests/web/web-format.test.ts tests/observability/metrics-service.test.ts tests/integration/mcp-persistent-agent.test.ts`
  — 4 files / 18 tests passed。
- 全量：`pnpm test` — 88 files / 781 tests passed。
- `pnpm typecheck` — passed。
- `pnpm web:build` — passed；Vite 8.3.5，2,078 modules transformed，主 JS
  337.78 kB（gzip 100.80 kB）。
- `git -c core.safecrlf=false diff --check` — passed。
- 未调用真实 DeepSeek API。

## Phase 6.3 剩余工作

- 匿名 Guest Session 与移除登录页。
- 匿名访问下的 Actor/Guest 数据隔离、滥用与成本限制整合。
- 公网 HTTPS 部署与真实公网验收。
- Deferred Manual Final RecoveryReview / Host 决策入口仍保持关闭。
