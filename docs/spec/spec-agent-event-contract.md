# agent-event-contract（AR2a：统一事件合同·实时层）Spec

> 版本 v1.2 / 2026-07-10
> 状态：~~草案~~ → **已批准**（计划审查三轮：fix first×2——B1-B3 Files touched 漏列、
> subagent-track 静默行为破坏——均修复后终审批准）→ 已实施（随流水线推进更新）
> 依赖：`ROADMAP-agent-runtime.md`（AR2a 定义、决策 R1/R6/R7、事件合同设计铁律）
> 架构事实（写给全新上下文的实现者，均已实测到行）：
> - 技术栈：Next.js App Router + Tauri 2；agent 循环用 `@anthropic-ai/claude-agent-sdk`
>   （`sdk.query()`），入口 `lib/agent/claude-adapter.ts` 的 `runClaudeAgent()`。
> - **三套平行事件协议是本 spec 要消灭的对象**：
>   ① 后端 `AgentRunEvent`（claude-adapter.ts:60-64）：只有 `system/tool_use/tool_result/subagent`
>   四变体——**没有 text/thinking**，文本走独立 `onChunk` 回调、思考走 `onThinking` 回调；
>   ② SSE 外层帧（app/api/agent/query/route.ts `createStreamingResponse`，约 :315）：
>   `data: ${JSON.stringify(payload)}\n\n` 纯 data 行、无 id/event 字段，帧 type 有
>   `meta/chunk/agent_event/ask_user/ask_user_answered/title/done/incomplete/error` 九种；
>   ③ 前端 `AgentEvent`（app/chat/chat-types.ts:74-82）：比后端多 `text/thinking/ask_user/
>   ask_user_answered` 变体，由 route 层包装后经 `agent_event` 帧到达。
> - 前端消费链：`app/shared/chat-stream.tsx`（ChatStreamProvider→runStream→readSSEStream）→
>   `app/chat/chat-request.ts` 的 `dispatchSSEEvent`（:124）；状态聚合纯函数 `reduceChunk`
>   （:74）/`reduceAgentEvent`（:92）**在 chat-stream.tsx**（注意不在 chat-request.ts）；
>   `TurnStatus = streaming|done|error|stopped|incomplete`，收到 `done` 帧置 done，
>   `isFinished`（:164）。断线：AbortError→stopped，其他→error。
> - thinking 是**整块上报非逐 token**：claude-adapter.ts:470 注释明确"thinking 增量不收
>   不推"，`onThinking` 收到的是 assistant 消息里完整的 thinking 块。因此合同的
>   `message_delta(channel=thinking)` 实为"每块一条 delta"，实现时不要试图造逐字流。
> - 持久化：`chat_agent_events` 唯一写出口是 `insertAssistantTurn`（route.ts:223），
>   **回合收尾时批量写**（非实时）；assistant message 行也在收尾时创建（route.ts:248，
>   条件 conversationId && fullContent 非空）。写入前经 `sanitizeTurnEvents`
>   （lib/agent/persist-hygiene.ts）过滤。历史行 event_type 词表：
>   `text/thinking/tool_use/tool_result/system/subagent/ask_user/ask_user_answered`
>   （另有 system 子类 turn_duration/turn_incomplete/thinking_duration/compact_boundary/init）。
> - run 收尾顺序（现状）：`persistAgentTurn`（route.ts:375，落库+cleanup+trace）→
>   `writeSpan` → 发 `done` 帧（:378）→ `await improveConversationTitle` → 发 `title` 帧
>   （:381-386）→ `controller.close()`。**done 之后还有 title 收尾**——这正是 run_settled
>   要修的空隙；且没有任何"收尾完成"终态事件。
> - 子代理事件：`subagent-runner.ts`（:134/:215/:312/:330/:353）emit `subagent` 变体
>   （phase=start/tool/blocked/done），经 `onEvent` 回调链
>   （mcp-tools/subagent.ts→mcp-tools/index.ts:27→claude-adapter.ts:205 的 onAgentEvent）
>   混在主回合 `agent_event` 帧里下发，无实例标识字段之外的通道。
> - 测试栈：`npm test` = `node --import tsx tests/all.test.ts`（聚合入口，新测试文件必须
>   接入）；跑绿姿势 `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true`；**无 DOM 测试栈**——
>   UI 用源码契约断言（readFileSync + 正则），纯逻辑用纯函数测试。

## 0. 目标与非目标

**目标**：三套平行协议收敛为唯一共享合同 `AgentRuntimeEvent`（单一 schema 文件，后端
emit、SSE 传输、前端消费皆 import 同一类型），并补 `run_settled` 终态事件（含
outcome）与事件 envelope（含 per-run 单调 eventId、instanceId 预留）。

**非目标（本期不做，已知并接受）**：
- ❌ 持久化重放 / `run_events` 表 / checkpoint（AR2b）；断线恢复客户端（AR2c）。
- ❌ `chat_agent_events` 表结构与**持久化词表**变更——合同事件在落库边界映射回既有
  event_type 词表，历史行渲染零迁移。
- ❌ run 状态机与 dispatch-store 打通（AR4）；steering 队列（AR5，`queue_updated`
  类型本期只定义不发射）。
- ❌ 改 SDK 交互逻辑（sdk.query 参数、hook chain、MCP server 注册均不动）——只改
  事件的出口形状。
- ❌ 兼容旧帧格式的过渡期双协议（桌面应用整体发版，前后端同仓同步切换，无旧客户端）。

## 1. 成功标准

- [ ] **单一 schema**：`lib/agent/runtime-events.ts` 是唯一事件类型定义处；
  `AgentRunEvent`（claude-adapter.ts）与前端自定义 `AgentEvent`（chat-types.ts）删除。
  验证：grep 断言 chat-types.ts 不再声明事件 union，且 adapter/route/chat-request 均
  import 自 runtime-events.ts（源码契约测试）。
- [ ] **settled 恰好一次**：success / abort / error 三条路径下，SSE 流各恰好出现一条
  `run_settled`（outcome 分别为 completed/aborted/error），且其后无任何 runId 等于
  本 run 的事件。验证：route 流式响应测试（mock adapter）跑三路径，收集全部帧断言。
- [ ] **run_ended 先于 run_settled**：三条路径均成立（error 路径 run_ended 允许空负载）。
- [ ] **envelope 不变量**：eventId 在单 run 内严格单调递增；主对话事件 instanceId=null，
  子代理事件 instanceId 非空且同一子代理内一致。验证：同上测试 + subagent mock 路径。
- [ ] **前端行为等价**：timeline 渲染输入（text/thinking/tool/subagent/ask_user 各类）
  与 TurnStatus 派生（done/stopped/error/incomplete）在新合同下与现状一致。验证：
  reducer 纯函数测试——同一逻辑场景的合同事件序列产出与旧实现相同的 UI 状态。
- [ ] **持久化零回归**：合同事件经映射落库后，`chat_agent_events` 行的 event_type 词表
  与 payload 形状与现状一致（含 system 子类）；`sanitizeTurnEvents` 行为不变。验证：
  映射函数单测对照现有词表快照。
- [ ] **title 不再阻塞收尾**：`title_updated` 作为 conversation 级事件（envelope
  runId=null）在 run_settled 之后异步到达，前端能更新标题；done 感知不再等标题提炼。
- [ ] 全量测试绿：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`（含 typecheck 门禁）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/runtime-events.ts` | 新增 | 合同：envelope + 事件 union + 工厂/类型守卫 + `contractToLegacyEvents` 落库映射 |
| `lib/agent/claude-adapter.ts` | 修改 | 删 `AgentRunEvent`；`onChunk/onThinking/onAgentEvent` 三回调收敛为单一 `emit(AgentRuntimeEvent)`；内部各 emit 点改发合同事件 |
| `lib/agent/subagent-runner.ts` | 修改 | subagent phase 事件改发合同事件（run_started/tool_completed/run_blocked/run_ended+run_settled），携带 instanceId |
| `lib/agent/mcp-tools/subagent.ts` | 修改 | onEvent 回调签名随合同类型更新（透传） |
| `lib/agent/mcp-tools/index.ts` | 修改 | 同上（buildFinanceMcpServers 传递链类型） |
| `lib/agent/persist-hygiene.ts` | 修改 | `sanitizeTurnEvents` 入参类型改合同（过滤逻辑不变） |
| `lib/agent/mock-agent.ts` | 修改 | :3 import 的 `AgentRunEvent` 与 :43 `onAgentEvent` 调用改合同类型（mock 路径是测试跑绿的前提） |
| `lib/agent/mcp-tools/filing-precheck-batch.ts` | 修改 | :19 import 与 `onEvent`/`onSubagentEvent` 回调签名改合同类型 |
| `lib/agent/mcp-tools/bank-recon-batch.ts` | 修改 | 同上（:19 import + 回调签名） |
| `tests/subagent-transparency.test.ts` | 修改 | :152-153 源码契约断言（检查旧 union 含 `type: "subagent"`）改为检查 `runtime-events.ts` 合同中的子代理事件映射 |
| `app/api/agent/query/route.ts` | 修改 | SSE 帧改为 envelope 直传；发射 run_started/run_ended/run_settled；收尾顺序调整（title 移出 run 收尾）；落库前经 `contractToLegacyEvents` |
| `app/chat/chat-types.ts` | 修改 | 删本地 `AgentEvent` union，改为 `export type AgentEvent = AgentRuntimeEvent` **再导出别名**——下游 `provenance.ts`/`components/assistant-turn.tsx` 只用通用 `AgentEvent`，别名使其零改动（故不列入本表）；TurnStatus 保留 |
| `app/chat/subagent-track.tsx` | 修改 | :33 的 `Extract<AgentEvent,{type:"subagent"}>` 过滤在新 union 下为 `never`（子代理里程碑会静默消失，行为破坏非编译错）。改写为按 envelope `instanceId !== null` 过滤 + 消费新事件（run_started/tool_completed/run_blocked/run_ended+run_settled 映射出原 phase/summary/toolName/durationMs/isError/success 展示语义）。前提：reducer 在 timeline 条目上保留 envelope 的 instanceId（§4 步骤 6 一并实现） |
| `app/chat/chat-request.ts` | 修改 | `dispatchSSEEvent`/`reduceChunk`/`reduceAgentEvent` 改消费 envelope + 合同事件 |
| `app/shared/chat-stream.tsx` | 修改 | ~~完成态派生自 run_settled（outcome→TurnStatus 映射）~~ **落地校准**：完成态仍由旧帧 `done`/`incomplete`/`error` 驱动；`run_settled` 在 `chat-request.dispatchSSEEvent` 静默消耗。本文件实际改动是 timeline 保留 `instanceId` 供子代理轨道过滤（见 audit「实现现状校准」） |
| `tests/runtime-events.test.ts` | 新增 | envelope 不变量、settled 恰好一次、落库映射词表快照、reducer 等价 |
| `tests/all.test.ts` | 修改 | 接入新测试文件 |

## 3. 合同定义（实现照此，不自由发挥）

### 3.1 Envelope

```ts
type AgentEventEnvelope = {
  v: 1;                        // schemaVersion
  eventId: number;             // per-run 内存单调计数，从 1 起（持久 cursor 归 AR2b）
  runId: string;               // 复用本 run 的 traceId（agent_traces 已有）；无则 crypto.randomUUID()
  conversationId: number | null;
  instanceId: string | null;   // 子代理实例标识；主对话恒 null。铁律 4
  turnId?: string;
  messageId?: number;          // 回合收尾落库后才有，实时期恒缺省
  toolCallId?: string;
  ts: string;                  // ISO
  event: AgentRuntimeEvent;
};
```

conversation 级事件（目前仅 `title_updated`）的 runId 置 null——"settled 后无本 run
事件"铁律只约束 runId 非空的事件。

### 3.2 事件 union（与现状能力一一对应，无损）

| 合同事件 | 替代现状 | payload 要点 |
|---|---|---|
| `run_started` | `meta` 帧 | conversationId |
| `turn_started` | 无（新增） | v1 在 run_started 后立即发一次（现状 1 run=1 持久 turn），为多 turn 预留 |
| `message_started` | 无（新增） | channel: "text"\|"thinking"；首个 delta 前发 |
| `message_delta` | `chunk` 帧 / onThinking | channel + delta（**只带增量不带 partial 快照**，见 §3.3） |
| `message_completed` | 无（新增） | channel + 全文快照 |
| `tool_started` | `tool_use` | toolName + input |
| `tool_updated` | 无 | 本期只定义（AR4/批跑进度用），不发射 |
| `tool_completed` | `tool_result` | content/isError/durationMs/structured |
| `ask_user` / `ask_user_answered` | 同名帧 | questionId + question/answer（finwork 域事件进合同） |
| `compaction_completed` | system(compact_boundary) | preTokens/postTokens/trigger |
| `system_note` | system(init 等白名单) | message 字符串（保留 MEANINGFUL 白名单语义） |
| `run_blocked` | subagent phase=blocked | summary（确认门；看板已消费 blockedReason，语义对齐） |
| `queue_updated` | 无 | 本期只定义不发射（AR5） |
| `run_ended` | `done`/`incomplete` 帧 | kind: "complete"\|"incomplete" + conversation + generatedAttachments + message?（incomplete 时） |
| `run_settled` | 无（新增，本 spec 核心） | outcome: "completed"\|"aborted"\|"error" + error?（message 字符串） |
| `title_updated` | `title` 帧 | title（conversation 级，runId=null） |

子代理映射（subagent-runner 五个 emit 点）：phase=start→`run_started`、phase=tool→
`tool_completed`（现状 tool 事件即完成式，带 durationMs/isError）、phase=blocked→
`run_blocked`、phase=done→`run_ended` + `run_settled`（outcome 由 success 派生），
全部带 instanceId（用现有 label+序号或 uuid，实现时取子代理已有唯一标识）。

### 3.3 v1.0 总纲的一处修正（写回 ROADMAP）

ROADMAP 铁律 2 原文"partial 快照只随实时通道的 delta 事件下发"**在 SSE 场景不成立**：
每个文本 delta 携带全量累积快照是 O(n²) 网络字节（pi 是进程内传递才无成本）。本 spec
定案：delta 只带增量；快照挂在 `message_completed`/`tool_completed`；重放场景的快照
是 AR2b checkpoint 的职责。前端 reducer 本就以增量累积（reduceChunk 现状），无额外成本。

### 3.4 收尾顺序（route 新时序）

```
… SDK 流结束 → persistAgentTurn（落库，不变）→ writeSpan
→ run_ended（kind + conversation + attachments）
→ run_settled（outcome）                    ← 新：落库完成后、标题之前
→ improveConversationTitle（异步收尾）→ title_updated（runId=null）
→ controller.close()
```

abort 路径：requestSignal 触发 → persistIncompleteTurn（不变）→ run_ended(incomplete)
→ run_settled(aborted)。error 路径：run_ended（空负载或已收集部分）→ run_settled(error)。
**三条路径的 settled 发射点必须在同一收口函数里实现**（单一出口保证恰好一次），不允许
散在各 catch 分支手工发。

**abort 送达竞态（明确语义，防实现者误解）**：用户点停止时前端 fetch 立刻抛 AbortError、
读流退出（chat-stream.tsx:297-299 置 stopped），此时服务端流已关，`run_settled(aborted)`
**送达不了前端**。因此：前端 abort 路径**保留 AbortError→stopped 分支不变**；
`run_settled(aborted)` 的价值是服务端 canonical record（AR2b 持久化后供重放/看板消费），
不是前端状态来源。成功标准第 2 条对 abort 路径的断言以**服务端发射侧**（收口函数被调用
且帧已尝试写入）为准，不断言前端收到。

> **Ship 后校准**：不仅 abort——**成功/错误路径上前端也不用 `run_settled` 驱动
> TurnStatus**；`dispatchSSEEvent` 吞掉 settled，完成态靠随后的旧 `done`/`incomplete`/
> `error` 帧。上句原「settled 只在正常/错误收尾路径驱动前端状态」已过时，勿再引用。
> 详见 audit「实现现状校准」与 ROADMAP `run_settled` 铁律下的实现现状校准。

## 4. 实施步骤

1. 新建 `lib/agent/runtime-events.ts`：envelope + union + `createEmitter(runId, conversationId)`
   工厂（内聚 eventId 计数与 ts 盖章）+ `contractToLegacyEvents()`（合同→既有
   chat_agent_events 词表；以 route.ts:223 现状 insertAssistantTurn 的输入形状为映射目标）。
2. 写 `tests/runtime-events.test.ts` 的映射词表快照测试与 envelope 不变量测试，**先红**
   （TDD：以现有词表为期望值，映射函数未实现时红）。
3. claude-adapter：`RunClaudeAgentOptions` 的 onChunk/onThinking/onAgentEvent 收敛为
   `emit`；内部 emit 点逐一改（tool_use :499、emitToolResult :380-388、system 白名单 :451、
   assistant 文本/thinking 回调处）。**保持 SDK 消费逻辑零改动**。
4. subagent-runner 五个 emit 点改合同事件 + instanceId；透传链（mcp-tools/subagent.ts、
   index.ts）类型随动。
5. route：`createStreamingResponse` 改 envelope 直传帧；实现单一收口函数发
   run_ended/run_settled（§3.4 三路径）；title 移出 run 收尾；落库入口套
   `contractToLegacyEvents`。
6. 前端：chat-types 删本地 union 改 import；chat-request 的 dispatch/reducers 按合同
   switch，**reducer 在 timeline 条目上保留 envelope 的 instanceId**（subagent-track 的
   过滤依据）；subagent-track 改写（见 Files touched 行）。~~chat-stream 完成态从
   run_settled 派生……~~ **计划未落地**：实际为双模兼容——新 envelope 传输合同事件，
   TurnStatus / onDone 仍听旧帧；`run_settled` 与主对话 `run_ended` 在
   `dispatchSSEEvent` 中消耗不转发（见 `audit-agent-event-contract.md`「实现现状校准」）。
7. 跑全量测试 + 手动 mock 对话冒烟（含 spawn_subagent 场景、中途 abort 场景）。

## 5. 测试与验证方式

```bash
# 全量（含 typecheck 门禁；新测试文件须接入 tests/all.test.ts）
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test

# 只跑本任务新增
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test -- runtime-events
```

- 需要新增的测试：①settled 恰好一次 × 三路径（mock adapter 驱动 route 流）；②run_ended
  先于 settled；③eventId 单调 + instanceId 规则；④contractToLegacyEvents 词表快照
  （对照现状 event_type 全集含 system 子类）；⑤reducer 等价（合同事件序列 → 与旧实现
  相同 UI 状态，纯函数）；⑥源码契约断言（chat-types 无本地 union、三层 import 同源）。
- 明确不需要：e2e / 真实 LLM 调用 / DOM 渲染测试（无 DOM 栈，UI 走源码契约断言）。

## 6. 风险与开放问题

- **回归面**：adapter 回调收敛动的是所有对话的核心路径。缓解：步骤顺序设计为"先立合同
  与映射（带测试）再切流"，且 mock 冒烟必须覆盖 subagent 与 abort。reviewer 重点审
  三路径收口函数。
- **title 时序变化**：title_updated 移到 settled 后，若前端在 settled 时就允许导航离开，
  标题更新可能丢失（现状同样存在此窗口，未恶化）；AR2b 的持久层落地后自愈。
- **instanceId 取值**：spec 允许实现时选用子代理既有唯一标识；若现状 label 不保证唯一，
  用 `crypto.randomUUID()`，并在 audit 中说明选择。
- **被否决的备选**：①delta 带 partial 快照（O(n²) 网络，§3.3）；②复用 `chat_agent_events`
  做实时持久（message_id NOT NULL 且行在收尾才建，挂靠不上——ROADMAP R6）；③过渡期
  双协议（无旧客户端，白付两套维护）。
