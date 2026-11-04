# Phase 2 Step 1 Design Review

> 范围：工具执行接口、Registry 定义一致性、已验证输入执行
>
> 状态：Step 1 补充审查完成
>
> 未包含：Scheduler、Worker Pool、Write Executor、人工审批流程

## 1. Zod Transform 与异步 Refinement

最初 `validateInput()` 和 `execute()` 分别执行一次 Zod，因此先预校验再执行时
会让 transform、async refinement 和异步 schema 逻辑重复运行，也可能让审批看到的
标准化输入与工具实际收到的输入不一致。

修复方式：

- `validateInput(name, input)` 执行一次 `safeParseAsync()`。
- 校验结果经过严格 JSON 兼容性检查，再克隆并深冻结。
- Registry 使用私有 `WeakMap` 将 `ValidatedToolInput` 绑定到当前工具记录和标准化值。
- `executeValidated(validatedInput, context)` 只接受 Registry 签发且仍对应同一工具
  记录的令牌，不再次执行 Zod。
- `execute(name, input, context)` 先调用 `validateInput()`，再调用
  `executeValidated()`，保持原有公共调用方式。
- 如果工具已注销并重新注册，旧令牌会因工具记录身份不匹配被拒绝。

因此，审批展示使用的 `validatedInput.value` 就是执行函数收到的同一冻结值；
transform 和 async refinement 不会因审批预校验二次运行。

测试：

- `runs Zod transforms and async refinements once across validation and execution`
- `rejects a validated input after its tool definition is replaced`

## 2. 并发 Agent Run 租约

Registry 使用活动租约计数，而不是单个布尔锁：

- 每次 `AgentRunner.run()` 获取独立租约。
- 释放操作幂等。
- 一个租约释放只减少计数；计数归零后才恢复注册和注销能力。

并发测试验证：

1. Agent A 和 Agent B 共享同一个 Registry。
2. 两个 Agent 都进入 Provider 请求，证明两把租约均已获取。
3. Agent A 结束后，注册和注销仍被禁止。
4. Agent B 结束后，Registry 恢复修改能力。

测试：

- `keeps the registry locked until all concurrent Agent runs complete`

## 3. JSON 输入快照边界

工具执行输入明确要求为 JSON 兼容数据。Zod 校验成功后仍必须通过 JSON 边界检查，
不能依赖 `JSON.stringify()` 自动转换语义。

允许：

- `null`
- 字符串
- 布尔值
- 有限且非 `-0` 的数字
- 普通对象
- 无空位、无额外属性的数组

拒绝：

- BigInt
- 循环引用
- `undefined`
- Symbol
- 函数
- `NaN`、`Infinity`、`-0`
- Date、Map、Set 和带自定义原型的对象
- 稀疏数组、数组额外属性、Symbol key、访问器属性

拒绝时统一抛出公开安全的 `ToolInputValidationError`，详情只说明输入必须为
JSON 兼容数据，不包含内部异常、循环路径、BigInt 或其他实现细节。通过检查后才
进行 JSON 序列化、解析、深冻结和标准输入令牌创建，因此不会静默把 `NaN` 改成
`null` 或把 Date 改成字符串。

测试：

- `rejects non-JSON inputs without invoking tools or leaking details`

## 4. 验证结果

- `pnpm test`：7 个测试文件、44 个测试全部通过
- `pnpm typecheck`：通过
- `git diff --check`：通过

原有 Phase 1 的 33 个测试继续通过；Step 1 新增及补充测试共 11 个。
