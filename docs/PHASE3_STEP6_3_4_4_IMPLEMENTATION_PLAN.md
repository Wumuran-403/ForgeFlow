# ForgeFlow Phase 3 Step 6.3.4.4 Implementation Plan

> 状态：Implementation Plan，等待架构评审
>
> 最终修正结论：严格 Lazy Request Replay 无法仅靠当前 v8 Schema
> 在并发和进程崩溃下保证。已提交最小 Migration v9 reservation 方案，
> 在架构批准前不得开始编码。
>
> 范围：Recovery Evidence V0 的 Host 授权 Read-back Request、受控外部
> Read、Transaction A / B、Attempt 状态机、Crash Recovery 和 controlled
> provenance Verification 集成
>
> 边界：不执行真实 Read Tool、Write、Provider 或 LLM；不修改 Task.status；
> 不修改 RecoveryReview 最终决策；不进入 Step 6.3.5

## 1. 本轮性质

本轮只完成源码核查和实施计划。

- 没有修改生产代码。
- 没有修改测试。
- 没有修改 Migration 或数据库 Schema。
- 没有修改依赖。
- 没有执行测试。
- 没有执行 Read-back、Recovery、Verifier、Provider、LLM 或 Write。
- 没有开始 Step 6.3.4.4 实施。

## 2. 前置源码核查

### 2.1 Read Tool Allowlist

实际接口：

```text
RecoveryReadbackToolRegistry.register()
RecoveryReadbackToolRegistry.get()
RecoveryReadbackToolRegistry.prepareArguments()
```

已核实：

- Registry 只能注册 Host 提供的 `RecoveryReadbackToolDefinition`。
- Store 中只允许 `mode=read`。
- `retrySafety` 只允许 `immutable` 和 `version_conditional`。
- Tool Name、Version、Timeout、Schema Hash 必须与 ToolRegistry 完全一致。
- `buildArguments()` 产出的 candidate 必须通过
  `ToolRegistry.validateInput()`。
- 返回值是绑定 ToolRegistry WeakMap token 的 `ValidatedToolInput`。
- Registry 当前不执行 Tool，也不保存 Validated Input。

当前限制：

```text
buildArguments(manifest, requestContext)
```

只能看到 Evidence Manifest 和 Request context，看不到真实的 Original
Unknown Write ToolRun。仅依赖 Submission 的 `resourceRef` 不能证明该资源
就是原始写入影响的资源。

同时，当前 ToolDefinition 没有 Host-owned output schema 或 actual
resource version / ETag extractor，无法可靠实现
`version_conditional` 的运行时版本比较。

### 2.2 ToolRegistry

实际执行入口：

```text
ToolRegistry.validateInput(name, input)
  -> ValidatedToolInput

ToolRegistry.executeValidated(validatedInput, context)
  -> Tool output
```

已核实：

- Validated Input 绑定具体 Tool Registry entry。
- Tool 被 unregister/替换后，旧 validated token 不能执行。
- `executeValidated()` 接受 `ToolExecutionContext`：

```text
taskId
toolCallId
signal
fencingToken?
```

- ToolRegistry 提供 `acquireExecutionLease()`，可在外部执行期间锁定注册表。
- ToolRegistry 不验证 Tool output Schema。

### 2.3 RecoveryEvidenceUnitOfWork

已有方法：

```text
createOwnedRecoveryEvidenceReadbackRequest()
createOwnedRecoveryEvidenceReadAttemptPrepared()
transitionOwnedRecoveryEvidenceReadAttempt()
completeOwnedRecoveryEvidenceRead()
createOwnedStoredEvidenceVerificationCheck()
recordOwnedRecoveryEvidenceVerification()
```

共同事实：

- 全部使用同步 immediate SQLite transaction。
- 全部要求 Lease / Fencing。
- 构造时必须注入 `assertAuthority`。
- 只允许 `waiting_review` Task。
- 使用 Task version CAS。
- 使用 StorageWritePermit。
- 不修改 Task.status。

`createOwnedRecoveryEvidenceReadbackRequest()` 已支持：

- Request key exact replay。
- Review decisionVersion CAS。
- ParentPreparation callback。
- 同一 transaction 内创建 Request / Operation / prepared Attempt /
  Event / Checkpoint。
- Parent callback 与 Request 写入共享 task、permit、timestamp。

`completeOwnedRecoveryEvidenceRead()` 已支持同一 immediate transaction：

- ToolRun running -> succeeded。
- Tool Message。
- PlanStep -> completed。
- Attempt -> completed + Event。
- `tool.succeeded` Event。
- Verification Check intent。
- EvidenceRead。
- `recovery.evidence.read_completed` Event。
- Checkpoint。

### 2.4 当前 UoW 缺口

尚未实现：

1. Transaction A 的 Parent Plan / PlanStep / Read ToolRun 业务构造器。
2. Attempt prepared -> dispatching 与 ToolRun queued -> running 的原子 UoW。
3. Read failed / timed_out / cancelled 的 ToolRun + Attempt + PlanStep +
   Plan 原子终止 UoW。
4. dispatching -> interrupted 与 ToolRun running -> interrupted 的恢复 UoW。
5. `completeOwnedRecoveryEvidenceRead()` 新写入分支的最新 Cancel/Pause
   transaction 内检查。
6. `recordOwnedRecoveryEvidenceVerification()` 新写入分支的最终
   Cancel/Pause transaction 内检查。
7. `createOwnedRecoveryEvidenceReadbackRequest()` 新写入分支的
   Cancel/Pause transaction 内检查。
8. retry attempt 只允许从可恢复的 ToolRun 状态创建。当前 UoW 允许在
   ToolRun 已 failed/timed_out/cancelled 后继续创建 Attempt，但没有合法
   ToolRun requeue 路径，必须在实施时收紧。

### 2.5 Migration v8

实际已持久化：

```text
recovery_evidence_readback_requests
recovery_evidence_read_attempts
recovery_evidence_verification_checks
recovery_evidence_reads
recovery_evidence_verifications
```

Request 已包含：

```text
evidenceSubmissionId
originalToolRunId
requestKey
operationId
executionPlanId
planStepId
readToolRunId
verifier binding
allowlist binding
read tool binding
retrySafety / consistencyMode
expectedResourceVersion / expectedEtag
verificationCheckId
```

Attempt 状态：

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

Check 区分：

```text
stored_evidence_v0
readback_transaction_b
```

EvidenceRead 已包含：

```text
evidenceSubmissionId
readbackRequestId
readAttemptId
verificationCheckId
observedAt
resourceVersion / resourceEtag
resultPayloadDigest / Store ref / storage mode
```

数据库 Trigger 已验证：

- Original Write 必须为 `write + unknown`。
- Original Plan 必须为 `agent`。
- Recovery Read Plan 必须为 `recovery_evidence`。
- Read ToolRun 必须匹配 Request 的 Tool identity / hash。
- Request 必须匹配 Operation 和 Event。
- Transaction B Check 必须匹配 Request 的 Verifier / Allowlist / Tool
  binding。
- EvidenceRead 必须有 completed Attempt、succeeded ToolRun、Check intent
  和唯一 Tool Message。
- Version-conditional EvidenceRead 的实际版本必须匹配 Request 预期。

结论：

- 已提交的 Request 可以用：

```text
UNIQUE (
  task_id,
  review_id,
  evidence_submission_id,
  original_tool_run_id
)
```

作为稳定逻辑身份查询。

- 但 v8 无法在“尚未计算 binding/requestKey”的阶段为先到请求原子
  占位。
- 由于 `buildArguments()` / `ToolRegistry.validateInput()` 是异步边界，
  不能把它们放进同步 immediate transaction。
- 没有 reservation 时，双 Worker 或进程恢复可能在 Request 并发提交前
  重复调用当前 Host 配置。

因此严格 Lazy Request Replay 存在 Schema 阻塞，最小 Migration v9 方案
见 §21.1。批准该 Migration 前不得开始 Step 6.3.4.4 编码。

### 2.6 Lease / ExecutionAuthority

已核实：

- `TaskLeaseManager.claim()` 允许非 terminal Task，包括
  `waiting_review`。
- `assertOwned()` 校验 lease token、fencing token 和 expiry。
- Heartbeat 失败通过 `ExecutionAuthority.revoke()` 先标记失权，再 abort
  signal。
- `waiting_review` Task 不能使用普通 `beginOwnedToolRun()`，因为普通 UoW
  要求 `running`。
- Recovery Evidence 路径必须继续使用专用 UoW。

### 2.7 Recovery Gate

已核实：

- `RecoveryManager.recoverReadRuns()` 通过
  `findEarliestUnfinishedPlanStep()` 只遍历 `agentExecutionPlans`。
- 因此普通 Read Recovery 当前不会直接选择 `recovery_evidence` Plan。
- `RecoveryClassifier` 仍遍历全部 PlanStep / ToolRun，没有 purpose-aware
  的独立分类。
- `RecoveryClassification` 当前没有：

```text
recovery_read_interrupted
recovery_verification_pending
```

- 当前没有 Recovery Evidence 专用执行入口。

### 2.8 Controlled Verification

已核实：

- Stage 4 `RecoveryEvidenceVerificationService` 当前只处理 Stored Evidence
  V0。
- Stage 3 `RecoveryVerifierRuntime` 当前强制：

```text
hasReadback = false
readbackToolRunId = NULL
toolMessageId = NULL
```

- 当前 Verification Service 从 Evidence Submission 的 Manifest payload
  Store ref 加载 Payload，不能加载 Transaction B 的 EvidenceRead payload。
- `recordOwnedRecoveryEvidenceVerification()` 已强制
  `readback_transaction_b` 使用 `controlled_runtime_read` provenance。

因此 Step 6.3.4.4 必须补充 controlled readback 的 Verification 装载与
Runtime context，不得仅修改 provenance 字符串。

## 3. 总体架构

新增两类 Host-only 服务：

```text
RecoveryEvidenceReadbackService
  - Host policy 校验
  - request Key / Operation Payload
  - Transaction A
  - Recovery 编排

RecoveryEvidenceReadbackExecutor
  - dispatching UoW
  - Heartbeat / Authority / Fencing
  - 外部 Read Tool 执行
  - result payload storage
  - Transaction B
  - Verification Service 调用
```

两者只负责编排，不直接写 Repository、Event、Checkpoint。

调用链：

```text
RecoveryManager.requestRecoveryReadback()
  -> Claim Lease
  -> Heartbeat / ExecutionAuthority
  -> Read only one consistent TaskSnapshot
  -> validate Review / Submission / Original Unknown Write
  -> resolve Host verifier binding
  -> resolve allowlist and Host source binding
  -> prepare arguments + ToolRegistry.validateInput
  -> compute IDs / payload digest / requestKey
  -> Transaction A
  -> stop heartbeat
  -> release lease

RecoveryManager.executeRecoveryReadback()
  -> Claim Lease
  -> Heartbeat / ExecutionAuthority
  -> load Request / Attempt / Plan / ToolRun
  -> re-prepare and revalidate Host arguments
  -> begin dispatching UoW
  -> execute external Read outside SQLite
  -> normalize result + store canonical readback payload
  -> Transaction B
  -> controlled Verification Service
  -> stop heartbeat
  -> release lease
```

## 4. Host Readback Request Contract

Host input：

```text
ownership
expectedTaskVersion
reviewId
evidenceSubmissionId
expectedDecisionVersion
verificationCheckId
allowlistId
expectedResourceVersion
expectedEtag
```

Host input 不包含：

```text
readToolName
tool arguments
tool timeout
verifier id
verifier version
verifier config digest
actor force flag
```

Service 构造时固定：

```text
hostVerifierId
RecoveryReadbackToolRegistry
RecoveryVerifierHostBindingProvider
ToolRegistry
EvidencePayloadStore
```

Service 必须先验证：

- Review 属于 Task，且为 `pending` 或 `unresolved`。
- Review protocol >= 1。
- Review 当前 decisionVersion 与输入一致。
- Submission 属于 Review 和 Original Unknown Write。
- Original ToolRun 为 `write + unknown`。
- Original Agent Plan 为 `purpose=agent`。
- Original Agent Plan 的 source ModelCall 已 completed。
- Submission 的 evidence/resource binding 有效。
- Verification Check ID 尚未被同一 Task 的其他 Request 占用。

## 5. Host Resource Resolution

### 5.1 问题

当前 `buildArguments(manifest, requestContext)` 看不到 Original Unknown Write
本体。把 Submission 的 `resourceRef` 直接当成可信目标是不充分的。

### 5.2 计划接口

在 `RecoveryReadbackToolDefinition` 增加 Host-only：

```text
resolveSource(originalToolRun, manifest):
  {
    resourceRef,
    resourceVersionHint?,
    etagHint?
  }

buildArguments(
  manifest,
  requestContext,
  resolvedSource
)

resultSchema
extractResultMetadata(result):
  {
    resourceVersion?,
    resourceEtag?
  }
```

约束：

- `resolveSource()` 只能读取 Host 提供的 immutable Original ToolRun 和
  Manifest。
- `buildArguments()` 和 `resolveSource()` 都是 Host registration callback。
- 模型、Review payload 或 HTTP 请求不能提供 Tool Name、参数构造器或
  timeout。
- `resultSchema` 必须通过 Zod 校验 Tool output。
- `extractResultMetadata()` 只能由 Host allowlist 实现。
- 不允许从普通 Tool payload 自报字段推导可信 version，除非该字段属于
  Host allowlist 明确定义的 result Schema。

### 5.3 Resource Binding

如果 Manifest 有 `resourceRef`，Host resolution 得到的资源必须与其一致。

如果 Manifest 没有 `resourceRef`，Host allowlist 必须能从 Original
Unknown Write 的 persisted input 中确定唯一资源；否则拒绝 Request。

不允许：

- arbitrary URL；
- 任意本地路径；
- 通用 HTTP fetch；
- 以 Evidence Summary 或模型文本替代 Original ToolRun。

### 5.4 Immutable Allowlist Version

一个已发布的 `allowlistId + allowlistVersion` 必须代表不可变执行合同。

合同 canonical input 至少包含：

```text
protocolVersion
allowlistId
sourceResolverId / sourceResolverVersion
argumentBuilderId / argumentBuilderVersion
toolName / toolVersion / toolInputSchemaHash
resultSchemaId / resultSchemaVersion / resultSchemaHash
resourceMetadataExtractorId / resourceMetadataExtractorVersion
retrySafety
timeoutMs
maximumPayloadBytes
sensitiveOutputPolicy
```

`allowlistVersion` 使用以下 Digest 作为版本：

```text
sha256(JCS(Allowlist Immutable Contract))
```

格式为 64 lowercase hex，满足当前 `allowlist_version` 长度和字符串约束，
不新增 Schema 字段。

Registry 规则：

- 注册时重新计算 contract digest 并与 `allowlistVersion` 比较。
- 同一 `allowlistId + allowlistVersion` 再次注册时，contract digest 必须
  完全相同。
- 任何 source resolver、builder、tool schema、result schema、metadata
  extractor、retry safety、timeout、payload limit 或 sensitive policy
  变化都必须产生新 version。
- Host 必须保留执行历史版本所需定义；无法恢复历史 version 时 fail closed。
- Request 中持久化的 `allowlistId + allowlistVersion` 是历史合同的权威引用。
- 不通过模型或普通请求参数选择 allowlist version。

这避免依赖“相同 version 字符串自动代表相同代码和配置”的假设。

## 6. Transaction A

### 6.1 前置准备

本节只适用于逻辑 Request reservation 成功且当前 Worker 是该 reservation
owner 的路径。最终设计以 §21.1 为准。

Reservation miss 后，Transaction A 前完成：

1. Host verifier binding 获取。
2. Allowlist metadata 获取。
3. Original Write resource resolution。
4. `buildArguments()`。
5. `ToolRegistry.validateInput()`。
6. 从 validated input 计算 canonical input hash。
7. 计算 operation payload digest 和 review operation requestKey。
8. 预分配：

```text
requestId
operationId
executionPlanId
planStepId
readToolRunId
readAttemptId
verificationCheckId
toolCallId
```

Argument preparation 可以包含 Host callback，但不得执行 Read Tool，也不得
进入 SQLite transaction。

### 6.2 Parent Preparation

调用：

```text
RecoveryEvidenceUnitOfWork
  .createOwnedRecoveryEvidenceReadbackRequest(input, prepareParents)
```

`prepareParents()` 必须在同一 immediate transaction 内创建：

```text
ExecutionPlan
  purpose = recovery_evidence
  status = active
  sourceModelCallId = original agent plan.sourceModelCallId
  version = transaction-time MAX(execution_plans.version) + 1

PlanStep
  stepIndex = 0
  kind = read_batch
  status = queued

ToolRun
  originalIndex = 0
  mode = read
  status = queued
  attemptNo = 1
  toolName/toolVersion/schemaHash from allowlist
  input from validated input
  canonicalInputHash from input
  idempotencyKey from canonical identity
```

实际 Schema 中 `execution_plans` 有全局
`UNIQUE(task_id, version)`，不是每个 purpose 独立编号。因此 Plan version
必须在事务内对同一 Task 的全部 Plan 取 `MAX(version)+1`。

Recovery Plan 使用 stepIndex / originalIndex 的独立序号空间：

- 原始 LLM Plan 的 `stepIndex` 不变。
- 原始 Unknown Write ToolRun 的 `originalIndex` 不变。
- Recovery Read ToolRun 位于独立 `purpose=recovery_evidence` Plan。

### 6.3 同一 Transaction A 后续写入

Parent callback 返回后，现有 Request UoW 继续原子写：

```text
recovery.readback_requested Event
request_readback Operation (accepted)
RecoveryEvidenceReadbackRequest
recovery.evidence.read_attempt_prepared Event
Prepared Attempt #1
Checkpoint
```

同时：

- 重算 operation payload digest。
- 重算 requestKey。
- CAS Review decisionVersion。
- Request key exact replay 不执行 Parent callback。
- 任一步失败整体 rollback。

### 6.4 Cancel / Pause

新 Request 写入分支必须在事务内检查：

```text
cancelRequestedAt IS NULL
pauseRequestedAt IS NULL
```

Exact replay 可返回已存在 Request，但不得启动或重跑外部 Read，也不得
调用当前 Host Binding、Source Resolver、buildArguments、validateInput 或
ParentPreparation。

## 7. External Read Boundary

### 7.1 Dispatching Transaction

新增专用 UoW：

```text
beginOwnedRecoveryEvidenceRead()
```

同一 immediate transaction：

```text
Lease / Fencing / ExecutionAuthority
  -> Task waiting_review
  -> cancel/pause check
  -> Request / Attempt / Plan / PlanStep / ToolRun binding check
  -> Attempt prepared -> dispatching
  -> Attempt dispatching Event
  -> ToolRun queued -> running
  -> tool.started Event
  -> PlanStep queued -> running
  -> Checkpoint
```

任一步失败整体 rollback。

### 7.2 External Execution

顺序：

```text
prepareArguments()
  -> compare generated input with persisted ToolRun input
  -> ToolRegistry.validateInput()
  -> acquire ToolRegistry execution lease
  -> final pre-dispatch gate:
       Lease ownership
       Fencing token
       mandatory ExecutionAuthority
       combined AbortSignal not aborted
       latest persisted Cancel/Pause intent
  -> beginOwnedRecoveryEvidenceRead()
  -> ToolRegistry.executeValidated()
  -> release ToolRegistry execution lease
```

执行 context：

```text
taskId
toolCallId
signal = AbortSignal.any(caller signal, heartbeat/authority signal)
fencingToken
```

外部执行必须在 SQLite transaction 外。

ToolRegistry execution lease 获取后、`executeValidated()` 前必须执行最后
一次 dispatch gate。该 gate 在 begin UoW 前检查，并由
`beginOwnedRecoveryEvidenceRead()` 在同一 immediate transaction 内再次
权威检查。

如果 external Tool 尚未开始，而 Cancel/Pause、Lease 或 Authority 使 gate
失败：

- ownership 仍可提交 UoW 时，使用专用 UoW 将 prepared Attempt 原子标记
  `blocked_by_intent` 或 `cancelled`，并写对应 Event / Checkpoint。
- Lease / Authority 已失权时无法安全写结果，保留 prepared Attempt，
  由后续 Recovery 重新分类。
- 不允许先进入 dispatching 后因已知 pre-dispatch 失败永久悬挂。

### 7.3 Timeout

使用 Host allowlist 的 `timeoutMs`，不接受模型或 Request 临时指定。

规则：

- Tool 未启动：不进入 dispatching。
- Tool 已启动后 reject：Attempt `failed`。
- Tool 已启动后 timeout：Attempt `timed_out`。
- Abort 导致取消：Attempt `cancelled`。
- 非协作 Promise 不能被强制终止。
- 单一 settle 状态保证迟到 resolve/reject 不会提交第二个结果。
- 迟到 reject 必须被消费，不能形成 unhandled rejection。

Timeout / failed / cancelled 后必须通过专用 UoW 原子写：

```text
Attempt terminal transition + Event
ToolRun terminal transition
PlanStep failed / cancelled
ExecutionPlan failed / cancelled
Checkpoint
```

这些状态写入后，不允许同一 ToolRun 重新执行。进一步 Read-back 需要新的
Evidence Submission 和新的 Request。

### 7.4 Cancel / Pause

- Request 创建前拒绝。
- Attempt dispatching 前拒绝。
- 外部执行期间 signal 取消为 best effort。
- Transaction B 前重新检查持久化 intent。
- UoW 在 Transaction B immediate transaction 内最终检查。
- 已启动外部 Read 即使返回成功，也不得在 intent 出现后提交 EvidenceRead。
- 不修改或清除 intent。
- 不改变 Task.status。

## 8. Result Normalization and Payload Storage

外部 Tool 返回后：

1. 使用 allowlist `resultSchema` 校验 output。
2. 校验 JSON / size / sensitive output policy。
3. `extractResultMetadata()` 获取 actual resource version / ETag。
4. 从 Manifest 获取 resourceRef。
5. 构造：

```text
RecoveryReadbackResult {
  resourceRef,
  resourceVersion,
  observedAt,
  outcome = observed_succeeded,
  result
}
```

6. 使用 `canonicalJson()` 生成 canonical bytes。
7. 计算 semantic digest：

```text
sha256(JCS(RecoveryReadbackResult))
```

8. 计算 storage digest：

```text
sha256(canonical bytes)
```

9. 写入 EvidencePayloadStore。

Store 写入与 SQLite Transaction B 不是原子事务。

允许的故障结果：

- Store 成功、Transaction B 失败：留下无 Manifest 的 content-addressed
  orphan file。
- Store 失败：不创建 EvidenceRead / Check，读取记为 failed。

Orphan 规则：

- orphan 只表示文件内容已写入。
- orphan 不代表 Request、Attempt、EvidenceRead、Check 或 Verification
  已成功。
- 恢复只能以已持久化 Request / Attempt / EvidenceRead / Check 为准，
  不得仅凭 Store 中存在相同 Digest 文件推断成功。
- 本步骤不实现 GC，但 Store ref 必须保持内容寻址和不可覆盖，以便后续
  安全清理只能删除无任何数据库引用的内容。

禁止：

- 把 raw Payload 写入 Event。
- 把 raw Payload 写入 Checkpoint。
- 把 raw Payload 或本地路径写入 AppError。
- 只根据 `payloadType=readback_result` 设置 controlled provenance。

### 8.1 Version-Conditional

每个 Attempt 都必须比较：

```text
actualResourceVersion vs Request.expectedResourceVersion
actualEtag vs Request.expectedEtag
```

规则：

- expectedResourceVersion / expectedEtag 只能来自 Host-controlled input
  或经过 Host policy 验证的 Original Write source binding。
- 不接受模型、普通用户文本或 Tool 未验证输出直接提供预期值。
- Request 中为 NULL 的预期字段不用于比较。
- Request 中非 NULL 的预期字段必须取得 actual 值进行比较。
- actual 值缺失视为 mismatch。
- 任一非 NULL 预期字段与 actual 不一致时，不写入 Payload Store、
  EvidenceRead 或 Check。
- Attempt 记录 failed 和稳定 reasonCode。
- 不自动接受新版本。
- 新版本观察需要 Host 创建新的 Evidence Submission 和 Request。

## 9. Transaction B

调用现有：

```text
completeOwnedRecoveryEvidenceRead()
```

同一 immediate transaction 原子写：

```text
ToolRun running -> succeeded
Tool Message
PlanStep running -> completed
Recovery Evidence Plan active -> completed
Attempt dispatching -> completed + Event
tool.succeeded Event
Transaction B Verification Check intent
EvidenceRead
recovery.evidence.read_completed Event
Checkpoint
```

实施时必须补齐当前 UoW 未写的：

```text
ExecutionPlan active -> completed
```

ToolRun 持久化结果应只保存 bounded、redacted result reference，例如：

```text
{
  status: "succeeded",
  evidenceReadId,
  resultPayloadDigest,
  resourceVersion,
  resourceEtag
}
```

实际 read-only business Payload 保存在 EvidencePayloadStore，由
EvidenceRead 引用，不写入 Tool Message、Event、Checkpoint 或公开
AppError。

Transaction B 的 Replay 身份不是 final Verification。Transaction B 尚未
产生 Verification row 时，持久化查重对象是：

```text
readbackRequestId
readAttemptId
readToolRunId
verificationCheckId
resultPayloadDigest
resourceVersion
resourceEtag
existing EvidenceRead
existing Verification Check intent
```

v8 中 Check 已有 `UNIQUE(readback_request_id)`，EvidenceRead 有
`UNIQUE(task_id, verification_check_id)` 和
`UNIQUE(evidence_submission_id, tool_run_id)`，可作为权威查重依据。

事务内顺序：

```text
Lease / Fencing / Authority
  -> load Request
  -> lookup existing Check by readbackRequestId
  -> lookup existing EvidenceRead by Check / verificationCheckId
  -> B already committed:
       -> compare Attempt / ToolRun / Check / EvidenceRead binding
       -> compare resultPayloadDigest
       -> compare resourceVersion / ETag
       -> compare store ref / storage mode
       -> return persisted EvidenceRead / Check
       -> no writes
  -> B not committed:
       -> Cancel/Pause gate
       -> validate Request / Attempt dispatching / ToolRun running /
          PlanStep running
       -> atomic Transaction B writes
```

不同 Payload Digest、Resource Version、ETag 不得覆盖已提交 EvidenceRead。

Transaction B Replay 和 Verification Service Replay 是两个独立幂等边界：

- B Replay 查 Request + Attempt + EvidenceRead + Check。
- Verification Replay 查 final Verification 的
  `(task_id, verification_check_id)` / verification requestKey。

最终 New-write 规则：

- 新写入分支检查 Cancel/Pause。
- 使用 Task version CAS。
- 使用 Attempt / ToolRun / PlanStep version CAS。
- 任一写入失败整体 rollback。

## 10. Verification Integration

Transaction B 成功后，Check 已存在且 origin 为：

```text
readback_transaction_b
```

Verification Service 新增内部入口：

```text
verifyPersistedControlledReadback()
```

流程：

```text
Lease / Fencing / Authority
  -> authoritative Check lookup
  -> Check + Verification exact replay
  -> load EvidenceRead
  -> validate Request + Attempt + ToolRun + Tool Message + PlanStep
  -> load result Payload from EvidenceRead store ref
  -> Runtime integrity
  -> Host Verifier exact resolve
  -> Verifier execution
  -> recordOwnedRecoveryEvidenceVerification()
```

不重新执行 Read ToolRun。

### 10.1 Controlled Provenance

新增内部 opaque capability：

```text
VerifiedControlledReadbackProvenance
```

实现必须是 module-private `WeakMap` / WeakSet capability，模式与现有
`RecoveryEvidenceControlledReadCapability` 一致：

- 对外只暴露不可重建的 opaque object。
- 完整 provenance 数据保存在 module-private WeakMap。
- TypeScript 类型断言或手工构造普通 object 不能获得 capability。
- Runtime 只能通过内部 verifier 函数读取 capability payload。

只有完整校验以下链后生成：

```text
Readback Request
  + completed Attempt
  + succeeded Read ToolRun
  + exactly one Tool Message
  + completed recovery_evidence PlanStep
  + EvidenceRead
  + Verification Check
```

Stage 3 Runtime 增加 controlled context 参数：

```text
readbackRequestId
readAttemptId
readToolRunId
toolMessageId
evidenceReadId
```

`hasReadback=true` 只能来自该 capability，不能由以下条件推导：

```text
payloadType == readback_result
context 中存在两个非 NULL ID
EvidenceRead 单独存在
```

Runtime 内部 `assertVerifiedControlledReadbackProvenance()` 必须验证
capability 属于本模块 WeakMap，且 Task / Request / Check / EvidenceRead ID
一致后才能设置 `readbackToolRunId`、`toolMessageId` 和
`hasReadback=true`。

### 10.2 Persisted Payload

Controlled Verification 使用 EvidenceRead 的：

```text
resultPayloadDigest
resultPayloadStoreRef
resultPayloadStorageMode
```

构造内部 payload binding，交给 Stage 2 single-read Integrity loader。

不得退回 Manifest payload Store ref。

### 10.3 Result Mapping

沿用 Stage 4 状态映射：

- Availability failure：`not_run`，只有 Availability Event。
- Integrity mismatch：`not_run`，只有 Availability Event。
- Registry resolve failure：`not_run`，只有 Availability Event。
- Verifier passed / failed / inconclusive：两条 Event。
- Authenticity 永远为 `unverified`。

## 11. Crash Recovery

恢复入口：

```text
RecoveryManager.recoverEvidenceReadbacks(...)
RecoveryManager.recoverPendingEvidenceVerifications(...)
```

状态矩阵：

| 持久状态 | 恢复动作 | 禁止动作 |
|---|---|---|
| Request 不存在 | 同 requestKey 重新请求 | 伪造 Plan/ToolRun |
| Plan active / Step queued / Run queued / Attempt prepared | 重新验证 allowlist 后 dispatch | 跳过 dispatching |
| Attempt dispatching / Run running | Attempt/Run/Step -> interrupted；新 Attempt | 推断外部调用未执行 |
| Attempt interrupted / Run interrupted / Step interrupted | Run/Step -> queued；新 Attempt | 复用 interrupted Attempt |
| Read 返回但 B 未提交 | 当前仍 running/dispatching；按中断恢复 | 声称 exactly-once |
| completed Attempt + EvidenceRead + pending Check | 只重跑 Verifier | 重跑 Read |
| Verification 已存在 | exact replay | 重复 Event/Row |
| Run succeeded 但 Check/Read 缺失 | state inconsistency | 重新推断或补造 Read |
| Run failed/timed_out/cancelled | terminal；需新 Evidence/Request | 同 ToolRun 重试 |

`dispatching` 的语义是“已经持久化执行授权，但无法证明外部调用是否到达”。
恢复不得把它升级为 succeeded 或 failed，只能标记 interrupted。

RetrySafety：

```text
immutable:
  可重新读取同一不可变资源

version_conditional:
  每次 Attempt 必须重新校验版本或 ETag

mutable_current_state:
  Registry 拒绝注册
```

## 12. Recovery Gate and Purpose Isolation

新增分类：

```text
recovery_read_interrupted
recovery_verification_pending
```

规则：

- 阻止普通 Agent Resume。
- 由 Recovery Evidence Executor 接管。
- `recovery_read_interrupted` 只处理 recovery Evidence Read。
- `recovery_verification_pending` 只重跑 Verifier。
- 普通 `recoverReadRuns()` 不得处理 `recovery_evidence` Plan。
- Recovery Evidence Executor 不得处理 `agent` Plan。
- 分类必须基于 Plan purpose，不得仅凭 PlanStep kind。
- Recovery Evidence 分类单位是：

```text
taskId + readbackRequestId + executionPlanId
```

不得只按 Task 产生一个混合分类。

同一 Task 可以同时存在：

```text
Request A -> recovery_read_interrupted
Request B -> recovery_verification_pending
```

两者必须可以独立选择执行器。

Dedicated Scanner 输出：

```text
RecoveryEvidenceReadbackCandidate {
  taskId,
  readbackRequestId,
  executionPlanId,
  readAttemptId?,
  verificationCheckId?,
  classification,
  reasonCode
}
```

Classifier 逻辑：

- 有 Request / Attempt 且需要 Read：`recovery_read_interrupted`。
- 有 Transaction B Check 且无 final Verification：
  `recovery_verification_pending`。
- 对同一 Request 同时出现：

```text
Attempt interrupted
+ Transaction B Check
+ EvidenceRead
```

判定为 `state_inconsistent`，阻断自动执行。Transaction B 是原子边界，
正常的 interrupted Attempt 与 B Check 不得同时存在。
- Verification pending 不得重跑 Read。
- Read pending 不得处理其他 Request 的 Verification。
- 普通 `read_interrupted` 只用于 agent Read PlanStep。

## 13. Idempotency

### 13.1 Request

真实 Schema 中可用于已提交 Request 的稳定逻辑身份：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
```

对应 v8 约束：

```text
UNIQUE (
  task_id,
  review_id,
  evidence_submission_id,
  original_tool_run_id
)
```

现有 Request 还唯一绑定：

```text
request_key
operation_id
execution_plan_id
plan_step_id
read_tool_run_id
(task_id, verification_check_id)
```

`requestKey` 继续使用：

```text
computeRecoveryEvidenceReadbackOperationPayloadDigest()
computeRecoveryReviewOperationRequestKey()
```

Request key 包含 Evidence Submission ID，因此 A/B/C Evidence 不会串用。

但 `requestKey` 包含 Verifier / Allowlist / Read Tool binding 和
expectedDecisionVersion，不能作为“尚未解析 Host 配置”阶段的第一查找键。

最终 Lazy Replay 顺序：

```text
Reservation transaction
  -> Lease / Fencing / Authority
  -> lookup completed Request by stable logical identity
  -> completed request:
       -> compare caller-provided stable identity / optional requestKey
       -> load Operation / Attempt
       -> return persisted result
       -> do not call Host callbacks
       -> no writes
  -> no completed request:
       -> lookup active reservation
       -> another reservation owner: return in_progress
       -> stale reservation: atomically claim with current Lease
       -> no reservation: insert reservation
       -> return reservationToken

Host preparation outside SQLite transaction
  -> verifier binding
  -> allowlist exact version
  -> source resolver
  -> buildArguments
  -> ToolRegistry.validateInput
  -> digest / requestKey / parent IDs

Commit transaction
  -> Lease / Fencing / Authority
  -> validate reservationToken / fencing
  -> recheck completed Request by logical identity
  -> if another Request exists: reject reservation conflict
  -> ParentPreparation
  -> existing Transaction A writes
  -> mark reservation completed
```

相同 stable logical identity 但传入的 `requestKey`、Allowlist Version、
Tool binding 或 Verification Check ID 不一致时拒绝。

没有 reservation 就无法同时满足：

- Host preparation 是异步边界；
- SQLite immediate transaction 必须同步；
- Request 尚未存在时不能持久化部分 Request；
- 双 Worker 不得重复调用当前 Host 配置。

因此本计划依赖 §21.1 的 Migration v9 reservation。

### 13.2 Verification Check

Transaction B 使用 Request 预分配的 `verificationCheckId`。

Request Key 使用现有：

```text
computeRecoveryEvidenceVerificationRequestKey()
```

必须包含：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
checkOrigin = readback_transaction_b
verifier binding
allowlist binding
read tool binding
expectedPayloadDigest
```

Stored V0 的 Allowlist / Read Tool NULL 规则不用于 Transaction B。

### 13.3 Attempt

- `ReadAttempt.attemptNumber` 在同一 immediate transaction 内单调分配。
- `ToolRun.attemptNo` 表示该 logical ToolRun 的创建 attempt，固定为 1；
  外部 Read 重试不由 `ToolRun.attemptNo` 表示。
- 两者语义明确独立，不得通过修改 ToolRun.attemptNo 伪装外部 Attempt。
- 同一 Request 同时最多一个 prepared/dispatching Attempt。
- completed Request 不允许新 Attempt。
- terminal failed/timed_out/cancelled ToolRun 不允许新 Attempt。
- 只有 interrupted -> queued 的崩溃恢复路径可创建新 Attempt。

## 14. Event and State Matrix

### 14.1 Attempt

```text
prepared
  -> dispatching
  -> completed | interrupted | failed | timed_out | cancelled

prepared
  -> cancelled | blocked_by_intent
```

每次状态变化必须有：

- Attempt row transition。
- 对应 `recovery.evidence.read_attempt_*` Event。
- Checkpoint。
- ToolRun / PlanStep / Plan 状态与 Event 在同一 transaction 中一致。

### 14.2 Plan

```text
active
  -> completed
  -> failed
  -> cancelled
```

### 14.3 PlanStep

```text
queued -> running -> completed
queued/running -> interrupted
interrupted -> queued
queued/running -> failed/cancelled/blocked
```

### 14.4 ToolRun

```text
queued -> running -> succeeded
queued/running -> failed/timed_out/cancelled
running -> interrupted -> queued
```

Read ToolRun 不得进入 `unknown`。

### 14.5 Task / Review

- Task 始终 `waiting_review`。
- RecoveryReview 只增加 Verification 历史，不进入 final decision。
- Original Unknown Write 保持 `unknown`。

## 15. Testing Matrix

### 15.1 Transaction A

- Parent Plan / PlanStep / ToolRun / Request / Operation / Attempt /
  Event / Checkpoint 全部原子提交。
- 每个写入点故障注入时全部 rollback。
- requestKey replay 不执行 Parent callback。
- A/B/C Evidence Submission 生成不同 Request Key。
- Plan purpose/version/source model call 正确。
- 原始 Agent Plan 的 stepIndex/originalIndex 不变。
- 无 Migration 依赖。

### 15.2 Host Authorization

- 模型不能指定 verifier/tool/timeout/arguments。
- Original Unknown Write 是 `write + unknown`。
- 无关 Review / Submission / Original Write / Task 全部拒绝。
- Allowlist metadata、version、schema hash、timeout 必须一致。
- URL fetch / local path / arbitrary resource 拒绝。

### 15.3 External Read

- dispatching 原子写 Attempt/ToolRun/Step/Event/Checkpoint。
- 外部调用不在 SQLite transaction 内。
- success / reject / timeout / cancel。
- 非协作 Promise timeout 后迟到 resolve/reject 不提交。
- authority/lease/fencing 失败时不执行或提交。
- tool registry unregister 被 execution lease 阻止。
- version_conditional actual version/ETag mismatch 不形成 EvidenceRead。

### 15.4 Transaction B

- 完整原子写入清单。
- 每个写入点故障注入 rollback。
- Intent 出现在 B 前时整笔拒绝。
- Authority 撤销后迟到结果拒绝。
- Check + EvidenceRead 同时可见或同时不可见。
- Store orphan 不生成 Manifest / Check。

### 15.5 Verification

- B 后 pending Check 只重跑 Verifier。
- 不重新执行 Read ToolRun。
- Controlled provenance 缺任一节点时拒绝。
- payloadType=readback_result 单独存在时不能形成 controlled provenance。
- passed / failed / inconclusive / registry mismatch / timeout。
- Availability / Verification Event 规则。

### 15.6 Recovery / Gate

- prepared / queued 恢复启动 Read。
- dispatching 恢复先 interrupted。
- interrupted 后创建新 Attempt。
- completed Attempt + pending Check 只 verify。
- failed/timed_out/cancelled 不重试同一 Run。
- 普通 recoverReadRuns 不处理 recovery Evidence Plan。
- Recovery Evidence Executor 不处理 agent Plan。
- 分类互斥和优先级。

### 15.7 Security

- Event / Checkpoint / AppError 不含原始 Payload、路径、URL 或 stack。
- Tool Message 使用 redacted summary。
- Snapshot 不暴露 Payload body。
- Verifier 无 Repository / UoW / DB access。
- declared readback 与 controlled runtime read 严格分离。

### 15.8 Regression

- Stage 1 Request Key / Replay。
- Stage 2 Payload Integrity。
- Stage 3 Verifier Runtime。
- Stage 4 Stored Evidence Verification Service。
- Step 6.2 Read Recovery。
- Step 6.3.1 to 6.3.4.3 全量回归。

## 16. Planned File Changes

新增：

- `src/storage/migrations/009-phase3-step6-3-4-4.ts`（仅在 §21.1
  Migration 方案获批后）
- `src/storage/recovery-evidence-readback-reservation-repository.ts`
- `src/recovery/recovery-evidence-readback-service.ts`
- `src/recovery/recovery-evidence-readback-executor.ts`
- `src/recovery/recovery-evidence-controlled-provenance.ts`
- `tests/recovery/recovery-evidence-readback-service.test.ts`
- `tests/recovery/recovery-evidence-readback-executor.test.ts`
- `tests/recovery/recovery-evidence-readback-recovery.test.ts`
- `tests/storage/step6-3-4-4-schema.test.ts`
- `docs/PHASE3_STEP6_3_4_4_DEVELOPMENT_REPORT.md`

修改：

- `src/recovery/recovery-readback-tool-registry.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-types.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/index.ts`
- `src/storage/migrations/index.ts`

必要测试扩展：

- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/recovery/recovery-readback-tool-registry.test.ts`
- `tests/recovery/recovery-verifier-runtime.test.ts`
- `tests/recovery/recovery-evidence-verification-service.test.ts`
- `tests/recovery/recovery-classifier.test.ts`
- `tests/recovery/read-recovery.test.ts`

不计划修改：

- Migration v8。
- 已应用 Migration v4-v8。
- `package.json` / lockfile。
- Task 状态机。
- RecoveryReview final decision。

计划新增 Migration v9，但必须先通过 §21.1 的单独架构评审。

## 17. Implementation Order

1. Host result/source contract 与 ToolRegistry revalidation。
2. Migration v9 reservation + repository + schema tests，先单独评审。
3. Parent Preparation builder 与 Transaction A。
4. dispatching / failure / recovery UoW。
5. Recovery-only Read Executor。
6. controlled EvidenceRead payload 与 Transaction B。
7. controlled Verification integration。
8. Recovery Manager / Scanner / Classifier purpose isolation。
9. 故障注入、E2E 和全量回归。

每一步完成后单独报告并等待评审，不一次性跨步实施。

## 18. Risks and Open Questions

### 18.1 Lazy Request Replay Schema Blocker

严格 Lazy Request Replay 需要先于异步 Host preparation 原子 reservation。
v8 没有该持久化对象，不能把 buildArguments / validateInput 放进同步
SQLite transaction。

因此当前计划保持 BLOCKED，等待 §21.1 Migration v9 评审。

### 18.2 Existing Contract Extension

要安全实现 `version_conditional`，必须扩展 Host allowlist result contract：

- result Schema。
- actual resource version / ETag extractor。
- Original Unknown Write source resolver。

该扩展不修改数据库 Schema，但会修改 Stage 6.3.4.1 的公开 Host contract。
架构评审必须确认该扩展，或者明确将 version_conditional 在 Step
6.3.4.4 中 fail closed。

### 18.3 Attempt Transition Coverage

当前 Attempt Repository 支持所需状态，但现有 UoW 没有：

- prepared -> dispatching 同时更新 ToolRun/PlanStep。
- dispatching -> interrupted。
- failed/timed_out/cancelled 同时终止 Plan/ToolRun。

实施前不得用多个独立 transaction 拼接。

### 18.4 Cancel Latency

SQLite 没有长事务内 intent notification。

计划采用：

- dispatch 前事务检查。
- Host-provided AbortSignal。
- heartbeat authority signal。
- Transaction B 前与事务内最终检查。

在外部 Tool 不响应 Abort 时，不能立即阻止其副作用，但可以阻止结果提交。

### 18.5 Payload Store / SQLite Atomicity

Payload Store 与 SQLite 不是同一事务。

允许保留 content-addressed orphan，必须测试：

- 不形成 Manifest / Check / EvidenceRead。
- 不误报成功。
- 后续相同内容写入是幂等的。

### 18.6 Failure Retry

计划禁止同一 terminal failed/timed_out/cancelled ToolRun 重新执行。

进一步 Read-back 必须：

- 新 Evidence Submission；
- 新 Request Key；
- 新 Plan / ToolRun / Attempt。

如果架构要求同一 Request 自动重试 terminal failure，必须先扩展 ToolRun
生命周期与 Request 唯一约束，不能通过复制 Attempt 绕过。

## 19. Completion Criteria

Step 6.3.4.4 实施完成必须满足：

- Lazy Request Replay reservation Migration 已单独评审并批准。
- Transaction A 完整原子。
- Begin Read 完整原子。
- Transaction B 完整原子。
- 外部 Read 位于 SQLite transaction 外。
- Lease / Fencing / ExecutionAuthority 全程生效。
- Cancel/Pause 在 UoW 内最终生效。
- Attempt 历史完整。
- 无 exactly-once 虚假声明。
- B 后崩溃只重跑 Verifier。
- controlled provenance 由完整持久链生成。
- 普通 Agent Recovery 与 Recovery Evidence Recovery 双向隔离。
- 全量测试、typecheck、diff check 通过。
- Task.status、Original Unknown Write 和 Review final decision 不变。

## 20. Documentation Boundary

本轮只新增本 Implementation Plan。

- 没有修改生产代码。
- 没有修改测试。
- 没有修改 Migration、Schema 或依赖。
- 没有创建数据库。
- 没有执行测试。
- 没有执行 Read-back、Recovery、Verifier、Provider、LLM 或 Write。
- 没有开始 Step 6.3.4.4 编码。
- 没有进入 Step 6.3.4.5 或 Step 6.3.5。

完成后停止，等待架构评审。

## 21. Final Architecture Review Corrections

### 21.1 Transaction A Lazy Request Replay

#### Actual v8 uniqueness

已核实 `recovery_evidence_readback_requests` 真实约束：

```text
PRIMARY KEY (id)
UNIQUE (request_key)
UNIQUE (operation_id)
UNIQUE (execution_plan_id)
UNIQUE (plan_step_id)
UNIQUE (read_tool_run_id)
UNIQUE (task_id, id)
UNIQUE (task_id, verification_check_id)
UNIQUE (
  task_id,
  review_id,
  evidence_submission_id,
  original_tool_run_id
)
```

已提交 Request 的稳定逻辑身份：

```text
taskId
+ reviewId
+ evidenceSubmissionId
+ originalToolRunId
```

`requestKey` 是 binding 相关的派生键，包含：

```text
expectedDecisionVersion
allowlist binding
read tool binding
verifier binding
expected version / ETag
verificationCheckId
```

因此 `requestKey` 不能作为 Host 配置尚未解析阶段的第一查找键。

#### v8 blocker

以下两项不能同时成立：

1. `buildArguments()` 和 `ToolRegistry.validateInput()` 是异步 API。
2. SQLite immediate transaction callback 必须完全同步。

现有 v8 没有“preparing request identity”持久化对象，也没有能在父
Plan/PlanStep/ToolRun 存在前保存的逻辑 Request reservation。

如果只在 Service 内做“先查已提交 Request，再异步准备配置，再调用
Transaction A”，并发窗口为：

```text
Worker A: miss -> begin async Host preparation
Worker B: miss -> begin async Host preparation
Worker A: commit Request
Worker B: UoW finds Request after current Host callbacks already ran
```

因此 B 违反“Request hit 不得调用当前 Host Config”的要求。

进程崩溃后通过 Task lease 接管也有同样问题。

结论：当前 v8 Schema 无法严格实现本轮 Lazy Request Replay。

#### Proposed minimal Migration v9

新增表：

```text
recovery_evidence_readback_request_reservations
```

建议字段：

```text
id TEXT PRIMARY KEY
task_id TEXT NOT NULL
review_id TEXT NOT NULL
evidence_submission_id TEXT NOT NULL
original_tool_run_id TEXT NOT NULL
request_id TEXT NOT NULL
operation_id TEXT NOT NULL
execution_plan_id TEXT NOT NULL
plan_step_id TEXT NOT NULL
read_tool_run_id TEXT NOT NULL
read_attempt_id TEXT NOT NULL
verification_check_id TEXT NOT NULL
owner_token TEXT NOT NULL
owner_fencing_token INTEGER NOT NULL
status TEXT NOT NULL
  CHECK (status IN ('preparing', 'completed', 'abandoned'))
reservation_version INTEGER NOT NULL
created_at TEXT NOT NULL
updated_at TEXT NOT NULL
```

建议约束：

```text
UNIQUE (
  task_id,
  review_id,
  evidence_submission_id,
  original_tool_run_id
)
UNIQUE (task_id, verification_check_id)
UNIQUE (request_id)
UNIQUE (operation_id)
UNIQUE (execution_plan_id)
UNIQUE (plan_step_id)
UNIQUE (read_tool_run_id)
UNIQUE (read_attempt_id)
```

外键：

- Task。
- Review。
- Evidence Submission。
- Original ToolRun。

不提前对 Plan / PlanStep / Read ToolRun 建 FK，因为 reservation 必须先于
这些父记录存在。

#### Reservation transaction

```text
Lease / Fencing / Authority
  -> lookup completed Request by stable logical identity
  -> completed:
       -> optional expected requestKey comparison
       -> load persisted Operation / Attempt
       -> return original result
       -> no Host callback
       -> no write
  -> reservation exists + preparing:
       -> another owner: return in_progress
       -> stale lease owner: claim with current fencing / new ownerToken
  -> reservation exists + abandoned:
       -> claim with current fencing / new ownerToken
  -> reservation absent:
       -> insert preparing reservation
       -> return ownerToken
```

`ownerToken` 由 Host 内部生成，不来自模型。

#### Host preparation

只有成功取得 reservation ownerToken 的 Worker 可以调用：

```text
Verifier Host Binding
Allowlist exact lookup
Source Resolver
buildArguments
ToolRegistry.validateInput
```

另一个并发 Worker看到 `preparing` 时只能返回 in_progress，不能调用当前
Host callbacks。

#### Commit transaction

```text
Lease / Fencing / Authority
  -> validate reservation ownerToken / fencing / version
  -> lookup completed Request by stable logical identity
  -> completed unexpectedly:
       -> conflict / inconsistent reservation
  -> ParentPreparation
  -> Transaction A writes
  -> reservation preparing -> completed
```

Reservation commit 与 Transaction A 必须同一 immediate transaction。

如果 Host preparation 抛错：

- 仍有 ownership 时可把 reservation 标记 abandoned。
- 无法写状态时保留 preparing，由 lease takeover 判定 stale。
- 不创建部分 Plan / Request / Event / Checkpoint。

#### Replay identity comparison

已提交 Request Replay 必须比较调用方可见的稳定 binding：

```text
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
optional requestKey
```

如果调用方提供 `requestKey`，必须与历史 Operation / Request 一致。
不提供时可返回 stable logical identity 对应的原结果，但不得替换 binding。

### 21.2 Transaction B Exact Replay

Transaction B 的 Replay 不以 final Verification requestKey 为第一依据。

权威查重对象：

```text
readbackRequestId
readAttemptId
readToolRunId
verificationCheckId
resultPayloadDigest
resourceVersion
resourceEtag
EvidenceRead
Verification Check intent
```

实际约束依据：

```text
recovery_evidence_verification_checks.UNIQUE(readback_request_id)
recovery_evidence_reads.UNIQUE(task_id, verification_check_id)
recovery_evidence_reads.UNIQUE(evidence_submission_id, tool_run_id)
```

事务顺序：

```text
Lease / Fencing / Authority
  -> load Request
  -> Check by readbackRequestId
  -> EvidenceRead by Check / verificationCheckId
  -> B committed:
       -> immutable binding comparison
       -> digest / version / ETag comparison
       -> return persisted EvidenceRead + Check
       -> no write
  -> B not committed:
       -> Cancel/Pause gate
       -> validate running ToolRun + dispatching Attempt
       -> atomic B writes
```

检查存在但 EvidenceRead 缺失，或 EvidenceRead 存在但 Check 缺失，均为
inconsistency，不得自动补造。

Verification Service Replay 是后续独立边界，继续按 final Verification 和
verification requestKey 判定。

### 21.3 ToolRun / ReadAttempt Lifecycle

逻辑模型：

```text
Readback Request = logical request
ToolRun = logical tool invocation
ReadAttempt = external I/O attempt
```

固定语义：

- 同一 Request 的恢复重试保持同一个 `readToolRunId`。
- 每次外部 I/O Attempt 使用新 `readAttemptId`。
- `ReadAttempt.attemptNumber` 单调递增。
- `ToolRun.attemptNo` 固定为 1，表示 logical invocation creation；
  不用于表示外部 I/O Attempt。
- 两者明确独立，不要求数值相等。

恢复 UoW：

```text
recoverOwnedRecoveryEvidenceReadAttempt()
```

在同一 immediate transaction：

```text
Lease / Fencing / Authority
  -> old Attempt dispatching -> interrupted + Event
  -> ToolRun running -> interrupted
  -> PlanStep running -> interrupted
  -> allocate new attemptNumber
  -> ToolRun interrupted -> queued
  -> PlanStep interrupted -> queued
  -> new Attempt prepared + Event
  -> Checkpoint
```

并发恢复由 SQLite immediate transaction 串行化。只有一个 Worker 能取得
下一次 active Attempt。

状态枚举均来自现有 Schema：

```text
ExecutionPlan: active | completed | failed | cancelled
PlanStep: queued | running | interrupted | completed | failed | cancelled
ToolRun: queued | running | interrupted | succeeded | failed |
         timed_out | cancelled
ReadAttempt: prepared | dispatching | interrupted | completed |
             failed | timed_out | cancelled | blocked_by_intent
```

`failed / timed_out / cancelled` ToolRun 为终态。不得为同一 ToolRun 创建
新 Attempt。进一步 Read 必须使用新 Evidence Submission、新 Request、
新 Plan、新 ToolRun。

### 21.4 Immutable Host Allowlist Contract

发布合同以 Digest 版本表达：

```text
allowlistVersion =
  sha256(JCS(Allowlist Immutable Contract))
```

合同字段：

```text
protocolVersion
allowlistId
sourceResolverId / sourceResolverVersion
argumentBuilderId / argumentBuilderVersion
toolName / toolVersion / toolInputSchemaHash
resultSchemaId / resultSchemaVersion / resultSchemaHash
resourceMetadataExtractorId / resourceMetadataExtractorVersion
retrySafety
timeoutMs
maximumPayloadBytes
sensitiveOutputPolicy
```

当前 `allowlistVersion` 最大长度 64，64 lowercase hex 可放入现字段。

注册必须拒绝：

- version 与 contract digest 不一致。
- 同一 allowlistId + version 对应不同 digest。
- 缺少 source/builder/result/extractor identity 或 version。
- result Schema 不可 canonical hash。
- Sensitive Output Policy 非结构化或不可 canonical JSON。

历史 Request 只信任持久化 `allowlistId + allowlistVersion`。Registry
必须能精确恢复该版本；否则 fail closed。

### 21.5 Version-Conditional Trust

expected 来源仅允许：

- Host-controlled request input。
- Host policy 验证后的 Original Unknown Write source binding。

禁止来源：

- 模型输出。
- 普通用户自由文本。
- Tool output 中未经 extractor 验证的字段。
- Evidence Summary。

每个 Attempt：

```text
expectedResourceVersion != NULL
  -> actualResourceVersion must exist and equal

expectedEtag != NULL
  -> actualEtag must exist and equal
```

实际值缺失视为 mismatch。

比较必须在 Payload Store 写入前完成。mismatch 时：

- Attempt failed + stable reasonCode。
- 不写 Payload Store。
- 不生成 EvidenceRead / Check。
- 不自动接受新版本。

### 21.6 External Dispatch Final Gate

顺序：

```text
ToolRegistry execution lease acquired
  -> Lease ownership check
  -> fencing check
  -> mandatory ExecutionAuthority
  -> combined AbortSignal check
  -> latest persisted Cancel/Pause check
  -> beginOwnedRecoveryEvidenceRead()
  -> executeValidated()
```

如果 external Tool 尚未开始且 gate 失败：

- ownership 仍可写时，专用 UoW 原子写 Attempt blocked/cancelled 和
  Plan/Step 终止状态。
- ownership 已失时，保留 prepared Attempt 等待 Recovery。
- 不能停在无解释的 dispatching。

Tool 一旦开始，权限或 Intent 失效只能 best-effort abort；迟到结果由
Transaction B authority / intent gate 拒绝。

### 21.7 Payload Store Orphan

- Store 成功、B 失败可留下 orphan。
- orphan 不是成功证据。
- 恢复只相信数据库关系，不相信 Store 文件存在。
- 本阶段不实现 GC。
- 不得在 Event / Tool Message / Checkpoint 写 raw Payload。
- 后续 GC 只能删除无 Request / EvidenceRead / Check 引用的内容。
- 相同内容重复写入必须保持 content-addressed 幂等。

### 21.8 Request-Level Recovery Classification

Recovery Classification 单位：

```text
taskId + readbackRequestId + executionPlanId
```

同一 Task 可以同时拥有：

```text
Request A: recovery_read_interrupted
Request B: recovery_verification_pending
```

恢复选择器必须：

- 按 Request 分类。
- 每个 Request 独立选择 Read Executor 或 Verification Executor。
- 同一 Request 的 B Check + interrupted Attempt 判定
  `state_inconsistent`。
- Verification pending 不得重跑 Read。
- Read pending 不得执行其他 Request 的 Verification。
- 普通 Agent Recovery 与 Recovery Evidence Recovery 双向隔离。

### 21.9 Controlled Verification Capability

`VerifiedControlledReadbackProvenance` 使用 module-private WeakMap。

普通 object、boolean、TypeScript cast 均不可构造。

Capability 生成前必须在同一 Snapshot 中验证：

```text
Request
Attempt completed
ToolRun succeeded
exactly one Tool Message
PlanStep completed
EvidenceRead
Check origin=readback_transaction_b
```

Runtime 只能从 capability 获取：

```text
readbackRequestId
readAttemptId
readToolRunId
toolMessageId
evidenceReadId
```

并据此设置 `hasReadback=true` 和 readback IDs。

Payload binding 只使用 EvidenceRead：

```text
resultPayloadDigest
resultPayloadStoreRef
resultPayloadStorageMode
```

绝不回退到 Manifest.payloadStoreRef。

### 21.10 Added Test Requirements

- Completed Request Replay 不调用 Host callbacks。
- Reservation in_progress 不调用 Host callbacks。
- 双 Worker 同时 miss 时只有一个取得 ownerToken。
- Owner crash 后 stale reservation 被新 Lease 接管。
- Reservation commit 故障注入整体 rollback。
- 相同 logical identity + different requestKey/binding 拒绝。
- B exact replay 使用 Request / Attempt / EvidenceRead / Check。
- B binding 或 digest/version mismatch 拒绝。
- B Check 存在但 EvidenceRead 缺失判 inconsistency。
- ToolRun.attemptNo 与 ReadAttempt.attemptNumber 独立。
- interrupted -> queued + new prepared Attempt 同事务。
- failed/timed_out/cancelled 不得新 Attempt。
- Allowlist Version 等于 contract digest。
- 同 id/version 不同 contract 拒绝。
- expected actual 缺失、mismatch、success。
- Last-second dispatch gate failure 不进入 dispatching。
- Orphan 不被识别为 B success。
- 同 Task A read pending + B verification pending 独立分类。
- 同 Request B Check + interrupted Attempt 判 inconsistency。
- Controlled provenance 不可由普通 object/cast 伪造。

### 21.11 Remaining Schema Gap

尚未解决的唯一 Schema 缺口：

```text
recovery_evidence_readback_request_reservations
```

没有该表就无法严格保证 Request miss 到 ParentPreparation 之间的跨 Worker
唯一性，也无法避免并发 Request 命中前重复调用当前 Host callbacks。

该 Migration 尚未批准，也尚未实施。

在架构评审批准最小 Migration v9 前：

- Step 6.3.4.4 状态保持 BLOCKED。
- 不得用进程内 mutex 代替跨进程数据库语义。
- 不得先调用当前 Host callbacks 再声称 Lazy Replay。
- 不得修改已应用 v4-v8 Migration。

### 21.12 Correction Boundary

最终修正轮只更新本 Implementation Plan。

- 没有修改生产代码。
- 没有修改测试。
- 没有修改 Migration 或 Schema。
- 没有新增依赖。
- 没有创建数据库。
- 没有执行测试。
- 没有执行 Read-back、Recovery、Verifier、Provider、LLM 或 Write。
- 没有开始 Step 6.3.4.4 实施。

完成后停止，等待最终架构评审。
