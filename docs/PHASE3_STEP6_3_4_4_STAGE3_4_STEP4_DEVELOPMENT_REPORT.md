# ForgeFlow Phase 3 Stage 3.4 Step 4 Development Report

> 状态：Step 4 开发完成，等待架构评审。
>
> 范围：Recovery Evidence Lease / Fencing Takeover Guard。
>
> 数据库基线：Migration v9。
>
> 未实施：Interruption-only UoW、Full Recovery、Pause Resume
> Continuation、External Read、Transaction B 或 Step 5。

## 1. 实际新增与修改文件

生产代码：

- `src/storage/task-lease-manager.ts`
  - 新增 `claimWithClaimEvent()`。
  - 原 `claim()` 保留原返回类型，并委托给新方法。
  - 新增只读 `hasActiveLease()`，用于错误分类时读取当前 Lease。
- `src/storage/recovery-evidence-fencing-takeover-guard.ts`
  - 新增 Recovery Evidence Fencing Takeover Guard。
  - 新增 Lease Claim Event / Dispatch / Interrupted / Prepared sequence
    validator。
- `src/storage/index.ts`
  - 导出 storage-layer Guard 和类型。
  - 未加入 `src/recovery/index.ts`，不暴露 Recovery 执行入口。

测试：

- `tests/storage/task-lease.test.ts`
  - 扩展 Lease Event / Checkpoint rollback 测试。
- `tests/storage/recovery-evidence-fencing-takeover.test.ts`
  - 新增 release、expiry、并发、旧 Owner 写入和 Event sequence 测试。
- `tests/storage/recovery-evidence-fencing-takeover-worker.ts`
  - 新增跨连接并发 Claim worker。

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP4_DEVELOPMENT_REPORT.md`
  - 本报告。

## 2. TaskLeaseManager Claim API 变化

现有 API 保持兼容：

```text
claim(taskId, ownerId): TaskLeaseRecord
```

新增：

```text
claimWithClaimEvent(taskId, ownerId): {
  leaseRecord: TaskLeaseRecord,
  leaseClaimEventId: string
}
```

`claim()` 现在是兼容包装：

```text
claim()
  -> claimWithClaimEvent()
  -> return result.leaseRecord
```

因此现有 `PersistenceCoordinator`、`RecoveryManager`、测试 worker 和其他
`TaskLeaseManager.claim()` 调用方无需修改。

Claim Event ID 来自同一次 `EventRepository.append()` 返回的真实 Event
记录，不通过按时间或 sequence 查询“最近一个 `lease.claimed` Event”猜测。

## 3. Lease Record 与 Claim Event 原子关联

`claimWithClaimEvent()` 在原有 immediate transaction 内执行：

```text
BEGIN IMMEDIATE
  -> create StorageWritePermit
  -> read Task
  -> reject terminal Task
  -> TaskLeaseRepository.claim()
       -> conditional insert/update
       -> fencingToken = previous + 1
  -> EventRepository.append('lease.claimed')
  -> validate Event task/type/entity/fencing
  -> CheckpointStore.append('lease_claimed')
COMMIT
  -> return { leaseRecord, leaseClaimEventId }
```

Event 与 Checkpoint 使用同一个 transaction permit。Event 或 Checkpoint
任意一步失败，Lease row、Event 和 Checkpoint 全部 rollback。

## 4. Fencing Takeover Guard

新增：

```text
RecoveryEvidenceFencingTakeoverGuard
```

接口：

```text
claimRecoveryEvidenceOwnership(taskId, ownerId)
assertLeaseClaimEvent(ownership, leaseClaimEventId)
assertInterruptedClaimBinding(...)
assertPreparedClaimBinding(...)
```

`claimRecoveryEvidenceOwnership()` 返回：

| status | 含义 |
|---|---|
| `ready` | 本次 Claim 成功，返回 Lease、Ownership 和真实 Claim Event ID |
| `in_progress` | 当前仍有 active Lease，不允许接管 |
| `lease_conflict` | SQLite Claim 与随后 Lease 快照不一致的竞争回退 |
| `state_inconsistent` | Task 不存在、Task terminal 或 Claim Event invariant 失败 |

验证：

1. Task 不存在返回 `TASK_NOT_FOUND`。
2. Task 处于 `completed` / `failed` / `cancelled` 时拒绝。
3. active Lease 不可被第二个 Owner 接管。
4. Owner release 后可重新 Claim。
5. Lease expiry 后可重新 Claim。
6. 新 Claim 的 `fencingToken` 严格大于旧 Claim。
7. `leaseToken` 来自本次 Lease Repository Claim。
8. Claim Event Task / type / entity / fencing 与 Lease 一致。
9. 并发 Claim 由 SQLite immediate transaction 与 conditional update 串行化。
10. 旧 Lease / fencing 的 SQLite 写入由现有 `assertOwned()` 拒绝。

该 Guard 只建立持久化所有权与 Claim Event 关联，不创建
`ExecutionAuthority`，也不把 Preflight Capability 转换为执行权限。

## 5. Claim Event ID 与 Sequence 验证

### 5.1 Claim Event

`assertLeaseClaimEvent()` 要求：

```text
当前 ownership 通过 TaskLeaseManager.assertOwned()
leaseClaimEventId 存在
Event.taskId = ownership.taskId
Event.type = lease.claimed
Event.entityType = task_lease
Event.entityId = ownership.taskId
Event.payload.ownerId = 当前 Lease owner
Event.payload.fencingToken = ownership.fencingToken
```

验证使用当前 ownership。旧 Claim Event 不能在 Owner 更换后冒充当前
Ownership。

### 5.2 Interrupted Event

`assertInterruptedClaimBinding()` 要求：

```text
prior Dispatch Event sequence
  < Lease Claim Event sequence
  < Interrupted Event sequence
```

### 5.3 Prepared Event

`assertPreparedClaimBinding()` 要求：

```text
Lease Claim Event sequence
  < Prepared Event sequence
```

Full Recovery 中 Interrupted 与 Prepared 可以使用同一个 Claim Event；
两条 validator 可以分别调用。Pause Clear 后的 Resume Owner 必须传入
自己的 ownership 和新 Claim Event ID，旧 Owner Claim 会被 fencing/current
ownership 校验拒绝。

本步骤没有创建 Interrupted 或 Prepared Event。

## 6. 并发 Claim 行为

并发测试使用两个独立 SQLite 文件连接和两个真实
`RecoveryEvidenceFencingTakeoverGuard.claimRecoveryEvidenceOwnership()`
worker。

结果：

- 恰好一个 worker 返回 `ready`。
- 另一个返回 `in_progress`。
- 数据库只有一条 `lease.claimed` Event。
- 返回的 `leaseClaimEventId` 能在 Event 表中按 ID 精确找到。
- 失败方不写 Lease、Event 或 Checkpoint。

SQLite immediate transaction 和
`TaskLeaseRepository.claim()` 的 conditional update 继续提供串行化保证。

## 7. 旧 Owner 写入拒绝

测试执行真实路径：

1. Owner A Claim。
2. Owner A release。
3. Owner B Claim，fencing 严格递增。
4. Owner A 使用旧 leaseToken / fencingToken 调用
   `ExecutionStateMachine.transitionTask()`。
5. 写入被 `TASK_LEASE_NOT_OWNED` 拒绝。
6. Task 状态和 version 未产生新的 transition。

本步骤没有尝试跨进程同步 revoke `ExecutionAuthority`。新 Owner Claim
只证明 SQLite 持久化提交权已经转移，不证明旧进程或外部 Read 已停止。

## 8. 事务失败与回滚

`tests/storage/task-lease.test.ts` 覆盖：

- `lease.claimed` Event insert 失败：
  - Lease row rollback。
  - Event rollback。
- `lease_claimed` Checkpoint insert 失败：
  - Lease row rollback。
  - 已插入的 Claim Event rollback。
  - Checkpoint rollback。

现有 heartbeat / release Event 原子性测试继续通过。

## 9. 新增测试与实际执行结果

专项测试文件：

```text
tests/storage/task-lease.test.ts
tests/storage/recovery-evidence-fencing-takeover.test.ts
```

覆盖：

1. Active Lease 时第二个 Owner 返回 `in_progress`。
2. Heartbeat 后仍不可接管。
3. Release 后新 Owner Claim 成功。
4. Expiry 后新 Owner Claim 成功。
5. fencingToken 单调递增。
6. 返回的 Claim Event ID 属于本次 Claim。
7. Claim Event Task / type / entity / fencing 一致。
8. Dispatch < Claim < Interrupted sequence。
9. Claim < Prepared sequence。
10. Full Recovery 两个 Event 可引用同一个 Claim。
11. Resume Owner 不能复用旧 Owner Claim Event。
12. 两个独立连接并发 Claim 只有一个成功。
13. 旧 Owner SQLite transition 被拒绝。
14. Event 写入失败时 Lease Claim 整体 rollback。
15. Checkpoint 写入失败时 Lease Claim 整体 rollback。
16. 测试路径不创建 ReadAttempt。

实际执行：

```text
pnpm vitest run tests/storage/task-lease.test.ts tests/storage/recovery-evidence-fencing-takeover.test.ts

Test Files  2 passed (2)
Tests       12 passed (12)
```

命令退出码为 0。

全量回归：

```text
pnpm test

Test Files  56 passed (56)
Tests       598 passed (598)
```

命令退出码为 0。

类型检查：

```text
pnpm typecheck
```

命令退出码为 0。

差异检查：

```text
git diff --check
```

命令退出码为 0。输出仅包含现有工作树的 LF/CRLF 归一化 warning，未报告
whitespace error。该命令不检查未跟踪文件内容。

## 10. Migration / Schema 影响

无 Migration 或 Schema 影响。

- 复用 Migration v9 的 `task_leases`、`events` 和 `checkpoints`。
- 未新增 Lease-to-Event 外键或独立表。
- 未新增 Migration v10。
- 未修改 Migration v4-v9。
- 未新增依赖。

当前关联方式以同一次 immediate transaction 返回的真实 Event ID 为准，
不依赖 Event payload 查询推断。

## 11. 尚未解决的限制

1. Guard 不检查 Recovery Request、ReadAttempt 或 Dispatch outcome；Step 5 /
   Step 6 必须在 Immediate Transaction 内组合 Ownership、Request、
   Attempt、Intent 和完整 Lineage 校验。
2. `assertInterruptedClaimBinding()` / `assertPreparedClaimBinding()` 只验证
   Claim Event 和 sequence；完整 Lineage Schema 校验仍由 Stage 3.4 State
   Transition UoW 负责。
3. `lease_conflict` 是 SQLite Claim 失败但紧随其后的 Lease 快照不显示
   active owner 时的竞争/时钟边界分类；正常确定性路径返回 `ready`、
   `in_progress` 或 `state_inconsistent`。
4. 当前 Lease 表没有持久化 `leaseClaimEventId` 列。claim API 在事务内把
   真实 Event ID 返回给调用方；后续 Recovery UoW 必须持久化该 ID 到
   Interrupted / Prepared lineage，不能事后按最近 Event 猜测。
5. 跨进程旧 Owner 的 `ExecutionAuthority` 无法由新 Owner 同步 revoke；
   仍依赖 heartbeat / ownership 检查 fail closed。
6. 未实现 External Read 或外部调用终止事实。

## 12. 边界声明

本步骤仅完成 Stage 3.4 Step 4 Fencing Takeover Guard。

未实施：

- Stage 3.4 Step 5 及之后步骤。
- Interruption-only UoW。
- Full Interrupted Recovery。
- Pause Clear Resume Continuation。
- 新 Recovery 业务执行入口。
- Durable Recovery Job / Command Store。
- Recovery Lineage Repository 写入口。
- Stage 3.2 Dispatch Gate 修改。
- Stage 3.3 已封存行为修改。
- External Read / Transaction B。
- Verifier / Recovery Manager / Classifier。
- Step 6.3.5。
