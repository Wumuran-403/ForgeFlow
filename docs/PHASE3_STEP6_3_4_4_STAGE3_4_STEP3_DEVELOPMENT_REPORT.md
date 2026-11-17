# ForgeFlow Phase 3 Stage 3.4 Step 3 Development Report

> 状态：Step 3 开发完成，等待架构评审。
>
> 范围：Recovery Preflight Capability。
>
> 数据库基线：Migration v9。
>
> 未实施：Fencing Takeover、Recovery UoW、External Read、Transaction B、
> Stage 3.4 Step 4 及之后的步骤。

## 1. 实际新增和修改文件

### 新增

- `src/recovery/recovery-evidence-recovery-preflight.ts`
  - Recovery Retry Safety / Consistency / Exact Contract Preflight。
  - 进程内 opaque capability 签发与断言。
- `tests/recovery/recovery-evidence-recovery-preflight.test.ts`
  - Step 3 专项正常、失败、capability 防伪和副作用边界测试。
- `docs/PHASE3_STEP6_3_4_4_STAGE3_4_STEP3_DEVELOPMENT_REPORT.md`
  - 本报告。

### 修改

- `src/recovery/recovery-readback-tool-registry.ts`
  - 新增 `validatePersistedInput()`。
  - 只调用现有 `ToolRegistry.validateInput()` 验证持久化 normalized input。
  - 不调用 `ToolRegistry.executeValidated()`。
- `tests/storage/recovery-evidence-uow-fixture.ts`
  - 允许测试 fixture 设置 read ToolRun 的 Tool identity、Schema Hash、
    normalized input 和 canonical input hash。
  - 默认值保持原有 fixture 行为。

### 未修改

- `src/recovery/index.ts` 未导出 Recovery Preflight issuer/assertion。
- 未修改 Stage 3.2 Dispatch Gate。
- 未修改 Stage 3.3 已封存实现。
- 未修改 Migration v4-v9、Schema、状态枚举或 Digest protocol。

## 2. Preflight 验证流程

`prepareRecoveryEvidenceRecoveryPreflight()` 在 SQLite Immediate Transaction
外执行以下流程：

1. 校验 Preflight 输入格式。
2. 读取持久化 Task、Readback Request、Recovery Review Operation、
   Reservation 和 read ToolRun。
3. 校验 Task / Review Operation / Request / Reservation / ToolRun 的
   persistence binding。
4. 重新计算 Request Intent Digest，并与持久化 Reservation 比较。
5. 校验 Retry Safety / Consistency Mode / Expected binding 组合。
6. 使用 Request 持久化的 `allowlistId` 与 `allowlistVersion` 调用
   `RecoveryReadbackToolRegistry.getExact()`。
7. 重新计算 Allowlist Contract Digest。
8. 校验 Tool Name / Version / Schema Hash / Retry Safety /
   Consistency Mode / Result contract metadata。
9. 重新计算 read ToolRun 持久化 input 的 `canonicalInputHash`。
10. 使用 exact historical Tool Schema 验证持久化 normalized input。
11. 全部通过后才签发进程内 capability。

Preflight 没有打开 SQLite Immediate Transaction，没有调用 Host source
resolver / argument builder，没有执行 Tool，没有写 Event / Checkpoint。

## 3. Request Intent Digest 真实算法与字段

实际源码：

`src/storage/recovery-evidence-readback-reservation-keys.ts`

算法：

```text
sha256CanonicalJson([
  "forgeflow.recovery-evidence-readback-request-intent.v1",
  {
    taskId,
    reviewId,
    evidenceSubmissionId,
    originalToolRunId,
    allowlistId,
    verificationCheckId,
    expectedDecisionVersion,
    expectedResourceVersion,
    expectedEtag
  }
])
```

输入使用项目已有 JCS canonical JSON 与 SHA-256 helper。`expectedDecisionVersion`
来自持久化的 accepted Recovery Review Operation。

Preflight 将重算结果与以下值比较：

- `RecoveryEvidenceReadbackReservationRecord.requestIntentDigest`。
- 调用方可选提供的 `expectedRequestIntentDigest`。

任一不一致返回：

```text
state = failed
retryAssessment = failed
reasonCode = REQUEST_INTENT_DIGEST_MISMATCH
```

## 4. Exact Registry Contract 校验

Migration v9 的 Request 使用 `allowlist_version` 持久化 Allowlist Contract
Digest。该值为 64 位小写十六进制字符串，不带 `sha256:` 前缀；它不是普通
业务版本号。

Preflight 校验：

- `getExact(request.allowlistId, request.allowlistVersion)` 必须命中历史版本。
- 不得回退到 latest。
- `computeRecoveryReadbackAllowlistVersion()` 重算结果必须等于 Request
  `allowlistVersion`。
- Registry definition 的 `allowlistVersion`、`allowlistId` 必须匹配 Request。
- Tool Name / Version / Schema Hash 必须匹配 Request 和 read ToolRun。
- Retry Safety / Consistency Mode 必须匹配 Request。
- read ToolRun 必须是 `mode=read`，且属于同一 Task。

历史版本不存在时返回 `not_evaluated` /
`RECOVERY_CONTRACT_UNAVAILABLE`，不签发 capability。

Historical metadata 存在但重算 Digest 或 contract binding 不匹配时返回
`failed` / `RECOVERY_CONTRACT_MISMATCH`，不签发 capability。

## 5. Persisted Tool Input 验证

Preflight 使用 ToolRun 已持久化的 `input_json`：

1. 使用 `computeCanonicalInputHash(readRun.input)` 重算 canonical input hash。
2. 与 ToolRun 持久化的 `canonicalInputHash` 精确比较。
3. 通过 `RecoveryReadbackToolRegistry.validatePersistedInput()` 获取 exact
   historical Tool Schema。
4. 调用现有 `ToolRegistry.validateInput()`。
5. 校验返回的 ValidatedToolInput Tool identity / Schema Hash / read mode。
6. 再次计算 validated value 的 canonical hash，并与持久化 hash 比较。

`validatePersistedInput()` 不执行 Tool。Zod transform / async refinement
可能再次运行，因此仍要求相关 Tool Schema 保持 deterministic、pure、
idempotent 且无外部 I/O；本步骤没有新增绕过 WeakMap
`ValidatedToolInput` capability 的执行接口。

## 6. Capability 签发边界与绑定字段

Capability 是 frozen opaque object，真实 binding 保存在 module-private
`WeakMap` 中。普通对象、spread clone、JSON clone 和 TypeScript cast 均无法
通过验证。

绑定字段：

```text
taskId
requestId
readToolRunId
allowlistId
allowlistVersion
readToolName
readToolVersion
readToolSchemaHash
requestIntentDigest
retrySafety
consistencyMode
expectedResourceVersion
expectedEtag
canonicalInputHash
retryAssessment = passed
```

签发边界：

- 只有完成全部真实 Preflight 校验的路径才创建 capability。
- issuer 不从 `src/recovery/index.ts` 导出。
- capability 只存在进程内，不持久化。
- capability 不是 ExecutionAuthority。
- capability 不授予 Fencing Takeover、新 Attempt 创建、Dispatch 或 Tool
  execution 权限。

## 7. Fail Closed 分类

| 条件 | state | retryAssessment | reasonCode |
|---|---|---|---|
| Registry / persisted recovery state 不可读取 | `not_evaluated` | `not_evaluated` | `RECOVERY_CONTRACT_UNAVAILABLE` |
| Preflight 输入格式非法 | `failed` | `failed` | `RECOVERY_PREFLIGHT_INPUT_INVALID` |
| 调用方 expected binding 与 Request 不一致 | `failed` | `failed` | `RECOVERY_PREFLIGHT_BINDING_MISMATCH` |
| Task / Operation / Reservation / ToolRun 关系不一致 | `failed` | `failed` | `RECOVERY_PREFLIGHT_BINDING_INVALID` |
| Request Intent Digest 不一致 | `failed` | `failed` | `REQUEST_INTENT_DIGEST_MISMATCH` |
| Exact contract / Tool identity / schema 不一致 | `failed` | `failed` | `RECOVERY_CONTRACT_MISMATCH` |
| canonical input hash 不一致 | `failed` | `failed` | `CANONICAL_INPUT_HASH_MISMATCH` |
| normalized input 无法通过 exact historical schema | `failed` | `failed` | `PERSISTED_INPUT_INVALID` |
| immutable 带 Expected binding | `failed` | `failed` | `RETRY_BINDING_UNSAFE` |
| version_conditional 无 Expected binding | `failed` | `failed` | `EXPECTED_RESOURCE_BINDING_REQUIRED` |

只有 `state=passed` 的结果包含 capability。

## 8. 测试场景与实际结果

专项测试文件：

`tests/recovery/recovery-evidence-recovery-preflight.test.ts`

覆盖：

1. Exact historical contract 正常通过。
2. issuer/assertion 不从 public recovery barrel 暴露。
3. historical allowlist version 不存在。
4. Registry metadata 导致 Allowlist Contract Digest 不一致。
5. Tool Name 不一致。
6. Tool Version 不一致。
7. Schema Hash 不一致。
8. Request Intent Digest 不一致。
9. `canonicalInputHash` 不一致。
10. 持久化 normalized input 无法通过 exact historical schema。
11. `immutable + immutable_version` 无 Expected binding 通过。
12. `version_conditional + resource version` 通过。
13. `version_conditional + ETag` 通过。
14. immutable 带 Expected binding 拒绝。
15. version_conditional 无 Expected binding 拒绝。
16. 错误 Task / Allowlist / ToolRun binding 拒绝。
17. 错误 Request 无法评估。
18. 普通对象伪造 capability 拒绝。
19. spread clone capability 拒绝。
20. JSON clone capability 拒绝。
21. 错误 capability binding 拒绝。
22. 失败和 not_evaluated 结果不包含 capability。
23. Preflight 不调用 `executeValidated()`，不执行 Tool。
24. 成功 Preflight 不写 Event / Checkpoint。

请求组合非法无法通过现有 Request Repository 的 Schema 防线落库，因此 Retry
Safety 非法组合使用纯 assessment 测试覆盖；未通过直接篡改 append-only
Request 伪造测试状态。

实际执行：

```text
pnpm vitest run tests/recovery/recovery-evidence-recovery-preflight.test.ts

Test Files  1 passed (1)
Tests       15 passed (15)
```

命令退出码为 0。

## 9. 回归、类型和差异检查

实际执行：

```text
pnpm test

Test Files  55 passed (55)
Tests       592 passed (592)
```

命令退出码为 0。

```text
pnpm typecheck
```

命令退出码为 0。

```text
git diff --check
```

命令退出码为 0。输出仅包含 Git 对工作树现有 LF/CRLF 归一化的 warning，
未报告 whitespace error。`git diff --check` 不检查未跟踪文件内容。

## 10. Schema / Migration 影响

无 Schema 或 Migration 影响。

- 使用 Migration v9 已有的 Request、Reservation、ToolRun、Event 和
  Checkpoint 字段。
- 未新增 Migration v10。
- 未修改 Migration v4-v9。
- 未新增依赖。

## 11. 尚未解决的限制

1. 该模块未从 public recovery barrel 导出，但 TypeScript 本地代码仍可通过
   deep module path 导入。签发权限目前依赖 Host composition boundary 和代码
   评审约束，而不是语言级模块 ACL。
2. Capability 没有过期或一次性消费机制。Step 4-6 的 UoW 仍必须在新的
   Immediate Transaction 内重新验证 Lease、Fencing、Authority、Intent、
   Attempt 状态和全部持久化绑定，不能把 capability 当作 ExecutionAuthority。
3. Durable `recoveryOperationId` Command / Job Store 尚不存在；本步骤没有
   创建 Recovery 执行入口。
4. Preflight 只证明调用时的历史合约仍然可恢复；它不证明外部 Read 可以安全
   重跑，也不执行 Actual Resource Version / ETag 比较。
5. 本步骤没有实现 Fencing Takeover、Interrupted Recovery、Dispatch 或
   External Read。

## 12. 边界声明

本步骤仅完成 Stage 3.4 Step 3 Recovery Preflight Capability。

未实施：

- Stage 3.4 Step 4 及之后步骤。
- Recovery Preflight 生产调用链 / Host adapter。
- Fencing Takeover。
- Interrupted Recovery UoW。
- Full Recovery / Pause Resume Continuation。
- Recovery Lineage Repository。
- Durable Recovery Job / Command Store。
- External Read。
- Payload Store / Transaction B。
- Verifier / Recovery Manager / Classifier。
- Step 6.3.5。
