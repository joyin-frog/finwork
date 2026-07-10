# ROADMAP-agent-runtime：Agent 运行时硬化总纲

> **本文件是跨会话的进度账本。** 每个会话开工先读它，收工前更新状态表。
> 设计决策与被否决的备选方案写进各 spec；本文件只管全局：工作包、依赖、状态、批次。
> 创建：2026-07-10 v1.0（earendil-works/pi 全仓探索 + Codex 清单交叉对比，结论存记忆
> `pi-repo-reference.md`）。
> **修订 v1.1（2026-07-10）**：Codex 二轮评审修正——v1.0 把 pi 自己掌控 agent loop 的能力
> 部分误当成 Claude Agent SDK 外层可直接复制的能力。本轮修正已逐条对照 SDK 类型
> （`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）与现有代码核实，AR1/AR2/AR3/AR5
> 的实现假设全部重写，AR4/AR6/AR8 措辞收窄。
> 体例照 `ROADMAP-improve.md`；单个工作包开工时再写自包含的 `spec-<工作包名>.md`。

## 总判断

pi 探索验证了 finwork 的 agent 层三个已知薄弱点有配方可参照（重建回顾退化、压缩不可感知、
运行中不可插话），同时暴露一个结构性欠账：**后端 `AgentRunEvent`、前端 `AgentEvent`、SSE
外层帧是三套平行协议，且没有终态语义（done ≠ settled）与断线重放能力**。统一事件合同是
本总纲的地基工程。

**方法论共识**：先治确诊的病（P0），再铺路线图的砖（P1），架构泛化等真需求出现（P2）。
两条铁律贯穿全部工作包：

1. **AgentRuntime 方法接口不做 P0**——其唯一收益（换 runtime）本身是 P2 条件项；但事件
   类型合同必须 P0 抽取，且合同字段不得泄漏 SDK 形状。
2. **finwork 不拥有 agent loop，Claude SDK 拥有**（v1.1 起升为铁律）——任何从 pi 抄来的
   loop 内能力（截断拦截、steering 注入点、compaction 算法替换），落地前必须先确认 SDK
   暴露了对应控制点（hook / Query 方法 / 回调参数），确认不了就先立 spike 不立实施包。

## 已拍板/共识决策

| # | 决策 | 内容 |
|---|------|------|
| R1 | 事件合同 P0 | 后端/SSE/前端收敛为唯一共享合同 `AgentRuntimeEvent`，补 `run_settled` 终态与稳定 event cursor |
| R2 | 接口抽取降级 | AgentRuntime 方法接口 + `claude_session_id` 泛化降为 P2 条件项：等第二 runtime PoC 立项后由两个实现校准接口形状 |
| R3 | ~~compaction 升 P0~~（v1.1 修正） | v1.0 表述"把 SDK 摘要生成换成 pi 配方"**不成立**：`<对话回顾>` 只在非 resume / 失效 session 重建时使用（`lib/agent/claude-adapter.ts` yieldMessages，注释明确此为 prompt 流角色限制的绕行），正常续聊走 Claude transcript；SDK `PostCompact` hook 只提供 `compact_summary` 捕获（sdk.d.ts:2086），无替换压缩算法的控制点。AR1 拆为 AR1a（重建回顾结构化）+ AR1b（PostCompact 摘要审计），均为 SDK 外层可达 |
| R4 | 不换 SDK | 整体替换 Claude Agent SDK、引入 pi 作依赖、动摇 MCP 架构，均列入不做清单 |
| R5 | 看板现状修正 | agent-team-board / task-board / dispatch-store 均已 ship；AR4 是补 runtime 层，不是重建 UI |
| R6 | 实时/持久分账（v1.1） | 实时事件通道与持久事件日志是两种账本：`partial` 快照只走实时通道；持久化走独立 `run_events` 表 + 周期 checkpoint + 终态事件，**不把每个完整 partial append 进 SQLite**（平方级膨胀）。运行事件日志与模型上下文会话树也是两种账本，不因都有 cursor 而合并设计（v1.0"append-only session 雏形顺手成立"的说法撤回） |
| R7 | 重放语义（v1.1) | 断线重放是 at-least-once delivery：`run_settled` 每 run 恰好一次指**日志里有唯一 canonical record**，客户端仍须按 eventId 去重。现有客户端是 `fetch POST` 读 SSE 而非 EventSource，`Last-Event-ID` 不会自动生效——cursor 由客户端显式带参 |

## 工作包清单

状态取值：`未开始` → `spec已写` → `计划已批` → `实施中` → `已ship`（spike 型：`未开始` → `已验证/已否决`）。

### P0 —— 治确诊的病，直接价值

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| AR2a | 共享事件合同（实时层） | 唯一 `AgentRuntimeEvent` 类型 + 事件 envelope + `run_settled`，现有 Claude adapter 先实现。**本包不做持久重放**（那是 AR2b）。事件清单与 envelope 见下节 | 无 | **已ship**（`spec-agent-event-contract.md` v1.2 + `audit-agent-event-contract.md`；19 文件 +470/-340。计划审查 fix-first×2；实施审查 fix-first 一轮抓 3 阻塞——B1 子代理 run_ended 前端丢失/B2 eventId 跨 emitter 不单调/B3 tool_completed 落库 label=UUID 破坏分组——均修复后终审 ship。未提交，待用户决定 commit/PR） |
| AR3-spike | 工具安全闸可行性验证 | 见 `spike-tool-gate-findings.md` v2.0（静态+运行时 E2a/E2b/E3/E3b 均有定论，E1 截断未复现） | 无 | **已完成**。结论：①**AR3b-垫片立项**，挂点=MCP handler 内部（E2b 证明 zod 在 canUseTool 之后，挂 canUseTool 来不及）；②**AR3b-截断闸降级为观察项不立包**（高风险写工具都是带 zod 的 MCP 工具，zod 是天然兜底；E1 未证明 SDK 截断会执行工具；且 canUseTool 覆盖不到 allowedTools 内置工具——E3b）；③附带产出：`SDKAssistantMessage.error` 实时可见，供 AR2a 的 run_ended/settled outcome 用 |
| AR3b-垫片 | MCP 入参宽松化垫片 | MCP 工具 handler 入口对"应为 object/array 却收到 JSON 字符串"的参数先 parse 再交业务 | AR3-spike（已完成） | **已ship**（`coerce-json.ts` 的 `jsonCoercible` = zod `z.preprocess` 声明式包装；应用到 kingdee(16字段)/business-analysis(4)/business-metrics(1)/emit-checklist(1)；纯字符串小数组 profile/document-metadata 按判据排除。轻量路径主循环自查通过。`audit-ar3b-json-coerce.md`。未提交） |
| AR1a | 失效 session 的结构化重建回顾 | 现状：resume 失效时全量历史压平成单条 `<对话回顾>` user 消息（claude-adapter.ts yieldMessages）。改造：借 pi compaction 的摘要结构（`Goal/Progress/Key Decisions/Next Steps` + 读写文件清单 + 回合边界切割），把重建回顾从"压平转写"升级为"结构化摘要 + 保留最近 N 轮原文"。**只动 finwork 自己的重建路径，不声称接管 SDK compaction** | 无 | 未开始 |
| AR1b | SDK compaction 摘要审计 | 用 `PostCompact` hook（`compact_summary` + trigger，sdk.d.ts:2086）把 SDK 压缩摘要、`compact_boundary` 的 pre/post tokens 元数据落 `agent_spans`/审计模型。压缩从"只落 span 不知内容"变为可感知可追溯 | 无 | 未开始 |

### P1 —— 铺路线图的砖

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| AR2b | run 事件持久化 + 重放 | 独立 `run_events` 表（不复用 `chat_agent_events`——其 `message_id` NOT NULL 且 assistant message 回合收尾才建行，实时事件无从挂靠）：终态事件 + 周期 checkpoint 落库，高频 delta 只走实时通道（R6）。GET replay 接口按 eventId 起点重放。cursor 用表自增 id，不另设 per-conversation seq | AR2a | 未开始 |
| AR2c | 断线恢复客户端 | 客户端显式带 cursor 重连（POST-SSE 无 EventSource 自动重发，R7）、按 eventId 去重、以 checkpoint + 后续事件重建现场 | AR2b | 未开始 |
| AR4 | run 状态机 + 可观察现场重建 | `subagent_dispatches` 台账之下补 run 级状态机（`starting→running→settled|error|interrupted`）与事件流打通、按 `instanceId` 订阅。**崩溃恢复措辞收窄（v1.1）**：恢复的是最后已持久化状态、已完成工具步骤、孤儿 run 标记 `interrupted/recoverable`、用户继续执行的入口——**不承诺**恢复执行中的 Claude query / Python 进程 / 未提交事务。目标是"重建可观察现场"，非"恢复执行现场"。参照 pi supervisor 的 InstanceRecord + recoverAfterRestart，自建不引包 | AR2b | 未开始 |
| AR5-spike → AR5 | steering 插话（先 spike） | v1.0"loop 每轮工具执行后轮询队列"**不成立**（finwork 不拥有 loop）。实际路线：SDK streaming input 模式的 `Query.streamInput(stream)`（sdk.d.ts:2439）+ `interrupt()`（sdk.d.ts:2205）——保持输入流开放、保存活跃 Query 句柄、经 streamInput 投递、interrupt 做真中断。**spike 先验证 SDK 实际投递时点**（消息何时进上下文：当前 turn 工具跑完后？下次模型请求前？），时点语义确认后才立实施包。UI 形态（常驻输入 vs 插话按钮）写 spec 前问用户 | AR2a（`queue_updated` 事件） | 未开始 |
| AR6 | 文件写串行化 | Write/Edit 型工具按规范化绝对路径排队（参照 pi file-mutation-queue）。**`run_python` 例外（v1.1）**：可写任意多文件、调用前不知 canonical path——对它用 conversation/outputDir 级粗锁，或在真实文件写边界（deliverable 落盘处）加锁，spec 时定 | 无 | 未开始 |
| AR7 | 仓库外打包 smoke test | Tauri/Next/skills 打包产物在仓库外环境安装冒烟（照 pi release:local 模式：build→pack→隔离安装→跑真命令）。非 pi 衍生项，是"Windows 运行时测试盲区"既有欠债，借本总纲登记 | 无 | 未开始 |

### P2 —— 条件触发，等真需求

| ID | 工作包 | 说明 | 触发条件 | 状态 |
|----|--------|------|----------|------|
| AR8 | 子代理角色 SOP 渐进披露 | **改名（v1.1）**：主 Agent skills 已经通过 SDK skill plugin 渐进加载（`lib/agent/skill-plugin.ts` 注释明确：listing 只占 name+description，正文按需加载）。本包只针对**子代理的 rolePrompt 内嵌 SOP**：挪成 SKILL.md 形态按需加载 | 子代理 rolePrompt 体积成为实际痛点 | 未开始 |
| AR9 | AgentRuntime 方法接口 + session 泛化 | 抽 `prompt()/resume()/interrupt()` 方法签名层；`claude_session_id` 泛化为 runtime session | AR10 PoC 立项（由两个实现校准接口形状） | 未开始 |
| AR10 | pi-ai/pi-agent-core 独立 PoC | 仓库外 PoC 验证多 Provider 路线 | 确定要支持多 Provider（产品决策） | 未开始 |

## 事件合同设计要点（AR2a/b/c 的设计定案，写 spec 时展开）

事件清单：

```
run_started
turn_started
message_started / message_delta / message_completed
tool_started / tool_updated / tool_completed
queue_updated
compaction_completed
run_ended
run_settled
```

事件 envelope（每个事件的外层结构，v1.1 定案）：

```
{
  schemaVersion;
  eventId;          // 全局单调（持久层=run_events 自增 id）
  runId;
  conversationId;
  instanceId;       // 子代理事件复用同一合同；主对话为 null
  turnId?;
  messageId?;       // 回合收尾后回填关联，实时期可空
  toolCallId?;
  timestamp;
  event;            // 上表之一 + 各自 payload
}
```

设计铁律（均已定案，spec 不再重议）：

1. **`run_settled` 语义**：日志中每 run 恰好一条 canonical record；settled 之后本 run 绝不
   再有新事件；携带 `outcome: completed | aborted | error`。`run_ended` 与 `run_settled`
   之间允许出现 `compaction_completed` / `queue_updated` / 落库收尾——"done ≠ settled"
   正是本事件存在的理由。传递语义是 at-least-once，客户端按 eventId 去重（R7）。
2. **实时/持久分账（R6，AR2a spec 修正）**：delta 事件只带增量**不带 partial 快照**——
   SSE 场景下逐 delta 携带全量累积是 O(n²) 网络字节（pi 是进程内传递才无成本），且前端
   reducer 本就增量累积。快照挂在 `message_completed`/`tool_completed` 终态事件；重放
   场景的快照是 AR2b checkpoint 的职责。持久层只存终态事件 + 周期 checkpoint，绝不
   append 每个完整 partial。断线重建现场 = 最近 checkpoint + 其后事件重放。
3. **cursor**：`run_events` 表自增 id 即游标；客户端重连显式带参（POST-SSE 无
   `Last-Event-ID` 自动机制，R7）。
4. **`instanceId` 预留**：子代理事件复用同一合同，现在留成本为零；不留则批跑阶段返工协议。
5. **合同不泄漏 SDK 形状**：字段全部自有命名，`parent_tool_use_id`、`session_id` 等由
   adapter 映射，绝不透传。守住这条，AR9 的接口将来是被两个实现校准出来的。

## 依赖关系（关键路径）

```
AR2a 事件合同(实时) ──→ AR2b 持久化+重放 ──→ AR2c 断线客户端
                    │                  └──→ AR4 run状态机 ──→ 批跑（另立项）
                    └──→ AR5-spike ──→ AR5 steering
AR3-spike ──→ (若可行) AR3b 实施
AR1a / AR1b / AR6 / AR7（无前置，按资源穿插）
AR10 PoC ──→ AR9 接口抽取（顺序不可反）
```

## 批次计划（v1.1，照 Codex 建议序调整；开工时按当时资源微调）

- **第一批**：AR2a（共享事件合同+run_settled，暂不做持久重放）+ AR3-spike（SDK 控制点
  可行性验证，产出结论文档）。
- **第二批**：AR1a（结构化重建回顾）+ AR1b（PostCompact 摘要审计）——两包都动
  claude-adapter 周边，同批串行。
- **第三批**：AR2b（run 事件持久化+checkpoint+replay）；AR6、AR7 穿插。
- **第四批**：AR4（run 状态机）+ AR2c（断线客户端）。
- **第五批**：AR5-spike → AR5（steering，spike 通过后）。
- P2 三项不排批次，条件触发。

## 会话协议（断点续传）

1. 开工：读本文件 → 找到状态非"已ship"的最靠前工作包 → 写/读对应 `spec-<工作包名>.md`。
2. 流水线：scout 探索 → 主循环写 spec（自包含）→ reviewer 批计划（复杂任务）→ implementer
   实施（TDD，先红后绿）→ 写 audit → reviewer 审 diff → ship。spike 型工作包产出结论文档，
   不走完整流水线。
3. 收工：更新本文件状态表；关键取舍写持久记忆。
4. pi 参照代码：重新 clone `github.com/earendil-works/pi` 对照；五包全景与可抄清单见记忆
   `pi-repo-reference.md`。SDK 控制点以 `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`
   为准（本总纲引用行号对应 v0.3.x，升级后重核）。

## 需要用户确认的口径（遇到时问，不编默认值）

- AR2b：`run_events` 新表走迁移链，编号遵守跨 worktree 迁移纪律（三查：main 链尾/各
  worktree 链尾/库实际版本）。
- AR5：steering 注入的 UI 形态（输入框常驻可打字 vs 显式"插话"按钮）——spike 后、写 spec 前问。
- AR1a：重建回顾的摘要生成用哪档模型槽（routerModel 快速档 vs 主模型）——成本口径需拍板。

## 不做清单（不设限也不做，防止反复纠结）

整体替换 Claude Agent SDK（深度绑定 session/transcript/MCP/hook，重写收益远小于风险）；
引入 pi 系包作运行时依赖（只抄设计不背依赖）；采纳 pi 反 MCP 哲学（finwork 25+ 域工具
全走 MCP，架构正相反）；TUI/多 Provider 模型目录（GUI + Anthropic 网关用不上）；
在 AR10 立项前做任何"为多 runtime 预留"的抽象层；声称接管/替换 SDK compaction 算法
（控制点不存在，只有 PostCompact 捕获）；把每个完整 partial 快照 append 进 SQLite。
