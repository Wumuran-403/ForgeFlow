# ForgeFlow Phase 3 Step 6.3.5 Implementation Plan

> 状态：原 Implementation Plan、G2 Foundation 与 Option B Trust Model
> 已通过架构评审；G2 仍等待 Trust Model Remediation 与重新 F3 验收。
>
> 设计基线：`docs/PHASE3_STEP6_3_5_FINAL_RECOVERY_REVIEW_DESIGN.md`
> 已于 2026-11-09 通过最终架构评审。
>
> 数据库基线：Migration v9。
>
> Step 1、G2-F.1、G2-F.2 已 Approved & Sealed。G2 仍 BLOCKED，
> Step 2 不得开始。本修订不授权 remediation 或任何生产代码开发。

## 0. 执行规则

### 0.1 强制顺序

1. 每个 Step 必须先获得单独开发授权。
2. 每个 Step 完成后只提交该 Step 的 Development Report。
3. Development Report 必须等待架构评审通过，才能开始下一 Step。
4. 不得将多个 Step 合并为一次大型实现。
5. 任一 Implementation Gate 未满足时，对应 Step 必须保持 blocked。
6. 不得通过修改 Original Unknown Write ToolRun 绕过任何 Gate。
7. 不得自行扩大 Migration / Schema 范围。

### 0.2 标准验证命令

每个授权开发的 Step 至少按实际范围执行：

```bash
pnpm vitest run <targeted-test-files>
pnpm test
pnpm typecheck
git diff --check
```

报告只记录实际执行的命令和真实结果。不得把计划测试写成已通过。

### 0.3 Development Report

Step N 的报告路径：

```text
docs/PHASE3_STEP6_3_5_STEP<N>_DEVELOPMENT_REPORT.md
```

G2 Foundation 的报告路径：

```text
docs/PHASE3_STEP6_3_5_G2_FOUNDATION_DEVELOPMENT_REPORT.md
```

G2-F.2R Trust Model Remediation 的报告路径：

```text
docs/PHASE3_STEP6_3_5_G2_TRUST_MODEL_REMEDIATION_DEVELOPMENT_REPORT.md
```

每份报告至少包含：

- 实际修改文件。
- 公共 / 内部接口变化。
- 状态机与事务边界。
- 新增测试及覆盖映射。
- 实际执行的命令与结果。
- 已知限制与未实施范围。
- Migration / Schema 影响结论。
- 是否满足该 Step 封存条件。

### 0.4 验收级别（Acceptance Levels）

以下三个级别必须独立记录，不得互相替代：

| 级别 | 名称 | 定义 | 允许的表述 |
|---|---|---|---|
| L1 | Internal Implementation Complete | 纯契约、内部模块或测试路径完成；尚无真实组件集成 | “内部实现完成” |
| L2 | Integration Verified | 目标模块通过真实 Repository / UoW / Scheduler / SQLite 集成测试；生产入口仍可保持关闭 | “集成测试通过” |
| L3 | Production Entry Open | 全部前置 Step 与 Gate 通过，Release Gate 明确授权打开真实 Host 入口 | “生产入口已开放” |

规则：

- L1 不自动升级为 L2。
- L2 不自动升级为 L3。
- 测试通过不等于生产入口开放。
- 生产入口关闭时，不得通过测试 fixture、公开 service 或默认 composition
  配置绕过 Gate。
- 每个 Step 在 Development Report 中必须分别声明：
  - 达到的最高验收级别。
  - 是否打开生产入口。
  - 未达到下一级别的阻塞原因。

### 0.5 Release / Entry Gates

以下不是新增 Step，而是独立 Gate：

| Release Gate | 最早申请条件 | 授权后允许的行为 |
|---|---|---|
| R1 Final Decision Integration Readiness | Step 6 与 Step 7 均已封存并通过架构评审 | 确认 Final Decision + Terminal Replay 内部集成具备条件；不打开真实 Host 写入入口 |
| R2 Multi-Write Coverage | Step 8 与 Step 9 均已封存，G5b 通过 | 宣称 Multi-Write Barrier 覆盖所有普通 persistent Write |
| R3 Step 6.3.5 Seal | Step 1-11 全部通过并与全量 Regression 报表一并评审 | 封存 Step 6.3.5，仍不得自动进入下一阶段 |

Release Gate 必须单独记录在对应 Development Report 或最终封存报告中。任何
Step 的代码完成都不能自动触发 R1 / R2 / R3。

R1 不是生产入口开放授权。真实 Host 入口默认保持关闭，直到 R2 及
Step 10-11 验收完成，并另行通过 L3 生产入口评审。若要在受控环境提前开放，
必须提交独立隔离证明并经架构审批。

## 1. 权威范围

### 1.1 本计划覆盖

- Host Final Decision Authorization。
- Terminal read-only Replay Authorization。
- `SourceContractV1` system-verified / manual-attested variants。
- Final Decision requestKey、CAS、Exact Replay。
- Final Decision Event / Operation / downstream Skip Event 顺序。
- Original Unknown Write Resolver。
- Final Decision Lease-owned UoW。
- PlanStep `1:N` ToolRun 的原子 skipped convergence。
- Capability-guarded Task Final Convergence。
- Multi-Write Barrier 与真实 Write admission。
- persistent `AgentRunner` direct Write bypass 封闭。
- Cancel / Pause / terminal Task race。
- Fault Injection、SQLite 多连接并发与 Regression。

### 1.2 明确不覆盖

- External Read 执行。
- Transaction B 新协议。
- Verifier Runtime 重设计。
- Payload Store 后端替换。
- Durable Recovery Job / Command Store。
- Recovery Scanner / Worker 自动编排。
- Re-plan、Re-plan Task、Re-plan lineage 或 Migration。
- Step 6.3.5 之后的阶段。
- Migration v10。

## 2. 当前源码事实

以下事实来自当前生产源码阅读，不是实施完成声明。

### 2.1 Recovery Review / Operation

- `RecoveryReviewDecisionService` 当前只实现：
  - `advance_decision_version`
  - evidence submission
  - mark unresolved
- 没有 final confirm。
- `ExecutionUnitOfWork.decideRecoveryReview()` 是 protocol v0 legacy path，
  不得作为 v1 Final Decision 入口。
- `RecoveryReviewOperationRepository` 是 append-only。
- `recovery_review_operations.request_key` 唯一。
- `(review_id, resulting_decision_version)` 唯一。
- `applied_event_id` 当前允许 nullable；Final Decision UoW 必须应用层强制
  confirm operation 非空。

### 2.2 Event / Checkpoint / Permit

- `EventRepository.append()` 生成并返回 Event ID。
- Events / Checkpoints 是 append-only。
- `StorageWritePermit` 绑定当前 SQLite write transaction token。
- 所有多表状态写入必须复用同一个 permit。

### 2.3 Task / Plan / ToolRun

- `TaskLeaseManager.claimWithClaimEvent()` 拒绝 terminal Task。
- `TASK_TRANSITIONS.waiting_review` 不包含 `completed`。
- `PLAN_STEP_TRANSITIONS.queued` 包含 `skipped`。
- `TOOL_RUN_TRANSITIONS.queued` 包含 `skipped`。
- `TaskPlanner` 将连续 Read 合并为一个 `read_batch` PlanStep。
- PlanStep 与 ToolRun 实际为 `1:N`。
- Write PlanStep 的 `1:1` 是 TaskPlanner 业务不变量，不是 DB 唯一约束。
- `Task Terminal Guard` 当前将 queued / running / awaiting_approval /
  interrupted ToolRun 视为 active。

### 2.4 Write Admission

- 受调度 Write 路径：

```text
WriteExecutor
  -> PersistentExecutionBridge.beforeExecute()
  -> ExecutionUnitOfWork.beginOwnedToolRun()
  -> ToolRegistry.executeValidated()
```

- `beginOwnedToolRun()` 当前自行开启 immediate transaction。
- 当前没有 Barrier check + ToolRun begin 的组合事务。
- `beginOwnedToolRun()` 当前不拒绝 `PlanStep=skipped`。
- `AgentRunner` 在 scheduler 缺失但 persistence 存在时会走 direct
  `registry.execute()` fallback。

### 2.5 Payload / Source Contract

- `FileEvidencePayloadStore` 支持内容寻址文件存储与 digest 校验。
- generic `json` payload 可加载并验证 storage / semantic digest。
- **Step 1 已完成并 Approved & Sealed。**
- 已实现 `RecoverySourceContractV1Schema`：
  - `system_verified`
  - `manual_attested`
- 已实现 canonical serializer、SHA-256 digest、expected identity validator。
- 已实现 System / Manual variant 结构隔离、时间窗口、coverage 与 authority
  校验。
- 已通过现有 Payload Store json put / read / integrity roundtrip。
- SourceContractV1 目前尚未接入 Final Decision / Operation / UoW。

## 3. Implementation Gates

| Gate | 前置证明 | 阻塞 Step | 失败处理 |
|---|---|---|---|
| G1 Payload Store + SourceContract | 现有 Payload Store 可持久化、读取、重算 canonical JSON digest，并能区分 system/manual variant | Step 1 | 停止；单独提交 persistence 方案 |
| G2 Host identity / Gateway | G2a 内部 Principal / Context / Gateway 纪律 + G2b 真实 Host Authentication Adapter + G2c 已批准的 In-Process TCB 威胁模型 | G2 Foundation remediation + 重新 G2-F.3 / Step 2 | Step 2 blocked；不得用 WeakMap / Mock Principal 单独证明 G2 |
| G3 Final Convergence capability | capability 只能由受控 Final Decision UoW 在当前 transaction 内签发和消费 | Step 6 | 停止；不得放宽通用 Task transition |
| G4 Shared audit chain | Unknown Resolver、Terminal Guard、skipped convergence 使用同一 Review / Operation / Event / Evidence / Verification 链 | Step 6 | 停止；不得复制弱化判断 |
| G5a Write path inventory | 所有生产 Write 调用点已枚举，旁路可在不扩 Schema 的前提下封闭 | Step 8 | Step 8 blocked |
| G5b Write closure exit evidence | Step 9 完成时证明 Scheduler + ExecutionBridge 成为普通 persistent Write 唯一入口 | Step 9 出口验收 / R2 前置 | Step 9 不得封存；R2 blocked |
| G6 Immutable Original ToolRun | 所有路径只读 Original Unknown Write，不修改其 status | 全 Steps | 立即失败；整体 rollback |
| G7 Migration v9 sufficiency | 不新增列/表即可表达 actorType、SourceContract digest、Barrier、Final Decision audit | 全 Steps | 停止并提交独立 Migration 方案 |

### 3.1 Gate 执行方式

- Gate 证据写入对应 Step Development Report 的 “Gate Evidence” 小节。
- Gate 未满足时，不得用测试 fixture、进程内临时字段或 mock persistence
  伪装满足。
- 若 Gate 需要生产代码之外的新架构决定，必须停止并单独评审。

### 3.2 G2 Host Authentication 方案决策

**[最终建议]**

采用：

```text
Minimal HTTP Host Control
  + Node built-in http
  + Ed25519 signed HostAssertionV1
  + loopback binding for local deployment
  + separate Human Reviewer / Host Verifier public-key domains
  + opaque AuthenticatedHostRequestContext
  + module-private Gateway / composition boundary
  + Step 2 private capability issuers
```

方案比较：

| 方案 | 优点 | 缺口 | 结论 |
|---|---|---|---|
| 本地 Host Control + OS identity | 依赖最少 | Node 进程身份不是 per-request credential；跨平台 ACL / named pipe 复杂；容易误把 username 当认证 | 不采用 |
| Minimal HTTP + verifiable credential | 单进程可实施；Node 内置 http/crypto；可测试 expiry/audience/scope/revocation | 需要 Host 管理签名私钥与公钥配置 | 采用 |
| External authenticated Host assertion adapter | 最接近企业部署 | 当前没有外部 Host、IdP 或 ingress 可提供真实 assertion，无法独立完成 G2 | 作为未来替换 adapter，不采用为本阶段默认 |

#### Transport

- 使用 Node built-in `http`。
- 默认绑定 `127.0.0.1`，只服务本地 Host Control / demo。
- 非 loopback 部署必须由受控 TLS ingress 终止 TLS，并使用同一 Gateway
  contract。
- 不新增 Fastify / Express 等依赖。

#### Human Reviewer authentication

- Host 侧使用 Ed25519 私钥签发短生命周期 `HostAssertionV1`。
- Bearer assertion claims 包含：

```text
issuer
keyId
subject / actorId
actorType = human_reviewer
role = manual_reviewer
audience = forgeflow.step6_3_5.recovery-review
scopes
issuedAt
notBefore
expiresAt
assertionId
```

- 私钥只存在于 Host 签发工具 / secret store，不在 ForgeFlow runtime。
- runtime 只持有对应 public key、issuer allowlist、audience 和 revocation
  配置。
- 本地 demo 由操作系统文件权限保护私钥；真实多用户部署应替换为 SSO /
  OIDC adapter，但输出同一个 AuthenticatedPrincipal contract。

Human Reviewer 固定 keyId mapping：

- 每个 Human Reviewer 使用独立 Ed25519 key pair。
- public-key config 将 `keyId` 固定映射到唯一：

```text
issuer
actorId
actorType = human_reviewer
role = manual_reviewer
allowedScopes
status = active | revoked
```

- assertion 中的 `issuer/keyId/actorId/actorType/role/scopes` 必须与该可信
  mapping 完全一致；任一不一致 fail closed。
- 一个 keyId 不得映射到多个 actorId、多个 role 或 Host Verifier scope。
- signing tool 只获得目标 Reviewer 私钥和 keyId；不得允许持有一个 Reviewer
  私钥的调用方选择其他 Reviewer、Verifier key 或 Verifier role。
- 即使 signer 伪造 assertion claims，verifier 也会以可信 keyId mapping
  覆盖并拒绝 identity/role/scope mismatch。
- 若未来采用集中签名服务，服务必须在签发前认证 Reviewer session /
  credential；不能只接受 actorId 字符串。
- Human Reviewer private key 不得进入 Repository、runtime public-key config、
  logs 或 HTTP responses。

#### Host Verifier authentication

- 使用独立 Ed25519 key domain。
- `actorType=host_verifier`、`role=host_verifier`。
- 私钥由 verifier workload / CI secret store 持有。
- 不能复用 Human Reviewer public key、issuer 或 assertion。
- Runtime verifier 身份与历史 Verification / trustAnchor 分离。
- public-key config 将 Verifier `keyId` 固定映射到唯一：

```text
issuer
actorId / verifier service identity
actorType = host_verifier
role = host_verifier
allowedScopes
status = active | revoked
```

- Human Reviewer key 不得映射到 `host_verifier` role，Verifier key 不得映射
  到 `manual_reviewer` role。

#### AuthenticationEvidenceId

Adapter 验证 assertion 后生成：

```text
sha256(jcs({
  issuer,
  keyId,
  assertionId,
  subject,
  actorType,
  role,
  audience,
  scopes,
  issuedAt,
  expiresAt,
  assertionDigest
}))
```

- 不包含原始 Bearer token。
- 不包含私钥。
- 只用于 Host Context / audit evidence。

#### Gateway role mapping

```text
role=manual_reviewer -> actorType=human_reviewer
                     -> issuerScope=manual_reviewer

role=host_verifier   -> actorType=host_verifier
                     -> issuerScope=host_verifier
```

一个 assertion 只允许一个 issuer role。多 role 或未知 role fail closed。

`scopes` 必须显式区分：

```text
recovery_review.final_decision
recovery_review.read_replay
```

请求 access 必须在 assertion scopes 中；Gateway 不接受 body actorType、
issuerScope 或 scope 提权字段。

#### Expiry / revocation / audience

Adapter 必须 fail closed：

- signature invalid。
- unsupported algorithm / keyId。
- issuer 不在 allowlist。
- audience mismatch。
- token expired / notBefore in future。
- role / scope / actorType mismatch。
- revoked `assertionId` 或 `keyId`。
- missing / unreadable public-key or revocation config。

Private keys：

- 不进入 repository。
- 不通过 HTTP body / Agent / Tool 传递。
- 不记录日志。

#### Gateway / identity scope isolation

- Gateway 只在 Host HTTP composition root 创建。
- AgentRunner、ToolRegistry、Provider、RecoveryManager 与普通 business
  service 不持有 Gateway 引用。
- Gateway 不返回 Context；Context 只在 Gateway 内部创建和消费。
- G2 Foundation 不创建 Final Decision / Replay capability issuer。
- Step 2 issuer 后续必须消费 Gateway Context，而不是重新认证 actor 字符串。
- `src/recovery/index.ts` 只导出 capability assertion / types，不导出
  Gateway 或 Context creator。

#### Dependency / deployment / persistence

- 新依赖：无。
- 使用 Node `http`、`crypto` 和现有 Zod。
- 需要 Host 提供 public-key config、issuer allowlist、audience、
  revocation denylist 与 private-key signing tooling。
- 不新增 Migration / SQLite Schema；Context / capability 为进程内 opaque
  object，authentication evidence 后续进入 Event JSON。

## 4. Step 总览

| Step | 名称 | 依赖 | 核心产物 | 是否修改状态 | Step 完成时最高级别 | 生产入口 |
|---|---|---|---|---|---|---|
| 1 | SourceContractV1 Contract + Integrity | G1 | pure schema / digest / validator / payload roundtrip | 否 | L2 | 关闭 |
| G2-F | Host Identity & Gateway Foundation | Step 1；G2 为出口 Gate | Ed25519 Host assertion verifier + Principal + opaque Context + Gateway | 否 | L2 | 关闭 |
| G2-F.2R | G2 Trust Model Remediation | G2-F.2 | In-process TCB policy + no untrusted JS tests + accepted-risk record | 否 | L1 | 关闭 |
| 2 | Final Decision / Replay Authorization | Step 1、G2-F、G2-F.2R、G2-F.3 pass | opaque capabilities + exact claims validation | 否 | L1 | 关闭 |
| 3 | Unknown Settlement / Audit Chain | Step 1-2、G4 预审 | pure resolver + audit DTO + convergence capability contract | 否 | L1 | 关闭 |
| 4 | Final Decision Core UoW | Step 1-3 | Review CAS / Event / Operation / Exact Replay / current PlanStep | 是，内部未公开 | L2 | 关闭且不可达 |
| 5 | Downstream Skip Convergence | Step 4 | PlanStep 1:N ToolRun batch skipped + Plan terminal | 是，内部未公开 | L2 | 关闭且不可达 |
| 6 | Task Final Convergence | Step 5、G3/G4 | Terminal Guard integration + Task terminal + final service | 是，受 capability 保护 | L2 | 关闭 |
| 7 | Terminal Read-only Replay | Step 6 | Host-authorized exact read-only query | 否 | L2 | 关闭；满足 R1 readiness 申请条件 |
| 8 | Multi-Write Barrier + Unified Admission | Step 5、G5a | pure Barrier policy + combined ToolRun begin UoW | 是，普通 admission | L2 | 局部路径，不得宣称全覆盖 |
| 9 | AgentRunner / Scheduler Write Closure | Step 8 | direct Write fail closed + composition guard + G5b exit evidence | 是，入口治理 | L2 | 满足 R2 申请条件 |
| 10 | Cancel / Pause / Terminal Race | Step 6-9 | First Terminal Commit Wins tests + race hardening | 是，边界收敛 | L2 | 关闭；仍待 Step 11 与 L3 评审 |
| 11 | Fault Injection / Concurrency / Regression | Step 1-10 | worker tests、fault matrix、full regression | 否，发现缺陷需单独修复授权 | L2 | 关闭；满足 R3 / L3 申请条件 |

G2 Foundation 是 Step 2 前的未编号前置子步骤。原 Step 1-11 编号、顺序和核心
范围保持不变。

## 5. Step 详细设计

### 5.0 Step 边界与验收级别不变量

**[强制规则]**

1. Step 4-5 之间不得产生任何需要后续生产事务补齐的 Final Decision。
   - Step 4-5 的 UoW / service 仅可由测试 fixture 调用。
   - public recovery barrel、默认 composition root 和真实 Host 入口必须
     保持关闭。
   - 不得把“Review 已 final、downstream 尚未 skip、Task 尚未 terminal”的
     状态暴露给生产调用方。
   - Step 5 必须使 Final Decision 核心和 downstream skip 在同一
     immediate transaction 内完整提交；缺少 Task convergence 只能作为
     R1 前的入口关闭原因，不能由第二个生产事务补写既有 Decision。

2. Step 6-7 完成前，Final Decision 必须对真实生产入口保持关闭。
   - Step 6 只能完成内部 Task Convergence 集成与测试。
   - Step 7 完成 Terminal read-only Replay 后，Step 6-7 才共同满足 R1
     readiness 申请条件。
   - R1 通过只确认内部集成具备条件，不打开真实 Host Final Decision
     写入口。
   - Step 6 或 Step 7 任一未封存，生产入口保持关闭。
   - 真实入口默认在 R2、Step 10-11 验收和另行 L3 评审完成前保持关闭。
   - 若要在受控环境提前开放，必须提供独立隔离证明并经架构审批。

3. Step 8-9 完成前，不得宣称 Multi-Write Barrier 覆盖所有普通 Write。
   - Step 8 最多声明“真实 Scheduler 路径的 admission integration passed”。
   - Step 8 完成时 direct AgentRunner Write bypass 仍可能阻塞 L3。
   - Step 9 封闭 bypass 且 G5b 通过后，Step 8-9 才共同满足 R2 申请条件。
   - R2 通过前，报告不得使用“all ordinary Write covered”或等价表述。

4. 每个 Step 的封存结论必须明确写出：
   - 已达最高验收级别：L1 / L2 / L3。
   - 生产入口状态：closed / candidate / open。
   - 未开放原因和对应 Release Gate。

### Step 1: SourceContractV1 Contract + Integrity

#### 目标

先完成自动与人工 negative-proof 的共同纯契约，不进入 Decision 或数据库
状态修改。

#### 依赖 / Gate

- 依赖：无。
- Gate G1：先证明现有 `EvidencePayloadStore` 可以保存 canonical JSON、
  读取并重算 digest。
- Gate G7：只使用现有 payload / envelope digest 模型。

#### 候选文件

- 新增 `src/recovery/recovery-source-contract.ts`
- 更新 `src/recovery/index.ts`
- 新增 `tests/recovery/recovery-source-contract.test.ts`

#### 接口契约

定义：

```text
RecoverySourceContractV1Schema
RecoverySourceContractV1 =
  RecoverySystemVerifiedSourceContractV1
  | RecoveryManualAttestedSourceContractV1
```

共同字段：

- `sourceContractSchemaVersion`
- `sourceContractAuthority`
- `taskId`
- `reviewId`
- `originalUnknownWriteToolRunId`
- `targetResourceIdentity`
- `queryScope`
- `observationTimeWindow`
- `coverageCompleteness`
- `negativeObservationSemantics`
- `provenance`
- `result`
- `sourceObservedAt`
- `payloadDigest`

System-verified variant：

- `sourceContractAuthority = system_verified`
- `provenance = controlled_runtime_read`
- verifier identity / binding digest
- verification result = passed

Manual-attested variant：

- `sourceContractAuthority = manual_attested`
- `source_type = manual_review`
- `actorId` / `actorType = human_reviewer`
- manual responsibility
- provenance 不得为 controlled runtime read
- result 允许 passed / inconclusive / not_run 对应的受控表达

提供：

```text
canonicalRecoverySourceContractV1()
computeRecoverySourceContractDigest()
validateRecoverySourceContractV1()
```

Digest 规则：

- canonical payload 不包含自引用的 `sourceContractDigest` 字段。
- `sourceContractDigest = sha256(jcs(canonical contract payload))`。
- Contract 以 `payloadType=json` 持久化时，Payload Store 的 semantic
  payload digest 必须等于 `sourceContractDigest`。
- Decision payload / Operation payload digest / requestKey 绑定该 digest；
  不得在 Service 中由调用方覆盖。

Validator 不得访问 DB、Registry、Provider、文件系统或网络。

#### 测试

- system / manual 合法样例。
- 未知字段拒绝。
- canonical 序列化稳定。
- digest 稳定且匹配。
- 跨 Task / Review / Unknown Write 身份拒绝。
- target / scope / time window / coverage 缺失拒绝。
- manual 伪装 controlled runtime / system verified 拒绝。
- system variant 缺少 verifier binding 拒绝。
- payload store put -> read -> integrity -> parse 往返。
- 文件篡改触发 digest mismatch。

#### 验收

- 只新增纯 contract 与 payload integrity 集成测试。
- 不修改 DB、Schema、Final Decision UoW、Authorization 或 Task 状态。
- Gate G1 证据明确写入 Development Report。
- 最高验收级别：L2。
- 生产入口：closed。

### G2 Foundation: Host Identity & Gateway

#### 目标

在现有 Step 2 前建立真实可验证的 Host identity 来源和 Gateway 边界。

该子步骤不改变原 Step 1-11 的编号、顺序或核心范围。

#### 依赖 / Gate

- 依赖 Step 1。
- 出口 Gate：G2。
- Step 2 必须依赖 G2 Foundation 完成并通过 G2 架构评审。

#### G2-F.1 Contract / Gateway Internal Tests

目标验收级别：L1。

候选文件：

```text
src/host-auth/host-assertion.ts
src/host-auth/host-authentication-config.ts
src/host-auth/ed25519-host-authentication-adapter.ts
src/host/authenticated-principal.ts
src/host/authenticated-host-request-context.ts
src/host/recovery-review-host-gateway.ts
tests/host-auth/host-assertion.test.ts
tests/host/authenticated-host-request-context.test.ts
tests/host/recovery-review-host-gateway.test.ts
```

接口：

```text
HostAssertionV1ClaimsSchema
HostAuthenticationConfigSchema
HostAuthenticationAdapter.authenticate()
AuthenticatedPrincipal
AuthenticatedHostRequestContext
RecoveryReviewHostGateway
```

要求：

- Ed25519 signature verification。
- issuer / keyId allowlist。
- exact audience。
- issuedAt / notBefore / expiresAt。
- assertionId / keyId revocation。
- maximum TTL。
- role -> actorType / issuerScope mapping。
- keyId -> actorId / actorType / role / allowedScopes immutable mapping。
- assertion 只允许一个 issuer role。
- scope allowlist：
  - recovery_review.final_decision
  - recovery_review.read_replay
- Context 使用 module-private WeakMap。
- Context 不离开 Gateway。
- Gateway 不接受 body-supplied actorId / actorType / issuerScope / scope。
- Gateway / Context creator 不导出到 recovery public barrel。
- G2 Foundation 不包含 Final Decision / Replay capability issuer。

本阶段不能用 WeakMap 或 gateway unit tests 单独通过 G2。

#### G2-F.2 Real Host Authentication Adapter Integration

目标验收级别：L2。

候选文件：

```text
src/host/http/recovery-review-host-server.ts
src/host/http/recovery-review-host-routes.ts
tests/integration/recovery-review-host-auth.test.ts
tests/integration/recovery-review-host-auth-worker.ts
```

实现要求：

- Node built-in `http`。
- 默认 loopback binding。
- `Authorization: Bearer <HostAssertionV1>`。
- 由真实 Ed25519 verifier 验证，不使用 mock principal。
- Human Reviewer 与 Host Verifier 使用独立 keyId / private key。
- keyId mapping 验证 actorId / actorType / role / scopes，不允许私钥持有者
  通过 assertion claim 切换到其他 actor 或 role。
- Runtime 只加载 public keys 和 revocation config。
- private keys 仅存在于 Host signer / test temp secret fixture，不进入 repo。
- Gateway 在认证成功后只创建 opaque AuthenticatedHostRequestContext。
- G2 Foundation 不签发 Final Decision / Replay capability。
- HTTP DTO 不含 actorType / issuerScope / permission 字段。

外部 signer tooling：

```text
scripts/host-auth/issue-host-assertion.ts
```

该工具只在 Host 管理面使用，不进入 runtime composition。
工具必须按 keyId 加载对应私钥，并拒绝覆盖可信 keyId mapping 中的 actor /
role / scope。

#### G2-F.2R Trust Model Remediation

该子步骤位于重新执行 G2-F.3 之前。

目标：将已批准的 Option B 单进程 Trusted Computing Base（TCB）安全模型
落实到测试、报告与 G2 验收声明中。

范围：

1. 记录当前 TCB：
   - 静态装载、经过审查的应用代码。
   - Host 注册的 Tool Implementation。
   - Composition Root、Gateway、Adapter、UoW、Repository。
2. 记录不可信数据：
   - HTTP body / headers / assertion。
   - LLM output / ToolCall arguments。
   - Tool output / Provider / MCP / persisted JSON。
3. 验证不存在不可信 JS / dynamic plugin execution 入口：
   - no `eval`。
   - no `new Function`。
   - no `node:vm`。
   - no dynamic `import()` of user-provided code。
   - no third-party JS plugin loader。
4. 验证 AgentRunner / ToolRegistry / Provider / RecoveryManager：
   - 只执行静态编写或 Host 注册的代码。
   - 不把 model / tool / provider / MCP data 当作可执行 JS。
5. 验证外部不可信数据无法创建可信 Context。
6. 保留 G2-F.3 原始 attack reproduction，并明确其为当前排除的恶意
   in-process TCB code 场景。
7. 核查 recovery public barrel 与 business module import policy 仍是
   defense-in-depth，而不是安全沙箱。

若发现实际不可信 JS 执行入口：

- 立即停止。
- G2 恢复 BLOCKED。
- 不得用修改威胁模型文字掩盖。

允许的 remediation 文件：

```text
docs/PHASE3_STEP6_3_5_G2_TRUST_MODEL_REMEDIATION_DEVELOPMENT_REPORT.md
tests/security/g2-trusted-runtime-boundary.test.ts
```

该阶段不修改已封存 Adapter / Gateway / HTTP Server。

验收：

- 最高验收级别：L1 Internal Implementation Complete。
- Production Entry：closed。
- 原始 in-process self-Gateway attack 不得被写成“已阻止”。
- 必须明确该项属于已接受风险。

#### G2-F.3 G2 Gate Final Acceptance

前置条件：

- G2-F.2R Trust Model Remediation 已封存。
- 不得直接沿用此前 G2-F.3 BLOCKED 报告并自动改为 PASS。
- 必须重新执行 Gate acceptance。

G2 只有同时满足以下条件才通过：

1. G2-F.1 internal isolation tests 通过。
2. G2-F.2 real adapter integration 通过。
3. G2-F.2R TCB remediation tests / report 通过。
4. 至少一次 loopback HTTP integration 使用真实 Ed25519 signature。
5. 未认证、错误签名、过期、错误 audience、撤销 key / assertion 均 fail
   closed。
6. Manual / Verifier token 的跨 actor、跨 role、跨 issuer、跨 scope 均拒绝。
7. keyId mapping mismatch 与 key revocation 拒绝。
8. `final_decision` / `read_replay` allowedAccess 交叉请求拒绝。
9. Context 无法由 JSON clone / spread / cast 伪造。
10. 不可信 HTTP / model / tool / provider / MCP input 无法创建 Context。
11. TCB 中没有 untrusted JS / dynamic plugin execution 入口。
12. recovery public barrel 不包含 Gateway / Context creator。
13. AgentRunner / ToolRegistry / Provider / HTTP business DTO 无 Gateway /
    Context creator 引用。
14. 原 in-process self-Gateway attack 被明确记录为已接受风险，而不是已阻止。
15. G2 evidence 可由 G2 Foundation 架构评审复核。

G2 Gate test matrix：

| 场景 | 预期 |
|---|---|
| 合法 Manual assertion | 创建 human_reviewer Principal / Context |
| 合法 Verifier assertion | 创建 host_verifier Principal / Context |
| signature invalid | reject |
| unknown keyId / issuer | reject |
| expired / notBefore future | reject |
| audience mismatch | reject |
| revoked keyId | reject |
| revoked assertionId | reject |
| keyId 映射到其他 actorId | reject |
| Human key 声明 host_verifier role | reject |
| Verifier key 声明 manual_reviewer role | reject |
| Manual / Verifier issuer domain 交叉 | reject |
| final_decision / read_replay scope 交叉 | reject |
| assertion 包含多个 issuer role | reject |
| body 提供 actorId / actorType / issuerScope | reject |
| Context spread clone / JSON clone / cast | reject |
| recovery public barrel 暴露 Gateway / Context creator | reject |
| AgentRunner / ToolRegistry / Provider 持有 Gateway | reject |
| public-key config 包含 private key material | reject |
| untrusted HTTP input 创建 Context | reject |
| model / tool-call / provider / MCP data 创建 Context | reject |
| runtime 存在 `eval` / `new Function` / `node:vm` / dynamic user JS import | G2 blocked |
| in-process trusted code 自建 Gateway / Context | accepted risk，不得声明已阻止 |

不允许：

- 使用 Mock Principal 作为 G2 final evidence。
- 使用普通 object 冒充 AuthenticatedHostRequestContext。
- 把 `NODE_ENV`、环境变量 username、CLI username 或 HTTP body actorId
  当作身份。

#### G2 Foundation 验收

- 最高验收级别：L2。
- Production Entry：closed。
- G2 Foundation 不实现 Final Decision / Replay capability 或 capability issuer。
- G2 安全目标只覆盖外部 / 数据输入认证，不覆盖任意恶意 in-process JS。
- Module / Gateway / Context / issuer 边界属于 defense-in-depth，不是 sandbox。
- G2 通过后，Step 2 才能获得开发授权。
- 仍需 G2 Foundation 的独立 Development Report 和架构评审。

### Step 2: Final Decision / Replay Authorization

#### 目标

建立完整请求绑定的 Final Decision 与 Terminal Replay capability，不实现
Decision UoW。

#### 依赖 / Gate

- 依赖 Step 1、G2-F.1、G2-F.2、G2-F.2R。
- Gate G2：重新执行 G2-F.3 并通过。

#### 候选文件

- 新增 `src/recovery/recovery-review-final-decision-authorization.ts`
- 更新 `src/recovery/index.ts`，只导出 assertion / types，不导出 issuer
- 新增 `tests/recovery/recovery-review-final-decision-authorization.test.ts`

#### 接口契约

Final Decision claims：

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

Terminal Replay claims：

```text
access = read_replay
same complete request identity
```

要求：

- WeakMap / module-private issuer。
- Final Decision / Replay issuer 只接受 G2 Foundation 的
  `AuthenticatedHostRequestContext` 作为身份输入。
- issuer 不接受 actorId / actorType / issuerScope 普通参数。
- Manual issuer 只能签发 `human_reviewer`。
- Verifier issuer 只能签发 `host_verifier`。
- 普通 object、spread clone、JSON clone、cast 无法构造。
- `requestNonce` 不替代 requestKey。
- `src/recovery/index.ts` 不暴露 issuer。
- Service 后续必须自行计算 digest / requestKey 并与 claims exact 比较。

#### 测试

- Final / Replay 合法 capability。
- 跨 access / task / review / operation / version / digest / sourceContract /
  requestKey / actor 拒绝。
- manual 与 verifier issuer 交叉使用拒绝。
- clone / cast / JSON roundtrip 拒绝。
- 新 read nonce 可绑定同一 requestKey。
- finalized 前不能把 Terminal Replay authorization 当写权限。
- G2 Foundation 真实 Gateway flow 生成可信 Context 后，Step 2 issuer 才能
  签出 capability。
- 直接传入普通 Context object / clone / cast 拒绝。

#### 验收

- 无 UoW、无 SQLite 写入、无 Event。
- 不重新实现 Host Authentication；只消费 G2 Foundation Context。
- capability claims 与设计文档完全一致。
- 最高验收级别：L1。
- 生产入口：closed。

### Step 3: Unknown Settlement / Audit Chain

#### 目标

把 Original Unknown Write 的最终审计链与 downstream 状态判断抽成单一只读
Resolver，并定义 Final Convergence capability contract。

#### 依赖 / Gate

- 依赖 Step 1-2。
- Gate G4 预审：确定同一审计链输入字段。

#### 候选文件

- 新增 `src/recovery/recovery-unknown-write-settlement.ts`
- 可选新增 read-only adapter：
  `src/storage/recovery-review-audit-reader.ts`
- 新增 `src/storage/recovery-review-final-convergence-capability.ts`
- 新增 `tests/recovery/recovery-unknown-write-settlement.test.ts`
- 新增 `tests/storage/recovery-review-final-convergence-capability.test.ts`

#### 接口契约

```text
resolveUnknownWriteSettlement(input)
  -> open_unknown
   | resolved_success
   | resolved_not_executed
   | state_inconsistent
```

输入必须覆盖：

- Original ToolRun
- RecoveryReview
- final Operation
- applied Final Decision Event
- Evidence Submission
- Verification
- SourceContractV1 digest / payload
- target PlanStep
- downstream PlanSteps / ToolRuns
- pending Approvals
- current Task / Plan

规则：

- `resolved_success` 必须 Review / Operation / Event / Evidence / Verification
  完整匹配。
- `resolved_not_executed` 还必须满足当前 PlanStep failed，所有 downstream
  ToolRun terminal skipped，所有 downstream PlanStep skipped。
- 任何 final 裸状态但审计链不完整 -> `state_inconsistent`。
- Original ToolRun 永远只读 `unknown`。

Final Convergence capability：

- 只定义进程内 capability contract。
- Step 6 前不得用于 Task 状态写入。

#### 测试

- open / success / not-executed / inconsistent 全矩阵。
- missing Operation / Event / Evidence / Verification。
- actor / payload / SourceContract mismatch。
- skipped PlanStep 下 queued ToolRun -> inconsistent。
- Original ToolRun 不被修改。
- capability clone / cast 失败。

#### 验收

- Resolver 只读。
- 未修改 Terminal Guard、Task transition 或共享状态。
- Gate G4 输入字段清单写报告。
- 最高验收级别：L1。
- 生产入口：closed。

### Step 4: Final Decision Core UoW

#### 目标

实现不包含 downstream 批量 skip 和 Task terminal convergence 的 Final
Decision 核心事务，用于独立验证 Authorization、requestKey、CAS、Event、
Operation 和 Exact Replay。

#### 依赖 / Gate

- 依赖 Step 1-3。
- 必须仍是 internal-only，不通过 public service 暴露生产入口。

#### 候选文件

- 新增 `src/storage/recovery-review-final-decision-unit-of-work.ts`
- 新增 `src/recovery/recovery-review-final-decision-service.ts`
- 更新 `src/storage/index.ts`，只做最小 internal export
- 新增 `tests/storage/recovery-review-final-decision.test.ts`
- 新增 `tests/recovery/recovery-review-final-decision-service.test.ts`
- 可选新增 worker fixture `tests/recovery/review-final-decision-worker.ts`

#### 输入

- ownership + expectedTaskVersion
- Final Decision Authorization capability
- reviewId / expectedDecisionVersion
- operation
- evidenceSubmissionId / verification ids
- SourceContract binding
- decision note
- expected Task / ToolRun / PlanStep versions

#### 权威事务顺序

```text
BEGIN IMMEDIATE
one StorageWritePermit
re-check Lease / Fencing / Authority
Service computes canonical digest / requestKey
validate Authorization claims
lookup requestKey
  found -> verify audit chain and return replay
  not found:
    Task version CAS
    latest Cancel / Pause Intent
    Review decisionVersion CAS
    Evidence / Verification eligibility
    Unknown Settlement / Barrier classification
    current Write PlanStep completed / failed
    generate operationId
    append Final Decision Event
    append Operation appliedEventId
    append Checkpoint
COMMIT
```

其中 `operationPayloadDigest` 是 canonical Final Decision payload 的 JCS
SHA-256 digest；`requestKey` 必须使用现有的
`computeRecoveryReviewOperationRequestKey()` 语义，不能由调用方直接提供。

本 Step 不写 downstream Skip Event，不执行 Task final transition。
如果该 UoW 被错误接入生产入口，必须 fail closed。

#### 测试

- 首次 confirm success / not executed。
- 同一 requestKey 响应丢失 Exact Replay。
- Event ID -> Operation.appliedEventId 精确绑定。
- Event payload operationId / requestKey 反向绑定。
- Event payload 持久化 actorId / actorType / sourceContractDigest。
- expectedTaskVersion 只影响首次执行。
- expectedDecisionVersion conflict。
- Authorization 全 claims mismatch。
- Event / Operation / Checkpoint 任一失败整体 rollback。
- Original ToolRun unknown 不变。
- 不调用 Provider / External Read / Verifier / ToolRegistry。

#### 验收

- UoW 只通过 test fixture 调用。
- 无 public barrel 生产入口。
- 所有写入共享一个 permit。
- 最高验收级别：L2。
- 生产入口：closed and unreachable。
- 不得产生需要 Step 5 后续生产事务补齐的 Final Decision。

### Step 5: Downstream Skip Convergence

#### 目标

在 Final Decision Core UoW 内实现 PlanStep `1:N` ToolRun 的原子 skipped
收敛和 Plan terminal，不执行 Task terminal convergence。

#### 依赖 / Gate

- 依赖 Step 4。
- Gate G4：Resolver 与 convergence 输入必须同源。

#### 候选文件

- 更新 `src/storage/recovery-review-final-decision-unit-of-work.ts`
- 更新 `src/storage/execution-state-machine.ts` 或复用其 transition guard
- 更新 `src/storage/plan-step-repository.ts` 仅当需要批量 CAS helper
- 更新 `src/storage/tool-run-repository.ts` 仅当需要批量读取 / CAS helper
- 更新 `tests/storage/recovery-review-final-decision.test.ts`
- 新增 `tests/storage/recovery-review-final-decision-convergence.test.ts`

#### 事务规则

对每个 downstream PlanStep：

1. `listByPlanStep()` 载入全部 ToolRun。
2. 先验证全部 ToolRun / PlanStep / Approval / versions。
3. Write Step 必须恰好一条 ToolRun；Read Batch 允许 `1:N`；
   unknown_tool 允许 0。
4. 逐条 ToolRun `queued -> skipped`，每条写一个 `tool.skipped` Event。
5. 全部成功后，PlanStep 只 CAS 一次 `queued -> skipped`，写一个
   `plan_step.skipped` Event。
6. 所有 downstream terminal 后，Plan `active -> failed`。
7. 任一记录失败，整个 Decision transaction rollback。

Event payload 必须绑定：

```text
operationId
upstreamDecisionEventId
requestKey
reasonCode = UPSTREAM_WRITE_NOT_EXECUTED
planId
planStepId
toolRunId
upstreamToolRunId
upstreamReviewId
fencingToken
```

#### 测试

- write PlanStep 1:1。
- read_batch 1:N 批量 skipped。
- unknown_tool 0 ToolRun。
- 一条 ToolRun version mismatch -> 整体 rollback。
- pending Approval -> fail closed。
- PlanStep 只 CAS 一次，只有一个 PlanStep skipped Event。
- 每条 ToolRun 恰好一个 skipped Event。
- Exact Replay 不重复状态 / Event / Checkpoint。
- Plan failed 仅在全部 PlanStep terminal 后发生。

#### 验收

- Task 仍保持 waiting_review / 非 terminal。
- Original Unknown Write 不变。
- Step 5 内的 Final Decision + downstream skip 已原子提交，不需要后续生产
  事务补齐。
- 最高验收级别：L2。
- 生产入口：closed and unreachable。

### Step 6: Task Final Convergence

#### 目标

实现 capability-guarded Task Final Convergence，将 Final Decision、Resolver、
Terminal Guard 和 downstream convergence 集成。

#### 依赖 / Gate

- 依赖 Step 5。
- Gate G3：Final Convergence capability 只能由当前 Final Decision UoW 签发。
- Gate G4：Terminal Guard、Resolver、skip convergence 使用同一审计链。

#### 候选文件

- 更新 `src/storage/recovery-review-final-decision-unit-of-work.ts`
- 更新 `src/storage/recovery-review-final-convergence-capability.ts`
- 更新 `src/storage/execution-state-machine.ts`
- 更新 `src/storage/task-invariants.ts`
- 更新 `src/recovery/recovery-review-final-decision-service.ts`
- 更新 `src/recovery/index.ts`
- 更新 `tests/storage/recovery-review-final-decision.test.ts`
- 新增 `tests/storage/recovery-review-final-convergence.test.ts`

#### 接口

```text
transitionTaskFinalConvergenceInCurrentTransaction({
  ownership,
  expectedTaskVersion,
  status: completed | failed | cancelled,
  capability
}, permit)
```

要求：

- module-private capability。
- 不接受普通 `transitionTask()` 调用。
- Review / Operation / Event / Evidence / Verification / downstream states
  在当前事务可见后才执行 Terminal Guard。
- `TASK_TRANSITIONS` 不需要公开加入 `waiting_review -> completed`。
- Task / Plan / PlanStep / Decision Event / Operation / Checkpoint 同一 permit。

#### 测试

- confirmed_succeeded -> Task completed。
- confirmed_not_executed -> Plan failed -> Task failed。
- public transitionTask 仍拒绝 `waiting_review -> completed`。
- capability clone / cast / 外部调用拒绝。
- Terminal Guard 遇到 incomplete audit chain 拒绝。
- Event / Operation / downstream / Task / Checkpoint 任一失败整体 rollback。
- Original ToolRun unknown。

#### 验收

- Final Decision service 只完成内部集成，public Host 入口仍关闭。
- 最高验收级别：L2。
- 生产入口：closed；仅满足 R1 的前半条件。

### Step 7: Terminal Read-only Replay

#### 目标

为已经 terminal 的 Task 提供 Host-authorized、只读、精确 requestKey Replay。

#### 依赖 / Gate

- 依赖 Step 2、Step 6。
- 无 Lease、无 ExecutionAuthority、无写 permit。

#### 候选文件

- 新增 `src/recovery/recovery-review-terminal-replay-service.ts`
- 更新 `src/recovery/index.ts`
- 新增 `tests/recovery/recovery-review-terminal-replay.test.ts`
- 新增 `tests/storage/recovery-review-terminal-replay.test.ts`

#### 接口

```text
replayTerminalFinalDecision({
  authorization,
  requestKey,
  operation,
  expectedDecisionVersion,
  operationPayloadDigest,
  sourceContractDigest
})
```

要求：

- `access=read_replay`。
- 只读取指定 requestKey。
- 校验 Operation / Event / Review / Evidence / SourceContract / downstream
  terminal 状态。
- 不列出其他 review / request。
- 不写 Event / Checkpoint。
- 不 Claim Lease。
- 不签发 ExecutionAuthority。

#### 测试

- terminal Task 成功 Replay。
- nonterminal Task 拒绝该只读入口。
- 不同 requestKey / digest / actor / operation 拒绝。
- incomplete Operation / Event / Evidence chain 拒绝。
- 不增加 Event / Checkpoint / ToolRun 状态。
- 旧 Owner 无法通过 read auth 取得写权限。

#### 验收

- fallback 需要新的 `read_replay` capability，不复用写 capability。
- 最高验收级别：L2。
- Step 6-7 均封存后，才可申请 R1 integration readiness。
- R1 通过也不自动打开真实 Final Decision Host 入口。
- 真实入口默认在 R2、Step 10-11 和另行 L3 评审完成前保持 closed。

### Step 8: Multi-Write Barrier + Unified Admission

#### 目标

实现 Write Barrier policy，并把通用 ToolRun / PlanStep 校验与 Barrier 接入
真实 Write admission。

#### 依赖 / Gate

- 依赖 Step 5。
- Gate G5a：所有普通 Write 路径已枚举。

#### 候选文件

- 新增 `src/storage/recovery-multi-write-barrier-policy.ts`
- 更新 `src/storage/execution-unit-of-work.ts`
- 更新 `src/persistence/execution-bridge.ts`
- 更新 `src/storage/tool-run-repository.ts` 仅当需要 batch/query helpers
- 新增 `tests/storage/recovery-multi-write-barrier.test.ts`
- 更新 `tests/scheduler/write-executor.test.ts`
- 更新 `tests/scheduler/read-worker-pool.test.ts`
- 更新 `tests/integration/persistent-execution.test.ts`

#### 接口

```text
beginOwnedToolRunAfterWriteBarrier({
  toolRunId,
  expectedToolRunVersion,
  ownership
})
```

事务：

```text
BEGIN IMMEDIATE
StorageWritePermit
Lease / Fencing / Authority
load Task / ToolRun / PlanStep
generic mode-agnostic admission validation
  - ToolRun queued
  - PlanStep queued / running
  - identity / version consistent
  - no skipped / terminal PlanStep
if mode == read:
  begin Read without Barrier
if mode == write:
  Barrier policy
  begin Write
ToolRun / PlanStep / Event / Checkpoint
COMMIT
```

#### 测试

- read / write 在 mode 分流前均拒绝 skipped PlanStep。
- Read 不执行 Barrier，但执行通用状态校验。
- earliest open unknown / resolved_not_executed / earlier nonterminal /
  historical unknown / target unknown 全部 fail closed。
- logical identity / ordinal ambiguity 拒绝。
- 多个 active Agent Plan 拒绝。
- Barrier + begin 同一 transaction。
- WriteExecutor / ReadWorkerPool 真实集成。
- 不调用 Registry / Host callback。

#### 验收

- 不能只交付 pure policy 测试。
- 必须证明真实 `WriteExecutor` 在副作用前完成 admission。
- 最高验收级别：L2。
- 可声明“Scheduler 路径 admission integration passed”。
- 不得声明覆盖所有普通 Write；direct bypass 仍由 Step 9 处理。

### Step 9: AgentRunner / Scheduler Write Closure

#### 目标

封闭 persistent 与非 persistent direct Write 旁路。

#### 依赖 / Gate

- 依赖 Step 8。
- G5b 不是 Step 9 的启动前置条件，而是 Step 9 的出口验收条件。
- Step 9 获得单独开发授权后，负责实现 Write closure，并在完成时提供：
  - Scheduler + ExecutionBridge 成为普通 persistent Write 唯一入口的证据。
  - direct AgentRunner Write fallback fail closed 的证据。
  - 相关真实集成测试和全量回归证据。

#### 候选文件

- 更新 `src/agent/agent-runner.ts`
- 更新 `src/persistence/coordinator.ts`
- 更新 `src/tools/registry.ts` 仅当需要受控 metadata / admission helper
- 更新 `tests/integration/scheduler-agent-runner.test.ts`
- 更新 `tests/integration/persistent-execution.test.ts`
- 新增 `tests/agent/agent-runner-write-admission.test.ts`

#### 要求

- `persistence !== undefined` 时必须存在 scheduler。
- persistent Task 的所有 Tool Call 走 Scheduler。
- scheduler 缺失时 Write 必须 fail closed。
- nonpersistent direct fallback 只允许 Read。
- AgentRunner 与 Scheduler registry 必须同一实例。
- Composition Root 不向普通业务服务暴露 raw Write execution。

#### 测试

- persistence without scheduler 构造 / 运行 fail closed。
- nonpersistent Write 拒绝。
- nonpersistent Read 仍可用。
- scheduled Read / Write 正常。
- direct `registry.execute()` 不进入普通 Write 路径。
- 真实 persistent integration 不出现绕过 Bridge 的 Write。

#### 验收

- Gate G5b 完成证据写入报告；未提供则 Step 9 不得封存。
- 若关闭 nonpersistent Write 会破坏现有产品语义，停止并单独评审，不得放行。
- 最高验收级别：L2。
- Step 8-9 均封存后，才可申请 R2。
- R2 未批准前，不得宣称 Multi-Write Barrier 已覆盖所有普通 Write。

### Step 10: Cancel / Pause / Terminal Race

#### 目标

验证并硬化 Final Decision、Cancel、Pause、terminal Task 的事务竞争。

#### 依赖 / Gate

- 依赖 Step 6-9。
- 不修改 Stage 3.2 / Stage 3.3 已封存行为。

#### 候选文件

- 更新 `src/storage/recovery-review-final-decision-unit-of-work.ts`
- 更新 `src/recovery/recovery-review-final-decision-service.ts`
- 更新 `src/storage/task-invariants.ts` 仅当 terminal race 需要收紧
- 新增 `tests/storage/recovery-review-final-decision-race.test.ts`
- 新增 `tests/storage/recovery-review-final-decision-race-worker.ts`
- 更新 `tests/storage/task-lease.test.ts`

#### 状态规则

- Cancel 在 final convergence 前已持久化：Cancel Priority 生效。
- Decision 提交但 Task 未 terminal：后续 Cancel 可生效。
- Decision + Task terminal 同一事务：First Terminal Commit Wins。
- terminal Task：拒绝新 Intent / Decision 写操作。
- Pause：允许 audit-only Decision，不允许 Resume / Dispatch / Re-plan。

#### 测试

- 两 SQLite connection 并发 Cancel / Decision。
- Cancel 先提交。
- Decision 只提交、Task 未 terminal，再 Cancel。
- Decision + Task terminal 同事务，再 Cancel。
- terminal Task 再 Decision。
- Pause / Decision / Clear / Cancel 交叉。
- 所有 race 只有一个合法终态。
- Exact Replay 不复活旧 Owner。

#### 验收

- First Terminal Commit Wins 完整矩阵通过。
- 不通过修改 terminal Task 来重开竞争。
- 最高验收级别：L2。
- 生产入口保持 closed，等待 Step 11 与另行 L3 生产入口评审。

### Step 11: Fault Injection / Concurrency / Regression

#### 目标

集中验证崩溃窗口、SQLite 多连接、多 worker、Event / Checkpoint failure
与全量回归。

#### 依赖 / Gate

- 依赖 Step 1-10。
- 本 Step 只允许修复本 Step 暴露且明确属于 Step 6.3.5 的缺陷。
- 新缺陷需要扩大范围时停止并单独报告。

#### 候选测试

- `tests/storage/recovery-review-final-decision-faults.test.ts`
- `tests/storage/recovery-review-final-decision-worker.ts`
- `tests/recovery/recovery-review-terminal-replay-worker.ts`
- `tests/storage/recovery-multi-write-barrier-concurrency.test.ts`
- 更新现有 SQLite reopen / lease / scheduler / integration suites

#### Fault Matrix

- Event append failure。
- Operation append failure。
- ToolRun skipped transition failure。
- PlanStep CAS failure。
- Task Terminal Guard failure。
- Task transition failure。
- Checkpoint failure。
- response lost after commit。
- SQLite reopen after Decision。
- two owners / two connections。
- cancel / pause late intent。
- old owner late write。
- Original ToolRun changed attempt -> rollback。

#### Regression

- Phase 1-3 existing tests。
- Stage 3.1-3.4 Recovery Evidence tests。
- Scheduler / AgentRunner / persistence tests。
- SourceContract / Authorization / Terminal Replay tests。
- Full test / typecheck / diff check。

#### 验收

- 所有失败路径整体 rollback。
- 所有 Exact Replay 不重复 Event / Checkpoint。
- 所有 concurrent writer 只有一个合法 winner。
- 最终全量回归报告真实记录。
- 最高验收级别：L2。
- Step 11 完成后才可申请 R3。
- R3 不自动开放生产入口；真实入口仍需独立 L3 评审，且 R2 必须已通过。

## 6. 测试层级

### 6.1 Pure Contract Tests

- SourceContractV1。
- Authorization claims。
- Unknown Settlement resolver。
- Barrier policy。

### 6.2 Storage UoW Tests

- Final Decision ordering。
- Exact Replay。
- skipped convergence。
- Task convergence。
- rollback。

### 6.3 Service Tests

- Service computes digest / requestKey。
- Authorization exact matching。
- no trust in caller digest。

### 6.4 Integration Tests

- WriteExecutor / ReadWorkerPool real admission。
- AgentRunner scheduler closure。
- Pause / Cancel / terminal race。

### 6.5 Multi-Connection / Worker Tests

- SQLite immediate transaction。
- two owner race。
- response lost replay。
- no duplicate Event / Checkpoint。

## 7. Migration v9 复用判断

### 7.1 可复用 v9

| 能力 | 复用方式 |
|---|---|
| actorType | decision payload digest + Event JSON |
| SourceContractV1 | payload store JSON + envelope / payload digest |
| Final Decision audit | operation / event / checkpoint |
| unknown settlement | Review / Operation / Event / Evidence / Verification read |
| skipped convergence | existing ToolRun / PlanStep status + CAS |
| Task final transition | existing Task version CAS + internal transition |
| Barrier | existing Plan / PlanStep / ToolRun / Review / Event |
| Terminal Replay | existing Operation/Event read path |

### 7.2 不申请 v10

本计划所有 Steps 均不修改 Migration v9、SQLite Schema 或状态枚举。

以下情况必须停止并单独提交 Migration 方案：

- Payload Store 无法持久化 canonical SourceContractV1。
- 需要 SQL-queryable `source_contract_digest`。
- 需要 SQL-queryable `actor_type`。
- 需要数据库级 Barrier Generation。
- 需要 Re-plan lineage / Re-plan operation。
- 需要 Durable Recovery Job。

## 8. 必须单独架构评审的问题

1. Gate G1 失败时的 SourceContract persistence 方案。
2. Gate G2 Host Principal / keyId mapping / Gateway 边界无法满足时。
3. Step 9 若必须破坏 nonpersistent Write 行为，需确认产品语义。
4. 任何 Migration v10 需求。
5. Durable Recovery Job / Re-plan / External Read / Transaction B 设计。
6. 需要改变 Stage 3.2 / Stage 3.3 / Stage 3.4 已封存 UoW。

## 9. Step 封存规则

- 每 Step 必须独立通过 targeted tests、`pnpm test`、`pnpm typecheck` 和
  `git diff --check`，除非该 Step 被明确限定为纯文档或 review。
- 每 Step 的 Development Report 必须写明未实施范围。
- 任何 Gate 未通过时，该 Step 不得封存。
- 封存结论必须明确最高验收级别 L1 / L2 / L3，不得只写“完成”。
- R1 / R2 / R3 必须单独审批；Step 封存不自动触发 Release Gate。
- G2-F.2R 必须先完成并封存，再重新执行 G2-F.3；旧 BLOCKED F3 报告不能
  自动转为 PASS。
- G2 Foundation 必须独立开发、测试、提交报告并封存；未封存前 Step 2 不得
  开始。
- Step 4-5 不得以“后续 Step 会补”作为生产性 Final Decision 的验收依据。
- Step 8-9 未共同封存前，任何报告不得宣称 Barrier 全覆盖。
- 后续 Step 不得在前一 Step 未封存时开始。
- 最终 Step 11 通过后仍需整体架构评审，不自动进入 Step 6.3.6。

## 10. 当前下一步骤

Step 1、G2-F.1、G2-F.2 已 Approved & Sealed。

当前下一步骤为：

```text
G2-F.2R Trust Model Remediation
```

准确边界：

- 记录并测试已批准的 In-Process TCB 威胁模型。
- 检查 `eval` / `new Function` / `node:vm` / dynamic user import /
  plugin loader。
- 验证 AgentRunner / ToolRegistry / Provider / RecoveryManager 只执行
  可信静态代码。
- 验证 HTTP / model / ToolCall / Provider / MCP / persisted JSON 不能创建
  trusted Context。
- 保留原 self-Gateway attack，作为 accepted risk。
- 不修改 Gateway / Adapter / HTTP Server / Host Assertion。
- 不实现 Final Decision / Replay capability。
- 不新增 Migration / Schema / dependency。

G2-F.2R 封存后，必须重新执行 G2-F.3 Gate acceptance。
重新 F3 通过且 G2 Gate 正式通过后，才可申请 Step 2。

## 11. 计划状态

**原 Implementation Plan、G2 Foundation 与 Option B TCB 已批准。**

当前仍保持 11 个 Step。内部实现完成（L1）、集成测试通过（L2）和生产
入口开放（L3）已分离；R1 / R2 / R3 是独立 Release Gates，不由任何 Step
自动触发。

R1 只确认 Final Decision + Terminal Replay 内部集成 readiness；R2 确认
Write coverage；R3 封存 Step 6.3.5。真实生产入口仍需 R2、Step 10-11 和
另行 L3 评审全部完成。

Step 1、G2-F.1、G2-F.2 已封存。G2-F.2R 与重新 G2-F.3 尚未授权。
