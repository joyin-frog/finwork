# ROADMAP-agent-runtime：Agent 运行时硬化总纲

> **本文件是跨会话的进度账本。** 每个会话开工先读它，收工前更新状态表。
> 设计决策与被否决的备选方案写进各 spec；本文件只管全局：工作包、依赖、状态、批次。
> 创建：2026-07-10 v1.0（earendil-works/pi 全仓探索 + Codex 清单交叉对比，结论存记忆
> `pi-repo-reference.md`）。
> **修订 v1.1（2026-07-10）**：Codex 二轮评审修正——v1.0 把 pi 自己掌控 agent loop 的能力
> 部分误当成 Claude Agent SDK 外层可直接复制的能力。本轮修正已逐条对照 SDK 类型
> （`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`）与现有代码核实，AR1/AR2/AR3/AR5
> 的实现假设全部重写，AR4/AR6/AR8 措辞收窄。
> **修订 v1.2（2026-07-29，已被 v1.3 取代）**：曾短暂采用“Pi 默认、Claude 可选”的
> 双运行时过渡方案；该方案未进入实施。
> **修订 v1.3（2026-07-29）**：v1.2 的双运行时过渡方案已被产品决策取代。最终目标是
> **Pi-only Agent Runtime**，彻底删除 Claude Agent SDK；Anthropic Messages 是首批 Provider
> 协议，不是 runtime。当前架构 SSOT 为 `design-pi-agent-runtime.md`，AR10 执行规格为
> `spike-pi-anthropic-replacement.md`。
> **修订 v1.4（2026-07-29）**：System Prompt、Skills 与工具精简纳入迁移总路径。采用
> “迁移前基线、迁移中结构等价、Pi 稳定后语义精简”的三段式方案，详见
> `design-agent-context-simplification.md`。
> 体例照 `ROADMAP-improve.md`；单个工作包开工时再写自包含的 `spec-<工作包名>.md`。

> **2026-07-21 优先级叠加说明**：复杂文件任务的真实失败样本将 AR2b、AR2c、AR4 从通用
> P1 路线图提升为产品可靠性交付的关键路径，但不改变本文件已经冻结的 AR2a 合同。拆分后的
> 入口为 `ROADMAP-complex-task-reliability.md`。其中：CR-R1 对齐 AR2b，CR-R2 对齐 AR2c +
> AR4；`run_settled.outcome` 继续保持 `completed|aborted|error`。两份路线图冲突时，事件合同
> 以本文件与 `audit-agent-event-contract.md` 为准，复杂任务的功能范围/批次以新路线图为准。

## 总判断

pi 探索验证了 finwork 的 agent 层三个已知薄弱点有配方可参照（重建回顾退化、压缩不可感知、
运行中不可插话），同时暴露一个结构性欠账：**后端 `AgentRunEvent`、前端 `AgentEvent`、SSE
外层帧是三套平行协议，且没有终态语义（done ≠ settled）与断线重放能力**。统一事件合同是
本总纲的地基工程。

2026-07-29 的最终产品决策是彻底移除 Claude Agent SDK。Pi 是唯一 Agent Runtime；用户现有
Anthropic Messages 兼容网关是第一阶段 Provider。迁移目标不是复刻 Claude SDK 内部轨迹，
而是保持 Finwork 的业务、事件、安全、交付与可观察性合同。

三条铁律贯穿全部工作包：

1. **事件、Run、工具与安全合同归 Finwork 所有**：公共类型不得泄漏 Pi SDK 消息形状；
   `AgentRuntimeEvent` 继续作为唯一实时边界。
2. **先 PoC、后冻结抽象**：AR10 用真实 Pi session、Provider、工具与打包行为校准边界，
   AR9 再冻结最小 Finwork Agent Service 和 runtime session 合同；禁止为假想的第二 runtime
   预先设计万能接口。
3. **Pi 拥有 agent loop**：Finwork 不重写第三套 loop；只在 `AgentSession` 外维护产品合同、
   工具、安全、资源、交付和可观察性。

## 已拍板/共识决策

| # | 决策 | 内容 |
|---|------|------|
| R1 | 事件合同 P0 | 后端/SSE/前端收敛为唯一共享合同 `AgentRuntimeEvent`，补 `run_settled` 终态与稳定 event cursor |
| R2 | 薄边界而非多 runtime 抽象 | AR10 PoC 在前，AR9 只冻结 Query Pipeline 真正需要的 Finwork Agent Service、session、usage/error 边界；不建 runtime factory |
| R3 | Claude 专属 compaction 包取消 | v1.1 对 Claude SDK 控制点的判断保留为历史证据；AR1a/AR1b 不再实施。Pi compaction 在 AR10/AR12 映射到公共事件与审计 |
| R4 | Pi-only | Pi 是唯一 runtime；不做 Claude fallback、不做 runtime 切换 UI。Anthropic Messages 是 Provider 协议 |
| R5 | 看板现状修正 | agent-team-board / task-board / dispatch-store 均已 ship；AR4 是补 runtime 层，不是重建 UI |
| R6 | 实时/持久分账（v1.1） | 实时事件通道与持久事件日志是两种账本：`partial` 快照只走实时通道；持久化走独立 `run_events` 表 + 周期 checkpoint + 终态事件，**不把每个完整 partial append 进 SQLite**（平方级膨胀）。运行事件日志与模型上下文会话树也是两种账本，不因都有 cursor 而合并设计（v1.0"append-only session 雏形顺手成立"的说法撤回） |
| R7 | 重放语义（v1.1) | 断线重放是 at-least-once delivery：`run_settled` 每 run 恰好一次指**日志里有唯一 canonical record**，客户端仍须按 eventId 去重。现有客户端是 `fetch POST` 读 SSE 而非 EventSource，`Last-Event-ID` 不会自动生效——cursor 由客户端显式带参 |
| R8 | Runtime 固定、Provider 可扩展 | runtime 固定为 Pi；Provider profile 与 model slot 独立。首批只做用户现有 Anthropic Messages 网关 |
| R9 | 工具归 Finwork | 现有 45 个生产注册财务工具不作为 Pi Extension 的业务实现，也不继续把 Claude MCP 注册形式当领域边界；抽中立工具定义，由 Pi `customTools` 薄适配 |
| R10 | Pi 包分层 | 产品入口使用 `@earendil-works/pi-coding-agent`；需要 Provider/凭证扩展时显式使用 `pi-ai`；初期不直接调用 `pi-agent-core` 的低层 loop |
| R11 | Claude 必须删除 | PoC 与 Pi 生产链路通过后删除 Claude SDK、CLI、adapter、settings/session 命名、transcript retention、专属测试与打包资源；不保留隐藏 fallback |
| R12 | 上下文精简分阶段 | System Prompt/Skills/工具与 Pi 迁移一起设计但不混改：AS0 先建基线，AS1 随迁移做结构中立化，AS2 在 Pi 主链稳定且 Claude 删除后做语义精简 |

## 工作包清单

状态取值：`未开始` → `spec已写` → `计划已批` → `实施中` → `已ship`（spike 型：`未开始` → `已验证/已否决`）。

### P0 —— 治确诊的病，直接价值

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| AR2a | 共享事件合同（实时层） | 唯一 `AgentRuntimeEvent` 类型 + 事件 envelope + `run_settled`，现有 Claude adapter 先实现。**本包不做持久重放**（那是 AR2b）。事件清单与 envelope 见下节 | 无 | **已ship**（`spec-agent-event-contract.md` v1.2 + `audit-agent-event-contract.md`；19 文件 +470/-340。计划审查 fix-first×2；实施审查 fix-first 一轮抓 3 阻塞——B1 子代理 run_ended 前端丢失/B2 eventId 跨 emitter 不单调/B3 tool_completed 落库 label=UUID 破坏分组——均修复后终审 ship。未提交，待用户决定 commit/PR） |
| AR3-spike | 工具安全闸可行性验证 | 见 `spike-tool-gate-findings.md` v2.0（静态+运行时 E2a/E2b/E3/E3b 均有定论，E1 截断未复现） | 无 | **已完成**。结论：①**AR3b-垫片立项**，挂点=MCP handler 内部（E2b 证明 zod 在 canUseTool 之后，挂 canUseTool 来不及）；②**AR3b-截断闸降级为观察项不立包**（高风险写工具都是带 zod 的 MCP 工具，zod 是天然兜底；E1 未证明 SDK 截断会执行工具；且 canUseTool 覆盖不到 allowedTools 内置工具——E3b）；③附带产出：`SDKAssistantMessage.error` 实时可见，供 AR2a 的 run_ended/settled outcome 用 |
| AR3b-垫片 | MCP 入参宽松化垫片 | MCP 工具 handler 入口对"应为 object/array 却收到 JSON 字符串"的参数先 parse 再交业务 | AR3-spike（已完成） | **已ship**（`coerce-json.ts` 的 `jsonCoercible` = zod `z.preprocess` 声明式包装；应用到 kingdee(16字段)/business-analysis(4)/business-metrics(1)/emit-checklist(1)；纯字符串小数组 profile/document-metadata 按判据排除。轻量路径主循环自查通过。`audit-ar3b-json-coerce.md`。未提交） |
| AR1a | Claude 失效 session 的结构化重建回顾 | Claude 专属，不再产生目标架构价值 | 无 | **取消（v1.3）** |
| AR1b | Claude SDK compaction 摘要审计 | Claude 专属；Pi compaction 由 AR10/AR12 验证和映射 | 无 | **取消（v1.3）** |

### P1 —— 铺路线图的砖

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| AR2b | run 事件持久化 + 重放 | 独立 `run_events` 表（不复用 `chat_agent_events`——其 `message_id` NOT NULL 且 assistant message 回合收尾才建行，实时事件无从挂靠）：终态事件 + 周期 checkpoint 落库，高频 delta 只走实时通道（R6）。GET replay 接口按 eventId 起点重放。cursor 用表自增 id，不另设 per-conversation seq | AR2a | **已ship**（CR-R1；见 `spec-run-events-persistence-replay.md` / audit） |
| AR2c | 断线恢复客户端 | 客户端显式带 cursor 重连（POST-SSE 无 EventSource 自动重发，R7）、按 eventId 去重、以 checkpoint + 后续事件重建现场 | AR2b | **核心已ship**（CR-R2）；显式 resume API / 重连订阅仍后续 |
| AR4 | run 状态机 + 可观察现场重建 | `subagent_dispatches` 台账之下补 run 级状态机（`starting→running→settled|error|interrupted`）与事件流打通、按 `instanceId` 订阅。**崩溃恢复措辞收窄（v1.1）**：恢复的是最后已持久化状态、已完成工具步骤、孤儿 run 标记 `interrupted/recoverable`、用户继续执行的入口——**不承诺**恢复执行中的 runtime query / Python 进程 / 未提交事务。目标是"重建可观察现场"，非"恢复执行现场" | AR2b | **核心已ship**（CR-R2）；可恢复入口仍后续 |
| AR5-spike → AR5 | steering 插话 | Claude spike 取消；AR10 验证 `AgentSession.steer/followUp` 的准确时点并映射 `queue_updated`。首期只定底层合同，不做 UI | AR2a、AR10 | Pi 验证纳入 AR10 |
| AR6 | 文件写串行化 | Write/Edit 型工具按规范化绝对路径排队（参照 pi file-mutation-queue）。**`run_python` 例外（v1.1）**：可写任意多文件、调用前不知 canonical path——对它用 conversation/outputDir 级粗锁，或在真实文件写边界（deliverable 落盘处）加锁，spec 时定 | 无 | 未开始 |
| AR7 | 仓库外打包 smoke test | Tauri/Next/skills 打包产物在仓库外环境安装冒烟（照 pi release:local 模式：build→pack→隔离安装→跑真命令）。非 pi 衍生项，是"Windows 运行时测试盲区"既有欠债，借本总纲登记 | 无 | 未开始 |

### Pi-only Runtime 替换 —— 产品决策已确认

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| AR8 | Pi Skill 资源目录 | 保留现有内置/用户 Skill SSOT；用 Pi `ResourceLoader` 做显式发现/白名单适配，禁止 ambient 用户目录渗入产品 session | AR10 | 未开始 |
| AR9 | Finwork Agent Service + session/settings 泛化 | 用 PoC 证据冻结最小请求/结果/session/usage/error 边界；泛化 `claude_session_id`、`ClaudeSettings`、`ModelUsage`，公共层禁止 SDK import | AR10 | 未开始 |
| AR10 | Pi + Anthropic Messages 替换 PoC | 按 `spike-pi-anthropic-replacement.md` 验证用户网关、session、事件、附件、Skill、代表工具、安全闸、取消/compaction、子代理、usage、打包和 Claude 零残留预演 | AS0 | **Spec 已写 / 等待 AS0** |
| AR11 | 中立财务工具目录 + Pi adapter | 抽 `FinanceToolDefinition`/执行上下文/规范化 tool id；Pi 生成 session-scoped `customTools`；验证 Zod→模型 schema 桥；从五个代表工具迁到 45 个 | AR10、AR9 | 未开始 |
| AR12 | Pi 生产接入 | 用 `AgentSession`、自定义 `ResourceLoader` 与内部 Finwork extension 接入统一事件、安全、会话、交付和子代理合同 | AR9、AR11、AR8 | 未开始 |
| AR13 | Claude SDK 删除 | 删除旧 adapter、SDK/MCP adapter、CLI 打包、Claude settings/session/config/retention、专属测试和错误文案；不保留 fallback | AR12 | 未开始 |
| AR14 | Pi-only 发布门 | 45 个生产注册工具、安全矩阵、session/compaction、复杂文件交付、三平台 packaged smoke、import/依赖/产物零 Claude 残留 | AR13 | 未开始 |

### Agent 上下文精简 —— 与迁移分账

| ID | 工作包 | 说明 | 依赖 | 状态 |
|----|--------|------|------|------|
| AS0 | 上下文基线与职责清单 | 按 `as0-agent-context-baseline.md` 的 20 个 Runtime 中立任务记录 prompt/Skill/tool 成本、选择准确性、安全与交付质量；逐项标记 keep/move/merge/delete/investigate | 无；AR10 真实 PoC 前须冻结 Claude Phase B 结果 | **Phase B harness ready / Claude runs pending** |
| AS1 | 结构中立化 | System Prompt 去 Claude boundary、Skill loader 换 Pi ResourceLoader、工具变 `FinanceToolDefinition`；保持语义与业务行为等价 | AS0、AR10；与 AR9/AR11/AR12 协同 | 未开始 |
| AS2 | Pi-native 语义精简 | 精简 core prompt、Skill 入口/reference、按角色/任务暴露工具子集，逐项评测工具合并/删除 | AR12、AR13、AS1 | 未开始 |
| AS3 | 精简发布门 | 形成 before/after 报告；业务质量、安全、交付不得下降，上下文成本/错误调用/无效 turns 至少一项改善 | AS2 | 未开始；并入 AR14 |

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

   **实现现状校准（AR2a 已 ship 后，以代码为准；2026-07-16）**：
   - **谁发射**：`app/api/agent/query/route.ts` 内 `settleRun(outcome)` 单一收口——先
     `run_ended`，再 `run_settled`；成功 / abort / error 三路径共用（见
     `tests/runtime-events.test.ts` S1–S5）。`settleRun` 之后仍发旧帧 `done` /
     `incomplete` / `error`；`title_updated` 在 settled **之后**异步发送（runId=null）。
   - **前端不把它当完成态开关**：`app/chat/chat-request.ts` 的 `dispatchSSEEvent` 对
     `run_settled`（及主对话 `run_ended`）**静默消耗**，不调 `onDone`/`onIncomplete`。
     UI 终态仍由**旧帧**驱动。`contractToLegacyEvents` 对 `run_settled` 返回 `[]`
     （不落库、不进时间线）。
   - **定位**：协议层 / 服务端 canonical 终态（为 AR2b 重放/观测预留）；**不是**当前
     聊天 UI 的 TurnStatus 来源。`spec-agent-event-contract.md` 里「chat-stream 完成态
     派生自 run_settled」是计划表述、**未按字面落地**——细节见
     `audit-agent-event-contract.md`「实现现状校准」。
2. **实时/持久分账（R6，AR2a spec 修正）**：delta 事件只带增量**不带 partial 快照**——
   SSE 场景下逐 delta 携带全量累积是 O(n²) 网络字节（pi 是进程内传递才无成本），且前端
   reducer 本就增量累积。快照挂在 `message_completed`/`tool_completed` 终态事件；重放
   场景的快照是 AR2b checkpoint 的职责。持久层只存终态事件 + 周期 checkpoint，绝不
   append 每个完整 partial。断线重建现场 = 最近 checkpoint + 其后事件重放。
3. **cursor**：`run_events` 表自增 id 即游标；客户端重连显式带参（POST-SSE 无
   `Last-Event-ID` 自动机制，R7）。
4. **`instanceId` 预留**：子代理事件复用同一合同，现在留成本为零；不留则批跑阶段返工协议。
5. **合同不泄漏 SDK 形状**：字段全部自有命名，Pi 的 session/tool/event 字段由 adapter
   映射，绝不透传。守住这条，未来扩 Provider 不需要改 Query Pipeline、SSE 或 UI。

## 依赖关系（关键路径）

```
AR2a 事件合同(实时) ──→ AR2b 持久化+重放 ──→ AR2c 断线客户端
                    │                  └──→ AR4 run状态机 ──→ 批跑（另立项）
                    └──→ AR5-spike ──→ AR5 steering
AR3-spike ──→ (若可行) AR3b 实施
AR1a / AR1b（已取消）；AR6 / AR7（无前置，按资源穿插）
AS0 上下文基线 ──→ AR10 Pi+Anthropic PoC ──→ AR9 Finwork边界 ──→ AR11 中立工具 ──→ AR12 Pi生产接入
                               └────────────→ AR8 Skill适配 ────┘
                         AR9 / AR11 / AR12 + AS1 结构中立化
AR12 ──→ AR13 Claude SDK删除 ──→ AS2 语义精简 ──→ AR14 / AS3 Pi-only发布门
```

## 批次计划（v1.1，照 Codex 建议序调整；开工时按当时资源微调）

- **第一批**：AR2a（共享事件合同+run_settled，暂不做持久重放）+ AR3-spike（SDK 控制点
  可行性验证，产出结论文档）。
- **第二批（历史计划）**：AR1a + AR1b 已取消，不再为待删除 SDK 增加能力。
- **第三批（已完成核心）**：AR2b 已由 CR-R1 ship；AR6、AR7 仍可穿插。
- **第四批（已完成核心）**：AR4 + AR2c 已由 CR-R2 ship 核心；显式 resume API / 重连订阅仍后续。
- **第五批**：Claude AR5-spike 取消；Pi steering 纳入 AR10。
- **Pi 替换准备批**：AS0 建立旧链路上下文/行为基线，不改 Agent 语义。
- **Pi 替换第 0 批**：AR10 PoC，只产证据与最小试验代码，不接生产 Query Pipeline。
- **Pi 替换第 1 批**：AR9 公共边界/session/settings 泛化；AR8 Skill 适配可并行。
- **Pi 替换第 2 批**：AR11 中立工具目录 + Pi adapter；先代表工具，后机械迁移全量；AS1
  只做结构中立化，不改变行为。
- **Pi 替换第 3 批**：AR12 Pi 生产接入与语义等价门。
- **Pi 替换第 4 批**：AR13 删除 Claude SDK → AS2 逐项语义精简 → AR14/AS3 发布门。

## 会话协议（断点续传）

1. 开工：读本文件 → 找到状态非"已ship"的最靠前工作包 → 写/读对应 `spec-<工作包名>.md`。
2. 流水线：scout 探索 → 主循环写 spec（自包含）→ reviewer 批计划（复杂任务）→ implementer
   实施（TDD，先红后绿）→ 写 audit → reviewer 审 diff → ship。spike 型工作包产出结论文档，
   不走完整流水线。
3. 收工：更新本文件状态表；关键取舍写持久记忆。
4. Pi 参照代码以当前锁定版本和官方仓库为准；历史 Claude SDK 控制点只用于解释旧实现，
   不再作为新增功能依据。
5. Pi-only 工作以 `design-pi-agent-runtime.md` 为架构 SSOT，以
   `spike-pi-anthropic-replacement.md` 为 AR10 执行合同；PoC 得到反证时先更新设计，再冻结
   公共边界，不以隐藏 Claude fallback 掩盖差异。
6. System Prompt、Skills 与工具精简以 `design-agent-context-simplification.md` 为 SSOT；
   Runtime 迁移 diff 与语义优化 diff 必须分开，均用 AS0 golden tasks 验证。

## 需要用户确认的口径（遇到时问，不编默认值）

- AR2b：`run_events` 新表走迁移链，编号遵守跨 worktree 迁移纪律（三查：main 链尾/各
  worktree 链尾/库实际版本）。
- AR5：steering UI 暂缓；AR10 只验证底层投递时点，若未来产品化再单独拍板。
- AR10：网关模型 id、认证方式和脱敏测试凭证在执行时提供；协议已确认为 Anthropic Messages。
- AR10：Pi 内置 read/bash/edit/write 是关闭还是保留并加闸，由安全实验结果决定。

## 不做清单（不设限也不做，防止反复纠结）

在 AR10 通过前破坏生产 Claude 路径；PoC 通过后继续保留 Claude fallback；开发 runtime
切换 UI；把财务业务 handler 写进 Pi Extension；在公共层散落 `@earendil-works/*` 类型；
把当前进程内工具强行保留为网络 MCP；未经 PoC 就断言 Zod `preprocess/refine` 能无损转换
为 Pi/TypeBox schema；为“未来可能换 runtime”重写第三套 agent loop；把每个完整 partial
快照 append 进 SQLite；把旧 Claude transcript 伪装成可无损恢复的 Pi session；在 Runtime
迁移 diff 中同时重写 prompt/Skills/工具行为；没有 golden task 证据就合并或删除能力。
