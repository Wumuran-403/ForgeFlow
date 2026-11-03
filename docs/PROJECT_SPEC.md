# ForgeFlow 项目设计与开发实施文档

> **项目定位：** 面向硬件研发工作流的可恢复 Agent Runtime 作品集项目  
> **英文名称：** ForgeFlow — Resumable Agent Execution Engine  
> **技术主线：** TypeScript / Node.js / DeepSeek API / MCP / SQLite  
> **文档版本：** v1.0  
> **用途：** 作为 Codex（编码代理）实施项目的唯一需求基线；运行时模型可配置为 DeepSeek。

---

## 0. 给开发者的第一条说明

本项目不是“套一个大模型 API 的聊天机器人”，而是实现一个小型、可观察、可恢复的 Agent 执行运行时。所有功能围绕一个清晰的执行循环展开：**接收任务 → 请求模型 → 校验工具调用 → 调度工具 → 持久化状态 → 将结果交还模型 → 继续执行或结束**。

开发时遵循以下原则：

1. **先做可靠的后端内核，再做漂亮的前端。** 第一阶段必须有可运行的 CLI 或 API 演示，Web Dashboard 放到后期。
2. **每次只实现一个阶段。** 不要让 Codex 一次性生成整个系统；每阶段先读文档、列计划、实现、测试、总结，再进入下一阶段。
3. **先用 Mock Provider 测试执行逻辑，再接 DeepSeek。** 这样可以把 Agent 状态机与具体模型供应商解耦，也能避免每次测试都消耗 Token。
4. **任何写操作都必须可控。** 写文件、创建订单草稿等操作默认要求人工批准；MVP 不接真实嘉立创业务系统。
5. **不要伪造评测数字。** 所有成功率、Token 和耗时均从本地测试记录中统计。
6. **不要把 API Key 写进代码、日志、截图或 Git。** 使用 `.env`，并提交 `.env.example`。

### Codex 与 DeepSeek 的职责边界

- **Codex：** 负责编写、修改、测试和解释本项目代码，是开发阶段的编码代理。
- **DeepSeek Runtime Provider：** 是 ForgeFlow 程序运行时调用的模型供应商，负责根据任务上下文生成回复和工具调用。
- 两者配置分开管理。Codex 当前使用的模型/Provider 配置，不等于 ForgeFlow 的 `LLM_*` 运行时环境变量。
- 如果要让 Codex 本身也使用 DeepSeek，应先根据当前安装的 Codex 版本确认其自定义 Provider/API 兼容配置方式；不要假设任意 OpenAI 兼容地址都能直接作为 Codex 后端。

---

## 1. 项目概述

### 1.1 一句话介绍

ForgeFlow 是一个使用 TypeScript / Node.js 开发的轻量级 Agent Runtime，支持多轮 LLM 工具调用、只读并行与写入串行调度、Checkpoint 中断恢复、MCP 工具接入、上下文管理，以及 Token / 工具执行全链路追踪和任务评测。

### 1.2 作品集展示场景

上层 Demo 采用“PCB 生产准备预审”作为模拟业务场景。用户提交一份 BOM 数据和自然语言任务，例如：

> 检查这份 PCB 项目的 BOM：核对字段完整性、查询元器件库存、检查规格信息，汇总缺料和风险，并生成生产准备报告。未经我批准，不要执行任何写入操作。

Agent 可以调用以下模拟工具：

| 工具 | 类型 | 示例能力 |
|---|---|---|
| `bom.inspect` | 只读 | 读取 BOM、检查必填字段、统计器件数量 |
| `inventory.search` | 只读 | 查询本地模拟库存、交期和库存状态 |
| `part.check_spec` | 只读 | 检查封装、参数、制造商料号等字段 |
| `report.generate` | 写入 | 生成 Markdown / JSON 预审报告 |
| `order.create_draft` | 写入 | 创建本地模拟订单草稿，不提交真实订单 |

**边界声明：** 上述数据和工具均为本地模拟数据，仅用于展示 Agent 工程能力。项目不是嘉立创官方产品，不调用或假冒嘉立创内部 API，不使用其商标或暗示存在官方合作。

### 1.3 项目目标

- 做出一个可独立运行的 Agent 执行内核，而非只展示提示词。
- 通过代码证明工具调用循环、调度、恢复、MCP 和上下文工程的理解。
- 通过事件日志和评测用例证明系统行为可观察、可复现。
- 做出一个 3–5 分钟可完整演示的业务 Demo。
- 形成适合 GitHub 展示和面试讲解的 README、架构图、测试报告与技术调研记录。

### 1.4 非目标（MVP 不做）

- 不实现完整 PCB 设计、EDA 编辑、Gerber 解析或真实生产下单。
- 不接企业内部库存、ERP、订单或用户数据。
- 不做复杂多 Agent 自组织协作；先把单 Agent Runtime 的执行语义做好。
- 不追求兼容所有模型供应商；先实现一个 OpenAI-compatible Provider Adapter 和一个 Mock Provider。
- 不在第一阶段做分布式队列、Kubernetes、多租户计费和复杂权限系统。

---

## 2. 用户流程与核心演示

### 2.1 正常执行流程

1. 用户创建任务，输入 BOM 样例和检查目标。
2. Runtime 创建 `task`，初始化消息、预算与状态。
3. Provider 请求模型；模型返回自然语言内容或一个/多个 Tool Calls。
4. Tool Registry 检查工具是否存在、参数是否通过 Zod 校验、权限是否满足。
5. Scheduler 根据工具读写属性分批执行：连续只读工具并行，写入工具串行；写入前执行人工批准检查。
6. 每个工具执行前后记录 Tool Run，并保存 Checkpoint。
7. 工具结果加入对话，Runtime 再次请求模型。
8. 模型给出最终答复后，任务状态改为 `completed`，生成指标与事件记录。

### 2.2 必须录制的四个演示

| Demo | 操作 | 面试官应看到的证据 |
|---|---|---|
| A. 多轮工具调用 | 一项任务触发 3–5 次工具调用 | 每轮模型请求、Tool Call 参数、工具结果、最终答复 |
| B. 并行/串行调度 | 两个以上只读查询 + 两个写入动作 | 只读任务并发执行；写操作按顺序执行；写操作需批准 |
| C. 中断恢复 | 执行中暂停或强制终止服务，再重启恢复 | 从最近 Checkpoint 继续；已完成的安全步骤不重复执行；不确定写操作进入人工核对 |
| D. 可观测性 | 打开任务详情与评测页 | Token、耗时、重试、失败原因、工具调用轨迹、任务成功率 |

### 2.3 推荐演示数据

仓库内提供 `examples/sample-bom.csv` 和本地模拟库存数据。字段可包含：`designator`、`part_number`、`manufacturer`、`footprint`、`quantity`、`description`。测试数据至少覆盖：字段缺失、库存不足、器件规格不匹配、可替代料候选、正常通过等情况。

---

## 3. 功能需求

### 3.1 Agent Core（必须）

- 支持创建任务、初始化 system prompt 和 user message。
- 支持模型返回文本、Tool Calls、结束标记。
- 支持多轮工具调用循环，直到模型结束、预算耗尽、达到最大轮数或触发保护策略。
- 保存消息序列，保证工具调用消息与工具结果按协议配对。
- 每个任务具有 `maxIterations`、`maxToolCalls`、`tokenBudget` 和 `timeoutMs`。
- 使用 Provider Adapter 隔离模型 SDK；业务逻辑不得直接依赖 DeepSeek SDK 的私有响应结构。

### 3.2 Tool Registry（必须）

每个工具声明：名称、描述、Zod 输入 Schema、读写模式、幂等属性、是否需要人工批准、超时时间、执行函数。

- 工具参数必须通过 Schema 校验后才能执行。
- 未注册工具、参数校验失败、权限不足时，不得调用执行函数。
- 工具输出需有大小限制；错误以结构化结果返回，不能把堆栈和密钥暴露给模型。
- 工具名采用稳定命名，例如 `inventory.search`，不要在代码中散落字符串常量。

### 3.3 Task Scheduler（必须）

- `read` 工具可以并行执行，并发上限默认 3，可配置。
- `write` 工具必须串行执行，不能和另一个写工具同时运行。
- 调度必须保留模型返回的工具调用顺序语义：**连续只读调用组成一个并行批次；遇到写调用先等待前一批只读完成，再串行执行写调用；写调用之后的新只读调用必须等写调用完成后再执行。**
- 以上规则避免把读写混成一个不确定的并发批次。
- 对工具超时、失败和取消统一处理；失败是否重试取决于工具幂等属性和错误类型。
- `requiresApproval=true` 的写工具进入 `awaiting_approval`，由用户批准后才执行。

示例：模型顺序返回 `[read A, read B, write C, read D, write E]`，执行顺序为：`A/B 并行 → C 串行 → D → E 串行`。

### 3.4 Checkpoint Engine（必须）

在以下时点保存 Checkpoint：

- 任务创建完成后；
- 每次模型响应解析完成后（尤其是待执行 Tool Calls 已生成时）；
- 每个工具开始前和执行结果落库后；
- 任务暂停、等待人工批准、恢复、完成或失败时。

Checkpoint 至少包含：任务状态、消息历史、当前迭代次数、待执行 Tool Calls、已完成步骤标识、Token 统计、预算配置、最后事件序号。

恢复策略：

- 只恢复有明确持久化证据的状态。
- 对 `read` 工具，若工具执行中断，默认可按工具策略重新执行。
- 对非幂等 `write` 工具，若进程在执行结果落库前崩溃，状态标记为 `unknown`，不能盲目自动重试；需要工具的幂等键/查询确认能力，或人工核对。
- 不承诺外部副作用的 exactly-once；通过幂等键、状态记录和人工确认尽量避免重复副作用。

### 3.5 Context Manager（必须）

- 维护 system prompt、当前目标、工具定义、最近消息、摘要和预算信息。
- 对较大的工具输出做裁剪/摘要，原始结果可保存在数据库或文件中，消息中只放摘要和引用 ID。
- 不允许为节省 Token 而删除当前任务目标、最近一轮工具结果、待执行调用或必要的安全约束。
- 首版实现简单的消息窗口和工具结果长度上限；之后再加历史摘要。
- Provider 有返回 Token usage 时使用真实值；否则用明确标记为估算的字符/Token 近似值，不混淆真实与估算数据。

### 3.6 MCP 接入（必须）

- ForgeFlow Runtime 作为 MCP Client，能够连接一个本地 MCP Server，读取工具列表并调用工具。
- 第一版优先支持本地 `stdio` 传输；后续可扩展 Streamable HTTP。
- 对 MCP 工具统一映射为内部 Tool Definition，复用 Registry、权限检查、调度、事件记录与 Checkpoint。
- Demo 提供一个 `demo-mcp-server`，暴露只读的库存和器件查询工具。
- MCP 工具的读写属性、风险级别、是否需要批准由 ForgeFlow 侧配置，不盲目信任外部 Server 的描述。

### 3.7 Observability 与 Evaluation（必须）

- 为每个任务生成 `traceId`，事件包含 `taskId`、`traceId`、时间、事件类型和关联 ID。
- 记录模型请求耗时、Token usage、工具耗时、工具状态、重试、暂停/恢复和失败原因。
- 提供任务事件时间线，以及聚合指标。
- Evaluation 使用固定的离线任务集；每次变更后可重复运行。
- 至少统计 Task Success Rate、Tool Call Accuracy、Recovery Success Rate、Duplicate Execution Rate、Average Latency、Token Consumption。
- 指标必须从真实运行数据计算；测试集、样本数和统计口径写入报告。

---

## 4. 系统架构

### 4.1 分层架构

| 层 | 主要职责 | 关键组件 |
|---|---|---|
| Interface | CLI / REST API / Web Dashboard | Fastify routes、后期 React UI |
| Runtime | 驱动完整 Agent 生命周期 | AgentRunner、RunController |
| Core | 消息、状态、循环保护和策略 | Agent Core、Loop Guard、Context Manager |
| Tooling | 工具声明、校验、权限、执行 | Tool Registry、Tool Executor、MCP Client |
| Scheduling | 按读写属性与顺序调度 | Task Scheduler、Concurrency Limiter |
| Persistence | 状态、Checkpoint、事件和指标 | SQLite Repository |
| Observability | Trace、日志、指标和评测 | Event Store、Metrics、Evaluation Runner |
| Provider | 模型供应商适配 | MockProvider、DeepSeekProvider |

### 4.2 模块依赖原则

- `agent-core` 只依赖抽象接口，不直接依赖 Fastify、SQLite 或具体模型 SDK。
- `scheduler` 通过 Tool Registry 提供的工具元数据执行，不自行解析模型原始响应。
- `checkpoint` 只负责状态持久化与恢复，不决定 Agent 下一步推理。
- `observability` 订阅统一事件，不侵入业务代码，不在日志中记录密钥。
- `deepseek-provider` 只实现 Provider 接口；替换供应商不需要重写 Agent Loop。

### 4.3 运行时执行循环

```text
createTask(input)
  -> persist initial state + checkpoint
  -> while task is running:
       check cancellation / timeout / budget / loop guard
       build context within token budget
       provider.generate(messages, toolDefinitions)
       persist model response + usage + checkpoint
       if response has no tool calls:
           mark task completed; persist final answer
           break
       validate tool calls with registry and schemas
       scheduler.execute(toolCalls)
       for each tool result:
           persist tool run + event + checkpoint
           append tool result message
  -> return task summary + trace
```

### 4.4 状态机

**Task 状态：** `queued` → `running` → `completed | failed | cancelled`；运行中也可以进入 `paused` 或 `waiting_approval`，之后由用户恢复或批准。

**Tool Run 状态：** `queued` → `running` → `succeeded | failed | interrupted | unknown | awaiting_approval | skipped`。

状态转换必须集中管理并有单元测试，避免在不同路由中随意修改状态字段。

---

## 5. 核心数据结构与接口草案

以下是接口设计基线。Codex 可以在实现中微调字段名，但不得随意改变核心语义。

### 5.1 核心类型

```ts
export type ToolMode = "read" | "write";

export type TaskStatus =
  | "queued" | "running" | "paused" | "waiting_approval"
  | "completed" | "failed" | "cancelled";

export type ToolRunStatus =
  | "queued" | "running" | "succeeded" | "failed"
  | "interrupted" | "unknown" | "awaiting_approval" | "skipped";

export interface ToolExecutionContext {
  taskId: string;
  traceId: string;
  signal: AbortSignal;
  idempotencyKey: string;
  workingDirectory: string;
}

export interface ToolDefinition<TInput = unknown> {
  name: string;
  description: string;
  mode: ToolMode;
  inputSchema: import("zod").ZodType<TInput>;
  idempotent: boolean;
  requiresApproval: boolean;
  timeoutMs: number;
  execute(input: TInput, context: ToolExecutionContext): Promise<unknown>;
}

export interface ModelUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  source: "provider" | "estimated" | "unknown";
}

export interface ModelRequest {
  model: string;
  messages: AgentMessage[];
  tools: ModelToolDefinition[];
  temperature?: number;
}

export interface ModelResponse {
  message: AssistantMessage;
  usage: ModelUsage;
  finishReason?: string;
  requestId?: string;
}

export interface LLMProvider {
  generate(request: ModelRequest, options?: { signal?: AbortSignal }): Promise<ModelResponse>;
}
```

### 5.2 Tool 元数据

工具元数据至少包括：

- `name`：稳定唯一名称；
- `description`：给模型看的简洁说明；
- `mode`：`read` / `write`；
- `inputSchema`：Zod Schema；
- `idempotent`：同一请求重复执行是否安全；
- `requiresApproval`：执行前是否等待用户批准；
- `timeoutMs`：执行超时；
- `execute`：实际业务逻辑。

### 5.3 Agent Runner 伪代码

```ts
async function runTask(taskId: string, signal: AbortSignal) {
  let state = await taskRepository.loadLatestState(taskId);

  while (state.status === "running") {
    guard.check(state);
    const context = contextManager.build(state);
    const response = await provider.generate(context.request, { signal });
    state = await checkpoint.saveModelResponse(state, response);

    const calls = response.message.toolCalls ?? [];
    if (calls.length === 0) {
      return taskService.complete(taskId, response.message.content);
    }

    const results = await scheduler.execute(calls, state, signal);
    state = await taskService.appendToolResults(state, results);
    await checkpoint.save(state);
  }

  return taskRepository.getSummary(taskId);
}
```

伪代码用于表达职责，不是可直接复制的完整实现。异常、暂停、人工批准和崩溃恢复必须在正式实现中处理。

---

## 6. 调度策略设计

### 6.1 读写分类

- **Read：** 读取 BOM、查询库存、查询器件规格、读取文件、搜索资料等无副作用操作。
- **Write：** 写入文件、创建草稿、修改配置、提交表单等会产生副作用的操作。

工具作者必须显式声明 `mode`，不能让模型自行决定工具属于读还是写。

### 6.2 调度算法

遍历模型返回的 Tool Calls，按原顺序切分为连续的 Read 批次与单独的 Write 屏障：

1. 遇到 Read：加入当前 Read Batch。
2. 遇到 Write：先等待当前 Read Batch 全部结束，再等待批准，然后单独执行该 Write。
3. 遇到后续 Read：开始新的 Read Batch。
4. 整个调用列表结束后，等待最后一个 Read Batch。

Read Batch 内使用 `Promise.allSettled`，并通过并发限制器控制最大并发数。每个调用单独记录结果，部分失败不应丢失其他调用的成功结果。

### 6.3 调度验收用例

输入序列：`R1, R2, W1, R3, W2`。

预期：R1/R2 时间重叠；W1 在 R1/R2 结束后开始；R3 在 W1 完成后开始；W2 在 R3 完成后开始。整个过程中同时运行的 Write 数量永远不超过 1。

---

## 7. Checkpoint、暂停与恢复

### 7.1 Checkpoint 粒度

Checkpoint 是可序列化的 Agent 状态快照，不是简单保存聊天记录。至少包含：

```ts
interface AgentCheckpointState {
  taskId: string;
  status: TaskStatus;
  iteration: number;
  messages: AgentMessage[];
  pendingToolCalls: ToolCall[];
  completedToolRunIds: string[];
  tokenUsage: ModelUsage;
  budget: { maxIterations: number; maxToolCalls: number; maxTokens: number };
  lastEventSequence: number;
  updatedAt: string;
}
```

### 7.2 恢复步骤

1. 加载任务最新的有效 Checkpoint。
2. 检查最近未完成的 Tool Runs。
3. 对只读工具的 `interrupted` 状态，按工具策略安全重试。
4. 对写工具的 `unknown` 状态，不自动执行；优先查询幂等键对应的操作是否已成功，否则等待人工确认。
5. 恢复消息历史、迭代次数、预算和事件序号。
6. 将任务状态改为 `running` 并继续执行。

### 7.3 暂停与取消的区别

- `pause`：不再启动新工具；正在执行的工具根据 AbortSignal 与可中断能力安全停止，保存状态后进入 `paused`。
- `cancel`：用户明确放弃任务；停止后续步骤，记录取消原因，状态为 `cancelled`。
- `waiting_approval`：任务不是失败，也不是暂停；它在等待用户对某个写入动作作出决定。

### 7.4 崩溃窗口处理

在调用外部写操作之前先落库 `running` 状态与幂等键。若恢复时发现该写操作仍为 `running`，将其转为 `unknown` 并进行核对；没有幂等/查询能力时必须让用户确认，不能自动再执行一次。这是面试中值得重点解释的可靠性设计。

---

## 8. 持久化设计（SQLite）

MVP 使用 SQLite，开启外键约束和 WAL 模式。数据库迁移要版本化，不要在启动时无条件删除或重建数据库。

| 表 | 关键字段 | 用途 |
|---|---|---|
| `tasks` | `id, status, objective, created_at, updated_at` | 任务主记录与当前状态 |
| `checkpoints` | `id, task_id, sequence, state_json, created_at` | 不可变状态快照 |
| `tool_runs` | `id, task_id, call_id, tool_name, mode, status, input_json, output_json, idempotency_key` | 工具执行状态与结果 |
| `model_calls` | `id, task_id, iteration, model, prompt_tokens, completion_tokens, duration_ms, status` | 模型调用统计 |
| `events` | `id, task_id, sequence, type, payload_json, created_at` | 任务事件时间线 |
| `approvals` | `id, task_id, tool_run_id, status, decided_at` | 人工批准记录 |
| `eval_runs` | `id, suite_name, started_at, finished_at, summary_json` | 评测运行摘要 |

约束建议：

- `checkpoints(task_id, sequence)` 唯一。
- `events(task_id, sequence)` 唯一。
- `tool_runs.idempotency_key` 建唯一索引（允许为空时按 SQLite 规则处理）。
- JSON 字段必须进行运行时校验；不要假设数据库中的 JSON 永远可信。
- API Key 不进入任何表。

---

## 9. API 设计（MVP）

| 方法 | 路径 | 作用 |
|---|---|---|
| `POST` | `/api/tasks` | 创建任务并开始执行或返回任务 ID |
| `GET` | `/api/tasks` | 查询任务列表 |
| `GET` | `/api/tasks/:id` | 查询任务状态与结果摘要 |
| `GET` | `/api/tasks/:id/events` | 获取事件时间线（首版可用轮询） |
| `POST` | `/api/tasks/:id/pause` | 暂停任务 |
| `POST` | `/api/tasks/:id/resume` | 恢复任务 |
| `POST` | `/api/tasks/:id/cancel` | 取消任务 |
| `POST` | `/api/approvals/:id/approve` | 批准待执行写工具 |
| `POST` | `/api/approvals/:id/reject` | 拒绝待执行写工具 |
| `GET` | `/api/metrics/summary` | 查询聚合指标 |
| `POST` | `/api/evals/run` | 执行固定评测集 |

API 返回统一结构：`{ data, error, requestId }`。错误响应不得泄露堆栈、密钥或本地绝对路径。异步任务接口应立即返回 `taskId`，前端通过查询接口获取进度。

---

## 10. DeepSeek Provider 配置

### 10.1 配置原则

使用 Provider Adapter 隔离供应商；运行时通过环境变量配置：

```dotenv
LLM_PROVIDER=deepseek
LLM_BASE_URL=https://api.deepseek.com
LLM_API_KEY=replace_me
LLM_MODEL=replace_with_available_model_id
LLM_TIMEOUT_MS=60000
LLM_MAX_RETRIES=2
```

模型 ID 以你当前 DeepSeek 账户/API 文档中可用的名称为准，放在环境变量里，不要散落在代码中。请求结构尽量使用 OpenAI-compatible Chat Completions 风格，但必须验证当前所选模型是否支持工具调用以及对应参数格式。

### 10.2 Provider 实现要求

- 实现统一的 `LLMProvider` 接口。
- 处理超时、限流、网络失败和 API 错误；只对可安全重试的错误重试。
- 记录 Provider 返回的 Token usage、模型名称、请求耗时和 request ID（如可用）。
- 不记录 Authorization Header、API Key 或完整敏感提示词。
- 对工具调用参数进行 JSON 解析和 Zod 二次校验。
- Mock Provider 必须能按预设脚本返回多轮 Tool Calls，用于确定性测试。

### 10.3 DeepSeek 与 Codex 不要混淆

`.env` 中的 `LLM_API_KEY` 只供 ForgeFlow 运行时使用。Codex 自身的模型配置由 Codex 客户端管理，单独配置、单独保密。开发中即使 Codex 使用 DeepSeek，也不能把 Codex 的内部配置或密钥复制进项目仓库。

---

## 11. MCP 设计

### 11.1 最小目标

ForgeFlow 作为 MCP Client 连接本地 Demo MCP Server，完成：

1. 初始化连接；
2. 获取 Tools List；
3. 把 MCP Tool 转成内部 Tool Definition；
4. 统一执行、记录结果并加入 Agent 对话；
5. 断开连接、超时与异常时提供明确错误。

### 11.2 安全策略

- MCP Server 来源需要显式配置，不自动连接未知 Server。
- 外部 MCP 工具默认视为不可信输入；输出按长度上限裁剪并做结构化处理。
- `write` 工具必须由本地策略显式标注并要求批准。
- 本地 `stdio` Server 只能启动配置允许的命令，不允许模型自行拼接 shell 命令。
- 后续支持 HTTP 传输时要增加来源校验、认证和访问控制。

---

## 12. Loop Guard 与成本控制

这是项目的差异化模块之一。它不仅限制最大迭代数，还主动检测重复工具调用和无效循环。

### 12.1 首版检测规则

- **完全重复调用：** 对 `toolName + canonicalizedArguments` 生成签名；同一签名连续重复达到阈值（默认 3 次）则暂停并记录 `loop_detected`。
- **短周期循环：** 最近 N 次调用出现 A→B→A→B 的重复模式时触发告警；首版可以只告警或暂停，不自动篡改模型计划。
- **无进展重试：** 同一工具连续失败且参数不变，达到上限后停止重试。
- **预算保护：** 达到最大轮数、最大工具数、Token 预算或总耗时后停止，并说明停止原因。

### 12.2 设计约束

- Loop Guard 先采用“检测 + 暂停 + 给出原因”的保守策略，不擅自删除工具调用或伪造工具结果。
- 每次触发都记录签名、重复次数、策略阈值和触发事件。
- 统计 Loop Detection Rate、误报案例和被拦截的重复调用数。

---

## 13. 可观测性与效果评测

### 13.1 事件类型

建议统一事件：`task.created`、`task.started`、`llm.requested`、`llm.responded`、`tool.queued`、`tool.started`、`tool.succeeded`、`tool.failed`、`tool.awaiting_approval`、`checkpoint.saved`、`task.paused`、`task.resumed`、`loop.detected`、`task.completed`、`task.failed`。

### 13.2 指标口径

| 指标 | 计算口径 |
|---|---|
| Task Success Rate | 成功完成任务数 / 有效评测任务数 |
| Tool Call Accuracy | 正确工具与参数的调用数 / 评测中应调用工具总数 |
| Recovery Success Rate | 成功恢复并完成的中断任务数 / 可恢复中断任务数 |
| Duplicate Execution Rate | 被识别的重复副作用执行次数 / 写工具执行次数 |
| Average Latency | 任务创建到完成的平均耗时；同时报告 P50/P95 更好 |
| Token Consumption | 模型返回 usage 的 Token 总量；估算值必须单列 |
| Loop Detection Rate | 被 Loop Guard 命中的测试循环数 / 测试集中的循环样本数 |

### 13.3 测试集

建议准备 30 个固定任务：10 个正常检查、5 个字段缺失、5 个库存不足、5 个规格不匹配、5 个循环/失败/中断恢复任务。样本规模可以逐步扩充。每次评测保存版本号、模型 ID、提示词版本、数据集版本、运行时间和统计结果。

**不要在 README 或简历中提前写“节省 40% Token”之类未经测试的数据。** 可以先写“实现 Token 统计和重复调用检测”，实际测出数据后再补充。

---

## 14. 技术栈与依赖建议

### 14.1 推荐技术栈

| 类别 | 选择 | 用途 |
|---|---|---|
| Runtime | Node.js LTS + TypeScript | 主运行环境 |
| Package Manager | pnpm | 依赖与脚本管理 |
| HTTP | Fastify | REST API |
| Validation | Zod | API、工具参数、配置校验 |
| Persistence | SQLite + `better-sqlite3` | 任务、Checkpoint、事件存储 |
| LLM | OpenAI-compatible SDK / HTTP adapter | 调用 DeepSeek API |
| MCP | 官方 MCP TypeScript SDK | MCP Client / Demo Server |
| Logging | Pino（或 Fastify 内置 Logger） | 结构化日志 |
| Testing | Vitest | 单元、集成和评测用例 |
| UI（后期） | React + Vite | Dashboard |
| Telemetry（后期） | OpenTelemetry JS | 标准化 Trace / Metrics |

依赖安装前，要求 Codex 检查 Node.js、pnpm 和相关 SDK 当前官方文档，选择兼容版本；不要在文档中复制可能过时的固定版本号或旧版 MCP API。

### 14.2 首期依赖建议

```bash
pnpm add fastify zod dotenv better-sqlite3 pino openai
pnpm add -D typescript tsx vitest @types/node
```

MCP 依赖应在 MCP 阶段按官方当前安装文档添加，确认使用的 SDK 主版本及导入路径。前端与 OpenTelemetry 依赖推迟到对应阶段，不要一开始就安装所有依赖。

---

## 15. 推荐项目目录

首版用单仓库、单 TypeScript 应用，避免过早拆分 Monorepo：

```text
forgeflow/
├─ docs/
│  ├─ PROJECT_SPEC.md
│  ├─ ARCHITECTURE.md
│  ├─ OPEN_SOURCE_RESEARCH.md
│  └─ EVALUATION.md
├─ examples/
│  ├─ sample-bom.csv
│  └─ inventory.json
├─ src/
│  ├─ api/                 # Fastify 路由与 DTO
│  ├─ agent/               # AgentRunner、消息和状态机
│  ├─ provider/             # LLMProvider、Mock、DeepSeek Adapter
│  ├─ tools/                # Tool Registry 和业务模拟工具
│  ├─ scheduler/             # Read/Write 调度与并发限制
│  ├─ checkpoint/            # 快照、恢复、暂停与恢复服务
│  ├─ context/               # 上下文预算与摘要
│  ├─ mcp/                   # MCP Client 与 Demo Server
│  ├─ loop-guard/            # 重复调用和无效循环检测
│  ├─ storage/               # SQLite、迁移和 Repository
│  ├─ observability/         # Event、Trace、Metrics
│  ├─ evaluation/            # 固定评测集与评测运行器
│  ├─ config/                # 环境变量和配置校验
│  └─ index.ts
├─ tests/
│  ├─ unit/
│  ├─ integration/
│  └─ fixtures/
├─ data/                     # 本地数据库与输出；加入 .gitignore
├─ .env.example
├─ .gitignore
├─ package.json
├─ pnpm-lock.yaml
├─ tsconfig.json
├─ README.md
└─ AGENTS.md                 # Codex 项目级约定
```

如果后期前端变大，再拆为 `apps/server`、`apps/web` 和 `packages/*`；不要为了目录看起来“高级”而提前引入复杂构建系统。

---

## 16. 分阶段开发计划

### Phase 0：工程骨架与开发规范

**工作项**
- 初始化 Git、pnpm、TypeScript、Vitest；
- 建立目录、配置加载、统一错误结构和 `.env.example`；
- 写入 `AGENTS.md`，约定 Codex 先读文档、分阶段开发、每次改动运行测试；
- 完成健康检查 API 或简单 CLI。

**验收**：`pnpm test` 可运行；`pnpm dev` 可启动；没有真实密钥也可以运行 Mock 模式。

### Phase 1：Agent Core + Mock Provider + Tool Calling Loop

**工作项**
- 定义消息、Provider、Tool、Task 类型；
- 实现 Mock Provider 脚本模式；
- 实现 Tool Registry、Zod 参数校验；
- 完成基本 Agent Loop 和轮数/工具数上限；
- 实现 `bom.inspect`、`inventory.search`、`part.check_spec` 三个只读模拟工具。

**验收**：一个固定任务能够进行至少 3 轮模型/工具往返，输出结构化结果；错误工具名和错误参数被拦截；全流程由自动化测试覆盖。

### Phase 2：Scheduler（只读并行、写入串行）

**工作项**
- 实现工具读写模式；
- 实现连续 Read Batch 并发执行；
- 实现 Write Barrier 和写入串行；
- 实现并发上限、超时、取消和结果隔离；
- 增加写工具人工批准流程。

**验收**：调度测试证明只读重叠、写操作不重叠、顺序屏障正确，未批准写工具不会执行。

### Phase 3：SQLite + Checkpoint + Resume

**工作项**
- 实现数据库迁移与 Repository；
- 保存任务、事件、Tool Runs、Model Calls 和 Checkpoints；
- 实现 pause / resume / cancel；
- 实现进程重启后的恢复；
- 实现非幂等写操作的 `unknown` 状态和人工核对路径。

**验收**：任务执行中关闭进程，再启动可以恢复；已完成只读步骤不会无故重复；不确定写操作不会盲目重复执行。

### Phase 4：DeepSeek Provider + Context Manager + Loop Guard

**工作项**
- 接入可配置 DeepSeek Provider；
- 实现超时、限流和安全重试；
- 实现上下文预算、工具结果裁剪和真实/估算 Token 分层；
- 实现重复调用签名、短周期循环检测和预算保护。

**验收**：Mock 与 DeepSeek 使用同一套 Agent Core；模型工具调用可以实际跑通；达到循环阈值时任务按策略暂停并留下事件。

### Phase 5：MCP Client + Demo MCP Server

**工作项**
- 按官方当前 MCP SDK 文档实现 Client；
- 实现本地 `stdio` Demo Server；
- 将 MCP 工具映射到内部 Registry；
- MCP 工具复用权限、调度、Trace 和 Checkpoint。

**验收**：Runtime 能发现并调用 MCP 库存查询工具，事件时间线中可追踪完整调用。

### Phase 6：Observability + Evaluation + Web Dashboard

**工作项**
- 聚合 Token、耗时、错误、调用数和恢复指标；
- 执行固定 Evaluation Suite，保存报告；
- 使用 React + Vite 制作任务列表、详情时间线、批准面板和评测页；
- 完善 README、架构图、演示脚本和录屏。

**验收**：完成 3–5 分钟演示；别人按照 README 可以在本地启动；评测数据能从数据库重新计算。

---

## 17. 全局验收标准

最终提交前逐项检查：

- [ ] TypeScript 严格模式开启，无关键类型逃逸；
- [ ] Mock Provider 下可离线运行完整演示；
- [ ] DeepSeek Provider 可通过 `.env` 配置，密钥不进入仓库；
- [ ] 至少 3 轮 Tool Calling Loop 正常工作；
- [ ] Read 并发、Write 串行及批准机制有自动化测试；
- [ ] Checkpoint 可持久化，服务重启后可恢复；
- [ ] 非幂等写操作不自动盲重试；
- [ ] MCP Client 能调用 Demo MCP Server；
- [ ] Loop Guard 能识别重复调用并记录事件；
- [ ] 每次模型和工具调用都能关联到 task / trace；
- [ ] Token usage 区分 Provider 真实值与估算值；
- [ ] Evaluation 有固定数据集、统计口径和可复现报告；
- [ ] README 有安装、配置、启动、测试、演示和架构说明；
- [ ] 没有真实用户数据、真实业务凭证或未经授权的外部系统连接。

---

## 18. Codex 协作规则（建议写入 AGENTS.md）

1. 开始任务前先阅读根目录 `README.md`、`docs/PROJECT_SPEC.md` 和 `AGENTS.md`。
2. 一次只实现用户明确指定的 Phase 或一个小功能，不跨阶段堆代码。
3. 实施前先输出：当前理解、将修改的文件、接口/数据结构变化、测试计划和风险。
4. 尽量先写测试，再写实现；每个公共接口都要有输入校验和错误处理。
5. 未经用户明确要求，不要安装大批新依赖、不升级无关依赖、不删除数据文件。
6. API Key 只能从环境变量读取；禁止输出密钥、Authorization Header 或 `.env` 内容。
7. 不要将真实写操作接到外部业务系统；Demo 写入仅落本地数据库或沙箱文件。
8. 每阶段结束运行 lint（如已配置）、类型检查和测试，报告实际命令与结果；未运行的测试不得声称通过。
9. 发现需求冲突或 SDK API 与文档不一致时，先查当前官方文档并提出最小改动方案，不要猜测 API。
10. 保持代码可读，优先清晰的函数和接口，不为展示架构而过度抽象。

---

## 19. 给 Codex 的首轮启动指令

将下面这段作为 Codex 的第一条任务指令：

```text
你将协助我开发 ForgeFlow，一个 TypeScript / Node.js Agent Runtime 项目。
请先完整阅读 docs/PROJECT_SPEC.md 和根目录 AGENTS.md（若文件尚不存在，请根据项目文档创建）。

开发规则：
1. 不要一次性实现全部项目，严格按 Phase 0 → Phase 6 分阶段推进。
2. 当前先执行 Phase 0，并为 Phase 1 做必要的接口预留；不要提前实现 MCP、Web Dashboard 或复杂可观测性。
3. 在写代码前先检查当前目录、Node.js、pnpm 版本和已有文件，避免覆盖用户现有内容。
4. 先给出 Phase 0 的实施计划、拟新增/修改文件列表和测试计划；然后完成 Phase 0。
5. 使用 TypeScript strict mode、Zod 校验、Vitest；运行时模型 Provider 必须可替换，先提供 Mock Provider。
6. 所有依赖版本与 SDK API 以当前官方文档为准，不要照抄过时示例。
7. 不要把 API Key 写入代码或日志；只创建 .env.example，不创建带真实密钥的 .env。
8. 完成后运行类型检查和测试，并如实报告命令、结果、遗留问题及下一阶段建议。

请用中文解释架构与实现决策，代码命名使用清晰的英文。现在先检查项目目录并开始 Phase 0。
```

---

## 20. 面试讲解主线

建议面试时按照下面顺序讲，不要从“我用了什么框架”开始：

1. **问题：** 简单 Agent Demo 缺少可靠的执行控制，工具调用可能重复、任务可能中断、写操作可能产生副作用，也缺少可量化的观测数据。
2. **设计：** 把模型决策和执行控制分离，模型负责提出 Tool Calls，Runtime 负责校验、权限、调度、持久化与恢复。
3. **关键难点：** Read/Write 调度语义、Checkpoint 粒度、非幂等写操作崩溃窗口、MCP 工具权限边界、上下文预算和循环检测。
4. **工程证据：** 展示自动化测试、事件时间线、崩溃恢复演示、调度时间戳和评测报告。
5. **复盘：** 说明当前 MVP 的限制、尚未实现的分布式能力，以及下一步如何扩展。

简历描述必须以真实完成情况为准。项目尚未完成时，不要把计划中的功能写成已经实现。

---

## 21. 推荐交付物清单

最终 GitHub 仓库至少包含：

- `README.md`：项目介绍、架构图、功能、安装与 Demo；
- `docs/PROJECT_SPEC.md`：本项目需求与设计基线；
- `docs/OPEN_SOURCE_RESEARCH.md`：对 Claude Code、OpenCode、Gemini CLI、Pi Agent 的对比调研；
- `docs/ARCHITECTURE.md`：模块关系和状态机；
- `docs/EVALUATION.md`：测试集、指标口径和实际结果；
- `examples/`：可公开的 BOM 与模拟库存数据；
- `tests/`：单元、集成、恢复与调度测试；
- `demo/` 或录屏：演示脚本与截图。

**完成标准不是代码行数，而是：别人能运行、能看懂、能复现测试，并能通过演示验证关键工程能力。**
