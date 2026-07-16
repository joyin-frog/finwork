# Audit: agent-event-contract (AR2a)

Spec: `docs/spec/spec-agent-event-contract.md` v1.2 (已批准)

---

## 实现现状校准（相对 spec 计划的落地真相）

> 本节修正「读旧 spec / ROADMAP 字面意思」时容易产生的误解。以当前代码为准
> （校准 2026-07-16）。ROADMAP 铁律 1 旁有同内容摘要。

| 问题 | 答案 |
|---|---|
| UI 完成态从哪来？ | **旧 SSE 帧** `done` / `incomplete` / `error` → `chat-stream` 的 `onDone` / `onIncomplete`。**不是** `run_settled`。 |
| `run_settled` 谁发？ | `route.ts` 的 `settleRun()`：三路径各恰好一次；顺序恒为 `run_ended` → `run_settled`（再发旧兼容帧）。 |
| 前端怎么处理 `run_settled`？ | `dispatchSSEEvent` **consumed 后 return**（与 `turn_started` / `message_started` / `message_completed` / `queue_updated` 同类）；主对话 `run_ended`（`instanceId == null`）同样静默消耗。 |
| 会进 `chat_agent_events` 吗？ | 不会。`contractToLegacyEvents` 对 `run_settled` 映射为 `[]`。 |
| spec 写「chat-stream 完成态派生自 run_settled」还算数吗？ | **计划未按字面落地**。实际是双轨：合同帧走 envelope；完成态仍靠旧帧。子代理里程碑靠 `instanceId != null` 的 `run_ended` 经 `contractToLegacyEvents` → `subagent(phase=done)`。 |
| abort 时前端能收到 settled 吗？ | 不能（fetch 已 AbortError 关流）。settled(aborted) 是服务端 canonical record，前端 stopped 仍来自 AbortError 分支——与 spec §3.4 一致。 |

入口索引：`lib/agent/runtime-events.ts`（类型）· `app/api/agent/query/route.ts`（`settleRun`）· `app/chat/chat-request.ts`（分发）· `tests/runtime-events.test.ts`（S1–S5）。

---

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/agent/runtime-events.ts` | 新增 |
| `tests/runtime-events.test.ts` | 新增 |
| `lib/agent/claude-adapter.ts` | 修改 |
| `lib/agent/mock-agent.ts` | 修改 |
| `lib/agent/subagent-runner.ts` | 修改 |
| `lib/agent/mcp-tools/index.ts` | 修改 |
| `lib/agent/mcp-tools/subagent.ts` | 修改 |
| `lib/agent/mcp-tools/filing-precheck-batch.ts` | 修改 |
| `lib/agent/mcp-tools/bank-recon-batch.ts` | 修改 |
| `app/api/agent/query/route.ts` | 修改 |
| `app/chat/chat-types.ts` | 修改 |
| `app/chat/subagent-track.tsx` | 修改 |
| `app/chat/chat-request.ts` | 修改 |
| `app/shared/chat-stream.tsx` | 修改 |
| `tests/subagent-transparency.test.ts` | 修改 |
| `tests/all.test.ts` | 修改 |

---

## 每文件改动内容

### `lib/agent/runtime-events.ts`（新增）
定义 `AgentRuntimeEvent` 联合类型（新合同事件 + 向后兼容遗留事件），`AgentEventEnvelope`，
`createEmitter` 工厂（封装 eventId 计数器与 ts 盖章，提供 `wrap`/`wrapConversation` 方法），
以及 `contractToLegacyEvents` 映射函数（合同 envelope → 旧 `chat_agent_events` 词表）。

### `tests/runtime-events.test.ts`（新增）
TDD 测试文件，覆盖六个测试节：
- L1-L11：`contractToLegacyEvents` 词表快照（新合同→遗留映射）
- LS1-LS5：subagent 事件映射（run_started/tool_completed/run_blocked/run_ended → 旧 subagent phase）
- E1-E13：envelope 不变量（v=1、eventId 单调递增、instanceId、ts 格式等）
- C1-C6：源码契约 import 同源（各文件均从 runtime-events 导入）
- R1-R7：reducer 等价（instanceId 在 timeline 条目上保留）
- S1-S5：run_settled 收口三路径（completed/aborted/error 均由同一函数发射）

所有断言通过：`node --import tsx tests/runtime-events.test.ts` 输出 `全部断言通过 ✓`。

### `lib/agent/claude-adapter.ts`（修改）
- 删除 `export type AgentRunEvent` 联合类型
- `ClaudeAgentRunOptions` 中 `onChunk`/`onThinking`/`onAgentEvent` 三回调改为单一 `emit?: (event: AgentRuntimeEvent) => void` + 新增 `onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void`
- 内部各 emit 点改发合同事件：`message_delta(channel)` 取代 onChunk/onThinking；`tool_started`/`tool_completed` 取代 tool_use/tool_result；`compaction_completed` 取代 system(compact_boundary)；`system_note` 取代其余 system 事件

### `lib/agent/mock-agent.ts`（修改）
- import 改为 `AgentRuntimeEvent` from `./runtime-events`（移除 AgentRunEvent）
- `emitEvent` 直接调 `runOptions.emit?.()`
- 所有 tool 事件改用新类型：`tool_started`/`tool_completed`（替代旧 `tool_use`/`tool_result`）
- thinking 改用 `{type:"message_delta", channel:"thinking", delta}`
- say() 内部改用 `{type:"message_delta", channel:"text", delta}`

### `lib/agent/subagent-runner.ts`（修改）
- 添加 `import { randomUUID } from "node:crypto"`
- `onEvent` 回调签名改为 `(event: AgentRuntimeEvent, instanceId: string) => void`
- 每次 `runSubagent` 开始时生成 `const instanceId = randomUUID()`
- 五个 emit 点改合同事件：
  - start → `{type:"run_started", label, roleId}`
  - tool → `{type:"tool_completed", toolName, content, durationMs, isError, summary}`
  - blocked → `{type:"run_blocked", toolName, label, roleId, summary}`
  - done(success) → `{type:"run_ended", kind:"complete", label, roleId, success:true, durationMs}`
  - done(fail) → `{type:"run_ended", kind:"incomplete", label, roleId, success:false, durationMs}`
  - 全部携带 instanceId 作为第二参数

### `lib/agent/mcp-tools/index.ts`、`subagent.ts`、`filing-precheck-batch.ts`、`bank-recon-batch.ts`（修改）
- import 改为 `AgentRuntimeEvent` from `@/lib/agent/runtime-events`
- `onSubagentEvent?: (event: AgentRuntimeEvent, instanceId: string) => void` 签名随类型更新
- `RunParallelFn`（batch 文件）的 `onEvent` 签名同步更新

### `app/api/agent/query/route.ts`（修改，主要重写）
- 引入 `createEmitter`、`contractToLegacyEvents`、`AgentRuntimeEvent`、`AgentEventEnvelope`、`AgentEmitter`
- `runAgentTurn` 创建 `mainEmitter = createEmitter(traceId, conversationId, null)`
- `handleEmit(event, emitter)` 统一处理：
  - `message_delta(text)` → 经 identity 过滤 → push chunks → wrap envelope
  - `message_delta(thinking)` → 经 PII+identity 过滤 → wrap envelope
  - 其余 → wrap envelope → `contractToLegacyEvents` → 落入 collector
- `onSubagentEvent` 为每个子代理事件创建独立 `createEmitter(traceId, convId, instanceId)`
- `settleRun(outcome, opts?)` 单一收口函数发射 `run_ended` + `run_settled`（三路径共用）
- 成功路径：`settleRun("completed")` 后发旧 `done` 帧（向前兼容）
- abort/error 路径：`settleRun("aborted"|"error")` 后发旧 `incomplete`/`error` 帧
- `ask_user`/`ask_user_answered` 经 `streamEmitter.wrap()` 作为 envelope 发送
- `title_updated` 经 `streamEmitter.wrapConversation()` 发送（runId=null）

### `app/chat/chat-types.ts`（修改）
- 删除本地 `AgentEvent` 联合类型
- 改为 `export type AgentEvent = AgentRuntimeEvent`（再导出别名，下游零改动）
- `VISIBLE_SYSTEM_SUBTYPES` 恢复为仅含 `"compact_boundary"`（回滚误加的 `"init"`）
- `shouldHideAgentEvent` 中的 subtype 取值改为 `(event as {subtype?: string}).subtype` 安全转型

### `app/chat/subagent-track.tsx`（修改）
- `TimelineItem` 类型增加 `instanceId?: string | null`
- 主过滤条件改为 `instanceId != null`（live 流），兜底保留 `event.type === "subagent"`（DB 历史）

### `app/chat/chat-request.ts`（修改）
- 引入 `contractToLegacyEvents`、`AgentEventEnvelope`
- `SSECallbacks.onAgentEvent` 签名增加 `instanceId?: string | null` 参数
- `dispatchSSEEvent` 参数改为 `data: Record<string, unknown>`，实现双模分发：
  - 新帧（`v === 1`）：解包 envelope，`message_delta(text)` → onChunk；`run_started` → onMeta；`title_updated` → onTitle；terminal 事件（run_settled/run_ended 等）→ 消耗不转发；其余 → `contractToLegacyEvents` → onAgentEvent
  - 旧帧：保持原有 chunk/agent_event/meta/ask_user/title/done/incomplete/error 路径

### `app/shared/chat-stream.tsx`（修改）
- `StreamTimelineItem` 增加 `instanceId?: string | null`
- `reduceAgentEvent` 签名增加 `instanceId?: string | null` 参数，存入 timeline 条目
- `runStream` 中 `onAgentEvent` 回调传 `instanceId` 给 `reduceAgentEvent`

### `tests/subagent-transparency.test.ts`（修改）
- C1-C4：原检查 `phase: "start/tool/blocked/done"` → 改为检查新合同类型 `run_started`/`tool_completed`/`run_blocked`/`run_ended`
- C12-C13：原检查 `chat-types.ts` 含 `type:"subagent"` → 改为检查 `runtime-events.ts` 含子代理变体，claude-adapter import 自 runtime-events

### `tests/all.test.ts`（修改）
- 末尾追加：`const { runtimeEventsTestPromise } = await import("./runtime-events.test.ts"); await runtimeEventsTestPromise;`

---

## 与计划的偏差及原因

### 偏差 1：`VISIBLE_SYSTEM_SUBTYPES` 修正（`chat-types.ts`）
先前会话错误地将 `"init"` 加入白名单。`agent-event-stream.test.ts`（不在 Files touched 内）明确断言 `init` 应隐藏。本次修复以保持预存测试通过。偏差方向：恢复现状，非扩展功能。

### 偏差 2：`tests/subagent-transparency.test.ts` C1-C4 额外更新
Spec 只提到更新 C12-C13（:152-153 行），但 C1-C4 检查 `phase: "start"` 等旧字段，AR2a 改完后必然失败。两处都在 Files touched 列表的同一文件中，更新 C1-C4 是维持测试绿灯的最小改动，未扩展文件范围。

### 偏差 3：`lib/agent/persist-hygiene.ts` 未实际修改
Spec 列出此文件为"修改 | 入参类型改合同"。但 `sanitizeTurnEvents` 的 `AnyEvent` 结构化类型（`{ type: string; [k: string]: unknown }`）已经覆盖新旧两种事件格式，`collector.collectedEvents` 存储的是 `contractToLegacyEvents` 翻译后的遗留格式，过滤逻辑（检查 `type === "system"` + `subtype`）不受影响。实质行为零差异，故不作无意义的类型声明变更。

---

## 测试结果

### TDD 红-绿证据

写 `tests/runtime-events.test.ts` 时 `lib/agent/runtime-events.ts` 尚未实现，§③④⑤（源码契约/reducer/run_settled）全红；实现源文件后全绿。

### 最终运行结果

```
$ node --import tsx tests/runtime-events.test.ts
L1-L11: contractToLegacyEvents 词表快照 ✓
LS1-LS5: subagent 事件映射 ✓
E1-E13: envelope 不变量 ✓
C1-C6: 源码契约 import 同源 ✓
R1-R7: reducer 等价 ✓
S1-S5: run_settled 收口 × 三路径 ✓
runtime-events: 全部断言通过 ✓

$ node --import tsx tests/subagent-transparency.test.ts
P1-P6: buildTurnSegments subagent 分组 ✓
C1-C4: 四个 emit 点（新合同类型）✓
C5-C7: 脱敏红线自查 ✓
C8-C11: 透传链完整性 ✓
C12-C13: AR2a subagent 变体在 runtime-events.ts 统一定义 ✓
C14-C19: 渲染分支存在 ✓
C20: shouldHideAgentEvent 不隐藏 subagent ✓
C21-C22: MCP 工具结果被收（P2）✓
subagent-transparency: 全部断言通过 ✓

$ node --import tsx tests/agent-event-stream.test.ts
agent-event-stream: all 17 checks passed ✓
```

---

## 开放风险

### 风险 1（已修复）：`tests/mock-agent.test.ts`

**原状**（AR2a 初次交付时）：该测试文件从 `claude-adapter.ts` import `AgentRunEvent`（AR2a 已删除），并检查 `e.type === "tool_use"` / `e.type === "tool_result"`（AR2a 改为 `tool_started`/`tool_completed`），同时使用 `onChunk`/`onAgentEvent` 回调（AR2a 已从 `ClaudeAgentRunOptions` 移除），M1 断言失败。

**修复**（fix-first 第一轮，已在 AR2a fix-first-r1 任务中完成）：
- `import type { AgentRunEvent }` 改为 `import type { AgentRuntimeEvent }` from `runtime-events`
- `events` 类型改为 `AgentRuntimeEvent[]`
- `onChunk`/`onAgentEvent` 回调改为单一 `emit` 回调（`message_delta(text)` → chunks，所有事件入 events）
- M1/M2 检查改为 `tool_started`；M4 验证普通问答无 `tool_started`/`tool_completed`

**当前状态**：`tests/mock-agent.test.ts` 全部断言通过。

### 风险 2（低）：SSE abort 竞态
`run_settled(aborted)` 发出时前端 fetch 已因 AbortError 关流，帧送达不了前端。spec 已明确此为设计意图（服务端 canonical record，非前端状态来源）。前端 abort 路径保留 AbortError→stopped 分支不变。
