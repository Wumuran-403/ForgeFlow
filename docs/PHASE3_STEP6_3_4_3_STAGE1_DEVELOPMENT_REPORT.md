# Phase 3 Step 6.3.4.3 Stage 1 Development Report

> 状态：Verification Request Key + Check ID Transactional Replay 完成，
> 等待架构评审
>
> 范围：仅实施 Step 6.3.4.3 第 1 阶段
>
> 边界：未实现 Stored Payload Integrity、Authenticity、Verifier Runtime
> Resolve、Timeout 或 Verification Service。未进入 Step 6.3.4.4 / 6.3.5。

## 1. 新增与修改文件

生产代码：

- `src/storage/recovery-evidence-verification-keys.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/step6-3-4-3-request-key.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `tests/storage/snapshot-concurrency.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_3_STAGE1_DEVELOPMENT_REPORT.md`

没有新增依赖，没有修改 Migration 或数据库 Schema。

## 2. Verification Request Key

新增：

```text
RecoveryEvidenceVerificationRequestKeyInputSchema
canonicalRecoveryEvidenceVerificationRequestKeyInput
computeRecoveryEvidenceVerificationRequestKey
```

Request Key：

```text
sha256(JCS([
  "forgeflow.recovery-evidence-verification.v1",
  VerificationBinding
]))
```

VerificationBinding 固定包含：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
checkOrigin
verifierId
verifierVersion
verifierConfigDigest
allowlistId
allowlistVersion
readToolName
readToolVersion
readToolSchemaHash
expectedPayloadDigest
```

Stored Evidence V0 canonicalization：

```text
allowlistId: null
allowlistVersion: null
readToolName: null
readToolVersion: null
readToolSchemaHash: null
```

NULL 字段必须显式出现在 JCS object 中，不允许省略、空字符串或 placeholder。

## 3. Check ID 唯一约束

Migration v8 实际约束：

```text
recovery_evidence_verification_checks.id PRIMARY KEY
UNIQUE(task_id, verification_check_id)
UNIQUE(request_key)
```

结论：

- `verificationCheckId` 在同一个 Task 内唯一。
- 不同 Task 可以存在相同 `verificationCheckId`。
- Request Key 包含 taskId，因此跨 Task 不会错误命中。
- `checkRecordId` 仍由全局 primary key 唯一，调用方必须为数据库行提供
  Globally unique ID；这不是 verificationCheckId 的业务唯一范围。

## 4. Transactional Check ID Replay

`createOwnedRecoveryEvidenceVerificationCheck()` 现顺序：

```text
begin immediate SQLite transaction
  -> Lease / fencing
  -> mandatory local ExecutionAuthority
  -> lookup Check by (Task ID, verificationCheckId)
```

### 4.1 Check ID Hit

```text
persisted Check
  -> validate Task / Review / Submission / Original Write / Check ID / origin
  -> recompute requestKey from persisted binding
  -> compare with persisted requestKey
  -> lookup final Verification by Check ID
       -> exists: return persisted Verification
       -> missing: return pending
  -> no Host V2 binding used
  -> no Check / Event / Checkpoint / Attempt writes
```

Result 新增：

```text
state = created | verification | pending
verification = record | null
```

### 4.2 Check ID Miss

```text
compute requestKey from new binding
  -> validate supplied requestKey
  -> requestKey exact replay lookup
       -> hit: validate identity + persisted key, return result/pending
  -> latest Cancel/Pause intent check
  -> Task version CAS
  -> create Check
  -> Checkpoint
```

因此 Service 先前读取的 TaskSnapshot 不会成为 Check 是否存在的权威依据。

## 5. Existing Check Binding Comparison

同 Check ID replay 校验：

```text
taskId
reviewId
evidenceSubmissionId
originalToolRunId
verificationCheckId
checkOrigin
expectedPayloadDigest
```

持久化 Check 的 verifier ID/version/config digest、Allowlist 和 Read Tool
字段用于重算 requestKey，但不与当前 Host Binding 比较。

同 Check ID、不同逻辑身份返回：

```text
RECOVERY_EVIDENCE_VERIFICATION_CHECK_ID_CONFLICT
```

持久化 binding 无法重算出自身 requestKey 时返回：

```text
RECOVERY_EVIDENCE_VERIFICATION_CHECK_BINDING_CORRUPT
```

## 6. Cancel / Pause

新 Check 写入前在 UoW transaction 内检查：

```text
cancelRequestedAt
pauseRequestedAt
```

Check ID / requestKey exact replay 先返回，不受该 gate 无条件拒绝。

ExecutionAuthority 仍在 UoW transaction 开始时强制检查，并保留 DB Lease /
fencing ownership 校验。

## 7. 测试结果

专项测试：

```text
pnpm vitest run tests/storage/step6-3-4-3-request-key.test.ts
```

结果：1 个测试文件，7 个测试通过。

新增测试覆盖：

- V0 五个 Readback 字段显式 NULL canonicalization。
- Request Key 稳定。
- Check 已存在时使用持久化 V1 binding，忽略当前 V2 config。
- Check ID hit + Verification result replay。
- Check ID hit + pending。
- 陈旧 Snapshot 后 Check 已提交的并发窗口。
- 不同 Task 复用同一 verificationCheckId。
- 同 Task 同 Check ID 不同逻辑身份拒绝。
- Check replay 不新增 Event / Checkpoint / Check。
- Cancel Intent 下已有 Check 仍可 replay，新 Check 被拒绝。

全量测试：

```text
pnpm test
```

结果：44 个测试文件，367 个测试通过。

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

## 8. 未实现内容

后续阶段仍未实现：

- Stored Payload 加载与 Runtime Integrity。
- Authenticity fail-closed 处理。
- Host Verifier Binding provider。
- Verifier Registry Runtime Resolve 与 Timeout。
- Verification Service 调用链。
- Payload 错误映射和 Verification Event 状态矩阵。
- 全量 Stored Evidence Verification E2E。

本轮没有执行真实 Read-back、Verifier、Provider、Recovery 或 Write。

完成后停止，等待 Stage 2 架构评审授权。
