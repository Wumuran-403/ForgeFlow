# Phase 3 Step 6.3.4.3 Stage 2 Development Report

> 状态：Stored Payload Runtime Integrity 完成，等待 Stage 2 架构评审
>
> 范围：仅实现已持久化 Evidence Payload 的加载、Storage Digest 校验、
> Semantic Digest 校验、结构化结果和安全错误分类
>
> 边界：未实现 Authenticity、Trust Anchor、Verifier Runtime Resolve、
> Timeout、Verification Service、Read-back、Provider、LLM、Write 或普通
> Agent Resume。未进入 Step 6.3.4.4 / Step 6.3.5。

## 1. 新增与修改文件

生产代码：

- `src/recovery/recovery-evidence-payload-integrity.ts`
- `src/recovery/index.ts`

测试：

- `tests/recovery/recovery-evidence-payload-integrity.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_3_STAGE2_DEVELOPMENT_REPORT.md`

没有新增依赖，没有修改 Migration、数据库 Schema、UoW、Verifier 或
Recovery 执行流程。

## 2. 对外接口

新增：

```text
verifyRecoveryEvidencePayloadIntegrity(
  manifest,
  payloadStore
): RecoveryEvidencePayloadIntegrityResult
```

输入只使用 Manifest 的以下字段：

```text
payloadType
payloadDigestProtocol
payloadDigest
payloadStoreRef
payloadStorageMode
```

结果由 Zod Schema 校验：

```text
availabilityStatus: available | unavailable
integrityStatus: not_checked | matched | mismatch
actualStorageDigest: sha256 digest | null
actualSemanticDigest: sha256 digest | null
reasonCode: stable reason code
redactedSummary: redacted text
```

结果不包含原始 Payload bytes、进程异常 message、stack、本地路径或
Store 内部信息。

## 3. 两层 Digest 校验

实现严格区分：

### 3.1 Storage Digest

Store reference 必须完全匹配：

```text
evidence-file:sha256/<64 lowercase hex>
```

从 Store reference 推导：

```text
expectedStorageDigest = sha256:<64 lowercase hex>
```

然后调用：

```text
payloadStore.read(storeRef, expectedStorageDigest)
```

Manifest semantic digest 不作为 `read()` 的 expected digest 参数。

文件读取成功后，Runtime 再次对返回的原始 bytes 计算 SHA-256，得到
`actualStorageDigest`。这提供独立于 Store 实现的第二道检查。

### 3.2 Semantic Digest

`raw_bytes`：

```text
bytes -> SHA-256
```

`json`：

```text
bytes
  -> strict UTF-8 decode
  -> JSON.parse
  -> JCS canonical JSON
  -> SHA-256
```

`readback_result`：

```text
bytes
  -> strict UTF-8 decode
  -> JSON.parse
  -> RecoveryReadbackResultSchema
  -> JCS canonical JSON
  -> SHA-256
```

`external_reference`：

```text
fail closed
-> unavailable / not_checked
-> no network request
-> no arbitrary URL fetch
```

最后将实际计算的 `actualSemanticDigest` 与 Manifest
`payloadDigest` 比较。Manifest digest 从不直接复制为实际观测值。

## 4. 状态映射

| 情况 | Availability | Integrity | reasonCode |
|---|---|---|---|
| Store reference 非法 | unavailable | not_checked | `EVIDENCE_PAYLOAD_STORE_REF_INVALID` |
| Manifest digest 格式非法 | unavailable | not_checked | `EVIDENCE_PAYLOAD_DIGEST_INVALID` |
| Payload 文件缺失 | unavailable | not_checked | `ENOENT` |
| 普通 Store I/O failure | unavailable | not_checked | `EVIDENCE_PAYLOAD_STORE_IO_ERROR` |
| Store 文件 bytes 与 reference digest 不匹配 | available | mismatch | `EVIDENCE_PAYLOAD_STORED_DIGEST_MISMATCH` |
| JSON parse / canonicalization 失败 | available | mismatch | `EVIDENCE_PAYLOAD_JSON_INVALID` |
| Readback Result Schema 失败 | available | mismatch | `EVIDENCE_PAYLOAD_READBACK_RESULT_INVALID` |
| Semantic Digest 不匹配 | available | mismatch | `EVIDENCE_PAYLOAD_SEMANTIC_DIGEST_MISMATCH` |
| Storage 与 Semantic Digest 均匹配 | available | matched | `EVIDENCE_PAYLOAD_INTEGRITY_MATCHED` |
| external reference 无受控 Adapter | unavailable | not_checked | `EVIDENCE_PAYLOAD_EXTERNAL_REFERENCE_UNSUPPORTED` |

Storage Digest mismatch 时 `FileEvidencePayloadStore.read()` 不返回实际
bytes，因此 Runtime 无法可靠取得实际 Storage Digest；该值保持 `null`，
不把 Store reference 推导出的期望值冒充为实际观测值。

JSON parse 或 Readback Schema 失败时，文件读取与 Storage Digest 已经
成功，因此保留实际 `actualStorageDigest`，但 `actualSemanticDigest`
保持 `null`。

## 5. 安全边界

- Store reference 在调用 Payload Store 前进行严格白名单格式校验。
- 不接受本地文件路径、URL、任意 fetch 或用户控制的路径拼接。
- 不发起网络请求。
- 不输出原始异常 message、stack、本地路径或 Payload 内容。
- `external_reference` 不访问网络，也不读取 Store。
- `payloadType=readback_result` 仅表示已声明 Payload 类型，本模块不产生
  `controlled_runtime_read` provenance，也不执行 Verifier。
- availability 与 integrity 是两个独立维度；内容可读取但 Digest 不匹配
  使用 `available + mismatch`。

## 6. 测试覆盖

新增专项测试覆盖：

- `raw_bytes` Storage / Semantic Digest。
- 非 canonical 文件 bytes 的 JSON JCS Semantic Digest。
- `readback_result` Schema 校验与 canonical Digest。
- Storage Digest mismatch。
- Semantic Digest mismatch。
- 非法 Store reference。
- `ENOENT`。
- 普通 I/O failure。
- 文件被替换。
- `external_reference` fail closed，且不调用 Store。
- 无法可靠取得 actual digest 时保持 `null`。
- JSON parse 与 Readback Schema failure。
- 结果只使用 v8 允许的 Availability / Integrity 状态。
- 输出不包含本地路径、原始异常或 Payload 内容。
- Manifest Digest / Protocol 非法组合。

专项测试：

```text
pnpm vitest run tests/recovery/recovery-evidence-payload-integrity.test.ts
```

结果：1 个测试文件，13 个测试通过。

Stage 1 Regression：

```text
pnpm vitest run tests/storage/step6-3-4-3-request-key.test.ts
```

结果：1 个测试文件，7 个测试通过。

全量测试：

```text
pnpm test
```

结果：45 个测试文件，380 个测试通过。

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

## 7. 当前限制

- 本模块只输出 Integrity Result，不返回原始 Payload，也不调用 Verifier。
- Authenticity 仍完全未实现，Stage 2 不产生任何可信真实性结论。
- Verifier Runtime Resolve、Host Binding、Timeout 和 Verification
  持久化仍属于后续阶段。
- 后续 Service 若需要把同一份已校验 Payload 交给 Verifier，应避免重新
  读取 Store 造成 TOCTOU；该集成设计需在下一阶段基于实际接口处理。
- 没有新增 Migration，也没有修改数据库 Schema。

## 8. 边界声明

本轮：

- 没有执行 Recovery、Read-back、Provider、LLM、Write 或 Verifier。
- 没有修改 Task.status。
- 没有修改生产 Migration 或数据库 Schema。
- 没有新增依赖。
- 没有开始 Step 6.3.4.4 或 Step 6.3.5。

完成后停止，等待 Stage 2 架构评审。
