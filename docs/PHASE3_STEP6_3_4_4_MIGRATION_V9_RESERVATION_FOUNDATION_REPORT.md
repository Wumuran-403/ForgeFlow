# Phase 3 Step 6.3.4.4 Migration v9 Reservation Foundation Report

> 状态：Migration v9 Reservation Foundation + Final Hardening 完成，
> 等待最终架构评审
>
> 范围：Reservation Schema、Repository、Lease-owned UoW、CAS 状态机与
> completed invariant 基础
>
> 边界：未实现 Request Service、Transaction A ParentPreparation、External
> Read、Transaction B、Controlled Provenance、Verification Integration、
> Recovery Scanner/Classifier 或 Step 6.3.5。

## 1. 新增与修改文件

生产代码：

- `src/storage/migrations/009-phase3-step6-3-4-4.ts`
- `src/storage/migrations/index.ts`
- `src/storage/recovery-evidence-readback-reservation-keys.ts`
- `src/storage/recovery-evidence-readback-reservation-repository.ts`
- `src/storage/recovery-evidence-readback-reservation-unit-of-work.ts`
- `src/storage/recovery-evidence-readback-request-repository.ts`
- `src/storage/types.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/step6-3-4-4-schema.test.ts`
- `tests/storage/recovery-evidence-readback-reservation.test.ts`
- `tests/storage/recovery-evidence-reservation-worker.ts`
- `tests/storage/schema.test.ts`
- `tests/storage/step6-3-1-schema.test.ts`
- `tests/storage/step6-3-2-schema.test.ts`
- `tests/storage/step6-3-3-1-schema.test.ts`
- `tests/storage/step6-3-4-2-schema.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_MIGRATION_V9_RESERVATION_FOUNDATION_REPORT.md`

没有新增依赖，没有修改已应用 Migration v4-v8。

## 2. Migration v9

新增表：

```text
recovery_evidence_readback_request_reservations
```

字段：

```text
id
task_id
review_id
evidence_submission_id
original_tool_run_id
request_id
operation_id
execution_plan_id
plan_step_id
read_tool_run_id
read_attempt_id
verification_check_id
request_intent_digest
owner_token
owner_fencing_token
status
reservation_version
created_at
updated_at
```

唯一约束：

```text
stable logical identity:
  task_id + review_id + evidence_submission_id + original_tool_run_id

scoped verification identity:
  task_id + verification_check_id

preallocated IDs:
  request_id
  operation_id
  execution_plan_id
  plan_step_id
  read_tool_run_id
  read_attempt_id
```

外键：

- Review 与 Task 复合外键。
- Evidence Submission 与 Task 复合外键。
- Original ToolRun 与 Task 复合外键。

Insert Trigger 验证：

- Task 为 `waiting_review`。
- Review 为 `pending` 或 `unresolved`。
- Review.toolRunId 等于 Original ToolRun ID。
- Submission 属于同一 Review 和 Original ToolRun。
- Original ToolRun 为 `write + unknown`。

状态 Trigger 验证：

- `preparing -> completed`
- `preparing -> abandoned`
- `preparing -> preparing` stale takeover
- `abandoned -> preparing` reclaim

`completed` 更新与 Reservation DELETE 被拒绝。

## 3. Request Intent Digest

固定协议：

```text
forgeflow.recovery-evidence-readback-request-intent.v1
```

输入：

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

计算：

```text
sha256(JCS([
  protocolVersion,
  intentInput
]))
```

不包含：

- Verifier binding。
- Allowlist Version。
- Read Tool binding。
- Host 尚未解析的配置。

稳定输入测试确认对象字段顺序不影响 Digest；业务预期变化会改变 Digest。

`allowlistId` 是 Host Readback Request 的显式业务字段；`allowlistVersion`
必须由后续不可变 Allowlist Registry 解析，因此不进入 Preparation 前的
Intent Digest。

## 4. Reservation Repository

新增：

```text
RecoveryEvidenceReadbackReservationRepository
```

接口：

```text
insert()
getById()
getByLogicalIdentity()
takeover()
abandon()
complete()
assertCompletedInvariant()
```

低层写入均要求：

- SQLite write transaction。
- StorageWritePermit。
- `reservation_version` CAS。
- owner token / fencing 条件。

Repository 不调用 Host Binding、Source Resolver、Argument Builder、
ToolRegistry 或任何外部 API。

## 5. Reservation UoW

新增：

```text
RecoveryEvidenceReadbackReservationUnitOfWork
```

公开生命周期：

```text
acquireOwned()
abandonOwned()
completeOwned()
```

所有入口：

- 使用 SQLite immediate transaction。
- 调用 `TaskLeaseManager.assertOwned()`。
- 调用 mandatory ExecutionAuthority guard。
- 只允许 `waiting_review` Task。
- 使用 StorageWritePermit。

`completeOwned()` 只提供 Transaction A completion callback 基础：

```text
Reservation
  + task
  + permit
  + timestamp
-> callback
-> completed invariant validation
-> reservation completed
```

该 callback 不包含 ParentPreparation 业务实现。

## 6. Owner Token

Owner token：

- 由 UoW 内部 `randomBytes(32).toString("hex")` 生成。
- 固定 64 lowercase hex。
- 不接受模型、HTTP 调用方或普通 input 提供。
- 不写入 Event、Checkpoint、日志或 AppError。
- 首次成功 acquire 返回 token。
- 原 Owner 必须携带已有 token 才能重入，返回 `reentered` 和原 token。
- 没有 token 或 token 不匹配的并发 Worker 返回 `in_progress`，
  `ownerToken = NULL`。
- 公共 Reservation View 不包含 ownerToken 字段，避免 in_progress 结果
  通过嵌套 Record 泄露 token。
- stale takeover/reclaim 才生成新 token。

## 7. 状态机与 CAS

### 创建

```text
no reservation -> preparing, version 1
```

### 同 owner 重复获取

```text
preparing + same fencing + matching ownerToken
  -> reentered
  -> 原 ownerToken 返回给该 Owner
  -> 不更新 version / timestamp
```

```text
preparing + same fencing + missing/mismatched ownerToken
  -> in_progress
  -> ownerToken = NULL
```

### Stale takeover

```text
preparing + higher fencing
  -> preparing
  -> new ownerToken
  -> reservation_version + 1
```

### Abandon

```text
preparing + exact owner/fencing/version
  -> abandoned
  -> reservation_version + 1
```

### Abandoned reclaim

```text
abandoned + higher fencing
  -> preparing
  -> new ownerToken
  -> reservation_version + 1
```

### Complete

```text
preparing + exact owner/fencing/version
  + completed Transaction A invariant
  -> completed
  -> reservation_version + 1
```

所有 takeover、abandon、complete 均以 CAS 失败拒绝旧 owner。

Intent 不一致时统一返回：

```text
RECOVERY_EVIDENCE_READBACK_REQUEST_INTENT_CONFLICT
```

不得因 Stable Logical Identity 相同而接受不同 Intent。

## 8. Completed Invariant

Reservation 转 completed 前，数据库与 Repository 均验证：

```text
Request ID / Task / Review / Submission / Original ToolRun
Operation ID / Request Key / accepted status
Operation result plan/run IDs
ExecutionPlan purpose=recovery_evidence, status=active
PlanStep read_batch, status=queued
Read ToolRun mode=read, status=queued
Read Attempt prepared, attempt_number=1
readback_requested Event
```

任一实际记录缺失或 ID 不一致时：

```text
RECOVERY_EVIDENCE_READBACK_RESERVATION_COMPLETION_INCONSISTENT
```

整个 transaction rollback，Reservation 保持 preparing。

## 9. Historical v8 Compatibility

- v8 已有 Request 不自动创建 Reservation。
- v9 不 backfill、不伪造 owner token 或 request intent。
- `RecoveryEvidenceReadbackRequestRepository.getByLogicalIdentity()`
  可查询历史 Request。
- Reservation UoW 对历史 Request 返回 `historical_request` 状态。
- 历史 Replay 会核对：

```text
Review / Submission / Original Write
Verification Check ID
Allowlist ID
expectedDecisionVersion
expectedResourceVersion
expectedEtag
```

- 无法从 Request / Operation 证明一致时 fail closed，不伪造历史字段。
- v8 Request 原有 Replay 数据和唯一约束保持不变。

## 9.1 预分配 ID 固定

- 首次成功 Reservation 原子保存全部候选 ID。
- 并发 Worker 的 request / operation / plan / step / tool-run / attempt
  候选 ID 被忽略。
- `in_progress` 与 `reentered` 返回数据库中已持久化的身份。
- stale takeover 和 abandoned reclaim 复用原 Reservation ID 与全部
  预分配 ID。
- 任何 ID 不一致都不能作为 Transaction A completion 输入。

## 10. 并发与连接安全

双连接测试由两个独立子进程执行：

```text
same Task lease / fencing
+ same stable logical identity
+ different proposed preallocated IDs
```

结果：

- 只有一个 Worker 返回 `acquired`。
- 另一个返回 `in_progress`。
- 数据库中只有一个 Reservation。
- 两个结果引用同一 Reservation ID。

SQLite immediate transaction 与 stable identity unique key 共同保证唯一
owner。

## 11. 测试结果

Reservation Foundation 专项：

```text
pnpm vitest run tests/storage/step6-3-4-4-schema.test.ts tests/storage/recovery-evidence-readback-reservation.test.ts tests/storage/schema.test.ts
```

结果：3 个测试文件，18 个测试通过。

覆盖：

- v8 -> v9 migration。
- Migration rollback。
- 历史 v8 Request 无 Reservation 兼容。
- stable identity / verification ID / 预分配 ID 唯一约束。
- 双连接并发 acquisition。
- same owner in_progress。
- stale fencing takeover。
- abandoned reclaim。
- takeover / abandon / complete CAS。
- 旧 owner token 迟到 abandon / complete 拒绝。
- completed 不可修改或删除。
- completed Transaction A ID 一致性。
- cross-task identity 拒绝。
- request intent digest 稳定性。
- 失败不产生部分 Reservation。
- preparing / abandoned / completed 三种状态的 Intent mismatch。
- `allowlistId`、decision version、expected version / ETag 的 Intent
  冲突。
- 原 Owner token 重入。
- 无 token 竞争者只得到 in_progress，且响应不含 token。
- takeover 后候选 ID 全部忽略。
- 历史 Request 意图一致时 Replay，不一致时 fail closed。

全量测试：

```text
pnpm test
```

结果：49 个测试文件，429 个测试通过。

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

## 12. 未实现与剩余边界

- 未实现 Request Service。
- 未实现 Host Binding、Allowlist、Source Resolver、buildArguments 或
  ToolRegistry 校验。
- 未实现 Transaction A ParentPreparation。
- 未实现 Transaction A Request / Operation / Attempt 业务。
- 未实现 External Read 或 dispatching UoW。
- 未实现 Transaction B。
- 未实现 controlled provenance 或 Verification integration。
- 未实现 Recovery Scanner / Classifier。
- 未实现 Reservation GC 或清理。
- 未新增 Migration v10。

当前 Migration v9 只提供 Reservation Foundation，不代表 Step 6.3.4.4
业务实现已完成。

## 13. 边界声明

本轮：

- 没有执行 Read-back、Recovery、Verifier、Provider、LLM 或 Write。
- 没有修改 Task.status。
- 没有修改 RecoveryReview final decision。
- 没有新增依赖。
- 没有修改已应用 Migration v4-v8。
- 没有进入 Step 6.3.4.4 业务实现。
- 没有进入 Step 6.3.5。

完成后停止，等待 Migration v9 Reservation Foundation 架构评审。
