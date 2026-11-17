# Phase 3 Step 6.3.4.4 Stage 3.2 Supplementary Architecture Review

> 状态：Stage 3.2 定向加固完成，等待架构评审
>
> 范围：Dispatch Preflight capability、Retry Attempt 来源验证、
> single-active-Attempt 事务检查、current-transaction Permit、Replay 授权隔离
>
> 边界：未实施 Stage 3.3、Stage 3.4、External Read、Transaction B 或
> Step 6.3.5。

## 1. 审计结论

本轮核查确认并修复了三个实际边界缺口：

1. 原 Dispatch Preflight binding 是普通对象，调用方可以通过 spread clone
   或 TypeScript cast 构造同形对象。
2. Retry Attempt 只凭 `attemptNumber > 1` 和普通 Request / ToolRun / Plan
   binding 就能进入 Dispatch，缺少持久化 Recovery lineage 验证。
3. 内部状态矩阵执行器在未传 Permit 时会自行打开 transaction，不满足
   Stage 3.2 必须复用外层 immediate transaction 的要求。

同时将 Task-wide Cancel / Pause 检查前移到 Exact Replay 之前，避免把
`replayed-existing-dispatching` 误用为新的外部执行授权。

## 2. Dispatch Preflight Capability

### 2.1 签发

`prepareRecoveryEvidenceDispatchPreflight()` 仍执行：

```text
RecoveryReadbackToolRegistry instance check
  -> exact getExact(allowlistId, expectedContractDigest)
  -> rebuild immutable allowlist contract metadata
  -> recompute JCS allowlist contract digest
  -> verify definition.allowlistVersion
  -> mint process-local capability
```

Registry exact lookup 和 Contract Digest 重算仍在 SQLite transaction 外完成。

### 2.2 Capability

Preflight 返回值现在是 opaque
`RecoveryEvidenceDispatchPreflightCapability`：

- 运行时对象为 frozen empty object。
- 可信 metadata 保存在模块私有 `WeakMap` 中。
- WeakMap 只接受由该模块实际签发的对象作为 key。
- Capability 不持久化，不进入 Migration、Event 或 Database。

以下对象均无法通过：

- `{}` 或手工构造的同形对象。
- `{ ...capability }` spread clone。
- `JSON.parse(JSON.stringify(capability))` JSON clone。
- TypeScript `as` cast。
- 伪造的 Registry-like `{ getExact() }` 对象。

### 2.3 Dispatch 验证

`beginOwnedRecoveryEvidenceRead()` 在 transaction 外验证 capability，
取得只读 trusted binding；transaction 内继续比较：

- persisted Request allowlist identity / version / digest。
- Tool name / version / input schema hash。
- Retry Safety / Consistency Mode。
- Read ToolRun tool metadata 与 canonical input hash。
- Attempt retry / consistency binding。

调用方不再能够直接传入 allowlist 或 tool contract 字段。

## 3. First Attempt 与 Retry Attempt 来源

### 3.1 First Attempt

`attemptNumber === 1` 时：

- Attempt ID 必须等于 Reservation 的 `read_attempt_id`。
- durable `read_attempt_prepared` Event 必须存在且绑定该 Attempt。
- Attempt ID、attempt number、prepared status 必须一致。
- 提交前继续执行 Initial Reservation Completion Invariant。

### 3.2 Retry / Resume Attempt

`attemptNumber > 1` 时必须验证：

- prepared Event 中唯一的 `recoveryOperationId`。
- `priorAttemptId`。
- `interruptionEventId`。
- `newAttemptId`。
- prepared Event ID 由 Attempt 的 `last_event_id` 绑定。
- 当前 Attempt 的 `attemptNumber = priorAttempt.attemptNumber + 1`。
- prior Attempt 属于同一 Request / ToolRun。
- prior Attempt 状态为 `interrupted`。
- interruption Event 的 `resumeEligible === true`。
- interruption Event 与 prepared Event 的 operation identity 一致。
- prior Dispatch Event 存在，当前 fencing 严格大于 prior Dispatch fencing。
- Pause 来源必须绑定对应 `pauseClearEventId`。

当前 Stage 3.4 尚未提供生产 Retry Lineage writer，因此生产 Retry Dispatch
暂时统一返回：

```text
state: state_inconsistent
reason: retry_lineage_invalid
```

没有使用测试 fixture 伪造 Retry 正向授权。

## 4. Single Active Attempt

Dispatch 在同一个 SQLite immediate transaction 内重新读取 Attempt 集合，
按 `readbackRequestId + readToolRunId` 过滤 `prepared | dispatching`：

- Candidate Attempt 自身是唯一 active Attempt：允许继续。
- 存在其他 active Attempt：不执行状态转换，返回
  `state_inconsistent / multiple_active_attempts`。

该判断不依赖 transaction 外 Snapshot。

## 5. Current-Transaction Permit

`RecoveryEvidenceStateTransitionUnitOfWork` 所有转换现在显式要求
`StorageWritePermit`：

- 不再缺省自行打开 transaction。
- 不创建 nested transaction。
- 入口首先执行 `assertStorageWritePermit(database, permit)`。
- Permit 必须由当前数据库的 outer immediate transaction 创建。
- `exclusive` transaction 不再被视为可签发 Permit 的写事务。
- 普通对象、过期 Permit、跨 transaction Permit 均被拒绝。

Stage 3.2 Dispatch 通过
`transitionOwnedRecoveryEvidenceReadAttemptInCurrentTransaction()` 复用外层
transaction permit。

## 6. Replay 与 External Read 授权隔离

保留：

- Lease / Fencing / ExecutionAuthority 检查先于 Exact Replay。
- Exact Replay 先于 Task version CAS。
- Exact Replay 不重复 Attempt Event、Tool Event 或 Checkpoint。

补充：

- Task-wide Cancel 在 Exact Replay 前返回 `cancel_required`。
- Task-wide Pause 在 Exact Replay 前返回 `pause_blocked`。
- 只有 `created` 表示本次调用新提交了 Dispatch 授权。
- `replayed-existing-dispatching` 不是 External Read 调用授权。
- Replay 不恢复旧 Owner 的写权限。
- 测试确认无论 created 还是 replay 路径都未调用
  `ToolRegistry.executeValidated()`。

## 7. 实际修改文件

生产代码：

- `src/recovery/recovery-evidence-dispatch-preflight.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/transaction.ts`

测试：

- `tests/recovery/recovery-readback-tool-registry.test.ts`
- `tests/storage/recovery-evidence-dispatch-contract.ts`
- `tests/storage/recovery-evidence-dispatch-worker.ts`
- `tests/storage/recovery-evidence-dispatch-uow.test.ts`
- `tests/storage/recovery-evidence-uow-fixture.ts`
- `tests/storage/recovery-evidence-uow.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_2_SUPPLEMENTARY_REVIEW.md`

没有新增依赖，没有修改 Migration v9、Schema 或 Digest Protocol。

## 8. 实际执行结果

Stage 3.2 专项与直接回归：

```text
pnpm vitest run tests/recovery/recovery-readback-tool-registry.test.ts tests/storage/recovery-evidence-dispatch-uow.test.ts tests/storage/recovery-evidence-state-matrix.test.ts tests/storage/recovery-evidence-uow.test.ts
```

结果：

```text
Test Files  4 passed (4)
Tests       111 passed (111)
```

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  52 passed (52)
Tests       519 passed (519)
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

## 9. 剩余限制

- Retry Dispatch 的正向路径必须等待 Stage 3.4 实现合法 Recovery lineage
  writer；当前生产路径保持 fail-closed。
- Capability 是进程内对象，跨进程 Worker 必须各自通过 Host Registry
  exact preflight 重新签发，不能序列化或复用其他进程的 capability。
- Stage 3.2 只形成 Dispatch 授权；`dispatching` 不证明 External Read
  已发生或成功。
- Cancel / Pause 在本轮仍只返回业务阻断结果，实际收敛属于 Stage 3.3。
- 未实施 External Read、Payload Store、Transaction B、Controlled
  Provenance、Verifier、Recovery Manager 或 Step 6.3.5。

完成后停止，等待 Stage 3.2 supplementary architecture review。
