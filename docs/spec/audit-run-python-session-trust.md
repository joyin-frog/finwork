# audit-run-python-session-trust.md

> 实施者：claude-sonnet-4-6 / 2026-07-13
> 对应 spec：`docs/spec/spec-run-python-session-trust.md`

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `lib/agent/hooks/session-trust.ts` | 新增 | 进程级会话信任存储 + sentinel 常量 |
| `lib/agent/hooks/types.ts` | 修改 | HookContext 加 `conversationId?`；BeforeToolResult confirm 变体加 `trustable?`；resolveUserQuestion 入参加 `trustable?` |
| `lib/agent/hooks/chain.ts` | 修改 | 导入 sentinel + trustToolForConversation；透传 trustable；识别 sentinel 放行并写信任 |
| `lib/agent/hooks/built-in.ts` | 修改 | 导入 isToolTrustedForConversation；risk-confirm 对 run_python 命中信任+有 resolver 时直接 allow；confirm 结果对 isPython 标记 trustable |
| `lib/agent/claude-adapter.ts` | 修改 | AgentQuestion 加 `trustable?`；canUseTool ctx 加 `conversationId: runOptions.conversationId` |
| `lib/agent/runtime-events.ts` | 修改 | 局部 AskUserQuestionPayload 加 `trustable?: boolean` |
| `app/chat/chat-types.ts` | 修改 | AskUserQuestionPayload 加 `trustable?: boolean` |
| `app/components/ask-user-panel.tsx` | 修改 | 导入 SESSION_TRUST_CONFIRM_ANSWER；加 trustSession state；confirm 分支 trustable 时渲染 checkbox；确认按钮按勾选提交 sentinel 或普通「确认」 |
| `tests/session-trust.test.ts` | 新增 | 覆盖 spec §3 步骤 1 的 a–e |
| `tests/all.test.ts` | 修改 | 在 agentConfirmFlowTestPromise 之后注册 sessionTrustTestPromise |

## 每个文件的更改内容

### `lib/agent/hooks/session-trust.ts`（新增）
- 导出 `SESSION_TRUST_CONFIRM_ANSWER = "__confirm_trust_session__"`（稳定机器 sentinel）
- 用 `Symbol.for("finance-agent.run-python-session-trust")` 承载 `Set<string>` 存于 globalThis
- 导出 `trustToolForConversation(conversationId, toolName)`：key = `${conversationId}:${toolName}`；conversationId 为 undefined 时 no-op
- 导出 `isToolTrustedForConversation(conversationId, toolName)`：conversationId 为 undefined 时直接返回 false
- 无任何 `node:` 前缀导入（客户端组件安全）

### `lib/agent/hooks/types.ts`
- `HookContext` 新增 `conversationId?: number`
- `BeforeToolResult` confirm 变体新增 `trustable?: boolean`
- `resolveUserQuestion` 入参新增 `trustable?: boolean`

### `lib/agent/hooks/chain.ts`
- 顶部导入 `SESSION_TRUST_CONFIRM_ANSWER, trustToolForConversation`
- confirm 块调 `resolveUserQuestion` 时透传 `trustable: result.trustable`
- 答案判定顺序：`answer === SESSION_TRUST_CONFIRM_ANSWER` 先检查（精确比较，不 trim/lowercase）→ 若有 conversationId 写信任，继续放行；否则回退 `EXPLICIT_CONFIRM_ANSWERS.has(answer.trim().toLowerCase())` 判普通确认；其余 deny

### `lib/agent/hooks/built-in.ts`
- 导入 `isToolTrustedForConversation`
- `createRiskConfirmHook` 高风险分支：`isPython = ctx.toolName.includes("run_python")`
- 若 `isPython && ctx.resolveUserQuestion && isToolTrustedForConversation(ctx.conversationId, ctx.toolName)` → 直接 `{action:"allow"}`
- 否则返回 `{action:"confirm", prompt, ...(isPython ? {trustable:true} : {})}` — 非 python 工具不带 trustable

### `lib/agent/claude-adapter.ts`
- `AgentQuestion` 加 `trustable?: boolean` 字段
- `canUseTool` 调 `runBeforeHooks` 时加 `conversationId: runOptions.conversationId`

### `lib/agent/runtime-events.ts` & `app/chat/chat-types.ts`
- 各自的局部 `AskUserQuestionPayload` 加 `trustable?: boolean`，保证类型全链贯通

### `app/components/ask-user-panel.tsx`
- 新增 import：`SESSION_TRUST_CONFIRM_ANSWER` from `@/lib/agent/hooks/session-trust`
- 新增 state：`const [trustSession, setTrustSession] = useState(false)`
- confirm 分支（`question.kind === "confirm"`）：若 `question.trustable`，在后果文字与两按钮间渲染 `<label><input type="checkbox" .../>本次对话不再询问</label>`
- 「确认执行」onClick 改为：`submit(trustSession ? SESSION_TRUST_CONFIRM_ANSWER : "确认")`
- 「取消」不变（提交 "取消"，不在 EXPLICIT_CONFIRM_ANSWERS 中 → chain.ts deny）
- 未加 `eslint-disable-next-line no-restricted-syntax` suppress（label/input 不含 WP8a 受限模式，suppress-lock 计数保持 109）

### `tests/session-trust.test.ts`（新增）
覆盖 spec §3 步骤 1 a–e 全部断言（见下方测试结果节）。

### `tests/all.test.ts`
在 `agentConfirmFlowTestPromise` await 之后注册 `sessionTrustTestPromise`。

## 与计划的偏差

| 项目 | 说明 |
|---|---|
| suppress-lock 上限未调整 | 新增的 label+checkbox 未用 `cursor-pointer` 等 WP8a 受限类，故不需要 no-restricted-syntax suppress 注释；suppress-lock 计数维持 109，在限额内，无需改 `tests/ui/suppress-lock.test.ts`（该文件不在 Files touched 列表，按计划铁律不改） |
| 测试环境 venv symlink | worktree 的 `workers/.venv` 目录缺失（worktree 不复制），手动建了 symlink 指向主仓库 `.venv`，供 `npm test` 的 Python 脚本调用。symlink 不提交，不影响代码 |

## TDD RED 证据

首次运行（实现前）输出：
```
node:internal/modules/cjs/loader:1421
  const err = new Error(message);
              ^
Error: Cannot find module '../lib/agent/hooks/session-trust.ts'
Require stack:
- .../tests/session-trust.test.ts
    at ...T._resolveFilename...
code: 'MODULE_NOT_FOUND'
```
原因：`session-trust.ts` 未存在，全部测试失败。

## TDD GREEN 证据

实现完成后各定向测试输出：

```
session-trust: all checks passed ✓
agent-confirm-flow: all 6 checks passed ✓
sdk-pre-tool-use: native mechanism gate and main/subagent wiring ✓
```

## 安全不变量测试 (d) 通过证据

`tests/session-trust.test.ts` ST-d 断言：
```
// conversationId=30 已写信任，resolver=undefined → runBeforeHooks 仍返回 deny
assert.equal(result.behavior, "deny", "ST-d: 即便已信任，无 resolver 仍应 deny（硬不变量）");
```
本次 GREEN 运行中该断言通过（含在 "all checks passed ✓" 内）。

流程解释：built-in.ts 判断 `isPython && ctx.resolveUserQuestion`（undefined = falsy）→ 不走免确认路径 → 返回 `{action:"confirm"}`；chain.ts 见 `confirm` 但 `ctx.resolveUserQuestion` 为 undefined → 直接 `{behavior:"deny"}`。信任存储的存在对无 resolver 调用路径完全无影响。

## typecheck 结果

```
> finwork@0.1.6 typecheck
> tsc -p tsconfig.typecheck.json
（无输出，退出码 0）
```

## `npm test` 结果

```
ℹ tests 11
ℹ suites 0
ℹ pass 11
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms ~56000
```

## 开放风险

- `workers/.venv` symlink 是测试环境临时措施，不在提交范围内。CI 或其他 worktree 如需跑包含 Python 调用的测试，同样需要此 symlink 或独立 venv。
- `SESSION_TRUST_CONFIRM_ANSWER` 为进程内常量，若未来多进程部署，信任存储需重新评估（spec §5 已知风险，本期接受）。
