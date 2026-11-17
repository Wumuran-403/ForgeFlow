# ForgeFlow Batch D Deployment Report

> 状态：本地部署包与容器验收通过；公网部署待服务器和域名。
>
> 日期：2026-11-09。Production Recovery Entry：Closed。

## 1. 修改文件

- 部署：`Dockerfile`、`compose.yaml`、`deploy/Caddyfile`、`deploy.env.example`、`.gitignore`。
- Web：`src/web/config.ts`、`src/web/server-factory.ts`、`src/web/task-service.ts`、`web/src/lib/types.ts`、`web/src/components/ui.tsx`。
- 运维与测试：`scripts/backup-sqlite.mjs`、`scripts/smoke-web.mjs`、`tests/web/web-api.test.ts`、`tests/web/deployment-backup.test.ts`、`tests/web/deployment-config.test.ts`。
- 文档：`README.md`、本报告。

没有新增包依赖、迁移、Runtime 重构或 Git commit。

## 2. 部署结构与启动

```text
Browser --HTTPS--> Caddy (:443) --Compose network--> Web API (:8787)
                                                \--> forgeflow_data:/app/data
```

Caddy 公开 80/443，Web API 仅在 Compose 网络上监听。Caddy 自动管理公网证书；本地 `localhost` 验证使用其本地证书。SQLite 位于 `/app/data/forgeflow.db`，Evidence 预留目录 `/app/data/evidence`。Caddy 证书与配置各有独立 Volume。

按 README 将 `deploy.env.example` 复制为 gitignored `deploy.env`，替换域名及私密凭据，然后运行：

```bash
docker compose --env-file deploy.env up -d --build
```

## 3. 实际容器验证

- 初次 `docker build`：Docker Desktop 引擎未运行，失败；启动引擎后，Docker Hub 直接拉取返回错误内容。通过已配置镜像源拉取并本地标记基础镜像后，`docker build --pull=false -t forgeflow:batch-d .`：**通过**，构建中 `pnpm web:build` 和 `pnpm typecheck` 均通过。
- `docker run`：**通过**；健康检查、前端页面、未认证拒绝、登录、创建 Mock 任务、轮询、审批模拟写入、历史读取：**通过**。
- `docker restart` 后，已完成任务 `bcbb8bfc-ad49-4c8f-946a-cea4cbcc39a0` 可继续查询：**通过**。
- `docker compose --env-file deploy.env.example config --quiet`：**通过**。
- Caddy `validate`：**通过**。
- 本地 Compose 使用 `localhost:18443` 和本地证书；HTTPS 代理完整 Mock 流程：**通过**。本地测试客户端关闭了证书信任校验，因此这一项不代表公认证书验收。
- Compose Web 重启后，同一任务 `dd081fda-a92b-4d72-87f0-4c2a75920725` 仍可查询：**通过**。
- Caddy 与 Web 的 `/internal/recovery-review/authenticate` 返回 404：**通过**。

## 4. SQLite 备份与恢复

`scripts/backup-sqlite.mjs` 使用 SQLite Online Backup API 生成一致性备份，并对备份文件执行 `PRAGMA integrity_check`。运行中的容器备份命令：

```bash
docker compose --env-file deploy.env exec -T web node scripts/backup-sqlite.mjs /app/data/forgeflow.db /app/data/backups/forgeflow.db
```

本地容器与 Compose 两次执行均通过。Compose 测试中停止 Web，使用 README 中的恢复命令覆盖数据库并清除旧 WAL/SHM，启动后仍能读取上述任务：**通过**。备份还应复制到服务器外；未来若 Evidence 目录有文件，应同步备份匹配版本。Web Demo 当前不写 Evidence 文件。

## 5. 安全与重启行为

- 生产配置强制精确 HTTPS `WEB_PUBLIC_ORIGIN`、Secure Cookie，并拒绝样例凭据；Session Cookie 含 HttpOnly、SameSite=Strict。写请求 Origin 必须与配置完全一致。
- 登录每来源每分钟最多 10 次；创建任务每 actor 每分钟最多 10 次。现有每日任务数、并发任务数、模型轮次和工具调用上限仍有效。
- 未完成任务在服务器重启后显示为 `interrupted` 并提示人工核对；丢失的内存审批不出现在可批准队列，未确认写操作不会自动重试。该实现只改变 Web 展示，不改写 Lease/Fencing 或 SQLite 状态机。
- 请求日志只包含 request ID、方法、状态和耗时。检查本地容器日志，未检出测试 access token、Session Cookie、Authorization 字样或 `LLM_API_KEY`。
- DeepSeek Key 仅通过容器运行环境注入；本轮使用 Mock，未执行真实 DeepSeek Web E2E。

## 6. 最终验证

```text
pnpm typecheck       PASS
pnpm test            72 files, 703 tests PASS
pnpm web:build       PASS
git diff --check     PASS（仅已有 LF/CRLF 提示）
```

## 7. 未完成的公网验收

用户将在后续提供服务器 URL。当前没有服务器访问、域名或 DNS 配置，因此**没有公网 URL**，公网 HTTPS 证书、真实浏览器跨公网访问、线上容器重启和真实 DeepSeek Web E2E 均未验证。拿到服务器信息后，需按 README 部署并执行第 6 节所列公网验收流程。

当前登录限流以代理连接来源计数，多个外部用户可能共享同一来源；限流计数在进程重启后清零。Web Demo 的业务数据仍在内存，SQLite 仅持久化 Agent 执行历史。Phase 3 Step 2–11 和 Final RecoveryReview 入口均未启动。
