# Phase 3 Step 6.3.4.4 Stage 1 Development Report

> 状态：Host Readback Contract + Immutable Allowlist Registry 完成，
> 等待 Stage 1 架构评审
>
> 范围：Host-only callback contract、Immutable Allowlist Version、
> ToolRegistry revalidation、Result Schema / Metadata validation
>
> 边界：未调用 Reservation UoW，未实现 Request Service、ParentPreparation、
> Transaction A/B、External Read、Controlled Provenance 或 Step 6.3.5。

## 1. 修改文件

生产代码：

- `src/recovery/recovery-readback-tool-registry.ts`
- `src/recovery/recovery-contract-errors.ts`
- `src/recovery/index.ts`

测试：

- `tests/recovery/recovery-readback-tool-registry.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE1_DEVELOPMENT_REPORT.md`

没有新增 Migration、依赖或数据库 Schema 变更。

## 2. Host Readback Contract

`RecoveryReadbackToolDefinition` 现包含：

```text
protocolVersion
sourceResolverId / sourceResolverVersion
argumentBuilderId / argumentBuilderVersion
name / version / schemaHash
allowlistId / allowlistVersion
resultSchemaId / resultSchemaVersion / resultSchemaHash
resourceMetadataExtractorId / resourceMetadataExtractorVersion
mode = read
retrySafety
consistencyMode
inputSchema
timeoutMs
maximumPayloadBytes
sensitiveOutputPolicy
resolveSource()
buildArguments()
resultSchema
extractResultMetadata()
```

Protocol：

```text
forgeflow.recovery-readback-contract.v1
```

### 2.1 Source Resolution

`resolveSource(originalToolRun, manifest)` 只接收冻结的：

- Original Unknown Write 持久化 context。
- Evidence Manifest。

Registry 验证：

```text
manifest.taskId == originalToolRun.taskId == requestContext.taskId
manifest.toolRunId == originalToolRun.id
manifest.toolName/version/inputSchemaHash/canonicalInputHash/idempotencyKey
  == originalToolRun fields
```

Resolved Source 只允许 Host-stable scheme：

```text
<scheme>://...
```

明确拒绝：

```text
http
https
file
ftp
```

如果 Manifest.resourceRef 非 NULL，Resolved Source resourceRef 必须完全一致。

### 2.2 Argument Builder

`buildArguments(manifest, requestContext, resolvedSource)` 只能接收冻结上下文。

调用流程保持：

```text
Host buildArguments()
  -> ToolRegistry.validateInput()
  -> ValidatedToolInput
```

本阶段没有调用 `executeValidated()`。

### 2.3 Sensitive Output Policy

结构化字段：

```text
classification: public | internal | confidential
mode: allow | redact | reject
redactionProfile: string | null
```

`redact` 必须提供 profile；其他 mode 必须为 NULL。

本阶段只固定合同和 Digest，不执行输出分类或 redaction。

## 3. Immutable Allowlist Version

Allowlist Contract Digest 输入：

```text
protocolVersion
allowlistId
sourceResolverId / Version
argumentBuilderId / Version
toolName / toolVersion / toolInputSchemaHash
resultSchemaId / resultSchemaVersion / resultSchemaHash
resourceMetadataExtractorId / Version
retrySafety
consistencyMode
timeoutMs
maximumPayloadBytes
sensitiveOutputPolicy
```

计算：

```text
allowlistVersion =
  hex(
    sha256(
      JCS([
        "forgeflow.recovery-readback-allowlist-contract.v1",
        contract
      ])
    )
  )
```

输出为 64 lowercase hex，匹配现有 Request / v9 字段约束。

注册规则：

- Contract metadata 重新 parse。
- Input Schema Hash 必须等于 ToolRegistry 实际 Schema Hash。
- Result Schema Hash 必须等于实际 Result Schema canonical hash。
- 重新计算 Contract Digest，必须等于 allowlistVersion。
- 同 allowlistId + version 重注册拒绝。
- 合同变化会生成新 version。
- 同一 allowlistId 可保留多个历史 version。
- `prepareArguments()` / `validateResult()` 要求精确 `(allowlistId, version)`。
- 缺失历史 version 时 fail closed。

注意：JCS Digest 绑定的是 Host 声明的 metadata 和 Schema Hash，不是
TypeScript callback 的实际机器码指纹。Host 必须通过发布产物、代码 review
和不可变版本治理保证 callback 与 metadata 一起发布；不能声称 Digest
密码学证明了 callback 实现内容。

## 4. Registry 版本管理

内存结构：

```text
allowlistId
  -> allowlistVersion
       -> RegisteredRecoveryReadbackTool
```

接口：

```text
register()
getExact(allowlistId, allowlistVersion)
get(allowlistId)             // 仅单版本便利查询
listVersions(allowlistId)
prepareArguments()
validateResult()
```

同一 allowlistId 存在多个版本时，`get()` 返回
`RECOVERY_READBACK_VERSION_REQUIRED`，不会自动选择最新版本。

## 5. Result Contract

`validateResult()`：

1. 精确解析 Allowlist Version。
2. 再次验证 ToolRegistry metadata 未变化。
3. 使用 Host `resultSchema` 验证实际 Result。
4. 冻结 parsed result。
5. 调用 Host metadata extractor。
6. 只返回 Schema 验证后的：

```text
resourceVersion
resourceEtag
```

7. 用 canonical JSON 计算 payload bytes。
8. 超过 `maximumPayloadBytes` 时拒绝。

本阶段不比较 expected / actual version。后续执行阶段必须：

- expected 非 NULL 且 actual 缺失时 fail closed。
- actual 不一致时 fail closed。
- 不自动接受新版本。

## 6. ToolRegistry Revalidation

已保留：

- Tool Name 精确匹配。
- Tool Version 精确匹配。
- Input Schema Hash 精确匹配。
- Tool mode 必须为 read。
- Timeout 与 Allowlist Contract 一致。
- Result 是 ToolRegistry WeakMap token 对应的 `ValidatedToolInput`。

普通对象不能被视为合法 Validated Input；本阶段未调用
`executeValidated()`，该回归由既有 ToolRegistry WeakMap 测试覆盖。

## 7. 测试结果

Stage 1 专项：

```text
pnpm vitest run tests/recovery/recovery-readback-tool-registry.test.ts
```

结果：1 个测试文件，12 个测试通过。

覆盖：

- Host-only Source Resolver、Argument Builder、Result Schema、
  Metadata Extractor。
- Immutable Contract Digest。
- 所有 contract metadata 变化产生新 version。
- Duration、Payload Size、Sensitive Policy 纳入 Digest。
- 同 ID/version 不同合同拒绝。
- ToolRegistry Version / Input Schema Hash / Timeout mismatch。
- Result Schema Hash mismatch。
- 非 read Tool 拒绝。
- URL / file / HTTP resolver source 拒绝。
- Original Write 与 Manifest Tool binding mismatch。
- 多历史 version 精确恢复。
- 缺失历史 version fail closed。
- Result Schema 验证后 metadata extraction。
- Maximum Payload Bytes。
- 未执行真实 Tool。

ToolRegistry / Verifier Regression：

```text
pnpm vitest run tests/recovery/recovery-readback-tool-registry.test.ts tests/recovery/recovery-verifier-registry.test.ts tests/tools/registry.test.ts
```

结果：3 个测试文件，34 个测试通过。

全量测试：

```text
pnpm test
```

结果：49 个测试文件，434 个测试通过。

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

## 8. 兼容性影响

- `RecoveryReadbackToolDefinition` 的构造方必须补齐新的 Host metadata 和
  callbacks。
- `prepareArguments()` 新增 allowlistVersion、Original ToolRun context
  参数。
- Allowlist Version 从任意字符串收紧为 64 lowercase hex contract digest。
- Registry 允许同一 allowlistId 多版本；单版本便利 `get()` 保留。

没有其他生产模块调用该 Registry，因此兼容性影响局限在 Host registration
和测试。

## 9. 未解决风险

- callback 代码字节无法通过 JCS Metadata Digest 证明；必须依赖 Host 发布
  治理与代码 review。
- `resolveSource()` / `buildArguments()` 的确定性、只读和无外部 I/O 是
  Host 注册合同的一部分，Registry 只能冻结输入，不能沙箱化任意 callback。
- Sensitive Output Policy 本阶段只绑定合同，尚未执行实际 redaction。
- Maximum Payload Bytes 使用 canonical JSON 字节数；后续 Payload Store
  写入仍需复用相同校验顺序。
- 没有实现 Result expected / actual version comparison；属于后续执行阶段。

## 10. 边界声明

本轮：

- 未调用 Reservation acquireOwned 或任何 Reservation UoW。
- 未实现 Request Service、ParentPreparation 或 Transaction A/B。
- 未创建 ExecutionPlan / PlanStep / ToolRun。
- 未执行 Read Tool、Provider、LLM 或 Write。
- 未修改 Task.status 或 RecoveryReview final decision。
- 未修改 Migration v9，未新增 Migration v10。
- 未进入 Step 6.3.5。

完成后停止，等待 Stage 1 架构评审。
