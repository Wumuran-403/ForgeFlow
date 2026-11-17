# Phase 6.3 Anonymous Web Integration Report

## 结论

Phase 6.3 已完成。本地 Web 产品现在无需注册、密码或 Access Token：首次访问由服务端签发匿名 Guest Session，并直接进入 Dashboard。普通 Web API 仍以服务端认证的 Guest Actor 做任务、审批、控制和历史数据隔离；Host Authentication 与 Final RecoveryReview 的封闭状态未改变。

## 实际修改文件

- Guest Session / Web 安全：`src/web/auth.ts`、`src/web/config.ts`、`src/web/server-factory.ts`、`src/web/server.ts`、`src/web/task-service.ts`
- 全站成本控制：`src/web/global-model-budget.ts`、`src/storage/migrations/012-phase6-3-anonymous-budget.ts`、`src/storage/migrations/index.ts`
- 安全停止与持久化：`src/agent/agent-runner.ts`、`src/agent/types.ts`、`src/persistence/execution-bridge.ts`、`src/storage/execution-state-machine.ts`、`src/storage/index.ts`
- Web 产品整合：`web/src/app.tsx`、`web/src/lib/api.ts`、`web/src/lib/auth.tsx`、`web/src/lib/types.ts`、`web/src/components/layout.tsx`、`web/src/pages/evaluation-page.tsx`、`web/src/pages/workspace-page.tsx`、`web/src/pages/history-page.tsx`；删除 `web/src/pages/login-page.tsx`
- 配置和运行说明：`.env.example`、`deploy.env.example`、`compose.yaml`、`scripts/smoke-web.mjs`、`README.md`
- 验证：`tests/web/guest-auth.test.ts`、`tests/web/global-model-budget.test.ts`、`tests/web/web-api.test.ts`、`tests/web/deployment-config.test.ts`、`tests/integration/recovery-process-worker.ts`、`tests/integration/recovery-process.test.ts`，以及 Migration 版本断言测试。

## Guest Session 与 Actor Isolation

- `GET /api/auth/session` 在没有有效 Cookie 时生成密码学安全的随机 `guest_...` Actor ID，并用 HMAC-SHA256 签名包含签发时间、过期时间和随机 nonce 的 Session。
- Cookie 为 HttpOnly、SameSite=Strict；生产 HTTPS 配置要求 Secure。Guest ID 不能由请求参数或前端指定，Cookie 不包含 API Key。
- 有效 Cookie 在刷新、浏览器关闭重开和服务重启后继续识别同一 Actor；签名错误、篡改或过期 Cookie 返回未认证。清除 Cookie 后生成的新 Guest 无权访问旧 Guest 的任务。
- Task、Approval、Pause/Resume/Cancel、History 继续执行服务端 Actor 检查。双 Guest 集成测试确认 Guest B 无法读取或审批 Guest A 的任务。
- 原登录接口已删除，前端不再存在登录、退出或 Access Token 输入。内部 `/internal` / RecoveryReview Web 路由仍不可用，普通 Guest 不能充当 Host Reviewer。
- Origin/CSRF 检查仍作用于状态修改请求。

## 全站预算与防滥用

- SQLite Migration v12 新增按 UTC 日期聚合的全站模型预算表和调用 Reservation 表。
- DeepSeek Web 模式默认关闭；启用时必须同时设置 `WEB_ALLOW_PAID_PROVIDER=true`、服务端 API Key 和正数 `WEB_GLOBAL_MODEL_TOKEN_BUDGET_PER_DAY`。
- Provider Dispatch 前在 SQLite `IMMEDIATE` 事务内执行 `已结算 + 在途预留 + 本次输入估算 + 保留 completion` 检查并原子预留。多个同数据库进程/实例不能同时透支同一剩余额度。
- Provider 返回实际 Usage 时按 Provider Usage 结算；Estimated / Unknown Usage 独立记录并保守计费，不写成 Provider 实际用量。进程崩溃遗留的预留继续占用预算，不会在重启后被当作免费额度。
- 预算不足或站点并发上限到达时不调用底层 Provider；Agent 在有效 Lease/Fencing 下写入 `global_model_budget_exhausted` Event 和 Checkpoint，合法暂停 Task，Resume 不能绕过该阻断，也不会静默切换成 Mock。
- 保留每 Guest 创建频率、并发任务、每日任务与真实模型任务配额、单 Task Model Turn / Tool Call / Token Budget；Guest Session 签发另有按网络来源的辅助频率限制。
- Evaluation 启动使用 SQLite 历史做全站小时频率限制，并保留全站单 Run 并发控制。生产默认只读；只展示固定 Suite 的公开结果，不返回 Guest 私有任务。

限制：全站 Provider 并发计数是单 Web 服务进程内限制；跨多个 Web 副本的预算预留仍由 SQLite 原子事务保护。预检预留不是绝对计费上限，单次真实返回可能高于估算。崩溃 Reservation 当前采取保守永久占用，尚无管理员核销入口。

## Web 产品整合

- Dashboard、Workspace、Approval Center、Execution History、Evaluation Center 和预设 MCP Workflow 全部通过自动 Guest Session 使用真实 Web API。
- Workspace 显示全站预算安全停止，禁用 Resume，仅保留 Cancel；Execution History 显示对应持久化 Event。
- Evaluation Center 根据服务端 capability 显示可运行或生产只读状态，不允许上传脚本或配置任意 MCP Server。
- MCP 仍只使用服务端 allowlist 的本地 stdio Server，并经过 ToolRegistry、Scheduler、ToolRun、Event 与 Checkpoint 链路。

## 浏览器 E2E 与重启验证

使用真实浏览器、生产前端构建、Mock Provider 和独立 SQLite 文件验证：

- 首次打开直接进入 Dashboard，无登录页面或跳转。
- 创建 STM32 BOM Recovery；真实后端进入 Pending Approval 并显示 6 个 ToolRun。
- 在 Pending Approval 时停止并重启 Node.js 服务；同一 HttpOnly Guest Cookie 仍能读取原任务和审批，审批未被自动通过。
- 审批后任务保持 `Interrupted · review needed`，显式 Resume 后 Write 成功并最终完成；历史、Checkpoint、Token Usage 可查询。
- 页面刷新以及关闭并重新打开浏览器标签后，同一 Guest 的历史任务仍存在。
- 预设 STM32 MCP Inventory Audit 经真实 stdio 子进程执行并完成，Web 显示 MCP ToolRun。
- Evaluation Center 运行固定 Suite 并从 SQLite 展示 30/30 deterministic 结果；这不是实际大模型成功率。
- 390×844 手机视口检查通过，页面没有横向 document overflow；桌面加载、空状态、任务状态和错误提示已检查。
- 另以 DeepSeek 模式、1 Token 全站预算和占位 Key 启动独立服务：首个请求在底层网络调用前被预算预检阻断，Task 持久化为 paused，并显示 `global_model_budget_exhausted` 安全提示；没有真实 DeepSeek 调用。

浏览器工具本轮只提供一个隔离浏览器 Profile，因此“两个独立浏览器上下文”没有标记为 Browser PASS；同等 Actor 越权场景由两个独立 Guest Cookie 的真实 Web API 集成测试覆盖。Phase 3 的审批等待、服务重启、审批和显式 Resume 浏览器恢复链路已通过；运行中的 Pause/Cancel 竞态没有新增浏览器驱动验证。

## 实际测试结果

- `pnpm exec vitest run tests/web/guest-auth.test.ts tests/web/global-model-budget.test.ts tests/web/web-api.test.ts tests/integration/recovery-process.test.ts`：4 files、30 tests passed。
- `pnpm typecheck`：passed。
- `pnpm web:build`：passed；Vite 生成生产 Bundle。
- `pnpm test`：90 files、791 tests passed。
- `git diff --check`：passed；仅输出现有 Windows 工作区的 LF/CRLF 提示，无 whitespace error。

## 未完成事项

- 未部署公网 HTTPS；真实 Secure Cookie、Caddy 和公网 Origin 仍需部署阶段验证。
- 未执行真实 DeepSeek 调用或压力测试；预算耗尽验证刻意在网络请求前停止。
- 多 Web 副本的分布式 Provider 并发信号量、崩溃 Reservation 管理入口和管理员预算界面不在本批次范围。
- Manual Final RecoveryReview 与 Host 决策业务入口继续 Deferred / Closed。

Phase 6.3 完成后停止；未开始公网部署。
