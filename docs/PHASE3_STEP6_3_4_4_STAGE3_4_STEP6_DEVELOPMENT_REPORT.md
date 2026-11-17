# ForgeFlow Phase 3 Stage 3.4 Step 6 Development Report

> 状态：Step 6 开发完成，等待架构评审。
>
> 范围：Full Interrupted Recovery + New Attempt，以及 Pause Clear 后的
> Resume Continuation。
>
> 数据库基线：Migration v9。
>
> 未实施：Step 7、Step 8、Durable Recovery Job、External Read、
> Transaction B、Verifier 或公开 Recovery Worker。

## 1. 实际新增与修改文件

生产代码：

- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
  - 新增内部 `RecoveryEvidenceFullRecoveryUnitOfWork`。
  - Full Recovery：Interrupted + requeue + Prepared Event + New Attempt
    在同一 immediate transaction 内完成。
  - Pause Clear Resume Continuation。
  - phase=prepare Exact Replay。

测试：

- `tests/storage/recovery-evidence-interruption.test.ts`
  - 扩展为 Step 5 + Step 6 集成测试。
  - 新增 Full Recovery、Pause Resume、prepare Replay、冲突和四类故障回滚。

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP6_DEVELOPMENT_REPORT.md`
  - 本报告。

`RecoveryEvidenceFullRecoveryUnitOfWork` 未从 storage / recovery public
barrel 导出，不构成 HTTP、IPC 或 Worker Recovery 入口。

## 2. Internal UoW 接口

```text
RecoveryEvidenceFullRecoveryUnitOfWork
  .recoverOwnedRecoveryEvidenceReadAttempt(input)
```

输入：

```text
ownership
currentLeaseClaimEventId
expectedTaskVersion
requestId
priorAttemptId
expectedPriorAttemptVersion
expectedToolRunVersion
expectedPlanStepVersion
expectedPlanVersion
recoveryOperationId
newAttemptId（可选；首个调用可由 Host 指定）
pauseClearEventId（Pause Resume 时必需）
preflightResult
```

输出：

```text
status
replayed
priorAttempt
newAttempt
interruptionEventId
preparedEventId
pauseClearEventId
retryAssessment
preflightReasonCode
```

稳定结果：

- `prepared`
- `cancel_required`
- `pause_blocked`
- `manual_review`
- `preflight_required`
- `retry_assessment_unavailable`

## 3. Recovery 状态转换

### 3.1 Full Recovery

起始状态：

```text
Attempt: dispatching
ToolRun: running
PlanStep: running
Plan: active
```

同一 immediate transaction 内：

```text
State Transition UoW:
  Attempt dispatching -> interrupted
  ToolRun running -> interrupted
  PlanStep running -> interrupted
  Plan active

Full Recovery UoW:
  ToolRun interrupted -> queued
  PlanStep interrupted -> running
  Plan active

  Prepared Event
  New Attempt prepared
  Final Checkpoint
```

状态转换使用已封存 State Transition UoW 完成 interruption 部分。当前
State Matrix 没有 prepare target，因此 requeue / Prepared Event /
Attempt insert 使用现有 Repository 和 Schema 约束在同一个外层 transaction
内完成；没有创建 nested transaction，也没有绕过 Attempt 状态转换约束。

### 3.2 Pause Resume Continuation

起始状态由 Step 5 已提交：

```text
Attempt: interrupted
ToolRun: interrupted
PlanStep: interrupted
Plan: active
```

Hook 显式 Pause Clear 后：

```text
ToolRun interrupted -> queued
PlanStep interrupted -> running
Plan active

Prepared Event
New Attempt prepared
Final Checkpoint
```

不重复写 Interrupted Event。

### 3.3 Cancel / Pause 优先级

顺序：

```text
Cancel > Pause > Normal Recovery
```

- Cancel 存在：返回 `cancel_required`，不创建 New Attempt。
- Pause 仍存在：返回 `pause_blocked`，不创建 New Attempt。
- Pause 已 Clear：通过 Resume Continuation。
- 无控制意图且历史 `resumeEligible=false`：manual review，不创建 Attempt。
- 无控制意图且 Preflight `not_evaluated`：返回
  `retry_assessment_unavailable`，不创建 Attempt。

## 4. New Attempt 创建流程

1. 原 Attempt 必须为 `dispatching` 或已持久化 `interrupted`。
2. 原 Attempt ID 不可复用。
3. `attemptNumber = MAX + 1`，且必须等于 `priorAttemptNumber + 1`。
4. New Attempt ID 首次由 Host 或 UoW UUID 生成。
5. 先写 Prepared Event，再创建 `prepared` Attempt，保证
   Attempt.last_event_id 与真实 Event 绑定。
6. ToolRun 进入 `queued`。
7. PlanStep 进入 `running`。
8. ExecutionPlan 保持 `active`。
9. 原 Interrupted Attempt 保留历史状态和原 Event。
10. 不创建 Dispatch Event，不执行 External Read。

## 5. Prepared Lineage / Claim Event / Fencing

Prepared Lineage 使用 Step 1 Strict Schema：

```text
lineageSchemaVersion
recoveryOperationId
recoveryPhase = prepare
taskId
readbackRequestId
readToolRunId
readAttemptId = newAttemptId
attemptNumber = newAttemptNumber
attemptStatus = prepared
priorAttemptId
priorAttemptNumber
interruptionEventId
newAttemptId
newAttemptNumber
leaseClaimEventId
fencingToken
pauseClearEventId（Pause 时）
retrySafety / consistencyMode
allowlistId / allowlistVersion
readToolName / readToolVersion / readToolSchemaHash
requestIntentDigest
expectedResourceVersion / expectedEtag
```

验证：

- Interrupted / Prepared 使用相同 root `recoveryOperationId`。
- Prepared `interruptionEventId` 指向真实 Interrupted Event。
- `newAttemptNumber = priorAttemptNumber + 1`。
- Prepared Claim Event 属于当前 Resume Owner。
- Claim Event sequence < Prepared Event sequence。
- Full Recovery 可以复用本次 interruption 的 Claim Event。
- Pause Resume 必须使用 Pause Clear 后新 Owner 的 Claim Event。
- 旧 Owner Claim Event 不能冒充当前 Resume Owner。

`RecoveryEvidenceFencingTakeoverGuard.assertPreparedClaimBinding()` 在
Prepared Event 写入后、New Attempt 插入前再次验证当前 Ownership 和
Claim sequence；失败会回滚整个 transaction。

## 6. Pause Clear Resume Continuation

Resume 前置条件：

1. Task 当前无 Cancel。
2. `pauseRequestedAt IS NULL`。
3. Interrupted Lineage `controlIntentKind=pause`。
4. `resumeEligible=true` 且 `retryAssessment=passed`。
5. `pauseClearEventId` 指向真实 `recovery.evidence.pause_cleared`。
6. Clear Event `clearedPauseEventId` 等于原 Pause Request Event。
7. Pause Request sequence < Interrupted sequence < Clear sequence。
8. 不存在晚于 Clear 的新 Pause generation。
9. 当前 Resume Owner Claim sequence > Clear sequence。
10. 当前 Preflight passed capability 与历史 Request / ToolRun / Digest 一致。

旧 Clear、错误 Pause generation、旧 Owner Claim 均 fail closed。

## 7. Exact Replay

Replay key：

```text
taskId + recoveryOperationId + prepare
```

流程：

1. 当前 Lease / Fencing / Authority / Claim Event 先验证。
2. 查找唯一 Prepared Event。
3. Strict Parse Prepared Lineage。
4. 查找真实 Interrupted Event 并使用 Pair Validator。
5. 验证 Request / ToolRun / prior Attempt / New Attempt identity。
6. 独立验证历史 Dispatch / claim / Interrupted / Clear sequence。
7. 验证当前下游状态属于合法 Prepared Attempt 演进。
8. 返回原 New Attempt、Prepared Event 和 Interrupted Event。
9. 不写 Event / Checkpoint，不修改历史 Claim / fencingToken。

允许的下游状态包括：

```text
prepared / queued / queued|running / active
dispatching / running / running / active
completed / succeeded / completed / active|completed
failed / failed / failed / failed
timed_out / timed_out / failed / failed
interrupted / interrupted / interrupted / active
cancelled / cancelled / cancelled / cancelled
blocked_by_intent / queued / queued|running / active
```

其他组合 fail closed。

## 8. 事务原子性与权限边界

每次调用：

- 创建一个 `StorageWritePermit`。
- 不创建 nested transaction。
- Registry / Contract / async Preflight 在 transaction 外完成。
- transaction 内不调用 Registry、Provider、Verifier 或 External I/O。
- 不把 Recovery Preflight Capability 转换成 ExecutionAuthority。
- 当前 Owner 的 Lease / Fencing / Authority 每次重新验证。

任意以下失败整体 rollback：

- Interrupted Event。
- Prepared Event。
- Tool Event。
- New Attempt insert。
- ToolRun / PlanStep update。
- Checkpoint。

Full Recovery 的 interruption 由 State Transition UoW写 Checkpoint，随后
Prepared continuation 再写 final Checkpoint；两者位于同一个外层
immediate transaction，最终失败会同时回滚。

## 9. 测试与实际结果

专项测试文件：

```text
tests/storage/recovery-evidence-interruption.test.ts
```

Step 6 覆盖：

1. Full Recovery 创建不同 ID 的 New Attempt。
2. Attempt Number 严格递增。
3. 原 Attempt 保持 interrupted 历史。
4. Prepared Event 引用真实 Interrupted Event。
5. Prepared Lineage 引用真实 Claim Event。
6. Claim sequence < Prepared sequence。
7. Retry failed 不创建 Attempt。
8. Resume Eligible false 不创建 Attempt。
9. Request Intent Digest mismatch 不创建 Attempt。
10. Preflight allowlist / contract unavailable 不创建 Attempt。
11. 冲突 active Attempt 拒绝。
12. Pause 未 Clear 返回 pause_blocked。
13. Pause Clear 后 Resume 成功。
14. Resume 使用新 Owner Claim Event。
15. 旧 Owner Claim Event 被拒绝。
16. Pause failed 不 Resume。
17. Pause not_evaluated 不 Resume。
18. 错误 Pause Clear generation 拒绝。
19. Cancel 优先于 Pause。
20. 相同 operation 返回同一个 New Attempt。
21. Replay 不重复 Prepared Event。
22. Replay 不重复 Checkpoint。
23. Owner A prepare、Owner B Replay。
24. 不同 Request 的相同 operation conflict 拒绝。
25. 历史 Claim / fencing identity 保持。
26. 合法 downstream dispatching 后 Replay。
27. 非法 downstream 状态 Replay 拒绝。
28. 无 Intent + Preflight not_evaluated 不创建 Attempt。
29. Attempt insert 失败整体 rollback。
30. Prepared Event 失败整体 rollback。
31. Tool Event 失败整体 rollback。
32. Checkpoint 失败整体 rollback。
33. Invalid Authority / Claim Event 拒绝。
34. 不创建 Dispatch Event / External Read。
35. 不调用 `ToolRegistry.executeValidated()`。

实际执行：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts

Test Files  1 passed (1)
Tests       22 passed (22)
```

全量回归：

```text
pnpm test

Test Files  57 passed (57)
Tests       620 passed (620)
```

类型检查：

```text
pnpm typecheck
```

命令退出码为 0。

## 10. 已实现 / 已测试 / 未实现

### 已实现

- Full Interrupted Recovery。
- New Attempt 持久化。
- Prepared Lineage。
- Pause Clear Resume Continuation。
- phase=prepare Exact Replay。
- 事务级 rollback。

### 已测试

- 真实 TaskLeaseManager / Fencing Claim / ExecutionAuthority。
- 真实 Recovery Preflight result。
- 真实 Stage 3.3 Pause Set / Clear。
- 真实 Step 5 Interruption UoW。
- 跨 Owner Replay。
- 合法与非法 downstream 状态。
- 四类写失败 rollback。

### 未实现

- Stage 3.4 Step 7 / Step 8。
- Durable Recovery Job / Command Store。
- Recovery Scanner / Classifier / 独立 Worker。
- External Read / `executeValidated()`。
- Transaction B / Verifier。
- HTTP / IPC / Host Control Recovery 入口。
- 跨重启 Recovery Orchestration 与 exactly-once 外部执行。

## 11. Migration / Schema 影响

无 Schema / Migration 影响。

- 复用 Migration v9。
- 未新增 Migration v10。
- 未修改 Migration v4-v9。
- 未新增依赖。

## 12. 尚未解决的限制

1. `recoveryOperationId` 仍由调用方 stable context 提供；仓库尚无 Durable
   Recovery Job / Command Store，不能声称跨重启恢复已完成。
2. `newAttemptId` 可省略并在首次事务中生成 UUID；跨重启响应丢失重试必须
   依赖稳定 `recoveryOperationId` 查找已提交 Prepared Event，而不是要求
   调用方记住生成 ID。
3. Prepared requeue 使用现有 Repository；State Matrix 当前没有 prepare
   target。interruption 部分严格复用 State Transition UoW，没有绕过其状态
   约束。
4. Full Recovery 当前会产生 interruption Checkpoint 和 final prepared
   Checkpoint 两条 Checkpoint，但二者在同一 transaction 内原子提交/回滚。
5. Replay 返回历史 Prepared Attempt 不构成 Dispatch 授权；后续 Stage 3.2
   Dispatch Gate 仍必须重新验证当前 Lease / Fencing / Authority / Intent
   和完整 Lineage。
6. 无 Intent + Preflight not_evaluated 继续 fail closed，不创建 Attempt，
   不改变 Step 5 的未评估语义。
7. 未实现外部 Read，因此无法证明旧 Owner 外部操作已停止；系统只保证
   SQLite 持久化提交权已转移。

## 13. 边界声明

本步骤仅完成 Stage 3.4 Step 6。

未开始 Step 7 / Step 8，未修改 Stage 3.2 Dispatch Gate 或 Stage 3.3
已封存行为，未调用 External Read，未修改 Schema / Migration / Dependency。
