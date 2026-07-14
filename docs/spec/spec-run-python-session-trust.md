# run_python 会话级信任 Spec

> 版本 v1.0 / 2026-07-13
> 状态：草案
> 依赖：`spec-security-release-blockers.md`（run_python 每次确认的机制闸由它引入）
> 架构事实：Agent 经 `@anthropic-ai/claude-agent-sdk` 的 canUseTool 做工具权限；run_python(`mcp__finance_worker__run_python`,high risk)的确认来自 `createRiskConfirmHook` 通用 high-risk 分支,经 `runBeforeHooks`(chain.ts)调 `resolveUserQuestion` 弹确认卡,答案是唯一回传通道。`runOptions.conversationId?: number` 可用但未进 HookContext。子代理 `resolveUserQuestion` 为 undefined,run_python 走 confirm→无 resolver→deny 的 fail-closed 路径。桌面为单 Node 进程,进程级内存状态可跨请求/跨 Next route bundle 共享(参照 storage.ts 的 `globalThis[Symbol.for(...)]` lease registry)。

## 0. 目标与非目标
**目标**：给 run_python 的确认卡增加「本次对话不再询问」选项。同一 conversationId 内一旦用户以该选项确认过,后续该对话的 run_python 免确认直接放行;换新对话或重启应用后重新询问。把 run_python 的确认从「每次」降为「每对话一次」,不动安全底线。

**非目标（本期不做,已知并接受)**：
- 不做全局/持久化的 auto 开关(不写 DB、不跨应用重启保留信任)。「本次对话」= 进程内、按 conversationId 作用域,重启即重新询问。
- 不把信任扩展到 run_python 以外的任何工具。算薪批量、确认薪资期间、导出金蝶草稿(均 high risk)、写工作约定/更新公司画像(ALWAYS_CONFIRM)一律保持每次确认,不得出现「本次不再询问」。
- 不改子代理行为:子代理无交互确认通道,run_python 仍 fail-closed 拒绝,信任存储绝不能让子代理绕过。
- 不改 stuck-guard(连续报错/单回合次数上限的打断):信任只跳过权限确认,不跳过 stuck-guard。
- 不宣称沙箱,不新增依赖。

## 1. 成功标准
- [ ] 新增进程级会话信任存储(按 `${conversationId}:${toolName}` 作用域,globalThis Symbol 承载),提供 `trustToolForConversation` 与 `isToolTrustedForConversation`;未知对话/未信任返回 false;不同 conversationId 相互隔离。
- [ ] run_python 确认卡渲染一个「本次对话不再询问」勾选项;勾选后点「确认执行」提交一个稳定 sentinel(共享常量,非本地化文案),未勾选仍提交普通「确认」。
- [ ] chain.ts 收到 sentinel:视为肯定放行 **并且** 对 `(ctx.conversationId, ctx.toolName)` 写入信任;收到普通「确认」:放行但不写信任;「取消」/空/含糊/否定:仍 deny。conversationId 缺失时 sentinel 仅当次放行、不写信任(无法作用域)。
- [ ] createRiskConfirmHook 对 run_python:**仅当** `ctx.resolveUserQuestion` 存在(交互通道)且 `isToolTrustedForConversation(ctx.conversationId, toolName)` 为真时,直接 `{action:"allow"}` 跳过确认;否则照常 confirm,并在 confirm 结果里标记 `trustable:true`。
- [ ] 「本次不再询问」选项**只**出现在 run_python 卡:其他 high-risk 工具与 ALWAYS_CONFIRM 工具的 confirm 结果 `trustable` 为 falsy,卡上无该勾选项,且即便信任存储被人为写入别的 toolName 也不影响它们(它们不查信任存储)。
- [ ] 安全不变量(硬性):子代理(`resolveUserQuestion` 为 undefined)对 run_python 仍 deny,与信任存储无关——信任 bypass 必须以「存在交互确认通道」为前提。测试显式覆盖:即便同 conversationId 在主 Agent 被信任,无 resolver 的调用仍 deny。
- [ ] 定向测试 + `npm run typecheck` 通过;新测试注册进 `tests/all.test.ts`。

## 2. Files touched
| 文件 | 动作 | 改什么 |
|---|---|---|
| `docs/spec/spec-run-python-session-trust.md` | 新增 | 本 spec |
| `docs/spec/audit-run-python-session-trust.md` | 新增 | 实施审计(以 Files changed 开头) |
| `lib/agent/hooks/session-trust.ts` | 新增 | 进程级会话信任存储 + sentinel 常量。**只用 Web 平台全局(globalThis/Symbol.for/Set),严禁 `node:` 前缀导入**——client 组件 ask-user-panel.tsx 会导入本文件的 sentinel 常量,带 node 依赖会污染客户端 bundle |
| `lib/agent/hooks/types.ts` | 修改 | HookContext 加 `conversationId?`;BeforeToolResult 的 confirm 变体加 `trustable?`;resolveUserQuestion 入参加 `trustable?` |
| `lib/agent/hooks/chain.ts` | 修改 | 透传 trustable+conversationId;识别 sentinel 放行并写信任 |
| `lib/agent/hooks/built-in.ts` | 修改 | risk-confirm:run_python 命中信任则免确认;confirm 结果标 trustable(仅 run_python) |
| `lib/agent/claude-adapter.ts` | 修改 | canUseTool ctx 传 `conversationId: runOptions.conversationId`;AgentQuestion 类型加 `trustable?` |
| `lib/agent/runtime-events.ts` | 修改 | 局部 `AskUserQuestionPayload`(约 16 行,`ask_user` 事件所用)加 `trustable?: boolean`,与 chat-types 同步——否则将来在 AgentRuntimeEvent 层访问 `.trustable` 会 typecheck 失败 |
| `app/chat/chat-types.ts` | 修改 | `AskUserQuestionPayload`(约 64 行,**面板实际消费的 prop 类型**)加 `trustable?: boolean`。**这是发布门**:不加则 ask-user-panel.tsx 读 `question.trustable` 直接 typecheck 失败(计划审查 B-1) |
| `app/components/ask-user-panel.tsx` | 修改 | confirm 卡:trustable 时渲染「本次对话不再询问」勾选,勾选则提交 sentinel |
| `tests/session-trust.test.ts` | 新增 | 存储隔离、risk-confirm 免确认/标记、chain sentinel 写信任、子代理不变量、组件源码契约 |
| `tests/all.test.ts` | 修改 | 注册新测试 |

实施中如需改列表外文件,停止并报告。

## 3. 实施步骤
1. 先写 `tests/session-trust.test.ts` 并确认 RED,至少覆盖:(a)存储 trust/isTrusted、conversationId 隔离、未知对话 false;(b)risk-confirm:构造带 resolver+已信任的 ctx → run_python 返回 allow 且不弹卡;未信任 → confirm 且 trustable=true;传 calculate_payroll_batch/export_kingdee_draft → confirm 且 trustable falsy;(c)chain.ts:sentinel 答案 → allow 且调用写信任(可注入 spy 或改后 isTrusted 为真);普通「确认」→ allow 且未写信任;「取消」→ deny;(d)**安全不变量**:resolver 为 undefined 时 run_python 即便同 conversationId 已被信任仍 deny;(e)组件源码契约:`app/components/ask-user-panel.tsx` 含勾选项与 sentinel 提交分支。注册进 tests/all.test.ts。
2. `lib/agent/hooks/session-trust.ts`:导出 `SESSION_TRUST_CONFIRM_ANSWER`(稳定机器 sentinel,如 `"__confirm_trust_session__"`);globalThis `Symbol.for("finance-agent.run-python-session-trust")` 承载一个 `Set<string>`;`trustToolForConversation(conversationId, toolName)` 与 `isToolTrustedForConversation(conversationId, toolName)`,key=`${conversationId}:${toolName}`;conversationId 为 undefined 一律 no-op/false。参照 `lib/knowledge/storage.ts` 的 lease registry 写法。
3. `types.ts`:HookContext 加 `conversationId?: number`;BeforeToolResult confirm 变体加 `trustable?: boolean`;resolveUserQuestion 入参对象加 `trustable?: boolean`。
4. `built-in.ts` createRiskConfirmHook:在 high-risk 分支里,`isPython = ctx.toolName.includes("run_python")`。若 `isPython && ctx.resolveUserQuestion && isToolTrustedForConversation(ctx.conversationId, ctx.toolName)` → `{action:"allow"}`。否则 `{action:"confirm", prompt, trustable: isPython}`。其它 high-risk/ALWAYS_CONFIRM 分支 trustable 不设(falsy)。
5. `chain.ts`:confirm 处理里把 `result.trustable` 透传进 `resolveUserQuestion({..., kind:"confirm", trustable})`。判定答案(顺序,无歧义):先取原始 `answer`(**不 trim/lowercase**,sentinel 本身全小写无空格,但要与 sentinel 精确比较),`if (answer === SESSION_TRUST_CONFIRM_ANSWER)` → 视为肯定并写信任:若 `ctx.conversationId != null` 调 `trustToolForConversation(ctx.conversationId, ctx.toolName)`,然后放行(conversationId 缺失则不写信任、仅当次放行);否则回退既有分支 `EXPLICIT_CONFIRM_ANSWERS.has(answer.trim().toLowerCase())` 判定普通「确认」(放行但不写信任),不匹配则 deny。结果:sentinel→放行+写信任;普通确认→放行不写信任;取消/空/含糊→deny。
6. `claude-adapter.ts`:canUseTool 调 runBeforeHooks 的 ctx 里加 `conversationId: runOptions.conversationId`;AgentQuestion 类型加 `trustable?: boolean`。同步:`app/chat/chat-types.ts` 与 `lib/agent/runtime-events.ts` 两处 `AskUserQuestionPayload` 各加 `trustable?: boolean`(见 Files touched),保证 `trustable` 从 hook→AgentQuestion→ask_user envelope→面板 prop 全链类型贯通。
7. `ask-user-panel.tsx` confirm 分支:当 `question.trustable` 为真,在两按钮上方渲染一个受控 checkbox「本次对话不再询问」(用现有 UI 组件与 token,风格参照现有卡片;交互元素豁免注释照现有写法)。「确认执行」onClick 改为:勾选则 `submit(SESSION_TRUST_CONFIRM_ANSWER)`,否则 `submit("确认")`。「取消」不变。从 `@/lib/agent/hooks/session-trust` 导入 sentinel 常量,勿硬编码字符串。非 trustable 卡保持现状两按钮。
8. 跑全部定向测试 + typecheck,写 audit(以 Files changed 开头,含 TDD RED/GREEN 证据与安全不变量测试结果)。

## 4. 测试与验证方式
```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/session-trust.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/agent-confirm-flow.test.ts
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/sdk-pre-tool-use.test.ts
npm run typecheck
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
```
- 需新增测试点:见步骤 1（a–e）。安全不变量(d)是发布门,必须绿。
- 不涉及:python 侧、桌面构建、e2e、真实模型联网。

## 5. 风险与开放问题
- 信任是进程内、按 conversationId 作用域:同一对话跨多轮 turn 复用(符合「本次对话」语义),重启即失效(安全上更保守)。若未来多进程部署需重新评估。
- 提示注入:信任只在用户主动勾选后对「该对话」生效,爆炸半径限于用户有意开启的这段会话;子代理与无交互通道路径永不受信任影响(硬不变量)。
- run_python 即便被信任,stuck-guard 仍能在连续报错/次数超限时打断——保留不动。
