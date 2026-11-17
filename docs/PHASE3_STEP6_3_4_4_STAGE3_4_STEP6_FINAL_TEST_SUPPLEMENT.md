# ForgeFlow Phase 3 Stage 3.4 Step 6 Final Test Supplement

> 状态：测试补充发现真实实现缺陷。
>
> 结论：按授权要求停止，未修改生产代码。
>
> 未开始 Step 7 / Step 8。

## 1. 新增 / 调整测试

测试文件：

- `tests/storage/recovery-evidence-interruption.test.ts`

新增测试：

```text
classifies a real different Request as an Exact Replay identity conflict
```

调整测试：

原组合测试拆分为独立测试：

```text
rejects a different newAttemptId without writes
```

## 2. 第二个真实 Request 的构造方式

测试没有使用不存在的 Request ID。

构造方式：

1. 使用同一个 SQLite database。
2. 通过 `createRecoveryEvidenceUowFixture()` 创建一个真实存在的第二 Task。
3. 使用真实 `RecoveryEvidenceReadbackReservationUnitOfWork` 完成
   Reservation。
4. 通过 `createOwnedRecoveryEvidenceReadbackRequest()` 创建真实 Request RB。
5. RB 包含合法的 Task / Review / Operation / Reservation / Plan /
   PlanStep / read ToolRun 绑定。

说明：

- 当前 Schema 对 Request 设置：
  - `UNIQUE(operation_id)`
  - `UNIQUE(execution_plan_id)`
  - `UNIQUE(plan_step_id)`
  - `UNIQUE(read_tool_run_id)`
  - `UNIQUE(task_id, review_id, evidence_submission_id, original_tool_run_id)`
- 同 Task 的第二 Request 需要完整的第二套 write run / review / submission /
  read plan / read run 链。
- 本次按授权允许的 fallback，使用同一数据库、另一个真实 Task 下的有效
  Request RB，而不是伪造 ID。

## 3. 单 Prepared Event 身份冲突实际结果

首次 Prepare：

```text
Task = T1
recoveryOperationId = R1
requestId = RA
newAttemptId = A1
```

结果：

- Prepared Event 1 条。
- New Attempt A1 1 条。

Replay：

```text
Task = T1
recoveryOperationId = R1
requestId = RB（真实存在）
```

实际错误：

```text
RECOVERY_EVIDENCE_FULL_RECOVERY_BINDING_INVALID
```

期望错误：

```text
RECOVERY_EVIDENCE_FULL_RECOVERY_REPLAY_INCONSISTENT
```

因此测试失败。

## 4. 为什么这是实际实现缺陷

`RecoveryEvidenceFullRecoveryUnitOfWork.recoverOwnedRecoveryEvidenceReadAttempt()`
当前顺序：

1. 读取当前输入 Request RB。
2. 读取 prior Attempt RA。
3. 执行 `assertPersistedBindings()`。
4. 之后才执行 `findPreparedReplay()`。

`assertPersistedBindings()` 已经检查：

```text
priorAttempt.readbackRequestId === request.id
```

由于 RA != RB，代码在查找历史 Prepared Event 前就抛出
`RECOVERY_EVIDENCE_FULL_RECOVERY_BINDING_INVALID`。

因此：

- fail closed 行为正确。
- 不写数据的行为正确。
- 但错误分类不是 Operation / Replay Identity Conflict。
- Replay 分支内的 Request identity 检查目前不可达。

## 5. A1 / A2 测试独立性

已拆分为独立测试：

```text
First:
  R1 + A1

Replay:
  R1 + A2
```

实际结果：

- 测试通过。
- 拒绝原因来自 `preparedLineage.newAttemptId` 与调用参数 A2 不一致。
- 该测试不再包含错误 Request 场景。
- 不依赖缺失 Claim 或其他前置失败。

## 6. Event / Attempt / Tool Event / Checkpoint 数量

在失败错误分类断言前，测试已实际断言：

- Event 数量不变。
- Checkpoint 数量不变。
- Recovery ReadAttempt 列表完全不变（因此没有第二个 Attempt）。
- 原 Prepared Event payload 完全不变。

Tool Event 属于 Event 集合，因此 Event 总数不变证明没有新增 Tool Event。

结论：

- 无第二次准备写入。
- A1 与原 Prepared Lineage 保持不变。
- 只有错误分类不符合授权要求。

## 7. 实际执行结果

指定专项测试：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts

Test Files  1 failed (1)
Tests       1 failed | 27 passed (28)
```

失败测试：

```text
classifies a real different Request as an Exact Replay identity conflict
```

实际错误码：

```text
RECOVERY_EVIDENCE_FULL_RECOVERY_BINDING_INVALID
```

全量测试：

```text
pnpm test

Test Files  1 failed | 56 passed (57)
Tests       1 failed | 625 passed (626)
```

类型检查：

```text
pnpm typecheck
```

命令退出码为 0。

差异检查：

```text
git diff --check
```

命令退出码为 0。仅有现有 LF/CRLF warning，无 whitespace error。

## 8. 是否发现生产代码缺陷

是。

缺陷类型：

```text
Exact Replay Request Identity Conflict error classification
```

代码仍安全 fail closed，但错误分类不稳定、不准确，未满足本次授权要求。

## 9. 最小修复建议

需要架构授权后再修改生产代码。

最小修复方向：

1. 在 generic Request / prior Attempt binding 检查前，按
   `taskId + recoveryOperationId + prepare` 查找已有 Prepared Event。
2. 若存在历史 Prepared Event：
   - 进入 Exact Replay identity validation。
   - 比较历史 `readbackRequestId` 与当前输入 `requestId`。
   - 不一致时返回稳定 Operation / Replay Identity Conflict。
3. 若不存在 Prepared Event，再执行首次 Prepare 的严格 Request /
   Attempt / Reservation binding 校验。
4. 保持当前无写入和 Event / Checkpoint 不变行为。
5. 不修改 Schema / Migration。

## 10. 本轮修改范围

修改：

- `tests/storage/recovery-evidence-interruption.test.ts`
- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP6_FINAL_TEST_SUPPLEMENT.md`

未修改：

- 生产代码。
- State Transition UoW。
- Full Recovery UoW。
- Step 1 Schema。
- Stage 3.2 Dispatch Gate。
- Stage 3.3 已封存行为。
- Migration / SQLite Schema。
- 依赖。

按授权要求在确认真实实现缺陷后停止，等待进一步授权。
