# ForgeFlow Phase 3 Step 6.3.5 G2-F.2 Development Report

> Step：G2-F.2 Real Host Authentication Adapter Integration
>
> 状态：开发完成，等待 G2-F.2 架构评审。
>
> 最高验收级别：L2 Integration Verified
>
> Production Entry：Closed
>
> G2：仍 BLOCKED

## 1. 实际新增 / 修改文件

新增生产代码：

- `src/host-auth/host-authentication-config-loader.ts`
- `src/host-auth/host-assertion-bearer.ts`
- `src/host-auth/host-assertion-signer.ts`
- `src/host/http/recovery-review-host-server.ts`

新增 Host signer tooling：

- `scripts/host-auth/issue-host-assertion.ts`

新增测试：

- `tests/host-auth/host-authentication-config-loader.test.ts`
- `tests/host-auth/host-assertion-signer.test.ts`
- `tests/integration/recovery-review-host-auth.test.ts`
- `tests/integration/host-auth-http-worker.ts`
- `tests/integration/host-auth-signing-cli.test.ts`

修改：

- `tsconfig.json`
  - 将 `scripts/**/*.ts` 纳入 typecheck。

新增报告：

- `docs/PHASE3_STEP6_3_5_G2_F2_DEVELOPMENT_REPORT.md`

未修改：

- G2-F.1 已封存文件。
- `src/recovery/index.ts`。
- Final RecoveryReview Design。
- Migration / SQLite Schema。
- Stage 3.2 / 3.3 / 3.4。

## 2. HTTP Host Server

实现：

```text
startRecoveryReviewHostServer()
```

入口：

```text
POST /internal/recovery-review/authenticate
Authorization: Bearer <HostAssertionV1 token>
Content-Type: application/json

body:
{
  access: "final_decision" | "read_replay"
}
```

安全属性：

- 使用 Node built-in `http`。
- 默认绑定 `127.0.0.1`。
- 显式拒绝非 loopback host binding。
- 请求来源 socket 也必须是 loopback。
- body 上限 8 KiB。
- 严格 JSON + strict Zod。
- body 不允许 actorId、actorType、issuerScope 或 scopes。
- 不返回 Context 或 Bearer token。
- 只返回脱敏认证摘要：

```text
authenticated
actorId
actorType
issuerScope
access
authenticationEvidenceId
requestNonce
expiresAt
```

- `Cache-Control: no-store`。
- 不提供 Final Decision / Replay 业务入口。

## 3. Public-key / Revocation Config

Loader：

```text
loadHostAuthenticationConfigFromFile(path)
```

- 读取 public-key / issuer / actor / role / scopes / status config。
- strict schema；unknown private-key 字段拒绝。
- JSON / I/O / schema 错误 fail closed。
- revocation 当前来自：
  - trusted key `status=revoked`
  - `revokedAssertionIds[]`

Runtime 只加载 public keys 和 revocation config；不加载 signing private key。

## 4. Bearer Assertion

Token format：

```text
forgeflow-host-assertion.v1.<base64url(canonical HostAssertionV1 JSON)>
```

HTTP header：

```text
Authorization: Bearer forgeflow-host-assertion.v1.<...>
```

Decoder：

- prefix / max length 校验。
- base64url canonical encoding 校验。
- UTF-8 fatal decode。
- JSON parse。
- HostAssertionV1 strict parse。
- re-encode 必须与输入完全一致。
- 所有错误映射为 authentication failure。

## 5. Signing Tooling

Pure signer：

```text
issueHostAssertion()
```

CLI：

```text
pnpm exec tsx scripts/host-auth/issue-host-assertion.ts \
  --config <public-config.json> \
  --key-id <trusted-key-id> \
  --private-key <reviewer-private-key.pem> \
  [--scope <scope>]... \
  [--assertion-id <id>] \
  [--ttl-seconds <n>]
```

限制：

- 不接受 `--actor-id`、`--actor-type`、`--role` 或 issuer 参数。
- 身份与权限只能来自 keyId trusted mapping。
- private key 必须与 mapping public key 匹配。
- scope subset 必须属于 mapping allowedScopes。
- TTL 不得超过 config 最大值。
- revoked key 拒绝签发。
- private key 不进入 stdout / HTTP response。

## 6. 真实 Ed25519 HTTP 认证链

实际链路：

```text
Bearer HostAssertionV1
  -> bearer decode
  -> Ed25519HostAuthenticationAdapter
       -> keyId mapping
       -> real Ed25519 signature verify
       -> issuer / audience
       -> actor / role / scopes
       -> time / TTL / revocation
       -> AuthenticatedPrincipal
  -> RecoveryReviewHostGateway
       -> role-derived issuerScope
       -> requested access scope check
       -> opaque AuthenticatedHostRequestContext
  -> HTTP sanitized authentication summary
```

测试使用临时生成的真实 Ed25519 key pairs 并执行真实 sign/verify；没有
Mock Principal。

## 7. Human / Verifier 隔离

- Human Reviewer 与 Host Verifier 使用不同 key pair / keyId。
- Human key 只能映射 `human_reviewer + manual_reviewer`。
- Verifier key 只能映射 `host_verifier + host_verifier`。
- 同一 actorId 不能跨 Human / Verifier role。
- 同一 public key 不能映射多个 identity。
- Cross actor / role / issuer / scope tests 均拒绝。

## 8. 普通业务模块隔离

验证：

- `src/recovery/index.ts` 不导出 Gateway、Context creator、Adapter 或 signer。
- `AgentRunner`、`ToolRegistry`、`RecoveryManager` 未 import Gateway /
  Context 模块。
- HTTP server module 不 import signer。
- Runtime server 不读取 private key。
- Gateway 不返回 Context。

已知代码级限制：

- TypeScript / Node 进程内代码仍可通过相对路径 import 内部文件。
- 当前边界由不导出 creator、Composition Root 归属、普通业务模块静态检查和
  module-private WeakMap 组成。

## 9. 负例覆盖

已覆盖：

- Missing Authorization。
- Malformed Bearer。
- Invalid Ed25519 signature。
- Unknown keyId。
- Wrong issuer。
- Wrong audience。
- Expired assertion。
- Future notBefore。
- Excessive TTL。
- Revoked assertion ID。
- Revoked key。
- Actor mapping mismatch。
- Role / actorType mismatch。
- Multiple role shape。
- Scope escalation。
- Human / Verifier cross-key。
- Body actorId / actorType / issuerScope injection。
- Private key material in config。
- Non-Ed25519 public key。
- Duplicate keyId / public key。
- Context spread clone / JSON clone / cast。
- Non-loopback binding。

## 10. 实际命令与结果

G2-F.2 targeted：

```text
pnpm vitest run \
  tests/host-auth/host-authentication-config-loader.test.ts \
  tests/host-auth/host-assertion-signer.test.ts \
  tests/integration/recovery-review-host-auth.test.ts \
  tests/integration/host-auth-signing-cli.test.ts

Test Files  4 passed (4)
Tests       14 passed (14)
```

Full suite：

```text
pnpm test

Test Files  66 passed (66)
Tests       679 passed (679)
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

## 11. 已知限制 / 未实施范围

- 未实现 G2-F.3 final Gate acceptance package。
- 未实现 Final Decision / Replay capability 或 issuer。
- 未接入 Final Decision / Replay 业务 service。
- 未实现 production composition root。
- Config / revocation 当前为文件加载，无 hot reload 或 remote revocation。
- public-key / revocation / private-key 文件的 OS 文件权限由 Host 部署负责；
  runtime 不检查或修改文件 ACL。
- HTTP 仅 loopback；非 loopback 仍需 Host TLS ingress 设计。
- 无 rate limiting / request audit storage。
- 无 Migration / Schema 变更。

## 12. 验收级别与生产状态

- 最高验收级别：**L2 Integration Verified**。
- Production Entry：**Closed**。
- 真实 HTTP route 仅为内部认证探针，不执行真实业务。
- G2-F.3 未执行，G2 Gate 尚未最终通过。

## 13. 封存判断

G2-F.2 满足 L2 候选条件：

- 真实 Ed25519 sign / verify。
- 真实 loopback HTTP integration。
- Separate human / verifier key domains。
- Public-key / revocation config loading。
- Signing CLI 与 trusted keyId mapping。
- Negative authentication and forgery tests。
- 无 Final Decision / Replay capability。
- 无 production business entry。

等待 G2-F.2 架构评审；不得自行进入 G2-F.3 或 Step 2。
