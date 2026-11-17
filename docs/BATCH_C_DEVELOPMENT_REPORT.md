# ForgeFlow Batch C Development Report

> 状态：开发完成，待 Batch C 验收
> 日期：2026-11-09
> 范围：First Web Product Phase

## 1. 实际交付

- React + TypeScript + Vite Web 前端。
- Tailwind CSS 和 Lucide 图标界面。
- Node.js TypeScript Web API。
- SQLite 持久化 Agent 执行状态。
- Mock Provider 浏览器完整审批工作流。
- 两个真实 Agent 工作流模板：
  - STM32 BOM Recovery
  - STM32 Inventory Audit
- Docker/VPS 部署预留配置。

## 2. 前端页面

- Dashboard：任务统计、最近任务、运行状态、Provider 状态。
- Agent Workspace：工作流选择、自然语言任务、构建数量、轮询进度、Tool Call/Result、最终报告。
- Approval Center：真实后端审批队列、参数展示、批准和拒绝。
- Execution History：任务列表、Execution Plan、PlanStep、ToolRun、Event、Checkpoint 和错误信息。

页面不使用静态成功数据，全部通过 Web API 读取。

## 3. Web API

```text
POST /api/auth/login
GET  /api/auth/session
POST /api/auth/logout
GET  /api/dashboard
GET  /api/workflows
GET  /api/tasks
POST /api/tasks
GET  /api/tasks/:id
GET  /api/tasks/:id/events
GET  /api/approvals
POST /api/approvals/:id/approve
POST /api/approvals/:id/reject
GET  /api/health
```

认证使用 `WEB_ACCESS_TOKEN` 换取签名 HttpOnly Session Cookie。任务列表和详情通过服务端 actor 归属检查隔离。

## 4. Agent 与审批边界

Web 后台任务继续复用：

- `AgentRunner`
- `TaskPlanner` / `TaskScheduler`
- `ReadWorkerPool` / `WriteExecutor`
- `PersistenceCoordinator`
- `TaskLeaseManager`
- `ExecutionUnitOfWork`
- SQLite Event / Checkpoint / Plan / ToolRun

Pending Approval 保存在运行中的 Web 服务进程内。批准或拒绝由后端 API 实际触发 `WriteExecutor` 的审批 Promise，不依赖前端本地状态。

当前限制：服务重启后不会恢复未完成的内存审批；该限制已写入 README，不宣称跨重启继续执行。

## 5. 启动命令

开发模式：

```bash
pnpm dev:web
```

生产构建：

```bash
pnpm web:build
pnpm web:start
```

本轮本地验证服务：

```text
http://127.0.0.1:8787
```

## 6. 实际验证

### 浏览器 Mock E2E

- 登录：PASS
- Dashboard 空状态和完成状态：PASS
- Agent Workspace 创建任务：PASS
- 后端写入审批：PASS
- Approval Center 批准：PASS
- Task 最终状态：`completed`
- Model Turns：`5 / 8`
- Tool Calls：`7 / 20`
- `procurement_create_draft`：`succeeded`
- `procurement_get_drafts`：回读 1 个草稿
- 页面刷新/直接访问任务 URL：PASS
- Execution History 的 Plan、ToolRuns、Events、Checkpoints：PASS
- 浏览器视口：`563 × 672`
- 页面横向溢出：无，`scrollWidth = clientWidth = 553`

### API 集成

- 未认证请求拒绝：PASS
- 错误访问令牌拒绝：PASS
- Session Cookie 篡改拒绝：PASS
- 跨 Origin 写请求拒绝：PASS
- 非法请求体拒绝：PASS
- 任务创建、轮询、刷新读取：PASS
- Web 后端批准审批：PASS
- Web 后端拒绝审批且无写入副作用：PASS
- Read-only Audit 工作流：PASS
- Actor 任务隔离：PASS

### 构建与测试

```text
pnpm typecheck
passed

pnpm web:build
passed

pnpm test
70 test files passed
698 tests passed

git diff --check
exit code 0
```

## 7. 安全与数据边界

- DeepSeek API Key 只在服务端使用，不进入前端 Bundle。
- 未增加 Final Decision、Recovery Control 或 Host Authentication 的公开路由。
- Write Approval、Scheduler、Lease/Fencing 和 SQLite Transaction 未绕过。
- Unknown Write 不自动重试。
- 普通 Web 用户只能访问自身 actor 的任务。
- 每任务模型轮次和 Tool Calls 有预算限制。
- 活跃任务数和每日任务数有限制。
- BOM、库存和采购草稿仍是内存模拟业务数据；SQLite 保存 Agent 执行状态。

## 8. 未实施与已知限制

- 未部署服务器，未验证公网 HTTPS。
- Dockerfile 已提供，但本轮未执行 Docker build 或容器启动。
- 未实现多用户账号体系，当前为单 access token 对应单 actor。
- Pending Approval 不跨服务重启恢复。
- 未实现 WebSocket/SSE，当前使用轮询。
- 未连接真实库存、ERP 或采购系统。
- 未开始 Phase 3 Step 2–11。
- 未创建 Git Commit。

## 9. Batch D 前置条件

- 构建并验证容器镜像。
- 配置 HTTPS、反向代理和真实域名。
- 注入生产 `WEB_ACCESS_TOKEN`、`WEB_SESSION_SECRET` 和 DeepSeek Key。
- 配置持久化 Volume 和 SQLite 备份。
- 启用 Secure Cookie、真实 HTTPS Origin 校验和访问日志脱敏。
- 在公网环境执行一次真实浏览器端到端访问。

## 10. 结论

Batch C 的 Web UI、Web API、后台 Agent 执行、刷新恢复读取、后端审批和历史审计已完成实际验证，具备进入 Batch D 部署开发的条件。
