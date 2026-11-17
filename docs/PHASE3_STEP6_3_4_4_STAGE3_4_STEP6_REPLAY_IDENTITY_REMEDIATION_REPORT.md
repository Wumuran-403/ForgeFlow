# ForgeFlow Phase 3 Stage 3.4 Step 6 Replay Identity Remediation Report

> 状态：Exact Replay Request Identity Classification 修复完成。
>
> 范围：Step 6 最小生产代码修复。
>
> 数据库基线：Migration v9。
>
> 未开始 Step 7 / Step 8。

## 1. 实际检查和修改文件

生产代码：

- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
  - 调整 Owner 授权、Prepared Event 查询和首次 Prepare binding validation
    的顺序。
  - 增加 Prepared Lineage 早期 identity conflict 分类。

测试：

- `tests/storage/recovery-evidence-interruption.test.ts`
  - 保留真实 Request RB Identity Conflict 测试。
  - A1/A2 `newAttemptId` 冲突保持独立测试。
  - 新增 Owner Authorization 优先于 Replay 结果读取的测试。

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP6_REPLAY_IDENTITY_REMEDIATION_REPORT.md`
  - 本报告。

未修改：

- `RecoveryEvidenceStateTransitionUnitOfWork` Prepare Recovery 规则。
- Step 1 Lineage Schema。
- Stage 3.2 Dispatch Gate。
- Stage 3.3 已封存 UoW。
- Migration / SQLite Schema。
- 依赖。

## 2. 修复前后检查顺序

### 修复前

```text
Lease / Authority / Task status
  -> Load current Request RB
  -> Load current prior Attempt RA
  -> assertPersistedBindings(RA, RB)
       -> FULL_RECOVERY_BINDING_INVALID
  -> findPreparedReplay()
```

因此 Request 身份不一致在历史 Prepared Event 查询前被 generic binding
validation 拦截。

### 修复后

```text
Lease / Ownership / Fencing / Authority / Task status
  -> Validate current Claim Event
  -> Load task events
  -> Find historical Prepared Event

     Found:
       -> Strict Parse Prepared Lineage
       -> Compare historical Task / Request / priorAttempt / newAttemptId
       -> Mismatch:
            RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT
       -> Match:
            -> Load Request / Reservation / Attempt / ToolRun / PlanStep / Plan
            -> Existing Exact Replay validation

     Not Found:
       -> Load current Request / Attempt / ToolRun / PlanStep / Plan
       -> assertPersistedBindings()
       -> full first-Prepare validation
```

当前 Owner Authorization 仍然先于历史 Replay 查询。

## 3. Replay Key 查询条件

历史 Prepared Event 查询：

```text
taskId
+ recoveryOperationId
+ recoveryPhase = prepare
```

查询同时要求：

```text
event.type = recovery.evidence.read_attempt_prepared
event.entityType = recovery_evidence_read_attempt
payload.readAttemptId = entityId
payload.newAttemptId = entityId
payload.attemptStatus = prepared
```

多条匹配继续返回：

```text
RECOVERY_EVIDENCE_RECOVERY_LINEAGE_CONFLICT
```

## 4. Request Identity Conflict 分类

Prepared Lineage 早期比较：

```text
historical taskId          == current taskId
historical requestId       == current requestId
historical priorAttemptId  == current priorAttemptId
historical newAttemptId     == optional current newAttemptId
```

任一不一致：

```text
RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT
```

该检查发生在：

- 当前 Request Repository 绑定校验之前。
- 当前 prior Attempt generic binding 校验之前。
- Exact Replay 下游状态验证之前。

但仍然发生在：

- Lease / Ownership / Fencing 验证之后。
- ExecutionAuthority 验证之后。
- 当前 Claim Event 验证之后。

## 5. 真实 Request Identity Conflict 测试

测试：

```text
classifies a real different Request as an Exact Replay identity conflict
```

构造：

1. 使用同一个 SQLite database。
2. 通过真实 Fixture / Reservation / Request UoW 创建第二个真实 Task Request
   RB。
3. RB 的 Task / Review / Operation / Reservation / Plan / PlanStep /
   ToolRun 均可读取，不是不存在的 ID。
4. 使用历史 Task T1、operation R1 和 Request RB 发起 Replay。

实际结果：

```text
RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT
```

测试同时断言：

- Event 数量不变。
- Checkpoint 数量不变。
- Attempt 列表不变。
- 原 Prepared Event payload 不变。
- Tool Event 属于 Event 集合，因此数量不变。

## 6. A1/A2 冲突测试

独立测试：

```text
rejects a different newAttemptId without writes
```

场景：

```text
First:  R1 + A1
Replay: R1 + A2
```

实际错误：

```text
RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT
```

拒绝原因来自 Prepared Lineage 的 `newAttemptId=A1` 与当前 A2 不一致。
不依赖错误 Request、缺失 Claim 或其他前置校验。

## 7. 正常 Exact Replay

现有测试继续通过：

- 同一 Request。
- 同一 prior Attempt。
- 同一 recoveryOperationId。
- 同一或省略 newAttemptId。

实际行为：

- 返回历史 New Attempt A1。
- 不新增 Attempt。
- 不新增 Prepared Event。
- 不新增 Checkpoint。
- 新 Owner 可 Replay 历史结果。
- 历史 Claim / fencing 不被覆盖。

## 8. 首次 Prepare Binding Validation 未削弱

只有 Prepared Event 不存在时才加载当前 Request 并执行：

```text
assertPersistedBindings()
  -> Request / Task
  -> Request / prior Attempt
  -> Request / ToolRun
  -> ToolRun / PlanStep / Plan
  -> Reservation
  -> Retry Safety / Consistency
```

原有首次 Prepare 负向测试继续通过：

- Request 不存在。
- Request 与 Task 不匹配。
- ToolRun 不匹配。
- Prior Attempt 不匹配。
- Preflight failed / not_evaluated。
- Version mismatch。
- Active Attempt conflict。

未删除 `assertPersistedBindings()`，未跳过 Request Repository。

## 9. Owner Authorization 优先级

新增测试：

```text
validates current Owner authorization before replay result lookup
```

场景：

- 已有历史 Prepared Event。
- 当前 ExecutionAuthority invalid。
- 当前 Claim Event invalid。
- 旧 Owner ownership / stale fencing。

实际结果：

- Authority invalid 先拒绝。
- Claim Event invalid 先拒绝。
- stale ownership 先拒绝。
- 不读取/返回 Replay 结果。
- Event / Attempt / Checkpoint 不变。

## 10. Event / Attempt / Tool Event / Checkpoint

身份冲突 Replay 是只读 fail closed：

- Attempt 数量不变。
- Event 数量不变（包含 Prepared Event 和 Tool Event）。
- Checkpoint 数量不变。
- 历史 A1 不变。
- 历史 Prepared Event payload 不变。

本次修复没有新增写入路径。

## 11. 实际验证结果

专项测试：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts

Test Files  1 passed (1)
Tests       29 passed (29)
```

全量测试：

```text
pnpm test

Test Files  57 passed (57)
Tests       627 passed (627)
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

仅有工作树现有 LF/CRLF normalization warning，没有 whitespace error。

## 14. 剩余限制

1. 真实 Request RB 使用同一数据库中的第二个真实 Task Request。当前 Schema
   对同 Task 第二 Request 要求完整第二套 write/review/submission/read 链，
   本次按授权 fallback 使用另一个真实合法 Request。
2. Step 6 Prepared Attempt 进入 Stage 3.2
   `beginOwnedRecoveryEvidenceRead()` 的端到端测试仍属于 Step 7，本次未执行。
3. Durable Recovery Job / Command Store 仍不存在；跨重启稳定
   `recoveryOperationId` 仍由 Host context 提供。
4. 未实现 External Read / Dispatch / Transaction B / Verifier。

## 15. 边界声明

本次仅完成 Exact Replay Identity Classification 最小修复。

未修改 State Transition Prepare Recovery 规则、Step 1 Schema、Stage 3.2、
Stage 3.3、Migration 或依赖。未开始 Step 7 / Step 8。

完成后停止，等待最终架构评审。
