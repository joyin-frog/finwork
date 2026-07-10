# recap-and-compaction-audit（AR1a + AR1b）Spec

> 版本 v1.1 / 2026-07-10
> 状态：~~草案~~ → **已批准**（计划审查 fix-first：唯一阻塞 B1「SDK `query()` options 不支持
> 编程式 hooks」经主循环核实为 **reviewer 事实误判**——sdk.d.ts:1446 `Options.hooks?:
> Partial<Record<HookEvent, HookCallbackMatcher[]>>` 存在，:1433-1444 有编程式配置示例，
> AR1b 挂载点成立、无需解绑，已驳回；非阻塞 N1/N2 采纳，见下方「计划审查回应」）→ 已实施
> 依赖：`ROADMAP-agent-runtime.md`（AR1a/AR1b 定义、决策 R3；模型槽口径已拍板 = **mainModel**）；
> 本 spec 基于 AR2a 已 ship 后的 claude-adapter 现状（emit 单回调、runtime-events 合同已在）。
> 架构事实（写给全新上下文实现者，均已读到行）：
> - **重建回顾触发面（关键，决定 AR1a 价值边界）**：`lib/agent/claude-adapter.ts` 的
>   `pickPromptMessages`(:104-114) 明确——**resume 且未重试只发最后一条 user 消息**（靠 SDK
>   transcript 续接，`messages.length==1`）；**重试或非 resume 才发全量历史**。`buildPromptInput`
>   (:611) 仅在 `messages.length>1`（或有附件）时进 `yieldMessages`(:623)。所以对话回顾**只在
>   stale session 重试**（`queryWithRetry` 捕获 session 失效后 `pickPromptMessages(...,{retried:true})`
>   返回全量，:347 附近）**或非 resume 多轮**时触发，正常续聊不走。AR1a 只改这条重建路径。
> - **现状压平**：`yieldMessages`(:631-637) 把 `messages.slice(0,-1)` 逐行 `用户:x\n助手:y`
>   拼成 `<对话回顾>…</对话回顾>` + 当前请求，作为单条 user 消息。`yieldMessages` 是
>   `async function*`（可 await），失败无降级——但本就是纯字符串拼接不会失败。
> - **messages 是纯文本**：`AgentMessage` 只有 `role`(user/assistant)+`content`(string)，来自
>   DB `chat_messages`。**没有结构化的工具调用/读写文件记录**（那些在 `chat_agent_events`，
>   不传进 runClaudeAgent）。→ 摘要的"文件清单"无结构化来源，只能让 LLM 从对话文本尽力提及。
> - **可复用的单次 LLM 模式**：`lib/agent/conversation-title.ts:40-99` `generateConversationTitle`
>   —— `fetch(buildMessagesUrl(settings.apiUrl))` 打 `/v1/messages`，`x-api-key` 头、
>   `AbortSignal.timeout`、`SKIP_LLM` 守卫、apiKey 空返回 null、非 2xx/异常返回 null。
>   `buildMessagesUrl` 在 `lib/agent/router.ts:239`。AR1a 抄此模式，换 `model=settings.mainModel`、
>   `max_tokens≈600`、结构化摘要 prompt。
> - **compaction 现状**：`compact_boundary` 系统消息在 claude-adapter.ts:430-441 处理，写一条
>   `spanType:"compact"` span，字段只有 `inputSummary:"pre=N"`/`outputSummary:"post=N"`/`tokens`。
>   **compact_metadata 只有 pre_tokens/post_tokens/trigger/duration_ms，无 summary 文本**。
>   `sdk.query` 的 `options`(:270-311) **没有 hooks 字段**（canUseTool 是唯一 hook 挂点）。
>   → 要拿 compaction 摘要文本，必须首次引入 SDK 原生 `PostCompact` hook（其 input 带
>   `compact_summary`，见 spike-tool-gate-findings 引 sdk.d.ts:2086）。
> - **span 落库**：`lib/observability/spans.ts:20` `writeSpan(SpanInput)`；`inputSummary`/
>   `outputSummary` 截 200 字符 + PII redact，但 **`metadata`（→metadata_json）JSON.stringify
>   不截断**(:37)。→ compaction 摘要全文适合放 `metadata:{compactSummary}`，不放 summary 字段。
> - 测试栈：`npm test`=`node --import tsx tests/all.test.ts`（聚合，新文件须接入）；跑绿姿势
>   `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true`；无 DOM 栈；LLM 调用测试走 SKIP_LLM 降级路径。

## 计划审查回应（v1.0→v1.1）

- **B1（阻塞，已驳回）**：reviewer 称"SDK Options 无 hooks 字段，AR1b 挂载点跑不通"。核实
  sdk.d.ts：`Options`(:1247) 内 :1446 有 `hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>`，
  :1433-1444 注释含编程式示例 `hooks:{ PreToolUse:[{ hooks:[async(input)=>…] }] }`；
  `HookCallbackMatcher = { hooks: HookCallback[]; timeout? }`(:770-771)；`HOOK_EVENTS` 含
  `"PostCompact"`，`PostCompactHookInput` 含 `compact_summary`(:2086)。→ 编程式 hooks 完全支持，
  AR1b 不解绑、不降级。
- **N1（采纳）**：`buildPromptInput` 仅一个调用方（claude-adapter.ts:314），settings 透传只改
  `buildPromptInput`+`yieldMessages` 两签名，不溢出 Files touched。且 settings 已在
  `runClaudeAgent`(:118) 读取，**直接透传，recap-summary.ts 内不再二次 readClaudeSettings**。
- **N2（采纳）**：`fallbackFlatRecap` **只负责 recap 文本段**生成；`yieldMessages` 的 attachment
  分支（现 :648-658 的 content 数组结构）**留在 yieldMessages 内不动**，不搬进 recap-summary.ts，
  避免结构漂移。逐字等价的快照只锁 recap 文本段。

## 实施审查回应（第二轮，v1.1→实施后）

- **B1（阻塞，已核实驳回）**：reviewer 称"带附件的 stale 重建会丢附件或重复当前请求"。主循环
  核实 `yieldMessages`(claude-adapter.ts:643-664)：`text = await buildStructuredRecap(...)`，
  结构化分支(recap-summary.ts:176-179)与 `fallbackFlatRecap`(:56) **均含 lastPromptText 恰好
  一次**；attachment 分支(:658-661) 拼的是 `attachmentBlocks`（附件块）**不是** lastPromptText，
  与改造前结构逐字一致 → 不丢附件、不重复请求。B1 不成立。**但采纳其"该路径无测试覆盖"**：补一个
  带附件的 stale 重建测试用例锁死此不变量（测试绿即坐实驳回）。
- **N1（已满足）**：`summarizeHistory` 的 fetch 已设 `AbortSignal.timeout(15_000)`(:110)，catch
  返回 null → 降级。无需改。
- **N2（待办，非阻塞）**：`createPostCompactHookCallback` 现放 `recap-summary.ts`，命名语义偏
  （该文件语义是"重建回顾"）。**留作后续小重构**：挪到 `lib/agent/compaction-audit.ts`。不阻塞
  本期 ship（纯位置/命名，行为无关）。

## 0. 目标与非目标

**目标**：
- **AR1a**：把 stale 重建时的 `<对话回顾>` 从"全量逐行压平"升级为"**较早历史→一次 mainModel
  结构化摘要**（Goal/Progress/Key Decisions/Next Steps）**+ 保留最近 K 条消息原文**"。摘要失败/
  无 key/SKIP_LLM 一律**优雅降级回现状全量压平**（增强而非替换，绝不因摘要失败破坏重建）。
- **AR1b**：接 SDK `PostCompact` hook，把 `compact_summary` 落进审计（`agent_spans` 的
  `metadata_json`），让 SDK 侧压缩从"只知 token 数不知内容"变为可追溯。

**非目标（本期不做，已知并接受）**：
- ❌ 接管/替换 SDK 的 compaction 算法（控制点不存在，只有 PostCompact 捕获——ROADMAP R3）。
- ❌ 改正常续聊路径（resume 未重试发单条，不受影响）。
- ❌ 结构化"读写文件清单"（messages 无此数据源；摘要 prompt 让 LLM 从文本尽力提及，不建表、
  不接 chat_agent_events）。
- ❌ 持久化 run 事件 / AR2b 相关。
- ❌ 给摘要生成加缓存/复用（stale 重试低频，一次性生成即可）。

## 1. 成功标准

- [ ] **AR1a 分段正确**：history（messages.slice(0,-1)）长度 ≤ `RECENT_KEEP`(默认 8) 时**不调
  LLM**、行为等同现状全量压平；> 阈值时，最近 `RECENT_KEEP` 条保留逐行原文、更早的进摘要段，
  最终文本形如 `<历史摘要>…</历史摘要>\n<最近对话>…逐行…</最近对话>\n\n当前请求:\n{last}`。
  验证：纯函数测试对不同长度 history 断言分段边界与产出结构。
- [ ] **AR1a 降级**：SKIP_LLM=1 / apiKey 空 / fetch 异常 / 非 2xx / 摘要空 → **回退到现状全量
  逐行压平**（`<对话回顾>` 原格式），重建不中断。验证：SKIP_LLM 下跑重建，断言产出 == 现状压平
  格式（与改造前 yieldMessages 输出一致的快照）。
- [ ] **AR1a 摘要 prompt**：用 `settings.mainModel`、结构化四段 prompt、max_tokens≈600、超时守卫。
  验证：源码契约断言（读取 model 字段取 mainModel、prompt 含四段关键词、有 timeout）。
- [ ] **AR1b hook 落库**：PostCompact hook 触发时 writeSpan 一条含 `metadata.compactSummary`
  （全文，不截断）的 compact span，trigger/summary 都在。验证：直接调 hook 回调（构造
  PostCompactHookInput），断言 writeSpan 被调且 metadata.compactSummary === 输入 summary。
- [ ] **AR1b 不破坏现状**：原 compact_boundary span（pre/post tokens）保留不变；hook 是**新增**
  一条 summary span，不改原 span。验证：compact_boundary 处理逻辑 diff 为空或仅并列新增。
- [ ] 全量绿：`FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test`（含 typecheck 门禁）。

## 2. Files touched

| 文件 | 动作 | 改什么 |
|---|---|---|
| `lib/agent/recap-summary.ts` | 新增 | ①`buildStructuredRecap(history, lastPromptText, settings)`：分段（近 K 原文 + 更早摘要）并拼装最终文本；②`summarizeHistory(olderMessages, settings)`：抄 conversation-title 的 fetch 模式，mainModel + 四段 prompt + timeout，失败返回 null；③`fallbackFlatRecap(history, lastPromptText)`：现状逐行压平（供降级与 ≤阈值路径复用，与现 yieldMessages 输出逐字一致）|
| `tests/recap-summary.test.ts` | 新增 | 分段边界、降级等价（SKIP_LLM→fallback）、prompt 契约 |
| `lib/agent/claude-adapter.ts` | 修改 | ①`yieldMessages` 改为 await `buildStructuredRecap`（SKIP_LLM/失败内部已降级），文本组装从内联移到 recap-summary；②`options`(:270) 加 `hooks:{ PostCompact:[…] }`，回调 writeSpan 落 compactSummary；保留 canUseTool 不变 |
| `tests/recap-summary.test.ts` 之外 | — | compact_boundary 原 span 逻辑（:430-441）**不动** |
| `tests/all.test.ts` | 修改 | 接入 recap-summary 测试 |

> 注：`lib/observability/spans.ts` 不改（metadata 已支持任意 JSON）。若 PostCompact hook 的落库
> 想复用现有 compact span 形状，直接调 `writeSpan`。

## 3. 实施步骤

1. 新建 `lib/agent/recap-summary.ts`：
   - `fallbackFlatRecap(history, lastPromptText)`：**逐字复制**现 yieldMessages 的 recap 拼接
     （:631-637），保证降级输出与改造前一致（用快照测试锁）。
   - `summarizeHistory(older, settings)`：抄 conversation-title.ts:40-99 结构，`model =
     settings.mainModel || settings.model`，`max_tokens: 600`，system=“你是财务对话摘要器，
     只输出结构化摘要”，user prompt 要求输出四段：`## 目标 / ## 进展 / ## 关键决策 /
     ## 下一步`，并"若对话中提到具体文件/单据/报表名，在进展里带上"。SKIP_LLM/无 key/非 2xx/
     异常/空 → 返回 null。
   - `buildStructuredRecap(history, lastPromptText, settings)`：`RECENT_KEEP=8`。
     若 `history.length <= RECENT_KEEP` → 直接 `fallbackFlatRecap`（不调 LLM）。
     否则 `older = history.slice(0, -RECENT_KEEP)`, `recent = history.slice(-RECENT_KEEP)`；
     `summary = await summarizeHistory(older, settings)`；summary 为 null → `fallbackFlatRecap`
     （整段降级）；否则拼 `<历史摘要>\n${summary}\n</历史摘要>\n<最近对话>\n${recent 逐行}\n
     </最近对话>\n\n当前请求:\n${lastPromptText}`。
2. 写 `tests/recap-summary.test.ts`（TDD 先红）：短 history→fallback；长 history + SKIP_LLM→
   整段 fallback；长 history + mock 摘要成功→结构化产出；prompt 契约（mainModel、四段词、timeout）。
3. 改 `claude-adapter.ts` `yieldMessages`：把 recap 文本组装换成 `await buildStructuredRecap(
   history, lastPromptText, settings)`（settings 已在 runClaudeAgent 作用域，:118；确认能传进
   yieldMessages——若作用域不通，把 settings 作参数透传）。attachmentBlocks 分支逻辑不变（文本换
   成结构化结果）。
4. 改 `options`(:270) 加 `hooks` 字段（sdk.d.ts:1446 确认 `Options.hooks?: Partial<Record<
   HookEvent, HookCallbackMatcher[]>>` 存在）。形状照 `HookCallbackMatcher = { hooks: HookCallback[];
   timeout? }`(:770-771) 与 :1433-1444 示例：
   ```
   hooks: { PostCompact: [{ hooks: [async (input) => {
     const i = input as { compact_summary?: string; trigger?: string };
     writeSpan({ traceId: requestId, spanType: "compact",
       name: `compact:summary:${i.trigger ?? "?"}`, startedAt: Date.now(), durationMs: 0,
       metadata: { compactSummary: i.compact_summary, trigger: i.trigger } });
     return { continue: true };
   }] }] }
   ```
   `PostCompactHookInput` 含 `compact_summary`(sdk.d.ts:2086)。回调返回值形状以 sdk.d.ts 的
   HookCallback 返回类型为准（`{ continue: true }` 或等价）。**canUseTool 与其余 options 不动**；
   compact_boundary 消息处的原 span（:430-441，pre/post tokens）也不动——本 hook 是并列新增。
5. 接入 tests/all.test.ts，跑绿。

## 4. 测试与验证方式

```bash
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test -- recap-summary   # 本任务
FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test                    # 全量含 typecheck
# typecheck 单独(过滤本机 src-tauri 构建产物噪声,与本任务无关):
npx tsc -p tsconfig.typecheck.json 2>&1 | grep -v "src-tauri/"       # 应无输出
```

- 需要新增测试：分段边界（≤阈值/>阈值）、降级等价（SKIP_LLM→fallback 快照 == 现状格式）、
  摘要 prompt 契约、PostCompact hook writeSpan 落 compactSummary。
- 不需要：真实 LLM 摘要质量（无 key 环境测不了；测降级与分段逻辑即可）；e2e。

## 5. 风险与开放问题

- **摘要在重建热路径上加一次 LLM 往返**：仅 stale 重试触发（低频），但会给该次重建加延迟。缓解：
  timeout（建议 ≤15s）+ 失败降级，超时即回退全量压平，不阻塞。reviewer 重点看降级路径。
- **settings 传参**：yieldMessages 当前不接 settings；确认 runClaudeAgent 作用域的 settings 能否
  透传进 buildPromptInput→yieldMessages（可能要给这两个函数加 settings 参数）。这是唯一可能溢出
  Files touched 之外的点——若 buildPromptInput 有其他调用方，需一并适配（implementer 发现即报告）。
- **PostCompact hook 配置形状**：finwork 首次用 SDK 原生 hooks，配置结构以 node_modules 的
  sdk.d.ts 为准（HookEvent 数组 + matcher？），别照抄本 spec 的伪代码形状——先读类型。
- **降级必须逐字等于现状**：fallbackFlatRecap 若与旧 yieldMessages 输出有一字节差异，会悄悄改变
  所有 stale 重建的 prompt。用快照测试对着旧输出锁死。
- **被否决的备选**：①每轮都摘要（正常续聊不走此路，无意义且加成本）；②摘要落新表（span 已够，
  不建表）；③读 chat_agent_events 拿文件清单（跨数据源、超范围，messages 纯文本足够）。
