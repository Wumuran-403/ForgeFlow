# ForgeFlow Phase 3 Stage 3.4 Step 7 Development Report

> 状态：Step 7 集成与并发验证完成，等待架构评审。
>
> 范围：Stage 3.2 Dispatch Gate Integration + Concurrency。
>
> 数据库基线：Migration v9。
>
> 未开始 Step 8。

## 1. 实际新增 / 修改文件

测试：

- `tests/storage/recovery-evidence-interruption.test.ts`
  - 新增 Step 7 Dispatch Integration、Replay Integration、
    Intent Gate 和 Concurrency 测试。
- `tests/storage/recovery-evidence-full-recovery-worker.ts`
  - 新增真实独立 SQLite 连接的 Recovery Prepare / Replay worker。

文档：

- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP7_DEVELOPMENT_REPORT.md`
  - 本报告。

生产代码：

- 无修改。

未修改：

- Stage 3.2 Dispatch Gate。
- Stage 3.3 已封存 UoW。
- Step 1 Lineage Schema。
- Step 2 普通状态转换 / Replay Policy。
- Migration / SQLite Schema。
- 依赖。

## 2. Step 7 具体实施范围

本步骤通过测试验证既有实现是否满足 Step 7：

1. Recovered Prepared Attempt 能进入原 Stage 3.2 Dispatch Gate。
2. Dispatch 后 Prepared Exact Replay 不破坏 Dispatching Child。
3. Cancel / Pause 优先于 Dispatch / Replay。
4. Invalid Prepared Lineage 被 Dispatch Gate 拒绝。
5. 新 Owner 能 Dispatch 由自己 Recovery 创建的 Prepared Attempt。
6. 旧 Owner stale fencing 不能 Dispatch。
7. 两个独立 SQLite 连接并发 Prepare 只有一个成功创建 Attempt。
8. 两个独立 SQLite 连接并发 Replay 只返回历史 Attempt。
9. 并发竞争不重复 Prepared Event、Tool Event 或 Prepared Checkpoint。

未增加 Recovery 专用 Dispatch 入口。

## 3. Prepared Attempt 到 Dispatch 完整调用链

```text
Old Attempt dispatching
  -> Recovery Preflight
  -> Step 6 Full Recovery
  -> State Transition UoW
       interrupted + requeue + Prepared Event + New Attempt
  -> New Prepared Attempt
  -> prepareRecoveryEvidenceDispatchPreflight()
  -> RecoveryEvidenceUnitOfWork.beginOwnedRecoveryEvidenceRead()
  -> Stage 3.2 Dispatch Gate
  -> State Transition UoW
       prepared -> dispatching
       ToolRun queued -> running
       PlanStep queued/running -> running
       Plan active
```

测试使用真实：

- TaskLeaseManager / ExecutionAuthority。
- Recovery Preflight。
- Dispatch Preflight opaque capability。
- State Transition UoW。
- SQLite immediate transaction。

未直接调用底层 Repository 产生 Dispatching 状态。

## 4. Dispatch Gate 权限和状态验证

Prepared Attempt 通过 Gate 时实际验证：

- Task.status = waiting_review。
- Task / Request / Reservation / Review / Operation binding。
- 单一 active Attempt。
- Attempt.status = prepared。
- ToolRun.status = queued。
- PlanStep.status = queued / running。
- Plan.status = active 且 purpose = recovery_evidence。
- Recovery / Dispatch Preflight identity。
- Retry Dispatch Lineage。
- Interrupted / Prepared Pair。
- 当前 Lease / Fencing / Authority。
- Cancel / Pause Intent。

测试确认：

- Task 在 Dispatch 前后保持 waiting_review。
- Dispatch 后 Attempt dispatching、ToolRun running、PlanStep running、Plan active。
- 旧 Owner ownership 在 New Owner 接管后无法 Dispatch。
- 非法 Prepared Lineage 返回 `state_inconsistent` /
  `retry_lineage_invalid`。
- Cancel 返回 `cancel_required`。
- Pause 返回 `pause_blocked`。

## 5. Dispatching Child / Exact Replay

测试路径：

1. Step 6 创建 Prepared New Attempt。
2. Stage 3.2 Dispatch Gate 将 Child 转为 dispatching。
3. 使用原 recoveryOperationId 执行 Prepared Replay。
4. Replay 返回原 Prepared Attempt / Prepared Event。
5. 当前 Child 仍保持 dispatching。

确认：

- 不创建第二个 Attempt。
- 不重复 Prepared Event。
- 不重复 Prepared Checkpoint。
- 不覆盖历史 Claim / fencing。
- 不破坏 ToolRun running / PlanStep running 状态。
- 新 Owner 在合法接管后可以只读 Replay 历史 Prepared 结果。
- 历史 Replay 结果不构成新的 Dispatch 授权。

## 6. 独立 SQLite 连接并发

新增 worker：

`tests/storage/recovery-evidence-full-recovery-worker.ts`

每个 worker 使用：

- 独立 `openDatabase()` 连接。
- 独立 TaskLeaseManager。
- 独立 ExecutionAuthority。
- 真实 Recovery Preflight。
- 真实 RecoveryEvidenceFencingTakeoverGuard。

### 并发 Prepare

两个 Owner 同时尝试同一 Task / recoveryOperationId：

- 一个成功 Claim Lease 并创建 Prepared Attempt。
- 另一个返回 in_progress。
- Prepared Event 数量 = 1。
- Recovery ReadAttempt 数量从 1 增加到 2。
- fencingToken 单调递增。

### 并发 Replay

释放获胜 Lease 后，两个新 Owner 同时 Replay：

- 一个取得 Lease 并返回历史 Prepared Attempt。
- 另一个返回 in_progress。
- Attempt 数量保持 2。
- Prepared Event 数量保持 1。
- Tool Event 数量不变。
- Prepared Checkpoint 数量保持 1。
- 新增 Event / Checkpoint 仅为合法 Lease Claim，不代表 Recovery 重复写入。

## 7. Lease / Fencing / Intent 竞争

测试：

- 旧 Owner stale ownership 在 New Owner 接管后 Dispatch 被拒绝。
- Cancel 在 Dispatch 前阻止 Dispatch。
- Pause 在 Dispatch 前阻止 Dispatch。
- 同一 operation 的并发 worker 只有一个获得有效 Ownership。
- Prepared Event 历史 fencing 不被 New Owner Replay 覆盖。

明确边界：

- SQLite Lease / Fencing 是持久化提交权依据。
- ExecutionAuthority 是进程内 capability。
- 新 Owner 接管不证明旧进程 External Read 已停止。
- 未实现 exactly-once External Execution。

## 8. Event / Attempt / Checkpoint 原子性

Step 6 原有测试继续覆盖：

- Attempt insert failure rollback。
- Prepared Event failure rollback。
- Tool Event failure rollback。
- Checkpoint failure rollback。

Step 7 并发测试确认：

- 并发 Prepare 只产生一个 Prepared Event 和一个 New Attempt。
- 并发 Replay 不产生第二个 Prepared Event。
- Replay 不产生新的 Tool Event。
- Replay 不产生新的 Prepared Checkpoint。
- 不出现部分提交。

## 9. Read 并发 / Write 串行

本步骤没有修改 ReadWorkerPool、WriteExecutor 或 TaskScheduler。

Stage 3.4 不执行 External Read，也不改变既有 Read / Write 调度规则。
完整测试套件继续覆盖现有 Scheduler / ReadWorkerPool / WriteExecutor 回归。
本次没有增加绕过调度器的 Recovery 专用执行路径。

## 10. 实际执行结果

Step 7 专项测试：

```text
pnpm vitest run tests/storage/recovery-evidence-interruption.test.ts

Test Files  1 passed (1)
Tests       33 passed (33)
```

全量测试：

```text
pnpm test

Test Files  57 passed (57)
Tests       631 passed (631)
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

结果见第 12 节。

## 11. Migration / Schema 影响

无。

- 复用 Migration v9。
- 未新增 Migration v10。
- 未修改 Migration v4-v9。
- 未修改 SQLite Schema。
- 未新增依赖。

## 12. `git diff --check`

实际执行结果：

```text
Exit code: 0
```

仅有工作树现有 LF/CRLF normalization warning，没有 whitespace error。

## 13. 剩余限制

1. Durable Recovery Job / Command Store 仍不存在。
2. recoveryOperationId 仍由 Host stable context 提供。
3. 未实现跨重启 Recovery Orchestration。
4. 未实现 External Read，因此无法证明旧进程外部操作已停止。
5. exactly-once External Execution 未实现。
6. 未执行 Step 8 的完整崩溃窗口 / Fault Injection 矩阵。

## 14. 未实施内容

- Step 8。
- Durable Recovery Job / Command Store。
- Recovery Scanner / Classifier / 独立 Worker。
- External Read / Provider。
- Transaction B / Verifier。
- 新 HTTP / IPC / Host Control Recovery 入口。
- Migration / Schema 修改。

## 15. 边界声明

Step 7 通过既有 Stage 3.2 Dispatch Gate 和 State Transition UoW 完成集成与
并发验证，未增加 Recovery 特殊 Dispatch 路径，未放宽任何已有安全校验。

完成后停止，不开始 Step 8。
