# ForgeFlow Phase 3 Stage 3.4 Step 8 Development Report

> 状态：Step 8 Fault Injection & Regression 完成，等待架构评审。
>
> 数据库基线：Migration v9。
>
> 本步骤仅修改测试与测试辅助代码。

## 1. 实际检查的文件

生产代码：

- `src/storage/recovery-evidence-full-recovery-unit-of-work.ts`
- `src/storage/recovery-evidence-state-transition-unit-of-work.ts`
- `src/storage/recovery-evidence-fencing-takeover-guard.ts`
- `src/storage/recovery-evidence-unit-of-work.ts`
- `src/storage/task-lease-manager.ts`
- `src/storage/event-repository.ts`
- `src/storage/checkpoint-store.ts`
- `src/storage/transaction.ts`
- `src/storage/write-boundary.ts`
- `src/storage/recovery-evidence-recovery-lineage.ts`

测试：

- `tests/storage/recovery-evidence-interruption.test.ts`
- `tests/storage/recovery-evidence-state-transition-lineage.test.ts`
- `tests/storage/recovery-evidence-dispatch-uow.test.ts`
- `tests/storage/task-lease.test.ts`
- `tests/storage/recovery-evidence-step8-database-lifecycle.test.ts`

文档：

- Stage 3.4 Implementation Plan
- Step 5、Step 6、Step 7 Development Reports
- Step 6 Supplementary Architecture Audit 与 Remediation Reports

## 2. 新增 / 修改的测试

新增：

- `tests/storage/recovery-evidence-step8-database-lifecycle.test.ts`
  - SQLite 提交后关闭 / 重开。
  - 失败事务关闭 / 重开后无部分提交。

扩展：

- `tests/storage/recovery-evidence-interruption.test.ts`
  - Interrupted UoW：
    - Attempt update failure。
    - ToolRun transition failure。
    - PlanStep transition failure。
    - Tool Event append failure。
  - Full Recovery：
    - ToolRun requeue failure。
    - PlanStep resume failure。

既有 Step 6 / Step 7 测试继续覆盖：

- Interrupted Event failure。
- Checkpoint failure。
- Prepared Event failure。
- New Attempt insert failure。
- Tool queued Event failure。
- Lineage / Replay / Intent / concurrency。

## 3. Fault Injection 矩阵

| 阶段 / 写入点 | 注入方式 | 结果 |
|---|---|---|
| Lease Claim Event | Event trigger / existing tests | rollback |
| Lease Claim Checkpoint | Checkpoint trigger | rollback |
| Interrupted Event | Event spy / trigger | rollback |
| Attempt interrupted update | SQLite trigger | rollback |
| ToolRun interrupted transition | SQLite trigger | rollback |
| PlanStep interrupted transition | SQLite trigger | rollback |
| Tool interrupted Event | SQLite trigger | rollback |
| Interrupted Checkpoint | Checkpoint trigger | rollback |
| Full Recovery Interrupted Event | Event failure | rollback |
| Full Recovery ToolRun requeue | SQLite trigger | rollback |
| Full Recovery Tool queued Event | SQLite trigger | rollback |
| Full Recovery PlanStep resume | SQLite trigger | rollback |
| Full Recovery Prepared Event | SQLite trigger | rollback |
| Full Recovery New Attempt insert | Repository spy failure | rollback |
| Full Recovery Prepared Checkpoint | SQLite trigger | rollback |

## 4. 数据库回滚结果

所有注入失败测试使用 `expectStateUnchanged()` 比较：

- Task status / version。
- Event 数量。
- Checkpoint 数量。
- Recovery ReadAttempt 列表。
- ToolRun 列表。
- PlanStep 列表。
- ExecutionPlan 列表。

结果：

- 旧 Attempt 不留下部分 interrupted 更新。
- New Attempt 不残留。
- Prepared / Tool Event 不残留。
- Checkpoint 不残留。
- ToolRun / PlanStep 回到事务前状态。

## 5. Lease / Fencing / Authority 结果

既有与新增测试确认：

- Lease 过期后新 Owner takeover。
- Release 后新 Owner Claim。
- 独立 SQLite 连接只有一个 Owner Claim 成功。
- fencingToken 单调递增。
- 旧 Owner stale lease / fencing 的 SQLite 写入被拒绝。
- Heartbeat 失效时旧 Owner 不能继续提交。
- Authority 无效时写入拒绝。
- 当前 Claim Event identity 无效时写入拒绝。
- 历史 Claim Event 不能冒充当前 Ownership。

未将新 Owner takeover 解释为旧进程 External Read 已停止。

## 6. Intent / Dispatch / Recovery 竞争结果

测试确认：

- Cancel > Pause > Normal Recovery。
- Cancel 阻止 Full Recovery New Attempt。
- Pause 未 Clear 阻止 Resume。
- Cancel / Pause 阻止 Dispatch。
- Cancel / Pause 不覆盖已提交历史 Interrupted / Prepared Event。
- Dispatch 成功后 Prepared Exact Replay 返回历史 Attempt。
- Dispatching Child 不被 Prepared Replay 改写。

不确定外部结果仍保留 `waiting_review` / 现有审查语义，没有新增状态。

## 7. Lineage / Exact Replay Regression

既有测试继续通过：

- Interrupted / Prepared strict Schema。
- Pair Validator。
- Dispatch < Claim < Interrupted。
- Claim < Prepared。
- Pause Request < Interrupted < Pause Clear < Resume Claim < Prepared。
- Real Request identity conflict。
- A1/A2 New Attempt identity conflict。
- Duplicate Prepared Event conflict。
- Illegal downstream state fail closed。
- 合法 Dispatching Child Replay。
- Cancel convergence Replay。
- Cross-owner Replay。
- Exact Replay 不重复 Event / Attempt / Checkpoint。

## 8. SQLite 关闭 / 重开

新增测试：

### 已提交事务

1. Lease Claim 提交。
2. 关闭数据库连接。
3. 重新打开同一个 SQLite 文件。
4. Lease row、`lease.claimed` Event 和 `lease_claimed` Checkpoint 仍存在。
5. 第二个 Owner 仍不能 Claim 有效 Lease。

### 失败事务

1. Lease Claim 在 Checkpoint 写入时失败。
2. 关闭数据库连接。
3. 重新打开同一个 SQLite 文件。
4. 无 Lease row。
5. 无 `lease.claimed` Event。
6. 无 `lease_claimed` Checkpoint。

WAL / synchronous / foreign_keys 等配置沿用既有 `openDatabase()`。

## 9. Phase 1–3 Regression

全量回归覆盖：

- Phase 1 Agent Core / AgentRunner / Tool Registry。
- Phase 2 TaskPlanner / ReadWorkerPool / WriteExecutor / TaskScheduler。
- Phase 3 State Transition。
- Stage 3.2 Dispatch Gate。
- Stage 3.3 Cancel / Pause / Resume。
- Stage 3.4 Step 1–7。

保持：

- Tool Registry validation 未放宽。
- Retry Safety 未放宽。
- Dispatch Gate 未修改。
- Stage 3.3 已封存行为未修改。
- Read / Write 调度约束未修改。
- Recovery 不执行 External Read。
- 不调用 Provider / Verifier。
- 不执行 Transaction B。

## 10. 实际执行命令与结果

Step 8 专项：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts tests/storage/recovery-evidence-step8-database-lifecycle.test.ts

Test Files  2 passed (2)
Tests       37 passed (37)
```

全量测试：

```text
pnpm test

Test Files  58 passed (58)
Tests       635 passed (635)
```

类型检查：

```text
pnpm typecheck
```

命令退出码为 0。

## 11. 生产代码是否修改

否。

本步骤只修改测试、测试 fixtures / workers 和文档。

## 12. Migration / Schema / Dependency 影响

无。

- 复用 Migration v9。
- 未新增 Migration v10。
- 未修改 SQLite Schema。
- 未新增依赖。

## 13. `git diff --check`

实际执行：

```text
git diff --check
```

退出码为 0。仅报告现有 LF/CRLF normalization warning，无 whitespace error。

## 14. 尚未解决的限制

1. 当前没有 Durable Recovery Job / Command Store，不能验证跨重启 Recovery 编排。
2. 没有实际进程崩溃注入；SQLite 事务失败使用 trigger / repository failure 模拟。
3. 没有真实连接在 transaction 中途断开的安全注入方式；未被确认提交的事务不视为成功。
4. 未实现 External Read，因此不能验证外部副作用停止。
5. 未实现 exactly-once External Execution。
6. Recovery Scanner / Classifier / 独立 Worker 未实现。
7. Phase 3 Step 6.3.5 未开始。

## 15. 边界声明

Step 8 仅完成 Fault Injection 和 Regression。

未修改生产状态机、Repository 业务行为、State Transition UoW、Stage 3.2、
Stage 3.3、Migration、Schema 或依赖。

未开始 Phase 3 Step 6.3.5 或其他后续功能。
