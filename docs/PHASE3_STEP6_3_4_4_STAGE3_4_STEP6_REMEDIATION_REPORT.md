# ForgeFlow Phase 3 Stage 3.4 Step 6 Remediation Report

> 状态：P1 Prepare Recovery State Transition 修复完成，等待架构复审。
>
> 范围：Step 6 局部架构修复。
>
> 数据库基线：Migration v9。
>
> 未开始 Step 7 / Step 8，未修改 Stage 3.2 / Stage 3.3 已封存行为。

## 1. 实际修改文件

生产代码：

- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
  - 新增内部 `prepareRecoveredReadAttemptInCurrentTransaction()`。
  - 新增独立 Prepare Recovery 状态规则和原子写路径。
- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
  - 删除 Prepare-side 的直接 Repository 业务写入。
  - Full Recovery 改为调用统一 Prepare Recovery Transition。

测试：

- `tests/storage/recovery-evidence-interruption.test.ts`
  - 新增 Prepare Recovery Transition 正向、负向和 rollback 测试。
  - 新增 A1/A2 New Attempt identity conflict 测试。
  - 新增单 Prepared Event + 错误 Request 测试。
  - 新增 Task `waiting_review` 状态断言。

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP6_REMEDIATION_REPORT.md`
  - 本报告。

未修改：

- Step 1 Lineage Schema。
- Step 2 既有普通 transition 行为。
- Stage 3.2 Dispatch Gate。
- Stage 3.3 已封存 UoW。
- Migration v4-v9 / SQLite Schema。
- 依赖。

## 2. 新 Prepare Recovery Transition API

内部 API：

```text
RecoveryEvidenceStateTransitionUnitOfWork
  .prepareRecoveredReadAttemptInCurrentTransaction(input, permit)
```

输入核心字段：

```text
ownership
currentLeaseClaimEventId
expectedTaskVersion
priorAttemptId
expectedPriorAttemptVersion
expectedToolRunVersion
expectedPlanStepVersion
expectedPlanVersion
newAttemptId
newAttemptNumber
preparedLineage
```

职责：

1. 验证 outer current-transaction `StorageWritePermit`。
2. 验证 Lease / Fencing / ExecutionAuthority。
3. 验证当前 Claim Event 与 Ownership。
4. 验证 Task / Request / ToolRun / PlanStep / Plan。
5. 验证 source state。
6. 验证 expected versions。
7. 验证无冲突 Active Attempt。
8. 验证 Attempt Number。
9. 验证 Interrupted / Prepared Lineage Pair。
10. 统一写入 requeue、Tool Event、Prepared Event、New Attempt 和
    Checkpoint。

该 API 未从 storage / recovery public barrel 导出。

## 3. Prepare Recovery 状态规则

独立规则：

```text
Old Attempt:
  interrupted -> interrupted

ToolRun:
  interrupted -> queued

PlanStep:
  interrupted -> running

Plan:
  active -> active

New Attempt:
  insert -> prepared
```

不会把 New Attempt insert 伪装成旧 Attempt 的普通状态更新。

Prepare Transition 验证：

- 旧 Attempt 必须为 interrupted。
- ToolRun 必须为 interrupted。
- PlanStep 必须为 interrupted。
- Plan 必须为 active。
- Plan purpose 必须为 recovery_evidence。
- PlanStep kind 必须为 read_batch。
- ToolRun 必须为 read，且 Tool identity / Schema Hash 一致。
- Request / Attempt retrySafety / consistencyMode 一致。
- Active Attempt 数量必须为 0。
- New Attempt Number 必须等于 prior + 1，也等于 MAX + 1。

## 4. Full Recovery 调用统一转换能力

整改前，Full Recovery 直接调用：

```text
ToolRunRepository.transition()
EventRepository.append()
PlanStepRepository.updateStatusCas()
RecoveryEvidenceReadAttemptRepository.insertPrepared()
CheckpointStore.append()
```

整改后，`recovery-evidence-full-recovery-unit-of-work.ts` 中已不存在这些
Prepare-side 业务写调用。

Full Recovery 仍在同一外层 transaction 中：

1. 调用既有 State Transition UoW 写 interruption。
2. 重新读取 interruption 后的当前版本。
3. 构造 Prepared Lineage。
4. 调用 `prepareRecoveredReadAttemptInCurrentTransaction()`。
5. 返回新 Attempt。

收据：

```text
rg "toolRuns\.transition|planSteps\.updateStatusCas|events\.append|attempts\.insertPrepared|checkpoints\.append"
src/storage/recovery-evidence-full-recovery-unit-of-work.ts
```

实际结果：无匹配。

## 5. Permit / Lease / Fencing / Authority

Prepare Recovery Transition 要求：

- Full Recovery 外层只创建一次 `StorageWritePermit`。
- 传入的 permit 必须属于当前 immediate transaction。
- Prepare Transition 不创建新 permit。
- 不打开 nested transaction。
- `leaseManager.assertOwned()` 验证当前 ownership。
- Claim Event 必须属于当前 Task、当前 Owner 和当前 fencingToken。
- `assertAuthority()` 独立执行。
- 不把 ownership 或 Preflight Capability 转换为 ExecutionAuthority。

测试使用真实 `TaskLeaseManager`、Claim Guard 和
`ExecutionAuthority`。

## 6. Event / Attempt / Tool Event / Checkpoint 原子性

统一 Prepare Transition 内的顺序：

```text
Validate
  -> ToolRun interrupted -> queued
  -> Append tool.queued
  -> PlanStep interrupted -> running
  -> Append Prepared Event
  -> Insert New Attempt prepared
  -> Append Checkpoint
```

保证：

- Prepared Event 先于 Attempt insert。
- New Attempt.last_event_id 等于 Prepared Event ID。
- Claim Event sequence < Prepared Event sequence。
- 所有写使用同一个 permit。
- 任一写失败整体 rollback。
- Full Recovery 的 interruption 与 prepare 仍在同一个外层 immediate
  transaction 中。

## 7. A1/A2 Replay conflict

新增测试：

```text
rejects different newAttemptId and request bindings without writes
```

场景：

```text
first:
  recoveryOperationId = R1
  newAttemptId = A1

replay:
  recoveryOperationId = R1
  newAttemptId = A2
```

实际结果：

- fail closed。
- 不创建 A2。
- Attempt 数量不变。
- Event 数量不变。
- Checkpoint 数量不变。
- 历史 A1 保持不变。

## 8. 单 Prepared Event + 错误 Request

同一测试还覆盖：

- 数据库只存在首次完整 Prepared Event。
- Replay 使用不同 Request ID。
- Replay fail closed。
- 不写 Event / Attempt / Checkpoint。

错误 Request 不存在时由 Request Repository fail closed；只要 Prepared
Event 存在，UoW 不会生成新 Attempt。

## 9. Task waiting_review

新增断言：

- Full Recovery Prepare 后 `Task.status = waiting_review`。
- Pause Resume Continuation 后 `Task.status = waiting_review`。
- Direct Prepare Recovery Transition 后 `Task.status = waiting_review`。

Task version 可以因 Event append 递增，但没有 Task status transition。
Stage 3.2 Dispatch Gate 未修改。

## 10. Prepare Transition 测试

新增测试覆盖：

1. 合法 interrupted -> prepared。
2. ToolRun 非 interrupted 拒绝。
3. PlanStep 非 interrupted 拒绝。
4. Plan 非 active 拒绝。
5. 原 Attempt 非 interrupted 拒绝。
6. expected version mismatch 拒绝。
7. 旧 Owner / stale fencing 拒绝。
8. invalid ExecutionAuthority 拒绝。
9. missing / invalid Transaction Permit 拒绝。
10. invalid Attempt Number 拒绝。
11. 冲突 Active Attempt 拒绝。
12. Checkpoint 写入失败整体 rollback。

Full Recovery 原有 rollback 测试继续覆盖 Attempt insert、Prepared Event、
Tool Event 和 Checkpoint 失败。

## 11. 实际执行结果

指定专项测试：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts tests/storage/recovery-evidence-state-transition-lineage.test.ts

Test Files  2 passed (2)
Tests       45 passed (45)
```

全量测试：

```text
pnpm test

Test Files  57 passed (57)
Tests       625 passed (625)
```

类型检查：

```text
pnpm typecheck
```

命令退出码为 0。

差异检查：

```text
git diff --check
```

结果见第 13 节。

## 12. Migration / Schema 影响

无。

- 复用 Migration v9。
- 未新增 Migration v10。
- 未修改 Migration v4-v9。
- 未修改 SQLite Schema。
- 未新增依赖。

## 13. `git diff --check`

实际执行结果：

```text
Exit code: 0
```

仅输出工作树现有 LF/CRLF normalization warning，没有 whitespace error。
该命令不检查未跟踪文件内容。

## 14. 尚未解决的限制

1. 仍未执行 Step 6 Prepared Attempt 到 Stage 3.2
   `beginOwnedRecoveryEvidenceRead()` 的端到端集成测试；该测试属于 Step 7
   范围，本次未授权。
2. Durable Recovery Job / Command Store 仍不存在，跨重启 operation context
   仍依赖 Host stable `recoveryOperationId`。
3. Full Recovery 仍产生 interruption Checkpoint + final prepared
   Checkpoint；二者在同一 outer transaction 中原子提交或回滚。
4. 本步骤未实现 External Read / Dispatch / Transaction B / Verifier。

## 15. 边界声明

本次仅完成 Step 6 P1 remediation 和授权测试补充。

未开始 Step 7 / Step 8，未修改 Stage 3.2 Dispatch Gate、Stage 3.3 已封存
UoW、Step 1 Schema、Step 2 既有普通 transition 行为、Migration 或依赖。

完成后停止，等待架构复审。
