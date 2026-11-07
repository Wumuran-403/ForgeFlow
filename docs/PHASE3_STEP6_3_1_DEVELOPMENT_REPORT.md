# Phase 3 Step 6.3.1 Development Report

> 状态：Evidence Contract + Schema / Compatibility 完成
>
> 范围：Recovery Evidence 数据契约、Digest、Migration v4、Repository 读取、
> TaskSnapshot 扩展和 Legacy Review 兼容
>
> 边界：没有实现 EvidenceVerifier、Read-back 执行、最终 Review Decision、
> 自动 Resume 或 Step 6.3.2

## 1. 修改与新增文件

Recovery Evidence：

- `src/recovery/recovery-evidence.ts`
- `src/recovery/index.ts`

Storage 类型、Migration 和 Repository：

- `src/storage/types.ts`
- `src/storage/migrations/004-phase3-step6-3-1.ts`
- `src/storage/migrations/index.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/recovery-review-repository.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `src/storage/recovery-legacy-attestation-repository.ts`
- `src/storage/recovery-review-operation-repository.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/index.ts`

Plan purpose 查询隔离：

- `src/storage/execution-unit-of-work.ts`
- `src/storage/execution-state-machine.ts`
- `src/storage/task-lease-manager.ts`
- `src/recovery/recovery-manager.ts`

测试：

- `tests/recovery/recovery-evidence.test.ts`
- `tests/storage/step6-3-1-schema.test.ts`
- `tests/storage/step6-3-1-repositories.test.ts`
- `tests/storage/schema.test.ts`
- `tests/storage/step3-schema.test.ts`
- `tests/recovery/recovery-classifier.test.ts`

文档：

- `docs/PHASE3_STEP6_3_1_DEVELOPMENT_REPORT.md`

本步骤没有新增依赖，没有修改锁文件，没有修改 Phase 1 / Phase 2
非持久化执行路径。

## 2. Evidence Schema 与 Digest 协议

### 2.1 Source-specific Evidence

`RecoveryEvidenceEnvelopeSchema` 使用 discriminated union：

- `manual_review`
  - `actorId` 必填。
  - `verifierId`、`verificationId` 必须为 null。
- `system_verification`
  - `actorId` 必须为 null。
  - `verifierId`、`verificationId` 必填。

共同约束：

- Schema version 固定为 `forgeflow.recovery-evidence.v1`。
- `sourceObservedAt`、`submittedAt` 使用 UTC ISO-8601 字符串。
- `verifiedAt` 在尚未完成可信核验时为 null。
- `evidenceRef`、Task ID、ToolRun ID、Tool 名称和版本不得为空。
- 三种 Hash 字段必须是 `sha256:<64 lowercase hex>`。
- `external_reference` 必须提供 `resourceRef` 和 `resourceVersion`。
- payload type 必须与 digest protocol 匹配。

该 Schema 只定义可信调用方应提交的数据。`actorId`、`verifierId` 和
`verificationId` 的宿主身份注入、认证与 Verifier 生命周期尚未在本步骤实现。

### 2.2 Payload Digest

实现以下纯函数：

- `computeRawPayloadDigest`：SHA-256 原始字节。
- `computeJsonPayloadDigest`：现有 JCS 实现 + SHA-256。
- `computeReadbackResultPayloadDigest`：固定 Read-back Result Schema +
  JCS + SHA-256。
- `computeExternalReferencePayloadDigest`：只对受控 Adapter
  实际取得的 bytes/JSON 计算，不对 URL 字符串计算。

`external_reference` 的 `resourceVersion` 仅作为来源版本元数据，不能替代
payload content digest。

### 2.3 Envelope Digest

Envelope Digest 输入固定包含：

```text
schemaVersion
evidenceRef
sourceType
outcome
sourceObservedAt
resourceRef
resourceVersion
taskId
toolRunId
toolName
toolVersion
inputSchemaHash
canonicalInputHash
idempotencyKey
actorId
verifierId
verificationId
payloadType
payloadDigestProtocol
payloadDigest
```

Envelope Digest 不包含：

- `envelopeDigest` 自身。
- `redactedSummary`。
- `submittedAt`。
- `verifiedAt`。

计算复用 `src/shared/canonical-json.ts`，没有自行实现未经验证的 JCS
算法。测试覆盖对象键顺序、数组顺序、字符串和数字边界、`-0`、NaN、
Infinity、BigInt、Date 拒绝，以及显示字段不改变 Digest。

## 3. Migration v4

新增：

```text
version: 4
name: phase3_step6_3_1_recovery_evidence_contract
```

### 3.1 execution_plans

新增：

```text
purpose TEXT NOT NULL DEFAULT 'agent'
CHECK purpose IN ('agent', 'recovery_evidence')
```

既有 Plan 全部自动保留 `agent`。

### 3.2 recovery_reviews

新增：

- `review_protocol_version`，默认 0，非空。
- `decision_version`，默认 0，非空。
- `evidence_payload_digest`
- `evidence_payload_type`
- `evidence_digest_protocol`
- `evidence_envelope_digest`
- `actor_id`
- `verifier_id`
- `verification_id`
- `source_observed_at`
- `submitted_at`
- `verified_at`

Digest、payload type 和 digest protocol 有 SQLite CHECK。历史 Review 不生成
Digest，不自动升级为 protocol v1。

### 3.3 recovery_evidence_reads

创建字段：

- `id`
- `task_id`
- `review_id`
- `tool_run_id`
- `evidence_envelope_digest`
- `created_at`

约束：

- `UNIQUE(review_id, tool_run_id)`。
- `(task_id, review_id)` 指向 `recovery_reviews(task_id, id)`。
- `(task_id, tool_run_id)` 指向 `tool_runs(task_id, id)`。
- Trigger 验证 Review 为 active protocol v1。
- Trigger 验证 ToolRun 为同 Task、Read、succeeded。
- Trigger 验证 ToolRun 所属 Plan 的 purpose 为 `recovery_evidence`。
- Trigger 验证对应 Tool Message 恰好一条且 `toolCallId` 匹配。
- Evidence Read 审计行 append-only。

本步骤只建立结构和插入验证，不创建真实 Evidence Read ToolRun。

### 3.4 recovery_legacy_attestations

创建完整 Legacy Attestation 字段，包含：

- Original Review 与 attestation version。
- request key 与 evidence envelope digest。
- source type、actor/verifier identity。
- source/submitted/verified timestamps。
- `confirms_original`、`contradicts_original`、`inconclusive` 结果。

约束：

- `UNIQUE(original_review_id, attestation_version)`。
- `UNIQUE(request_key)`。
- `(task_id, original_review_id)` 同 Task 复合外键。
- source-specific identity CHECK。
- 只能关联 protocol v0 Review。
- Append-only Trigger。

没有实现 Attestation 提交服务、冲突锁定服务或历史 Review 自动重新核验。

### 3.5 recovery_review_operations

创建字段：

- `id`
- `task_id`
- `review_id`
- `request_key`
- `operation`
- `expected_decision_version`
- `resulting_decision_version`
- `status`
- `evidence_envelope_digest`
- `result_plan_id`
- `result_tool_run_id`
- `applied_event_id`
- `created_at`

约束：

- Operation 枚举包含六种批准操作，其中包括 `request_readback`。
- `UNIQUE(request_key)`。
- `UNIQUE(review_id, resulting_decision_version)`。
- `UNIQUE(task_id, applied_event_id)`。
- resulting version 必须等于 expected + 1。
- `request_readback` 必须同时提供 result Plan 和 ToolRun。
- 非 `request_readback` 不得填写 result Plan/ToolRun。
- Review、Plan、ToolRun、Event 全部使用同 Task 复合外键。
- `request_readback` Trigger 验证 result Plan purpose 为
  `recovery_evidence`，且 result ToolRun 属于该 Plan 的 Read Step。
- Operation 审计行 append-only。

设计文档没有定义 `status` 的值集合，因此本步骤只要求非空文本。具体
applied/conflict 等生命周期值留给 Step 6.3.2 的 Decision Core。

## 4. 复合外键和唯一索引

Migration 实际依赖以下父键：

```text
recovery_reviews(task_id, id)   UNIQUE
tool_runs(task_id, id)          UNIQUE
execution_plans(task_id, id)    UNIQUE
events(task_id, id)             本步骤新增 UNIQUE INDEX
```

新增：

```sql
CREATE UNIQUE INDEX ux_events_task_id
ON events(task_id, id);
```

`events(id)` 原有的单列主键不会被假定为满足 SQLite 复合外键父键要求。

Migration 测试验证：

- clean database 可创建全部新结构。
- 从 Step 6.2 / Migration v3 数据库升级成功。
- 新表复合外键声明有效。
- 跨 Task 的 Evidence Read、Review Operation 和 Legacy Attestation
  插入被拒绝。
- `foreign_keys=ON`。
- v4 中途失败时整个 Migration 回滚，`schema_migrations` 仍停在 v3。

## 5. Legacy Review 兼容

从 v3 升级的 Review：

```text
review_protocol_version = 0
decision_version = 0
evidence_payload_digest = NULL
evidence_envelope_digest = NULL
actor_id = NULL
verifier_id = NULL
verification_id = NULL
```

原有以下字段保持不变：

- Review status。
- note。
- source type。
- evidence ref。
- created/updated/decided timestamps。
- 原始 Events。

旧 `RecoveryReviewRepository.decide()` 和
`ExecutionUnitOfWork.decideRecoveryReview()` 现在只能更新 protocol v0
Review。Protocol v1 Review 必须等待 Step 6.3.2 的 Lease-owned 唯一入口。

## 6. Repository 与 TaskSnapshot

### 6.1 ExecutionPlanRepository

新增：

- purpose 映射和写入。
- `listByTaskPurpose`.
- `listAgentByTask`.
- `listRecoveryEvidenceByTask`.
- `getLatestByPurpose`.

所有用于 Checkpoint 或普通 Recovery 的最长 Plan 查询都显式过滤
`purpose='agent'`：

- ExecutionStateMachine。
- ExecutionUnitOfWork。
- TaskLeaseManager。
- RecoveryManager 的最早未完成业务 PlanStep 选择。

`PersistentExecutionBridge` 在为新 Plan 分配全局版本时仍读取全部
`execution_plans`，因为现有 Schema 对 `(task_id, version)` 使用全局唯一约束。
这与 Recovery Evidence Plan 使用全局 MAX(version)+1 的设计一致。

### 6.2 Recovery Repository

新增：

- `RecoveryEvidenceReadRepository`
  - append/read Task 与 Review 维度。
- `RecoveryLegacyAttestationRepository`
  - append/read Task、Review、request key 维度。
- `RecoveryReviewOperationRepository`
  - append/read Task、Review、request key 维度。

所有写方法继续要求有效 `StorageWritePermit`。没有新增绕过 UoW 的 Review
Decision API。

### 6.3 TaskSnapshot

TaskSnapshot 在同一个 SQLite read transaction 中增加：

- `recoveryEvidenceReads`
- `recoveryLegacyAttestations`
- `recoveryReviewOperations`

`executionPlans` 保持为带 purpose 的完整集合，并新增：

- `agentExecutionPlans`
- `recoveryEvidencePlans`

分组由同一批已读取 Plan 派生，不执行独立 Repository 拼接。测试验证整个
Snapshot 只开启一个 read transaction，并正确读取新 Repository 数据。

## 7. 测试结果

新增测试：

- Evidence contract 和 Digest：9 项。
- Migration/Schema/历史兼容：6 项。
- Repository/TaskSnapshot/purpose 隔离：2 项。

总计新增 17 项。

改动前基线：

- 32 个测试文件。
- 262 项测试通过。

改动后：

- `pnpm test`：35 个测试文件、279 项测试全部通过。
- Phase 1 / Phase 2 / Phase 3 Step 1-6.2 原有测试全部保持通过。

关键覆盖：

- manual/system source-specific Schema。
- Envelope Digest 稳定性和字段排除。
- 不支持 Canonical JSON 类型拒绝。
- clean v4 和 v3 -> v4 升级。
- Legacy Review 状态及原始字段保留。
- 不伪造 v0 Digest。
- 复合外键和跨 Task 拒绝。
- Evidence Read Tool Message 绑定。
- Legacy Attestation append-only。
- Review Operation append-only。
- Recovery Plan purpose 读取隔离。
- protocol v1 Review 不能通过旧决策方法更新。
- 新数据在同一 TaskSnapshot read transaction 中读取。

## 8. 命令验证

实际执行：

```powershell
pnpm test
pnpm typecheck
git diff --check
```

结果：

- `pnpm test`：通过，35/35 文件、279/279 测试。
- `pnpm typecheck`：通过，无 TypeScript 错误。
- `git diff --check`：退出码 0，无空白错误。
  Git 输出若干既有 LF/CRLF 提示，不是 diff whitespace error。

## 9. 尚未完成与阶段边界

本步骤没有实现：

- EvidenceVerifier 外部调用。
- 外部 Evidence Adapter 和 Evidence Store。
- Evidence 提交 API。
- Read-back Plan/ToolRun 创建。
- Read-back Crash Recovery。
- Lease-owned Recovery Review Decision UoW。
- `confirmed_succeeded` / `confirmed_not_executed` 新决策入口。
- Legacy conflict 自动锁定或解决服务。
- RecoveryManager 新决策编排。
- 自动 Resume、Provider 调用或 Write Recovery。
- Step 6.3.2。

宿主身份认证、Verifier trust、Evidence retention 和不可访问证据的运营策略
仍需后续步骤实现。Digest 只证明内容完整性，不证明来源真实性。

本次仅完成 Phase 3 Step 6.3.1。没有开始 Step 6.3.2，没有执行任何 Write
Recovery，没有调用 Provider，也没有运行 Evidence Read-back。
