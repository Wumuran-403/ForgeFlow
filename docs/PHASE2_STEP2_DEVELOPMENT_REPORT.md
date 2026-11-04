# Phase 2 Step 2 Development Report

> 范围：Scheduler Planner
>
> 状态：Step 2 完成，仅生成执行计划
>
> 未包含：Read Worker Pool、并行执行、Write Executor、审批、超时执行、取消调度、AgentRunner 集成

## 1. 新增与修改文件

新增：

- `src/scheduler/types.ts`
- `src/scheduler/planner.ts`
- `src/scheduler/index.ts`
- `tests/scheduler/planner.test.ts`
- `docs/PHASE2_STEP2_DEVELOPMENT_REPORT.md`

未修改 Phase 1 的 AgentRunner、Provider、Tool Registry 或持久化模块。

## 2. Planner 接口

```ts
class TaskPlanner {
  constructor(registry: ToolRegistry);

  plan(toolCalls: readonly ToolCall[]): SchedulePlan;
}
```

`ScheduleStep` 有三种：

```ts
type ScheduleStep =
  | {
      kind: "read_batch";
      items: readonly PlannedKnownToolCall[];
    }
  | {
      kind: "write";
      item: PlannedKnownToolCall;
    }
  | {
      kind: "unknown_tool";
      item: PlannedUnknownToolCall;
      reason: "not_registered" | "invalid_metadata";
    };
```

每个已注册计划项保留：

- `originalIndex`
- `toolCallId`
- `toolName`
- `arguments`
- `mode`
- `timeoutMs`
- `requiresApproval`

Unknown Tool 不包含可信模式、超时或审批元数据，也不会暴露工具执行函数。

## 3. 调度算法

Planner 按原始 Tool Call 顺序同步遍历：

1. 安全元数据为 `read` 时加入当前 Read Batch。
2. 连续 Read 保持在同一批次。
3. 遇到 Write 时先提交当前 Read Batch，再将 Write 作为独立步骤提交。
4. 连续 Write 各自形成独立步骤，不合并。
5. 遇到未知工具时先提交当前 Read Batch，再提交独立 Unknown Tool Barrier。
6. Unknown Barrier 后的 Read 必须进入新的 Read Batch。
7. 遍历结束后提交最后一个 Read Batch。

`R1, R2, W1, R3, W2` 生成：

```text
read_batch[R1, R2]
write[W1]
read_batch[R3]
write[W2]
```

## 4. 元数据一致性

Planner 每次只调用 `ToolRegistry.get(name)` 获取当前安全元数据：

- 不维护第二份工具定义。
- 不读取或暴露原始执行函数。
- Registry 返回异常或元数据字段非法时，工具降级为 Unknown Tool Barrier。
- `mode` 总是通过 `ToolModeSchema` 再次校验。
- `timeoutMs` 必须为正整数。
- `requiresApproval` 必须为布尔值。

Planner 不自行获取执行租约。规划后立即释放租约会产生错误的安全承诺，因为定义
仍可能在真正执行前改变。Step 3 必须在 AgentRunner 已持有的整次运行租约内完成
规划与执行；此时 Registry 的注册和注销在整个 Run 期间均被禁止。

## 5. 测试矩阵

`tests/scheduler/planner.test.ts` 共 15 个测试：

| # | 测试 | 结果 |
|---|---|---|
| 1 | 单个 Read 生成一个 Read Batch | 通过 |
| 2 | 连续 Read 合并为一个 Batch | 通过 |
| 3 | 单个 Write 独立成为步骤 | 通过 |
| 4 | 连续 Write 生成多个独立步骤 | 通过 |
| 5 | `R1,R2,W1,R3,W2` 屏障顺序正确 | 通过 |
| 6 | 未知工具成为独立屏障 | 通过 |
| 7 | 未知工具不会被归类成 Read | 通过 |
| 8 | 原始 Tool Call ID 完整保留 | 通过 |
| 9 | 原始 index 完整保留 | 通过 |
| 10 | timeout 和 approval 元数据正确传递 | 通过 |
| 11 | 空 Tool Calls 返回空计划 | 通过 |
| 12 | 输入顺序和内容不被修改 | 通过 |
| 13 | Read 不会跨 Write/Unknown 错误合并 | 通过 |
| 14 | 缺失或异常元数据安全降级为 Unknown | 通过 |
| 15 | 租约期间仅规划、不执行且定义不可注销 | 通过 |

测试全部使用纯数据与同步断言，没有使用 `setTimeout` 模拟并发。

## 6. 实际验证结果

- `pnpm test`：8 个测试文件、59 个测试全部通过
- `pnpm typecheck`：通过，无 TypeScript 错误
- `git diff --check`：通过，无空白错误

Phase 1 原有测试与 Phase 2 Step 1 测试全部保持通过。

## 7. 当前设计限制

- Planner 只生成计划，不执行任何 Tool Call。
- Read Batch 的并发上限、Worker Pool 和部分失败隔离尚未实现。
- Write Approval、Write Executor、超时执行和取消调度尚未实现。
- Unknown Tool 的 Arguments 未预校验，因为安全预校验需要后续执行阶段和 Registry 令牌配合。
- Planner 依赖调用方在 Agent Run 租约内使用，不能单独保证“从规划到执行”期间定义不变。
- 计划对象使用 TypeScript readonly 类型，但尚未在运行时递归冻结。
- Planner 对工具元数据异常采用保守降级，不尝试修复或猜测缺失字段。

## 8. Step 3 接入方式

Step 3 应在 AgentRunner 已持有 Registry 执行租约时调用：

```ts
const plan = new TaskPlanner(registry).plan(response.message.toolCalls ?? []);
```

执行层应按计划顺序消费步骤：

1. Read Batch 交给下一阶段的只读执行器。
2. Write 保持独立屏障，等待前序步骤结束。
3. Unknown Tool 生成安全失败结果，不进入 Read 并发批次。
4. 所有结果写入以 `originalIndex` 为下标的固定结果数组。
5. 最终按原始 index 排序后再生成 Tool Message，不能使用完成顺序。
6. 规划和执行必须共享同一次 Registry 租约，避免元数据与执行定义不一致。

本阶段不进入 Step 3。
