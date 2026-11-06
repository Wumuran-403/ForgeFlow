# Phase 3 Step 4 Development Report

> 状态：Task Lease + Fencing + ExecutionStateMachine 完成
>
> 范围：Lease Claim/Heartbeat/Expiry/Release、Ownership Guard、Task/ToolRun/
> PlanStep 状态机、CAS、最终 TaskSnapshot

## 1. 修改与新增文件

数据库与存储：

- `src/storage/migrations/003-phase3-step4.ts`
- `src/storage/migrations/index.ts`
- `src/storage/types.ts`
- `src/storage/task-lease-repository.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/execution-state-machine.ts`
- `src/storage/task-invariants.ts`
- `src/storage/task-repository.ts`
- `src/storage/plan-step-repository.ts`
- `src/storage/tool-run-repository.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/index.ts`

工具上下文：

- `src/tools/types.ts`

测试：

- `tests/storage/task-lease.test.ts`
- `tests/storage/lease-claim-worker.ts`
- `tests/storage/execution-state-machine.test.ts`
- `tests/storage/state-cas-worker.ts`
- `tests/storage/step4-schema.test.ts`
- `tests/storage/schema.test.ts`
- `tests/storage/snapshot-concurrency.test.ts`
- `tests/tools/registry.test.ts`

文档：

- `docs/PHASE3_STEP4_DEVELOPMENT_REPORT.md`

没有修改 AgentRunner、TaskScheduler 或其持久化执行路径。

## 2. Migration 设计

新增：

```text
version: 3
name: phase3_step4_task_lease_state_machine
```

### task_leases

字段：

```text
task_id PRIMARY KEY
owner_id
lease_token UNIQUE
fencing_token
expires_at
heartbeat_at
released_at
updated_at
```

约束：

- `task_id` 引用 `tasks.id`，不可删除。
- `fencing_token > 0`。
- `lease_token` 全表唯一。
- Active Lease 必须有 owner、token、expiry，且 `released_at IS NULL`。
- Released Lease 必须清空 owner/token/expiry，并记录 `released_at`。
- Lease 行禁止 DELETE。
- `task_id` 不可修改。
- fencing token 不允许减小。
- `plan_steps` 增加 `version`，用于 CAS。

### 终态 Trigger

- Task 进入 `completed/failed/cancelled` 时不能存在 pending/unresolved
  RecoveryReview。
- Task 进入 `completed/failed/cancelled` 时不能存在尚未处理的 PlanStep：
  queued / running / awaiting_approval / waiting_review / interrupted。
- Task 进入 `completed/failed/cancelled` 时不能存在 queued /
  awaiting_approval / running / interrupted ToolRun。
- Task 进入 `completed/failed/cancelled` 时不能存在 pending Approval。
- Unknown Write 只有以下两种可追踪结论可以视为已处理：
  - confirmed_succeeded
  - confirmed_not_executed 且对应 PlanStep 已 failed
- 没有 RecoveryReview 的 unknown，以及 pending/unresolved Review，均阻止终态。
- completed 要求所有 PlanStep 为 completed 或 skipped，不能遗留 failed 或
  cancelled 的必要步骤。

数据库 CHECK 只验证枚举和数据形状，完整状态转换仍由
`ExecutionStateMachine` 和 CAS SQL 共同约束。

`ExecutionStateMachine`、`TaskRepository.updateStatus` 和
`TaskRepository.updateStatusCas` 共用 `assertTaskCanBecomeTerminal()`；SQLite
Trigger 使用同一组条件作为独立数据库防线。

ToolRun 终态分类：

| 分类 | 是否仍有活跃执行风险 |
| --- | --- |
| succeeded / failed / timed_out / cancelled / skipped | 否，已有确定结果 |
| unknown + confirmed_succeeded | 否，Review 已确认外部结果 |
| unknown + confirmed_not_executed 且 PlanStep failed | 否，已确认未执行 |
| unknown + pending / unresolved | 是，阻止任何终态 |
| unknown + 无 RecoveryReview | 是，阻止任何终态 |

## 3. TaskLeaseManager

接口：

```text
claim(taskId, ownerId)
heartbeat(taskId, leaseToken, fencingToken)
assertOwned(taskId, leaseToken, fencingToken)
release(taskId, leaseToken, fencingToken)
isExpired(taskId, leaseToken, fencingToken)
```

### Claim

- 在 `BEGIN IMMEDIATE` 同步事务中执行。
- completed / failed / cancelled Task 禁止 Claim。
- Lease Token 使用 `randomUUID()`。
- 使用一条 `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` 原子 Claim。
- 仅当原 Lease 已 Release 或 `expires_at <= now` 时允许抢占。
- 新 Claim 的 fencing token 为 `old fencing_token + 1`。
- 首次 Claim 的 fencing token 为 1。
- 两个独立连接同时 Claim 时，由 SQLite 写锁串行化且只有一个成功。
- 数据库 Trigger 同时拒绝 terminal Task 的 Lease Insert 或重新激活。

### Heartbeat

- 同时匹配 task_id、lease_token、fencing_token。
- 要求 `expires_at > now`。
- 过期 Lease 不能续期。
- 旧 Worker 不能续期新 Worker 的 Lease。

### Release

- 同时匹配 task_id、lease_token、fencing_token。
- 清空 owner、lease token 和 expiry。
- 保留 row、fencing token 和最后 heartbeat 时间。
- 记录 `released_at`。

### Event / Checkpoint

Event：

- lease.claimed
- lease.heartbeat
- lease.released

Checkpoint：

- Claim 创建 `lease_claimed` Checkpoint。
- Release 创建 `lease_released` Checkpoint。
- 普通 Heartbeat 只更新 Lease 并追加 Event，不创建 Checkpoint，避免周期性
  Heartbeat 写放大。
- Heartbeat Event 仍然保留，不因减少 Checkpoint 而删除。

Event payload 不包含 Lease Token。

## 4. Fencing Token

- fencing token 跨 Lease 生命周期单调递增。
- Release 不重置 fencing token。
- 下一次 Claim 从持久化值继续递增。
- 数据库 Trigger 拒绝 fencing token 减小。
- Old Worker 的 lease token 或 fencing token 不匹配时，Heartbeat、
  `assertOwned`、Release 和状态提交都会被拒绝。

边界：Fencing 只能保护 ForgeFlow 控制的 SQLite 状态和支持 Fencing 的外部
资源。它不能强制阻止不支持 fencing 的任意外部 API 接受旧请求。此类外部写仍需
幂等键、外部查询或人工核对。

## 5. Ownership Guard

`ExecutionStateMachine` 的每次写入必须提供：

```text
taskId
leaseToken
fencingToken
expectedTaskVersion
```

写入前依次验证：

1. Lease owner 非空。
2. Lease Token 匹配。
3. Fencing Token 匹配。
4. Lease 尚未过期。
5. Task 当前 version 等于 expectedTaskVersion。
6. 对 Task 转换，再验证 expected status。
7. 根据 mode 验证 ToolRun 转换。
8. 根据 PlanStep 状态机验证转换。

旧 Worker、过期 Lease、旧 Task version 或旧 ToolRun/PlanStep version 均不能
覆盖当前状态。

`ToolExecutionContext` 新增可选 `fencingToken`，供后续支持 Fencing 的工具
向下游资源转发。Step 4 不执行工具，也不接入 Scheduler。

## 6. ExecutionStateMachine

### TaskStatus

实现：

```text
queued -> running | cancel_requested
running -> pause_requested | cancel_requested | waiting_approval
        | waiting_review | completed | failed
pause_requested -> paused | waiting_review | cancel_requested
paused -> running | cancel_requested
cancel_requested -> cancelled | waiting_review
waiting_approval -> running | cancel_requested | failed
waiting_review -> running | failed | cancelled
completed / failed / cancelled -> terminal
```

补充：

- waiting_review 收到 cancel 只记录 cancel intent，状态保持 waiting_review。
- waiting_review -> running 时检查 cancel intent、active RecoveryReview、
  Unknown Write 核对状态和 confirmed_not_executed 对应的 PlanStep failed。
- 终态写入检查 active execution 和 active RecoveryReview。

### ToolRunStatus

Read：

```text
queued -> running | failed | skipped | cancelled
running -> succeeded | failed | timed_out | cancelled | interrupted
interrupted -> queued | failed | skipped | cancelled
```

Write：

```text
queued -> awaiting_approval | running | failed | skipped | cancelled
awaiting_approval -> queued | running | failed | skipped | cancelled
running -> succeeded | unknown
```

明确拒绝：

```text
running(write) -> failed
running(write) -> timed_out
running(write) -> cancelled
```

Write running 只剩 `succeeded` 和 `unknown`。工具异常、超时、取消、输出序列化
或 Result Commit 失败时的具体归类仍由后续执行集成层负责映射到 `unknown`。

### PlanStepStatus

实现：

```text
queued -> running | awaiting_approval | failed | skipped | cancelled
running -> completed | failed | cancelled | waiting_review | interrupted
interrupted -> running | failed | skipped | cancelled
awaiting_approval -> running | failed | skipped | cancelled
waiting_review -> completed | failed | cancelled
terminal -> 无后续状态
```

`waiting_review -> running` 保持禁止。

PlanStep 崩溃转换额外检查 kind 和关联 ToolRun mode：

- Read Batch：允许 `running -> interrupted`。
- Write：`running -> interrupted` 永远拒绝。
- Write ToolRun 已进入 unknown 后，PlanStep 才允许进入 waiting_review。
- Write 崩溃不能只标记 interrupted 后自动重试。

Step 3 的数据库 Trigger 继续作为第二道防线，拒绝存在 blocking ToolRun 时将
PlanStep 写成 completed。

## 7. CAS 状态更新

新增：

- `TaskRepository.updateStatusCas`
- `PlanStepRepository.updateStatusCas`
- `ToolRunRepository.transition` 支持 `expectedVersion`

更新 SQL 同时匹配当前状态和 version，不能只依赖事务前 SELECT。

并发 CAS 测试使用两个独立 Node 子进程和两个独立文件型 SQLite 连接，使用同一
Lease Token、fencing token 和 expected Task version 同时尝试 `queued -> running`：

- 恰好一个成功。
- 另一个返回状态/ version 冲突。
- 最终只有一条 `task.transitioned` Event。
- Task 不会互相覆盖。

## 8. 最终 TaskSnapshot

`TaskSnapshotReader.load()` 在单个 SQLite read transaction 中读取：

```text
task
lease
messages
model_calls
execution_plans
plan_steps
tool_runs
approvals
recovery_reviews
events
checkpoints
```

`lease` 为该 Task 当前 Lease 行；Task 尚未 Claim 时为 null。

WAL 双连接测试验证：

- Connection A 先读取 Task 后，Connection B Claim Lease。
- A 继续读取时 lease 仍为 null。
- A 的事务结束后重新读取才看到 B 的 Lease。

Step 3 的 PlanStep/ToolRun/Approval/RecoveryReview 并发快照测试继续通过。

综合快照测试中，Connection B 在 A 的 read transaction 内一次性提交：

```text
Lease
ExecutionPlan 状态
PlanStep
ToolRun
Approval
RecoveryReview
Message
Event
Checkpoint
```

A 在事务结束前继续读取仍看到起始快照；事务结束后才看到 B 的完整提交。

## 9. 测试清单

`tests/storage/task-lease.test.ts`（6 项）：

- Claim、Heartbeat、错误 Token、错误 Fencing
- Release 后重新 Claim 继续递增 Fencing
- Lease 过期后不能 Heartbeat/assertOwned，可被新 Claim 接管
- completed / failed / cancelled Claim 全部拒绝
- Claim Event 失败整体 rollback
- Heartbeat/Release Event 失败整体 rollback
- 两个独立进程并发 Claim，仅一个成功

`tests/storage/execution-state-machine.test.ts`（11 项）：

- TaskStatus 全矩阵
- Read/Write ToolRun 全矩阵
- PlanStepStatus 全矩阵
- Ownership 与旧 Task version 拒绝
- 两个独立连接并发 CAS 只有一个成功
- Read/Write ToolRun 实际状态写入
- PlanStep CAS 与 completed active execution 拒绝
- active RecoveryReview、cancel intent、recovery resume 保护
- Read running -> interrupted 与 Write 崩溃进入 waiting_review 的对照
- failed / cancelled 终态 active work 与 pending Approval 拒绝
- confirmed_succeeded 与 confirmed_not_executed 可终止，pending/unresolved
  不可终止，且原始 ToolRun 始终保持 unknown

`tests/storage/step4-schema.test.ts`（3 项）：

- task_leases 字段、PlanStep version、Lease/终态 Trigger
- Lease 行不可删除、Fencing 不回归、Release 保留 Fencing
- 绕过应用层直接 SQL 更新 terminal Task 时，SQLite Trigger 仍拒绝 active
  PlanStep 和未完成必要步骤

`tests/storage/snapshot-concurrency.test.ts`（3 项）：

- 基础 Snapshot 一致性
- Lease 单一 WAL 快照
- Step 3 执行表单一 WAL 快照

`tests/tools/registry.test.ts`：

- ToolExecutionContext 可传递 fencingToken

## 10. 实际执行结果

- `pnpm test`：28 个测试文件、207 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1 / Phase 2 以及 Phase 3 Step 1 / Step 2 / Step 3 的原有测试继续包含在
全量测试中并通过。

## 11. 已知限制

- SQLite WAL 和 Lease 适用于同机进程；不是跨主机分布式 Lease。
- Fencing 不能强制限制不支持 fencing 的外部 API。
- Lease 过期采用惰性检查：Heartbeat/assertOwned/Claim 时判断，不运行后台
  expiry sweeper。
- 普通 Heartbeat 不创建 Checkpoint；长期 Heartbeat 历史保存在 Event 中。
- Task 进入终态后不会自动 Release 当前 Lease；完整生命周期编排留给 Step 5。
- 状态机是低层持久化接口，尚未接入 AgentRunner / TaskScheduler。
- ToolRun `unknown` 后缺少可信结果时的 Read-back 编排属于 Step 6。
- 没有完整 Pause / Resume / Cancel 编排、RecoveryManager 或自动恢复。

## 12. 阶段边界声明

本次只完成 Phase 3 Step 4。

- 没有实现 AgentRunner 持久化集成。
- 没有实现 TaskScheduler 持久化集成。
- 没有实现 RecoveryManager。
- 没有实现完整 Pause / Resume / Cancel 编排。
- 没有实现自动恢复工具执行。
- 没有进入 Step 5 或 Step 6。
