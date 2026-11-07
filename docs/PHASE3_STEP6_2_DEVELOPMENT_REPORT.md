# Phase 3 Step 6.2 Development Report

> 状态：Read Recovery 完成
>
> 范围：running/interrupted/queued Read 安全恢复、Intent/Result 持久化、
> Read Batch 并行、Lease Heartbeat、阻塞 Gate
>
> 边界：不执行 Write，不调用 Provider，不进入 Step 6.3

## 1. 修改与新增文件

Recovery：

- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-types.ts`
- `src/recovery/index.ts`

Persistence / Storage：

- `src/persistence/lease-heartbeat.ts`
- `src/persistence/coordinator.ts`
- `src/persistence/execution-bridge.ts`
- `src/persistence/index.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/index.ts`

测试：

- `tests/recovery/read-recovery.test.ts`
- `tests/recovery/recovery-classifier.test.ts`
- `tests/recovery/recovery-manager.test.ts`

文档：

- `docs/PHASE3_STEP6_2_DEVELOPMENT_REPORT.md`

## 2. Read Recovery 流程

新增：

```text
RecoveryManager.recoverReadRuns(taskId, ownerId)
```

流程：

```text
atomic Claim Lease
  -> start shared LeaseHeartbeat
  -> recovery.inspected
  -> RecoveryClassifier / block checks
  -> find earliest unfinished PlanStep
  -> require read_batch barrier
  -> validate persisted ToolRun definition
  -> requeue running/interrupted Read
  -> ReadWorkerPool
       -> assertOwned
       -> Tool Intent Commit
       -> queued/running
       -> external Read
       -> atomic Tool Result + Tool Message
  -> recovery.read_retried / recovery.read_completed
  -> stop Heartbeat
  -> Release Lease
```

没有调用 Provider，也没有执行任何 Write。

## 3. ToolRun 状态处理

### succeeded

- 不进入 ReadWorkerPool。
- 不重写 Tool Message。
- 必须存在且仅存在一条对应 Tool Message。
- 缺失或重复时 `state_inconsistent`。

### running(Read)

```text
running -> interrupted -> queued -> running -> result
```

- 使用新 Claim 的 Lease Token / fencing token。
- 保留 ToolRun ID、Call ID、originalIndex、Tool Version、各 Hash 和
  idempotency key。
- `requeuedCount` 每个 ToolRun 只记一次。

### interrupted(Read)

```text
interrupted -> queued -> running -> result
```

可以直接重试，不新建 ToolRun。

### queued(Read)

- 视为尚未启动的首次执行。
- 不伪造 interrupted 事件。
- 仍必须先完成 Tool Intent Commit。

### failed / timed_out / cancelled / skipped

- 已有明确终态，不自动重试。
- 终态 PlanStep 不阻止 Read Recovery 判定为 no_work。
- 正常终态必须恰好存在一条 Tool Message。
- 缺少或重复 Tool Message 时 RecoveryClassifier 标记 `state_inconsistent`。

## 4. Recovery Gate

只允许：

```text
safe_to_resume
read_interrupted
```

任何 findings 含以下分类时拒绝：

- state_inconsistent
- cancel_pending
- write_outcome_unknown
- review_pending
- approval_pending
- pause_pending
- model_call_interrupted

queued Read 的 `QUEUED_READ_NOT_STARTED` 是 informational finding，不阻塞。

进行最早的未完成 PlanStep 判断时：

- 必须是 read_batch。
- Write Barrier 未完成时拒绝。
- 不允许跨越 write / unknown_tool PlanStep 执行后续 Read。
- completed PlanStep 中的 Read 不重复执行。

## 5. Tool Definition 一致性

每次 Read 恢复前检查：

- Tool 仍存在。
- mode = read。
- toolVersion 与 ToolRun 相同。
- inputSchemaHash 相同。
- canonicalInputHash 相同。
- requiresApproval 相同。
- 当前 Zod input validation 通过。

任一 Hash 或版本不一致会在 Tool 函数调用前阻止恢复并返回
`READ_RECOVERY_BLOCKED`。不会使用新工具版本执行旧 ToolRun。

## 6. Intent / Result 原子性

- 外部 Read 调用前必须先通过 ExecutionStateMachine/UoW 提交 Intent。
- Intent 失败时 Read 函数调用次数为零。
- 成功后通过 `PersistentExecutionBridge.persistReadResult` 和 UoW 原子提交：
  - ToolRun terminal
  - Tool Message
  - PlanStep 更新
  - Event
  - Checkpoint
- Result Commit 失败时：
  - 不返回成功 Tool Message。
  - 不请求 Provider。
  - 保留 running Intent。
  - Lease 仍会被安全清理。

Read 工具正常抛错时按现有 Read 语义持久化 failed，并保留与其他 Read 的独立结果。

Tool Message 一致性由 RecoveryClassifier 检查：

- queued / running / interrupted：不要求 Tool Message。
- succeeded / failed / timed_out / cancelled / skipped：必须恰好一条。
- Tool Message 必须属于同一 Task，并通过 `toolCallId` 对应 ToolRun。

## 7. Read Batch 并发与顺序

复用现有 ReadWorkerPool：

- 默认最大并发数不变。
- 已成功 Read 不进入 Worker。
- 只调度 queued/interrupted/running 的可恢复 Read。
- 单 Read 失败不取消同批其他 Read。
- 结果持久化按 originalIndex 顺序，而不是 Promise 完成顺序。

测试使用反向延迟证明第二个 Read 先完成时，Tool Message 仍按原始顺序写入。

## 8. Lease / Heartbeat

- 复用 Step 5 的 `LeaseHeartbeat`，没有第二套 Lease 续租逻辑。
- `LeaseHeartbeat` 与 Result Commit 共享同一个 `ExecutionAuthority`。
- Heartbeat 失败时先同步设置 revoked 状态，再触发 AbortSignal。
- Model/Intent/Result Commit 前检查本地执行权。
- UoW owned 事务接收 authority guard，并在事务内部再次检查。
- 本地 revoked 检查与同步 SQLite 提交之间没有 await 窗口。
- Claim 后启动 Heartbeat。
- Provider 不存在；Heartbeat 覆盖 Read 执行、Intent 和 Result Commit。
- Heartbeat 失败：
  - Abort ReadWorkerPool context。
  - 不启动新的 Read。
  - 活跃 Read 根据 AbortSignal 收尾。
  - 即使数据库 Lease 仍然有效，所有终态 Result Commit 也被本地执行权拒绝。
  - 数据库 `assertOwned` / fencing 检查继续保留。
  - running Intent 留给后续恢复扫描。
- 执行结束先停止 Heartbeat，再 Release Lease。
- Release 失败显式返回错误。

## 8.1 PlanStep / ToolRun 异常组合

RecoveryClassifier 额外识别：

```text
非终态 PlanStep
+ 所有关联 ToolRun 已终态
+ 无 Approval / RecoveryReview 合法阻塞
```

该组合标记为 `NON_TERMINAL_STEP_WITH_TERMINAL_RUNS` 和
`state_inconsistent`，不会自动修改或执行数据。

## 9. 阻塞策略

以下存在时恢复直接拒绝：

- cancel intent
- pause intent
- active RecoveryReview
- Unknown Write
- requested/interrupted Model Call
- approval pending
- state inconsistent / Tool Definition changed
- 前序 Write Barrier 未完成

不会自动处理 Write、Approval 或 Model Call。

## 10. 测试矩阵

`tests/recovery/read-recovery.test.ts`（17 项）：

- running Read crash -> interrupted -> queued -> succeeded
- interrupted Read 重试
- queued Read 首次执行
- succeeded / failed / timed_out / cancelled / skipped 不重试
- succeeded Read 缺少 Tool Message -> state inconsistent
- Tool Version / Schema Hash / Input Hash mismatch
- Zod input validation 失败
- Intent Commit 失败时 Tool 调用次数为零
- Result Commit 失败不返回成功结果
- Read Batch 实际并行及 originalIndex 顺序
- 单 Read 失败不影响同批成功 Read
- cancel / pause / active review / unknown write / model call / approval pending /
  write barrier 全部阻塞
- Heartbeat 失败后不启动新 Read
- Heartbeat 失败时工具忽略 Abort 后仍无法提交 Result
- Heartbeat 失败后工具抛错仍无法提交 failed Result
- Lease 被替换后旧 Worker 无法提交 Result
- Read Recovery -> Lease Release -> PersistentCoordinator 接管 -> 下一次
  Model Call 的端到端生命周期

`tests/recovery/recovery-classifier.test.ts` 新增：

- 所有终态 ToolRun 的 Tool Message 唯一性
- queued/running/interrupted 允许无 Tool Message
- 非终态 PlanStep + 全终态 ToolRun -> state_inconsistent

`tests/recovery/recovery-manager.test.ts` 与 `recovery-classifier.test.ts` 的
Step 6.1 回归继续通过。

## 11. 实际执行结果

- `pnpm test`：32 个测试文件、262 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1 / Phase 2 / Phase 3 Step 1–5 / Step 6.1 全部回归通过。

## 12. 尚未实现

- Write Recovery。
- Unknown Write 自动/人工核对。
- Model Call Recovery / 新 Attempt。
- 完整 Pause / Resume / Cancel 编排。
- Read Recovery 完成后自动生成下一次 Provider 请求。
- MCP、真实 DeepSeek Provider、Dashboard。

## 13. 阶段边界声明

本次只完成 Phase 3 Step 6.2。

没有执行 Write Recovery，没有实现 Unknown Write Review 自动化，没有实现
Model Call Recovery，也没有实现完整 Pause / Resume / Cancel。

没有进入 Step 6.3。
