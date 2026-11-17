# ForgeFlow Phase 3 Step 6.3.4.4 Stage 3.4 Implementation Plan

> 状态：设计修订版 1（架构评审后），等待最终架构评审。本文仅定义 Stage 3.4
> 的设计与实施顺序，尚未授权生产代码开发。
>
> 基线：Migration v9；Stage 3.1–3.3 已完成并通过封存。
>
> 范围：Fencing Takeover、Interrupted Recovery、Recovery Lineage Writer。

设计状态标记：

- **已确定**：由现有源码接口和本轮架构评审要求直接决定。
- **待确认**：已有推荐方案，但需要最终架构评审批准。
- **未知**：当前源码不足以证明，需要后续实现或架构决策。

## 1. 当前源码架构与真实调用链

### 1.1 Lease / Fencing

当前执行所有权由：

- `TaskLeaseManager.claim()`
- `TaskLeaseManager.heartbeat()`
- `TaskLeaseManager.assertOwned()`
- `TaskLeaseManager.release()`
- `TaskLeaseRepository`
- `ExecutionAuthority`
- `LeaseHeartbeat`

共同管理。

真实调用链：

```text
TaskLeaseManager.claim(taskId, ownerId)
  -> BEGIN IMMEDIATE
  -> Task 非 terminal
  -> task_leases INSERT
       或 owner_id IS NULL
       或 expires_at <= now 时接管
  -> fencing_token = previous fencing_token + 1
  -> append lease.claimed Event
  -> Checkpoint
  COMMIT
```

`TaskLeaseManager.assertOwned()` 同时检查：

```text
ownerId IS NOT NULL
leaseToken 匹配
fencingToken 匹配
expiresAt > now
```

`ExecutionAuthority` 是进程内 object：

- heartbeat 失败时先 revoke authority。
- revoke 同时触发 AbortSignal。
- SQLite写入仍必须另行通过 lease/fencing 校验。

### 1.2 Recovery Evidence 持久化

核心表：

```text
recovery_evidence_readback_requests
recovery_evidence_read_attempts
tool_runs
plan_steps
execution_plans
events
checkpoints
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

Migration v8 Trigger 只允许：

```text
prepared -> dispatching | cancelled | blocked_by_intent
dispatching -> completed | interrupted | failed | timed_out | cancelled
```

`interrupted` 是 Attempt 历史终态；恢复必须创建新的 Attempt ID。

### 1.3 Stage 3.1 State Transition UoW

`RecoveryEvidenceStateTransitionUnitOfWork` 是内部状态矩阵执行器：

```text
StorageWritePermit
  -> Lease / Fencing
  -> ExecutionAuthority
  -> Request / Attempt identity
  -> Exact Replay
  -> Task version CAS
  -> State Matrix
  -> Attempt / ToolRun / PlanStep / Plan
  -> Attempt Event / Tool Event
  -> Checkpoint
```

它已经支持：

```text
Attempt: dispatching -> interrupted
ToolRun: running -> interrupted
PlanStep: running -> interrupted
ExecutionPlan: active，保持 active
```

该执行器不接受 nested transaction，必须复用外层
`StorageWritePermit`。

### 1.4 Stage 3.2 Dispatch Gate

`beginOwnedRecoveryEvidenceRead()` 对 Retry Attempt 当前要求：

- `attemptNumber = priorAttempt.attemptNumber + 1`。
- prior Attempt 状态为 `interrupted`。
- prepared Event 中存在：
  - `recoveryOperationId`
  - `priorAttemptId`
  - `interruptionEventId`
  - `newAttemptId`
  - `pauseClearEventId`
- interruption Event 存在，`resumeEligible = true`。
- interruption Event 与 prepared Event 的 recoveryOperationId 一致。
- 当前 fencingToken 严格大于 prior Dispatch Event fencingToken。
- 同一 `recoveryOperationId` 只有一个 prepared Event。
- Request / ToolRun 身份未替换。

Stage 3.4 必须生成满足上述 Gate 的持久化记录，不得放宽 Gate。

### 1.5 State Machine 已有转换

已经确认：

```text
ToolRun: interrupted -> queued | failed | skipped | cancelled
PlanStep: interrupted -> running | failed | skipped | cancelled
```

因此 interrupted Recovery 可以复用：

- 同一逻辑 Read ToolRun。
- 同一 Recovery Evidence Plan / PlanStep。
- 新 Attempt ID。

### 1.6 Schema 现状

Attempt 表没有 Recovery Lineage 列。

当前已有 `events.payload_json` 可承载：

```text
recoveryOperationId
priorAttemptId
newAttemptId
interruptionEventId
dispatchEventId
priorFencingToken
newFencingToken
resumeEligible
interruptionCause
```

Stage 3.4 可先采用 Event-scoped versioned lineage，不需要新增表列。

### 1.7 现有普通 Read Recovery 参考

`RecoveryManager.recoverReadRuns()` 已实现：

```text
claim inspection lease
  -> create ExecutionAuthority
  -> start LeaseHeartbeat
  -> operate
  -> stop heartbeat
  -> release lease
```

并通过 `ReadWorkerPool` 重新执行普通 Agent read。

该流程不能直接用于 Recovery Evidence Readback，因为：

- 它没有 Recovery Lineage。
- 它没有 Recovery Intent Digest / Allowlist Version。
- 它会 requeue 普通 ToolRun，而 Recovery Evidence 必须保持逻辑 ToolRun 与
  Attempt lineage。
- 它面向普通 Agent Plan，不是 `purpose=recovery_evidence`。

Stage 3.4 应复用 Lease / Authority 生命周期模式，不得复用普通 Read
Recovery 的业务执行入口。

## 2. 已有能力与缺失能力

### 2.1 已有能力

- Lease 过期/释放后的条件接管。
- fencingToken 单调递增。
- ExecutionAuthority 与 LeaseHeartbeat。
- Attempt / ToolRun / PlanStep / Plan 状态矩阵。
- Cross-transaction `StorageWritePermit`。
- Stage 3.2 Retry Dispatch Gate。
- Prepared / Observed Event 审计字段。
- Exact Replay。
- Cancel / Pause Host Intent。
- Pause Resume lineage。

### 2.2 缺失能力

- 明确的 Stage 3.4 Recovery Operation 输入类型。
- Recovery Lineage 纯验证器。
- 将 `recoveryOperationId` 等 metadata 写入 interrupted Event。
- interrupt + requeue + new Attempt 的单一 immediate transaction。
- Pause-induced interruption-only 路径。
- Interrupted + no active Attempt 的 Exact Replay 分类。
- 并发 Recovery Operation 的唯一性保证。
- Stage 3.4 专项测试与 Report。

## 3. 目标与非目标

### 3.1 目标

1. 合法新 Owner 在不复用旧 Attempt ID 的前提下恢复 Readback。
2. 原子持久化 interrupted 事实和新 Attempt prepared 状态。
3. 建立 Event-based Recovery Lineage V1。
4. 保持 Stage 3.2 Dispatch Gate 原样通过 lineage 校验。
5. 支持 Cancel > Pause > Recovery。
6. 支持 Pause-induced interruption-only。
7. 保证 Exact Replay、并发和 fault rollback。

### 3.2 非目标

- External Read 执行。
- ToolRegistry input validation / execute。
- Payload Store。
- Transaction B。
- Controlled Provenance / Verifier。
- Recovery Manager / Classifier 正式接入。
- Step 6.3.5。
- Migration v10。

## 4. 核心设计决策

### 4.1 Lease Takeover 与 Recovery State UoW 分两阶段

推荐：

```text
Phase A: Claim new lease/fencing
Phase B: Recovery Evidence immediate transaction
```

原因：

- `TaskLeaseManager.claim()` 已经是原子条件更新。
- UoW 必须先拿到新 leaseToken / fencingToken 才能构造 Authority 和
  StorageWritePermit 上下文。
- 即使把 claim 嵌套进 Recovery UoW，也无法消除“进程在 claim 后崩溃”的
  窗口。
- Recovery UoW 的原子边界应覆盖所有业务状态与 Lineage，不应承担 Lease
  acquisition。

如果 Phase B 失败：

- Lease 保持新 owner 持有直到 release/expiry。
- 下一次 Recovery 可重新 claim。
- 不允许伪造 Attempt / Event 部分成功。

### 4.2 Recovery Lineage V1

新增 discriminated union：

```text
RecoveryEvidenceLineageV1 =
  InterruptLineageV1
  | PrepareLineageV1
```

Root Shared Fields：

```text
lineageSchemaVersion = "recovery-evidence-lineage.v1"
recoveryOperationId
recoveryPhase = interrupt | prepare
taskId
readbackRequestId
readToolRunId
priorAttemptId
priorAttemptNumber
interruptionCause
retryAssessment
resumeEligible
retrySafety
consistencyMode
allowlistId
allowlistVersion
requestIntentDigest
expectedResourceVersion
expectedEtag
```

Interrupted Event Payload (`recoveryPhase=interrupt`)：

```text
readbackRequestId
lineageSchemaVersion
readAttemptId = priorAttemptId
priorAttemptId
attemptNumber = priorAttemptNumber
attemptStatus = interrupted
dispatchEventId
dispatchFencingToken
leaseClaimEventId
fencingToken
recoveryOperationId
recoveryPhase = interrupt
interruptionCause
reasonCode
retryAssessment
resumeEligible
controlIntentKind
controlIntentEventId
```

Interrupted Event 不包含：

- 自己的 `interruptionEventId`。
- `newAttemptId` / `newAttemptNumber`。
- `pauseClearEventId`。

Prepared Event Payload (`recoveryPhase=prepare`)：

```text
readbackRequestId
readAttemptId = newAttemptId
attemptNumber = newAttemptNumber
attemptStatus = prepared
fencingToken
recoveryOperationId
recoveryPhase = prepare
priorAttemptId
priorAttemptNumber
interruptionEventId
newAttemptId
newAttemptNumber
pauseClearEventId | absent
leaseClaimEventId
lineageSchemaVersion
```

Prepared Event 必须引用已经存在的 Interrupted Event，且：

```text
root recoveryOperationId 相同
priorAttemptNumber + 1 = newAttemptNumber
```

Lineage 不新增表；可能写入两个 Event：

1. `recovery.evidence.read_attempt_interrupted`（phase=interrupt）
2. `recovery.evidence.read_attempt_prepared`（phase=prepare，仅 full recovery
   或 Pause-clear continuation）

interruption-only 时只有 interrupted Event。full recovery 时 old Attempt
`last_event_id` 指向 interrupted Event，新 Attempt `last_event_id` 指向
prepared Event。

### 4.3 Recovery Operation Identity

Root identity：

`recoveryOperationId`：

- Host-generated stable opaque identity。
- Task-scoped。
- 同一逻辑 Recovery 的响应丢失重试必须复用。
- 新一轮 Recovery 必须生成新 ID。
- 不持久化为独立表主键；由 Event payload + immediate transaction 保证
  应用级唯一。

已确定生成方式：

- 使用 Host / Recovery Coordinator 生成的 UUID。
- 必须在第一次 Recovery 调用前生成。
- 必须保存在跨重启可恢复的持久化命令、Job 或幂等上下文中。
- UoW 不在每次调用中现场生成 ID。
- 响应丢失后不得重新生成。

Phase-specific idempotency identity：

```text
taskId + recoveryOperationId + recoveryPhase
```

`recoveryPhase`：

```text
interrupt
prepare
```

说明：

- `interrupt` 覆盖 Cancel / Pause / Retry-failed 的 interruption-only 操作。
- `prepare` 覆盖 Pause Clear 后的 Resume continuation，或普通 full recovery
  的 new Attempt creation。
- 两个 phase 共享同一个 root `recoveryOperationId`。
- Stage 3.2 仍只看到 interrupted / prepared Event 中相同的 root ID，不放宽
  Gate。

当前源码缺口：

- 仓库尚无 Recovery Job / Command 或等价 durable operation context。
- Step 1 可设计 pure contract。
- Step 5 及之后的任何生产恢复入口，在 Host 提供 durable operation context
  前必须保持 blocked。

### 4.4 Retry Safety Gate

Recovery 新 Attempt 创建前，必须在 SQLite transaction 外完成 Host
preflight：

```text
RecoveryReadbackToolRegistry.getExact(
  request.allowlistId,
  request.allowlistVersion
)
  -> recompute allowlist contract digest
  -> verify retrySafety / consistencyMode
  -> verify Tool identity / Schema hash
  -> verify Retry Safety declaration
```

UoW 内只比较：

- 持久化 Request / ToolRun 字段。
- passed `RecoveryEvidenceRecoveryPreflightCapability`。
- `retrySafety` / `consistencyMode`。
- expectedResourceVersion / expectedEtag。
- canonicalInputHash。

Capability 边界（已确定）：

- Stage 3.4 使用独立的 `RecoveryEvidenceRecoveryPreflightCapability`。
- 该 capability 证明历史 Retry Safety / Consistency / Allowlist / Intent
  Digest / Schema Hash / canonicalInputHash 已完成 Host 校验。
- Stage 3.2 `RecoveryEvidenceDispatchPreflightCapability` 继续只服务
  Dispatch Contract。
- 两者可以共享底层 immutable contract 计算函数，但不能替换、复用或
  相互授予权限。

规则：

- `retrySafety` 决定是否允许重复 Read。
- `consistencyMode` 决定读取一致性协议。
- `immutable` 不要求 expected version。
- `version_conditional` 必须有 expected version 或 ETag。
- 任一历史 allowlist contract 不能精确恢复时 fail closed。
- Stage 3.4 不执行 External Read；Actual version / ETag 比较留给 Stage 4。

Retry Safety 不满足时，旧 Attempt 仍必须由合法新 Owner 标记为
interrupted；不能继续保留 dispatching。详见 §8.3。

### 4.5 Cancel / Pause 优先级

固定：

```text
Cancel > Pause > Normal Recovery
```

Cancel 存在：

- 如果新 Owner 尚未取得合法 Lease / Fencing Takeover：
  - 不修改 Attempt / ToolRun / PlanStep。
  - 返回 `cancel_required` 或 `in_progress`。
- 如果新 Owner 已经取得合法 Lease / Fencing Takeover：
  - 允许 safe interruption-only。
  - old Attempt `dispatching -> interrupted`。
  - ToolRun / PlanStep 进入 interrupted。
  - ExecutionPlan 保持 active。
  - 不创建新 Attempt，不执行 Retry Safety。
  - `resumeEligible=false`：不是把 Cancel 编码进字段，而是该分支没有执行
    Retry Safety，不能声称历史恢复条件已满足。
  - 返回 `interrupted_cancel_pending`。
  - 随后由 Stage 3.3 Request Cancel 把 interrupted Request 收敛为
    cancelled。

Cancel 分支仍保留 Outcome Uncertain：

- interruption 不代表远端 Read 未发生。
- Cancel 表示系统停止接受该 Readback 的结果。
- 旧 Owner late result 仍必须被 Lease / Fencing / Attempt terminal 状态
  拒绝。

Pause 存在：

- 如果刚完成合法 Fencing Takeover，可执行 interruption-only：
  - old Attempt -> interrupted。
  - ToolRun -> interrupted。
  - PlanStep -> interrupted。
  - Plan 保持 active。
  - 不创建新 Attempt。
- 如果 Retry Safety 通过，interrupted Event 仍可写入
  `resumeEligible = true`。
- Pause 本身不改变 `resumeEligible`；它只阻止当前时刻创建新 Attempt。
- Pause 清除并验证 generation 后，再通过显式 Recovery Resume 创建新
  Attempt。

### 4.6 Outcome Uncertain

`interrupted` 只表示：

```text
旧 Owner 不再具备合法提交权限
```

它不表示：

- External Read 一定未发生。
- External Read 一定失败。
- 可以安全重跑。

新 Attempt 创建前必须通过 Retry Safety Gate；否则 manual Review。

## 5. Key Data Model And Event Design

### 5.1 Interrupted Event

Type：

```text
recovery.evidence.read_attempt_interrupted
```

Required payload：

```text
readbackRequestId
readAttemptId
priorAttemptId
attemptNumber
attemptStatus = interrupted
dispatchEventId
dispatchFencingToken
fencingToken
recoveryOperationId
recoveryPhase = interrupt
interruptionCause
reasonCode
resumeEligible
retryAssessment
leaseClaimEventId
controlIntentKind
controlIntentEventId
```

`resumeEligible`：

- 是 Stage 3.2 兼容字段。
- `true` 当且仅当 `retryAssessment === passed`。
- `false` 不表示已经证明永久不可恢复，只表示当前没有足够证据授权 Retry。

`retryAssessment`：

| 场景 | resumeEligible | retryAssessment |
|---|---|---|
| Retry Safety / historical contract 通过 | true | passed |
| Retry Safety / contract 明确不满足 | false | failed |
| Cancel 分支跳过 Retry 检查 | false | not_evaluated |

Pause 不改变 `retryAssessment`：

- Pause 存在但检查通过：`passed / true`，但当前不允许创建可 Dispatch 的
  new Attempt。
- Pause 清除后才继续 prepare phase。

Event immutability：

- Interrupted Event 一旦提交，`resumeEligible` / `retryAssessment` 不可修改。
- Stage 3.3 Request Cancel 只追加下游 Cancel Event 和状态，不修改历史
  interrupted Event。

### 5.2 New Prepared Event

Type：

```text
recovery.evidence.read_attempt_prepared
```

Required payload：

```text
readAttemptId = newAttemptId
attemptNumber
attemptStatus = prepared
fencingToken
recoveryOperationId
recoveryPhase = prepare
priorAttemptId
interruptionEventId
newAttemptId
pauseClearEventId
lineageSchemaVersion
```

不得缺省 `recoveryOperationId` 或 `interruptionEventId`。

### 5.3 Additional Events

已确定：

- 复用现有 `lease.claimed` Event 作为 Takeover 事实。
- Interrupted Event 通过 `leaseClaimEventId` 引用该 Event。
- 不新增重复的 `fencing_takeover` Event。

待确认：

- 是否额外增加 `recovery.evidence.read_attempt_recovery_prepared` 聚合
  Event。
- 若增加，它只能作为审计补充，不能替代 prepared Event 或 Attempt
  `last_event_id`。

## 6. UoW / Repository / Capability Boundary

### 6.1 新业务 UoW

建议新增：

```text
beginOwnedRecoveryTakeover()
```

或：

```text
claimRecoveryEvidenceOwnership()
```

职责：

- 通过 TaskLeaseManager 领取 lease。
- 返回 ownership + ExecutionAuthority context。
- 不写 Attempt。

实际 Recovery API：

```text
interruptOwnedRecoveryEvidenceReadAttempt()
recoverOwnedRecoveryEvidenceReadAttempt()
resumeInterruptedOwnedRecoveryEvidenceReadAttempt()
```

推荐先拆为：

- `interruptOwned...`：Cancel / Pause / Retry-unsafe interruption-only。
- `recoverOwned...`：interrupt + new Attempt 原子完成。

`interruptOwned...` 必须区分：

```text
interrupted_cancel_pending
interrupted_pause_pending
interrupted_retry_unsafe
```

三者都只创建历史 interrupted 事实，不授予后续执行权限。

### 6.2 Repository

复用：

- `RecoveryEvidenceReadAttemptRepository`
- `RecoveryEvidenceReadbackRequestRepository`
- `ToolRunRepository`
- `PlanStepRepository`
- `ExecutionPlanRepository`
- `EventRepository`
- `CheckpointStore`

建议新增：

```text
RecoveryEvidenceRecoveryLineageRepository
```

只读/验证职责：

- Event payload schema parse。
- 按 `taskId + recoveryOperationId + recoveryPhase` 查找对应 Event。
- 校验 lineage 唯一性。
- 不直接写 Attempt / ToolRun。

### 6.3 Capability

进程内 capability：

```text
RecoveryEvidenceRecoveryPreflightCapability
```

签发者：

- Host Recovery preflight。

绑定：

- taskId
- requestId
- readToolRunId
- allowlistId
- allowlistVersion
- readToolName / version / schemaHash
- requestIntentDigest
- retrySafety
- consistencyMode
- expectedResourceVersion / expectedEtag
- canonicalInputHash

签发权：

- 只由 Host-owned Recovery Preflight adapter 签发。
- 不通过普通 Recovery Service 或公开请求构造。
- 普通对象、spread clone、JSON clone 和 cast 必须是无效 capability。

## 7. Fencing Takeover Atomic Transaction Design

### 7.1 Lease Claim Transaction

```text
TaskLeaseManager.claim(taskId, newOwnerId)
  -> BEGIN IMMEDIATE
  -> existing lease active?
       yes -> fail, return in_progress
       no  -> claim
  -> fencingToken = previous + 1
  -> Lease Event / Checkpoint
  COMMIT
```

Step 4 API 目标（已确定）：

```text
claimRecoveryEvidenceOwnership()
  -> leaseRecord
  + leaseClaimEventId
```

当前 `TaskLeaseManager.claim()` 只返回 `TaskLeaseRecord`，没有返回
`lease.claimed` Event ID。这是需要由 Step 4 最小扩展的真实 API 缺口，
不得通过扫描“最近一个 lease Event”猜测。

Recovery State Transaction 对每个被写入 Event 分别验证：

- 该 Event 的 `leaseClaimEventId` 属于当前 Task。
- Claim Event fencingToken 等于写入该 Event 时的当前 ownership fencingToken。
- Claim Event sequence 早于该 Event sequence。
- Interrupted Event 额外要求 Claim Event sequence 晚于 prior Dispatch Event。
- Prepared Event 不要求 Claim Event 晚于 Interrupted Event；Full Recovery 中
  两个 Event 可以引用同一个 Claim Event。

Full Recovery：

```text
Interrupted.leaseClaimEventId = current owner Claim
Prepared.leaseClaimEventId    = current owner Claim
```

Pause Clear 后 Resume Continuation：

```text
Interrupted.leaseClaimEventId = 旧 interruption Owner Claim
Prepared.leaseClaimEventId    = 执行 Resume 的新 Owner Claim
```

不得让 Prepared Event 复用旧 Owner Claim 来冒充当前 ownership。

### 7.2 Recovery State Transaction

```text
BEGIN IMMEDIATE
  -> create StorageWritePermit
  -> assertOwned(taskId, newLease, newFencing)
  -> assertAuthority()
  -> Task = waiting_review
  -> Request / old Attempt / ToolRun / PlanStep / Plan
  -> validate stable identity only:
       taskId / requestId / readToolRunId / priorAttemptId
  -> Exact Replay lookup by:
       taskId + recoveryOperationId + recoveryPhase
       命中:
         validate complete phase-specific lineage / Events / identity
         return persisted result
         no writes and no new execution authorization
       未命中:
         lookup existing interruption lineage by:
           taskId + recoveryOperationId + interrupt

         no interruption lineage -> Full Recovery branch

         existing interruption lineage -> Continuation branch
COMMIT
```

Full Recovery branch：

```text
preconditions:
  old Attempt = dispatching
  no other active Attempt
  old Dispatch Event valid
  new ownership fencing > old Dispatch fencing
  current Lease Claim Event valid
latest Intent:
  Cancel -> interruption-only; retryAssessment=not_evaluated
  Pause -> interruption-only; retry assessment may be passed/failed
  none -> Recovery Preflight + Retry Safety gate
writes:
  Interrupted Event
  old Attempt -> interrupted
  ToolRun running -> interrupted
  PlanStep running -> interrupted
  Plan active
if retryAssessment=passed and no Cancel/Pause:
  ToolRun interrupted -> queued
  PlanStep interrupted -> running
  Prepared Event + new Attempt prepared
```

Pause Resume Continuation branch：

```text
preconditions:
  existing complete interruption lineage for same root ID
  old Attempt = interrupted
  interrupted Event retryAssessment=passed
  interrupted Event resumeEligible=true
  Pause Clear Event valid for the same Pause generation
  no newer Pause / Cancel
  Recovery Preflight passes again
  current Lease / Fencing / Authority valid
writes:
  no new Interrupted Event
  no repeated Attempt -> interrupted transition
  ToolRun interrupted -> queued
  PlanStep interrupted -> running
  Prepared Event with same root recoveryOperationId + phase=prepare
  new Attempt prepared
  Checkpoint
```

如果 interruption lineage 存在但 Pause 未正确 Clear、Retry Assessment 不是
passed 或 Event 不完整，则返回 pause_blocked /
interruption_not_resumable / state_inconsistent，不创建 new Attempt。

Exact Replay 必须位于首次执行状态前置条件与 active Attempt 冲突检查
之前：

- `phase=interrupt` 命中时，旧 Attempt 预期已经不再是 dispatching。
- `phase=prepare` 命中时，new Attempt 预期已经存在且可能为 prepared 或
  dispatching。
- 同一 root recoveryOperationId 的 interrupt Replay 不阻止后续 prepare
  continuation。

Replay 只返回持久化历史：

- 不重新 Dispatch。
- 不恢复旧 Owner 写权限。
- 不把历史 Attempt 作为当前执行授权。
- 当前最新 Cancel / Pause 仍阻止后续 Dispatch / Transaction B。

### 7.3 Phase-aware Execution Matrix

| 当前持久化事实 | 请求 phase | 结果 |
|---|---|---|
| 无 interrupted / prepared lineage；old dispatching | interrupt | 创建 Interrupted Event，interruption-only |
| 无 interrupted / prepared lineage；old dispatching；retry-safe | prepare | 同一 transaction 创建 interrupted + prepared + new Attempt |
| interrupted lineage 已存在 | interrupt | 返回原 Interrupted Event，不重复写 |
| interrupted lineage 已存在；Pause 已 Clear；retryAssessment=passed | prepare | 创建 prepared Event + new Attempt |
| interrupted lineage 已存在；Pause 未 Clear | prepare | pause_blocked，不创建 Attempt |
| interrupted lineage 已存在；Cancel | prepare | cancel_required，不创建 Attempt |
| prepared lineage 已存在 | prepare | 返回相同 new Attempt |
| new Attempt 已 dispatching | prepare | 返回 in_progress，不调用 Dispatch |
| prepared / interruption lineage 不完整 | interrupt / prepare | state_inconsistent / manual Review |

`resumeEligible=true` 只允许 prepare continuation；Clear Event、Pause
generation、Retry Assessment 和 Recovery Preflight 仍必须逐项通过。

### 7.4 Late Old Owner

`ExecutionAuthority` 是进程内对象。新 Owner 不能同步 revoke 另一个进程
中的旧 Authority，也不能保证 Takeover 自动终止已经开始的外部 Read。

实际边界：

- 同进程：旧 Owner 可通过本地 Authority revoke 主动失去提交权。
- 跨进程：旧 Owner 在 heartbeat / Lease ownership 检查时发现 lease
  已失效。
- 全局持久化依据：SQLite Lease token + fencingToken。
- 新 Owner 可以阻止旧 Owner 通过新的数据库写入校验。
- 新 Owner 不能证明旧进程或远端操作已停止。

旧 Owner 的晚到结果会被：

1. Lease token / fencingToken mismatch 拒绝。
2. interrupted Attempt 的 terminal 状态拒绝。
3. Recovery State Transaction 的 request / attempt binding 拒绝。

任一命中即 fail closed；不得把 late result 判为成功。Stage 4 仍必须设计
外部执行边界和结果提交保护，本阶段不执行 External Read。

## 8. Interrupted Recovery State Matrix

### 8.1 Full Recovery

| 对象 | Before | After |
|---|---|---|
| old Attempt | dispatching | interrupted |
| Read ToolRun | running | interrupted -> queued |
| PlanStep | running | interrupted -> running |
| ExecutionPlan | active | active |
| new Attempt | 不存在 | prepared |

### 8.2 Interruption Only

| 对象 | Before | After |
|---|---|---|
| old Attempt | dispatching | interrupted |
| Read ToolRun | running | interrupted |
| PlanStep | running | interrupted |
| ExecutionPlan | active | active |
| new Attempt | 不存在 | 不创建 |

### 8.3 Retry Safety Fail Closed

| 对象 | Before | After |
|---|---|---|
| old Attempt | dispatching | interrupted |
| Read ToolRun | running | interrupted |
| PlanStep | running | interrupted |
| ExecutionPlan | active | active |
| new Attempt | 不存在 | 不创建 |

只有已经取得合法新 Owner Lease / Fencing 时才能执行该转换。写入
interruption Event：

```text
resumeEligible = false
reasonCode =
  RETRY_UNSAFE
  | RECOVERY_CONTRACT_UNAVAILABLE
```

返回值：

```text
interrupted_retry_unsafe
recommendedNextAction = manual_review
```

不允许 Retry Unsafe 时继续把旧 Attempt 永久保留为 dispatching。

### 8.4 Cancel Present

未取得合法 Takeover：

```text
return cancel_required / in_progress
```

已经取得合法 Takeover：

```text
interruption-only
  -> old Attempt interrupted
  -> ToolRun / PlanStep interrupted
  -> Plan active
  -> no new Attempt
  -> interrupted_cancel_pending
  -> Stage 3.3 cancelOwnedRecoveryEvidenceRead()
```

Stage 3.3 随后对 interrupted Request 执行 Request-level Cancel：

- Attempt 保持 interrupted。
- ToolRun / PlanStep / Plan 收敛为 cancelled。
- 不创建新 Attempt。
- 不声称远端 Read 未发生。

### 8.5 Pause Present

如果当前 transaction 已取得合法 takeover：

- interruption-only。
- Retry Safety 通过时 `resumeEligible = true`。
- Pause 本身不把 `resumeEligible` 改为 false。
- 不立即创建可 Dispatch 的 new Attempt。
- Host Clear Pause 后验证 pauseClearEventId / generation，再创建新 Attempt。

如果未取得 takeover：

- 保持 dispatching，返回 in_progress / pause_blocked。

### 8.6 Exact Replay Terminal

| 新 Attempt 状态 | 返回 |
|---|---|
| prepared | replayed-prepared |
| dispatching | in_progress，不重新 Dispatch |
| completed | completed Replay |
| failed / timed_out / cancelled / interrupted | persisted terminal |
| lineage 不完整 | state_inconsistent |

Interruption-only 的 Replay 返回原 interrupted Event，不创建 new
Attempt。当前 Pause / Cancel 仍使后续执行保持 blocked。

## 9. Recovery Lineage Integrity Constraints

必须同时满足：

```text
lineage.taskId = Request.taskId = old/new Attempt.taskId
lineage.readbackRequestId = Request.id
lineage.readToolRunId = Request.readToolRunId
priorAttemptId = old Attempt.id
newAttemptId = new Attempt.id
priorAttemptNumber + 1 = newAttemptNumber
interruptionEventId = old interrupted Event.id  // prepare only
dispatchEventId = old dispatching Event.id
interrupted.leaseClaimEventId = interruption owner claim
interrupted.fencingToken = interruption owner fencing
interrupted.claim sequence > dispatch sequence
interrupted.claim sequence < interrupted Event sequence
prepared.leaseClaimEventId = prepare owner claim
prepared.fencingToken = prepare owner fencing
prepared.claim sequence < prepared Event sequence
old Dispatch fencing < recovery fencing
requestIntentDigest 与 Request 持久化 Intent 一致
resumeEligible = Retry Safety / historical-contract gate passed
retryAssessment 与 resumeEligible 关系一致
interrupted Event recoveryPhase = interrupt
prepared Event recoveryPhase = prepare
```

不得接受：

- 同一 logical request 下替换 ToolRun。
- 同一 recoveryOperationId 对应多个 newAttemptId。
- Full Recovery priorAttempt 不是 dispatching。
- Pause Resume Continuation priorAttempt 不是 interrupted。
- interruption Event 属于其他 Task / Attempt。
- prepared Event 与 interrupted Event 不连续。
- pauseClearEventId 指向错误 generation。
- Retry Safety failed 却写入 resumeEligible=true。
- current Pause / Cancel 被错误编码进 resumeEligible，导致历史能力与当前
  控制状态混淆。
- 同一 recoveryOperationId 的两个 phase 被错误合并成同一 Replay key。
- `resumeEligible=false` / `retryAssessment=not_evaluated` 被改写成 passed。

## 10. Stage 3.2 Dispatch Gate Integration

Stage 3.4 写入的 prepared Event 必须满足当前
`hasValidRetryDispatchLineage()` 的既有查询：

```text
readAttemptId = newAttemptId
attemptNumber = prior.attemptNumber + 1
priorAttemptId = oldAttemptId
interruptionEventId = interruptedEvent.id
recoveryOperationId = interruptedEvent.recoveryOperationId
newAttemptId = newAttempt.id
recoveryPhase = prepare
```

同时：

- interrupted Event 的 `priorAttemptId` 必须指向 old Attempt。
- `resumeEligible = true`。
- `retryAssessment = passed`。
- prepared Event fencingToken = current fencing。
- current fencing > old Dispatch Event fencing。
- 同一 Request / ToolRun 没有第二个 active Attempt。
- interrupted / prepared Event root recoveryOperationId 相等。
- Stage 3.2 不需要理解 phase，但 phase 不能改变 root ID 或放宽任何 Gate。

Stage 3.2 不放宽：

- 不根据 recoveryOperationId 字符串长度猜测合法性。
- 不根据 Attempt status 单独放行。
- 不通过普通 `createOwnedRecoveryEvidenceReadAttemptPrepared()` 伪造
  lineage。

## 11. Exact Replay And Concurrency

### 11.1 Exact Replay Key

```text
taskId + recoveryOperationId + recoveryPhase
```

Root `recoveryOperationId` 贯穿 interrupt 与 prepare；phase 只用于幂等
操作边界。

### 11.2 Replay 顺序

```text
Lease / Fencing / Authority
  -> Task / Request / prior Attempt stable identity
  -> lookup by taskId + recoveryOperationId + recoveryPhase
       命中:
         validate full lineage bindings / referenced Events
         return persisted history read-only
       未命中:
         validate first-execution preconditions
         validate no conflicting active Attempt
         read latest Cancel / Pause
         execute new Recovery State Transaction
```

Replay 与当前 Intent：

- Replay 命中只说明同一历史 operation 已提交。
- 当前 Cancel / Pause 不因 Replay 被清除。
- Replay 不返回新的 Dispatch 授权。
- 后续 Dispatch 仍需通过 Stage 3.2 当前 Lease / Fencing / Authority /
  Cancel / Pause 检查。
- 如果当前 Intent 已在 Replay 后提交，Stage 3.3 必须可继续收敛历史
  prepared / dispatching Attempt。

### 11.3 Concurrent Same Recovery Operation

SQLite immediate transaction 串行化：

1. 第一次 transaction 写 interrupted + prepared Events + new Attempt。
2. 第二次 transaction 进入后查询 recoveryOperationId。
3. 命中完整 lineage 后返回同一 Attempt。

没有 Event / Checkpoint 重复写入。

同一 recoveryOperationId 若绑定不同 Request、priorAttemptId、
interruptionEventId、newAttemptId 或 fencing lineage，必须返回
`state_inconsistent`，不得按“近似相同”自动修复。

### 11.4 Two Owners Race

`TaskLeaseRepository.claim()` conditional update 保证：

- 第一个 owner fencing = N + 1。
- 第二个 owner 看到 active lease，claim 失败。
- 只有合法 lease holder 能进入 Recovery UoW。

### 11.5 Crash Windows

| 崩溃点 | 结果 |
|---|---|
| Lease claim 前 | 无状态变化 |
| Lease claim 后、UoW 前 | lease 可 expiry 后接管；无 Attempt 变化 |
| UoW transaction 内失败 | 整体 rollback |
| UoW commit 后响应丢失 | Exact Replay |
| new Attempt prepared 后 Dispatch 前崩溃 | prepared 可被 Step 6.3 Recovery 分类 |
| Recovery State Transaction 前崩溃 | old Attempt 保持 dispatching；Lease 可重新接管 |
| Recovery State Transaction 内崩溃 | 整体 rollback |

## 12. Cancel / Pause Competition

### 12.1 Cancel

- Cancel Intent 由独立 control-plane UoW 写入。
- Recovery UoW 在 immediate transaction 内重新读取 Cancel。
- 未取得合法 Takeover 时返回 `cancel_required` / `in_progress`，不写 Attempt。
- 已取得合法 Takeover 时执行 safe interruption-only。
- 不执行 Retry Safety，不创建新 Attempt。
- 将 interrupted Request 交给 Stage 3.3 Request Cancel 收敛。
- 已提交 interrupted Event 的 Exact Replay 仍可返回历史，但不恢复权限。

### 12.2 Pause

- Pause 存在时只允许合法 takeover 后的 interruption-only。
- 不创建可 Dispatch 的新 Attempt。
- Host Clear 后通过 Stage 3.4 resume path 创建新 Attempt。
- 新 Pause generation 晚于 clear 时，旧 Resume fail closed。

### 12.3 Commit Ordering

SQLite writer 串行化意味着：

- **Intent 先提交**：
  - Cancel：Recovery 看到 Cancel，执行 interruption-only，再由 Stage 3.3
    Cancel 收敛。
  - Pause：Recovery 看到 Pause，执行 interruption-only，不创建新 Attempt。
- **Recovery 先提交**：
  - Cancel / Pause Intent 随后提交。
  - 新 prepared Attempt 必须由 Stage 3.3 Pause/Cancel 收敛。
  - 如果已进入 dispatching，Stage 3.3 仍不可用普通枚举 Settlement；
    Stage 3.4 必须在合法 Takeover 后接管并 interruption-only。

两种顺序都必须有测试，不能假设 Intent 一定先到。

### 12.4 Cancel Convergence Crash Contract

场景：

```text
Stage 3.4 interruption-only COMMIT
  -> process crash
  -> Stage 3.3 Request Cancel 尚未执行
```

Host / orchestration retry contract：

1. Task-wide Cancel control-plane 已持久化
   `cancelIntentEventId`。
2. Host 重新枚举该 Task 下的 Recovery Evidence Request。
3. 对每个 Request，使用相同逻辑 key：

```text
taskId + readbackRequestId + cancelIntentEventId
```

4. 如果 Request 已是 blocked_by_intent / interrupted，调用
   `cancelOwnedRecoveryEvidenceRead()`。
5. Stage 3.3 收敛 ToolRun / PlanStep / Plan 为 cancelled。
6. Stage 3.3 不修改既有 Interrupted Event，只追加自己的 Cancel Event /
   Checkpoint。
7. 已 interrupted Attempt 不重复生成 Interrupted Event。
8. 同一 key Exact Replay 不重复 Event / Checkpoint。

触发边界：

- Host Cancel command dispatcher 负责重新驱动。
- 可由独立的 durable command worker 定时/启动时重试。
- 本阶段不实现 Recovery Manager / Scanner / Classifier。
- 不允许依赖“同一次进程内调用栈”完成 interruption 与 Request Cancel。

测试设计：

- 先完成 interruption-only 并 COMMIT。
- 模拟进程终止，不调用 Stage 3.3。
- 新进程读取同一 cancelIntentEventId。
- 调用 Request Cancel。
- 验证 interrupted Attempt 保持、下游 cancelled、Event 不重复。
- 再次调用同 key 返回 Exact Replay。

## 13. Expected File Changes

生产代码：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-state-matrix.ts`（如增加 recovery-ready 矩阵）
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/recovery-evidence-readback-request-repository.ts`（如需 lookup helper）
- `src/storage/index.ts`
- 可能新增 `src/storage/recovery-evidence-recovery-lineage.ts`
- 可能新增 `src/recovery/recovery-evidence-recovery-preflight.ts`

测试：

- 新增 `tests/storage/recovery-evidence-interrupted-recovery.test.ts`
- 可能新增 `tests/storage/recovery-evidence-recovery-worker.ts`
- 更新 `tests/storage/recovery-evidence-dispatch-uow.test.ts`
- 更新 `tests/storage/recovery-evidence-uow.test.ts`
- 更新 `tests/storage/snapshot-concurrency.test.ts`

文档：

- Stage 3.4 Development Report
- 如修改总体计划，单独提交计划修订

不预期修改：

- Migration v4–v9。
- Recovery Manager / Classifier 生产入口。
- ToolRegistry / External Read。
- Transaction B。

## 14. Implementation Order

### Stage 3.4 Step 1 — Recovery Lineage Contract

目标：

- 定义 `RecoveryEvidenceLineageV1`。
- 实现纯 schema / validator。
- 定义 Event payload canonical shape。
- 包含 root recoveryOperationId、recoveryPhase、retryAssessment、
  leaseClaimEventId 和 resumeEligible 一致性约束。

前置条件：

- 本计划通过最终架构评审。
- 接受 Event payload-based V1 lineage 作为 Step 1 契约。
- 不修改 Migration v4–v9。
- 不创建 Recovery UoW / Capability / Lease Takeover 生产入口。
- 如要求 DB-level recoveryOperationId uniqueness，必须先另行评审
  Migration v10，Step 1 暂停。

验收：

- 合法 full / pause-resume lineage 通过。
- 缺 recoveryOperationId / priorAttemptId / interruptionEventId 失败。
- 跨 Task / Request / ToolRun / Attempt 失败。
- attemptNumber 必须连续。
- interrupted / prepared Event 引用必须一致。
- interrupt / prepare 可共享 root ID，但 phase-specific Replay key 不同。
- retryAssessment / resumeEligible 组合矩阵通过。
- Interrupted / Prepared payload 使用 discriminated union，不依赖 null
  字段区分 phase。
- Interrupted payload 禁止出现 interruptionEventId / newAttemptId。
- Prepared payload 必须包含 interruptionEventId / newAttemptId。
- Event payload canonical shape 通过严格 Zod 校验。

### Stage 3.4 Step 2 — State Transition Metadata Extension

目标：

- 扩展 internal State Transition UoW，使 interrupted Event 可携带
  Recovery metadata。
- 不改正常 failure / cancel / pause behavior。

验收：

- dispatching -> interrupted 事件完整。
- interrupted Event 写 recoveryPhase=interrupt、retryAssessment、
  leaseClaimEventId。
- Event、Attempt、ToolRun、PlanStep 状态原子。
- Existing Stage 3.1 regression 全部通过。
- Exact Replay 不重复 Event / Checkpoint。

### Stage 3.4 Step 3 — Recovery Preflight Capability

目标：

- 新增 Host-owned Recovery Preflight。
- exact allowlist / retrySafety / consistency / expected binding。

验收：

- 普通对象和克隆无法伪造。
- spread clone / JSON clone / TypeScript cast 无法重构 capability。
- 错误 Task / Request / ToolRun / allowlist / intent digest 被拒绝。
- 历史 allowlist version 不可恢复时，Takeover 后写 interrupted +
  `resumeEligible=false`，不创建新 Attempt。
- immutable / version_conditional 分支正确。
- 不在 transaction 内调用 Registry。

### Stage 3.4 Step 4 — Fencing Takeover Guard

目标：

- 明确 new Owner claim / old dispatch fencing / active lease 条件。
- 统一 takeover 结果：
  - ready
  - in_progress
  - lease_conflict
  - state_inconsistent

验收：

- 两 Owner 并发只有一人 claim 成功。
- active lease 不可 takeover。
- expired / released lease 接管后 fencing 严格递增。
- Lease Claim API 返回 leaseClaimEventId。
- Recovery UoW 校验 Claim Event task / fencing / sequence。
- old Owner 的 SQLite 写操作失败；不假设跨进程 Authority 被同步 revoke。

### Stage 3.4 Step 5 — Interruption-only UoW

目标：

- 实现 Pause-induced / takeover interruption-only。
- old Attempt dispatching -> interrupted。
- ToolRun -> interrupted。
- PlanStep -> interrupted。
- 不创建新 Attempt。

验收：

- Pause generation 正确绑定。
- Cancel 优先于 Pause。
- Cancel 存在时 interruption-only，不创建新 Attempt。
- Retry Unsafe 时 interrupted + `resumeEligible=false`。
- interruption Replay 使用 phase=interrupt。
- Cancel interruption COMMIT 后崩溃，可复用 cancelIntentEventId 驱动
  Stage 3.3 收敛。
- 新 Owner fencing > old dispatch fencing。
- Exact Replay 返回原 interrupted Event。
- Failure/Checkpoint fault rollback。

### Stage 3.4 Step 6 — Full Interrupted Recovery + New Attempt

目标：

- Full Recovery 在同一 immediate transaction 完成 interrupted + requeue +
  new Attempt。
- Pause Resume Continuation 只完成 requeue + prepared Event + new Attempt，
  不重复写 interrupted。
- 新 Attempt = prepared。
- attemptNumber = MAX + 1。
- ToolRun queued、PlanStep running、Plan active。
- Pause continuation 使用同一 root recoveryOperationId +
  recoveryPhase=prepare。

验收：

- 旧 Attempt / ToolRun / PlanStep 历史保留。
- 新 prepared Event 包含完整 lineage。
- 单 Request / ToolRun 最多一个 active Attempt。
- prepare Replay 返回同一 Attempt，不创建第二个 active Attempt。
- Pause continuation 的 Prepared Event 使用当前 Resume Owner 的
  leaseClaimEventId / fencingToken，不复用旧 interruption Claim。
- 原 Request / Intent Digest / ToolRun 不变。
- 原 Agent Plan / Unknown Write 不变。

### Stage 3.4 Step 7 — Stage 3.2 Integration & Concurrency

目标：

- Stage 3.2 Dispatch 能从 Stage 3.4 lineage 通过。
- 不放宽 Gate。

验收：

- 完整 lineage 可 Dispatch。
- 缺字段 / 错 ID / 错 fencing / 多 active Attempt 被拒绝。
- 两个 Recovery worker 并发只有一个创建 Attempt。
- 响应丢失使用同一 recoveryOperationId 返回同一 Attempt。
- 没有重复 Event / Checkpoint。

### Stage 3.4 Step 8 — Fault Injection & Regression

目标：

- 覆盖崩溃窗口、Cancel/Pause race、Event/Checkpoint failure、旧 Owner
  late result。

验收：

- 所有多表失败整体 rollback。
- Outcome uncertain 不被写成 failed / timed_out / cancelled。
- 不调用 External Read。
- 全量 test / typecheck / diff check。

## 15. Test Matrix

| 场景 | 预期 |
|---|---|
| Lease active | takeover 拒绝 |
| Lease expired | fencing +1 |
| Two takers | 只有一个成功 |
| Old dispatch fencing >= new | 拒绝 |
| Old owner late failure | lease/fencing 拒绝 |
| interrupt replay | 返回原 Interrupted Event |
| prepare replay | 返回同一 new Attempt |
| interrupt replay 后继续 prepare | 合法 continuation |
| interruption payload | 不包含 interruptionEventId/newAttemptId |
| prepare payload | 必须包含 interruptionEventId/newAttemptId |
| same operation concurrent | 一个 create，一个 replay |
| interruption Event committed only | manual/fail closed |
| new Attempt prepared | replay 不重复写 |
| new Attempt dispatching | in_progress |
| new Attempt terminal | persisted terminal / conflict |
| Cancel before takeover | cancel_required / in_progress，不写 Attempt |
| Cancel after takeover, before Recovery | interruption-only，不创建新 Attempt |
| Cancel after Recovery commit | Stage 3.3 cancel prepared Attempt |
| Pause before Recovery | interruption-only |
| Pause after Recovery commit | Stage 3.3 blocks prepared |
| Pause cleared | resume path |
| Pause resume by new Owner | Prepared 引用新 Claim Event |
| Prepared Claim sequence | 早于 Prepared Event；不要求晚于 Interrupted Event |
| New Pause after clear | stale resume拒绝 |
| immutable request | preflight + new Attempt |
| version_conditional | expected version/etag preserved |
| allowlist missing after takeover | interrupted + resumeEligible=false |
| Retry Unsafe after takeover | interrupted + resumeEligible=false |
| Cancel interruption COMMIT 后崩溃 | 同 cancelIntentEventId 重新驱动 Stage 3.3 |
| retryAssessment matrix | passed / failed / not_evaluated 严格校验 |
| ToolRun interrupted->queued | success |
| PlanStep interrupted->running | success |
| Event failure | rollback |
| Checkpoint failure | rollback |
| Original Agent Plan | unchanged |
| Original Unknown Write | unchanged |

## 16. Migration / Schema Risk

### 16.1 当前判断

Stage 3.4 的 V1 Lineage 可以存入 Event payload，不需要立即新增 Migration
v10：

- Attempt 已有 interrupted / prepared 状态。
- ToolRun / PlanStep transitions 已支持。
- Event payload 可扩展 versioned JSON。
- Stage 3.2 已从 Event 校验 lineage。

### 16.2 真实风险

`recoveryOperationId` 没有数据库唯一约束。

当前只能依赖：

- SQLite single-writer。
- immediate transaction。
- UoW 查询后插入。

如果架构要求数据库级 `UNIQUE(task_id, recovery_operation_id)`，必须单独
提交 Migration v10 方案，不能在本轮自行创建。

### 16.3 性能风险

Event-based lineage 查找需要扫描 `events` payload。当前项目规模可接受，
但数据量增大后可能需要 index / normalized lineage table。

该性能优化不是 Stage 3.4 的硬阻塞。

### 16.4 Durable Recovery Operation Context

recoveryOperationId 本身不需要新表，但必须由 Host / Recovery Coordinator
持久化在 Recovery Job / Command / idempotency context 中。

当前源码没有该组件：

- 这不是 Migration v9 Schema 的阻塞。
- 但它会阻塞 Step 5 的生产恢复入口。
- 不得用进程 Map、随机数临时变量或“调用方自行记住”替代。
- 若后续决定把 Command context 放进 SQLite，必须先单独提交 Migration
  方案，不在本计划中创建。

## 17. Open Architecture Questions

1. `recoveryOperationId` 由 Host UUID，还是由 Recovery Coordinator
   deterministic hash 生成？
2. 是否接受 Event payload + immediate transaction 的应用级唯一性，
   不新增 DB UNIQUE index？
3. Pause-induced interruption-only 是否需要单独的
   `resumeInterruptedOwned...()`，还是扩展 Stage 3.3 Resume？
4. interrupted Event 是否新增专用 `fencing_takeover` Event，还是只写
   recovery metadata？

已确定，不再作为开放问题：

- Retry Unsafe 必须保留 interrupted 历史并进入 manual Review。
- 旧 Owner late result 不能写成成功；Stage 3.4 只保留 interrupted /
  outcome uncertain。
- `attemptNumber` 固定 `MAX + 1`，不允许预留 gap。
- Recovery Preflight Capability 与 Stage 3.2 Dispatch Preflight 分离。
- `resumeEligible=false` 必须阻断 Resume / Dispatch，不能由 Pause Clear
  绕过。

## 18. 附加问题逐项答复

### Q1. Pause-induced interruption 后，Clear 能否通过 Stage 3.2 Gate？

可以，但必须分两个 transaction：

1. Pause 期间合法 Takeover，执行 interruption-only。
2. Host Clear Pause 后，执行 Resume transaction 创建 new Attempt。

Event lineage：

```text
pause_requested:
  pauseEventId
  pauseRequestedAt

interrupted:
  recoveryOperationId
  recoveryPhase = interrupt
  readAttemptId = priorAttemptId
  priorAttemptId = priorAttemptId
  dispatchEventId
  dispatchFencingToken
  fencingToken = newOwnerFencing
  pauseRequestEventId
  resumeEligible = true  // Retry Safety 已通过

pause_cleared:
  clearedPauseEventId = pauseRequestEventId

new prepared:
  recoveryOperationId
  recoveryPhase = prepare
  priorAttemptId
  interruptionEventId
  newAttemptId
  pauseClearEventId = pause_cleared.id
  leaseClaimEventId = resume owner claim
  fencingToken = currentFencing
```

Stage 3.2 当前会验证 interrupted Event 的 `resumeEligible=true`、
Pause source 对应的 clear Event 和 prepared lineage。

### Q2. Cancel + interruption-only 后如何最终收敛？

Recovery 事务只把旧 Attempt / ToolRun / PlanStep 转为 interrupted。
随后调用 Stage 3.3 `cancelOwnedRecoveryEvidenceRead()`：

- Attempt 保持 interrupted。
- Stage 3.4 Cancel interruption-only 写入：
  `retryAssessment=not_evaluated`、`resumeEligible=false`。
- interrupted Event 为 immutable；Stage 3.3 不得修改其中任何字段。
- ToolRun / PlanStep / Plan 收敛为 cancelled。
- 不创建新 Attempt。
- 不执行 Retry Safety。
- 不声称外部 Read 未发生。
- 已 interrupted Request 的 Cancel Exact Replay 不重复写 Interrupted Event。

### Q3. Retry Unsafe 为什么不能保留 dispatching？

取得合法 Takeover 后，旧 Owner 已不具备全局提交权。继续保留
`dispatching` 会造成：

- 系统无法区分“旧 Owner 仍合法执行”和“所有权已转移但未结算”。
- 旧 Attempt 永久停在中间状态。
- Recovery / Cancel / Classifier 无法安全分类。
- 后续可能错误接受旧结果。

因此必须写 `interrupted + resumeEligible=false`，将结果保留为 outcome
uncertain 并进入 manual Review。

### Q4. Exact Replay 如何处理第一次创建的 active prepared Attempt？

按 `taskId + recoveryOperationId + prepare` 找到完整 lineage 后，直接
返回该 prepared Attempt。Exact Replay 位于“其他 active Attempt 冲突
检查”之前，因为该 active Attempt 正是当前 phase 的历史结果，不是竞争者。
如果中断 phase 也命中，则返回原 Interrupted Event，二者不会互相覆盖。

### Q5. 同一 recoveryOperationId 对应不同 identity 如何处理？

以下任一不一致返回 `state_inconsistent`：

```text
Request ID
priorAttemptId
interruptionEventId
newAttemptId
ToolRun ID
fencing lineage
pauseClearEventId
```

不得选择“较新”记录，也不得静默修复。

### Q6. 响应丢失后如何复用 recoveryOperationId？

`recoveryOperationId` 由调用方上层 Recovery Coordinator 在第一次调用前
生成并写入 durable Recovery Job / Command / idempotency context，不由 UoW
每次调用随机生成。同一逻辑恢复的跨进程重试必须读取同一个 ID；新的恢复
轮次才生成新 ID。

当前仓库没有 Recovery Job 持久化表或等价组件，因此：

- Step 1 可以先实现纯 Lineage Contract。
- Step 5 的生产入口在 Host 提供 durable operation context 前必须 blocked。

### Q7. 如何复用同一个 StorageWritePermit？

Recovery State Transaction：

```text
runInTransaction(database, ..., "immediate")
  -> createStorageWritePermit(database) 一次
  -> 传入 State Transition UoW
  -> 传入 Attempt / ToolRun / PlanStep / Event / Checkpoint Repository
```

State Transition UoW 只接受 current-transaction permit，不打开 nested
transaction。

### Q8. interrupted / prepared Event 与 Attempt.last_event_id 顺序？

固定顺序：

1. append interrupted Attempt Event，包含 `recoveryPhase=interrupt`、
   `retryAssessment`、`leaseClaimEventId`。
2. old Attempt -> interrupted，`last_event_id = interruptedEvent.id`。
3. 写 ToolRun / PlanStep interrupted events 和状态。
4. Retry Safety 通过且需要 full recovery 时：
   - ToolRun interrupted -> queued。
   - PlanStep interrupted -> running。
   - append prepared Event，包含 `recoveryPhase=prepare` 和同一 root
     recoveryOperationId。
   - insert new Attempt，`last_event_id = preparedEvent.id`。
   - append final Checkpoint。
5. transaction 内某一步失败，全部 rollback。

如果 interruption-only，则到步骤 3 + checkpoint 后提交。

### Q9. Intent 在两个 transaction 之间提交如何处理？

Intents 由独立 control-plane Transaction 提交，不要求 Lease。Recovery
State Transaction 开始后重新读取最新 Intent。

- Intent 先提交：Recovery 进入 Cancel/Pause interruption-only。
- Recovery 先提交：Intent 后提交，新 prepared Attempt 由 Stage 3.3
  Pause/Cancel 收敛；若已 dispatching，只能等待合法 Takeover 后 Stage 3.4
  interruption-only。

### Q10. Lease Claim Event 与 Interrupted Event 是否关联？

已确定关联。Lease Claim Transaction 应返回 `leaseClaimEventId`，
Recovery State Transaction 的 interrupted Event 写入：

```text
leaseClaimEventId
dispatchEventId
dispatchFencingToken
fencingToken
```

UoW 必须验证该 Lease Event：

- taskId 匹配。
- fencingToken 等于当前 ownership。
- sequence 位于 Dispatch Event 之后、Interrupted Event 之前。

该 API 扩展属于 Step 4 必需验收项。

Interrupted Event 与 Prepared Event 分别引用“写入自己的当前 Owner Claim”：

- Full Recovery 可引用同一个 Claim。
- Pause Clear 后 Resume Continuation 必须引用 Resume Owner 的新 Claim。
- Prepared Claim 只要求早于 Prepared Event，不要求晚于 Interrupted Event。

## 19. 设计状态

### 已确定

- Cancel 在合法 Takeover 后允许 interruption-only，随后由 Stage 3.3 收敛。
- Pause 在合法 Takeover 后允许 interruption-only，不立即创建新 Attempt。
- Retry Unsafe 必须写 interrupted + `resumeEligible=false`。
- `resumeEligible` 只表示 Retry Safety / historical contract 是否满足。
- `retryAssessment` 区分 passed / failed / not_evaluated。
- Exact Replay 在 active Attempt 冲突检查之前。
- Exact Replay 使用 root ID + phase。
- Recovery Preflight 与 Dispatch Preflight Capability 分离。
- `ExecutionAuthority` 不能跨进程直接 revoke。
- Lease Claim Transaction 与 Recovery State Transaction 分开命名。
- recoveryOperationId 由 Host UUID 在首次调用前生成，并持久化在
  durable Recovery Command / Job 中。
- 复用现有 `lease.claimed` Event，interrupted Event 引用
  leaseClaimEventId。
- Step 1 只做 pure Lineage Contract。

### 待确认

- 是否接受 Event payload + immediate transaction 的应用级唯一性。
- Pause-clear 后 Resume 的 UoW 归属与命名。
- 是否额外增加 `recovery_prepared` 聚合 Event。
- `TaskLeaseManager.claim()` 返回 claimEventId 的具体 API 形态。

### 未知

- Stage 4 如何提供外部 Read 的启动门和可信 Settlement capability。
- 旧 Owner 外部 Promise 的实际终止能力。
- 当前仓库缺少 durable Recovery Job / Command store；Step 5 前必须由 Host
  补齐。
- 大规模 Event lineage 查询性能。
- 既有 Transaction B completion 未同步 Plan 状态的后续修复范围。

## 20. 建议

建议先批准并实施：

```text
Stage 3.4 Step 1 — Recovery Lineage Contract
```

理由：

- 它是后续所有 Recovery UoW 的数据契约。
- 不修改生产数据库。
- 可独立进行 schema、identity binding 和 pure validation 测试。
- 若 Step 1 评审发现 recoveryOperationId 必须 DB 唯一，再另行决定是否
  需要 Migration v10，避免在业务 UoW 中临时绕过。

Step 1 未通过前，不应开始 Fencing Takeover 或 interrupted Recovery
生产实现。

## 21. 修订摘要

| 评审问题 | 文档章节 | 修改理由 |
|---|---|---|
| A. Cancel 与 dispatching 收敛死路 | §4.5、§8.4、§12.1、Q2 | 合法 Takeover 后允许 interruption-only；Stage 3.3 再执行 Request Cancel |
| B. Retry Unsafe 状态语义 | §4.4、§8.3、Step 5、Q3 | Retry Unsafe 也必须留下 interrupted 历史，不能永久 dispatching |
| C. resumeEligible 语义 | §4.5、§5.1、§8.5、§10、Q1 | 仅表达 Retry Safety / historical contract，不承载当前 Pause/Cancel |
| D. Exact Replay 与 active Attempt | §7.2、§11.2、Q4/Q5 | 先按 operation identity replay，再检查竞争 active Attempt |
| E. ExecutionAuthority 跨进程 | §7.3、Q9/Q10 | 新 Owner 不能同步 revoke 旧进程；SQLite lease/fencing 才是全局依据 |
| F. Recovery Preflight Capability | §4.4、§6.3、Step 3 | 与 Stage 3.2 Dispatch Preflight 分离，职责和绑定字段明确 |
| G. 事务命名冲突 | §7.1、§7.2、§11.5 | 改为 Lease Claim Transaction / Recovery State Transaction |
| H. Step 1 验收范围 | §14 Step 1 / Step 3 | Step 1 只测试 pure lineage；Capability 防伪移至 Step 3 |

附加修订：

- §18 逐项回答 10 个架构问题。
- §19 区分已确定、待确认和未知事项。
- §20 明确 Step 1 的实际前置条件。

### 最终一致性评审追加修订

| 最终问题 | 文档章节 | 修改理由 |
|---|---|---|
| Phase-aware Exact Replay | §4.3、§5、§7.2、§7.3、§11、Q1/Q4 | root ID 不变，以 interrupt / prepare phase 分开 Replay |
| Replay 早于首次执行状态检查 | §7.2、§11.2 | 首次成功后旧 Attempt 已 interrupted，Replay 不能要求 dispatching |
| retryAssessment | §5.1、§8.3、§8.4、§10 | 区分 passed / failed / not_evaluated，保持 Stage 3.2 兼容 |
| Cancel Convergence crash contract | §12.4、Test Matrix | interruption 后崩溃可由相同 cancelIntentEventId 重驱动 Stage 3.3 |
| recoveryOperationId 持久性 | §4.3、§16.4、Q6 | UUID 必须保存在跨重启 durable command/job，不依赖进程内存 |
| leaseClaimEventId | §5.1、§7.1、§7.2、§10、Q10、Step 4 | 复用 lease.claimed Event 并建立精确关联 |

### Final Contract Consistency Fix 追加修订

| 最终问题 | 文档章节 | 修改理由 |
|---|---|---|
| A. Pause Resume Continuation 首次执行分支 | §7.2、§7.3、§11、Step 6 | 明确区分无 interruption lineage 的 Full Recovery 与已有 interrupted lineage 的 Continuation |
| B. Lineage Schema 字段结构 | §4.2、§5、§9、Step 1 | 改为 recoveryPhase discriminated union，禁止用 null 混用不适用字段 |
| C. Interrupted Event 不可变性 | §5.1、§8.4、Q2 | Cancel interruption 固定 not_evaluated / false；Stage 3.3 只追加下游 Cancel 审计 |
| D. Phase-specific Lease Claim 审计 | §5.1、§5.2、§7.1、§7.2、§9、Q10、Step 4/6 | 每个 Event 引用写入时的当前 Owner Claim；Continuation 必须使用新 Owner Claim |

### 真实源码核查依据

- `src/storage/recovery-evidence-unit-of-work.ts`
  - `beginOwnedRecoveryEvidenceRead()`
  - `hasValidRetryDispatchLineage()`
  - `cancelOwnedRecoveryEvidenceRead()`
  - `resumeBlockedOwnedRecoveryEvidenceRead()`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-state-matrix.ts`
- `src/storage/recovery-evidence-read-attempt-repository.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/task-lease-repository.ts`
- `src/persistence/lease-heartbeat.ts`
- `src/storage/event-repository.ts`
- `src/storage/checkpoint-store.ts`
- Migration v8 / v9 Schema 与 Trigger

核查结论：

- Stage 3.2 的实际 Gate 要求 interrupted / prepared Event 中 root
  recoveryOperationId 相等且 `resumeEligible===true`。
- Stage 3.3 对 dispatching Cancel 在无可信 Settlement 时 fail closed。
- `TaskLeaseManager.claim()` 当前只返回 lease record，不返回 claim Event ID。
- 仓库当前没有 durable Recovery Job / Command store。
