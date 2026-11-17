# Phase 3 Step 6.3.3 Supplementary Review

> 审查类型：只读 Evidence Auditability Review
>
> 结论：原始审查发现的 evidenceRef、来源时间、resource version 和 Payload
> 可达性缺口已由 Step 6.3.3.1 修复。当前实现通过 immutable Manifest、
> 完整 Event 审计字段和内容寻址 Payload Store 支持历史追溯。
>
> 建议：正式验收 Step 6.3.3。
>
> 阅读说明：§2-§8 保留 6.3.3.1 修复前的原始审查快照，用于说明问题来源；
> 当前实现与修复证据以 §10-§12 为准。

## 1. 审查范围与实际读取源码

本次实际读取：

- `docs/PHASE3_STEP6_3_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_3_DEVELOPMENT_REPORT.md`
- `src/recovery/recovery-review-submission.ts`
- `src/recovery/recovery-review-decision-service.ts`
- `src/recovery/recovery-manager.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/recovery-review-operation-repository.ts`
- `src/storage/recovery-review-operation-keys.ts`
- `src/storage/recovery-review-repository.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/types.ts`
- `src/storage/migrations/004-phase3-step6-3-1.ts`
- `src/storage/migrations/005-phase3-step6-3-2.ts`
- `src/storage/migrations/006-phase3-step6-3-2-1.ts`
- `tests/recovery/recovery-evidence-submission.test.ts`

本次没有修改生产代码、测试或数据库 Schema，没有执行 Recovery、Write、
Provider、Verifier 或 Read-back。

## 2. RecoveryReview 当前字段的覆盖语义

`RecoveryReview` 是单记录模型，Evidence Submission 使用 UPDATE 覆盖当前
evidence metadata：

- `src/storage/execution-unit-of-work.ts:1889-1901`

该 UPDATE 覆盖：

- `evidence_ref`
- `evidence_payload_digest`
- `evidence_payload_type`
- `evidence_digest_protocol`
- `evidence_envelope_digest`
- `actor_id`
- `verifier_id`
- `verification_id`
- `source_observed_at`
- `submitted_at`

`RecoveryReviewRecord` 确实只暴露最新值：

- `src/storage/types.ts:440-462`

因此 Submission B 会覆盖 Submission A 的当前 evidence metadata。旧值必须
由 Event/Operation 等 append-only 记录保留，不能依赖 Review 主记录。

## 3. Event / Operation 保存的历史字段

### 3.1 `recovery.evidence.submitted` Event

实际 Event payload：

- `src/storage/execution-unit-of-work.ts:1916-1945`

保存：

- reviewId
- toolRunId
- sourceType
- outcome
- payloadType
- payloadDigestProtocol
- payloadDigest
- envelopeDigest
- actorId / verifierId / verificationId
- decisionVersion
- operationRequestKey
- fencingToken
- trustStatus / finalEligible / trustReason
- Event 自身的 createdAt

没有保存：

- `evidenceRef`
- `sourceObservedAt`
- `submittedAt`
- `resourceRef`
- `resourceVersion`
- 原始 payload content

### 3.2 `recovery_review_operations`

Operation record 实际字段：

- `src/storage/types.ts:493-508`
- `src/storage/migrations/005-phase3-step6-3-2.ts:21-55`

保存：

- requestKey
- operation
- expected/resulting decisionVersion
- status
- actorId
- operationPayloadDigest
- evidenceEnvelopeDigest
- appliedEventId

没有字段保存：

- evidenceRef
- sourceObservedAt
- resourceRef/resourceVersion
- source-specific verifier timestamps

`applied_event_id` 可以把 requestKey 对应到 Event，但没有弥补 Event 中缺失的
Evidence reference 字段。

### 3.3 TaskSnapshot

TaskSnapshot 可以读取：

- 所有 Events
- 所有 RecoveryReviewOperations

源码：

- `src/storage/task-snapshot.ts:65`
- `src/storage/task-snapshot.ts:82`

所以审计轨迹“可读取”的前提是字段已经写入 Event/Operation。当前缺失字段无法
通过 Snapshot 查询恢复。

## 4. evidenceRef 历史保留结论

逐项回答：

1. 每次 Submission 的 `evidenceRef` 没有写入独立 Event。
2. `evidenceRef` 被 Envelope Digest 计算输入包含，因此理论上某个候选 ref
   可以参与重新计算，但 Digest 不可逆，不能从 Digest 恢复 ref。
3. 后续 Submission 覆盖 Review.evidenceRef 后，旧 evidenceRef 不可查询。
4. Operation 只有摘要字段，Event 也没有实际 evidenceRef，因此两者都没有
   保留可读取的旧引用。
5. TaskSnapshot 能读取 Event/Operation 集合，但不能恢复未持久化的 ref。

严重性：高。

这不仅影响人工审计，也阻止未来 EvidenceVerifier 根据历史 Submission 重新
定位并校验 A/B/C。

## 5. Payload 保留与重新获取

### 5.1 当前 Payload 处理

Submission 输入包含 `payloadContent`：

- `src/recovery/recovery-review-submission.ts:50-75`

Service 使用它重新计算 Payload Digest：

- `src/recovery/recovery-review-submission.ts:164-187`

但 `payloadContent` 只参与即时 Digest 计算，没有写入：

- RecoveryReview
- Event
- Operation
- 独立 Evidence Store

### 5.2 按 Payload Type

| Payload Type | Payload 已保存 | Digest 已保存 | 未来重新获取路径 |
| --- | --- | --- | --- |
| `raw_bytes` | 否 | 是 | 只能依赖稳定 evidenceRef；当前历史 ref 丢失 |
| `json` | 否 | 是 | 只能依赖稳定 evidenceRef；当前历史 ref 丢失 |
| `external_reference` | 否 | 是 | `resourceRef/resourceVersion` 未落库，无法定位版本 |
| `readback_result` | 否 | 是 | 只能依赖 evidenceRef/Read ToolRun；当前历史 ref 丢失 |

### 5.3 三者必须区分

当前状态：

```text
Digest 已保存             = Yes
Payload 已保存            = No
Payload 未来可重新获取    = 不能保证
```

`evidenceRef` 当前只是非空字符串：

- `src/recovery/recovery-review-submission.ts:52`

没有 Adapter、ACL、不可变版本、内容寻址或 retention 保障。不能把它视为已经
受控且稳定的 Evidence Store 引用。

`external_reference` 的 `resourceRef/resourceVersion` 只参与 Envelope Digest，
没有进入 RecoveryReview 或历史记录。后续 Submission 后也无法恢复。

### 5.4 证据不可访问时

当前实现会让 Review 保持 active/unverified：

- `verifiedAt = NULL`
- Event `trustStatus = unverified`
- Event `finalEligible = false`

这符合“未验证证据不能完成 final decision”的安全方向，但当前数据库没有逐次
Submission 的 availability/retention 状态，无法区分：

- 从未验证；
- 验证失败；
- Evidence 已删除；
- Evidence 被替换；
- Evidence 永久不可达。

## 6. 多次 Evidence Submission 的追踪结果

场景：

```text
submit Evidence A
mark unresolved A
submit Evidence B
mark unresolved B
submit Evidence C
```

当前可追溯性：

| 字段 | A | B | C | 结论 |
| --- | --- | --- | --- | --- |
| evidenceRef | 否 | 否 | 仅 Review 当前值 | 历史不可查 |
| Envelope Digest | 是 | 是 | 是 | Event 可查 |
| Payload Digest | 是 | 是 | 是 | Event 可查 |
| actor/verifier | 是 | 是 | 是 | Event 可查 |
| sourceObservedAt | 否 | 否 | 仅 Review 当前值 | 历史不可查 |
| unresolved reason | 是 | 是 | 不适用 | Event 中保留 |
| requestKey -> Event | 是 | 是 | 是 | Operation.appliedEventId |

因此 A/B/C 的 Digest 和部分身份可以查询，但 Evidence reference 和来源观察
时间不能完整恢复。

现有测试没有覆盖 A/B/C 三次成功 Submission：

- `tests/recovery/recovery-evidence-submission.test.ts:497-565` 只执行一次
  Evidence Submission，随后两次 unresolved。
- 测试 helper 固定使用 `audit://evidence/1`：
  `tests/recovery/recovery-evidence-submission.test.ts:800`。

## 7. unresolved Reason 与 Evidence 关联

`recovery.review.unresolved` Event 保存：

- reviewId
- toolRunId
- reason
- referencedEvidenceEnvelopeDigest
- decisionVersion
- operationRequestKey
- actorId
- fencingToken

源码：

- `src/storage/execution-unit-of-work.ts:2159-2176`

因此每次 unresolved 的 reason 和 Evidence Digest 关联可追溯，前提是 Event
未被删除，而 append-only Trigger 已提供该保护。

问题在于：

- Event 只关联 Envelope Digest，不关联 evidenceRef。
- 如果 Envelope Digest 对应多份实际内容且无法重新获取 Payload，人类审计仍
  无法判断当时具体使用了哪份外部材料。

## 8. 并发、幂等与事务

已确认：

- 同 requestKey 重放返回原 Operation。
- 重放不重复 Event/Operation/Checkpoint。
- 同 requestKey 不同内容拒绝。
- 不同 Evidence 会改变 Envelope Digest，因为 evidenceRef、sourceObservedAt、
  resource metadata、identity 和 Digests 均参与 Envelope Digest。
- Event 或 Checkpoint 写入失败时，Review CAS 和 Operation 整体 rollback。
- 多次 unresolved 的 reason 分别写 Event。

但“旧 evidenceRef 不会因新提交消失”不成立。测试也只验证了 Operation/Event
数量，没有直接查询旧 evidenceRef 是否仍存在。

## 9. 原始问题与修复状态

### 原始 P1：历史 evidenceRef 未持久化，已修复

- 当前 Review 被后续 Submission 覆盖。
- Event 没有 evidenceRef。
- Operation 没有 evidenceRef。
- TaskSnapshot 无法恢复 A/B/C refs。

位置：

- `src/storage/execution-unit-of-work.ts:1889-1945`
- `src/storage/types.ts:493-508`

### 原始 P1：sourceObservedAt/resource metadata 未持久化，已修复

- `sourceObservedAt` 只更新 Review 当前字段。
- `resourceRef/resourceVersion` 不进入 RecoveryReview、Event 或 Operation。
- `external_reference` 无法靠 TaskSnapshot 重新定位到具体资源版本。

### 原始 P1：没有 Payload Store，已修复

- raw/json/readback Payload 不保存。
- evidenceRef 没有 Adapter/ACL/immutability/retention 保证。
- Verifier 无法保证重新取得与历史 Payload Digest 相同的内容。

### 原始 P2：缺少 A/B/C 审计测试，已修复

现有测试主要覆盖单次 Submission、幂等和两次 unresolved，没有验证三次独立
Evidence 的 refs、timestamps、resource metadata 和 requestKey/Event 连接。

### 原始 P2：证据可用性审计不存在，已建立约定

Step 6.3.3.1 新增 availability audit Zod 约定：

- never_checked
- available
- unavailable
- expired
- replaced
- digest_mismatch

Manifest 保持 immutable，后续状态继续通过 append-only Event 记录。实际
availability writer 和 Verifier 仍属于 Step 6.3.4。

## 10. 6.3.3.1 修复结果

Migration v7 新增 immutable `recovery_evidence_submissions`，每条成功
`submit_evidence` 独立保存：

- evidenceRef
- resourceRef/resourceVersion
- sourceObservedAt/submittedAt
- actor/verifier/verificationId
- payload/envelope digests
- payloadStoreRef/storageMode
- requestKey
- operationId/appliedEventId

任务 Event 同步增加 evidenceSubmissionId 和完整来源字段。Manifest、Operation、
Event 使用同 Task 复合外键和 Trigger 校验，Manifest 禁止 UPDATE/DELETE。

raw/json/readback Payload 先写入本地内容寻址 Store，再提交 SQLite。Store ref
稳定，读取时重新计算 Digest。external_reference 记录为 `reference_only`，
明确不可声称已保存或已可信。

TaskSnapshot 新增 `recoveryEvidenceSubmissions`。A/B/C 测试已验证三个 ref、
resource version、sourceObservedAt、identity、Digest、requestKey 以及
Operation/Event 关联均可读取。

实际验证：

- `pnpm test`：39 个测试文件、313 项测试全部通过。
- `pnpm typecheck`：通过。
- `git diff --check`：退出码 0，无 whitespace error；仅有既有 LF/CRLF
  提示。

## 11. 当前剩余限制

- 本地文件 Store 没有分布式复制、ACL API 或自动 retention。
- SQLite 失败后可能留下 orphan Payload，本步骤不自动回收。
- availability audit 目前只有数据契约，Verifier/writer 属于 Step 6.3.4。
- Migration v7 不回填旧 Submission，旧记录仍无法重建缺失字段。
- external_reference 不会被标记 available/trusted。

## 12. 建议

建议正式验收 Step 6.3.3 的 Evidence Auditability。原始阻断问题已经修复，
新测试覆盖 A/B/C 历史、Payload 重读/篡改/删除、Manifest 不可变性和迁移
兼容性。

本步骤没有进入 Step 6.3.4。

## 13. Final Source Verification

### 13.1 本次实际读取

本轮重新读取：

- `src/recovery/evidence-payload-store.ts`
- `src/storage/recovery-evidence-submission-repository.ts`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/types.ts`
- `tests/storage/step6-3-3-1-schema.test.ts`
- `tests/recovery/recovery-evidence-submission.test.ts`
- `.gitignore`

### 13.2 Manifest SQL 约束

Migration v7：

- 创建 `recovery_evidence_submissions`。
- 创建 `ux_recovery_review_operations_task_id` 复合父键。
- `UNIQUE(request_key)`。
- `UNIQUE(operation_id)`。
- `UNIQUE(applied_event_id)`。
- Review、ToolRun、Operation、Event 都使用 `(task_id, foreign_id)` 复合外键。

源码位置：

- `src/storage/migrations/007-phase3-step6-3-3-1.ts:12`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts:15`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts:71-73`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts:103-109`

Trigger：

- 校验 Operation 为 applied 的 `submit_evidence`。
- 校验 requestKey、decisionVersion、envelopeDigest 和 appliedEventId。
- 校验 Event 类型、Review entity。
- 校验 Event payload 的 evidenceSubmissionId、evidenceRef 和
  envelopeDigest。
- UPDATE / DELETE Trigger 拒绝修改历史。

源码位置：

- `src/storage/migrations/007-phase3-step6-3-3-1.ts:116-138`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts:144`
- `src/storage/migrations/007-phase3-step6-3-3-1.ts:150`

结论：

- 正常 UoW 路径每次成功 submit 恰好插入一条 Manifest。
- 数据库保证每个 Operation 至多一条 Manifest，但没有反向 Trigger 强制
  “每个新 submit Operation 必须立即有 Manifest”。这是应用事务路径保证，
  不是完整的数据库反向恒等式。
- Cross-Task 关联由复合外键阻止。
- Review 的绑定 ToolRun 与 Manifest ToolRun 的相等性由 UoW 应用层保证；
  DB 只保证 Manifest ToolRun 与 Review 属于同一 Task。
- Event 的 evidenceSubmissionId/evidenceRef/envelopeDigest 由 Trigger 绑定；
  Event 的其余来源字段由应用写入，未逐字段与 Manifest 比较。

这些属于纵深防御缺口，不破坏当前唯一 UoW 写入路径。

### 13.3 Payload Store

源码：

- `src/recovery/evidence-payload-store.ts:28-64`
- `src/recovery/evidence-payload-store.ts:70-81`
- `src/recovery/evidence-payload-store.ts:93-118`

确认：

- `raw_bytes`、`json`、`readback_result` 都由 Service 转为 bytes 后调用
  Store。
- 文件名由严格验证的 SHA-256 digest hex 生成。
- storeRef 为 `evidence-file:sha256/<digest>`。
- 临时文件位于同一受控目录。
- temp file 完整写入后使用 hard link 创建最终文件。
- EEXIST 时读取已有内容并校验 Digest，不覆盖。
- 读取时重新计算 SHA-256。
- 缺失或权限错误会直接抛底层 filesystem error。
- 内容替换会抛 `EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH`。

文件系统与 SQLite 不是分布式原子事务。Payload 先写，SQLite 失败只会留下
可回收 orphan；Manifest 不存在，调用返回失败。测试验证了这一点。

剩余边界：

- hard link 依赖同一文件系统且目标 FS 支持 hard link。
- 没有 fsync/目录 fsync，电力故障持久性未完全证明。
- filesystem error 没有统一转换为脱敏 AppError，可能包含本地路径。
- Store 在 requestKey 校验前执行；错误 requestKey 理论上可产生 orphan。

### 13.4 Git 与目录安全

`.gitignore` 使用 `data/` 排除整个运行数据目录，覆盖
`data/evidence`。证据文件名完全由 digest 生成，没有用户路径拼接。临时文件
位于同一目录。源码没有打印 Payload 内容。

### 13.5 A/B/C 数据读取

`tests/recovery/recovery-evidence-submission.test.ts:734` 使用真实
`TaskSnapshotReader` 重新读取 SQLite，而不是只检查内存对象。

测试验证：

- 三条 Manifest。
- A/B/C 不同 evidenceRef。
- 不同 resourceVersion。
- 不同 sourceObservedAt。
- actor/verifier 区分。
- 各自 payload/envelope digest。
- 各自 requestKey。
- Manifest -> Operation。
- Manifest -> Event。
- unresolved reason 与 Envelope Digest。

Payload 测试使用实际临时文件 Store，重新读取、替换和删除均经过真实
filesystem。

### 13.6 TaskSnapshot

TaskSnapshot 在同一 read transaction 中读取：

- Events。
- Operations。
- Reviews。
- Evidence Submissions。

源码：

- `src/storage/task-snapshot.ts:69`
- `src/storage/task-snapshot.ts:84-89`

Manifest 查询按 `decision_version, created_at, id` 稳定排序：

- `src/storage/recovery-evidence-submission-repository.ts:216-223`

Repository 支持 requestKey 和 operation 查询；Task/Review/ToolRun 维度可从
Snapshot 过滤。没有单独 `getByToolRun` 索引 API，但不影响当前审计读取。

### 13.7 最终结论

原始 P1 的 evidenceRef、来源时间、resource version 和 Payload 可达性缺口
已修复。A/B/C 历史、Digest 重算、Manifest 不可变性和 SQLite 失败 orphan
行为都有真实源码与测试依据。

剩余问题为纵深防御和运维边界，不阻断 Step 6.3.3 审计能力验收：

- 数据库没有反向强制所有 submit Operation 必须有 Manifest。
- Review/ToolRun 相同绑定主要由 UoW 保证。
- 文件错误未统一脱敏。
- 无 fsync、ACL API、retention 或 orphan GC。
- availability audit writer 属于 Step 6.3.4。

建议正式验收 Step 6.3.3，并将上述限制带入 Step 6.3.4 设计。

### 13.8 本轮额外测试证据核查

已确认 A/B/C 测试使用真实 `TaskSnapshotReader`，不是内存对象拼接。

仍有两个非阻断测试缺口：

- 尚未直接插入跨 Task Manifest 或同 Task 错误 ToolRun Manifest 做 Trigger/
  复合外键负例；当前只检查了 FK/Trigger 存在性。
- A/B/C 测试验证了 unresolved reason，但没有逐条断言 unresolved Event 的
  `referencedEvidenceEnvelopeDigest` 等于 A/B 对应 Envelope Digest。源码确实
  写入了该字段：
  `src/storage/execution-unit-of-work.ts:2169-2171`。

上述缺口不改变当前源码结论，但建议在后续回归中补齐负例和精确关联断言。

### 13.9 Final Recommendation

建议正式验收 Step 6.3.3 Evidence Auditability。

原始 P1 问题已经由真实 Schema、UoW、Snapshot 和 Payload Store 修复。剩余项为
纵深防御、异常脱敏、运维 retention/orphan GC，以及少量测试缺口，不阻断当前
Step 6.3.3 验收，也不属于进入 Step 6.3.4 的前置阻塞。
