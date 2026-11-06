# Phase 3 Step 2 Development Report

> 状态：Task / Message / Model Call Repository 完成
>
> 范围：Storage Migration、Repositories、Zod JSON Codec、Sequence Allocator、基础 TaskSnapshot、ExecutionUnitOfWork

## 1. 修改文件清单

Migration 与存储实现：

- `src/storage/migrations/001-phase3-step2.ts`
- `src/storage/migrations/index.ts`
- `src/storage/types.ts`
- `src/storage/json-codec.ts`
- `src/storage/sequences.ts`
- `src/storage/task-repository.ts`
- `src/storage/message-repository.ts`
- `src/storage/model-call-repository.ts`
- `src/storage/event-repository.ts`
- `src/storage/checkpoint-store.ts`
- `src/storage/task-snapshot.ts`
- `src/storage/execution-unit-of-work.ts`
- `src/storage/transaction.ts`
- `src/storage/write-boundary.ts`
- `src/storage/index.ts`

测试：

- `tests/storage/schema.test.ts`
- `tests/storage/repositories.test.ts`
- `tests/storage/snapshot-concurrency.test.ts`
- `tests/storage/sequence-concurrency.test.ts`
- `tests/storage/sequence-worker.ts`

文档：

- `docs/PHASE3_STEP2_DEVELOPMENT_REPORT.md`

没有修改 AgentRunner、TaskScheduler、Tool Registry 业务逻辑。

## 2. Migration 设计

新增 Migration：

```text
version: 1
name: phase3_step2_task_message_model_call
```

创建的表：

- `tasks`
- `messages`
- `model_calls`
- `events`
- `checkpoints`

没有创建：

- `execution_plans`
- `plan_steps`
- `tool_runs`
- `approvals`
- `recovery_reviews`
- `task_leases`

所有表主键、外键、NOT NULL、UNIQUE 与 CHECK 均位于 migration 中。

主要约束：

- `tasks.trace_id` UNIQUE。
- Task status 使用完整状态枚举 CHECK。
- Message `task_id + sequence` UNIQUE。
- Tool Message `task_id + tool_call_id` 部分唯一索引。
- Model Call `task_id + iteration + attempt_no` UNIQUE。
- Event `task_id + sequence` UNIQUE。
- Checkpoint `task_id + sequence` UNIQUE。
- Checkpoint/Messages/Model Calls/Events 全部外键引用 `tasks.id`。
- 所有业务表默认 `ON DELETE RESTRICT`。

Event 增加：

```text
BEFORE UPDATE -> RAISE(ABORT)
BEFORE DELETE -> RAISE(ABORT)
```

Event 仅允许 INSERT。

## 3. Zod JSON Codec

`src/storage/json-codec.ts`：

- `encodeJson(schema, value, column)`
- `decodeJson(schema, value, column)`
- `PersistedJsonError`

写入时先 Zod parse，再 `JSON.stringify`；读取时先 `JSON.parse`，再 Zod parse。
失败统一转换为安全的 `PERSISTED_JSON_INVALID`，不暴露原始值。

使用 JSON Codec 的字段：

- `tasks.token_usage_json`
- `tasks.last_error_json`
- `messages.tool_calls_json`
- `model_calls.request_json`
- `model_calls.response_json`
- `model_calls.usage_json`
- `model_calls.error_json`
- `events.payload_json`
- `checkpoints.budget_json`
- `checkpoints.metadata_json`

## 4. Sequence Allocator

`SequenceAllocator` 负责：

- Message sequence：任务内 `MAX(sequence) + 1`
- Checkpoint sequence：任务内 `MAX(sequence) + 1`
- Event sequence：原子递增 `tasks.last_event_sequence`
- Model Call attempt：任务+iteration 内 `MAX(attempt_no) + 1`

所有分配方法要求当前连接处于由 `runInTransaction(..., "immediate")` 或等效写锁
事务签发的写许可上下文中。仅凭 `database.inTransaction === true` 不足以获得
写权限，`deferred` 读事务不能签发写许可。

Task 创建、Model Call 和状态更新 UoW 使用 `BEGIN IMMEDIATE`，确保 sequence
读取与对应写入位于同一个写锁事务内。Message、Checkpoint 和 Model Call attempt
的分配与 INSERT 在 Repository 方法内部紧邻完成，不允许把号码分配给调用方后
脱离事务再插入。

## 5. Repository 设计

`TaskRepository`：

- insert
- get
- updateStatus
- updateCurrentIteration
- updateTokenUsage

`MessageRepository`：

- append
- listByTask

`ModelCallRepository`：

- createRequested
- complete
- fail
- get
- listByTask

`EventRepository`：

- append
- listByTask

`CheckpointStore`：

- append
- loadLatest
- listByTask

Repository 只负责对应表的查询与 JSON 映射；跨表事务由 UoW 管理。

### Repository / UoW 写边界

- Repository 的写方法必须接收不可公开伪造的 `StorageWritePermit`。
- 写许可只能由 `runInTransaction(..., "immediate")` 或
  `runInTransaction(..., "exclusive")` 内部的 `createStorageWritePermit()`
  签发；公开的 `src/storage/index.ts` 不导出该能力。
- `TaskRepository.updateStatus()`、`ModelCallRepository.complete()/fail()` 以及其他
  Repository 写方法在事务外调用时会同步拒绝，不能单独修改状态。
- 即使连接处于 `database.inTransaction === true` 的 deferred 读事务中，也不能
  获得写许可。
- `TaskRepository`、`MessageRepository`、`ModelCallRepository`、
  `EventRepository` 和 `CheckpointStore` 仍然是单表 Repository；跨表业务状态
  变更只通过 `ExecutionUnitOfWork` 的公开事务入口完成。
- 写许可在运行时校验数据库仍处于已登记的写事务中，避免只依赖 TypeScript
  类型约束。

## 6. ExecutionUnitOfWork

已实现事务：

### Create Task

```text
task
+ system message
+ user message
+ task.created event
+ task_created checkpoint
```

全部位于一个 `BEGIN IMMEDIATE` 事务。

### Begin Model Call

```text
model_calls requested
+ task iteration update
+ llm.requested event
+ model_call_requested checkpoint
```

Attempt 可显式传入，也可自动分配下一个 attempt_no。

### Complete Model Call

```text
model_call requested -> completed
+ assistant message
+ token usage update
+ llm.responded event
+ model_response checkpoint
```

### Fail / Interrupt / Cancel Model Call

```text
model_call terminal failure state
+ llm.<status> event
+ model_call_finished checkpoint
```

### Task Status Update

```text
task status update
+ task.status_changed event
+ task_status_changed checkpoint
```

任何 SQL 或 Trigger 失败都会整体 rollback。

## 7. 基础 TaskSnapshot

`TaskSnapshotReader.load(taskId)` 在单个 SQLite read transaction 中读取：

- tasks
- messages
- model_calls
- events
- checkpoints

不包含 Plan、ToolRun、Approval、RecoveryReview 或 Lease。当前只是 Phase 3
Step 2 的基础 Snapshot，不是完整恢复 Snapshot。

并发一致性证据：

- `tests/storage/snapshot-concurrency.test.ts` 使用两个独立的文件型 SQLite
  连接和 WAL 模式。
- Connection A 开始 Snapshot read transaction 并先读取 Task。
- 在该 read transaction 尚未结束时，Connection B 通过一个
  `BEGIN IMMEDIATE` 事务提交新的 Message、Event 和 Checkpoint。
- Connection A 继续读取其余表时仍看到起始快照中的 2 条 Message、1 条 Event
  和 1 条 Checkpoint，而 Task 仍报告 `last_event_sequence = 1`。
- Connection A 的事务结束后重新读取，能看到 3 条 Message、2 条 Event、
  2 条 Checkpoint 和 `last_event_sequence = 2`，证明没有拼接两个时间点。

## 8. SequenceAllocator 多连接并发验证

`tests/storage/sequence-concurrency.test.ts` 通过两个独立 Node 子进程建立两个
独立 SQLite 连接，并使用 IPC 同时发出开始信号。两个进程分别执行
`BEGIN IMMEDIATE` 短事务：

- 每个 Message append 都在同一事务中执行 `MAX(sequence) + 1` 和 INSERT。
- 每个 Checkpoint append 都在同一事务中执行 `MAX(sequence) + 1` 和 INSERT。
- 每个 Model Call 都在同一事务中执行 `MAX(attempt_no) + 1` 和 INSERT。

两个进程各追加 12 次后，数据库中的 Message、Checkpoint 和 Model Call attempt
序号均为无重复、无空洞的连续整数。测试使用真实文件数据库和
`busy_timeout`，没有用 `:memory:` 或 Mock 替代 SQLite。Event 序号继续由
`tasks.last_event_sequence` 在同一写事务内原子递增，并由既有 Event 测试覆盖。

## 9. 测试结果

`tests/storage/schema.test.ts`（6 个通过）：

- 只创建批准的五张 Step 2 业务表
- 必填列和外键约束
- status/role/message-shape CHECK
- Event append-only Trigger
- Message/Event sequence unique
- Step 2 migration 重复执行

`tests/storage/repositories.test.ts`（12 个通过）：

- Task 创建与读取
- Message sequence 分配与唯一性
- Model Call attempt 独立记录和响应完成
- Event append-only 与 sequence
- JSON 写入校验和损坏 JSON 读取拒绝
- 基础 TaskSnapshot
- Task 创建事务原子性
- Model Response 事务原子性
- 状态与 Event 同事务
- Model Call failure/interrupted 记录
- Repository 写方法在事务外不能修改 Task 或 Model Call
- deferred read transaction 不能签发写许可

`tests/storage/snapshot-concurrency.test.ts`（1 个通过）：

- 两个独立 WAL 连接之间的 TaskSnapshot 单一快照一致性

`tests/storage/sequence-concurrency.test.ts`（1 个通过）：

- 两个独立进程并发追加 Message、Checkpoint、Model Call 时序号不重复

## 10. 实际执行结果

- `pnpm test`：22 个测试文件、166 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1 的 33 个测试、Phase 2 的 130 个测试、Phase 3 Step 1 的测试全部保持通过。

## 11. 尚未完成

- Execution Plan / Plan Step Repository
- Tool Run Repository
- Approval / RecoveryReview Repository
- Task Lease / Fencing
- RecoveryManager
- Pause / Resume / Cancel 持久化编排
- AgentRunner / TaskScheduler 持久化集成
- 完整 TaskSnapshot

## 12. 阶段边界声明

本次只完成 Phase 3 Step 2。没有提前实现 Step 3 及后续执行计划、工具执行、
审批、恢复核对、Lease/Fencing 或 AgentRunner 持久化集成。

本次最终核查只新增了 Step 2 范围内的写边界和并发证明测试，没有创建新的业务
表、Repository 或后续阶段状态机。
