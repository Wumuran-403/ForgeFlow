# ForgeFlow Phase 3 Step 6.3.5 Step 2 Development Report

> Step：Final Decision / Replay Authorization
>
> 状态：**BLOCKED before implementation**
>
> 阻断原因：Gate G2 未满足。当前源码没有可信 authenticated Host identity
> 或可证明隔离的 Manual / Host Verifier issuer 边界。
>
> Step 1：Approved & Sealed，保持只读，不修改。

## 1. 结论

Step 2 未进入实现阶段。

根据本轮授权：

```text
如果 G2 所需的 authenticated Host identity 或 issuer 边界尚不存在，
必须 fail closed，并提交阻断报告，不得以测试 fixture 冒充真实 Host 身份。
```

当前结论：

- G2：**BLOCKED**。
- 最高验收级别：未达到 L1。
- Production Entry：Closed。
- 未创建 Final Decision / Replay Authorization capability。
- 未创建 issuer。
- 未运行或伪造真实 Host identity 测试。

## 2. 实际修改文件

新增：

- `docs/PHASE3_STEP6_3_5_STEP2_DEVELOPMENT_REPORT.md`

修改：

- 无。

新增生产代码：无。

新增测试：无。

## 3. G2 源码核查

### 3.1 现有 Host Control authorization

实现：

```text
src/recovery/recovery-evidence-host-control-authorization.ts
```

实际行为：

- 使用 module-private WeakMap 防止普通对象伪造。
- issuer 不通过 `src/recovery/index.ts` 公开。
- 但 issuer 输入包含普通字符串 `controlActor`。
- 文件内没有认证 session、principal resolver、签名 assertion、token 验证或
  Host Auth adapter。
- 注释明确它是 “Internal Host Control adapter only”，但没有证明调用它的
  模块已经验证用户身份。

结论：

```text
WeakMap 防盗用对象，不等于 authenticated Host identity proof。
```

因此不能把该 capability 或 controlActor 字符串转换为 Step 2 的
`human_reviewer` / `host_verifier` 身份。

### 3.2 Verifier context

实现：

```text
src/recovery/recovery-verifier-registry.ts
```

存在字段：

```text
authenticatedActorId
```

但它是 verifier input context 的运行时数据字段，不是 Host Authentication
Gateway 签发的身份断言。

当前调用：

```text
src/recovery/recovery-evidence-verification-service.ts
```

会把历史 Evidence Manifest 的 actorId 放入该字段。该值证明的是被审查
Evidence 中记录的人工 actor，不是当前请求的 authenticated session。

结论：

```text
Manifest actorId != current Host principal.
```

不能用它签发 Final Decision / Replay Authorization。

### 3.3 生产源码搜索

当前未发现：

- authenticated Host principal provider。
- Host session / user context。
- request authentication middleware。
- signed Host identity assertion。
- Manual Reviewer issuer service。
- Host Verifier issuer service。
- Host Control Gateway。
- issuer audience / scope policy。

现有内部 capability：

```text
RecoveryEvidenceDispatchPreflightCapability
RecoveryReviewOperationCapability
RecoveryEvidenceHostControlAuthorization
```

分别证明 Registry preflight、调用来自内部 Review service、或 Host Control
请求防伪；它们都不是 Final Decision actor authentication。

## 4. 为什么不能继续实现

Final Decision / Replay capability 要求：

```text
actorId / actorType
  来自同一个 authenticated Host identity。
Manual issuer
  只能签发 human_reviewer。
Host Verifier issuer
  只能签发 host_verifier。
普通 Agent / HTTP body / Tool Call
  不能自行签发。
```

若现在新增 `issueManualReviewerFinalDecisionAuthorization({ actorId })` 或
`issueHostVerifierFinalDecisionAuthorization({ actorId })`：

- 任意内部调用方都可提供任意 actorId。
- 任意调用方都可选择 issuer 函数。
- Manual / Verifier 权限分离只存在于函数名，不存在 Host 权限边界。
- WeakMap 只能证明 capability 由某个 issuer 创建，不能证明 issuer 有资格
  代表该 actor。

因此该实现不能提供 G2 证据，不得进入代码。

## 5. 必需的解阻条件

在重新授权 Step 2 前，必须提供以下之一：

### Option A：可信 Host Identity Provider

Host 层提供：

```text
authenticatedPrincipal:
  actorId
  actorType
  issuerScope
  authenticationEvidenceId
```

该对象必须来自 Host authentication boundary，而不是 Agent / HTTP body /
Tool Call / 普通 service 参数。

### Option B：Host-signed identity assertion

Host 提供签名 assertion，issuer 可验证：

- signature。
- audience。
- expiry。
- actorId。
- actorType / role。
- action scope。

### Option C：受控 Host Control Gateway callback

Step 2 issuer 不直接接收 actorId；只接受一个 opaque
`AuthenticatedHostRequestContext`，其创建权在 Host Gateway，且 Agent /
HTTP DTO / LLM Tool 无法构造。

无论选择哪种方案，都必须额外证明：

- Manual issuer 与 Verifier issuer 权限隔离。
- read Replay 与 final_decision 写权限隔离。
- issuer 不在 recovery public barrel。
- agent / tool / HTTP 参数无法构造 issuer context。

## 6. 计划测试状态

因 G2 在实现前阻断，以下测试**未执行且未创建**：

- Final / Replay capability 合法签发。
- access / task / review / operation / version / digest / requestKey / actor
  claims mismatch。
- Manual 与 Verifier issuer 交叉拒绝。
- object / spread / JSON / cast 伪造拒绝。
- Replay nonce 与 Final Decision nonce 隔离。

不得用本地 fake issuer fixture 代替 G2 Gate。

## 7. 验证命令

由于没有 Step 2 代码或测试变更，未运行 Step 2 targeted tests、`pnpm test`
或 `pnpm typecheck`。

`git diff --check` 在报告生成前执行，结果通过；仅有当前工作副本既有的
LF/CRLF 提示。报告生成后会再次执行并记录在最终回复中。

## 8. 未实施范围

- Final Decision Authorization capability。
- Terminal Replay Authorization capability。
- Manual / Verifier issuer。
- capability claims validation。
- Final Decision Service / UoW。
- Unknown Settlement Resolver。
- Task / PlanStep / ToolRun 状态修改。
- Event / Checkpoint。
- Migration / Schema。
- Step 3 及后续。

## 9. 验收级别与生产入口

- 最高验收级别：Blocked before L1。
- Production Entry：Closed。
- Step 2 不具备封存条件。

生产入口 closed 的原因是代码未改变，而不是由测试 fixture 伪造通过。

## 10. 需要架构决策

请在继续 Step 2 前单独批准可信 Host identity / issuer boundary：

1. 选择 Host principal provider、signed assertion 或 Host Gateway callback。
2. 明确 Manual 与 Verifier issuer 的权限归属。
3. 明确 issuer 与 Agent / HTTP / Tool Call 的隔离方式。
4. 明确测试如何证明真实边界，而不使用 mock actorType 绕过 G2。

在这些条件满足前，Step 2 保持 blocked，不得开始 Step 3。
