# Phase 3 Step 5 Development Report

> 状态：AgentRunner / TaskScheduler 持久化集成完成
>
> 范围：PersistenceCoordinator、Lease-owned Agent Run、Model Call 持久化、
> Tool Intent/Result 持久化、Scheduler 注入、终态执行保护

## 1. 修改与新增文件

持久化入口：

- `src/persistence/coordinator.ts`
- `src/persistence/execution-bridge.ts`
- `src/persistence/recovery-gate.ts`
- `src/persistence/index.ts`

Agent / Scheduler：

- `src/agent/agent-runner.ts`
- `src/agent/types.ts`
- `src/agent/index.ts`
- `src/scheduler/types.ts`
- `src/scheduler/task-scheduler.ts`
- `src/scheduler/read-worker-pool.ts`
- `src/scheduler/write-executor.ts`
- `src/scheduler/index.ts`

Storage：

- `src/storage/execution-unit-of-work.ts`
- `src/storage/task-invariants.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/plan-step-repository.ts`
- `src/storage/tool-run-repository.ts`
- `src/storage/approval-repository.ts`
- `src/storage/recovery-review-repository.ts`
- `src/storage/migrations/003-phase3-step4.ts`
- `src/storage/index.ts`

测试：

- `tests/integration/persistent-execution.test.ts`
- `tests/storage/step4-schema.test.ts`

文档：

- `docs/PHASE3_STEP5_DEVELOPMENT_REPORT.md`

没有修改 CLI 入口，也没有开始 Step 6。

## 2. 持久化入口设计

新增 `PersistenceCoordinator`：

```text
run(taskId, ownerId)
  -> TaskLeaseManager.claim
  -> start Lease Heartbeat
  -> load final TaskSnapshot
  -> Recovery Gate
  -> validate Task executable state
  -> transition queued -> running
  -> create PersistentExecutionBridge
  -> run existing AgentRunner + TaskScheduler
  -> finish Task
  -> stop and await Heartbeat
  -> release Lease
```

另有受控入口：

```text
runOwned(taskId, leaseToken, fencingToken)
```

该入口不自行 Claim，但开始前必须通过 `assertOwned`。无 Lease、过期 Lease、
错误 fencing token 或错误 task ID 均直接拒绝，不会调用 Provider。

### run() / runOwned() 所有权规则

- `run()`：拥有完整 Lease 生命周期，负责 Claim、Heartbeat、停止 Heartbeat 和
  Release。
- `runOwned()`：只执行 caller 已拥有的 Lease；不 Claim，不启动 Heartbeat，
  也不 Release。调用方负责续租和释放。
- AgentRunner 自身不管理 Lease。

### Task 状态边界

- `queued`、`running`：允许持久化 Agent 执行。
- `waiting_approval`、`waiting_review`、`pause_requested`、`paused`：
  Lease 可用于 Step 5/6 的审批和状态清理，但当前 Step 5 持久化执行入口拒绝
  自动继续。
- `completed`、`failed`、`cancelled`：禁止 Claim，也禁止新增活跃执行数据。

## 3. Heartbeat 生命周期

- Claim 成功后立即启动周期 Heartbeat。
- 默认周期为 `leaseTtlMs / 3`，为网络、SQLite 和调度延迟保留安全余量。
- 测试可以注入更短周期，生产默认跟随 TaskLeaseManager TTL。
- Heartbeat 覆盖 Provider、Read Worker Pool、Write、ApprovalHandler 等待和
  持久化提交期间。
- Heartbeat 事件继续写入 Event；普通 Heartbeat 不写 Checkpoint。
- 任一 Heartbeat 失败会：
  - 记录 worker 已失去执行权；
  - Abort 当前执行信号；
  - 阻止新建 Model Call 和启动新 Tool；
  - 让已启动 Write 通过现有 Abort/Unknown 语义收尾；
  - 在清理完成后停止 Heartbeat 并尝试 Release。
- 执行结束先停止 Heartbeat，再 Release。
- Release 失败抛出明确 `TASK_LEASE_RELEASE_FAILED`；若同时存在主执行错误，
  使用 `AggregateError`，不再静默吞掉。

## 4. Recovery Gate

初始 TaskSnapshot 在状态转换和 AgentRunner 启动前必须通过
`assertSafeToStartPersistentRun()`。

拒绝条件：

- requested 或 interrupted Model Call。
- queued、awaiting_approval、running、interrupted 或 unknown ToolRun。
- 非 completed/skipped PlanStep，包括 interrupted、waiting_review。
- pending Approval。
- pending/unresolved RecoveryReview。

错误码：

```text
PERSISTENT_RECOVERY_REQUIRED
```

Gate 在任何 Provider/Tool 调用前执行，不修改原始执行事实，不伪造 Tool Message。
claim/release 审计事件之外，不改变遗留 ModelCall、ToolRun 或 PlanStep 状态。

queued ToolRun 也不能假定安全：它可能已经提交 Intent。Step 5 Recovery Gate
统一要求 RecoveryManager 处理。

本检查只在入口执行一次。当前 Worker 运行中新产生的 requested Model Call 和
running ToolRun 不会被误判为遗留状态。

## 5. Lease / Fencing 集成

- AgentRunner 不负责 Claim、Heartbeat 或 Release。
- PersistenceCoordinator 获取并最终释放 Lease。
- AgentRunner 使用 PersistenceBridge；Bridge 的 Model Call、Tool Intent 和
  Tool Result 写入均携带 task ID、lease token 和 fencing token。
- UoW 在事务内部调用 `TaskLeaseManager.assertOwned`。
- ToolRun 写入继续使用 version CAS。
- Task 终态转换继续通过 `ExecutionStateMachine`。
- 旧 Worker 即使持有旧 expected version，也会先被 fencing ownership 校验拒绝。

## 6. AgentRunner 集成

保留原入口：

```text
AgentRunner.run(...)
```

未注入 `AgentExecutionPersistence` 时完全沿用 Phase 1 的非持久化行为。新的
持久化路径通过可选 adapter 注入：

1. 从已持久化 Message 历史初始化 Agent 消息。
2. Provider 请求前创建 `requested` Model Call。
3. requested 事务成功提交后，才调用 Provider。
4. Provider 返回后，通过 UoW 原子提交：
   - Model Call completed
   - Assistant Message
   - Usage
   - Event
   - Checkpoint
5. 有 Tool Calls 时，在同一事务中额外提交：
   - ExecutionPlan
   - PlanSteps
   - ToolRun intents
   - 幂等键和工具版本/Hash
6. 最终答案仍由原 Agent Loop 生成，随后通过 ExecutionStateMachine 将 Task
   转为 completed。

Provider 失败时使用 UoW 保存 failed/cancelled Model Call。Model Response
持久化失败时 AgentRunner 返回 failed，不把响应视为成功。

## 7. TaskScheduler 集成

未重写 Planner 或 Scheduler。新增可选执行钩子：

```text
beforeExecute
persistReadResult
persistWriteResult
```

持久化路径执行流程：

```text
Model response transaction
  -> persist Plan / PlanStep / ToolRun intents
  -> Scheduler uses the persisted SchedulePlan
  -> each tool:
       assertOwned
       commit Tool Intent (queued -> running)
       call external tool only after commit
       persist Tool Result + Tool Message + PlanStep update
```

PersistentBridge 会重新加载当前 Snapshot，并检查 ToolRun 当前状态与 version。
已成功或已启动的 ToolRun 不会再次执行。

## 8. Read 执行语义

- 继续使用 Phase 2 ReadWorkerPool 的默认最大并发数和有界 Worker。
- `beforeExecute` 在真正调用 Read 函数前提交 Intent。
- 外部 Read 并行执行。
- Result 持久化按原始 Tool Call 顺序进行，不按完成时间排序。
- 单个 Read 失败不会取消同批其他 Read。
- 每个 Read Result 与 Tool Message、PlanStep 更新在同一个 UoW 事务中提交。
- Read 输出必须通过 JSON-compatible 预校验；失败会记录为工具失败。

如果 Read 已执行但 Result Commit 失败：

- 不返回未提交的成功结果给 AgentRunner。
- 不伪造成功 Tool Message。
- Scheduler 以 `persistence_failed` 终止整批执行。
- AgentRunner 不再请求下一轮模型。
- 保留 running ToolRun Intent，交由 Step 6 恢复。

## 9. Write 执行语义

- 保持 Phase 2 串行 Write Barrier。
- `requiresApproval=true` 时仍必须经过 ApprovalHandler。
- Approval 拒绝时 Write 函数调用次数为零，ToolRun/PlanStep 记录为 skipped，
  Tool Message 仍持久化，Agent 可以继续下一模型轮次。
- Approval 通过后才提交 Tool Intent。
- Tool Intent Commit 成功后才调用外部 Write。
- Write 成功后 Result Commit；若 Result Commit 失败，会尝试在第二个事务中写
  `unknown`，并立即终止 Scheduler 后续步骤。
- Write 一旦进入 running，以下情况均映射为 unknown：
  - 工具抛错
  - 超时
  - 执行中取消
  - 非 JSON / BigInt / 循环引用等输出序列化失败
  - 执行后输入/定义校验失败
  - Tool Result 事务失败
  - Result Event 或 Checkpoint 失败
- 如果 unknown 的二次持久化也失败，原 running Intent 保留给 Step 6。
- 上述 unknown 路径均不会请求下一轮模型，也不会执行后续 Write。
- unknown 不会自动重试，也不会继续请求下一轮模型。
- 后续未启动 Tool Calls 由原 TaskScheduler 标记为 skipped。

## 10. UoW 事务与终态保护

新增所有权感知事务：

- `beginOwnedToolRun`
- `completeOwnedToolRun`
- `finalizeOwnedToolRunBeforeStart`

Model Call 的 begin/complete/fail 也支持可选 ownership，并在事务内部校验 Lease。

数据库新增第二道保护：

- terminal Task 禁止新增 PlanStep。
- terminal Task 禁止新增 ToolRun。
- terminal Task 禁止新增 Approval。
- terminal Task 禁止新增 RecoveryReview。
- Repository 写入前执行同样的 terminal Task 检查。

所有状态变更与 Event 保持同事务。StorageWritePermit 生命周期约束沿用 Step 2。

## 11. 测试矩阵

`tests/integration/persistent-execution.test.ts`（19 项）：

- Model Call requested 在 Provider 调用前可见
- 两个 Read 实际并行，持久化 Message 仍按原始调用顺序
- 两个 Write 串行并分别经过 Approval
- Tool Intent 失败时工具函数调用次数为零
- Write 成功后 Result Event 失败时转为 unknown，且不请求下一轮模型
- Approval 拒绝时 Write 调用为零，ToolRun/PlanStep 为 skipped
- 无有效 Lease 时持久化入口拒绝
- 过期 Lease 与旧 fencing token 拒绝，Provider 不调用
- Model Response 与 Assistant Message 原子回滚
- Read Result、Tool Message、PlanStep 原子回滚
- Provider 长等待期间持续 Heartbeat
- ApprovalHandler 等待期间持续 Heartbeat
- Heartbeat 失败后不启动新 Provider/Tool
- 已启动 Write 在 Heartbeat 失效后 unknown
- 正常完成后 Heartbeat 停止并 Release
- Provider / Scheduler 异常后的 Lease 清理
- Release 失败显式返回错误
- Recovery Gate 对 requested、running、unknown、interrupted、
  waiting_review、queued Intent 全部拒绝
- Recovery Gate 拒绝时 Provider 和 Tool 调用次数为零
- Write 异常、超时、BigInt 输出映射 unknown
- Write 执行中取消映射 unknown
- unknown 二次持久化失败时保留 running Intent

`tests/storage/step4-schema.test.ts` 扩展：

- terminal Task 通过 Repository 禁止新增 PlanStep、ToolRun、Approval
- 绕过 Repository 的原始 SQL 同样被 SQLite Trigger 拒绝

## 12. 实际执行结果

- `pnpm test`：29 个测试文件、226 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1、Phase 2 以及 Phase 3 Step 1–4 的测试继续包含在全量测试中并通过。
未注入持久化 adapter 的 AgentRunner 原有路径保持兼容。

## 13. 已知限制

- 没有进程启动自动恢复。
- 没有重建 requested Model Call attempt。
- Read Result Commit 失败后的 interrupted/retry 策略留给 Step 6。
- Write Result Commit 失败会记录 unknown，但没有人工核对工作流。
- ApprovalHandler 仍是 Phase 2 运行时接口；没有实现可持久恢复的审批等待流程。
- 当前 Tool Registry 没有独立 Output Schema；输出只做 JSON-compatible 检查，
  Write 执行后的校验/序列化异常仍按 unknown 处理。
- unknown 后不会自动 Read-back。
- `waiting_approval` / `waiting_review` 的完整恢复编排属于 Step 6。
- SQLite WAL 与 Lease 仍只面向同机进程。

## 14. 阶段边界声明

本次只完成 Phase 3 Step 5。

- 没有实现 RecoveryManager。
- 没有实现自动崩溃恢复。
- 没有实现完整 Pause / Resume / Cancel 编排。
- 没有实现 Unknown Write 人工核对自动化。
- 没有接入 MCP、真实 DeepSeek Provider 或 Dashboard。
- 没有进入 Step 6。
