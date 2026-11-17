# ForgeFlow Phase 3 Step 6.3.5 Step 1 Development Report

> Step：SourceContractV1 Contract + Integrity
>
> 状态：开发完成，等待 Step 1 架构评审。
>
> 实现基线：
> - `docs/PHASE3_STEP6_3_5_FINAL_RECOVERY_REVIEW_DESIGN.md`
> - `docs/PHASE3_STEP6_3_5_IMPLEMENTATION_PLAN.md`
>
> 数据库基线：Migration v9。

## 1. 实际修改文件

新增：

- `src/recovery/recovery-source-contract.ts`
- `tests/recovery/recovery-source-contract.test.ts`
- `docs/PHASE3_STEP6_3_5_STEP1_DEVELOPMENT_REPORT.md`

修改：

- `src/recovery/index.ts`

未修改：

- Migration / SQLite Schema。
- SQLite 数据库。
- Final Decision Authorization / UoW。
- Unknown Resolver / Task Convergence。
- Multi-Write Barrier。
- Stage 3.2 / Stage 3.3 / Stage 3.4 已封存行为。

## 2. SourceContractV1 Schema

实现：

```text
RecoverySourceContractV1Schema
RecoverySystemVerifiedSourceContractV1Schema
RecoveryManualAttestedSourceContractV1Schema
```

类型：

```text
RecoverySourceContractV1
  = RecoverySystemVerifiedSourceContractV1
  | RecoveryManualAttestedSourceContractV1
```

共同字段：

- `sourceContractSchemaVersion`
- `taskId`
- `reviewId`
- `originalUnknownWriteToolRunId`
- `targetResourceIdentity`
- `queryScope`
- `observationTimeWindow`
- `coverageCompleteness`
- `sourceObservedAt`
- `payloadDigest`
- variant discriminator / source / provenance / semantics / result

所有对象均为 strict：

- 未知字段拒绝。
- `sourceContractDigest` 不属于 Contract payload；出现即拒绝。
- `payloadDigest` 必须是 `sha256:<64 lowercase hex>`。
- 时间戳必须是有效 ISO-8601 UTC。
- `sourceObservedAt` 必须位于 observation time window 内。
- coverage 必须声明 complete。
- covered selectors 不可重复，且必须包含 query scope selector。

## 3. System / Manual Variant 隔离

### System-verified

固定：

```text
sourceContractAuthority = system_verified
sourceType = system_verification
provenance = controlled_runtime_read
result = passed
negativeObservationSemantics
  = authoritative_absence
  | authoritative_non_execution_marker
```

必须包含：

```text
verifierBinding:
  verifierId
  verifierVersion
  verifierConfigDigest
  verificationId
  bindingDigest
  verificationResult = passed
```

缺少 verifier binding、verification result 非 passed、混入 manual identity 或
manual-only 字段均拒绝。

### Manual-attested

固定：

```text
sourceContractAuthority = manual_attested
sourceType = manual_review
provenance = declared_payload
negativeObservationSemantics = manual_attested_non_execution
```

`result` 只允许：

```text
passed | inconclusive | not_run
```

必须包含：

```text
manualAttestation:
  actorId
  actorType = human_reviewer
  attestationId
  attestationDigest
  responsibilityStatement
```

Manual variant 无法通过 schema 获得：

- `controlled_runtime_read`。
- `system_verified` authority。
- verifier binding。
- system-only negative observation semantics。

Step 1 只建立结构隔离，不签发受信执行能力。真正的 actor / verifier Host
authorization 仍必须由 Step 2 及后续 Gate 提供；普通构造的 Contract 数据不会
打开或授权任何 Final Decision 生产入口。

## 4. API 契约

新增：

```text
canonicalRecoverySourceContractV1(input): string
computeRecoverySourceContractDigest(input): string
validateRecoverySourceContractV1(input, expectedBindings)
```

`RecoverySourceContractExpectedBindingsSchema` 要求：

```text
taskId
reviewId
originalUnknownWriteToolRunId
sourceContractAuthority
```

任一项不匹配：

```text
RECOVERY_SOURCE_CONTRACT_BINDING_MISMATCH
```

Validator 只执行：

- Zod strict parse。
- canonical serialization 前置校验。
- expected identity / authority 比较。

Validator 不执行：

- 数据库操作。
- Registry / Provider 调用。
- 网络访问。
- 文件系统访问。
- Final Decision Authorization。

## 5. Canonical JSON / Digest

使用项目现有：

```text
canonicalJson()
sha256CanonicalJson()
```

语义：

```text
sourceContractDigest
  = sha256(jcs(canonical SourceContractV1 payload))
```

规则：

- Contract payload 不包含自引用 `sourceContractDigest`。
- `canonicalRecoverySourceContractV1()` 对 key 顺序不敏感。
- digest 对同一 canonical Contract 稳定。
- Payload Store 以 `payloadType=json` 保存 Contract 时，manifest 的
  `payloadDigest` 使用 `sourceContractDigest`。
- 加载后重新验证 Payload Store semantic digest，并重新解析 Contract。

## 6. G1 Payload Store Gate

结论：**通过（L2 integration evidence）**。

实际验证：

- 使用 `FileEvidencePayloadStore.put()` 持久化 canonical Contract JSON。
- 使用 `loadRecoveryEvidencePayloadWithIntegrity()` 读取并验证：
  - storage raw digest。
  - semantic JCS digest。
  - availability / integrity status。
- 将 verified JSON payload materialize 后重新解析为
  `RecoverySourceContractV1`。
- 重新计算 `sourceContractDigest` 并确认与 manifest semantic digest 一致。
- 文件被替换后返回
  `EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH`。
- malformed JSON 不产生 verified payload。

未增加持久化抽象或新 Schema。

## 7. G7 Migration v9 Sufficiency

结论：**满足 Step 1 范围**。

- 没有新增表或列。
- 没有修改 Migration v9。
- Contract 使用现有 `payloadType=json` 与 JCS SHA-256 语义。
- Contract 文件通过现有 `EvidencePayloadStore` 引用。
- `sourceContractDigest` 由 Contract canonical payload 计算，不写入
  Contract 自身。

未发现 Step 1 的 Schema / Migration blocker。

## 8. 测试

新增测试文件：

```text
tests/recovery/recovery-source-contract.test.ts
```

覆盖：

1. System / Manual 合法 Contract。
2. Manual 与 System strict variant 隔离。
3. 未知字段和自引用 `sourceContractDigest` 拒绝。
4. key 顺序无关的 canonical JSON。
5. 稳定 SHA-256 digest。
6. Task / Review / Unknown Write / authority 身份 mismatch。
7. target / query / time / coverage / payload digest 缺失拒绝。
8. Manual 伪装 controlled runtime / system verified 拒绝。
9. System verifier binding 缺失 / verification failed 拒绝。
10. Manual actorType / failed result 拒绝。
11. observation time window 与 coverage selector 校验。
12. Payload Store put / read / semantic digest / parse roundtrip。
13. 存储文件篡改拒绝。
14. malformed persisted JSON 拒绝。

### 实际测试结果

初始 targeted run：

- 1 个测试 fixture 使用了仍在 observation window 内的时间值，却被误标为
  “outside window”。
- 这是测试 fixture 错误，不是生产实现缺陷。
- 已将时间值修正为窗口外后重跑。

最终 targeted run：

```text
pnpm vitest run tests/recovery/recovery-source-contract.test.ts

Test Files  1 passed (1)
Tests       13 passed (13)
```

全量测试：

```text
pnpm test

Test Files  59 passed (59)
Tests       648 passed (648)
```

类型检查：

```text
pnpm typecheck

$ tsc --noEmit
```

结果：通过。

Diff check：

```text
git diff --check
```

结果：通过，无 whitespace error。Git 仅报告当前工作副本中既有的 LF/CRLF
提示。新增源码、测试和报告另行执行尾随空白检查，结果通过。

## 9. 验收级别

- 最高验收级别：**L2 Integration Verified**。
- 生产入口：**closed**。
- 原因：
  - Step 2 Final Decision Authorization 未实施。
  - Step 4-7 Final Decision UoW / Task Convergence / Terminal Replay 未实施。
  - 新 API 只验证 Contract 结构和完整性，不签发执行权限。

## 10. 生产入口 Closed 证明

Step 1 新增模块只被：

- `src/recovery/index.ts` 导出。
- `tests/recovery/recovery-source-contract.test.ts` 调用。

没有：

- Final Decision service import。
- Final Decision UoW。
- Host production route。
- Task / Review / ToolRun 状态写入。
- Event / Operation / Checkpoint 写入。

因此 SourceContractV1 的存在不会打开真实 Host Final Decision 写入口。

## 11. 未实施范围

- Final Decision Authorization。
- Terminal Replay Authorization。
- Final Decision requestKey / CAS / Exact Replay。
- Unknown Write Resolver。
- Task Final Convergence。
- Downstream ToolRun skipped convergence。
- Multi-Write Barrier。
- AgentRunner Write closure。
- Cancel / Pause race。
- Fault injection / multi-connection regression。
- Migration v10。
- Step 2。

## 12. Step 1 封存判断

满足候选封存条件：

- SourceContractV1 schema 与 variants 实现完成。
- canonical serializer / digest / validator 完成。
- G1 / G7 证据完成。
- targeted / full tests 与 typecheck 通过。
- 生产入口保持 closed。

最终结论：

```text
Step 1 candidate for architecture review and seal.
```

等待 Step 1 架构评审；不开始 Step 2。
