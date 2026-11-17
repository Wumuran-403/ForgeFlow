# Phase 3 Step 6.3.4.4 Stage 3.2 Development Report

> 状态：Dispatch UoW 完成，等待 Stage 3.2 架构评审
>
> 范围：`beginOwnedRecoveryEvidenceRead()`、Dispatch Gate、Exact Replay、
> current-transaction 状态矩阵执行
>
> 边界：未实现 Stage 3.3 Failure/Cancel/Pause/Resume UoW、Stage 3.4
> Recovery UoW 或 Stage 4 External Read。

## 1. 实际修改文件

生产代码：

- `src/recovery/recovery-evidence-dispatch-preflight.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-readback-reservation-repository.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/index.ts`

测试：

- `tests/recovery/recovery-readback-tool-registry.test.ts`
- `tests/storage/recovery-evidence-uow-fixture.ts`
- `tests/storage/recovery-evidence-dispatch-uow.test.ts`
- `tests/storage/recovery-evidence-dispatch-worker.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_2_DEVELOPMENT_REPORT.md`

没有新增依赖，没有修改 Migration v9、Schema 或 Digest Protocol。

## 2. Dispatch 业务入口

新增：

```text
RecoveryEvidenceUnitOfWork.beginOwnedRecoveryEvidenceRead()
```

返回严格区分：

```text
created
replayed-existing-dispatching
cancel_required
pause_blocked
```

只有 `created` 表示本次调用刚刚提交新的 Dispatch 授权。

## 3. 完整调用链

### 3.1 Transaction 外 Host Preflight

新增：

```text
prepareRecoveryEvidenceDispatchPreflight()
```

调用链：

```text
RecoveryReadbackToolRegistry.getExact(
  allowlistId,
  expectedAllowlistContractDigest
)
  -> rebuild immutable contract metadata
  -> recompute allowlist contract digest
  -> compare with expected digest
  -> verify definition.allowlistVersion
  -> return frozen Dispatch preflight binding
```

该操作不访问数据库事务，不调用 Tool，不执行 External Read。

### 3.2 Dispatch UoW

```text
RecoveryEvidenceUnitOfWork.beginOwnedRecoveryEvidenceRead(input)
  -> BEGIN IMMEDIATE
  -> Task lease / fencing
  -> local ExecutionAuthority
  -> Task = waiting_review
  -> Request / Attempt identity
  -> Reservation by request_id
  -> Reservation status = completed
  -> Reservation identity invariant
  -> RecoveryReviewOperation = accepted request_readback
  -> Review = pending / unresolved
  -> Review decisionVersion = Operation resultingDecisionVersion
  -> Recovery Plan = recovery_evidence
  -> PlanStep = read_batch
  -> ToolRun = read
  -> Request.allowlist_id / allowlist_version
  -> Tool metadata / Input Schema Hash
  -> canonicalInputHash
  -> Attempt / ToolRun / PlanStep / Plan version bindings

  -> Exact Dispatch Replay
       existing dispatching:
         validate Event + running ToolRun + running PlanStep + active Plan
         return replayed-existing-dispatching
         no writes

  -> latest Cancel Intent
       return cancel_required, no writes

  -> latest Pause Intent
       return pause_blocked, no writes

  -> expected Task / Attempt / ToolRun / PlanStep / Plan versions
  -> Task version CAS
  -> Stage 3.1 State Transition UoW
       current transaction permit
       no nested transaction
       Attempt -> dispatching
       ToolRun -> running
       PlanStep queued -> running or running stays running
       Attempt Event
       tool.started Event
       Checkpoint
  -> return created
```

## 4. Allowlist Contract Digest Gate

持久化字段：

```text
RecoveryEvidenceReadbackRequest.allowlist_version
```

该字段承载 64 lowercase hex Allowlist Contract Digest。

Dispatch UoW 在 transaction 内重新读取并比较：

```text
request.allowlist_id
request.allowlist_version
request.read_tool_name / version / schema_hash
request.retry_safety / consistency_mode
readRun.toolName / version / inputSchemaHash
readRun.canonicalInputHash
```

Registry exact lookup 和 Digest 重算保持在 transaction 外。

## 5. State Transition UoW 复用

Stage 3.1 内部执行器：

```text
RecoveryEvidenceStateTransitionUnitOfWork
```

新增 current-transaction 模式：

```text
transitionOwnedRecoveryEvidenceReadAttempt(input, permit)
```

- Stage 3.2 在 outer immediate transaction 内传入该 permit。
- 状态矩阵执行器不再打开嵌套 transaction。
- Stage 3.2 不重复实现 Attempt / ToolRun / PlanStep / Plan 状态规则。
- 内部执行器继续使用 ExecutionStateMachine transition validators。

## 6. Exact Replay

Dispatch Replay 在 Task version CAS 前执行。

验证：

- Request / Attempt / Reservation / Plan / PlanStep / ToolRun binding。
- `read_attempt_dispatching` Event。
- Attempt dispatching。
- ToolRun running。
- PlanStep running。
- Plan active。

Task Event 分配会递增 Task.version：

```text
Dispatch = Attempt Event + Tool Event
Task.version: V -> V+2
```

响应丢失后使用原始 `expectedTaskVersion = V` 再次调用，因为 Replay
在 CAS 前执行，返回 `replayed-existing-dispatching`。

Replay 验证：

- 不新增 Event。
- 不新增 Checkpoint。
- 不重复状态转换。
- 仍需当前 Lease / Fencing / ExecutionAuthority。

## 7. Cancel / Pause

Stage 3.2 只检查最新 Task-wide Intent：

```text
Cancel -> cancel_required
else Pause -> pause_blocked
else Dispatch
```

不执行：

- Stage 3.3 Cancel 收敛。
- `prepared -> blocked_by_intent`。
- Pause clear。
- 新 Attempt。
- Recovery。

Intent 在 Dispatch immediate transaction 内重新读取。

## 8. 并发与回滚

双进程并发测试：

- 两个 Worker 使用同一 Attempt 抢占 Dispatch。
- 一个返回 `created`。
- 另一个返回 `replayed-existing-dispatching`。
- 数据库中只有一个 `read_attempt_dispatching` Event。

Fault injection：

- Event append 失败整体 rollback。
- Checkpoint append 失败整体 rollback。
- Attempt / ToolRun / PlanStep / Plan 状态全部回滚。

## 9. 测试覆盖

Stage 3.2 专项覆盖：

1. created Dispatch。
2. 原始 Task version Exact Replay。
3. Cancel Intent 不写状态。
4. Pause Intent 不写状态。
5. concurrent Workers 只有一个 created。
6. Retry Dispatch 时 PlanStep 保持 running。
7. Attempt / Request binding mismatch。
8. Allowlist digest mismatch。
9. Tool Schema Hash mismatch。
10. canonicalInputHash mismatch。
11. historical Request without Reservation。
12. incomplete Reservation invariant。
13. Fencing mismatch。
14. Lease released。
15. ExecutionAuthority revoked。
16. Task not waiting_review。
17. Review decision mismatch。
18. Event failure rollback。
19. Checkpoint failure rollback。
20. Original Agent Plan / Unknown Write unchanged。
21. ToolRegistry.executeValidated() 未调用。
22. preflight helper exact contract recovery。

## 10. 实际执行结果

专项与直接回归：

```text
pnpm vitest run tests/recovery/recovery-readback-tool-registry.test.ts tests/storage/recovery-evidence-dispatch-uow.test.ts tests/storage/recovery-evidence-state-matrix.test.ts tests/storage/recovery-evidence-uow.test.ts
```

结果：

```text
Test Files  4 passed (4)
Tests       107 passed (107)
```

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  52 passed (52)
Tests       515 passed (515)
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

## 11. 已知限制与遗留问题

- Stage 3.2 只持久化 Dispatch 授权，不代表 External Read 已发生或成功。
- Cancel / Pause 仅返回业务结果，不执行 Stage 3.3 状态收敛。
- Retry Dispatch 依赖上层已完成合法 Recovery 并准备新的 Attempt。
- Preflight binding 是普通输入对象；生产调用方必须使用 Host-owned
  Registry preflight helper，不能由模型或普通请求构造。
- Reservation initial Completion Invariant 只适用于第一个 Attempt；
  retry 使用持久化 Reservation identity invariant。

## 12. 边界声明

本轮：

- 未实施 Stage 3.3。
- 未实施 Stage 3.4。
- 未实施 External Read、ToolRegistry.executeValidated()、Payload Store。
- 未实施 Transaction B、Controlled Provenance、Verifier 或 Recovery
  Manager。
- 未修改 Task.status、Original Unknown Write 或 Final Review Decision。
- 未新增 Migration v10、Schema 字段或依赖。
- 未进入 Step 6.3.5。

完成后停止，等待 Stage 3.2 架构评审。
