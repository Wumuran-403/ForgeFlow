# ForgeFlow Phase 3 Step 6.3.5 Final RecoveryReview Architecture Design

> 状态：最终架构评审通过（2026-11-09），作为 Step 6.3.5 实施设计基线。
>
> 后续实施必须按
> `docs/PHASE3_STEP6_3_5_IMPLEMENTATION_PLAN.md` 分步授权。
>
> Design approval 不等于生产代码开发授权。

## 0. 结论摘要

### 已批准原则与生命周期收口

- Step 6.3.5 核心是 Final RecoveryReview Decision、Cancel 交互、
  Multi-Write Barrier 与 Task / Plan terminal convergence。
- `requestKey` 应作为最终决策的唯一幂等身份。
- Final Decision 不执行 External Read / Verifier / Provider。
- Original Unknown Write ToolRun 应保持 `unknown`。
- Nonterminal Exact Replay 继续走 Lease-owned UoW。
- Terminal Task 不能重新 Claim Lease，因此需要独立的只读 Replay 路径。
- Multi-Write Barrier 必须在真实 Write 副作用开始前执行。
- `waiting_review -> completed` 只能由受 capability 保护的 Final
  Convergence Transition 执行。
- Multi-Write Barrier 必须进入持久化 Write admission 的组合事务，并封闭
  `AgentRunner` 的 direct Write 旁路；scheduler-less direct 路径只允许
  Read。
- Manual Reviewer 与 Host Verifier 分别持有独立的 Final Decision
  Authorization；Verifier `failed` 不允许人工覆盖。
- Pause 期间允许 audit-only Final Decision，但不得 Resume、Dispatch 或
  Re-plan。
- `confirmed_not_executed` 将当前 Write PlanStep 收敛为 `failed`，将尚未
  执行且依赖该 Write 的 queued ToolRun / PlanStep 收敛为 `skipped`，
  不自动 Re-plan。
- `actorType` 进入 decision payload digest、`requestKey` 绑定和 Final
  Decision Event payload。
- Terminal Task 的 Exact Replay 使用独立 Host-authorized read-only path。
- 本轮未发现核心 Final Decision 需要 Migration v10 的 Schema blocker。
- failed Task 后的 Re-plan 只能建立新 Task；原 Task 永久 terminal。
- Re-plan lineage / operation persistence 属于 Step 6.3.5 之外的后续
  Migration 设计，不在本轮实现。
- Final Decision Event -> Operation -> downstream skip Event -> Terminal
  Guard -> Task terminal -> Checkpoint 是唯一权威事务顺序。
- Final Decision / Terminal Replay Authorization 绑定完整 requestKey 和
  payload digest，不能只绑定 review / decision 类型。
- 所有 confirmed_not_executed 都需要 SourceContractV1；Manual 使用
  manual_attested，Automatic 使用 system_verified。
- PlanStep 与 ToolRun 为 1:N；批量 skipped 必须先验证全部 ToolRun，再执行
  唯一一次 PlanStep CAS。

### 当前结论

前序 P1 与本轮六项最终一致性问题均已收口。文档具备提交最终架构评审的
条件；实现仍需单独授权，**不得从本设计直接进入 Step 6.3.5 开发**。

## 1. 证据标记

- **[已实现]** 当前源码存在生产实现。
- **[已测试]** 历史 Development Report 记录测试通过。
- **[静态源码确认]** 本轮阅读源码确认，未重新执行测试。
- **[原计划明确]** 原始计划明确要求。
- **[已批准原则]** 已由前序架构评审批准，本轮不得回退。
- **[最终建议]** 本轮只读审计得出的推荐设计，已随最终架构评审纳入基线。
- **[待决策]** 当前没有权威结论，不得写成生产已实现行为。

前文已有 `[Final Architecture Decision]` 标记视为
`[已批准原则]` 的等价历史标记。

本轮未重新执行测试。

## 2. 权威范围

### 2.1 原始范围

`docs/PHASE3_STEP6_3_IMPLEMENTATION_PLAN.md` §19 明确定义：

```text
6.3.5 Final Decisions + Cancel + Multi-Write Barrier

- confirmed_succeeded / confirmed_not_executed
- PlanStep completed/failed
- Task terminal invariants
- cancel intent
- multi-write barrier
```

§20 明确测试：

- v1 Final Decision 只能是 Lease-owned UoW。
- 并发 decision 只能一个成功。
- duplicate requestKey 不重复 Event / Checkpoint。
- earlier unknown barrier 阻止 later write。
- active review 阻止 cancelled。
- all trusted final + cancel intent -> cancelled。
- confirmed_not_executed + PlanStep failed -> 不可 completed。

### 2.2 后续修订

`docs/PHASE3_STEP6_3_4_4_REMAINING_IMPLEMENTATION_PLAN.md` §9 把目标聚合为
Final RecoveryReview：

- Final Decision Input。
- expectedDecisionVersion CAS。
- Evidence / Verification 完整性。
- Original Unknown Write 审计。
- Final statuses。
- Cancel interaction。
- Decision Replay / Idempotency。
- Review Event。
- Task / Plan convergence。
- Manual / Automatic boundary。

### 2.3 范围裁定

**[原计划明确]**

Step 6.3.5 必须实现：

1. Final RecoveryReview Decision。
2. Original Unknown Write 最终审计。
3. PlanStep / Plan / Task convergence。
4. Cancel Intent 交互。
5. Multi-Write Barrier。
6. Decision Version CAS / Exact Replay。
7. Manual / Automatic authorization。
8. Fault Injection / Regression。

**[已批准原则]**

- Cancel 核心状态收敛继续复用 Stage 3.3 已封存 UoW；Step 6.3.5 消费
  Cancel Intent，并保证 Final Decision 是 audit-only，不回滚已提交事实。
- Multi-Write Barrier 属于 Step 6.3.5，必须接入持久化 Write admission，
  而不是只实现纯 Policy 测试。

### 2.4 不属于 Step 6.3.5 默认范围

- Durable Recovery Job / Command Store。
- Durable `recoveryOperationId` context。
- Recovery Evidence Scanner。
- Recovery Evidence Worker。
- External Read execution。
- Transaction B execution。
- Verifier execution。
- exactly-once External Execution。
- Failed Task Re-plan Task creation / Replan lineage / Replan authorization。

这些是前置、相邻或后续设计。

## 3. Architectural Decisions

### AD-1：Final Decision 是 audit-only operation

**[Final Architecture Decision]**

- 不执行任何外部副作用。
- 不调用 Provider / Verifier / External Read。
- 只读并结算持久化 Evidence / Verification / Lineage。
- 可以写入 Review、Operation、PlanStep、Plan、Task、Event、Checkpoint。

### AD-2：requestKey 是唯一幂等身份

**[Final Architecture Decision]**

- 使用现有 `computeRecoveryReviewOperationRequestKey()`。
- 不引入第二套 Host stable `operationId`。
- `recovery_review_operations.id` 继续作为存储主键。
- 同一请求重放按 `requestKey` 查历史。

### AD-3：Original ToolRun 永远保持 unknown

**[Final Architecture Decision]**

- Final Decision 不修改 Original ToolRun.status。
- 最终结论由 Review、Operation、Event、PlanStep 表达。

### AD-4：Final Decision 与 Task completion 同事务

**[Final Architecture Decision]**

- 最后一条必需 Review 完成时，可以在同一 immediate transaction 内完成
  Task terminal convergence。
- 若仍有未解决 Review / Unknown / Active Step，只提交 Decision，
  Task 保持 `waiting_review`。

### AD-5：Terminal Task Replay 不使用 Lease

**[Final Architecture Decision]**

- Terminal Task 拒绝 Claim。
- Terminal 后响应丢失 Replay 使用 Host-authorized read-only query。
- 该路径不写数据库、不签发 ExecutionAuthority。

### AD-6：Barrier enforcement 在 Write admission

**[Final Architecture Decision]**

- 不修改 Stage 3.2 Recovery Evidence Dispatch Gate。
- 在 `src/persistence/execution-bridge.ts` 的 `beforeExecute()` 与
  `beginOwnedToolRun()` 之间建立同一 immediate transaction 的 barrier
  check + begin run 原子操作。
- `persistence !== undefined` 的 `AgentRunner` 必须配置 scheduler；否则
  运行 fail closed，不能走 direct `registry.execute()`。
- 即使没有 persistence，scheduler 缺失时任何 Write tool invocation 也必须
  fail closed；direct `registry.execute()` 只能承载无 durable Task 的 Read。

## 4. Final Decision Transaction Order

### 4.1 推荐顺序

```text
Host Authorization capability presented
  -> pre-check current Lease / Ownership / Fencing
  -> BEGIN IMMEDIATE
  -> one StorageWritePermit
  -> re-check Lease / Fencing / ExecutionAuthority
  -> Service builds canonical decision payload
  -> Service computes operationPayloadDigest
  -> Service computes requestKey
  -> validate Authorization claims against canonical digest / requestKey /
     operation / expectedDecisionVersion / actorId / actorType
  -> lookup operation by requestKey
       |
       +-- found:
       |    -> verify operation / review / event / actor / payload digest /
       |       sourceContractDigest / authorization claims
       |    -> load historical result
       |    -> return replay
       |    -> no mutable version CAS, no Event, no Checkpoint
       |
       +-- not found:
            -> expectedTaskVersion CAS
            -> latest Cancel / Pause Intent
            -> Review decisionVersion CAS into final status
            -> Evidence / Verification eligibility
            -> Multi-Write Barrier
            -> current Write PlanStep completed / failed
            -> generate operationId
            -> append Final Decision Event containing operationId and obtain
               real decisionEventId
            -> append applied Operation with appliedEventId = decisionEventId
            -> load all downstream PlanSteps and all associated ToolRuns
            -> validate all expected versions and legal skipped states
            -> transition every downstream ToolRun
            -> append one tool.skipped Event per ToolRun, referencing
               decisionEventId
            -> transition each downstream PlanStep once
            -> append one plan_step.skipped Event per PlanStep, referencing
               decisionEventId
            -> ExecutionPlan active -> terminal when all steps terminal
            -> run Terminal Guard after Review / Operation / Event / Evidence /
               Verification / downstream states are visible in this transaction
            -> optional Task terminal transition
            -> Checkpoint
            -> COMMIT
```

### 4.2 关键规则

- Authorization 和 Ownership 必须同时验证。
- Historical Operation 不能替代当前 Authorization。
- Authorization 必须绑定完整决策请求；`requestNonce` 只是防重放字段，
  不能替代 `requestKey` / payload digest / operation / expected version。
- Operation Replay 不得被 Task version 或 Review version CAS 拦截。
- Operation 不存在时为首次应用，必须执行全部 CAS 与 Evidence Gate。
- Final Decision Event 必须先写入并返回真实 Event ID，downstream skip Event
  才能在 payload 中引用 `upstreamDecisionEventId`。
- Event Repository 的单次 `append()` 会生成并返回 Event ID；Final Decision
  UoW 必须使用该返回值作为真实 `decisionEventId`，不能预造 Event ID 或
  依赖调用方传入。
- `Operation.appliedEventId` 必须精确等于该 Final Decision Event ID。
- Task Terminal Guard 必须在 Review final、Operation、applied Event、
  Evidence、Verification 和 downstream skipped 状态均于当前事务可见后执行。
- Operation insert、所有 Event、所有状态转换和 Checkpoint 必须同事务；
  任一步失败共同 rollback。
- Concurrent duplicate `requestKey` 由 immediate transaction +
  `UNIQUE(request_key)` 串行化。

## 5. Operation Identity / Idempotency

### 5.1 requestKey

继续使用：

```text
computeRecoveryReviewOperationRequestKey({
  reviewId,
  expectedDecisionVersion,
  operation,
  operationPayloadDigest,
  actorId
})
```

Final operations：

```text
confirm_succeeded
confirm_not_executed
```

### 5.2 decisionPayloadDigest

**[Final Architecture Decision]**

Canonical payload：

```text
forgeflow.recovery-review-final-decision.v1
{
  taskId,
  recoveryReviewId,
  originalUnknownWriteToolRunId,
  decision,
  actorType,
  evidenceSubmissionId,
  verificationCheckId | null,
  verificationId | null,
  sourceContractDigest | null,
  decisionNote | null
}
```

规则：

- Service 计算，不信任调用方直接提供的 Digest。
- `actorId` / `actorType` 来自 Host Authorization。
- `actorId` 由现有 requestKey helper 进入身份。
- `actorType` 进入 decisionPayloadDigest，因此同一 actorId 以不同 actorType
  调用会得到不同 requestKey。
- `expectedDecisionVersion` 由现有 requestKey helper 进入身份。
- `expectedTaskVersion` 不进入 requestKey。
- `decisionNote` 会持久化并影响审计，因此进入 Digest。
- 所有 `confirmed_not_executed` 的 `sourceContractDigest` 必须非空，且与
  持久化 canonical `SourceContractV1` payload 匹配；自动与人工路径分别
  使用 `system_verified` / `manual_attested` 的 Contract，不得互相冒充。
- `confirm_succeeded` 的 `sourceContractDigest` 为 null，不得携带无来源
  digest。

### 5.3 Exact Replay

找到 `requestKey` 后必须验证：

- taskId。
- reviewId。
- operation type。
- actorId。
- actorType / authorization claims。
- operationPayloadDigest。
- expectedDecisionVersion。
- applied Event 存在，且
  `Operation.appliedEventId = Event.id`、
  `Event.payload.operationId = Operation.id`、
  `Event.payload.requestKey = Operation.requestKey`。
- Event payload actorId / actorType 与 Operation / Authorization claims
  完全一致。
- Event `sourceContractDigest` 必须与 canonical decision payload 和持久化
  `SourceContractV1` 一致。
- Review 当前 final 状态与 Operation 一致。

任一项不同：

```text
RECOVERY_REVIEW_FINAL_DECISION_OPERATION_CONFLICT
```

### 5.4 Output

成功：

```text
state = applied | replayed
review
operation
originalUnknownWriteToolRun
planStep
executionPlan
task
taskOutcome
```

稳定冲突：

```text
decision_version_conflict
operation_identity_conflict
evidence_insufficient
intent_conflict
state_inconsistent
```

Authorization / ownership 失败继续使用 `AppError`。

## 6. Evidence Eligibility Matrix

### 6.1 原则

Evidence observation、Provenance、Verification status 与 Decision Actor
是四个独立维度。

`verificationStatus=passed` 不能单独证明：

- 外部 Write 成功。
- 外部 Write 未执行。

### 6.2 Final Eligibility Matrix

**[Final Architecture Decision]**

| Evidence / Verification | confirmed_succeeded | confirmed_not_executed |
|---|---|---|
| Binding mismatch | Reject | Reject |
| Evidence missing | Reject / unresolved | Reject / unresolved |
| passed + observed_succeeded + trusted provenance | Eligible | Reject |
| passed + observed_not_executed + contract proves non-execution | Reject | Eligible |
| passed but observation conflicts with decision | Reject | Reject |
| failed | Reject | Reject |
| inconclusive | Manual only with authoritative evidence | Manual only with authoritative evidence |
| not_run | Manual only with authoritative evidence | Manual only with authoritative evidence |
| External result unknown | Manual only | Manual only |
| Payload file exists but no committed EvidenceRead | Reject | Reject |

### 6.3 confirmed_succeeded

自动路径要求：

- Evidence 精确绑定 original Unknown Write。
- Observation = `observed_succeeded`。
- Provenance 为可信的 `controlled_runtime_read`。
- Historical Verifier Binding 有效。
- Availability = available。
- Integrity = matched。
- Authenticity = `system_verified`。
- Verification passed。

Manual path 不能伪装成上述 automatic path；它必须走独立授权、authoritative
manual evidence 与审计路径。

### 6.4 confirmed_not_executed

所有 `confirmed_not_executed` 均要求：

- 持久化 canonical `SourceContractV1` payload。
- `sourceContractDigest` 非空并进入 canonical decision payload /
  `operationPayloadDigest` / `requestKey`。
- Contract 明确声明当前版本具有 negative-proof 能力。
- Contract 包含 target resource identity、query scope、observation time
  window、coverage / completeness、negative observation semantics、
  provenance、verifier/manual attestation identity 与 result。
- 身份、时间窗口、范围、digest、Evidence Submission 与原 Unknown Write
  精确绑定。

Automatic system-verified Contract 要求：

- Observation = `observed_not_executed`。
- Provenance = `controlled_runtime_read`。
- Historical Verifier Binding 与 source contract 一致。
- Availability = available。
- Integrity = matched。
- Authenticity = `system_verified`。
- Verification passed。

Manual-attested Contract 要求：

- Provenance 不得伪装为 `controlled_runtime_read`。
- Authenticity = `manual_attested`，不得写成 `system_verified`。
- `source_type=manual_review`，actorId / actorType=human_reviewer 来自同一个
  authenticated Host identity。
- Contract 必须记录人工来源、观察时间、目标、查询范围、覆盖完整性、
  负向证明语义、人工责任人与 attestation digest。
- Verification = passed / inconclusive / not_run 的允许矩阵见 §6.5；
  Verification failed 不允许人工覆盖。
- Manual Contract 必须由有权限的 Manual Reviewer 授权并持久化；普通
  Agent / recovery caller 不得自行构造。

禁止推断：

- 资源不存在 -> 未执行。
- timeout -> 未执行。
- generic passed -> 未执行。
- 原 ToolRun unknown -> 未执行。

### 6.5 Manual

**[Final Architecture Decision]**

- Manual Reviewer 身份来自 Host Authorization。
- Manual Decision 必须绑定一个明确选择的 Evidence Submission。
- Evidence 必须与原 Unknown Write 精确绑定。
- Availability / Integrity 不得为 unavailable / mismatch。
- Manual Decision 不得把 Verification failed 改写为 passed。
- Manual Attestation 不能写成 Verifier passed。
- Binding mismatch 不允许人工绕过。
- Manual `confirmed_not_executed` 必须绑定持久化 manual-attested
  `SourceContractV1` 和 `sourceContractDigest`。
- Manual Contract 的 provenance 不得伪装为 `controlled_runtime_read`，
  authenticity 不得伪装为 `system_verified`。

Final Manual Matrix：

| Verification | Manual Decision |
|---|---|
| passed | 允许；仍需 Reviewer authorization 与 Evidence binding |
| failed | 禁止 final success / not-executed override，保持 unresolved / manual review |
| inconclusive | 允许有 authoritative evidence 的人工决定 |
| not_run | 允许有 authoritative evidence 的人工决定 |
| binding mismatch | 必须拒绝 |

Manual evidence 表达：

- 持久化于 `recovery_evidence_submissions`。
- `source_type=manual_review`。
- `actor_id` 必须来自认证 Host capability。
- `evidence_ref`、`payload_digest`、`envelope_digest` 不可为空。
- `sourceContractDigest` 不可为空并指向可加载、digest 匹配的
  canonical `SourceContractV1` payload。
- Payload 可加载且 Integrity 可重算。
- 不允许只靠未持久化 TypeScript 字段或 `redacted_summary`。

当前 Schema 已有上述字段，不需要仅为 manual evidence 增加列。

### 6.6 Manual / Automatic SourceContractV1 Matrix

**[最终建议]**

| 维度 | Automatic | Manual |
|---|---|---|
| Source | `system_verification` | `manual_review` |
| Actor | `host_verifier` | `human_reviewer` |
| Provenance | `controlled_runtime_read` | `declared_payload` / authoritative manual source；不得伪装 controlled |
| Authenticity | `system_verified` | `manual_attested` |
| Contract authority | `system_verified` | `manual_attested` |
| Verification | `passed` | passed / inconclusive / not_run 按 §6.5；failed 拒绝 |
| `sourceContractDigest` | required | required |
| Persisted Contract | canonical JSON + envelope digest | canonical JSON + envelope digest + manual responsibility |
| Binding mismatch | reject | reject |

共同字段：

```text
sourceContractSchemaVersion
sourceContractAuthority
taskId
reviewId
originalUnknownWriteToolRunId
targetResourceIdentity
queryScope
observationTimeWindow
coverageCompleteness
negativeObservationSemantics
provenance
actorId / verifierId
attestationOrVerificationId
result
payloadDigest
```

当前持久化模型可以保存 `manual_attested`、`manual_review`、时间、evidence
ref 和 digest，但尚无 `SourceContractV1` canonical schema / validator。
因此 Manual 与 Automatic negative decision 在 Validator 完成前都必须
fail closed；不得只放一个未持久化 TypeScript 字段。

## 7. Original Unknown Write Resolution

### 7.1 保留事实

Original ToolRun:

```text
status = unknown
```

Final Decision 不把 ToolRun 改为 succeeded / failed / cancelled。

### 7.2 推荐 Resolver

内部策略：

```text
resolveUnknownWriteSettlement(taskId, toolRunId)
```

返回：

```text
open_unknown
resolved_success
resolved_not_executed
state_inconsistent
```

判定：

| 状态 | 条件 |
|---|---|
| open_unknown | 无 Review；Review pending/unresolved |
| resolved_success | Review confirmed_succeeded + Operation/Event/Evidence 完整 |
| resolved_not_executed | Review confirmed_not_executed + Operation/Event/Evidence 完整 + downstream ToolRun/PlanStep 已原子 skipped |
| state_inconsistent | Review final 但 Operation/Event/ToolRun/Evidence 绑定不一致 |

Final Decision 可以在同一 transaction 内先完成 downstream ToolRun /
PlanStep skipped，再提交 `resolved_not_executed` 的最终可观察状态。
Barrier 读取时看到 skipped PlanStep 下仍有 nonterminal ToolRun，必须返回
`state_inconsistent`。

### 7.3 Final Decision Event

Final design：

```text
recovery.review.final_decision
```

Payload：

```text
operationId
reviewId
originalUnknownWriteToolRunId
decision
decisionVersion
evidenceSubmissionId
verificationCheckId
verificationId
sourceContractDigest
actorId
actorType
requestKey
fencingToken
```

历史 unknown Event 永久不变。

### 7.4 Terminal Guard integration

**[静态源码确认]**

当前 `src/storage/task-invariants.ts` 的
`assertTaskCanBecomeTerminal()` 使用 SQL 直接判断：

- Review 不存在。
- Review 为 pending / unresolved。
- confirmed_not_executed 但 PlanStep 未 failed。

它尚未验证：

- final Review 是否存在对应 confirm Operation。
- Operation 是否引用真实 applied Event。
- Event 是否为该 Review 的 final decision Event。
- Evidence / Verification 与 Review / original ToolRun 是否一致。

**[Final Architecture Decision]**

抽取统一：

```text
resolveUnknownWriteSettlement(taskId, toolRunId)
```

并由 Task Terminal Guard 使用。

Guard 必须区分：

- final Review 的裸状态。
- final Operation / Event / Evidence 的可信审计链。

如果 final status 存在但审计链不完整，必须返回
`state_inconsistent` / unresolved，而不是允许 terminal。

Final Decision UoW 不得在 Review final / Operation / Decision Event /
Evidence / Verification / downstream skipped 状态完成前调用 Terminal Guard。
SQLite 同一 immediate transaction 中的后续 SQL 能读取本事务尚未提交的
写入，因此 Guard 必须安排在这些记录全部可见之后、Task terminal CAS 之前。

不得在 Stage 3.3 Cancel UoW 内复制另一套弱化判断。

## 8. Task / Plan Terminal Convergence

### 8.1 PlanStep / Plan

Final matrix:

| Decision | ToolRun | PlanStep | Plan |
|---|---|---|---|
| confirmed_succeeded | unknown | completed | 全步骤 terminal 后 completed |
| confirmed_not_executed | unknown | failed | 下游步骤收敛后 failed |
| unresolved | unknown | waiting_review | active |

### 8.2 confirmed_not_executed Downstream Convergence

Scenario:

```text
W1 -> W2 -> W3
W1 confirmed_not_executed
W2 / W3 still queued
```

Final design:

- W1 PlanStep:
  - `waiting_review -> failed`
- 当前 Schema 没有显式 dependency edge；同一 Agent Plan 内以更大的
  `stepIndex` 表示后续线性步骤。无法从持久化事实证明某个后续步骤独立于
  W1 时，必须按下游依赖处理。
- W2 / W3 以及 W1 之后仍未执行的 queued PlanSteps：
  - 关联 queued ToolRun：`queued -> skipped`
  - `queued -> skipped`
  - 不新增 blocked 状态。
- 每个被上游失败的步骤追加 Event：

```text
reasonCode = UPSTREAM_WRITE_NOT_EXECUTED
upstreamToolRunId
upstreamReviewId
upstreamDecisionEventId
```

- ToolRun 与 PlanStep 的状态转换、Event、Checkpoint 必须在 Final
  Decision 同一 immediate transaction 内完成；详细规则见 §8.7。
- 不自动执行 W2 / W3。
- 不自动 Re-plan。
- W2 / W3 只有显式、独立授权的 Re-plan 才能重新成为可执行 Write。
- 已经 completed 的后续步骤不会被回滚；其存在本身触发
  `state_inconsistent`，因为上游 Write 尚未成功却已有后续步骤执行。
- 若 W2 / W3 或任一后续步骤已是 running，说明 Barrier earlier invariant
  已失效：
  - 不自动改写为 skipped。
  - 返回 `state_inconsistent` / manual review。

Plan：

- 当该 Plan 所有 PlanStep 已 terminal，且存在 failed step：
  - `active -> failed`。
- 若同一 Task 还有其他 Plan 的 active Review / Unknown：
  - 本 Plan 可以 failed。
  - Task 仍保持 `waiting_review`。

Task：

- 其他 Unknown Review 未完成：保持 waiting_review。
- 所有 Reviews final 且无 Cancel：failed。
- Cancel 存在：等待所有 Reviews final 后 cancelled。
- Pause 存在：不自动 Resume / Re-plan，Task 收敛等待 Pause Clear 后的
  Host 收敛。

### 8.3 Cancel / Pause impact

- confirmed_not_executed + Cancel：Decision 可审计提交，最终 cancelled。
- confirmed_not_executed + Pause：PlanStep/Plan 可收敛，Task 不自动推进；
  Pause Clear 后由 Host 决定 failed/cancelled。

### 8.4 Task Matrix

| 状态组合 | Task |
|---|---|
| 所有 Unknown resolved_success，所有步骤 completed/skipped | completed eligible |
| 任一 resolved_not_executed，无 Cancel | failed eligible |
| 任一 open_unknown | waiting_review |
| active Review | waiting_review，不允许 terminal |
| Cancel + 任一 open_unknown | waiting_review |
| Cancel + 所有 Unknown reviewed | cancelled |
| Pause Intent | 不自动 Resume / Re-plan / Dispatch |
| queued/running Read/Write 存在 | 不允许 terminal |
| 多个 Unknown 部分完成 | waiting_review |

### 8.5 waiting_review -> completed

**[静态源码确认]**

当前 `ExecutionStateMachine.TASK_TRANSITIONS`：

```text
waiting_review -> running | failed | cancelled
```

没有：

```text
waiting_review -> completed
```

**[Final Architecture Decision]**

不要修改通用状态表并允许任意调用方直接完成 Task。

在 `ExecutionStateMachine` 增加内部、受 capability 约束的方法：

```text
transitionTaskFinalConvergenceInCurrentTransaction({
  ownership,
  expectedTaskVersion,
  status: completed | failed | cancelled,
  capability
}, permit)
```

要求：

- 只能由 Final Decision UoW 的 module-private capability 调用。
- 复用 `assertTaskCanBecomeTerminal()` 等价不变量。
- 复用 TaskRepository version CAS。
- Event / Checkpoint 使用同一个 permit。
- 不修改 Stage 3.3 已封存调用路径。
- 普通 `transitionTask()` 仍不允许 `waiting_review -> completed`。
- Final Decision 的 `completed | failed | cancelled` Task convergence 均应
  通过同一专用内部 Transition 路径，不能只保护 `completed` 而让另外两个
  终态继续走宽松的通用入口。
- Task、ExecutionPlan、PlanStep、Review、Operation、Event、Checkpoint
  使用同一个 `StorageWritePermit` 和同一个 immediate transaction。
- Exact Replay 在 Task version / Review decisionVersion CAS 之前命中；
  Replay 不再次执行 convergence。
- Terminal Task 的响应丢失重放改走 §12 的 Host-authorized read-only path。

### 8.6 Final Convergence Preconditions

- expected Task version。
- current Lease / Fencing / Authority。
- 无 active Review。
- 当前 Write PlanStep 为 `waiting_review`。
- 允许 W1 之后待收敛的 downstream PlanStep 处于 `queued`，其关联
  ToolRun 处于 `queued`；这些状态必须在同一 Final Decision transaction
  内转换为 `skipped`。
- 不得存在 running / awaiting_approval / interrupted PlanStep 或 active
  ToolRun；存在时返回 `state_inconsistent`，不得直接跳过。
- 无 pending Approval。
- 所有 Unknown 已可信 resolved。
- 目标 status 符合 Cancel Priority。
- completed 时全 PlanStep completed/skipped。
- failed/cancelled 时 Plan/PlanStep terminal 状态符合矩阵。
- 提交 Plan / Task terminal transition 前，每个 skipped PlanStep 的关联
  ToolRun 必须已经 terminal 为 `skipped` 且存在对应事件；不得残留
  queued / awaiting_approval / running / interrupted ToolRun。
- Final Convergence UoW 必须记录所有被 skipped 的 ToolRun / PlanStep 的
  expected version，并在当前事务内重新 CAS。
- 任一 skipped PlanStep 下仍有 nonterminal ToolRun，返回
  `state_inconsistent`，不得直接完成 Plan / Task。

上述“无 active PlanStep / ToolRun”约束在 downstream skipped 收敛完成后、
提交 Plan / Task terminal transition 之前整体复核。

### 8.7 Skipped PlanStep / ToolRun Lifecycle

#### 实际状态审计

**[静态源码确认]**

1. 已知工具的计划在创建时会同时创建初始 `queued` ToolRun。
2. `TaskScheduler` 遇到 prior Write `unknown` 时，会通过 `fillUnstarted()`
   为后续 Tool Call 生成内存中的 `skipped` Result。
3. `fillUnstarted()` 不调用 Persistence；当前 W2 / W3 ToolRun 仍保持
   `queued`，对应 PlanStep 也尚未由这条路径持久化为 `skipped`。
4. `TaskScheduler` 当前按本次 `schedulePlan` / ToolCall 列表执行，不通过
   SQL 查询“所有 queued ToolRun”来恢复执行。
5. `TaskLeaseManager` 与 Persistent Recovery Gate 会因 queued / unknown
   ToolRun 拒绝普通重跑或重新 Claim，因此不能依赖“Scheduler 不会再选择”来
   证明安全。
6. `Task Terminal Guard` 将 `queued` ToolRun 计为 active
   （`TASK_ACTIVE_TOOL_RUN`），所以仅把 PlanStep 改为 skipped 仍无法使
   Task 进入 failed / cancelled。
7. 当前 `beginOwnedToolRun()` 检查 Task running、ToolRun queued 和 version，
   但没有拒绝 `PlanStep=skipped`；它只在 PlanStep 仍为 queued 时推进
   PlanStep。因此 `skipped PlanStep + queued ToolRun` 仍是可启动的非法组合。
8. Migration v2 的 `tool_runs_block_completed_step_*` 只保护 completed
   PlanStep，没有保护 skipped PlanStep。
9. State Matrix 已允许 Read / Write ToolRun 的
   `queued -> skipped`，无需新增 ToolRun status。
10. 现有 `finalizeOwnedToolRunBeforeStart()` 已证明
    `queued|awaiting_approval -> skipped`、PlanStep skipped、`tool.skipped`
    Event 和 Checkpoint 的单项处理方式；但该方法每次调用自行开启事务，
    不能用于 Final Decision 中多记录原子收敛。

结论：不能保留 W2 / W3 的 queued ToolRun。必须使用已有 `skipped`
ToolRun 终态，并在同一个 Final Decision / Final Convergence transaction
内同步收敛。

#### PlanStep / ToolRun Cardinality

**[静态源码确认]**

- 实际关系是 PlanStep `1:N` ToolRun，而不是 schema 外键隐含的一对一。
- `TaskPlanner` 将连续 Read 合并为单个 `read_batch` PlanStep；一个
  `read_batch` 可包含多条 ToolRun。
- 当前 `TaskPlanner` 为每个 Write 创建独立 `write` PlanStep，因此正常
  Agent Plan 的 Write PlanStep 应恰好关联一条 ToolRun；但 SQL Schema
  没有 `UNIQUE(plan_step_id)`，不能把该业务不变量写成数据库事实。
- `unknown_tool` PlanStep 可关联零条 ToolRun。
- `ToolRunRepository.listByPlanStep()` 返回全部关联行；
  `UNIQUE(plan_step_id, original_index)` 只约束每个业务位置一行，不限制
  PlanStep 总行数。
- 历史测试中存在一个 `read_batch` PlanStep 对应两条 succeeded ToolRun 的
  场景；该结论来自阅读测试源码，本轮未重新执行测试。

**[最终建议]**

Final Convergence 必须按 PlanStep 批量加载全部 ToolRun：

1. 先读取同一 PlanStep 下全部 ToolRun，并验证 Task / Plan / PlanStep
   身份。
2. Write PlanStep 关联数量不等于 1 -> `state_inconsistent`。
   Original W1 的该唯一 ToolRun 必须是 `unknown`。
3. Read Batch 允许 1:N；unknown_tool 允许 0。
4. 任一关联 ToolRun 不是 expected `queued`，或版本不一致，或存在 pending
   Approval -> 整个 transaction fail closed。
5. 全部关联 ToolRun 验证通过后，逐条执行 ToolRun `queued -> skipped`，
   每条写一个独立 `tool.skipped` Event。
6. 所有 ToolRun transition 成功后，执行唯一一次 PlanStep CAS
   `queued -> skipped`，只写一个 `plan_step.skipped` Event。
7. 不允许先更新 PlanStep 再逐个尝试 ToolRun；也不允许部分 ToolRun 更新后
   提交。

后续 implementation tests 必须显式保护：

- read_batch 1:N 批量 skipped。
- write PlanStep 的 1:1 业务不变量。
- unknown_tool 0 ToolRun。
- 任一 ToolRun state / version / Approval 异常导致整体 rollback。

#### 完整状态矩阵

**[最终建议]**

| 实体 | W1 | W2 | W3 |
|---|---|---|---|
| Original ToolRun | `unknown` | `queued -> skipped` | `queued -> skipped` |
| PlanStep | `waiting_review -> failed` | `queued -> skipped` | `queued -> skipped` |
| ExecutionPlan | `active -> failed` | same | same |
| Task | 依据全局 Review / Intent 收敛 | same | same |

Task：

- 仍有其他 open Unknown / active Review：`waiting_review`。
- 所有 Review final、无 Cancel、存在 not-executed failure：
  `waiting_review -> failed`。
- Cancel 存在且全部 Review final：`waiting_review -> cancelled`。
- Pause Intent 存在：允许 audit-only Decision，但不自动 Resume / Re-plan /
  Dispatch；Task 等待 Host 显式收敛。

#### Final Decision 内的最小收敛集合

**[最终建议]**

对每个依赖 W1 且尚未执行的 queued PlanStep：

1. 通过 State Matrix 验证 PlanStep `queued -> skipped`。
2. 对每个关联且仍为 `queued` 的 ToolRun 验证
   `queued -> skipped`。
3. ToolRun CAS 成功后才推进 PlanStep CAS；所有记录和 Event / Checkpoint
   使用同一个 `StorageWritePermit` 与同一个 immediate transaction。
4. 为每个实际 ToolRun transition 追加恰好一个 `tool.skipped` Event。
5. 为每个实际 PlanStep transition 追加恰好一个
   `plan_step.skipped` Event。
6. 每个 Event payload 至少绑定：

```text
reasonCode = UPSTREAM_WRITE_NOT_EXECUTED
operationId
taskId
planId
planStepId
toolRunId
upstreamToolRunId
upstreamReviewId
upstreamDecisionEventId
requestKey
fencingToken
```

`upstreamDecisionEventId` 必须等于 Final Decision Event 的真实 ID，并与
`recovery_review_operations.applied_event_id` 完全一致。downstream Event
只能在 Final Decision Event 追加后写入。
`(operationId, toolRunId)` 用于识别该 ToolRun 的唯一 skip Event；
`(operationId, planStepId)` 用于识别该 PlanStep 的唯一 skip Event。

7. 在该 Final Decision UoW 最后一次状态写入后追加一个最终 Checkpoint；
   Exact Replay 命中 `requestKey` 时不重复 Event / Checkpoint。
8. ToolRun `finished_at` / `updated_at`、安全 `error.code =
   UPSTREAM_WRITE_NOT_EXECUTED` 与 PlanStep `updated_at` 必须设置，以证明
   该工具调用未进入执行而是被本地下游收敛跳过。

Fail-closed 条件：

- ToolRun 已 running / succeeded / unknown / interrupted / failed /
  timed_out / cancelled，但 PlanStep 仍 queued。
- PlanStep 已 skipped，但关联 ToolRun 仍 queued / awaiting_approval /
  running / interrupted。
- 存在 pending Approval。
- PlanStep version / ToolRun version 与事务外 Snapshot 不一致。
- 同一 ToolRun 已有不一致的 skipped Event 或 reasonCode。

这些情形返回 `state_inconsistent`，不得强制改写为 skipped。

### 8.8 Failed Task / Explicit Re-plan Boundary

#### 当前源码事实

**[静态源码确认]**

- `TaskLeaseManager.claimWithClaimEvent()` 对 completed / failed / cancelled
  Task 抛出 `TASK_LEASE_TASK_TERMINAL`。
- `tasks` 表没有 `source_task_id`、`parent_task_id`、
  `source_review_id`、`source_tool_run_id` 或 Re-plan 字段。
- `CreateTaskInputSchema` 只接受新 Task 的 objective / prompt / limits，
  不接受来源 Task / Review / Unknown Write 绑定。
- `recovery_review_operations.operation` 的现有 SQL CHECK 不包含
  `replan`；`request_key` 唯一只能约束现有 Operation 类型。
- `ExecutionPlanRepository.nextVersion(taskId)` 按单个 Task 计算 Plan
  generation；新 Task 会拥有独立的 Plan generation 与 Task Lease。
- Events 的 payload 是 JSON，可记录跨 Task 引用，但 `events.task_id`
  只指向 Event 所属 Task；payload 内的来源 ID 没有 Foreign Key、
  cross-task uniqueness 或事务级身份约束。

#### 方案比较

**[最终建议]**

| 方案 | 当前 Schema 可表达性 | 结论 |
|---|---|---|
| A. 新 Task Re-plan | 新 Task / new Plan / new Lease 可复用现有模型；来源关系可用 Event payload 记录，但强引用与幂等仍需持久 Replan Operation / lineage | 推荐 |
| B. 同一 Task 受控 Re-plan | 需打破 terminal Task 不可重新 Claim 的约束，并定义 reopen authority、Re-plan Operation、Plan generation 与 Terminal Guard 例外 | 不推荐 |

Option A 推荐规则：

1. 原 Task 永久保持 failed terminal，不重新激活。
2. 新 Task 使用新的 Task ID、trace、ExecutionPlan、ToolRun 与 Task Lease。
3. 原 ExecutionPlan / PlanStep / ToolRun / Final Decision Event 永远不修改。
4. 原始 Unknown Write ToolRun 永久保持 `unknown`。
5. 新 Task 的创建 Event 必须持久化来源关系：

```text
sourceTaskId
sourceExecutionPlanId
sourcePlanStepId
originalUnknownWriteToolRunId
sourceRecoveryReviewId
sourceFinalDecisionOperationId
sourceFinalDecisionEventId
replanReason
actorId
actorType
authorizationNonce
```

6. Host 必须使用独立的 Re-plan authorization；Final Decision
   Authorization、Recovery Preflight Capability 与 Pause / Cancel
   Capability 均不得转换为 Re-plan authority。
7. 原 Task 已有 Cancel / Pause Intent 时不得创建 Re-plan Task；Cancel
   优先，Pause 必须先由 Host 显式清除。
8. 新 Task 的创建、来源 Event、初始 Plan / Queue 初始化应使用独立
   Re-plan UoW。

#### Schema / Migration 边界

**[已批准原则]**

- Re-plan 不属于 Step 6.3.5，本轮不得实现。
- Step 6.3.5 只能把 Task 收敛到 terminal failed / cancelled；不得隐式
  Re-plan。

**[最终建议]**

- Option A 在**概念上**符合现有 Task terminal / Lease / Plan ownership
  模型。
- 当前 Migration v9 没有一等 Re-plan Operation、source lineage FK 或
  unique request identity；仅靠 Event JSON 无法提供生产级幂等与引用完整性。
- 因此 Option A 的完整实现需要独立 Re-plan migration / persistence
  方案，至少提供：

```text
recoveryReplanOperationId
requestKey UNIQUE
sourceTaskId
sourceReviewId
originalUnknownWriteToolRunId
sourceFinalDecisionEventId
newTaskId
authorization actor / nonce
status / result
```

- 在该 migration 与独立架构批准之前，failed Task 之后不得创建 Re-plan
  Task；保持显式不可用，不以应用内存字段模拟。
- Option B 需要重新打开 terminal Task，和现有 Lease / Terminal Guard
  原则冲突；即使新增字段也仍需独立 reopen authorization、Plan generation
  和 Migration，不采用。

### 8.9 Final State Matrix

**[最终建议]**

#### confirmed_not_executed

| 实体 | W1 | W2 | W3 |
|---|---|---|---|
| Original ToolRun | `unknown` | `skipped` | `skipped` |
| PlanStep | `failed` | `skipped` | `skipped` |
| ExecutionPlan | `failed` | same | same |
| Task | 全局收敛为 waiting_review / failed / cancelled | same | same |

前置要求：

- W2 / W3 ToolRun 必须从 queued 实际转换到 skipped。
- 不允许 PlanStep skipped 与 ToolRun queued 并存。
- 不允许 Original Unknown Write 被修改。
- 不允许 Re-plan 隐式启动。

#### confirmed_succeeded

| 实体 | Original Write | 其他步骤 | ExecutionPlan | Task |
|---|---|---|---|---|
| 状态 | `unknown` | 按既有执行结果 completed / skipped | 全部 terminal 后 completed | 受保护 Final Convergence 后 completed |

Cancel 存在时以 Cancel Priority 收敛为 cancelled；Pause 存在时不自动推进
Resume / Replan。

## 9. Multi-Write Barrier

### 9.1 顺序语义

**[静态源码确认]**

以下字段不能承担跨 Write 的业务顺序：

- `execution_plans.version`：Plan generation identity。
- `tool_runs.attempt_no`：执行 Attempt revision。
- `tool_runs.id` / timestamp：不保证与模型原始 Write 顺序一致。

当前 `tool_runs` 约束为：

```text
UNIQUE (plan_step_id, original_index)
UNIQUE (task_id, call_id)
```

因此当前 Schema 中一个 `(planStepId, originalIndex)` 只能有一条 ToolRun。
`attempt_no` 不能用于创建同一业务位置的多条 ToolRun 并据此排序。未来若引入
多 ToolRun Attempt，也必须先按逻辑 Write 聚合，不能直接按 `attempt_no`
比较不同 Write。

### 9.2 Current Active Agent Plan

只考虑 `purpose=agent`：

1. 恰好一个 `status=active` Plan 才允许新的普通 Write admission。
2. 零个 active Plan -> `barrier_blocked` / `no_active_plan`。
3. 多个 active Agent Plan -> `state_inconsistent`。
4. 历史 Agent Plan 中仍存在 open Unknown -> 全局 `barrier_blocked`。
5. Recovery Evidence Plan 不参与普通 Write 排序，但不得被此 UoW 修改。

### 9.3 Logical Write Identity

逻辑 Write identity 使用持久化业务键：

```text
taskId
  + planId
  + planStepId
  + originalIndex
  + toolName
  + toolVersion
  + inputSchemaHash
  + canonicalInputHash
```

规则：

- `toolCallId` 是调用关联与审计字段，不是逻辑 Write 身份的唯一来源。
- `tool_runs.idempotency_key` 的计算包含 Plan version / originalIndex /
  tool identity / input digest，只保证当前 Plan generation 内的 Write
  唯一性，不能直接跨 Plan generation 充当业务身份。
- 同一逻辑位置出现不同 `toolCallId`、tool identity 或 input digest 时，
  不得合并为同一 Write，也不得猜测哪一个正确；返回
  `state_inconsistent`。
- 对 Write 逻辑位置，一条 ToolRun Row 表示一个逻辑 Write；Read Batch
  PlanStep 可以合法关联多条 Read ToolRun。若未来允许同一逻辑 Write 的
  多个 ToolRun Attempt，只有上述身份完全一致的行才可以聚合；
  `attempt_no` 只表示 Attempt revision。
- 已被标记为 Unknown 的逻辑 Write 永远不能被普通 admission 再次执行。
  新 Attempt 只能来自独立 Recovery / Re-plan 流程，且不属于普通 Barrier
  admission。

### 9.4 Deterministic Ordering

当前 Agent Plan 内 Write 的确定顺序为：

```text
PlanStep.stepIndex ASC
  -> ToolRun.originalIndex ASC
```

要求：

- 同一 Plan 内 `stepIndex` 必须唯一，同一 PlanStep 内 `originalIndex`
  必须唯一。
- 两个不同逻辑 Write 占用同一顺序位置，或相同身份映射到不同顺序位置时，
  返回 `state_inconsistent`。
- 禁止使用随机 ID、`toolCallId` 字典序、`attempt_no` 或 timestamp 作为
  顺序 tie-breaker。
- `execution_plans.version` 只用于识别 Plan generation，不参与 Plan 内排序。
- 无法证明业务顺序时必须 fail closed。

Re-plan replacement boundary：

- 不自动创建新 Plan，也不得通过修改旧 Plan 绕过 `resolved_not_executed`。
- 显式 Re-plan 只有在旧 Plan 已 terminal、所有 PlanStep terminal、所有
  Original Unknown Write 已可信 resolved 后才可建立新 Plan generation。
- 新 Plan 必须使用新的 `planId`；旧 Plan 不得重新变为 active。
- 当前 Schema 没有独立 Re-plan lineage 表。Step 6.3.5 只规定 barrier
  replacement 前置条件，不实现 Re-plan 流程；在 Re-plan contract 完成前，
  下游 Write 保持 blocked。

### 9.5 Barrier Classification

```text
open_unknown
resolved_success
resolved_not_executed
```

#### open_unknown

必须同时满足审计事实不足或不完整，例如：

- Original Write ToolRun 仍为 `unknown`。
- RecoveryReview 未 final。
- final Review 缺少匹配 Operation / Event / Evidence 审计链。
- Review final 状态与 PlanStep 状态冲突。

行为：

- 阻止原逻辑 Write 自动重试。
- 阻止所有后续依赖 Write。
- 允许 RecoveryReview / Evidence audit 路径继续。

#### resolved_success

仅当以下全部成立：

- Review = `confirmed_succeeded`。
- Operation / Event / Evidence / digest / actor claims 完整匹配。
- PlanStep = `completed`。
- Original ToolRun 保持 `unknown`。

行为：Barrier 可以越过该逻辑 Write，但后续 Write 仍须经过普通状态、
Approval、Task 与 Intent 检查。

#### resolved_not_executed

仅当以下全部成立：

- Review = `confirmed_not_executed`。
- Operation / Event / Evidence / source-contract binding 完整匹配。
- PlanStep = `failed`。
- Original ToolRun 保持 `unknown`。
- 所有依赖该失败 Write 的 skipped PlanStep 均已完成
  `queued -> skipped`，且其关联 ToolRun 也已 terminal 为 `skipped`。

行为：

- 禁止执行任何依赖该 Write 的后续 Write。
- 不自动 Re-plan。
- 只有独立授权的 Re-plan 可以建立新的合法执行路径。
- 旧 Plan active、仍有非 terminal PlanStep、仍有 open Unknown 或缺少
  Re-plan 授权时，新 Plan admission fail closed。
- 若存在 `PlanStep=skipped` 且关联 ToolRun 仍 queued / awaiting_approval /
  running / interrupted，返回 `state_inconsistent`，不得越过该位置。

未经可信 Resolution 证明的 `failed` / `skipped` / `cancelled` 不得被当作
`resolved_not_executed`；此类状态继续 fail closed，等待审计或人工处理。

### 9.6 Algorithm

```text
beginOwnedToolRunAfterWriteBarrier(targetToolRunId):
  BEGIN IMMEDIATE
  one StorageWritePermit
  assert current Lease / Fencing / ExecutionAuthority
  load target ToolRun and owning Task
  load target PlanStep

  if target.status != queued:
    return tool_run_state_conflict
  if target.PlanStep.status not in (queued, running):
    return state_inconsistent / skipped_step_cannot_execute
  if target.PlanStep / ExecutionPlan / Task identity mismatch:
    return state_inconsistent
  if target / PlanStep expected version mismatch:
    return version_conflict

  if target.mode == read:
    begin read ToolRun in this transaction
    transition PlanStep queued -> running when applicable
    append tool.intent_committed Event
    append Checkpoint
    COMMIT
    return admitted

  # Only here does the write-only Multi-Write Barrier run.

  plans = all purpose=agent Plans for target.taskId
  activePlans = plans where status == active
  if activePlans.size != 1:
    return barrier_blocked or state_inconsistent

  currentPlan = activePlans.single
  if target does not belong to currentPlan:
    return state_inconsistent

  targetKey = logicalWriteIdentity(target)
  if any historical/current logical Write has targetKey and is
     open_unknown or terminal-unknown:
    return barrier_blocked / unknown_write_reuse_forbidden

  if any historical purpose=agent Plan has unresolved Unknown:
    return barrier_blocked / historical_unknown

  groups = group currentPlan ToolRuns where mode == write
           by logicalWriteIdentity
  if ordering or identity is ambiguous:
    return state_inconsistent

  targetOrder = (target.stepIndex, target.originalIndex)
  if any group after targetOrder already left queued:
    return state_inconsistent / premature_later_write

  for each group in deterministic order before targetOrder:
    switch classification(group):
      open_unknown:
        return barrier_blocked / earliest_open_unknown
      resolved_not_executed:
        return barrier_blocked / earliest_not_executed_predecessor
      resolved_success:
        continue
      nonterminal:
        return barrier_blocked / earlier_nonterminal_write

  transition target queued -> running
  transition current PlanStep queued -> running when applicable
  append tool.intent_committed Event
  append Checkpoint
  COMMIT
```

明确约束：

- 即使 target 是 earliest `open_unknown`，普通 admission 也不得执行它；
  target 只能进入 Review / Recovery audit。
- historical Plan 中任一无审计链的 Unknown 都是全局 blocker。
- target 不得属于已存在 Unknown 的逻辑 Write。
- `PlanStep=skipped` 下的任何 ToolRun 都不得进入普通 admission；只有
  Final Convergence UoW 可以把 queued ToolRun 收敛为 skipped。
- target 仍 queued 时，任何更晚的逻辑 Write 已经 running / terminal，说明历史
  admission 已破坏顺序不变量；返回 `state_inconsistent`，不得继续执行。
- 所有状态读取、分类和写入必须在同一个 immediate transaction 内。
- 不满足分类或关系时返回状态冲突，不写成功 Event / Checkpoint。

### 9.7 Read Boundary

- Barrier 只适用于 `mode=write`。
- Read 与 Write 在 mode 分流前都必须通过同一组通用 admission 校验：
  Task running、Lease / Fencing / Authority、ToolRun queued、PlanStep
  queued / running、Task / Plan / PlanStep / ToolRun 身份一致、version
  一致。
- `PlanStep=skipped` 或任何 terminal PlanStep 下，Read / Write ToolRun
  均不得普通 admission。
- Read 通过通用校验后，跳过 Write Barrier 的跨 Write 业务排序，但仍执行
  Read 自身的 Approval、Timeout、Persist Result 与状态转换规则。
- Read 不因 Multi-Write Barrier 本身被拒绝。
- 当前通用 `beginOwnedToolRun()` 要求 Task running；普通 Agent Read 在
  `waiting_review` 下不得通过该入口。Recovery Evidence Read 使用独立
  reservation / dispatch UoW，不借用普通 Agent admission。

### 9.8 Actual Enforcement Path

**[静态源码确认]**

受持久化调度的普通 Write 路径：

```text
WriteExecutor.execute()
  -> context.persistence.beforeExecute()
  -> ExecutionBridge.beginOwnedToolRun()
  -> ToolRegistry.executeValidated()
```

当前 `ExecutionBridge.beforeExecute()` 调用的 `beginOwnedToolRun()` 会自行
开启 immediate transaction。不能把 Barrier check 放在该 transaction 外。

Final design：

```text
ExecutionBridge.beforeExecute()
  -> ExecutionUnitOfWork.beginOwnedToolRunAfterWriteBarrier()
       -> BEGIN IMMEDIATE
       -> StorageWritePermit
       -> Lease / Fencing / Authority
       -> load Task / ToolRun / PlanStep
       -> generic status / identity / version validation
       -> mode == read:
            -> begin Read without Write Barrier
       -> mode == write:
            -> Barrier Policy
            -> begin Write
       -> ToolRun / PlanStep / Event / Checkpoint
       -> COMMIT
  -> no await
  -> ExecutionAuthority assert-active gate
  -> ToolRegistry.executeValidated()
```

要求：

- Barrier Policy 与 ToolRun begin 原子提交。
- 外部副作用只能在 admission COMMIT 成功后开始。
- Barrier check 不调用 Registry、Host callback、Provider 或网络。
- 目标 ToolRun version 与 Task version 在同一事务内重新验证。
- 目标 PlanStep 必须仍处于 queued / running；`skipped` / terminal
  PlanStep 下的 ToolRun 一律拒绝普通 admission。
- 组合 UoW 先执行统一通用 admission，再按 mode 分流。只有 Write 进入
  Multi-Write Barrier；Read 不能绕过 skipped / terminal PlanStep 校验。

**[静态源码确认：必须封闭的旁路]**

`AgentRunner.runLoop()` 在 `scheduler !== undefined` 时走
`TaskScheduler -> WriteExecutor / ReadWorkerPool`。但如果
`persistence !== undefined` 且 `scheduler === undefined`，当前代码会直接：

```text
AgentRunner.executeToolCall()
  -> ToolRegistry.execute()
```

该路径不经过 `ExecutionBridge.beforeExecute()`，因此可以绕过 Barrier。
最小设计修复：

1. `persistence !== undefined` 时，`AgentRunner` 必须要求 scheduler；缺失时
   构造或运行 fail closed。
2. 持久化 Task 的所有 Tool Call 必须统一走
   `TaskScheduler -> ExecutionBridge`。
3. direct `registry.execute()` 仅允许无持久化、无 durable Task 的 Read-only
   局部执行；不得执行 Write，也不得作为 WriteExecutor / Evidence Read 或
   业务服务入口。
4. Composition Root 不应向普通 Recovery / Agent business services 暴露
   raw `ToolRegistry.execute()` capability。

静态搜索当前生产代码的结果：

- `executeValidated()` 调用点只有 `WriteExecutor` 与 `ReadWorkerPool`。
- direct `registry.execute()` 的当前生产调用点是 `AgentRunner` fallback。
- `AgentRunner` 的该 fallback 不在 `TaskScheduler` 路径内。

因此若不封闭该 fallback，不能宣称 Multi-Write Barrier 覆盖所有普通 Write。

### 9.9 Concurrency

- Barrier + ToolRun begin 必须同一 immediate transaction。
- Task Lease / Fencing / ExecutionAuthority 在事务内重新验证。
- 两个 Owner 并发 admission 时由 SQLite immediate transaction 串行化。
- 第二个 Owner 必须在取得写锁后重新读取最新 Unknown / Review / PlanStep
  状态，不能复用 transaction 外 Snapshot。
- 旧 Owner 即使持有过期 Barrier decision，也不得在 COMMIT 时通过 Fencing。

### 9.10 Barrier Schema

初始 Barrier 可完全从现有表推导：

- `execution_plans`
- `plan_steps`
- `tool_runs`
- `recovery_reviews`
- `recovery_review_operations`
- final decision `events`
- persisted Evidence / Verification

不需要专用 Barrier 表，也不需要 Migration v10。若未来需要持久 Barrier
Generation、跨进程 Barrier Job 或性能缓存，应单独设计并评审 Migration。

## 10. Cancel / Pause Interaction

固定：

```text
Cancel > Pause > Normal Operation
```

### Cancel

- Final Decision 是 audit-only，Cancel 已提交时仍允许有权限的 decision。
- Final Decision 不得把 Task 设为 completed。
- All required Reviews final 后才能 cancelled。
- Final Decision 不删除 / 修改 Cancel Event。

### Pause

**[Final Architecture Decision]**

- 允许 audit-only Final Decision。
- 不允许 Resume / Dispatch / Re-plan。
- Pause Clear 后 Host 仍需显式触发后续收敛 / Resume。
- Final Decision 不修改 Pause Event。

### Race

**[最终建议]**

采用 **First Terminal Commit Wins**：

- Immediate transaction 按提交顺序串行化。
- Cancel 在 Final Decision 的 Task terminal convergence 之前已经持久化：
  Cancel Priority 生效，Decision 仍可 audit-only 记录，但 Task target 为
  cancelled。
- Final Decision 与 Task terminal convergence 不在同一事务完成（例如仍有
  其他 Review）：Decision 先提交后，随后提交的 Cancel 仍可生效，最终 Task
  收敛为 cancelled。
- Final Decision 与 Task terminal convergence 在同一事务成功提交：此后
  Task 已是 terminal，新的 Cancel / Pause / Decision 写操作必须拒绝，且
  不得重新打开或覆盖 terminal Task。
- 已 terminal Task 只允许 Host-authorized read-only Replay。
- `Cancel > Pause > Normal Operation` 只在 UoW 执行最终收敛时，对当时已经
  持久化的 Intent 生效；它不是对已 terminal 状态的事后改写授权。

| 已提交顺序 | 结果 |
|---|---|
| Cancel -> Decision transaction | Audit decision；Task cancelled |
| Decision only（Task 未 terminal） -> Cancel | Decision retained；后续 Task cancelled |
| Decision + Task terminal 同一事务 | Decision/terminal commit；后续 Cancel 拒绝 |
| Task already terminal -> Cancel | `TASK_TERMINAL` / conflict；不写 Intent |

## 11. Manual / Automatic Authorization

### 11.1 当前能力

**[已实现]**

`RecoveryEvidenceHostControlAuthorization` 仅覆盖：

```text
cancel_set
pause_set
pause_clear
```

不是 Final Decision capability。

### 11.2 推荐 capability

**[最终建议]**

```text
RecoveryReviewFinalDecisionAuthorization

claims:
  access = final_decision
  taskId
  reviewId
  originalUnknownWriteToolRunId
  operation = confirm_succeeded | confirm_not_executed
  expectedDecisionVersion
  operationPayloadDigest
  sourceContractDigest | null
  requestKey
  actorId
  actorType = human_reviewer | host_verifier
  requestNonce
```

签发：

- Host Auth / Review Control adapter only。
- Manual issuer 只能签发 actorType=human_reviewer。
- Host Verifier issuer 只能签发 actorType=host_verifier。
- 普通调用方不能选择 actorType，也不能把 Manual Authorization 当作
  Verifier Authorization。
- Issuer 与 Service 必须复用同一 canonical payload / digest / requestKey
  pure function；issuer 不能接受调用方预计算的 digest 作为权威输入。
- 不在 recovery public barrel 暴露 issuer。
- LLM Tool Call / 普通 HTTP body / 普通 Agent 参数不能签发。
- 不持久化 capability 本身。

Service 校验：

1. 使用 authenticated actorId / actorType 与请求业务字段自行构造 canonical
   decision payload。
2. 自行计算 `operationPayloadDigest` 和 `requestKey`；忽略调用方提供的
   digest / requestKey 作为权威值。
3. exact 比较 capability claims 中的 taskId、reviewId、Unknown Write、
   operation、expectedDecisionVersion、digest、sourceContractDigest、
   requestKey、actorId、actorType。
4. `requestNonce` 只用于 Authorization 防重放，不能替代完整请求身份。
5. 任一 claim 与重新计算结果不同，返回 authorization claim conflict。

`requestNonce` 不进入历史 event/operation 身份；Replay Authorization 可以
使用新的 nonce，但必须绑定相同 taskId / reviewId / operation /
expectedDecisionVersion / payload digest / requestKey / actor claims。

### 11.3 Manual

- actorType=human_reviewer。
- actorId 来自认证身份。
- evidence source 必须是 authoritative manual evidence。
- Manual `confirmed_not_executed` 必须绑定 `manual_attested`
  `SourceContractV1`，其 provenance 不得写成 `controlled_runtime_read`，
  authenticity 不得写成 `system_verified`。
- passed：允许在 Host Reviewer authorization 与 Evidence binding 通过后
  final。
- failed：禁止人工覆盖为 `confirmed_succeeded` 或
  `confirmed_not_executed`。
- inconclusive / not_run：允许在 authoritative manual evidence、可用
  payload、integrity match、真实 source timestamp 与明确人工责任归属下
  final。
- binding mismatch：拒绝。

Manual eligibility matrix：

| Verification | `confirmed_succeeded` | `confirmed_not_executed` |
|---|---|---|
| passed | 允许，需 manual authorization + binding | 允许，需 authoritative negative evidence |
| failed | 拒绝 | 拒绝 |
| inconclusive | 仅 authoritative evidence 允许 | 仅 authoritative evidence 允许 |
| not_run | 仅 authoritative evidence 允许 | 仅 authoritative evidence 允许 |
| binding mismatch | 拒绝 | 拒绝 |

Manual evidence 必须能由现有持久化模型验证：

- `source_type=manual_review`。
- `actor_id` 与 Host Authorization `actorId` 一致。
- evidence submission / review / original ToolRun 身份一致。
- payload / envelope digest 与持久化内容一致。
- `authenticity_status=manual_attested` 只能由认证 Human Reviewer
  capability 产生。
- `source_observed_at`、evidence ref、payload digest 不得由普通调用方任意
  覆盖。

当前 Schema 能表达 `manual_attested`、actor、observed time、evidence ref
和 digest；不能把“人工声明”自动升级为 `system_verified`。

### 11.4 Automatic

- actorType=host_verifier。
- historical Verifier Binding 必须完整。
- 只有 passed + matching observation/provenance 才允许自动 decision。

Preflight Capability 不能转换为 Final Decision Authorization。

Automatic `confirmed_succeeded` 必须同时满足：

- Evidence 精确绑定 Original Unknown Write。
- `outcome=observed_succeeded`。
- `readback_result_provenance=controlled_runtime_read`。
- availability / integrity / authenticity 满足当前 Verification Contract。
- Historical Verifier Binding 完整且 digest 匹配。
- `verification_status=passed`。
- Verification passed 与 evidence / review / request / attempt 身份一致。

Automatic `confirmed_not_executed` 不得只依赖
`verification_status=passed`。必须存在版本化 `SourceContractV1`，其规范
payload 至少绑定：

```text
targetResourceIdentity
queryScope
observationTimeWindow
coverage / completeness
negativeObservationSemantics
provenance
verifierBinding
verificationResult
```

Disallowed evidence：

- 资源 404 / 不存在但没有 query scope 与 coverage 证明。
- timeout。
- generic verifier passed。
- ToolRun 自身为 `unknown`。
- unverified / declared payload。
- binding mismatch、integrity mismatch、unavailable / expired / replaced。

`SourceContractV1` 应进入 canonical evidence payload，并通过现有
evidence envelope / payload digest 持久绑定。Final Decision 只读取已持久化
payload 与 Verification，不在事务中调用外部服务。当前代码尚无
`SourceContractV1` 结构与 Validator；在实现该 Contract 前，automatic
negative decision 必须 fail closed。

Manual `confirmed_not_executed` 使用同一 Schema 的
`sourceContractAuthority=manual_attested` variant；Manual Contract 缺失、
digest 不匹配、责任人或观察时间缺失时也必须 fail closed。当前代码同样
尚无 Manual Contract Validator。

如果最终要求 query scope / coverage / negative semantics 可独立 SQL 查询，
而不是作为 digest-bound JSON payload 读取，则需要单独评估 Schema 增量；
核心 Final Decision 本身不因此自动要求 Migration v10。

### 11.5 Authorization / Replay Identity

- `actorId` 与 `actorType` 必须同时来自同一个 authenticated Host
  Authorization。
- `actorType` 必须进入 canonical decision payload，进而进入
  `operationPayloadDigest`。
- `computeRecoveryReviewOperationRequestKey()` 继续以 reviewId、
  expectedDecisionVersion、operation、payload digest、actorId 计算
  `requestKey`；由于 payload digest 已绑定 actorType，同一 actorId 以不同
  actorType 调用会得到不同 requestKey。
- Final Decision Event payload 必须持久化 `actorType`。
- Exact Replay 必须比较 Authorization claims、Operation
  `actorId`/digest、Event `actorId`/`actorType`、reviewId、requestKey 与
  applied event identity。
- actorType 不一致时返回 operation identity conflict，不得返回历史成功。
- Terminal read-only Replay 同样从 Final Decision Event 读取并验证历史
  `actorType`。

### 11.6 actorType 持久化

Current Schema:

- `recovery_review_operations` 有 `actor_id`，没有独立 `actor_type` 列。
- Events payload 是 JSON。

Final design:

- `actorType` 进入 `decisionPayloadDigest`。
- Final Decision Event payload 明确持久化 `actorType`。
- `requestKey` 由 actorId + payload digest 共同绑定 actorType。
- Exact Replay 必须同时比较 Operation、Event、Authorization claims。
- Terminal read-only Replay 也必须校验 Event actorType。

不新增 `actor_type` 列：

- Event payload 提供持久化事实。
- Operation payload digest 绑定 Event 语义。
- 该设计避免为单一冗余字段引入 Migration。

若架构要求 actorType 可独立 SQL 查询，才需要单独评估 Migration。

## 12. Terminal Task Read-only Replay

### 12.1 当前事实

**[静态源码确认]**

`TaskLeaseManager.claimWithClaimEvent()` 对 completed / failed / cancelled
Task 抛出：

```text
TASK_LEASE_TASK_TERMINAL
```

因此 Final Decision 与 Task terminal convergence 在同一事务提交后，原调用方
若响应丢失，不能再通过 Lease-owned UoW 重放。

### 12.2 路径比较

#### A. Terminal Task 仍走 Lease-owned UoW

问题：

- Terminal Task 不能 Claim Lease。
- 与现有 TaskLeaseManager 语义冲突。
- 不值得为 Replay 放宽 terminal Claim。

#### B. Host-authorized read-only Replay

**[Final Architecture Decision]**

- 无需 Lease，因为没有任何写操作。
- 仍需 Host Authorization。
- 使用独立 `access=read_replay` capability；claims 必须与 Final Decision
  Authorization 的完整请求身份一致：

```text
access = read_replay
taskId
reviewId
originalUnknownWriteToolRunId
operation
expectedDecisionVersion
operationPayloadDigest
sourceContractDigest | null
requestKey
actorId
actorType
requestNonce
```

- 通过 `recovery_review_operations.getByRequestKey()` 读取历史 Operation。
- 校验 Authorization claims、Review、Event actorId / actorType、Evidence、
  SourceContract digest、Operation identity、payload digest 与 applied
  Event。
- 读取授权只能返回该 `requestKey` 对应的历史结果；不能列出或读取其他
  Review / requestKey，也不能升级为写权限。
- 返回历史结果。
- 不写 Event / Checkpoint，不签发 ExecutionAuthority。

### 12.3 分流

```text
Nonterminal task:
  -> Lease-owned Final Decision UoW
  -> requestKey Replay before CAS
  -> if concurrent convergence makes Task terminal, fall back to terminal
     read-only Replay only with a matching read_replay Authorization
     and the same complete request identity / requestKey

Terminal task:
  -> Host-authorized read-only Replay
  -> requestKey exact lookup
  -> reconstruct historical result
```

若 terminal fallback 找不到相同 requestKey 的 Operation / Event，返回
operation not found 或 task terminal conflict，不得重新 Claim、写 Event 或
把当前调用提升为新的 Decision。

## 13. Schema / Migration Decision

### 13.1 已足够支持

**[静态源码确认]**

`recovery_reviews`：

- final status。
- decision_version。
- source / actor / verifier / verification identity。
- evidence digest / type / protocol。
- submitted / verified / decided timestamps。

`recovery_review_operations`：

- `confirm_succeeded` / `confirm_not_executed`。
- request_key unique。
- review + resulting decision version unique。
- expected / resulting version。
- actor_id。
- operation_payload_digest。
- applied_event_id。

`events` / `checkpoints`：

- Event / Checkpoint 唯一审计。
- Events payload 是 JSON，可持久化 `actorType` 与
  `SourceContractV1` digest / canonical contract payload。

Task / Plan / PlanStep / ToolRun：

- version / status / binding 足够表达当前矩阵。
- `tool_runs` 有 `plan_step_id`、`original_index`、`tool_name`、
  `tool_version`、`input_schema_hash`、`canonical_input_hash`、
  `attempt_no`、`call_id`。
- `UNIQUE (plan_step_id, original_index)` 与
  `UNIQUE (task_id, call_id)` 只保证每个业务 ordinal 一行及 callId 唯一；
  PlanStep 仍可一对多关联多条 Read ToolRun。
- Barrier 顺序可由 `plan_steps.step_index + tool_runs.original_index`
  确定；无需专用 Barrier 表。
- ToolRun / PlanStep State Matrix 已允许 `queued -> skipped`，因此
  downstream non-execution 收敛不需要新状态或新列。

### 13.2 应用层缺口

- `RecoveryReviewDecisionService` 没有 final confirm。
- `CommitOwnedRecoveryReviewOperationInputSchema` 只允许
  `advance_decision_version`。
- `ExecutionUnitOfWork.decideRecoveryReview()` 是 protocol v0 legacy path。
- `RecoveryReviewOperationRepository` 当前允许 `appliedEventId=null` 输入，
  Schema 也未对 confirm operation 强制非空；Final Decision UoW 必须自行
  强制 `confirm_* -> appliedEventId NOT NULL`。
- Task 状态机没有 `waiting_review -> completed`。
- `ExecutionBridge.beforeExecute()` 尚未把 Barrier check 与
  `beginOwnedToolRun()` 合并为一个 immediate transaction。
- `AgentRunner` 在 `persistence !== undefined` 且 scheduler 缺失时存在
  direct `registry.execute()` fallback，可绕过 Write admission。
- 尚无 `SourceContractV1` canonical payload schema / validator。
- 现有 v9 没有独立 `source_contract_digest` 列；本设计要求将其写入
  canonical evidence payload、decision payload digest 与 Final Decision
  Event JSON。
- `recovery_review_operations` 只有 `actor_id`，没有 `actor_type` 列；本设计
  通过 payload digest + Event payload 表达 actorType。
- 尚无 Final Decision UoW 在同一事务内批量执行
  `ToolRun queued -> skipped` + `PlanStep queued -> skipped`。
- 当前没有统一应用层校验保证 Write PlanStep 恰好一条 ToolRun；Schema
  允许多条 ToolRun，因此 Final Convergence 必须显式检查。
- `beginOwnedToolRun()` 尚未拒绝 `PlanStep=skipped`。
- 尚无 Re-plan operation / source lineage persistence；当前 Task 模型不能
  为新 Task 提供强来源 FK 或唯一 Re-plan Replay。

### 13.3 Migration 判断

**[已批准原则]**

最小 Final RecoveryReview 方案**初步不需要 Migration v10**：

- 复用 recovery_reviews。
- 复用 recovery_review_operations。
- 复用 Event / Checkpoint。
- ToolRun 保持 unknown。
- Barrier 可从现有 Plan / PlanStep / ToolRun / Review / Operation / Event
  推导。
- `actorType` 可从 digest、Operation 和 Event 审计链恢复，无需独立列。
- `SourceContractV1` 进入现有 digest-bound JSON payload；若最终要求
  SQL-queryable 列，再单独提出 Schema 增量。
- skipped downstream ToolRun 使用现有状态矩阵与 Event / Checkpoint，
  不需要 Migration。

以下能力仍需单独 Migration / persistence 评审，不属于当前核心：

- Durable Recovery Job。
- 持久 Barrier Generation。
- 新的 Evidence Selection 表。
- 额外的 Task completion 字段。
- 独立的 actorType / Source Contract SQL 索引。
- Future Failed Task Re-plan operation / source lineage。

若 implementation discovery 证明现有 Payload Store 无法持久化并回读
canonical `SourceContractV1`，必须在开发前停止并提交最小 persistence 方案，
不得用未持久化 TypeScript 字段替代。

Re-plan 不影响 Step 6.3.5 核心 Final Decision 的 v9 结论，但 Re-plan 自身
必须经过独立 persistence / Migration 评审，不能复用普通 Task creation
伪造来源关系。

## 14. Durable Job / External Execution Boundaries

### Durable Recovery Job

- 不属于 Final Decision 的直接必要条件。
- 是自动 Worker / 跨重启 Orchestration 的前置。
- 可独立设计。
- 若落 SQLite，可能需要 Migration。

### Scanner / Classifier / Worker

- Generic Scanner / Classifier / Manager 已存在。
- Evidence-specific automatic workflow 仍未实现。
- 不属于 Final Decision UoW 本身。

### External Read / Transaction B

- 属于 Stage 4。
- Final Decision 只消费持久化 EvidenceRead / Manifest / Payload digest。
- 不执行 External Read。
- 无可信 EvidenceRead 时 automatic decision fail closed。

### Verifier

- 属于 Stage 5。
- Final Decision 只消费 historical Binding / Verification Result。
- 不重新选择当前 Verifier Binding。
- not_run / inconclusive 不得自动转 passed。

## 15. Implementation Scope / Dependency Graph

### Phase A：Design Contract Approval

- Final Decision input / requestKey。
- Evidence matrix。
- Unknown resolver。
- Task transition。
- Barrier enforcement。
- Authorization。

Migration：仅评估。

### Phase B：Final Decision Operation / Idempotency

依赖：

- Phase A。
- Existing Lease / Review / Operation schema。

修改候选：

- `RecoveryReviewDecisionService`
- `ExecutionUnitOfWork` 或新 Final Decision UoW
- `RecoveryReviewOperationRepository`

测试：

- confirm success / not executed。
- requestKey replay。
- decisionVersion conflict。
- concurrent one winner。
- Event / Checkpoint。
- Final Decision Event -> Operation -> downstream skip Event 的 ID 绑定。
- Terminal Guard 在 Operation / Event / downstream states 可见后执行。
- Authorization 对完整 requestKey / digest / sourceContractDigest 绑定。
- read Replay 只允许相同 requestKey。

### Phase C：Evidence Eligibility

依赖：

- Phase A。
- Persisted Evidence / Verification read-only access。

修改候选：

- Pure eligibility validator。
- Review decision UoW integration。

测试：

- matrix rows。
- binding mismatch。
- not_run / inconclusive / failed / passed。
- manual / automatic difference。

### Phase D：Unknown Write Resolution + Task Convergence

依赖：

- Phase B / C。
- Approved Task transition。

修改候选：

- Final Decision UoW。
- `ExecutionStateMachine` 内部本事务 convergence method。
- `task-invariants` resolver integration。
- Skipped downstream ToolRun / PlanStep atomic convergence。

测试：

- success / not executed / unresolved。
- cancel。
- all steps terminal。
- waiting_review -> completed。
- active review / active run block。
- W2 / W3 queued ToolRun -> skipped + PlanStep -> skipped。
- read_batch PlanStep 1:N ToolRun 批量 skipped，PlanStep 仅 CAS 一次。
- write PlanStep 1:N（N != 1）fail closed。
- skipped PlanStep with queued ToolRun blocks Task terminal。
- one Event per ToolRun / PlanStep transition。
- Exact Replay 不重复 skipped Event / Checkpoint。

### Phase E：Multi-Write Barrier

依赖：

- Phase D resolver。
- Final architecture approval for normal Agent Write admission。

修改候选：

- Barrier pure policy。
- `ExecutionBridge.beforeExecute()`。
- `ExecutionUnitOfWork.beginOwnedToolRunAfterWriteBarrier()`。

测试：

- W1 block W2/W3。
- logical Write grouping / conflicting ordinal rejection。
- multiple unknown writes。
- historical Plan unknown blocks new writes。
- target existing Unknown cannot re-enter ordinary admission。
- reads unaffected。
- concurrent owners。
- successful barrier advance。
- not_executed requires re-plan。
- persistent `AgentRunner` without scheduler fails closed。
- scheduler-less Write fails closed; direct fallback remains Read-only。
- `PlanStep=skipped` target 无法进入 ordinary ToolRun admission。
- skipped PlanStep 下 nonterminal ToolRun 返回 `state_inconsistent`。
- Read 与 Write 均经过 mode 分流前的通用 PlanStep 状态校验。

### Phase F：Cancel / Pause / Fault Injection / Regression

- Cancel/Pause races。
- First Terminal Commit Wins。
- terminal Task 后 Intent / Decision 写入拒绝。
- Terminal replay。
- rollback。
- SQLite reopen。
- Phase 1–3 regression。

## 16. 推荐 Step 6.3.5 最小可实施范围

1. Lease-owned Final Decision UoW。
2. Host-only Final Decision Authorization。
3. requestKey idempotency + decisionVersion CAS。
4. Evidence / Verification eligibility pure validator。
5. Original Unknown Write resolver。
6. Protected Final Task Convergence Transition。
7. Skipped ToolRun / PlanStep atomic convergence。
8. Multi-Write Barrier policy + actual Write admission integration。
9. Cancel / Pause audit-only interaction。
10. Terminal read-only Replay。
11. Fault Injection / Regression。

## 17. 明确不属于 Step 6.3.5

- Durable Recovery Job / Command Store。
- Durable `recoveryOperationId` context。
- Recovery Scanner / Evidence Worker。
- External Read / Provider。
- Transaction B 新协议 / 新执行器。
- Verifier Runtime / Binding 重设计。
- Payload Store 后端。
- exactly-once External Execution。
- Failed Task 的 Explicit Re-plan Task creation / Replan lineage。
- 重新打开 terminal Task、Task Lease takeover 或 Re-plan authorization。

## 18. Remaining Open Decisions

### 18.1 已批准原则

**[已批准原则]**

以下设计不得回退：

1. 使用专用、capability-guarded Final Convergence Transition 处理
   `waiting_review -> completed`，并统一覆盖 failed / cancelled terminal
   convergence。
2. Multi-Write Barrier 接入
   `beginOwnedToolRunAfterWriteBarrier()`；所有 Write 必须经过
   `TaskScheduler + ExecutionBridge`。
3. Manual `not_run / inconclusive` 仅在 authoritative evidence、
   integrity match、binding match 与独立 Host authorization 下允许 final。
4. `confirmed_not_executed` 必须有版本化 `SourceContractV1`。
5. Pause 期间允许 audit-only Final Decision，但禁止 Resume / Dispatch /
   Re-plan。
6. Final Decision Authorization 的 issuer 属于 Host Auth / Review Control
   adapter。
7. Terminal read-only Replay 不 Claim Lease、不生成 ExecutionAuthority、
   不写 Event / Checkpoint。
8. Original Unknown Write ToolRun 永远保持 `unknown`。
9. Step 6.3.5 不实现 Re-plan，也不重新打开 terminal Task。

### 18.2 本轮最终建议

**[最终建议]**

1. skipped PlanStep 必须与其关联 ToolRun 在同一 Final Decision /
   Convergence transaction 内收敛；ToolRun 使用已有
   `queued -> skipped`。
2. failed Task 后的 Re-plan 采用 Option A：原 Task 永久 terminal，新建
   Task / Plan / Lease。
3. 新 Task 必须通过独立 Re-plan Operation 与来源 lineage 绑定原 Task /
   Review / Unknown Write / Final Decision Event。
4. Re-plan 属于 Step 6.3.5 之外的后续阶段。

### 18.3 待决策

**[待决策]**

1. 未来 Re-plan persistence 采用新增 `recovery_replan_operations` /
   source lineage 表，还是经过单独架构批准的 event-sourced protocol。
   当前 v9 的 Event JSON 不足以独立提供 FK 完整性与唯一 Replay。
2. `SourceContractV1` 是否继续作为 digest-bound JSON payload，还是需要
   SQL-queryable Schema。该决定不阻塞核心 Final Decision。
3. Re-plan Operation 的 Host authorization capability、requestKey 与
   actorType 具体契约，只在独立 Re-plan 设计阶段决定。

### 18.4 Implementation Gates

**[待决策]**

以下必须在 Implementation Planning 中证明：

1. 现有 Payload Store 能持久化并回读 canonical `SourceContractV1`
   system_verified / manual_attested variants。
2. Host Control Composition Root 有可信 authenticated actorId / actorType
   来源。
3. persistent runtime 能保证所有普通 Write 经过 `ExecutionBridge`。
4. Task Final Convergence capability 只在当前 Final Decision transaction
   内有效。
5. skipped ToolRun convergence 与 Task Terminal Guard 使用同一审计链。

## 19. 是否具备进入 Implementation Planning 的条件

**设计层面：已通过最终架构评审（2026-11-09）。**

本轮已完成：

- 修正 Multi-Write Barrier blocker / target / ordering 规则。
- 明确 logical Write identity 与 ambiguous order fail-closed。
- 封闭 persistent direct execution bypass 的设计边界。
- 定义 `confirmed_not_executed` 下游 PlanStep / Plan / Task convergence。
- 收敛 Manual / Automatic Evidence eligibility。
- 明确 actorType 的 digest / Event / Replay 绑定。
- 确认核心方案无已知 Migration v10 blocker。
- 补齐 W2 / W3 queued ToolRun -> skipped 的原子生命周期，消除
  skipped PlanStep + queued ToolRun 的非法组合。
- 明确 failed Task 的 Re-plan 采用新 Task 边界，且属于后续独立阶段。
- 未发现无法到达或无法退出的核心状态转换；`resolved_not_executed` 后的
  下游 ToolRun / PlanStep 均可通过现有 skipped 状态收敛，并通过 Plan
  failed / Task failed 或 cancelled 退出，不会自动执行。合法 Re-plan
  仍需独立授权、持久 lineage 与后续设计。

**实现授权层面：本轮仅授权 Implementation Planning。** 不得开始
Implementation Plan 的 Step 1 或任何 production implementation。

后续必须按 `docs/PHASE3_STEP6_3_5_IMPLEMENTATION_PLAN.md` 逐步授权、
开发、测试、提交 Development Report 并通过架构评审后才能进入下一步。

## 20. 源码与文档依据

文档：

- `docs/PHASE3_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_IMPLEMENTATION_PLAN.md` §19–20
- `docs/PHASE3_STEP6_3_4_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_4_4_REMAINING_IMPLEMENTATION_PLAN.md` §9
- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP8_DEVELOPMENT_REPORT.md`
- `docs/PHASE3_STAGE3_4_CLOSEOUT_AND_STEP6_3_5_ARCHITECTURE_DISCOVERY.md`

源码：

- `src/storage/recovery-review-repository.ts`
- `src/storage/recovery-review-operation-repository.ts`
- `src/recovery/recovery-review-decision-service.ts`
- `src/recovery/recovery-review-submission.ts`
- `src/recovery/recovery-evidence-host-control-authorization.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/storage/recovery-evidence-read-repository.ts`
- `src/storage/recovery-evidence-verification-check-repository.ts`
- `src/storage/recovery-evidence-verification-repository.ts`
- `src/storage/task-invariants.ts`
- `src/storage/execution-state-machine.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/task-lease-manager.ts`
- `src/persistence/execution-bridge.ts`
- `src/agent/agent-runner.ts`
- `src/scheduler/planner.ts`
- `src/scheduler/task-scheduler.ts`
- `src/scheduler/write-executor.ts`
- `src/scheduler/read-worker-pool.ts`
- `src/storage/plan-step-repository.ts`
- `src/storage/tool-run-repository.ts`
- `src/storage/task-repository.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/recovery-review-operation-keys.ts`
- `src/storage/types.ts`
- Migration v1 / v2 / v3 / v4 / v5 / v7 / v8 / v9

关键静态证据：

- `TASK_TRANSITIONS.waiting_review` 不包含 `completed`。
- `PLAN_STEP_TRANSITIONS.queued` 包含 `skipped`。
- `ExecutionPlanRepository.updateStatusCas()` 只允许 active -> terminal。
- `TaskLeaseManager.claimWithClaimEvent()` 拒绝 terminal Task。
- `ExecutionBridge.beforeExecute()` 当前调用独立事务的
  `beginOwnedToolRun()`。
- `AgentRunner` 在 persistence 存在但 scheduler 缺失时走 direct
  `registry.execute()`。
- `executeValidated()` 的生产调用点只有 WriteExecutor 与 ReadWorkerPool。
- `tool_runs` 以 `(plan_step_id, original_index)` 与
  `(task_id, call_id)` 唯一。
- `TaskScheduler.fillUnstarted()` 只生成内存 skipped Result，不持久化
  downstream ToolRun。
- Task Terminal Guard 将 queued ToolRun 视为 active。
- `beginOwnedToolRun()` 不拒绝 `PlanStep=skipped`。
- `tasks` / `CreateTaskInputSchema` 没有 Re-plan source lineage 字段。
- `recovery_review_operations.operation` CHECK 不包含 `replan`。
- Events payload 可记录 JSON 引用，但没有 cross-task Foreign Key 或唯一
  Re-plan request identity。
- `EventRepository.append()` 生成并返回 Event ID，可供后续 Skip Event
  精确引用。
- `RecoveryReviewOperationRepository` 当前允许 `appliedEventId=null`；
  Final Decision UoW 必须为 confirm operation 强制非空。
- `TaskPlanner` 将连续 Read 合并为一个 `read_batch` Step，因此实际存在
  PlanStep 1:N ToolRun。

## 21. 本轮修订摘要

### P1-1：Multi-Write Barrier 错误放行

修订章节：§9、§13、§15、§18–19。

修正内容：

- 删除 target 自身可无条件作为 earliest open group 放行的规则。
- `resolved_not_executed` 成为显式 blocker。
- historical Plan unresolved Unknown 全局阻止新 Write。
- earliest open Unknown / earlier nonterminal / target existing Unknown 均
  fail closed。
- 排序歧义不再使用 stable ID，改为 `stepIndex + originalIndex`，歧义直接
  `state_inconsistent`。

### P1-2：Logical Write Identity / Ordering

修订章节：§9.3–9.6。

修正内容：

- `toolCallId` 降为关联字段，不作为唯一逻辑身份。
- identity 绑定 Plan、PlanStep、originalIndex、tool identity 和 input digest。
- `execution_plans.version` 与 `attempt_no` 明确不承担跨 Write 顺序。
- PlanStep `1:N` ToolRun、Write Step 1:1 业务不变量及
  read_batch 批量关联被准确记录。

### P1-3：Barrier Enforcement Coverage

修订章节：§9.8、§13.2、§18–19。

修正内容：

- Barrier 与 ToolRun begin 合并为同一 immediate transaction。
- `AgentRunner` persistent direct execution fallback 被识别为真实旁路。
- persistent mode 无 scheduler 必须 fail closed。
- direct `registry.execute()` 仅允许无持久化 Read-only 局部执行；任何 Write
  必须经过 scheduler + admission，否则 fail closed。

### P1-4：confirmed_not_executed Convergence

修订章节：§8.2–8.6、§11.4。

修正内容：

- 当前 Write PlanStep -> failed。
- 后续 queued ToolRun / PlanStep -> skipped，使用已有
  `UPSTREAM_WRITE_NOT_EXECUTED` reason Event。
- 后续 running / completed 状态视为 `state_inconsistent`。
- Plan 全步骤 terminal 且含 failed 后可 active -> failed。
- 其他 Unknown 未完成时 Task 保持 waiting_review；Cancel 优先收敛为
  cancelled；Pause 阻止 Resume / Re-plan。
- 所有 negative proof 必须使用版本化 `SourceContractV1`；
  Automatic 为 `system_verified`，Manual 为 `manual_attested`。

### P1-5：Skipped PlanStep / ToolRun Lifecycle

修订章节：§8.6–8.9。

修正内容：

- 确认 W2 / W3 ToolRun 在现有 Scheduler 路径中仍可能保持 queued。
- 确认 Task Terminal Guard 会阻止这种状态，且普通 ToolRun admission
  不拒绝 skipped PlanStep。
- 使用现有 `queued -> skipped` 收敛 ToolRun，并同步 PlanStep。
- 每个实际状态转换写对应 Event；Final Decision UoW 末尾写一个 Checkpoint。
- Exact Replay 不重复 skipped 状态、Event 或 Checkpoint。

### P1-6：Failed Task / Explicit Re-plan Boundary

修订章节：§8.8、§17–19。

修正内容：

- 原 Task 永久保持 failed terminal，不重新 Claim 原 Lease。
- Re-plan 采用新 Task / new ExecutionPlan / new Lease。
- 来源关系需要独立 Re-plan Operation 与 persistent lineage。
- 现有 v9 可用 Event JSON 记录引用，但不能提供完整 FK 与唯一 Replay。
- Re-plan 不进入 Step 6.3.5；未来实现需单独 Migration / architecture。

### Schema / Migration 结论

本轮未发现核心 Final Decision 需要 Migration v10：

- actorType 通过 decision payload digest + Event payload 持久绑定。
- Barrier 从现有 Plan / PlanStep / ToolRun / Review / Operation / Event
  推导。
- SourceContractV1 设计为 digest-bound JSON payload。

若 Payload Store 无法支持 SourceContractV1 的持久化与回读，或架构要求
SQL-queryable Source Contract / actorType，则必须单独提交 persistence
方案，不在本设计中擅自新增 Migration。

Failed Task Re-plan 同理：当前核心 Final Decision 不需要 v10，但 Re-plan
自身需要独立 persistence / Migration 设计后才可实施。

## 22. Final Consistency Remediation

**[本轮只读审计结论]**

1. **Transaction Ordering**：Final Decision Event 先写入并获得真实 ID，
   Operation 再以 `appliedEventId` 绑定；downstream skip Event 引用同一 ID；
   最后执行 Terminal Guard、Task terminal 与 Checkpoint。
2. **Authorization**：Final Decision / read Replay capability 均绑定完整
   operation、expectedDecisionVersion、payload digest、requestKey、actor
   identity；nonce 只用于防重放。
3. **Read Admission**：Read / Write 在 mode 分流前执行统一状态、身份、
   version、Lease / Authority 校验；Read 仅跳过 Write Barrier。
4. **Manual Contract**：所有 confirmed_not_executed 都需要
   SourceContractV1；Manual 使用 manual_attested，Automatic 使用
   system_verified，不得互相冒充。
5. **Cancel Race**：采用 First Terminal Commit Wins；terminal Task 后拒绝
   新 Intent / Decision 写操作。
6. **Cardinality**：PlanStep 与 ToolRun 为 1:N；Write Step 1:1 是业务
   不变量而非 Schema 唯一约束；Final Convergence 必须批量验证全部
   ToolRun 后只执行一次 PlanStep CAS。

本轮仅阅读现有测试源码，未重新运行测试。现有测试历史包含 read_batch 一个
PlanStep 对应两条 ToolRun 的场景记录，但该记录不替代本轮验证。

未发现新的核心 Schema / Migration blocker。Manual SourceContractV1 仍要求
实现前提供 canonical payload / validator；若无法复用 Payload Store，则需
单独 persistence 方案。

## 23. 边界声明

本文件仅为设计修订。

未修改生产代码、测试、Migration、SQLite Schema 或依赖，未创建 Git Commit。

设计已批准；后续停止点由 Implementation Plan 的逐步授权 Gate 定义。
