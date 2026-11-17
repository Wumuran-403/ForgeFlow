# Phase 3 Step 6.3.4.4 Stage 3.1 Supplementary Review

> 状态：Supplementary Architecture Audit 完成，等待架构评审
>
> 范围：状态矩阵执行器可见性、生产调用链、Task version CAS 与
> 响应丢失 Exact Replay
>
> 边界：未实施 Stage 3.2–3.4，未修改 Migration/Schema/Digest Protocol。

## 1. 方法可见性与实际调用链

### 1.1 修复前问题

State matrix transition 方法原先定义在：

```text
RecoveryEvidenceUnitOfWork.transitionOwnedRecoveryEvidenceReadAttempt()
```

该方法是公开实例方法，而
`RecoveryEvidenceReadbackService` 与
`RecoveryEvidenceVerificationService` 都持有同一个
`RecoveryEvidenceUnitOfWork` 实例。因此业务 Service 能直接调用它，存在
绕过 Stage 3.2 Reservation / Allowlist / Task / Review / Retry / Intent
Gate，以及 Stage 3.3/3.4 业务 Gate 的风险。

### 1.2 边界收紧

状态转换执行器已移动到内部类：

```text
src/storage/recovery-evidence-state-transition-unit-of-work.ts
RecoveryEvidenceStateTransitionUnitOfWork
```

边界：

- `RecoveryEvidenceUnitOfWork` 不再公开该 transition 方法。
- 该内部类没有从 `src/storage/index.ts` 导出。
- `RecoveryEvidenceReadbackService` 和 Verification Service 均无法通过
  `RecoveryEvidenceUnitOfWork` 调用矩阵执行器。
- 当前生产代码调用点：0。
- 当前调用点仅为 Stage 3.1 测试 fixture 与测试文件直接导入。

该文件标注为 internal mechanical executor。Stage 3.2–3.4 后续业务 UoW
必须在完成各自 Gate 后，才可实例化并调用它。

### 1.3 A / B 分类

当前实现属于：

```text
A. 底层状态矩阵执行器
```

不是：

```text
B. 对外业务 UoW
```

它不负责：

- Reservation Completion Invariant。
- Allowlist / Tool / Input preflight。
- Review decisionVersion。
- Retry Safety / Consistency。
- Cancel / Pause Intent 业务判断。
- Recovery Operation Lineage。

Stage 3.2–3.4 必须分别提供自己的业务入口和完整校验。

## 2. Task version CAS 行为

### 2.1 Task version 实际更新来源

`SequenceAllocator.nextEventSequence()` 在每次分配 Event sequence 时执行：

```sql
UPDATE tasks
SET last_event_sequence = last_event_sequence + 1,
    version = version + 1,
    updated_at = ?
WHERE id = ?
```

因此：

- 每个 Event 写操作都会递增 Task.version。
- Dispatch 写 Attempt Event + Tool Event，Task.version 从 V 增至 V+2。
- Checkpoint 写入不是 Task version 的递增来源。

源码位置：

- `src/storage/sequences.ts`
- `src/storage/event-repository.ts`

### 2.2 执行顺序

内部 State Transition UoW 的实际顺序：

```text
BEGIN IMMEDIATE
  -> Lease / Fencing
  -> Local ExecutionAuthority
  -> Attempt / Request stable identity lookup
  -> request-level Cancel exact replay lookup
  -> attempt transition exact replay lookup
  -> Transaction B completed exact replay lookup
  -> Task version CAS
  -> state matrix validation
  -> state writes
  -> Events
  -> Checkpoint
COMMIT
```

关键点：

- Exact Replay lookup 位于 Task version CAS 之前。
- Lease / Fencing / Authority 仍位于 exact replay 之前。
- 旧 Owner 不能通过 Replay 恢复写权限。
- 未命中 Replay 时才校验原始 `expectedTaskVersion`。

## 3. 响应丢失 Exact Replay 测试

测试：

```text
exact-replays after a lost response using the original Task version
```

步骤与结果：

1. 初始 Task version = V。
2. 首次 dispatch 使用 `expectedTaskVersion = V`。
3. 成功提交后验证 Task version = V+2。
4. 模拟响应丢失，使用同一 Attempt、同一 target、同一 reason 和原始
   `expectedTaskVersion = V` 再次调用。
5. Exact Replay 返回原持久化 Attempt，不执行 Task version CAS。

验证结果：

- Attempt 状态不再次转换。
- Attempt Event 不重复。
- Tool Event 不重复。
- Checkpoint 不重复。
- 原始 Task version V 不阻止 Replay。

Authority 回归：

- 已有测试 `cannot use replay or new writes after local authority is revoked`
  继续通过。
- 撤销 Authority 后，即使持久状态匹配，也不能通过 Replay 写回。

## 4. 测试与检查结果

专项测试：

```text
pnpm vitest run tests/storage/recovery-evidence-state-matrix.test.ts tests/storage/recovery-evidence-uow.test.ts
```

结果：

```text
Test Files  2 passed (2)
Tests       78 passed (78)
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

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  51 passed (51)
Tests       498 passed (498)
```

## 5. 实际修改文件

- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-state-matrix.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/index.ts`
- `tests/storage/recovery-evidence-uow-fixture.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/recovery-evidence-state-matrix.test.ts`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_1_DEVELOPMENT_REPORT.md`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_1_SUPPLEMENTARY_REVIEW.md`

## 6. 遗留问题

- State Transition UoW 仍是 TypeScript export，供同层业务 UoW 复用；
  未从 storage public index 导出，但模块级 deep import 仍可能需要 code
  review 约束。
- Stage 3.2–3.4 尚未实现，因此完整业务 Gate 尚无法接入。
- Transaction B completed 的 `dispatching -> completed` 仍由既有
  `completeOwnedRecoveryEvidenceRead()` 负责，不由 Stage 3.1 target 枚举
  提交。

## 7. 边界声明

本轮：

- 未实施 Stage 3.2 Dispatch UoW。
- 未实施 Stage 3.3 Failure / Cancel / Pause / Resume UoW。
- 未实施 Stage 3.4 Interrupted Recovery UoW。
- 未修改 Migration v9、Schema、Digest Protocol 或依赖。
- 未执行 External Read、Transaction B、Verifier 或 Recovery Manager。
- 未进入 Step 6.3.5。

完成后停止，等待 Stage 3.1 Supplementary Architecture Audit 评审。
