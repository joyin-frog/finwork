# audit-subagent-transparency

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `app/chat/chat-types.ts` | 修改 | `AgentEvent` 加 `subagent` 变体；`shouldHideAgentEvent` 天然不隐藏（仅过滤 `system` 类型，已有测试锁定） |
| `lib/agent/claude-adapter.ts` | 修改 | `AgentRunEvent` 加 `subagent` 变体；主 Agent 调 `buildFinanceMcpServers` 时传入 `runOptions.onAgentEvent` |
| `lib/agent/mcp-tools/index.ts` | 修改 | `createFinanceMcpServer` / `buildFinanceMcpServers` 加可选末位参 `onSubagentEvent?`，透传给 `createSpawnSubagentTool` |
| `lib/agent/mcp-tools/subagent.ts` | 修改 | `createSpawnSubagentTool` 加 `onSubagentEvent?`，调 `runSubagent` 时作为 `opts.onEvent` 传下 |
| `lib/agent/subagent-runner.ts` | 修改 | `runSubagent` opts 加 `onEvent?`；在 start/tool/blocked/done 四点 emit 脱敏里程碑；`runSubagentsParallel` 同步接 `onEvent` 并透传 |
| `app/chat/turn-segments.ts` | 修改 | `ProcessSegment` 加 `subagent` 变体；`buildTurnSegments` 加显式 `subagent` 分支按 `label` 归组 |
| `app/chat/chat-page.tsx` | 修改 | 引入 `SubagentTrack`；`processSegments.map` 加 `seg.kind === "subagent"` 渲染分支 |
| `app/chat/subagent-track.tsx` | 新增 | 子代理子轨道渲染组件：角色标签 + 工具步骤行 + blocked 高亮（`--tone-notice`）|
| `tests/subagent-transparency.test.ts` | 新增 | ①纯函数：`buildTurnSegments` 分组断言；②源码契约：emit 四点 + 脱敏 + 透传链 + 渲染分支 + 类型同步 + `shouldHideAgentEvent` |
| `tests/all.test.ts` | 修改 | 接入 `subagentTransparencyTestPromise` |

均在 spec §2 Files touched 范围内，无超出列表外的改动。

---

## §1 成功标准逐条核对

### A. 事件产出与脱敏

**A1 — `runSubagent` 接受 `onEvent`，四点 emit**

- `start`：角色解析 + `recordDispatchStart` 之后 emit `{type:"subagent", phase:"start", label, roleId, summary:task.label}`
- `tool`：`tool_result` 块处理段（:267-289）emit，用刚 `shift()` 出的局部 `pending?.input` 喂 `getToolSummary`，不进事件对象
- `blocked`：`canUseTool` deny + `getToolRiskLevel==="high"` 时 emit，不含 input/content
- `done`：成功路径和 catch 失败路径各一处 emit，不夹带 `content`

验证：源码契约断言 `phase:"start"/"tool"/"blocked"/"done"` 均通过（C1-C4 ✓）

**A2 — 脱敏红线**

- 所有 `opts.onEvent?.()` 调用字面量均不含 `input:` 或 `content:` 字段（C6-C7 ✓）
- 摘要来自 `getToolSummary(name, pending?.input)`（C5 ✓）
- `done` 事件仅含 `phase/success/durationMs`，不夹带子代理正文（代码可见）

**A3 — label 与 roleId**

所有 emit 点均带 `label: task.label` 和 `roleId: task.roleId`，供前端按子代理分组。

### B. 透传接线

**B1 — 参数链贯通**

`claude-adapter.ts` → `buildFinanceMcpServers(... runOptions.onAgentEvent)` → `createFinanceMcpServer(... onSubagentEvent)` → `createSpawnSubagentTool(... onSubagentEvent)` → `runSubagent(... opts.onEvent: onSubagentEvent)`

源码契约 C8-C11 全部通过。

**B2 — 无递归**

`subagent-runner.ts:172` 的 `buildFinanceMcpServers(sdk, outputDir)` 调用只传两个参数，不传 `onEvent`/`onSubagentEvent`（C11 ✓）。

**B3 — 两份类型同步**

`chat-types.ts` `AgentEvent` 和 `claude-adapter.ts` `AgentRunEvent` 均含 `type: "subagent"` 变体（C12-C13 ✓）。

### C. 渲染

**C1 — `buildTurnSegments` 显式 `subagent` 分支**

- `turn-segments.ts` 加 `else if (type === "subagent")` 分支，在 else catch-all 之前，按 `label` 归组为 `{ kind: "subagent", label, items }` 段
- 纯函数单测（P1-P6）：喂两条不同 label 的 subagent 事件 + 普通 tool 事件 → 分出两条子轨道、普通段不丢（全通过 ✓）

**C2 — 渲染子轨道**

- `app/chat/subagent-track.tsx` 新增：角色名标签行 + 工具步骤行 + blocked 高亮（`--tone-notice` + `fa-toned` + `fa-tone-pill`，仿 `agents/page.tsx`）
- `chat-page.tsx` 加 `seg.kind === "subagent"` 分支，渲染 `<SubagentTrack>`（C14-C19 ✓）

**C3 — `shouldHideAgentEvent` 不隐藏 subagent**

`shouldHideAgentEvent` 只过滤 `type === "system"` 且不在白名单的事件；`subagent` 类型天然不被过滤（C20 ✓）。

### D. 不回归

全套测试：9/9 通过，0 失败（与基线一致）。`reportlab` 未安装的异步错误是预先存在的环境问题，与本次改动无关。

---

## 测试/typecheck 输出摘要

```
# typecheck
npm run typecheck → tsc -p tsconfig.typecheck.json → 无错误，无输出

# 新测试单跑
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/subagent-transparency.test.ts
P1-P6: buildTurnSegments subagent 分组 ✓
C1-C4: 四个 phase emit 点 ✓
C5-C7: 脱敏红线自查 ✓
C8-C11: 透传链完整性 ✓
C12-C13: 两份事件类型含 subagent 变体 ✓
C14-C19: 渲染分支存在 ✓
C20: shouldHideAgentEvent 不隐藏 subagent ✓
subagent-transparency: 全部断言通过 ✓

# 全套
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test
# tests 9 / pass 9 / fail 0
```

---

## 脱敏红线自查结论

**通过**。

1. `subagent-runner.ts` 中所有 `opts.onEvent?.()` 调用的字面量均不含 `input:` 或 `content:` 字段（C6/C7 断言验证）
2. `tool` 事件的摘要来自 `getToolSummary(name, pending?.input)`，`pending?.input` 只喂给 `getToolSummary` 内部，不作为字段进入事件对象
3. `done` 事件只含 `phase/success/durationMs`，不夹带子代理正文（`content` 仍经正常 tool_result 返回）
4. `blocked` 事件的 `summary` 是固定文案 `"高风险动作已拦截，待主对话人工确认"`，不含工具原始 input

---

## 偏离/遗留/风险

**偏离**：无。所有改动均在 spec §2 Files touched 范围内。

**集成测试限制（已确认，见 spec §4.3）**：
`FINANCE_AGENT_MOCK_AGENT=1` 只拦截主 Agent 的 `runClaudeAgent`，不覆盖 `runSubagent`（内部 `await import` 真实 SDK）。因此不写触发 `spawn_subagent` 的真调 API 集成测试。emit 行为以源码契约断言兜底（四点存在 + `getToolSummary` + 字面量不含 input/content）。

**真机目视**：跑不动（需真实 API key 触发 `spawn_subagent`），在此标记为「待人工目视」。

**遗留/后续（不阻塞本期）**：
- `subagent` 事件随 `collectedEvents` 落库。里程碑级体量可接受；如后续发现单会话事件暴涨，可考虑只落 start/done、tool 只走实时（spec §5 已记录）
- 子轨道「预计还有几步」不做（spec §5 明确不做，子代理不预告步数）
- 过程区洪流若问题暴露，可按 spec §5 按工具名合并显示（本期不强做）
