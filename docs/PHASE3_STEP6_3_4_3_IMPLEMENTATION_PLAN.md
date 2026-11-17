# Phase 3 Step 6.3.4.3 Implementation Plan

> 状态：Final Exact Replay Concurrency Correction，等待评审通过
>
> 范围：Stored Evidence V0 Payload 加载、Runtime Integrity、Authenticity
> 边界、Host Verifier 执行、ExecutionAuthority、Cancel/Pause Gate 和
> Verification 持久化
>
> 边界：不执行 Read-back、Provider、LLM 或 Write，不修改 Task.status，
> 不进入 Step 6.3.4.4 / Step 6.3.5

## 1. 前置源码核查

### 1.1 Payload Store

实际接口：

```text
EvidencePayloadStore.put(bytes, expectedDigest)
  -> { storeRef, storageMode }

EvidencePayloadStore.read(storeRef, expectedDigest)
  -> Uint8Array
```

`FileEvidencePayloadStore`：

- Store reference 格式固定为
  `evidence-file:sha256/<64 lowercase hex>`。
- `put()` 对传入的原始字节计算 SHA-256。
- `read()` 校验 storeRef 与调用方传入的 expectedDigest 一致。
- `read()` 对文件原始字节再次计算 SHA-256。
- 不接受任意本地路径。

因此 `read(storeRef, expectedDigest)` 校验的是**存储文件的原始字节
SHA-256**，不是 `RecoveryEvidenceEnvelope.payloadDigestProtocol` 的通用
语义解释器。

### 1.2 Manifest Payload Digest

`RecoveryEvidenceSubmissionRecord` 已持久化：

```text
payloadType
payloadDigestProtocol
payloadDigest
payloadStoreRef
payloadStorageMode
```

`computeSubmittedEvidencePayloadDigest()`：

- `raw_bytes`：原始 bytes SHA-256。
- `json`：JCS + SHA-256。
- `readback_result`：Readback Result Schema 校验后 JCS + SHA-256。
- `external_reference`：当前仅接受声明 Digest，没有受控 Adapter。

`submittedEvidencePayloadBytes()`：

- `raw_bytes`：写入原始 bytes。
- `json`：先写 canonical JSON bytes。
- `readback_result`：先写 canonical JSON bytes。
- `external_reference`：不写入文件。

当前写入期关系：

```text
raw_bytes:
  storage bytes digest = Manifest.payloadDigest

json / readback_result:
  canonical storage bytes SHA-256 = Manifest.payloadDigest
```

测试依据：

- `tests/recovery/recovery-evidence-submission.test.ts` 对 raw/json
  Manifest 分别使用其 Store ref 和 Manifest payloadDigest 成功读取。
- 同一测试验证文件被替换后 Store Digest 失败，文件删除后读取失败。

这是当前**写入路径的不变量**，不能被扩大解释为 Payload Store 在所有
未来协议版本中都只保存“语义 Digest”。

### 1.3 Verification Check / UoW

Migration v8 已持久化：

```text
check_origin
verifier_id
verifier_version
verifier_config_digest
allowlist_id / allowlist_version
read_tool_name / version / schema_hash
expected_payload_digest
```

`RecoveryEvidenceUnitOfWork` 已强制：

- Lease / fencing ownership。
- 构造时注入的 local ExecutionAuthority guard。
- Task version CAS。
- Stored V0 Check exact replay。
- Verification exact replay。
- Availability Event / optional Verification Event / Verification /
  Checkpoint 的原子提交。

### 1.4 Verifier Registry

Registry 提供 Host-only 注册、兼容性 resolve、Result Schema 与 Trust
条件校验。

当前限制：

- Verifier Definition 没有持久化 timeout 字段。
- Migration v8 没有 Authenticity evaluator ID/version、Trust Anchor ID
  或 Trust Anchor config digest 字段。

Step 6.3.4.3 不新增 Migration。无法可靠持久化的 Authenticity 配置必须
fail closed。

## 2. Payload Digest Contract

### 2.1 三层 Digest

实现必须显式区分：

```text
storageDigest
  文件原始字节 SHA-256

semanticDigest
  Manifest.payloadDigestProtocol 定义的逻辑 Digest

manifestDigest
  Manifest.payloadDigest
```

### 2.2 加载与校验顺序

```text
Manifest.payloadStoreRef
  -> strict format validation
  -> derive storageDigestFromStoreRef
  -> PayloadStore.read(storeRef, storageDigestFromStoreRef)
  -> actualStorageDigest
  -> decode bytes according to payloadType
  -> actualSemanticDigest
  -> compare actualSemanticDigest with Manifest.payloadDigest
```

禁止直接把 Manifest semantic digest 作为 Store 读取参数，从而把
storage integrity 与 semantic integrity 合并成一次检查。

即使当前 raw/json/readback_result 写入路径生成的两个 Digest 相等，运行时
仍必须分别计算和校验。

### 2.3 Payload Type 规则

```text
raw_bytes:
  raw bytes -> semantic digest = raw bytes SHA-256

json:
  bytes -> JSON parse -> JCS -> SHA-256

readback_result:
  bytes -> RecoveryReadbackResultSchema.parse
         -> JCS -> SHA-256

external_reference:
  reference_only
  -> 无受控 Adapter
  -> unavailable / unverified / not_run
```

`payloadType=readback_result` 不表示受控 Runtime Read-back。Stored
Evidence V0 的 declared readback_result 只能使用 `declared_payload`
provenance。

## 3. Immutable Verification Configuration

### 3.0 Check ID / Request Key 生命周期

`verificationCheckId` 必须由 Host API 在发起逻辑验证请求时生成，并作为
`verifyStoredEvidence()` 的必填输入。Service 不得在每次调用时自动生成新
Check ID。

规则：

- 同一逻辑验证请求、同一绑定和所有重试复用原 Check ID。
- 新的明确验证请求才分配新 Check ID。
- Check ID 进入稳定 requestKey 的 JCS 输入。
- Request Key 还包含 Task / Review / Manifest / Original Write /
  verifier binding / expected payload digest。
- URL、时间戳和非请求身份字段不得进入 requestKey。
- Check 已存在时，从持久化 Check 读取原配置并重算 requestKey；
  不使用当前 Registry 最新配置替代历史绑定。
- Check ID 相同但 requestKey 或 binding 不同：拒绝，不创建新 Check。

拟新增稳定计算：

```text
computeStoredEvidenceVerificationRequestKey({
  "taskId": taskId,
  "reviewId": reviewId,
  "evidenceSubmissionId": evidenceSubmissionId,
  "originalToolRunId": originalToolRunId,
  "verificationCheckId": verificationCheckId,
  "checkOrigin": "stored_evidence_v0",
  "verifierId": verifierId,
  "verifierVersion": verifierVersion,
  "verifierConfigDigest": verifierConfigDigest,
  "allowlistId": allowlistId,             // null for Stored V0
  "allowlistVersion": allowlistVersion,   // null for Stored V0
  "readToolName": readToolName,           // null for Stored V0
  "readToolVersion": readToolVersion,     // null for Stored V0
  "readToolSchemaHash": readToolSchemaHash, // null for Stored V0
  "expectedPayloadDigest": expectedPayloadDigest
})
```

canonical protocol 必须带固定 domain/version，并使用现有 canonical JSON +
SHA-256。

NULL canonicalization：

- Stored Evidence V0 不使用 Read Tool / Allowlist。
- allowlistId、allowlistVersion、readToolName、readToolVersion、
  readToolSchemaHash 必须在 JCS input 中显式出现并取值 `null`。
- 不得省略字段，也不得使用空字符串、占位 ID 或当前 Host 默认值。
- `verificationCheckId`、checkOrigin、verifier binding 和 expected digest
  仍为必填非 NULL 值。

### 3.0.1 Check ID Transactional Replay Lookup

Exact replay 的权威判断必须在
`RecoveryEvidenceUnitOfWork.createOwnedRecoveryEvidenceVerificationCheck()`
的 SQLite immediate transaction 内完成，不能依赖 Service 先前读取的
TaskSnapshot 是否已看到 Check。

UoW 输入：

- ownership / expected task version。
- Host-provided verificationCheckId。
- Task / Review / Evidence Submission / Original Unknown Write logical
  identity。
- expected payload digest。
- lazy Host Verifier Binding provider。

事务顺序：

```text
Lease / fencing / mandatory ExecutionAuthority
  -> begin immediate SQLite transaction
  -> lookup Check by (taskId, verificationCheckId)
  -> exists:
       -> load persisted Check binding
       -> validate logical identity
       -> validate Check ID binding
       -> use persisted verifier ID/version/config digest
       -> do not invoke current Host Binding provider
       -> lookup Verification by verificationCheckId
            -> exists: return persisted Verification
            -> missing: return pending
       -> no Event / Checkpoint / row writes
  -> missing:
       -> invoke Host Binding provider
       -> validate new verifier binding
       -> compute stable requestKey
       -> requestKey exact replay lookup
            -> hit: return existing Check/persisted result
       -> latest Cancel/Pause intent check
       -> Task version CAS
       -> insert new Check
       -> Checkpoint
```

如果存在 Check，Service 不得先用当前 Registry / Host Config V2 重算 binding。
Host Binding provider 只在 Check ID miss 后执行。

### 3.0.2 Existing Check Binding Comparison

同一 verificationCheckId 必须绑定唯一逻辑身份。持久化 Check 以下字段必须与
本次调用身份一致：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
checkOrigin = stored_evidence_v0
```

以下配置字段来自持久化 Check，不由本次 Host Config 重写：

```text
verifierId
verifierVersion
verifierConfigDigest
allowlistId / allowlistVersion
readToolName / version / schemaHash
expectedPayloadDigest
```

任一逻辑身份不匹配：

```text
RECOVERY_EVIDENCE_VERIFICATION_CHECK_ID_CONFLICT
```

不得创建第二个 Check，不得修改原 Check，不得返回其他 Task/Review 的结果。

当前 Registry / Host 配置更新只影响新 Check；已有 Check 的 exact replay
必须继续使用持久化 binding。

### 3.1 可以复用 v8 固定的数据

Step 6.3.4.3 Check 创建时固定：

- verifier ID / version。
- verifier config digest。
- allowlist ID / version。
- read tool ID / version / schema hash（如果适用）。
- expected payload digest。
- checkOrigin。

创建 Host Verifier Binding 时，Service 不得用当前 Registry 中的新版本冒充
调用方指定的原版本。新 Check 的 binding 必须比较：

```text
Check.verifierId
Check.verifierVersion
Check.verifierConfigDigest
Check.expectedPayloadDigest
```

新 Check binding 任一不匹配时：

- 不调用 Verifier。
- Verification 记录为 `not_run`。
- 不创建 Verification Event。

### 3.2 Verifier Timeout Configuration

现有 v8 Check 没有独立 timeout 字段。计划将 timeout 纳入 Host Verifier
Effective Config，并纳入 `verifierConfigDigest`：

```text
VerifierEffectiveConfig
  verifierId
  verifierVersion
  timeoutMs
  rule config
  allowlist config
  read tool schema hash
  protocol version
```

Service 创建新 Check 前冻结该 Effective Config。运行已有 Check 时只使用
Check 持久化的 verifier ID / version / config digest；Host 必须能从受控
配置目录精确恢复同一 binding，否则 fail closed。Config 或 timeout 改变时
不得继续使用旧 Check 执行新配置。

### 3.2.1 Host Verifier Binding 与 Runtime Resolve

Host Verifier Binding 发生在 Check 创建前：

```text
Host definition
  -> verifierId / version
  -> Effective Config
  -> timeoutMs
  -> config digest
  -> Check binding
```

v8 `recovery_evidence_verification_checks` 的 verifierId、version 和
configDigest 均为 NOT NULL。因此没有可用 Host binding 时：

- 不创建 Check。
- 不写入 placeholder verifier。
- 不伪造 digest。
- 返回明确的 Host binding 错误。

Runtime Resolve 发生在 Integrity 通过后：

```text
persisted Check binding
  -> exact Registry definition
  -> version/config digest comparison
  -> run Verifier
```

Exact Replay 命中时：

- 使用持久化 Check 原 binding。
- 不根据当前 Registry 最新版本重算 check binding。
- Verification 已存在则直接返回。
- Verification 不存在则返回 pending，不进入 Runtime Resolve。

Stored Evidence V0 不需要 Read Tool / Allowlist，持久化字段使用 v8 Schema
允许的 NULL。不得填假值。

### 3.3 Authenticity 配置限制

v8 Check 没有：

- Authenticity evaluator ID / version。
- Trust Anchor ID / version。
- Trust Anchor config digest。

本步骤不增加 Migration，因此 Authenticity 必须 fail closed：

- 不执行非权威 Trust Anchor / Authenticity evaluator 预检。
- 最终持久化只能是 `unverified`。
- 不允许持久化 `manual_attested`。
- 不允许持久化 `system_verified`。
- 不允许使用进程当前 Trust Anchor 宣称历史 Check 已被可信认证。
- Verifier 的 `system_verified` / `manual_attested` 自报不能覆盖 Host
  结果。

`RecoveryVerifierRegistry.validateResult()` 仍执行现有 Schema 校验；
Service 最终使用 Runtime Integrity 与固定 `authenticity=unverified`
重写可持久化结果字段。

## 4. Stored Evidence V0 调用链

```text
RecoveryEvidenceVerificationService.verifyStoredEvidence()
  -> assert Lease / fencing ownership
  -> assert mandatory ExecutionAuthority
  -> load one consistent TaskSnapshot
  -> resolve Manifest / Review / Original Unknown Write
  -> RecoveryEvidenceUnitOfWork.createOrReplayVerificationCheck()
       -> immediate SQLite transaction
       -> lookup Check by Host-provided verificationCheckId
       -> existing Check:
            -> validate persisted logical identity
            -> use persisted verifier binding
            -> Verification exists: return persisted result
            -> Verification missing: return pending
            -> no Host binding provider call
            -> no payload read
            -> no Verifier call
            -> no Event / Checkpoint / row writes
       -> missing Check:
            -> invoke Host Binding provider
            -> compute stable verification request key with explicit NULLs
            -> requestKey exact replay lookup
            -> latest Cancel/Pause Intent check
            -> Task version CAS
            -> persist new Check + Checkpoint
  -> if existing Verification/pending: return without Payload load
  -> if new Check:
       -> assert no Cancel/Pause Intent before external payload work
  -> recheck Lease / Authority / Cancel/Pause
  -> load payload from Manifest Store reference
  -> Runtime storage digest validation
  -> Runtime semantic digest / Integrity validation
  -> Authenticity = unverified (no evaluator invocation)
  -> Runtime Resolve persisted Verifier binding from Registry
  -> invoke Verifier outside SQLite transaction
  -> post-verifier Lease / Authority / Cancel/Pause check
  -> recordOwnedRecoveryEvidenceVerification()
       -> exact replay lookup
       -> latest Cancel/Pause Intent check inside immediate transaction
       -> Availability Event
       -> optional Verification Event
       -> Verification row
       -> Checkpoint
```

Service 的 Snapshot 只用于读取不可变 Manifest / Review / Original Write
身份，不能作为 Check 是否存在的权威判断。Service 级检查不能替代 UoW
事务内的 Check ID lookup 和 Cancel/Pause gate。

## 5. Runtime Integrity

新增 Runtime Integrity executor，不把该职责交给 Verifier。

输出必须包含：

```text
availabilityStatus
integrityStatus
actualStorageDigest?
actualSemanticDigest?
reasonCode
```

`actualStorageDigest` / `actualSemanticDigest` 是 Runtime 内部可选值。
v8 Verification 表没有 storage digest 字段；`observed_payload_digest`
保存 Runtime 实际计算出的 semantic digest，且该列允许 NULL。

规则：

- Store reference 格式非法：`unavailable` / `not_checked`。
- Payload 缺失或 Store I/O 失败：`unavailable` / `not_checked`。
- 文件可读取但 File Digest mismatch：`available` / `mismatch`。
- 文件可读取但 Semantic Digest mismatch：`available` / `mismatch`。
- 两者均匹配：`available` / `matched`。
- Integrity 不匹配时，不进入 Authenticity 处理或业务 Verifier。

v8 已确认允许 Integrity=`not_checked | matched | mismatch`，也允许
`observed_payload_digest = NULL`。不得新增状态。

`digest_mismatch` 仍是 v8 Availability 允许值，但本步骤对“可读取内容但
Digest mismatch”统一使用 `available + integrity mismatch`，不把内容缺失
与完整性失败混为同一 Availability 维度。

### 5.1 Payload Store 错误分类

| Store 实际结果 | 识别方式 | Service 映射 |
|---|---|---|
| Store ref 非法 | `EVIDENCE_PAYLOAD_STORE_REF_INVALID` / `EVIDENCE_PAYLOAD_DIGEST_INVALID` | unavailable / not_checked |
| Payload 文件缺失 | Node `ENOENT` | unavailable / not_checked |
| 文件字节 Digest mismatch | `EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH` | available / mismatch |
| 其他普通 I/O failure | 非上述稳定 code 的同步异常 | unavailable / not_checked |
| 文件读取成功且 Store digest 正确 | `read()` 返回 bytes | 继续计算 semantic digest |

当前 `FileEvidencePayloadStore.read()` 的 Digest mismatch 异常不携带实际
Storage Digest，因此 Service 不得伪造 `actualStorageDigest`。缺失值保持
NULL；Verification 的 `observed_payload_digest` 也不得用 Manifest digest
回填。

公开 AppError / Event payload 不得包含本地路径、底层异常 message 或
stack。Service 只持久化稳定 reason code 和 redacted summary。

`observed_payload_digest` 只保存 Runtime 对实际内容重新计算出的 semantic
Digest，不直接复制 Manifest digest。

## 6. Authenticity

Authenticity 与 Integrity 独立。

当前 Step 6.3.4.3 的最终 Authenticity 固定为 `unverified`，原因是 v8
无法持久化 verifier/evaluator/trust anchor 的完整身份与配置。

Service 不执行非权威 Authenticity / Trust Anchor 预检。最终只能：

```text
authenticityStatus = unverified
```

禁止：

- Digest matched => system_verified。
- Verifier passed => manual_attested/system_verified。
- 进程当前 Trust Anchor 自动升级历史 Check。
- 用当前进程 Authenticity 配置补写历史 Check 的可信结论。

业务 Verification 可以仍为 `passed`，但 Authenticity 保持 `unverified`，
Final RecoveryReview 不得将其视为可信成功证据。

## 7. Verifier 执行与 Timeout

### 7.1 Registry 选择

Host 根据 Check 持久化值匹配 Registry：

```text
verifierId
verifierVersion
verifierConfigDigest
```

加：

- payloadType
- sourceType
- controlled hasReadback

Registry 未命中、版本不匹配、configDigest 不匹配：

```text
availabilityStatus = available
integrityStatus = matched
authenticityStatus = unverified
verificationStatus = not_run
verificationEventId = NULL
```

### 7.2 Verifier 已启动

Verifier 一旦进入 `verify()`：

- resolve：使用已校验 Result。
- reject：`inconclusive + VERIFIER_EXCEPTION`。
- timeout：`inconclusive + VERIFIER_TIMEOUT`。

Exception / timeout 都创建 Verification Event。

### 7.3 非协作式 Promise

Verifier timeout 不能强制终止任意 Promise。

实现必须：

- 先为原 Promise 注册 resolve/reject handler，避免迟到 reject 产生
  unhandled rejection。
- 使用单一 `settled` 状态。
- timeout 只能产生一次最终结果。
- 迟到 resolve/reject 只能被消费，不能第二次提交或覆盖已有结果。
- Verifier 不接收 Repository、UoW、Manifest writer 或数据库句柄。
- 当前 Verifier Contract 没有 AbortSignal；不得声称 timeout 已终止执行。
- 提交前重新检查 Lease、ExecutionAuthority 和 Cancel/Pause Intent。

## 8. Cancel / Pause Atomic Gate

### 8.1 UoW 修改

`RecoveryEvidenceUnitOfWork` 在以下方法对应的 immediate transaction 内检查
最新 Task intent：

```text
createOwnedRecoveryEvidenceVerificationCheck()
recordOwnedRecoveryEvidenceVerification()
```

`createOwnedRecoveryEvidenceVerificationCheck()` 顺序：

```text
Lease / Authority
  -> Check ID replay lookup
  -> existing persisted binding return / pending
  -> missing: Host Binding
  -> requestKey calculation + exact replay lookup
  -> latest Cancel/Pause check
  -> version CAS
  -> new Check
```

`recordOwnedRecoveryEvidenceVerification()` 顺序：

```text
Lease / Authority
  -> Verification requestKey replay lookup
  -> exact replay return
  -> latest Cancel/Pause check
  -> version CAS
  -> new Verification
```

因此现有 Verification 的只读 exact replay 不会因为 Cancel/Pause 被无条件
拒绝；但任何新的 Check / Verification 写入都会被阻止。

### 8.2 Service 检查

- Exact Replay 查询前不得用 Cancel/Pause 无条件拒绝只读重放。
- 新 Check 由 UoW 在事务内检查 intent。
- 新 Check 成功后、Payload 读取前：再次检查。
- Verifier 返回或 timeout 后、UoW 提交前：再次检查。
- UoW 事务内：最终权威检查。

Intent 出现后：

- 可保留 pending Check。
- 不伪造 Verification。
- 不自动创建新 Check ID。

## 9. Exact Replay Semantics

### 9.1 Check Replay

请求键由以下不可变值计算：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
verifierId
verifierVersion
verifierConfigDigest
allowlistId/version
readToolName/version/schemaHash
expectedPayloadDigest
verificationCheckId
```

Exact replay：

- 权威 lookup 在 UoW immediate transaction 内按 verificationCheckId 执行。
- Service Snapshot 不决定 Check 是否存在。
- Check 已存在且 Verification 已存在：返回持久化 Verification。
- Check 已存在但 Verification 不存在：返回 `pending`。
- Check 已存在时不执行当前 Host Binding provider。
- Check ID 相同但逻辑身份不同：拒绝。
- 不读 Payload。
- 不调用 Verifier。
- 不写 Event / Checkpoint。

只有 Check ID miss 后才执行 Host Binding 和 requestKey lookup。requestKey
对 Stored V0 的 Allowlist / Read Tool 字段必须显式包含 `null`。

### 9.2 Verification Replay

UoW `recordOwnedRecoveryEvidenceVerification()`：

- 先执行 Lease / Authority。
- 再查 requestKey。
- 命中且完整 binding 一致：返回原 Verification。
- 只有未命中才检查 Cancel/Pause、Task version 并写新结果。

## 10. Provenance Separation

`payloadType=readback_result` 与 `controlled_runtime_read` 完全独立。

Stored Evidence V0：

- Check origin 为 `stored_evidence_v0`。
- 不存在 Request / Attempt / Read ToolRun / EvidenceRead 链。
- Verifier Registry `hasReadback=false`。
- `readback_result` payload 的 provenance 只能是 `declared_payload`。

只有以下完整链存在时才能设置 `hasReadback=true` 和
`controlled_runtime_read`：

```text
Readback Request
  -> Read Attempt completed
  -> Read ToolRun succeeded
  -> 恰好一条 Tool Message
  -> Recovery Evidence PlanStep
  -> EvidenceRead
```

仅凭 payloadType 不得推导 controlled provenance。

## 11. Availability / Integrity / Verification Mapping

所有最终 Verification 都必须有 Availability Event。Verification Event
仅在 Verifier 实际启动时存在。

| 情况 | Availability | Integrity | Authenticity | Verification | availabilityEvent | verificationEvent |
|---|---|---|---|---|---|---|
| Store ref 非法 | unavailable | not_checked | unverified | not_run | 必填 | NULL |
| Payload ENOENT | unavailable | not_checked | unverified | not_run | 必填 | NULL |
| Store I/O failure | unavailable | not_checked | unverified | not_run | 必填 | NULL |
| File digest mismatch | available | mismatch | unverified | not_run | 必填 | NULL |
| Semantic digest mismatch | available | mismatch | unverified | not_run | 必填 | NULL |
| external_reference | unavailable | not_checked | unverified | not_run | 必填 | NULL |
| Registry miss/version/config mismatch | available | matched | unverified | not_run | 必填 | NULL |
| Verifier exception | available | matched | unverified | inconclusive | 必填 | 必填 |
| Verifier timeout | available | matched | unverified | inconclusive | 必填 | 必填 |
| Verifier passed | available | matched | unverified | passed | 必填 | 必填 |
| Verifier failed | available | matched | unverified | failed | 必填 | 必填 |
| Verifier inconclusive | available | matched | unverified | inconclusive | 必填 | 必填 |

约束：

- `verificationStatus=not_run` 必须 `verificationEvent=NULL`。
- 任何最终 Verification row 都必须有非空 `availability_event_id`。
- Availability Event 表示 Runtime 是否可读取/取得 Payload，不等同于
  Integrity 是否匹配。
- 不新增未批准状态。

## 12. 拟修改文件

生产代码：

- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/recovery-evidence-payload-integrity.ts`
- `src/recovery/recovery-evidence-authenticity.ts`
- `src/storage/recovery-evidence-verification-keys.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/recovery/index.ts`

测试：

- `tests/recovery/recovery-evidence-verification-service.test.ts`
- `tests/recovery/recovery-evidence-payload-integrity.test.ts`
- `tests/recovery/recovery-evidence-authenticity.test.ts`
- `tests/storage/recovery-evidence-verification-keys.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`

不新增 Migration，不修改数据库 Schema。

## 13. 测试矩阵

### Payload / Integrity

- Raw file storage digest 与 semantic digest 分别校验。
- JSON canonical bytes digest 正确。
- Semantic digest mismatch。
- File digest mismatch。
- ENOENT、I/O error、非法 store ref。
- external_reference fail closed。
- 可读 Digest mismatch 使用 available + mismatch。
- 所有最终 Verification 都有 Availability Event。
- 未启动 Verifier 时只有 Verification Event 为 NULL。

### Authenticity / Verifier

- Integrity matched + no Trust Anchor => unverified。
- Verifier passed 不能覆盖 unverified。
- 本步骤不调用非权威 Authenticity evaluator。
- Registry miss / version mismatch。
- Verifier exception、timeout、非协作 Promise 迟到 resolve/reject。
- Exception/timeout 生成 Verification Event。
- not_run 不生成 Verification Event。

### Replay

- Check exact replay + Verification exists。
- Check exact replay + pending，不读 Payload / 不调用 Verifier。
- Verification exact replay。
- Cancel/Pause 下 existing Verification replay 仍可返回。
- 同一逻辑请求所有重试复用同一 Check ID。
- Registry / Host config 更新后，旧 Check 仍可按持久化 binding replay。
- 新显式验证请求使用新 Check ID。
- 并发 Request A/B：A 提交 V1 Check 后，B 的 UoW lookup 必须看到 A，
  即使 B 先前 Snapshot 未看到。
- B 因 Check ID hit 不得调用 V2 Host Binding provider，也不得生成 V2
  requestKey 覆盖原 Check。
- 同 Check ID 不同逻辑身份拒绝。
- Exact Replay 不新增 Event / Checkpoint / Attempt / Check。

### Request Key

- Stored V0 allowlist/read tool 五个字段始终进入 JCS 且值为 `null`。
- 不得出现字段省略、空字符串或 placeholder identity。

### Authority / Intent Race

- Check 前 Cancel/Pause。
- Check 后、Payload 读取前 Cancel/Pause。
- Verifier 执行期间 Cancel/Pause。
- Lease expired / fencing stale。
- Authority revoked。
- Intent/Authority 失效后仅保留 pending Check。

### Provenance

- declared readback_result -> declared_payload。
- payloadType=readback_result 但无完整 Read 链 -> hasReadback=false。
- controlled provenance 缺少 Request/Attempt/ToolRun/Message/EvidenceRead
  任一节点时拒绝。

### Regression

- Step 6.3.4.2 Transaction B 完整原子性。
- Step 6.3.4.2 Authority replay 顺序。
- Step 6.1 至 Step 6.3.4.2 全量回归。

## 14. 风险与限制

- 本步骤不实现受限 Authenticity Trust Anchor 持久化，也不执行非权威
  evaluator 预检，因此 Authenticity 始终为 unverified。
- 本步骤不新增 Migration，Verifier timeout 只能通过 Host Effective
  Config 与 verifierConfigDigest 固定。
- `verificationCheckId` 必须由 Host 提供并跨重试复用；Service 不能临时
  生成新 ID。
- v8 没有 actualStorageDigest 字段；Storage Digest 只在 Runtime / Event
  payload 中作为安全审计值出现，Verification 只持久化 semantic
  `observed_payload_digest`。
- 当前 Verifier Contract 没有 AbortSignal，timeout 不能终止非协作 Promise。
- 不实现 Read-back、Provider、普通 Agent Resume、Task terminal decision
  或 Final RecoveryReview Decision。
- Verification 失败不会修改原始 ToolRun unknown 状态。

## 15. Architecture Review Revision Traceability

### 15.1 Payload Digest Contract

- 原问题：storage digest 与 semantic digest 关系未显式固定。
- 修订：两者分别计算；当前 canonical bytes 写入关系只作为源码/测试依据，
  不作为运行时跳过任一步的理由。

### 15.2 Immutable Configuration

- 原问题：Authenticity / timeout 配置未说明如何固定。
- 修订：Verifier config 与 timeout 纳入 verifierConfigDigest；
  Authenticity 因 v8 无持久化字段，统一 fail closed 为 unverified。

### 15.3 Timeout Semantics

- 原问题：异常、timeout、迟到 Promise 未明确。
- 修订：not_run / inconclusive / Event 规则固定，使用单次 settle 状态与
  handler 吞掉迟到 rejection。

### 15.4 Cancel / Pause Gate

- 原问题：Service 检查不能防止 TOCTOU。
- 修订：Check 创建和 Verification 提交均在 UoW immediate transaction 内
  检查最新 intent，且 exact replay 在 intent gate 之前。

### 15.5 Exact Replay

- 原问题：Cancel/Pause 可能误拒绝只读重放。
- 修订：先 Lease/Authority，再 requestKey replay；命中返回原结果/pending，
  只有 miss 才执行 intent gate 和新写入。

### 15.6 Provenance

- 原问题：readback_result 可能被误认为 controlled runtime read。
- 修订：hasReadback 只来自完整持久化关联链，Stored V0 始终 false。

### 15.7 Scope

- 不新增 Migration。
- 不修改生产代码、测试或依赖。
- 不执行测试。
- 不进入 Step 6.3.4.4 或 Step 6.3.5。

## 16. Final Architecture Review Corrections

### 16.1 本轮修订内容

1. Availability Event 与 Verification Event 在最终结果表拆成独立列。
2. 可读 Payload 的 File/Semantic Digest mismatch 统一为
   `available + integrity mismatch`。
3. 固定 Host-generated verificationCheckId 与稳定 requestKey 生命周期。
4. 区分新 Check 创建前的 Host Verifier Binding 与 Integrity 后的
   Runtime Resolve。
5. 固定 Payload Store 四类错误映射，并禁止公开路径。
6. Authenticity 不执行非权威预检，本步骤始终 unverified。

### 16.2 源码 / Schema 依据

Payload / Digest：

- `src/recovery/evidence-payload-store.ts`
- `src/recovery/recovery-review-submission.ts`
- `src/recovery/recovery-evidence.ts`
- `tests/recovery/recovery-evidence-submission.test.ts`

Verification Schema：

- `src/storage/types.ts`
- `src/storage/migrations/008-phase3-step6-3-4-2.ts`
- Migration v8 Verification tables / Triggers

UoW / Replay：

- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-verification-check-repository.ts`
- `src/storage/recovery-evidence-verification-repository.ts`

Verifier：

- `src/recovery/recovery-verifier-registry.ts`
- `tests/recovery/recovery-verifier-registry.test.ts`

v8 已核实允许：

```text
integrity_status:
  not_checked
  matched
  mismatch

availability_status:
  available
  unavailable
  expired
  replaced
  digest_mismatch

verification_status:
  not_run
  passed
  failed
  inconclusive
```

本计划不新增状态。

### 16.3 修正后的状态表

以 §11 为唯一最终状态矩阵。

关键规则：

- 所有最终 Verification 都有 Availability Event。
- `not_run` 时 Verification Event 必须 NULL。
- 可读但 Digest mismatch 使用 `available + mismatch`。
- Artifact 不可读取才使用 `unavailable + not_checked`。

### 16.4 Check ID / Request Key 生命周期

- verificationCheckId 由 Host 生成。
- 同一逻辑验证请求的所有重试复用同一 Check ID。
- 新显式验证请求才创建新 Check ID。
- requestKey 使用持久化 binding 的 canonical JCS + SHA-256。
- Check 已存在时从持久化 Check 重算 requestKey。
- Registry 配置更新不得改变旧 Check 的 exact replay 语义。

### 16.5 Host Binding / Runtime Resolve

- Host Verifier Binding 在新 Check 前冻结 verifier identity、version、
  effective config digest 和 timeout。
- 无 Host binding：v8 verifier 字段 NOT NULL，因此不能创建 Check。
- Stored V0 的 allowlist/read tool 字段使用 NULL。
- Runtime Resolve 仅在 Integrity 通过后进行，并只使用 Check 持久化配置。
- Exact Replay/pending 不进入 Runtime Resolve。

### 16.6 尚未解决的限制

- v8 无 Authenticity evaluator / Trust Anchor 持久化字段，本步骤固定
  unverified。
- v8 无独立 timeout 字段，timeout 只能通过 Host Effective Config 和
  verifierConfigDigest 绑定。
- v8 无 actualStorageDigest 字段；只持久化 nullable semantic
  `observed_payload_digest`。
- Verifier Contract 无 AbortSignal，timeout 不能终止非协作 Promise。

### 16.7 文档边界

本轮只修改本 Implementation Plan。

- 没有修改生产代码。
- 没有修改测试。
- 没有修改 Migration 或数据库 Schema。
- 没有新增依赖。
- 没有执行测试。
- 没有开始 Step 6.3.4.3 编码。
- 没有进入 Step 6.3.4.4 / Step 6.3.5。

## 17. Final Exact Replay Concurrency Correction

### 17.1 Check ID Transactional Replay Lookup

最终规则：

- UoW 在 create Check 的 immediate transaction 内，首先按
  `(taskId, verificationCheckId)` 查找持久化 Check。
- Snapshot 只用于读取不可变 Manifest / Review / Original Write 身份，
  不作为 Check 存在性的权威依据。
- Check 命中后使用持久化 binding，Host Binding provider 不执行。
- Check + Verification 命中返回持久化结果。
- Check 命中、Verification 缺失返回 pending。
- 两种命中均不写 Event / Checkpoint / row。
- Check ID miss 后才惰性获取新 Host Binding、计算 requestKey 并执行
  requestKey replay lookup。

并发窗口固定为：

```text
Request A commits Check(V1)
  -> Request B enters UoW transaction
  -> Check ID lookup sees Check(V1)
  -> B uses V1 persisted binding
  -> B does not use Host Config V2
```

### 17.2 Existing Check Binding Rules

同一 Check ID 必须保持：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
checkOrigin=stored_evidence_v0
```

以及持久化：

```text
verifierId/version/configDigest
allowlistId/version (V0 nullable)
readToolName/version/schemaHash (V0 nullable)
expectedPayloadDigest
```

逻辑身份不匹配时拒绝，禁止改写 Check 或另建 Check 掩盖冲突。

### 17.3 Request Key NULL Canonicalization

Stored Evidence V0 的 canonical JCS object 必须固定包含：

```text
allowlistId: null
allowlistVersion: null
readToolName: null
readToolVersion: null
readToolSchemaHash: null
```

不得省略，不得替换为空字符串或默认占位值。相同逻辑请求必须得到相同
requestKey；新 Check ID 才允许形成新的逻辑验证请求。

### 17.4 Source Locations

对应现有源码：

- `src/storage/recovery-evidence-unit-of-work.ts`
  - `createOwnedRecoveryEvidenceVerificationCheck()`
  - `recordOwnedRecoveryEvidenceVerification()`
- `src/storage/recovery-evidence-verification-check-repository.ts`
  - `getByCheckId()`
  - `getByRequestKey()`
- `src/storage/recovery-evidence-verification-repository.ts`
  - `getByCheckId()`
  - `getByRequestKey()`
- `src/storage/migrations/008-phase3-step6-3-4-2.ts`
  - Check ID unique constraints
  - nullable Stored V0 Allowlist / Read Tool fields

### 17.5 Documentation Boundary

本轮只更新本计划文档：

- 没有修改生产代码。
- 没有修改测试。
- 没有修改 Migration 或数据库 Schema。
- 没有新增依赖。
- 没有执行测试。
- 没有开始 Step 6.3.4.3 实现。
- 没有进入 Step 6.3.4.4 / Step 6.3.5。
