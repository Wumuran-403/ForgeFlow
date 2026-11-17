# Phase 6.1 Evaluation Engine & Metrics Report

## 1. 结论

Phase 6.1 已完成。实现了固定 30 Case Evaluation Suite、EvaluationRunner、SQLite v11 持久化、可重建报告、聚合指标服务和认证 Web API。未修改登录架构，未进入 Phase 6.2 / 6.3，未调用真实 DeepSeek。

## 2. 修改文件

- `src/evaluation/*`：Suite、类型、判定、指标、Runner、Repository、确定性执行器。
- `src/observability/*`：基于 SQLite 的 Task / Tool / Token / Latency / Loop / Recovery / MCP / Evaluation 聚合。
- `src/storage/migrations/011-phase6-1-evaluation.ts`、migration barrel：SQLite v11。
- `src/web/server-factory.ts`、`src/web/task-service.ts`：Metrics / Evaluation 后端接口。
- `scripts/run-phase6-evaluation.ts`、`package.json`：独立评测命令。
- `tests/evaluation/*`、`tests/observability/*`、Web / Schema / Migration 测试。
- `README.md`：运行命令、指标语义和 API。

## 3. Evaluation Suite 与 Runner

Suite `phase6.1-v1` 固定包含：10 个正常工具场景、5 个无效输入、5 个库存不足、5 个规格/工具错误、5 个 Loop/Recovery 场景。判定使用结构化 outcome、工具名、JCS 语义参数和 Tool 状态，不以最终自然语言关键词作为成功依据。

确定性执行器使用新建的 STM32 Demo Runtime；MCP Case 启动真实本地 stdio Server 并通过 MCP Client/Registry 调用；Loop Case 调用现有 LoopGuard。评测不会创建普通 Web Task，也不会复用共享 Demo 写数据。Write Approval 拒绝场景不会执行 Write。

每次运行生成独立 Run ID，保存 Suite/Provider/Config 版本、时间、每个 Case 的 expectation、observation、verdict、failure reason 和 latency。SQLite 重开后可从持久化数据重新读取完整报告。

## 4. 指标口径

- Task Success Rate：判定通过 Case / Run 中全部 Case。
- Tool Call Accuracy：正确的工具名 + canonical arguments + status /（Expected Call + Unexpected Call）。
- Recovery Success Rate：成功恢复且没有 Unknown Write / Recovery Eligible Case；Unknown Write 不进入分子。
- Duplicate Execution Rate：标记为重复副作用的 succeeded Write / succeeded Write；Unknown Write 排除。
- Average / P50 / P95 Latency：Runner 观测到的 Case 执行时长；P50/P95 使用 nearest-rank。
- Provider Token Usage：仅 `source=provider` 的真实 Provider totalTokens 总和。
- Estimated Token Usage：仅 `source=estimated` 的本地估算总和。
- Loop Detection Rate：正确命中的目标 Loop Case / Suite 中目标 Loop Case。
- MCP Tool Execution Success Rate：成功 MCP Call / 实际尝试 MCP Call。

所有 ratio 均持久化 numerator、denominator、exclusions 和 definition。分母为零时保留零分母并返回 0，不编造比例。

## 5. SQLite 与 Observability API

Migration v11 新增：

- `evaluation_runs`
- `evaluation_case_results`
- `evaluation_metrics`

后端接口：

- `GET /api/metrics/summary`
- `POST /api/evals/run`
- `GET /api/evals`
- `GET /api/evals/:id`

普通 Task 指标按认证 Actor 的持久化 Task 范围聚合；Evaluation 历史来自 Evaluation 表。指标服务读取 SQLite 的 Task、ModelCall、ToolRun、Event 和 Evaluation 数据，不使用进程内计数。Provider/Estimated Token 分栏保持独立。

## 6. 实际评测运行

命令：

```text
pnpm eval:phase6 -- data/phase6-1-evaluation.db
```

Run ID：`eval-cf3e012f-5884-4123-a6b1-39af6965de78`

- 30 / 30 Case 通过。
- Task Success Rate：30 / 30。
- Tool Call Accuracy：18 / 18。
- Recovery Success Rate：2 / 3；Unknown Write 安全阻断 Case 不计成功恢复。
- Duplicate Execution Rate：0 / 0；本轮参考 Suite 未执行 Write，未虚构分母。
- Average / P50 / P95：23.73 ms / 1 ms / 327 ms，仅为本机本次运行数据。
- Provider / Estimated Token：0 / 0；参考执行器不调用模型，未将零值描述为 Token 节省。
- Loop Detection Rate：2 / 2。
- MCP Tool Execution Success Rate：1 / 1。

## 7. 实际验证

```text
pnpm exec vitest run tests/evaluation tests/integration/mcp-persistent-agent.test.ts tests/integration/recovery-process.test.ts tests/integration/token-budget-persistence.test.ts tests/integration/loop-guard-persistence.test.ts tests/scheduler/write-executor.test.ts tests/storage/schema.test.ts tests/web/web-api.test.ts
# 9 files, 50 tests passed

pnpm exec vitest run tests/observability/metrics-service.test.ts
# 1 file, 1 test passed

pnpm typecheck
# passed

pnpm web:build
# passed; 2077 modules transformed

pnpm test
# 87 files, 777 tests passed

git -c core.safecrlf=false diff --check
# passed
```

SQLite 重开、Run 隔离、报告重建、Provider/Estimated 分栏、Unknown Write 排除、MCP 统计和认证 API 均有自动化覆盖。

## 8. 明确限制与后续

- Phase 6.1 仅提供后端接口，没有新增 Dashboard 页面；留给 Phase 6.2。
- Guest Session、移除登录页和 Web 产品整合留给 Phase 6.3。
- 两个 Recovery 成功 Case 使用确定性恢复观察 Fixture；真实强制进程中断仍由 Phase 3 Recovery 子进程回归测试覆盖。两者没有被混写为同一种测试证据。
- 本地运行 latency 不是生产基准，Provider Token 为 0 是因为未调用模型。
- Remote MCP、OAuth 和公网部署仍不在本轮范围。

Phase 6.1 到此停止，等待验收。
