# ForgeFlow Phase 3 Stage 3.4 Step 6 Supplementary Architecture Audit

> 状态：只读补充架构审查完成。
>
> 结论：Step 6 暂不应通过架构评审。
>
> 本轮未修改生产代码、测试、Migration、Schema 或依赖。

## 1. 实际检查的文件

生产代码：

- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-state-matrix.ts`
- `src/storage/tool-run-repository.ts`
- `src/storage/plan-step-repository.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/event-repository.ts`
- `src/storage/checkpoint-store.ts`
- `src/storage/transaction.ts`
- `src/storage/write-boundary.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/recovery-evidence-recovery-lineage.ts`

测试与文档：

- `tests/storage/recovery-evidence-interruption.test.ts`
- `tests/storage/recovery-evidence-state-transition-lineage.test.ts`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP6_DEVELOPMENT_REPORT.md`
- Step 1-5 Development Reports
- Stage 3.4 Implementation Plan

## 2. State Transition UoW 审查

### 2.1 逐项结论

| 问题 | 实际结论 |
|---|---|
| ToolRun `interrupted -> queued` 是否通过 State Transition UoW？ | 否。Step 6 直接调用 `ToolRunRepository.transition()` |
| PlanStep `interrupted -> running` 是否通过 State Transition UoW？ | 否。Step 6 直接调用 `PlanStepRepository.updateStatusCas()` |
| Prepared Event 是否通过统一状态转换写入？ | 否。Step 6 直接调用 `EventRepository.append()` |
| New Attempt `prepared` 是否由统一状态转换机制验证？ | 否。Step 6 直接调用 `RecoveryEvidenceReadAttemptRepository.insertPrepared()` |
| 是否检查 Lease / Fencing / Authority？ | 在 UoW 入口检查，并在 Prepared Event 后通过 Claim Guard 再检查；但直接 Repository 写本身不执行这些检查 |
| 是否检查源/目标状态和实体一致性？ | 有手工检查与 CAS，但不等于 State Matrix / State Transition UoW 的统一业务不变量 |
| 是否存在直接 Repository update / insert？ | 是，详见下表 |
| 同一 Immediate Transaction 是否只有一个 Permit？ | 是 |

### 2.2 实际写入路径

`RecoveryEvidenceFullRecoveryUnitOfWork.recoverOwnedRecoveryEvidenceReadAttempt()`
在当前事务中执行：

```text
1. State Transition UoW
   Attempt dispatching -> interrupted
   ToolRun running -> interrupted
   PlanStep running -> interrupted
   Plan active

2. ToolRunRepository.transition()
   interrupted -> queued

3. EventRepository.append()
   tool.queued

4. PlanStepRepository.updateStatusCas()
   interrupted -> running

5. EventRepository.append()
   recovery.evidence.read_attempt_prepared

6. RecoveryEvidenceReadAttemptRepository.insertPrepared()
   new Attempt = prepared

7. CheckpointStore.append()
```

第 1 步通过已封存 `RecoveryEvidenceStateTransitionUnitOfWork`。

第 2-7 步位于同一个 immediate transaction 和同一个
`StorageWritePermit` 下，但没有全部经过 State Transition UoW。

### 2.3 三类边界不能混同

SQLite transaction atomicity：

- 成立。
- 任一步抛错会 rollback。

Repository / Schema constraints：

- ToolRun transition 检查 expected status。
- PlanStep update 检查 expected status / version。
- Attempt insert trigger检查 Prepared Event 的
  `readAttemptId / attemptNumber / attemptStatus` 基本绑定。
- Event / Checkpoint 检查 transaction permit。

State Transition business invariants：

- 不成立。
- `ToolRunRepository.transition()` 与 `PlanStepRepository.updateStatusCas()`
  本身不会调用 `canTransitionToolRunStatus()` /
  `canTransitionPlanStepStatus()`。
- Prepared New Attempt 不经过 State Matrix。
- Full Recovery UoW 手工重复了一部分状态一致性检查，但没有统一执行器。

因此不能因为所有写入位于同一个 SQLite transaction，就认定它们等价于
State Transition UoW。

### 2.4 架构缺口

当前 State Matrix 只有：

```text
dispatching
blocked_by_intent
failed
timed_out
cancelled
interrupted
```

没有 prepare-recovered target。Step 6 因此直接调用了 Repository。这正是
本次审查发现的主要架构缺陷。

## 3. Task 状态 / Dispatch Gate 审查

### 3.1 Task 状态追踪

Step 5 起始：

```text
Task.status = waiting_review
```

Step 6 Full Recovery：

- 不修改 `tasks.status`。
- 不调用 `TaskRepository.updateStatusCas()`。
- Event append 由 `SequenceAllocator.nextEventSequence()` 增加
  `tasks.last_event_sequence` 和 `tasks.version`。

Step 6 后：

```text
Task.status = waiting_review
Task.version = 新值
Task.last_event_sequence = 新值
```

Task version 的变化来自同一 transaction 内的 Event append，不是 Task
status transition。

### 3.2 Stage 3.2 Dispatch Gate 实际要求

`RecoveryEvidenceUnitOfWork.beginOwnedRecoveryEvidenceRead()` 实际调用：

```text
assertOwnedRecoveryTask()
  -> Lease / Fencing valid
  -> Task.status == waiting_review
```

随后 Dispatch Gate 对 Prepared Attempt 要求：

```text
Attempt.status = prepared
ToolRun.status = queued
PlanStep.status = queued | running
Plan.status = active
Request / Reservation / Review / Operation binding valid
只有一个 active Attempt
Prepared Event 存在
AttemptNumber > 1 时 Retry Dispatch Lineage 有效
```

Step 6 产生：

```text
Task = waiting_review
Attempt = prepared
ToolRun = queued
PlanStep = running
Plan = active
Prepared Event with recoveryOperationId / interruptionEventId /
newAttemptId / claim sequence
```

静态追踪结论：当前 Prepared Attempt 满足 Stage 3.2 Dispatch Gate 的
状态前置条件。Task 不需要额外的 `waiting_review -> ???` 转换。

### 3.3 Task version 与 Replay

Full Recovery 写 Event 会改变 Task version。Exact Replay 在检查
`expectedTaskVersion` 前先命中 Prepared Event，因此调用方使用原始
expected version 仍可返回历史 Prepared Attempt。

Replay 仍需提供当前有效 Lease / Fencing / Authority / Claim Event。
历史 Task version 不会被重写。

### 3.4 未覆盖项

当前没有通过 `beginOwnedRecoveryEvidenceRead()` 实际执行 Step 6 Prepared
Attempt 的端到端测试。上述 Dispatch Gate 结论来自真实源码静态追踪，不是
本次实际执行结果。该集成测试属于 Step 7 范围，本轮未执行。

## 4. Exact Replay / Operation Identity 审查

### 4.1 `newAttemptId` 冲突行为

当前行为：

```text
首次:
  recoveryOperationId = R1
  newAttemptId = A1
  -> 创建 A1

再次:
  recoveryOperationId = R1
  newAttemptId = A2
  -> 找到历史 A1
  -> 检测 A2 != A1
  -> 抛出 RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT
```

结论：明确 fail closed，不会创建 A2。

若再次调用不提供 `newAttemptId`，Replay 返回 A1。首次由 UoW 自动生成的 ID
也能在响应丢失后通过稳定 `recoveryOperationId` 找回。

### 4.2 其他 identity 行为

同一 operation：

- Prepared Event 匹配数 > 1：`RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT`。
- 不同 Request / ToolRun / prior Attempt：失败。
- 新 Owner Replay：当前 Lease / Fencing / Authority / Claim Event 先验证。
- 历史 Prepared Claim / fencing：只读验证，不覆盖。
- 不重复写 Prepared Event / Checkpoint。

### 4.3 测试缺口

当前测试没有独立构造：

```ini
first newAttemptId = A1
replay newAttemptId = A2
```

代码行为已经明确 fail closed，但缺少专项回归测试。

当前 `different Request + same operation` 测试通过追加第二个 Prepared Event
触发 “multiple Prepared Events”，没有单独测试“只有一个 Prepared Event，
但 payload Request 不同”的分支。

## 5. 测试场景映射

测试文件：

`tests/storage/recovery-evidence-interruption.test.ts`

以下“已执行”引用 Step 6 Development Report 中实际执行结果：

```text
Test Files  1 passed (1)
Tests       22 passed (22)

Full suite:
Test Files  57 passed (57)
Tests       620 passed (620)
```

| 场景 | 实际测试 / 结论 |
|---|---|
| 1. 合法 Interrupted 创建 New Attempt | `atomically creates a prepared New Attempt from dispatching`；已执行 |
| 2. New Attempt ID 不同 | 同上；已执行 |
| 3. Attempt Number 严格递增 | 同上，断言 2；已执行 |
| 4. 原 Interrupted Attempt 保持 | 同上，断言旧 Attempt interrupted；已执行 |
| 5. Prepared 引用正确 Interrupted Event | 同上；已执行 |
| 6. Prepared 引用真实 Claim | 同上；已执行 |
| 7. Claim Sequence < Prepared | 代码/Claim Guard 验证；测试间接覆盖，无独立 sequence 断言 |
| 8. Retry failed 不创建 Attempt | `does not create an Attempt when Preflight is failed or unavailable`；已执行 |
| 9. Resume Eligible false 不创建 | `rejects Pause failed / not_evaluated ...`；已执行 |
| 10. Intent Digest mismatch | 同一 Preflight failed 测试内的 digest mismatch；已执行 |
| 11. Allowlist / Tool / Schema mismatch | Allowlist unavailable 已执行；Tool/Schema mismatch 具体分类引用 Step 3 专项测试，Step 6 未独立重测 |
| 12. 冲突 active Attempt | `gives Cancel priority and rejects conflicting active Attempts`；已执行 |
| 13. Pause 未 Clear | `resumes after Pause Clear ...` 中 `pause_blocked`；已执行 |
| 14. Pause Clear 后 Resume | 同上；已执行 |
| 15. Resume 使用新 Claim | 同上；已执行 |
| 16. 旧 Owner Claim 拒绝 | 同上；已执行 |
| 17. Pause failed 不 Resume | `rejects Pause failed / not_evaluated ...`；已执行 |
| 18. Pause not_evaluated 不 Resume | 同上；已执行 |
| 19. 错误 Pause Clear | 同上；已执行 |
| 20. Cancel 优先 Pause | `gives Cancel priority and rejects conflicting active Attempts`；已执行 |
| 21. 首次 prepare 后重复返回同 Attempt | `replays the same Prepared Event across owners`；已执行 |
| 22. Replay 不重复 Prepared Event | 同上；已执行 |
| 23. Replay 不重复 Checkpoint | 同上；已执行 |
| 24. Owner A prepare / Owner B Replay | 同上；已执行 |
| 25. 不同 Request 同 operation | `fails closed for conflicting operation identity ...`；通过 duplicate Prepared Event 覆盖，非单 Event 错 Request 独立测试 |
| 26. 历史 Claim / fencing 不覆盖 | `replays the same Prepared Event across owners`；已执行 |
| 27. 合法 downstream 后 Replay | 同上，测试 prepared -> dispatching；已执行 |
| 28. 非法 downstream 后 Replay | `fails closed for conflicting operation identity and illegal replay state`；已执行 |
| 29. Attempt 写入失败 rollback | `rolls back Attempt, Prepared Event, Tool Event and Checkpoint failures`；已执行 |
| 30. Prepared Event 失败 rollback | 同上；已执行 |
| 31. Tool Event 失败 rollback | 同上；已执行 |
| 32. Checkpoint 失败 rollback | 同上；已执行 |
| 33. Cancel / Pause / Lease 竞争 | Cancel/Pause 有测试；stale Authority/Claim 有测试；Step 6 内没有直接跨连接 Lease 竞争测试 |
| 34. 无 Intent + Preflight not_evaluated | `does not create an Attempt when Preflight is failed or unavailable`；已执行 |
| 35. 不执行 External Read | `atomically creates ...`；未调用工具执行路径 |
| 36. 不调用 `executeValidated()` | `atomically creates ...` 使用 spy；已执行 |

额外缺口：

- 无显式 `newAttemptId=A2` Replay 冲突测试。
- 无单 Prepared Event + 错 Request payload 的独立测试。
- 无 Step 6 -> Stage 3.2 `beginOwnedRecoveryEvidenceRead()` 集成测试。

## 6. `git diff --check`

本次实际执行：

```text
git diff --check
```

退出码为 0。输出仅包含工作树现有 LF/CRLF 归一化 warning，没有 whitespace
error。该命令不检查未跟踪文件内容。

本次没有重复执行 Step 6 专项测试或全量测试；以上测试数字引用 Step 6
Development Report 中已经执行的结果。

## 7. 已发现的缺陷

### P1. Prepare-side State Transition UoW 绕过

问题：

- ToolRun requeue、PlanStep requeue、Prepared Event、New Attempt insert
  都是直接 Repository 调用。
- 统一 transaction permit 和 SQLite atomicity 不能替代 State Transition
  business invariants。

影响：

- 状态机不变量分散在 Full Recovery UoW 手工代码和 Schema trigger 中。
- 后续修改可能只更新 State Matrix，却遗漏 Full Recovery 手工路径。
- 无法证明所有 recovery 状态迁移走同一批准机制。

### P2. 缺少 `newAttemptId` 冲突专项测试

代码已 fail closed，但无显式 A1/A2 回归测试。

### P2. 缺少 Stage 3.2 Dispatch Gate 集成测试

静态追踪通过，但尚未真实验证 Step 6 Prepared Attempt 进入
`beginOwnedRecoveryEvidenceRead()`。Step 7 尚未授权。

### P3. 测试覆盖表述略强

Development Report 将 35 项列为覆盖，但第 25 项采用 duplicate-event
近似测试，第 11 项 Tool/Schema mismatch 依赖 Step 3 测试，第 33 项没有
Step 6 内跨连接 Lease 竞争。

## 8. 最小修复建议

建议先获得架构批准，再新增一个内部 Prepare Recovery State Transition
method，例如：

```text
RecoveryEvidenceStateTransitionUnitOfWork
  .prepareRecoveredReadAttemptInCurrentTransaction({
    currentTransactionPermit,
    ownership,
    currentLeaseClaimEventId,
    expectedTaskVersion,
    expectedAttemptVersion,
    expectedToolRunVersion,
    expectedPlanStepVersion,
    expectedPlanVersion,
    priorAttemptId,
    newAttemptId,
    prepareLineage
  })
```

职责：

1. 验证 current-transaction permit。
2. 验证 Lease / Fencing / ExecutionAuthority。
3. 验证 source states：
   - old Attempt interrupted
   - ToolRun interrupted
   - PlanStep interrupted
   - Plan active
4. 应用明确 prepare-recovery matrix：
   - ToolRun interrupted -> queued
   - PlanStep interrupted -> running
   - Plan active
5. 验证 Prepared Event / New Attempt / attempt number / lineage。
6. 在同一 permit 下写 Event、Attempt、Tool Event、Checkpoint。

不建议直接扩大现有 `RecoveryEvidenceTransitionTargetSchema` 来把
“new Attempt prepared”伪装成普通 Attempt update；这是一个 insert +
cross-entity transition，需要独立 prepare-recovery 规则。

## 9. 是否需要修改 Step 6 生产代码

需要，但本轮未修改。

若架构评审接受“Prepare Recovery UoW”作为统一状态转换器：

- Full Recovery UoW 应改为调用该内部 UoW。
- State Transition UoW 可新增方法，但不改变既有
  `transitionOwnedRecoveryEvidenceReadAttempt...` 行为。
- 测试应补：
  - 合法 prepare matrix；
  - 非法源状态 / target 组合；
  - A1/A2 Replay conflict；
  - 单 Event wrong Request；
  - Step 7 授权后的 Dispatch Gate integration。

## 10. 修复范围和禁止范围

下一步若获授权，最小修复范围：

- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
- Step 6 专项测试
- Step 6 报告 / Supplementary Audit

禁止：

- 修改 Migration v9 / Schema。
- 新增 Migration v10。
- 修改 Stage 3.2 Dispatch Gate。
- 修改 Stage 3.3 已封存 UoW。
- 修改 Step 1 Lineage Schema。
- 实施 Step 7 / Step 8。
- 实施 External Read / Transaction B。
- 创建 Durable Recovery Job。
- 新增依赖。

本报告完成后停止，等待架构评审。
