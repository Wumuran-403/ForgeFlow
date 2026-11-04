# Phase 2 Step 4 Development Report

> 范围：Write Executor 与人工审批
>
> 状态：Step 4 完成
>
> 未包含：完整 TaskScheduler、多 Write 编排、工具超时、审批超时、AgentRunner 集成

## 1. WriteExecutor 架构

```text
Planned write Tool Call
  -> WriteExecutor
       -> ToolRegistry.get()
       -> 解析并校验 Write 任务
       -> ToolRegistry.validateInput()
       -> WriteApprovalHandler.request()
       -> ToolRegistry.executeValidated()
       -> WriteToolResult
```

`WriteExecutor` 只执行一个 Write Tool Call，不负责前后 Read/Write 屏障，也不负责
多个 Write 的顺序编排。调用方必须持有 Registry 执行租约，保证 Planner 元数据和
实际执行定义一致。

## 2. Approval Handler 接口

```ts
interface WriteApprovalRequest {
  taskId: string;
  toolCallId: string;
  toolName: string;
  description: string;
  input: unknown;
}

type WriteApprovalDecision =
  | { status: "approved" }
  | { status: "rejected"; reason?: string };

interface WriteApprovalHandler {
  request(
    request: WriteApprovalRequest,
    options: { signal?: AbortSignal },
  ): Promise<WriteApprovalDecision>;
}
```

审批请求不包含环境变量、Provider 配置、API Key、Authorization Header、工具执行
函数或内部异常。

## 3. 审批与输入安全

- `write` 由 Registry 默认归一化为 `requiresApproval=true`。
- 显式 `requiresApproval=false` 时跳过审批。
- 没有 Handler 时，需要审批的 Write 返回 `skipped`，执行函数调用次数为零。
- 参数先经过 `validateInput()`，Zod transform/refinement 只执行一次。
- 审批看到的输入通过 `structuredClone(validatedInput.value)` 独立创建。
- 实际执行使用 Registry 深冻结的标准输入。
- 审批回调即使修改自己的输入副本，也不会影响工具实际收到的参数。
- 审批通过后再次检查 AbortSignal，已取消则绝不启动写工具。
- 审批拒绝原因不会回传模型，避免意外暴露敏感文本。

## 4. 状态转换规则

| 场景 | 状态 | 是否已启动写函数 |
|---|---|---|
| 审批通过且执行成功 | `succeeded` | 是 |
| Read、未知工具、非法参数、元数据不匹配 | `failed` | 否 |
| 审批拒绝、无 Handler、无效审批决定 | `skipped` | 否 |
| 审批前或审批期间取消 | `cancelled` | 否 |
| 审批通过但执行前取消 | `cancelled` | 否 |
| 写函数启动后抛错 | `unknown` | 是 |
| 写函数启动后输出不可序列化 | `unknown` | 是 |
| 写函数启动后任务被取消 | `unknown` | 是 |

`unknown` 永不自动重试。只有能够确认写函数没有启动时，才返回 `failed`。

## 5. 安全边界

- 只接受 `mode=write` 且与 Registry 元数据完全匹配的计划项。
- Read Tool 不会请求审批或执行。
- 未知工具不会执行。
- 不直接访问工具原始 `execute`。
- 所有执行通过 `validateInput()` 和 `executeValidated()`。
- 写函数执行异常只返回通用 `WRITE_OUTCOME_UNKNOWN`。
- BigInt、循环引用等不可序列化输出返回 `unknown`。
- Tool Result 不包含内部错误消息、stack、cause、密钥或审批拒绝原因。
- 没有自动重试、回滚或外部副作用确认。

## 6. 测试矩阵

`tests/scheduler/write-executor.test.ts` 共 14 个测试：

| # | 测试 | 结果 |
|---|---|---|
| 1 | 审批通过后成功执行 Write | 通过 |
| 2 | 审批拒绝时零执行且不暴露原因 | 通过 |
| 3 | 无 ApprovalHandler 时跳过 | 通过 |
| 4 | `requiresApproval=false` 直接执行 | 通过 |
| 5 | Read Tool 被拒绝且不审批/执行 | 通过 |
| 6 | 未知工具被拒绝 | 通过 |
| 7 | Zod 校验失败时不审批/执行 | 通过 |
| 8 | 审批输入与实际执行输入值一致但引用独立 | 通过 |
| 9 | 审批回调修改副本不影响实际输入 | 通过 |
| 10 | 审批等待期间取消，零执行 | 通过 |
| 11 | 审批通过后、执行前取消，零执行 | 通过 |
| 12 | 执行异常返回 unknown 且隐藏内部信息 | 通过 |
| 13 | BigInt 输出返回 unknown | 通过 |
| 14 | 循环引用输出返回 unknown | 通过 |

测试还覆盖了 taskId、toolCallId、AbortSignal 传递和审批请求字段白名单。

## 7. 实际验证结果

- `pnpm test`：10 个测试文件、86 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1、Step 1、Step 2、Step 3 的全部测试保持通过。

## 8. 当前限制

- 不实现工具超时或审批超时。
- 不实现完整任务取消调度；取消只在执行边界和底层工具可感知时生效。
- 不实现多 Write 串行编排，由后续 TaskScheduler 负责。
- 不实现 AgentRunner 集成。
- 不实现审批持久化、恢复或 Web 审批界面。
- 写函数开始后若忽略 AbortSignal，Executor 会等待其 Promise 结束；结束前无法
  确认副作用，因此不能安全重试。
- 没有回滚和 exactly-once 保证。

## 9. Step 5 接入建议

Step 5 可在不改变当前状态语义的前提下增加：

1. 审批等待超时：超时前未决定则返回 `cancelled` 或专用等待状态，写函数必须零执行。
2. 工具执行超时：写函数启动后超时必须返回 `unknown`，不能返回 `failed`。
3. 完整 TaskScheduler：读取 Planner 步骤，Read Batch 交给 ReadWorkerPool，
   Write Step 交给 WriteExecutor。
4. Write 必须串行，并在前一个步骤 settle 后再推进。
5. 结果按 `originalIndex` 回填，保持模型原始 Tool Call 顺序。
6. 规划和执行共享 Registry 租约。

本阶段不进入 Step 5。
