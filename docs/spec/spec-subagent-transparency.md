# 子代理过程透明化（subagent-transparency）Spec

> 版本 v1.0 / 2026-07-05
> 状态：~~草案~~ → **已批准**（计划审查通过无阻塞；已折入 tool-emit 时点/runSubagentsParallel 同步/mock 限制等修正） → 已实施（待）
> 依赖：`spec-confirm-gate-card.md`（已 ship；本功能与其正交，但共用 `AgentEvent` 联合类型，改动时勿冲突）
> 架构事实（写给没读过代码库的全新上下文实现者）：
> - Agent 运行时是 `@anthropic-ai/claude-agent-sdk`（TS），Next.js API 路由 + Tauri 桌面端；前端流式走 SSE。
> - **主 Agent 事件通道（已存在）**：`lib/agent/claude-adapter.ts:71` 定义 `onAgentEvent?: (event: AgentRunEvent) => void`；主 Agent 在 tool_use（:494）、tool_result（`emitToolResult` :363/:375）等处 emit。`app/api/agent/query/route.ts:290` 把 `onAgentEvent` 接到 SSE：每个事件 enqueue 成 `{type:"agent_event", event}` 帧。前端 `app/shared/chat-stream.tsx` 累积成 `StreamTurn`，`app/chat/turn-segments.ts` 的 `buildTurnSegments` 切成"过程段"，`app/chat/chat-page.tsx` 渲染「过程区」。
> - **前后端两份平行事件类型**（历史分叉，改一处不够，二者必须同步——F2 的 blocker 2 教训）：后端 `AgentRunEvent`（`claude-adapter.ts`）、前端 `AgentEvent`（`app/chat/chat-types.ts:72`）。
> - **子代理执行（`lib/agent/subagent-runner.ts` 的 `runSubagent`）**：主 Agent 调 `spawn_subagent` MCP 工具（`lib/agent/mcp-tools/subagent.ts`）→ `runSubagent` → 起独立 `sdk.query()` 循环。**它已经在迭代完整消息流**：文本块 push 到 `chunks`（:263-266）、tool_result 块走 after-hook（:267-290）、计时钩子 `createTimingHook` 回调（:178-180 已拿到 `name/durationMs/isError`）、高风险工具被确认门 deny 时 `blockedTools.add`（:197-199）。但**只 `return content`（:296-314），过程全咽了，onAgentEvent 没穿进来**。
> - `buildFinanceMcpServers(sdk, outputDir, traceId?, conversationId?)`（`mcp-tools/index.ts:57`）→ `createFinanceMcpServer` → `createSpawnSubagentTool(sdk, outputDir, traceId, conversationId)`（`subagent.ts:8`）。**被主 Agent（`claude-adapter.ts:201`）和子代理（`subagent-runner.ts:167`）都调用**；但子代理的 `allowedTools` 不含 `spawn_subagent`（不在 SHARED_TOOLS/role.tools），**子代理不能再派子代理，无递归**。
> - **脱敏工具（已存在）**：`getToolSummary(toolName, input)`（`lib/agent/tools/renderers.ts`，`risk-confirm` 在用）把工具调用翻成人话摘要，不含原始敏感值。
> - 测试栈：`npm test` = `node --import tsx tests/all.test.ts`（聚合入口，不支持 `-- 过滤`；新文件须 import 进 all.test.ts）。**无 jsdom/DOM 测试栈**，UI 用"源码契约断言"（`readFileSync` + assert，仿 `tests/tool-call-step-ui.test.ts`）；纯逻辑仿 `tests/ask-user-multi.test.ts`。Mock SDK 走 `FINANCE_AGENT_MOCK_AGENT=1`。

## 0. 目标与非目标

**目标**：子代理干活时（如薪税专员算 40 人工资），把它的过程里程碑（开始 / 每步工具 / 停在确认门 / 完成）顺着已有的 `onAgentEvent → SSE` 通道冒进对话「过程区」，渲染成一条**带角色标签的子轨道**——用户能实时看到它在做什么、停在哪、为什么停，而不是一个转圈到最后蹦结果。并行多个子代理时按 label 分成多条子轨道。

**非目标（本期不做，已知并接受）**：
- ❌ 子代理内部的 thinking 流 / 逐 token 文本流——只冒**结构化里程碑**（start/tool/blocked/done），不冒原始增量（避免过程区被洪流刷屏，也是脱敏考量）。
- ❌ 子代理级单独"停止/干预"按钮——停止仍是整轮 abort（`stopTurn` 已有）；干预是功能 3。
- ❌ 确认门可操作化（功能 2，已 ship）、停在确认门一键接管（功能 3）。
- ❌ 不引入 jsdom / DOM 测试框架。
- ❌ 不改子代理的执行逻辑、超时、并发度、工具白名单——**只加旁路 emit，不动主流程**。

## 1. 成功标准

**A. 事件产出与脱敏（纯逻辑 / 源码契约，可自动验证）**
- [ ] `runSubagent` 接受可选 `onEvent` 回调，并在四个时点 emit `type:"subagent"` 事件：`start`（角色解析后）、`tool`（每个工具完成，带 `getToolSummary` 摘要 + `durationMs` + `isError`）、`blocked`（高风险工具被确认门 deny 时）、`done`（返回前，带 `success` + `durationMs`）。验证：源码契约断言四个 emit 点存在且 phase 正确；若 mock SDK 可行，跑一次 `runSubagent` 断言收到的事件序列。
- [ ] **【脱敏红线 · 第二出口】**：`subagent` 事件的 `summary` 只来自 `getToolSummary`；**代码中 emit 处不得直接引用工具原始 `input` 或 tool_result `content`/`block.content`**。`done` 事件不夹带子代理正文（正文仍经正常 tool_result 返回）。验证：源码契约断言 emit 语句用 `getToolSummary(...)`，且 emit 对象字面量不含 `input`/`content` 原值字段。
- [ ] 事件带 `label` 与 `roleId`，供前端按子代理分组。

**B. 透传接线（源码契约）**
- [ ] `onSubagentEvent` 从主 Agent 的 `onAgentEvent` 一路穿到 `runSubagent`：`claude-adapter.ts`（主 Agent 调 `buildFinanceMcpServers` 时传入）→ `mcp-tools/index.ts` → `subagent.ts` → `runSubagent(opts.onEvent)`。**子代理自身调 `buildFinanceMcpServers` 时不传**（无递归）。验证：源码契约断言参数链贯通，且子代理路径（`subagent-runner.ts:167`）不传 emitter。
- [ ] `subagent` 变体同步加进**两份**类型：`AgentRunEvent`（`claude-adapter.ts`）与 `AgentEvent`（`chat-types.ts`）。验证：typecheck 通过 + 两处都含该变体。

**C. 渲染（纯函数 + 源码契约）**
- [ ] `buildTurnSegments`（`turn-segments.ts`）把连续的 `subagent` 事件按 `label` 归成一个"子轨道"段。验证：**纯函数单测**——喂一个含两个不同 label 的 subagent 事件序列 + 普通事件的 timeline，断言输出分出两条子轨道段、且不吞掉普通段。
- [ ] 过程区渲染每条子代理子轨道：显示角色名 + 逐步点亮的工具步骤；`blocked` 步骤高亮"停在确认门 · 原因"。验证：源码契约断言渲染分支存在。
- [ ] `shouldHideAgentEvent`（`chat-types.ts:88`）不隐藏 `subagent` 事件；`getPersistedTimeline` 落库回放也能渲染。

**D. 不回归**
- [ ] 主 Agent 现有事件（tool_use/tool_result/thinking/ask_user）渲染不变；全套测试绿；typecheck 过。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `app/chat/chat-types.ts` | 修改 | `AgentEvent` 加 `subagent` 变体；`shouldHideAgentEvent` 确保不隐藏它。 |
| `lib/agent/claude-adapter.ts` | 修改 | `AgentRunEvent` 加 `subagent` 变体（与前端同步）；主 Agent 调 `buildFinanceMcpServers`（:201）时把 `onAgentEvent` 作为 `onSubagentEvent` 传入。 |
| `lib/agent/mcp-tools/index.ts` | 修改 | `buildFinanceMcpServers`/`createFinanceMcpServer` 签名加可选 `onSubagentEvent`，透传给 `createSpawnSubagentTool`。 |
| `lib/agent/mcp-tools/subagent.ts` | 修改 | `createSpawnSubagentTool` 接 `onSubagentEvent`，调 `runSubagent` 时作为 `opts.onEvent` 传下。 |
| `lib/agent/subagent-runner.ts` | 修改 | `runSubagent` opts 加 `onEvent?`；在 start / tool(**tool_result 块 :267-289**) / blocked(canUseTool deny) / done 四点 emit 脱敏里程碑（`getToolSummary`）。**`runSubagentsParallel`（:338-368）也必须同步接 `onEvent` 并透传给每个 `runSubagent`**，否则并发子代理事件丢失。 |
| `app/chat/turn-segments.ts` | 修改 | `buildTurnSegments` 识别 `subagent` 事件、按 `label` 归成子轨道段。 |
| `app/chat/chat-page.tsx`（必要时抽 `app/chat/subagent-track.tsx`） | 修改/新增 | 渲染子代理子轨道（角色名 + 步骤 + blocked 高亮）。抽组件与否由实现者按现有 `ToolStepList` 组织方式定，但**新增文件须列入本表**。 |
| `tests/subagent-transparency.test.ts` | 新增 | ①纯函数：`buildTurnSegments` 分组；②源码契约：emit 四点 + 脱敏 + 透传链 + 渲染分支。导出 `subagentTransparencyTestPromise`。 |
| `tests/all.test.ts` | 修改 | 接入 `subagentTransparencyTestPromise`（仿现有 `await import` 写法）。 |

> 若实现中发现必须动列表外文件（例如 `chat-stream.tsx` 的事件累积逻辑对新变体不透明），**停止并报告**，不要擅自扩边界。

## 3. 实施步骤

1. **类型变体（两份同步，防字段被丢）**：给 `AgentEvent`（chat-types）与 `AgentRunEvent`（claude-adapter）都加：
   ```ts
   | { type: "subagent"; label: string; roleId: string; phase: "start" | "tool" | "blocked" | "done";
       summary?: string; toolName?: string; durationMs?: number; isError?: boolean; success?: boolean }
   ```
   `shouldHideAgentEvent` 里确保 `subagent` 不被隐藏（它不是 `system` 类型，现有逻辑天然不隐藏，加一条测试锁定即可）。
2. **透传接线**：`buildFinanceMcpServers`/`createFinanceMcpServer` 加可选末位参 `onSubagentEvent?`；`createSpawnSubagentTool` 加同名参并在调 `runSubagent` 时放进 `opts.onEvent`。`claude-adapter.ts:201` 主 Agent 构建 MCP 时把自己的 `onAgentEvent` 传入；`subagent-runner.ts:167` 子代理构建 MCP 时**不传**（保持 undefined）。
3. **emit 里程碑（subagent-runner.ts，只加旁路，不动主流程）**：
   - `start`：角色解析、`recordDispatchStart` 之后（:120 附近）emit `{type:"subagent", label:task.label, roleId:task.roleId, phase:"start", summary:task.label}`。
   - `tool`：**必须在 `tool_result` 块处理段（:267-289）emit，不要在 `createTimingHook` 回调里 emit**。原因：计时钩子回调触发时（由 :281 `runAfterHooks` 驱动），对应 input 已在 :271 被 `stack.shift()` 移出 `pendingToolCalls`，回调拿不到。正确做法：在 :267-289 段，`pending` 是刚 `shift()` 出来的局部变量，直接 emit `{phase:"tool", toolName:name, summary:getToolSummary(name, pending?.input), durationMs, isError}`——input 只喂 `getToolSummary`，**不进事件对象**。
   - `blocked`：`canUseTool` 里 `blockedTools.add(toolName)` 处（:198）emit `{phase:"blocked", toolName, summary:"高风险动作已拦截，待主对话人工确认"}`。
   - `done`：返回前（:296 成功、:315 catch 失败）emit `{phase:"done", success, durationMs}`（**不带 content**）。
   - 所有 emit 用 `opts.onEvent?.(...)`（可选链，未传时零成本）。
4. **分组（turn-segments.ts）**：`buildTurnSegments` 必须**显式**加 `subagent` 分支——注意它现有 else 是"tool_use/tool_result/system 归并为工具段"的**兜底 catch-all**，`subagent` 事件若不显式分流会被错误吞进工具段。加分支按 `label` 收拢为子轨道段（参照现有连续 tool 归组写法）。纯函数单测（§4.1）能机械检出漏分流。
5. **渲染（chat-page.tsx / 子组件）**：过程区渲染子轨道，复制现有 `ToolStepList` 的步骤样式与 tone token（`blocked` 用 `--tone-notice`，仿 `app/agents/page.tsx` 的"停在确认门"呈现）。
6. **测试**：按 §4。

## 4. 测试与验证方式

```bash
# 全套（本仓库标准姿势）：
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# 单跑新文件（开发时）：
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/subagent-transparency.test.ts
# 类型检查（两份事件类型同步、透传链贯通不应断裂）：
npm run typecheck
```

- 新增测试（进 `tests/subagent-transparency.test.ts`，接入 `tests/all.test.ts`）：
  1. 纯函数（仿 `ask-user-multi.test.ts` 的纯逻辑风格）：`buildTurnSegments` 喂含两个 label 的 subagent 事件 + 普通 tool 事件 → 断言分出两条子轨道、普通段不丢。
  2. 源码契约（仿 `tool-call-step-ui.test.ts` 的 `readFileSync`）：
     - `subagent-runner.ts` 含四个 `phase:"..."` 的 emit；emit 摘要用 `getToolSummary`；**emit 对象字面量不含 `input:`/`content:` 原值**（脱敏红线）。
     - 透传链：`index.ts`/`subagent.ts` 出现 `onSubagentEvent`，且 `subagent-runner.ts:167` 那次 `buildFinanceMcpServers` 调用不传 emitter。
     - `chat-types.ts` 与 `claude-adapter.ts` 都含 `type: "subagent"` 变体。
     - 渲染文件含 `subagent` / 子轨道分支。
  3. **集成测试不可行（已确认）**：`FINANCE_AGENT_MOCK_AGENT=1` 只拦截 `runClaudeAgent`（主 Agent），`runSubagent` 内部 `await import` 真实 SDK、无 mock 分支，`spawn_subagent` 会绕过 mock 直接真调 SDK。因此**不写触发 spawn_subagent 的集成测试**（会真调 API 失败）。成功标准 A 的 emit 行为**以源码契约断言兜底**（四 emit 点存在 + 用 `getToolSummary` + 字面量不含 input/content），实现者在 audit 里说明此限制。
- 真机目视（交付证据，非单测）：起 dev server，发一个会触发 `spawn_subagent` 的任务，`preview_screenshot` 存证子轨道。跑不动则 audit 标"待人工目视"。
- 不需要跑：e2e、python worker 不涉及。
- 先跑基线全绿再改，改完再跑，零回归。

## 5. 风险与开放问题

- **【脱敏红线 · 必守】第二出口**：子代理事件是一个**新的数据出口**，工资明细/身份证/卡号绝不能从这里漏到 SSE/落库/观测。铁律：只传 `getToolSummary` 摘要 + 计数 + 时长，永不传工具原始 input/output、永不夹带子代理正文。（对应 data-trust「第二出口同样要堵」。）
- **计时钩子拿不到 input**：`createTimingHook` 现签名只有 name/durationMs/isError。若 `tool` 事件要更细摘要而需 input，优先在 `canUseTool`/`pendingToolCalls`（已存 `{startTime, input}`，:169/:188）处配对取摘要——但**取到的 input 只喂 `getToolSummary`，不进事件**。实现者若发现改计时钩子签名更干净，属列表内文件改动，可做，但保持脱敏。
- **过程区洪流**：子代理并发 5、每个多步，事件量可能大。本期只发里程碑（每工具一条），并复用过程区既有的段收拢。若仍嫌吵，`tool` 事件可按工具名合并显示——记为可选优化，不在本期强做。
- **落库体量**：`subagent` 事件随 `collectedEvents` 落库。里程碑级体量可接受；若发现单会话事件暴涨，记为后续（可只落 start/done、tool 只走实时不落库）——本期不预先优化。
- **开放问题（不阻塞）**：子轨道要不要显示"预计还有几步"？无可靠依据（子代理不预告步数），**不做**，避免编造进度——与"绝不静默猜测"一致。

---

## 附录：audit（implementer 产出 `docs/spec/audit-subagent-transparency.md`）
以 **Files changed** 清单开头（对照 §2）→ §1 成功标准逐条核对（命令+结果）→ 测试/typecheck 输出摘要 → 脱敏红线自查结论 → 偏离/遗留/风险。
