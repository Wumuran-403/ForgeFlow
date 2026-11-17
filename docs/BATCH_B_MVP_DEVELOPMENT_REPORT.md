# ForgeFlow Portfolio MVP Batch B Development Report

> 状态：Batch B 验收通过，Batch B.1 真实 DeepSeek Smoke Test 通过
> 日期：2026-11-09
> 范围：Real DeepSeek Provider + STM32 BOM Agent Demo + CLI

## 1. 交付摘要

Batch B 已完成以下交付：

1. 基于现有 `LLMProvider` 抽象实现真实 DeepSeek Provider。
2. 提供 STM32F103C8T6 开发板 BOM、库存、短缺分析、审批写和回读确认 Demo。
3. 提供离线 Mock 和真实 DeepSeek 两种 CLI 启动方式。
4. 保持 SQLite 持久化、Task Lease、Fencing、Read/Write Scheduler 和 Write Approval 链路。
5. 增加模型调用和工具调用上限，避免无限循环。
6. 完成定向测试、全量测试、TypeCheck 和 diff 检查。

真实 DeepSeek API 调用已在 Batch B.1 使用环境变量密钥完成，未将密钥写入仓库、日志或报告。

## 2. DeepSeek Provider

### 2.1 API

`DeepSeekProvider` 实现现有接口：

```ts
interface LLMProvider {
  generate(
    request: ModelRequest,
    options?: GenerateOptions,
  ): Promise<ModelResponse>;
}
```

实现位置：

- `src/provider/deepseek-provider.ts`
- `src/provider/index.ts`

### 2.2 支持能力

- OpenAI-compatible `POST /chat/completions`
- System / User / Assistant / Tool 消息转换
- 多轮 Tool Calling
- Tool Arguments JSON 解析
- `tool_call_id` 对应的 Tool Result 回传
- Provider Usage Token 映射
- AbortSignal
- 请求超时
- 网络错误、HTTP 429、5xx 的有限重试
- 非法 JSON、非法 Tool Call 和非法响应结构拒绝
- API Key 仅通过 `LLM_API_KEY` 或 `.env` 提供

Provider 不直接执行 Tool，也不绕过 `TaskScheduler`。

### 2.3 循环上限

Demo 使用 `AgentRunner` 的现有预算：

- `maxModelTurns`：默认 10
- `maxToolCalls`：默认 24

可通过以下环境变量覆盖：

```dotenv
DEMO_MAX_MODEL_TURNS=10
DEMO_MAX_TOOL_CALLS=24
```

当工具调用数超出上限时，持久化层会将尚未启动的 ToolRun 标记为 `skipped`，错误码为 `TOOL_CALL_LIMIT_REACHED`，不会执行额外工具。

## 3. STM32 BOM Agent Demo

### 3.1 工具集

现有读取工具：

- `bom_get_items`
- `inventory_lookup`
- `component_get_spec`

新增模拟写入和回读工具：

- `procurement_create_draft`
- `procurement_get_drafts`

`procurement_create_draft` 使用 `mode=write` 和 `requiresApproval=true`。草稿只存在于 Demo 内存 Store，不连接真实采购系统。

### 3.2 工作流

Demo 目标为 2,000 套 STM32F103C8T6 开发板：

1. 读取 BOM。
2. 对每个 BOM 元器件查询模拟库存。
3. 按 2,000 套构建数量识别短缺。
4. 请求采购草稿写入审批。
5. 审批通过后创建内存采购草稿。
6. 使用 `procurement_get_drafts` 回读确认。
7. 输出最终分析报告。

实测短缺项：

- `STM32F103C8T6`：需求 2,000，可用 1,050，短缺 950。
- `X32258MSB4SI`：需求 2,000，可用 400，短缺 1,600。

### 3.3 执行链路

```text
AgentRunner
  -> TaskPlanner
  -> TaskScheduler
  -> ReadWorkerPool / WriteExecutor
  -> WriteApprovalHandler
  -> PersistentExecutionBridge
  -> SQLite
```

Task 通过 `PersistenceCoordinator.run()` 获取 Lease，并持久化：

- Model Call
- Execution Plan
- Plan Step
- Tool Run
- Event
- Checkpoint

## 4. CLI

### 4.1 Mock 离线模式

```bash
pnpm demo:mock --auto-approve
pnpm demo:mock --reject
```

Mock 最终报告根据真实 Tool Result 动态生成，不会在审批拒绝时虚报草稿已创建。

### 4.2 DeepSeek 模式

```bash
pnpm demo:deepseek --auto-approve
```

缺少 API Key 时实际输出：

```text
DEEPSEEK_API_KEY_REQUIRED: LLM_API_KEY is required for pnpm demo:deepseek.
```

命令返回非零退出码。

### 4.3 CLI 输出

Demo 会展示：

- Provider 和 Model
- Task ID 与最终 Task 状态
- Run 状态和停止原因
- 模型轮次及 Tool Call 数量
- 每个 ToolRun 的输入和输出
- 审批写结果
- 回读确认的 Draft 数量
- 最终 BOM / 短缺 / 建议报告

## 5. Mock 实测结果

### 5.1 批准路径

命令：

```bash
pnpm demo:mock --auto-approve
```

实际结果：

- Task 状态：`completed`
- Run 状态：`completed (final_response)`
- Model Requests：5
- Tool Calls：7
- `procurement_create_draft`：`succeeded`
- `procurement_get_drafts`：`succeeded`
- 回读 Draft 数量：1

### 5.2 拒绝路径

命令：

```bash
pnpm demo:mock --reject
```

实际结果：

- Task 状态：`completed`
- Run 状态：`completed (final_response)`
- Model Requests：5
- Tool Calls：7
- `procurement_create_draft`：`skipped`
- `procurement_get_drafts`：`succeeded`
- 回读 Draft 数量：0
- 最终报告明确说明审批被拒绝且没有创建草稿

## 6. 测试结果

### 6.1 定向测试

DeepSeek Provider：

```text
pnpm vitest run tests/provider/deepseek-provider.test.ts
1 test file passed
4 tests passed
```

STM32 Demo：

```text
pnpm vitest run tests/demo/stm32-agent-demo.test.ts
1 test file passed
3 tests passed
```

Persistent Execution：

```text
pnpm vitest run tests/integration/persistent-execution.test.ts
1 test file passed
19 tests passed
```

覆盖场景包括：

- Tool Calling 解析
- 多轮 Tool Result 传递
- HTTP 重试
- 非法响应
- Timeout
- Abort
- 离线批准工作流
- 审批拒绝无副作用
- Tool Call 上限停止
- Lease、Plan、ToolRun 和 Checkpoint 持久化

### 6.2 全量验证

```text
pnpm test
69 test files passed
694 tests passed

pnpm typecheck
passed

git diff --check
exit code 0
```

`git diff --check` 只有工作区既有的 CRLF 转换提示，没有空白错误。

## 7. 修改文件

### 生产代码

- `src/provider/deepseek-provider.ts`
- `src/provider/index.ts`
- `src/tools/demo/stm32.ts`
- `src/demo/stm32-agent-demo.ts`
- `src/demo/stm32-demo-cli.ts`
- `src/persistence/execution-bridge.ts`

### 测试

- `tests/provider/deepseek-provider.test.ts`
- `tests/demo/stm32-agent-demo.test.ts`

### 配置与文档

- `package.json`
- `.env.example`
- `README.md`

## 8. 未实现与未验证

- 未连接真实库存、ERP、采购或替代料系统。
- 未实现 Web UI、流式输出或 Dashboard。
- 未实现 MCP、动态插件加载或独立 Host Control Process。
- 未开始 Phase 3 Step 2–11。
- 未新增 Migration、SQLite Schema 或依赖。
- 未修改已封存 G2 Foundation。
- 未开放 Final Decision 生产入口。
- 未创建 Git Commit。

## 9. Batch B.1 Real DeepSeek Smoke Test

命令：

```bash
pnpm demo:deepseek --auto-approve
```

实际结果：

- Provider / Model：DeepSeek / `deepseek-chat`
- Task 状态：`completed`
- Run 状态：`completed (final_response)`
- Model Turns：6
- Tool Calls：9
- Token Usage：3,895
- 实际调用工具：BOM、4 项库存、2 项规格检查、采购草稿写、采购草稿回读
- `procurement_create_draft`：`succeeded`
- Tool Result 审批标记：`approval: "approved"`
- `procurement_get_drafts`：`succeeded`
- 回读 Draft 数量：1
- 预算使用：`6/10` Model Turns，`9/24` Tool Calls

DeepSeek 正确解析 Tool Arguments、回传多轮 Tool Result、识别两项短缺并通过现有审批机制创建和回读模拟草稿。

首次 Smoke Test 发现模型未准确描述审批结果。最小修复是让写工具成功结果显式返回 `approval: "approved"`，并约束最终报告使用该事实。第二次真实调用确认修复有效。

## 10. 结论

Batch B 的 Provider、STM32 Demo、审批写、回读确认、离线 CLI 和真实 DeepSeek 路径均已完成实际验证。全量测试与 TypeCheck 通过，生产边界没有被绕过。

当前状态为：

```text
Batch B Accepted
Mock End-to-End Verified
DeepSeek Provider Unit/Contract Verified
Real DeepSeek End-to-End Verified
Batch B.1 Smoke Test Passed
```

可以进入作品展示与包装阶段。
