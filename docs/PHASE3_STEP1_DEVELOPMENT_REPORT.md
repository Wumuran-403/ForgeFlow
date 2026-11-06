# Phase 3 Step 1 Development Report

> 状态：SQLite Foundation 完成
>
> 范围：SQLite 连接、PRAGMA、DATABASE_PATH、schema_migrations、Migration Runner、同步事务包装器

## 1. 修改文件清单

依赖与配置：

- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `.env.example`
- `src/config/env.ts`

数据库基础模块：

- `src/storage/database.ts`
- `src/storage/migrations.ts`
- `src/storage/transaction.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/test-database.ts`
- `tests/storage/database.test.ts`
- `tests/storage/import-safety.test.ts`
- `tests/storage/migrations.test.ts`
- `tests/storage/transaction.test.ts`
- `tests/unit/config.test.ts`

文档：

- `docs/PHASE3_STEP1_DEVELOPMENT_REPORT.md`

没有修改 AgentRunner、TaskScheduler、Tool Registry 业务表或 Phase 2 调度逻辑。

## 2. 新增依赖

```text
better-sqlite3@13.0.3
@types/better-sqlite3@9.6.0
```

`better-sqlite3@13.0.3` 要求 Node `>=22`，当前 Node 24.11 兼容。

安装说明：

- 包内包含 `win32-x64` 官方预编译产物。
- 当前机器没有 Visual Studio C++ 构建工具。
- pnpm 默认触发了不必要的 native rebuild，并因缺少 Visual Studio 失败。
- 已将 `better-sqlite3` 的冗余 build script 显式关闭，实际模块通过包内
  预编译产物加载；真实 SQLite 读写已由测试验证。
- `pnpm install --frozen-lockfile` 最终通过。

## 3. 数据库模块结构

`src/storage/database.ts`：

- `resolveDatabasePath()`
- `configureDatabaseConnection()`
- `openDatabase()`
- `closeDatabase()`
- `DATABASE_BUSY_TIMEOUT_MS`

每个新连接都会执行：

```sql
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
```

连接初始化后立即读取实际 PRAGMA，并验证：

- 文件数据库 `journal_mode = wal`
- `synchronous = 2`
- `foreign_keys = 1`
- `busy_timeout = 5000`

模块 import 不打开数据库、不创建目录、不创建生产数据库。

## 4. DATABASE_PATH

新增配置：

```text
DATABASE_PATH=data/forgeflow.db
```

`loadConfig()` 只解析字符串，不创建目录或数据库。相对路径在调用
`openDatabase()` 时才按显式 `baseDirectory` 或当前工作目录解析。

测试数据库使用独立系统临时目录，不使用生产路径。

## 5. Migration Runner

`src/storage/migrations.ts`：

- `schema_migrations(version, name, applied_at)`
- 校验 Migration version 为正整数且唯一
- 按 version 排序
- 拒绝未提供给 Runner 的已应用 migration
- 拒绝同版本但名称变化的 migration
- 全部 pending migrations 在同一事务中执行
- 任一步骤失败整体 rollback
- Async migration function 在 callback 调用前被拒绝
- 同步 migration 意外返回 thenable 时在提交前拒绝并 rollback

本阶段没有创建 Task、ToolRun、PlanStep、Approval、RecoveryReview、Lease
或其他业务表。

## 6. 同步事务包装器

`src/storage/transaction.ts`：

- `runInTransaction(database, operation)`
- `assertSynchronousFunction(value)`
- `assertSynchronousResult(value)`
- `AsyncTransactionForbiddenError`

实现方式：

```ts
assertSynchronousFunction(operation);
database.transaction(() => {
  const result = operation();
  assertSynchronousResult(result);
  return result;
})
```

`assertSynchronousFunction()` 在 `operation()` 调用前执行，通过
`Object.prototype.toString` 识别 `AsyncFunction` 和 `AsyncGeneratorFunction`。
因此 async callback 的函数体不会开始执行，也不依赖事务回滚作为第一道防护。

TypeScript 使用 `SynchronousOperation` 条件类型限制 PromiseLike 返回值，使 async
callback 在编译期也不被接受。

第二道 thenable guard 仍位于 SQLite transaction callback 内部、提交之前。同步
函数意外返回 thenable 时立即抛错，已执行的 SQL 写入会回滚。

事务中不允许等待 Provider、工具执行、审批 Handler 或其他外部 Promise。

Migration Runner 在进入迁移事务前检查全部 migration callback，并在每个 callback
实际调用前再次检查。Async migration body 不会开始执行。

## 7. 模块 import 无副作用验证

`tests/storage/import-safety.test.ts` 在独立子进程中：

- 使用隔离临时工作目录。
- 动态导入 `src/config/env.ts` 和 `src/storage/database.ts`。
- 只调用 `loadConfig()` 与 `resolveDatabasePath()`。
- 不调用 `openDatabase()`。
- 验证 `data/forgeflow.db` 不存在。
- 验证 `data/` 目录未创建。

## 8. 干净安装验证

当前工作区 `node_modules` 的直接递归删除被命令执行策略拒绝，因此没有宣称已经
清空当前工作区安装。改为使用独立临时项目目录；该目录初始没有 `node_modules`，
复制当前 `package.json`、`pnpm-lock.yaml`、`pnpm-workspace.yaml`、
`tsconfig.json` 与 `src/`。

在干净临时项目执行：

```text
pnpm install --frozen-lockfile
```

结果：

- 安装退出码 0。
- 安装 47 个包。
- `better-sqlite3@13.0.3` 使用包内预编译二进制。
- 没有触发 native rebuild。
- 真实创建 SQLite 文件、创建表、插入并读取数据。
- 实测 `journal_mode=wal`。
- 实测 `synchronous=2`。
- 实测 `foreign_keys=1`。

临时项目路径：

```text
C:\Users\trap2\AppData\Local\Temp\forgeflow-clean-install-805cfd2f02874ae18c9f533a92eef959
```

## 9. 测试结果

新增和更新测试覆盖：

| 验证项 | 测试文件 / 用例 | 结果 |
|---|---|---|
| 文件型临时数据库初始化 | `database.test.ts` | 通过 |
| WAL | `database.test.ts` | 通过 |
| `synchronous=2` | `database.test.ts` | 通过 |
| `foreign_keys=1` | `database.test.ts` | 通过 |
| busy_timeout=5000 | `database.test.ts` | 通过 |
| 每个新连接执行初始化 | `applies connection initialization to every new connection` | 通过 |
| 临时库与生产路径隔离 | `keeps temporary test paths separate from the production default` | 通过 |
| 模块 import 不创建生产库/目录 | `import-safety.test.ts` | 通过 |
| Migration 重复执行 | `applies migrations once and records schema versions` | 通过 |
| Migration 失败整体回滚 | `rolls back the full migration run when any migration fails` | 通过 |
| Async migration 调用前拒绝 | `does not commit an async migration callback` | 通过 |
| Migration 类型层拒绝 Promise | `rejects async migration callbacks in the TypeScript contract` | 通过 |
| Migration 历史不一致 | `rejects an applied migration whose name changed` | 通过 |
| 同步事务提交 | `commits a synchronous callback result` | 通过 |
| 同步 callback 返回 thenable 时回滚 | `rejects a thenable before commit and rolls back writes` | 通过 |
| Async transaction 调用前拒绝 | `rejects an async callback before its body starts` | 通过 |
| Transaction 类型层拒绝 Promise | `rejects promise-returning callbacks in the TypeScript contract` | 通过 |
| DATABASE_PATH 默认值 | `config.test.ts` | 通过 |
| DATABASE_PATH 显式配置 | `accepts an explicit database path without creating it` | 通过 |

Async callback 测试额外验证：

- `beforeAwaitExecuted === false`
- `afterAwaitExecuted === false`
- 数据库没有写入
- `database.inTransaction === false`

## 10. 实际执行结果

- `pnpm install --frozen-lockfile`：通过
- `pnpm test`：18 个测试文件、146 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

原有 Phase 1 的 33 个测试和 Phase 2 的 130 个测试保持通过。

## 11. 尚未完成

- Task / Message / Model Call Repository
- Plan / ToolRun / Approval / RecoveryReview
- Task Lease / Fencing
- AgentRunner / TaskScheduler 持久化接入
- Pause / Resume / Cancel / Recovery
- 幂等键与 Unknown Write Review

## 12. 阶段边界声明

本次只完成 Phase 3 Step 1：SQLite Foundation。没有提前实现 Step 2 及后续
Repository、业务表、Lease/Fencing、Recovery 或 AgentRunner 持久化集成。
