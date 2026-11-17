# Phase 3 Step 6.3.2.1 Supplementary Review

> 状态：Operation Boundary Hardening 完成
>
> 范围：Replay ordering、内部中性 Operation 边界、Migration v5 历史兼容和
> Operation/Status 映射
>
> 结论：Step 6.3.2 范围内的发现均已修复，没有进入 Step 6.3.3

## 1. 审查结论

本轮确认并修复四个问题：

1. Persisted request replay 原先晚于 Task Version CAS。
2. `advance_decision_version` 原先通过普通命名的 RecoveryManager 方法暴露。
3. Migration v5 对不合法历史 status 缺少专项回滚测试。
4. Migration v5 只约束 status 集合，没有约束 Operation 与 status 的映射。

## 2. Replay Ordering

修复后的顺序：

```text
current local ExecutionAuthority
  -> current Lease / fencing ownership
  -> request identity + canonical payload
  -> persisted requestKey lookup
      -> exact match: return original Operation, no writes
      -> mismatch: reject
      -> not found: continue
  -> Task Version CAS
  -> Review Version CAS
  -> Event / Operation / Checkpoint
```

因此：

- 已应用请求不会因之后合法 Task Version 增长而失效。
- 重放仍必须持有当前有效 Lease、fencing token 和本地 authority。
- 旧 Worker 不能通过 replay 绕过 ownership。
- 重放不重复 Event、Operation 或 Checkpoint。

新增测试：

- Operation 成功提交后，Task Version 因 Lease/Event 合法增长，再使用原始旧
  Task Version 和原 requestKey 重放。
- 旧 Lease 被替换后，旧执行者重放被拒绝；新执行者可以识别原 Operation。

## 3. 内部中性 Operation 边界

`advance_decision_version` 保留为 CAS/幂等基础设施测试能力，不作为应用层
正式 Review 操作。

限制方式：

- 删除普通命名的
  `RecoveryManager.commitRecoveryReviewOperation()`。
- 改为未从 public recovery index 导出的 Symbol-keyed 内部测试入口。
- `RecoveryReviewDecisionService` 不从 `src/recovery/index.ts` 导出。
- `RecoveryReviewOperationRepository` 不从 `src/storage/index.ts` 导出。
- UoW 继续要求 DecisionService 创建的一次性 capability。

后续 Step 6.3.3 应增加 operation-specific 的正式入口，例如 Evidence
Submission 或 unresolved 方法，不能重新开放任意 version bump。

## 4. Migration v5 历史兼容

Migration v5 的复制流程保留：

- 原 request key。
- Operation type。
- expected/resulting decision version。
- 旧 status。
- result Plan/ToolRun。
- applied Event。

新 `actor_id` 和 `operation_payload_digest` 对历史行保持 NULL，不伪造数据。

新增测试验证：

- 合法 v4 Operation 升级后字段和 Event 关联保持。
- 索引、readback Trigger、append-only Trigger 和复合外键重新创建。
- 如果旧 status 不属于 `applied | accepted`，v5 CHECK 失败并整体回滚到 v4，
  原行和旧 schema 保持不变。

## 5. Operation / Status 映射

Migration v6 新增 INSERT Trigger：

```text
advance_decision_version -> applied
submit_evidence          -> applied
mark_unresolved          -> applied
confirm_succeeded        -> applied
confirm_not_executed     -> applied
legacy_attest             -> applied
request_readback          -> accepted
```

Repository 的 Zod 校验也拒绝不匹配组合。v4/v5 历史行不被重写。

## 6. 验证结果

- `pnpm test`：37 个测试文件、295 项测试全部通过。
- `pnpm typecheck`：通过。
- `git diff --check`：退出码 0，无 whitespace error；仅有既有 LF/CRLF
  提示。

## 7. 剩余限制

本步骤仍不包含：

- Evidence Submission。
- unresolved 业务决策。
- 最终 Review Decision。
- Verifier 或 Read-back。
- Write Recovery、Provider 或自动 Resume。

没有 Step 6.3.2 范围内的阻塞项。没有开始 Step 6.3.3。
