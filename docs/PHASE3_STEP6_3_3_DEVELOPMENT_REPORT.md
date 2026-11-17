# Phase 3 Step 6.3.3 Development Report

> 状态：Evidence Submission + Unresolved，6.3.3.1 Auditability
> Hardening 完成
>
> 范围：operation-specific Lease-owned 入口、Evidence Digest/Binding、
> `submit_evidence`、`mark_unresolved`、幂等和审计
>
> 边界：没有实现最终 Review Decision、Verifier、Read-back、Write Recovery、
> Provider 调用或 Step 6.3.4

## 1. 修改与新增文件

Recovery：

- `src/recovery/recovery-review-submission.ts`
- `src/recovery/recovery-review-decision-service.ts`
- `src/recovery/recovery-manager.ts`
- `src/recovery/evidence-payload-store.ts`
- `src/recovery/index.ts`

Storage：

- `src/storage/execution-unit-of-work.ts`
- `src/storage/recovery-evidence-submission-repository.ts`
- `src/storage/recovery-review-operation-repository.ts`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts`
- `src/storage/migrations/index.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/types.ts`
- `src/storage/index.ts`

测试：

- `tests/recovery/recovery-evidence-submission.test.ts`
- `tests/recovery/evidence-submission-worker.ts`
- `tests/recovery/review-operation-fixture.ts`
- `tests/storage/step6-3-3-1-schema.test.ts`

文档：

- `docs/PHASE3_STEP6_3_3_DEVELOPMENT_REPORT.md`

本步骤没有新增依赖，没有修改 Migration v1-v6。6.3.3.1 新增 Migration v7，
用于不可变 Evidence Submission Manifest。

## 2. Operation-specific 公开入口

新增两个正式 RecoveryManager 方法：

```text
RecoveryManager.submitRecoveryEvidence(...)
RecoveryManager.markRecoveryReviewUnresolved(...)
```

没有重新开放任意 Operation 或通用 decision version bump。Step 6.3.2 的
`advance_decision_version` 仍只通过未公开的 Symbol-keyed 内部测试入口使用。

两个正式方法复用：

- TaskLeaseManager / Claim。
- LeaseHeartbeat。
- ExecutionAuthority。
- TaskSnapshotReader。
- RecoveryReviewDecisionService。
- ExecutionUnitOfWork。
- StorageWritePermit。
- Task/Review CAS。
- requestKey 持久化幂等。

Manager 统一负责 Claim、立即 Heartbeat 校验、Snapshot、binding 校验、
Operation 调用、Heartbeat failure、停止 Heartbeat 和原 token/fencing Release。

## 3. Evidence Submission 流程

### 3.1 Host Context

客户端提交的 Evidence 数据不包含可覆盖的 actor/verifier 身份字段。

Host context 使用 discriminated union：

```text
manual_review:
  actorId

system_verification:
  verifierId
  verificationId
```

错误 source-specific 字段组合由 Zod 拒绝。`submittedAt` 由 Manager 使用宿主
时钟生成，`verifiedAt` 固定为 NULL。

Operation 的 `actor_id`：

- manual review 使用 `actorId`。
- system verification 使用 `verifierId` 作为宿主操作身份。

### 3.2 Payload Digest 重算

`submitRecoveryEvidence` 接受实际 payload content：

- `raw_bytes`：canonical base64 解码后重新计算 SHA-256。
- `json`：JCS + SHA-256。
- `readback_result`：固定 Read-back Result Schema + JCS + SHA-256。
- `external_reference`：没有 Adapter，无法验证实际外部内容，因此只记录
  声明 Digest，并始终标记 `trustStatus=unverified`。

提交的 `payloadDigest` 必须与重新计算结果一致，否则拒绝。

随后使用 Step 6.3.1 的
`RecoveryEvidenceEnvelopeSchema` 和
`computeRecoveryEvidenceEnvelopeDigest` 生成 Envelope Digest。

`redactedSummary` 不参与 Digest。原始 payload content 不写入 Event 或
Operation。

### 3.3 Binding 校验

UoW 在同一事务内验证：

- Envelope Task ID 与当前 Task。
- Envelope ToolRun ID 与 Review 绑定 ToolRun。
- ToolRun 属于同一 Task。
- ToolRun 为 started Write、结果 unknown。
- ToolName。
- ToolVersion。
- InputSchemaHash。
- CanonicalInputHash。
- IdempotencyKey。
- Review protocol v1。
- Review status 为 pending/unresolved。
- Review decisionVersion CAS。

任一不匹配整体 rollback。

### 3.4 Trust 边界

所有本步骤提交的 Evidence 都记录为：

```text
trustStatus = unverified
finalEligible = false
trustReason = final_verification_not_executed
```

`observed_succeeded`、`observed_not_executed` 和 `inconclusive` 只表示收到
相应声明或证据，不代表最终 Review 已确认。Unknown Write 仍保持 unknown，
Terminal Guard 和 Recovery Gate 仍保持阻塞。

`external_reference` 不会因为存在 URL、ETag 或 Digest 就变成可信外部证据。
其 Event 明确记录：

```text
trustReason = external_adapter_not_executed
```

受控 Adapter 和 Verifier 属于 Step 6.3.4。

## 4. submit_evidence Transaction

顺序：

```text
local ExecutionAuthority guard
  -> capability / StorageWritePermit
  -> current Lease + fencing ownership
  -> requestKey identity validation
  -> persisted replay lookup
      -> exact match: return, no writes
      -> mismatch: reject
      -> not found: continue
  -> Task Version CAS
  -> Review protocol/status/version/binding validation
  -> update current RecoveryReview evidence metadata
  -> Event
  -> submit_evidence Operation
  -> Checkpoint
  -> COMMIT
```

Operation：

```text
operation = submit_evidence
status = applied
expectedDecisionVersion = 当前版本
resultingDecisionVersion = expected + 1
evidenceEnvelopeDigest = 本次 Envelope Digest
```

Review status 不因收到 Evidence 自动改变。Task、PlanStep、ToolRun 和 Tool
Message 均不改变。

Event 只包含审计字段，包括 review/toolRun、source、outcome、payload/hash、
actor/verifier reference、decisionVersion、requestKey 和 fencingToken。

## 5. mark_unresolved Transaction

允许：

```text
pending -> unresolved
unresolved -> unresolved
```

要求：

- 非空 reason。
- expectedDecisionVersion CAS。
- `referencedEvidenceEnvelopeDigest` 可为 null。
- 非 null 时必须引用该 Review 已提交的 `submit_evidence` Operation。
- 每次成功操作产生独立 Event、Operation 和 Checkpoint。
- 相同 requestKey 重放不重复写入。

`unresolved -> unresolved` 不是空版本递增：请求必须包含原因，并明确是否
引用 Evidence Envelope。新 Evidence 后再 unresolved 会形成新的 request key
和 decision version。

本操作：

- 更新 Review status 为 unresolved。
- 更新 note/reason。
- 补齐 unresolved schema 要求的 source type 和 decidedAt。
- 不修改 ToolRun、Tool output、Tool Message、PlanStep 或 Task status。
- 不生成 Resume 或 Provider 请求。

Final Review 状态通过 manager 和 UoW 两层拒绝。

## 6. CAS、Idempotency 与并发

Replay lookup 继续早于 Task Version CAS：

- 已应用请求可在 Task Version 合法增长后重放。
- Replay 仍先验证当前 Lease/fencing/authority，stale Worker 不能绕过。
- 重放不更新 Review，不重复 Event/Operation/Checkpoint。
- 相同 requestKey 不同 payload 拒绝。
- 两个独立数据库连接竞争同一 expected version 时，只有一个成功。

新增 Evidence Submission Worker 使用真实文件型 SQLite，验证
`submit_evidence` 的双连接并发行为。

## 7. Lease / Transaction 安全

- Heartbeat 在提交前立即执行 ownership validation。
- Heartbeat failure 先 revoke ExecutionAuthority，再 Abort。
- 本地 revoked 即使 DB Lease 有效也不能提交。
- UoW transaction 内再次验证 Lease/fencing 和 authority。
- Event 失败时 Review CAS、Operation 和后续写入全部 rollback。
- Checkpoint 失败时 Review 更新、Event 和 Operation 全部 rollback。
- Release 失败显式返回 `RECOVERY_REVIEW_LEASE_RELEASE_FAILED`。

## 8. 测试结果

新增测试文件：

- `tests/recovery/recovery-evidence-submission.test.ts`：12 项。

覆盖：

- 合法 manual_review evidence。
- 合法 system_verification evidence。
- Host identity 注入错误拒绝。
- Task、ToolRun、ToolVersion、Schema Hash、Input Hash、idempotency key
  mismatch。
- payload content digest 重算与错误 Digest 拒绝。
- external_reference unverified。
- Event 不包含原始敏感 payload。
- 同 requestKey replay 不重复审计。
- 同 key 不同 payload 拒绝。
- 旧 Task Version replay。
- stale fencing replay 拒绝、新 owner replay 成功。
- 双连接 evidence submission 并发。
- Heartbeat failure。
- Release failure。
- Event/Checkpoint rollback。
- pending -> unresolved。
- unresolved -> unresolved with new evidence。
- unresolved replay。
- unknown evidence reference 拒绝。
- final Review 拒绝。
- ToolRun/PlanStep/Task 状态保持。

改动前基线：

- 37 个测试文件。
- 295 项测试通过。

改动后：

- `pnpm test`：39 个测试文件、313 项测试全部通过。
- `pnpm typecheck`：通过。
- `git diff --check`：退出码 0，无 whitespace error；存在既有 LF/CRLF
  提示。

## 9. 尚未完成与阶段边界

本步骤没有实现：

- confirmed_succeeded。
- confirmed_not_executed。
- Evidence Verifier 或受控外部 Adapter。
- Recovery Evidence Plan / Read-back ToolRun。
- Read-back 执行或 Crash Recovery。
- Legacy Conflict Resolution。
- Write Recovery。
- 普通 Agent Resume。
- Provider 调用。
- Step 6.3.4。

RecoveryReview 当前字段只保存最新提交的 Evidence metadata。历史轨迹由
append-only Events 和 Operations 保留，而不是在 Review 表中保存多版本
Evidence 集合。

本次完成 Phase 3 Step 6.3.3 与 Step 6.3.3.1 Auditability Hardening。
没有执行任何 Write、Provider 或 Read-back，也没有开始 Step 6.3.4。

## 10. Step 6.3.3.1 Auditability Hardening

### 10.1 Immutable Evidence Submission Manifest

Migration v7 新增：

```text
recovery_evidence_submissions
```

每条成功 `submit_evidence` 产生独立 immutable Manifest，保存：

- evidenceRef。
- resourceRef/resourceVersion。
- sourceObservedAt/submittedAt。
- source-specific actor/verifier identity。
- payload type/protocol/digest。
- envelope digest。
- payloadStoreRef/storageMode。
- requestKey。
- operationId。
- appliedEventId。

关联：

- `(task_id, review_id)` -> RecoveryReview。
- `(task_id, tool_run_id)` -> ToolRun。
- `(task_id, operation_id)` -> `submit_evidence` Operation。
- `(task_id, applied_event_id)` -> submitted Event。

Trigger 验证 Operation/Event/Manifest 一致。Manifest 禁止 UPDATE/DELETE。

### 10.2 Payload Store

新增本地内容寻址文件 Store：

- raw_bytes：保存原始字节。
- json：保存 JCS canonical UTF-8 bytes。
- readback_result：保存规范化 JSON bytes。
- external_reference：不保存内容，记录 `reference_only`。

Store ref 格式：

```text
evidence-file:sha256/<digest-hex>
```

写入使用 temp file + atomic hard link，内容不可覆盖。重复相同内容返回原 ref。
读取时重新计算 SHA-256，篡改或缺失会失败。

默认目录为 `data/evidence`，测试使用临时目录。Store 在 SQLite transaction
之前写入。SQLite 失败可产生未被 Manifest 引用的 orphan，本步骤不实现自动
回收。

### 10.3 Event / Operation / Manifest 关联

`recovery.evidence.submitted` Event 现在额外保存：

- evidenceSubmissionId。
- evidenceRef。
- resourceRef/resourceVersion。
- sourceObservedAt/submittedAt。
- payloadStoreRef/payloadStorageMode。

原有 identity、outcome、digest、requestKey、fencingToken 继续保存。
Event 仍不保存原始敏感 Payload。

### 10.4 Snapshot

TaskSnapshot 新增：

```text
recoveryEvidenceSubmissions
```

与 Events、Operations、RecoveryReviews 在同一 SQLite read transaction 读取。
所有历史 Manifest 按 decisionVersion/createdAt/id 稳定排序。

### 10.5 A/B/C 追溯

测试完整执行：

```text
submit A -> unresolved A
submit B -> unresolved B
submit C
```

现在可以分别读取：

- A/B/C evidenceRef。
- resourceRef/resourceVersion。
- sourceObservedAt/submittedAt。
- actor/verifier identity。
- payload/envelope digest。
- requestKey。
- Operation appliedEventId。
- Event evidenceSubmissionId。
- 两次 unresolved reason 与引用的 Envelope Digest。

### 10.6 Availability Audit 约定

新增 Zod 审计约定：

```text
never_checked
available
unavailable
expired
replaced
digest_mismatch
```

Manifest 本身 immutable；后续可用性通过 append-only Event 记录。本步骤不实现
Verifier 或 availability Event 写入器，留给 Step 6.3.4。

### 10.7 历史数据

Migration v7 不为旧 `submit_evidence` Operation 伪造 Manifest。旧 Operation、
Event 和 Digest 保留，但升级前缺少完整 ref/resource/time 的提交无法重建为
新 Manifest。

### 10.8 6.3.3.1 测试

新增 6 项测试，覆盖：

- Manifest schema、复合外键和 immutable Trigger。
- v6 -> v7 不 backfill 旧 Operation。
- v7 Migration 失败回滚。
- A/B/C 完整历史。
- raw/JSON Payload 重新读取。
- Payload 重复写入、替换和删除。
- external_reference reference_only。
- Payload Store 失败不产生 Manifest。
- SQLite 失败产生 orphan但不产生有效 Manifest。
- Manifest UPDATE/DELETE 拒绝。

### 10.9 剩余限制

- 本地文件 Store 不提供分布式复制、ACL API 或自动 retention。
- 未被 Manifest 引用的 orphan 暂无自动 GC 命令。
- Availability Event 写入器和检查流程属于 Step 6.3.4。
- 历史旧 Submission 无法补造缺失的 Manifest 引用。
- `external_reference` 仍不会被判定为 available/trusted。
