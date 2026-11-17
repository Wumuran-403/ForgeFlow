# Phase 3 Step 6.3.4.3 Stage 3 Development Report

> 状态：Host Verifier Runtime Foundation 完成，等待 Stage 3 架构评审
>
> 范围：Host Verifier Binding、Runtime Resolve、Timeout、Verified Payload
> 单次交付基础
>
> 边界：未实现完整 RecoveryEvidenceVerificationService，未执行 Recovery、
> Read-back、Provider、LLM、Write 或 Verifier 持久化，未进入
> Step 6.3.4.4 / Step 6.3.5。

## 1. 新增与修改文件

生产代码：

- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-evidence-payload-integrity.ts`
- `src/recovery/recovery-contract-errors.ts`
- `src/recovery/index.ts`

测试：

- `tests/recovery/recovery-verifier-runtime.test.ts`
- `tests/recovery/recovery-evidence-payload-integrity.test.ts`

文档：

- `docs/PHASE3_STEP6_3_4_3_STAGE3_DEVELOPMENT_REPORT.md`

没有新增依赖，没有修改 Migration、数据库 Schema、UoW、Task 状态或
Recovery 执行流程。

## 2. Host Verifier Binding

新增 Host-owned immutable binding：

```text
verifierId
verifierVersion
verifierConfigDigest
timeoutMs
effectiveConfig
```

Effective Config：

```text
protocolVersion =
  "forgeflow.recovery-verifier-effective-config.v1"
verifierId
verifierVersion
timeoutMs
ruleConfig
```

`verifierConfigDigest`：

```text
sha256(JCS(Effective Config))
```

因此 `timeoutMs` 与规则配置更新都会改变 digest。

`RecoveryVerifierHostBindingProvider` 只接受 Host 启动期提供的不可变
definition：

- 每个 `verifierId` 最多一个 active binding。
- active binding 用于创建新 Check。
- 同一 provider 可以保留 inactive 历史 binding，用于恢复旧 Check。
- 新 Check 不读取模型、请求调用方或 Verifier 自定义的 timeout。
- 找不到完全一致的 `(verifierId, verifierVersion, configDigest)`
  时 fail closed。

当前没有新增 Check 字段，也不声称 v8 单独保存 timeout。恢复旧 Check 时，
Host 必须提供同一 Effective Config，并重新计算得到相同 config digest；
否则 Runtime 返回 `not_run` / `VERIFIER_BINDING_UNAVAILABLE`。

## 3. Runtime Resolve

`RecoveryVerifierRuntime.executePersisted()` 的解析顺序：

```text
verified payload handoff validation
  -> exact persisted binding restore
  -> context config digest comparison
  -> Registry verifier identity lookup
  -> verifier version comparison
  -> Registry payload/source compatibility resolve
  -> verifier execution
```

约束：

- 不使用 Registry 最新版本冒充持久化版本。
- ID、version、config digest 任一不匹配时不执行 Verifier。
- 未注册 Verifier 返回 `VERIFIER_NOT_REGISTERED`。
- 版本不匹配返回 `VERIFIER_VERSION_MISMATCH`。
- Context digest 不匹配返回 `VERIFIER_CONFIG_DIGEST_MISMATCH`。
- Compatibility 失败返回 `VERIFIER_INCOMPATIBLE`。
- 上述情况均为 `not_run`，不要求 Verification Event。

Runtime 只持有 Verifier Registry 与 Binding Provider。Verifier 调用签名仍
只接收：

```text
RecoveryVerifierInput
RecoveryVerifierContext
```

不注入 Repository、UoW、数据库、Manifest Writer 或持久化 capability。

## 4. Timeout

Verifier 执行使用单一 settle 状态：

```text
未启动               -> not_run
正常返回且 Result 合法 -> passed / failed / inconclusive
同步抛错或 reject     -> inconclusive
timeout              -> inconclusive
Result Schema 失败    -> inconclusive
```

Timeout 只决定 Runtime 是否接受该次结果，不会声称强制终止非协作式
Promise。Timeout 后：

- 迟到 resolve 被忽略。
- 迟到 reject 已被 rejection handler 消费。
- 不产生第二次 settle。
- 不覆盖已经返回的 `inconclusive`。

当前 Verifier Contract 没有 AbortSignal，本阶段没有修改其接口。

## 5. Verified Payload Handoff

Stage 2 Integrity 模块现提供内部 single-read handoff：

```text
PayloadStore.read()
  -> storage digest verification
  -> semantic digest verification
  -> VerifiedEvidencePayload
```

公开 Stage 2 API 仍只返回 Integrity Result。内部 loader 与 materializer
没有从 `recovery/index.ts` 公开，并由后续 Service 从模块内部使用。

Verified Payload：

- 只能由 `available + matched` 路径生成。
- 不包含 Store reference、本地路径或文件句柄。
- 不保存 UoW、Repository 或数据库引用。
- `provenance` 固定为 `declared_payload`。
- `payloadType=readback_result` 不会被识别为
  `controlled_runtime_read`。

Materialize 时：

- raw bytes 返回独立副本。
- JSON / readback 数据使用独立 clone。
- Verifier Input、Payload、Manifest 与 Context 以冻结副本交付。
- Integrity 失败不生成 Verified Payload。
- 伪造 handoff 对象在调用 Verifier 前被拒绝。

## 6. Authenticity

Stage 3 保持：

```text
authenticityStatus = unverified
```

Runtime 不传递 Trust Anchor，也不接受 Verifier 自报的
`manual_attested` / `system_verified` 作为 Host 结论。Runtime 最终结果
始终重写为 `unverified`；Verifier 的 Integrity 自报也不能覆盖 Runtime
已确认的 `matched`。

## 7. 测试结果

Stage 3 专项测试：

```text
pnpm vitest run tests/recovery/recovery-verifier-runtime.test.ts tests/recovery/recovery-evidence-payload-integrity.test.ts
```

结果：2 个测试文件，28 个测试通过。

覆盖：

- Host Binding 稳定性。
- timeout 进入 Effective Config 与 digest。
- active config 更新后历史 Check Binding 不变。
- exact binding 缺失 fail closed。
- Registry version / context config digest mismatch。
- Verifier 未注册与 binding 不可用。
- 正常 Verifier Result。
- reject、同步 throw、invalid result。
- timeout 后迟到 resolve。
- timeout 后迟到 reject，无 unhandled rejection。
- Verifier 只收到 Verifier Input 与 Context。
- Verifier 输入为冻结业务副本。
- declared readback_result 不满足 readback-required Verifier。
- 一次 Store read 同时完成 Integrity 与 handoff。
- Integrity 失败不生成 Verified Payload。
- 伪造 Verified Payload 被拒绝。

Stage 1 Regression：

```text
pnpm vitest run tests/storage/step6-3-4-3-request-key.test.ts
```

结果：1 个测试文件，7 个测试通过。

Stage 2 Regression：

```text
pnpm vitest run tests/recovery/recovery-evidence-payload-integrity.test.ts
```

结果：1 个测试文件，16 个测试通过。

全量测试：

```text
pnpm test
```

结果：46 个测试文件，395 个测试通过。

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

## 8. 当前限制

- 未实现完整 Verification Service、Check 调用编排和 Verification
  持久化。
- v8 没有独立 timeout 字段；旧 Check 的 timeout 依赖 Host 保存并提供
  完全相同的 Effective Config。
- 非协作 Promise 不会被强制取消。
- Stage 3 的 `hasReadback` 固定为 false；需要受控 readback 的 Verifier
  在完整持久化关联链接入前保持 fail closed。
- Authenticity 仍固定 unverified。
- 未新增 Migration、Schema 字段或依赖。

## 9. 边界声明

本轮：

- 没有执行 Recovery、Read-back、Provider、LLM、Write 或真实 Verifier。
- 没有修改 Task.status。
- 没有创建数据库。
- 没有开始 Step 6.3.4.4 或 Step 6.3.5。

完成后停止，等待 Stage 3 架构评审。
