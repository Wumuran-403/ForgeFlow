# Phase 3 Step 6.3.4.2 Development Report

> 状态：Migration v8 + Verification Repository 完成，等待架构评审
>
> 范围：Recovery Evidence Readback Request / Read Attempt / Verification
> Check / Verification 持久化、Recovery Evidence UoW、EvidenceRead 扩展和
> TaskSnapshot 扩展
>
> 边界：没有执行真实 Read-back、Verifier、Recovery、Provider 或 Write，
> 没有进入 Step 6.3.4.3

## 1. 新增与修改文件

Migration 与类型：

- `src/storage/migrations/008-phase3-step6-3-4-2.ts`
- `src/storage/migrations/index.ts`
- `src/storage/types.ts`

Repositories：

- `src/storage/recovery-evidence-readback-request-repository.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/recovery-evidence-verification-check-repository.ts`
- `src/storage/recovery-evidence-verification-repository.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `src/storage/recovery-evidence-read-capability.ts`
- `src/storage/recovery-evidence-readback-operation-keys.ts`

UoW 与 Snapshot：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/step6-3-4-2-schema.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/recovery-evidence-uow-fixture.ts`
- `tests/storage/recovery-evidence-attempt-worker.ts`
- `tests/storage/snapshot-concurrency.test.ts`
- 既有 Migration 版本与表清单测试

文档：

- `docs/PHASE3_STEP6_3_4_2_DEVELOPMENT_REPORT.md`

没有新增依赖。

## 2. Migration v8

Migration v8 不修改 v1-v7，新增：

```text
recovery_evidence_readback_requests
recovery_evidence_read_attempts
recovery_evidence_verification_checks
recovery_evidence_verifications
```

并重建 `recovery_evidence_reads`，保留 v7 历史行。新增字段对历史行保持
NULL，不伪造 readback request、check、attempt、result digest、resource
version/ETag 或 payload store 数据。

### 2.1 EvidenceRead 扩展

新增：

```text
evidence_submission_id
readback_request_id
read_attempt_id
verification_check_id
observed_at
resource_version
resource_etag
result_payload_digest
result_payload_store_ref
result_payload_storage_mode
```

受控 Transaction B 行必须具有完整绑定；v7 历史行和既有 legacy repository
写入路径可保持新字段为 NULL。新增 Trigger 对带受控关联的行校验：

- Request / Attempt / ToolRun / Evidence Submission 同 Task。
- Attempt 已 completed。
- Check expected digest 等于 EvidenceRead result digest。
- version_conditional 的实际版本/ETag 与 Request 预期一致。
- Read ToolRun 已 succeeded，且恰好存在一条 Tool Message。

### 2.2 Readback Request

保存完整：

- Review / Evidence Submission / Original Unknown Write。
- Operation / ExecutionPlan / PlanStep / Read ToolRun。
- Verifier / Allowlist / Tool version / schema hash。
- Retry safety / consistency mode。
- Expected resource version / ETag。
- 预分配 verificationCheckId。

Operation 结果关联继续使用真实字段：

```text
operation.result_plan_id
operation.result_tool_run_id
operation.applied_event_id
```

没有引用不存在的 Operation `plan_step_id` 或 `read_tool_run_id` 列。
`recovery.readback_requested` Event payload 中的 operationId、requestKey、
requestId、plan ID、step ID、read run ID 和 check ID 必须与 Request 一致。

### 2.3 Read Attempt

支持：

```text
prepared
dispatching
interrupted
completed
failed
timed_out
cancelled
blocked_by_intent
```

新增 `version` 和 `last_event_id`，用于 CAS 和 Event 关联。Trigger 校验：

- Prepared row 只能由 `recovery.evidence.read_attempt_prepared` Event 创建。
- 每次 UPDATE 必须 `version + 1` 且使用新 Event。
- Event type、readAttemptId、attemptNumber、attemptStatus 必须匹配。
- 状态转换只允许 predefined graph。
- DELETE 被拒绝。

### 2.4 Verification Check

支持：

```text
readback_transaction_b
stored_evidence_v0
```

校验：

- Request 预分配 Check ID 与 Transaction B Check 一致。
- Stored V0 不能占用任何 Request 已预分配的 Check ID。
- Check 原 Manifest / Review / Original Unknown Write / agent Plan 一致。
- Transaction B Check 的 Request、verifier、allowlist 和 read tool 配置
  完全一致。
- Request、Check、EvidenceRead 和最终 Verification 最多一一关联。
- Check 行 append-only。

Transaction B 写入顺序为 Check intent -> EvidenceRead。EvidenceRead 侧
`verification_check_id` Trigger 反向确认 Check，避免即时外键循环。

### 2.5 Verification

保存 Availability、Integrity、Authenticity 和 Verification 分层结果。

- Availability Event 必填并唯一。
- Verification Event 可空且唯一。
- `verification_status=not_run` 时 Verification Event 必须为 NULL。
- Verifier 实际执行时两个 Event 都必须关联同一 Verification。
- 两个 Event 必须与 Verification 同 Task，payload ID/status/requestKey
  必须一致。
- 同一 Check intent 只允许一条最终 Verification。
- Verification 行 append-only。

## 3. Repositories

新增四个 Repository：

- `RecoveryEvidenceReadbackRequestRepository`
- `RecoveryEvidenceReadAttemptRepository`
- `RecoveryEvidenceVerificationCheckRepository`
- `RecoveryEvidenceVerificationRepository`

均使用 Zod 输入边界和 `StorageWritePermit`。查询支持：

- Request：ID、requestKey、operation ID、Task。
- Attempt：ID、Task，以及单调 next attempt number。
- Check：ID、check ID + Task、requestKey、Task。
- Verification：ID、check ID + Task、requestKey、Task。

`RecoveryEvidenceReadRepository` 增加受 capability 保护的
`insertControlled()`；旧 `insert()` 只允许创建所有新关联字段为 NULL 的
legacy/history-compatible 行。

## 4. RecoveryEvidenceUnitOfWork

新增独立同步 UoW：

```text
createOwnedRecoveryEvidenceReadbackRequest
createOwnedRecoveryEvidenceReadAttemptPrepared
transitionOwnedRecoveryEvidenceReadAttempt
createOwnedRecoveryEvidenceVerificationCheck
completeOwnedRecoveryEvidenceRead
recordOwnedRecoveryEvidenceVerification
```

共同约束：

- 构造时必须注入 local ExecutionAuthority guard，不能省略。
- 使用 Lease ownership / fencing / mandatory ExecutionAuthority guard。
- 只允许 `waiting_review` Task。
- 使用 Task version CAS。
- 使用 immediate SQLite transaction。
- 使用 StorageWritePermit。
- 不修改 Task.status。
- 不 await 外部 Read / Verifier。

### 4.1 Request + Attempt A1

`createOwnedRecoveryEvidenceReadbackRequest()` 原子提交：

```text
recovery.readback_requested Event
request_readback Operation (accepted)
Readback Request
recovery.evidence.read_attempt_prepared Event
Prepared Attempt
Checkpoint
```

同时：

- 重算 operation payload digest。
- 校验 requestKey。
- CAS Review decisionVersion。
- 校验 read Plan purpose、PlanStep kind、Read ToolRun mode/status。
- 相同 requestKey 返回原 Request / Attempt / Operation。
- 相同 key 但任何 binding 不一致时拒绝。

### 4.2 Retry Attempt

`createOwnedRecoveryEvidenceReadAttemptPrepared()` 在同一 immediate
transaction 内分配 `MAX(attemptNumber)+1`。

- 同一 Request 只能存在一个 prepared/dispatching active attempt。
- completed Request 不允许新 Attempt。
- 两个连接并发竞争时只有一个可以取得下一次 active retry attempt。

### 4.3 Transaction B

`completeOwnedRecoveryEvidenceRead()` 原子提交：

```text
ToolRun running -> succeeded
Tool Message
PlanStep -> completed
Attempt completed Event + Attempt CAS
tool.succeeded Event
Verification Check intent
EvidenceRead
recovery.evidence.read_completed Event
Checkpoint
```

ToolRun、Message、PlanStep、Attempt、Check、EvidenceRead、Event 或
Checkpoint 任一失败时整体 rollback。

### 4.4 Stored Evidence V0

`createOwnedRecoveryEvidenceVerificationCheck()` 创建 append-only V0 Check，
不创建 EvidenceRead，不启动 Verifier。

### 4.5 Verification

`recordOwnedRecoveryEvidenceVerification()` 原子提交：

```text
Availability Event
optional Verification Event
Verification row
Checkpoint
```

Transaction B Check 要求 `controlled_runtime_read` provenance。Stored V0
可使用 declared/none provenance。相同 requestKey exact replay 返回原结果，
不重复写 Event / Checkpoint。

## 5. TaskSnapshot

`TaskSnapshot` 新增：

```text
recoveryEvidenceReadbackRequests
recoveryEvidenceReadAttempts
recoveryEvidenceVerificationChecks
recoveryEvidenceVerifications
```

并扩展现有 `recoveryEvidenceReads` 字段。

五个 Recovery Evidence 集合与 Events、Operations、Reviews、Submissions
都通过 `TaskSnapshotReader.load()` 的同一 SQLite read transaction 读取。
新增 WAL concurrency 测试在 Snapshot 读取过程中由另一连接提交 Check，
第一次 Snapshot 不包含该提交，第二次 Snapshot 包含完整提交。

## 6. 测试结果

已执行：

```text
pnpm test
```

结果：43 个测试文件通过，360 个测试通过。

覆盖：

- v7 -> v8 升级和历史 EvidenceRead NULL 保留。
- Migration failure rollback。
- 新表、索引、Trigger、外键与 append-only。
- Request exact replay、A/B/C 独立 Request。
- 错误 Manifest / Original Write / Cross Task / Operation-Event mismatch。
- Attempt CAS、Event 原子性、DELETE 拒绝。
- 两个连接并发 retry attempt 分配。
- Transaction B ToolRun + Message + PlanStep + Attempt + Check +
  EvidenceRead + Event + Checkpoint 完整原子提交。
- Transaction B 每个持久化写入点的故障注入 rollback。
- local ExecutionAuthority revoked 后拒绝 dispatching、B commit、V0
  Verification commit 和 exact replay。
- Stored V0 Check、Check ID reservation 和独立 Check ID。
- Availability Event 必填、Verification Event optional。
- Verification exact replay 和唯一终态。
- 五类 Recovery Evidence Snapshot 集合同事务读取。
- Phase 1 / Phase 2 / Step 6.1-6.3.4.1 全量回归。

已执行：

```text
pnpm typecheck
```

结果：通过。

已执行：

```text
git diff --check
```

结果：通过。仅有既有文件的 LF/CRLF normalization warning，无 whitespace
error。

## 7. 遗留风险与边界

- 本步骤没有实现实际 Read-back Executor。
- 本步骤没有执行 Verifier 或实现 Verifier Service。
- 本步骤没有实现 Step 6.3.4.4 的父 Plan / PlanStep / Read ToolRun 创建
  业务；但 UoW 已提供 `RecoveryEvidenceParentPreparation` callback，
  与 Request / Operation / Attempt 共享同一个 immediate transaction 和
  StorageWritePermit。
- 没有实现 pending Verification 自动恢复。
- 没有实现 RecoveryManager Scanner / Recovery Gate 接入。
- 没有执行 Recovery、Provider、Read-back、Verifier 或 Write。
- 没有修改 Task.status。
- 没有实现 Step 6.3.4.3。

## 8. Supplementary Hardening Record

### 8.1 原始实现实际情况

架构评审前：

- `completeOwnedRecoveryEvidenceRead()` 只写 Attempt、Check、EvidenceRead、
  Event 和 Checkpoint。
- ToolRun / Tool Message / PlanStep 仍要求调用方预先提交，Transaction B
  不具备完整原子性。
- UoW 的 authority guard 是可选参数。
- Request UoW 只能组合已经存在的父 Plan / PlanStep / Read ToolRun。
- Legacy `RecoveryEvidenceReadRepository.insert()` 理论上可传入受控字段。

### 8.2 修改的代码文件

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `src/storage/recovery-evidence-read-capability.ts`
- `src/storage/index.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/recovery-evidence-uow-fixture.ts`
- `tests/storage/recovery-evidence-attempt-worker.ts`
- `tests/storage/snapshot-concurrency.test.ts`
- `docs/PHASE3_STEP6_3_4_2_DEVELOPMENT_REPORT.md`

### 8.3 Transaction B 最终原子写入清单

同一 SQLite immediate transaction、同一 StorageWritePermit：

```text
ToolRun running -> succeeded
Tool Message
PlanStep queued/running -> completed
Attempt dispatching -> completed + Event
tool.succeeded Event
Verification Check intent
EvidenceRead
recovery.evidence.read_completed Event
Checkpoint
```

故障注入覆盖：

- ToolRun transition。
- Tool Message。
- PlanStep result。
- Attempt completed Event。
- Attempt transition。
- Tool result Event。
- Check intent。
- EvidenceRead。
- Read completed Event。
- Checkpoint。

每个失败点均验证 ToolRun、Message、PlanStep、Attempt、Check、EvidenceRead、
Event 和 Checkpoint 没有部分提交。

### 8.4 ExecutionAuthority 强制检查

`RecoveryEvidenceUnitOfWork` 构造函数现在必须接收：

```text
assertAuthority: () => void
```

所有 public UoW 方法在完成 Lease ownership 检查后调用该 guard。测试验证：

- DB Lease 仍有效但 local authority revoked 时 exact replay 被拒绝。
- Attempt dispatching 被拒绝。
- 迟到的 Transaction B result 被拒绝。
- 迟到的 Verification result 被拒绝。

### 8.5 Transaction A 组合契约

新增：

```text
RecoveryEvidenceParentPreparation
RecoveryEvidenceParentPreparationContext
```

`createOwnedRecoveryEvidenceReadbackRequest(input, prepareParents?)` 在
exact replay 未命中后，以同一 task / permit / timestamp callback 允许
Step 6.3.4.4 创建父 Plan / PlanStep / Read ToolRun。callback 与 Request /
Operation / Attempt 处于同一 immediate transaction；callback 之后任一步
失败都会整体 rollback。

### 8.6 Exact Replay 顺序

最终顺序：

```text
Lease / fencing ownership
  -> mandatory local ExecutionAuthority
  -> payload digest / requestKey recomputation
  -> persisted replay lookup
  -> exact binding comparison
  -> return original result without writes
  -> only on miss: Task version check
  -> parent preparation callback
  -> Review decisionVersion CAS
  -> create new Request / Operation / Attempt
```

E2E 测试验证 Task / Review version 后续推进后，相同 payload replay 返回原
Request / Attempt / Operation，不新增 Event / Checkpoint，也不执行 parent
callback。

### 8.7 Legacy insert 隔离

`insertControlled()` 必须携带 UoW 内部 WeakSet capability。

`insert()` 检测到任一 controlled 字段非 NULL 时抛出
`RECOVERY_EVIDENCE_CONTROLLED_READ_REQUIRED`。历史 v1-v7 兼容行仍可使用
所有新字段 NULL 的旧接口。

### 8.8 最终验证

- `pnpm test`：43 个测试文件、360 个测试通过。
- `pnpm typecheck`：通过。
- `git diff --check`：通过，仅有既有 LF/CRLF normalization warning。

完成后停止，等待架构评审。
