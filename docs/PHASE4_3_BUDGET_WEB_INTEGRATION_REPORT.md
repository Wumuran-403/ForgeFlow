# Phase 4.3 Task Token Budget & Web Integration Report

## 结论

Phase 4.3 已完成。ForgeFlow 现在支持 SQLite 持久化的单任务累计 Token
Budget，在后续 Provider 请求前使用持久化累计值进行检查；预算耗尽时，
不会再发起模型请求，并在 Lease/Fencing 保护的同一 SQLite 事务中记录
`token_budget_exhausted` Event、Checkpoint 和合法的 `paused` 状态。

本轮未修改登录、Session、Actor 归属或 Origin 校验架构。匿名 Guest Session
和移除登录页面仍按要求延期到 Phase 6 Web 产品整合。本轮未开始 Phase 5，
未创建 Git Commit。

## 实际修改文件

- Agent 与 Usage：`src/agent/agent-runner.ts`、`src/agent/types.ts`、
  `src/context/token-usage.ts`。
- 持久化与恢复：`src/persistence/coordinator.ts`、
  `src/persistence/execution-bridge.ts`、
  `src/storage/execution-state-machine.ts`、
  `src/storage/execution-unit-of-work.ts`、
  `src/storage/task-repository.ts`、`src/storage/task-lease-manager.ts`、
  `src/storage/types.ts`、`src/storage/migrations/index.ts`、
  `src/storage/migrations/010-phase4-3-token-budget.ts`。
- Web API 与配置：`src/web/config.ts`、`src/web/task-service.ts`、
  `.env.example`、`deploy.env.example`、`compose.yaml`。
- Web UI：`web/src/lib/types.ts`、`web/src/pages/dashboard-page.tsx`、
  `web/src/pages/workspace-page.tsx`、`web/src/pages/history-page.tsx`。
- 测试：`tests/integration/token-budget-persistence.test.ts`、
  `tests/unit/agent-loop.test.ts`、`tests/web/web-api.test.ts`、
  `tests/web/deployment-config.test.ts`、相关 Storage migration/schema 测试和
  Web/Recovery 测试配置 Fixture。
- 文档：`README.md`、本报告。

未新增依赖。

## Token Budget 与统计语义

- v10 migration 为 `tasks` 增加可选正整数 `max_tokens`。历史 Task 迁移后为
  `NULL`，保持无限预算兼容；新 Web Task 默认使用
  `WEB_DEFAULT_TOKEN_BUDGET=50000`。
- Task、Checkpoint 和 Lease Checkpoint 都保留预算上限。Agent 每次准备发起
  新 Provider 请求前，从持久化 Task 读取累计 Usage 与上限；进程内计数不能
  覆盖 SQLite 真值。
- 每次 ModelCall 的 Usage 继续保持 `provider`、`estimated` 或 `unknown`。
  Task aggregate 分别保存 Provider 和 Estimated prompt/completion/total 以及
  calls 数；Estimated 不会被写成 Provider 实际用量。
- Provider 只返回部分 Token 字段时，`totalTokens` 使用已知字段的确定性和，
  不伪造未知部分。
- 已完成的最终回答不需要下一次模型请求，因此即使该次调用令累计值达到上限，
  仍可合法完成。预算只阻止后续 Provider 请求；单次已开始调用可能使累计值超过
  上限，这是首版硬边界的已知粒度。

## 耗尽事务与 Recovery

预算耗尽处理要求 Task 仍为 `running`、当前 Lease/Fencing 仍有效、Task CAS
版本未变化，而且 SQLite 中的 `totalTokens >= maxTokens`。事务执行：

1. `running -> pause_requested -> paused`；
2. 写入 `token_budget_exhausted` Event，包含上限、总量、Provider/Estimated
   分量和调用数；
3. 写入带 `maxTokens` 的 `token_budget_exhausted` Checkpoint。

任一写入失败则整个事务回滚。服务重启后预算从 Task/ModelCall/Checkpoint
记录恢复；预算暂停任务的 Resume fail closed 为
`TASK_TOKEN_BUDGET_EXHAUSTED`，不会新增重复 Event、Provider 请求或工具副作用。
Cancel 仍使用既有合法状态机。

## Web Integration

- Dashboard 显示总 Token、Provider/Estimated 分量，以及 Loop Guard 或预算
  Guard 状态。
- Workspace 显示任务预算进度、剩余量、Provider/Estimated 分量、每次
  ModelCall 的 Usage 来源与总量。Loop Guard 或预算耗尽后显示安全提示；
  Resume 禁用，Cancel 保留。
- Execution History 显示 Task 预算、Provider/Estimated 聚合、逐 ModelCall
  Usage 明细、Loop Guard 状态，并展开真实 `loop_detected` 和
  `token_budget_exhausted` Event payload。
- 只有 SQLite 中已持久化的 Event 会显示为已触发，不根据前端本地状态推断。

## 实际验证

- `pnpm exec vitest run tests/integration/token-budget-persistence.test.ts tests/integration/context-persistence.test.ts tests/context/context-manager.test.ts`
  — 3 files / 11 tests passed。
- Storage migration/schema 定向命令 — 7 files / 38 tests passed。
- Agent、Token Budget、Loop Guard、Web 配置与 Web API 定向命令 —
  5 files / 35 tests passed。
- `pnpm typecheck` — passed。
- `pnpm web:build` — passed，2077 modules transformed。
- `pnpm test` — 82 files / 765 tests passed。
- `git -c core.safecrlf=false diff --check` — passed。

测试验证了 Provider/Estimated 独立统计、下一次 Provider 请求前阻断、Event /
Checkpoint 持久化、真实 SQLite 关闭重开后的预算恢复、Resume fail closed、
历史数据库 v10 migration、旧 Task 无预算兼容、Web API 预算视图，以及现有
Context Manager、Loop Guard、Scheduler、Approval、Write Barrier、Recovery、
Lease/Fencing 全量回归。未调用真实 DeepSeek API。

## 已知限制与延期项

- 首版预算检查使用已完成 ModelCall 的累计 Usage；不会在未知完成量的情况下
  预扣下一次调用，因此单次调用可使累计量超过上限。
- 预算暂停和 Loop Guard 暂停当前没有普通用户可执行的“清除原因”入口；这能
  防止重复 Resume 绕过安全限制。未来若增加入口，必须有独立授权与审计语义。
- Phase 3 Browser Recovery E2E 仍为 Pending；Manual Final RecoveryReview 与
  Host 决策入口仍为 Deferred/Closed，未标记为 PASS。
- Anonymous Guest Session、移除登录页、Phase 5 MCP 和 Phase 6 产品整合均未在
  本轮实施。

## Phase 5.1 前置补丁（2026-11-10）

后续 Phase 5.1 开发开始前，已补齐请求前预算预估：Agent 先使用
ContextManager 构建实际请求，再在有效 Lease/Fencing 下读取 SQLite 累计值；当
`persistedUsage + estimatedNextPromptTokens + reservedCompletionTokens > maxTokens`
时，不创建 ModelCall、不调用 Provider，并沿用同一 `token_budget_exhausted`
Event / Checkpoint / 合法暂停事务。已有调用但累计 Usage 无法可靠确定时，每个
未知调用按一个完整 `maxContextTokens` 计入保守预算投影；全新零调用任务仍从 0
开始。该机制降低超支风险，但不承诺绝对计费硬上限，因为 Provider 实际
completion 用量仍可能偏离 reserve。
