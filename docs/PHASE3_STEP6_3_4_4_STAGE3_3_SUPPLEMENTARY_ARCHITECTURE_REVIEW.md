# Phase 3 Step 6.3.4.4 Stage 3.3 Supplementary Architecture Review

> 状态：补充架构审查完成，等待最终评审结论
>
> 范围：Host Control Authorization、Dispatch Settlement、Failure / Intent
> 交错、ExecutionPlan.version、Pause generation
>
> 边界：未实施 Stage 3.4、External Read、Transaction B、Verifier、
> Recovery Manager 或 Step 6.3.5。

## 1. 审查结论摘要

本轮确认并修复了三个真实问题：

1. HostControlAuthorization minter 曾从公开 `src/recovery/index.ts`
   导出；WeakMap 只能防止对象伪造，不能限制合法签发权。
2. Dispatching Settlement 曾只是调用方传入的普通字符串枚举，无法证明
   External Read 的生命周期事实。
3. Failure / Timeout 曾因 Cancel / Pause 的全局 Intent gate 返回
   `cancel_required` / `pause_blocked`，可能丢失已经确定的执行失败事实。

`ExecutionPlan.version` 和 Pause generation 的现有语义经核查可保持一致，
无需 Migration。

## 2. 审查项 A：Host Control Authorization

### 2.1 原调用链

Capability 实现：

```text
src/recovery/recovery-evidence-host-control-authorization.ts
  -> object WeakMap
  -> bind taskId / operation / requestNonce / controlActor
```

审查前 `createRecoveryEvidenceHostControlAuthorization()` 从
`src/recovery/index.ts` 公开导出。任何能导入 Recovery public barrel 的
代码都可以调用该 minter。

生产 UoW 只调用：

```text
assertRecoveryEvidenceHostControlAuthorization()
```

当前生产代码没有：

- Host Control Gateway。
- HTTP / IPC 认证入口。
- Composition Root 的 authenticated actor 注入。

因此审查前：

- 普通 Recovery Service 无法从自身 private UoW 字段直接写 Intent，但能
  通过公开 Recovery API 自行签发有效 Capability。
- 普通 Agent Runtime 也能通过公开 API 自行签发。
- WeakMap 只阻止对象、clone 和 cast 伪造，不能阻止公开 minter 的合法签发。

### 2.2 修复

- Minter 更名为
  `issueRecoveryEvidenceHostControlAuthorization()`。
- Minter 从 `src/recovery/index.ts` 完全移除。
- 公开 Recovery API 不再导出 capability issuer、assert helper 或 claims
  类型。
- 生产 issue call site：0。
- 生产调用方只能持有 UoW 所需 capability，不能通过 public barrel 签发。
- 测试通过 internal module 模拟可信 Host Control adapter。

新增测试确认：

- Public Recovery API 不包含 issuer。
- 普通对象、spread clone、JSON clone 不可伪造。
- 错误 operation、requestNonce、controlActor 被拒绝。

### 2.3 尚未解决

当前仓库还没有实际认证请求入口和 Composition Root。`controlActor` 的
真实性最终必须由 Host Control Gateway 从可信认证上下文取得，不能来自
模型、HTTP body 或普通业务参数。

本轮已将签发入口移出公开 Recovery API，但尚未接入真实认证适配器。

## 3. 审查项 B：Dispatch Settlement

### 3.1 原问题

审查前 `cancelOwnedRecoveryEvidenceRead()` 接受普通字段：

```text
dispatchingSettlement = not_started | result_settled
```

该字段：

- 只是 Zod enum。
- 未绑定 Task / Request / Attempt。
- 未绑定 Dispatch Event ID。
- 未绑定 fencingToken。
- 可由 UoW 调用方直接填写。
- 无法区分成功、失败、timeout、response discarded 或 Promise 未终止。

因此不能作为可信执行事实。

### 3.2 修复

Stage 3.3 当前没有可信 Settlement 来源，因此：

- 删除 `dispatchingSettlement` schema 字段和 TypeScript Union。
- `dispatching` Attempt 的 Cancel 一律 fail closed，错误码：

```text
RECOVERY_EVIDENCE_DISPATCH_SETTLEMENT_UNAVAILABLE
```

- Prepared / blocked_by_intent / interrupted Cancel 不受影响。
- Transaction B 已完成仍返回 completed Exact Replay。
- 普通调用方伪造额外 settlement 字段会被 strict Zod schema 拒绝。

Stage 4 后续必须由可信 Executor / Dispatch 生命周期模块签发 opaque
Settlement capability，并绑定：

```text
taskId
readbackRequestId
attemptId
dispatchEventId
fencingToken
settlement kind
```

本轮未实现 External Read，因此没有伪造该 capability。

## 4. 审查项 C：Failure / Timeout 与 Intent

### 4.1 原问题

Failure UoW 审查前在发现 Cancel / Pause 时直接返回：

```text
cancel_required
pause_blocked
```

这会把控制意图与执行事实混淆：

- External Read 已经明确失败。
- Cancel / Pause 只应阻止后续新执行。
- 已发生且可确定的失败仍必须持久化，否则审计事实丢失。
- 旧 Task version 若因 Intent Event 改变，也会错误阻止 Failure 落库。

### 4.2 修复

Failure / Timeout 现在：

- 仍要求 Lease / Fencing / ExecutionAuthority 有效。
- 严格 CAS Attempt、ToolRun、PlanStep、Plan。
- 不再使用 Task.version 作为执行事实 CAS。
- Cancel / Pause 存在时仍允许把确定 Failure / Timeout 写入 terminal
  fact。
- Attempt Event 新增：

```text
controlIntentKind = cancel | pause | null
controlIntentEventId
```

- 两者同时存在时记录 Cancel，符合 Cancel > Pause 的审计优先级。
- Cancel / Pause 本身不被清除。
- Outcome uncertain 没有 Failure UoW 入口，不能伪装成 failed / timed_out。

新增测试先捕获 Failure 输入，再设置 Cancel / Pause 使 Task.version 变化，
随后调用 Failure UoW；确认执行事实落库且 Intent Event ID 被保留。

## 5. 审查项 D：ExecutionPlan.version

### 5.1 Schema 与调用方

Schema：

```text
UNIQUE (task_id, version)
```

Repository 使用：

- `insert(version)`：创建 Task-scoped Plan generation。
- `nextVersion(taskId)`：`MAX(version) + 1`。
- `listByTaskPurpose()` / `getLatestByPurpose()`：按 version 排序。

Execution engine 使用 version 作为：

- Plan generation identity。
- ToolRun idempotency key 输入。
- Event payload `plan.created.version`。
- Checkpoint `planVersion`。

`ExecutionPlanRepository.updateStatusCas()` 是唯一状态更新入口，状态转换：

```text
active -> completed | failed | cancelled
```

不再递增 `version`，只把 version 用作 expected-generation CAS。

### 5.2 结论

`ExecutionPlan.version` 在整个项目中是稳定的 Task-scoped Plan Generation
Identity，不是 row revision。

没有发现调用方依赖 Plan 状态变化后 version 递增。新增：

- 类型注释明确该语义。
- Repository 回归测试确认状态转换后 version 不变。
- 多 Request Cancel 测试确认不同 Recovery Plan generation 不冲突。

无需 Migration v10。

## 6. 审查项 E：Pause Generation

核查结果：

- Pause Set 只接受 `waiting_review` Task。
- Pause Set 受 HostControlAuthorization、Task version CAS 和 Cancel gate
  保护。
- Pause Clear 必须匹配当前 `pauseRequestedAt`、Pause Event ID 和 sequence。
- Clear 会拒绝旧 generation，不能清除新 Pause。
- 同一 requestNonce 的有效 Pause Set / Clear 返回 Exact Replay。
- Cancel 存在时 Pause Set / Clear / Resume 全部拒绝。
- Event、Task field update 和 Checkpoint 在同一 SQLite immediate
  transaction 内完成。
- Event append 或 Checkpoint 失败时字段更新整体 rollback。

未发现需要修复的 Pause generation 缺陷。

## 7. 新增与更新测试

新增 / 更新覆盖：

1. Public Recovery API 无法签发 HostControlAuthorization。
2. 普通对象、spread clone、JSON clone Capability 被拒绝。
3. 错误 operation / requestNonce / controlActor 被拒绝。
4. Dispatching Cancel 无可信 Settlement 时 fail closed。
5. 普通 Settlement enum 字段被 strict schema 拒绝。
6. Failure 前 Task.version 因 Cancel / Pause 变化仍可落库。
7. Failure Event 保留 controlIntentKind / controlIntentEventId。
8. Timeout 保持相同事实结算语义。
9. ExecutionPlan status CAS 不改变 generation version。
10. 多 Recovery Request Cancel 不产生 plan version 冲突。
11. 旧 Pause Clear 不覆盖新 Pause。
12. Pause Intent / Clear / Resume Exact Replay 不重复写。

## 8. 实际验证结果

Stage 3.3 专项：

```text
pnpm vitest run tests/storage/recovery-evidence-dispatch-uow.test.ts tests/storage/recovery-evidence-uow.test.ts tests/storage/recovery-evidence-state-matrix.test.ts
```

结果：

```text
Test Files  3 passed (3)
Tests       121 passed (121)
```

全量测试：

```text
pnpm test
```

结果：

```text
Test Files  52 passed (52)
Tests       542 passed (542)
```

Typecheck：

```text
pnpm typecheck
```

结果：通过。

Diff check：

```text
git diff --check
```

结果：通过，仅有工作区既有 LF/CRLF normalization warning。

## 9. 实际修改文件

- `src/recovery/recovery-evidence-host-control-authorization.ts`
- `src/recovery/index.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/types.ts`
- `tests/storage/recovery-evidence-dispatch-uow.test.ts`
- `tests/storage/recovery-evidence-uow.test.ts`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_3_DEVELOPMENT_REPORT.md`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_3_SUPPLEMENTARY_ARCHITECTURE_REVIEW.md`

本轮未修改 Migration、Schema、数据库定义或依赖。

## 10. 剩余限制

- Public API 已不能签发 HostControlAuthorization，但真实认证 Gateway /
  Composition Root 尚未实现；`controlActor` 必须由后续可信入口注入。
- Dispatching Cancel 在 Stage 3.3 保持 fail closed，等待 Stage 4 可信
  Settlement capability。
- Pause Observed 写失败后的 Authority revoke / Abort / Lease release 仍
  由 Executor 生命周期负责。
- Stage 3.4 Interrupted Recovery、Fencing Takeover 和 Recovery Lineage
  writer 未实现。
- 既有 Transaction B completion 仍未同步完成 Recovery Evidence Plan；
  Cancel-after-completion 只返回已存在 Check + EvidenceRead 的完成事实，
  不补写或回滚。

## 11. 封存建议

建议允许 **Stage 3.3 正式封存**，但需要保留两个明确前置条件：

1. 在暴露任何外部 Host Control endpoint 前，必须接入 authenticated
   Gateway / Composition Root，禁止普通请求传入任意 controlActor。
2. Stage 4 Dispatching Cancel 必须先建立可信 Settlement capability，
   不得恢复普通枚举输入。

Stage 3.3 当前实现可以封存，但不得据此开始 Stage 3.4 或 External Read。
