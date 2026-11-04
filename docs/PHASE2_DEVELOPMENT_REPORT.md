# ForgeFlow Phase 2 Development Report

> 状态：Phase 2 完成并通过集成验收
>
> 范围：Task Planner、Read Worker Pool、Write Executor、Approval、Timeout、Cancellation、TaskScheduler、AgentRunner 集成
>
> 未包含：SQLite、Checkpoint、MCP、真实 DeepSeek API、Web Dashboard

## 1. Phase 2 整体架构

```text
AgentRunner
  -> registry execution lease
  -> Mock / Provider response
  -> TaskScheduler
       -> TaskPlanner
            -> Read Batch
            -> Write Barrier
            -> Unknown Tool Barrier
       -> ReadWorkerPool
       -> WriteExecutor
            -> WriteApprovalHandler
       -> ordered ScheduledToolResult[]
  -> ordered Tool Messages
  -> next model request / terminal result
```

Registry 是工具定义、Zod 校验和实际执行的唯一入口。Planner、ReadWorkerPool、
WriteExecutor 和 TaskScheduler 必须引用同一个 Registry 实例。

## 2. 七个 Step 的实施成果

| Step | 成果 |
|---|---|
| Step 1 | Tool timeout/approval 元数据、ToolExecutionContext、输入预校验、Registry 执行租约 |
| Step 2 | Read 合并、Write Barrier、Unknown Barrier 和原始 Index 规划 |
| Step 3 | 有界 Read Worker Pool、结果顺序保持、部分失败隔离 |
| Step 4 | WriteExecutor、审批 Handler、Write 安全状态机 |
| Step 5 | 工具/审批超时、AbortSignal 组合、Read slot settle 语义 |
| Step 6 | TaskScheduler、AgentRunner 可选注入、Write unknown 终止 |
| Step 7 | 本地 BOM 端到端集成测试、完整验收和 Phase 2 文档 |

## 3. Read / Write 调度机制

- 连续 Read 形成一个 Read Batch。
- Read Batch 交给 ReadWorkerPool，默认最大并发 3。
- 遇到 Write 前等待此前 Read Batch 全部 settle。
- 每个 Write 独立执行，不与其他 Write 或前后 Read 重叠。
- Unknown Tool 作为独立屏障，安全失败后继续后续计划。
- 所有结果按 `originalIndex` 回填，不按完成时间排序。
- 取消后不领取新的排队 Read；未启动调用仍有明确 `cancelled` 结果。

## 4. Worker Pool 并发控制

- 固定 Worker 数量为 `min(maxConcurrency, taskCount)`。
- Worker 共享单调递增的任务索引。
- 槽位在底层工具 Promise 真正 settle 后才释放。
- 工具超时或取消只决定 `timed_out`/`cancelled` 状态，不提前释放仍占用的槽位。
- 一个 Read 失败或超时不会取消同批其他 Read。
- 结果写入固定下标，最终按原始 Tool Call 顺序返回。

## 5. 审批机制

- Write 默认 `requiresApproval=true`。
- 显式 `requiresApproval=false` 可跳过审批。
- 参数先通过 Registry Zod 校验和 JSON 快照。
- 审批拿到独立可变副本，实际执行使用 Registry 深冻结输入。
- 无 Handler、拒绝或审批超时时工具执行次数为零。
- 审批通过后再次检查父取消信号。
- 审批超时后延迟返回的 approved 不会执行 Write。

## 6. Timeout 与 Cancellation

- 工具默认超时 30 秒；审批有独立的 30 秒默认超时。
- 每个工具使用独立 AbortController，组合父任务取消和自身超时。
- 读工具超时返回 `timed_out`，同批其他 Read 继续。
- Write 已启动后超时、异常或取消返回 `unknown`。
- Write 已成功完成后才取消时，保留 `succeeded`。
- 取消和超时不会声称强制停止忽略 AbortSignal 的底层工具。
- 不自动重试超时或 unknown 的 Write。

## 7. AgentRunner 集成

- 不注入 Scheduler 时保留 Phase 1 顺序执行路径。
- 注入 Scheduler 时，预算检查后把完整 Tool Call 数组交给 TaskScheduler。
- AgentRunner 保留 `maxModelTurns` 与 `maxToolCalls` 管理。
- Registry 租约覆盖模型请求、规划、工具执行和下一轮决策。
- 租约通过 `try/finally` 释放。
- `write_outcome_unknown` 后不再请求下一轮 LLM。
- `cancelled` 后不再请求下一轮 LLM。
- Write 被拒绝或确认未执行失败后，剩余步骤为 `skipped`，Agent 可重新决策。

## 8. 完整集成测试场景

`tests/integration/phase2-end-to-end.test.ts` 使用真实 TaskScheduler、
ReadWorkerPool、WriteExecutor、ToolRegistry、MockLLMProvider 和本地 BOM 状态。

### 主场景

调用顺序：

```text
R1 BOM 读取
R2 库存查询
W1 BOM 更新（审批）
R3 BOM 重读
W2 生产报告生成（审批）
```

验证结果：

- R1/R2 使用 Deferred Gate 证明实际重叠。
- 最大 Read 并发不超过配置。
- W1 在 R1/R2 均结束且审批完成后开始。
- R3 在 W1 结束后开始，并读取到更新后的 Revision。
- W2 在 R3 结束后开始。
- 最大 Write 并发为 1，Read/Write overlap violations 为 0。
- 开始/结束/审批事件均记录单调时间戳。
- 5 个 Tool Call ID 和结果顺序完全匹配。
- Agent 收到完整 Tool Message 并返回最终答案。
- Registry `executeValidated()` 调用 5 次，`execute()` 未绕过调用。

### 失败与终止场景

- W1 审批拒绝：W1 和后续 R2 均为 skipped，W1/R2 执行次数为零，Agent
  发起下一轮 LLM 重新决策。
- W1 已启动后 unknown：R2 为 skipped，W1 执行次数保持 1，Agent 返回
  `write_outcome_unknown`，不再请求 LLM，也不重试。
- Read Batch 中 R2 失败：R1/R3 保持成功，三个结果全部按原序回填，
  Agent 收到完整结果后继续决策。

### 取消场景

- Read Batch 取消：运行中的 R1/R2 等待底层 settle，排队 R3 不启动，
  三个调用均返回 `cancelled`，Agent 不再请求 LLM。
- 审批等待取消：W1 执行次数为零，后续 R2 不启动，所有结果明确。
- Write 执行开始后取消：W1 返回 `unknown`，R2 为 skipped，
  Agent 不请求下一轮 LLM。
- Write 成功完成后取消：已确认的 Write Result 保持 `succeeded`。
- 取消后没有新的工具启动，活动计数最终归零。

## 9. 测试数量与真实结果

Phase 2 最终验证：

- `pnpm test`：14 个测试文件、130 个测试全部通过
- `pnpm typecheck`：通过
- `git diff --check`：通过，无空白错误
- `pnpm start`：健康检查正常，阶段为 `phase-2`

Step 7 新增 8 个端到端测试；Phase 1 的 33 个原始测试和 Phase 2 Step 1-6
全部测试继续通过。

## 10. 已知限制

- 没有 SQLite、Checkpoint、进程重启恢复或持久化审批队列。
- `write_outcome_unknown` 只在当前内存 Run 中阻止后续执行，进程退出后状态不会恢复。
- 忽略 AbortSignal 的工具不会被强制终止；底层 Promise settle 前执行器会保守等待。
- 没有写操作回滚、幂等确认或 exactly-once 保证。
- 没有 MCP、真实 DeepSeek API、Context Manager、Loop Guard、Dashboard 或评测集。
- 审批通过回调仅存在于进程内，没有外部审批 UI。
- Tool Output 大小限制、上下文压缩和完整可观测性尚未实现。

## 11. Phase 3 Checkpoint 开发建议

Phase 3 建议实现：

1. SQLite 版本化迁移、WAL 和外键约束。
2. `tasks`、`tool_runs`、`checkpoints`、`events`、`approvals`、`model_calls` 表。
3. 在 Task、模型响应、Tool 开始/结束、审批和终止边界保存 Checkpoint。
4. 恢复时加载不可变最新快照，并校验持久化 JSON。
5. Read 中断可按策略安全重跑；Write `unknown` 不得自动重试。
6. 写入幂等键、执行前落库和人工核对路径。
7. pause/resume/cancel 状态机及事件时间线。
8. 崩溃恢复集成测试：任务中断、重启、继续和重复副作用检测。

Phase 3 不应通过缩短现有超时或强制释放 Worker 槽位来模拟恢复。所有恢复语义必须
建立在明确持久化证据上。
