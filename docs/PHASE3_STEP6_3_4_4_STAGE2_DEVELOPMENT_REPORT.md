# Phase 3 Step 6.3.4.4 Stage 2 Development Report

> 状态：Reservation Integration & Transaction A 完成，等待 Stage 2 架构评审
>
> 范围：RecoveryEvidenceReadbackService、Host Preparation、Reservation
> acquire/complete/abandon、ParentPreparation 与 Transaction A
>
> 边界：未实现 dispatching、External Read、Transaction B、Controlled
> Provenance、Recovery Scanner/Classifier 或 Step 6.3.5。

## 1. 修改文件

生产代码：

- `src/recovery/recovery-evidence-readback-service.ts`
- `src/recovery/recovery-evidence-manifest.ts`
- `src/recovery/recovery-readback-tool-registry.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-readback-reservation-unit-of-work.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/execution-plan-repository.ts`

测试：

- `tests/recovery/recovery-evidence-readback-service.test.ts`
- `tests/recovery/recovery-readback-tool-registry.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE2_DEVELOPMENT_REPORT.md`

没有新增 Migration、依赖或数据库 Schema 变更。

## 2. Service 调用链

```text
RecoveryEvidenceReadbackService.prepareReadback()
  -> Host request input Zod validation
  -> ReservationUnitOfWork.acquireOwned()

  state=historical_request
    -> return persisted Request
    -> no Host callbacks

  state=completed
    -> return persisted Request
    -> no Host callbacks

  state=in_progress
    -> return persisted Reservation identity
    -> no Host callbacks

  state=acquired | reentered
    -> load immutable business Snapshot
    -> Host Preparation
    -> ReservationUnitOfWork.completeOwned()
         -> RecoveryEvidenceUnitOfWork
              createOwnedRecoveryEvidenceReadbackRequest()
              + ParentPreparation
         -> Transaction A intent reconstruction
         -> Reservation preparing -> completed
    -> return persisted Request
```

任何 Preparation 或 Transaction A 失败都会尝试 abandon 当前 Reservation。
Lease/Authority 已经失效时保留 preparing，等待后续 fencing takeover。

## 3. Stable Request Identity

Reservation 使用：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
```

Request Intent：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
allowlistId
verificationCheckId
expectedDecisionVersion
expectedResourceVersion
expectedEtag
```

`taskId` 来自已校验的 TaskLease ownership Task，并实际进入
`forgeflow.recovery-evidence-readback-request-intent.v1` 的 canonical JCS
object 与 SHA-256 Digest。

Exact replay / takeover / reclaim 均先走 Reservation UoW，再决定是否执行
Host Preparation。

## 4. Host Preparation

仅 Reservation owner 会执行：

1. Load one consistent TaskSnapshot。
2. 验证 Review 是 protocol v1 active review。
3. 验证 Review decisionVersion。
4. 验证 Evidence Submission 属于 Review / Original Unknown Write。
5. 验证 applied submission Event。
6. 验证 Original ToolRun 为 `write + unknown`。
7. 验证 Original Agent Plan。
8. 验证 source ModelCall completed。
9. 使用持久化 Submission + Original ToolRun 构造 Manifest。
10. 解析精确 Allowlist Version。
11. 获取 Host Verifier Binding。
12. 执行 Host resolveSource。
13. 验证 Resource Scheme 白名单。
14. 执行 Host buildArguments。
15. ToolRegistry.validateInput。
16. 验证 Tool Name / Version / Schema Hash。
17. 计算 canonicalInputHash。
18. 重算 operationPayloadDigest 与 requestKey。

没有执行 Tool，也没有取得 ToolRegistry execution lease。

## 5. Resource Scheme 白名单

Stage 1 Contract 在 Stage 2 增加：

```text
allowedResourceSchemes
```

该字段：

- 是 Allowlist Immutable Contract 的一部分。
- 参与 allowlistVersion Digest。
- 禁止 http / https / file / ftp。
- `prepareArguments()` 要求 resolved resource scheme 位于显式白名单。

## 6. ParentPreparation / Transaction A

同一 SQLite immediate transaction 内：

```text
ExecutionPlan
  id = Reservation.executionPlanId
  purpose = recovery_evidence
  status = active
  version = transaction-time MAX(task execution_plans.version) + 1
  sourceModelCallId = Original Agent Plan source ModelCall

PlanStep
  id = Reservation.planStepId
  stepIndex = 0
  kind = read_batch
  status = queued

ToolRun
  id = Reservation.readToolRunId
  originalIndex = 0
  mode = read
  status = queued
  input = ToolRegistry Validated Input
  attemptNo = 1

RecoveryEvidenceUnitOfWork
  -> recovery.readback_requested Event
  -> request_readback Operation accepted
  -> Readback Request
  -> Prepared ReadAttempt #1
  -> Checkpoint

Reservation
  -> preparing
  -> completed
```

原始 Agent Plan、Agent PlanStep index 和 Original Unknown Write
`originalIndex` 均不修改。

## 7. Reservation Completion Invariant

Reservation completed 前：

1. 从已写入 Request / Operation 重构 Request Intent。
2. 重新计算 Request Intent Digest。
3. 与 Reservation 持久化 digest 比较。
4. 验证全部预分配 ID。
5. 验证 Plan / PlanStep / ToolRun / Attempt / Event。
6. 只有全部匹配才更新 Reservation completed。

不一致时整体 rollback，不保留部分 Parent 或 Request。

## 8. Cancel / Pause

- RecoveryEvidenceUnitOfWork 新 Request 分支在事务内检查 Cancel/Pause。
- Reservation complete 在调用 ParentPreparation 前检查。
- 已有 completed Request / historical Request replay 不受当前 intent 阻断，
  但不会启动外部 Read。
- 新 Request 被拒绝后不改变 Task.status、Review final decision 或 intent 字段。

## 9. Replay / Concurrency

已验证：

- completed Reservation replay 不调用 Source Resolver、Argument Builder 或
  Host Verifier Binding。
- historical Request replay 不调用 Host callbacks。
- preparing Reservation 竞争 Owner 返回 in_progress，不调用 callbacks。
- 原 Owner token 重入后可以继续 Preparation。
- stale fencing takeover 复用全部预分配 ID。
- abandoned Reservation 在更高 fencing 下 reclaim。
- 不同 Request Intent 在 Host callbacks 前拒绝。

## 10. 故障注入

对 Transaction A 以下写入点执行 fault injection：

- ExecutionPlan insert。
- PlanStep insert。
- ToolRun createIntent。
- RecoveryReviewOperation append。
- Readback Request insert。
- Prepared Attempt insert。
- Event append。
- Checkpoint append。
- Reservation complete。

每个失败点均验证：

- 无 Request。
- 无新增 Plan / PlanStep / ToolRun / Attempt。
- 无新增 Event / Checkpoint。
- Reservation 回到 abandoned，或因失权保持可恢复 preparing。

## 11. 测试结果

Stage 2 专项：

```text
pnpm vitest run tests/recovery/recovery-evidence-readback-service.test.ts
```

结果：1 个测试文件，14 个测试通过。

Stage 1 Contract Regression：

```text
pnpm vitest run tests/recovery/recovery-readback-tool-registry.test.ts
```

结果：1 个测试文件，12 个测试通过。

Reservation + Service Regression：

```text
pnpm vitest run tests/storage/recovery-evidence-readback-reservation.test.ts tests/recovery/recovery-evidence-readback-service.test.ts
```

结果：2 个测试文件，23 个测试通过。

全量测试：

```text
pnpm test
```

结果：50 个测试文件，448 个测试通过。

Typecheck：

```text
pnpm typecheck
```

结果：通过。

Diff check：

```text
git diff --check
```

结果：通过，仅有既有 LF/CRLF normalization warning。

## 11.1 Request Intent Digest Consistency Check

实际核查：

- `RecoveryEvidenceReadbackRequestIntentInputSchema` 包含必填 `taskId`。
- canonical JCS array 的 object 包含 `taskId`。
- Digest 使用固定 domain：

```text
forgeflow.recovery-evidence-readback-request-intent.v1
```

- Reservation UoW 使用当前 owned Task ID 构造 Intent。
- `assertOwnedPreparingReservation()` 从 owned Task 重建相同输入。
- Transaction A completion invariant 从 actual Request / Operation 字段
  重建 Intent，并与 Reservation 持久化 Digest 比较。

新增测试确认：

- 空 `taskId` 被 Zod 拒绝。
- 改变 `taskId` 会改变 Digest。
- canonical JCS 文本实际包含 `taskId` 字段。

因此不需要旧/新 Digest 兼容分支，也不需要修改生产代码或 Migration。

## 12. 兼容性影响

- Stage 1 Allowlist Contract 新增 `allowedResourceSchemes`，并纳入
  allowlistVersion Digest。
- 现有 Host Readback registration 必须声明资源 scheme 白名单。
- Manifest 构造逻辑抽为共享 helper，由 Stored Verification 与 Readback
  Service 共用。
- ExecutionPlanRepository 新增只读 `nextVersion(taskId)`。

没有修改 Migration v9，没有新增 Migration v10。

## 13. 剩余风险

- Host resolver / builder 的确定性、只读和无外部 I/O 仍是 Host 注册治理
  责任；Registry 只能冻结输入和 metadata。
- Plan version 在 immediate transaction 中用 MAX+1 分配，依赖 SQLite
  写锁和现有 `UNIQUE(task_id, version)` 约束。
- Service 不暴露 ownerToken；跨调用原 Owner 重入需要由上层 Host 持有
  Stage 1 Reservation 返回的 token。
- 本阶段未实现 dispatching、External Read、Transaction B 或 Verification
  integration。

## 14. 边界声明

本轮：

- 未执行真实 Read Tool。
- 未将 ToolRun 置为 running。
- 未将 Attempt 置为 dispatching。
- 未获取 ToolRegistry execution lease。
- 未写 EvidenceRead。
- 未实现 Transaction B。
- 未修改 Task.status。
- 未修改 RecoveryReview final decision。
- 未进入 Step 6.3.5。

完成后停止，等待 Stage 2 架构评审。
