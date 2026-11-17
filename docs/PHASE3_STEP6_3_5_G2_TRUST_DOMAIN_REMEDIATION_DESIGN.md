# ForgeFlow Phase 3 Step 6.3.5 G2 Trust-Domain Remediation Design

> 状态：Approved by final architecture review（2026-11-09）。
>
> 当前决定：采用 Option B，明确单进程 Trusted Computing Base（TCB），并
> 收窄 G2 安全声明。
>
> Design approval 不授权生产代码、测试、Migration 或 Schema 修改。

## Final Architecture Decision

- Option B 获批。
- 所有静态装载、经过审查的应用代码和 Host 注册 Tool 属于 TCB。
- HTTP / LLM / Tool Call / Provider / MCP / persisted JSON 属于不可信数据。
- 不支持加载或执行不可信 in-process JavaScript。
- 恶意进程内代码不属于当前 G2 威胁模型。
- G2-F.3 的 self-Gateway attack 仍成立，属于已接受风险，不是已修复漏洞。
- 在重新执行 G2-F.3 前必须完成 G2-F.2R Trust Model Remediation。

> 以下 §0–§13 保留原始 P1 发现、方案比较和审查时建议，作为历史审查记录。
> 当前具有约束力的是本 Final Architecture Decision 与 §14–§16 的最终状态。

## 0. 结论摘要（历史审查记录）

### P1 根因

当前 Context 信任边界只到：

```text
Context 由某个 Ed25519HostAuthenticationAdapter + RecoveryReviewHostGateway
实例创建。
```

没有证明：

```text
该 Gateway 是 Host Composition Root 创建的唯一受信实例。
```

因此任意进程内模块都能：

1. import Adapter / Gateway。
2. 生成自己的 Ed25519 key pair。
3. 构造自己的 trusted config。
4. 自签 assertion。
5. 创建会被 module-level WeakMap 接受的 Context。

G2-F.3 已实际复现该攻击。

### 历史建议（现已采纳为 Final Decision）

推荐：

```text
Option B：显式单进程 Trusted Computing Base
```

理由：

- 当前项目不加载不可信 JavaScript。
- ToolRegistry 只执行编译时 / Composition Root 注册的受信函数。
- 没有动态 `eval`、`new Function`、`node:vm`、dynamic import 或插件 loader。
- 同进程模块本来就能读取 DB、文件、进程环境、内网与所有服务对象；仅隔离
  Gateway 模块不能形成真实安全边界。
- 真正需要阻止恶意进程内代码时，必须同时重新设计 DB / credential /
  composition ownership，而不是只拆一个 Gateway 类。

### 限制

Option B 不会阻止 G2-F.3 的 in-process 自构造攻击。

它把这些代码定义为：

```text
Trusted Application Code
```

而不是安全沙箱中的 Untrusted Code。

如果架构要求“即使任意进程内代码恶意执行，也不能构造 Context”，则
Option B 不满足，必须采用带 OS 权限隔离和数据库所有权隔离的
Option A。

因此当前 G2 仍为：

```text
BLOCKED until trust model is explicitly approved.
```

## 1. 源码事实

### 1.1 没有不可信 JS 执行入口

当前 `src/` 中未发现：

- `eval()`
- `new Function`
- `node:vm`
- 动态 `import()`
- `worker_threads`
- `child_process`
- 第三方 JS plugin loader

当前 `src/index.ts` 只是 CLI health-check。

### 1.2 ToolRegistry 只执行注册函数

`ToolRegistry.register()` 接受 Host 编译代码提供的 Tool Definition。

`executeValidated()` 只调用当前 Registry 中保存的 function：

```text
ToolRegistry
  -> registered tool function
  -> execute()
```

模型只能产生 ToolCall 数据，不能注入或执行任意 JS module。

### 1.3 MCP 尚未在本阶段执行

当前 Step 6.3.5 不实现 MCP / External Tool module loader。

未来 MCP Server 应位于独立外部进程；其输出是不可信数据，但不应被解释为
可执行 JS。

### 1.4 AgentRunner / ExecutionBridge / Recovery UoW 都在同一进程

当前可信决策链：

```text
AgentRunner
  -> TaskScheduler
  -> PersistentExecutionBridge
  -> ExecutionUnitOfWork / Repository
```

Recovery Review：

```text
RecoveryManager
  -> RecoveryReviewDecisionService
  -> ExecutionUnitOfWork
```

Host HTTP：

```text
Host HTTP Server
  -> Adapter
  -> Gateway
  -> Context
```

所有对象目前都在同一 Node.js execution domain。

### 1.5 普通业务模块目前没有 import Gateway

当前：

- `src/recovery/index.ts` 不导出 Gateway。
- AgentRunner / ToolRegistry / RecoveryManager 没有 import Gateway。
- HTTP server 是唯一 Composition 使用点。

但这些只是当前 import graph 与模块政策，不是针对恶意代码的运行时隔离。

## 2. 威胁模型选择

### 2.1 当前实际威胁面

不可信输入：

- HTTP body / headers。
- Bearer assertion。
- LLM output。
- ToolCall arguments。
- Tool output。
- 外部 MCP / Provider response。
- 数据库中被篡改的 JSON。

可信代码：

- `src/` 中编译并加载的模块。
- Host 注册的 Tool execute 函数。
- Composition Root：
  - RecoveryManager
  - PersistenceCoordinator
  - Host HTTP Server
  - Gateway
  - UoW

### 2.2 当前不支持的威胁

- 恶意 in-process 模块。
- 恶意 Tool implementation。
- 从模型 / HTTP / 文件动态加载并执行 JS。
- 第三方 Plugin 在同一 JS heap 内任意执行。

如果未来支持上述能力，Option B 不再成立。

## 3. Option A：独立 Host Control Trust Domain

### 3.1 Node.js Process

优点：

- 独立 V8 isolate / heap / module instance。
- 可使用不同 OS 用户、文件权限、service account。
- 可通过 local socket / named pipe / loopback HTTP / IPC 通信。

不足：

- 若 Agent process 与 Host process 运行在同一 OS user 且都能写同一 SQLite，
  恶意 Agent code 仍可直接写 DB。
- 要真正隔离 Final Decision，Host Control 必须独占：
  - SQLite 写权限，或
  - Final Decision Repository / UoW 服务。
- 配置、public key、private key、DB path 和 credential 需要 OS 权限隔离。

结论：

```text
Node Process 只有在 OS identity / filesystem / DB ownership 一并隔离时才
构成真实安全边界。
```

### 3.2 Worker Thread

优点：

- 独立 JS isolate 与 module WeakMap。
- 比 module export / package boundary 更接近隔离。
- startup / IPC 比 process 轻。

不足：

- 同进程、同 OS 用户、同权限。
- 恶意 parent code 仍可读写共享文件、DB、环境与配置。
- Context / capability 对象不能跨 thread transfer；Step 2 issuer、Context、
  Final Decision UoW 必须整体留在 Host worker。
- 仍不是 OS security boundary。

结论：

```text
Worker Thread 可防对象共享，不防同进程 / 同权限代码访问资源和实现伪造。
```

### 3.3 Package Export / Module Boundary

Package exports、private symbols、module-private WeakMap 只能限制正常 import
路径和对象伪造。

不能阻止：

- 源码 workspace 内相对 import。
- 测试 / build override。
- 恶意代码直接打开 DB 或加载模块。

结论：

```text
Package / module boundary 不是运行时安全边界。
```

### 3.4 Option A 所需最终归属

若采用 A，必须把以下整体迁入 Host Control trust domain：

- Ed25519 Adapter。
- Gateway。
- Context creator。
- Step 2 Final Decision / Replay capability issuer。
- Final Decision Lease-owned UoW。
- Event / Operation / Checkpoint。

SQLite / Lease / Fencing / Final Decision UoW 必须在 Host Control 侧执行，
并保持单 immediate transaction。

Agent 侧若仍需访问 SQLite，应通过受控 persistence service 或只允许其访问
不需要 Final Decision 权限的数据边界。

## 4. Option B：Explicit In-Process Trusted Computing Base

### 4.1 定义

整个 ForgeFlow Node.js application process 是 TCB。

Trusted：

- 所有静态 import 的业务模块。
- Composition Root。
- Gateway / Adapter。
- ToolRegistry 注册函数。
- UoW / Repository。

Untrusted：

- 请求参数。
- assertion 数据。
- 模型输出。
- 工具输入 / 输出。
- Provider / external data。
- persisted JSON。

### 4.2 In-Process Gateway Registry 能做到什么

可防止：

- HTTP body / model / tool input 直接构造 Context。
- 普通代码通过 recovery public barrel 获得 Gateway。
- object clone / cast / JSON roundtrip 伪造 Context。
- 误用公开业务路径签发 capability。

不能防止：

- 恶意 in-process module import Gateway / Adapter。
- 恶意 module 直接打开 SQLite。
- 恶意 module 读取 Host public config。
- 恶意 module 生成自己的 key / config / Gateway。

因此 Registry / WeakMap 不是对恶意同进程代码的修复。

### 4.3 Composition Root / Import Policy 的作用

仍有价值，但属于 defense-in-depth：

- Gateway 只在 Host HTTP composition 中实例化。
- AgentRunner / ToolRegistry / Provider / RecoveryManager 不接收 Gateway。
- Recovery public barrel 不导出 Gateway / Context creator。
- 业务模块 import policy 由静态检查保护。
- 禁止动态 JS / plugin loader。

这些规则减少误用和供应链传播，但不能把恶意 trusted code 变成 untrusted。

## 5. 方案比较

| 维度 | A：独立 Host Control Process | B：In-Process TCB |
|---|---|---|
| 隔离恶意同进程 JS | 可，前提是 OS/DB/credential 也隔离 | 否 |
| Worker Thread | 只隔离对象，不隔离 OS/DB | 不适用 |
| Package / Export | 不是安全边界 | 只作 DTO / import 政策 |
| DB / Lease / Final UoW | 必须归 Host Control | 当前同进程 |
| IPC | 需要稳定身份、序列化、timeout、replay | 不需要 |
| 单事务 | Host 事务内完成 | 仍当前事务 |
| 现有代码改动 | 大 | 小 |
| 新依赖 | 可不用 | 无 |
| 适合当前无 plugin 项目 | 过度 | 是 |
| 对抗恶意 in-process code | 需要完整权限隔离 | 不支持 |

## 6. 最终推荐

推荐 **Option B** 作为 Step 6.3.5 当前产品范围的最终信任模型。

前提：

1. ForgeFlow 明确不支持在 Agent Runtime process 中加载不可信 JS。
2. Tool / Provider / MCP data 不能转换为可执行 JS。
3. Third-party plugin 或动态 agent-generated code 不在当前产品范围。
4. Gateway / issuer 不从网络 / model / tool / persisted input 可达。
5. 所有 in-process code 被视为经过同一信任级别审查的 TCB。

在此模型下：

```text
G2 验证的是 authenticated external Host boundary，
不是恶意 in-process module sandbox。
```

## 7. 推荐架构

### 7.1 信任边界

```text
Untrusted input
  HTTP request
  model response
  tool input/output
  external provider/MCP data
        |
        v
Trusted ForgeFlow Process (TCB)
  Host HTTP Server
  Ed25519 Adapter
  RecoveryReviewHostGateway
  AgentRunner
  ToolRegistry
  Scheduler
  ExecutionBridge
  RecoveryReview UoW
  SQLite / Lease / Event / Checkpoint
```

### 7.2 Context / Authorization

- Context 只由进程内受信 Gateway 创建。
- Final Decision capability 只由受信 Host issuer 创建。
- 普通 untrusted input 无法创建 Context / issuer。
- 恶意 in-process code 被视为 TCB violation，而不是 authentication bypass。

### 7.3 Final Decision 权限归属

当前：

```text
ForgeFlow trusted process
  -> Final Decision UoW
  -> SQLite transaction
```

Lease/Fencing/Exact Replay 语义不变。

### 7.4 对 G2-F.3 攻击脚本的处理

在 Option B 下，该脚本仍然可以成功。

这不是修复遗漏，而是：

```text
The script executes as trusted in-process code.
```

如果产品要求“该脚本必须失败”，Option B 不可接受，必须采用 A。

## 8. 需要收窄的 G2 声明

从：

```text
普通业务模块无法取得 Gateway / Context。
```

收窄为：

```text
Untrusted HTTP / model / tool / provider / persisted input
不能取得或构造 Gateway / Context。

Only trusted in-process modules can access internal Gateway construction,
and such modules already have TCB-level DB/process access.
```

保留：

- public recovery barrel 不导出 Gateway。
- Agent / Tool / Provider / RecoveryManager 不被 Composition Root 注入
  Gateway。
- Context clone / cast / JSON 拒绝。
- Final Decision issuer 不进入 untrusted input path。

删除：

- “任意普通 in-process code 无法 import / 构造 Gateway”
- “WeakMap + static import test 可以阻止恶意同进程代码”

## 9. 是否需要进程内 Gateway Registry

可以作为 defense-in-depth：

- single trusted Gateway instance metadata。
- Context 只绑定该 instance id。
- assertion 验证 instance id。

但：

- 同一进程 trusted code 仍可构造 Registry 或修改代码。
- 不能作为 Option B 的安全证明。

因此不是 P1 的根本修复。

## 10. 最小 Remediation 范围

如果架构批准 Option B，最小修复不是重写 Gateway，而是：

1. 正式记录 Trusted Computing Base。
2. 修订 G2 安全声明与测试口径。
3. 增加禁止 untrusted JS / dynamic loader 的回归检查。
4. 把 F3 攻击脚本保留为“trusted-code assumption demonstration”，不再作为
   声称可被阻止的安全回归。
5. 保持 composition/import policy 作为 defense-in-depth。

候选文件：

```text
docs/PHASE3_STEP6_3_5_G2_TRUST_DOMAIN_REMEDIATION_DESIGN.md
tests/security/g2-trusted-runtime-boundary.test.ts
```

若需要代码级 policy helper：

```text
src/security/runtime-trust-policy.ts
```

但该 helper 不能宣称是 sandbox。

## 11. Option A 最小实现范围（未采用）

候选：

```text
src/host-control/main.ts
src/host-control/client.ts
src/host-control/ipc-protocol.ts
src/host-control/final-decision-service.ts
tests/integration/host-control-process.test.ts
```

前提：

- Host Control process 独占 Final Decision UoW / SQLite write capability。
- Agent process 不能直接写 Final Decision tables。
- IPC 使用受认证 local socket / pipe。
- Context / capability 不离开 Host Control process。
- 需要重新评估 Agent / Scheduler / ExecutionBridge 的 persistence 归属。

这会显著扩大 Step 6.3.5 范围。

## 12. 对 Final RecoveryReview Design 的影响

Option B：

- 不改变 Final Decision、Exact Replay、Lease/Fencing、Event/Operation 顺序。
- 只澄清 Host Authorization 的威胁模型。
- 仍满足“Final Decision issuer 不暴露给 untrusted input / public business
  API”的设计。
- 但必须修订 G2 / Implementation Plan 中“普通 in-process module 无法
  import Gateway”的过强声明。

Option A：

- 也不改变事务语义，但改变部署 / IPC / SQLite 所有权。
- 需要显著架构与实施计划修订。

## 13. Migration / Schema / Dependencies

Option B：

- Migration：不需要。
- Schema：不需要。
- 新依赖：不需要。

Option A：

- 当前设计可在同一 SQLite 上做，但真正安全隔离需要独立 DB 权限 / service
  边界；可能引出 persistence 架构修订。
- 默认不需要 Migration，但实现范围远大于 Option B。

## 14. G2 Gate 解除条件

Option B 已获架构批准，但 G2 不得自动解除。已完成：

1. 本 TCB 威胁模型。
2. 明确不支持 untrusted in-process JavaScript。
3. 修订 Implementation Plan G2 声明。
4. F3 in-process attack 被正式归类为 trusted-code attack。

仍需 G2-F.2R 完成：

- 禁止 dynamic JS / plugin loader 的回归测试。
- External HTTP / model / tool / provider input 不可取得 Context 的验证。

G2-F.2R 封存后才可重新执行 G2-F.3 Gate acceptance。

## 15. 下一轮开发授权判断

### 已批准的 Option B 路径

可以单独授权：

```text
G2-F.2R Trust Model Remediation
```

范围仅为：

- 文档 / threat model。
- untrusted JS prohibition policy test。
- G2 acceptance claim update。
- 不需要修改 Gateway / Adapter。

### 未采用的 Option A 路径

若未来需要阻止恶意 in-process 代码，必须另行批准 Host Control process /
DB ownership / IPC 架构，不能沿用当前 G2 声明。

## 16. 最终状态

```text
G2 Gate: BLOCKED pending G2-F.2R and re-run of G2-F.3
Production Entry: Closed
Step 2: Not authorized
```

本文件仅提供架构决策，不解除 G2，不开始 Remediation 开发。
