# Phase 2 Step 3 Development Report

> 范围：Read Worker Pool
>
> 状态：Step 3 完成
>
> 未包含：Write Executor、Write Approval、工具超时、取消调度、完整 TaskScheduler、AgentRunner 集成

## 1. 新增与修改文件

新增：

- `src/scheduler/read-worker-pool.ts`
- `tests/scheduler/read-worker-pool.test.ts`
- `docs/PHASE2_STEP3_DEVELOPMENT_REPORT.md`

修改：

- `src/scheduler/types.ts`
- `src/scheduler/index.ts`

未修改 AgentRunner、Provider、Tool Registry、SQLite、Checkpoint 或 MCP。

## 2. 模块架构

```text
TaskPlanner
  -> read_batch
       -> ReadWorkerPool.execute(items, { taskId, signal })
            -> ToolRegistry.get()
            -> ToolRegistry.validateInput()
            -> ToolRegistry.executeValidated()
       -> ordered ReadToolResult[]
```

ReadWorkerPool 只接受 Planner 生成的只读任务。它在执行前再次确认：

- 任务 Mode 为 `read`
- Registry 当前 Mode 为 `read`
- Tool Name 与 Registry 元数据一致
- `timeoutMs` 与 Planner 快照一致
- `requiresApproval` 与 Planner 快照一致

Write、Unknown、过期元数据和非法任务不会进入工具执行函数。

## 3. Worker Pool 接口

```ts
new ReadWorkerPool(registry, {
  maxConcurrency: 3,
}).execute(
  readBatch.items,
  {
    taskId,
    signal,
  },
);
```

返回值：

```ts
interface ReadToolResult {
  originalIndex: number;
  toolCallId: string;
  toolName: string;
  status: "succeeded" | "failed";
  output?: unknown;
  error?: {
    code: string;
    message: string;
    details: readonly { path: string; message: string }[];
  };
}
```

`activeTaskCount` 暴露当前活动只读任务数，用于验证 Worker 槽位释放。

## 4. 并发控制算法

- `maxConcurrency` 默认 3。
- 启动时创建 `min(maxConcurrency, tasks.length)` 个固定 Worker。
- 所有 Worker 共享单调递增的 `nextIndex`。
- Worker 在单线程事件循环中同步领取下一个任务，不会重复领取同一 index。
- 任务槽位在结果 Promise 真正 settle 后通过 `finally` 释放。
- 没有使用 `Promise.race` 或超时提前释放槽位。
- 每个结果写入固定数组下标，不按 Promise 完成顺序 `push`。
- Worker 全部结束后按原数组顺序返回结果。

工具执行使用：

```text
validateInput() -> executeValidated()
```

因此 Zod transform 和 async refinement 只运行一次，且执行函数不会拿到未经
JSON 快照和深冻结的可变输入。

## 5. 错误与部分失败

每个任务独立捕获并转换为结果：

- JSON 参数解析失败：`TOOL_ARGUMENTS_JSON_INVALID`
- 未知工具：`TOOL_NOT_FOUND`
- Zod 参数校验失败：`TOOL_INPUT_INVALID`
- 工具执行失败：`TOOL_EXECUTION_FAILED`
- Write 或非法 Read 计划项：`INVALID_READ_TASK`

内部异常消息、stack、cause 和敏感值不会进入结果。一个任务失败不会中止其他
Read 任务，也不会丢失已经成功的结果。

## 6. 测试矩阵

`tests/scheduler/read-worker-pool.test.ts` 共 13 个测试：

| # | 测试 | 结果 |
|---|---|---|
| 1 | 非法 maxConcurrency 被拒绝 | 通过 |
| 2 | 三个 Read 实际并行 | 通过 |
| 3 | 默认上限不超过 3 | 通过 |
| 4 | 自定义并发 2 生效 | 通过 |
| 5 | 超过并发上限的任务等待槽位 | 通过 |
| 6 | 完成顺序反转时结果保持原序 | 通过 |
| 7 | 单个执行失败不影响其他 Read | 通过 |
| 8 | Zod 校验失败时执行函数不被调用 | 通过 |
| 9 | Unknown Tool 不进入执行 | 通过 |
| 10 | Write Tool 不进入 Read Worker | 通过 |
| 11 | taskId、toolCallId、signal 正确传递 | 通过 |
| 12 | JSON 字符串参数先解析再校验 | 通过 |
| 13 | 空批次返回空结果且活动任务归零 | 通过 |

并发测试使用 deferred Promise、启动/完成事件和活动计数，不依赖 `setTimeout`
睡眠推断并发。额外覆盖了任务完成后 `activeTaskCount === 0`。

## 7. 实际验证结果

- `pnpm test`：9 个测试文件、72 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1、Phase 2 Step 1 和 Step 2 的全部测试保持通过。

## 8. 当前限制

- 未实现工具超时，底层工具 Promise 不结束则 Worker 槽位不会释放。
- 未实现完整取消调度；传入的 AbortSignal 只转发给工具。
- 未实现 Write Executor、Write Approval 或完整 TaskScheduler。
- 未接入 AgentRunner，当前由调用者直接调用。
- ReadWorkerPool 不处理 Unknown Tool 的消息生成，只返回安全失败结果。
- 未实现工具输出大小限制；输出序列化仍由后续 Agent 消息层负责。
- `activeTaskCount` 包含 Zod 校验和实际工具执行阶段，是保守的 Worker 槽位计数。

## 9. Step 4 接入建议

Step 4 应按 Planner 步骤顺序执行：

1. `read_batch` 调用 ReadWorkerPool。
2. `write` 保持独立屏障，交给后续 Write Executor。
3. `unknown_tool` 直接形成安全失败结果。
4. 所有结果使用 `originalIndex` 写入统一结果槽位。
5. 等整个批次或步骤 settle 后再推进下一个屏障。
6. 规划和执行保持在同一次 Registry 租约内。
7. Write Approval、超时和取消策略应独立实现，不能通过提前释放 Read Worker
   槽位来模拟超时。

本阶段不进入 Step 4。
