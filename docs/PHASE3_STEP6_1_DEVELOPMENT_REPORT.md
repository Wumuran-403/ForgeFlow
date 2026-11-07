# Phase 3 Step 6.1 Development Report

> 状态：RecoveryManager Foundation 完成
>
> 范围：Recovery 扫描、原子 Claim、Snapshot 检查、分类、RecoveryReport、
> inspection Event/Checkpoint
>
> 边界：只检查，不执行恢复动作

## 1. 修改与新增文件

Recovery：

- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-scanner.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-types.ts`
- `src/recovery/index.ts`

Storage：

- `src/storage/task-lease-manager.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/index.ts`

测试：

- `tests/recovery/recovery-classifier.test.ts`
- `tests/recovery/recovery-manager.test.ts`
- `tests/recovery/recovery-inspect-worker.ts`

文档：

- `docs/PHASE3_STEP6_1_DEVELOPMENT_REPORT.md`

没有修改 AgentRunner、TaskScheduler、Provider 或 Tool 执行逻辑。

## 2. RecoveryScanner

扫描条件：

- Task 非 completed/failed/cancelled。
- 没有 Lease。
- Lease 已释放。
- Lease 已过期。

有效 Lease 不会进入候选列表。

候选结构：

```text
taskId
status
traceId
leaseState = missing | released | expired
fencingToken
```

Scanner 只读，不 Claim、不修改 Task，也不代表已获得执行权。

## 3. RecoveryManager

接口：

```text
scan()
recoverTask(taskId, ownerId)
inspectTask(taskId, ownerId)
inspectCandidates(ownerId)
claimInspectionLease(taskId, ownerId)
inspectOwnedTask(ownership)
releaseInspectionLease(ownership)
```

`inspectTask`：

```text
atomic Claim
  -> load TaskSnapshot
  -> Lease Ownership check
  -> RecoveryClassifier
  -> recovery.inspected Event
  -> recovery_inspected Checkpoint
  -> release Lease
```

`recoverTask` 在 Step 6.1 中只是 inspection alias，不执行恢复动作。

`inspectTask` 自己拥有 Claim/Release 生命周期。
`claimInspectionLease` / `inspectOwnedTask` / `releaseInspectionLease` 提供给后续
恢复阶段和确定性并发测试使用，调用方负责成对释放。

Claim 失败时不得绕过 Lease 读取后继续执行。`inspectCandidates` 会跳过
`TASK_LEASE_UNAVAILABLE`，但其他错误仍向上传播。

## 4. Lease 与 Ownership

- 恢复检查必须先通过 TaskLeaseManager 原子 Claim。
- Claim 使用 `BEGIN IMMEDIATE` 和 fencing token。
- Snapshot 检查与 inspection 记录继续验证 Lease Token / fencing token。
- inspection Event 写入验证 expected Task version。
- 检查成功或失败都会尝试 Release。
- Release 失败返回明确错误，不静默忽略。

TaskLeaseManager 的 Claim/Heartbeat/Release 路径改为读取 Lease 所需的原始 Task
字段，不再解析 token usage 等 JSON。这样即使 Task JSON 已损坏，也仍能获取
Lease、生成 `state_inconsistent` 报告并安全释放 Lease。

## 5. RecoveryClassifier

分类：

```text
safe_to_resume
read_interrupted
write_outcome_unknown
model_call_interrupted
approval_pending
review_pending
pause_pending
cancel_pending
state_inconsistent
```

识别规则：

- requested/interrupted ModelCall -> model_call_interrupted。
- running/interrupted Read -> read_interrupted。
- queued Read -> 不进入 read_interrupted，记录
  `QUEUED_READ_NOT_STARTED` informational finding。
- running/unknown Write -> write_outcome_unknown。
- queued Write 不进入 write_outcome_unknown，并按审批事实记录：
  - requiresApproval=false -> `QUEUED_WRITE_NOT_STARTED`
  - Approval approved -> `QUEUED_WRITE_APPROVED_NOT_STARTED`
  - Approval pending / 尚无决定 -> `QUEUED_WRITE_APPROVAL_PENDING`
  - Approval rejected/expired/cancelled -> `QUEUED_WRITE_APPROVAL_INVALID`
- awaiting_approval 或 pending Approval -> approval_pending。
- pending/unresolved RecoveryReview 或 waiting_review PlanStep -> review_pending。
- pause intent / pause_requested -> pause_pending。
- cancel intent / cancel_requested -> cancel_pending。

一致性检查：

- ToolRun 引用缺失 PlanStep。
- PlanStep mode 与 ToolRun mode 不一致。
- completed PlanStep 含活跃 ToolRun。
- Tool Message 引用不存在的 assistant Tool Call。
- 当前 Tool version / mode / approval policy 与 ToolRun 不一致。
- input schema hash / canonical input hash 不一致。
- Approval 与 ToolRun version/input hash 不匹配。
- RecoveryReview 没有指向 unknown Write。
- waiting_approval 无 pending Approval。
- waiting_review 无 active RecoveryReview。
- Snapshot JSON 无法解码。

分类包含结构化 findings，不只返回布尔值。

## 6. 状态优先级

统一优先级：

1. state_inconsistent
2. cancel_pending
3. write_outcome_unknown
4. review_pending
5. approval_pending
6. pause_pending
7. model_call_interrupted
8. read_interrupted
9. safe_to_resume

即使存在多个问题，所有 findings 都保留；`primaryClassification` 只表达处理
优先级。

已测试：

- state inconsistency 高于 cancel/read/model。
- cancel 高于普通 Resume。
- Write unknown 高于 Read interrupted。
- 多异常时 findings 不丢失。

## 7. RecoveryReport

```text
taskId
classification
primaryClassification
findings[]
blockingReasons[]
recommendedNextAction
inspectedAt
fencingToken
```

Finding 只包含：

- classification
- safe error code
- 脱敏摘要
- entity type
- entity ID

不包含 Model Request、Tool Input、User Message 正文、API Key、Authorization
Header 或工具凭证。

## 8. Event / Checkpoint

成功检查追加：

```text
Event: recovery.inspected
Checkpoint: recovery_inspected
```

两者在同一 UoW 事务中提交。Event payload 只包含：

- classification
- finding count
- recommended action
- fencing token

Checkpoint 保存 Task 状态、Message/Event sequence、Plan Version、预算快照。

Snapshot JSON 损坏时，使用不解析 Snapshot 的安全记录路径，仅读取 Lease 检查
所需的原始 Task 字段，避免覆盖原始损坏数据。

## 9. 测试矩阵

`tests/recovery/recovery-classifier.test.ts`（6 项）：

- safe_to_resume
- 多 findings 与固定优先级
- state inconsistency / cancel priority
- ModelCall / Approval / Review / Pause / Cancel 识别
- 报告不含 Tool Input 或 Message 正文
- 优先级函数独立测试

`tests/recovery/recovery-manager.test.ts`（10 项）：

- queued / abandoned running 扫描
- 有效 Lease 排除
- released / expired Lease 扫描
- Read / Write / Model / Approval / Review / Pause / Cancel 分类
- Tool Version mismatch -> state_inconsistent
- 损坏 Snapshot JSON -> state_inconsistent
- Event / Checkpoint 同事务
- Checkpoint 失败时 Event rollback
- expired Lease 重新 Claim 与 fencing 递增
- 两个独立 RecoveryManager 并发 Claim 只有一个成功
- queued Read/Write、pending/approved/rejected Approval、running/interrupted
  Read、running/unknown Write 的对照分类
- 多个 queued ToolRun findings 不丢失，且不会执行 Provider/Tool

Recovery 检查不会调用 Provider 或 Tool。

## 10. queued ToolRun 协议核查

已核查 Step 5 持久化执行顺序：

```text
Plan 创建 -> ToolRun queued
beforeExecute
  -> assertOwned
  -> Tool Intent Commit
  -> ToolRun queued -> running
  -> 调用外部 Tool
```

因此 queued 仅表示尚未进入实际执行，不能视为 interrupted 或 Unknown。
Step 6.1 只记录结构化 finding，不执行 queued ToolRun。真正启动策略留给
Step 6.2。

当前 Step 5 实现满足上述 Intent-before-external-call 顺序。

## 11. 实际执行结果

- `pnpm test`：31 个测试文件、242 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1 / Phase 2 / Phase 3 Step 1–5 全部回归测试继续通过。

## 12. 尚未实现

- Read 自动重试。
- Write unknown 转换或人工核对。
- Model Call 新 Attempt 创建。
- Provider 重新调用。
- Pause / Resume / Cancel 完整编排。
- safe_to_resume Task 自动执行。
- RecoveryManager 自动调用 AgentRunner。
- MCP、真实 DeepSeek Provider、Dashboard。

## 13. 待后续阶段确认

- Step 6.2 需要明确 queued ToolRun 是原计划继续、重新规划还是取消。
- approved 的 queued Write 需要 Lease/Fencing 和 Scheduler 重新取得执行权后才能
  启动。
- rejected/expired/cancelled Approval 对应的 queued/skipped 记录如何清理，
  留给后续恢复计划。

## 14. 阶段边界声明

本次只完成 Phase 3 Step 6.1。

没有开始 Step 6.2，也没有实现任何自动恢复、工具重试或 Provider 重试。
