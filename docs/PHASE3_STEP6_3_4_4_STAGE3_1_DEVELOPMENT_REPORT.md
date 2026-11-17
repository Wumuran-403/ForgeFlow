# Phase 3 Step 6.3.4.4 Stage 3.1 Development Report

> 状态：State Transition & Event Matrix 完成，等待 Stage 3.1 架构评审
>
> 范围：Recovery Evidence 状态矩阵、Attempt / ToolRun / PlanStep /
> ExecutionPlan 原子一致性、Attempt 与 Request-level Event
>
> 边界：未实现 Stage 3.2 Dispatch UoW、Stage 3.3 Failure/Cancel/Pause/
> Resume UoW、Stage 3.4 Recovery UoW，也未进入 Stage 4。
>
> Supplementary Review：状态矩阵执行器已从公开
> `RecoveryEvidenceUnitOfWork` 拆分为 storage-internal
> `RecoveryEvidenceStateTransitionUnitOfWork`。详见
> `PHASE3_STEP6_3_4_4_STAGE3_1_SUPPLEMENTARY_REVIEW.md`。

## 1. 实际修改文件

生产代码：

- `src/storage/recovery-evidence-state-matrix.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/recovery-evidence-state-matrix.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_1_DEVELOPMENT_REPORT.md`

没有新增依赖，没有修改 Migration、Schema 或数据库定义。

## 2. 每个文件的修改内容

### 2.1 `recovery-evidence-state-matrix.ts`

新增纯状态矩阵：

- `RecoveryEvidenceTransitionTargetSchema`
- `resolveRecoveryEvidenceStateMatrix()`
- `RecoveryEvidenceStateMatrixInput`
- `RecoveryEvidenceStateMatrixResult`

矩阵验证：

- Plan 必须为 `recovery_evidence`。
- PlanStep 必须为 `read_batch`。
- 首次 Dispatch：PlanStep queued -> running。
- Retry Dispatch：PlanStep 保持 running。
- ToolRun 必须 queued -> running。
- Pause：只允许 Attempt prepared -> blocked_by_intent，下游不变。
- Failure / Timeout / Cancel / Interrupt 使用真实 Attempt、
  ToolRun、PlanStep、ExecutionPlan 状态组合。
- Cancel blocked/interrupted 时 Attempt 不变，只收敛下游记录。
- Agent Plan、write PlanStep、terminal Attempt 复活等组合均拒绝。

ToolRun / PlanStep 转换调用现有：

```text
canTransitionToolRunStatus()
canTransitionPlanStepStatus()
```

没有通过通用 Repository 方法绕过 ExecutionStateMachine 规则。

### 2.2 `execution-plan-repository.ts`

新增：

```text
updateStatusCas()
```

仅允许：

```text
active -> completed
active -> failed
active -> cancelled
```

使用 `id + expectedStatus + expectedVersion` CAS 更新，冲突返回
`EXECUTION_PLAN_STATE_CONFLICT`。

### 2.3 `recovery-evidence-state-transition-unit-of-work.ts`

内部状态矩阵执行器：

```text
RecoveryEvidenceStateTransitionUnitOfWork
transitionOwnedRecoveryEvidenceReadAttempt()
```

该内部类不通过 `src/storage/index.ts` 导出；业务 Service 持有的
`RecoveryEvidenceUnitOfWork` 不再暴露 transition 方法。

现为一个 immediate transaction 内的状态矩阵执行：

```text
Lease / Fencing / Authority
  -> Task version CAS
  -> Attempt / Request / ToolRun / PlanStep / ExecutionPlan binding
  -> exact replay lookup
  -> state matrix validation
  -> Attempt transition（如实际发生）
  -> ToolRun transition（如实际发生）
  -> PlanStep transition（如实际发生）
  -> ExecutionPlan transition（如实际发生）
  -> corresponding tool Event（如 ToolRun 变化）
  -> Checkpoint
COMMIT
```

关键行为：

- `prepared -> dispatching` 同时让 ToolRun queued -> running、PlanStep
  queued/running -> running。
- `dispatching -> failed` 同时让 ToolRun failed、PlanStep failed、
  Recovery Plan failed。
- `dispatching -> timed_out` 同时让 ToolRun timed_out、PlanStep failed、
  Recovery Plan failed。
- `dispatching -> interrupted` 同时让 ToolRun interrupted、PlanStep
  interrupted，ExecutionPlan 保持 active。
- `prepared/dispatching -> cancelled` 同步取消 ToolRun、PlanStep 和
  Recovery Plan。
- blocked_by_intent / interrupted 的 Cancel 保留历史 Attempt 状态，只
  收敛 ToolRun、PlanStep 和 Recovery Plan。
- failed / timed_out / cancelled / completed Attempt 不会被强制改写。
- 只修改 `purpose=recovery_evidence` 的 Plan。
- Original Agent Plan / PlanStep / Unknown Write 不变。

### 2.4 `src/storage/index.ts`

导出状态矩阵类型与函数，供 Stage 3.2–3.4 后续复用。

### 2.5 测试文件

`recovery-evidence-state-matrix.test.ts` 覆盖纯矩阵允许与拒绝组合。

`recovery-evidence-uow.test.ts` 增加：

- 原子 Dispatch / Retry Dispatch。
- Failure / Timeout / Cancel / Interrupt 多记录转换。
- blocked_by_intent / interrupted Request-level Cancel。
- Exact Replay 不重复写 Event / Checkpoint。
- terminal Attempt 拒绝改写。
- Pause 不映射 Cancel。
- Checkpoint 失败整体回滚。
- Original Agent Plan / Unknown Write 保持不变。
- ToolRegistry `executeValidated()` 未被调用。

## 3. Event / Checkpoint 实现

实际 Attempt 状态转换：

- 恰好写一个对应 Attempt Event：

```text
recovery.evidence.read_attempt_dispatching
recovery.evidence.read_attempt_blocked_by_intent
recovery.evidence.read_attempt_failed
recovery.evidence.read_attempt_timed_out
recovery.evidence.read_attempt_cancelled
recovery.evidence.read_attempt_interrupted
```

ToolRun 实际变化时写对应 Tool Event：

```text
tool.started
tool.failed
tool.timed_out
tool.cancelled
tool.interrupted
```

Attempt 保持原状态、仅 Request-level Cancel 收敛下游时：

```text
recovery.evidence.readback_cancelled
```

该 Event 包含：

```text
readbackRequestId
readAttemptId
cancelIntentEventId
previousAttemptStatus
reasonCode
fencingToken
```

每次成功转换写一个 Checkpoint。以下路径不重复写：

- Attempt exact replay。
- Request-level Cancel exact replay。
- 非法/冲突操作。

## 4. 测试场景

专项覆盖：

1. 首次 Dispatch 的 PlanStep queued -> running。
2. Retry Dispatch 的 PlanStep running 保持不变。
3. prepared Cancel。
4. dispatching Cancel。
5. blocked_by_intent Request-level Cancel。
6. interrupted Request-level Cancel。
7. failed / timed_out / cancelled terminal 不被改写。
8. Pause 不映射 Cancel。
9. Attempt Event 唯一性。
10. Request-level Cancel Event 唯一性。
11. Exact Replay 不重复追加 Event / Checkpoint。
12. Checkpoint 写入失败时多记录整体 rollback。
13. Original Agent Plan / Unknown Write 不变。
14. ToolRegistry.executeValidated() 调用次数为 0。
15. Agent Plan / write PlanStep / terminal Attempt 的非法组合拒绝。

## 5. 实际测试结果

Stage 3.1 专项：

```text
pnpm vitest run tests/storage/recovery-evidence-state-matrix.test.ts tests/storage/recovery-evidence-uow.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       78 passed (78)
```

Stage 3.1 受影响回归：

```text
pnpm vitest run tests/storage/recovery-evidence-state-matrix.test.ts tests/storage/recovery-evidence-uow.test.ts tests/recovery/recovery-evidence-readback-service.test.ts tests/storage/recovery-evidence-readback-reservation.test.ts
```

结果：

```text
Test Files  4 passed (4)
Tests       101 passed (101)
```

首次全量运行出现一个既有时间敏感集成测试失败：

```text
tests/integration/persistent-execution.test.ts
heartbeats while ApprovalHandler is waiting
```

该失败堆栈未进入 Stage 3.1 修改文件；随后单独复跑该测试通过，再重新
执行全量测试通过。

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  51 passed (51)
Tests       498 passed (498)
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

结果：通过，仅有工作区既有的 LF/CRLF normalization warning。

## 6. 已知限制与遗留问题

- Stage 3.1 只实现状态转换机制，没有实现 Stage 3.2 的 Dispatch 授权、
  Allowlist preflight、Task/Review 业务 gate。
- Stage 3.3 仍需在调用状态矩阵前执行最新 Cancel/Pause Intent 检查、
  Cancel Intent generation 和 Request-level 业务策略。
- Stage 3.4 仍需实现 Fencing Takeover、Retry Safety、Recovery Lineage、
  interrupt + new Attempt。
- Transaction B completed 的 `dispatching -> completed` 继续由现有
  `completeOwnedRecoveryEvidenceRead()` 负责，本阶段没有扩展该事务。
- Request-level Cancel 的稳定 `transitionOperationId` 由 Stage 3.3
  Host Intent 层提供；No-active Cancel 缺少该 ID 时 fail closed。
- Event 唯一性由 immediate transaction + 查询已有 Event 实现；数据库
  没有额外唯一索引。

## 7. 边界声明

本轮：

- 未实施 Stage 3.2 Dispatch UoW。
- 未实施 Stage 3.3 Failure / Timeout / Cancel / Pause / Resume UoW。
- 未实施 Stage 3.4 Interrupted Recovery UoW。
- 未实现 External Read、Payload Store、Transaction B、
  Controlled Provenance、Verifier 或 Recovery Manager。
- 未修改 Task.status、Original Unknown Write、RecoveryReview Final
  Decision。
- 未新增 Migration v10、Schema 字段或依赖。
- 未进入 Step 6.3.5。

完成后停止，等待 Stage 3.1 架构评审。
