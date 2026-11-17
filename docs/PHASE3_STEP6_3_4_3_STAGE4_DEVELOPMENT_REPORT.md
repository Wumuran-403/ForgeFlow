# Phase 3 Step 6.3.4.3 Stage 4 Development Report

> 状态：RecoveryEvidenceVerificationService + Lazy Host Binding Replay
> Hardening 完成，等待 Stage 4 最终架构评审
>
> 范围：Stored Evidence V0 完整验证编排
>
> 边界：未执行 Read-back、Provider、LLM、Write 或普通 Agent Resume；
> 未修改 Task.status、RecoveryReview 最终决策、Migration、Schema 或依赖；
> 未进入 Step 6.3.4.4 / Step 6.3.5。

## 1. 新增与修改文件

生产代码：

- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/index.ts`

测试：

- `tests/recovery/recovery-evidence-verification-service.test.ts`
- `tests/storage/step6-3-4-3-request-key.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_3_STAGE4_DEVELOPMENT_REPORT.md`

没有修改 Migration、数据库 Schema、UoW 写入语义、Task 状态机或 Review
最终决策。

## 2. 公开入口

```text
RecoveryEvidenceVerificationService.verifyStoredEvidence(input)
```

输入由 Host 提供：

```text
ownership: taskId / leaseToken / fencingToken
expectedTaskVersion
reviewId
evidenceSubmissionId
verificationCheckId
```

Verifier 选择不来自调用请求：

- Service 构造时固定 `hostVerifierId`。
- 新建 Check 时只从 Host-owned Binding Provider 获取 active Binding。
- timeout、verifier version 和 Effective Config 不能由模型或请求参数指定。

Service 依赖：

```text
ForgeFlowDatabase
TaskLeaseManager
EvidencePayloadStore
RecoveryVerifierRuntime
mandatory ExecutionAuthority assert callback
Host verifier id
```

## 3. 执行调用链

```text
verifyStoredEvidence(input)
  -> Lease / Fencing validation
  -> mandatory ExecutionAuthority validation
  -> one consistent TaskSnapshot read
  -> validate Review / Submission / Evidence Event / Original Unknown Write
     / original agent ExecutionPlan
  -> RecoveryEvidenceUnitOfWork
       create/replay Verification Check in immediate transaction
       with lazy Host Binding provider
  -> Check + Verification replay: return persisted result
  -> Check pending replay: return pending
  -> newly created Check:
       -> fresh intent / authority validation
       -> Stage 2 single-read Integrity + Verified Payload
       -> Integrity failure: persist not_run result
       -> post-load authority / intent validation
       -> Stage 3 Runtime Resolve / Verifier Execution
       -> post-verifier authority / intent validation
       -> RecoveryEvidenceUnitOfWork
            record Verification in immediate transaction
  -> return persisted Verification
```

Service 不直接写 Repository、Event、Checkpoint 或 StorageWritePermit。

### 3.1 Lazy Host Binding Replay Hardening

修复前：

```text
Service Snapshot Check lookup
  -> visible Check: persisted Binding
  -> not visible: current Host active Binding
  -> call eager UoW Check API
```

修复后：

```text
Service passes logical identity + synchronous lazy Binding provider
  -> UoW BEGIN IMMEDIATE
  -> Lease / Fencing / ExecutionAuthority
  -> authoritative Check ID lookup
       -> hit: persisted Binding, provider never called
       -> miss: call lazy provider exactly once
```

Host Binding provider 的准确调用位置：

```text
RecoveryEvidenceUnitOfWork
  .createOwnedStoredEvidenceVerificationCheck()
  -> transactional Check ID miss branch
  -> resolveRecoveryEvidenceVerificationHostBinding()
```

Check ID hit 分支只读取持久化 Binding，重算并核对 Request Key，再返回
Verification 或 pending。当前 Host active Binding、Registry 新版本和当前
Config digest 均不能改变历史 Check 的 Replay。

当 provider 抛错、返回 thenable 或返回非法 Binding 时，UoW 在创建
Check 前回滚，不产生 Check、Event 或 Checkpoint。

## 4. 不变业务绑定校验

Service 从同一个 `TaskSnapshot` 验证：

- Review 属于 Task。
- Review 仍为 `pending` 或 `unresolved`。
- Submission 的 `taskId / reviewId / toolRunId` 与 Review 一致。
- Submission 的 applied Event 为 `recovery.evidence.submitted`，且
  Event submission id 一致。
- Original ToolRun 属于 Task、`mode=write`、`status=unknown`。
- Original ToolRun 的 PlanStep 属于同一 Task。
- PlanStep 对应 ExecutionPlan 的 `purpose=agent`。

Verifier Envelope 的 Tool 元数据来自真实 Original ToolRun：

```text
toolName
toolVersion
inputSchemaHash
canonicalInputHash
idempotencyKey
```

不从模型输入或 Evidence Submission 的摘要字段猜测这些值。

## 5. Replay 行为

### 5.1 Check + Verification Replay

- UoW 在 immediate transaction 内按 `(taskId, verificationCheckId)` 查询。
- 命中时使用持久化 Check Binding。
- Verification 已存在则直接返回。
- 不读取 Payload Store。
- 不调用 Verifier。
- 不新增 Check / Verification / Event / Checkpoint。
- Cancel/Pause 下仍可返回已有 Verification。

### 5.2 Check + Pending Replay

- Check 命中但 Verification 不存在时返回 `pending`。
- 不读取 Payload。
- 不调用 Verifier。
- 不自动生成新 Check ID。
- Cancel/Pause 不阻断只读 pending replay。

### 5.3 Verification Record Replay

最终 UoW 以持久化 Check 的 `requestKey` 写入。若同一结果已存在，UoW
返回原 Verification，不重复 Event / Checkpoint。

## 6. 状态映射

| Runtime 情况 | Availability | Integrity | Verification | Availability Event | Verification Event |
|---|---|---|---|---|---|
| Store ref 非法 / ENOENT / I/O / external reference | unavailable | not_checked | not_run | 必填 | NULL |
| Storage / Semantic Digest mismatch、JSON invalid、Readback Schema invalid | available | mismatch | not_run | 必填 | NULL |
| Registry miss / version / config / compatibility failure | available | matched | not_run | 必填 | NULL |
| Verifier passed | available | matched | passed | 必填 | 必填 |
| Verifier failed | available | matched | failed | 必填 | 必填 |
| Verifier inconclusive / reject / throw / timeout | available | matched | inconclusive | 必填 | 必填 |

`observedPayloadDigest`：

- 使用 Runtime 实际计算出的 Semantic Digest。
- 不可靠取得时为 `NULL`。
- 不复制 Manifest Digest。

`readbackResultProvenance` 固定为：

```text
declared_payload
```

`authenticityStatus` 固定为：

```text
unverified
```

## 7. 事务与 Authority

### Read transaction

`TaskSnapshotReader.load()` 在一个 SQLite read transaction 内读取 Task、
Review、Submission、Event、ToolRun、PlanStep、ExecutionPlan、Check 和
Verification 历史。

### Check transaction

`createOwnedRecoveryEvidenceVerificationCheck()` 使用 SQLite immediate
transaction：

- Lease / Fencing。
- mandatory local ExecutionAuthority。
- authoritative Check ID lookup。
- persisted Binding 使用。
- requestKey exact replay。
- latest Cancel/Pause。
- Task version CAS。
- Check + Checkpoint。

### Payload / Verifier

Payload Store 读取和 Verifier 执行位于 SQLite transaction 之外，不声称
文件系统与 SQLite 原子。

### Verification transaction

`recordOwnedRecoveryEvidenceVerification()` 使用 SQLite immediate
transaction：

- Lease / Fencing。
- mandatory local ExecutionAuthority。
- Verification requestKey exact replay。
- latest Cancel/Pause。
- Task version CAS。
- Availability Event。
- optional Verification Event。
- Verification row。
- Checkpoint。

Service 在 Check 创建后、Payload 读取后、Verifier 返回后分别做提前退出
检查；最终权威检查仍由 UoW 事务完成。

## 8. 测试结果

Stage 4 专项：

```text
pnpm vitest run tests/recovery/recovery-evidence-verification-service.test.ts
```

结果：1 个测试文件，19 个测试通过。

覆盖：

- passed / failed / inconclusive 持久化。
- Availability Event 与 Verification Event 的 not_run 规则。
- Check + Verification exact replay。
- Check + pending replay。
- Cancel/Pause 下持久化结果 replay。
- 一次 Payload Store read。
- Integrity 通过后同一 Verified Payload 交给 Verifier。
- Store ref invalid、ENOENT、I/O、external reference。
- Storage / Semantic/JSON / Readback Schema failure。
- Registry miss、version mismatch、config mismatch、compatibility failure。
- 同步 throw、Promise reject、timeout。
- Authority revoked、lease expired、fencing changed。
- Check 前 Cancel、Payload 后 Cancel、Verifier 执行期间 Intent。
- declared readback_result 不成为 controlled runtime read。
- 结果与 Event 不泄漏 Payload、路径和底层异常。
- Task.status 不改变。
- 历史 Check 在当前 Host 无 active Binding / Registry 无 Verifier 时仍可
  Replay。
- Check ID hit 不调用 Host Binding provider。
- Check ID miss 时 Host Binding provider 恰好调用一次。
- Lazy Binding provider 抛错时无 Check / Event / Checkpoint 部分写入。
- Lease 失效时不能通过 Exact Replay 返回结果。

Stage 1 / 2 / 3 Regression：

```text
pnpm vitest run tests/storage/step6-3-4-3-request-key.test.ts tests/recovery/recovery-evidence-payload-integrity.test.ts tests/recovery/recovery-verifier-runtime.test.ts
```

结果：3 个测试文件，38 个测试通过。

全量测试：

```text
pnpm test
```

结果：47 个测试文件，417 个测试通过。

Typecheck：

```text
pnpm typecheck
```

结果：通过。

Diff check：

```text
git diff --check
```

结果：通过，仅有工作区既有的 LF/CRLF normalization warning。

## 9. 当前限制与剩余风险

- Host Binding provider 只在 UoW immediate transaction 的 Check ID miss
  分支调用；陈旧 Snapshot 不参与 Binding 来源判断。
- v8 没有独立 timeout 字段，恢复旧 Check 仍要求 Host 提供完全相同的
  Effective Config 与 config digest。
- Verifier Contract 没有 AbortSignal，timeout 不能强制终止非协作 Promise。
- 本阶段只支持 Stored Evidence V0；controlled runtime readback 仍为后续
  步骤。
- 未新增 Migration、Schema、依赖或后台 Recovery 执行器。

## 10. 边界声明

本轮：

- 没有执行 Read-back、Provider、LLM 或 Write。
- 没有自动 Resume 普通 Agent。
- 没有修改 Task.status。
- 没有修改 RecoveryReview 最终决策。
- 没有开始 Step 6.3.4.4 或 Step 6.3.5。

完成后停止，等待 Stage 4 架构评审。
