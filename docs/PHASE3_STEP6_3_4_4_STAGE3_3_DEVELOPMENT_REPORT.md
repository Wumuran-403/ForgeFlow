# Phase 3 Step 6.3.4.4 Stage 3.3 Development Report

> 状态：Failure / Timeout / Cancellation / Pause / Resume UoW 完成，
> 等待 Stage 3.3 架构评审
>
> 边界：未实施 Stage 3.4 Interrupted Recovery、External Read、Transaction B
> 扩展或 Step 6.3.5。

## 1. 实际修改文件

生产代码：

- `src/recovery/recovery-evidence-host-control-authorization.ts`
- `src/recovery/index.ts`
- `src/storage/task-repository.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/recovery-evidence-dispatch-uow.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/recovery-evidence-state-matrix.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_3_DEVELOPMENT_REPORT.md`

没有新增依赖，没有新增 Migration v10，没有修改 Migration v4-v9 或 Schema。

## 2. 新增 UoW 接口

`RecoveryEvidenceUnitOfWork` 新增：

```text
setTaskWideRecoveryEvidenceCancel()
cancelOwnedRecoveryEvidenceRead()
failOwnedRecoveryEvidenceRead()
setTaskWideRecoveryEvidencePause()
clearTaskWideRecoveryEvidencePause()
blockOwnedRecoveryEvidenceReadForIntent()
recordOwnedRecoveryEvidenceReadPauseObserved()
resumeBlockedOwnedRecoveryEvidenceRead()
```

新增进程内 Host Control capability：

```text
issueRecoveryEvidenceHostControlAuthorization()  // internal-only
assertRecoveryEvidenceHostControlAuthorization()
```

Capability 使用模块私有 `WeakMap`，绑定：

```text
taskId
operation = cancel_set | pause_set | pause_clear
requestNonce
controlActor
```

普通对象、spread clone、JSON clone 和 cast 无法签发有效
HostControlAuthorization。Capability 不持久化。Issuer 不从公开
`src/recovery/index.ts` 导出；普通 Recovery Service / Agent Runtime 只能
接收 Capability，不能通过公开 Recovery API 签发。

## 3. Failure / Timeout

`failOwnedRecoveryEvidenceRead()` 只接受：

```text
failed
timed_out
```

状态转换：

| 结果 | Attempt | ToolRun | PlanStep | ExecutionPlan |
|---|---|---|---|---|
| failed | dispatching -> failed | running -> failed | running -> failed | active -> failed |
| timed_out | dispatching -> timed_out | running -> timed_out | running -> failed | active -> failed |

约束：

- `prepared -> failed / timed_out` 被拒绝。
- Outcome uncertain 没有业务入口；调用方不得调用 Failure UoW。
- reasonCode 使用稳定 `UPPER_SNAKE_CASE`，不保存原始异常。
- Cancel / Pause 不阻止已经确定的 Failure / Timeout 执行事实落库。
- Attempt Event 保存当时最新 `controlIntentKind` 和
  `controlIntentEventId` 审计字段。
- Failure / Timeout 不使用 Task.version 作为执行事实 CAS；Control Intent
  Event 引起的 Task.version 变化不会丢弃已确定结果。Attempt、ToolRun、
  PlanStep、Plan、Lease 和 Fencing 仍全部 CAS。
- Attempt Event、Tool Event、下游状态和 Checkpoint 在同一 immediate
  transaction 内提交。
- 相同 terminal 结果和 reasonCode 的 Exact Replay 不重复写 Event /
  Checkpoint，但仍要求当前 Lease / Fencing / Authority 有效。

## 4. Task-wide Cancel

`setTaskWideRecoveryEvidenceCancel()`：

```text
HostControlAuthorization(cancel_set)
  -> waiting_review Task
  -> latest Cancel generation check
  -> Task version CAS
  -> set cancel_requested_at
  -> append recovery.evidence.cancel_requested
  -> Checkpoint
```

该入口不要求执行 Task Lease，也不调用 Executor ExecutionAuthority。

同一 requestNonce 且仍是最新 Cancel generation 时返回 Exact Replay，
不覆盖时间戳、不重复写 Event / Checkpoint。

`cancelOwnedRecoveryEvidenceRead()` 按 Request 收敛：

- 幂等身份：
  `taskId + readbackRequestId + cancelIntentEventId`。
- prepared -> cancelled，并取消下游。
- dispatching Cancel 在缺少可信 Settlement capability 时 fail closed；
  普通调用方枚举不再被接受。
- blocked_by_intent 保留 Attempt，取消 ToolRun / PlanStep / Plan。
- interrupted 保留 Attempt，取消 ToolRun / PlanStep / Plan。
- failed / timed_out / cancelled 返回 terminal conflict，不强制改写。
- Transaction B 完成时返回 completed Replay，不回滚 EvidenceRead / Check。
- 多 active Attempt 返回 state_inconsistent。

Task-wide Cancel 事件可以覆盖同一 Task 下多个 Request；每个 Request
独立提交或失败，不批量伪造成功。

## 5. Task-wide Pause

`setTaskWideRecoveryEvidencePause()`：

```text
HostControlAuthorization(pause_set)
  -> latest Cancel gate
  -> Task version CAS
  -> set pause_requested_at
  -> append recovery.evidence.pause_requested
  -> Checkpoint
```

`clearTaskWideRecoveryEvidencePause()`：

```text
HostControlAuthorization(pause_clear)
  -> latest Cancel gate
  -> expected pauseRequestedAt
  -> expected Pause Event ID + sequence
  -> verify no newer Pause generation
  -> clear pause_requested_at
  -> append recovery.evidence.pause_cleared
  -> Checkpoint
```

规则：

- 不要求执行 Task Lease；Worker 持有 Lease 时 Host 仍可提交 Pause。
- 不调用 Executor ExecutionAuthority。
- 同一仍有效 Pause generation 的 Exact Replay 不重复写 Event /
  Checkpoint。
- Clear 只接受对应 generation；迟到 Clear 不能清除新 Pause。
- Cancel 存在时 Pause Set / Clear / Resume 全部拒绝。
- 普通 Task status transition 不用于清除 Pause。

## 6. Pause Block / Observed

`blockOwnedRecoveryEvidenceReadForIntent()`：

```text
prepared -> blocked_by_intent
```

- ToolRun 保持 queued。
- ExecutionPlan 保持 active。
- 首次 PlanStep 保持 queued。
- Retry PlanStep 保持 running。
- Attempt Event 绑定 `intentEventId = pauseRequestEventId`。
- Exact Replay 在 Pause 已清除后仍可只读返回持久化 blocked 结果。

`recordOwnedRecoveryEvidenceReadPauseObserved()` 只追加 Event 和
Checkpoint，不改变 Attempt / ToolRun / PlanStep / ExecutionPlan。

Event 绑定：

```text
readbackRequestId
readAttemptId
attemptNumber
dispatchEventId
pauseRequestEventId
attemptStatusAtPause
interruptionCause
resumeEligible
externalCallStarted
fencingToken
```

`externalCallStarted` 支持：

```text
true | false | unknown
```

该字段只表示本地执行器是否进入 Tool 调用边界，不证明远端收到请求。

同一 Request + Attempt + Pause generation 的重复 Observed 调用返回
Exact Replay；不同本地事实绑定同一 key 时返回冲突。

## 7. Explicit Resume

`resumeBlockedOwnedRecoveryEvidenceRead()` 只接受：

- prior Attempt = blocked_by_intent。
- Task = waiting_review。
- `pause_requested_at IS NULL`。
- 指定 pause_cleared Event 存在且匹配被清除的 Pause generation。
- clear 之后没有新的 pause_requested Event。
- 没有 Cancel。
- Lease / Fencing / ExecutionAuthority 有效。

创建：

```text
new Attempt = prepared
ToolRun = queued
PlanStep = 保持 queued（首次）或 running（Retry）
ExecutionPlan = active
```

prepared Event 写入：

```text
priorAttemptId
newAttemptId
pauseClearEventId
pauseRequestEventId
resumeCause = pause
attemptNumber
fencingToken
```

Resume：

- 不再次清除 pause_requested_at。
- 不执行 Dispatch / External Read。
- 使用持久化 MAX attemptNumber + 1。
- 同一 Request / ToolRun 最多一个 active Attempt。
- Exact Replay 返回同一个已创建 Attempt，不重复写 Event / Checkpoint。
- Stage 3.2 Dispatch 已扩展 Pause Resume lineage 校验，允许 Resume 后
  再经过正常 Dispatch Gate。
- interrupted 仍只能由 Stage 3.4 恢复。

## 8. Exact Replay 与 generation CAS

| UoW | Exact Replay key | 行为 |
|---|---|---|
| Failure / Timeout | task + request + attempt + terminal status + reasonCode | 返回 terminal history，不重复写 |
| Task Cancel Set | task + requestNonce | 返回最新 Cancel Event |
| Task Pause Set | task + requestNonce | 返回最新 Pause Event |
| Pause Clear | task + pause generation + clear requestNonce | 返回原 clear Event |
| Pause Block | attempt + pauseRequestEventId | 返回原 blocked Attempt |
| Pause Observed | request + attempt + pause generation | 返回原 observed Event |
| Resume | request + priorAttempt + pauseClearEventId + newAttemptId | 返回原 new Attempt |
| Request Cancel | request + cancelIntentEventId | 返回原 cancelled / completed |

所有 Replay 仍先验证当前 Lease / Fencing / ExecutionAuthority；Replay
不会为旧 Owner 恢复写权限。

Task version CAS：

- Host Intent 字段更新使用当前 Task version 做 CAS。
- Event allocation 负责递增 Task.version。
- Event/Checkpoint 失败时字段更新随 transaction 一起 rollback。
- Exact Replay 位于新写入 CAS 之前。

## 9. ExecutionPlan version 修正

多 Request Cancel 测试暴露出：

`ExecutionPlan.version` 是 Task 内 plan generation identity，不是 row
status CAS version。

原 `updateStatusCas()` 在状态变化时递增 version，可能使两个 Recovery
Plan 的 generation 冲突。现已改为：

- `version` 只用于 CAS 条件，状态变化时不递增。
- `status` / `updated_at` 更新仍受 StorageWritePermit 和
  expectedStatus + expectedVersion 保护。

## 10. 测试场景

本轮覆盖：

1. Failure 正常转换和 Exact Replay。
2. Timeout 映射为 Attempt timed_out + Plan failed。
3. prepared -> failed / timed_out 拒绝。
4. Failure 在 Cancel / Pause 存在时零写入。
5. Cancel prepared。
6. Cancel dispatching 在无可信 Settlement 来源时 fail closed。
7. Cancel blocked_by_intent，Attempt 保持原状态。
8. Cancel interrupted，Attempt 保持原状态。
9. Cancel terminal conflict。
10. Cancel after Transaction B completed 不回滚。
11. 一个 Task-wide Cancel 逐项取消多个 Request。
12. 单 Request Cancel 失败不影响其他 Request。
13. Pause Set / Clear Exact Replay。
14. 新 Pause generation 阻止旧 Clear / Resume。
15. Worker 持有 Lease 且本地 Authority 撤销时 Host Pause 仍可提交。
16. Pause block 首次 queued 与 Retry running 状态矩阵。
17. Pause observed true / false / unknown。
18. Pause observed 绑定 Dispatch Event 和 Pause generation。
19. Pause observed 失败整体 rollback，随后旧 Authority 写入被拒绝。
20. Host Pause Event / Checkpoint 失败整体 rollback。
21. Resume 创建新 Attempt、attemptNumber 递增。
22. Resume Exact Replay 不重复写。
23. Resume 后通过 Stage 3.2 Dispatch Gate。
24. Cancel 优先于 Pause block / Clear。
25. 伪造或 operation scope 错误的 HostControlAuthorization 被拒绝。
26. 多 Request 下 ExecutionPlan generation 不冲突。
27. Original Agent Plan / Original Unknown Write / Task.status 保持不变。

## 11. 实际执行结果

Stage 3.3 专项：

```text
pnpm vitest run tests/storage/recovery-evidence-dispatch-uow.test.ts tests/storage/recovery-evidence-uow.test.ts tests/storage/recovery-evidence-state-matrix.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       121 passed (121)
```

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  52 passed (52)
Tests       542 passed (542)
```

Typecheck：

```text
pnpm typecheck
```

结果：通过。

Diff check：

```text
git diff --check
```

结果：通过，仅有工作区既有 LF/CRLF normalization warning。

## 12. 已知限制

- Stage 4 尚未实现，因此 dispatching Cancel fail closed；后续必须由可信
  Executor / Dispatch 生命周期签发绑定 Task、Request、Attempt、Dispatch
  Event 和 fencingToken 的 opaque Settlement capability。
- Pause observed 的 Authority revoke / Abort / Lease release 属于 Executor
  生命周期；UoW 只持久化 observation。调用方必须保证写入失败时也撤销
  Authority 并停止旧结果提交。
- Stage 3.4 Interrupted Recovery 和 Recovery Lineage writer 未实现；
  interrupted Attempt 仍不能通过本阶段 Resume。
- 当前既有 Transaction B completion 代码未同步把 Recovery Evidence Plan
  更新为 completed。Cancel-after-completion 只识别已存在的 Check +
  EvidenceRead 并返回持久化完成结果，不补写或回滚 Plan；该项留给后续
  Transaction B 评审/实现。
- Pause Retry 的 PlanStep=running 由状态矩阵覆盖，但合法 Retry Attempt
  创建仍依赖 Stage 3.4 或后续已批准路径。

## 13. 边界声明

本轮未实施：

- Stage 3.4 Interrupted Recovery UoW。
- Recovery Lineage writer。
- Fencing takeover 后 interrupt + new Attempt 组合事务。
- External Read / `ToolRegistry.executeValidated()`。
- Payload Store / Transaction B 扩展。
- Controlled Provenance / Verifier / Recovery Manager。
- Provider / LLM / Write。
- Migration v10。
- Step 6.3.5。

完成后停止，等待 Stage 3.3 架构评审。
