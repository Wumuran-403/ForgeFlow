# Phase 4.2 Loop Guard Development Report

## 结论

Phase 4.2 已完成。Loop Guard 在新的 ToolCall Batch 进入 Scheduler、Write
Approval 和工具副作用之前执行；持久化任务触发时，会在同一 SQLite
`IMMEDIATE` 事务中跳过完整且尚未启动的当前 Batch、写入
`loop_detected` Event 与 Checkpoint，并通过既有合法状态转换进入
`paused`。Phase 4.3、MCP、Evaluation 和公网部署均未开始。

## 实际修改文件

- 核心：`src/loop-guard/*`、`src/agent/agent-runner.ts`、
  `src/agent/types.ts`。
- 持久化：`src/persistence/coordinator.ts`、
  `src/persistence/execution-bridge.ts`、
  `src/storage/execution-state-machine.ts`。
- 配置与启动：`src/config/env.ts`、`src/web/server.ts`、
  `src/web/task-service.ts`、`.env.example`、`deploy.env.example`、
  `compose.yaml`、`README.md`。
- Web：`web/src/pages/workspace-page.tsx`、
  `web/src/pages/history-page.tsx`。
- 测试：`tests/loop-guard/loop-guard.test.ts`、
  `tests/integration/loop-guard-persistence.test.ts`。

未增加依赖，未增加数据库迁移，未创建 Git Commit。

## Signature 与检测策略

- Signature 使用现有 canonical JSON 与 SHA-256，绑定 `toolName` 和参数；
  JSON 属性顺序不影响结果。Event 只保存 64 位十六进制摘要，不保存参数、
  API Key 或 Tool Result 明文。
- 连续重复默认在第三次 `A` Dispatch 前触发。
- 短周期首版仅检测周期二，默认在 `A-B` 重复三轮、最后一次 Dispatch 前触发。
- 连续失败使用真实 ToolRun `failed` / `timed_out` 状态以及非明文结果摘要；
  错误结果变化会重置无进展累计。
- 成功 Write 和发生变化的成功 Read 结果摘要视为可观察进展；`unknown`
  是硬阻断边界，不会被 Loop Guard 自动重试。
- 检测以模型轮次为单位。多调用 Read Batch 不作为单一 Signature 累计，
  避免把正常并行读取误报为跨轮循环。窗口固定且有界，默认保留 12 轮。

## 执行、事务与 Recovery

模型响应及执行计划先按现有恢复协议落库，随后 Loop Guard 从 SQLite 的
agent ExecutionPlan、PlanStep 和 ToolRun 重建窗口，并在 Scheduler Dispatch
前判断。触发事务要求 Task 仍为 `running`、Lease/Fencing 仍有效、当前
ExecutionPlan 仍为 `active`，且整个 Batch 的 ToolRun/PlanStep 全部为
`queued`。任何 Batch 已开始时 Guard 均不会中途切割或改写既有结果。

触发事务只将当前未开始 Batch 收敛为 `skipped`，保留此前成功 ToolRun；
写入与 Assistant ToolCall 一一对应的 Tool Result 消息，维持上下文关联；
再执行 `running -> pause_requested -> paused`、Event 和 Checkpoint。检测窗口
来自 SQLite 原始记录，与 Context Manager 的请求裁剪相互独立。

任务因 Loop Guard 暂停后，当前版本没有安全的“原因已解决”确认协议，
因此 Resume fail closed 为 `TASK_LOOP_GUARD_BLOCKED`。服务重启后同样读取
持久化事件并拒绝绕过，不会新增重复 Event、Checkpoint、Provider 请求或
工具副作用。

## Web 可观测性

Workspace 对真实持久化的 `loop_detected` 显示暂停提示并禁用 Resume。
Execution History 展示 Event payload，包括原因、相关工具、摘要、重复次数、
阈值和周期；Task 状态显示为 `paused`。诊断 Event 不作为 Tool Result 使用。

## 实际验证

- `pnpm exec vitest run tests/integration/loop-guard-persistence.test.ts tests/loop-guard/loop-guard.test.ts tests/unit/agent-loop.test.ts tests/integration/context-persistence.test.ts`
  — 4 files / 29 tests passed。
- `pnpm exec vitest run tests/unit/config.test.ts tests/integration/persistent-execution.test.ts tests/storage/execution-state-machine.test.ts tests/storage/recovery-multi-write-barrier.test.ts tests/recovery/read-recovery.test.ts tests/web/web-api.test.ts`
  — 6 files / 72 tests passed。
- `pnpm test` — 81 files / 761 tests passed。
- `pnpm typecheck` — passed。
- `pnpm web:build` — passed（2077 modules transformed）。
- `git -c core.safecrlf=false diff --check` — passed。

测试覆盖 canonical Signature、参数差异、连续重复、二周期、相同／变化失败、
Read Batch、可观察进展、持久化 Event/Checkpoint、Dispatch 前阻断、既有成功
ToolRun 不变、暂停、关闭并重新打开真实 SQLite 文件后的窗口重建、重启后
Resume fail closed，以及现有 Context、Scheduler、
Approval、Write Barrier、Recovery、Lease/Fencing 和 Web API 全量回归。未调用
真实 DeepSeek API。

## 已知限制与后续

- 首版只检测长度为二的短周期，不做任意周期或概率判定。
- “进展”只采用受信任的 ToolRun 状态与持久化结果摘要，不推断外部业务系统
  是否变化，也不依据模型自然语言判断副作用。
- Loop Guard 暂停后的受控确认／清除机制、误报案例统计和 Loop Detection
  Rate 可作为 Phase 4.3 候选，但 Phase 4.3 的具体范围需另行授权。
- Phase 3 Browser Recovery E2E 仍为 Pending；Manual Final RecoveryReview 与
  Host 决策入口仍为 Deferred/Closed，未标记为 PASS。
