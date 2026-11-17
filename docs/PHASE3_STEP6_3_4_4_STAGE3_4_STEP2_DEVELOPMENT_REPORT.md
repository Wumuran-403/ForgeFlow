# Phase 3 Step 6.3.4.4 Stage 3.4 Step 2 Development Report

> 状态：State Transition Metadata Extension 完成，等待 Step 2 架构评审
>
> 范围：内部 `RecoveryEvidenceStateTransitionUnitOfWork` 的 Interrupted
> Lineage metadata 持久化
>
> 边界：未实施 Recovery UoW、Fencing Takeover、Preflight Capability、
> Resume Continuation 或任何公开恢复入口。

## 1. 实际修改文件

生产代码：

- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-recovery-lineage.ts`

测试与 fixture：

- `tests/storage/recovery-evidence-state-transition-lineage.test.ts`
- `tests/storage/recovery-evidence-recovery-lineage.test.ts`
- `tests/storage/recovery-evidence-uow-fixture.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/recovery-evidence-dispatch-uow.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP2_DEVELOPMENT_REPORT.md`

未修改 `src/storage/index.ts`，未新增依赖，未修改 Migration v4–v9。

## 2. State Transition UoW 接口变化

`TransitionOwnedRecoveryEvidenceReadAttemptInput` 新增：

```text
recoveryLineage?: RecoveryEvidenceInterruptLineageV1
```

规则：

- `status=interrupted` 时必须提供 `recoveryLineage`。
- 其他 target 不允许提供 `recoveryLineage`。
- `reasonCode` 必须等于 `recoveryLineage.reasonCode`。
- Lineage 先由 Stage 3.4 Step 1 Strict Schema 解析。
- 普通对象不能绕过 Schema；额外字段会被拒绝。

本次为 Stage 3.2 Event 兼容性补充：

```text
Interrupted Payload.attemptNumber
```

并强制：

```text
attemptNumber = priorAttemptNumber
```

Migration v8 Trigger 和 Stage 3.2 都依赖该字段。

## 3. Interrupted Event 持久化结构

当 `status=interrupted` 且 lineage 合法时，Event payload 直接使用 Step 1
Lineage，不再追加旧 generic fields。

实际包含：

```text
lineageSchemaVersion
recoveryOperationId
recoveryPhase=interrupt
taskId
readbackRequestId
readToolRunId
readAttemptId
attemptNumber
priorAttemptId
priorAttemptNumber
attemptStatus=interrupted
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
controlIntentKind（适用时）
controlIntentEventId（适用时）
pauseRequestEventId（Pause 时）
```

Schema 与 Migration v8 Trigger 要求：

```text
payload.readAttemptId = Attempt.id
payload.attemptNumber = Attempt.attemptNumber
payload.attemptStatus = interrupted
```

均保持一致。

## 4. 事务顺序与 StorageWritePermit

转换必须在外层 immediate transaction 中执行：

```text
outer runInTransaction(..., "immediate")
  -> createStorageWritePermit() once
  -> State Transition UoW
  -> no nested transaction
```

新写入顺序：

1. Lease / Fencing / ExecutionAuthority。
2. Task / Request / Attempt stable identity。
3. Exact Replay lookup。
4. Task version CAS。
5. Dispatch / Lease Claim / Control Intent binding。
6. State Matrix validation。
7. append Interrupted Attempt Event。
8. Attempt `last_event_id = Event.id`。
9. ToolRun / PlanStep / ExecutionPlan transitions。
10. Tool Event。
11. Checkpoint。

Event 或 Checkpoint 任一失败，全部 SQLite 写入回滚。

## 5. Lineage 数据库绑定

UoW 在 transaction 内验证：

- Lineage taskId = Task.id。
- Lineage readbackRequestId = Request.id。
- Lineage readToolRunId = Request.readToolRunId。
- Lineage prior/read Attempt ID = current Attempt.id。
- priorAttemptNumber = current Attempt.attemptNumber。
- Attempt status = interrupted。
- Tool name / version / schema hash 与 Request / ToolRun 一致。
- Retry Safety / Consistency / Allowlist / Expected 字段与 Request 一致。
- Lineage fencingToken = 当前 ownership fencingToken。
- Dispatch Event ID / entity / status / fencing 完整匹配。
- Lease Claim Event 属于当前 Task，fencing 匹配。
- Lease Claim sequence > Dispatch sequence。
- Interrupted Event sequence > Lease Claim sequence。
- Cancel / Pause Intent Event 与当前 Task Intent 和 lineage 一致。
- Pause `controlIntentEventId` 必须等于 `pauseRequestEventId`。

无控制意图时，Task Cancel / Pause 字段必须为空。

## 6. Exact Replay

当前 Attempt 已是 interrupted 时：

1. Lease / Fencing / Authority 仍先校验。
2. 查询同 Attempt 的 Interrupted Event。
3. 使用 Step 1 Schema 解析 Event payload。
4. 使用 canonical Lineage 比较整个 payload。
5. 查询同一 recoveryOperationId 的其他 Interrupted Event。
6. 如果 operation ID 已绑定不同 lineage，返回
   `RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT`。
7. 完全一致时验证：
   - current Attempt = interrupted。
   - current `last_event_id = Event.id`。
   - ToolRun / PlanStep = interrupted。
   - ExecutionPlan = active。
8. 返回持久化 Attempt。

Exact Replay 不写 Event / Checkpoint。

历史 Event 完整性在 Replay 分支独立验证：

- Lineage `dispatchEventId` 指向旧 Dispatch Event。
- 旧 Dispatch Event fencing = Lineage `dispatchFencingToken`。
- Lease Claim Event 存在且 type = `lease.claimed`。
- Claim Event fencing = 历史 Lineage `fencingToken`。
- Dispatch sequence < Claim sequence < Interrupted Event sequence。

Replay 不要求历史 Lineage fencing 等于当前 Owner B fencing。当前 Owner
B 的 lease/fencing/authority 先独立验证；历史 Event 只验证自身内部一致性。

### 6.1 Downstream State Evolution

审查确认旧实现错误要求 Replay 时下游始终为：

```text
ToolRun=interrupted
PlanStep=interrupted
Plan=active
```

这会拒绝后续合法状态演进。现已改为分类验证：

| 下游状态 | Replay 条件 |
|---|---|
| interrupted / interrupted / active | 初始 Interrupted 状态 |
| cancelled / cancelled / cancelled | 必须存在后续 Request Cancel Event |
| queued / running / active | 必须存在合法 prepared child Attempt + Prepare Lineage |
| running / running / active | 必须存在合法 dispatching child Attempt |
| 其他组合 | fail closed |

历史真实性验证与当前下游状态验证分离：

- Interrupted Event、Dispatch Event、Lease Claim Event、Lineage canonical
  identity 必须永远一致。
- 当前 Owner Lease / Fencing / Authority 独立验证。
- 下游状态只允许上述可解释演进。
- Replay 不执行新的状态转换。

## 7. 新增测试

新增 `recovery-evidence-state-transition-lineage.test.ts`，覆盖：

1. 合法 Interrupted Lineage 写入。
2. Event payload 通过 Step 1 Schema。
3. Attempt.last_event_id 与 Event 一致。
4. ToolRun / PlanStep interrupted、Plan active。
5. 缺 recoveryOperationId 拒绝。
6. 缺 leaseClaimEventId 拒绝。
7. Task / Request / Attempt identity mismatch 拒绝。
8. dispatchFencingToken >= fencingToken 拒绝。
9. retryAssessment / resumeEligible 非法组合拒绝。
10. Cancel / Pause Intent Event mismatch 拒绝。
11. Event append 失败整体 rollback。
12. Checkpoint append 失败整体 rollback。
13. Exact Replay 不重复写。
14. 旧 Owner Lease / Fencing / Authority 失效拒绝。
15. Owner A interrupted COMMIT 后，Owner B 使用更高 fencing 进行 Exact
    Replay。
16. Owner B Replay 保留 Owner A 历史 fencing / Lease Claim Event，不增加
    Event / Checkpoint。
17. Owner A 旧 Lease 在同一 Replay 场景下再次写入被拒绝。
18. Interrupted 后 Stage 3.3 Cancel convergence，再 Replay。
19. Full Recovery 预期 child prepared 状态，再 Replay。
20. Pause Clear + prepared child 状态，再 Replay。
21. 历史 lineage reference 被篡改时 Replay 拒绝。
22. 无法解释的下游状态组合 Replay 拒绝。

## 7.1 首次执行与 Replay 前置状态

首次执行：

- Attempt = dispatching。
- 当前 Owner Lineage fencing = 当前 ownership fencing。
- 执行完整状态转换。

Replay：

- Attempt = interrupted。
- Attempt.last_event_id = 原 Interrupted Event。
- 历史 Event / Dispatch / Claim / canonical Lineage 必须一致。
- 下游状态按 §6.1 分类允许初始中断、Cancel convergence 或合法 child
  Attempt 演进。
- 当前 Owner 的新 fencing 只用于 Authorization。
- 历史 Lineage fencing 保持 Owner A 原值。
- 不执行新的状态转换或 Checkpoint。

Stage 3.4 Step 1 测试同步增加 Interrupted `attemptNumber` 字段。

Full Recovery / Pause Continuation 的 child prepared 状态只通过内部测试
fixture 验证 Replay Policy；没有实现对应生产入口。

## 8. 实际执行结果

Step 2 专项与直接回归：

```text
pnpm vitest run tests/storage/recovery-evidence-state-transition-lineage.test.ts tests/storage/recovery-evidence-uow.test.ts tests/storage/recovery-evidence-dispatch-uow.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       100 passed (100)
```

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  54 passed (54)
Tests       577 passed (577)
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

## 9. Stage 3.1–3.3 回归

Stage 3.1–3.3 已封存测试全部通过：

- Dispatch / Failure / Timeout / Cancel / Pause / Resume 状态矩阵。
- Exact Replay。
- Task-wide Intent。
- Pause generation。
- Multi-request Cancel。
- Original Agent Plan / Unknown Write 不变。
- Event / Checkpoint rollback。

测试 fixture 使用真实 `TaskLeaseManager.release/claim` 建立新 Owner，
没有伪造 Takeover 或外部 Read 结果。

## 10. Migration / Schema 需求

本 Step 不需要 Migration 或 Schema 变更：

- Lineage 存入现有 Event payload。
- Attempt / ToolRun / PlanStep / Plan 现有状态足够。
- 复用 Migration v8 Trigger。

未修改 Migration v4–v9，未创建 Migration v10。

## 11. 尚未解决的限制

- 仍没有公开 Recovery UoW；本 Step 只扩展内部执行器。
- 仍没有 Recovery Preflight Capability。
- 仍没有 Fencing Takeover UoW。
- 仍没有 Interrupt-only / Full Recovery / Resume Continuation 业务入口。
- `requestIntentDigest` 当前只验证格式和 Lineage 字段一致性；没有在 State
  Transition UoW 内重新计算完整 Request Intent。
- Durable recoveryOperationId Command / Job 仍缺失。
- 不执行 External Read、ToolRegistry validation、Transaction B 或 Verifier。
- Cross-owner Replay 仍需上层使用同一个 recoveryOperationId；当前 Step 2
  不提供 durable Recovery Command/Job。

## 12. Step 2 封存结论

本轮确认并修复了 Interrupted Exact Replay 对下游状态的过度约束。

当前 Replay 可以只读处理：

- 初始 interrupted 状态。
- Stage 3.3 Cancel convergence。
- 未来 Full Recovery 的 queued / running / active + prepared child 状态。
- 未来 Pause Resume Continuation 的同类状态。
- Owner A interrupted 后由 Owner B 使用更高 fencing 重放。

无法解释的下游状态、被篡改的 Lineage 引用和非法 Event 关系继续 fail
closed。

若架构评审接受上述 Replay Policy 分类，建议将 Stage 3.4 Step 2 正式封存。
Full Recovery / Pause Continuation 的 child 状态测试仅验证 Replay Policy，
不代表对应生产入口已实现。

## 13. 边界声明

本轮未实施：

- Stage 3.4 Step 3。
- Recovery Preflight Capability。
- Fencing Takeover。
- Recovery Lineage Repository。
- new Attempt 创建。
- Pause Clear Resume Continuation。
- Durable Recovery Job / Command Store。
- Stage 3.2 Dispatch Gate 修改。
- Migration v10 或依赖变更。
- External Read / Transaction B / Recovery Manager / Step 6.3.5。

完成后停止，等待 Stage 3.4 Step 2 架构评审。
