# ForgeFlow Phase 1 Development Report

> 状态：Phase 1 验收通过
>
> 范围：Mock Provider、Tool Registry、Agent Loop、STM32F103C8T6 集成场景
> 未包含：Scheduler、Checkpoint、SQLite、MCP、DeepSeek 实际调用、Web Dashboard

## 1. 当前项目架构

```text
User Input
  -> AgentRunner
       -> ToolRegistry.list()
       -> Zod 4 z.toJSONSchema(target: draft-07, io: input)
       -> LLMProvider.generate()
       -> AssistantMessage
       -> ToolRegistry.execute()
       -> ToolMessage(toolCallId)
       -> LLMProvider.generate()
       -> Final Answer
```

主要模块：

| 模块 | 职责 |
|---|---|
| `src/provider/` | 定义 Provider 请求、响应、消息、Tool Call 契约，并提供确定性的 Mock Provider |
| `src/tools/` | 工具声明、注册、查询、注销、Zod 校验、顺序执行和本地 STM32 Demo 工具 |
| `src/agent/` | 驱动模型请求、工具调用、消息回传、预算控制、取消与最终结果 |
| `src/shared/` | 统一错误结构、统一工具命名规则 |
| `src/config/` | 环境变量加载和 Zod 校验 |
| `tests/` | Provider、Registry、Agent Loop 单元测试及 STM32 集成测试 |

依赖方向保持单向：Agent 通过接口依赖 Provider 和 Registry，不依赖具体
DeepSeek SDK，也不依赖 STM32 Demo 数据。

## 2. Agent Loop 执行流程

1. 校验用户目标并构造 System Message 和 User Message。
2. 检查取消信号和 `maxModelTurns`。
3. 将 Tool Registry 的安全元数据转换为模型工具定义。
4. 调用 `LLMProvider.generate()` 并校验响应。
5. 将完整 Assistant Message 追加到消息历史。
6. 若没有 Tool Call，则返回文本答案；空文本按明确失败处理。
7. 若存在 Tool Call，则先检查整批调用是否超出 `maxToolCalls`。
8. 预算足够时，严格按照原始顺序逐个执行。
9. 将每个执行结果构造成 Tool Message，并以 `toolCallId` 关联调用。
10. 再次请求模型，直到得到最终答案、取消或达到预算上限。

一次响应包含多个 Tool Call 时，Assistant Message 只追加一次，其中的
`toolCalls` 数组保持完整和原始顺序。

## 3. 核心接口

### LLMProvider

```ts
interface LLMProvider {
  generate(request: ModelRequest, options?: GenerateOptions): Promise<ModelResponse>;
}
```

`ModelToolDefinition` 使用 DeepSeek/OpenAI-compatible 的 `parameters` 字段。
Agent 使用当前已安装 Zod 4.6.7 的官方 API：

```ts
z.toJSONSchema(schema, {
  target: "draft-07",
  io: "input",
  unrepresentable: "throw",
})
```

没有开启 strict 模式。

### ToolDefinition

```ts
interface ToolDefinition<TInput, TOutput> {
  name: string;
  description: string;
  mode: "read" | "write";
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput): TOutput | Promise<TOutput>;
}
```

工具名统一为最长 64 字符的小写 snake_case，不允许点号。当前业务工具名为
`bom_get_items`、`inventory_lookup`、`component_get_spec`。

### ToolRegistry

- `register(definition)`：注册并校验元数据。
- `get(name)`：返回安全的工具元数据，不暴露原始执行函数。
- `has(name)`、`list()`：查询和获取安全元数据。
- `unregister(name)`：注销工具。
- `execute(name, input)`：执行 Zod 校验后再调用工具函数。

### AgentRunner

```ts
new AgentRunner({
  provider,
  registry,
  model,
  maxModelTurns,
  maxToolCalls,
  systemPrompt,
})
```

`maxModelTurns` 默认 10，统计发起的模型请求次数。`maxToolCalls` 默认 20，
统计模型提出且被 Runtime 接收的 Tool Call 次数，包括无效参数、执行失败和
整批预算拒绝中的调用。

## 4. Tool Call 协议与参数处理

- Tool Call 的 `arguments` 支持对象或 JSON 字符串。
- JSON 字符串只解析一次；已经是对象时不会重复解析。
- JSON 解析失败时生成带 `toolCallId` 的安全失败 Tool Result。
- 解析成功或原本就是对象时，参数最终仍由 Tool Registry 执行 Zod 校验。
- 工具不存在、参数无效或执行异常都会生成带 `toolCallId` 的工具结果，并回传模型。
- 工具执行异常的内部消息和堆栈不会进入模型消息，原始异常保存在服务端
  `AppError.cause` 中。
- 取消和预算控制直接结束 Loop，不会转换为普通工具错误。

## 5. 循环限制与取消

- 模型请求次数达到 `maxModelTurns` 后不再发起下一次请求。
- 单批 Tool Call 数量超过剩余 `maxToolCalls` 时，在执行任何工具前拒绝整批。
- 取消在每次模型请求前和每个工具执行前检查。
- Provider 请求会收到同一个 `AbortSignal`。
- Provider 返回后、响应解析和消息追加前再次检查取消，防止忽略
  `AbortSignal` 的 Provider 将已取消任务推进为完成状态。
- 当前不支持强制中断已经进入同步/异步工具函数内部的工作；只支持执行边界取消。

## 6. 验收后修复记录

### 取消竞态

`AgentRunner` 在 `provider.generate()` 返回后立即检查取消信号。即使 Provider
忽略取消信号并返回正常文本，Agent 也会返回 `cancelled`，不追加 Assistant
Message、不执行工具，也不会返回 `completed`。

对应测试：

- `rechecks cancellation after a provider ignores AbortSignal and returns`

### 工具输出序列化

工具成功返回后，Agent 会先验证输出能否被 `JSON.stringify` 序列化。BigInt、
循环引用、`undefined` 等非 JSON 兼容结果会转换为
`TOOL_OUTPUT_NOT_SERIALIZABLE` 安全工具失败，保留原始 `toolCallId`，并继续
允许模型作出后续决策。

对应测试：

- `converts a BigInt tool output into a correlated safe failure and continues`
- `converts a circular tool output into a correlated safe failure and continues`

### 工具错误暴露边界

`toAgentToolError()` 只转发 Tool Registry 明确定义的公开安全错误：

- `ToolNotFoundError`
- `ToolInputValidationError`
- `ToolExecutionError`

其他任意 `AppError` 或未知异常都降级为通用 `TOOL_EXECUTION_FAILED`。
`ToolRegistry.execute()` 会把工具函数内部抛出的所有异常包装为
`ToolExecutionError`；其公开 message 固定，details 为空，原始异常只保存在
服务端 `cause` 中。Zod 校验错误只提取字段路径和安全 issue 文本，不提取原始
输入值。Tool Result 不序列化 stack 或 cause，因此 API Key、内部异常文本和
堆栈不会进入模型消息。

对应测试：

- `does not expose a sensitive AppError thrown by a tool`

## 7. Phase 1 十二项验收矩阵

| # | 验收项 | 对应测试 | 实际结果 |
|---|---|---|---|
| 1 | Mock Provider 多轮不同响应 | `tests/unit/mock-provider.test.ts`：`returns three scripted responses in order and then reports exhaustion` | 通过 |
| 2 | Tool Registry 注册、查询、注销、执行 | `tests/tools/registry.test.ts`：`registers, queries, lists, unregisters, and executes a tool` | 通过 |
| 3 | Zod 阻止非法参数进入工具函数 | `tests/tools/registry.test.ts`：`blocks invalid input before invoking the tool function` | 通过 |
| 4 | 连续多轮调用不同工具 | `tests/unit/agent-loop.test.ts`：`completes consecutive model turns that request different tools` | 通过 |
| 5 | 多个 Tool Call 按顺序执行 | `tests/unit/agent-loop.test.ts`：`executes multiple calls in order and appends one complete assistant tool-call message` | 通过 |
| 6 | Tool Result 正确匹配 Tool Call ID | 同上，以及 `tests/integration/stm32-f103c8t6.test.ts`：`completes a three-round BOM, inventory, and specification review` | 通过 |
| 7 | 工具失败后 Agent 继续决策 | `tests/unit/agent-loop.test.ts`：`returns a structured tool failure to the model and continues deciding` | 通过 |
| 8 | 模型请求和工具调用均有上限 | `stops before exceeding the model request limit`、`rejects an over-budget tool-call batch before executing any tool` | 通过 |
| 9 | 取消阻止后续执行 | `does not request the model when cancellation is already requested`、`stops between tool calls on cancellation without converting it to a tool error` | 通过 |
| 10 | STM32F103C8T6 完整场景 | `tests/integration/stm32-f103c8t6.test.ts`：`completes a three-round BOM, inventory, and specification review` | 通过 |
| 11 | 全部测试通过 | `pnpm test` | 7 个测试文件、33 个测试全部通过 |
| 12 | 类型检查通过 | `pnpm typecheck` | 通过，无 TypeScript 错误 |

## 8. 特别边界审查

| 边界 | 实现与证据 | 结果 |
|---|---|---|
| 单批 Tool Calls 超过剩余预算 | 在执行循环前累计并比较；超限立即返回 `limit_reached`，工具执行函数调用次数为 0 | 通过 |
| 工具执行异常生成关联结果 | Agent 捕获 Registry 的安全 `AppError`，Tool Message 保留原始 `toolCallId` | 通过 |
| 取消不转成普通工具错误 | 返回 `status: cancelled`，后续工具和模型请求均被阻止 | 通过 |
| Provider 忽略取消并返回 | Provider 返回后立即重查取消，不追加响应、不执行工具 | 通过 |
| 多个 Tool Calls 共用 Assistant Message | 每个模型响应只 push 一次完整 Assistant Message | 通过 |
| Mock Provider 独立请求历史 | `structuredClone` 保存每次请求，读取时再次深拷贝 | 通过 |
| JSON 解析与 Zod 校验 | 字符串只 `JSON.parse` 一次，对象直接传给 Registry，最终都经过 Zod | 通过 |
| JSON Schema 一致性 | `parameters` 与 `z.toJSONSchema(..., { target: "draft-07", io: "input" })` 的完整输出相等 | 通过 |
| 非 JSON 工具输出 | BigInt 和循环引用转换为 `TOOL_OUTPUT_NOT_SERIALIZABLE`，不抛出未处理异常 | 通过 |

## 9. 测试清单与结果

`tests/tools/registry.test.ts`（4 个通过）：

- `registers, queries, lists, unregisters, and executes a tool`
- `rejects duplicate, dotted, and missing tool registrations`
- `blocks invalid input before invoking the tool function`
- `wraps tool execution failures without exposing the internal message`

`tests/integration/stm32-f103c8t6.test.ts`（1 个通过）：

- `completes a three-round BOM, inventory, and specification review`

`tests/unit/mock-provider.test.ts`（5 个通过）：

- `returns a deterministic response and estimated usage`
- `does not perform work after cancellation`
- `returns three scripted responses in order and then reports exhaustion`
- `throws a scripted provider error and can continue with the next step`
- `stores independent request history snapshots`

`tests/unit/agent-loop.test.ts`（17 个通过）：

- `returns a direct final answer without requesting tools`
- `executes multiple calls in order and appends one complete assistant tool-call message`
- `completes consecutive model turns that request different tools`
- `returns a structured tool failure to the model and continues deciding`
- `converts missing, invalid, and malformed JSON tool calls into correlated safe results`
- `parses JSON string arguments once and passes object arguments without parsing`
- `rejects an over-budget tool-call batch before executing any tool`
- `stops before exceeding the model request limit`
- `does not request the model when cancellation is already requested`
- `rechecks cancellation after a provider ignores AbortSignal and returns`
- `stops between tool calls on cancellation without converting it to a tool error`
- `treats empty tool-free responses as a controlled failure`
- `sends draft-07 input JSON Schema as model tool parameters`
- `converts a BigInt tool output into a correlated safe failure and continues`
- `converts a circular tool output into a correlated safe failure and continues`
- `does not expose a sensitive AppError thrown by a tool`
- `reports provider failures directly without creating a tool result`

`tests/unit/config.test.ts`（3 个通过）：

- `defaults to a runnable mock provider without an API key`
- `requires provider credentials for DeepSeek`
- `rejects invalid numeric limits`

`tests/unit/errors.test.ts`（2 个通过）：

- `preserves public application details`
- `does not expose internal error messages`

`tests/unit/health.test.ts`（1 个通过）：

- `reports a ready Mock mode without external credentials`

## 10. 实际命令结果

| 命令 | 结果 |
|---|---|
| `pnpm test` | 7 个测试文件通过，33 个测试通过 |
| `pnpm typecheck` | 通过，无错误 |
| `git diff --check` | 通过；仅有 Git 的 LF/CRLF 转换提示，无空白错误 |
| `pnpm start` | 通过；输出 `status: ok`、`phase: phase-1`、`provider: mock` |

## 11. 已知限制

- 工具调用严格串行，没有只读并行和写入串行调度。
- 尚不支持任务暂停/恢复、Checkpoint 和 SQLite 持久化。
- 取消只保证在模型请求和工具执行边界生效，不能强制停止已经运行的工具。
- 没有 token 预算、上下文压缩、历史摘要和大型工具输出裁剪。
- 没有真实 DeepSeek Adapter、MCP、流式输出或 Dashboard。
- 工具输出必须符合 JSON 兼容数据约定；非兼容输出会安全失败。尚未实现输出大小限制。
- 工具 Schema 转换失败会直接终止当前请求，没有专门的用户可读降级路径。
- Mock Provider 是按脚本回放，不根据请求内容动态决策。

## 12. Phase 2 建议范围

Phase 2 只建议实现 Scheduler 及其验收测试：

1. 连续只读 Tool Calls 形成 Read Batch，最大并发默认 3。
2. Write Tool 形成屏障，必须串行执行。
3. 保持 `read -> write -> read` 的原始顺序语义。
4. 为并发上限、超时、取消和部分失败增加测试。
5. 增加写工具人工批准流程。
6. 暂不引入 SQLite、Checkpoint、MCP 或真实 DeepSeek 调用。

Phase 2 验收应使用执行时间戳证明只读调用重叠、写调用永不重叠，并验证
未批准的写工具不会进入执行函数。
