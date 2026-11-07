# Phase 3 Step 6.2 Supplementary Review

> 审查类型：只读架构与安全审查
>
> 结论摘要：原审查发现的问题已在 Step 6.2.1 补充修复中解决。
> 执行权撤销、终态 Tool Message 一致性、PlanStep 异常组合和生命周期衔接均已补齐。
> 建议正式验收 Step 6.2。

## 1. 审查范围与实际读取的源码

本次实际读取：

- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-types.ts`
- `src/recovery/recovery-scanner.ts`
- `src/persistence/coordinator.ts`
- `src/persistence/execution-bridge.ts`
- `src/persistence/lease-heartbeat.ts`
- `src/persistence/recovery-gate.ts`
- `src/storage/execution-state-machine.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/task-snapshot.ts`
- `tests/recovery/read-recovery.test.ts`
- `tests/recovery/recovery-manager.test.ts`
- `tests/integration/persistent-execution.test.ts`

没有修改生产代码，没有修改数据库 Schema，没有执行 Write Recovery，也没有调用真实
Provider。

## 2. Task 生命周期衔接结论

### 2.1 Read Recovery 后 Task.status

`RecoveryManager.recoverReadRuns()` 在 `src/recovery/recovery-manager.ts:109`
启动恢复。

`executeReadRecovery()` 只在 Task 原状态为 `queued` 时执行：

```text
queued -> running
```

如果 Task 已经是 `running`，不会再次执行 Task 状态转换。

Read Batch 完成后：

- 更新 ToolRun/PlanStep、Tool Message、Event、Checkpoint。
- 不把 Task 自动标记为 completed。
- Task 通常保持 `running`。

结论：Read Recovery 成功后 Task.status 为 `running`。

### 2.2 no_work 时 Task.status

`executeReadRecovery()` 在没有未完成 PlanStep，或最早 unfinished PlanStep 没有
可恢复 Read ToolRun 时返回 `no_work`，不修改 Task.status。

因此：

- 原 queued Task 仍为 queued。
- 原 running Task 仍为 running。

### 2.3 Lease 释放

`recoverReadRuns()`：

1. 停止 Heartbeat。
2. 调用 `releaseInspectionLease()`。
3. 只有 Release 成功才正常返回。

Release 失败会返回 `RECOVERY_LEASE_RELEASE_FAILED`。源码位置：

- `src/recovery/recovery-manager.ts:142`
- `src/recovery/recovery-manager.ts:146`
- `src/recovery/recovery-manager.ts:561`

结论：Read Recovery 正常完成后 Lease 已释放。

### 2.4 PersistentCoordinator 后续接管

`PersistenceCoordinator.executeOwned()` 允许：

```text
queued / running
```

只有 queued 时执行 `queued -> running`；running 直接进入 AgentRunner：

- `src/persistence/coordinator.ts:157`
- `src/persistence/coordinator.ts:167`
- `src/persistence/coordinator.ts:175`

所以不存在“只允许 queued -> running，因此 running 无法接管”的限制。

### 2.5 Recovery Gate 是否允许后续 Provider 请求

Read Recovery 正常完成后：

- 原 requested Model Call 已不存在。
- Read ToolRun 为 succeeded/failed 等终态。
- 当前 Read Batch PlanStep 为 completed。
- 无 running/interrupted/unknown Write。
- 无 pending Approval / active RecoveryReview。

此时 `assertSafeToStartPersistentRun()` 允许 Task 进入正常的
`PersistenceCoordinator.run()`，可以创建下一次 Model Call。

补充修复新增了 Read Recovery -> PersistentCoordinator 的集成测试，使用 Mock
Provider 验证下一次 Model Call 能够正常创建，不调用真实 Provider。

### 2.6 PlanStep 异常组合：原始发现与修复后结论

原始审查曾发现：

```text
PlanStep 非终态
+ 其所有 ToolRun 都已是终态
+ 没有 Write / Review / Approval 阻塞
```

该组合当时可能返回 no_work，同时被 Recovery Gate 阻止。

修复后：

- RecoveryClassifier 新增
  `NON_TERMINAL_STEP_WITH_TERMINAL_RUNS` finding。
- 此类组合的 primary classification 为 `state_inconsistent`。
- RecoveryManager 不会返回 no_work，也不会自动修改 PlanStep。
- 不会补写 Tool Message，不会执行 ToolRun。
- awaiting_approval、waiting_review 以及存在 Approval/RecoveryReview 的合法等待
  状态不会被误判。

对应测试：

- `tests/recovery/recovery-classifier.test.ts:311`

### 2.7 Read Recovery 到 Coordinator 的 E2E 验证

修复后新增直接测试：

```text
running Read Recovery
  -> Result Commit
  -> PlanStep completed
  -> Heartbeat stopped
  -> Lease released
  -> PersistentCoordinator.run()
  -> new Lease / fencing=2
  -> next Model Call iteration=2
```

测试同时验证：

- 下一次 Model Call 持久化为 completed。
- 旧 Read 不重复执行。
- Tool Message 不重复。
- Recovery Gate 未被绕过。

对应测试：

- `tests/recovery/read-recovery.test.ts:724`

## 3. ToolRun / Tool Message 一致性矩阵

| ToolRun 状态 | Tool Message 规则 | 当前实现 |
| --- | --- | --- |
| queued | 不要求 | 未启动，正确 |
| running | 不要求 | 执行中，正确 |
| interrupted | 不要求 | 等待恢复，正确 |
| succeeded | 必须恰好 1 条 | UoW 创建；Classifier 检查 |
| failed | 必须恰好 1 条 | UoW 创建；Classifier 检查 |
| timed_out | 必须恰好 1 条 | UoW 创建；Classifier 检查 |
| cancelled | 必须恰好 1 条 | UoW 创建；Classifier 检查 |
| skipped | 必须恰好 1 条 | UoW 创建；Classifier 检查 |

### 3.1 UoW 原子写入

普通工具结果通过 `completeOwnedToolRun()` 写入：

- `src/storage/execution-unit-of-work.ts:1481`
- `src/storage/execution-unit-of-work.ts:1534`

未启动工具结果通过 `finalizeOwnedToolRunBeforeStart()` 写入：

- `src/storage/execution-unit-of-work.ts:1608`
- `src/storage/execution-unit-of-work.ts:1644`

ToolRun 终态、Tool Message、PlanStep、Event、Checkpoint 在同一事务内。

数据库还有：

```text
UNIQUE(task_id, tool_call_id) WHERE role = 'tool'
```

因此正常路径下不会产生重复 Tool Message。

### 3.2 RecoveryClassifier 检查范围

当前对以下终态统一检查：

```text
succeeded
failed
timed_out
cancelled
skipped
```

检查规则：

- Tool Message 必须属于同一 Task。
- `toolCallId` 必须对应 ToolRun。
- 必须恰好存在一条。
- 缺失或重复均产生 state_inconsistent finding。
- queued / running / interrupted 不要求 Tool Message。

对应源码：

- `src/recovery/recovery-classifier.ts`

对应测试：

- `tests/recovery/recovery-classifier.test.ts:238`
- `tests/recovery/recovery-classifier.test.ts:292`

### 3.3 结论

- 五种终态均严格要求恰好一条 Tool Message。
- queued / running / interrupted 允许没有 Tool Message，符合执行语义。
- 终态缺少 Tool Message 时 RecoveryClassifier 会标记 state_inconsistent。
- 重复 Tool Message 同时受数据库唯一索引和 Classifier 检查保护。
- Classifier 不补造 Tool Message，也不重新执行终态 ToolRun。

## 4. Lease / Heartbeat 故障场景矩阵

| 场景 | 当前行为 | 结论 |
| --- | --- | --- |
| A. Result Commit 成功，Release 成功 | 正常返回，Lease owner 清空 | 安全 |
| B. Read 成功，Commit 失败，Lease 仍有效 | local authority 有效但 Commit 失败；Result 回滚；停止 Heartbeat 后 Release | 安全；running Intent 可被扫描 |
| C. Commit 失败，Lease 已丢失 | local authority 或 UoW assertOwned/fencing 拒绝；旧 Release 失败；新 Lease 不受影响 | 安全 |
| D. Heartbeat 失败，Read 仍在执行 | 先 revoke 本地执行权，再 Abort；等待底层 Promise settle | 安全 |
| E. 工具忽略 Abort，迟到 Result | local ExecutionAuthority 已 revoked，迟到 Result Commit 被拒绝；Worker Promise settle 后才清理 | 安全 |
| F. 旧执行者 Release | release SQL 同时匹配 token/fencing | 不可能释放新执行者 Lease |

### 4.1 Result Commit 失败

`PersistentExecutionBridge.persistReadResult()`：

- `src/persistence/execution-bridge.ts:256`

失败会向 ReadWorkerPool 抛错。UoW 回滚后 ToolRun 仍为 running，Tool Message 不写入。
`recoverReadRuns()` 外层最终停止 Heartbeat 并 Release。

`tests/recovery/read-recovery.test.ts:342` 验证：

- Read 只执行一次。
- 没有成功 Tool Message。
- running Intent 保留。
- Lease 最终释放。

由于 Task 非终态且 Lease Released/Missing，RecoveryScanner 后续可以识别
running Read。

### 4.2 Lease 已丢失

`PersistentExecutionBridge` 在 Result Commit 前同时依赖：

- 本地 `ExecutionAuthority` guard。
- UoW 内部 `TaskLeaseManager.assertOwned`。
- fencing token 校验。

旧 Worker 的 Result Commit：

- 本地 authority 若已 revoked -> 拒绝。
- 数据库 Lease 已被替换 -> assertOwned / fencing 拒绝。
- 旧 fencing token 不匹配 -> 拒绝。
- 旧 Release 不会删除新 Lease。

`tests/recovery/read-recovery.test.ts:613` 验证旧 Worker 无法提交 Result。

### 4.3 Heartbeat 停止与 Release 顺序

`recoverReadRuns()` 在 Release 前：

```text
await heartbeat.stop()
releaseInspectionLease()
```

Heartbeat 为同步 SQLite 调用，不会存在跨 await 的并发回调。停止后不会再写
Heartbeat Event。

Release 失败：

- 有主错误时 -> AggregateError。
- 无主错误时 -> `RECOVERY_LEASE_RELEASE_FAILED`。

不会静默吞掉 Release 错误。

### 4.3.1 本地执行权与数据库所有权

两层检查职责不同：

- `ExecutionAuthority`：立即撤销当前进程/执行上下文的本地提交资格。
- `TaskLeaseManager.assertOwned` + fencing token：验证数据库中的当前执行所有权。

本地 guard 不能替代数据库 guard；数据库 guard 也不能替代 Heartbeat 失败后的
本地撤销，因为瞬时 Heartbeat 失败时数据库 Lease 可能仍然有效。

### 4.4 Lease 已释放但 Worker 仍运行

RecoveryManager 使用 `await readWorkerPool.execute(...)`，ReadWorkerPool 会等待
所有已启动工具 Promise 真正 settle，之后才返回。

因此正常控制流不会在底层 Read Promise 仍运行时主动 Release Lease。

如果工具永久忽略 Abort 且永不 settle，Recovery 的 Promise 会持续等待，
Heartbeat 也继续维持 Lease；不会提前释放仍被占用的 Lease。只有进程真正退出或
Heartbeat 停止后，Lease 才可能过期。

## 5. 已确认问题与修复状态

本节保留 Step 6.2 原始审查的四个问题。下文“触发条件/结果”描述原始问题，
修复状态反映当前源码和测试。

### 原始问题 1：Heartbeat 失败与数据库 Lease 失效不是同一件事（已修复）

严重性：高

源码：

- `src/persistence/lease-heartbeat.ts:10`
- `src/persistence/lease-heartbeat.ts:38`
- `src/persistence/lease-heartbeat.ts:97`
- `src/storage/task-lease-manager.ts:202`
- `src/persistence/execution-bridge.ts:267`
- `src/persistence/execution-bridge.ts:275`
- `src/recovery/recovery-manager.ts:129`

原始触发条件：

1. Heartbeat 因非 ownership 原因抛错，例如瞬时 SQLite/内部错误。
2. Lease 数据库行仍然有效，token/fencing 未变化。
3. Read 工具忽略 AbortSignal 并迟到返回。
4. `LeaseHeartbeat` 设置本地 failure 并 abort，但 DB Lease 没有失效。
5. ReadWorker 可能以 `cancelled` 结果完成，UoW assertOwned 仍会通过。

原始结果：

- 旧 Worker 在本地“已失去执行权”的语义下仍可提交 cancelled Tool Result。
- 随后 `recoverReadRuns()` 会检测 heartbeat.failure 并抛错，但 DB 已有迟到结果。

这不等同于 stale fencing 提交，因为数据库 Lease 实际仍属于该 Worker；但它与
“Heartbeat 失败即停止提交”的安全语义存在歧义。

修复状态：已解决。

采用方案：Local heartbeat failure 必须使 Result Commit 拒绝。

- 新增共享 `ExecutionAuthority`。
- Heartbeat 失败先同步 revoke，再触发 AbortSignal。
- Model / Intent / Result Commit 均检查本地执行权。
- UoW owned 事务内部再次执行 authority guard。
- 即使数据库 Lease 尚有效，revoked Worker 也无法提交任何终态 Result。

### 原始问题 2：非 succeeded 终态缺少 Tool Message 一致性检查（已修复）

严重性：中

源码：

- `src/recovery/recovery-classifier.ts:501`
- `src/storage/execution-unit-of-work.ts:1481`
- `src/storage/execution-unit-of-work.ts:1608`

原始触发条件：

- failed / timed_out / cancelled / skipped ToolRun 因数据损坏或绕过 UoW 的人工
  修改而丢失 Tool Message。

原始审查时 RecoveryClassifier 只检查 succeeded，上述状态可能不进入
state_inconsistent。

正常 UoW 事务不会产生该组合；问题主要属于恢复器和损坏数据检测缺口。

修复状态：已解决。

- succeeded / failed / timed_out / cancelled / skipped 均要求恰好一条 Tool Message。
- 同时检查 Task 归属与 toolCallId 对应关系。
- queued / running / interrupted 仍允许没有 Tool Message。

### 原始问题 3：缺少 Read Recovery 到下一次正常 Model Call 的端到端测试（已修复）

严重性：低

原始审查时源码衔接条件成立，但没有测试直接验证：

```text
recoverReadRuns
  -> Lease release
  -> PersistentCoordinator.run
  -> next Model Call requested
```

修复状态：已解决。

新增端到端测试验证：

```text
running Read Recovery
  -> Result Commit
  -> PlanStep completed
  -> Heartbeat stopped
  -> Lease released
  -> PersistentCoordinator.run
  -> new Lease / fencing=2
  -> next Model Call iteration=2
```

### 原始问题 4：非终态 PlanStep + 全终态 ToolRun 未归类为 state_inconsistent（已修复）

严重性：低

源码：

- `src/recovery/recovery-manager.ts:287`
- `src/recovery/recovery-classifier.ts`
- `src/persistence/recovery-gate.ts:4`

修复状态：已解决。

RecoveryClassifier 新增 `NON_TERMINAL_STEP_WITH_TERMINAL_RUNS`，分类为
`state_inconsistent`，不会自动修改 PlanStep 或执行 ToolRun。

## 6. 未发现问题的项目与对应测试

- running Read -> interrupted -> queued -> succeeded：
  `tests/recovery/read-recovery.test.ts:55`
- interrupted / queued Read 恢复：
  同一测试文件中的 interrupted/queued 场景
- succeeded 不重复执行及 succeeded 缺 Tool Message 识别：
  terminal 与 missing-message 测试
- Tool Version / Schema Hash / Input Hash / Zod 校验：
  guard tests
- Intent Commit 失败工具调用次数为零：
  intent test
- Result Commit 失败不返回成功结果：
  `tests/recovery/read-recovery.test.ts:349`
- Read Batch 并行与 originalIndex 顺序：
  `tests/recovery/read-recovery.test.ts:384`
- cancel/pause/review/unknown write/model call/approval/write barrier 阻塞：
  `tests/recovery/read-recovery.test.ts:458`
- Heartbeat 失败不启动新 Read：
  `tests/recovery/read-recovery.test.ts:588`
- Heartbeat 失败后工具抛错也无法提交 failed Result：
  `tests/recovery/read-recovery.test.ts:627`
- Lease 被替换后旧 Worker 无法提交：
  `tests/recovery/read-recovery.test.ts:663`
- Read Recovery 到下一 Model Call：
  `tests/recovery/read-recovery.test.ts:724`
- 五种终态 Tool Message 唯一性：
  `tests/recovery/recovery-classifier.test.ts:238`
- queued/running/interrupted 不要求 Tool Message：
  `tests/recovery/recovery-classifier.test.ts:292`
- 非终态 PlanStep + 全终态 ToolRun：
  `tests/recovery/recovery-classifier.test.ts:311`

## 7. 是否建议正式验收 Step 6.2

建议正式验收 Step 6.2。

补充修复后已验证：

- Heartbeat 失败后的所有终态 Result Commit 均被本地执行权撤销保护。
- 数据库 assertOwned/fencing 继续作为第二道防线。
- 所有终态 ToolRun 的 Tool Message 一致性均被检查。
- Read Recovery 完成后 PersistentCoordinator 可接管并创建下一 Model Call。

## 8. 进入 Step 6.3 前的阻塞项

无 Step 6.2 范围内阻塞项。

Step 6.3 仍需遵守：

- 本地 ExecutionAuthority 只撤销当前 Worker 的提交权，不替代外部资源 fencing。
- Write Recovery、Unknown Write Review、Model Call Recovery 仍属于后续工作。
- 完整 Pause / Resume / Cancel 编排尚未实现。

## 9. 实际验证

- `pnpm test`：32 个测试文件、262 个测试全部通过。
- `pnpm typecheck`：通过。
- `git diff --check`：通过，仅有既有 LF/CRLF 提示。
