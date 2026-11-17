# Phase 3 Step 6.3.4.4 Remaining Implementation Plan

> 状态：设计修订版，等待最终架构评审。本文仅定义剩余 Stage 的设计与
> 实施顺序，尚未授权生产代码开发。
>
> 数据库基线：Migration v9。
>
> 已完成：Migration v9 Reservation Foundation、Stage 1 Host Readback
> Contract、Stage 2 Reservation Integration / Transaction A。
>
> 未完成：Stage 3 Dispatch/Failure/Recovery UoW、Stage 4 External Read /
> Transaction B、Stage 5 Controlled Provenance / Verification、Stage 6
> Recovery Manager / Classifier。
>
> 独立后续：Step 6.3.5 Final RecoveryReview。

## 1. 当前状态与封存范围

### 1.1 已封存能力

Migration v9：

```text
recovery_evidence_readback_request_reservations
```

已支持：

- stable logical Request identity。
- ownerToken / fencing takeover。
- preparing / completed / abandoned。
- reservation_version CAS。
- Transaction A completion invariant。
- 历史 v8 Request 无 Reservation 兼容。

Stage 1：

- Host-only Readback Tool contract。
- immutable allowlistVersion Digest。
- Source Resolver / Argument Builder identity。
- Result Schema / Metadata Extractor。
- Resource scheme 白名单。
- Maximum Payload Bytes / Sensitive Output Policy。
- ToolRegistry exact metadata validation。

Stage 2：

- request intent digest。
- Reservation acquire / reenter / takeover / reclaim。
- Host Preparation。
- ParentPreparation。
- Recovery Evidence Plan / PlanStep / queued ToolRun。
- Request / request_readback Operation / Prepared Attempt #1。
- Transaction A atomic completion。
- Task-wide Cancel / Pause Intent 与 Request-scoped 收敛基础。
- Replay / concurrency / fault injection。

### 1.2 当前持久事实

```text
Task.status = waiting_review
Original Write ToolRun.status = unknown
RecoveryReview 尚未 Final Decision
Recovery Evidence Plan.status = active
Recovery Evidence PlanStep.status = queued
Read ToolRun.status = queued
Read Attempt.status = prepared
```

尚未发生：

- `prepared -> dispatching`
- ToolRun `queued -> running`
- 真实 External Read
- Transaction B
- EvidenceRead
- Controlled Provenance
- Controlled Verification
- Recovery Evidence request-scoped classification

本文修订日期：2026-11-08。

本轮修订重点：

- Final consistency pass：Request-level Cancel convergence、Task-wide
  Cancel / Pause Intent、Recovery Lineage Exact Replay、同步执行启动门。
- 补齐 Cancel 对 prepared / dispatching / blocked_by_intent / interrupted /
  terminal / Transaction B completed 的入口合同。
- Pause control-plane 与执行 Lease 分离；Host Pause 可在 Worker 持锁时
  提交 Task-wide Intent。
- 明确 Allowlist Contract Digest 持久化在 Request.allowlist_version，
  无需新增 digest 列。
- Verifier retry governance metadata 进入 v2 Effective Config Digest。
- 将 External Read 的启动责任统一归属 Stage 4，Stage 3 只实现 Dispatch
  UoW，避免两个 Stage 重复 dispatch。
- 将 Retry Safety、历史 Allowlist Version、Expected Version / ETag、
  Lease / Fencing / Authority 组合为外部 Read 前的强制 gate。
- 明确 `ToolRun.input_json` 保存的是 Zod 规范化后的输入，而不是原始
  候选输入或可跨进程复用的 `ValidatedToolInput` capability。
- 保持现有 `jcs-sha256-v1`、Storage Digest、content-addressed Store Ref
  和 Allowlist Contract 四层协议，不把整体语义简化成裸 Payload SHA-256。
- 修正 Recovery 接管前提，禁止仅凭 `Attempt=dispatching` 和
  `ToolRun=running` 就改写为 `interrupted`。
- 以真实 ExecutionPlan / PlanStep / ToolRun / ReadAttempt 状态机为准，
  修正 `PlanStep interrupted -> running` 与 `ToolRun interrupted -> queued`。

## 2. 当前源码接口核查

### 2.1 ReadAttempt 实际状态与转换

`RecoveryEvidenceReadAttemptStatusSchema`、Attempt Repository 转换表和
Migration v8 Trigger 共同支持：

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

真实转换：

```text
prepared
  -> dispatching
  -> cancelled
  -> blocked_by_intent

dispatching
  -> completed
  -> interrupted
  -> failed
  -> timed_out
  -> cancelled

interrupted / completed / failed / timed_out / cancelled /
blocked_by_intent
  -> 对该 Attempt 均为终态
```

Attempt 的 `interrupted` 是单次 Attempt 的终态，不能在原地恢复；后续外部
Read 必须创建 `attempt_number + 1` 的新 Attempt。

### 2.2 ToolRun / PlanStep / ExecutionPlan 实际状态

ToolRun：

```text
queued
awaiting_approval
running
interrupted
succeeded
failed
timed_out
unknown
cancelled
skipped
```

Recovery Read 只使用 Read ToolRun，不使用 `unknown` 表示外部 Read
不确定性。`unknown` 继续保留给原 Agent Write 语义。

现有 `ExecutionStateMachine` 对 Read ToolRun 的真实转换：

```text
queued -> running | failed | skipped | cancelled
running -> succeeded | failed | timed_out | cancelled | interrupted
interrupted -> queued | failed | skipped | cancelled
terminal -> no transition
```

PlanStep：

```text
queued
running
awaiting_approval
waiting_review
interrupted
completed
failed
skipped
cancelled
```

现有 PlanStep 转换包含：

```text
queued -> running | awaiting_approval | failed | skipped | cancelled
running -> completed | failed | cancelled | waiting_review | interrupted
interrupted -> running | failed | skipped | cancelled
terminal -> no transition
```

结论：`PlanStep interrupted -> queued` **不受现有 ExecutionStateMachine
支持**。Recovery 后只能使用 `PlanStep interrupted -> running`；只有
ToolRun 支持 `interrupted -> queued`。Stage 3 不得通过通用
`PlanStepRepository.updateStatus()` 绕开该状态机。

ExecutionPlan：

```text
active
completed
failed
cancelled
```

当前没有 `interrupted` Plan 状态，也没有 `ExecutionPlanRepository` 的
状态更新方法。逻辑计划在 Attempt 中断时保持 `active`；成功、确定失败或
取消分别收敛到 `completed`、`failed`、`cancelled`。

### 2.3 当前 UoW

已有：

- `createOwnedRecoveryEvidenceReadbackRequest`。
- `createOwnedRecoveryEvidenceReadAttemptPrepared`。
- `transitionOwnedRecoveryEvidenceReadAttempt`。
- `completeOwnedRecoveryEvidenceRead`。
- `recordOwnedRecoveryEvidenceVerification`。
- Recovery Readback Reservation UoW。

缺口：

- 没有 Attempt + ToolRun + PlanStep 的原子 dispatch UoW。
- 没有 dispatching -> interrupted + new Attempt 的 Recovery UoW。
- 没有统一 terminal failure / timeout / cancellation UoW。
- `createOwnedRecoveryEvidenceReadAttemptPrepared` 尚未阻止 terminal
  ToolRun 或 terminal Request 的新 Attempt。
- `completeOwnedRecoveryEvidenceRead` 尚未更新 ExecutionPlan status。
- `completeOwnedRecoveryEvidenceRead` 的 Replay 仍主要围绕 Verification
  requestKey，需要改成 Transaction B 自身复合幂等边界。
- `recordOwnedRecoveryEvidenceVerification` 需要为 controlled readback
  增加 capability、EvidenceRead binding 和新写入分支 intent gate。
- 没有 Host-only Pause set / clear UoW。
- 没有 Failure / Cancel / Pause / Resume / Recovery 的 Exact Replay
  统一规则。

### 2.4 Tool Input 持久化语义

Stage 2 的实际调用链：

```text
Host buildArguments()
  -> ToolRegistry.validateInput()
       -> Zod safeParseAsync()
       -> Transform / Async Refinement 执行
       -> JSON round-trip
       -> deepFreeze()
       -> ValidatedToolInput + process-local WeakMap token
  -> ToolRun.input_json = normalized ValidatedToolInput.value
  -> ToolRun.canonical_input_hash = hash(normalized value)
```

因此：

- 原始 Host 候选输入只在 Stage 2 进程内短暂存在，不保证持久化。
- `ToolRun.input_json` 是 Schema 验证和 Transform 后的规范化 JSON 值。
- `ValidatedToolInput` 是进程内 capability，不是可持久化数据。
- 进程重启后该 WeakMap token 必然失效。
- `executeValidated()` 只接受当前 ToolRegistry 实例签发且仍在 WeakMap
  中的 token，不会再次执行 Zod parse / transform / async refinement。

Stage 4 必须从持久化规范化输入重新取得新的进程内 capability，不能从
数据库伪造 `ValidatedToolInput`，也不能为通过 token 校验而新增旁路
API。该重新验证会让 Transform / Async Refinement 再次执行，因此 Schema
必须满足确定、纯、对规范化输入幂等且无外部 I/O。

### 2.5 Payload Store 与 Digest 协议

当前 Payload Store：

```text
put(bytes, expectedStorageDigest) -> content-addressed storeRef
read(storeRef, expectedStorageDigest) -> bytes
```

三层值必须分开：

```text
Semantic Digest
  = 既有 Readback Result Schema parse + JCS canonical bytes + SHA-256

Storage Digest
  = 实际写入文件的 canonical bytes SHA-256

Store Ref
  = evidence-file:sha256/<storage digest hex>
```

Readback payload 的现有语义协议是 `jcs-sha256-v1`，实际 helper 为
`computeReadbackResultPayloadDigest()`：

```text
parse(RecoveryReadbackResultSchema)
  -> JCS
  -> SHA-256
```

`resultSchemaId / resultSchemaVersion / resultSchemaHash` 不属于当前
`computeReadbackResultPayloadDigest()` 的哈希输入；它们进入 Immutable
Allowlist Contract，并由 `allowlistVersion` 固定。因此整体协议是：

```text
exact allowlistId + allowlistVersion
  -> exact Result Schema identity/version/hash
  -> exact Result Schema validation
  -> fixed RecoveryReadbackResult normalization
  -> existing jcs-sha256-v1 semantic digest
  -> separate storage digest / Store Ref
```

不得把整体协议简化为“任意 Tool Output 的 SHA-256”，也不得未经批准把
schema identity 塞入 `jcs-sha256-v1` 的输入。若架构要求把 schema
identity 直接并入 Digest 输入，这是新的 payload protocol version，必须
单独评审并保持历史协议可验证。

当前 raw / json / readback canonical 写入路径可能得到相同的 Storage
Digest 与 Semantic Digest，但实现仍必须分别计算和比较，不能把二者
视为同一合同字段。

文件系统与 SQLite 不共享事务。

### 2.6 Controlled Verification 与 Recovery 缺口

当前：

- Verification Service 主要处理 Stored Evidence V0 Manifest payload。
- Verifier Runtime 强制：

```text
readbackToolRunId = null
toolMessageId = null
hasReadback = false
```

- 没有 EvidenceRead Payload binding loader。
- 没有不可伪造的 controlled provenance capability。
- `recoverReadRuns()` 只从 `agentExecutionPlans` 选择 PlanStep。
- `RecoveryClassifier` 仍以 Task 级报告为主。
- TaskSnapshot 尚未投影 Reservation。

### 2.7 Retry Safety / Consistency Mode 真实枚举

源码依据：

- `src/storage/types.ts`
  - `RecoveryEvidenceReadbackRetrySafetySchema`
  - `RecoveryEvidenceReadbackConsistencyModeSchema`
- `src/recovery/recovery-readback-tool-registry.ts`
  - `RecoveryReadbackToolDefinitionSchema.superRefine()`
  - `assertContextMatchesRetrySafety()`
- `src/storage/migrations/008-phase3-step6-3-4-2.ts`
  - Request 表的 `retry_safety` / `consistency_mode` CHECK。
- `tests/recovery/recovery-readback-tool-registry.test.ts`
  - 非法 enum、非法组合和 version-conditional request binding 测试。
- `tests/storage/step6-3-4-2-schema.test.ts`
  - Request 持久化组合约束。
- `tests/storage/step6-3-4-4-schema.test.ts`
  - 当前 Reservation / Request binding 组合。

真实枚举：

```text
retrySafety:
  immutable
  version_conditional

consistencyMode:
  immutable_version
  etag_or_resource_version
```

不存在的值：

```text
mutable_current_state
current_state_only
```

Registry 和生产 Schema 当前只允许：

| retrySafety | consistencyMode | Expected binding |
|---|---|---|
| immutable | immutable_version | `expectedResourceVersion = NULL` 且 `expectedEtag = NULL` |
| version_conditional | etag_or_resource_version | 至少一个 Expected 非 NULL |

Version-conditional 实际比较：

| expectedResourceVersion | expectedEtag | Actual 要求 |
|---|---|---|
| 非 NULL | NULL | Actual resourceVersion 必须存在并精确匹配 |
| NULL | 非 NULL | Actual ETag 必须存在并精确匹配 |
| 非 NULL | 非 NULL | 两个 Actual 都必须存在并分别精确匹配 |
| NULL | NULL | Schema 拒绝该 Request 组合 |

`retrySafety` 决定是否允许重复调用；`consistencyMode` 决定 Expected /
Actual 的比较模式。二者是独立字段，但当前 Registry / SQLite 将合法组合
限制为上表两种。不得在文档或实现中声明存在 `mutable` 等未实现枚举。

### 2.8 Verifier Effective Config 当前覆盖范围

源码依据：

- `src/recovery/recovery-verifier-runtime.ts`
  - `RecoveryVerifierEffectiveConfigSchema`
  - `RecoveryVerifierHostBindingDefinitionSchema`
  - `RecoveryVerifierHostBindingProvider`
- `tests/recovery/recovery-verifier-runtime.test.ts`
  - config digest、timeout、历史 binding 恢复测试。

当前 Effective Config / `verifierConfigDigest` 覆盖：

```text
protocolVersion
verifierId
verifierVersion
timeoutMs
ruleConfig
```

当前没有显式、不可变地覆盖：

```text
Verifier retrySafety declaration
read-only / side-effect policy
deterministic execution contract identity
duplicate-computation safety declaration
```

因此本计划要求扩展 Host Verifier Contract / Effective Config：

```text
protocolVersion = forgeflow.recovery-verifier-effective-config.v2
governance:
  retrySafety: retry_safe | manual_only
  readOnlyRequired: true
  externalSideEffects: forbidden
  deterministic: required
  executionContractId
  executionContractVersion
  executionContractDigest
```

这些 metadata 必须进入 `sha256(JCS(Effective Config))`。数据库仍只持久化
既有 verifierId / version / config digest，因此不需要新增 Migration。
历史 v1 Binding 缺少该 governance digest 时不得自动 retry，只能 manual
Review；新 v2 binding 通过新的 config digest 独立持久化。

### 2.9 Allowlist Contract Digest 持久化核查

源码依据：

- `src/recovery/recovery-readback-tool-registry.ts`
  - `AllowlistVersionSchema = /^[0-9a-f]{64}$/`
  - `computeRecoveryReadbackAllowlistVersion()`
  - 注册时重新计算 Contract Digest 并与 `allowlistVersion` 比较。
- `src/storage/migrations/008-phase3-step6-3-4-2.ts`
  - Request 表字段：`allowlist_id`、`allowlist_version`。
- `src/storage/migrations/009-phase3-step6-3-4-4.ts`
  - Reservation 不重复存 Allowlist；通过 `request_id` 关联 Request。
- `src/recovery/recovery-evidence-readback-service.ts`
  - Host Preparation 从 Registry exact version 读取后将
    `allowlist.allowlistVersion` 写入 Transaction A。
- `src/storage/recovery-evidence-unit-of-work.ts`
  - Transaction A / Request replay 比较 `allowlistId` /
    `allowlistVersion`。

结论：

- 数据库不存在名为 `allowlistContractDigest` 的独立列。
- 既有字段 `recovery_evidence_readback_requests.allowlist_version` 就是
  Allowlist Contract Digest，不是任意人类可读版本号。
- SQLite v8 对该列只检查非空；64 lowercase hex 与 Contract Digest 语义由
  Stage 1 Registry / Application Schema 和执行前验证保证。
- v9 Reservation 只有 `request_id` 关联，不另存 digest；历史合同身份由
  Request 的 `allowlist_id + allowlist_version` 提供。
- Transaction A 写入值来自已注册 exact Allowlist 的
  `allowlistVersion`。
- Stage 3.2 Dispatch 前的 transaction 外 preflight 必须调用
  `Registry.getExact(allowlistId, allowlistVersion)`；UoW transaction 内
  重新比较 Request / RetryPreflightBinding 的 `allowlistId` /
  `allowlistVersion`。
- Stage 3.4 `RetryPreflightBinding` 必须包含 `allowlistId` 与
  `allowlistVersion`，不新增重复 digest 字段。
- 跨进程恢复时必须重新执行：

```text
getExact(allowlistId, allowlistVersion)
  -> recompute Contract Digest
  -> compare recomputed digest == persisted allowlistVersion
  -> revalidate Tool input/result schema hashes and registry metadata
```

因此当前 Schema 足以证明历史 Contract 身份，不需要 Migration v10。若未来
允许同一 ID/version 对应不同合同，必须另有治理变更；当前 Registry 明确
拒绝重复注册。

## 3. 剩余整体流程

```text
Stage 2 已提交:
  Recovery Evidence Plan
  PlanStep queued
  Read ToolRun queued
  Readback Request
  Attempt prepared

Stage 3:
  只实现 Dispatch / Failure / Recovery UoW
  prepared -> dispatching
  ToolRun queued -> running
  PlanStep queued -> running（首次 dispatch）
  persist dispatch authorization
  不调用 External Read

Stage 4:
  Read Executor Preparation
    exact Allowlist Version
    load persisted normalized ToolRun.input
    rebuild one process-local ValidatedToolInput
    retry safety / version binding gate
  -> call Stage 3 Dispatch UoW exactly once
  -> SQLite COMMIT
  -> recheck local Authority / Cancel / Pause
  -> external Read outside SQLite
  validate Result
  extract metadata
  conditional version check
  canonical payload
  Payload Store
  Transaction B
    ToolRun succeeded
    Tool Message
    PlanStep completed
    Plan completed
    Attempt completed
    Verification Check intent
    EvidenceRead
    Events
    Checkpoint

Stage 5:
  verify complete persistent provenance chain
  load EvidenceRead payload
  Runtime Integrity
  Host Verifier
  Transaction C / Verification record

Stage 6:
  request-scoped classification
  dedicated recovery selection
  valid lease / fencing takeover
  retry safety gate
  new Attempt dispatch / verify-only / manual fail closed

Step 6.3.5:
  final RecoveryReview decision
  original Unknown Write resolution
  Task / Plan terminal convergence
```

Stage 3 与 Stage 4 的边界是单向的：

- Stage 3 拥有唯一的 Dispatch Transaction 实现，但不执行 External Read。
- Stage 4 在执行准备完成后调用 Stage 3 Dispatch UoW。
- Dispatch Transaction 提交后，Stage 4 只能在事务外调用一次外部 Read。
- Stage 4 不得再次创建 dispatching 状态、再次提交 Dispatch Transaction，
  也不得把 `beginDispatch()` 的成功重放当作新的外部调用授权。

## 4. 全局不变量

### 4.1 Task / Review

- Task 在 Step 6.3.4.4 全部剩余 Stage 中始终 `waiting_review`。
- RecoveryReview 不进入 Final Decision。
- Original Unknown Write 始终 `unknown`。
- Original ToolRun、PlanStep、ExecutionPlan 和 Event 的历史审计字段不得
  被覆盖或重写。
- 不执行新的 Agent Write。
- 任何 Recovery 自动动作都不得修改 Task.status、RecoveryReview status
  或 Final Decision。

### 4.2 Authority

- 每个写 UoW 都检查 Lease ownership / fencing / ExecutionAuthority。
- 旧 owner 的迟到结果不能提交。
- Authority revoke 先于 Abort signal 可见。
- Abort 成功不代表外部调用没有发生。

### 4.3 Transaction

- SQLite 多记录状态转换必须在 immediate transaction。
- External Read / Verifier 不得位于 SQLite transaction callback 内。
- Registry exact lookup、Host Resolver / Builder、Verifier Binding 解析
  和外部 I/O 均在 transaction 外。
- UoW 只校验重新读取的持久化字段、Contract Digest、版本、ID 和状态绑定，
  不信任 transaction 外 Snapshot 作为写授权。
- StorageWritePermit 只在 transaction 内使用。

### 4.4 Trust

- Integrity != Authenticity。
- Digest match 不证明来源可信。
- Payload file exists != EvidenceRead committed。
- `payloadType=readback_result` != controlled provenance。
- Readback success != Original Write success。

### 4.5 Historical Compatibility

- 有完整 v9 completed Reservation 的 Request 才能进入新的 Dispatch。
- v8 historical Request 没有 Reservation 时，只允许历史查询和完整事实
  Replay。
- 不存在 Reservation 的历史 Request 不得伪造 Reservation，也不得进入
  External Read 或创建新的 Read Attempt。
- 历史 Request 已有完整 Transaction B 时，可只读 Replay；不完整时必须
  fail closed 或进入人工 Review。

### 4.6 Stage Boundary

- Phase 3.4.4 未完成并通过评审前，不设计或实施 Step 6.3.5 代码。
- Step 6.3.5 的最终决策不得通过覆盖原始 Unknown Write 的历史来表达。

### 4.7 Global Intent Precedence

所有执行与写入 UoW 使用同一优先级：

```text
Cancel > Pause > Normal Operation
```

覆盖范围：

- Stage 3.2 Dispatch UoW。
- Stage 3.3 Failure / Cancel / Pause / Resume。
- Stage 3.4 Interrupted Recovery。
- Stage 4.4 Transaction B。
- Stage 5.4 Verification UoW。
- Stage 6.3 Recovery Executor。

约束：

- 每次 new write 都在 SQLite immediate transaction 内重新读取最新
  `cancelRequestedAt` / `pauseRequestedAt` 与 Event generation。
- transaction 外 Snapshot 只能用于提前退出，不能作为 Intent 授权。
- Cancel 先于 Pause；Cancel 存在时不得执行 Pause Resume、Retry 或新
  Attempt。
- Pause 存在时不得执行 Normal Dispatch / Read / B / 新 Verification。
- 已提交 Transaction B、已存在 Verification 与历史 terminal 状态只能
  Exact Replay，不得被 Cancel / Pause 回滚、删除或覆盖。

### 4.8 Intent Scope

根据现有 `tasks.cancel_requested_at` 与 `tasks.pause_requested_at`，本计划
明确：

- Cancel Intent 是 **Task-wide intent**。
- Pause Intent 是 **Task-wide intent**。
- Request 不是 Intent 的拥有者；Request 只承载 Cancel / Pause 的收敛
  结果。

Task-wide Pause：

- 阻止新的 Recovery Evidence Dispatch、External Read、Transaction B。
- 阻止新的 Controlled Verification / Verifier 调用。
- Classifier 对 Readback 返回 `pause_blocked` 或对应证据状态。
- Verification Recovery 在 Pause 存在时不得启动 Verifier；检查的是同一
  Task 级 `pauseRequestedAt`，不是 Readback-only 字段。
- 已有 Verification / Transaction B / terminal 状态只允许 Exact Replay。

Task-wide Cancel：

- Host control-plane 在 `HostControlAuthorization` + Task version CAS 下写入
  `cancelRequestedAt` 与 `recovery.evidence.cancel_requested` Event；不要求
  持有执行 Worker 的 Task Lease。
- 一个 Cancel Intent generation 可以覆盖同一 Task 下多个 Recovery
  Evidence Request。
- Cancel UoW 按 Request 分别执行，幂等 key 为
  `taskId + readbackRequestId + cancelIntentEventId`。
- 一个 Request 的 Cancel 收敛失败不能伪造其他 Request 已取消。
- 已完成的 Request 返回 completed Exact Replay；未完成 Request 分别
  Cancel。
- Cancel 阻止新的 Verification；existing Verification 仅 Replay。

Event scope：

- `recovery.evidence.cancel_requested` 是 Task-wide Intent Event。
- `recovery.evidence.pause_requested` / `pause_cleared` 是 Task-wide
  Intent Event。
- `recovery.evidence.pause_observed` 绑定具体 Attempt / Dispatch Event。
- `recovery.evidence.readback_cancelled` 是 Request-scoped 收敛 Event，
  必须包含 `readbackRequestId` 与 `cancelIntentEventId`。

现有 Task 级字段足以表达 Intent；Request-scoped 收敛通过 Event /
Request binding 表达，不需要新增列。

## 5. Stage 3 — Dispatch / Failure / Recovery UoW

### Stage 3.1 State Transition & Event Matrix

前置条件：

- Stage 2 Request 已 completed Reservation。
- Request / Plan / PlanStep / ToolRun / Attempt 完整可见。
- Task = waiting_review，Review = pending/unresolved。
- 首次 dispatch：Attempt = prepared、ToolRun = queued、Plan = active、
  PlanStep = queued。
- interrupted Retry：Attempt = prepared、ToolRun = queued、Plan = active、
  PlanStep = running。
- 无 Reservation 的 v8 historical Request 不满足前置条件，只能 Replay。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/execution-plan-repository.ts`
- 复用现有 Event、Checkpoint、ToolRun、PlanStep Repository。

状态转换：

- 只允许下表列出的转换；表中未列出的转换一律拒绝。

事务边界：

- 下表每个多记录状态转换必须在一个 SQLite immediate transaction 内完成。
- 本 Stage 不调用 ToolRegistry、Payload Store、External Read 或 Verifier。

| 场景 | ReadAttempt | Read ToolRun | PlanStep | ExecutionPlan | Event / Checkpoint |
|---|---|---|---|---|---|
| 首次合法 dispatch | prepared -> dispatching | queued -> running | queued -> running | active | `read_attempt_dispatching`、`tool.started`、Checkpoint |
| Retry dispatch | prepared -> dispatching | queued -> running | 保持 running | active | `read_attempt_dispatching`、`tool.started`、Checkpoint |
| Cancel: prepared（首次/Retry） | prepared -> cancelled | queued -> cancelled | queued（首次）或 running（Retry）-> cancelled | active -> cancelled | `read_attempt_cancelled`、Checkpoint |
| Cancel: blocked_by_intent 无 active | 保持 blocked_by_intent | queued -> cancelled | queued/running -> cancelled | active -> cancelled | Cancel Event + Checkpoint；不改写旧 Attempt |
| Cancel: interrupted 无 active | 保持 interrupted | interrupted -> cancelled | interrupted -> cancelled | active -> cancelled | Cancel Event + Checkpoint；不改写旧 Attempt |
| Cancel: failed / timed_out / cancelled | 保持原终态 | 保持原终态 | 保持原终态 | 保持原终态 | 不强制改为 cancelled；返回 conflict / 已记录结果 |
| 首次/Retry Dispatch 前 Pause | prepared -> blocked_by_intent | 保持 queued | 保持 queued（首次）或 running（Retry） | 保持 active | `read_attempt_blocked_by_intent`、Checkpoint |
| Dispatch 后、External Read 调用前 Pause | 保持 dispatching | 保持 running | 保持 running | 保持 active | `pause_requested` + abort；不提交 Transaction B |
| External Read 执行期间 Pause | 保持 dispatching | 保持 running | 保持 running | 保持 active | `pause_requested` + best-effort abort；outcome uncertain |
| External Read 返回后、Transaction B 前 Pause | 保持 dispatching | 保持 running | 保持 running | 保持 active | `pause_requested`；丢弃本次结果，不写 EvidenceRead |
| 已授权后确定失败 | dispatching -> failed | running -> failed | running -> failed | active -> failed | `read_attempt_failed`、tool failure Event、Checkpoint |
| 已授权后超时 | dispatching -> timed_out | running -> timed_out | running -> failed | active -> failed | `read_attempt_timed_out`、tool timeout Event、Checkpoint |
| Cancel: dispatching | dispatching -> cancelled | running -> cancelled | running -> cancelled | active -> cancelled | `read_attempt_cancelled`、tool cancel Event、Checkpoint |
| 合法接管后结果不确定 | dispatching -> interrupted | running -> interrupted | running -> interrupted | 保持 active | `read_attempt_interrupted`、Checkpoint |
| Transaction B 成功 | dispatching -> completed | running -> succeeded | running -> completed | active -> completed | Stage 4 Transaction B 统一提交 |
| Cancel after Transaction B | 保持 completed | 保持 succeeded | 保持 completed | 保持 completed | 不回滚、不删除 EvidenceRead |

状态规则：

- `prepared -> failed` 和 `prepared -> timed_out` 不被现有 Schema 支持。
- `blocked_by_intent`、`interrupted`、`cancelled` 对单个 Attempt 均为
  终态。
- `blocked_by_intent` 是可恢复的 Pause 终态：Pause Intent 解除后，Host
  可以显式执行 `resumeBlockedOwnedRecoveryEvidenceRead()`，为同一
  Request / ToolRun 创建新的 Attempt。
- `interrupted` 只能由合法 Fencing Takeover 后的 Stage 3.4 产生。
- Pause 本身不写 interrupted；旧 Attempt 保持 dispatching 直到合法
  Takeover。
- `cancelled` 不可 Resume；后续执行必须建立新的明确验证请求。
- Cancel 可以在没有 active Attempt 时收敛 Request：
  - blocked_by_intent / interrupted Attempt 保持原状态，只把下游
    ToolRun / PlanStep / Plan 收敛到 cancelled。
  - 不得伪造 `blocked_by_intent -> cancelled` 或
    `interrupted -> cancelled` 的 Attempt 转换。
- Transaction B 已完成时 Cancel 不回滚 ToolRun / PlanStep / Plan，也不
  删除 EvidenceRead；只能返回持久化完成结果或状态冲突。
- failed / timed_out / cancelled Attempt 不得强制改为 cancelled；
  Cancel UoW 保持历史终态并返回 conflict 或其已记录 Exact Replay。
- 首次 Pause 时 PlanStep 保持 queued；Retry Pause 时 PlanStep 保持
  running。不得把 PlanStep 改为 queued。
- Dispatch 提交后的 Pause 没有 `dispatching -> blocked_by_intent`
  转换，也不能直接使用 interrupted；必须等待合法 Fencing Takeover。
- Pause 不改变 Task.status、Original Unknown Write 或 Review decision。
- Pause 不是 Cancel，不得套用 Cancel 的 ToolRun / PlanStep / Plan
  终态转换。
- ExecutionPlan 没有 `interrupted` 状态；中断时保持 active。
- terminal failed / timed_out / cancelled 的 ToolRun 不允许再次执行。
- Resume 后稳定组合为：new Attempt prepared、ToolRun queued、
  PlanStep running、ExecutionPlan active。

测试与验收：

- 每条合法转换恰好对应一个 Attempt Event 和 Checkpoint。
- 每条计划外转换被 Repository / UoW 拒绝。
- 任一写入失败时多记录转换整体 rollback。
- Pause 后 ToolRun / PlanStep / Plan 保持原状态。
- 本 Stage 测试证明 External Read 调用次数为 0。

不在本小节：External Read、Payload Store、Transaction B、Verification。

### Stage 3.2 Dispatch UoW

前置条件：

- Request 有 completed Reservation，Reservation Completion Invariant 通过。
- Request / Plan / PlanStep / ToolRun / Attempt 完整绑定。
- Task = waiting_review，Review = pending/unresolved。
- 当前 ownership / fencing / ExecutionAuthority 有效。
- Attempt = prepared；Plan = active。
- ToolRun = queued；PlanStep = queued（首次）或 running（Retry）。

新增接口：

```text
beginOwnedRecoveryEvidenceRead()
```

必须扩展现有 `RecoveryEvidenceUnitOfWork`，复用其 Task、Review、
ExecutionPlan、PlanStep、ToolRun、Request、Attempt、Event、Checkpoint
Repository，不另建一套重复的 Recovery Evidence 数据模型。

输入：

```text
ownership
expectedTaskVersion
requestId
attemptId
allowlistId
expectedAllowlistContractDigest（持久化字段名 allowlist_version）
expectedAttemptVersion
expectedPlanVersion
expectedPlanStepVersion
expectedToolRunVersion
```

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `tests/storage/recovery-evidence-readback-dispatch.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`

事务边界：

- 以下完整顺序在一个 SQLite immediate transaction 内执行。
- Registry exact lookup、Host Resolver / Builder、ToolRegistry 动态解析
  和 input validation 均在 transaction 外完成。
- 本 transaction 只比较持久化 allowlistId / allowlistVersion /
  readToolSchemaHash / canonicalInputHash 等字段，不调用 Host callback。
- 本 transaction 不包含 External Read、Verifier 或 Payload Store。

事务顺序：

```text
BEGIN IMMEDIATE
  -> Lease / Fencing / Authority
  -> Task waiting_review
  -> Review pending/unresolved + expected decisionVersion
  -> Reservation completed + Completion Invariant
  -> Request / Operation / Plan / PlanStep / ToolRun / Attempt identity
  -> compare persisted Request.allowlist_id / allowlist_version
     with preflight allowlistId / Contract Digest
  -> compare persisted Tool metadata / Input Schema Hash
  -> Plan active
  -> Attempt prepared
  -> ToolRun queued
  -> PlanStep queued（首次）或 running（Retry）
  -> latest Cancel Intent:
       exists -> return CancelRequired / no Dispatch
  -> latest Pause Intent:
       exists -> block_owned prepared / no Dispatch
  -> Task version CAS
  -> append read_attempt_dispatching Event
  -> Attempt prepared -> dispatching
  -> ToolRun queued -> running
  -> PlanStep queued -> running（首次）
  -> append tool.started Event
  -> Checkpoint
COMMIT
```

返回值必须区分：

```text
created
replayed-existing-dispatching
```

只有 `created` 表示本调用刚刚取得新的外部执行授权。Stage 4 不得把
replay 视为再次执行 External Read 的凭据；进程中断后的再次读取必须由
Stage 6 取得合法 ownership，通过 Retry Safety Gate，并创建新 Attempt。

并发与失败：

- Task / Attempt / ToolRun / PlanStep 全部使用 version CAS。
- 同一 Attempt 只能有一个 transaction 从 prepared 进入 dispatching。
- Lease / Fencing / Authority 失效时不写。
- Reservation 不完整、historical Request、跨 Task 或 Tool metadata
  mismatch 时不写。
- 任一 Event、Checkpoint 或状态写入失败时整体 rollback。

Dispatch Commit 与外部调用边界：

```text
COMMIT dispatching authorization
  -> return created to Stage 4
  -> Stage 4 rechecks local Authority / Cancel / Pause
  -> External Read outside SQLite
```

`dispatching` 只证明系统已持久化执行意图，不证明外部调用已经发生或成功。

状态转换：

- 首次 Dispatch：Attempt prepared -> dispatching、ToolRun queued ->
  running、PlanStep queued -> running。
- Retry Dispatch：Attempt prepared -> dispatching、ToolRun queued ->
  running、PlanStep 保持 running。
- replay-existing-dispatching 不产生状态写入。

测试与验收：

- 首次和 Retry dispatch 原子成功。
- 双 Owner 并发只有一个 created。
- replay 不新增 Event / Checkpoint。
- 旧 Owner、错误 fencing、撤销 Authority、historical Request 全部拒绝。
- Attempt dispatching 时 ToolRun 必然 running。
- 本 UoW 不执行外部调用。

不在本小节：真实 External Read、Payload Store、Transaction B。

### Stage 3.3 Failure / Timeout / Cancellation UoW

前置条件：

- Task ownership 仍有效，或调用方是经过合法 fencing takeover 的新 Owner。
- Request / Attempt / ToolRun / PlanStep / Plan 身份完整。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/execution-plan-repository.ts`
- `tests/storage/recovery-evidence-readback-dispatch.test.ts`

接口：

```text
failOwnedRecoveryEvidenceRead()
cancelOwnedRecoveryEvidenceRead()
blockOwnedRecoveryEvidenceReadForIntent()
setTaskWideRecoveryEvidencePause()
clearTaskWideRecoveryEvidencePause()
recordOwnedRecoveryEvidenceReadPauseObserved()
resumeBlockedOwnedRecoveryEvidenceRead()
```

状态入口约束：

```text
setTaskWideRecoveryEvidencePause()
  HostControlAuthorization + Task version CAS
  不要求持有同一执行 Task Lease
  只设置 pause_requested_at + pause_requested Event

clearTaskWideRecoveryEvidencePause()
  HostControlAuthorization + expected Pause generation
  只清除 pause_requested_at + pause_cleared Event

blockOwnedRecoveryEvidenceReadForIntent()
  only: prepared -> blocked_by_intent

recordOwnedRecoveryEvidenceReadPauseObserved()
  only: append Pause Event / Checkpoint
  does not change Attempt / ToolRun / PlanStep / Plan

failOwnedRecoveryEvidenceRead()
  only: dispatching -> failed / timed_out

cancelOwnedRecoveryEvidenceRead()
  Request-level convergence
  active prepared -> cancelled
  active dispatching -> cancelled
  no active + prior blocked_by_intent -> keep Attempt，cancel downstream
  no active + prior interrupted -> keep Attempt，cancel downstream
  prior failed / timed_out / cancelled -> keep Attempt，replay / conflict
  Transaction B completed -> return completed，no rollback
```

`Stage 4.1 Preparation` 发生在 Dispatch 之前。Preparation 失败时 Attempt
仍为 prepared，不调用本小节的 failed / timed_out 转换，也不写
`blocked_by_intent`。

事务边界：

- 每个调用使用一个 SQLite immediate transaction。
- Attempt Event 必须先写，再执行受 Migration v8 Trigger 校验的 Attempt
  transition。
- 任一阶段失败整体 rollback。

| 已知事实 | Attempt | ToolRun | PlanStep | Plan | 说明 |
|---|---|---|---|---|---|
| Dispatch 前 Cancel | prepared -> cancelled | queued -> cancelled | queued -> cancelled | active -> cancelled | 外部调用确定未发生 |
| Dispatch 前 Pause | prepared -> blocked_by_intent | 保持 queued | 保持 queued（首次）或 running（Retry） | 保持 active | 不自动 Dispatch |
| Dispatch 后、调用前 Cancel | dispatching -> cancelled | running -> cancelled | running -> cancelled | active -> cancelled | 仅在 executor 能证明调用未开始时 |
| 已 Dispatch 后 Result / normalization 确定失败 | dispatching -> failed | running -> failed | running -> failed | active -> failed | 不复用 terminal ToolRun |
| Tool timeout | dispatching -> timed_out | running -> timed_out | running -> failed | active -> failed | 不声称强制终止 Promise |
| Tool 明确失败 | dispatching -> failed | running -> failed | running -> failed | active -> failed | 保存稳定 reasonCode |
| External Read 已返回，Transaction B 前 Cancel | dispatching -> cancelled | running -> cancelled | running -> cancelled | active -> cancelled | 不写 EvidenceRead / Check |
| Dispatch 后任一 Pause 时点 | 保持 dispatching | 保持 running | 保持 running | 保持 active | 只写 Pause Event；等待合法 Takeover |
| Outcome uncertain | 不写 | 不写 | 不写 | 不写 | 由 Recovery 合法接管后处理 |
| Lease / Authority 失效 | 不写 | 不写 | 不写 | 不写 | 旧 Owner 无提交权 |

状态转换：

- 只允许本表列出的 Attempt / ToolRun / PlanStep / Plan 组合。
- `prepared -> failed` 和 `prepared -> timed_out` 必须拒绝。

约束：

- `prepared` 不支持通用 failed / timed_out，不能伪造转换。
- Stage 4.1 Host metadata / input 重建失败时保持 prepared 并 fail closed，
  禁止借用 `blocked_by_intent` 隐藏非 Intent 错误。
- 只有 Dispatch 已提交后的确定性执行失败才能调用 Failure UoW。
- Outcome uncertain 不得被转换成普通 failed；必须保留在
  `dispatching` 或通过合法 Recovery 进入 `interrupted`。
- 每次写 transaction 内重新读取最新 Cancel / Pause Intent。
- Cancel 存在时优先于 Pause；不得执行 Pause block / Resume / observed 后
  再尝试 Normal write。
- terminal ToolRun 不得接收新的 Attempt。
- External Read 已返回但 Transaction B 被 Cancel gate 阻止时，
  Transaction B 必须整体不提交；随后由 Ownership 仍有效的 Cancel UoW
  写入 cancelled。Payload Store 可能留下 orphan。
- Transaction B 被 Pause gate 阻止时保持 dispatching，不直接写
  interrupted；旧 Owner 停止提交并释放 / 失去 Lease 后，新 Owner 才能
  执行 Stage 3.4。

#### Cancel Recovery

Cancel 与 Pause 分离：

```text
Cancel:
  terminal cancellation
  no Resume
  no Retry Safety

Pause:
  non-cancel intent
  may Resume / Recovery
  requires explicit clear + matching generation
```

Cancel Intent generation 使用 Host control-plane 事件：

```text
recovery.evidence.cancel_requested
payload:
  taskId
  cancelRequestedAt
  taskVersion
  controlActor
  requestNonce
```

同一 Cancel UoW 的所有重试必须绑定同一个 `cancelIntentEventId`。

Cancel 路径：

| 当前 ownership | 处理 |
|---|---|
| 原 Owner Lease 仍有效 | 原 Owner 可调用 `cancelOwnedRecoveryEvidenceRead()` |
| 原 Owner Lease 已失效 | 旧 Owner 不写；新 Owner 先完成合法 Fencing Takeover |
| 新 Owner 检测到 Cancel Intent | 不执行 Retry Safety，不创建新 Attempt，直接 Cancel UoW |
| 同一 Cancel key 已收敛 | Exact Replay；不得复活 |
| historical failed / timed_out / cancelled | 保持终态并返回 conflict；不得强制 cancelled |
| Transaction B completed | 返回 completed Exact Replay；不得回滚 |

Cancel 覆盖矩阵：

| Request 状态 | ReadAttempt | Read ToolRun | Recovery PlanStep | Recovery Plan |
|---|---|---|---|---|
| prepared | prepared -> cancelled | queued -> cancelled | queued（首次）或 running（Retry）-> cancelled | active -> cancelled |
| dispatching | dispatching -> cancelled | running -> cancelled | running -> cancelled | active -> cancelled |
| blocked_by_intent，无 active Attempt | 保持 blocked_by_intent | queued -> cancelled | queued / running -> cancelled | active -> cancelled |
| interrupted，无 active Attempt | 保持 interrupted | interrupted -> cancelled | interrupted -> cancelled | active -> cancelled |
| failed / timed_out / cancelled | 保持原终态 | 保持原终态 | 保持原终态 | 保持原终态 |
| Transaction B 已完成 | 保持 completed | 保持 succeeded | 保持 completed | 保持 completed |

`cancelOwnedRecoveryEvidenceRead()` 通用事务：

```text
BEGIN IMMEDIATE
  -> Lease / Fencing / Authority
  -> Task waiting_review
  -> latest Cancel Intent + generation
  -> Request / Recovery Evidence Plan / PlanStep / ToolRun binding
  -> require Plan.purpose = recovery_evidence
  -> Original Agent Plan / PlanStep / Unknown Write 不得参与更新
  -> if Transaction B already complete:
       return persisted completion / status conflict（no rollback）
  -> if active Attempt = prepared / dispatching:
       read_attempt_cancelled Event
       Attempt -> cancelled
  -> else if active Attempt absent:
       if prior Attempt = failed / timed_out / cancelled:
          return terminal_status_conflict（no writes）
       require prior Attempt = blocked_by_intent or interrupted
       keep prior Attempt unchanged
  -> ToolRun current -> cancelled
  -> Recovery PlanStep current -> cancelled
  -> Recovery Evidence Plan active -> cancelled
  -> recovery.evidence.readback_cancelled Event + Checkpoint
COMMIT
```

语义：

- `cancelled` 表示系统停止接受本次 Readback 结果，不代表外部 Read
  一定没有发生。
- 不写 EvidenceRead、Transaction B Check 或 Verification 输入。
- Payload Store 可能已有 orphan，不得据此恢复成功。
- 旧 Owner 晚到结果必须因 Attempt terminal、Lease / Fencing / Authority
  和 Cancel Event 被 Transaction B 拒绝。
- Task.status 保持 waiting_review。
- Original Unknown Write 保持 unknown。
- Cancel 不写 `blocked_by_intent`。
- 不修改 Original Agent ExecutionPlan / PlanStep。

Cancel 对已完成 Transaction B / Verification 的影响：

- Transaction B 完成后 Cancel 不回滚任何完成记录，不删除 EvidenceRead。
- existing Verification 只允许 Exact Replay。
- Verification missing 时不自动启动 Verifier；进入 manual Review /
  cancelled-request 处理。
- Cancel 不修改 Original Unknown Write，也不作 Final RecoveryReview
  Decision。

Cancel Exact Replay：

- 逻辑 key 不能依赖 active Attempt ID：
  `taskId + readbackRequestId + cancelIntentEventId`。
- 同一 key 已收敛到 cancelled 且 ToolRun / PlanStep / Recovery Plan
  binding 一致：返回持久化结果。
- blocked_by_intent / interrupted 场景复用同一 Request 级 key，旧
  Attempt 状态保持不变。
- Transaction B 已完成且绑定一致：返回持久化完成结果，不加“cancelled”
  到旧 ToolRun / Plan。
- 历史 Attempt 为 failed / timed_out / cancelled 时，保持原终态；同一
  Cancel key 的已记录 conflict 可 Exact Replay，否则返回冲突，不写
  Cancelled。
- 同一 key 对应不同逻辑结果或另一 terminal 组合：状态冲突。
- 不重复写 Event / Checkpoint。

#### Pause / Resume 状态闭环

Pause Intent 在 Step 6.3.4.4 中只通过 Host-owned UoW 设置与解除：

Pause Event 分类：

| Event | 写入者 | 主要 Payload | Generation / Replay |
|---|---|---|---|
| `recovery.evidence.pause_requested` | Host Pause control-plane UoW | taskId、pauseRequestedAt、taskVersion、controlActor、requestNonce | generation = pauseRequestEventId / sequence；key = taskId + generation |
| `recovery.evidence.pause_observed` | Execution worker UoW | pauseRequestEventId、attemptId、dispatchEventId、externalCallStarted、observedAt、fencingToken | key = taskId + requestId + attemptId + generation |
| `recovery.evidence.pause_cleared` | Host explicit Resume control-plane UoW | clearedPauseEventId、clearedPauseEventSequence、pauseRequestedAt、taskVersion | key = taskId + pause generation + clearEventId |

职责边界：

- `pause_requested` 只表示用户 / Host 发起了 Pause，不表示执行器看到或
  中止了调用。
- `pause_observed` 只由持有该 Attempt 执行上下文的 Worker 写；它绑定
  Pause Requested、ReadAttempt 和 Dispatch Event。
- `pause_cleared` 只由 Host 显式 Resume 请求写，必须绑定要清除的 Pause
  generation。
- `pause_cleared` 不表示旧执行器曾观察到 Pause，也不表示旧外部 Promise
  已终止；旧 Dispatch generation 仍不具备提交资格。
- 同一 Event 的 Exact Replay 不重复追加 Event / Checkpoint。

```text
setTaskWideRecoveryEvidencePause()
  -> HostControlAuthorization
  -> expectedTaskVersion CAS
  -> does not require execution Task Lease
  -> records pause_requested_at
  -> append recovery.evidence.pause_requested Event
  -> Checkpoint
  -> Task.status 保持 waiting_review

clearTaskWideRecoveryEvidencePause()
  -> HostControlAuthorization
  -> expected pauseRequestedAt + Task version CAS
  -> expected pauseRequestEventId / sequence
  -> latest Cancel gate
  -> pause_requested_at = NULL
  -> append recovery.evidence.pause_cleared Event
       payload includes clearedPauseEventSequence / pauseRequestedAt
  -> Checkpoint
  -> no newer Pause may be overwritten
```

Host Pause control capability：

- 由独立 control-plane adapter 签发，不复用 Executor 的
  `ValidatedToolInput`、ExecutionAuthority 或 Task Lease token。
- scope 固定为 `taskId + pause_set | pause_clear + requestNonce`。
- 只能调用 Pause request / clear UoW，不能写 Attempt、ToolRun、
  PlanStep、ExecutionPlan 或 EvidenceRead。
- UoW 仍使用 StorageWritePermit 和 Task version / Pause generation CAS。
- 执行 Worker 持有独占 Task Lease 时，control-plane 仍可提交 Pause
  request；它不尝试 Claim 同一个执行 Lease。
- Worker 对 Pause 的观察由独立的 `pause_observed` Event 表达。

当前 `TaskRepository.updateStatusCas()` 使用 `COALESCE`，不能清除
`pause_requested_at`。Stage 3 必须增加受 StorageWritePermit 和 CAS 保护的
Host-only set/clear 方法；不需要 Migration，但不能借普通 Task transition
隐式清除 Intent。

首次与 Retry 的 Pause 前置状态：

```text
首次: Attempt prepared, ToolRun queued, PlanStep queued, Plan active
Retry: Attempt prepared, ToolRun queued, PlanStep running, Plan active
```

各时间点规则：

| Pause 时间点 | Pause UoW 结果 | Resume 行为 |
|---|---|---|
| 首次 Dispatch 前 | prepared -> blocked_by_intent；ToolRun queued；PlanStep queued；Plan active | Clear Pause 后 `resumeBlockedOwned...` 创建 new Attempt；ToolRun / PlanStep 不变 |
| Retry Dispatch 前 | prepared -> blocked_by_intent；ToolRun queued；PlanStep running；Plan active | Clear Pause 后 `resumeBlockedOwned...` 创建 new Attempt；ToolRun / PlanStep 不变 |
| Dispatch Commit 后、External Read 前 | 保持 dispatching / running / running / active；写 Pause Event | Clear Pause 后，新 Owner Takeover 再由 Stage 3.4 interrupt + new Attempt |
| External Read 执行期间 | 保持 dispatching / running / running / active；写 Pause Event；best-effort Abort | 视为 outcome uncertain；Clear Pause 后仍须 Takeover + Retry Safety |
| External Read 返回后、Transaction B 前 | 保持 dispatching / running / running / active；写 Pause Event；不写 EvidenceRead / Check | Clear Pause 后，新 Owner Takeover 再 Recovery |

Pause observed Event：

```text
recovery.evidence.pause_observed
```

使用现有通用 Event payload 保存稳定诊断字段：

```text
readAttemptId
attemptNumber
dispatchEventId
pauseRequestEventId
attemptStatusAtPause = dispatching
interruptionCause =
  pause_before_external_call |
  pause_during_external_read |
  pause_before_transaction_b
resumeEligible = true
externalCallStarted = true | false | unknown
fencingToken
```

Event 不写 Payload、Store 路径、原始异常或敏感内容。`externalCallStarted`
只能来自当前执行器可证明的本地事实；Recovery 不能在缺少该事实时猜测。

`externalCallStarted` 语义：

| 值 | 含义 |
|---|---|
| true | 本地执行器已经进入 Tool 调用边界 |
| false | 调用前同步启动门已确认调用尚未开始，并阻止了本次调用 |
| unknown | 缺少可靠本地事实，不能推断 |

该字段只描述本地执行器是否进入调用，不代表远端服务一定收到请求。
任何逻辑都不得仅凭该字段认定远端 Read 已执行或未执行。

本地同步执行门：

1. External Read 前重新检查 Authority / Cancel / Pause signal。
2. 在单一同步边界内记录 `callStarted` 并调用
   `executeValidated()`；不得在二者之间 await。
3. Pause observed 处理读取该本地 `callStarted` 事实。
4. 若 Pause signal 在该同步门之前可见，记录 false 并阻止调用。
5. 若在该门之后到达，记录 true 并 best-effort Abort。
6. 无法证明门的位置时记录 unknown。

Pause 后 Lease 生命周期：

```text
Host Pause Intent committed
  -> executor observes Pause
  -> if execution ownership still valid:
       persist pause_observed Event + Checkpoint
  -> revoke local ExecutionAuthority
  -> send Abort signal
  -> reject all future result submission from old Attempt
  -> voluntarily release Task Lease with old leaseToken / fencingToken
  -> next owner claims Lease
  -> fencingToken increases
  -> Stage 3.4 validates old Dispatch Event fencing
```

规则：

- Authority revoke 必须先于 Abort signal。
- Pause Observed Event 写入失败时，仍必须撤销 Authority、Abort 并停止
  提交。
- Lease release 失败或进程崩溃时，由 Lease expiry 与 fencing takeover
  接管。
- Lease release 不证明外部 Promise 已终止。
- 新 Owner 必须验证旧 Dispatch Event 的 fencingToken 严格小于自己。
- 旧 Owner 晚到结果仍必须被 Transaction B 拒绝。

`resumeBlockedOwnedRecoveryEvidenceRead()`：

```text
BEGIN IMMEDIATE
  -> Lease / Fencing / Authority
  -> Task waiting_review
  -> if existing active Attempt for same Request / ToolRun:
       validate its prepared Event references the same pauseClearEventId
       return persisted active Attempt（no writes）
  -> no Cancel
  -> require pause_requested_at IS NULL
  -> require expected pauseClearEventId exists
  -> require clear Event.clearedPauseEventSequence == prior Pause generation
  -> require no later pause_requested Event after clear Event
  -> verify Request / ToolRun / Plan / prior Attempt binding
  -> if no active Attempt:
       create new Attempt prepared（new Host-generated ID）
       prepared Event payload includes pauseClearEventId
  -> if active Attempt already exists: return persisted active Attempt
  -> append prepared Event / Checkpoint only on creation
COMMIT
```

Resume 规则：

- 本 UoW 只接受 `blocked_by_intent`。
- 由 Pause 产生的 `interrupted` 必须走 Stage 3.4
  `recoverOwnedRecoveryEvidenceReadAttempt()`。
- `clearPauseIntent()` 是唯一允许清空 `pause_requested_at` 的入口；
  `resumeBlocked...` 不再次清除该字段。
- `clearPauseIntent()` 的 Exact Replay 条件是
  `pause_requested_at IS NULL` 且同一 Pause generation 的
  `pause_cleared` Event 已存在。
- 若已经出现新的 `pause_requested` generation，旧 clear / resume 必须
  返回冲突，不得清除或覆盖新 Pause。
- Stage 6.3 固定调用顺序：

```text
Pause Intent present
  -> Pause block / interruption UoW
  -> Host 显式 Resume 请求
  -> clearPauseIntent UoW
  -> resumeBlocked / Stage 3.4 Recovery UoW
  -> Stage 4.1 -> Dispatch
```

- `cancelled`、`failed`、`timed_out` 不可 Resume。
- Resume 不得改变 Reservation 预分配 ID 或 Request Intent Digest。
- Resume 不调用 External Read；它只恢复为可 Dispatch 的 prepared 状态。
- Resume 不证明旧的外部 Promise 已终止；可能发生旧 Read 晚到返回。
  旧 Owner 的结果仍因 Authority / Fencing / Attempt terminal 状态无法提交。
- 若 Resume 后发现新的 Pause / Cancel，CAS 或 Intent 检查必须失败。
- Task.status 始终保持 `waiting_review`。
- Pause / Resume Event 使用现有 Event payload，至少绑定
  `pauseRequestedAt`、`pauseEventSequence`、`taskVersion` 和
  `fencingToken`。
- 重复设置同一仍有效的 Pause 不得覆盖 timestamp 或追加重复 Event。
- 同一 Attempt + Pause generation 的 Pause observed Event 只能写一次；
  重复调用返回已持久化 Event / Checkpoint，不重复追加。
- Resume 必须携带并核对 `pauseClearEventId`，且验证没有更新的 Pause
  generation。

测试与验收：

- 上述五个 Pause 时间点均分别覆盖。
- Pause 不会被映射为 Cancel。
- 首次 Pause 保持 PlanStep queued；Retry Pause 保持 running。
- Resume 创建新 Attempt ID 且 attemptNumber 递增。
- 迟到的旧 Resume 不能清除新的 Pause。
- clearPauseIntent Commit 后响应丢失时，Exact Replay 不重复写
  pause_cleared Event / Checkpoint。
- clearPauseIntent 后出现新 Pause 时，旧 clear / resume 均拒绝。
- Resume 后只能先进入 prepared，不得直接 External Read。
- Pause 在 External Read 期间出现后又清除，旧 Attempt 的 Transaction B
  仍因 pause Event generation 被拒绝。
- externalCallStarted true / false / unknown 三种审计结果。
- 同步启动门与 Pause 竞争：false 不调用 Tool，true 可能已进入调用。

测试与验收：

- 每个写入点 fault injection。
- Cancel / Pause 竞争。
- failure / timeout / cancellation 映射正确。
- Authority 撤销时零写入。
- Event、reasonCode、Checkpoint 和 terminal status 一致。

Exact Replay：

```text
key = taskId + requestId + attemptId + desired terminal status
```

- 若 Attempt 已是同一 terminal status，且 reasonCode、ToolRun、
  PlanStep、Plan、fencing ownership 历史一致：返回持久化结果，不新增
  Event / Checkpoint。
- 若同 Attempt 已是另一种 terminal status：返回状态冲突。
- 若 Attempt 仍在允许的起始状态：按本小节执行一次转换。
- 若持久化部分是另一组 ToolRun / PlanStep / Plan：state_inconsistent。
- Exact Replay 仍需通过当前 Lease / Fencing / Authority；已有只读重放
  不得为旧 Owner 恢复写权限。
- Pause observed Exact Replay key：
  `taskId + requestId + attemptId + pauseEventSequence`。
- Clear Pause Exact Replay key：
  `taskId + pauseEventSequence + pauseClearEventId`。

不在本小节：进程崩溃自动接管、External Read、Transaction B。

### Stage 3.4 Interrupted Recovery UoW

前置条件：

- 新 Owner 已合法 Claim Task Lease。
- 新 fencingToken 严格大于旧 Owner fencingToken。
- 新 ExecutionAuthority 已绑定且 active。
- Request 有 completed Reservation。
- 没有 Cancel Intent。
- 旧 Attempt = dispatching、ToolRun = running、PlanStep = running、
  Plan = active；或旧 Attempt = interrupted、无 active Attempt，且
  interruption Event 来自本 UoW 之前的合法 Takeover。
- 若需要创建新 Attempt，Retry Registry / Host preflight 已在 SQLite
  transaction 外完成；若已有本次 Recovery 创建的 prepared Attempt，
  其 Exact Replay 不要求当前 Host 配置可解析。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/execution-state-machine.ts`（复用只读状态转换规则）
- `tests/storage/recovery-evidence-readback-dispatch.test.ts`

输入至少包含：

```text
ownership（new fencing owner）
expectedTaskVersion
requestId / readToolRunId
recoveryOperationId
priorAttemptId
candidateNextAttemptId
expectedDispatchEventId
expectedDispatchFencingToken
expectedPauseClearEventId | null
expectedPlanStepVersion / expectedPlanVersion / expectedToolRunVersion
RetryPreflightBinding | null
  null 允许：Exact Replay、Pause interruption-only
```

事务边界：

- 只有 Interruption + New Attempt 分支需要在 transaction 外完成 Registry
  exact lookup、Retry Safety contract 解析、Source Resolver 和 normalized
  input 重验证。
- Interruption-only 分支不要求 Registry / RetryPreflightBinding。
- UoW 只读取持久化 Request / Attempt / ToolRun / PlanStep / Plan /
  Reservation 和调用方传入的 preflight binding。
- 以下完整 DB 顺序在一个 SQLite immediate transaction 内执行。
- 不调用 External Read、Payload Store 或 Verifier。

Recovery Operation Identity：

```text
recoveryOperationId
  = Host-generated stable opaque identity

Recovery Lineage:
  recoveryOperationId
  priorAttemptId
  interruptionEventId
  pauseClearEventId | null
  candidateNextAttemptId
  preparedEventId
```

持久化位置：

- `read_attempt_interrupted` Event payload 写入 `recoveryOperationId` /
  `priorAttemptId` / `resumeEligible`。
- Recovery 创建 Attempt 的 `read_attempt_prepared` Event payload 写入完整
  Recovery Lineage。
- 不依赖进程内 Map / object；跨进程只从 Event + Attempt 重建。

Recovery Lineage Exact Replay：

1. 按 `recoveryOperationId` 查 prepared Event。
2. 校验 `priorAttemptId`、`interruptionEventId`、
   `pauseClearEventId`、candidateAttemptId、Request / ToolRun 绑定。
3. 按 Recovery-created Attempt 状态返回：

| Recovery-created Attempt 状态 | 行为 |
|---|---|
| prepared | 返回同一个 Attempt ID |
| dispatching | 返回 in_progress；不重新 Dispatch、不创建 Attempt |
| completed / Transaction B committed | 返回持久化完成结果 |
| failed / timed_out / cancelled / interrupted | 返回持久化终态 |
| lineage 缺失或字段冲突 | state_inconsistent |

旧 Recovery 操作与新一轮 Recovery：

- 若当前 active dispatching Attempt 的 prepared Event lineage 匹配
  `recoveryOperationId`，这是旧 Recovery 操作的 Exact Replay。
- 若新 Owner 要接管当前 active dispatching Attempt，必须使用当前
  Attempt 作为新的 `priorAttemptId`，生成新的 `recoveryOperationId`，
  重新验证 Dispatch Event fencing / Retry Safety，并创建下一 Attempt。
- 新一轮 Recovery 不得复用旧 `candidateNextAttemptId`、不得把旧
  prepared Attempt 当作本次新操作结果。

事务顺序：

```text
BEGIN IMMEDIATE
  -> Lease / Fencing / new Authority
  -> exact Request / Attempt / ToolRun / PlanStep / Plan identity
  -> latest Cancel Intent（存在则不由本 UoW 处理）
  -> lookup Recovery-created Attempt by recoveryOperationId
  -> if lineage exists:
       validate full Recovery Lineage
       return prepared / in_progress / completed / terminal per state
  -> inspect all active Attempts for Request + ToolRun
  -> if active = dispatching and is priorAttemptId:
       verify dispatch Event + expectedDispatchFencingToken
       if current fencing == event fencing:
          return in_progress；no interruption
       require current fencing > event fencing
       if Pause Intent present:
          compare only persistent Request / Attempt / ToolRun /
          Plan / PlanStep / Dispatch Event binding
          Task version CAS
          old Attempt dispatching -> interrupted + Event
          Event includes recoveryOperationId / priorAttemptId
          ToolRun running -> interrupted
          PlanStep running -> interrupted
          Plan remains active
          Event resumeEligible=true
          Checkpoint
          COMMIT（interruption-only）
       else:
          require RetryPreflightBinding
          continue interrupt + new branch
  -> if active = any other prepared / dispatching Attempt:
       state_inconsistent
  -> require RetryPreflightBinding
  -> compare persisted allowlistId / allowlistVersion /
     readToolSchemaHash / retrySafety / consistencyMode /
     expectedResourceVersion / expectedEtag / canonicalInputHash
     with RetryPreflightBinding
  -> require no Cancel / no Pause
  -> if old Attempt dispatching:
       Task version CAS
       old Attempt dispatching -> interrupted + Event
       Event includes recoveryOperationId / priorAttemptId
       ToolRun running -> interrupted
       PlanStep running -> interrupted
       Plan remains active
  -> verify interrupted provenance and resumeEligible
  -> require no active Attempt
  -> require Pause Intent IS NULL
  -> if interruption cause is Pause:
       require expectedPauseClearEventId
       require pause_cleared Event exists / matches pause generation
  -> allocate attempt_number from persisted MAX + 1
  -> new Attempt prepared with new Host-generated ID + Event
       event payload includes recoveryOperationId /
       recoveredFromAttemptId / interruptionEventId / pauseClearEventId
  -> ToolRun interrupted -> queued
  -> PlanStep interrupted -> running
  -> Checkpoint
COMMIT
```

`recoverOwnedRecoveryEvidenceReadAttempt()` 是唯一 Recovery interrupt /
resume 写入口，支持以下分支：

```text
dispatching + Pause Intent:
  完成 old Attempt / ToolRun / PlanStep interruption
  写 resumeEligible interrupted Event
  不创建 new Attempt

dispatching + no Pause Intent:
  完成 interruption，并在同一 transaction 创建 new Attempt

interrupted（无 active Attempt）+ no Pause Intent:
  验证 interrupted Event / resumeEligible / fencing provenance
  -> ToolRun interrupted -> queued
  -> PlanStep interrupted -> running
  -> new Attempt prepared + Event
```

Interruption-only 不解析历史 Allowlist / Host Contract，因为它不创建新的
外部执行授权，只终止旧 Attempt。Interruption + New Attempt 必须拥有
RetryPreflightBinding，因为之后会进入新的 Read 执行链。

`interrupted（无 active Attempt）` 的合法生产来源是
`dispatching + Pause Intent` 分支：新 Owner 已合法 Takeover，但 Pause
尚未解除，因此只完成中断，不创建后续 Attempt。Pause 清除后再进入本 UoW
创建下一 Attempt。

两类路径：

```text
ordinary interrupted recovery:
  interruption + ToolRun requeue + PlanStep running + new Attempt
  = one immediate transaction

pause-induced interrupted recovery:
  transaction 1: interruption only
  -> Host explicit clearPause transaction
  -> transaction 2: recovery UoW creates new Attempt
```

active Attempt 状态规则：

| active Attempt | Dispatch Event fencing | 当前 ownership | 行为 |
|---|---|---|---|
| prepared，但 lineage 不匹配当前 recoveryOperationId | 无 | 任意 | state_inconsistent |
| dispatching（priorAttemptId） | == 当前 fencing，原 Lease 有效 | 原 Owner | `in_progress`，不接管、不调用 External Read |
| dispatching（priorAttemptId） | < 当前 fencing，合法 Takeover，Pause 未清 | 新 Owner | interruption-only，无 new Attempt |
| dispatching（priorAttemptId） | < 当前 fencing，合法 Takeover，Pause 已清 | 新 Owner | interruption + new Attempt |
| dispatching（priorAttemptId） | > 当前 fencing / Event 缺失 | 任意 | fencing conflict / state_inconsistent |
| 其他 prepared / dispatching | 任意 | 任意 | state_inconsistent |
| 无 active，prior Attempt interrupted + Pause 未清 | 历史 Event 可验证 | 新 Owner | return interrupted / pending Resume |
| 无 active，prior Attempt interrupted + Pause 已清 | 历史 Event 可验证 | 新 Owner | 创建下一 Attempt |
| 无 active，interrupted Event 不可验证 | 任意 | 任意 | state_inconsistent / manual Review |

修正后的稳定 retry 组合：

```text
new Attempt = prepared
ToolRun = queued
PlanStep = running
ExecutionPlan = active
```

状态转换：

```text
Pause 未清:
  old Attempt: dispatching -> interrupted
  Read ToolRun: running -> interrupted
  PlanStep: running -> interrupted
  ExecutionPlan: active（不变）
  new Attempt: 不创建

Pause 已清:
  old Attempt: dispatching -> interrupted
  Read ToolRun: running -> interrupted -> queued
  PlanStep: running -> interrupted -> running
  ExecutionPlan: active（不变）
  new Attempt: absent -> prepared
```

`PlanStep interrupted -> queued` 不被现有状态机允许；只有 ToolRun 可以
`interrupted -> queued`，PlanStep 必须使用 `interrupted -> running`。

Retry Safety Gate：

事务外 preflight：

```text
persisted Request / ToolRun snapshot
  -> exact allowlistId / allowlistVersion
  -> Registry.getExact()
  -> recompute Allowlist Contract Digest
  -> compare recomputed digest == persisted allowlistVersion
  -> Tool identity / version / Input Schema Hash unchanged
  -> revalidate persisted normalized ToolRun.input
  -> compare canonicalInputHash
  -> derive immutable RetryPreflightBinding
```

`RetryPreflightBinding` 只存在于进程内，包含：

```text
requestId
priorAttemptId
allowlistId / allowlistVersion
allowlistContractDigest（等于持久化 allowlistVersion）
readToolName / readToolVersion / readToolSchemaHash
retrySafety
consistencyMode
expectedResourceVersion / expectedEtag
canonicalInputHash
```

transaction 内复验：

```text
Lease / Fencing / Authority
  -> re-read persisted Request / Attempt / ToolRun / PlanStep / Plan
  -> compare all RetryPreflightBinding fields with persisted rows
  -> latest Cancel / Pause Intent
  -> business state / version CAS
```

UoW 不调用 Registry、Host callback 或 ToolRegistry，也不重新解析
Allowlist Contract。

Retry Safety 与 Consistency Mode 是两个独立持久化字段：

| retrySafety | consistencyMode | Schema 允许 | 是否允许新 Attempt | 结果校验 |
|---|---|---|---|---|
| immutable | immutable_version | 是 | exact contract / input 一致时允许 | expected version / ETag 均为 NULL |
| version_conditional | etag_or_resource_version | 是 | exact contract / input 一致时允许 | 至少一个 expected 非 NULL，并逐个匹配 Actual |
| immutable | etag_or_resource_version | 否 | fail closed | 不得混用 |
| version_conditional | immutable_version | 否 | fail closed | 不得混用 |
| 未知值 | 任意 | 否 | fail closed / manual Review | v8/v9 无该状态 |

Actual Value 规则：

- 每个非 NULL `expectedResourceVersion` 都必须有 Actual 且精确匹配。
- 每个非 NULL `expectedEtag` 都必须有 Actual 且精确匹配。
- Expected 为 NULL 不要求对应 Actual。
- Actual 缺失时不能视为匹配，也不能跳过比较。
- Retry Safety 决定是否允许重复调用；Consistency Mode 决定后续读取结果
  使用何种一致性 / 版本比较规则。两者不得合并为一个 enum。

Attempt ID / 数量：

- Reservation `read_attempt_id` 只用于第一个 ReadAttempt。
- Retry / Resume 必须使用新的 Host-generated `readAttemptId`。
- `attemptNumber` 在 UoW transaction 内按同一
  `readbackRequestId + readToolRunId` 的持久化 `MAX + 1` 分配。
- `ToolRun.attempt_no` 保持 1，逻辑 ToolRun 不变。
- 同一 Request 同时最多一个 prepared / dispatching Attempt。

Recovery UoW Exact Replay：

- 若已有 prepared Attempt 且其 Event 证明由同一 prior Attempt 的本次
  Recovery 创建，返回该持久化 ID；忽略调用方新的候选 ID。
- 若 active dispatching Attempt 的 dispatch Event fencing 等于当前
  ownership fencing，返回 `in_progress`，不得接管。
- 若 current fencing 严格大于 dispatch Event fencing且已有合法
  Takeover，必须进入 interruption 路径，不得被“已有 active Attempt”
  短路。
- 若无 active Attempt、prior Attempt 已 interrupted 且 Pause 仍存在，
  返回 persisted interrupted / pending；不创建新 Attempt。
- 若无 active Attempt、prior Attempt 已 interrupted 且 Pause 已清除，
  验证 interruption Event 后创建下一 Attempt。
- 若 dispatching -> interrupted + new Attempt transaction 已提交但响应
  丢失，重试必须返回已创建的 active Attempt。
- 若本次 Recovery 已创建的新 active Attempt 进一步进入 dispatching，
  按当前持久状态返回，不重复 interruption；若 Request 已完成
  Transaction B，则返回持久化完成结果。
- 已有多个 active Attempt、active Attempt 无法证明 Recovery 来源、
  无 active interrupted 缺少合法 Event、interrupted 与 active Attempt
  绑定不同 ToolRun、或 Attempt number 不单调：state_inconsistent。
- Exact Replay 不新增 Event / Checkpoint，不重复执行 interrupted
  transition。

`dispatching` 或 `interrupted` 本身不证明可以安全重读。只有上述 gate
全部通过，才允许同一 Request 下的新 Attempt。

测试与验收：

- stale fencing takeover 产生新 Attempt。
- dispatching Event 缺失 fencingToken 或 fencing 不递增时拒绝 Recovery。
- 原 Owner Lease 仍有效且 fencing 等于 Dispatch Event 时返回
  in_progress，不接管、不第二次 External Read。
- 新 Owner fencing 严格大于 Dispatch Event fencing时可接管 dispatching。
- Pause 未清时 Stage 3.4 只写 interruption，不创建新 Attempt。
- Pause interruption-only 在历史 Allowlist Version 不可解析、无
  RetryPreflightBinding 时仍可完成。
- Pause 清除后再次调用 Stage 3.4，创建下一 Attempt。
- Pause 来源的 interrupted 缺少 pause_cleared Event 时 fail closed。
- 旧 Attempt 保持 interrupted，PlanStep 终态为 running。
- 缺少历史 Allowlist Version、Retry Safety 不匹配、input hash 改变均
  拒绝。
- terminal failed / timed_out / cancelled 不创建新 Attempt。
- Pause 不会直接产生 interrupted；合法 Takeover 后由本 UoW 原子产生
  interrupted + new prepared。
- interrupted 且无后续 active Attempt 在 Pause 未清时返回 pending，
  在 Pause 已清时可创建下一 Attempt；Event / fencing 不可验证时 manual
  Review。
- Recovery UoW 已提交但响应丢失时，Exact Replay 返回同一个 active
  Attempt，不重复 Event / Checkpoint。
- interrupted 后已有 prepared Attempt 时，Exact Replay 返回同一 ID。
- Recovery-created Attempt 已 dispatching 时，旧 recoveryOperationId
  返回 in_progress，不重新 Dispatch。
- Recovery-created Attempt 已 completed / terminal 时返回持久化结果。
- lineage 字段缺失或 candidate Attempt ID 冲突时 state_inconsistent。
- 新 Owner 对当前 dispatching Attempt 发起新一轮 Recovery 时使用新的
  recoveryOperationId / priorAttemptId，不复用旧操作。
- 并发 Recovery 只创建一个 active Attempt。
- dispatching Recovery 后只有一个 active Attempt。
- Reservation 首个 Attempt ID 不被 Retry 复用，新 ID 不同且
  attemptNumber 单调递增。
- 旧 Owner 晚到 Transaction B 被拒绝。

不在本小节：External Read、Payload Store、Transaction B。

### Stage 3.5 Concurrency & Fault Injection

前置条件：

- Stage 3.1–3.4 的 UoW 已实现并通过各自专项测试。
- 可用双连接 SQLite 测试环境和可控 Lease Clock / Authority proxy。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/execution-state-machine.ts`
- `tests/storage/recovery-evidence-readback-dispatch.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`

事务边界：

- Dispatch、Failure、Cancel、Interrupt 都是单一 immediate transaction。
- 不跨 transaction 拼接 Attempt、ToolRun、PlanStep、Plan。

状态转换：

- fault injector 只能通过 Stage 3.2–3.4 的原子接口制造成功或失败。
- 测试不得直接 UPDATE Attempt / ToolRun / PlanStep / Plan 绕过校验。

必须测试：

- Dispatch 原子性。
- 双 Owner 并发 Dispatch。
- Lease 有效时禁止其他 Worker 接管。
- Lease 失效后 fencing takeover。
- Cancel / Pause 在每个 transaction 边界竞争。
- Cancel + 原 Owner 有效时只执行 Cancel UoW。
- Cancel + 原 Owner 失效时 Takeover 后只执行 Cancel UoW。
- Cancel Terminal 后旧 Owner 晚到结果不能提交。
- Pause 设置、Pause 解除、旧 Resume 清除新 Pause 的 CAS。
- Host Pause control-plane 在 Worker 持有 Task Lease 时仍可提交 Pause
  Request，且不 Claim 同一执行 Lease。
- pause_observed 写失败后 Authority 仍撤销、Abort 仍发送、结果仍停止提交。
- voluntary Lease release 失败后 expiry / fencing takeover 可接管。
- 首次 Pause 保持 PlanStep queued，Retry Pause 保持 running。
- blocked_by_intent 与 interrupted 的 Explicit Resume。
- Dispatch 前崩溃保持 prepared。
- Dispatch 后崩溃保持 dispatching，等待合法 Recovery。
- 原 Owner Lease 有效时不接管 dispatching。
- 合法新 Owner fencing > Dispatch Event fencing 时接管 dispatching。
- Pause 未清时 interruption-only；清除后才创建下一 Attempt。
- 外部结果晚到但旧 Owner 无 Authority 时不能提交。
- Failure / Cancel / Pause / Resume UoW 的 Exact Replay。
- Recovery UoW Commit 后响应丢失，不创建第二个 active Attempt。
- Event、Checkpoint、Attempt 各写入点 fault injection。
- 非法状态转换全部拒绝。
- `purpose=agent` Read Recovery 不处理 Recovery Evidence Plan。

验收：

- 所有失败路径 rollback，或停留于明确 prepared / dispatching /
  interrupted 状态。
- 无重复 Event / Checkpoint。
- 不声称 External Read exactly-once。
- 专项测试、Stage 1/2 回归、typecheck 和 diff check 通过。

不在本 Stage：

- 真实 External Read。
- ToolRegistry `executeValidated()`。
- Transaction B。
- EvidenceRead。
- Verification。

## 6. Stage 4 — External Read + Transaction B

### Stage 4.1 Read Executor Preparation

前置条件：

- Stage 2 Transaction A 已提交。
- Request 有 completed Reservation + Completion Invariant。
- Attempt = prepared，ToolRun = queued，PlanStep = queued 或 running，
  Plan = active。
- 当前调用者仍持有有效 Lease / Fencing / Authority。

生产代码范围：

- `src/recovery/recovery-evidence-readback-executor.ts`
- `src/recovery/recovery-readback-tool-registry.ts`
- `src/recovery/recovery-evidence-readback-service.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `tests/recovery/recovery-evidence-readback-executor.test.ts`

Preparation 顺序：

```text
load Request / Attempt / ToolRun / PlanStep / Plan / Reservation
  -> exact allowlistId + allowlistVersion
  -> Registry.getExact()
  -> verify Request / ToolRun Tool identity / Version / Schema Hash
  -> reuse Registry source validation
       resolveSource(persisted Original Unknown Write, Manifest)
       validate resource scheme / persisted resource binding
  -> load persisted ToolRun.input_json
  -> ToolRegistry.validateInput(toolName, persisted normalized input)
  -> compare revalidated normalized value + canonicalInputHash
  -> acquire ToolRegistry execution lease
  -> Stage 3 beginOwnedRecoveryEvidenceRead()
```

Tool Input 语义：

- Stage 2 的 Host 原始候选参数只存在于 Preparation 内存中，不保证持久化。
- `ToolRun.input_json` 是 Stage 2 Zod Schema 验证后的规范化值，即
  Transform / Async Refinement 的输出，不是原始候选参数。
- `ValidatedToolInput` WeakMap capability 不能序列化、不能持久化、不能跨
  进程恢复。
- Stage 4 不重新调用 Host `buildArguments()`，但必须从持久化 normalized
  input 调用一次 `ToolRegistry.validateInput()` 以取得本进程 capability。
- 这次调用可能导致输入 Schema 的 Transform / Async Refinement 再次执行。
  本计划不声称 Stage 2 与 Stage 4 端到端只执行一次 Transform。
- Source Resolver 可以为了确认最终 `resourceRef` 执行一次，但必须复用
  Registry 现有 schema / scheme / Manifest binding 校验，且不得调用
  Argument Builder。
- 新 capability 的 toolName / version / schemaHash / normalized value /
  canonical hash 必须与持久化绑定一致；否则 fail closed。
- 随后只能使用 `executeValidated(validatedInput, context)`；
  `executeValidated()` 不会再执行 Schema parse / Transform。
- Host 必须保证输入 Schema 的 Transform / Async Refinement：

```text
deterministic
pure
idempotent for already-normalized input
no network / filesystem / database / Provider side effect
```

- 不新增 `executeUnchecked()`、`restoreValidatedInput()` 或其他绕过
  WeakMap capability 的公共执行 API。

Preparation 失败：

- exact Allowlist Version 缺失、Tool metadata 变化、Input Schema Hash
  mismatch、重新验证值变化：不进入 dispatching。
- 此时 Attempt 仍 prepared；返回稳定错误并等待配置修复或人工 Review。
- 不得将配置错误伪装成 Pause / `blocked_by_intent`。
- Preparation 失败不调用 Stage 3.3 Failure UoW，不构造
  `prepared -> failed`。

事务边界：

- Preparation 所有 Registry / Host 调用均在 SQLite transaction 外。
- Source Resolver / Builder 与 ToolRegistry 动态调用均在 transaction 外。
- Stage 3 Dispatch UoW 只检查持久化字段、contract digest、版本和 ID
  绑定，不调用上述 Registry / Host API。
- 从 Stage 6.3 进入时，Stage 4.1 复用已生成的 `RetryPreflightBinding`，
  不再次执行 Registry / Source Resolver / input revalidation。
- 完成 preparation 后只调用一次 Stage 3 Dispatch UoW。
- Stage 4 不自行执行第二次 Dispatch Transaction。

状态转换：

- 本小节不直接写 DB。
- Preparation 成功只返回执行候选；真正的 prepared -> dispatching 由
  Stage 3.2 Dispatch UoW 完成。
- Preparation 失败保持 prepared。

测试与验收：

- 规范化输入跨进程重建成功。
- Stage 2 验证原始输入后，Stage 4 对 normalized input 再次调用
  `validateInput()`；测试不得断言端到端 Transform 只执行一次。
- Stage 4 单次 preparation 只调用一次 `validateInput()`，随后
  `executeValidated()` 不再次执行 Transform / Refinement。
- 非确定 / 非幂等 Transform、Async Refinement 或外部 I/O 必须 fail
  closed。
- 持久化输入变化、schema hash 变化、version mismatch 均拒绝。
- Preparation 失败不产生 dispatching。
- preparation 完成后 Dispatch UoW 恰好调用一次。

不在本小节：External Read、Payload Store、Transaction B。

### Stage 4.2 External Read Runtime

前置条件：

- Stage 3 Dispatch UoW 返回 `created`。
- Attempt = dispatching，ToolRun = running，PlanStep = running。
- 当前进程持有 6.1 重建的 `ValidatedToolInput` capability。

生产代码范围：

- `src/recovery/recovery-evidence-readback-executor.ts`
- `src/recovery/recovery-evidence-readback-service.ts`
- `src/tools/registry.ts`（复用，不新增旁路 token API）
- `src/persistence/lease-heartbeat.ts`
- `tests/recovery/recovery-evidence-readback-executor.test.ts`

执行顺序：

```text
Dispatch UoW COMMIT
  -> re-read in-memory Authority state
  -> latest Cancel / Pause signal check
  -> ToolRegistry.executeValidated(validatedInput, context)
       outside SQLite
  -> single-settle result
```

同步执行启动门：

```text
Authority.assertActive()
  -> check latest Cancel / Pause signal
  -> set local callStarted
  -> call ToolRegistry.executeValidated()
```

以上四个动作之间不得 `await`。若 Cancel / Pause 在设置 `callStarted`
之前可见，则不启动 Tool；若之后到达，则 `callStarted=true` 并
best-effort Abort。

Execution context：

```text
taskId
toolCallId
signal = AbortSignal.any(host signal, heartbeat/authority signal)
fencingToken
```

Timeout：

- 只使用 exact Allowlist Contract 中的 `timeoutMs`。
- 不接受模型、HTTP 调用方或普通请求临时指定 Timeout。
- 使用单一 settle 状态。
- 迟到 resolve / reject 不得再次提交结果；迟到 reject 必须被消费。
- Timeout 不会强制终止非协作式 Promise。
- Timeout 后 ownership 仍有效时，调用 Stage 3 timeout UoW。
- ownership 已失效时保持 dispatching，由合法 Recovery 处理。

Authority / Cancel：

- Dispatch COMMIT 是外部调用授权的持久化边界。Commit 后到达的 Pause
  是中断请求，不会撤销已经提交的授权。
- Authority 撤销必须先于本地 Abort signal。
- Cancel / Pause 在 Dispatch Commit 后仍可能发生，因此外部调用前和结果
  提交前都要检查。
- Abort 成功不等于外部副作用没有发生。
- 旧 Owner 的外部结果只能在 Transaction B 再次通过 Lease / Fencing /
  Authority 后提交。
- External Read 执行期间出现 Cancel：收到可结算结果或达到 Host timeout
  后，ownership 仍有效时调用 Cancel UoW；不得写 EvidenceRead。
- External Read 执行期间出现 Pause：记录 Pause observed Event，
  best-effort Abort，Attempt 保持 dispatching；不得把 Pause 改写为
  cancelled、failed 或 interrupted。只有合法 Fencing Takeover 后，
  Stage 3.4 才能中断旧 Attempt。
- Pause observed 写入后，执行器按“Authority revoke -> Abort -> 停止结果
  提交 -> voluntary Lease release”顺序退出；Event 写失败也不得继续
  提交。
- Pause observed Event 的 `externalCallStarted` 必须来自同步启动门，
  取值 true / false / unknown，且不代表远端一定收到请求。
- Pause 与 Host timeout 同时存在且 ownership 仍有效时，Timeout 使用
  `timed_out`；同时保留 Pause Event。不得据此写 EvidenceRead。
- 数据库与外部 I/O 非原子，因此无法保证 Dispatch COMMIT 后的 Pause
  与外部调用绝对无竞争。
- 即使 Pause 随后解除，旧 Attempt 也不能恢复提交资格；旧结果不得成为
  EvidenceRead。后续必须由新 Owner Takeover 创建新 Attempt，并重新
  经过 Retry Safety Gate。

禁止：

- 在 SQLite transaction 内等待 Tool Promise。
- 使用 `ToolRegistry.execute()` 绕过当前进程 Validated Input。
- 执行 `mode=write` Tool。
- 根据 Tool 名称或请求文本临时选择其他 Tool。

事务边界：

- ToolRegistry lease 获取、Promise 执行、timeout 和 result settle 都在
  SQLite transaction 外。
- 失败、超时和取消后的持久化只能调用 Stage 3.3 UoW。

状态转换：

- External Read 本身不直接改 DB。
- timeout / known failure / cancel 分别由 Stage 3.3 映射为
  timed_out / failed / cancelled。
- Outcome uncertain 保持 dispatching，等待 Recovery。
- Pause 本身不是 Attempt terminal status；它记录 Event 并禁止旧 Attempt
  提交 Transaction B。

测试与验收：

- 正常 resolve / reject / synchronous throw。
- Host timeout、late resolve、late reject、无 unhandled rejection。
- Cancel / Authority 在调用前和返回后竞争。
- Pause observed 后 Authority revoke 先于 Abort。
- Lease release 失败时旧结果仍不能提交。
- 旧 Owner 结果不能提交。
- 外部调用一定在 transaction 外。

不在本小节：Payload Store、Transaction B。

### Stage 4.3 Result Normalization & Payload Store

前置条件：

- External Read 返回了可结算结果。
- 当前 Owner 仍可在后续 UoW 中通过 Authority 检查。

生产代码范围：

- `src/recovery/recovery-readback-tool-registry.ts`
- `src/recovery/recovery-evidence-readback-executor.ts`
- `src/recovery/recovery-evidence.ts`
- `src/recovery/evidence-payload-store.ts`
- `tests/recovery/recovery-evidence-readback-executor.test.ts`
- `tests/recovery/recovery-evidence.test.ts`

Normalization：

```text
raw Tool Result
  -> exact Result Schema validation
  -> trusted Metadata Extractor
  -> actual resourceVersion / resourceEtag
  -> expected / actual version conditional comparison
  -> fixed RecoveryReadbackResult validation
  -> Host-controlled resourceRef / observedAt normalization
  -> JCS canonical bytes
  -> semantic digest via computeReadbackResultPayloadDigest()
  -> storage digest = SHA-256(canonical bytes)
  -> content-addressed store ref
  -> PayloadStore.put(bytes, storageDigest)
```

Result Schema identity 绑定：

- `resultSchemaId / resultSchemaVersion / resultSchemaHash` 由 exact
  Allowlist Version 固定。
- `validateResult()` 必须精确恢复该 Allowlist Version，并确认
  ToolRegistry Result Schema hash 未变化。
- Semantic Digest 继续使用现有 `jcs-sha256-v1` helper；不得改成任意
  raw Tool Output 的 SHA-256。
- 不得把 Schema identity 偷偷拼进现有 Digest 输入。需要改变 Digest
  输入时必须定义新 protocol version，并保持历史协议可验证。

Version Conditional：

- Expected 来自持久化 Request。
- Actual 只能来自 Host Result Schema 验证后的 Metadata Extractor。
- expected non-NULL -> actual must exist and match。
- actual missing 一律 mismatch，不跳过比较。
- mismatch 必须在 Payload Store 写入前终止。
- mismatch 映射为失败观察，不是 Original Write 最终结论。
- Review 不做 Final Decision。
- 新版本需要新的 Evidence Submission / Request，不能自动接受。

Payload 限制：

- `maximumPayloadBytes` 在 Store 写入前检查。
- `sensitiveOutputPolicy=mode:reject` 时拒绝保存。
- `mode:redact` 在缺少 Host-approved deterministic redactor 时必须
  fail closed；本计划不自行发明 redaction 实现。
- Event、Message、Checkpoint、Snapshot 和公开错误不得包含 raw Payload。

事务边界：

- Result Schema、Metadata Extractor、canonicalization 和 Payload Store
  全部位于 SQLite transaction 外。
- Store 写入成功不代表任何 DB 状态已提交。

状态转换：

- 本小节不直接写 DB。
- 确定失败由 Stage 3.3 Failure UoW 表达。
- 成功结果只进入 Stage 4.4 Transaction B。

三层 Digest / Ref：

```text
semanticDigest:
  persisted as Attempt.result_digest
  persisted as VerificationCheck.expected_payload_digest
  persisted as EvidenceRead.result_payload_digest

storageDigest:
  从 Store Ref 的 64 lowercase hex 推导
  用于 PayloadStore.put() / read() 的文件内容校验

storeRef:
  evidence-file:sha256/<storageDigest hex>
  persisted as Attempt.result_payload_store_ref
  persisted as EvidenceRead.result_payload_store_ref
```

即使当前 canonical readback bytes 的 semantic digest 与 storage digest
相等，也必须分别计算、分别校验，不把 Manifest/Check 中的 semantic
digest 直接当作 Payload Store 读取参数。

Store failure / Orphan：

| 情况 | 处理 |
|---|---|
| Result Schema fail | 不写 Store，Attempt failed |
| Metadata extraction fail | 不写 Store，Attempt failed |
| Version mismatch | 不写 Store，Attempt failed |
| Payload size / output policy fail | 不写 Store，Attempt failed |
| Store write fail | 不写 EvidenceRead，Attempt failed 或不提交 |
| Store success + Transaction B fail | 可留下 content-addressed orphan |
| Store file exists but no complete DB relation | 不得推断 B 成功 |

本 Stage 不实现 Payload GC。

Outcome uncertain 规则：

`inconclusive` 只属于 Verification 状态，不属于 ReadAttempt。ReadAttempt
只使用现有 Schema 状态：

| External 情况 | Attempt / ToolRun | 后续 |
|---|---|---|
| 明确、权威的成功结果 + Schema 通过 | Stage 4.4 completed / succeeded | Transaction B |
| 权威 Tool 业务失败结果 | failed / failed | 不写 EvidenceRead |
| Result Schema / metadata 确定失败 | failed / failed | 不写 EvidenceRead |
| 网络连接中断，无响应 | 保持 dispatching / running | 等待合法 Takeover -> interrupted + new Attempt |
| 响应在传输中丢失 | 保持 dispatching / running | 等待合法 Takeover -> interrupted + new Attempt |
| Promise reject，无法证明外部调用未启动 | 保持 dispatching / running | 等待合法 Takeover -> interrupted + new Attempt |
| Promise reject，Host 有持久化 / 权威证据证明调用未启动 | failed / failed | 不写 EvidenceRead |
| Host timeout | timed_out / timed_out | 不推断外部操作未发生，不写 EvidenceRead |
| Cancel | cancelled / cancelled | 不写 EvidenceRead |
| Pause | 保持 dispatching / running | 只写 Pause Event；Takeover 后 Recovery |

补充约束：

- 只有 Dispatch 后、Host 能给出明确执行结果时才能进入 failed。
- Connection interruption、response loss、普通 reject 都是 outcome
  uncertain，不得直接 failed。
- Timeout 是明确的本 Attempt 超时状态，但不是“外部操作未执行”的证明。
- 任何 uncertain 情况都不得生成 EvidenceRead、Verification Check 或
  Verification passed 输入。

测试与验收：

- JSON 使用 JCS，不使用 `JSON.stringify` 作为 canonicalization。
- Result Schema 与 Metadata Extractor fail。
- expected version/ETag 缺失、错配、成功。
- payload 超限和 sensitive policy。
- Payload Store write fail。
- semantic / storage digest 分别校验。
- canonical bytes 可重新得到同一 semantic digest 和 Store Ref。
- 日志、Event、错误不泄露 Payload 或本地路径。

不在本小节：Transaction B、Controlled Provenance、Verifier。

### Stage 4.4 Transaction B UoW

前置条件：

- External Read 已有 schema-valid normalized result。
- Payload Store 已成功写入 canonical bytes。
- Attempt = dispatching，ToolRun = running，PlanStep = running，
  Plan = active。
- Request 有 completed Reservation。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `src/storage/recovery-evidence-verification-check-repository.ts`
- `src/storage/execution-plan-repository.ts`
- `tests/storage/recovery-evidence-transaction-b.test.ts`

必须强化现有：

```text
completeOwnedRecoveryEvidenceRead()
```

同一 SQLite immediate transaction：

1. Lease / Fencing / Authority。
2. Task waiting_review。
3. completed Reservation / Completion Invariant。
4. Request / Attempt / ToolRun / PlanStep / Plan 完整绑定。
5. latest Intent gate：
   Cancel exists -> no Transaction B / no EvidenceRead
   Pause exists -> no Transaction B / persist Pause observed
   pause Event generation mismatch -> no Transaction B
6. Task version CAS。
7. `read_attempt_completed` Event。
8. Attempt dispatching -> completed。
9. ToolRun running -> succeeded。
10. 恰好一个 redacted Tool Message。
11. PlanStep running -> completed。
12. ExecutionPlan active -> completed。
13. `tool.succeeded` Event。
14. Transaction B Verification Check intent。
15. EvidenceRead。
16. `recovery.evidence.read_completed` Event。
17. Checkpoint。

任何一步失败整体 rollback。

External Read 已返回但 Transaction B 无法提交：

- Latest Cancel：Transaction B 不写；ownership 仍有效时调用 Stage 3
  Cancel UoW，将 Attempt / ToolRun / PlanStep / Plan 收敛为 cancelled。
- Latest Pause：Transaction B 不写；记录 Pause observed Event。
  Attempt / ToolRun / PlanStep 保持 dispatching / running / running，
  Plan 保持 active，等待合法 Fencing Takeover。
- 即使 Pause 随后已被清除，只要当前 Attempt 的 dispatching Event 之后
  存在 `recovery.evidence.pause_requested` Event 且该 Attempt
  未被 interrupt，Transaction B 仍必须拒绝。
- Authority / Lease / Fencing 失效：不写任何 fallback 状态，保持
  dispatching，由合法 Recovery 接管。
- 以上情况不得生成 EvidenceRead、Transaction B Check 或 completed
  Event。
- 如果 Payload Store 已写入，文件可以成为 orphan；不得据此补写
  Transaction B。

状态转换：

```text
Attempt: dispatching -> completed
ToolRun: running -> succeeded
PlanStep: running -> completed
ExecutionPlan: active -> completed
Tool Message: 0 -> exactly 1
EvidenceRead: absent -> present
Transaction B Check: absent -> present
```

Transaction B 写入字段：

```text
VerificationCheck.expected_payload_digest
  = semantic digest

Attempt.result_digest
  = semantic digest

EvidenceRead.result_payload_digest
  = semantic digest

EvidenceRead.result_payload_store_ref
  = Store Ref derived from storage digest

EvidenceRead.result_payload_storage_mode
  = content_addressed_file
```

ToolRun output 与 Tool Message：

- 只保存稳定状态和 redacted reference。
- 不保存 raw Payload、本地路径、Store 内部路径或敏感字段。
- 不允许 `completeOwnedRecoveryEvidenceRead()` 在缺少明确 redacted
  message 时自动把完整 Tool Output 序列化进 Message。

事务边界：

- External Read 和 Payload Store 写入都在 Transaction B 之外。
- Transaction B 只接收已经验证并规范化的结果引用。
- Transaction B UoW 不调用 Registry、Host callback、ToolRegistry 或
  Payload Store，只校验持久化 ID / digest / status / version 绑定。
- Store 与 SQLite 非原子；Transaction B 失败时 DB 保持 dispatching /
  running / active 组合。

测试与验收：

- 每个 DB write 点 fault injection。
- 任一失败无 Check / EvidenceRead / Message partial。
- PlanStep 与 Plan 同步完成。
- Event、Checkpoint 不重复。
- Tool Message 恰好一个。

不在本小节：Verifier 执行、Controlled Provenance。

### Stage 4.5 Replay & Fault Injection

前置条件：

- Transaction B 已完整提交，或持久化记录处于可分类的 dispatching 状态。
- 当前 Owner 通过 Lease / Fencing / Authority 检查。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `src/storage/recovery-evidence-verification-check-repository.ts`
- `tests/storage/recovery-evidence-transaction-b.test.ts`

Transaction B Replay 不能只依赖 ToolRun status。权威输入：

```text
Task ID
Request ID
Request Intent Digest
ReadAttempt ID
Read ToolRun ID
Plan ID / PlanStep ID
Allowlist ID / Version
Tool Name / Version / Schema Hash
Retry Safety / Consistency Mode
Expected Resource Version / ETag
Actual Resource Version / ETag
Semantic Digest
Storage Digest-derived Store Ref
Verification Check ID
EvidenceRead ID
Tool Message identity
Events / Checkpoint
```

Replay 顺序：

```text
Lease / Fencing / Authority
  -> lookup Check by readbackRequestId
  -> lookup EvidenceRead by verificationCheckId
  -> if complete:
       compare every immutable binding and normalized result field
       return persisted Transaction B result
       no writes / no Store read / no External Read
  -> if absent:
       validate dispatching Attempt + running ToolRun
       latest Cancel Intent:
          exists -> do not execute Transaction B
       latest Pause Intent:
          exists -> do not execute Transaction B
       Task CAS
       execute Transaction B once
```

一致性与失败：

- Check 存在但 EvidenceRead 缺失：`state_inconsistent`，不得补造。
- EvidenceRead 存在但 Check 缺失：`state_inconsistent`。
- 相同 Check ID 绑定不同 Attempt / payload digest / resource version：
  拒绝。
- 部分 Message / Event / Checkpoint：停止自动流程并人工 Review。
- Payload orphan 存在但 DB 无完整关系：只能视为非证据文件。
- Transaction B Replay 不新增 Event、Checkpoint、Check、Message 或
  Attempt。

幂等边界：

- Transaction B Replay：Request + Attempt + ToolRun + EvidenceRead +
  Transaction B Check。
- Final Verification Replay：Verification Check + final Verification +
  verification requestKey。
- 两者不得混用；Transaction B Check 完成不等于 Verification 完成。

事务边界：

- Replay lookup、绑定比较和缺失分支的 Transaction B 在同一 immediate
  transaction 中完成。
- exact replay 分支只读 DB，不读 Payload Store、不执行 External Read、
  不写 Event / Checkpoint。

状态转换：

- complete Replay：不改变任何状态。
- missing 且绑定一致：执行 Stage 4.4 的完整转换。
- partial / conflict：不改变状态，返回 state_inconsistent。

Stage 4 Fault Injection：

- Tool Registry validation / execution。
- Result Schema、Metadata Extractor、Version Compare。
- Payload canonicalization、size limit、Store put。
- Transaction B 的每个 DB write。
- Check insert、EvidenceRead insert、Tool Message uniqueness。
- Events / Checkpoint。
- 外部成功但 Transaction B 每个阶段失败。
- Store success + B fail + process restart。
- stale owner Transaction B。

测试与验收：

- External Read 始终在 SQLite transaction 外。
- Transaction B 全有或全无。
- Version mismatch 不产生 EvidenceRead。
- 相同 Check ID、不同结果拒绝。
- exact replay 零外部调用、零新增 Event / Checkpoint。
- Store orphan 不被判定为成功提交。
- 无 exactly-once 外部调用声明。

不在本 Stage：

- Controlled Provenance capability。
- Verifier 调用。
- Final RecoveryReview。

## 7. Stage 5 — Controlled Provenance & Verification

### Stage 5.1 Controlled Provenance Loader

前置条件：

- Transaction B 已完整提交。
- EvidenceRead、Transaction B Check、Tool Message 和 PlanStep 原子可见。
- Stage 4 已证明外部结果来自 exact Allowlist Version。

生产代码范围：

- `src/recovery/recovery-evidence-controlled-provenance.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/task-snapshot.ts`
- `tests/recovery/recovery-evidence-controlled-verification.test.ts`

事务边界：

- Provenance loader 在一个 SQLite read transaction 内读取完整关系图。
- 不接受调用方传入的普通 provenance object。
- transaction 内不调用 Host、Verifier 或 Payload Store。

状态转换：

- 本小节只读，不改变 Request / Attempt / ToolRun / Plan / PlanStep /
  EvidenceRead / Check。
- 完整性失败只产生内存分类结果，不写 Event 或修复记录。

完整链：

```text
Recovery Readback Request
  + completed ReadAttempt
  + succeeded Read ToolRun
  + exactly one corresponding Tool Message
  + completed recovery_evidence PlanStep
  + completed recovery_evidence ExecutionPlan
  + EvidenceRead
  + Transaction B Verification Check
```

必须一致：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
readbackRequestId
readAttemptId
readToolRunId
planId
planStepId
verificationCheckId
allowlistId / allowlistVersion
```

Capability：

- 模块私有 `WeakMap<object, ProvenanceRecord>`。
- 只有 DB 完整性校验通过的 loader 可以 mint。
- 普通 object、boolean、TypeScript cast、JSON clone 或不同模块实例均不能
  伪造 capability。
- capability 不暴露文件路径、Payload bytes、Repository、UoW 或写能力。

失败：

- 缺少任一节点、ToolMessage 数量不为 1、PlanStep / Plan 未完成：
  返回稳定 `state_inconsistent`，不自动补造记录。

测试与验收：

- 完整链成功。
- 缺 Request / Attempt / ToolRun / Message / PlanStep / Plan / EvidenceRead
  / Check 任一节点均拒绝。
- cross-request、cross-task、cross-review 混合记录拒绝。
- `payloadType=readback_result`、Tool Name、Allowlist ID、Store Ref 任一
  单独字段都不能 mint capability。
- Stored Evidence 不能伪装 controlled provenance。

不在本小节：Verifier 执行、Verification 持久化。

### Stage 5.2 EvidenceRead Payload Binding

前置条件：

- 已有合法 controlled provenance capability。
- EvidenceRead 的 Payload binding 字段完整。

生产代码范围：

- `src/recovery/recovery-evidence-payload-integrity.ts`
- `src/recovery/recovery-evidence-controlled-provenance.ts`
- `src/recovery/evidence-payload-store.ts`
- `tests/recovery/recovery-evidence-controlled-verification.test.ts`

唯一 Payload Binding：

```text
EvidenceRead.resultPayloadDigest
EvidenceRead.resultPayloadStoreRef
EvidenceRead.resultPayloadStorageMode
EvidenceRead.verificationCheckId
```

读取流程：

```text
verified capability
  -> exact Transaction B Check
  -> exact Allowlist Version + Result Schema identity
  -> derive storage digest from EvidenceRead Store Ref
  -> PayloadStore.read(storeRef, storageDigest)
  -> compute storage digest
  -> validate fixed RecoveryReadbackResult Schema
  -> compute semantic digest
  -> compare with EvidenceRead.resultPayloadDigest
  -> compare with Check.expected_payload_digest
  -> single-read VerifiedEvidencePayload handoff
```

约束：

- 只读取一次 Payload Store。
- 不重新读取 Store 获取 Verifier 输入。
- 不回退到 Original Manifest payload ref。
- 不把 Verification Check 中的 expected digest 复制为 observed digest。
- `resultPayloadStorageMode` 必须为 `content_addressed_file`。
- 找不到 Allowlist Version、Digest mismatch、I/O failure、Schema failure
  均 fail closed。

事务边界：

- Payload Store 读取和 Integrity 计算在 SQLite transaction 外。
- DB binding 由 capability 对应的 transaction snapshot 提供；读取前后
  仍需由最终 Verification UoW 校验 Authority。

状态转换：

- 本小节不写 DB。
- Integrity 通过只产生 Verified Payload handoff；失败不改变
  Transaction B 状态。

测试与验收：

- 使用 EvidenceRead ref，不使用 Manifest ref。
- 一次 Store read，一次 Verified Payload handoff。
- Storage / Semantic / Schema failure 不产生 Verifier 输入。
- 不泄露 Store 路径或 Payload。

不在本小节：Host Verifier。

### Stage 5.3 Controlled Verification Runtime

前置条件：

- Controlled provenance capability 合法。
- VerifiedEvidencePayload 合法。
- 持久化 Transaction B Check 的 Verifier Binding 完整。

生产代码范围：

- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-verifier-registry.ts`
- `src/recovery/recovery-verifier-registry.ts`
- `tests/recovery/recovery-evidence-controlled-verification.test.ts`
- `tests/recovery/recovery-verifier-runtime.test.ts`

新增受控入口：

```text
RecoveryEvidenceVerificationService.verifyPersistedControlledReadback()
```

流程：

```text
Lease / Fencing / Authority
  -> Transaction B Check exact replay
  -> final Verification exact replay
  -> latest Task-wide Cancel Intent:
       exists -> do not start Verifier
  -> latest Task-wide Pause Intent:
       exists -> do not start Verifier / verify-only recovery paused
  -> load controlled provenance
  -> load verified EvidenceRead payload
  -> exact persisted Verifier Binding resolve
  -> Host Verifier execution
  -> single-settle result
  -> final Authority / Intent check
  -> record Verification UoW
```

Runtime 扩展：

- 只有 module-private capability 能让 `hasReadback=true`。
- 只有 capability 能填入非 NULL `readbackToolRunId`、`toolMessageId`。
- `payloadType=readback_result` 不能改变 provenance。
- Stored Evidence V0 路径继续保持 `hasReadback=false`。
- 持久化 verifierId / version / config digest 必须 exact resolve。
- 不接受当前 Registry 最新版冒充历史 Binding。
- Verifier 自报 Integrity / Authenticity 不能覆盖 Host 结论。

事务边界：

- Exact Check / Verification Replay 使用只读查询。
- Payload 读取、Verifier Resolve 和执行位于 SQLite transaction 外。
- 最终状态写入只通过 Stage 5.4 Verification UoW。

状态转换：

- Runtime 本身不写 DB。
- started Verifier 的结果交由 Stage 5.4 映射为 passed / failed /
  inconclusive。
- 未启动 Verifier 映射为 not_run；本小节不直接提交。

Verification 状态：

- Integrity failure：`not_run`，无 Verification Event。
- Runtime resolve failure：`not_run`，无 Verification Event。
- Verifier started 后 passed / failed / reject / timeout：
  `passed` / `failed` / `inconclusive`，Verification Event 必填。
- `authenticityStatus` 固定 `unverified`。

测试与验收：

- 完整 provenance + verified payload 成功。
- 无 capability、错误 module instance、普通 object 均拒绝。
- Registry version / config mismatch 不执行 Verifier。
- late resolve / reject 不覆盖已有结果。
- Authenticity 始终 unverified。

不在本小节：自动 Recovery、Final RecoveryReview。

### Stage 5.4 Verification UoW Integration

前置条件：

- Verifier 已启动并产生一个可结算结果，或 Runtime 明确返回 not_run。
- 调用者仍持有有效 Lease / Fencing / Authority。

生产代码范围：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-verification-repository.ts`
- `tests/storage/recovery-evidence-transaction-c.test.ts`

事务边界：

- Check / Verification replay lookup、Intent gate、Event、Verification row
  和 Checkpoint 在一个 SQLite immediate transaction 内完成。
- Verifier 执行与 Payload Store 读取不在该 transaction 内。
- UoW 只核对持久化 Verifier ID / version / config digest、
  checkOrigin、Request / EvidenceRead / Attempt 绑定，不调用
  VerifierRegistry、Host Binding Provider 或 Verifier。

`recordOwnedRecoveryEvidenceVerification()` 必须强化：

```text
BEGIN IMMEDIATE
  -> Lease / Fencing / Authority
  -> existing Verification requestKey replay
  -> Check ID / origin / controlled capability requirement
  -> EvidenceRead / Attempt / Request identity
  -> existing Verification replay: return before Intent gate
  -> new write latest Cancel:
       exists -> no Verification write
  -> new write latest Pause:
       exists -> no Verifier / no new Verification
  -> Task version CAS
  -> Availability Event（所有最终 Verification 必填）
  -> optional Verification Event
  -> Verification row
  -> Checkpoint
COMMIT
```

状态转换：

```text
Verification: absent -> present
Availability Event: absent -> exactly 1
Verification Event: absent -> 0（not_run）或 1（started）
Checkpoint: previous -> one new checkpoint
```

规则：

- exact Verification replay 先于新写入 intent gate。
- new write 必须在 transaction 内重新检查 Intent。
- `verificationStatus=not_run` 时 Verification Event 必须 NULL。
- 非 `not_run` 时 Verification Event 必填。
- `controlled_runtime_read` 必须绑定 Request、EvidenceRead、ReadAttempt。
- Original Unknown Write ToolRun 保持 `unknown`，Verification 不修改。
- Recovery Read ToolRun 在 Transaction B 成功后保持 `succeeded`，
  Verification 同样不修改它。
- Task.status 保持 waiting_review。

测试与验收：

- 每个写入点 fault injection。
- exact replay 零新增 Event / Checkpoint / Verification。
- not_run / passed / failed / inconclusive Event 约束。
- Cancel / Pause / Authority 撤销阻止新写入。
- 旧 Owner 晚到结果不能提交。

不在本小节：Final RecoveryReview 决策。

### Stage 5.5 Regression

前置条件：

- Stage 5.1–5.4 已完成。

生产代码范围：

- 上述 Stage 5 文件。
- `tests/recovery/recovery-evidence-controlled-verification.test.ts`
- `tests/recovery/recovery-verifier-runtime.test.ts`
- Step 6.3.4.3 Verification Regression tests。

事务边界：

- Regression 必须分别覆盖 read transaction、外部 Verifier 执行和
  Verification immediate transaction。
- 不得用测试 helper 绕过 UoW 写入。

状态转换：

- Replay 路径不改变状态。
- 新 Verification 路径只允许 absent -> present。
- not_run / passed / failed / inconclusive 与 Event 数量必须一致。

必须回归：

- Step 6.3.4.3 Stored Evidence V0 Verification。
- Exact Check / Verification Replay。
- Authenticity 固定 unverified。
- Verifier timeout / late resolve / late reject。
- Transaction B Check 与 final Verification 的幂等边界。
- 普通 Agent Recovery 不读取 Recovery Evidence Verification。

测试矩阵：

- 完整 controlled provenance 通过。
- 缺任一持久化节点拒绝。
- cross-request / cross-task 拒绝。
- Stored Evidence 不可伪造 controlled provenance。
- EvidenceRead payload binding 成功。
- Replay 不重复调用 Verifier。
- Authority / Lease / Fencing 失效不能提交。
- Cancel / Pause 使新 Verification 写入失败。

验收：

- Controlled provenance 不可由普通结构伪造。
- Verification 不重新执行 Read。
- Verifier 不读取 Original Manifest payload。
- Stored Evidence V0 语义不回归。
- 专项测试、typecheck、diff check 通过。

不在本 Stage：

- 自动 Recovery 调度。
- Final RecoveryReview。

## 8. Stage 6 — Recovery Manager / Classifier

### Stage 6.1 Recovery Candidate

前置条件：

- Stage 3–5 的 UoW 和状态转换已通过评审。
- `TaskSnapshotReader` 在一个 read transaction 内提供 Request、Attempt、
  Reservation、Plan、PlanStep、ToolRun、Message、EvidenceRead、Check 和
  Verification。
- Reservation 尚未加入 TaskSnapshot；Stage 6 必须通过现有 Reservation
  Repository 在同一个 read transaction 中补充投影，不修改数据库 Schema。

生产代码范围：

- `src/recovery/recovery-types.ts`
- `src/recovery/recovery-evidence-readback-recovery.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/recovery-evidence-readback-reservation-repository.ts`
- `tests/recovery/recovery-evidence-readback-recovery.test.ts`

分类单位：

```text
taskId + readbackRequestId + executionPlanId
```

Request 尚未创建时：

```text
taskId + reservationId + requestIntentDigest
```

候选结构至少包含：

```text
taskId
reservationId | readbackRequestId
executionPlanId
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
attemptIds
persistedStatuses
verificationStatus
verificationReasonCode
cancelRequestedAt
pauseRequestedAt
persistedFacts
classification
reasonCodes
manualReviewRequired
```

事务边界：

- Candidate 构造与分类只读。
- 分类阶段不 Claim Lease、不写 Event、不执行 Host callback、不调用
  Tool、Verifier 或 Payload Store。

状态转换：

- 本小节不改变任何持久化状态。
- 候选只反映同一个 read transaction 内的事实快照。

测试与验收：

- 一个 Task 的多个 Request 各自产生候选。
- 候选不通过 Task 聚合状态覆盖 Request 事实。
- 不存在无关 Request 混入同一候选。

不在本小节：自动执行、Lease Claim、External Read。

### Stage 6.2 Recovery Classifier

前置条件：

- 6.1 已提供完整 Request-scoped candidate。
- Classifier 本身不拥有写权限。

生产代码范围：

- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-evidence-readback-recovery.ts`
- `tests/recovery/recovery-classifier.test.ts`

事务边界：

- Classifier 使用一个只读 Snapshot / Reservation 投影。
- 分类结果不获得写入权限，不能直接更新状态。
- Classifier 不调用 Registry、Host callback、Tool 或 Verifier。
- Classifier / RecoveryManager 不得清除 Pause；只有 Host 显式 Resume
  请求可以调用 Pause clear UoW。
- exact Allowlist / Retry Safety 的可用性由 Classifier 之后的 Recovery
  Executor 在 transaction 外 preflight；失败可以把候选升级为
  manual_review_required。

状态转换：

- 本小节不写状态。
- 分类只输出 recommendation / reasonCode / manualReviewRequired。
- `blocked_by_intent` 只有在 Pause Intent 清除后才可分类为
  resume_ready；分类本身不会清除 Intent。

分类：

```text
reservation_preparing
reservation_abandoned
reservation_completed_inconsistent
read_not_dispatched
read_in_progress
read_outcome_uncertain
read_interrupted
pause_blocked
resume_ready
cancel_owner_required
cancel_takeover_required
verification_pending
verification_not_run
verification_passed
verification_failed
verification_inconclusive
verification_blocked_by_cancel
completed_exact_replay
historical_replay_only
intent_blocked
state_inconsistent
manual_review_required
```

| 持久事实 | 分类 | 允许动作 |
|---|---|---|
| Reservation preparing + 当前有效 owner | reservation_preparing | 当前 owner 可继续；其他 Worker in_progress |
| Reservation abandoned / stale preparing | reservation_abandoned | 新合法 fencing owner 可 reclaim |
| Reservation completed + Request / Plan / ToolRun / Attempt 不完整 | reservation_completed_inconsistent | fail closed / manual |
| Attempt prepared + ToolRun queued + Intent clear | read_not_dispatched | Retry Safety Gate 后 Dispatch |
| Attempt blocked_by_intent + Pause Intent still present | pause_blocked | 只等待；不创建新 Attempt |
| Attempt blocked_by_intent + Pause cleared Event + no newer Pause | resume_ready | `resumeBlockedOwnedRecoveryEvidenceRead()` 创建 new Attempt |
| Attempt dispatching + ToolRun running + 原 Owner Lease 有效 | read_in_progress | 不接管、不重跑 |
| Attempt dispatching + 合法新 fencing owner | read_outcome_uncertain | Retry Safety 后由 Stage 3.4 接管 |
| Attempt interrupted + ToolRun interrupted + resumeEligible | read_interrupted / resume_ready | 合法接管 + Retry Safety 后由 Stage 3.4 新建 Attempt |
| Cancel Intent + 原 Owner Lease 有效 | cancel_owner_required | 原 Owner 调用 Cancel UoW |
| Cancel Intent + 原 Owner Lease 失效 | cancel_takeover_required | 新 Owner Takeover 后直接 Cancel UoW，不 Retry |
| Cancel Intent + Transaction B 已完成 | completed_exact_replay / verification_blocked_by_cancel | 不回滚；existing Verification Replay，missing 不自动运行 |
| EvidenceRead + Check + Verification missing | verification_pending | exact historical Binding + retry-safe Verifier 时只跑 Verifier |
| Task-wide Pause + Verification missing | pause_blocked | 不启动 Verifier；等待 Host 显式 Resume |
| Verification.status = not_run | verification_not_run | Exact Replay；不自动调用 Verifier |
| Verification.status = passed | verification_passed | Exact Replay；无自动动作 |
| Verification.status = failed | verification_failed | Exact Replay；人工 Review / 新证据 |
| Verification.status = inconclusive | verification_inconclusive | Exact Replay；人工 Review / 新 Check |
| v8 Request 无 Reservation | historical_replay_only | 历史 Replay；不得 Dispatch |
| Pause Intent + prepared 尚未写 block | intent_blocked | 只执行 Pause block UoW |
| Cancel Intent + 其他非 terminal 状态 | intent_blocked | 按 ownership 选择 Cancel 或 Takeover 后 Cancel |
| 跨 ID、部分写入、冲突终态 | state_inconsistent | fail closed / manual |
| Exact Allowlist Version 缺失或 Retry Safety 不满足 | manual_review_required | 不 Read、不 Verifier |

关键规则：

- `Attempt=dispatching + ToolRun=running` 只说明结果不确定，不授权改状态。
- Pause Intent 存在时优先于 Dispatch / Resume：
  - prepared -> 只允许 Pause block UoW。
  - dispatching -> Pause observed / abort，保持 dispatching，等待合法
    Takeover。
  - 不得在没有后续明确 Resume 的情况下创建新 Attempt。
- Cancel Intent 优先于 Retry Safety 和 Pause Resume：
  - 不创建新 Attempt。
  - 原 Owner 有效时原地 Cancel。
  - 原 Owner 失效时必须先 Fencing Takeover，然后 Cancel。
  - Cancel 完成后不得再恢复该 Request。
- 当前 Owner Lease 有效时，其他 Recovery Worker 不得接管。
- 只有新 Worker 合法 Claim Lease、取得严格更大的 fencingToken 并绑定
  新 ExecutionAuthority 后，才能执行 Stage 3 Interrupted Recovery UoW。
- Recovery UoW 仍必须重新执行 Retry Safety Gate。
- Classifier 的分类是执行建议，不是执行授权。

Verification 状态策略：

| 状态 | 自动恢复 | Exact Replay | 人工 Review |
|---|---|---|---|
| missing | 仅当 exact persisted Verifier Binding 可解析时执行 Verifier | 若执行中断且 Check 仍 pending，返回 pending | Binding / EvidenceRead 不完整时 |
| not_run | 否 | 返回持久化 not_run | integrity failure、binding unavailable、config mismatch、Registry miss 时 |
| passed | 否 | 返回持久化 passed | 不要求；最终结论仍由 Step 6.3.5 决定 |
| failed | 否 | 返回持久化 failed | 需要人工决定新证据或是否重新发起明确验证 |
| inconclusive | 否 | 返回持久化 inconclusive | 需要人工 Review 或显式新 Check |

Verification 规则：

- `not_run` 不是成功，也不是通过。
- 已存在的 not_run / passed / failed / inconclusive 都是持久化终态结果，
  不得被自动 Recovery 覆盖。
- 不得使用当前最新 Verifier / config 重新解释历史 Check。
- 要重跑 not_run 或 inconclusive，必须建立新的明确 Verification Check
  ID；不得复用旧 Check 改写历史。
- Verification Recovery 只修复“Check 存在但 Verification 尚未写入”的
  pending 状态。
- Verification missing 可能表示 Verifier 未开始、已开始但进程崩溃，或
  已完成但 Verification UoW 未提交；当前没有 Verifier Attempt，
  因此只有满足 Verifier Retry Safety Contract 时才允许自动重跑。

测试与验收：

- 所有状态组合有稳定分类。
- 当前 owner 有效时其他 Worker 只能 in_progress。
- Stale / abandoned 只有合法 takeover 后可执行。
- Pause 未清除时不得 Resume / Dispatch。
- RecoveryManager 扫描 Pause 时只返回 pause_blocked，不写 clear Event。
- Pause 清除后必须有 `pause_cleared` Event；resume_ready 仍需对应
  blocked / interrupted UoW，不得直接调用 External Read。
- 所有冲突状态 fail closed。

不在本小节：状态写入、External Read、Verifier。

### Stage 6.3 Readback Recovery Executor

前置条件：

- Consumer 已取得合法 Lease / Fencing / ExecutionAuthority。
- Classifier 返回可恢复分类。
- 原 Request 有完整 v9 Reservation；历史 Request 不满足条件。

生产代码范围：

- `src/recovery/recovery-evidence-readback-recovery.ts`
- `src/recovery/recovery-evidence-readback-executor.ts`
- `src/recovery/recovery-manager.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `tests/recovery/recovery-evidence-readback-recovery.test.ts`

事务边界：

- 分类与 stale 检查是只读操作。
- Cancel Intent 在任何 Registry / Retry preflight 之前处理；Cancel 不要求
  当前 Host 配置可解析。
- Registry exact lookup、Host Source Resolver、ToolRegistry input
  revalidation 和 Retry Safety contract 解析在 SQLite transaction 外。
- active Attempt 按状态分流：prepared 继续 Dispatch；dispatching 先核对
  当前 ownership 与 dispatching Event fencing，再决定 in_progress 或
  Stage 3.4 Recovery。
- Pause interruption-only 只做持久化身份 / fencing 校验，不需要
  Registry / RetryPreflightBinding。
- 状态恢复由 Stage 3.4 UoW；External Read 在 Dispatch Commit 后单独执行。
- 结果提交由 Transaction B 完成。

Host 显式 Resume 授权边界：

```text
Host receives explicit user/operator Resume request
  -> clearTaskWideRecoveryEvidencePause()
  -> pause_requested_at = NULL
  -> pause_cleared Event + Checkpoint
  -> COMMIT
  -> RecoveryManager may observe resume_ready
  -> resumeBlocked / Stage 3.4
```

RecoveryManager / Classifier / Executor 均不得调用 clearPauseIntent，也不得
把“没有 active Attempt”解释为可以自行清除 Pause。

执行边界：

```text
Task Lease Claim / Heartbeat
  -> new ExecutionAuthority
  -> reload Request-scoped facts
  -> verify current lease / fencing
  -> if caller carries an old recoveryOperationId:
       execute Recovery Lineage Exact Replay first
  -> if Cancel Intent:
       if current owner owns original Attempt:
          cancelOwnedRecoveryEvidenceRead()
       else if legal Takeover completed:
          cancelOwnedRecoveryEvidenceRead()
       else:
          wait / fail closed
       -> return cancelled
  -> if Pause Intent present and no legal interruption Takeover is needed:
       return pause_blocked；RecoveryManager does not clear Pause
  -> if active Attempt = prepared:
       keep persisted Attempt ID
       if Pause Intent present:
          blockOwnedRecoveryEvidenceReadForIntent()
          return pause_blocked
       else:
          Host preflight + Stage 4.1
          Stage 3 Dispatch UoW
  -> if active Attempt = dispatching:
       if current lease is original owner lease and fencing matches
          dispatching Event:
            no takeover / no second External Read / in_progress
       else if new fencingToken > dispatching Event.fencingToken
          and legal Lease Takeover completed:
            if Pause Intent present:
              Stage 3.4 interruption-only with new recoveryOperationId
              return interrupted / wait for explicit clear + Resume
            else:
              exact Allowlist / Retry / Consistency / Input preflight
              Stage 3.4 interruption + new Attempt prepared
                with new recoveryOperationId
       else:
            fencing conflict / fail closed
  -> if no active Attempt and prior Attempt = interrupted:
       verify interruption Event / resumeEligible
       if Pause Intent present: return pause_blocked
       verify matching pause_cleared Event for Pause source
       exact Allowlist / Retry / Consistency / Input preflight
       Stage 3 Interrupted Recovery UoW with new recoveryOperationId
  -> if no active Attempt and prior Attempt = blocked_by_intent:
       if Pause Intent present: return pause_blocked
       require matching pause_cleared Event
       resumeBlockedOwnedRecoveryEvidenceRead()
  -> if terminal:
       return persisted result / pending state
  -> Stage 4 Read Executor Preparation（复用 RetryPreflightBinding）
  -> Stage 3 Dispatch UoW（恰好一次）
  -> External Read outside SQLite
  -> Transaction B
```

状态规则：

- Intent 优先级固定：

```text
Cancel Intent -> Cancel UoW -> cancelled
else Pause Intent -> Pause block / interruption path -> pause_blocked
else -> Retry preflight -> Preparation -> Dispatch
```

- 当前 Owner 有效时不接管。
- `dispatching + 原 Owner Lease 有效`：in_progress，不调用 External Read。
- `dispatching + fencingToken <= Dispatch Event fencing`：不得接管。
- `dispatching + fencingToken > Dispatch Event fencing + 合法 Takeover`：
  进入 Stage 3.4。
- Cancel Intent 路径不执行 Retry Safety、不创建 new Attempt，直接走
  Cancel UoW。
- `cancelled` 只表示系统不再接受本次 Readback 结果，不代表外部调用
  未发生。
- `read_outcome_uncertain + no Pause` 可在同一 transaction 内把旧 Attempt
  标记 interrupted 并创建新 Attempt prepared。
- `dispatching + Pause` 只能由合法 Takeover 先写 interrupted；Pause
  清除后才创建下一 Attempt。
- `read_interrupted` 若已有下一次 prepared Attempt，则不得再创建并行
  Attempt。
- PlanStep 按真实状态机使用 `interrupted -> running`。
- `failed` / `timed_out` / `cancelled` 不自动重试同一 Request。
- Pause Intent 存在时不得创建新 Attempt；解除后 blocked 状态由
  `resumeBlocked...`、interrupted 状态由 Stage 3.4 创建后续 Attempt。

状态转换：

```text
Pause 未清:
  dispatching -> interrupted
  running ToolRun -> interrupted
  running PlanStep -> interrupted
  no new Attempt

Pause 已清:
  dispatching -> interrupted -> new Attempt prepared
  running ToolRun -> interrupted -> queued
  running PlanStep -> interrupted -> running
  Plan -> 保持 active
```

上述转换必须分别由 Stage 3.4 和 Stage 4.1–4.4 的 UoW 执行。

Retry Safety Gate 必须包含：

- exact Allowlist ID / Version。
- Retry Safety / Consistency Mode。
- Expected Resource Version / ETag。
- normalized Tool Input / canonical hash。
- Lease / Fencing / Authority。
- Request / Attempt / ToolRun 持久化绑定。

Stage 3.4 UoW 内再次读取持久化字段并核对 RetryPreflightBinding；它不调用
Registry、Source Resolver、Argument Builder、ToolRegistry 或任何外部 I/O。

失败：

- Retry gate 失败：不调用 External Read；进入 manual / state inconsistent。
- Lease 在 classify 与 execute 之间失效：调用前 fail closed。
- 旧 Owner 晚到结果：Transaction B 拒绝。
- External Read 结果未知：保持 dispatching，等待下一轮合法 Recovery。

测试与验收：

- Lease 失效后 takeover 可恢复。
- 当前 Lease 有效时另一个 Worker 不执行。
- stale classification 在执行前失效。
- 原 Owner Lease 有效时不接管 dispatching。
- Cancel Intent + 原 Owner 有效时原地 Cancel。
- Cancel Intent + 原 Owner 失效时 Takeover 后 Cancel，不创建新 Attempt。
- Cancel 路径不调用 Registry / Retry Preflight / External Read。
- 合法 Takeover 后 dispatching 进入 Stage 3.4。
- Dispatch Event fencingToken 缺失 / 不递增时拒绝接管。
- `dispatching + running` 无合法 Retry Safety 时不发起 Read。
- 一个 Request 最多一个 active Attempt。
- 旧 Owner 晚到结果无法提交。

不在本小节：Verification Recovery、Final Decision。

### Stage 6.4 Verification Recovery

前置条件：

- Transaction B 已完整提交。
- EvidenceRead + Transaction B Check 完整可见。
- final Verification 缺失。

生产代码范围：

- `src/recovery/recovery-evidence-readback-recovery.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-verifier-registry.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `tests/recovery/recovery-evidence-controlled-verification.test.ts`

流程：

```text
valid Lease / Fencing / Authority
  -> exact Request / Attempt / EvidenceRead / Check
  -> controlled provenance
  -> EvidenceRead payload binding
  -> exact Verifier Binding
  -> Verifier
  -> Verification UoW
```

规则：

- Verification Recovery 不执行 Read。
- 已存在 Verification 时只 Replay。
- 不因当前 Host Verifier 配置更新而替换历史 Binding。
- 不把 `not_run` 或 `inconclusive` 解释为 Original Write 的最终结论。
- Cancel / Pause 只阻止新写入；已有结果可只读 Replay。
- 只有 Verification missing 才允许创建新 Verification。
- 若 historical Verifier Binding 无法精确恢复，保持 missing 并进入
  manual Review；不得用 active / latest Binding 替代。
- `not_run`、`passed`、`failed`、`inconclusive` 均不得被 Recovery
  覆盖；重复调用必须走 Exact Replay。
- Transaction B 已完成但 Cancel Intent 存在且 Verification missing 时，
  不自动调用 Verifier，分类为 verification_blocked_by_cancel。
- 需要重新验证 not_run 或 inconclusive 时，Host 必须提交新的明确
  Verification Check ID。

Verifier Retry Safety Contract：

Host 治理合同。Host 必须声明并治理以下属性：

```text
deterministic for same persisted Check / payload / binding
read-only
no external side effect
safe to compute more than once
no Repository / DB / UoW write
no mutable current time / Random / network dependency
```

上述声明、read-only / side-effect policy、deterministic execution contract
identity 必须进入扩展后的 Verifier Effective Config 并参与
`verifierConfigDigest`。未进入 digest 的进程当前开关不能作为历史
Binding 的 retry-safe 依据。新 Config 使用
`forgeflow.recovery-verifier-effective-config.v2`；历史 v1 Binding
只能 Exact Replay，不能自动 retry。

Runtime 可执行约束：

```text
exact persisted verifierId / version / config digest
fixed EvidenceRead payload + expected semantic digest
Host-owned timeoutMs
single-settle
late resolve / reject cannot overwrite persisted result
Verifier receives no Repository / UoW / DB capability
```

边界：

- Runtime 无法沙箱化或自动证明任意 TypeScript callback 的纯函数 /
  no-side-effect 属性；只能依赖 Host 注册治理、release review 和测试。
- 只有 Host 标记为 retry-safe 且 Runtime 能精确恢复历史 Binding 的
  Verifier，才允许在 Verification missing 时重复计算。
- 重复计算不得声称 exactly-once。
- 不满足 Host 治理合同或 Runtime 约束时，保持 Verification missing，
  分类为 manual_review_required，不调用 Verifier。
- 不得使用当前最新 Binding 替代历史 Binding。

事务边界：

- Provenance / payload / Verifier 均在 SQLite transaction 外。
- 最终写入只调用 Stage 5.4 Verification UoW。

状态转换：

- Verification missing -> present。
- Transaction B Check、EvidenceRead、Attempt、ToolRun 均保持不变。
- Verification Replay 不改变状态。

测试与验收：

- B 完成、Verification pending 时只执行 Verifier。
- Verifier exact replay 不重复调用。
- not_run / passed / failed / inconclusive 均 Exact Replay，不被重跑。
- `not_run` 不被视为 passed。
- historical Binding 缺失时不使用当前配置。
- deterministic / read-only / no-side-effect Verifier 可以在 missing 时重跑。
- 非确定性、有外部副作用或无法限制 Timeout 的 Verifier 不自动重跑。
- governance metadata 变化必须改变 verifierConfigDigest。
- 历史 Binding 缺少 governance digest 时不自动重跑。
- Runtime 不声称能够证明 TypeScript callback 的纯函数属性。
- retry-safe Verifier 重跑不声称 exactly-once。
- EvidenceRead payload ref 不与 Manifest ref 混用。
- Intent / Authority / Lease 失效阻止提交。
- 验证失败不修改 Task.status 或 Original Unknown Write。

不在本小节：Final RecoveryReview。

### Stage 6.5 RecoveryManager Integration

前置条件：

- 普通 Agent Recovery 与 Recovery Evidence Recovery 均有独立分类入口。
- `RecoveryManager` 继续作为 Lease 生命周期 owner。

生产代码范围：

- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-scanner.ts`
- `src/recovery/recovery-types.ts`
- `tests/recovery/recovery-classifier.test.ts`
- `tests/recovery/recovery-evidence-readback-recovery.test.ts`

入口：

```text
RecoveryManager.classifyEvidenceReadbacks(taskId)
RecoveryManager.recoverEvidenceReadbacks(taskId, ownerId)
RecoveryManager.recoverPendingEvidenceVerifications(taskId, ownerId)
HostResumeService.resumeEvidenceReadback(...)
```

`HostResumeService` 是唯一调用
`clearTaskWideRecoveryEvidencePause()` 的入口，之后才允许
RecoveryManager 处理 resume_ready。普通 RecoveryManager 扫描无法解除
Pause。

职责划分：

- RecoveryManager：Lease Claim、Heartbeat、ExecutionAuthority 生命周期、
  release。
- RecoveryEvidenceClassifier：只读 Request-scoped 分类。
- Readback Recovery Executor：Recovery-only Read/Transaction B。
- Verification Recovery：只运行 Verifier。

隔离规则：

- `recoverReadRuns()` 只处理 `purpose=agent`。
- Recovery Evidence 入口只处理 `purpose=recovery_evidence`。
- 不得把一个 Task 的聚合 classification 直接应用到所有 Request。
- Task 可同时存在：

```text
Request A -> read_outcome_uncertain
Request B -> verification_pending
```

两个 Request 必须分别处理。

事务边界：

- Lease / Authority 生命周期在 Manager。
- 每个 Request 的状态转换仍由各自 UoW 的 immediate transaction 完成。
- Classifier 与 executor 之间重新读取持久事实，禁止使用 stale report
  直接写状态。

状态转换：

- Manager 不直接改变 Request / Attempt / ToolRun / Verification 状态。
- 状态变化只由 Stage 3 / 4 / 5 的 UoW 完成。
- Task-wide Cancel Intent 必须枚举同一 Task 下全部 Recovery Evidence
  Request：completed 只 Replay，非 terminal 分别调用 Cancel UoW。

测试与验收：

- 多 Request 不同状态独立分类与执行。
- ordinary Agent Recovery 不处理 recovery evidence Plan。
- recovery evidence recovery 不处理 Agent Plan。
- Lease takeover 后 stale classification 不提交。
- RecoveryManager 不得替 Host 清除 Pause。
- Manager release 后无遗留 Authority。

不在本小节：Final RecoveryReview、Task terminal transition。

### Stage 6.6 Recovery Regression

前置条件：

- Stage 6.1–6.5 已完成。

生产代码范围：

- Stage 6 的 classifier、executor、Manager integration 和 TaskSnapshot
  Reservation 投影。
- `tests/recovery/recovery-evidence-readback-recovery.test.ts`
- `tests/recovery/recovery-classifier.test.ts`
- Stage 3–5 全量回归测试。

事务边界：

- Regression 必须验证 classify 与 execute 之间重新读取事实。
- 所有恢复写操作仍必须经过对应 immediate transaction。

状态转换：

- 覆盖 read-only / reclaim / interrupted retry / verify-only / fail-closed
  五类路径。
- 不得直接从 dispatching 或 running 跳到 completed。

必须覆盖：

- Reservation preparing / abandoned / completed。
- Request 已创建但未 Dispatch。
- Attempt prepared / dispatching / interrupted。
- Attempt blocked_by_intent + Pause 未解除 / 已解除。
- Cancel 对 prepared / dispatching / blocked / interrupted / terminal。
- External Read 结果未知。
- External Read 已返回但 Transaction B 未提交。
- Transaction B 完成、Verification pending。
- Verification 已完成。
- Verification not_run / passed / failed / inconclusive。
- 同一 Request 出现 interrupted Attempt + EvidenceRead + Check 的冲突。
- Lease 失效与 Fencing Takeover。
- Cancel / Pause 在 classify 与 execute 之间出现。
- 历史 v8 Request 无 Reservation 的只读 Replay。
- 普通 Agent Recovery 与 Recovery Evidence Recovery 双向隔离。

验收：

- 每个 Request 独立决策。
- 当前 owner 有效时不被接管。
- 无合法 fencing 不得执行 Recovery 写。
- 不确定外部结果时禁止盲目自动重试。
- Pause 解除后 Resume 只创建 prepared Attempt，不直接 External Read。
- Recovery UoW 响应丢失后的 Exact Replay 不创建第二个 active Attempt。
- Recovery Lineage prepared / dispatching / completed 的状态化 Replay。
- 旧 recoveryOperationId 与新一轮 Recovery 的 lineage 不混淆。
- not_run 不会被当作 passed，也不会被当前最新 Binding 自动重跑。
- 不一致状态停止自动恢复并进入人工 Review。
- 自动恢复不修改 Task.status、Original Unknown Write 或 Final Review。
- 所有专项测试、Stage 1–5 回归、typecheck 和 diff check 通过。

不在本 Stage：

- Final RecoveryReview。
- Write 状态收敛。
- Task terminal transition。

## 9. Step 6.3.5 — Final RecoveryReview

Step 6.3.5 独立于 Step 6.3.4.4，只有在 Stage 3-6 完成后设计。

必须覆盖：

1. Final Decision Input。
2. expectedDecisionVersion CAS。
3. Evidence Submission + Verification 完整性。
4. Original Unknown Write 审计与最终状态处理。
5. `confirmed_succeeded` / `confirmed_not_executed`。
6. Cancel Intent 交互。
7. Decision Replay / Idempotency。
8. RecoveryReview Event。
9. Task/Plan 收敛。
10. 人工与自动决策边界。

审计约束：

- Original Unknown Write ToolRun 的历史 status、input、output、error 和
  Event 必须保持原值。
- Final Decision 通过新的 Review / Decision / Event 记录表达，不通过
  覆盖旧 ToolRun 表达。
- Task 在 Step 6.3.4.4 期间保持 `waiting_review`。
- 只有 Step 6.3.5 获得独立授权后，才设计 Task / Plan 最终收敛。
- 证据不足、Verification inconclusive、Retry Safety 不满足或状态不一致
  时，不得自动推断 Original Write 成功或未执行。

Step 6.3.4.4 封存前，本计划不授权 Step 6.3.5 的任何生产代码。

## 10. Schema 兼容性审查

当前 v9 已支持：

- Request / Attempt / Check / EvidenceRead / Verification。
- Reservation preparing / completed / abandoned。
- Attempt 状态、时间戳、reasonCode、result digest 和 Store Ref。
- Event/Checkpoint。
- Content-addressed Payload Store refs。
- ToolRun/Plan/PlanStep 状态。
- Request-scoped持久化。

本轮源码审查未发现必须新增 Migration v10：

- `prepared -> blocked_by_intent / cancelled` 与
  `dispatching -> failed / timed_out / cancelled / interrupted` 均已存在。
- `PlanStep interrupted -> running` 已由 ExecutionStateMachine 支持。
- `ToolRun interrupted -> queued` 已由 ExecutionStateMachine 支持。
- `EvidenceRead` 允许受控 Payload digest / Store Ref / storage mode。
- `Verification` 允许 Availability Event 必填、Verification Event 可选。
- Reservation 唯一约束和完成不变量足以支持现有预分配 ID。

需要应用层补齐：

- ExecutionPlan status update repository。
- Dispatch / Failure / Recovery UoW。
- TaskSnapshot 的 Reservation 只读投影。
- Transaction B 复合 Replay lookup。
- Controlled provenance capability。
- Controlled Verification loader。
- Request-scoped classifier / manager。
- Tool Input 跨进程重新验证，不修改 ToolRegistry 公共 token 语义。
- Host-only Pause set / clear，使用 Task version + pauseRequestedAt CAS。
- Dispatch / Failure / Cancel / Pause / Resume / Recovery Exact Replay。
- Recovery Attempt ID 生成和同一 Request single-active-Attempt guard。

已确认不需要通过修改 Migration 解决的问题：

- `PlanStep interrupted -> queued` 错误：修正为 `interrupted -> running`。
- Dispatch 重复：只保留 Stage 3 UoW，Stage 4 调用它。
- Attempt 结果不确定：使用现有 `dispatching`，不新增状态。
- 旧 Owner 晚到结果：使用现有 Lease / Fencing / Authority + UoW 拒绝。
- Pause 清除：`tasks.pause_requested_at` 已允许 NULL；需要新增应用层
  CAS 清除方法，不改 Schema。
- Retry Attempt ID：现有 Attempt 主键和
  `(request, toolRun, attempt_number)` 唯一约束已足够，后续 ID 由 Host
  生成。
- Verification not_run：现有 Verification 状态和 Event 约束已足够。
- Verifier retry governance：通过扩展 Host Effective Config 并更新
  verifierConfigDigest 表达，不需要新增数据库列。
- Allowlist Contract Digest：已持久化在 Request 的
  `allowlist_version` 字段；v9 Reservation 通过 request_id 关联，不需要
  重复列。

### 10.1 State Liveness

修订后的合法出口：

| 当前状态 | 合法后续 |
|---|---|
| prepared + Pause | blocked_by_intent -> Explicit Resume -> new prepared |
| dispatching + Cancel + 原 Owner 有效 | Cancel UoW -> cancelled |
| dispatching + Cancel + 原 Owner 失效 | legal Takeover -> Cancel UoW -> cancelled |
| dispatching + Pause | legal Takeover -> interrupted（不创建 Attempt）-> Host explicit clearPause -> Recovery -> new prepared |
| dispatching + outcome uncertain | interrupted / waiting recovery -> new prepared |
| blocked_by_intent + Pause cleared | resumeBlockedOwned -> new prepared |
| interrupted + resumeEligible + Pause cleared | recoverOwned -> new prepared |
| Verification missing | Verification Recovery / pending Replay |
| Verification not_run / passed / failed / inconclusive | Exact Replay；显式新证据或新 Check |
| failed / timed_out / cancelled | 当前 Request 终态；显式新 Request |
| historical Request without Reservation | 历史 Replay；manual Review |

有意终态不是“状态死路”：

- failed / timed_out / cancelled 必须通过新的明确请求继续，不得原地
  复活旧 ToolRun。
- `not_run` 必须保留历史，不得用新 Binding 覆盖旧 Check。
- 历史 Request 缺 Reservation 时只能 Replay 或人工处理。

不允许存在：

- blocked_by_intent 没有 Resume 入口。
- interrupted 没有来源 Event 或没有合法 Resume / fail-closed 分类。
- Verification missing 与 not_run 混淆。
- 普通 Interrupted Recovery 的 interruption 与 new Attempt 不得分属
  不同 transaction。

明确区分：

- 普通 Interrupted Recovery：`dispatching -> interrupted`、ToolRun
  `running -> interrupted -> queued`、PlanStep
  `running -> interrupted -> running`、new Attempt prepared 必须在同一
  immediate transaction 内提交。
- Pause-induced Interrupted Recovery：合法 Fencing Takeover 后先持久化
  interrupted，不创建 new Attempt；Host 显式 clearPause 后，再由新的
  Stage 3.4 transaction 创建 new Attempt。

如果实施过程中发现必须新增列、缺少唯一约束或无法表达状态，必须停止并
提交最小 Migration 方案，不得自行创建 v10。

## 11. Failure Injection 计划

### Stage 3

- Attempt transition。
- ToolRun transition。
- PlanStep transition。
- ExecutionPlan transition。
- Event append。
- Checkpoint append。
- Dispatch / Retry / Interrupt transaction 的每个写入点。
- Pause set / clear 与 pauseRequestedAt CAS。
- blocked Resume / interrupted Recovery 的每个写入点。
- Failure / Cancel / Pause / Resume / Recovery Exact Replay。
- Cancel prepared / dispatching / blocked / interrupted / terminal /
  completed Transaction B。
- Recovery Lineage prepared / dispatching / completed。
- concurrent Dispatch / Recovery。
- stale classification / stale fencing。

### Stage 4

- persisted input revalidation。
- Result Schema。
- Metadata extractor。
- Version compare。
- Sensitive output policy。
- Payload Store put。
- Transaction B 的每个 DB write。
- Tool Message uniqueness。
- Check insert。
- EvidenceRead insert。
- Events / Checkpoint。

### Stage 5

- Provenance chain 每个节点。
- Payload load / integrity。
- Verifier binding resolve。
- Availability Event。
- Verification row。
- optional Verification Event。
- Checkpoint。
- not_run / passed / failed / inconclusive 分类。
- Verifier governance metadata / Effective Config v2 digest。

### Stage 6

- Snapshot / Reservation 分类。
- Lease takeover between classify and execution。
- Cancel/Pause between classify and execution。
- Allowlist Version 在 classify 后变为不可恢复。
- Retry Safety Gate 在 classify 后失效。
- Pause 在 Resume 前被新 Pause 取代。
- Task-wide Cancel 对多 Request 的逐项收敛。
- Verification not_run 与 missing 混淆。
- Exact Replay 重复创建 Attempt。
- stale classification replay。

## 12. 文件修改预估

Stage 3：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/execution-state-machine.ts`（只复用/校验收紧）
- `src/storage/task-repository.ts`（Host-only Pause set / clear CAS）
- `src/storage/task-snapshot.ts`（如 Resume 需要一致读取 pause timestamp）
- `src/storage/index.ts`（仅导出必要接口）
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/recovery-evidence-readback-dispatch.test.ts`

Stage 4：

- `src/recovery/recovery-evidence-readback-executor.ts`
- `src/recovery/recovery-evidence-readback-service.ts`
- `src/recovery/recovery-readback-tool-registry.ts`
  （增加复用现有校验路径的 persisted-source resolve helper）
- `src/recovery/recovery-evidence.ts`
- `src/recovery/evidence-payload-store.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `tests/recovery/recovery-evidence-readback-executor.test.ts`
- `tests/recovery/recovery-evidence.test.ts`
- `tests/storage/recovery-evidence-transaction-b.test.ts`

Stage 5：

- `src/recovery/recovery-evidence-controlled-provenance.ts`
- `src/recovery/recovery-verifier-registry.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/recovery-evidence-payload-integrity.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `tests/recovery/recovery-evidence-controlled-verification.test.ts`
- `tests/recovery/recovery-verifier-registry.test.ts`
- `tests/recovery/recovery-verifier-runtime.test.ts`

Stage 6：

- `src/recovery/recovery-types.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-scanner.ts`
- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-evidence-readback-recovery.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/recovery-evidence-readback-reservation-repository.ts`
- `tests/recovery/recovery-evidence-readback-recovery.test.ts`
- `tests/recovery/recovery-classifier.test.ts`

Step 6.3.5 修改范围另行设计，本计划不授权。

## 13. 分阶段验收与实施顺序

```text
Stage 3
  -> review
Stage 4
  -> review
Stage 5
  -> review
Stage 6
  -> review
Phase 3.4.4 E2E
  -> review
Step 6.3.5 design
```

每个 Stage 必须：

- 完成专项测试。
- 完成前序阶段回归。
- 更新 development report。
- 通过 typecheck / diff check。
- 停止等待架构评审。

## 14. Phase 3 最终端到端验收

完整 E2E 必须覆盖：

1. Original Write 进入 unknown。
2. RecoveryReview 创建。
3. Evidence Submission。
4. Recovery Readback Request / Reservation。
5. Transaction A。
6. Input normalization / persisted input reconstruction。
7. Dispatch UoW。
8. External Read outside SQLite。
9. Version conditional success / mismatch。
10. Transaction B。
11. Controlled Provenance。
12. Controlled Verification。
13. Verification Pending Recovery。
14. Request-scoped Recovery。
15. Lease / Fencing Takeover 与 stale owner 拒绝。
16. 首次 / Retry Dispatch 前 Pause 与 Explicit Resume。
17. External Read 前 / 中 / 后 Pause 与 Resume。
18. Verification not_run 分类与 Exact Replay。
19. Original Unknown Write 审计保留。
20. Task 始终保持 waiting_review。
21. Original Unknown Write 始终保持 unknown。
22. RecoveryReview 未作 Final Decision。
23. 无重复 Read、重复 Event、重复 Checkpoint 或盲重试。
24. Payload orphan 不被认作 EvidenceRead 成功。
25. Replay 和不一致状态 fail closed。

Step 6.3.4.4 E2E 不包含 Final RecoveryReview Decision。完整 Phase 3 E2E
只能在 Step 6.3.5 独立完成并封存后再验收。

## 15. 风险与待决问题

### 15.1 Host Contract Side Effects

Registry 可以冻结输入并限制 source scheme，但不能沙箱化 TypeScript
callback。Host 必须保证 resolver / builder deterministic、read-only、
无外部 I/O。Tool Input Schema 的 Transform / Async Refinement 同样必须
对规范化输入确定且幂等。

### 15.2 Retry Policy

本计划采用：

- interrupted / dispatching uncertainty 只有在合法 Lease / Fencing
  takeover、exact historical Allowlist Version 和 Retry Safety Gate 全部
  满足后，才可以在同一 Request 新 Attempt。
- Retry Safety 决定是否允许重复调用；Consistency Mode 决定结果版本 /
  ETag 比较要求，两者保持独立。
- terminal failed/timed_out/cancelled 不得复用同一 ToolRun。
- `mutable` 或无法证明安全的 Retry Safety fail closed / manual Review。
- terminal failure 后进一步 Read 需要新 Evidence Submission / Request。

架构评审需确认该产品策略。

### 15.3 Version Conditional Mismatch

计划将其作为本次 Readback 失败和需要新观察/人工 Review 的情况，
不直接形成 Original Write 最终结论。

### 15.4 Tool Message 内容

Transaction B 必须写 redacted result reference，而不是 raw Payload。
当前 UoW 在未显式提供 message 时会序列化 Tool Output；Stage 4 必须移除
该 fallback 或保证调用方始终传入固定 redacted message。架构评审需确认
最终 human-readable 格式。

### 15.5 Payload Orphan

本阶段不做 GC，只保留安全清理条件。需确认后续 GC 的拥有者与审计要求。

### 15.6 Request-scoped Recovery

本计划采用 RecoveryManager 持有 Lease / Authority 生命周期，独立
Classifier 与 Executor 负责 Request-scoped 分类和执行。架构评审需确认
该职责划分。

### 15.7 Readback Envelope Source

当前 `RecoveryReadbackValidatedResult` 只明确返回 Result、resourceVersion
和 ETag；`RecoveryReadbackResult` 还需要 `resourceRef`、`observedAt` 和
`outcome`。Stage 4 建议：

- `resourceRef` 由 exact Allowlist `resolveSource()` 的 Host 校验结果
  重新确认，不信任 Tool Output 任意字段。
- `observedAt` 使用 Host 执行时钟，不使用外部 Tool 自报时间。
- `outcome` 继续由 exact Result Schema 验证，但不得由未验证字段推断。

Stage 4 实施前必须确认现有 Result Schema 如何稳定提供 `outcome`，优先在
现有 Host Contract 内解决，不新增数据库字段。

### 15.8 Payload Identity 与 Digest

当前 `jcs-sha256-v1` 的实际 hash 输入是固定
`RecoveryReadbackResultSchema` + JCS，不直接包含 Allowlist 的 Result
Schema identity/version/hash。Schema identity 由 `allowlistVersion`
合同绑定。

若架构评审要求把 Schema identity 直接并入 payload digest 输入，必须作为
新的 payload digest protocol version 单独评审，并保持历史
`jcs-sha256-v1` 可验证。不得静默改变现有 helper。

### 15.9 Sensitive Output Redaction

Stage 1 固定了 `sensitiveOutputPolicy` contract，但当前没有通用 redactor
callback。`mode=redact` 且没有 Host-approved deterministic redactor 时，
Stage 4 必须 fail closed。是否增加 redactor contract 需架构评审确认，
不得把未经脱敏的 Tool Output 写入 Store、Message 或 Event。

### 15.10 Historical Reservation Gap

v8 historical Request 没有 Reservation。本计划选择只读 Replay / 人工
处理，不提供安全进入新 Dispatch 的路径。若要支持其继续执行，必须提出
独立的兼容设计，不能补写伪造 Reservation。

### 15.11 Pause Intent Storage Gap

`tasks.pause_requested_at` 已存在，但当前没有生产级 clear API，且
`updateStatusCas()` 的 `COALESCE` 不能写 NULL。Stage 3 需要新增 Host-only
Task-wide set / clear 方法与独立 HostControlAuthorization，并保持
Task.status = waiting_review。无需 Migration；若实施时发现现有
StorageWritePermit / CAS 无法在不持有执行 Lease 的情况下安全表达
Task-wide Pause generation，必须停止并提交评审。

### 15.12 Verification not_run Finality

`not_run` 是已持久化的 Verification 结果，不是 pending。自动 Recovery
只能处理 Verification missing。重跑 not_run 必须使用新的明确 Check ID，
不能覆盖旧结果，也不能使用当前最新 Binding。

## 16. 本轮文档边界

本轮只修改本计划文档。

- 没有修改生产代码。
- 没有修改测试。
- 没有修改 Migration 或 Schema。
- 没有新增依赖。
- 没有创建数据库。
- 没有执行测试。
- 没有执行 Read Tool、Recovery、Verifier、Provider、LLM 或 Write。
- 没有开始 Stage 3。
- 没有进入 Step 6.3.5。

完成后停止，等待架构评审。
