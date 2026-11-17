# ForgeFlow Phase 3 Stage 3.4 Closeout & Step 6.3.5 Architecture Discovery

> 状态：只读架构审查与结项整理完成。
>
> 本轮不授权 Step 6.3.5 生产开发。
>
> 结论：Stage 3.4 可以正式结项；Step 6.3.5 目前只有目标级设计，
> 尚未达到可直接实施的契约完整度。

## 0. 证据标记

本文使用以下标记区分事实来源：

- **[已实现]** 当前源码存在对应生产实现。
- **[已测试]** 历史 Development Report 记录实际测试通过。
- **[静态源码确认]** 本轮阅读源码确认，但没有重新执行测试。
- **[原计划明确]** 原始实施计划有明确文字要求。
- **[建议新增设计]** 当前没有批准方案，仅为下一步建议。
- **[尚未确认]** 文档或源码不足，不能作为已批准结论。

本轮未重新执行测试。测试数字来自 Step 8 Development Report 的历史记录，
不表示本次重新运行结果。

## 1. Stage 3.4 正式结项摘要

Stage 3.4 完成了 Recovery Evidence Readback 在
`waiting_review` 语义下的安全恢复基础：

- 不可变 Interrupted / Prepared Recovery Lineage。
- 基于真实 Lease Claim Event 的 Fencing Takeover。
- Interruption-only Recovery。
- Full Interrupted Recovery。
- New Attempt 创建。
- Pause Clear 后 Resume Continuation。
- 通过原 Stage 3.2 Dispatch Gate 的集成验证。
- 独立 SQLite 连接并发与故障回滚验证。

Stage 3.4 仍**没有**完成：

- Durable Recovery Job / Command Store。
- 跨重启 Recovery Orchestration。
- Recovery Evidence 专用自动 Scanner / Worker。
- External Read 执行。
- Transaction B 的端到端 Recovery 执行链。
- Recovery Evidence Verifier 的端到端自动执行。
- exactly-once External Execution。
- 真实进程崩溃注入。

这些限制属于 Stage 3.4 的明确边界，不应被解释为已经解决。

## 2. Step 1–8 最终状态

根据当前架构结项指令，最终治理状态为：

| Step | 内容 | 最终状态 |
|---|---|---|
| Step 1 | Recovery Lineage Contract | Approved & Sealed |
| Step 2 | State Transition Metadata Extension | Approved & Sealed |
| Step 3 | Recovery Preflight Capability | Approved & Sealed |
| Step 4 | Fencing Takeover Guard | Approved & Sealed |
| Step 5 | Interruption-only UoW | Approved & Sealed |
| Step 6 | Full Interrupted Recovery + New Attempt | Approved & Sealed |
| Step 7 | Stage 3.2 Integration & Concurrency | Approved & Sealed |
| Step 8 | Fault Injection & Regression | Approved & Sealed |

说明：

- 各历史 Development Report 中仍保留“等待架构评审”的历史状态文字。
- 本文按当前结项指令记录最终治理状态，不回写或篡改历史报告。

## 3. Recovery Architecture 已实现能力

### 3.1 Recovery Lineage / Exact Replay

**[已实现]**

- `src/storage/recovery-evidence-recovery-lineage.ts`
  - `RecoveryEvidenceLineageV1Schema`
  - Interrupt / Prepare Discriminated Union
  - Pair Validator
  - canonical Lineage helper
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
  - Interrupted transition metadata。
  - Prepare Recovery current-transaction transition。
  - Interrupted / Prepare Replay validation。
- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
  - Prepare Exact Replay。
  - Request / priorAttempt / newAttempt identity conflict。
  - 跨 Owner 历史结果 Replay。

### 3.2 Lease / Fencing Takeover

**[已实现]**

- `src/storage/task-lease-manager.ts`
  - `claimWithClaimEvent()`
  - `assertOwned()`
  - `hasActiveLease()`
- `src/storage/recovery-evidence-fencing-takeover-guard.ts`
  - `claimRecoveryEvidenceOwnership()`
  - `assertLeaseClaimEvent()`
  - `assertInterruptedClaimBinding()`
  - `assertPreparedClaimBinding()`

实际持久化权限依据：

- SQLite `task_leases.fencing_token`
- `lease.claimed` Event
- `ExecutionAuthority`

### 3.3 Interruption-only UoW

**[已实现]**

- `src/storage/recovery-evidence-interruption-unit-of-work.ts`
  - `interruptOwnedRecoveryEvidenceReadAttempt()`

覆盖：

- Cancel interruption。
- Pause interruption。
- Retry Unsafe interruption。
- phase=interrupt Exact Replay。

### 3.4 Full Recovery / New Attempt

**[已实现]**

- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
  - `recoverOwnedRecoveryEvidenceReadAttempt()`

事务内完成：

- Interrupted。
- ToolRun requeue。
- PlanStep resume。
- Prepared Event。
- New Attempt prepared。
- Checkpoint。

### 3.5 Pause Resume Continuation

**[已实现]**

- Host Pause Set / Clear 使用既有 Stage 3.3 UoW。
- Resume 必须：
  - Pause 已 Clear。
  - `resumeEligible=true`。
  - Retry Preflight passed。
  - 当前 Resume Owner 使用自己的 Claim Event。
- Prepared Event 保存真实 `pauseClearEventId`。

### 3.6 Stage 3.2 Dispatch Gate Integration

**[已实现] / [已测试]**

- Stage 3.4 不提供 Recovery 专用 Dispatch 入口。
- Prepared Attempt 必须调用：

```text
RecoveryEvidenceUnitOfWork.beginOwnedRecoveryEvidenceRead()
```

- Dispatch Gate 继续校验：
  - Task `waiting_review`
  - Request / Reservation / Review / Operation
  - Retry Dispatch Lineage
  - Lease / Fencing / Authority
  - Cancel / Pause Intent
  - 单一 active Attempt

### 3.7 Concurrency / Fault Injection

**[已测试]**

历史报告记录：

- 独立 SQLite 连接并发 Claim。
- 同一 Recovery Operation 并发 Prepare。
- 跨 Owner Replay。
- 旧 Owner stale fencing 拒绝。
- Event / Attempt / ToolRun / PlanStep / Checkpoint rollback。
- 数据库关闭 / 重开后的提交与回滚边界。

## 4. 测试与质量验证结果

以下数字来自 `PHASE3_STEP6_3_4_4_STAGE3_4_STEP8_DEVELOPMENT_REPORT.md`，
不是本轮重新执行结果：

```text
Test Files: 58 passed
Tests: 635 passed
pnpm typecheck: passed
git diff --check: exit code 0
```

`git diff --check` 当时仅包含 LF/CRLF normalization warning。

## 5. 当前架构能力边界

### 5.1 Stage 3.4 范围内已确认

- Task 在 Recovery Evidence Readback 流程保持 `waiting_review`。
- Original Unknown Write 保持 `unknown`。
- 不执行 External Read。
- 不调用 Provider。
- 不调用 Verifier。
- 不执行 Transaction B。
- 不创建公开 Recovery Worker / HTTP / IPC 入口。

### 5.2 当前源码中已存在但未纳入 Stage 3.4 结项链路

以下模块存在于源码，但不能据此宣称 Stage 3.4 已完成其端到端流程：

- `src/recovery/evidence-payload-store.ts`
- `src/recovery/recovery-evidence-readback-service.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-evidence-verification-service.ts`
- `src/storage/recovery-evidence-unit-of-work.ts` 中的 Transaction B UoW

静态源码确认：

- Recovery readback service 当前只有 Request / Reservation / preparation。
- `ToolRegistry.executeValidated()` 只在普通 ReadWorkerPool / WriteExecutor
  中出现，不在 Recovery Readback 执行链中。
- Transaction B UoW 存在，但没有 Recovery External Read executor 调用它完成
  端到端闭环。
- Verifier Runtime / Verification Service 存在，但其端到端可信执行流程未纳入
  Stage 3.4 封存范围。

### 5.3 通用 Recovery 组件与 Evidence Recovery 的区别

**[已实现]**

- `RecoveryScanner`：扫描非终态 Task 与 Lease 状态。
- `RecoveryClassifier`：分类普通 Task/Tool/Review 状态。
- `RecoveryManager`：普通 Read 崩溃恢复和 Review 流程。

**[静态源码确认]**

- `RecoveryManager.findEarliestUnfinishedPlanStep()` 只选择
  `agentExecutionPlans`，不会自动驱动 `recovery_evidence` Plan。
- Stage 3.4 的 Prepared Attempt 不会由该通用 Read Recovery 路径自动 Dispatch。

因此：

- Generic Scanner / Classifier / Manager 已存在。
- Recovery Evidence 专用自动编排仍不存在。

## 6. Step 6.3.5 原始目标及来源

### 6.1 来源状态

顶层 `docs/PHASE3_IMPLEMENTATION_PLAN.md` 只定义 Phase 3 Step 6 的高层恢复
目标，没有展开 Step 6.3.5 的字段、API 或 Schema。

真正明确的子步骤来源是：

`docs/PHASE3_STEP6_3_IMPLEMENTATION_PLAN.md`

其 §19 定义：

```text
### 6.3.5 Final Decisions + Cancel + Multi-Write Barrier

- confirmed_succeeded / confirmed_not_executed。
- PlanStep completed/failed。
- Task terminal invariants。
- cancel intent。
- multi-write barrier。
```

§20 测试矩阵进一步要求：

- Unknown Write Terminal。
- Legacy Review。
- v1 final decision 只能通过 Lease-owned UoW。
- concurrent decision 只能一个成功。
- duplicate requestKey 不重复 Event / Checkpoint。
- earlier unknown barrier 阻止 later write。
- active review 阻止 Task cancelled。
- all trusted final + cancel intent -> cancelled。
- 不自动 Provider/Write recovery execution。

### 6.2 后续计划的重述

`docs/PHASE3_STEP6_3_4_4_REMAINING_IMPLEMENTATION_PLAN.md` §9 将
Step 6.3.5 进一步命名为：

```text
Final RecoveryReview
```

并列出：

1. Final Decision Input。
2. expectedDecisionVersion CAS。
3. Evidence Submission + Verification 完整性。
4. Original Unknown Write 审计与最终状态处理。
5. confirmed_succeeded / confirmed_not_executed。
6. Cancel Intent 交互。
7. Decision Replay / Idempotency。
8. RecoveryReview Event。
9. Task / Plan 收敛。
10. 人工与自动决策边界。

该计划同时明确：

- Step 6.3.5 独立于 Step 6.3.4.4。
- 必须等 Stage 3-6 完成后再设计。
- 只有独立授权后才能设计 Task / Plan 最终收敛。

### 6.3 范围差异

早期 6.3 计划把 Cancel 和 Multi-Write Barrier 明确放进 6.3.5。

后续计划已经：

- 在 Stage 3.3 实现 Task-wide Cancel / Pause Intent。
- 将 6.3.5 更集中地描述为 Final RecoveryReview 与最终收敛。

两份文档并未完全冲突，但“Cancel 和 Multi-Write Barrier 是否仍属于
6.3.5 新实现范围”没有形成单一权威结论。

### 6.4 设计完整度结论

**原计划没有提供可直接实施 Step 6.3.5 的完整设计。**

已明确：

- 业务目标和边界。
- Candidate statuses。
- Lease-owned / version-CAS / idempotency 原则。
- 高层测试矩阵。

尚未明确：

- Final Decision UoW 的精确输入和输出。
- confirm operation payload digest 的字段定义。
- Evidence / Verification 的精确充分性规则。
- Original Unknown Write 最终状态写在哪里、如何审计。
- Task / Plan 收敛的状态矩阵与优先级。
- Multi-Write Barrier 的数据选择与 barrier 释放规则。
- Manual / Automatic decision 的授权主体。
- 是否需要 Migration v10。

因此当前只能进入设计评审，不能进入实现。

## 7. 与现有架构的依赖关系

| 现有能力 | 与 Step 6.3.5 的关系 | 处理原则 |
|---|---|---|
| `TaskLeaseManager` | final decision 必须 lease-owned | 直接复用，不重写 Claim |
| Fencing Takeover Guard | Worker / stale owner 前置 | 直接复用 |
| State Transition UoW | 状态不变量参照 | 可复用模式；不可混用 Attempt Recovery |
| Full Recovery UoW | 产生 Prepared / dispatching 证据链 | final decision 只消费结果 |
| Recovery Lineage V1 | 历史 Evidence / Recovery 身份 | 不修改已封存 Schema |
| Recovery Preflight Capability | 证明历史 Retry Safety | 不得转换为 Final Decision 权限 |
| Stage 3.2 Dispatch Gate | 保持原行为 | 不修改 |
| Stage 3.3 Pause / Resume / Cancel | Intent 优先级来源 | 不修改封存行为 |
| EventRepository / CheckpointStore | final decision 审计 | 复用 |
| SQLite Immediate Transaction | final status + Event 原子性 | 复用 |
| `recovery_review_operations` | 可作为 final operation idempotency 基础 | 当前 UoW 只实现部分 operation |
| `RecoveryReviewDecisionService` | 当前 lease-owned evidence operations | 需扩展 final confirm；尚未设计 |

需要新增或扩展：

- Lease-owned Final RecoveryReview Decision UoW。
- Final decision input 与 request key。
- final confirm operation 的 Exact Replay。
- Original Unknown Write 的最终审计表达。
- Task / Plan terminal convergence。
- Multi-Write Barrier 策略。
- 人工与自动 decision 的授权门。

不得修改：

- Step 1 Lineage Schema。
- Step 2 普通 transition / Replay Policy。
- Stage 3.2 Dispatch Gate。
- Stage 3.3 已封存 Cancel / Pause / Resume 行为。

## 8. 尚未解决的架构问题

### 8.1 12 项调查结论

| 项目 | 是否属于 6.3.5 原计划 | 当前结论 |
|---|---|---|
| 1. Durable Recovery Job / Command Store | 否，原 6.3.5 未明确要求 | 后续 Worker 编排前置；Schema 未设计 |
| 2. stable recoveryOperationId | 否 | Stage 3.4 已识别 Host prerequisite；无持久化 Job context |
| 3. Recovery Scanner | 否 | Generic Scanner 已存在；Evidence-specific 自动扫描未实现 |
| 4. Recovery Classifier | 否 | Generic Classifier 已存在；Request-scoped Evidence Classifier 未确认 |
| 5. Recovery Worker 生命周期 | 否 | 设计空缺 |
| 6. Worker Claim / Lease / Fencing | 属于前置能力 | Stage 3.4 已实现可复用能力 |
| 7. External Read 执行与持久化 | 否，属于 Stage 4 | 未实现端到端执行 |
| 8. External Read 超时 / 取消 / unknown | 否，属于 Stage 4/5 边界 | final decision 必须消费，但实现未封存 |
| 9. Transaction B | 否，属于 Stage 4 | UoW 源码存在；无 External Read executor 闭环 |
| 10. Verifier | 否，属于 Stage 5 | Runtime / Service 源码存在；端到端未纳入 Stage 3.4 |
| 11. Evidence / Payload / Manifest binding | 否，主要是 Stage 4/5 | 部分组件存在；不可据此认定 6.3.5 前置全部验收 |
| 12. 崩溃恢复与并发 Worker | 部分相关，但未在 6.3.5 明确 | Lease/Fencing 可复用；Durable orchestration 未设计 |

### 8.2 明确不是 Step 6.3.5 的内容

以下不能默认塞入 Step 6.3.5：

- Durable Job 表设计。
- Recovery Worker service 生命周期。
- External Read executor。
- Transaction B 新协议。
- Verifier Runtime 新协议。
- Payload Store 后端更换。

这些要么属于更早的 Stage 4/5 前置，要么属于新的后续阶段。

### 8.3 明确属于 Step 6.3.5 的核心

- Original Unknown Write 最终决定。
- confirmed_succeeded / confirmed_not_executed。
- Review decision version CAS / idempotency。
- Task / Plan terminal convergence。
- Cancel intent 与 final decision 交互。
- Multi-write barrier。

## 9. 风险分析

### 9.1 Durable Job 与 Task Lease

二者职责不同：

- Task Lease：短周期“谁现在可以写 SQLite”。
- Durable Job：长期“哪个 Recovery Operation 仍需要推进”。

Job 不能替代 Lease；Worker 即使持有 Job，也必须重新 Claim Lease / Fencing。

### 9.2 Recovery Operation 是否需要独立状态机

当前文档没有批准结论。

建议架构评审决定是否定义独立状态：

```text
queued
running
waiting_retry
manual_review
completed
failed
cancelled
```

在未批准前，不得把上述状态写入 Schema。

### 9.3 Job 与现有实体关系

至少需要回答 Job 绑定：

- Task
- RecoveryReview
- Request
- Attempt
- Event / Operation identity

可能是一对多 Job，而不是单一 Request 外键。当前无批准模型。

### 9.4 Recovery Worker 重复调度

需要同时具备：

- Durable Job claim / lease
- Task Lease / fencing
- operation identity
- Exact Replay

仅使用 SQLite Task Lease 可以防止并发 SQLite 写，但不能证明跨重启 Job 只执行
一次。

### 9.5 跨进程 Claim / Fencing

SQLite Lease / Fencing 是跨进程持久化依据。

新 Owner 接管不等于：

- 旧进程已退出。
- 旧 External Read 已终止。
- 旧外部副作用未发生。

### 9.6 External Read 无法 exactly-once

必须保留三态：

- 明确成功。
- 明确未执行。
- 不确定。

不能把 timeout、断连或进程退出直接推断为未执行。

### 9.7 External Read 成功但 Transaction B 未提交

可能出现：

- 外部结果已产生。
- Payload 已写入临时 / content-addressed store。
- EvidenceRead / ToolRun Result 未提交。

恢复时不能仅凭 Payload 文件存在认定 Transaction B 成功；必须依据持久化
Lineage / Request / Attempt / Provenance 决定只读重放或人工核对。

### 9.8 Verifier 依据什么 Evidence

架构评审未明确。

已确定的约束：

- 不得使用当前最新 Verifier Binding 替代历史 Binding。
- Verification `not_run` 不等于 passed。
- failed / inconclusive 不得自动推断失败或成功。
- Verifier retry 必须满足 Host governance contract。

具体 Evidence 选择规则仍是设计空缺。

### 9.9 Cancel / Pause / Recovery

现有优先级：

```text
Cancel > Pause > Normal Operation
```

Step 6.3.5 必须复用，不得通过 final decision 绕过。

### 9.10 Host Control Authorization

当前已有 Host Control Authorization 用于 Pause / Cancel。

是否用于 Final Decision 尚未定义。

需要评审：

- Human reviewer identity 来源。
- Automatic verifier identity。
- decision actor capability。
- 防止模型 / 普通 HTTP 调用伪造 final decision。

### 9.11 SQLite 事务边界

必须保持：

- External I/O 在 SQLite transaction 外。
- Final status / Review / Operation / Event / Checkpoint 在单个 immediate
  transaction。
- 同一事务只使用一个 `StorageWritePermit`。
- Exact Replay 不重复写 audit。

### 9.12 Multi-Write Barrier

当前 `TaskSnapshot` / terminal guard 已有 Unknown Write 阻止 Task terminal 的
基础逻辑。

但原计划还要求：

- 按 PlanStep / Plan version 找到最早未解决 Write。
- 前序 Unknown Write 未解决时阻止后续 Write 推动执行。

现有源码没有证明该完整 barrier 已由专用策略实现。需要独立设计。

### 9.13 README 与文档状态

`README.md` 当前仍描述：

- Phase 2 complete。
- Persistence 尚未实现。

这与当前 Phase 3 源码和结项状态不一致。

本轮只允许新增指定架构文档，因此未修改 README。该文档债务应单独修复。

## 10. 下一阶段建议实施顺序

以下顺序是建议，不是当前已批准开发计划。

### Layer 0：Step 6.3.5 设计审查与 Schema 决策

必须先确定：

- 权威 Step 6.3.5 范围。
- Final Decision UoW 契约。
- Task / Plan 收敛矩阵。
- Multi-Write Barrier 算法。
- 是否复用 `recovery_review_operations`。
- 是否需要 Migration v10。

### Layer 1：Durable Recovery Job / Command Store

建议单独设计：

- Job identity。
- Job state machine。
- Job claim / lease / heartbeat。
- operation context。
- retry / replay。

此层可能需要新 Migration。

### Layer 2：Recovery Scanner / Classifier

需要先明确：

- 扫描粒度是 Task 还是 Recovery Operation。
- 如何从 Snapshot 选择 pending Job。
- 如何区分普通 Read Recovery 与 recovery_evidence Recovery。

Generic Scanner / Classifier 已存在，但不能假定可直接复用。

### Layer 3：Recovery Worker / Ownership

严格依赖 Layer 1 和 TaskLeaseManager。

Worker 必须：

- Claim durable job。
- Claim Task Lease。
- 校验 fencing / Authority。
- 支持 heartbeat / stale owner rejection。
- 不依赖进程内 Map 保证唯一性。

### Layer 4：External Read / Transaction B

严格依赖 Stage 3.2 Dispatch Gate。

必须设计：

- 启动门。
- timeout / abort / unknown outcome。
- Payload Store。
- Transaction B。
- late result rejection。

这一层不应与 Step 6.3.5 Final Decision 混在一起实现。

### Layer 5：Verifier / Evidence Settlement

严格依赖可信 EvidenceRead / Payload Provenance。

需要明确：

- historical Binding。
- retry governance。
- passed / failed / inconclusive / not_run。
- verification retry / replay。

### Layer 6：Final RecoveryReview / Task / Plan Convergence

本层才对应 Step 6.3.5 的主要业务目标：

- final decision input。
- decision version CAS。
- confirmed statuses。
- cancel interaction。
- multi-write barrier。
- Task / Plan terminal outcome。
- Exact Replay / idempotency。

必须建立在 Layer 4 / 5 的可靠 Evidence 结果上。

### Layer 7：Crash Recovery / Fault Injection / Regression

需要覆盖：

- Worker crash。
- Job stale takeover。
- External Read unknown。
- Transaction B crash。
- Verifier crash。
- final decision replay。
- multi-write ordering。

## 11. 需要架构评审确定的问题

1. Step 6.3.5 的权威范围是否仍包含 Cancel 和 Multi-Write Barrier？
2. Durable Recovery Job 是否是 Step 6.3.5 前置，而不是其内部实现？
3. Job 是否需要独立状态机？
4. Job 与 Task / Review / Request / Attempt 的关系是什么？
5. recoveryOperationId 的 generation 与持久化归属是什么？
6. Final Decision 的 input / digest / request key 字段是什么？
7. Evidence / Verification 的充分性规则是什么？
8. failed / inconclusive / not_run 如何影响 final eligibility？
9. Original Unknown Write 的最终审计如何表达？
10. confirmed_not_executed 是否一定要求 PlanStep failed？
11. Task / Plan 收敛的合法状态矩阵是什么？
12. Cancel intent 在 final decision 前后如何影响 terminal state？
13. Multi-Write Barrier 的选择和释放规则是什么？
14. Manual / automatic final decision 的 Host Authorization 如何定义？
15. 是否需要 Migration v10；如果需要，最小表 / 索引是什么？
16. External Read / Transaction B / Verifier 是否必须先完成独立架构评审？

## 12. 本次审查结论

### Stage 3.4

Stage 3.4 可以正式结项：

- Step 1–8 已按当前治理指令封存。
- Recovery Lineage、Lease/Fencing、Interruption、Full Recovery、
  New Attempt、Pause Resume、Dispatch Integration、Concurrency、
  Fault Injection 均有实现或历史测试证据。

### Step 6.3.5

Step 6.3.5 **不能直接进入开发**：

- 有明确的高层目标和测试方向。
- 缺少可实施的 Final Decision UoW、Schema、状态矩阵和 Multi-Write Barrier 设计。
- 早期 6.3 计划与后续 Stage 3.4.4 计划对 Cancel / Barrier 的范围表述未完全统一。
- Durable Job、External Read、Transaction B、Verifier 的归属和前后依赖尚未形成
  单一批准方案。

### 当前建议

先进行 Step 6.3.5 独立设计评审，不写生产代码。

评审输出至少应包含：

- Final RecoveryReview 契约。
- Task / Plan final state matrix。
- Multi-Write Barrier 算法。
- Durable Job / External Read / Verifier 的前置边界。
- Schema / Migration 决策。

## 13. 已阅读文档与源码

主要文档：

- `README.md`
- `docs/PROJECT_SPEC.md`
- `AGENTS.md`
- `docs/PHASE3_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_4_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_4_4_REMAINING_IMPLEMENTATION_PLAN.md`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_IMPLEMENTATION_PLAN.md`
- Stage 3.4 Step 1–8 Development Reports
- Step 6 Supplementary Audit / Remediation Reports

主要源码：

- `src/storage/recovery-evidence-recovery-lineage.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
- `src/storage/recovery-evidence-interruption-unit-of-work.ts`
- `src/storage/recovery-evidence-fencing-takeover-guard.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/task-invariants.ts`
- `src/storage/execution-state-machine.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/recovery-review-repository.ts`
- `src/storage/recovery-review-operation-repository.ts`
- `src/recovery/recovery-review-decision-service.ts`
- `src/recovery/recovery-scanner.ts`
- `src/recovery/recovery-classifier.ts`
- `src/recovery/recovery-manager.ts`
- `src/recovery/recovery-evidence-readback-service.ts`
- `src/recovery/recovery-verifier-runtime.ts`
- `src/recovery/recovery-evidence-verification-service.ts`

## 14. Git 工作树状态

审查开始时工作树已有大量 Stage 1–3.4 未提交文件。

本次只新增：

- `docs/PHASE3_STAGE3_4_CLOSEOUT_AND_STEP6_3_5_ARCHITECTURE_DISCOVERY.md`

未修改生产代码、测试、Migration、Schema、依赖，也未创建 Git Commit。
