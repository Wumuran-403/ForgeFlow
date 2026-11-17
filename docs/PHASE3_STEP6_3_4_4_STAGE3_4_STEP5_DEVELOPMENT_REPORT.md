# ForgeFlow Phase 3 Stage 3.4 Step 5 Development Report

> 状态：Step 5 开发完成，等待架构评审。
>
> 范围：Interruption-only UoW。
>
> 数据库基线：Migration v9。
>
> 未实施：Full Interrupted Recovery、Pause Clear Resume Continuation、
> new Attempt 创建、Durable Recovery Job、External Read 或 Step 6。

## 1. 实际新增与修改文件

生产代码：

- `src/storage/recovery-evidence-interruption-unit-of-work.ts`
  - 新增内部 `RecoveryEvidenceInterruptionUnitOfWork`。
  - 实现 Cancel / Pause / Retry Unsafe interruption-only 分支。
  - 实现 phase=interrupt Exact Replay。
- `src/recovery/recovery-evidence-recovery-preflight.ts`
  - 为真实 Preflight result 增加模块私有 WeakMap registration。
  - passed / failed / not_evaluated result 均冻结。
  - 新增内部 `assertRecoveryEvidenceRecoveryPreflightResult()`。
  - 不修改 public recovery barrel，不改变现有 result 字段。

测试：

- `tests/storage/recovery-evidence-interruption.test.ts`
  - 新增 Interruption-only 集成测试。

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP5_DEVELOPMENT_REPORT.md`
  - 本报告。

`RecoveryEvidenceInterruptionUnitOfWork` 未从 storage 或 recovery public
barrel 导出，不构成 HTTP / IPC / Worker Recovery 入口。

## 2. Interruption-only 接口

内部接口：

```text
RecoveryEvidenceInterruptionUnitOfWork
  .interruptOwnedRecoveryEvidenceReadAttempt(input)
```

输入绑定：

```text
ownership.taskId
ownership.leaseToken
ownership.fencingToken
currentLeaseClaimEventId
expectedTaskVersion
requestId
priorAttemptId
expectedAttemptVersion
recoveryOperationId
preflightResult（Cancel 之外适用）
```

返回状态：

| status | 含义 |
|---|---|
| `interrupted_cancel_pending` | Cancel interruption 已提交，等待 Stage 3.3 收敛 |
| `interrupted_pause_pending` | Pause interruption 已提交，不创建新 Attempt |
| `interrupted_retry_unsafe` | Retry Preflight 明确不安全，转 manual review |
| `full_recovery_required` | 无 Intent 且 Preflight passed，留给 Step 6 |
| `retry_assessment_unavailable` | 无 Intent 且 Preflight not_evaluated，fail closed 不写 |

结果同时返回：

```text
replayed
attempt
interruptionEventId
retryAssessment
preflightReasonCode
recommendedNextAction
```

## 3. 三种中断分支

### 3.1 Cancel interruption

```text
Attempt:   dispatching -> interrupted
ToolRun:   running -> interrupted
PlanStep:  running -> interrupted
Plan:      active -> active
new Attempt: none
```

Lineage：

```text
retryAssessment = not_evaluated
resumeEligible = false
controlIntentKind = cancel
```

返回 `interrupted_cancel_pending`，后续由 Stage 3.3 Request Cancel UoW
独立收敛。

### 3.2 Pause interruption

状态转换与 Cancel 相同，但不创建新 Attempt。

| Preflight | retryAssessment | resumeEligible | recommendedNextAction |
|---|---|---|---|
| passed | passed | true | await_pause_clear |
| failed | failed | false | manual_review |
| not_evaluated | not_evaluated | false | manual_review |

Lineage：

```text
controlIntentKind = pause
controlIntentEventId = pauseRequestEventId
```

Pause Clear 后 Resume Continuation 留给 Step 6。

### 3.3 Retry Unsafe interruption

条件：

```text
当前没有 Cancel / Pause Intent
真实 Preflight result = failed
```

```text
retryAssessment = failed
resumeEligible = false
```

状态转换为 interrupted，不创建新 Attempt，返回
`interrupted_retry_unsafe` / `manual_review`。

无 Intent 且 Preflight passed 时返回 `full_recovery_required`，不写状态；
无 Intent 且 Preflight not_evaluated 时返回
`retry_assessment_unavailable`，不写状态。后者避免将未评估结果伪装为
failed，也避免违反 Step 1 “not_evaluated requires explicit intent” 约束。

## 4. Lease / Fencing / Authority 验证

每次调用在 Recovery State Transaction 内独立验证：

1. `TaskLeaseManager.assertOwned()`。
2. 当前 `ExecutionAuthority.assertActive()`。
3. Task 必须为 `waiting_review`。
4. 当前 Claim Event 必须属于当前 Owner、Task 和 fencingToken。
5. 新 fencingToken 严格大于旧 Dispatch fencingToken。
6. Claim Event sequence 晚于旧 Dispatch Event。
7. Interrupted Event sequence 晚于当前 Claim Event。

新 Owner 取得 Lease 不会被转换成 ExecutionAuthority；测试调用方仍需
提供当前进程的 Authority。

## 5. Recovery Preflight Capability 验证

Step 3 原有 passed capability 继续通过 module-private WeakMap 验证。

本步骤补充：

- 所有真实 Preflight result 在返回前注册到 module-private WeakMap。
- result object 冻结。
- failed / not_evaluated 普通对象、spread clone 均无法通过验证。
- UoW 只接受由真实 `prepareRecoveryEvidenceRecoveryPreflight()` 返回的
  result object。

passed 结果额外验证：

```text
taskId
requestId
readToolRunId
allowlistId / allowlistVersion
Tool name / version / schema hash
requestIntentDigest
retrySafety / consistencyMode
expectedResourceVersion / expectedEtag
canonicalInputHash
retryAssessment = passed
```

Preflight 仍在 SQLite Transaction 外执行；UoW 不在 transaction 内调用
Registry。

## 6. Interrupted Lineage Event 字段

本步骤通过已封存 Step 1 Schema 和 Step 2 State Transition UoW 构造并写入：

```text
lineageSchemaVersion
recoveryOperationId
recoveryPhase = interrupt
taskId
readbackRequestId
readToolRunId
readAttemptId
attemptNumber
attemptStatus = interrupted
priorAttemptId
priorAttemptNumber
dispatchEventId
dispatchFencingToken
leaseClaimEventId
fencingToken
interruptionCause
reasonCode
retryAssessment
resumeEligible
retrySafety
consistencyMode
allowlistId
allowlistVersion
readToolName
readToolVersion
readToolSchemaHash
requestIntentDigest
expectedResourceVersion
expectedEtag
controlIntentKind / controlIntentEventId（适用时）
pauseRequestEventId（Pause 时）
```

Interrupted Event 写入后，Attempt `last_event_id` 指向该 Event。

## 7. Exact Replay

Replay key：

```text
taskId + recoveryOperationId + interrupt
```

流程：

1. 验证当前调用者 Lease / Fencing / Authority。
2. 验证当前 Claim Event。
3. 按 recoveryOperationId 查找唯一 Interrupted Event。
4. 使用 Step 1 Schema解析历史 Lineage。
5. 验证历史 Task / Request / ToolRun / priorAttempt identity。
6. 调用 Step 2 UoW，由已封存 Replay Policy 独立验证历史 fencing、
   Dispatch Event、Claim Event 和下游合法演进。
7. 返回原 Attempt / Interrupted Event，不写 Event 或 Checkpoint。

已测试：

- Owner A 写入后，Owner B 使用更高 fencing Replay。
- Stage 3.3 Cancel convergence 后 Replay。
- Prepare child Attempt 创建后 Replay。
- 同一 operation ID 的 Request / Attempt identity 冲突 fail closed。

## 8. Event / Checkpoint 原子性

UoW 使用外层 `runInTransaction(..., "immediate")`，只创建一次
`StorageWritePermit`，调用 State Transition UoW 的
`...InCurrentTransaction()`，不打开 nested transaction。

事务内写入：

```text
Attempt Event
Attempt.last_event_id / status
ToolRun interrupt transition
PlanStep interrupt transition
Tool Event
Checkpoint
```

测试注入：

- Interrupted Event append 失败：全部 rollback。
- Checkpoint append 失败：全部 rollback。

失败后 Attempt 仍为 dispatching，ToolRun / PlanStep / Plan 保持原状态，
Event 和 Checkpoint 数量不增加。

## 9. 新增测试与实际结果

专项测试：

```text
tests/storage/recovery-evidence-interruption.test.ts
tests/recovery/recovery-evidence-recovery-preflight.test.ts
```

覆盖：

1. Cancel interruption。
2. Pause + Preflight passed。
3. Pause + Preflight failed。
4. Pause + Preflight not_evaluated。
5. Retry Unsafe interruption。
6. Cancel 优先于 Pause。
7. 无 Intent + Preflight passed 不写 Full Recovery。
8. 无 Intent + Preflight not_evaluated fail closed。
9. 旧 Owner Claim/sequence 被拒绝。
10. 无效 ExecutionAuthority 被拒绝。
11. 伪造 Claim Event ID 被拒绝。
12. 错误 Request / Attempt identity 被拒绝。
13. 同一 Request 额外 active Attempt 被拒绝。
14. Attempt.last_event_id = Interrupted Event ID。
15. 不创建新 Attempt。
16. 不调用 `executeValidated()`。
17. 初次成功后 Exact Replay 不重复写。
18. Owner A -> Owner B 跨 fencing Replay。
19. Stage 3.3 Cancel convergence 后 Replay。
20. Prepare child 后 Replay。
21. Event 写入失败整体 rollback。
22. Checkpoint 写入失败整体 rollback。
23. 普通对象与 spread clone Preflight result 被拒绝。

实际执行：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts tests/recovery/recovery-evidence-recovery-preflight.test.ts

Test Files  2 passed (2)
Tests       28 passed (28)
```

全量回归：

```text
pnpm test

Test Files  57 passed (57)
Tests       611 passed (611)
```

类型检查：

```text
pnpm typecheck
```

命令退出码为 0。

## 10. Schema / Migration 影响

无 Schema 或 Migration 影响。

- 复用 Migration v9。
- 未新增 Recovery Job / Command Store。
- 未新增 Migration v10。
- 未修改 Migration v4-v9。
- 未新增依赖。

## 11. 尚未解决的限制

1. `recoveryOperationId` 仍由调用方 / 测试提供。仓库尚无 Durable Recovery
   Job / Command Store，不能声称跨重启 operation identity 已恢复。
2. UoW 未通过 public HTTP / IPC / Worker 暴露，符合本步骤边界。
3. 无 Intent 且 Preflight `not_evaluated` 当前返回
   `retry_assessment_unavailable` 且不写 Interrupted Event。原因是 Step 1
   Schema 只允许 `not_evaluated` 与显式 Cancel / Pause Intent 共存。该路径
   必须由后续架构评审决定 Step 6 的明确持久化语义。
4. Pause failed / not_evaluated 虽然写入 interrupted lineage，但
   `resumeEligible=false`，返回 `manual_review`，不能走 Resume Continuation。
5. 本步骤没有创建 new Attempt、没有执行 Full Recovery，也没有改变
   Stage 3.2 Dispatch Gate 或 Stage 3.3 已封存行为。
6. 外部 Read 是否实际发生仍为 unknown；interrupted 只表示旧 Owner 不再
   拥有合法提交权。

## 12. 边界声明

本步骤仅完成 Stage 3.4 Step 5 Interruption-only UoW。

未实施：

- Stage 3.4 Step 6 及之后步骤。
- Full Interrupted Recovery。
- Pause Clear Resume Continuation。
- new Attempt 创建。
- Durable Recovery Job / Command Store。
- Recovery Lineage Repository 额外写路径。
- Stage 3.2 Dispatch Gate 修改。
- Stage 3.3 已封存行为修改。
- External Read / Transaction B。
- Verifier / Recovery Manager / Classifier。
- Step 6.3.5。
