# Phase 3 Step 6.3.4.1 Development Report

> 状态：Verifier Contract + Allowlist 完成，等待架构评审
>
> 范围：Host-only Recovery Verifier Contract、Recovery Read Tool Allowlist、
> ToolRegistry schemaHash projection、Zod contract 和单元测试
>
> 边界：没有实现数据库持久化、Read-back 执行、Verifier 执行、Recovery、
> Provider 调用或 Step 6.3.4.2

## 1. 新增与修改文件

Recovery：

- `src/recovery/recovery-verifier-registry.ts`
- `src/recovery/recovery-readback-tool-registry.ts`
- `src/recovery/recovery-contract-errors.ts`
- `src/recovery/index.ts`

Tools：

- `src/tools/types.ts`
- `src/tools/registry.ts`
- `src/tools/fingerprint.ts`

测试：

- `tests/recovery/recovery-verifier-registry.test.ts`
- `tests/recovery/recovery-readback-tool-registry.test.ts`
- `tests/tools/registry.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_1_DEVELOPMENT_REPORT.md`

没有新增依赖，没有创建 Migration，没有修改 SQLite Schema，没有创建数据库。

## 2. Recovery Verifier Contract / Registry

新增 `RecoveryVerifierRegistry` 和显式
`RecoveryVerifierDefinitionSchema`：

```text
RecoveryVerifierDefinition
  id
  version
  description
  allowedPayloadTypes
  allowedSourceTypes
  readbackRequired
  allowlistId?
  verify(input, context)
```

约束：

- ID 必须唯一；重复注册直接拒绝。
- 未注册 Verifier 查询失败，没有默认 fallback。
- `readbackRequired=true` 时必须声明 Host allowlist，并允许
  `readback_result`。
- `readbackRequired=false` 时不得声明 allowlist。
- Registration 只接受 Host 定义；模型或普通请求没有 Registry 写入入口。
- Registry 不执行 Verifier；本步骤只冻结 Contract 和校验逻辑。

Verifier context 由 Zod 校验，包含 Task / Review / Original Write /
Submission / Verification / Check ID、Verifier config digest、payload/source
类型和 Host 生成时间。Host 身份与 Trust Anchor 是显式独立字段，不从模型
输出推导。

Verifier Result 只允许：

```text
status:
  passed
  failed
  inconclusive

integrity:
  not_checked
  matched
  mismatch

authenticity:
  unverified
  manual_attested
  system_verified
```

`unavailable`、`confirmed_succeeded` 和 `confirmed_not_executed` 均会被拒绝。
`manual_attested` 需要 Host 认证的 manual actor；
`system_verified` 需要 Host Trust Anchor。没有这些条件时只能保持
`unverified`。

Verifier Result 还要求：

- 非空 structured `reasonCode`。
- 非空、限长 `redactedSummary`。
- 不接受原始 Payload 字段。
- 不返回最终 RecoveryReview decision。

## 3. Recovery Read Tool Allowlist

新增 Host-only `RecoveryReadbackToolRegistry`。定义包含：

```text
name
version
schemaHash
allowlistId
allowlistVersion
mode = read
retrySafety
consistencyMode
inputSchema
timeoutMs
buildArguments(manifest, requestContext)
```

本步骤只允许：

- `retrySafety=immutable`
- `retrySafety=version_conditional`
- `mode=read`

拒绝：

- `mode=write`
- `mutable_current_state`
- `current_state_only`
- `retrySafety` / `consistencyMode` 组合不一致
- ToolRegistry 中不存在的 Tool
- ToolRegistry 版本不匹配
- schemaHash 不匹配
- timeoutMs 与 ToolRegistry metadata 不一致
- 通用 `fetch_url` / URL 参数工具

Allowlist 不接受 Tool 名、任意 Tool input 或执行函数作为调用参数。
`buildArguments` 只能由 Host 定义产生 candidate input。`prepareArguments()`
只执行以下流程：

```text
Host buildArguments(manifest, requestContext)
  -> ToolRegistry.validateInput()
  -> metadata / version / schema hash comparison
  -> return validated input token
```

`prepareArguments()` 不调用 `execute()` 或 `executeValidated()`。本模块没有
创建绕过 ToolRegistry 的执行入口，也没有执行 Read-back。

## 4. ToolRegistry Schema Hash Projection

ToolRegistry 注册时使用现有 `computeToolInputSchemaHash()`：

- 从实际注册的 `ToolDefinition.inputSchema` 生成 Draft-07 JSON Schema。
- 使用既有 canonical JSON + SHA-256。
- Hash 在注册时计算一次，并由 `RegisteredToolMetadata.inputSchemaHash`
  与 Tool name、version 一起读取。
- `ValidatedToolInput` 同时携带 `toolVersion` 和
  `inputSchemaHash`，后续步骤可与 Allowlist 持久化值比对。

没有改变现有 `validateInput()` / `executeValidated()` 的 WeakMap token
关系、Zod transform 执行次数或 ToolRegistry lock 语义。

## 5. Zod 校验边界

公开边界包括：

- `RecoveryVerifierDefinitionSchema`
- `RecoveryVerifierDefinitionMetadataSchema`
- `RecoveryVerifierPayloadSchema`
- `RecoveryVerifierInputSchema`
- `RecoveryVerifierContextSchema`
- `RecoveryVerifierResultSchema`
- `RecoveryVerifierCompatibilityInputSchema`
- `RecoveryReadbackToolDefinitionSchema`
- `RecoveryReadbackRequestContextSchema`
- `RecoveryReadbackPreparedInvocationSchema`

所有注册和准备步骤使用 `.strict()`，未知字段被拒绝。错误只保留 code、
结构化 path/message 和安全摘要，不包含原始 Payload、candidate input 或
工具实现错误。

## 6. 测试覆盖

新增/更新测试覆盖：

### Verifier Registry

- 合法 Verifier 注册与读取。
- 重复 ID、未注册 ID、无 fallback。
- 不支持 Payload / Source 类型。
- readbackRequired 缺少 readback。
- 非法 Verifier Result、final decision 状态和 unavailable。
- manual/system authenticity 的 Host 条件。
- 无 verify 函数的 Definition 拒绝。

### Read Tool Allowlist

- immutable / version_conditional 注册。
- Write、mutable/current-state、组合不一致拒绝。
- 未注册 Tool、Version mismatch、Schema Hash mismatch。
- generic URL fetch 拒绝。
- 任意 caller 参数注入拒绝。
- `buildArguments` 产生的 candidate 必须经 ToolRegistry 校验。
- 工具执行函数零调用。
- 版本预期绑定规则。

### ToolRegistry / Regression

- Schema Hash 稳定、Schema 变化产生不同 Hash。
- Version 变化与 Hash 可独立识别。
- Validated input 携带 version/hash projection。
- 现有 Zod transform / async refinement 只执行一次。
- WeakMap token 失效语义保持。

## 7. 实际验证结果

已执行：

```text
pnpm test
```

结果：41 个测试文件通过，328 个测试通过。

已执行：

```text
pnpm typecheck
```

结果：通过。

已执行：

```text
git diff --check
```

结果：通过。仅输出工作区既有文件的 LF/CRLF normalization warning，无
whitespace error。

## 8. 未实现内容与限制

本步骤没有实现：

- Migration v8 或任何 SQLite Schema 修改。
- Verification Check / Verification Repository。
- TaskSnapshot Recovery 集合扩展。
- Read-back Request / Attempt / Executor。
- Transaction A / B / V0 / C。
- 实际 Verifier 执行。
- RecoveryManager 执行流程修改。
- Recovery、Read-back、Write、Provider 调用。
- Step 6.3.4.2。

Schema Hash projection 目前只提供 Contract metadata；持久化绑定和实际
Read Tool 执行将在后续 Step 接入。
