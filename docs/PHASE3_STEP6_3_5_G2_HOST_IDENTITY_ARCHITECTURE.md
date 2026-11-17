# ForgeFlow Phase 3 Step 6.3.5 G2 Host Identity & Issuer Boundary Architecture

> 状态：只读架构设计与 G2 解阻方案，等待架构评审。
>
> 基线：
> - `docs/PHASE3_STEP6_3_5_FINAL_RECOVERY_REVIEW_DESIGN.md`
> - `docs/PHASE3_STEP6_3_5_IMPLEMENTATION_PLAN.md`
> - `docs/PHASE3_STEP6_3_5_STEP2_DEVELOPMENT_REPORT.md`
>
> 本文件不授权生产代码、测试、Migration、Schema 或依赖修改。

## 0. 结论摘要

### 当前判断

- 当前项目没有真实可信的 Host authentication boundary。
- 当前应用没有 HTTP / API Host 部署入口，只有 CLI health-check。
- `controlActor` 与 `authenticatedActorId` 都是普通数据字段，不是认证证明。
- 不存在可以安全创建 `AuthenticatedHostRequestContext` 的现有组件。
- Step 2 不能仅靠新增 WeakMap capability 完成 G2。

### 推荐方案

采用：

```text
Option C Host RecoveryReview Gateway
  + Host Authentication Adapter 提供可信 Principal
  + opaque AuthenticatedHostRequestContext
  + module-private Manual / Host Verifier issuer scope
  + 独立 access=final_decision / read_replay capability
```

### 实施顺序建议

建议先增加一个独立 Implementation Plan 前置子步骤：

```text
G2 Foundation / Step 2A
  -> Host Authentication Adapter contract
  -> AuthenticatedPrincipal
  -> Host Gateway
  -> opaque Context
  -> Context / issuer isolation tests
```

现有 Step 2 在其通过后，只实现 Final Decision / Replay capability claims
和 issuer 消费逻辑。

本建议需要 Implementation Plan 单独修订和评审。本轮不修改计划文件。

## 1. 源码核查范围

已阅读：

- `src/index.ts`
- `src/config/env.ts`
- `src/persistence/coordinator.ts`
- `src/agent/agent-runner.ts`
- `src/recovery/recovery-evidence-host-control-authorization.ts`
- `src/recovery/recovery-verifier-registry.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- 现有 Recovery / Capability / Verifier tests

未修改任何源码或测试。

## 2. 实际问题与源码证据

### 2.1 没有真实 Host 部署入口

`src/index.ts` 当前只执行：

```text
loadConfig()
  -> runHealthCheck()
  -> stdout JSON
```

没有：

- HTTP server。
- request authentication middleware。
- session / cookie / bearer token verification。
- mTLS principal。
- OIDC / SSO callback。
- Host Control Gateway。
- Host user / service identity context。

结论：

```text
当前 application composition 不包含 authenticated Host request path。
```

### 2.2 Host Control capability 不是身份认证

`src/recovery/recovery-evidence-host-control-authorization.ts`：

- 使用 module-private WeakMap。
- issuer 未从 `src/recovery/index.ts` 公开。
- issuer input 包含 `controlActor` 普通字符串。

它只证明：

```text
capability object 由当前进程内 issuer 创建。
```

不能证明：

```text
controlActor 是当前请求真实认证的 Host principal。
```

任何能够相对导入 issuer 文件的内部代码仍可传入任意字符串。

### 2.3 Verifier authenticatedActorId 不是当前 Host principal

`RecoveryVerifierContextSchema` 有：

```text
authenticatedActorId
trustAnchorId
```

但 `RecoveryEvidenceVerificationService` 当前把：

```text
graph.manifest.actorId
```

写入 `authenticatedActorId`。

该 actorId 是历史 Evidence Manifest 中记录的人工 actor，不是当前 verifier
请求的 authenticated session principal。

拒绝调用的校验也只检查字段组合，不检查 Host token、session、mTLS 或签名。

结论：

```text
historical evidence actorId != current authenticated Host identity.
```

### 2.4 Dispatch Preflight capability 与身份无关

`RecoveryEvidenceDispatchPreflightCapability` 证明：

- Registry exact allowlist / contract digest 已验证。

它不证明：

- 调用者是人类 Reviewer。
- 调用者是 Host Verifier。
- 调用者拥有 final_decision 或 read_replay 权限。

不得把 Preflight / Operation / HostControl capability 升级为 Final Decision
Authorization。

## 3. 逐项回答

### Q1. 当前项目是否有真正可信的 Host 认证入口？

**没有。**

当前只有 CLI entry，没有 Host transport or authentication boundary。

### Q2. controlActor / authenticatedActorId 是否只是普通数据？

**是。**

- `controlActor` 可由调用方输入。
- `authenticatedActorId` 是 verifier context 字段，当前来自历史 Manifest。
- 两者都不是 host-verified identity assertion。

### Q3. 哪个组件可以安全创建 AuthenticatedHostRequestContext？

当前没有。

新增架构中只允许：

```text
Host RecoveryReview Gateway
```

在以下顺序完成后创建：

```text
Host transport request
  -> Host Authentication Adapter
  -> verified AuthenticatedPrincipal
  -> Gateway role / permission mapping
  -> opaque AuthenticatedHostRequestContext
```

Gateway 不信任 HTTP body、Agent 参数或 Tool 参数中的 actor 字段。

### Q4. Manual Reviewer / Host Verifier 的身份和权限分别由谁确认？

Manual Reviewer：

- Host Authentication Adapter 确认真人身份。
- Adapter 返回 `actorType=human_reviewer`。
- 只有具备 `manual_reviewer` role 的 principal 才可映射到
  `issuerScope=manual_reviewer`。

Host Verifier：

- Host Authentication Adapter 确认服务身份。
- 认证方式可以是 mTLS、signed service token、internal workload identity。
- Adapter 返回 `actorType=host_verifier`。
- 只有具备 `host_verifier` role 的 principal 才可映射到
  `issuerScope=host_verifier`。

Gateway 负责：

- 将 authenticated role 映射为允许的 issuerScope。
- 拒绝调用方自行选择 actorType。
- 拒绝一个 scope 的 context 用于另一 scope。

### Q5. 是否存在 Agent / Tool / HTTP DTO / Service 绕过 Gateway 获取 issuer 的路径？

当前不存在 issuer，因此没有可绕过的 Final Decision issuer。

拟议架构中必须保证：

- Gateway 与 issuer 不从 `src/recovery/index.ts` 导出。
- AgentRunner、ToolRegistry、Provider、RecoveryManager 和普通 business
  services 不持有 Gateway / issuer 实例。
- HTTP DTO 不包含 issuer / actorType / authenticationEvidenceId 权限字段。
- Context 与 capability 使用 module-private WeakMap，JSON / spread clone /
  cast 无法恢复。
- capability issuer 是 Gateway 内部闭包，不是公开 free function。
- Host transport route 只调用 Gateway；业务 Service 只消费 capability。

### Q6. 当前是否有实际 Host 部署入口？

**没有。**

最小可信 Host Authentication Adapter 必须先引入一个真实 Host transport：

- HTTP API + SSO/session/token verification，或
- mTLS service ingress，或
- 已认证的 Host Control Gateway。

在没有选定 Host runtime 和 credential verification 方式前，不能用
`NODE_ENV`、环境变量 username、CLI 参数、fixture 或 actorType 字段代替认证。

## 4. 三层信任模型

以下三层必须分开：

### Layer 1: Authenticated Principal

由真实 Host Authentication Boundary 产出：

```text
AuthenticatedPrincipal
  actorId
  actorType
  issuerScope
  authenticationEvidenceId
  permissions
  authenticatedAt
  expiresAt
```

该层证明“当前请求是谁”。

### Layer 2: AuthenticatedHostRequestContext

由 Host RecoveryReview Gateway 在取得 Layer 1 后创建：

```text
contextId
actorId / actorType
issuerScope
allowedAccess
authenticationEvidenceId
requestNonce
createdAt / expiresAt
```

该层证明“可信 Host 已把认证结果绑定到当前 RecoveryReview 请求”。

它不等同于 Layer 1，也不等同于 Layer 3。

### Layer 3: Final Decision / Replay Capability

由 private issuer 消费 Layer 2 后创建：

```text
RecoveryReviewFinalDecisionAuthorization
RecoveryReviewTerminalReplayAuthorization
```

该层证明“该 authenticated request context 已为这个精确请求签发特定
access”。

Capability 必须继续绑定：

- taskId
- reviewId
- originalUnknownWriteToolRunId
- operation
- expectedDecisionVersion
- operationPayloadDigest
- sourceContractDigest
- requestKey
- actorId
- actorType
- requestNonce

不能用 Layer 2 或 capability 反向证明 Layer 1 的真实认证。

## 5. 方案比较

### Option A: 直接使用 AuthenticatedPrincipal

不采用作为最终边界：

- Principal 可能被普通业务 service 持有和传递。
- 缺少对具体 final_decision / read_replay 请求的绑定。
- 难以限制 issuer 调用范围。

Principal 仅作为 Gateway 的输入。

### Option B: 继续使用普通 controlActor 字符串

不采用：

- 无法证明身份。
- 任意内部 caller 可选择 actorType。
- WeakMap 只能防对象伪造，不能防 issuer 越权。

### Option C: Host Gateway + opaque Context

采用：

- 认证由真实 Host boundary 完成。
- Gateway 是唯一 Context 创建者。
- Context 不离开 Host/Gateway 边界。
- Issuer 由 Gateway private closure 持有。
- capability 精确绑定请求。
- recovery business layer 只消费 capability。

## 6. 推荐调用链

```text
Host HTTP / Control transport
  -> HostAuthenticationAdapter.authenticate(rawTransportRequest)
       -> verified AuthenticatedPrincipal
  -> HostRecoveryReviewGateway.issueFinalDecisionAuthorization(
       rawTransportRequest,
       command
     )
       -> re-authenticate or consume authenticated principal
       -> validate role / permission
       -> create AuthenticatedHostRequestContext (module-private WeakMap)
       -> build canonical request identity
       -> private issuer
       -> RecoveryReviewFinalDecisionAuthorization
  -> Final Decision Service
       -> assert capability claims
       -> recompute digest/requestKey
       -> exact compare
```

Terminal Replay：

```text
Host transport
  -> HostRecoveryReviewGateway.issueTerminalReplayAuthorization(...)
       -> authenticated principal
       -> allowedAccess includes read_replay
       -> requestKey / operation / digest / actor claims
       -> RecoveryReviewTerminalReplayAuthorization
  -> read-only Replay service
```

Gateway 不应返回 Layer 2 Context 给普通业务层。Context 只在 Gateway 内部
短期存在。

## 7. 最小接口设计

### 7.1 Host Authentication Adapter

概念接口：

```text
HostAuthenticationAdapter.authenticate(
  rawTransportRequest
) -> AuthenticatedPrincipal
```

要求：

- 只接受 Host transport 的原始认证材料。
- 不接受 `{ actorId, actorType }` DTO。
- 验证 cookie/session/bearer/mTLS 等真实凭据。
- 产出 `authenticationEvidenceId`。
- 失败 fail closed。

### 7.2 AuthenticatedPrincipal

```text
principalRef
actorId
actorType
roles
authenticationEvidenceId
authenticatedAt
expiresAt
```

`actorType` 只允许：

```text
human_reviewer | host_verifier
```

角色到 issuerScope：

```text
manual_reviewer -> manual_reviewer
host_verifier   -> host_verifier
```

### 7.3 Gateway

概念接口：

```text
HostRecoveryReviewGateway.issueFinalDecisionAuthorization(
  rawTransportRequest,
  command
)

HostRecoveryReviewGateway.issueTerminalReplayAuthorization(
  rawTransportRequest,
  replayQuery
)
```

Gateway 内部：

```text
authenticate principal
  -> reject unknown role
  -> reject body-supplied actor fields
  -> map allowed issuerScope / access
  -> build request identity
  -> invoke private issuer
  -> return opaque capability
```

### 7.4 AuthenticatedHostRequestContext

不通过 public API 暴露。

内部 claims：

```text
contextId
actorId
actorType
issuerScope
allowedAccess
authenticationEvidenceId
requestNonce
issuedAt
expiresAt
```

使用 module-private WeakMap：

- raw object / spread clone / JSON clone / cast 无效。
- Context 只由 Gateway 创建。
- Issuer 只接受该 WeakMap 中的 Context。

### 7.5 Capability claims

Final Decision：

```text
access = final_decision
taskId
reviewId
originalUnknownWriteToolRunId
operation
expectedDecisionVersion
operationPayloadDigest
sourceContractDigest | null
requestKey
actorId
actorType
requestNonce
```

Terminal Replay：

```text
access = read_replay
same complete request identity
```

issuer 必须从 authenticated context 获取 actorId / actorType，不接受普通
调用方传入。

## 8. 权限矩阵

| Authenticated role | issuerScope | final_decision | read_replay | 可调用 issuer |
|---|---|---|---|---|
| human_reviewer | manual_reviewer | 允许，受 Manual eligibility | 允许读取同一身份可读的历史 Decision | Manual private issuer |
| host_verifier | host_verifier | 允许，受 Verification eligibility | 允许读取对应历史 Decision | Verifier private issuer |
| unknown / missing | none | 拒绝 | 拒绝 | 无 |

额外规则：

- `manual_reviewer` 不能签发 `host_verifier` capability。
- `host_verifier` 不能签发 `human_reviewer` capability。
- `final_decision` capability不能用于 read_replay。
- `read_replay` capability不能用于写。
- Replay actor claims仍必须与历史 Decision Event / Operation exact match。

## 9. 请求身份绑定

Gateway / issuer 必须避免信任调用方提供的 digest / requestKey。

推荐流程：

```text
untrusted command
  -> strict command schema
  -> actorId / actorType from authenticated Context
  -> shared pure canonical Final Decision payload builder
  -> operationPayloadDigest
  -> requestKey
  -> issuer claims
  -> Capability
```

Service 后续必须重复：

```text
build payload
  -> compute digest
  -> compute requestKey
  -> exact compare capability claims
```

`requestNonce`：

- 只用于一次 authorization 防重放。
- 不进入 requestKey 的稳定业务身份。
- 新 read_replay 请求可以有新 nonce，但必须绑定相同历史 requestKey。

## 10. 最小新增文件计划

### G2 Foundation

建议新增：

```text
src/host/authenticated-principal.ts
src/host/recovery-review-host-gateway.ts
src/host/authenticated-host-request-context.ts
tests/host/recovery-review-host-gateway.test.ts
```

职责：

- Principal / role / auth evidence types。
- Context WeakMap。
- Gateway role mapping。
- context / issuer isolation。
- 不实现 Final Decision capability。

### Step 2

建议新增：

```text
src/recovery/recovery-review-final-decision-authorization.ts
tests/recovery/recovery-review-final-decision-authorization.test.ts
```

职责：

- final_decision / read_replay capability claims。
- module-private issuer。
- 消费 Gateway Context。
- exact request binding。
- 不实现 UoW。

### Composition Root

只在真实 Host transport 选定后新增：

```text
HostAuthenticationAdapter implementation
HostRecoveryReviewGateway composition
```

不得把 Gateway 注入 AgentRunner、ToolRegistry、Provider 或普通 Recovery
business service。

## 11. G2 通过证据

G2 至少需要：

1. 一个真实 Host Authentication Adapter 验证真实 credential。
2. Adapter 产出 actorId / actorType / authenticationEvidenceId。
3. Gateway 不接受 body / Agent / Tool 提供的 actorType。
4. Context 只能由 Gateway 创建。
5. raw object / spread / JSON / cast 全部拒绝。
6. Manual issuer 与 Verifier issuer 交叉调用拒绝。
7. final_decision / read_replay access 交叉拒绝。
8. 未认证、过期、错误 audience / scope 拒绝。
9. issuer 不从 recovery public barrel 导出。
10. AgentRunner / ToolRegistry / HTTP DTO 无法访问 Gateway / issuer。
11. 完整 requestKey / digest / operation / sourceContract / actor claims
    mismatch tests。
12. 真实 Host adapter integration evidence。

测试 fixture 可以验证 capability 数学与隔离性质，但不能替代真实 Host
Authentication Adapter 的 G2 证据。

## 12. 当前是否需要 Migration / Schema

不需要。

原因：

- Host principal / authentication evidence 属于 Host 运行时。
- Context 与 capability 是进程内 opaque object，不持久化。
- Durable Decision actorId / actorType 在后续 Final Decision Event payload
  中记录，现有 Events JSON 可承载。

若未来要求持久 session、API key、issuer registry 或 authentication audit
table，必须单独 Migration 设计，不在 G2 Foundation 默认范围。

## 13. 对已批准设计的影响

不改变 Final RecoveryReview Design 的行为或状态不变量。

仅补充实现层的信任来源：

```text
Design:
  actorId / actorType from Host Authorization

G2 architecture:
  authenticated principal -> Host Gateway context -> private issuer
```

需要修订的是 Implementation Plan：

- 增加 G2 Foundation / Step 2A。
- Step 2 依赖 G2 Foundation 封存。
- G2 Foundation 不属于 Step 3。

本轮不修改 Implementation Plan，等待架构评审。

## 14. 剩余外部前置条件

在 G2 真正通过前，仍需 Host 产品决策：

1. Host transport 是 HTTP API、Control plane 还是本地已认证 CLI。
2. Manual Reviewer 使用 SSO、session、mTLS 还是其他认证。
3. Host Verifier 使用 workload identity、mTLS 还是签名 service token。
4. Authentication evidence 的生成与审计规则。
5. token / session 过期与 audience policy。
6. 真实 Composition Root 在哪个进程启动 Gateway。

没有这些信息时，Task 保持：

```text
G2: BLOCKED
Step 2: not started
Production Entry: Closed
```

## 15. 最终建议

推荐：

1. 批准 Option C。
2. 增加独立 G2 Foundation / Step 2A。
3. 先实现 Principal / Gateway / Context 接口与负例测试。
4. 接入至少一个真实 Host Authentication Adapter。
5. 提供 G2 evidence 后，再恢复 Step 2 Final Decision / Replay
   Authorization。

本轮只完成架构设计，不解除 G2，不开始 Step 2 实现。
