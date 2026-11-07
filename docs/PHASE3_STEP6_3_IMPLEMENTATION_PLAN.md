# Phase 3 Step 6.3 — Unknown Write Recovery Implementation Plan

> 状态：设计阶段，等待架构评审通过
>
> 范围：Unknown Write Recovery、RecoveryReview、Evidence Trust、受限 Read-back、
> Lease-owned Decision UoW、Legacy Review、幂等与并发
>
> 本文档只包含设计。没有修改生产代码、测试或数据库 Schema，没有安装依赖，
> 没有执行 Recovery、Provider 或 Write。

## 1. 最终设计摘要

本版完成以下架构闭合：

1. Task completed / failed / cancelled 使用不同终态不变量。
2. Unknown Write 的终态判断基于同 Task Review、Evidence、Legacy Attestation
   和 PlanStep 映射，而不是简单遍历 unknown 状态。
3. Legacy conflict 一旦出现永久锁定，普通新 attestation 不能自动解除。
4. Protocol v1 Review 决策只有一个 Lease-owned 写入入口。
5. Read-back 使用独立 `recovery_evidence` ExecutionPlan 和普通 read_batch
   PlanStep，不重建现有 PlanStep CHECK，也不进入普通 Planner/Scheduler。
6. Evidence Digest、payload type、actor/verifier 和 timestamp 协议精确定义。
7. 所有 Review 操作使用持久化 operation request key 和 decision version CAS。
8. Verifier/Read-back 继承 Heartbeat、ExecutionAuthority、Abort、settle 和
   Lease 清理规则。

## 2. 当前架构与限制

现有：

- `RecoveryScanner`
- `RecoveryManager`
- `RecoveryClassifier`
- `RecoveryGate`
- `ExecutionStateMachine`
- `ExecutionUnitOfWork`
- `TaskLeaseManager`
- `LeaseHeartbeat` / `ExecutionAuthority`

现有 RecoveryReview：

```text
id
task_id
tool_run_id
status
note
source_type
evidence_ref
created_at
updated_at
decided_at
```

现有约束：

- `UNIQUE(task_id, tool_run_id)`
- active Review = pending/unresolved
- Review 必须引用同 Task 的 unknown Write
- confirmed_succeeded 必须有 evidence_ref

限制：

- evidence_ref 没有结构化 Read ToolRun 绑定。
- 没有 payload type、digest protocol、actor/verifier 或时间三态。
- 没有 decision version、持久化 request key 或 legacy attestation。
- 旧 `decideRecoveryReview()` 不是 Lease-owned API。
- 当前 terminal check 只看 active Review，无法证明每个 unknown Write 已 trusted。
- Recovery-only Read 没有与普通 Agent Read Batch 隔离。

## 3. Unknown Write 的三层事实

### 3.1 原始 ToolRun unknown

这是执行事实：

```text
Write 已启动
结果不确定
```

ToolRun 永远保持 unknown，不因 Review 改变。

### 3.2 尚未解决的 Unknown Write

满足任一：

- 没有 RecoveryReview。
- Review pending/unresolved。
- Legacy Review 没有 attestation。
- Legacy attestation inconclusive。
- Legacy conflict。
- Protocol v1 Review 缺 evidence/trust 字段。
- Review final 与 PlanStep completed/failed 不匹配。

### 3.3 已核验 Unknown Write

同时满足：

- 同 Task 的 final Review。
- Protocol v1 trusted，或 protocol v0 有 trusted legacy attestation。
- confirmed_succeeded + PlanStep completed，或
  confirmed_not_executed + PlanStep failed。
- 如果引用 recovery evidence Read ToolRun：
  - 同 Task；
  - mode=read；
  - succeeded；
  - 恰好一条 Tool Message；
  - toolCallId 对应；
  - 关联 binding 校验通过。

ToolRun 仍是 unknown；这里只表示 Review 可信。

## 4. Task Terminal Invariant

### 4.1 Unknown Write Resolution 子条件

对每个同 Task unknown Write ToolRun：

1. 必须存在唯一 RecoveryReview。
2. Review 必须是 trusted final。
3. 不得存在 legacy conflict。
4. confirmed_succeeded -> PlanStep completed。
5. confirmed_not_executed -> PlanStep failed。
6. 无 Review、active、legacy unverified、conflict、mismatch 均阻止 terminal。

### 4.2 Completed

```text
Task -> completed
```

要求：

- 所有普通业务 PlanStep 为 completed/skipped。
- completed/skipped 判断排除 recovery_evidence Plan 内的步骤。
- 不存在 active ToolRun / pending Approval / active Review。
- 所有 unknown Write 已核验。
- confirmed_not_executed / failed 业务 PlanStep 阻止 completed。
- 所有被 Review 引用的 recovery evidence Read 必须 succeeded。

### 4.3 Failed

```text
Task -> failed
```

要求：

- 无 active 业务 PlanStep / ToolRun / Approval / Review。
- 所有 unknown Write 已核验。
- confirmed_not_executed 对应 PlanStep failed。
- completed Task 不允许 failed PlanStep；failed Task 可以保留 prior completed 和
  failed PlanStep。
- `last_error_json` 或等价安全持久化失败事实必须存在。
- 若失败发生在 Plan 创建前，可以没有 PlanStep，但仍不得有 unresolved unknown。

### 4.4 Cancelled

```text
Task -> cancelled
```

要求：

- `cancel_requested_at IS NOT NULL`。
- 无 active PlanStep / ToolRun / Approval / Review。
- 所有 unknown Write 已核验。
- confirmed_succeeded 对应 completed；confirmed_not_executed 对应 failed。
- 完成后不请求 Provider、不执行后续 Write。

### 4.5 Recovery Evidence Plan Terminal Guard

Terminal Guard 必须检查 `purpose=recovery_evidence` 的 Plan：

- 存在 queued/running/interrupted Recovery Evidence PlanStep -> 阻止 Terminal。
- 存在 queued/running/interrupted Recovery Evidence Read ToolRun -> 阻止 Terminal。
- 正在等待 Verifier/Read-back -> 阻止 Terminal。
- Recovery Evidence Read succeeded 且被 trusted Review 引用 -> 允许。
- Recovery Evidence Read failed 且未被任何 Review 引用 -> 不阻止业务 Terminal。
- 被 Review 引用的 Read 必须：
  - status=succeeded；
  - 恰好一条 Tool Message；
  - Task/ToolRun/callId/binding 完全匹配。
- Review 引用的 Read 失败、缺消息或绑定不一致 -> Trust 失败，阻止 Terminal。
- 不能因为 recovery_evidence 不属于业务 Plan 就忽略其活动执行。
- 未引用的 failed Evidence Read 必须作为历史记录保留，但不参与业务步骤
  completed/skipped 判断。

建议将 Terminal Guard 拆成：

```text
assertBusinessPlanStepsTerminal
assertRecoveryEvidenceTerminal
assertUnknownWriteResolution
```

### 4.6 统一实施位置

- `ExecutionStateMachine`
- `ExecutionUnitOfWork`
- `TaskRepository.updateStatus/updateStatusCas`
- `assertTaskCanBecomeTerminal`
- SQLite terminal Trigger
- Step 6.4 Resume/Cancel Gate

数据库 Trigger 必须执行相同的 Unknown Write Resolution 查询，不能只看 Review
active 状态。

## 5. RecoveryReview 状态机

```text
pending
  -> unresolved
  -> confirmed_succeeded
  -> confirmed_not_executed

unresolved
  -> unresolved
  -> confirmed_succeeded
  -> confirmed_not_executed

confirmed_succeeded -> terminal
confirmed_not_executed -> terminal
```

规则：

- pending/unresolved 可提交证据。
- unresolved -> unresolved 会递增 decisionVersion 并追加 Event。
- final 不可逆，两个 final 不可互转。
- 每次 Evidence Submission 和有效 Decision 都有独立 operation/event。
- 单 ToolRun 仍只有一条 Review。

## 6. 三种有效 Review 结论

### 6.1 confirmed_succeeded

```text
Review -> confirmed_succeeded
PlanStep waiting_review -> completed
ToolRun unknown -> unknown
Task -> waiting_review（无 cancel intent）
```

- output 保持原值或 NULL。
- 不生成伪造成功 Tool Message。
- 不自动重执行 Write。

### 6.2 confirmed_not_executed

```text
Review -> confirmed_not_executed
PlanStep waiting_review -> failed
ToolRun unknown -> unknown
Task -> waiting_review（无 cancel intent）
```

- PlanStep failed 不直接决定 Task.status。
- 多个 unknown 未核验时 Task 继续 waiting_review。
- 不自动 Re-plan。
- completed Task 不允许遗留 failed PlanStep。

### 6.3 unresolved

```text
Review -> unresolved
PlanStep -> waiting_review
Task -> waiting_review
```

不推进 Tool/Provider/Resume。

## 7. Legacy Attestation 冲突锁定

### 7.1 独立 append-only 表

```text
recovery_legacy_attestations
  id
  task_id
  original_review_id
  attestation_version
  request_key
  evidence_envelope_digest
  evidence_ref
  source_type
  actor_id
  verifier_id
  verification_id
  source_observed_at
  submitted_at
  verified_at
  result
```

`result`：

```text
confirms_original
contradicts_original
inconclusive
```

原 Review/Event 不改写。

### 7.2 冲突锁定

- 任意有效 `contradicts_original` 将 Legacy Review 永久标记 conflict。
- 后续 `confirms_original` 不能自动解除。
- Step 6.3 不实现 conflict resolution。
- conflict 持续阻止 terminal/Resume。
- 输出 Recovery finding：`LEGACY_REVIEW_CONFLICT`。

### 7.3 Trust Resolver

- 无 attestation -> legacy_unverified。
- 有 conflict -> legacy_conflict。
- 无 conflict：
  - 最新 attestation confirms_original -> trusted legacy final。
  - 最新 attestation inconclusive -> legacy_unverified。
- 原 Review 状态只作为历史事实，不作为 trust 结论。

## 8. Protocol v1 唯一受控写入口

允许：

```text
RecoveryManager
  -> ExecutionUnitOfWork.decideOwnedRecoveryReview
```

规则：

- v1 final 只能由该入口写。
- 必须有 Lease/Heartbeat/ExecutionAuthority/fencing/version CAS。
- 旧 `decideRecoveryReview()` 仅保留给 protocol v0 legacy compatibility。
- 旧 API 遇到 protocol_version>=1 必须拒绝。
- Repository 决策方法不再通过 public storage index 暴露。
- 其他 UoW/Repository 不能写 v1 Review decision。
- DB Trigger 强制 v1 final evidence 字段和 final 不可逆。

## 9. Evidence Trust Model

### 9.1 定义

- Integrity：内容未被改变。
- Authenticity：证据来源身份可信。
- Verification：证据绑定及 outcome 判断可信。
- Human Attestation：认证 reviewer 的人工结论。
- System Verification：宿主只读 Verifier 结论。

Digest 不证明 authenticity。

### 9.2 Source-specific Schema

```text
manual_review_v1
  actorId: host required
  verifierId: null
  verificationId: null
  source_observed_at: authoritative required
  submitted_at: host generated
  verified_at: host generated at acceptance

system_verification_v1
  actorId: null
  verifierId: host required
  verificationId: host required
  source_observed_at: verifier required
  submitted_at: host generated
  verified_at: host generated
```

模型/普通请求不能填写 actorId/verifierId/verificationId。

### 9.3 Manual Policy

- 人工成功：authenticated reviewer + authoritative external evidence。
- 人工未执行：要求外部拒绝回执、权威幂等账本未接收、完整 mutation log 等强证据。
- “未观察到目标状态”不等于未执行。
- 无权威证据 -> unresolved。
- human-attested 与 system-verified 必须在 Review/Event 中区分。

## 10. Evidence Payload / Digest

### 10.1 Payload Types

```text
raw_bytes
json
external_reference
readback_result
```

Digest Protocol：

```text
raw_bytes -> sha256-raw-v1
json -> jcs-sha256-v1
readback_result -> jcs-sha256-v1
external_reference -> adapter-content-sha256-v1
```

### 10.2 external_reference

- Digest 必须基于受控 Adapter 实际获取的内容，不是 URL 字符串。
- Adapter 必须返回：
  - 实际获取的 bytes/JSON；
  - immutable resourceVersion / ETag / signature 或等价来源版本；
  - sourceObservedAt。
- `payloadDigest` 对实际获取内容计算；`resourceVersion` 是附加来源元数据，
  不代替内容 Digest。
- 引用不可访问、过期、被替换或缺失版本：
  - 不能 accepted 为 trusted evidence；
  - 保持 unresolved，或重新获取后产生新 envelope。
- Evidence Store 按 content digest 保存，带 ACL 和 retention。
- 若证据已删除，审计保留 digest/ref/observedAt，但不能再次核验；后续操作必须
  重新获取或保持 unresolved。

### 10.3 Envelope Digest

固定 JCS 输入及类型：

```text
schemaVersion: "forgeflow.recovery-evidence.v1"
evidenceRef: non-empty string
sourceType: "manual_review" | "system_verification"
outcome: "observed_succeeded" | "observed_not_executed" | "inconclusive"
sourceObservedAt: ISO-8601 UTC string
resourceRef: string | null
resourceVersion: string | null
taskId: non-empty string
toolRunId: non-empty string
toolName: non-empty string
toolVersion: non-empty string
inputSchemaHash: sha256:<hex>
canonicalInputHash: sha256:<hex>
idempotencyKey: sha256:<hex>
actorId: string | null
verifierId: string | null
verificationId: string | null
payloadType: "raw_bytes" | "json" | "external_reference" | "readback_result"
payloadDigestProtocol: "sha256-raw-v1" | "jcs-sha256-v1" | "adapter-content-sha256-v1"
payloadDigest: sha256:<hex>
```

source-specific 非空规则：

```text
manual_review:
  actorId required
  verifierId null
  verificationId null

system_verification:
  actorId null
  verifierId required
  verificationId required
```

`resourceRef/resourceVersion` 在 `external_reference` 时必须非空。

不参与：

- envelopeDigest 自身
- redactedSummary
- submittedAt / verifiedAt（这些是操作时间，不是证据内容）

Envelope Digest 稳定；redactedSummary 仅为展示。

### 10.4 Timestamp Ownership

- `sourceObservedAt`：来源系统或权威人工记录提供；required。
- `submittedAt`：Flow API 接收时由宿主生成；required for operation persistence。
- `verifiedAt`：Verifier/Authoritative Reviewer 完成核验时由宿主生成；required
  for final。

客户端时间不能替代宿主时间。

## 11. Recovery Read-back 结构最终选择

### 11.1 方案比较

| 方案 | 优点 | 问题 |
|---|---|---|
| 新增 PlanStep kind recovery_read | 语义明确 | 现有 CHECK 无法简单 ALTER，需重建 PlanStep |
| 独立 evidence read 表 | 隔离强 | 与 ToolRun plan_step_id、执行链重复 |
| recovery_evidence ExecutionPlan + read_batch PlanStep | 复用现有结构 | 需新增 Plan purpose 并过滤 |

最终选择：

```text
execution_plans.purpose = agent | recovery_evidence
recovery_evidence Plan 使用普通 read_batch PlanStep
```

理由：

- 不重建 `plan_steps` 表。
- 继续复用 ToolRun/PlanStep FK。
- Plan 级隔离比修改 PlanStep kind 更简单。
- 普通 Planner/Scheduler 可按 plan purpose 完全排除。

### 11.2 数据结构

```text
execution_plans
  purpose TEXT NOT NULL DEFAULT 'agent'
  CHECK purpose IN ('agent', 'recovery_evidence')
```

Recovery Evidence Plan：

- 使用新 version = `MAX(execution_plans.version) + 1`。
- `source_model_call_id` 必须精确取：

```text
Unknown Write ToolRun
  -> plan_steps.plan_id
  -> execution_plans(source_model_call_id)
```

不得使用任意最近 completed ModelCall。原 Plan / ModelCall 必须同 Task，且原
ModelCall 状态为 completed。
- PlanStep step_index=0，kind=read_batch。
- 此 Plan 使用独立 purpose 和独立 step 命名空间，不参与普通业务 step order。
- recovery read ToolRun originalIndex 只在此 PlanStep 内使用。

### 11.3 隔离

- Planner 永不生成 purpose=recovery_evidence。
- TaskScheduler 只调度 purpose=agent。
- RecoveryClassifier/Gate 单独识别 recovery_evidence。
- `ExecutionPlanRepository` 必须提供 purpose-aware list/get-latest：
  - Agent 查询：`WHERE purpose='agent'`
  - Recovery evidence 查询：`WHERE purpose='recovery_evidence'`
- 所有现有 latest Plan/MAX(version) 读取点必须审计：
  - `ExecutionBridge.completeModelResponse`
  - UoW checkpoint/meta 查询
  - StateMachine checkpoint 查询
  - TaskLeaseManager checkpoint 查询
  - RecoveryManager earliest unfinished PlanStep
- AgentRunner 只能选择 purpose=agent 的最新普通 Plan。
- TaskSnapshot 分组：
  - `agentPlans`
  - `recoveryEvidencePlans`
  - 同时保留带 purpose 的 flat `executionPlans` 仅供兼容，不允许消费方无过滤使用。
- Terminal Guard 不把 recovery_evidence PlanStep 当作普通业务步骤。

## 12. Evidence Read-back 绑定

建议新表：

```text
recovery_evidence_reads
  id
  task_id
  review_id
  tool_run_id
  evidence_envelope_digest
  created_at
  UNIQUE(review_id, tool_run_id)
```

复合外键：

```text
(task_id, review_id) -> recovery_reviews(task_id, id)
(task_id, tool_run_id) -> tool_runs(task_id, id)
```

验证 Trigger：

- ToolRun mode=read。
- ToolRun status=succeeded。
- 恰好一条 Tool Message。
- toolCallId 对应。
- 同 Task。

## 13. Recovery-only Read Crash Recovery

场景：

```text
execution_plans.purpose = recovery_evidence
PlanStep read_batch
ToolRun running(read)
process crash
```

流程：

1. RecoveryScanner 按 Task Lease 条件发现候选。
2. RecoveryClassifier 识别 recovery_evidence Plan 和 running Read。
3. 分类为 `recovery_read_interrupted`，不是普通 `read_interrupted`。
4. `RecoveryManager.recoverEvidenceReadRuns(...)` 处理。
5. 普通 `recoverReadRuns()` 和 TaskScheduler 不得接管。
6. running -> interrupted -> queued -> running。
7. 保留原 ToolRun ID/call ID/originalIndex/hashes/idempotency key。
8. Intent/Result 复用 Step 6.2 与 ExecutionAuthority/fencing。
9. 正常 failed 后不自动重试；新 Read-back 创建新的 recovery_evidence Plan/ ToolRun。
10. 已有 trusted Evidence 时拒绝重复 Read-back。

## 14. Multi Unknown Write 与 Cancel

- 按 PlanStep step_index + ExecutionPlan version 选择最早未解决 Write。
- 前序 Unknown Write barrier 未解决时，后续 Write 可保存 evidence，但不能推动
  Task 执行。
- 所有 Review decisions 使用同一 Task Lease 串行提交。
- cancel intent + unresolved -> waiting_review。
- 所有 unknown 已核验 + cancel intent -> waiting_review -> cancelled。
- confirmed_not_executed PlanStep failed 不自动决定 Task。
- Review 完成不自动 Resume/Re-plan。

## 15. Decision Operation Idempotency

### 15.1 表

```text
recovery_review_operations
  id
  task_id
  review_id
  request_key
  operation
  expected_decision_version
  resulting_decision_version
  status
  evidence_envelope_digest
  result_plan_id
  result_tool_run_id
  applied_event_id
  created_at
```

`operation`：

```text
submit_evidence
request_readback
mark_unresolved
confirm_succeeded
confirm_not_executed
legacy_attest
```

唯一：

- request_key
- (review_id, resulting_decision_version)
- (task_id, applied_event_id)

### 15.2 Events 父键

真实 Events 只有 `id PRIMARY KEY` 和 `UNIQUE(task_id, sequence)`，没有
`UNIQUE(task_id, id)`。Migration 必须先创建：

```sql
CREATE UNIQUE INDEX ux_events_task_id
ON events(task_id, id);
```

然后 Operations 使用：

```text
FOREIGN KEY(task_id, review_id)
  REFERENCES recovery_reviews(task_id, id)
FOREIGN KEY(task_id, result_plan_id)
  REFERENCES execution_plans(task_id, id)
FOREIGN KEY(task_id, result_tool_run_id)
  REFERENCES tool_runs(task_id, id)
FOREIGN KEY(task_id, applied_event_id)
  REFERENCES events(task_id, id)
```

`result_plan_id/result_tool_run_id` 对 `request_readback` 必须非空；
其他 operation 为 null。

### 15.3 Request Key

```text
sha256(JCS([
  "forgeflow.recovery-review-operation.v1",
  reviewId,
  expectedDecisionVersion,
  operation,
  operationPayloadDigest,
  actorId
]))
```

`operationPayloadDigest`：

- `request_readback`：JCS(reviewId, 原 unknown ToolRun ID, verifierId,
  allowlistId, expectedDecisionVersion)。
- 其他 operation：evidenceEnvelopeDigest。

相同 requestKey 重放：

- 返回已保存结果。
- 不重复写业务 Event/Checkpoint。

`request_readback`：

- request key 必须在创建 recovery_evidence Plan / Read ToolRun Intent 前持久化。
- 同一事务创建 operation record、Plan、PlanStep、ToolRun Intent、Event 和
  Checkpoint。
- 重复 request key 返回原 result_plan_id/result_tool_run_id。
- 不重复执行 Verifier/Read。
- 正常 failed 后重新请求必须使用新的 request key 和新的 Plan/ToolRun。
- crash 恢复继续使用已持久化的原 ToolRun Intent。
- 已有可信 Evidence 时，即使 request key 不同也拒绝创建新 Read-back。
- request_readback 即使不改变 Review status，也递增 decision_version 作为操作
  revision。

### 15.4 CAS

- expected_decision_version 必须等于 Review 当前版本。
- resulting_decision_version = expected + 1。
- 两个不同 request 同 expected version：一个成功，另一个冲突。
- final 状态只允许 protocol v0 legacy special path 或 v1 owned path。

## 16. Decision / Transaction Boundary

唯一 v1 决策入口：

```text
RecoveryManager
  -> RecoveryReviewDecisionService
  -> ExecutionUnitOfWork.decideOwnedRecoveryReview
```

事务内：

1. ExecutionAuthority guard
2. assertOwned
3. Task version CAS
4. Review status/version CAS
5. ToolRun/Evidence binding
6. Update Review
7. Update PlanStep
8. cancel intent final decision
9. Event
10. recovery_review_operations
11. Checkpoint

外部 Verifier/Read-back 永远不在同步 SQLite transaction 中 await。

## 17. Verifier / Abort / Lease

- Heartbeat 失败先 revoke ExecutionAuthority，再 Abort。
- 忽略 Abort 的 Verifier/Read 必须 settle 后才清理。
- settle 前不得提前释放仍在使用的 Lease。
- 迟到 Result/Decision 同时经过 local guard 和 DB fencing/assertOwned。
- Verifier 永不 settle：Recovery promise 持续等待，Heartbeat 继续；
  进程退出后 Lease 才过期。不得伪造停止状态。
- Release 失败显式暴露。

## 18. Database Migration

### recovery_reviews

```text
review_protocol_version INTEGER NOT NULL DEFAULT 0
decision_version INTEGER NOT NULL DEFAULT 0
evidence_payload_digest TEXT
evidence_payload_type TEXT
evidence_digest_protocol TEXT
evidence_envelope_digest TEXT
actor_id TEXT
verifier_id TEXT
verification_id TEXT
source_observed_at TEXT
submitted_at TEXT
verified_at TEXT
```

### execution_plans

```text
purpose TEXT NOT NULL DEFAULT 'agent'
CHECK purpose IN ('agent', 'recovery_evidence')
```

### 新表

```text
recovery_evidence_reads
recovery_legacy_attestations
recovery_review_operations
```

### 新唯一索引

```text
events(task_id, id)
```

真实父表检查：

- `events(task_id,id)` 当前缺失 -> Migration 补唯一索引。
- `recovery_reviews(task_id,id)` 已有 UNIQUE。
- `tool_runs(task_id,id)` 已有 UNIQUE。

### 旧数据

- review_protocol_version=0。
- decision_version=0。
- 不生成伪 digest。
- 旧 final Review 保持 legacy_unverified。
- 通过 legacy attestation 独立核验。
- conflict 永久锁定，Step 6.3 不自动解除。

### PlanStep 重建

本方案不新增 PlanStep kind，因此不重建 `plan_steps`。只给 `execution_plans`
新增 purpose 列。现有 ToolRun 复合外键、PlanStep Trigger、索引保持不变。

## 19. 子步骤顺序

### 6.3.1 Evidence Contract + Schema/Compatibility

- Evidence schemas/digest protocols。
- Review v1 fields。
- execution_plans purpose。
- evidence_reads / legacy_attestations / review_operations。
- Events unique index。
- 旧数据 legacy_unverified。

不开放 final decision。

### 6.3.2 Lease-owned Decision Core + Idempotency

- Lease/Heartbeat/ExecutionAuthority。
- Review version CAS。
- operation request key。
- 旧 API 仅 protocol v0。

不开放 final outcome。

### 6.3.3 Evidence Submission + unresolved

- submit evidence。
- unresolved -> unresolved。
- event/checkpoint 幂等。

### 6.3.4 Restricted Verifier + Recovery Read-back

- recovery_evidence ExecutionPlan。
- Recovery-only read_batch。
- Read-back crash recovery。
- Evidence binding/Trigger。

### 6.3.5 Final Decisions + Cancel + Multi-Write Barrier

- confirmed_succeeded / confirmed_not_executed。
- PlanStep completed/failed。
- Task terminal invariants。
- cancel intent。
- multi-write barrier。

### 6.3.6 RecoveryReport + E2E + Regression

- legacy report/conflict。
- Review resolved report。
- Step 6.4 Resume/history handoff contract。

## 20. 测试矩阵

### Unknown Write Terminal

- no review / active / legacy unverified / conflict -> terminal rejected。
- protocol v1 trusted success + PlanStep completed -> eligible。
- confirmed_not_executed + PlanStep failed -> eligible for failed/cancelled, not completed。
- Review/PlanStep mismatch -> state_inconsistent。
- ToolRun remains unknown。

### Legacy

- confirms_original -> trusted compatibility。
- inconclusive -> unverified。
- contradicts_original -> permanent conflict lock。
- later confirms cannot clear conflict。
- original Review/Event unchanged。

### API

- v1 decision only Lease-owned UoW。
- old API rejects v1。
- no Lease/revoked authority/stale fencing rejected。
- concurrent decision one winner。
- duplicate requestKey no duplicate Event/Checkpoint。

### Evidence

- raw bytes / JSON / external reference / readback digest。
- external reference version changes -> digest mismatch。
- inaccessible/expired reference -> unresolved。
- reviewer/verifier field injection。
- redactedSummary excluded。

### Recovery Read-back

- recovery_evidence Plan not planned/scheduled normally。
- running read crash -> interruption -> retry。
- new attempt after failed read。
- existing trusted evidence prevents duplicate readback。
- Read result/Tool Message atomic。
- Abort ignored -> settle before release; commit rejected。

### Cancel / Multi-write

- earlier unknown barrier blocks later write。
- active review blocks cancelled。
- all trusted final + cancel intent -> cancelled。
- no Provider/Write recovery auto-execution。

## 21. 风险与未决问题

### 未决

1. manual_review 是否可单独确认成功。
2. Evidence Store 后端与 retention。
3. reviewer 身份系统所在层。
4. legacy conflict 的未来冲突解决入口。
5. recovery_evidence ExecutionPlan version 对业务 Plan version 的长期影响。
6. confirmed_not_executed 后 Re-plan 触发属于 Step 6.4/6.5。

### 边界

- Digest 不证明来源真实性。
- 不保证外部 exactly-once。
- 不能回滚外部成功 Write。
- 不能强制终止忽略 AbortSignal 的 Verifier/Read。
- Step 6.3 不自动 Resume，不调用 Provider。
- Step 6.4 必须解决缺失 Tool Result 的 Provider History。

## 22. 与现有架构兼容性

- RecoveryReview 继续单记录。
- RecoveryScanner/Manager/Classifier/Gate 保留。
- LeaseHeartbeat/ExecutionAuthority/UoW permit 保留。
- ToolRun unknown 语义不变。
- Step 6.2 Read Recovery 语义不变。
- PlanStep CHECK 不重建。
- 普通 Planner/Scheduler 通过 execution_plans.purpose 排除 recovery evidence。
- Task terminal guard 增加 trusted unknown resolution 检查。

## 23. 评审确认项

1. 接受三种 Task terminal invariant。
2. 接受 Legacy conflict 永久锁定。
3. 接受 v1 唯一 Lease-owned decision entry。
4. 接受 recovery_evidence ExecutionPlan 方案。
5. 接受 Evidence digest/source-specific schema。
6. 接受 operation request 表和 Events unique index。
7. 接受六个子步骤顺序。
