# Phase 3 Step 6.3.4.4 Stage 3.4 Step 1 Development Report

> 状态：Recovery Lineage Contract 补充修订完成，等待 Step 1 架构评审
>
> 范围：纯类型、Zod Schema、身份一致性 Validator、canonical payload helper
>
> 边界：未实施 Step 2、State Transition UoW、Recovery Preflight Capability、
> Fencing Takeover、Recovery UoW 或任何生产恢复入口。
>
> Step 2 compatibility addendum：Interrupted Payload 已增加 Migration v8
> Trigger / Stage 3.2 所需的 `attemptNumber`，并强制其等于
> `priorAttemptNumber`。详见 Step 2 Development Report。

## 1. 实际新增与修改文件

新增生产代码：

- `src/storage/recovery-evidence-recovery-lineage.ts`

修改导出：

- `src/storage/index.ts`

新增测试：

- `tests/storage/recovery-evidence-recovery-lineage.test.ts`

新增文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP1_DEVELOPMENT_REPORT.md`

没有新增依赖，没有修改 Migration v4–v9，没有创建 Migration v10 或 Schema。

## 2. Lineage 类型结构

新增 discriminated union：

```text
RecoveryEvidenceLineageV1 =
  | RecoveryEvidenceInterruptLineageV1
  | RecoveryEvidencePrepareLineageV1
```

Discriminator：

```text
recoveryPhase = "interrupt" | "prepare"
```

Root shared fields：

```text
lineageSchemaVersion = "recovery-evidence-lineage.v1"
recoveryOperationId UUID
taskId
readbackRequestId
readToolRunId
priorAttemptId
priorAttemptNumber
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
```

`recoveryOperationId` 使用 Zod UUID 格式校验，不绑定特定 UUID version。

## 3. Interrupted Event Payload

Schema：

```text
RecoveryEvidenceInterruptLineageV1Schema
```

阶段字段：

```text
recoveryPhase = interrupt
readAttemptId
attemptStatus = interrupted
dispatchEventId
dispatchFencingToken
leaseClaimEventId
fencingToken
interruptionCause
reasonCode
retryAssessment
resumeEligible
controlIntentKind optional
controlIntentEventId optional
pauseRequestEventId optional
```

严格约束：

- `readAttemptId === priorAttemptId`。
- `fencingToken > dispatchFencingToken`。
- `resumeEligible=true` 当且仅当 `retryAssessment=passed`。
- Cancel Intent 必须使用 `retryAssessment=not_evaluated`。
- `not_evaluated` 允许用于 Cancel 或 Pause interruption，但不允许无控制意图。
- Pause interruption 必须绑定 `pauseRequestEventId`。
- controlIntentKind / controlIntentEventId 必须同时出现或同时省略。
- Pause 的 `controlIntentEventId` 必须等于 `pauseRequestEventId`。
- 无控制意图时不得出现 controlIntent 或 pauseRequestEventId。
- 不允许出现 interruptionEventId / newAttemptId / newAttemptNumber /
  pauseClearEventId。

## 4. Prepared Event Payload

Schema：

```text
RecoveryEvidencePrepareLineageV1Schema
```

阶段字段：

```text
recoveryPhase = prepare
readAttemptId
attemptNumber
attemptStatus = prepared
interruptionEventId
newAttemptId
newAttemptNumber
leaseClaimEventId
fencingToken
pauseClearEventId optional
```

严格约束：

- `readAttemptId === newAttemptId`。
- `attemptNumber === newAttemptNumber === priorAttemptNumber + 1`。
- `interruptionEventId` 必填。
- `leaseClaimEventId` 必填。
- `pauseClearEventId` 仅适用于 Pause continuation。
- Interrupted / Prepared 引用不同 Lease Claim Event 是合法的；Full Recovery
  可相同，Pause continuation 必须使用新 Resume Owner 自己的 Claim Event。

## 5. Validator 规则

### 5.1 Single Payload

```text
validateRecoveryEvidenceLineageV1(input, expectedIdentity?)
```

验证：

- Phase-specific Schema。
- 可选 Task / Request / ToolRun / prior Attempt ID / attemptNumber 绑定。
- unknown fields 拒绝。
- 纯函数，不访问数据库、Registry、Provider、文件系统或网络。

### 5.2 Interrupted + Prepared Pair

```text
validateRecoveryEvidenceLineagePair({
  interrupt,
  prepare?,
  interruptionEventId?,
  expectedIdentity?
})
```

验证：

- Interrupted / Prepared root recoveryOperationId 相同。
- Task / Request / ToolRun / prior Attempt identity 相同。
- Retry Safety / Consistency / Allowlist / Tool / Intent Digest /
  expected version / ETag 完全相同。
- `prepare.interruptionEventId` 等于期望 Interrupted Event ID。
- priorAttemptNumber 连续。
- `resumeEligible=true` 才允许 Prepare continuation。
- Pause interruption 与 pauseClearEventId 必须成对出现。
- Prepared fencingToken 严格大于 prior Dispatch fencingToken。
- Retry Safety / Consistency 只允许：
  - `immutable + immutable_version` + expected 字段均为 null。
  - `version_conditional + etag_or_resource_version` + 至少一个 expected
    字段非 null。

### 5.3 Canonical Payload

```text
canonicalRecoveryEvidenceLineageV1(input)
```

先验证 Schema，再使用现有 `canonicalJson()`。对象 key 顺序不同会产生相同
canonical payload。

## 6. 测试场景与结果

新增 17 项纯单元测试：

1. 合法 Interrupt Lineage。
2. 合法 Prepare Lineage。
3. 同 root ID、不同 phase。
4. Interrupted / Prepared 使用不同 Lease Claim Event。
5. 跨 Task / Request / ToolRun expected identity 拒绝。
6. 非法 recoveryOperationId UUID 拒绝。
7. Interrupted / Prepared readAttemptId mismatch 拒绝。
8. attemptNumber 不连续拒绝。
9. interruptionEventId / leaseClaimEventId / newAttemptId 缺失拒绝。
10. Interrupted 出现 Prepare 字段拒绝。
11. retryAssessment / resumeEligible 组合矩阵。
12. 未知额外字段拒绝。
13. canonical payload key-order 稳定性。
14. Prepared Payload 包含 Stage 3.2 所需的 attemptNumber。
15. Prepare 存在时 Interrupted Event ID 必填且必须一致。
16. Retry Safety / Consistency 合法与非法组合矩阵。
17. Control Intent 半绑定、Pause Event 不一致和伪造 pauseRequestEventId
    被拒绝。

专项测试：

```text
pnpm vitest run tests/storage/recovery-evidence-recovery-lineage.test.ts
```

结果：

```text
Test Files  1 passed (1)
Tests       17 passed (17)
```

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  53 passed (53)
Tests       559 passed (559)
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

## 7. Stage 3.2 Dispatch Gate 兼容性

当前 `hasValidRetryDispatchLineage()` 字段兼容：

Interrupted Event：

```text
readAttemptId
attemptStatus=interrupted
recoveryOperationId
priorAttemptId
resumeEligible
pauseRequestEventId（Pause 时）
```

Prepared Event：

```text
readAttemptId=newAttemptId
attemptNumber
attemptStatus=prepared
recoveryOperationId
priorAttemptId
interruptionEventId
newAttemptId
pauseClearEventId（可选）
fencingToken
```

Preparation Schema 现在显式包含 `attemptNumber`，并强制：

```text
attemptNumber = newAttemptNumber = priorAttemptNumber + 1
```

这直接兼容 Stage 3.2 对 `preparedEvent.payload.attemptNumber` 的读取。

本 Step 不放宽 Stage 3.2 Gate：

- Prepared / Interrupted 必须使用同一 root recoveryOperationId。
- prepare 必须引用 Interrupted Event。
- priorAttemptNumber 必须连续。
- Retry Assessment 未通过时不会产生 `resumeEligible=true`。
- Prepared fencing 必须大于 prior Dispatch fencing。

Pause Resume Continuation 在 Clear 后仍由后续 Step 使用同一 root ID +
`recoveryPhase=prepare` 创建唯一 Prepared Event。

## 8. Migration / Schema 需求

本 Step 不需要 Migration 或 Schema 变更：

- Lineage 为纯 TypeScript + Zod 契约。
- 未来可写入现有 `events.payload_json`。
- 不新增表、不修改 Migration v4–v9。

未解决 Schema 决策：

- `recoveryOperationId` 无数据库 UNIQUE 约束。
- Event payload lineage 查询无专用索引。

两项均不属于 Step 1；若要求 DB-level uniqueness，应单独评审 Migration v10。

## 9. 已知边界

- Pure Validator 无法证明 `leaseClaimEventId` 在数据库中存在，也不能判断
  Claim Event sequence；这些留到 Step 4 Recovery State Transaction。
- Pair validator 需要调用方提供实际 Interrupted Event ID；Pure Contract
  不读取 Event Repository。
- retryAssessment 的 passed 仅表示契约字段一致，不执行 Registry/Retry
  Preflight；真实 Capability 属于 Step 3。
- 没有生产代码调用这些 Schema，因此尚未形成任何恢复权限。
- Durable recoveryOperationId Command / Job 仍缺失，Step 5 前必须解决。

补充核查结论：

- Stage 3.2 实际读取 `preparedEvent.payload.attemptNumber`，补充前确实存在
  字段缺口。
- Pair Validator 已满足 interrupt-only 不要求 Event ID、prepare 必须提供
  实际 Interrupted Event ID。
- Pause interruption 未完成 Retry Assessment 时允许
  `not_evaluated + resumeEligible=false`，Stage 3.2 Gate 保持不变。
- 纯 Validator 已明确限定两种 Retry Safety / Consistency 组合。

## 10. 封存结论

Step 1 的补充契约缺口已修复，专项和全量测试均通过。若本轮架构评审接受
Event payload-based Lineage V1 与 UUID recoveryOperationId 契约，建议将
Stage 3.4 Step 1 正式封存。

封存不代表允许 Step 2；State Transition UoW 修改仍需独立授权。

## 11. 边界声明

本轮未实施：

- Stage 3.4 Step 2。
- State Transition UoW 修改。
- Recovery Preflight Capability。
- Fencing Takeover。
- Interrupted Recovery 或 Resume Continuation UoW。
- Recovery Lineage Repository。
- Durable Recovery Job / Command Store。
- External Read / Transaction B / Verifier / Recovery Manager。
- Migration v10 或依赖变更。
- Step 6.3.5。

完成后停止，等待 Stage 3.4 Step 1 架构评审。
