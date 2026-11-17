# ForgeFlow Phase 3 Step 6.3.5 G2 Trust Model Remediation + F3 Batch A Report

> 范围：G2-F.2R Trust Model Remediation + G2-F.3 Final Gate Re-Acceptance
>
> 状态：开发与复核完成，等待最终架构确认
>
> 结论：**G2 PASS Candidate**
>
> Production Entry：Closed
>
> Step 2：未授权

## 1. 实际修改文件

新增：

- `tests/security/g2-trusted-runtime-boundary.test.ts`
- `docs/PHASE3_STEP6_3_5_G2_TRUST_MODEL_REMEDIATION_DEVELOPMENT_REPORT.md`

最小文档同步：

- `docs/PHASE3_STEP6_3_5_IMPLEMENTATION_PLAN.md`
  - 当前下一步更新为 G2-F.2R。
- `docs/PHASE3_STEP6_3_5_G2_TRUST_DOMAIN_REMEDIATION_DESIGN.md`
  - 记录 Option B 最终批准状态，并保留原 P1 历史审查发现。

未修改：

- Gateway / Adapter / HTTP Server / Host Assertion。
- Step 1、G2-F.1、G2-F.2 已封存实现。
- Migration / SQLite Schema。
- Final RecoveryReview Design。

## 2. 当前 TCB

Trusted：

- 静态装载、经过审查的 ForgeFlow 应用代码。
- Host 注册的 Tool Implementation。
- AgentRunner、ToolRegistry、Scheduler、ExecutionBridge、Recovery UoW。
- Host HTTP Server、Ed25519 Adapter、Gateway。

Untrusted data：

- HTTP body / headers / assertion content。
- LLM output / ToolCall arguments。
- Tool / Provider / MCP output。
- persisted JSON。

恶意 in-process JavaScript 不属于当前 G2 威胁模型。

## 3. TCB 回归测试

新增：

```text
tests/security/g2-trusted-runtime-boundary.test.ts
```

使用 TypeScript token scanner 检查 `src/**/*.ts`，不是简单 regex grep。

覆盖：

1. 直接动态代码执行：
   - `eval`
   - `new Function`
2. 动态模块加载：
   - dynamic `import()`
   - `require`
   - `createRequire`
3. Runtime code-loading modules：
   - `node:vm` / `vm`
   - `node:worker_threads` / `worker_threads`
   - `node:child_process` / `child_process`
4. 间接执行形态：
   - `.eval`
   - `module._compile`
   - `process.dlopen`
   - string callback `setTimeout` / `setInterval`
   - `new Worker`
5. 禁止的 runtime sandbox/loader dependencies。

当前扫描结果：

```text
findings = 0
```

测试不会把普通静态 import、JSON.parse、Zod parse 或 Tool input validation 误判为
不可信代码执行。

## 4. Agent / Tool / Provider / JSON 边界

实际测试：

- AgentRunner + Mock Provider 返回包含 JavaScript 源码的 ToolCall arguments。
- ToolRegistry 将其作为 Zod 验证后的 string data 处理。
- JavaScript 字符串没有被 eval/import/execute。
- 未知 module path Tool 名被 `ToolNotFoundError` 拒绝。
- persisted JSON 中的 JavaScript 字符串通过 `decodeJson()` 后仍是 data。

## 5. Untrusted Input 与 Context

验证：

- 数据形状 object、带 actorId / actorType / issuerScope 的普通对象不能通过
  `assertAuthenticatedHostRequestContext()`。
- 带 code 字段的伪 Context 不执行 code。
- F2 HTTP tests继续验证：
  - missing / malformed / tampered token。
  - wrong audience / scope / role / actor。
  - expired / revoked。
  - HTTP body actor overrides。

## 6. Composition Root / Public Barrel

验证：

- `src/recovery/index.ts` 不导出 Gateway、Adapter、Context creator。
- AgentRunner、ToolRegistry、Mock LLM Provider、RecoveryManager 没有 import
  Gateway / Context。
- Host HTTP Server 不 import signer。
- 真实 HTTP route 只有认证探针：
  `POST /internal/recovery-review/authenticate`
- 没有 Final Decision / Replay 业务 route。

以上边界是 defense-in-depth，不是针对恶意同进程代码的 sandbox。

## 7. 原 P1 Accepted Risk

原 G2-F.3 self-Gateway attack 仍然成立：

- trusted in-process code 可构造自己的 Adapter / trusted config。
- 可自签 assertion 并创建 Gateway Context。
- 这是已批准的 TCB 威胁模型之外的恶意代码场景。

回归测试名称：

```text
documents accepted TCB risk: trusted in-process code can self-mint Context
```

该测试明确期望攻击在当前 TCB 内成功，不声称 WeakMap 或静态扫描修复了它。

若未来引入 untrusted JS、dynamic plugin 或 Agent-generated code execution，
必须重新评审 G2。

## 8. G2 Gate 证据

| Gate 条件 | 结果 |
|---|---|
| Real Ed25519 assertion | pass |
| Loopback HTTP auth | pass |
| Human / Verifier key domain | pass |
| keyId mapping | pass |
| audience / expiry / notBefore / TTL | pass |
| key / assertion revocation | pass |
| actor / role / scope / access isolation | pass |
| body actor override rejected | pass |
| Context clone / cast / JSON forgery rejected | pass |
| untrusted data cannot create Context | pass |
| no dynamic JS / plugin loader in current src | pass |
| public barrel / business import discipline | pass |
| self-Gateway attack accepted risk documented | pass |
| Final Decision / Replay capability absent | pass |
| Production Entry closed | pass |

## 9. 实际验证

G2 Batch A targeted：

```text
pnpm vitest run \
  tests/host-auth/host-assertion.test.ts \
  tests/host-auth/ed25519-host-authentication-adapter.test.ts \
  tests/host-auth/host-authentication-config-loader.test.ts \
  tests/host-auth/host-assertion-signer.test.ts \
  tests/host/recovery-review-host-gateway.test.ts \
  tests/integration/recovery-review-host-auth.test.ts \
  tests/integration/host-auth-signing-cli.test.ts \
  tests/security/g2-trusted-runtime-boundary.test.ts

Test Files  8 passed (8)
Tests       39 passed (39)
```

Full suite：

```text
pnpm test

Test Files  67 passed (67)
Tests       687 passed (687)
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

## 10. Known Limitations

- Token scanner 检查当前 `src/` 中可识别的动态执行形态，不是形式化安全证明。
- 无法覆盖未来新增代码、native addon 或刻意混淆代码。
- MCP 尚未实现；未来外部 MCP 必须保持 external process / data-only boundary。
- TCB 恶意 in-process code 为 accepted risk。
- Host revocation 是 config snapshot；无 hot reload。
- 无 rate limiting / production TLS。

## 11. 验收与状态

- G2-F.2R：候选 L1 Internal Implementation Complete。
- G2-F.3：基于实际源码和重跑测试重新复核。
- G2 Gate：**PASS Candidate**，等待最终架构确认。
- Production Entry：**Closed**。
- Final Decision / Replay capability：未实现。
- Step 2：不得开始，直到 G2 PASS Candidate 被正式确认。

## 12. 下一批次

最终确认后，下一步是：

- Batch B：真实 DeepSeek Provider、STM32 BOM / 库存 Agent 端到端 Demo、
  Approval / Checkpoint / 可观察日志。

Step 2–11 仍按后续路线单独授权，不自动继续。
