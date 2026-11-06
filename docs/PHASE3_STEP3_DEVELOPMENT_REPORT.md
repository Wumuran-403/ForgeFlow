# Phase 3 Step 3 Development Report

> 状态：Plan / Tool Run / Approval Repository + UoW 完成
>
> 范围：五张执行数据表、五个 Repository、ExecutionUnitOfWork 原子事务、
> 工具版本与 Hash、扩展 TaskSnapshot、StorageWritePermit 生命周期修正

## 1. 修改与新增文件

数据库与存储：

- `src/storage/migrations/002-phase3-step3.ts`
- `src/storage/migrations/index.ts`
- `src/storage/types.ts`
- `src/storage/execution-plan-repository.ts`
- `src/storage/plan-step-repository.ts`
- `src/storage/tool-run-repository.ts`
- `src/storage/approval-repository.ts`
- `src/storage/recovery-review-repository.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/index.ts`
- `src/storage/transaction.ts`
- `src/storage/write-boundary.ts`

工具契约：

- `src/shared/canonical-json.ts`
- `src/tools/fingerprint.ts`
- `src/tools/types.ts`
- `src/tools/registry.ts`

测试：

- `tests/storage/execution-persistence.test.ts`
- `tests/storage/step3-schema.test.ts`
- `tests/storage/schema.test.ts`
- `tests/storage/repositories.test.ts`
- `tests/storage/transaction.test.ts`
- `tests/tools/fingerprint.test.ts`
- `tests/tools/registry.test.ts`

文档：

- `docs/PHASE3_STEP3_DEVELOPMENT_REPORT.md`

没有修改 AgentRunner、TaskScheduler 或任何 Phase 1 / Phase 2 执行逻辑。

## 2. Migration 结构

新增 Migration：

```text
version: 2
name: phase3_step3_plan_tool_approval
```

创建：

- `execution_plans`
- `plan_steps`
- `tool_runs`
- `approvals`
- `recovery_reviews`

没有创建：

- `task_leases`
- Lease / Fencing 字段
- AgentRunner / Scheduler 持久化表

### 跨 Task 外键

同 Task 关系由复合唯一键和复合外键共同保证：

```text
execution_plans(task_id, id)
plan_steps(task_id, plan_id) -> execution_plans(task_id, id)
plan_steps(task_id, id)
tool_runs(task_id, plan_step_id) -> plan_steps(task_id, id)
tool_runs(task_id, id)
approvals(task_id, tool_run_id) -> tool_runs(task_id, id)
recovery_reviews(task_id, tool_run_id) -> tool_runs(task_id, id)
model_calls(task_id, id)
execution_plans(task_id, source_model_call_id) -> model_calls(task_id, id)
```

因此跨 Task 的 Plan、PlanStep、ToolRun、Approval、RecoveryReview 以及
source Model Call 关联都会被 SQLite 拒绝，不只检查 ID 是否存在。

### 其他数据库约束

- 所有核心字段 NOT NULL。
- Plan、PlanStep、ToolRun、Approval、RecoveryReview 状态全部有 CHECK。
- ToolRun mode 有 CHECK，且 Trigger 要求 mode 与 PlanStep kind 一致。
- Approval 通过 Trigger 校验 task、tool run、tool version 和 input hash 绑定。
- RecoveryReview 只能指向同 Task 的 `unknown` Write ToolRun。
- Approval `tool_run_id` 全表唯一。
- RecoveryReview `(task_id, tool_run_id)` 唯一。
- active RecoveryReview 另有 `pending/unresolved` 部分唯一索引。
- PlanStep 更新为 `completed` 时，Trigger 检查 queued、awaiting_approval、
  running、interrupted 以及未确认成功的 unknown ToolRun。
- `unknown + confirmed_not_executed` 无法满足 completed；UoW 会将 PlanStep
  转为 failed。
- `unknown + confirmed_succeeded` 允许 PlanStep completed，但原始 ToolRun
  保持 unknown，不伪造 output 或 succeeded 状态。

## 3. Repository 结构

### ExecutionPlanRepository

- insert
- get
- listByTask

### PlanStepRepository

- insert
- updateStatus
- get
- listByTask

### ToolRunRepository

- createIntent
- transition
- get
- listByTask

对象状态更新使用当前状态 CAS，并递增 `version`。

### ApprovalRepository

- createPending
- decide
- get
- getByToolRun
- listByTask

### RecoveryReviewRepository

- createPending
- decide
- get
- getByToolRun
- listByTask

所有写方法继续要求 `StorageWritePermit`。跨表状态变化由
`ExecutionUnitOfWork` 统一编排。

## 4. ExecutionUnitOfWork 事务边界

新增原子事务：

### completeModelCallWithPlan

```text
model_call completed
+ assistant message
+ token usage
+ execution plan
+ all plan steps
+ all tool run intents + idempotency keys
+ llm.responded / plan.created / tool.queued events
+ checkpoint
```

### beginToolRun

```text
tool run queued -> running / awaiting_approval
+ plan step state
+ task state
+ event
+ checkpoint
```

### requestApproval

```text
tool run -> awaiting_approval
+ plan step -> awaiting_approval
+ task -> waiting_approval
+ single pending Approval
+ event
+ checkpoint
```

### decideApproval

```text
Approval pending -> approved / rejected / expired / cancelled
+ ToolRun queued / skipped / cancelled
+ PlanStep queued / skipped / cancelled
+ Task waiting_approval / cancel_requested
+ event
+ checkpoint
```

审批记录的 tool version 和 canonical input hash 必须与 ToolRun 一致。

Step 3 没有 Lease/Fencing，因此非取消类审批决定不会直接把 Task 置为
`running`。批准后 ToolRun 和 PlanStep 进入排队状态，但 Task 保持
`waiting_approval`，表示决策已持久化、执行所有权尚未建立。真正恢复执行必须
由后续 Step 4/5 在有效 Lease 下完成。

### completeToolRun

```text
ToolRun running -> terminal status
+ Tool Message by tool_call_id
+ PlanStep status
+ Task status
+ event
+ checkpoint
```

已启动的 Write 只允许 `succeeded` 或 `unknown`。普通失败、超时和取消不会被
错误标记为 Write 的普通 failed/cancelled。

### requestRecoveryReview / decideRecoveryReview

```text
unknown Write -> pending RecoveryReview
+ PlanStep/Task waiting_review
+ event
+ checkpoint

review decision
+ PlanStep completed / failed / waiting_review
+ Task waiting_review
+ event
+ checkpoint
```

RecoveryReview 始终更新原记录，不创建第二条并行活动记录。

Step 3 不实现 Lease/Fencing，也不实现 RecoveryManager。因此三种 Review 结论
都只决定 PlanStep 的安全状态，不执行 Task `waiting_review -> running`：

- `confirmed_succeeded`：PlanStep 可 completed，Task 保持 waiting_review。
- `confirmed_not_executed`：PlanStep 转 failed，Task 保持 waiting_review。
- `unresolved`：PlanStep 和 Task 都保持 waiting_review。

即使 Task 存在 cancel intent，Review 决策也只保留在 waiting_review，不会借普通
Review 接口恢复运行。后续 Step 6 必须由 RecoveryManager 在有效 Lease/Fencing
和完整 ExecutionStateMachine 校验下决定是否恢复。

## 5. Tool Version、Schema Hash、Input Hash

`ToolDefinition` 新增可选 `version`。Registry 对未提供版本的现有工具默认使用：

```text
"1"
```

`RegisteredToolMetadata.version` 始终存在，并随 ToolRun 持久化。

### input_schema_hash

使用与 AgentRunner 模型工具定义一致的 Zod 4 配置：

```text
z.toJSONSchema(inputSchema, {
  target: "draft-07",
  io: "input",
  unrepresentable: "throw"
})
```

Zod 生成的 JSON Schema 会先转为纯 JSON 数据，移除仅供内部扩展的非枚举属性，
再计算 canonical SHA-256。

### canonical_input_hash

实现面向本项目输入约束的 RFC 8785 风格 Canonical JSON：

- Object key 按 ECMAScript/UTF-16 code unit 排序。
- Array 保持原顺序。
- 仅允许 JSON 兼容值。
- 拒绝 BigInt、undefined、Symbol、function、Date、Map、Set、循环引用、
  稀疏数组、accessor、Symbol key、NaN、Infinity 和 `-0`。
- 对 canonical UTF-8 字节计算 SHA-256。

Hash 格式统一为：

```text
sha256:<64 lowercase hex>
```

当前验证覆盖选定的 RFC 8785 数字、字符串 escaping、Unicode/UTF-16 key ordering
向量，以及 ForgeFlow 额外的 `-0` 拒绝预校验。它不是对 RFC 8785 全部边界条件
的正式一致性认证，文档和运行时都不应宣称“完整 RFC 8785 认证实现”。

### idempotency key

固定 domain：

```text
forgeflow.tool-idempotency.v1
```

payload 使用 JCS 数组：

```text
[
  taskId,
  planVersion,
  originalIndex,
  toolName,
  toolVersion,
  inputSchemaHash,
  canonicalInputHash
]
```

最终对 `domain + "\n" + JCS(payload)` 计算 SHA-256。Tool version 或输入 Hash
变化会产生不同幂等键。

## 6. Approval / RecoveryReview 约束

- 一个 ToolRun 最多一条 Approval。
- 一个 ToolRun 最多一条 RecoveryReview。
- 审批和核对历史通过 append-only Events 追加。
- pending / unresolved 都视为 active recovery。
- RecoveryReview 正式结论必须有 source type 和 decided time。
- confirmed_succeeded 必须有 evidence_ref。
- confirmed_success 不修改原始 unknown ToolRun，也不伪造 Tool Result。
- confirmed_not_executed 将 PlanStep 转为 failed。
- unresolved 保持 PlanStep waiting_review。

## 7. 扩展 TaskSnapshot

`TaskSnapshotReader.load()` 仍只开启一个 SQLite read transaction。Step 3 扩展：

- executionPlans
- planSteps
- toolRuns
- approvals
- recoveryReviews

基础数据继续包含 tasks、messages、model_calls、events、checkpoints。
本阶段 Snapshot 仍不包含 Lease/Fencing，因此不能称为 Step 4 完整恢复快照。

## 8. StorageWritePermit 生命周期

Step 2 的 Permit 已收紧：

- 每个 `BEGIN IMMEDIATE/EXCLUSIVE` 事务生成独立内部 Token。
- Permit 保存该 Token，不再只凭 `database.inTransaction === true` 通过。
- 事务结束后上下文被移除。
- 旧 Permit 在后续事务中复用会返回 `STORAGE_WRITE_PERMIT_INVALID`。
- 嵌套写事务共享当前外层 Token，并在每层退出时恢复正确上下文。

## 9. 测试矩阵

`tests/storage/execution-persistence.test.ts`（10 项，覆盖以下场景）：

- Assistant + Plan + ToolRuns 原子持久化
- Plan 写入失败整体 rollback
- 五类跨 Task 复合关联拒绝
- ToolRun mode 与 PlanStep kind 不匹配拒绝
- Approval 批准、Tool Result、Tool Message、PlanStep completed
- Tool Result 事务失败整体 rollback
- Approval 事务失败整体 rollback
- Approval version/hash 绑定及单记录唯一
- Unknown Write pending/unresolved 阻止 completed
- confirmed_succeeded 解锁 completed
- confirmed_not_executed 必须 failed
- cancel intent 存在时 Review 不恢复 Task running
- RecoveryReview 单记录唯一

`tests/storage/step3-schema.test.ts`（2 项）：

- 五张表的必填字段和复合同 Task 外键
- 状态 CHECK、单记录 UNIQUE、completed Trigger，且不存在 task_leases

`tests/storage/snapshot-concurrency.test.ts`（2 项）：

- 基础 Snapshot 双 WAL 连接一致性
- Task/ExecutionPlan 读取后由另一连接提交 PlanStep、ToolRun、Approval、
  RecoveryReview，A 不混合快照，事务结束后完整可见

`tests/tools/fingerprint.test.ts`（5 项）：

- canonical key ordering 与 array order
- 选定 RFC 8785 数字、字符串 escaping、Unicode/UTF-16 key ordering 向量
- `-0`、NaN、Infinity、BigInt、Date 拒绝
- Schema Hash 稳定性与 Schema 变化检测
- 幂等键版本绑定

`tests/tools/registry.test.ts`：

- 默认 tool version `"1"`
- 显式 tool version 保留

`tests/storage/transaction.test.ts`：

- 旧 StorageWritePermit 跨事务复用失败

`tests/storage/schema.test.ts`、`repositories.test.ts`：

- Migration 版本升级到 2
- Step 2 Repository/Snapshot 行为保持兼容
- 扩展 Snapshot 中新增集合默认为空

## 10. 实际执行结果

- `pnpm test`：25 个测试文件、186 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

原有 Phase 1 的 33 项、Phase 2 的 130 项以及 Step 1 / Step 2 测试继续包含在
全量测试中并通过。

## 11. 尚未完成

- Task Lease / Fencing Token
- ExecutionStateMachine 的完整 Task/Tool/Plan 转换校验
- Lease heartbeat、过期、恢复与旧 Worker 拒绝
- RecoveryManager
- Pause / Resume / Cancel 持久化编排
- Unknown Write 自动/人工恢复工作流
- AgentRunner / TaskScheduler 持久化集成
- 完整 Step 4 TaskSnapshot

## 12. 阶段边界声明

本次只完成 Phase 3 Step 3。没有创建 `task_leases`，没有实现 LeaseManager、
RecoveryManager、Pause/Resume/Cancel 持久化编排，没有接入 AgentRunner 或
TaskScheduler，也没有进入 Step 4。
