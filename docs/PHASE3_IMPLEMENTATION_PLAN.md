# ForgeFlow Phase 3 Implementation Plan

> 状态：设计修订版，等待架构评审通过
>
> 范围：SQLite、Checkpoint、Lease/Fencing、Pause/Resume/Cancel、Recovery、Idempotency
>
> 本文档只包含设计与实施计划。当前没有修改生产代码、安装依赖或创建数据库。

## 1. 本次修订摘要

本次保留原 Phase 3 分层架构，修订以下设计：

1. SQLite 默认改为 `WAL + synchronous=FULL`，明确 Process Crash 与 Power Loss
   的不同持久化保证。
2. 增加独立取消意图和 `cancel_requested` 状态；Unknown Write 进入
   `waiting_review`，不能与普通 `cancelled` 终态冲突。
3. Task Lease 增加单调递增 `fencing_token`，与 `lease_token` 一起保护所有状态写入。
4. 分别定义 Task、Tool Run、Plan Step、Model Call 的完整状态机与 CHECK 约束。
5. 将 Task Lease / Fencing 提前到 Step 4，AgentRunner 持久化集成推迟到 Step 5。
6. 持久化 Tool Run 绑定工具版本、Schema Hash、输入 Hash、权限和审批属性。
7. Model Call 使用 `requested` 状态和独立 attempt；进程崩溃后旧请求标记
   `interrupted`，重新创建请求，允许重复 API 费用。
8. 定义稳定 canonical JSON 与 SHA-256 规则；不同工具版本不得无条件复用幂等记录。
9. `TaskSnapshot` 必须在同一个 SQLite 只读事务/一致性快照中读取。

## 2. SQLite Durability

默认配置：

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
```

ForgeFlow 在调用外部 Write 前必须先提交 Write Intent，因此默认选择
`WAL + FULL`。`NORMAL` 只能作为显式配置的低耐久模式。

| 故障 | `WAL + NORMAL` | `WAL + FULL` |
|---|---|---|
| 进程崩溃 | 通常保留已提交事务，因为 WAL 与 OS Page Cache 仍存在 | 保留已提交事务 |
| 系统崩溃 / 断电 | 最近已提交但尚未 checkpoint/fsync 的事务可能丢失，数据库仍应保持一致 | 每次提交尝试同步 WAL，耐久性更强 |
| 存储设备撒谎、缓存失效、文件系统故障 | 无法绝对保证 | 无法绝对保证 |

`synchronous=FULL` 不能对抗硬件故障、磁盘损坏或错误配置。它表示 SQLite
在提交返回前执行其支持的同步步骤，而不是“绝对永不丢数据”。

SQLite 事务不能和外部 Write 组成一个原子事务。必须采用：

```text
COMMIT Write Intent
  -> call external Write
  -> COMMIT Write Result
```

如果外部 Write 已成功，但 Result Commit 前崩溃，恢复只能将 Write 标记为
`unknown`。WAL、idempotency key 和 fencing token 都不提供 exactly-once。

### 同机部署与 SQLITE_BUSY

- WAL 只适用于同一台机器的本地文件系统。
- 不支持把同一个 SQLite 数据库文件放在 NFS/SMB 等网络共享文件系统上供多主机
  同时写入。
- 多进程同机共享可以依赖 SQLite WAL、短事务和 Lease/Fencing；多主机分布式
  一致性不在 Phase 3 范围。
- `SQLITE_BUSY` 使用有界退避，建议最多 3 次，基础 50ms，指数退避并加入少量抖动。
- `SQLITE_LOCKED` 必须先识别错误来源。不得默认无差别重试；只有确认是安全、
  可恢复的短时同连接/共享缓存锁冲突才允许重试。
- 仅对可确认未产生外部副作用的事务开始、lease claim、heartbeat 等操作重试。
- Commit 结果不确定时不能通过重试猜测成功；必须依据 lease/fencing、事务记录和
  Unknown Write 规则处理。

## 3. Task Cancel 与 Unknown Write

`tasks` 增加独立持久化字段 `cancel_requested_at TEXT NULL`，Task 同时支持临时
状态 `cancel_requested`。`cancel_requested_at` 是取消意图的唯一事实来源；即使
Task 随后进入 `waiting_review`，该字段仍保留。

取消规则：

- 取消请求到达时，事务写入 `cancel_requested_at`，Task 进入 `cancel_requested`。
- 不启动新步骤，所有活跃工具收到 AbortSignal。
- Read 最终可以成为 succeeded/failed/timed_out/cancelled。
- Write 结果确认成功时保留 succeeded。
- Write 确认未启动时最终 cancelled。
- Write 已启动但结果未知时，Tool Run 为 unknown，Task 进入 `waiting_review`。
- `waiting_review` 不是终态，不能被普通 cancelled 流程覆盖。
- 有 cancel intent 时，完成 Unknown Write 核对后 Task 必须转为 `cancelled`，
  不得自动继续。
- 没有 cancel intent 时，才允许根据核对结果继续或重新规划。

数据库不变量：`tasks.status = 'cancelled'` 时不允许存在 active 的
`recovery_reviews`。active 定义固定为 `pending` 或 `unresolved`。
除事务层检查外，建议增加 trigger：

```text
BEFORE UPDATE OF status ON tasks
WHEN NEW.status = 'cancelled'
AND EXISTS (
  SELECT 1 FROM recovery_reviews
  WHERE task_id = NEW.id
    AND status IN ('pending', 'unresolved')
)
RAISE(ABORT, 'active recovery review')
```

## 4. Task Lease 与 Fencing Token

`task_leases` 字段：

```text
task_id
owner_id
lease_token
fencing_token
expires_at
heartbeat_at
```

每次成功获取 lease：

1. 生成新的随机 `lease_token`。
2. 将 `fencing_token` 原子加 1。
3. 写入 owner 与 expires_at。

`fencing_token` 按 Task 单调递增，租约释放后也不归零。

`task_leases` 记录在 Task 生命周期内不得删除。释放 Lease 时只清空 owner、
设置 expires_at/heartbeat_at 并保留最后 fencing_token；下一次成功 claim 必须
继续递增。若删除并重建 lease 行，会把 fencing_token 重置，破坏旧 Worker 检测。

资源级 Fencing 边界：

- SQLite 状态写入、Checkpoint、Tool Result 和终态更新可以由 lease/fencing
  完全保护。
- 支持 fencing token 的外部 API 可拒绝旧 Worker 或旧资源版本。
- 不支持 fencing 的外部 API 仍可能接受旧 Worker 请求；必须配合幂等键、
  外部查询或人工核对。
- 文件系统写入也不自动获得 fencing；需要使用幂等路径、原子 rename 和结果核对。

每次数据库状态写入必须同时校验：

- task_id
- lease_token
- fencing_token
- 当前 Task status
- Task version

任一不匹配都拒绝写入。失去租约的旧 Worker 不能提交 Checkpoint、Tool Result
或终态。Heartbeat 同样验证两个 token 且租约尚未过期。

调用工具前必须执行 `assertOwned`，然后持久化 Tool Intent，之后才能调用外部工具。
`ToolExecutionContext` 增加可选 `fencingToken`，支持 Fencing 的外部系统可据此拒绝
旧请求。

边界：`fencing_token` 只能保护 ForgeFlow 控制的数据库和支持 Fencing 的外部 API。
它不能强制阻止任意外部 Write 已由旧 Worker 发出。外部 Write 仍必须依赖稳定
idempotency key、外部查询或人工核对。

## 5. 统一状态机

### TaskStatus

```text
queued
running
pause_requested
paused
cancel_requested
waiting_approval
waiting_review
completed
failed
cancelled
```

主要转换：

```text
queued -> running | cancel_requested
running -> pause_requested | cancel_requested | waiting_approval | waiting_review
running -> completed | failed
pause_requested -> paused | waiting_review | cancel_requested
paused -> running | cancel_requested
cancel_requested -> cancelled | waiting_review
waiting_approval -> running | cancel_requested | failed
waiting_review -> running | failed | cancelled
waiting_review + cancel intent -> waiting_review
completed / failed / cancelled -> terminal
```

补充规则：

- `pause_requested` 等待底层 Write settle 时，如果 Write 变为 unknown，
  必须进入 `waiting_review`。
- `waiting_approval` 收到取消时，先进入 `cancel_requested`，不得直接跳过
  活跃审批清理。
- Task 已经处于 `waiting_review` 时再次收到取消，状态保持 `waiting_review`，
  只更新 `cancel_requested_at`。
- 只有不存在 active `recovery_reviews` 时，Task 才允许进入 `cancelled`。
- 除已经处于 `waiting_review` 的情形外，取消不得绕过 `cancel_requested`。
  queued、running、pause_requested、paused、waiting_approval 都必须先进入
  `cancel_requested`。
- paused 收到取消时进入 `cancel_requested`，清理审批/活跃状态后再转 cancelled。
- waiting_approval 收到取消时进入 `cancel_requested`，将 pending approval
  安全取消。
- 若已有 cancel intent，`waiting_review` 核对完成后只能进入 `cancelled`，
  不得恢复继续执行。

取消入口复核：

| 当前状态 | 收到取消后的动作 |
|---|---|
| queued | queued -> cancel_requested |
| running | running -> cancel_requested |
| pause_requested | pause_requested -> cancel_requested |
| paused | paused -> cancel_requested |
| waiting_approval | waiting_approval -> cancel_requested |
| waiting_review | 保持 waiting_review，只写 cancel intent |
| cancel_requested | 保持 cancel_requested |

除已经处于 `waiting_review` 的情形外，其他任何状态不得直接进入 `cancelled`。

Task `waiting_review -> running` 的前置条件必须全部满足：

1. `cancel_requested_at IS NULL`，不存在取消意图。
2. 不存在 active RecoveryReview，即 `pending` 或 `unresolved`。
3. 所有关联 Unknown Write 都有明确核对结论。
4. `confirmed_succeeded` 的 Write 不得自动重复执行。
5. 若确认成功但没有可信原始 Tool Result，后续步骤需要该结果时必须先执行
   Read-back。
6. `confirmed_not_executed` 对应 PlanStep 必须先转为 failed；之后通过重新规划
   生成新的计划，不得直接执行原 Unknown Write。
7. 当前 Worker 持有有效 Lease/Fencing Token，并通过 ExecutionStateMachine。

如果存在 cancel intent，Task 在 RecoveryReview 完成后只能进入 cancelled。
如果仍有 active RecoveryReview，Task 必须保持 waiting_review。普通 Resume
接口不得绕过上述条件。

### ToolRunStatus

```text
queued
awaiting_approval
running
interrupted
succeeded
failed
timed_out
unknown
cancelled
skipped
```

Read ToolRun：

```text
queued -> running
queued -> failed | skipped | cancelled
running -> succeeded | failed | timed_out | cancelled
running + process crash -> interrupted
interrupted -> queued | failed | skipped | cancelled
```

Write ToolRun：

```text
queued -> running
queued -> awaiting_approval -> running
queued / awaiting_approval -> failed | skipped | cancelled
running -> succeeded | unknown
running + process crash -> unknown
```

`ExecutionStateMachine` 必须接收 ToolRun.mode，并按 Read/Write 分别校验转换。
同一 `running -> failed` 或 `running -> cancelled` 转换对 Write 必须拒绝。

`queued -> failed` 用于工具函数尚未启动，但前置步骤已经确定失败的情况，例如：

- Zod 输入校验失败
- Tool Version / Schema Hash 不匹配
- 工具不存在或元数据异常
- 审批输入无法安全生成

这类失败可以确认外部副作用未发生，因此是 `failed`，不是 `unknown`。

| 场景 | Read | Write |
|---|---|---|
| 正常成功 | succeeded | succeeded |
| 正常抛错 | failed | unknown，因为副作用可能已发生 |
| 超时 | timed_out | unknown |
| 执行中取消 | cancelled | unknown |
| 执行前取消 | cancelled | cancelled |
| 审批拒绝 | 不适用 | skipped |
| 进程崩溃 | interrupted，可安全重试 | unknown，不自动重试 |

Read / Write 差异必须由状态机显式执行：

- Read 失败、超时、输出序列化/输出校验失败可以进入 failed/timed_out，
  外部副作用风险较低；若 Read 成功但 Result 事务提交失败，恢复时转
  interrupted，可安全重新执行。
- Write 在执行函数启动后出现以下任一情况，一律 unknown：
  - 工具抛错
  - 超时
  - 执行中取消
  - 输出无法序列化
  - 输出校验失败
  - Result Commit 失败
  - 进程崩溃导致无法确认结果
- Write 只有在工具函数尚未启动且前置阶段明确失败时才可 failed，例如
  Zod 校验、Tool Version 校验或审批输入生成失败。
- Write unknown 不自动重试，必须进入 recovery_review。
- Write `unknown` 是执行 attempt 的事实状态，不通过修改 ToolRun 状态表达
  Review 结论；Review 结论保存在 recovery_reviews。

Result Commit 失败时，如果仍能写入数据库，应保留 ToolRun 为 unknown；
如果数据库已不可写，重启后依据持久化的 `running(write)` 自动恢复为 unknown。

### PlanStepStatus

```text
queued
running
awaiting_approval
waiting_review
interrupted
completed
failed
skipped
cancelled
```

完整转换：

```text
queued -> running
queued -> awaiting_approval
queued -> skipped | cancelled | failed
running -> completed | failed | cancelled | waiting_review
running(read) + crash -> interrupted
interrupted -> running | skipped | cancelled | failed
awaiting_approval -> running | skipped | cancelled | failed
waiting_review -> completed | failed | cancelled
completed / failed / skipped / cancelled -> terminal
```

PlanStep 规则：

- Read Batch 只有在所有 ToolRun 都进入 terminal 状态后才可 completed。
- Read Batch 部分失败时，PlanStep 可为 completed；每个 ToolRun 保留
  succeeded/failed/timed_out 等独立结果。
- Read Batch 中途崩溃时，PlanStep 进入 interrupted；恢复后重新进入 running，
  只重跑 interrupted/queued 的 Read。
- Write 已启动但结果 unknown 时，PlanStep 进入 waiting_review，Task 同步进入
  waiting_review。ToolRun 的 unknown 表示该执行 attempt 已结束且不可自动重试，
  但 PlanStep 尚未达到可继续或可终止的安全状态。
- Review 确认成功：PlanStep -> completed，并保存带来源标记的核对结论；
  不能伪造原始 Tool Result。
- Review 确认未执行：PlanStep -> failed，按策略重新规划。
- Review 仍无法确认：PlanStep 保持 waiting_review，Task 保持重复核对状态，
  不允许自动执行后续步骤。
- Write 审批拒绝或确认未启动失败时，PlanStep -> skipped。
- 因前序失败、取消或 Write unknown 而未启动的后续 PlanStep -> skipped。
- 不允许 PlanStep 标记 completed，同时存在下文定义的 completion-blocking
  ToolRun/RecoveryReview 组合。

数据库事务在完成 PlanStep 前必须执行检查：

```text
NOT EXISTS blocking tool_runs for plan_step_id
```

其中 completion blocking 条件：

```text
tool_run.status IN (queued, awaiting_approval, running, interrupted)
OR (
  tool_run.status = unknown
  AND (
    recovery_review.id IS NULL
    OR recovery_review.status != confirmed_succeeded
  )
)
```

`unknown + confirmed_succeeded` 不阻塞 PlanStep completed；
`unknown + confirmed_not_executed` 必须把 PlanStep 转为 failed，且该组合必须
构成 completion blocker。
`unknown` 是 ToolRun attempt 的终态，但不是 PlanStep 在 pending/unresolved
Review 下的完成安全状态。

三种 Review 结论的强制规则：

| ToolRun | RecoveryReview | PlanStep |
|---|---|---|
| unknown | pending | 保持 waiting_review |
| unknown | unresolved | 保持 waiting_review |
| unknown | confirmed_succeeded | 只有在完成证据可信、Review 正式完成后才允许 completed |
| unknown | confirmed_not_executed | 必须 failed，禁止 completed |

- 不存在 RecoveryReview 的 Unknown Write 一律阻塞，不允许自动视为成功。
- `confirmed_succeeded` 必须具有完成时间、来源和证据引用；没有可信证据不得
  解锁 PlanStep。
- Read Batch 只有在所有 ToolRun 已有明确结果，且不存在未解决 Unknown Write
  时才能 completed。部分 Read failed/timed_out 不阻止 PlanStep completed。

数据库必须在 PlanStep 更新为 completed 的同一事务中执行上述查询。此外增加
SQLite trigger，使业务层无法绕过：

```text
BEFORE UPDATE OF status ON plan_steps
WHEN NEW.status = 'completed'
AND EXISTS blocking ToolRun/RecoveryReview for NEW.id
RAISE(ABORT, 'plan step has blocking tool run')
```

RecoveryReview 由 pending/unresolved 更新为 confirmed_not_executed 时，如果关联
PlanStep 已 completed，必须拒绝。Review 最终决定在 PlanStep completed 后不可
原地改写为 confirmed_not_executed；后续新证据通过新事件和安全流程处理。

Confirmed Success 但没有原始 Tool Result：

- 不得伪造原始 output。
- ToolRun.output_json 保持 NULL，除非有可信 Read-back。
- RecoveryReview 保存核对决定、核对说明、证据引用、来源类型和完成时间。
- 原始 Unknown Write ToolRun 保持 unknown 状态和历史审计关联，不改写为 succeeded。
- 人工核对结论必须明确标记为 `manual_review` 或受控 `system_verification`，
  不得伪装成原始工具执行输出。
- 若后续模型或步骤需要具体结果，必须执行安全 Read-back，并把 Read-back
  作为新的 Read ToolRun 和新的 Tool Message 追加。
- Read-back 必须有独立 Call ID、幂等键、Tool Run、执行时间、输入和输出记录，
  不能覆盖原 Unknown Write。
- 如果 Read-back 无法获得所需数据，Task 不得伪造 Tool Result 继续运行。
- 核对结论可以用于解除 PlanStep 的 review blocker，但不能冒充原始工具输出。

SQLite trigger 可增加相同约束作为第二道防线。

所有 status/kind/mode 字段增加 SQLite CHECK。状态转换由
`ExecutionStateMachine` 与 compare-and-swap SQL 管理，CHECK 只保证枚举合法。

## 6. 工具版本一致性

`tool_runs` 增加：

```text
tool_version
input_schema_hash
canonical_input_hash
mode
requires_approval
```

`ToolDefinition` 增加显式 `version`，现有工具默认版本为 `"1"`，保持兼容。
`input_schema_hash` 由 Zod Schema 的 draft-07 input JSON Schema 计算；
`canonical_input_hash` 由 Registry 标准化并深冻结的输入计算。

版本语义：

- `version` 表示工具执行契约/语义版本，不是 Schema 版本。
- 任何不兼容的执行语义变化都必须主动提升 `version`，包括副作用、
  错误分类、幂等行为、权限要求或结果含义变化。
- `input_schema_hash` 只能检测 Schema 变化，不能发现工具函数内部实现变化。
- 因此恢复判断必须以显式 `tool_version` 为主，Schema Hash 为辅助。
- 未提升版本但内部实现变化的工具，视为工程纪律错误；系统无法自动检测。

恢复时重新计算当前工具的：

```text
tool_version + input_schema_hash + mode + requires_approval
```

任一项与持久化 Tool Run 不一致时，禁止自动执行，返回安全错误
`TOOL_DEFINITION_CHANGED`，Task 进入 `waiting_review` 或 failed。绝不能静默使用
新版本工具继续旧任务。

审批记录绑定：

```text
tool_run_id
tool_version
canonical_input_hash
```

版本或输入 Hash 变化后，旧审批不得复用。

## 7. Model Call 中断恢复

`model_calls.status`：

```text
requested
completed
failed
interrupted
cancelled
```

调用 Provider 前先提交 `requested` Model Call 和 request_json。进程崩溃后：

1. 将遗留 `requested` 标记为 `interrupted`。
2. 不把未持久化响应视为成功。
3. 根据最后已提交 Message/Checkpoint 重建请求。
4. 创建 `attempt_no = N + 1` 的新 Model Call。
5. 保留所有旧 attempt。
6. 明确允许重复 Provider API 调用和重复费用。

Model Call 没有业务外部副作用，可以安全重新请求，但不得覆盖旧记录或伪造 Usage。

## 8. Canonical JSON 与幂等键

允许值：

- null
- boolean
- finite number，排除 NaN、Infinity、-0
- string
- array
- plain object

拒绝值：

- BigInt、undefined、Symbol、function
- Date、Map、Set、自定义原型
- 循环引用
- 稀疏数组和额外数组属性
- Symbol key
- getter/accessor

Canonical 规则采用 RFC 8785 JSON Canonicalization Scheme（JCS）：

1. Object key 按 ECMAScript/UTF-16 code unit 的确定性 lexicographic 顺序排序。
2. Array 保持顺序。
3. 不输出无意义空白。
4. 使用标准 JSON escaping。
5. 对 canonical UTF-8 字节计算 SHA-256。

不再同时接受 Unicode code point 与 UTF-16 两套排序语义；所有实现和测试统一
以 RFC 8785 JCS 为唯一规则。

ForgeFlow 仍在 JCS 之前执行项目级严格预校验并拒绝 `-0`。这是一层额外的输入
安全策略，不改变 RFC 8785 的排序/编码算法；只有通过预校验的值才进入 JCS。

```text
canonical_input_hash = sha256(canonicalJson(validatedInput))
input_schema_hash = sha256(canonicalJson(draft07InputSchema))
```

幂等键使用固定域前缀 + JCS 数组，不直接拼接普通字符串：

```text
domain = "forgeflow.tool-idempotency.v1"
payload = [
  taskId,
  planVersion,
  originalIndex,
  toolName,
  toolVersion,
  inputSchemaHash,
  canonicalInputHash
]

idempotencyKey =
  "sha256:" + hex(sha256(utf8(domain + "\n" + JCS(payload))))
```

`domain` 用于隔离不同用途的 Hash；数组保留固定字段顺序。JCS 只负责数组内
Object 的键顺序。

不同工具版本不得无条件复用旧 idempotency record。`idempotent=true` 只说明同一
幂等键重复调用安全，不代表可以自动盲目重试；仍需版本、审批和恢复策略验证。

## 9. 数据库与事务边界

表：

- schema_migrations
- tasks
- task_leases
- messages
- model_calls
- execution_plans
- plan_steps
- tool_runs
- approvals
- recovery_reviews
- checkpoints
- events

`tasks` 增加：trace_id、status、objective、system_prompt、current_iteration、
max_model_turns、max_tool_calls、token_usage_json、version、cancel_requested_at、
pause_requested_at、last_event_sequence、final_answer、last_error_json、时间戳。

`task_leases` 保存 owner、lease_token、fencing_token、expires_at、heartbeat_at。

`messages`：

```text
id, task_id, sequence, role, content, tool_call_id, tool_calls_json, created_at
UNIQUE(task_id, sequence)
```

`model_calls`：

```text
id, task_id, iteration, attempt_no, status, request_json, response_json,
usage_json, finish_reason, provider_request_id, duration_ms, error_json, 时间戳
UNIQUE(task_id, iteration, attempt_no)
```

`execution_plans` / `plan_steps`：

```text
plan: id, task_id, version, source_model_call_id, status, 时间戳
step: id, plan_id, step_index, kind, status, 时间戳
UNIQUE(task_id, version), UNIQUE(plan_id, step_index)
```

`tool_runs`：

```text
id, task_id, plan_step_id, call_id, original_index, tool_name,
tool_version, input_schema_hash, canonical_input_hash, mode,
requires_approval, status, input_json, output_json, error_json,
idempotency_key, attempt_no, started_at, finished_at, version
UNIQUE(task_id, call_id), UNIQUE(plan_step_id, original_index),
UNIQUE(idempotency_key)
```

`approvals`：id、task_id、tool_run_id、status、tool_version、
canonical_input_hash、request_json、reason、requested_at、expires_at、decided_at。

`recovery_reviews`：id、task_id、tool_run_id、status、note、source_type、
evidence_ref、created_at、decided_at。

审批与恢复核对唯一性：

```sql
CREATE UNIQUE INDEX ux_approvals_one_per_run
ON approvals(tool_run_id);

CREATE UNIQUE INDEX ux_approvals_pending
ON approvals(tool_run_id)
WHERE status = 'pending';

CREATE UNIQUE INDEX ux_recovery_reviews_one_per_run
ON recovery_reviews(task_id, tool_run_id);

CREATE UNIQUE INDEX ux_recovery_reviews_pending
ON recovery_reviews(tool_run_id)
WHERE status IN ('pending', 'unresolved');
```

Approval 采用单记录模式：

- 一个 ToolRun 只允许一条 Approval 记录，`UNIQUE(tool_run_id)`。
- `approvals.status` 允许 pending、approved、rejected、expired、cancelled。
- 数据库 CHECK 必须限制上述 Approval 枚举。
- 审批过期、取消或重新申请时更新原记录状态与时间字段，不新增第二条有效记录。
- 完整审批历史通过 append-only `events` 保存，例如 request、approved、rejected、
  expired、cancelled、re-requested。
- 同一 ToolRun 最多存在一条 pending Approval。

`recovery_reviews.status`：

```text
pending
confirmed_succeeded
confirmed_not_executed
unresolved
```

约束：

```text
status IN (
  'pending',
  'confirmed_succeeded',
  'confirmed_not_executed',
  'unresolved'
)
```

正式完成结论必须有来源和完成时间：

```text
status IN ('confirmed_succeeded', 'confirmed_not_executed', 'unresolved')
  -> source_type IS NOT NULL AND decided_at IS NOT NULL

status = 'confirmed_succeeded'
  -> evidence_ref IS NOT NULL
```

- `confirmed_succeeded`：PlanStep -> completed。
- `confirmed_not_executed`：PlanStep -> failed，随后重新规划。
- `unresolved`：PlanStep 与 Task 保持 waiting_review，不允许自动继续。
- pending/unresolved 视为 active recovery。
- 一个 ToolRun 只允许一条 RecoveryReview；后续核对更新原记录并在 events 中
  追加历史，不得创建并行 unresolved/pending 记录。

`checkpoints`：

```text
id, task_id REFERENCES tasks(id), sequence, reason, task_status,
last_message_sequence, model_iteration, plan_version, last_event_sequence,
budget_json, metadata_json, created_at
UNIQUE(task_id, sequence)
```

`events`：

```text
id, task_id REFERENCES tasks(id), sequence, trace_id, type, entity_type, entity_id,
payload_json, created_at
UNIQUE(task_id, sequence)
```

Events 是 append-only 审计事实：

- 只允许 INSERT，禁止 UPDATE 和 DELETE。
- 每次追加 Event 的同一事务内执行
  `tasks.last_event_sequence = tasks.last_event_sequence + 1`，并用新值作为
  Event sequence；不得在事务外分配序号。
- 业务状态变更、ToolRun 结果、Checkpoint 写入和对应 Event 必须同一事务提交。
- Approval 请求/决定、RecoveryReview 决定、Lease claim/expiry/lost/release、
  人工核对操作都追加 Event。
- Event payload 必须通过 Zod/JSON 校验和安全字段白名单；禁止 API Key、
  Authorization Header、工具凭证和未脱敏敏感输入。

数据库级不可变性：

```text
BEFORE UPDATE ON events -> RAISE(ABORT, 'events are append-only')
BEFORE DELETE ON events -> RAISE(ABORT, 'events are append-only')
```

Trigger 是强制保护，不能只依赖 Repository 约定。

所有业务表主键、外键、唯一约束和 CHECK：

| 表 | PK | FK | 必要 UNIQUE | CHECK |
|---|---|---|---|---|
| schema_migrations | version | 无 | version | 无 |
| tasks | id | 无 | trace_id | status |
| task_leases | task_id | tasks.id | task_id, lease_token | fencing_token >= 1 |
| messages | id | tasks.id | task_id+sequence | role |
| model_calls | id | tasks.id | task_id+iteration+attempt_no | status |
| execution_plans | id | tasks.id, model_calls.id | task_id+version | status |
| plan_steps | id | execution_plans.id | plan_id+step_index | kind, status |
| tool_runs | id | tasks.id, plan_steps.id | task_id+call_id, plan_step_id+original_index, idempotency_key | mode, status |
| approvals | id | tasks.id, tool_runs.id | tool_run_id | status |
| recovery_reviews | id | tasks.id, tool_runs.id | task_id+tool_run_id | status |
| checkpoints | id | tasks.id | task_id+sequence | task_status |
| events | id | tasks.id | task_id+sequence | 无固定 type enum |

所有 FK 使用显式引用字段，默认 `ON DELETE RESTRICT`；Phase 3 不支持隐式删除
Task 或级联清除审计数据。所有必填列加 `NOT NULL`，JSON 列写入/读取均做 Zod 校验。

JSON 列写入和读取都必须通过 Zod。数据库不保存 API Key、Authorization Header
或 Provider 凭证。

`schema_migrations` 是正式运行表清单的一部分，必须先于业务表创建并在生产
连接初始化时检查。

Tool Message 必须增加部分唯一索引：

```sql
CREATE UNIQUE INDEX ux_messages_tool_result
ON messages(task_id, tool_call_id)
WHERE role = 'tool' AND tool_call_id IS NOT NULL;
```

这防止同一 Task 的同一个 Tool Call ID 重复写入 Tool Result。

### 敏感数据持久化规则

- 禁止持久化 Provider API Key、Authorization Header、Bearer Token。
- 工具凭证不得通过 LLM Tool Call 参数传递；工具应从受控环境变量或 Secret
  Provider 读取。
- Schema 明确标记的 credential 字段必须拒绝；不得只依赖字符串猜测。
- 用户消息、Model Request、Tool Input 和 Tool Result 可能包含业务敏感信息：
  - 仅保存在本地数据库，不写入普通日志、事件 payload 或错误文本。
  - 只有恢复确有必要的数据才持久化。
  - `data/` 与数据库文件不得进入 Git。
- 审批数据分两类：
  - `input_json` 是恢复/执行需要的原始标准化输入。
  - `display_input_json` 是给审批界面的脱敏展示数据。
- 审批 Hash 和工具版本绑定原始标准化输入；脱敏展示数据不参与执行。
- 诊断事件允许使用安全引用 ID 和脱敏摘要，不得保存完整 API Key、
  Authorization Header 或工具凭证。
- 脱敏数据不能用于恢复工具执行。若因策略拒绝持久化执行所需原始输入，
  该任务必须标记为不可自动恢复，并转入人工核对。
- 当前阶段不承诺数据库文件静态加密（encryption at rest）；这是明确的
  部署层安全边界。

## 10. TaskSnapshot 一致性与 UoW

完整 `TaskSnapshot` 分阶段实现，不能在依赖表尚未创建时声称已完成：

- Step 2：基础 Snapshot 只包含 tasks、messages、model_calls、events、
  checkpoints。
- Step 3：扩展 Snapshot 加入 plans、plan_steps、tool_runs、approvals、
  recovery_reviews。
- Step 4：加入任务 lease，形成最终完整 Snapshot。

Step 4 完成后，`TaskRepository.loadSnapshot(taskId)` 必须在同一个 SQLite read
transaction 中读取：

```text
task + lease + messages + model_calls + plans + steps
+ tool_runs + approvals + recovery_reviews + latest checkpoint
+ last event sequence
```

禁止不同 Repository 分别查询后拼接出不同时刻的快照。WAL 下 read transaction
必须保持到全部相关查询完成。

ExecutionUnitOfWork 的关键事务：

```text
create task: task + messages + event + initial checkpoint
model response: model_call completed + assistant message
                + plan/steps + tool run intents + event + checkpoint
tool intent: tool_run running + idempotency binding + event + checkpoint
tool result: tool_run terminal + tool message + step update
             + event + checkpoint
approval: approval state + tool run + task status + event + checkpoint
```

外部工具调用只能发生在 Intent 事务提交后、Result 事务提交前。

## 11. 异常恢复流程

```text
启动
  -> migrations + PRAGMA
  -> 查找过期 lease 的可恢复 Task
  -> 原子 claim lease（新 lease_token + fencing_token）
  -> 在同一 read transaction 加载 TaskSnapshot
  -> 校验 JSON、状态、工具版本、消息/Plan/Tool/Event 序号
  -> 将遗留 requested Model Call 标记 interrupted
  -> 处理非终态 Tool Runs
  -> 仅从安全持久化边界继续
  -> completed / paused / waiting_approval / waiting_review
  -> 释放 lease
```

Read 崩溃：

1. `running(read)` 转 interrupted。
2. Task 无 pause/cancel intent 时重新 queued。
3. 使用原 Call ID、originalIndex、工具版本和幂等键重跑。

Write 崩溃：

1. `running(write)` 必须转 unknown。
2. 创建 pending recovery_review。
3. 不自动重试。
4. 有 cancel intent 时，review 后最终 cancelled。
5. 无 cancel intent 时，才允许根据 review 重新规划或继续。

waiting_review 恢复检查：

- active RecoveryReview 存在时保持 waiting_review。
- cancel intent 存在时，review 完成后只允许 cancelled。
- 无 cancel intent 且所有 Unknown Write 明确完成后，才可按第 5 章条件转 running。

Model Call 崩溃：

1. `requested` 转 interrupted。
2. 不保存推测响应。
3. 从最后持久化消息创建新 attempt。

引用不一致时禁止自动执行，Task 进入 failed 或 waiting_review，并记录
`STATE_INCONSISTENT`。

## 12. Pause / Resume / Cancel

Pause：

1. 持久化 pause intent，Task -> pause_requested。
2. 不启动新工具，abort 活跃工具。
3. 等待底层 Promise settle。
4. Read 未完成转 interrupted；Write 已启动且无法确认转 unknown。
5. 保存 Checkpoint，Task -> paused 或 waiting_review。
6. 释放 lease。

Resume：

1. 获取新 lease 和 fencing token。
2. 加载一致性 snapshot。
3. 校验工具版本和审批绑定。
4. `waiting_approval` / `waiting_review` 不允许普通自动 resume。
5. `waiting_review -> running` 必须满足第 5 章的全部前置条件：
   - 无 cancel intent
   - 无 active RecoveryReview
   - 所有 Unknown Write 已明确核对
   - confirmed success 不重复执行
   - 缺少数值结果时先 Read-back
   - confirmed_not_executed 先转 PlanStep failed 再重新规划
   - lease/fencing/state machine 校验通过
6. 有 cancel intent 时只允许最终 cancelled。
7. 安全 Plan 从未完成项继续；否则从下一模型轮次重新规划。

Cancel：

1. 先在事务中持久化 `cancel_requested_at`。
2. 不启动新工具，abort 活跃工具。
3. 等待已有任务 settle。
4. 根据来源状态执行：

| 收到取消时状态 | 状态动作 |
|---|---|
| queued | queued -> cancel_requested |
| running | running -> cancel_requested |
| pause_requested | pause_requested -> cancel_requested |
| paused | paused -> cancel_requested |
| waiting_approval | waiting_approval -> cancel_requested，并取消 pending approval |
| waiting_review | 保持 waiting_review，仅记录/保留 cancel intent |

5. 进入 `cancel_requested` 后，如果存在已启动 Write Unknown，Task ->
   waiting_review。
6. 如果没有 active recovery review，Task -> cancelled。
7. waiting_review 在 active review 完成前不得 cancelled；review 完成后，
   因 cancel intent 已存在，最终必须 cancelled。
8. 不允许 cancelled 状态仍有 active recovery review。

## 13. 七步开发计划

依赖关系：

```text
Step 1 SQLite Foundation
  -> Step 2 基础 Repository / Snapshot
  -> Step 3 Plan/Tool/Approval Repository + UoW
  -> Step 4 Lease/Fencing/StateMachine
  -> Step 5 AgentRunner/TaskScheduler 持久化集成
  -> Step 6 Recovery/Pause/Resume/Cancel/Idempotency/Review
  -> Step 7 故障注入与最终验收
```

Step 4 是 Step 5 的硬前置条件。任何持久化 Agent 执行都不能在未获得有效
lease_token + fencing_token 的情况下启动。

### Step 1：SQLite Foundation

范围：安装并锁定 `better-sqlite3` 与类型；database/migrations；DATABASE_PATH；
WAL/FULL/FK/busy_timeout；初始 migration；同步事务包装器。

验收：

- 新库可初始化，重复 migration 幂等。
- migration 失败整体 rollback。
- 使用文件型临时数据库验证 `PRAGMA journal_mode` 返回 `wal`。
- 显式设置 `PRAGMA synchronous=FULL`，实际查询 `PRAGMA synchronous` 返回 `2`。
- 实际查询 `PRAGMA foreign_keys` 返回 `1`。
- 每个新打开的数据库连接都执行必要初始化：foreign_keys、busy_timeout、
  所需同步配置；不得只初始化第一个连接。
- 测试数据库路径与生产 `data/forgeflow.db` 严格隔离；测试使用独立临时文件，
  测试结束后清理。
- import 模块不自动创建生产数据库。
- WAL 验收使用文件型临时数据库，不能只用 `:memory:`。
- `better-sqlite3` transaction callback 必须是同步函数；代码禁止 `async`
  callback、`await` 或返回 Promise。
- 事务内部不得等待 Provider、工具执行、审批 Handler 或其他外部 Promise。
- thenable guard 必须在 `better-sqlite3` transaction callback 内部、
  transaction 提交之前执行；若 callback 返回 thenable，必须立即抛错并回滚。
  不允许在 transaction 已提交后再检查 Promise。

### Step 2：Task / Message / Model Call Repository

范围：tasks、messages、model_calls、events、checkpoints；sequence allocator；
Zod JSON codec；单一 read transaction 的基础 TaskSnapshot；Task 创建与
Model Call 事务。

验收：

- Message sequence 唯一。
- 基础 Snapshot 在同一个 read transaction 中读取 tasks/messages/model_calls/
  events/checkpoints。
- Model Call attempt 独立保存。
- Event sequence 同一事务递增；UPDATE/DELETE trigger 生效。
- JSON 损坏被拒绝。
- 事务失败完全 rollback。
- 此时不得声明已包含 Plan、ToolRun、Approval、RecoveryReview 或 Lease。

### Step 3：Plan / Tool Run / Approval Repository + UoW

范围：plans、steps、tool_runs、approvals、recovery_reviews；ExecutionUnitOfWork；
工具版本/Schema Hash/Input Hash/Mode/RequiresApproval；扩展 Snapshot 加入这些表。

验收：

- Assistant + Plan + 全部 Tool Run 原子创建。
- Tool Result + Tool Message + Step 状态原子提交。
- Call ID 与 originalIndex 完整。
- 审批绑定工具版本与输入 Hash。
- 不同 Tool Version 不复用审批或幂等记录。
- Approval / RecoveryReview 单记录与 active 唯一索引生效。
- PlanStep completion trigger 拒绝 active 或 confirmed_not_executed review。
- 扩展 Snapshot 在同一 read transaction 中读取 Plan/ToolRun/Approval/
  RecoveryReview。
- 此时仍不得声明已包含 Task Lease。

### Step 4：Task Lease + Fencing + State Machine

范围：lease/fencing、heartbeat、expiry、release、ExecutionStateMachine、
CHECK 约束、cancel_requested/waiting_review 状态；最终完整 TaskSnapshot
加入 lease。

验收：

- 两个 Worker claim 只有一个成功。
- fencing_token 单调递增。
- 旧 lease 无法 heartbeat。
- 旧 fencing token 无法提交状态。
- 非法转换被拒绝。
- ExecutionStateMachine 依据 mode 拒绝非法 Read/Write 转换。
- Write running 不得转 failed/timed_out/cancelled；只能 succeeded/unknown。
- cancelled 不允许 active（pending/unresolved）recovery review。
- waiting_review -> running 在无 cancel intent、无 active review、
  所有 Unknown Write 已核对时才能通过。
- 完整 TaskSnapshot 在同一个 read transaction 中包含 Step 2 基础数据、
  Step 3 执行数据和 lease。

任何持久化 Agent 执行都必须在本步骤完成后才允许集成。

### Step 5：AgentRunner / TaskScheduler 持久化集成

范围：持久化执行先获取 Step 4 ownership；AgentRunner 可选 persistence
coordinator 或 runFromState；TaskScheduler 恢复已有 Plan 和已完成 Tool Runs；
全部写入校验 lease/fencing/version；原无持久化路径保持不变。

验收：

- 未获取 lease 的持久化执行入口直接拒绝。
- 每次工具调用前 assertOwned + persistToolIntent。
- 所有状态写入校验 lease/fencing/version。
- Phase 1/2 的 130 个测试保持通过。
- 两条路径使用同一 Provider/Tool 协议。

### Step 6：Recovery / Pause / Resume / Cancel / Idempotency / Unknown Review

范围：RecoveryManager、Pause/Resume/Cancel、Read interrupted safe retry、
Write unknown review、canonical JSON/hash/idempotency、tool version mismatch 阻止恢复。

验收：

- Read crash 不重复已完成步骤。
- Write crash 不自动重试。
- waiting_review 支持确认成功、确认未发生、仍未知。
- confirmed_succeeded 允许 PlanStep completed；confirmed_not_executed 转 failed；
  unresolved 保持 waiting_review。
- 无原始 Tool Result 的 confirmed_succeeded 使用来源标记核对结论，不伪造 output；
  需要具体值时执行安全 Read-back。
- cancel intent 存在时 review 后只能 cancelled。
- stale worker 无法提交结果。
- 版本不匹配不执行。
- duplicate Intent 被唯一约束阻止。

### Step 7：故障注入与最终验收

故障点：

- Lease 获取前/后
- Tool Intent 前/后
- 外部工具成功后、Result Commit 前
- Model Call requested 后
- Checkpoint 前后
- Pause/Cancel/Approval 决策边界

验收：

- 每个故障点都能恢复为明确状态。
- Unknown Write 不自动继续。
- stale Worker 写入被拒绝。
- 所有 Tool Call 有唯一结果或明确 pending/unknown。
- `pnpm test`、`pnpm typecheck`、`git diff --check` 全部通过。
- Mock 模式不需要 API Key。

## 14. 完整测试清单

数据库：

- fresh migrate、重复 migrate、失败 rollback。
- 文件型临时库验证 WAL；`PRAGMA synchronous` 返回 2；`foreign_keys` 返回 1。
- 每个新连接都重新执行连接初始化。
- 测试和生产数据库路径隔离。
- transaction callback 返回 Promise 时拒绝；事务内无 await。
- JSON 写入/读取 Zod 校验。
- Step 2 基础 Snapshot、Step 3 扩展 Snapshot、Step 4 完整 Snapshot
  都在各自阶段的单一 read transaction 中读取。
- Message/Event sequence 唯一。
- Event UPDATE/DELETE 被 trigger 拒绝；业务状态和 Event 同事务提交。
- 同一 Task + Tool Call ID 的 Tool Message 唯一。
- Checkpoint 引用完整。

状态与租约：

- Task/Tool/Plan 合法与非法转换。
- pause_requested -> waiting_review。
- waiting_approval -> cancel_requested。
- waiting_review 收到取消后保持 waiting_review 并记录 cancel intent。
- queued ToolRun 因前置验证失败转 failed。
- ExecutionStateMachine 依据 mode 拒绝 Read/Write 非法转换。
- Write running -> failed/timed_out/cancelled 必须被拒绝并转 unknown。
- PlanStep completed 时不存在非终态 ToolRun。
- Read Batch 部分失败、崩溃恢复和 Write unknown 的 PlanStep 状态。
- unknown + confirmed_succeeded 可 completed；unknown + pending/unresolved 阻塞；
  unknown + confirmed_not_executed 转 failed。
- PlanStep completed trigger 在 active review 或 confirmed_not_executed 时拒绝。
- models/approvals/recovery_reviews CHECK。
- lease claim、heartbeat、expiry、release。
- fencing 单调递增。
- stale lease/fencing 写入失败。
- cancelled 与 active recovery review 互斥。
- pending/unresolved 都阻止 cancelled。

事务与消息：

- Assistant + Plan + Tool Runs 原子写入。
- Tool Result + Tool Message + Step 原子写入。
- SQL 中途失败整体 rollback。
- Call ID / originalIndex 无丢失。
- 每个 Tool Call 只有一条结果。

恢复：

- Read running crash -> interrupted -> retry。
- Write running crash -> unknown。
- external success / result commit failure -> unknown。
- Model requested crash -> interrupted + 新 attempt。
- waiting_approval/waiting_review 重启不自动执行。
- waiting_review 只在无 cancel intent、无 active review、所有 Unknown Write
  已核对且 lease/fencing 有效时才能恢复 running。
- 有 cancel intent 时 waiting_review 只能 cancelled。
- confirmed_not_executed 先 PlanStep failed，再生成新计划，不执行原 Unknown Write。
- pause 后不自动运行。
- resume 从正确边界继续。
- cancel 最终 terminal。
- Tool Version 变化阻止执行。
- Snapshot 损坏拒绝自动恢复。

幂等与审批：

- canonical key ordering。
- Array order 保持。
- 非 JSON 输入拒绝。
- 相同输入稳定 Hash。
- 不同 Version 不共享 key/审批。
- duplicate intent 唯一约束。
- idempotent=true 也不自动盲重试。
- recovery review 三种决定。
- 一个 ToolRun 只有一条 Approval 和一条 RecoveryReview。
- Approval 过期/取消/重新申请只更新原行，历史保存在 events。
- RecoveryReview 更新使用原记录，历史保存在 events。
- confirmed_succeeded 无原始 output 时不伪造；需要结果时安全 Read-back
  生成新 Read ToolRun。
- Idempotency 使用固定 domain + JCS 数组，不能字符串拼接。
- JCS 前继续拒绝 -0。

SQLite 错误：

- SQLITE_BUSY 有界指数退避。
- SQLITE_LOCKED 先分类，不默认重试。
- commit 结果不确定时不重试猜测成功。

敏感信息：

- Provider API Key / Authorization Header 不进入数据库、日志和事件。
- credential 字段拒绝进入 LLM Tool 参数。
- User Message、Model Request、Tool Input 不进入普通日志和事件 payload。
- 审批展示使用脱敏副本，执行和恢复使用原始标准化输入。
- 脱敏数据不能用于恢复工具执行。

回归：

- Phase 1 的 33 个测试。
- Phase 2 的 130 个测试。
- Mock SQLite E2E。
- 非持久化与持久化 AgentRunner 路径。
- 多 Worker 并发。

## 15. 尚无法保证的工程边界

- 不保证外部系统 exactly-once。
- fencing_token 不能阻止不支持 Fencing 的外部 API 接受旧请求。
- 外部 Write 成功、SQLite Result 未提交时只能得到 unknown。
- 无外部查询能力时 Unknown Write 必须人工核对。
- FULL 仍无法抵御硬件、文件系统或存储故障。
- Provider 崩溃后重试可能产生重复 API 费用。
- SQLite 不是分布式数据库；多主机一致性不在本阶段范围。
- 不支持强制终止忽略 AbortSignal 的工具。
- Pause/Cancel 必须等待底层 Promise settle，可能延迟完成。
- 不自动回滚已成功的外部 Write。
- 未实现 MCP、真实 DeepSeek、Dashboard 或 Phase 4 Context/Loop Guard。

## 16. 开始实施前的批准条件

1. 接受 `WAL + synchronous=FULL` 作为默认策略。
2. 接受 `waiting_review` 为独立非终态。
3. 接受 TaskStatus 增加 pause_requested、cancel_requested、waiting_review。
4. 接受 ToolDefinition 增加显式 version，现有工具默认 `"1"`。
5. 接受 Tool Run 绑定 Version/Schema Hash/Input Hash。
6. 接受 Model Call requested/interrupted attempt 和重复 API 费用。
7. 接受 Step 4 先完成 Lease/Fencing，再进入 AgentRunner 持久化集成。

本文件是开始 Phase 3 Step 1 前的最新计划。等待审查后再进入实施。
