# Phase 3 Step 6.3.2 Development Report

> 状态：Lease-owned Decision Core + Idempotency，Step 6.3.2.1
> Operation Boundary Hardening 完成
>
> 范围：受控 Review Operation 入口、Migration v5/v6、request key、decision
> version CAS、Lease/Heartbeat/ExecutionAuthority、持久化幂等和边界加固
>
> 边界：没有实现 Evidence Submission、Read-back、最终 Review Decision、
> Write Recovery、Provider 调用或 Step 6.3.3

## 1. 新增与修改文件

Migration 与 Storage：

- `src/storage/migrations/005-phase3-step6-3-2.ts`
- `src/storage/migrations/006-phase3-step6-3-2-1.ts`
- `src/storage/migrations/index.ts`
- `src/storage/types.ts`
- `src/storage/recovery-review-operation-keys.ts`
- `src/storage/recovery-review-operation-capability.ts`
- `src/storage/recovery-review-operation-repository.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/index.ts`

Recovery 与 Lease：

- `src/recovery/recovery-review-decision-service.ts`
- `src/recovery/recovery-manager.ts`
- `src/recovery/index.ts`
- `src/persistence/lease-heartbeat.ts`

测试：

- `tests/recovery/recovery-review-decision.test.ts`
- `tests/recovery/review-operation-fixture.ts`
- `tests/recovery/review-operation-worker.ts`
- `tests/storage/step6-3-2-schema.test.ts`
- `tests/storage/schema.test.ts`
- `tests/storage/step6-3-1-schema.test.ts`
- `tests/storage/step6-3-1-repositories.test.ts`

文档：

- `docs/PHASE3_STEP6_3_2_DEVELOPMENT_REPORT.md`
- `docs/PHASE3_STEP6_3_2_1_SUPPLEMENTARY_REVIEW.md`

本步骤没有新增依赖，没有修改 v1-v4 Migration，没有调用 Provider、执行
Read-back 或修改任何 Task/PlanStep/ToolRun 业务状态。

## 2. Migration v5

### 2.1 必要性

Step 6.3.1 的 Operation 表有两个缺口：

- `status` 只是非空文本，没有有限值约束。
- request key 包含 actorId 和 operation payload digest，但表未持久化这两个
  校验输入，无法在重启后判断同一 request key 是否对应同一内容。

同时，本步骤不能开放任何最终 Review 决策，因此需要一个只递增
`decision_version`、不改变业务状态的中性 Operation，用于验证 Lease-owned
CAS 与幂等基础设施。

Migration v5 不修改已应用的 v4，而是重建：

```text
recovery_review_operations
```

### 2.2 新增字段和约束

新增：

- `actor_id`
- `operation_payload_digest`

有限状态：

```text
applied
accepted
```

- `applied`：对应业务/核心操作及审计记录已经原子提交。
- `accepted`：预留给未来 Read-back Intent 已持久化的操作。本步骤不产生该
  状态。

Operation 新增内部中性值：

```text
advance_decision_version
```

该 Operation：

- 只能由 Lease-owned DecisionService 产生。
- 只递增 Review 的 `decision_version`。
- 不改变 Review status。
- 不改变 PlanStep、ToolRun、Task status。
- 不生成 Tool Message。
- 不执行外部操作。

Migration 保留 v4 Operation 历史行。新字段对历史行保持 NULL，不伪造
actorId 或 payload digest。原有唯一约束、复合外键、request_readback Trigger
和 append-only Trigger 在重建后恢复。

### 2.3 Migration v6：Operation / Status 映射

Migration v5 只限制 status 属于 `applied | accepted`，没有限制 Operation
与 Status 的组合。Step 6.3.2.1 新增 Migration v6 Trigger：

```text
advance_decision_version -> applied
submit_evidence          -> applied
mark_unresolved          -> applied
confirm_succeeded        -> applied
confirm_not_executed     -> applied
legacy_attest             -> applied
request_readback          -> accepted
```

v6 不修改 v4/v5，不重写历史 Operation 行，只约束后续 INSERT。
Repository 层也执行同一映射校验。

### 2.4 历史数据安全

Migration v5 重建流程会：

- 逐行复制旧 request key、operation、expected/resulting version、status 和
  Event 关联。
- 新 actorId/payload digest 对旧行保持 NULL。
- 重新创建索引、复合外键、readback Trigger 和 append-only Trigger。
- 遇到不属于 `applied | accepted` 的旧 status 时由 CHECK 中止，整个
  Migration transaction 回滚。

测试验证非法历史 status 不会被删除、改写或静默跳过。

## 3. 唯一受控写入入口

调用链：

```text
RecoveryManager[RECOVERY_REVIEW_INTERNAL_TEST_OPERATION]()
  -> RecoveryReviewDecisionService.commitOwned()
  -> ExecutionUnitOfWork.commitOwnedRecoveryReviewOperation()
```

`advance_decision_version` 只是 Step 6.3.2 的内部测试/CAS 基础设施，不是
面向应用层的正式 Review 业务操作。它不再以普通命名方法公开：

- RecoveryManager 的生产 prototype 不暴露
  `commitRecoveryReviewOperation()`。
- 中性操作通过模块内部 Symbol 方法进入。
- Symbol 不从 `src/recovery/index.ts` 导出。
- RecoveryReviewDecisionService 不从 public recovery index 导出。
- 后续 Step 6.3.3 应新增 operation-specific 的正式公开入口，而不是开放
  任意 version bump。

### 3.1 RecoveryManager

负责：

1. 校验输入。
2. Claim Task Lease。
3. 启动共享 LeaseHeartbeat。
4. 立即执行一次 Heartbeat ownership validation。
5. 加载最终一致性 TaskSnapshot。
6. 校验 Review 与 ToolRun binding。
7. 调用 DecisionService。
8. 检查 Heartbeat failure。
9. 停止 Heartbeat。
10. 使用原 leaseToken/fencingToken 释放 Lease。

Heartbeat 或业务失败时仍执行清理。Release 失败与原始失败同时出现时返回
`AggregateError`；只有 Release 失败时返回
`RECOVERY_REVIEW_LEASE_RELEASE_FAILED`。

### 3.2 RecoveryReviewDecisionService

负责：

1. 使用 Zod 校验主机侧输入。
2. 对 operation payload 执行 JCS Canonical JSON + SHA-256。
3. 重新计算 request key。
4. 拒绝客户端 request key 与内容不匹配。
5. 创建一次性 capability。
6. 调用受控 UoW。

`actorId` 与 operation payload 由可信宿主上下文提供，不从模型输出或普通事件
payload 推断。本步骤仍不包含身份认证系统。

### 3.3 Capability Boundary

UoW 的事务要求一个模块私有 WeakSet capability。该 capability 只由
DecisionService 创建，并绑定到当前调用。

- 直接调用 UoW 不能提供有效 capability。
- `RecoveryReviewOperationRepository` 不再从 `src/storage/index.ts` 导出。
- `RecoveryReviewDecisionService` 不从 `src/recovery/index.ts` 导出。
- 中性测试操作只通过未公开的 Symbol-keyed RecoveryManager 方法进入。

## 4. Request Key 与幂等

### 4.1 Operation Payload Digest

```text
operationPayloadDigest =
  JCS(operationPayload) + SHA-256
```

### 4.2 Request Key

```text
sha256(JCS([
  "forgeflow.recovery-review-operation.v1",
  reviewId,
  expectedDecisionVersion,
  operation,
  operationPayloadDigest,
  actorId
]))
```

客户端提交 request key，但 DecisionService 和 UoW 都会按实际内容重新计算并
比较。不能只依赖客户端值。

### 4.3 重放

UoW 在确认当前 Lease、owner、fencing token 和本地 authority 后，先校验
request identity 并查询持久化 request key：

- 相同 key 且 actorId、payload digest、operation、expected/resulting version、
  task/review binding 全部一致：返回已有 Operation，`replayed=true`。
- 相同 key 但任一内容不一致：拒绝。

Replay lookup 早于 Task Version CAS。已提交请求即使之后 Task Version 因合法
Event/状态变化增长，也不会因为传入旧 Task Version 而被拒绝。

Replay 仍需当前有效 Lease 和本地 authority。旧 Lease/fencing token 的
stale Worker 不能通过 replay 绕过 ownership 校验。

重放路径不执行：

- Review UPDATE。
- Event INSERT。
- Operation INSERT。
- Checkpoint INSERT。

因此重启后仍可识别请求，且不会重复产生审计记录。

## 5. decision_version CAS

中性 Operation 的事务内执行：

```text
expectedDecisionVersion
  === current decision_version
```

成功后：

```text
resultingDecisionVersion = expectedDecisionVersion + 1
```

SQL 更新同时匹配：

- review id。
- task id。
- protocol version >= 1。
- status 为 pending/unresolved。
- decision_version 等于 expected。

两个请求使用不同 request key 和相同 expected version 时，只有一个可以
提交。双连接 Worker 测试验证一个成功、另一个得到 Task 或 Review version
conflict，且数据库中没有部分写入。

## 6. Lease / Heartbeat / ExecutionAuthority

提交前有两层执行权检查：

1. 本地 `ExecutionAuthority.assertActive()`。
2. UoW 内部 `TaskLeaseManager.assertOwned()`，包括：
   - leaseToken。
   - fencingToken。
   - Lease expiry。
   - Task ownership。

本地 authority 在 Heartbeat 失败时先 revoked，再 abort。即使数据库 Lease
仍有效，本地 revoked 的调用也不会进入 Operation INSERT。

DecisionService 和 UoW 调用之间没有 await。UoW 在同一同步 SQLite
`BEGIN IMMEDIATE` transaction 内再次检查本地 authority 和数据库 ownership。

## 7. Operation 事务边界

中性 Operation 的事务内顺序：

```text
local authority guard
  -> StorageWritePermit
  -> Task lease / fencing validation
  -> request key validation
  -> persisted request replay check
      -> exact match: return without writes
      -> mismatch: reject
      -> not found: continue
  -> Task version validation
  -> Review protocol / status / binding validation
  -> Review decision_version CAS
  -> Event
  -> Operation row
  -> Checkpoint
  -> commit
```

任一失败整体 rollback。

Operation 已提交后不可 UPDATE/DELETE。Review status、PlanStep、ToolRun 和
Task status 在本步骤中保持不变。

## 8. 旧 API 边界

`ExecutionUnitOfWork.decideRecoveryReview()` 继续保留：

- 只允许 protocol v0 Review。
- 遇到 protocol v1 时失败。
- v0 测试调用保持兼容。

Protocol v1 的受控入口只接受本步骤中性
`advance_decision_version` Operation。以下 Operation 仍被拒绝：

- `submit_evidence`
- `request_readback`
- `mark_unresolved`
- `confirm_succeeded`
- `confirm_not_executed`
- `legacy_attest`

## 9. 测试结果

新增测试：

- Step 6.3.2 Recovery Review decision core / v5 schema：13 项。
- Step 6.3.2.1 补充测试：3 项。

总计新增 16 项。

覆盖：

- 中性 Operation 成功提交。
- Review status / PlanStep / ToolRun / Task 不变。
- 同 request key / 同 payload 重放。
- 同 key / 不同 payload 拒绝。
- 不同 key / 同 expected version CAS 冲突。
- 数据库重启后的幂等识别。
- 已成功请求在 Task Version 合法增长后使用旧 Task Version 重放。
- 旧 Lease 被替换后 replay 拒绝，新执行者仍可识别原 Operation。
- 两个独立连接竞争，仅一个成功。
- 无 Lease、过期 Lease、旧 fencing token 拒绝。
- 本地 authority revoked 即使 DB Lease 有效也拒绝。
- Heartbeat 失败不提交 Operation。
- 旧 Worker 不能 Release 新 Lease。
- Release 失败显式报告。
- Event 写入失败回滚 Review CAS。
- Checkpoint 写入失败回滚 Operation 和 Event。
- v4 Operation 历史行升级。
- v5 Migration 失败整体回滚。
- 不合法历史 Operation status 使 Migration 回滚。
- Operation/Status 的 v6 映射 Trigger。
- Operation status/中性 Operation CHECK。
- Operation append-only。
- 旧 v0 API 兼容及 v1 拒绝。
- Storage public index 不暴露 Operation Repository。
- UoW capability 直接绕过拒绝。

改动前基线：

- 35 个测试文件。
- 279 项测试通过。

改动后：

- `pnpm test`：37 个测试文件、295 项测试全部通过。
- `pnpm typecheck`：通过。
- `git diff --check`：退出码 0，无 whitespace error；存在既有 LF/CRLF
  提示。

## 10. 尚未完成与阶段边界

本步骤没有实现：

- Evidence Submission。
- unresolved 业务决策。
- confirmed_succeeded / confirmed_not_executed。
- Recovery Evidence Plan 或 Read ToolRun 创建。
- EvidenceVerifier。
- Read-back 执行或 Crash Recovery。
- Write Recovery。
- 自动 Resume。
- Provider 调用。
- RecoveryManager 的最终 Review 决策编排。
- Step 6.3.3。

`accepted` Operation 状态已预留，但当前没有生产者。最终 Review 状态、PlanStep
和 Task 状态转换仍属于 Step 6.3.3 与 Step 6.3.5。

本次仅完成 Phase 3 Step 6.3.2 与 Step 6.3.2.1 补充加固。没有提交最终
Review 决策、Evidence 或外部操作，也没有开始 Step 6.3.3。
