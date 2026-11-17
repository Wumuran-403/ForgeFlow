# ForgeFlow Phase 3 Step 6.3.5 G2-F.1 Development Report

> Step：G2-F.1 Contract / Gateway Internal Tests
>
> 状态：开发完成，等待 G2-F.1 架构评审。
>
> 最高验收级别：L1 Internal Implementation Complete
>
> Production Entry：Closed
>
> G2：仍 BLOCKED

## 1. 实际新增文件

Host auth：

- `src/host-auth/host-assertion.ts`
- `src/host-auth/host-authentication-config.ts`
- `src/host-auth/ed25519-host-authentication-adapter.ts`

Host Gateway：

- `src/host/authenticated-principal.ts`
- `src/host/authenticated-host-request-context.ts`
- `src/host/recovery-review-host-gateway.ts`

Tests：

- `tests/host-auth/host-auth-fixture.ts`
- `tests/host-auth/host-assertion.test.ts`
- `tests/host-auth/ed25519-host-authentication-adapter.test.ts`
- `tests/host/recovery-review-host-gateway.test.ts`

报告：

- `docs/PHASE3_STEP6_3_5_G2_F1_DEVELOPMENT_REPORT.md`

未修改：

- `src/recovery/index.ts`
- Step 1 文件或报告。
- Final RecoveryReview Design。
- Migration / SQLite Schema。
- Stage 3.2 / 3.3 / 3.4 已封存实现。

## 2. HostAssertionV1

Schema：

```text
HostAssertionV1Schema
  schemaVersion = forgeflow.host-assertion.v1
  keyId
  claims
  signature
```

Claims：

```text
issuer
audience
actorId
actorType
role
scopes
issuedAt
notBefore
expiresAt
assertionId
```

约束：

- strict object，未知字段拒绝。
- actorType 必须与 role 一致：
  - `manual_reviewer -> human_reviewer`
  - `host_verifier -> host_verifier`
- 只允许单一 role；不支持 role array / multiple roles。
- scopes 至少一个且不可重复：
  - `recovery_review.final_decision`
  - `recovery_review.read_replay`
- Ed25519 signature 必须是 86 字符 base64url。
- `expiresAt > notBefore >= issuedAt`。

Canonical signing input：

```text
canonicalJson({
  schemaVersion,
  keyId,
  claims
})
```

Signature 不参与 signing input，但参与完整 assertion digest。

## 3. HostAuthenticationConfigV1

Schema：

```text
forgeflow.host-authentication-config.v1
  audience
  maximumAssertionTtlSeconds
  clockSkewSeconds
  trustedKeys[]
  revokedAssertionIds[]
```

Trusted key mapping：

```text
keyId
issuer
publicKeyPem
actorId
actorType
role
allowedScopes
status = active | revoked
```

约束：

- keyId 全局唯一。
- 同一 public key 不得映射到多个 identity / role。
- 同一 actorId 不得同时映射到 Human Reviewer 与 Host Verifier role。
- actorType 必须与 role 一致。
- allowedScopes 不可重复。
- 私有密钥字段不允许出现在 config：
  - unknown `privateKeyPem` 被 strict schema 拒绝。
- Adapter 构造时验证真实 Ed25519 public key。
- equivalent PEM 再编码通过 SPKI fingerprint 做二次唯一性检查。

## 4. Trusted keyId Mapping

Human Reviewer：

- 每个 Reviewer 使用独立 key pair / keyId。
- keyId 固定映射 actorId、actorType、role、allowedScopes、status。
- assertion claim 与 mapping 任一不一致即拒绝。
- signing fixture 使用真实 private key 生成签名；不存在 Mock Principal。

Host Verifier：

- 独立 key pair / keyId / public key。
- 固定映射 `actorType=host_verifier`、`role=host_verifier`。
- Human 与 Verifier key 不能复用。

拒绝：

- 跨 actorId。
- 跨 actorType / role。
- 跨 issuer。
- 跨 scope。
- revoked key。
- revoked assertion。
- 私钥被纳入 runtime config。

## 5. AuthenticatedPrincipal

接口 / schema：

```text
AuthenticatedPrincipalSchema
  actorId
  actorType
  role
  issuerScope
  scopes
  issuer
  keyId
  assertionId
  authenticationEvidenceId
  authenticatedAt
  expiresAt
```

Adapter 仅在以下全部通过后返回 frozen Principal：

- Ed25519 signature valid。
- key active / assertion not revoked。
- issuer / audience exact。
- actor / role / scopes 与 keyId mapping exact。
- time window valid。
- TTL 不超过配置上限。

AuthenticationEvidenceId：

```text
sha256(jcs({
  issuer,
  keyId,
  assertionId,
  actorId,
  actorType,
  role,
  audience,
  scopes,
  issuedAt,
  expiresAt,
  assertionDigest
}))
```

不包含 raw Bearer token 或 private key。

## 6. AuthenticatedHostRequestContext

Context 使用 module-private WeakMap。

Claims：

```text
contextId
actorId
actorType
issuerScope
allowedAccess
authenticationEvidenceId
assertionId
requestNonce
issuedAt
expiresAt
```

要求：

- Context 仅由 `RecoveryReviewHostGateway` 内部 private function 创建。
- `authenticated-host-request-context.ts` 不导出 creator。
- raw object、spread clone、JSON clone、TypeScript cast 无法通过 assertion。
- Context 不得被序列化后恢复为可信权限。
- requestNonce 由 Gateway 生成。

## 7. RecoveryReviewHostGateway

接口：

```text
RecoveryReviewHostGateway.createContext({
  assertion,
  access: final_decision | read_replay
})
```

Gateway：

- 只接受 assertion 和 requested access。
- 不接受 body actorId / actorType / issuerScope。
- 调用真实 Ed25519 adapter。
- 从 keyId mapping 派生 actor / role / issuerScope。
- 检查 requested access 对应的 scope。
- 创建 opaque Context。

Gateway / Context creator 未从以下位置导出：

```text
src/recovery/index.ts
src/host/authenticated-host-request-context.ts
```

普通业务模块静态检查：

- `AgentRunner`
- `ToolRegistry`
- `RecoveryManager`

均未 import Gateway / Context 模块。

## 8. 测试证据

Targeted files：

```text
tests/host-auth/host-assertion.test.ts
tests/host-auth/ed25519-host-authentication-adapter.test.ts
tests/host/recovery-review-host-gateway.test.ts
```

覆盖：

- 合法 Human / Verifier assertion。
- 真实 Ed25519 sign + verify。
- Signature invalid。
- Unknown keyId。
- Wrong issuer。
- Actor / role mismatch。
- Scope escalation。
- Wrong audience。
- Expired assertion。
- Future notBefore。
- Excessive TTL。
- Revoked assertionId。
- Revoked keyId。
- Multiple roles / unknown role shape。
- Non-Ed25519 public key。
- Duplicate keyId / public key。
- Private key material in config。
- request DTO 注入身份字段拒绝。
- Context clone / cast / JSON forgery。
- Gateway / creator public API 不可见。
- 普通 business modules 无 Gateway import。

## 9. 实际命令与结果

Targeted：

```text
pnpm vitest run \
  tests/host-auth/host-assertion.test.ts \
  tests/host-auth/ed25519-host-authentication-adapter.test.ts \
  tests/host/recovery-review-host-gateway.test.ts

Test Files  3 passed (3)
Tests       17 passed (17)
```

Full suite：

```text
pnpm test

Test Files  62 passed (62)
Tests       665 passed (665)
```

Typecheck：

```text
pnpm typecheck

$ tsc --noEmit
```

结果：通过。

Diff check：

```text
git diff --check
```

结果：通过，无 whitespace error；仅有当前工作副本既有 LF/CRLF 提示。

## 10. 已知限制

- G2-F.1 不包含真实 HTTP Host Server / Routes。
- 不包含 key-file loader、public-key deployment config 或 loopback HTTP
  integration。
- revocation 由 static config 提供；动态 reload / remote revocation service
  不在 G2-F.1。
- 没有 composition root wiring。
- 没有 Final Decision / Replay capability issuer。
- 内部模块仍可通过相对路径 import；当前边界依靠模块未导出 creator、Gateway
  不进入 recovery public barrel、composition discipline 与静态测试约束。
- 真实 G2 evidence 必须由 G2-F.2 的 Ed25519 HTTP integration 提供。

## 11. G2 / Production 状态

- G2：**BLOCKED**。
- G2-F.2：未实施。
- G2-F.3：未实施。
- Step 2：未开始。
- Production Entry：**Closed**。

## 12. 封存判断

G2-F.1 满足 L1 Internal Implementation Complete 候选条件：

- Contract / adapter / Gateway 内部实现完成。
- 真实 Ed25519 signature verification 测试通过。
- Opaque Context 与权限拒绝测试通过。
- 无 HTTP Host Entry。
- 无 Final Decision capability / issuer。

等待 G2-F.1 架构评审；不得自行进入 G2-F.2 或 Step 2。
