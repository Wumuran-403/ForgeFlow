# Phase 2 Step 5 Development Report

> 范围：工具超时、审批超时与取消
>
> 状态：Step 5 完成
>
> 未包含：完整 TaskScheduler、Read/Write 混合编排、AgentRunner 集成、Checkpoint、MCP

## 1. 新增与修改文件

新增：

- `src/scheduler/abort.ts`
- `tests/scheduler/timeout-cancellation.test.ts`
- `docs/PHASE2_STEP5_DEVELOPMENT_REPORT.md`

修改：

- `src/scheduler/types.ts`
- `src/scheduler/read-worker-pool.ts`
- `src/scheduler/write-executor.ts`
- `tests/scheduler/read-worker-pool.test.ts`
- `tests/scheduler/write-executor.test.ts`

ReadWorkerPool 与 WriteExecutor 继续保持独立执行器职责，没有实现完整 TaskScheduler。

## 2. 超时处理机制

ReadWorkerPool 配置：

- `defaultTimeoutMs` 默认 30,000
- 计划项 `timeoutMs` 优先
- `maxConcurrency` 仍默认 3

WriteExecutor 配置：

- `defaultTimeoutMs` 默认 30,000
- `approvalTimeoutMs` 默认 30,000
- 所有值必须为正整数

计时边界：

- Read 超时从调用 `executeValidated()` 前开始，不包含排队和 Zod 校验时间。
- Write 工具超时从审批完成并调用 `executeValidated()` 前开始。
- 审批等待使用独立计时器，不占用工具执行时间。
- 工具 Promise settle 后、超时时都会清理计时器。

## 3. AbortSignal 组合方式

`createAbortScope(parentSignal)` 为每次执行创建独立 `AbortController`：

```text
Parent task signal --abort event--> Child tool controller
Timeout timer ---------------------> Child tool controller
Child tool controller.signal ------> Tool execute context
```

执行结束后通过 `dispose()` 移除父信号监听器。超时触发后立即 abort 子信号并移除
不再需要的父监听器，即使底层工具忽略信号并继续运行。

每个 Read Tool Call 拥有不同子信号；一个工具超时不会 abort 同批其他工具。

## 4. 审批超时处理

审批请求使用独立 AbortScope 和计时器：

- 超时返回 `skipped`，错误码 `WRITE_APPROVAL_TIMEOUT`。
- 超时后 abort 审批信号。
- 延迟返回的 approved 会被忽略，写函数调用次数保持为零。
- 审批期间父任务取消返回 `cancelled`。
- 审批通过后再次检查父取消信号，已取消则不执行。
- 无 ApprovalHandler 时仍为 `skipped`。

审批超时不会启动 Write 工具，也不会进入工具执行计时。

## 5. Read Worker 槽位释放规则

Read 超时或取消时：

1. 记录结果为 `timed_out` 或 `cancelled`。
2. abort 该工具的独立子信号。
3. 继续等待底层工具 Promise 真正 settle。
4. settle 后才减少 `activeTaskCount` 并领取下一个任务。

没有使用 `Promise.race` 提前返回并释放槽位。忽略 AbortSignal 的工具仍可能继续运行，
Runtime 不会虚假声称并发上限仍被保证。

任务取消时，Worker 在领取下一个任务前检查父信号，不会启动排队中的 Read。未启动
任务显式返回 `cancelled`，不是稀疏数组或未定义结果。

## 6. Write unknown 规则

| 时点 | 结果 |
|---|---|
| 审批/校验前或期间取消 | `cancelled`，零执行 |
| 审批拒绝、超时或无 Handler | `skipped`，零执行 |
| 审批通过、执行前取消 | `cancelled`，零执行 |
| Write 已启动后取消 | `unknown` |
| Write 已启动后超时 | `unknown` |
| Write 已启动后抛错 | `unknown` |
| Write 输出不可序列化 | `unknown` |
| Write 已成功完成后才取消 | 保持 `succeeded` |

`unknown` 不允许自动重试。WriteExecutor 即使在超时或取消后也等待底层 Promise
settle 才返回，避免调用方过早启动下一个 Write 屏障。

## 7. 测试证据

Step 5 新增 `tests/scheduler/timeout-cancellation.test.ts`，共 18 个测试：

| 验收要求 | 测试 | 结果 |
|---|---|---|
| 默认 Read 超时 | `uses the registry default timeout of 30 seconds for a read` | 通过 |
| 自定义 Read 超时与同批隔离 | `uses a custom read timeout and does not cancel another read` | 通过 |
| 排队 Read 取消不启动 | `stops queued reads after task cancellation and marks them cancelled` | 通过 |
| 运行中 Read 收到取消 | 同上，检查子 AbortSignal | 通过 |
| 运行中 Read 取消等待 settle | `waits for a canceled running read to settle before canceling queued work` | 通过 |
| Read 超时不提前释放槽位 | `does not release a timed-out read slot until the underlying promise settles` | 通过 |
| 底层 settle 后释放槽位 | 同上，验证下一任务随后启动 | 通过 |
| 独立 AbortController | `uses an independent AbortController for each read` | 通过 |
| Write 超时 unknown 且不重试 | `leaves a write outcome unknown after execution timeout and never retries` | 通过 |
| Read 超时零重试 | `does not retry a timed-out read` | 通过 |
| 审批超时零执行 | `skips a write when approval times out and never executes it` | 通过 |
| 延迟 approved 被忽略 | `ignores an approval that resolves after the approval timeout` | 通过 |
| 审批期间取消 | `cancels during approval without executing the write` | 通过 |
| 审批取消传播到审批信号 | `aborts the approval signal when approval waiting is canceled` | 通过 |
| 审批时间不计入工具超时 | `starts tool timeout only after approval completes` | 通过 |
| Write 启动后取消 unknown | `returns unknown when cancellation occurs after write execution starts` | 通过 |
| 已成功 Write 后续取消仍成功 | `keeps a successful write succeeded when cancellation happens afterward` | 通过 |
| 审批后执行前取消 | `cancels after approval but before execution without starting the write` | 通过 |
| 非法超时配置 | `rejects non-positive timeout configuration` | 通过 |
| 成功执行后清理计时器 | `clears timers after successful read and write execution` | 通过 |

另外通过 Fake Timer 断言相关流程结束后计时器数量归零。

## 8. 实际验证结果

- `pnpm test`：11 个测试文件、104 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1、Step 1、Step 2、Step 3、Step 4 的全部测试保持通过。

## 9. 已知限制

- 不实现完整 TaskScheduler 和混合 Read/Write 编排。
- 不实现 AgentRunner 集成。
- AbortSignal 只表达请求取消；忽略信号的工具不会被强制停止。
- 若底层 Promise 永不 settle，Read 槽位或 WriteExecutor 会继续等待，这是保守且
  明确的安全行为。
- 审批 Handler 可能在超时后仍持有自己的外部资源；Runtime 已清理计时器和监听器，
  但其延迟结果会被忽略。
- 没有写操作回滚、幂等确认或 exactly-once 保证。
- 没有持久化取消状态或恢复机制。

## 10. Step 6 AgentRunner 集成建议

Step 6 建议：

1. AgentRunner 在现有 Registry 执行租约内调用 TaskPlanner。
2. 依次消费计划步骤，不重新根据 Tool 名称推断 Mode。
3. Read Batch 交给 ReadWorkerPool，父信号贯穿整个 Agent Run。
4. Write Step 交给 WriteExecutor，并保持独立屏障。
5. 所有结果按 `originalIndex` 回填，再生成消息历史。
6. `unknown` Write 状态不得自动重试，应停止后续依赖该写入的步骤。
7. AgentRunner 退出时确保所有 Worker 与执行器 Promise settle，不能提前释放租约。
8. 将 Read/Write 的计时、取消和审批结果映射到统一 Tool Result 协议。

本阶段不进入 Step 6。
