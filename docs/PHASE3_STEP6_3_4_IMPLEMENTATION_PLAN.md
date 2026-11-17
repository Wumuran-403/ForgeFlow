# Phase 3 Step 6.3.4 Implementation Plan

> 状态：设计阶段，等待架构评审通过
>
> 修订：Architecture Review Revision 1 / Revision 2 / Revision 3 /
> Final Consistency Check 已纳入
>
> 范围：Restricted Evidence Verifier + Recovery-only Read-back
>
> 边界：不实现最终 RecoveryReview Decision、Write Recovery、普通 Agent Resume、
> Provider 调用或 Step 6.3.5
>
> 本文档只包含设计，没有修改生产代码、测试或数据库 Schema，没有执行
> Recovery、Verifier、Read-back、Write 或 Provider。

## 1. 当前源码架构分析

### 1.1 已有能力

Step 6.3.3.1 已提供：

- Immutable `recovery_evidence_submissions` Manifest。
- 完整 `recovery.evidence.submitted` Event 审计。
- `recovery_review_operations` 幂等 Operation。
- Content-addressed `FileEvidencePayloadStore`。
- `TaskSnapshot.recoveryEvidenceSubmissions`。
- `recovery_evidence_reads` 预留表。
- `execution_plans.purpose = recovery_evidence`。

关键接口：

- `RecoveryManager.submitRecoveryEvidence`.
- `RecoveryManager.markRecoveryReviewUnresolved`.
- `ExecutionUnitOfWork.submitOwnedRecoveryEvidence`.
- `TaskLeaseManager`.
- `LeaseHeartbeat` / `ExecutionAuthority`.
- `TaskSnapshotReader`.
- `RecoveryReviewOperationRepository`.
- `RecoveryEvidenceSubmissionRepository`.
- `RecoveryEvidenceReadRepository`.

### 1.2 现有 Read Recovery 边界

已有 `RecoveryManager.recoverReadRuns()`：

- 只处理 `agentExecutionPlans` 中的最早未完成业务 PlanStep。
- 适用于普通 Agent Read。
- 可将 queued Task 转 running。
- 使用 `PersistentExecutionBridge.beforeExecute()`。
- `beforeExecute()` 调用 `beginOwnedToolRun()`。
- `beginOwnedToolRun()` 当前强制 Task.status = running。

这与 Step 6.3.4 冲突：

```text
Recovery Review 仍为 pending/unresolved
Task 仍为 waiting_review
Recovery-only Read 必须在该状态下执行
绝对不能自动 Resume Task
```

因此不能直接复用 `beginOwnedToolRun()` 或完整
`PersistentExecutionBridge` 的普通路径。

### 1.3 现有 Classifier 限制

`RecoveryClassifier` 当前遍历全部 PlanStep / ToolRun：

- 不区分 `agent` 与 `recovery_evidence` Plan。
- Recovery Evidence Plan 的 Read 会成为普通 `read_interrupted`。
- Recovery Gate 无 `recovery_read_interrupted` 分类。
- 无法单独处理 recovery-only read 的崩溃恢复。

6.3.4 必须增加 purpose-aware 查找和新分类，同时保持普通
`recoverReadRuns()` 不接管 `recovery_evidence` Plan。

### 1.4 现有 Schema 限制

`recovery_evidence_reads` 已具备：

- Review / ToolRun 同 Task 复合外键。
- `recovery_evidence` Plan purpose 校验。
- Read / succeeded ToolRun 校验。
- Tool Message 唯一性校验。
- append-only Trigger。

但缺少：

- Verifier 身份和规则版本持久化。
- Integrity / Authenticity / Verification 分层结果。
- Availability 多次检查历史。
- Read-back Request 与 Verification Result 的明确结果实体。

### 1.5 设计前置阻塞项

编码前必须先确认：

1. 新增 Migration v8。
2. 新增 Recovery Evidence Read 专用 UoW。
3. 新增独立 Recovery-only Read Executor。
4. 新增 Host-only Verifier Registry。
5. 新增 Read Tool allowlist。
6. `recovery_evidence` Plan 不进入 Agent latest 查询。
7. Task、PlanStep、ToolRun、Review 的“不自动推进”不变量。

### 1.6 现有 Operation 字段事实

实际读取：

- `src/storage/recovery-review-operation-repository.ts`
- `src/storage/migrations/005-phase3-step6-3-2.ts`
- `src/storage/migrations/006-phase3-step6-3-2-1.ts`
- `src/storage/types.ts`

现有 `recovery_review_operations` 只有：

```text
id
task_id
review_id
request_key
operation
expected_decision_version
resulting_decision_version
status
actor_id
operation_payload_digest
evidence_envelope_digest
result_plan_id
result_tool_run_id
applied_event_id
created_at
```

它没有 `execution_plan_id`、`plan_step_id` 或独立的
`read_tool_run_id` 字段。`result_plan_id` 是 recovery evidence Plan，
`result_tool_run_id` 是 Read ToolRun；Migration v5 已要求两者存在并指向
同一 Task 的 recovery evidence read，Migration v6 已要求
`request_readback` 的 status 为 `accepted`。

因此本设计选择方案 A：不扩展 Operation 表，Readback Request 的完整
PlanStep binding 通过 `Operation.applied_event_id` 指向的
`recovery.readback_requested` Event payload 校验。

ToolRegistry 实际已有 `validateInput()`、`executeValidated()` 和注册版本/
inputSchema metadata，但当前没有可直接读取的 schemaHash 字段。Step 6.3.4.1
必须为 Host Allowlist / ToolRegistry 增加受控 schema hash 投影，并在
Transaction A/Attempt dispatch 前与 Request 持久化值比较；不能从用户输入
或模型输出临时计算一个未注册的 hash。

## 2. 模块与调用链

### 2.1 新增模块

Recovery：

```text
RecoveryVerifierRegistry
RecoveryEvidenceVerificationService
RecoveryReadbackToolRegistry / Allowlist
RecoveryEvidenceReadExecutor
```

Storage：

```text
RecoveryEvidenceVerificationCheckRepository
RecoveryEvidenceVerificationRepository
RecoveryEvidenceReadbackRepository（查询/创建辅助）
```

Persistence：

```text
RecoveryEvidenceExecutionBridge
```

Manager：

```text
RecoveryManager.verifyRecoveryEvidence(...)
RecoveryManager.requestRecoveryReadback(...)
RecoveryManager.recoverEvidenceReadRuns(...)
RecoveryManager.recoverPendingEvidenceVerifications(...)
```

### 2.2 Stored Evidence Verification

```text
RecoveryManager.verifyRecoveryEvidence
  -> Claim Lease
  -> Heartbeat / ExecutionAuthority
  -> Load TaskSnapshot
  -> Resolve immutable Evidence Submission
  -> Host Verifier Registry lookup
  -> Transaction V0: persist Verification Check intent
       verificationCheckId
       requestKey
       evidence/readback binding
       verifier / allowlist configuration digest
  -> Read Payload Store / Adapter outside SQLite tx
  -> Recompute digest / run host verifier
  -> UoW append Verification + Availability Event
       + optional Verification Event + Checkpoint
  -> stop Heartbeat
  -> Release Lease
```

### 2.3 Recovery-only Read-back

```text
RecoveryManager.requestRecoveryReadback
  -> Claim Lease
  -> Heartbeat / ExecutionAuthority
  -> Load TaskSnapshot
  -> Validate submission / verifier / allowlist
  -> Transaction A: Read Intent
       preallocated stable verificationCheckId
       request_readback Operation (accepted)
       recovery_evidence Plan
       PlanStep
       ToolRun Intent (queued)
       Readback Request (full binding + expected identity)
       Read Attempt #1 (prepared)
       Event
       Checkpoint
  -> Dispatch Transaction: Lease-owned
       Read Attempt prepared -> dispatching
       Event
  -> External Execution: allowlisted Read outside SQLite tx
       canonicalize output
       store result in EvidencePayloadStore
       compute result digest
  -> Transaction B: Read Result
       ToolRun Result
       Tool Message
       PlanStep Result
       Evidence Read binding + evidenceSubmissionId
       + verificationCheckId
       + observedAt/resourceVersion
       + result digest/storeRef/storageMode
       Verification Check intent (actual result digest)
       Read Event
       Checkpoint
  -> External Execution: Verifier reads persisted EvidenceRead/Payload
  -> Transaction C: Verification Result
       Verification record
       Availability Event
       Verification Event
       Checkpoint
  -> stop Heartbeat
  -> Release Lease
```

Read Result 一旦提交，Verification 失败或缺失只能触发 Verifier 重跑，不能
重新执行已成功的 Read ToolRun。

Read-back 路径的 Verification Check intent 与 EvidenceRead 必须由同一个
Transaction B 原子提交。Transaction B 成功后不存在“EvidenceRead 已提交但
Check intent 尚未创建”的恢复窗口；Transaction B 失败则两者同时回滚。
Stored Evidence Verification 没有 Read Result 阶段，继续使用 Transaction V0。

## 3. Verifier 注册与权限模型

### 3.1 Host-only Verifier Registry

Verifier 只能由宿主启动代码注册：

```text
RecoveryVerifierDefinition
  id
  version
  description
  allowedPayloadTypes
  allowedSourceTypes
  readbackRequired
  allowlistId?
  verify(input, context)
```

禁止：

- 模型生成 verifier 名。
- HTTP 输入自由选择 verifier。
- 未注册 verifier fallback。
- Verifier 返回 final review status。

### 3.2 Verifier Context

Verifier 只能接收：

- Immutable Evidence Manifest。
- 已重新读取并通过完整性检查的 Payload bytes/structured result。
- 受控 Read-back ToolRun / Tool Message。
- Host-generated verification ID / timestamps。
- Host-generated verificationCheckId for one explicit check invocation。
- Task / Review / ToolRun 的安全标识。

不得接收：

- Provider 自然语言结论作为成功证据。
- 任意工具名或任意工具参数。
- 未经验证的外部 URL 内容。

### 3.3 Verifier Result

建议有限结果：

```text
passed
failed
inconclusive
```

另带结构化 reason code 和 redacted summary。

`unavailable` 属于 Availability，不是 Verifier Result。

Verifier Result 不是 RecoveryReview final decision。

### 3.3.1 Verification Check Identity

`verificationCheckId` 只能由 Host API / trusted caller 生成：

- Check intent（含 requestKey 和完整配置绑定）必须在任何外部检查前提交。
- 最终 Verification 已存在时，同 Check ID exact replay 返回原 Verification。
- 最终 Verification 尚不存在时，同 Check ID 进入同一 Check intent 的恢复，
  不得创建第二条 Check intent。
- 新 Check ID 表示宿主主动发起一次新的检查。
- 每个 Check ID 最多一行 Verification。
- 新 Check ID 必须产生独立 Availability Event。
- Verifier 实际执行时才产生 Verification Event。
- 进程失败重试保留原 Check ID，不能自动生成新检查。
- 模型、普通 HTTP body 或客户端布尔值不能决定 Check ID。

### 3.4 Read Tool Allowlist

新增宿主配置：

```text
RecoveryReadbackToolDefinition
  name
  version
  schemaHash
  allowlistId
  allowlistVersion
  mode = read
  retrySafety
  consistencyMode
  inputSchema
  timeoutMs
  buildArguments(manifest, requestContext)
  execute(input, context)
```

`retrySafety`：

```text
immutable
version_conditional
mutable_current_state (reserved, not registrable in 6.3.4)
```

`consistencyMode`：

```text
immutable_version
etag_or_resource_version
current_state_only (reserved, not registrable in 6.3.4)
```

约束：

- mode 必须为 read。
- 必须由 ToolRegistry 注册且 Hash/Version 匹配。
- 只允许 allowlist 内工具。
- 参数只能由 Host Allowlist 的 buildArguments 生成。
- Verifier 不得生成工具名、参数或选择任意 Read 工具。
- 模型不能提供 tool name 或 parameters。
- `version_conditional` Request 必须在 Transaction A 持久化
  `expectedResourceVersion` 和/或 `expectedEtag`；二者至少一个非空。
- `buildArguments(manifest, requestContext)` 必须使用 Request 中持久化的
  expected resource version / ETag，不能从当前页面状态动态猜测。
- Read 工具返回的 actual resource version / ETag 必须来自 Host Adapter
  的结构化 metadata，并在 Transaction B 前由 Host 校验。
- Read-only 不等于重复读取安全。
- Step 6.3.4 Registry 拒绝注册 `mutable_current_state` /
  `current_state_only`；后续独立设计 supersede/observation_group 生命周期后再开放。
- 每次成功 Read 记录 `observedAt`、可选 resourceVersion/ETag、
  result digest 和 payloadStoreRef。
- 不得提供任意 URL Fetch 作为通用 Read-back。

## 4. Recovery-only Read-back 执行流程

### 4.1 Plan 创建

使用：

```text
execution_plans.purpose = recovery_evidence
PlanStep.kind = read_batch
```

版本：

```text
MAX(execution_plans.version) + 1
```

`source_model_call_id`：

```text
Original Unknown Write ToolRun
  -> PlanStep
  -> original ExecutionPlan.source_model_call_id
```

必须同 Task 且 ModelCall 状态为 completed。

### 4.2 ToolRun Intent

ToolRun：

- id 新生成。
- call_id 新生成。
- originalIndex 在 Recovery Evidence Plan 内独立。
- toolName/toolVersion 来自 allowlist。
- mode=read。
- input 只来自 Host Allowlist `buildArguments(manifest, requestContext)`。
- `requestContext` 包含 Transaction A 已持久化的
  expectedResourceVersion / expectedEtag。
- 使用现有 schema/input/idempotency hash。
- status=queued。

### 4.3 Execution

执行专用 `RecoveryEvidenceReadExecutor`：

- 不复用普通 TaskScheduler。
- 不调用 Provider。
- 不调用 AgentRunner。
- 使用 Task Lease / Heartbeat / ExecutionAuthority。
- 执行顺序固定为：

```text
Host Allowlist.buildArguments(manifest, requestContext)
  -> ToolRegistry.validateInput()
  -> compare registered tool version / schema hash with Request
  -> assert Lease / fencing / local ExecutionAuthority
  -> Lease-owned Attempt dispatching transaction
  -> synchronous local ExecutionAuthority check
  -> ToolRegistry.executeValidated()
```

- `buildArguments()` 只产生 candidate input，不能直接调用工具。
- 工具名、version、schema hash、Zod input 必须经 ToolRegistry 校验。
- `executeValidated()` 只能接收同一轮 `validateInput()` 返回的受控对象；
  不得重新拼装 input 或调用未校验的底层函数。
- dispatching transaction 提交后不得插入新的 await；同步检查本地
  ExecutionAuthority 后立即进入 `executeValidated()`。
- 外部 Read 前必须完成专用 Intent Commit。
- 外部 Read 输出先规范化并写入 EvidencePayloadStore，再提交 Read Result。
- 外部 Read 成功后先以 Transaction B 提交 ToolRun Result、Tool Message、
  PlanStep Result、Evidence Read（含 observedAt/resourceVersion、
  result digest/storeRef、verificationCheckId）、对应 Verification Check
  intent、Read Event 和 Checkpoint。Check intent 的 expectedPayloadDigest
  必须来自 Transaction B 实际持久化的 result payload digest。
- Host Verifier 在 Transaction B 提交后读取持久化 Evidence，在 SQLite
  事务外执行 Verifier，最后以 Transaction C 提交 Verification、
  Availability/Verification Event 和 Checkpoint。
- Read Result 与 Verification 不属于同一事务。
- Transaction B 的 Check intent + EvidenceRead 原子性由专用 UoW 保证；
  `recovery_evidence_reads.verification_check_id` 对新的 controlled runtime
  read 非空并指向 Check intent，缺少 Check 的 B 状态不可提交。

### 4.4 专用 UoW

新增：

```text
createOwnedRecoveryReadbackIntent
beginOwnedRecoveryEvidenceRead
completeOwnedRecoveryEvidenceRead   // EvidenceRead + Check intent 原子提交
failOwnedRecoveryEvidenceRead
createOwnedRecoveryEvidenceVerificationCheck // Stored Evidence / V0 only
recordOwnedRecoveryEvidenceVerification
```

不得使用 `beginOwnedToolRun()` 的 Task running 约束。

允许 Task：

```text
waiting_review
```

不得改变 Task status。

### 4.5 RetrySafety / Attempt 语义

| retrySafety | 崩溃后自动重试 | 一致性条件 | 结果归属 |
| --- | --- | --- | --- |
| immutable | 允许 | 读取固定不可变资源 | 同一逻辑观察，新 Attempt |
| version_conditional | 有条件允许 | 必须绑定原 resourceVersion/ETag，且结果确认版本一致 | 同一逻辑观察，新 Attempt |
| mutable_current_state | 本阶段拒绝注册 | 需要 supersede/observation group 生命周期 | 不进入 6.3.4 |

Attempt 生命周期：

```text
prepared
  -> blocked_by_intent | cancelled
  -> dispatching
       -> completed
       -> interrupted
       -> failed | timed_out | cancelled
```

规则：

- Transaction A 创建 Attempt=prepared，仅表示 Intent 已持久化，外部尚未授权启动。
- 外部 Read 前必须在 Lease-owned SQLite transaction 中将 Attempt 从
  prepared 转为 dispatching，并追加 Event。
- `prepared` 只表示 Intent 已提交；不得调用外部 Read，也不得把这段时间
  表述为外部调用已经开始。
- dispatching 崩溃时无法证明外部调用是否真正到达，必须保留不确定性。
- attemptNumber 在同一 Lease-owned SQLite transaction 内单调分配。
- 崩溃恢复保留 interrupted Attempt 行。
- immutable/version_conditional 可新增 Attempt，复用原 ToolRun/request。
- `version_conditional` 的每个 Attempt 都必须校验实际 resourceVersion/ETag
  与 Request 中持久化值一致。
- 版本不匹配的 Attempt 标记 `failed` 且 reasonCode 为
  `RESOURCE_VERSION_MISMATCH`；不得插入 EvidenceRead、Check intent 或把新版本
  当成原观察。
- 版本不匹配不得自动用新版本重试。宿主若要观察新版本，必须创建新的 Readback
  Request 和新 requestKey。
- 版本不匹配必须在进入 Transaction B 前被拒绝。失败 UoW 可按现有 Read
  failure 语义提交 failed ToolRun / Attempt / Tool Message；若该失败事务也
  无法提交，则保留 running Intent 交由 Recovery 处理。无论哪条失败路径，
  都不得产生 EvidenceRead 或 Verification Check。
- `mutable_current_state` / `current_state_only` Registry 注册直接失败，
  本步骤不产生旧 Request 生命周期。
- 最终 EvidenceRead 只关联一个成功 Attempt。
- 后续失败 Attempt 不覆盖先前成功 Attempt。
- ToolRun 仍是逻辑执行记录，Attempt 表达实际外部调用次数。
- 不承诺 exactly-once。

Attempt Event：

```text
recovery.evidence.read_attempt_prepared
recovery.evidence.read_attempt_dispatching
recovery.evidence.read_attempt_interrupted
recovery.evidence.read_attempt_completed
recovery.evidence.read_attempt_failed
recovery.evidence.read_attempt_timed_out
recovery.evidence.read_attempt_cancelled
recovery.evidence.read_attempt_blocked_by_intent
```

Event 至少包含 readAttemptId、attemptNumber、attemptStatus、fencingToken，
以及当前状态对应的 preparedAt、dispatchingAt、interruptedAt、completedAt
或 reasonCode。事件不得用后续状态时间填充尚未发生的时间字段。

## 5. 数据库 Schema / Migration 设计

### 5.1 Migration v8

Migration v8 不改 v1-v7，新增四类持久化结构：

```text
recovery_evidence_readback_requests
recovery_evidence_read_attempts
recovery_evidence_verification_checks
recovery_evidence_verifications
```

#### Recovery Evidence Readback Request

字段：

```text
id
task_id
review_id
evidence_submission_id
original_tool_run_id
request_key
operation_id
execution_plan_id
plan_step_id
read_tool_run_id
verifier_id
verifier_version
verifier_config_digest
allowlist_id
allowlist_version
read_tool_name
read_tool_version
read_tool_schema_hash
retry_safety
consistency_mode
expected_resource_version
expected_etag
verification_check_id
created_at
```

约束：

- `UNIQUE(request_key)`。
- `UNIQUE(operation_id)`。
- `UNIQUE(execution_plan_id)`。
- `UNIQUE(plan_step_id)`。
- `UNIQUE(read_tool_run_id)`。
- `UNIQUE(task_id, verification_check_id)`。
- `(task_id, evidence_submission_id)` 同 Task 复合外键。
- `(task_id, review_id)` 同 Task 复合外键。
- `(task_id, original_tool_run_id)` 同 Task 复合外键。
- `(task_id, operation_id)` 指向 `request_readback` Operation。
- `(task_id, execution_plan_id)` 指向 recovery_evidence Plan。
- `(task_id, plan_step_id)` 指向 read_batch PlanStep。
- `(task_id, read_tool_run_id)` 指向 read ToolRun。
- Trigger 校验 Manifest.tool_run_id = original_tool_run_id。
- Trigger 校验 Manifest.review_id = review_id。
- Trigger 校验 Original ToolRun 为 write，Plan purpose=agent。
- Trigger 校验 Read ToolRun/PlanStep/Plan purpose 与 Request 一致。
- Migration v8 Trigger 不得假设 Operation 存在
  `execution_plan_id` / `plan_step_id` / `read_tool_run_id` 列。
- Trigger 校验 Operation.operation = `request_readback` 且
  Operation.status = `accepted`。
- Trigger 校验 Operation.result_plan_id = Request.execution_plan_id。
- Trigger 校验 Operation.result_tool_run_id = Request.read_tool_run_id。
- Trigger 校验 Operation.applied_event_id 非空，且指向同 Task、
  `type = recovery.readback_requested` 的 Event。
- 该 Event payload 必须包含 operationId、requestKey、readbackRequestId、
  executionPlanId、planStepId、readToolRunId 和 verificationCheckId，并与
  Request 完全一致。
- `retry_safety = immutable` 时 expectedResourceVersion 和 expectedEtag
  必须为 NULL。
- `retry_safety = version_conditional` 时 expectedResourceVersion 与
  expectedEtag 至少一个非空。
- Request insert 时 verificationCheckId 不得已被 Stored Evidence V0 Check
  intent 占用；Check insert 时也不得占用另一个 Readback Request 已预分配的 ID。
- Request append-only，UPDATE / DELETE 拒绝。

Operation result IDs 的实际来源固定为：

```text
Request.operation_id
  -> recovery_review_operations.id
       result_plan_id       = Request.execution_plan_id
       result_tool_run_id   = Request.read_tool_run_id
       applied_event_id
         -> Event.payload.planStepId
         -> Event.payload.readbackRequestId
         -> Event.payload.verificationCheckId
```

这是方案 A。Migration v8 不新增 Operation 结果列，也不假设
`plan_step_id` 已存在于 Operation。

Transaction A 顺序：

```text
Recovery Evidence Plan
  -> PlanStep
  -> Read ToolRun Intent
  -> read.intent Event
  -> recovery.readback_requested Event
  -> request_readback Operation
  -> Readback Request
  -> Attempt #1 prepared Event
  -> Checkpoint
```

#### Recovery Evidence Read Attempt

字段：

```text
id
task_id
readback_request_id
read_tool_run_id
attempt_number
retry_safety
consistency_mode
attempt_status
prepared_at
dispatching_at
interrupted_at
completed_at
observed_at
resource_version
resource_etag
result_digest
result_payload_store_ref
reason_code
created_at
```

`attempt_status`：

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

约束：

- `UNIQUE(readback_request_id, read_tool_run_id, attempt_number)`。
- `(task_id, readback_request_id)` 同 Task 复合外键。
- `(task_id, read_tool_run_id)` 同 Task 复合外键。
- Transaction A 只创建 `prepared` Attempt，不执行外部调用。
- 外部 Read 前必须在 Lease-owned transaction 提交
  `prepared -> dispatching`。
- attemptNumber 必须在 Lease-owned SQLite transaction 内单调分配。
- Attempt 生命周期更新使用 CAS；每次状态变化同时追加 Event。
- Attempt 表是查询投影，append-only Event 是审计事实来源。
- `version_conditional` 的成功 Attempt 必须保存 Host 校验通过的 actual
  resource_version / resource_etag。Request 中每个非空 expected binding
  都必须有对应 non-null actual binding 且严格相等；不允许只匹配其中一个后
  忽略另一个。
- DELETE 拒绝。

#### Recovery Evidence Verification Check

`verificationCheckId` 必须在任何 Availability Adapter、Payload Store 读取或
Host Verifier 外部执行之前持久化。Read-back 路径由 Transaction B 创建，
Stored Evidence 路径由 Transaction V0 创建。独立 Check 结构用于保证进程
崩溃后仍能使用原 Check ID 和原配置恢复，而不是重建一个新的检查。

字段：

```text
id
task_id
review_id
evidence_submission_id
original_tool_run_id
readback_request_id
evidence_read_id
verification_check_id
request_key
check_origin
verifier_id
verifier_version
verifier_config_digest
allowlist_id
allowlist_version
read_tool_name
read_tool_version
read_tool_schema_hash
expected_payload_digest
created_at
```

约束：

- `UNIQUE(request_key)`。
- `UNIQUE(task_id, verification_check_id)`。
- `UNIQUE(readback_request_id)` 对 readback_transaction_b 生效，保证一个
  Read-back Request 只有一个预分配 Check ID。
- `check_origin` 限定为 `readback_transaction_b` 或
  `stored_evidence_v0`。
- `(task_id, evidence_submission_id)` 指向 Manifest。
- `(task_id, review_id)`、`(task_id, original_tool_run_id)` 同 Task。
- `readback_transaction_b` 的 readback_request_id 必填，EvidenceRead 在同一个
  Transaction B 中通过 `recovery_evidence_reads.verification_check_id`
  反向绑定，因此 Check intent 的 evidence_read_id 保持 NULL，避免即时外键循环。
- `stored_evidence_v0` 的 readback_request_id / evidence_read_id 对
  Manifest-only verification 为 NULL；若检查已有受控 Read，可指向同一
  Evidence 的 Request / EvidenceRead。
- `readback_transaction_b` Check 必须与同一 Transaction B 的 EvidenceRead
  原子创建；该 EvidenceRead 保存相同的 verificationCheckId。
- `readback_transaction_b` Check 的 verificationCheckId 必须等于其
  Readback Request 预分配值。
- `stored_evidence_v0` Check 不得使用任何 Readback Request 已预分配的
  verificationCheckId。
- Transaction B 写入顺序为：Check intent（evidence_read_id NULL） ->
  EvidenceRead（verification_check_id 指向 Check）。这样避免即时外键循环，
  并由 EvidenceRead 侧非空 FK 保证两者不能只提交一半。
- `stored_evidence_v0` Check 不要求 EvidenceRead，但仍必须指向同一
  Manifest / Review / Original Write。
- Host Registry 重新解析 Verifier / Allowlist 后，identity、version、
  configDigest 和 read tool schema hash 必须与 Check intent 完全一致。
- `expected_payload_digest` 绑定本次检查准备验证的不可变 Payload。
  Read-back 路径必须使用 Transaction B 实际持久化的 result payload digest。
- Check intent append-only，UPDATE / DELETE Trigger 拒绝。
- 最终 Verification 行通过 `(task_id, verification_check_id)` 指向 Check
  intent；同一 Check intent 最多一条最终 Verification。
- Trigger 校验最终 Verification 的 requestKey、evidenceSubmissionId、
  reviewId、originalToolRunId、readbackRequestId 和 verifier/allowlist
  配置绑定与 Check intent 完全一致。
- 对 `readback_transaction_b`，Trigger 通过
  `EvidenceRead.verification_check_id` 校验 EvidenceRead 属于 Check intent，
  并校验最终 Verification.evidence_read_id 指向该 EvidenceRead；不要求
  Check intent.evidence_read_id 非空。
- 对 `stored_evidence_v0`，若 Check intent.evidence_read_id 非空，则最终
  Verification.evidence_read_id 必须与之一致。
- Check intent 已提交但最终 Verification 不存在时，状态投影为
  `recovery_verification_pending`，只能重跑 Availability / Verifier，
  不得重跑已完成 Read ToolRun。

Read-back 路径的 `verificationCheckId` 由 Host 在 Transaction A 创建 Request
时预分配；Transaction B 必须原样复用。Stored Evidence 路径由 Transaction V0
创建 Check intent 时分配。相同 Check ID 重放使用同一 Request / intent；
新 Check ID 必须创建新 Request 或独立 Check intent。进程重启、Heartbeat
接管或 Verifier 失败重试都不得自动生成新 Check ID。

#### Recovery Evidence Verification

字段：

```text
id
task_id
review_id
evidence_submission_id
original_tool_run_id
readback_request_id
evidence_read_id
read_attempt_id
verification_check_id
readback_result_provenance
verifier_id
verifier_version
verifier_config_digest
allowlist_id
allowlist_version
request_key
availability_status
integrity_status
authenticity_status
verification_status
expected_payload_digest
observed_payload_digest
reason_code
redacted_summary
availability_event_id
verification_event_id
created_at
```

`readback_result_provenance`：

```text
none
declared_payload
controlled_runtime_read
```

约束：

- `UNIQUE(request_key)`。
- `(task_id, verification_check_id)` 唯一并指向 Check intent。
- `availability_event_id` NOT NULL 且唯一。
- `verification_event_id` 可空且唯一。
- `(task_id, evidence_submission_id)`。
- `(task_id, review_id)`。
- `(task_id, original_tool_run_id)`。
- `(task_id, readback_request_id)` 可空。
- `(task_id, evidence_read_id)` 对 runtime readback 必填。
- `(task_id, read_attempt_id)` 可空。
- `(task_id, availability_event_id)`。
- `(task_id, verification_event_id)`。
- append-only UPDATE / DELETE Trigger。

`never_checked` 不是一次持久化检查结果，而是“没有任何 Verification/
Availability 记录”的默认投影状态。每次实际检查必须产生一行 Verification
记录和至少一条 Availability Event。

### 5.2 需要的父键

v8 先创建：

```sql
CREATE UNIQUE INDEX ux_recovery_evidence_submissions_task_id
ON recovery_evidence_submissions(task_id, id);

CREATE UNIQUE INDEX ux_recovery_evidence_reads_task_id
ON recovery_evidence_reads(task_id, id);

CREATE UNIQUE INDEX ux_recovery_evidence_reads_task_verification_check
ON recovery_evidence_reads(task_id, verification_check_id)
WHERE verification_check_id IS NOT NULL;

CREATE UNIQUE INDEX ux_recovery_evidence_readback_requests_task_id
ON recovery_evidence_readback_requests(task_id, id);

CREATE UNIQUE INDEX ux_recovery_evidence_read_attempts_task_id
ON recovery_evidence_read_attempts(task_id, id);

CREATE UNIQUE INDEX ux_recovery_evidence_verification_checks_task_check
ON recovery_evidence_verification_checks(task_id, verification_check_id);
```

Review、ToolRun、Event 父键已存在。

### 5.2.1 TaskSnapshot

`TaskSnapshot` 必须新增：

```text
recoveryEvidenceReadbackRequests
recoveryEvidenceReadAttempts
recoveryEvidenceReads
recoveryEvidenceVerificationChecks
recoveryEvidenceVerifications
```

其中 `recoveryEvidenceReads` 是现有字段的扩展，不是并行数据源。

`TaskSnapshotReader.load()` 必须在同一个 SQLite read transaction 内读取：

- Task / Lease / Events / Checkpoints。
- ExecutionPlans / PlanSteps / ToolRuns / Approvals。
- RecoveryReviews / Evidence Submissions / Review Operations。
- Readback Requests / Read Attempts / EvidenceReads / Verification Checks /
  Verifications。

Recovery Scanner 和 RecoveryManager 只能基于该一致 Snapshot 判断状态组合，
不得先读取 EvidenceRead、再在不同时间查询 Check intent 或 Operation。若调用方
已经处于 SQLite transaction 中，可复用同一 transaction；否则必须由
`TaskSnapshotReader` 建立只读事务。

### 5.3 Recovery Evidence Read

继续使用：

```text
recovery_evidence_reads
```

只在 Read 成功并产生唯一 Tool Message 后插入。

Migration v8 扩展该表：

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

新读入规则：

- `evidence_submission_id` 必须指向被核验的 Evidence Submission。
- `readback_request_id` 必须指向创建该 Read ToolRun 的 Request。
- `read_attempt_id` 必须指向最终成功 Attempt。
- `verification_check_id` 对新 controlled runtime read 必填，并指向同一
  Transaction B 原子创建的 Check intent。
- `result_payload_digest` 必须由实际 Read 输出重新计算。
- 可持久化 Read 输出先写入 EvidencePayloadStore。
- `result_payload_store_ref` 必须与 digest 对应。
- `observed_at` 由宿主生成。
- resourceVersion/ETag 仅适用于 versioned read。
- `version_conditional` 的 EvidenceRead.resourceVersion/resourceEtag 必须来自
  最终成功 Attempt，并与 Request expected binding 一一匹配。
- 历史行升级时新字段保持 NULL，不伪造结果。
- v8 Trigger 对新增 Evidence Read 行要求这些字段完整。
- `(task_id, evidence_submission_id)` 指向 Manifest。
- `UNIQUE(evidence_submission_id, tool_run_id)` 防止错误重复绑定。
- 对非空 verification_check_id 建立
  `UNIQUE(task_id, verification_check_id)` partial index，保证一个 Check
  intent 最多绑定一条 EvidenceRead。
- v8 Trigger 拒绝缺少 verification_check_id 的新 controlled runtime read；
  历史 v4-v7 行升级时该字段保持 NULL，不能伪造 Check。

`Verification` 可引用：

- Manifest only：raw_bytes / json。
- Evidence Read + ToolRun：readback_result。
- `external_reference`：暂时不允许 trusted verification。

### 5.4 Event

新增 Event：

```text
recovery.readback_requested
recovery.evidence.availability_checked
recovery.evidence.verification_completed
```

`recovery.readback_requested` payload 必须包含 operationId、requestKey、
readbackRequestId、executionPlanId、planStepId、readToolRunId 和
verificationCheckId；Operation 通过 applied_event_id 引用该 Event。

Payload 必须包含：

- evidenceSubmissionId
- verificationCheckId
- evidenceReadId?
- verifierId/version
- allowlistId?
- availabilityStatus
- integrityStatus
- authenticityStatus
- verificationStatus
- expected/observed digest
- reasonCode
- requestKey
- fencingToken

Event 不包含原始 Payload。

Availability Event 字段范围：

- verificationId
- verificationCheckId
- evidenceSubmissionId
- evidenceReadId?
- availabilityStatus
- integrityStatus
- checkedAt
- requestKey
- fencingToken

Verification Event 字段范围：

- verificationId
- verificationCheckId
- evidenceSubmissionId
- verifierId/version/configDigest
- allowlistId/version
- verificationStatus
- structured reasonCode / redactedSummary
- requestKey
- fencingToken

`availability_event_id` 必填；`verification_event_id` 仅在 Verifier 实际执行
时非空。没有运行 Verifier 时 `verification_status=not_run`。

每次 Check 使用一行 Verification 记录：

```text
availability_event_id  = 必填
verification_event_id  = Verifier 实际执行时可空字段
```

若 Availability 失败、Verifier 未执行：

- 仍提交 Verification 行。
- `verification_status = not_run`。
- `verification_event_id = NULL`。
- Availability Event 已持久化。

若 Verifier 执行：

- Verification 行必须同时关联 Availability Event 和 Verification Event。
- 两个 Event 都 append-only。
- 多次检查产生多行 Verification / 多组 Event，不覆盖旧记录。

### 5.5 Evidence / Original Write / Recovery Read 绑定

必须显式校验：

```text
EvidenceSubmission
  -> Original Unknown Write ToolRun
  -> Original PlanStep
  -> Original ExecutionPlan

RecoveryEvidenceRead
  -> New Read ToolRun
  -> Tool Message
  -> Recovery Evidence PlanStep
  -> Verification Check

Verification
  -> Verification Check
  -> EvidenceSubmission
  -> RecoveryEvidenceRead（如适用）
  -> ReadbackRequest（如适用）
  -> Read Attempt
```

已有源码能力：

- Manifest 保存 `task_id/tool_run_id/review_id`。
- `recovery_evidence_reads` 保存 review/toolRun/envelope digest。
- 复合外键保证 Review、Read ToolRun、Operation、Event 同 Task。

需要新增：

- `originalUnknownToolRunId` 明确写入 Verification / Readback request。
- Request 在 Transaction A 中持久化 Manifest、Original Write、Review、
  Operation、Plan、PlanStep、Read ToolRun、Verifier 配置和 Host Allowlist
  配置。
- UoW 校验它等于 Manifest 绑定的原始 ToolRun。
- Verifier context 只暴露 Original Unknown Write 的受控只读字段。
- Readback request 不能改绑 Review 的其他 ToolRun。

数据库约束：

- `(task_id, evidence_submission_id)`。
- `(task_id, original_tool_run_id)`。
- `(task_id, read_tool_run_id)`。
- `(task_id, review_id)`。
- Trigger 校验 EvidenceSubmission.tool_run_id =
  original_tool_run_id。
- Trigger 校验 RecoveryReview.tool_run_id = original_tool_run_id。
- Trigger 校验 Original ToolRun.mode = write 且 status = unknown。
- Trigger 校验 Original ToolRun 为 write，且其 PlanStep/ExecutionPlan
  purpose=agent。
- Trigger 校验 Original ExecutionPlan.source_model_call_id 同 Task 且该
  ModelCall 为 completed。
- Trigger 校验 RecoveryEvidenceRead.review_id = Verification.review_id。
- Trigger 校验 Manifest 与 RecoveryEvidenceRead 的 Envelope Digest 一致。
- Trigger 校验 EvidenceRead.readback_request_id = Verification request。
- Trigger 校验 EvidenceRead.verification_check_id =
  Verification.verification_check_id = Check intent.verification_check_id。
- Trigger 校验 Check intent.expected_payload_digest =
  EvidenceRead.result_payload_digest。
- Trigger 校验 controlled runtime read 具有 Request + Attempt + EvidenceRead。

测试：

- Original ToolRun 指向同 Task 其他 unknown write 时拒绝。
- Review 指向同 Task 另一 Unknown Write 时拒绝。
- Original ToolRun 的 Plan 为 recovery_evidence 时拒绝。
- Original Plan source ModelCall 非 completed 时拒绝。
- 跨 Task Manifest / Review / ReadRun 拒绝。
- 错误 Review 拒绝。
- Read ToolRun 与 Evidence Submission 的绑定可查询。

### 5.6 readback_result 语义

必须区分：

1. Step 6.3.3 用户提交的 `payloadType=readback_result`
   - provenance = `declared_payload`。
   - 没有受控 Request / Read ToolRun / Message / EvidenceRead 链。
   - 不得视为受控 Runtime Read-back。
2. Step 6.3.4 Runtime 产生的 Recovery Evidence Read
   - provenance = `controlled_runtime_read`。
   - 必须具有 Request、Attempt、ToolRun、Tool Message、PlanStep、
     EvidenceRead 的完整关联。
3. 非 Readback Payload
   - provenance = `none`。

Manifest 始终 immutable。用户不能通过提交
`payloadType=readback_result` 获得受控 Read-back 身份或可用性提升。

数据库约束：

- `controlled_runtime_read` 必须存在 readback_request_id、
  evidence_read_id、read_attempt_id。
- `declared_payload` 不得伪造 Request/EvidenceRead 关联。

测试：

- 用户声明 readback_result 不进入 controlled provenance。
- Runtime Read 完整链路可以验证。
- 缺少 Attempt/Message/EvidenceRead 时拒绝 controlled。

## 6. 状态机和 Event 设计

### 6.1 Task

Read-back 全程：

```text
waiting_review -> waiting_review
```

不得出现：

```text
waiting_review -> running
```

### 6.2 Recovery Evidence Plan

```text
active
  -> completed
  -> failed
```

PlanStep：

```text
queued -> running -> completed
queued -> failed
running -> interrupted
interrupted -> queued
```

### 6.3 ToolRun

Read：

```text
queued -> running -> succeeded
queued -> failed
running -> interrupted
interrupted -> queued
running -> failed/timed_out/cancelled
```

Read 不允许 `unknown`。

### 6.4 RecoveryReview

6.3.4 不改变：

```text
pending
unresolved
confirmed_succeeded
confirmed_not_executed
```

只追加 Verification 证据。

### 6.5 Availability / Trust 分层

Availability：

```text
never_checked
available
unavailable
expired
replaced
digest_mismatch
```

Integrity：

```text
not_checked
matched
mismatch
```

Authenticity：

```text
unverified
manual_attested
system_verified
```

Verification：

```text
not_run
passed
failed
inconclusive
```

Digest 匹配只能设置 Integrity=matched，不能单独设置 Authenticity 或 final Trust。

Authenticity 条件：

- `unverified`：默认状态。
- `manual_attested`：必须有宿主认证的独立人工背书依据；
  actorId 或普通 Evidence Submission 身份字段不足以设置。
- `system_verified`：必须通过宿主可信来源、签名、认证或 Trust Anchor；
  verifierId/verificationId 存在本身不足以设置。

没有上述机制时始终保持 `unverified`。

### 6.6 Recovery Gate 与 purpose isolation

新增分类：

```text
recovery_read_interrupted
recovery_verification_pending
```

规则：

- 阻止普通 Agent Resume。
- 由专用 Recovery Evidence Executor 接管。
- `recovery_verification_pending` 只允许重跑 Verifier，不允许重跑 Read。
- `recovery_verification_pending` 只能由已提交的 Verification Check intent
  且缺少最终 Verification 触发；不能把“任意 EvidenceRead 没有
  Verification”都当作 pending。
- 普通 `recoverReadRuns()` 不处理 `recovery_evidence` Plan。
- Recovery Evidence Executor 不处理 `agent` Plan。
- Recovery Scanner / Gate 必须按 Plan purpose 选择执行器。
- Agent latest Plan 查询只允许 purpose=agent。

## 7. Lease / Fencing / ExecutionAuthority 处理

### 7.1 所有权

RecoveryManager 独占：

- Claim。
- Heartbeat start / immediate check。
- Authority revocation。
- 最终 Release。

Verifier / Read Executor 不自行 Claim 或 Release。

实际源码核实：

- `TaskLeaseManager.claim` 只拒绝 completed/failed/cancelled，
  因此允许 `waiting_review`。
- `TaskLeaseManager.heartbeat` / `assertOwned` 只验证 lease token、
  fencing token 和 expiry，不要求 Task.running。
- `TaskLeaseManager.release` 不修改 Task.status。
- 普通 `beginOwnedToolRun()` 显式要求 Task.running，不能用于 Read-back。

需要新增：

- Recovery Evidence 专用 UoW，允许 waiting_review 下提交 Intent/Result。
- 普通 Agent UoW 的 running 约束保持不变。

### 7.2 异步边界

- SQLite 同步事务内不得 await 外部 Verifier / Read。
- 外部调用前必须完成 Intent / Request Operation。
- Result Commit 必须通过本地 authority + DB assertOwned/fencing。
- Heartbeat failure 先 revoke，再 Abort。
- 已启动 Promise 必须 settle 后才 Release。

### 7.3 失权

Heartbeat failure：

- 停止启动新 Provider / Tool / Verifier。
- 已启动 Read/Verifier 迟到结果不能提交。
- running Read 留给后续 Recovery。
- 不伪造 cancelled / failed。

### 7.4 Cancel / Pause 策略

已有源码能力：

- Task 可持久化 cancel_requested_at。
- Task 可持久化 pause_requested_at。
- Recovery Gate / Classifier 已把 cancel / pause 作为阻塞状态。

需要新增：

- `requestRecoveryReadback` / `recoverEvidenceReadRuns` / 自动恢复在存在
  cancel 或 pause intent 时一律拒绝启动新的外部 Read。
- Step 6.3.4 不提供客户端布尔参数或通用 host bypass。
- Review-only 取消例外留给 Step 6.3.5 明确设计，本步骤不实现。
- Read-back 全程不得将 Task 转为 running。
- 不得触发普通 Resume。
- 不得绕过 Step 6.3.5 Cancel Barrier。
- 每次外部 Attempt 启动前必须重新读取 Task intent；若 cancel/pause 已出现，
  Attempt 标记 `blocked_by_intent`，不得调用外部 Read。

数据库约束：

- 专用 Intent UoW 查询 Task intent 字段。
- 不提供清除 cancel_requested_at/pause_requested_at 的路径。

测试：

- cancel intent 下普通请求与自动恢复均拒绝。
- pause intent 下普通请求与自动恢复均拒绝。
- 拒绝后 Task / Review / PlanStep 不变。
- intent 字段保持不变。
- 不存在客户端 force/bypass 参数。
- 普通 RecoveryGate 行为保持。

## 8. Crash Recovery 设计

### 8.1 Request Read-back 前崩溃

- 没有 Plan/ToolRun Intent。
- 同 requestKey 可重新创建。

### 8.2 Intent 已提交但未执行

```text
Plan active
PlanStep queued
ToolRun queued
```

恢复入口：

```text
RecoveryManager.recoverEvidenceReadRuns
```

### 8.3 Read running 时进程崩溃

```text
running -> interrupted -> queued -> running
```

保留：

- ToolRun ID。
- Call ID。
- originalIndex。
- Tool version/hash。
- idempotency key。

### 8.4 Read 成功但 Result 未提交

当前持久状态仍为 running。

恢复时可安全重试 Read，但不得声称 exactly-once。Read-only allowlist 工具必须声明安全可重试。

### 8.5 Result 已提交但 Verification 未提交

- ToolRun 已 succeeded + Tool Message 已存在。
- 不得重跑 Read。
- Verifier 重新检查已持久结果。
- 补写 Verification Event / 表。

### 8.6 已验证后重复请求

- 同 verifier/version/rule 且仍有效：返回已有 Verification。
- 新 verifier version：允许新 Verification。
- 不重复创建相同 requestKey。

### 8.7 Crash Recovery 状态矩阵

| 崩溃点 | 持久状态 | 恢复动作 | 禁止动作 |
| --- | --- | --- | --- |
| Transaction A 前 | 无 Plan/ToolRun | 同 requestKey 创建 | 伪造 ToolRun |
| Transaction A 后 | Plan active / Step queued / Run queued | 执行 Read | 跳过 Intent |
| Read running / Attempt dispatching | Run running / Attempt dispatching | Attempt interrupted；Run interrupted -> queued -> running，并新增 Attempt | 直接 succeeded |
| Read ToolResult 已返回但 Transaction B 前 | Run running / Attempt dispatching | 保留 interrupted Attempt，按 retrySafety 新增 Attempt | 声称 exactly-once |
| Transaction B 提交前 | 无新 EvidenceRead / 无 Check intent | 按 Read Intent/Attempt 恢复；事务回滚不留下半成品 | 声称 Check 已存在 |
| Transaction B 后 | Run succeeded / Message / EvidenceRead / Check pending | 使用预分配原 Check ID 只重跑 Verifier | 重跑 Read 或生成新 Check ID |
| Stored Evidence V0 后、Verifier 启动前 | Check pending / 无 Read Result | 使用原 Check ID 重跑 Verifier | 伪造 EvidenceRead |
| Verification 外部执行后 Transaction C 前 | EvidenceRead 已有 / Check pending | 使用原 Check ID 重跑 Verifier 或补记 | 改 Run 状态 |
| Transaction C 后 | Verification 行 + Events | exact replay 返回 | 重复 Event |
| Availability 失败 | Verification row / no verification Event | 返回 unavailable 历史 | 标 trusted |

Read 失败和 Verification 失败必须分开表达：

- Read failed：ToolRun failed，无法形成有效 EvidenceRead。
- Verification failed：ToolRun 保持 succeeded，仅 Verification failed。

### 8.8 RetrySafety Crash Recovery

| retrySafety | Attempt dispatching 后崩溃 | 恢复策略 | 新身份 |
| --- | --- | --- | --- |
| immutable | 原 Attempt 未完成 | 原 Attempt interrupted，新增 Attempt | 同 Request / ToolRun，新 attemptNumber |
| version_conditional | 原 Attempt 未完成 | 原 Attempt interrupted；校验原 version/ETag 后新增 Attempt | 同 Request / ToolRun，新 attemptNumber |
| mutable_current_state | 不注册 | 6.3.4 Registry 直接拒绝 | 未来独立设计 Request supersede |

已形成成功 Runtime Read 且 Transaction B 已提交时，任何 retrySafety 都不得
再次执行 Read。Verification 失败只能新增 Verification/Attempt-free verifier
记录。

### 8.9 Pending Verification Recovery

新增入口：

```text
RecoveryManager.recoverPendingEvidenceVerifications(
  taskId,
  ownerId,
  verificationCheckId
)
```

流程：

```text
Claim Lease
  -> Heartbeat / ExecutionAuthority
  -> Load TaskSnapshot
  -> Find persisted Verification Check without final Verification
  -> Read persisted result payload from EvidencePayloadStore
  -> run Host Verifier outside SQLite tx
  -> Transaction C
  -> stop Heartbeat
  -> Release Lease
```

约束：

- Manifest-only Check 直接使用不可变 Manifest / Payload；controlled runtime
  read Check 必须对应已 succeeded 的 ToolRun 和已提交的 EvidenceRead。
- `verificationCheckId`、requestKey、Verifier / Allowlist 配置绑定来自
  Transaction B（Read-back）或 Transaction V0（Stored Evidence）已提交的
  Verification Check intent。
- Read-back 路径 Transaction B 必须同时提交 EvidenceRead 与 Check intent；
  B 后崩溃时 Snapshot 中两者必须同时可见。
- 不重新执行 Read ToolRun。
- 同 verificationCheckId replay 返回原 Verification。
- 新 Check ID 需要宿主显式发起，不由自动恢复随机生成。
- 不修改 ToolRun succeeded，不结束 RecoveryReview。
- Check / Commit 必须验证 Lease/fencing/authority。

Recovery Gate 分类：

```text
recovery_verification_pending
```

与 `recovery_read_interrupted` 区分：

- read_interrupted 需要恢复 Read Intent。
- verification_pending 只允许 Verifier 重跑。

## 9. 幂等和重复验证策略

### 9.1 request_readback Request Key

```text
sha256(JCS([
  "forgeflow.recovery-review-operation.v1",
  reviewId,
  evidenceSubmissionId,
  expectedDecisionVersion,
  "request_readback",
  operationPayloadDigest,
  verifierId,
  verificationCheckId,
  expectedResourceVersionOrNull,
  expectedEtagOrNull,
  actorId
]))
```

operation payload：

```text
evidenceSubmissionId
originalUnknownToolRunId
verifierId
verifierVersion
verifierConfigDigest
allowlistId
allowlistVersion
readToolName
readToolVersion
readToolSchemaHash
expectedResourceVersionOrNull
expectedEtagOrNull
verificationCheckId
expectedDecisionVersion
```

`request_readback` 的 payload digest 必须按以下输入重新计算，不能使用客户端
自报值：

```text
operationPayloadDigest = sha256(JCS([
  "forgeflow.recovery-review-operation-payload.v1",
  {
    evidenceSubmissionId,
    originalUnknownToolRunId,
    verifierId,
    verifierVersion,
    verifierConfigDigest,
    allowlistId,
    allowlistVersion,
    readToolName,
    readToolVersion,
    readToolSchemaHash,
    expectedResourceVersion,
    expectedEtag,
    verificationCheckId,
    expectedDecisionVersion
  }
]))
```

因此同一 Review / Original Write 下 Evidence A/B/C 必然产生三个不同的
requestKey；同一 Evidence 的完全相同请求仍可 exact replay。

### 9.2 Verification Request Key

```text
sha256(JCS([
  "forgeflow.recovery-evidence-verification.v1",
  evidenceSubmissionId,
  verificationCheckId,
  verifierId,
  verifierVersion,
  verifierConfigDigest,
  allowlistId,
  allowlistVersion,
  readToolVersion,
  readToolSchemaHash,
  readToolRunIdOrNull,
  expectedPayloadDigest
]))
```

Verifier rule/config digest 必须由宿主对版本化配置做 JCS + SHA-256，不接受
自由文本配置版本。

### 9.3 Replay

- Operation replay 返回原 Plan/ToolRun。
- Verification replay 返回原 Verification。
- Verification Check requestKey 先于外部 Availability / Verifier 执行提交；
  相同 requestKey 必须命中同一 Check intent。
- 同 evidenceSubmissionId + verificationCheckId replay 返回原检查。
- 新 verificationCheckId 不命中旧 Availability 历史。
- 同 key 不同内容拒绝。
- 不同 verifier config / allowlist version / Read tool version / schema hash
  不能命中旧成功结果。
- 失败事务不留下 Verification / Event / Checkpoint。
- Payload Store / Read 结果可重复检查，但外部 I/O 无 exactly-once 承诺。

Replay 顺序继承 Step 6.3.2.1：

1. 当前 Lease / Fencing / ExecutionAuthority。
2. exact replay lookup。
3. 命中则返回原结果，无写入。
4. 未命中后才进行 Task / decisionVersion CAS。

## 10. 测试矩阵

| 类别 | 用例 |
|---|---|
| Stored Integrity | raw/json Store 读取并 Digest 匹配 |
| Damage | Payload 缺失、替换、Digest mismatch |
| External Ref | 无 Adapter 保持 unavailable/unverified |
| Verifier | allowlist/source/payload type 校验 |
| Model Injection | 无法指定 verifier/tool/parameters |
| Plan Isolation | Recovery Evidence Plan 不出现在 Agent latest |
| Intent | ToolRun Intent commit 前零外部调用 |
| Read | queued/interrupted/running 恢复 |
| Crash | pre-intent / running / post-read / post-result |
| Read/Verification Split | Read Result 已提交、Verification 缺失，只重跑 Verifier |
| Request Persistence | Transaction A 后重启，仅凭 Request 恢复全部绑定 |
| Evidence A/B/C Request Keys | 同 Review/Original Write 下三份 Evidence 各有独立 Request |
| Evidence Request Replay | 同一 Evidence exact replay 返回原 Request；A/B/C 互不命中 |
| Check ID Replay | 同 Evidence + 同 Check ID 返回原 Verification |
| Check ID History | 新 Check ID 生成独立 Availability/Verification 历史 |
| Check ID Preallocation | Transaction A Request 保存稳定 verificationCheckId |
| Check ID Namespace | Request 预分配 ID 不会被 Stored V0 或其他 Request 复用 |
| Transaction B Atomic Check | EvidenceRead 与 Check intent 同一事务提交，无 B->V0 窗口 |
| Transaction B Rollback | Check intent、EvidenceRead、Message 全部回滚 |
| Stored Evidence V0 | 无 Read Result 的 Stored Verification 仍可在 V0 创建 Check |
| unavailable -> available | 第二次 Check 不覆盖第一次 unavailable |
| Request Binding | Manifest/Original Write/Review/Operation/Plan/Run 错误绑定拒绝 |
| Attempt Audit | 同一 ToolRun 的 prepared/dispatching/interrupted/retry/completed 历史 |
| Attempt Prepared | Transaction A 只写 prepared，不调用外部 Read |
| Attempt Dispatching | dispatching 崩溃保留外部是否到达的不确定性 |
| Attempt Events | timed_out/cancelled/blocked_by_intent 各有 Event |
| Attempt Number | 并发尝试在 Lease transaction 内单调分配 |
| immutable Retry | 自动新增 Attempt，不并发重复成功 |
| version_conditional Retry | ETag/resourceVersion 一致才重试 |
| Version Binding Digest | expectedResourceVersion/ETag 进入 operationPayloadDigest 与 requestKey |
| Version Metadata | actual resourceVersion/ETag 持久化到 Attempt 与 EvidenceRead |
| Version Mismatch | 不插入 EvidenceRead/Check，Attempt failed，不自动改读新版本 |
| mutable_current_state | Registry 注册拒绝；6.3.4 无半成品生命周期 |
| Read Output Store | result digest + payloadStoreRef 可重新读取 |
| Verification Failure | ToolRun 保持 succeeded，Verification failed |
| Event Association | 一条 Verification 同时关联 Availability/Verification Event |
| Availability History | 多次检查独立记录、部分失败 |
| Original Binding | Original Unknown Write / Review / Submission 错误绑定拒绝 |
| Cross Task | Manifest / Review / ReadRun 跨 Task 拒绝 |
| Wrong Review Binding | 同 Task 其他 Review / 其他 Unknown Write 绑定拒绝 |
| Operation Event Binding | Operation result plan/run 与 applied Event payload 全部匹配 |
| Operation No Phantom Columns | 不查询不存在的 plan_step_id / read_tool_run_id Operation 列 |
| Retry Consistency | ETag/resourceVersion 变化导致新 Read / 不复用旧结果 |
| Config Fingerprint | verifier/allowlist/tool version/hash 变化产生不同 key |
| waiting_review Lease | Claim / Heartbeat / Commit / Release 全程不改 Task 状态 |
| Cancel/Pause | intent 存在时不启动 Read-back、不清除 intent |
| Cancel Bypass | 客户端 force/bypass 参数无效 |
| readback_result Provenance | declared_payload 不获得 controlled_runtime_read |
| Purpose Isolation | Recovery Plan 不出现在 Agent latest；普通 Agent Recovery 不接管 |
| Verification Recovery Entry | Transaction B / V0 后崩溃由专用入口补 Transaction C |
| Verification Recovery No Read | 接管后只重跑 Verifier，不重复执行 succeeded Read |
| Snapshot Atomicity | 五个 Recovery 集合与 Events/Operations/Reviews/Submissions 同一 read tx |
| Result | Message/PlanStep/EvidenceRead/Verification 原子 |
| Lease | expired / stale fencing / authority revoked |
| Heartbeat | 失败后不启动新 Read/Verifier |
| Settle | Abort 忽略时等待 Promise settle |
| ToolRegistry Order | buildArguments -> validateInput -> ownership -> dispatching -> executeValidated |
| ToolRegistry Bypass | 未校验 input、version/hash mismatch、直接 execute 均拒绝 |
| Idempotency | Operation/Verification replay |
| Availability | 多次检查独立 Event，不覆盖历史 |
| Isolation | Task/PlanStep/ToolRun unknown 不被推进 |
| Regression | Phase1/2、Step6.1-6.3.3.1 |

## 11. 分步骤实施顺序

### 6.3.4.1 Verifier Contract + Allowlist

- Host Verifier interface。
- Read Tool allowlist interface。
- Zod payload/result schemas。

完成标准：纯单元测试通过；零数据库写入。

### 6.3.4.2 Migration v8 + Verification Repository

- Verification table/index/FK/append-only Trigger。
- Verification Check intent table/index/FK/append-only Trigger。
- Repository read/write capability。
- Snapshot 扩展。

完成标准：upgrade/rollback/immutability/snapshot tests。

### 6.3.4.3 Stored Payload Verification

- raw/json readback + digest。
- external reference blocked as unverified。
- Verification/Event/Checkpoint UoW。

完成标准：无外部 Provider/Read Tool 调用；历史 Verification 可追溯。

### 6.3.4.4 Recovery Readback Intent UoW

- `request_readback` operation。
- Recovery Evidence Plan/PlanStep/ToolRun Intent。
- Source model call binding。

完成标准：事务原子、requestKey replay、purpose isolation。

### 6.3.4.5 Recovery-only Read Executor

- Allowlist tool execution。
- Intent/Result UoW。
- Evidence Read binding。
- Lease/Heartbeat/authority。

完成标准：任务保持 waiting_review；普通 scheduler 不接管。

### 6.3.4.6 Readback Crash Recovery

- queued/running/interrupted recovery。
- succeeded/missing verification reconciliation。
- duplicate verification prevention。

完成标准：列出崩溃窗口全部有测试。

### 6.3.4.7 E2E + Report + Regression

- Recovery-only Read E2E。
- Snapshot/Event timeline。
- full tests/typecheck/diff check。
- development report。

## 12. 每一步的完成标准与禁止事项

每步必须同时满足：

- 生产接口有 Zod 校验。
- 所有 SQL 写入使用 StorageWritePermit。
- 所有跨表写入使用 UoW。
- 所有外部调用不在同步 SQLite callback 内。
- Lease/fencing/authority 检查存在。
- 失败整体 rollback。
- 测试覆盖成功、失败、replay、ownership。
- Task 不自动 running/completed/failed/cancelled。
- Review 不进入 final decision。
- PlanStep/ToolRun 不被错误推进。

禁止：

- 任意 Verifier / Tool 名由模型或普通请求注入。
- 调用 Write 工具。
- 创建普通 Agent Tool Call。
- 把 Digest matched 当 trusted。
- 把 external reference 当 available。
- 更新/删除 Evidence Manifest。
- 用普通 `recoverReadRuns()` 处理 recovery evidence。

## 13. 未解决风险与边界

1. Payload Store 无 fsync，电力故障后可能丢失已写文件。
2. hard-link 依赖文件系统支持。
3. 无 ACL API / retention / orphan GC。
4. file error 可能包含本地路径，需要安全错误映射。
5. SQLite 没有反向强制 submit Operation 必有 Manifest。
6. SQLite Trigger 负责数据库内关系；Host Registry 的 Verifier / Allowlist
   config digest 仍必须由 UoW 与 Check intent 比对。
7. external_reference 无 Adapter 时不能验证。
8. Read-back 外部调用不保证 exactly-once。
9. Abort 忽略时只能等待 Promise settle。
10. Verification Result 不等于 final Review Decision。

## 14. 架构评审前置确认项

评审前必须明确：

1. 接受 Migration v8 的独立 Verification Check intent 与 Verification 表。
2. 接受 Host-only Verifier Registry + Read allowlist。
3. 接受 Recovery Evidence 专用 UoW，不复用普通 `beginOwnedToolRun`。
4. 接受 Task 在 Read-back 全程保持 waiting_review。
5. 接受 `recovery_evidence` Plan 与 Agent Plan 完全隔离。
6. 接受 external_reference 在无 Adapter 时始终不可信。
7. 接受 Read-back 外部调用无 exactly-once 承诺。
8. 接受所有 Verification 仅追加、不覆盖历史。

## 15. 阶段边界草案

本设计只覆盖 Step 6.3.4。

不实现：

- confirmed_succeeded。
- confirmed_not_executed。
- RecoveryReview final decision。
- Cancel / Multi-Write Barrier。
- Write Recovery。
- 普通 Agent Resume。
- Provider 调用。
- Step 6.3.5。

## 16. Architecture Review Revision Traceability

本节保留 Revision 1 的历史审查记录。若与 Revision 2/3 冲突，以 §18、§20
和正文最终设计为准。

### 16.1 Read Result / Verification 两阶段

已有能力：

- Step 6.2 Read Intent/Result 原子性。
- Step 6.3.3 Manifest/Event/Operation。
- Lease/Heartbeat/ExecutionAuthority。

需要新增：

- Transaction A Read Intent。
- Transaction B Read Result。
- Transaction C Verification。
- 专用 UoW 的独立 API。

数据库约束：

- Transaction B 写 ToolRun、Message、PlanStep、EvidenceRead。
- Transaction C 写 Verification 与两个 Event。

测试：

- B 已提交、C 未提交时不重跑 Read。
- Verification failed 不改变 succeeded ToolRun。
- Read failed 与 Verification failed 分离。

### 16.2 Availability / Verification Event 模型

已有能力：

- append-only Events。
- Event task/id 复合唯一索引。

需要新增：

- Verification 行同时保存 availability_event_id 和
  verification_event_id。
- availability_event_id 必填。
- verification_event_id 可空。
- never_checked 为无记录默认投影。

数据库约束：

- 两 Event 都使用 `(task_id,event_id)` 复合外键。
- Verification 行 append-only。

测试：

- 部分 Availability 失败。
- Verifier 未执行时 verification_event_id=NULL。
- 多次 Availability/Verification 独立历史。

### 16.3 Original Unknown Write 绑定

已有能力：

- Manifest 保存 original unknown write ToolRun。
- Review -> original unknown write。
- `recovery_evidence_reads` 的 Task 复合外键。

需要新增：

- `original_tool_run_id` 持久化到 Readback/Verification 设计。
- UoW / Trigger 校验 Manifest original ToolRun。
- Verifier 只接收受控 Original Write context。

数据库约束：

- `(task_id, evidence_submission_id)`。
- `(task_id, original_tool_run_id)`。
- `(task_id, read_tool_run_id)`。
- `(task_id, review_id)`。

测试：

- 错误 Original ToolRun。
- 错误 Review。
- 跨 Task。
- Readback 与 Evidence Submission 不匹配。

### 16.4 Read Allowlist 与一致性

已有能力：

- ToolRegistry version、schema hash、Zod input、受控执行。

需要新增：

- allowlistId/version。
- schemaHash。
- retrySafety。
- consistencyMode。
- host buildArguments。

数据库约束：

- Read ToolRun 保存 toolVersion/hash/input hash/idempotency key。

测试：

- immutable retry。
- ETag/resourceVersion 条件读取。
- mutable current state 不误判重复安全。
- 任意 URL Fetch / Write 拒绝。

### 16.5 waiting_review Lease

已有能力：

- `TaskLeaseManager.claim` 允许 waiting_review。
- Heartbeat/assertOwned 不要求 Task.running。
- Release 不改变 Task.status。
- 普通 `beginOwnedToolRun` 要求 running。

需要新增：

- waiting_review 专用 Readback UoW。

数据库约束：

- 只更新 ToolRun/PlanStep/EvidenceRead。
- 不提供 Task.status 更新。

测试：

- waiting_review Claim/Heartbeat/Intent/Result/Release。
- 普通 Agent running 路径不回归。

### 16.6 Cancel / Pause

已有能力：

- cancel_requested_at。
- pause_requested_at。
- RecoveryGate/Classifier intent 检测。

需要新增：

- Readback 入口 intent gate。
- 宿主授权请求策略。

数据库约束：

- 不清除 intent。
- 不改变 Task.status。

测试：

- cancel / pause 下 Readback 拒绝。
- 不触发普通 Resume。
- 不破坏 Step 6.3.5 Cancel Barrier。

### 16.7 Authenticity Trust Model

已有能力：

- actorId / verifierId / verificationId 结构字段。
- Digest 校验。

需要新增：

- 独立 host attestation / trust anchor 校验。

数据库约束：

- Digest matched 只设置 Integrity。
- 无 trust anchor 时 Authenticity=unverified。

测试：

- actorId 不自动 manual_attested。
- verifierId 不自动 system_verified。
- 无签名/认证保持 unverified。

### 16.8 Configuration Fingerprint 与 Replay

已有能力：

- requestKey JCS + SHA-256。
- replay before CAS。

需要新增：

- verifierConfigDigest。
- allowlistId/version。
- read tool version/schema hash。
- Verification request key。

数据库约束：

- `UNIQUE(request_key)`。

测试：

- 同 key 同配置返回原结果。
- 同 key 不同内容拒绝。
- 配置/工具版本变化不命中旧成功结果。
- 重放仍验证当前 Lease/fencing/authority。

### 16.9 Purpose-aware Isolation

已有能力：

- `execution_plans.purpose`。
- ExecutionPlanRepository purpose-aware methods。
- 普通 Read Recovery 只查 agent plan。

需要新增：

- Classifier 识别 recovery_evidence Plan。
- Recovery Gate 新分类 `recovery_read_interrupted`。
- Recovery scanner 单独选择 recovery evidence work。
- Agent latest 只从 `purpose=agent` 查询。
- Recovery Evidence latest 只从 `purpose=recovery_evidence` 查询。
- Recovery-only PlanStep / ToolRun 选择必须从对应 Plan purpose 反查。
- 全局 version 分配仍满足 `(task_id,version)` 唯一约束，但消费者必须按
  purpose 分组。

数据库约束：

- purpose CHECK 已存在。

测试：

- Recovery Plan 不出现在 Agent latest。
- 普通 recoverReadRuns 不接管。
- Recovery executor 不接管 agent plan。
- TaskScheduler 不执行 recovery plan。

### 16.10 本轮修订后的评审门槛

架构评审必须确认：

1. Transaction A / B / V0 / C 是最终边界，V0 必须在外部 Verifier 前提交。
2. Migration v8 Verification Check intent + 双 Event 关联模型。
3. Original Unknown Write 复合绑定。
4. Allowlist retrySafety/consistencyMode。
5. waiting_review 专用 UoW。
6. Cancel/Pause gate。
7. Authenticity 必须独立证明。
8. Configuration Fingerprint。
9. Purpose-aware isolation。
10. Crash Recovery 与测试矩阵。

在以上确认前不得进入 Step 6.3.4.1 编码。

## 17. Revision 1 Design Boundary

本修订仍只属于 Step 6.3.4 设计阶段。

没有修改生产代码、测试或 Migration，没有创建数据库，没有执行 Recovery、
Read-back、Verifier、Write 或 Provider，也没有开始 Step 6.3.4.1。

最终边界保持不变：

- 不实现 confirmed_succeeded。
- 不实现 confirmed_not_executed。
- 不实现最终 RecoveryReview Decision。
- 不实现 Cancel / Multi-Write Barrier。
- 不实现 Write Recovery。
- 不自动 Resume。
- 不进入 Step 6.3.5。

## 22. Final Design Consistency Check Traceability

### 22.1 Transaction B / Verification Check

原问题：

- Transaction B 提交后、独立 Transaction V0 开始前存在崩溃窗口。
- Scanner 无法区分“正常待 Verifier”和“EvidenceRead 已提交但 Check 缺失”。

最终设计：

- Transaction A 在 Readback Request 中预分配稳定 verificationCheckId。
- Transaction B 原子提交 ToolRun Result、Tool Message、PlanStep Result、
  EvidenceRead、Check intent、Read Event 和 Checkpoint。
- Transaction B 先插入 Check intent（evidence_read_id NULL），再插入
  EvidenceRead；EvidenceRead.verification_check_id 非空并引用 Check。
- Scanner 只需查找“Check intent 存在且最终 Verification 缺失”的 B Snapshot。
- Stored Evidence Verification 继续使用 Transaction V0。

数据库约束：

- Request `UNIQUE(task_id, verification_check_id)`。
- Check intent `UNIQUE(readback_request_id)`。
- EvidenceRead 新行必须有 verification_check_id。
- Transaction B 失败时 Check / EvidenceRead / Message 同时回滚。

测试：

- Transaction B 前后崩溃窗口。
- Check + EvidenceRead 原子成功/回滚。
- B 后恢复只运行 Verifier。

未解决风险：

- Transaction B 的写入顺序与 Trigger 必须有真实 SQLite 测试，不能只验证
  内存对象。

### 22.2 version_conditional Binding

原问题：

- 原设计只有 retrySafety 条件，没有明确 expected resource version / ETag
  的 Transaction A 持久化和 Build/Run 校验。

最终设计：

- Readback Request 保存 expectedResourceVersion / expectedEtag。
- 两字段参与 operationPayloadDigest 和 requestKey。
- Host Allowlist.buildArguments 只使用已持久化预期值。
- 每个 Attempt 在 Transaction B 前验证 actual metadata，并将通过校验的
  actual resourceVersion / ETag 写入 Attempt 与 EvidenceRead。
- mismatch 不生成 EvidenceRead / Check，Attempt failed，且不自动观察新版本。

数据库约束：

- version_conditional 至少存在一个 expected binding。
- immutable 的 expected binding 必须为 NULL。
- Request append-only，不允许执行期修改预期版本。

测试：

- Digest/key 绑定。
- immutable / version_conditional 注册和 Request 校验。
- actual version mismatch、无 EvidenceRead、无自动新 Request。

未解决风险：

- Actual version/ETag 必须由 Host Adapter 的可信 metadata 提供；普通 Tool
  payload 字段不能自证版本一致。

### 22.3 Operation Result IDs

实际源码：

- Operation 有 result_plan_id、result_tool_run_id、applied_event_id。
- Operation 没有 plan_step_id 或独立 read_tool_run_id。
- Migration v5 已校验 request_readback 的 plan/tool run 关系。
- Migration v6 已校验 request_readback 必须为 accepted。

最终设计：

- 选择方案 A，不扩展 Operation 表。
- result_plan_id = Request.execution_plan_id。
- result_tool_run_id = Request.read_tool_run_id。
- applied_event_id 指向 recovery.readback_requested Event。
- Event payload 保存并校验 requestId、planStepId、readToolRunId 和
  verificationCheckId。

测试：

- 错误 Operation ID、plan/run、applied Event、payload ID 全部拒绝。
- 不执行任何不存在的 Operation 列引用。

未解决风险：

- Event payload 必须做严格 Zod 校验，并由 Schema test 验证 Trigger 读取路径。

### 22.4 TaskSnapshot

最终设计：

- TaskSnapshot 增加 Readback Requests、Read Attempts、Verification Checks、
  Verification Results，并扩展已有 EvidenceReads。
- 上述集合与 Events、Operations、Reviews、Evidence Submissions 必须在同一
  SQLite read transaction 内读取。
- Recovery Scanner / Manager 不得跨时间点拼接状态。

测试：

- 同一 Snapshot 内可完整恢复 B 后 pending Check。
- 并发写入不会造成半新半旧集合。

未解决风险：

- Snapshot 查询数量增加，需要索引和性能测试；Step 6.3.4 不引入近似读取或
  多查询拼接。

### 22.5 ToolRegistry

最终执行顺序：

```text
Host Allowlist.buildArguments(manifest, requestContext)
  -> ToolRegistry.validateInput()
  -> version / schema hash comparison
  -> Lease / ExecutionAuthority check
  -> Attempt prepared -> dispatching transaction
  -> synchronous local authority check
  -> ToolRegistry.executeValidated()
```

约束：

- buildArguments 只产生 candidate input。
- ToolRegistry 校验 Zod input、tool version、schema hash 和 mode=read。
- dispatching commit 后无 await 窗口，立即同步检查 authority 并调用
  executeValidated。
- 不得绕过 ToolRegistry 直接执行底层工具函数。

测试：

- validateInput 失败时零外部调用。
- version/hash mismatch 时零外部调用。
- Lease/authority 失效时零外部调用。
- executeValidated 使用的是同一 validateInput 受控对象。

未解决风险：

- 当前 ToolRegistry 尚未暴露 schemaHash projection，需在 6.3.4.1 完成并通过
  真实 registry metadata 测试。

### 22.6 Review Gate

本轮仅关闭最终设计一致性缺口，不改变 Step 6.3.4 的模块边界。

在确认以下事项前不得开始 Step 6.3.4.1：

1. Transaction B 原子创建 EvidenceRead + Check intent。
2. expected resource version / ETag 的持久化和 mismatch 规则。
3. Operation 方案 A 的 Event payload Trigger。
4. TaskSnapshot 单 read transaction。
5. ToolRegistry 的固定执行顺序与 schema hash 校验。

## 18. Architecture Review Revision 2 Traceability

本节保留 Revision 2 的历史审查记录。若与 Revision 3 冲突，以 §20 和正文
最终设计为准；不能把本节中的历史字段或旧流程当作待实现接口。

### 18.1 Read-back Request 持久化

已有能力：

- Manifest 完整 Evidence metadata。
- `request_readback` Operation 字段。
- `recovery_evidence_reads` binding Trigger。
- 同 Task 复合外键。

需要新增：

- `recovery_evidence_readback_requests`。
- Transaction A 写入完整 Request。
- 重启后只依赖 Request 恢复绑定和配置。

数据库约束：

- Request 唯一关联 Operation、Plan、PlanStep、Read ToolRun。
- Request 绑定 Manifest、Review、Original Write。
- Trigger 校验 Plan purpose、Step kind、Run mode、Operation type/status。

测试：

- Transaction A 后崩溃恢复。
- 错误 Manifest / Original Write / Review / Run。
- 跨 Task。
- Request 不可修改/删除。

### 18.2 RetrySafety 与 Attempt 审计

已有能力：

- ToolRun 保留逻辑执行身份。
- Read Worker 可重试 queued/interrupted Read。
- Event append-only。

需要新增：

- `recovery_evidence_read_attempts`。
- Revision 2 原始记录为 attempt started/interrupted/completed Events；
  Revision 3 已用 prepared/dispatching 和对应 Event 取代。
- immutable/version_conditional/mutable_current_state 策略。

数据库约束：

- attemptNumber 单调且唯一。
- Request/ToolRun 同 Task。
- EvidenceRead 只关联最终成功 Attempt。

测试：

- 三种 retrySafety 崩溃矩阵。
- Attempt 1 interrupted + Attempt 2 success。
- mutable state 不复用旧 request。
- 不声明 exactly-once。

### 18.3 Cancel / Pause 权限统一

已有能力：

- Task cancel_requested_at / pause_requested_at。
- RecoveryGate/Classifier intent 检测。

需要新增：

- 普通请求、自动恢复统一拒绝。
- 无客户端 bypass。

数据库约束：

- 不更新 Task.status。
- 不清除 intent 字段。

测试：

- cancel 普通请求/自动恢复拒绝。
- pause 普通请求/自动恢复拒绝。
- 客户端 force 参数无效。
- Task/Review/PlanStep/ToolRun 不变化。

### 18.4 buildArguments 权限

已有能力：

- ToolRegistry.validateInput。
- ToolRegistry.executeValidated。
- Tool version/schema hash。

需要新增：

- Host Allowlist 唯一定义 buildArguments。
- allowlistId 来自 Host 注册的 Verifier definition；Verifier 执行回调、
  模型和普通请求都不能生成工具参数或任意选择 Read 工具。

数据库约束：

- Request 保存 toolName/version/schemaHash/allowlist version.

测试：

- Verifier 参数注入拒绝。
- 模型工具名/参数注入拒绝。
- schema/hash mismatch 拒绝。

### 18.5 readback_result 语义

已有能力：

- Step 6.3.3 payloadType=readback_result。
- Manifest immutable。

需要新增：

- `readback_result_provenance`。
- controlled runtime read 完整链。

数据库约束：

- controlled 必须有 Request/Attempt/EvidenceRead/ToolRun/Message/PlanStep。
- declared payload 不能伪造 controlled 关联。

测试：

- declared vs controlled。
- 缺失 Message/EvidenceRead 拒绝 controlled。

### 18.6 Verification 状态枚举

已有能力：

- Availability Audit schema。

需要新增：

- Availability / Integrity / Authenticity / Verification 四轴枚举。

数据库约束：

- 每个轴使用 CHECK。
- unavailable 只存在于 Availability。

测试：

- unavailable 不进入 Verifier Result。
- Digest matched 不推高 Authenticity。

### 18.7 Event 与 Verification 关联

已有能力：

- append-only Event。
- task/event 复合唯一索引。

需要新增：

- Verification 行双 Event 外键。
- Availability Event 必填。
- Verification Event 可空。

数据库约束：

- 两 Event 同 Task。
- 未执行 Verifier 时 verification_event_id=NULL。

测试：

- 部分检查失败。
- 多次 Availability/Verification。
- Snapshot 可追溯。

### 18.8 Recovery Gate

已有能力：

- `agentExecutionPlans` / `recoveryEvidencePlans` 分组。

需要新增：

- `recovery_read_interrupted`。
- 双向 purpose isolation。

数据库约束：

- purpose CHECK 已存在。

测试：

- 普通 recoverReadRuns 不处理 recovery plan。
- Recovery executor 不处理 agent plan。
- 普通 Resume 被阻止。

### 18.9 Revision 2 Architecture Gate

评审时必须确认：

1. Readback Request 是 Transaction A 的强制实体。
2. Attempt 审计是正式数据模型。
3. cancel/pause 在 6.3.4 全部拒绝。
4. buildArguments 只由 Host Allowlist 生成。
5. declared/controlled readback_result 严格区分。
6. Verification 只通过双 Event + Verification 行表达。
7. Recovery Gate 双向隔离。
8. 新增测试矩阵完整。

在确认前不得开始 Step 6.3.4.1。

## 19. Final Design Boundary After Revision 2

本修订仍只属于 Step 6.3.4 设计阶段。

没有修改生产代码、测试或 Migration，没有创建数据库，没有执行 Recovery、
Read-back、Verifier、Write 或 Provider，也没有开始 Step 6.3.4.1。

阶段边界保持不变：

- 不实现 confirmed_succeeded。
- 不实现 confirmed_not_executed。
- 不实现最终 RecoveryReview Decision。
- 不实现 Cancel / Multi-Write Barrier。
- 不实现 Write Recovery。
- 不自动 Resume。
- 不进入 Step 6.3.5。

## 20. Architecture Review Revision 3 Traceability

### 20.1 request_readback 绑定 EvidenceSubmission

原问题：

- request key / operation payload 仅绑定 Review 和 Original Write。
- 同 Review 的 A/B/C 多份 Evidence 可能错误共享 Request。

本次修订：

- `evidenceSubmissionId` 加入 operation payload。
- 加入 operationPayloadDigest 输入。
- 加入 request_readback Request Key 输入。
- Request 行唯一绑定 evidenceSubmissionId。

持久化模型：

- `recovery_evidence_readback_requests.evidence_submission_id`。

数据库约束：

- `(task_id,evidence_submission_id)` FK。
- Manifest.review_id / tool_run_id 与 Request 一致。
- Request.operation_id / request_key 唯一。

测试：

- A/B/C 独立 Request Key。
- 同 Evidence exact replay。
- 不同 Evidence 不命中旧 Request。

风险：

- 多 Evidence 需要独立 Plan/Run，存储成本增加。

### 20.2 VerificationCheckId

原问题：

- Verification Request Key 对同 Evidence/同配置/null ReadRun 稳定不变。
- 无法发起独立重复 Availability Check。

本次修订：

- 增加 Host-generated `verificationCheckId`。
- 增加 append-only Verification Check intent，在任何外部检查前持久化完整
  Request Key 与配置绑定。
- 最终 Verification 行唯一绑定 Check ID。
- Request Key 包含 Check ID。
- 新 Check ID 产生独立 Availability/Verification 历史。
- 失败重试沿用原 Check ID。

持久化模型：

- `recovery_evidence_verification_checks` 保存 pending Check intent。
- `recovery_evidence_verifications.verification_check_id` 保存最终结果关联。

数据库约束：

- `UNIQUE(task_id, verification_check_id)`。
- Check intent requestKey 唯一。
- Verification requestKey 唯一。
- 同一 Check intent 最多一条最终 Verification。

测试：

- 同 Check ID replay。
- 新 Check ID 独立。
- unavailable -> available 历史保留。
- Check intent 后崩溃、重启后沿用原 Check ID。

风险：

- Host API 必须明确定义何时分配新 Check ID。

### 20.3 mutable_current_state 生命周期

原问题：

- Revision 2 提到新 Request，但未定义旧 Request/Plan/Run 如何关闭。

本次修订：

- Step 6.3.4 Registry 拒绝注册 `mutable_current_state` 和
  `current_state_only`。
- 只允许 immutable / version_conditional。
- 未来通过独立 supersede/observation group 设计开放。

持久化模型：

- 本步骤不持久化 mutable Request。

数据库约束：

- 不允许 Request 进入未定义生命周期。

测试：

- mutable/current-state allowlist 注册失败。
- 失败不影响 immutable/version_conditional 注册。

风险：

- Mutable current-state verification 推迟到未来步骤。

### 20.4 Verification Pending Recovery

原问题：

- Transaction B 已提交、Transaction C 未提交时没有专用恢复入口。

本次修订：

- 新增 `recoverPendingEvidenceVerifications`。
- 新增分类 `recovery_verification_pending`。
- 只重跑 Verifier，不重跑 Read。
- Read-back Transaction B 原子创建 EvidenceRead + Check intent。
- Stored Evidence 使用 Transaction V0 创建 Check intent。

持久化模型：

- 通过 append-only Verification Check intent + 缺失最终 Verification 识别。
- Check intent 在任何 Availability / Verifier 外部执行前提交；Read-back
  路径与 EvidenceRead 同属 Transaction B。
- controlled runtime read 通过 EvidenceRead 反查 Request / Manifest / ToolRun；
  Manifest-only Check 不要求 EvidenceRead。

数据库约束：

- EvidenceRead -> Request -> Manifest/ToolRun 复合绑定。
- EvidenceRead.verification_check_id -> Check intent。
- `(task_id, verification_check_id)` 唯一并连接最终 Verification。
- Check requestKey 与最终 Verification requestKey 必须一致。

测试：

- B 后崩溃、新 Lease 接管。
- 不重复 Read。
- Transaction C exact replay。
- 不结束 Review。

风险：

- Host 必须定义何时有意分配新 Check ID；自动恢复只能复用已持久化 ID。
- Verifier 在 Transaction C 前崩溃时可能被重新执行，外部 Verifier 不承诺
  exactly-once，但最终只保留一条受控 Verification 结果。

### 20.5 Original Write / Review 约束

原问题：

- 部分关系仅依赖 UoW。

本次修订：

- Trigger 校验 Manifest.tool_run_id = original_tool_run_id。
- Trigger 校验 Review.tool_run_id = original_tool_run_id。
- Trigger 校验 original Run mode=write/status=unknown。
- Trigger 校验 original Plan purpose=agent。

持久化模型：

- Request + Verification 都保存 original_tool_run_id。

数据库约束：

- 同 Task 复合外键与 Trigger。

测试：

- 同 Task 错误 Review。
- 同 Task 错误 Unknown Write。
- 跨 Task。

风险：

- Trigger 复杂度提高，需要 migration rollback tests。

### 20.6 buildArguments 统一

原问题：

- 文档仍存在 Verifier/Allowlist 共同生成参数歧义。

本次修订：

- 唯一签名：
  `buildArguments(manifest, requestContext)`，由 Host Allowlist 独占。
- Verifier 不能选择工具或参数。
- 执行必须经 validateInput/executeValidated。

持久化模型：

- Request 保存 allowlist/tool version/schema hash。

数据库约束：

- Read ToolRun 保存 version/schema/input/idempotency hashes。

测试：

- Verifier 参数注入失败。
- 任意 URL Fetch 拒绝。
- Schema/Hash mismatch 拒绝。

风险：

- Allowlist 配置变更必须提升版本。

### 20.7 Attempt prepared / dispatching

原问题：

- Transaction A 声称 Attempt 已 started，但外部尚未执行。

本次修订：

- Transaction A 只创建 prepared。
- 外部调用前单独 Lease-owned transaction 进入 dispatching。
- dispatching 崩溃保留外部是否到达的不确定性。
- timed_out/cancelled/blocked_by_intent Events 补齐。

持久化模型：

- `recovery_evidence_read_attempts`。

数据库约束：

- attemptNumber 在同一 Lease transaction 内单调分配。
- attempt unique 和同 Task FKs。

测试：

- prepared 不调用外部。
- dispatching 崩溃。
- interrupted/retry。
- event 与 attempt status 一致。

风险：

- Attempt 表是投影，Event 才是审计事实源。

### 20.8 Event / Verification association

原问题：

- Revision 2 已拆两个 Event，但需明确每个字段范围和 Check 生命周期。

本次修订：

- Verification 行保存 availability_event_id 和 verification_event_id。
- Availability Event 与 Verification Event 都以 verificationId 和
  verificationCheckId 关联。
- no Verifier -> verification_event_id=NULL。

持久化模型：

- Verification 行 append-only。

数据库约束：

- 两 Event 同 Task、各自唯一。

测试：

- 一条 Verification -> 两个 Event。
- 无 Verifier -> 一个 Availability Event + NULL。
- 多次历史。
- 两个 Event 的 verificationCheckId 与 Check intent 一致。

风险：

- Event payload 的完整 Zod 校验需要独立测试。

### 20.9 Recovery Gate

本次修订：

- `recovery_read_interrupted`：Read 恢复。
- `recovery_verification_pending`：只重跑 Verifier。
- 普通 Agent Recovery 不处理 Recovery Evidence Plan。
- Recovery Evidence Executor 不处理 Agent Plan。

测试：

- 普通 recoverReadRuns 不接管 recovery plan。
- Recovery executor 不接管 agent plan。
- 两类 pending 分类互斥。

### 20.10 Revision 3 Architecture Gate

评审必须确认：

1. evidenceSubmissionId 进入 Request Key。
2. verificationCheckId 生命周期。
3. mutable_current_state 在 6.3.4 拒绝注册。
4. pending verification recovery 入口。
5. Original Write/Review DB triggers。
6. Host-only buildArguments。
7. prepared/dispatching Attempt 状态。
8. 双 Event 与 Verification 关联。
9. 双向 purpose isolation。
10. Revision 3 测试矩阵。

在确认前不得开始 Step 6.3.4.1。

## 21. Final Design Boundary After Revision 3 / Consistency Check

本次仍只完成设计修订。

没有修改生产代码、测试或 Migration，没有创建数据库，没有执行 Recovery、
Read-back、Verifier、Write 或 Provider，也没有开始 Step 6.3.4.1。

边界保持：

- 不实现 confirmed_succeeded。
- 不实现 confirmed_not_executed。
- 不实现最终 RecoveryReview Decision。
- 不实现 Cancel / Multi-Write Barrier。
- 不实现 Write Recovery。
- 不自动 Resume。
- 不进入 Step 6.3.5。
