# Phase 2 Step 6 Development Report

> 范围：TaskScheduler 与 AgentRunner 集成
>
> 状态：Phase 2 Step 6 完成
>
> 未包含：SQLite、Checkpoint、MCP、Web Dashboard、真实 DeepSeek API、进程重启恢复

## 1. 新增与修改文件

新增：

- `src/scheduler/task-scheduler.ts`
- `tests/scheduler/task-scheduler.test.ts`
- `tests/integration/scheduler-agent-runner.test.ts`
- `docs/PHASE2_STEP6_DEVELOPMENT_REPORT.md`

修改：

- `src/scheduler/types.ts`
- `src/scheduler/index.ts`
- `src/scheduler/planner.ts`
- `src/scheduler/read-worker-pool.ts`
- `src/scheduler/write-executor.ts`
- `src/agent/agent-runner.ts`
- `src/agent/types.ts`
- `README.md`
- `src/health.ts`
- `tests/unit/health.test.ts`

没有新增依赖。

## 2. TaskScheduler 架构

```text
TaskScheduler
  -> TaskPlanner.plan(toolCalls)
  -> read_batch  -> ReadWorkerPool.execute()
  -> write       -> WriteExecutor.execute()
  -> unknown     -> safe failed result
  -> originalIndex result array
  -> TaskSchedulerResult
```

TaskScheduler 注入：

- 同一个 `ToolRegistry`
- `TaskPlanner`
- `ReadWorkerPool`
- `WriteExecutor`

构造时会检查四个模块是否引用同一个 Registry；不一致直接拒绝配置，不能使用另一个
Registry 绕过 Agent Run 的定义锁。

## 3. AgentRunner 接入

`AgentRunnerOptions` 新增可选 `scheduler`：

```ts
new AgentRunner({
  provider,
  registry,
  scheduler: new TaskScheduler({
    registry,
    planner: new TaskPlanner(registry),
    readWorkerPool: new ReadWorkerPool(registry),
    writeExecutor: new WriteExecutor(registry, { approvalHandler }),
  }),
  model: "mock-model",
});
```

- 不注入 Scheduler 时，继续使用 Phase 1 原有逐步顺序路径。
- 注入 Scheduler 时，预算检查通过后将完整 Tool Call 数组交给 Scheduler。
- AgentRunner 仍负责 `maxModelTurns` 和 `maxToolCalls`。
- Agent Run 的 Registry 租约覆盖 Provider 请求、规划、执行和结果回填。
- 租约通过 `try/finally` 释放。
- AgentRunner 和 Scheduler 使用不同 Registry 时构造失败。

## 4. 调度与屏障行为

- 连续 Read 由 Planner 合并为一个 Read Batch。
- Read Batch 交给 ReadWorkerPool，并发上限仍由 ReadWorkerPool 控制。
- Write Step 逐个等待 WriteExecutor 完成，不同 Write 不会并发。
- Unknown Tool 独立生成安全失败结果，后续计划继续。
- Read 部分失败或超时只影响对应结果，不终止其他 Read。
- 所有结果按 `originalIndex` 写入固定槽位，最终按原始 Tool Call 顺序返回。

## 5. 终止状态

`TaskSchedulerTermination`：

- `completed`
- `cancelled`
- `write_outcome_unknown`

规则：

- `completed`：正常完成，或普通 Write 拒绝/失败后其余步骤已标记 `skipped`；
  AgentRunner 可以继续下一轮 LLM。
- `cancelled`：不再启动后续步骤，所有未启动调用返回 `cancelled`；
  AgentRunner 不再请求 LLM。
- `write_outcome_unknown`：停止后续步骤，所有未启动调用返回 `skipped`；
  AgentRunner 返回 `write_outcome_unknown`，不再请求 LLM，不自动重试。

Agent 类型向后兼容增加：

```ts
type AgentRunStatus =
  | "completed"
  | "cancelled"
  | "limit_reached"
  | "failed"
  | "write_outcome_unknown";

type AgentToolResultStatus =
  | "succeeded"
  | "failed"
  | "skipped"
  | "unknown"
  | "timed_out"
  | "cancelled";
```

`AgentToolResult` 新增可选的 `originalIndex` 和 `mode`，旧调用方不需要修改。

## 6. Tool Call 结果回填

- TaskScheduler 为每个原始 Tool Call 创建结果。
- 结束前检查结果数组是否仍有空槽。
- 取消时未启动项为 `cancelled`。
- Write unknown 或普通 Write 失败后的后续项为 `skipped`。
- AgentRunner 按 Scheduler 返回顺序逐条生成 Tool Message。
- Tool Call ID 来自对应结果，不通过工具名称猜测。
- 序列化失败时仍保留 Tool Call ID、Original Index 和 Mode。

## 7. 测试矩阵

新增 18 个测试，其中 TaskScheduler 单元测试 12 个，AgentRunner 集成测试 6 个。

| 验收要求 | 测试 | 结果 |
|---|---|---|
| 单个 Read Batch | `executes a single read batch` | 通过 |
| 连续 Read 并行 | `executes consecutive reads concurrently and preserves result order` | 通过 |
| Read 后 Write 屏障 | `waits for a read batch before starting a write barrier` | 通过 |
| Read → Write → Read | `executes Read, Write, Read in plan order` | 通过 |
| Write 串行 | `never overlaps multiple write steps` | 通过 |
| Unknown Tool | `handles unknown tools independently and continues the plan` | 通过 |
| Read 部分失败 | `keeps successful reads when another read in the batch fails` | 通过 |
| Read 超时独立结果 | `keeps read timeout results independent` | 通过 |
| Write 拒绝后剩余 skipped | `marks later calls skipped when a write is rejected` | 通过 |
| Write unknown 停止 | `stops later steps and marks skipped after a write outcome is unknown` | 通过 |
| Write unknown 不请求 LLM | `stops without another model request when a write outcome is unknown` | 通过 |
| 取消补齐结果 | `marks all unstarted calls cancelled after task cancellation` | 通过 |
| AgentRunner 完整执行 | `executes a complete mixed batch through the injected scheduler` | 通过 |
| 旧顺序路径保持 | Phase 1 `executes multiple calls in order and appends one complete assistant tool-call message` | 通过 |
| ID 和顺序 | 完整批次与 TaskScheduler 顺序测试 | 通过 |
| 预算前置拒绝 | `rejects an over-budget batch before invoking the scheduler` | 通过 |
| Registry 租约覆盖完整执行 | `holds the registry lease across scheduling and the next model turn` | 通过 |
| 共享 Registry 多 Agent | `keeps the registry locked until all concurrent Agent runs complete` | 通过 |

此外，AgentRunner 与 Scheduler Registry 不一致测试通过。

## 8. 实际验证结果

- `pnpm test`：13 个测试文件、122 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1 与 Phase 2 Step 1 至 Step 5 的全部测试保持通过。

## 9. 已知限制

- 没有 SQLite、Checkpoint 或进程重启恢复。
- `write_outcome_unknown` 只终止当前内存 Run，不持久化待人工核对状态。
- 审批 Handler 仍由调用方提供，没有持久化审批队列或 Web 审批界面。
- 忽略 AbortSignal 的工具不会被强制停止，执行器会保守等待底层 Promise settle。
- TaskScheduler 依赖 AgentRunner 已持有的 Registry 租约；独立调用时调用方需要自行
  持有租约，才能保证从规划到执行的定义一致性。
- 不实现自动重试、回滚或 exactly-once。
- 尚未接入真实 DeepSeek API；Mock 模式仍是默认运行方式。

## 10. Step 7 集成测试建议

Step 7 建议只增加端到端验证，不扩展 Phase 3 能力：

1. 使用固定 Mock Task 完成 Read → Write → Read 全链路。
2. 同时覆盖批准、拒绝、无 Handler 和审批超时。
3. 覆盖 Read 部分失败、Read 超时和 Write unknown。
4. 覆盖取消发生在排队、读取中、审批中和写入中的差异。
5. 断言 Assistant Message、Tool Message、Tool Call ID 和 `originalIndex` 全部配对。
6. 使用两个共享 Registry 的并发 Agent Run 验证租约和定义一致性。
7. 验证 Scheduler 不注入时旧路径仍可运行。
8. 不引入 SQLite、MCP、真实模型或 Web Dashboard。

本阶段不进入 Step 7。
