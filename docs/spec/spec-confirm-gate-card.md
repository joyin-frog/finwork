# 确认门确认卡（confirm-gate-card）Spec

> 版本 v1.0 / 2026-07-05
> 状态：~~草案~~ → **已批准**（计划审查通过，3 阻塞项已改） → 已实施（待）
> 依赖：无（首个 P0 功能，独立起手）
> 架构事实（写给没读过代码库的全新上下文实现者）：
> - Agent 运行时是 `@anthropic-ai/claude-agent-sdk`（TypeScript），跑在 Next.js API 路由里，打包进 Tauri 桌面端。前后端走 `fetch → API Route`，流式走 SSE（`text/event-stream`）。
> - 角色是**纯数据**（`lib/agent/roles/registry.ts` 的 `ROLE_REGISTRY`），运行时无 `if (roleId===...)` 分支。本功能是**角色无关的横切改动**，改一次对所有角色生效。
> - **高风险工具确认门现状（已能用，本功能只升级它的呈现）**：
>   - `lib/agent/hooks/built-in.ts` 的 `createRiskConfirmHook()`：对 `getToolRiskLevel(tool)==="high"` 的工具返回 `{action:"confirm", prompt}`；`prompt` 由 `buildRiskConfirmPrompt` 生成，已含「人话动作摘要 + 不可逆后果」（后果文案见同文件 `RISK_IMPACT_NOTES`）。
>   - `lib/agent/hooks/chain.ts:17-27`：`confirm` 动作在有 resolver 时调用 `ctx.resolveUserQuestion({question: prompt, header:"操作确认"})`；答案为空 / `n|no|取消|否` → deny，否则 allow。
>   - `app/api/agent/query/route.ts:468-472`：主对话的 `resolveUserQuestion` 把**整个 question 对象**塞进 `{type:"ask_user", questionId, question}` SSE 事件并 enqueue。**question 对象原样透传，route.ts 无需改动。**
>   - 前端 `app/chat/chat-page.tsx:212` 选出待答 ask_user，:1000 用 `AskUserPanel`（`app/components/ask-user-panel.tsx`）渲染吸附在输入框上方的浮层。
> - **确认卡实际生效的 `high` 工具是 3 个**（`lib/agent/tools/registry.ts`）：`mcp__finance_worker__calculate_payroll_batch`、`mcp__finance_worker__confirm_payroll_period`（薪税专员）、`mcp__kingdee_worker__export_kingdee_draft`（记账专员）。
>   - ⚠️ `Bash` 也标记 `riskLevel:"high"`（registry.ts:22），但它由 `createUnwiredToolHook` 在 hook 链**链首 deny**（`built-in.ts:68-80`），永远到不了 `risk-confirm`，不会弹确认卡——**测试与验证均无需为 Bash 构造 confirm 事件**。
>   - `ALWAYS_CONFIRM_TOOLS`（`built-in.ts:146-150`：`remember_convention`、`update_company_profile`，本身 medium）也走 `{action:"confirm", prompt}` 路径，因此**也会被打上 `kind:"confirm"` 渲染成确认卡**。这是正确行为（它们本就要人确认），确认卡文案只依赖 `prompt`，对这两个工具同样成立，无需特判。

## 0. 目标与非目标

**目标**：把主对话里高风险动作的确认，从「一句普通提问气泡」升级为一张**确认卡**——后果醒目、只给「确认执行 / 取消」两个按钮——让非技术财务在按确认前看清"要做什么、什么后果"，且不会误触。这是"进度可调"在财务里的正确形态（人在风险点拍板）。

**非目标（本期不做，已知并接受）**：
- ❌ 子代理内部的确认门接管（子代理仍按现状静默 deny 高风险工具并记 `blockedReasons`）——那是功能 3。
- ❌ "改一改 / 纠偏重跑"：确认卡不提供自由文本改参数（见 §5 正确性约束）。留到后续。
- ❌ 四标签（结算状态/口径/合规/精度）的结构化展开与"逐个数字可追溯明细"——MVP 复用 `prompt` 已有的摘要+后果文案；结构化明细是后续增强。
- ❌ "记住选择下次不问"——高风险动作每次都问是特性。
- ❌ 子代理过程透明化（功能 1，另有 spec）。
- ❌ **不引入 jsdom / @testing-library 等 DOM 测试框架**。本仓库无 DOM 测试栈（见 §4），UI 层按"源码契约 + 纯函数断言"验证，不为本功能加测试依赖。

## 1. 成功标准

**A. 逻辑（纯函数单测，可自动验证）**
- [ ] **`kind` 透传**：`chain.ts` 的 confirm 分支调用 `resolveUserQuestion` 时，问题对象带 `kind:"confirm"`；非 confirm 路径不带（缺省）。验证：纯函数单测 mock `resolveUserQuestion`（仿 `tests/ask-user-multi.test.ts`），触发一个 high 工具的 confirm，断言收到的 `q.kind==="confirm"`。
- [ ] **答案判定不回归**：答 `"确认"`（任意非取消串）→ allow；`"取消"`/`否`/空串 → deny。验证：单测覆盖 `chain.ts:17-27` 三分支（此逻辑已存在，补测锁定语义）。
- [ ] **角色无关性证明**：对薪税 `calculate_payroll_batch` 与记账 `export_kingdee_draft` 各触发一次，都产出 `kind:"confirm"` 的问题对象，且 `risk-confirm`/`chain` 代码中无 `roleId` 分支。验证：单测两工具各跑一遍断言一致。

**B. 渲染（源码契约断言 + 真机目视，本仓库无 DOM 测试栈）**
- [ ] **确认卡分支存在且形态正确**：`ask-user-panel.tsx` 在 `question.kind==="confirm"` 时渲染「确认执行」「取消」两按钮，**不渲染自由文本输入框**（防"改一改"被误判放行，见 §5），后果文案用 tone token（非裸 hex）。验证：源码契约断言（仿 `tests/tool-call-step-ui.test.ts` 的 `readFileSync` + 断言写法）——断言该分支存在、含两按钮标识、`kind==="confirm"` 分支内无 `<textarea>`/文本 input、颜色走 `--tone-*` 变量。
- [ ] **真机目视**：起 dev server，构造/触发一次 high 工具确认，`preview_screenshot` 确认确认卡样式（后果告警色、两按钮）。作为最终交付证据，非单测。
- [ ] **普通提问不回归**：`kind` 缺省或 `"question"` 时走原有提问面板（含选项/多题）。验证：现有 ask-user 相关测试全绿（回归）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/claude-adapter.ts` | 修改 | `AgentQuestion` 类型（:49）加可选 `kind?: "confirm"`（透传字段，不改逻辑）。 |
| `lib/agent/hooks/types.ts` | 修改 | `HookContext.resolveUserQuestion` 的 question 入参加可选 `kind?: "confirm"`。 |
| `lib/agent/hooks/chain.ts` | 修改 | :19 调 `resolveUserQuestion` 时带上 `kind:"confirm"`（`confirm` 动作路径），保留 `header:"操作确认"`。 |
| `app/chat/chat-types.ts` | 修改 | `AskUserQuestionPayload`（:63）加可选 `kind?: "confirm" \| "question"`。 |
| `app/components/ask-user-panel.tsx` | 修改 | `question.kind==="confirm"` 时渲染确认卡分支（两按钮、后果告警色、无文本框）；否则走现有渲染。 |
| `tests/confirm-gate.test.ts` | 新增 | 一个文件两段：① 纯函数单测（仿 `tests/ask-user-multi.test.ts`）——`chain.ts` confirm 透传 `kind`、答案 allow/deny/空串三分支、双角色一致；② 源码契约断言（仿 `tests/tool-call-step-ui.test.ts` 的 `readFileSync`）——`ask-user-panel.tsx` 有 confirm 分支、两按钮、无文本框、tone token。导出 `confirmGateTestPromise`。 |
| `tests/all.test.ts` | 修改 | 加一行 `const { confirmGateTestPromise } = await import("./confirm-gate.test.ts");` 并 await（仿现有 :2-26 的 `xxxTestPromise` 写法），否则新测试不会被跑。 |

> 实施中若发现需要动列表外文件（例如 answered 态的时间线渲染 `chat-page.tsx:1455-1478` 也要区分 confirm），**停止并报告**，不要擅自扩边界；answered 态优化属非目标，MVP 只做待答浮层。

## 3. 实施步骤

1. **类型透传（三处必须同步，否则字段被前端类型静默丢弃）**：
   - **为什么三处都要改**：confirm 的问题对象在后端类型是 `AgentQuestion`（`claude-adapter.ts:49`），`route.ts:469-470` 把它**整体**塞进 `ask_user.question` 下发；前端接收时按 `AskUserQuestionPayload`（`chat-types.ts:63`）解构。这两份类型是**分开维护、历史上有分叉**的（`AgentQuestion` 无 `kind` 并非疏漏）。若只改一份，`kind` 会在"序列化能透传、但前端类型不认得"的情况下被忽略，卡片永不出现。因此三份必须一起加：
     - `claude-adapter.ts:49` `AgentQuestion` 加 `kind?: "confirm"`。
     - `hooks/types.ts:12-16` `HookContext.resolveUserQuestion` 入参对象加 `kind?: "confirm"`。
     - `chat-types.ts:63` `AskUserQuestionPayload` 加 `kind?: "confirm" | "question"`。
   - 三处均为**可选字段**：现有其它调用点（`built-in.ts:39/42` 的 ask-user hook、`:128` 的 stuck-guard）不传 `kind`，缺省即普通 question，**行为完全不变**，无需改动它们。
2. **打标（`chain.ts:17-27` 的 confirm 分支，实际调用在 :19）**：把 `resolveUserQuestion({ question: result.prompt, header:"操作确认" })` 改为 `resolveUserQuestion({ question: result.prompt, header:"操作确认", kind:"confirm" })`。**后端只改这一处**——`route.ts:470` 原样透传整个 question 对象，SSE 与前端自动拿到 `kind`，`route.ts` 无需改动。
3. **确认卡渲染（ask-user-panel.tsx）**：
   - 顶部按 `question.kind==="confirm"` 分流。confirm 分支：
     - 标题区「操作确认」；正文渲染 `question.question`（已含动作摘要+后果，按换行分段，**最后一段后果用告警色**——参照 `app/agents/page.tsx` 里 `--tone-notice` / `fa-tone-pill` 的既有用法，复制那套 token，不自造颜色）。
     - 两个按钮：「确认执行」`onSubmit("确认")`、「取消」`onSubmit("取消")`（复用面板现有的 answer 提交回调；答案字符串只要非取消即被 `chain.ts` 判 allow）。
     - **不渲染文本输入框 / 不渲染选项列表**。
   - 非 confirm：完全走现有渲染，不改。
4. **测试**：按 §4 补两个测试点。围绕 UI 用既有组件测试范式（参照仓库现有 `*.test.tsx` 的写法与工具）。

## 4. 测试与验证方式

**测试栈事实**：`package.json` 的 `test` = `node --import tsx tests/all.test.ts`——一个聚合入口，**不支持 `-- <文件名>` 过滤**（那是 Jest/Vitest 语法，本仓库用的是原生 node）。新测试文件只有被 `tests/all.test.ts` `import` 进去才会跑。本仓库**没有 jsdom/@testing-library**，UI 层用"源码契约断言"（`readFileSync` 源文件 + assert），不渲染 React。

```bash
# 全套单测（本仓库本地跑绿标准姿势）：
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

# 也可单独跑新文件（开发时）：
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/confirm-gate.test.ts

# 类型检查（三处加可选字段不应引入 any/类型断裂）：
npm run typecheck   # = tsc -p tsconfig.typecheck.json
```

- 需要新增的测试（都进 `tests/confirm-gate.test.ts`，并接入 `tests/all.test.ts`）：
  1. 纯函数段（仿 `tests/ask-user-multi.test.ts`）：mock `resolveUserQuestion`；confirm 路径带 `kind:"confirm"`；答 `"确认"`→allow、`"取消"`/空串→deny；薪税 + 记账两工具一致。
  2. 源码契约段（仿 `tests/tool-call-step-ui.test.ts`）：`readFileSync("app/components/ask-user-panel.tsx")`，断言含 `kind === "confirm"` 分支、两按钮标识、该分支内无文本输入、颜色用 `--tone-*`。
- **真机目视**（交付证据，非单测）：`preview_start` 起 dev server → 触发一次 high 工具确认 → `preview_screenshot` 存证。
- 明确不需要跑：e2e（`e2e/`）不涉及；python（`workers/`）不涉及。
- 实施者**先跑一遍全套确认基线全绿**再改；改完全套再跑一遍，不得引入回归。

## 5. 风险与开放问题

- **【正确性 · 必须遵守】"非取消文本 = 放行" 的既有语义**（`chain.ts:24`）：确认卡因此**绝不能**给自由文本框——否则用户想改参数（"用6月数据"）会被判为确认、按**原参数**执行。MVP 强制只给两按钮。"改一改"需要 deny + 把用户意图回喂 agent 重跑，属功能 3/后续，本期不做。
- **告警色 token**：必须复用 `app/globals.css` 里既有 tone 变量（如 `--tone-notice`），不自造 hex——否则 dark mode / 设计一致性会破。参照 `app/agents/page.tsx` 的 `fa-toned`/`fa-tone-pill` 用法。
- **answered 态**：本期只做待答浮层的确认卡；时间线里已答的 confirm 仍走现有紧凑摘要渲染，可接受。若视觉突兀，记为后续 polish，不在本期扩范围。
- **多题浮层**：现有 `questions[]` 多题路径（`built-in.ts` 的 `createAskUserQuestionHook`）与本功能正交——confirm 恒为单题，不进多题分支。实施时确认两条路径不打架。
- **ESC 语义（已知，MVP 可接受）**：`ask-user-panel.tsx:107-122` 的 ESC 提交空串 → `chain.ts` 判 deny。普通提问语义是"忽略"，在确认卡上结果等同"取消"（一致、无害），但确认卡不渲染"ESC 忽略"提示按钮。本期不特殊处理，记为已知。
- **开放问题（不阻塞实施，记录待定）**：确认卡是否要展示"展开明细"看可追溯数字？MVP 依赖 `prompt` 里的摘要已够；结构化四标签明细留待功能 4（薪税闭环）一并设计，避免这里过早抽象。

---

## 附录：audit 文档结构（implementer 完成后产出 `docs/spec/audit-confirm-gate-card.md`）

- **Files changed**：实际改动文件清单（对照 §2，超出必说明）。
- **成功标准逐条核对**：每条 [ ] → [x] + 如何验证（命令 + 结果）。
- **偏离与原因**：任何与本 spec 不一致处及理由。
- **测试结果**：命令原样 + 通过/失败输出摘要。
- **遗留/风险**：交给实施审查者重点看的地方。
