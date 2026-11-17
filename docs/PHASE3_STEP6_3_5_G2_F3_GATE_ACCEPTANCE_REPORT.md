# ForgeFlow Phase 3 Step 6.3.5 G2-F.3 Gate Acceptance Report

> Step：G2-F.3 Final G2 Gate Acceptance
>
> 状态：只读审计完成。
>
> 结论：**G2 Gate BLOCKED**
>
> G2 Foundation：不具备整体封存条件
>
> Step 2：不具备申请开发授权条件
>
> Production Entry：Closed

## 1. 执行摘要

G2-F.1 / G2-F.2 的功能测试全部通过：

- 真实 Ed25519 sign / verify。
- Loopback HTTP。
- KeyId mapping。
- audience / expiry / notBefore / scope / revocation。
- Human / Verifier 密钥域。
- DTO 身份注入拒绝。
- Context object clone / cast 拒绝。

但最终信任边界审计发现一项 P1：

```text
任意进程内模块可相对导入公开的 Gateway / Adapter 构造函数，
自行生成 Ed25519 key pair 与 trusted config，
创建能被全局 assertAuthenticatedHostRequestContext() 接受的 Context。
```

因此普通业务模块虽然当前没有 import Gateway，但技术上可以取得可信
Context。G2 不能通过。

## 2. 实际核查的源码

### Host Assertion / Auth

- `src/host-auth/host-assertion.ts`
- `src/host-auth/host-authentication-config.ts`
- `src/host-auth/host-authentication-config-loader.ts`
- `src/host-auth/host-assertion-bearer.ts`
- `src/host-auth/host-assertion-signer.ts`
- `src/host-auth/ed25519-host-authentication-adapter.ts`

### Gateway / HTTP

- `src/host/authenticated-principal.ts`
- `src/host/authenticated-host-request-context.ts`
- `src/host/recovery-review-host-gateway.ts`
- `src/host/http/recovery-review-host-server.ts`
- `scripts/host-auth/issue-host-assertion.ts`

### 普通业务 / Public API

- `src/recovery/index.ts`
- `src/agent/agent-runner.ts`
- `src/tools/registry.ts`
- `src/provider/*`
- `src/recovery/recovery-manager.ts`

### Tests

- `tests/host-auth/host-assertion.test.ts`
- `tests/host-auth/ed25519-host-authentication-adapter.test.ts`
- `tests/host-auth/host-authentication-config-loader.test.ts`
- `tests/host-auth/host-assertion-signer.test.ts`
- `tests/host/recovery-review-host-gateway.test.ts`
- `tests/integration/recovery-review-host-auth.test.ts`
- `tests/integration/host-auth-http-worker.ts`
- `tests/integration/host-auth-signing-cli.test.ts`

## 3. G2 Gate 逐条证据

### G2-1 HostAssertionV1 与真实 Ed25519

状态：**PASS**

源码：

- `host-assertion.ts`
- `ed25519-host-authentication-adapter.ts`

测试：

- “accepts signed Human and Verifier assertions”
- “authenticates Human and Verifier principals with real signatures”

证据：

- 使用临时生成的真实 Ed25519 key pair。
- `sign()` 生成 signature，`verify()` 验证。
- Invalid signature 拒绝。

### G2-2 Trusted keyId mapping

状态：**PASS**

源码：

- `host-authentication-config.ts`
- `ed25519-host-authentication-adapter.ts`

测试：

- “rejects signed claims that do not match trusted key mapping”
- “rejects duplicate mappings and private key material in config”

证据：

- keyId 唯一。
- public key 唯一。
- actorId 不跨 Human / Verifier role。
- issuer / actor / role / scopes 与 mapping exact。

### G2-3 Audience / expiry / notBefore / TTL

状态：**PASS**

测试：

- “rejects wrong audience, expired assertions, future notBefore, and excessive TTL”

### G2-4 Revocation

状态：**PASS，带快照时效限制**

测试：

- “rejects revoked assertions and revoked keys”
- “rejects revoked assertions and revoked key mappings over HTTP”

限制：

- Revocation 只在 Adapter / Server 构造时从 config snapshot 读取。
- 运行中修改文件不会自动 reload。
- 撤销最迟在新的 Adapter / Server 构造后生效。

这不阻断当前静态配置认证，但意味着不能宣称“即时撤销”。

### G2-5 Human / Verifier key domain

状态：**PASS**

测试：

- “rejects cross-actor, cross-role, cross-issuer, and cross-key signatures”
- “authenticates Human and Verifier bearer assertions over loopback HTTP”

### G2-6 HTTP DTO 不能选择身份

状态：**PASS**

源码：

- `recovery-review-host-server.ts`

测试：

- “rejects scope escalation and identity fields in the HTTP DTO”

证据：

- strict DTO 只允许 `access`。
- actorId / actorType / issuerScope 等额外字段返回 400。

### G2-7 Opaque Context clone / cast

状态：**PASS（仅针对已签发 Context object）**

测试：

- “rejects Context clones, casts, JSON roundtrips, and cross-access use”

证据：

- spread clone 拒绝。
- JSON roundtrip 拒绝。
- cast object 拒绝。

但该测试不能证明 Context creation authority 不可伪造，见 P1。

### G2-8 Context Creator 不导出

状态：**PASS（字面）**

源码：

- `authenticated-host-request-context.ts` 不导出 creator。
- private creator 位于 `recovery-review-host-gateway.ts`。

测试：

- “does not expose Gateway or Context creators through recovery public API”

限制：

- Gateway 本身仍从普通模块文件导出。
- 普通模块可相对导入 Gateway，并调用 public `createContext()`。

### G2-9 Ordinary business modules 无静态 import

状态：**PASS（静态当前调用图）**

测试：

- “keeps Gateway and Context imports out of ordinary business modules”

限制：

- 这是当前 import graph 检查，不是运行时模块隔离。
- 不阻止普通模块新增相对 import。

### G2-10 HTTP loopback / body limit / no business route

状态：**PASS**

源码：

- `recovery-review-host-server.ts`

测试：

- “rejects non-loopback binding and does not import signer code”
- “authenticates through a separate Node worker process”

证据：

- 默认 `127.0.0.1`。
- 非 loopback bind 拒绝。
- socket remote address 必须 loopback。
- body 上限 8 KiB。
- 唯一 route 是 `/internal/recovery-review/authenticate`。
- 无 Final Decision / Replay 业务 route。

### G2-11 Runtime 不持有 private key

状态：**PASS**

证据：

- Server 只接收 HostAuthenticationConfig public-key / revocation config。
- Config strict schema 拒绝 private key 字段。
- Signing CLI 单独读取 private key 文件。
- Server module 不 import signer。

### G2-12 Context creation authority

状态：**FAIL**

这是最终 G2 Gate 阻断项。

## 4. P1 缺陷

### 标题

```text
In-process Gateway construction can mint trusted Context
```

### 影响

任何能执行项目内 TypeScript / JavaScript 的普通业务模块都可以：

1. 相对 import `Ed25519HostAuthenticationAdapter`。
2. 相对 import `RecoveryReviewHostGateway`。
3. 生成自己的 Ed25519 key pair。
4. 构造自己的 HostAuthenticationConfig，将自建 public key 映射到
   `human_reviewer` / `manual_reviewer`。
5. 用自己的 private key 签 assertion。
6. 实例化 Adapter 和 Gateway。
7. 调用 public `gateway.createContext()`。
8. 获得由同一 module-level WeakMap 接受的可信 Context。

### 实际验证

执行了一次不写文件的临时 TypeScript 脚本：

```text
自建 Ed25519 key pair
  -> self-owned config
  -> Adapter
  -> Gateway
  -> self-signed assertion
  -> createContext()
  -> assertAuthenticatedHostRequestContext()
```

实际输出：

```json
{
  "actorId": "attacker-actor",
  "actorType": "human_reviewer",
  "issuerScope": "manual_reviewer",
  "access": "final_decision"
}
```

这证明：

- Context object 本身不可 clone / cast。
- 但调用方可以合法构造一个自己的 Gateway，并创建原始可信 Context。
- 当前 WeakMap 作用域只保证“Context 由某个 Gateway 创建”，不保证
  “Gateway 是 Host Composition Root 的受信实例”。

### 现有测试为何未发现

现有 tests 验证：

- 已签发 Context 不可篡改。
- 普通业务模块当前没有 import。
- recovery public barrel 不导出。

但没有验证：

- 任意进程内模块实例化自己的 Gateway 能否创建 Context。
- Context 是否绑定到唯一受信 Gateway instance / trust root。

## 5. 最小修复方案建议

### 方案 A（推荐）：独立 Host Control 信任域

将以下对象移入独立 Host Control execution domain：

- Ed25519 Adapter
- Gateway
- Context creator
- 后续 Step 2 capability issuer

可选实现：

- separate Node worker / process；或
- Host Control 独立 executable / package boundary。

业务进程 / Agent Runtime 不链接 Gateway / issuer，只通过受控 Host Control
接口请求 Decision / Replay 执行。Context 与 capability 不离开 Host 信任域。

优点：

- 不再依赖“业务模块不会相对 import”的代码自律。
- 普通业务模块无法实例化自己的 Gateway。
- Step 2 capability issuer 同处 Host trust domain。

### 方案 B：进程内 Trust Anchor Registry

引入不可由普通模块注册的 TrustedGateway Registry：

- Context 只能由 Registry 中预注册的唯一 Gateway 实例创建。
- Registry 初始化只允许 Host bootstrap。
- Context assertion 必须验证 Gateway instance identity。

问题：

- 在同一个 JS execution domain 内，普通模块仍可能 import Registry
  bootstrap API。
- 除非通过独立 bundle / package export policy / process boundary 隔离，
  否则只是提高绕过成本。

因此若坚持“任意普通业务模块不可获得 Context”，方案 A 更可靠。

## 6. HTTP 安全边界

已验证：

- loopback only。
- strict JSON / size limit。
- bearer token canonical decode。
- 真实 signature verify。
- no Context / token / private key in response。
- no logs in server code。
- no Final Decision / Replay route。

当前 HTTP 攻击面未发现直接业务执行入口。

## 7. 密钥 / 配置 / 撤销生命周期

当前保证：

- Runtime 只加载 public key 和 revocation config。
- Private key 只在 signing CLI / Host signer。
- key status 与 revokedAssertionIds 在 Adapter 构造时快照。

当前不保证：

- config hot reload。
- immediate/online revocation。
- file ACL 检查。
- rate limiting。

这些不是本次 P1 的主因，但应作为 G2 运行限制记录。

## 8. 实际测试命令和结果

G2 targeted：

```text
pnpm vitest run \
  tests/host-auth/host-assertion.test.ts \
  tests/host-auth/ed25519-host-authentication-adapter.test.ts \
  tests/host-auth/host-authentication-config-loader.test.ts \
  tests/host-auth/host-assertion-signer.test.ts \
  tests/host/recovery-review-host-gateway.test.ts \
  tests/integration/recovery-review-host-auth.test.ts \
  tests/integration/host-auth-signing-cli.test.ts

Test Files  7 passed (7)
Tests       31 passed (31)
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

结果：通过，无 whitespace error；仅有现有工作副本 LF/CRLF 提示。

## 9. 剩余风险

- P1：进程内 Gateway 自构造可 mint trusted Context。
- Static revocation snapshot，无 hot reload / immediate revocation。
- HTTP 无 rate limiting。
- File ACL 由部署负责。
- Node loopback HTTP 不是跨用户进程隔离机制。
- 普通模块相对 import 的边界依赖代码审查，不是安全沙箱。

## 10. G2 Gate 结论

```text
G2 Gate: BLOCKED
```

原因：

```text
Context creation trust root can be self-attested in-process.
```

## 11. G2 Foundation 封存结论

```text
G2 Foundation: Not sealable.
```

F1 / F2 implementation 与 tests 保留，不改写。

需要先架构评审并批准最小修复方案，再重新授权：

- G2 trust-domain remediation；或
- 明确修改安全威胁模型，承认所有 in-process code 属于 trusted
  computing base。

在没有明确决定前，不得宣称普通业务模块无法取得 Gateway / Context。

## 12. Step 2 状态

```text
Step 2: Not authorized / Not ready.
```

原因：

- Step 2 capability 会消费 Context。
- 当前 Context trust root 可被进程内模块自构造。
- 在这个缺陷修复前，Final Decision Authorization 的安全前提不成立。

现停止，等待 G2-F.3 架构评审。
