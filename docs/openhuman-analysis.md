# OpenHuman 深度架构剖析 —— 一个本地优先 Agent 操作系统是怎么搭起来的

> 研究对象：`openhuman`（`tinyhumansai/openhuman`，GNU 协议）。Tauri v2 + Vite/React 19 + Rust 核心（`openhuman_core`，130+ 域，约 40K 行仅 harness）+ pnpm monorepo。
> 这一版**不按提示词的四模块清单走**，而是按「这套系统真正强在哪」重组：先讲让它不塌的工程地基，再逐个拆它最硬核的子系统（上下文工程、确定性记忆、统一推理层、多智能体、流式、安全纵深、主动与具身能力），最后才落到 Finance Agent 能偷什么。
> 性质：只读研究，未改动 OpenHuman 任何文件。讲架构 / 设计 / 取舍，配关键文件路径与文字版流程图，不贴实现代码。
> 取材：通读了 `gitbooks/developing/architecture/*`、`docs/agent-subagent-tool-flow.md`，以及 20+ 个域的 `README.md`（这些 README 本身就是高密度架构契约）与核心源文件。

---

## TL;DR —— 它到底强在哪

OpenHuman 不是"一个聊天 app 加了几个工具"。它是**一个跑在桌面里的本地 Agent 操作系统**，真正的护城河有四条，且都不在"功能列表"里，而在**架构纪律**里：

1. **上下文工程被当成一等学科**。不是"塞满就截断"，而是一条四级 reduction 管线 + 内容感知压缩（TokenJuice）+ 可逆缓存（CCR）+ summarizer 绕道 + KV-cache 字节不变量，每一层都有电路断路器和"失败不留半残状态"的保证。**这是整个系统最值钱的部分。**
2. **记忆是确定性管线，不是向量库的壳**。Markdown 是真相源（内容寻址、写后不可变），SQLite 只是索引；bucket-seal 级联把明细滚成分层摘要；leaf 走状态机；外加一个**环境人格缓存**（learning 域：带半衰期的稳定性评分），实现"几分钟就懂你"。
3. **一个引擎，N 个入口**。整个 ReAct 循环只有一份（`run_turn_engine`），聊天 / 子 Agent / 事件总线 / triage / 会议机器人全驱动同一个引擎，差异通过 5 个 trait seam 注入——所以行为永不漂移。
4. **安全是纵深的，不是一道 prompt**。OS 级沙箱矩阵 + 子进程目录牢笼 + 确定性反注入（带混淆归一化）+ 追加式审计 + 自治分级 + 配对守卫，层层独立。

下面逐层拆。

---

## 一、让这套东西不塌的工程地基

在看任何子系统前，先看它的"宪法"——这些纪律是 130+ 个域不互相绞死的原因。

### 1.1 Canonical module shape（每个域长一个样）

AGENTS.md 里定义了一个**强制的模块骨架**，几乎每个域都遵守：

| 文件 | 角色 |
|---|---|
| `mod.rs` | 只做 `pub mod` 声明 + `pub use` 再导出，**零逻辑** |
| `types.rs` | serde DTO，纯类型 |
| `ops.rs` | 业务逻辑，返回 `RpcOutcome<T>` |
| `schemas.rs` | RPC 控制器 schema + `handle_*` 函数，`delegate` 到 ops |
| `store.rs` | 持久化（有就有，没有 README 明说"无") |
| `bus.rs` | 事件总线订阅（同上） |
| `tools.rs` | Agent 工具实现（同上） |
| `README.md` | **架构契约**：Public surface / Calls into / Called by / Persistence / Events / Gotchas |

这带来一个惊人的效果：**每个域的 README 都能当架构文档读**，而且它们显式列出 "Calls into / Called by"，等于把整张依赖图写进了文档。我这次能在有限时间里摸清 20 多个域，就是靠这套纪律。

### 1.2 类型化事件总线（`src/core/event_bus/`）

跨域解耦靠一个**类型化的 `DomainEvent` 总线**（publish/subscribe），不是字符串事件。例子：

- `learning` 发 `CacheRebuilt`，`ProfileMdRenderer` 订阅它重渲 `PROFILE.md`。
- `composio` 发 `ComposioConnectionCreated / Deleted / ActionExecuted`，`socket::event_handlers` 把后端 `composio:trigger` 解析成 `ComposioTriggerReceived` 再发总线。
- `inference` 在 auth 失败时发 `SessionExpired`，credentials 层订阅去刷新会话。

订阅者要自己 hold 住 `SubscriptionHandle`（放 static），否则订阅被 drop。这是一个**显式生命周期**的设计，不靠隐式全局。

### 1.3 结构化错误，不靠字符串匹配（`threads/error.rs` 是范本）

`ThreadsError::NotFound` 在控制器边界编码成 `StructuredRpcError { kind: "ThreadNotFound", expected_user_state: true }`——前端按 `kind` 判断"线程过期"，**不 sniff 方法名、不 grep 错误串、不进 Sentry**。而且它只在"解析出的 id 等于请求 id"时才升级为 NotFound，避免清错线程。这种"把可预期的用户态错误和真 bug 在类型层分开"的纪律，贯穿全仓（`inference/ops.rs` 把 401/429/model-not-found 降级到 `warn!` 不进 Sentry，只有未分类失败才 `error!`）。

### 1.4 文档即代码，且有 CI 兜底

`scripts/generate-architecture-docs.mjs` 从 `App.tsx` 抽 provider chain 生成文档表格（`<!-- BEGIN GENERATED -->` marker），`pnpm docs:check` 是 merge gate。架构文档不会腐烂，因为腐烂会让 CI 红。

> **对 Finance 的第一课**：这套"模块骨架 + README 即契约 + 依赖图写进文档 + 文档 CI"的纪律，是你 130 个域不绞死的前提。你现在 `lib/agent/` 还小，正是立这套规矩的时候。

---

## 二、Harness：一个引擎，N 个入口

### 2.1 seam 架构（最该学的结构）

整个 ReAct 循环只存在于 `engine::run_turn_engine`（[`src/openhuman/agent/harness/engine/core.rs`](openhuman/src/openhuman/agent/harness/engine/core.rs)）。五个调用方共用它：`Agent::turn`（桌面聊天）、`run_tool_call_loop`（`agent.run_turn` 事件总线）、`run_subagent`（子 Agent）、triage、meet_agent。**变化点全部藏在 5 个 trait 后面**：

```
                       ┌─────────────────────────────┐
   ToolSource ─────────┤                             │
   ProgressReporter ───┤   run_turn_engine           │  ← 唯一一份循环
   TurnObserver ───────┤   (announce → guard →       │
   CheckpointStrategy ─┤    stop-hook → provider →    │
   ResponseParser ─────┤    parse → exec → loop)      │
                       └─────────────────────────────┘
   inline（永不进 seam，保证不漂移）:
     stop-hook · context guard · token-budget 裁剪 · native/text 解析 ·
     重复失败断路器 · ProviderDelta→AgentProgress 流式转发
```

| Seam | 注入什么 | 父 vs 子的差异 |
|---|---|---|
| `ToolSource` | 工具广告 + 执行 | 父全量；子按定义过滤 |
| `ProgressReporter` | 事件"味道" | 顶层 `Turn*` + 流式 delta；子 `Subagent*` 嵌套不流式 |
| `TurnObserver` | 上下文管理 / 转录 / 历史形状 | 父走 `ContextManager`；子走 `EngineAutocompact` |
| `CheckpointStrategy` | 命中迭代上限的处理 | 父报错；子总结 |
| `ResponseParser` | 工具方言 | Native / XML / P-Format |

**为什么这是好设计**：循环是最容易长出 bug、最难测试的地方。把它压成一份、把差异外提到 seam，意味着断路器、流式转发、单工具执行器只写一遍、测一遍，三个入口都享受到，且永不分叉。

### 2.2 重复失败断路器（分级阈值，比"迭代上限"聪明得多）

[`harness/tool_loop.rs`](openhuman/src/openhuman/agent/harness/tool_loop.rs) 里一组阈值常量，专治"Agent 把同一个死路磨到上限再返回一个不带原因的 `MaxIterationsExceeded`"：

| 失败类型 | 阈值 | 设计意图 |
|---|---|---|
| 同 `(tool,args)` 确定性失败 | 3 | 逐字重复已知失败 → 停 |
| 可恢复（超时/限流/连接重置） | 8 | 给模型空间调参再试 |
| 无进展（变参但全失败） | 6 | 在打转 → 停 |
| **硬策略拒绝**（安全 block / gate deny） | **第 2 次** | 确定不可能成功；第一次放过让模型读"别重试"原因后转向 |

bail 时带 **root-cause 摘要**，而不是不透明的"超上限"。这是把"agent 卡死"从玄学变成可诊断。

### 2.3 多智能体编排（tier + depth + 可复用会话 + fork）

**三层 tier 模型**（`agent_tier` 字段，loader 静态校验 + 运行期 depth 守卫）：

```
Chat（快，UX 导向，如 orchestrator）
  ├─► Worker（叶子，干活）          chat 不能 spawn chat（无意义，纯烧 token）
  └─► Reasoning（慢，深思，如 planner）  reasoning 不能 spawn reasoning（防深度爆炸）
        └─► Worker                   worker 不能 spawn 任何东西（叶子，父只看一个压缩结果）
```

两层强制：`agents::loader::validate_tier_hierarchy` 在启动时拒绝同 tier 或 worker-带-subagents 的注册表；运行期 `MAX_SPAWN_DEPTH = 3` 用 task-local 计数器兜底（防用户 TOML 漏标 tier 还能递归）。

**可复用的耐久子 Agent 会话**（`agent_orchestration/subagent_sessions/`）：`spawn_subagent` 默认是**耐久 + 异步**的。它用 (父会话/线程 + agent_id + toolkit + model + sandbox + 归一化任务 key) 算一个**确定性兼容选择器**，spawn 前先查：兼容 worker 在跑 → 指令注进它的 `RunQueue`；idle/paused 有可复用历史 → 用 `initial_history` 起新 transient run；不兼容/已关 → 建新耐久会话。配套 `wait_subagent` / `steer_subagent` / `list_subagents` / `close_subagent`，是 Codex 风格的多 Agent 控制面。

**fork 模式（KV-cache 复用的精妙处）**：typed 子 Agent 是"窄 prompt + 过滤工具"；fork 子 Agent 则**逐字重放父的 rendered prompt + 消息前缀 + 工具 schema 快照**，只追加新任务——目的不是更强隔离，而是**共享父在推理后端的 KV-cache 前缀**，实测更便宜。这是把"提示词缓存"当成架构资源来经营。

**ParentExecutionContext task-local**：父 turn 开始前把 (provider / 工具 / 模型 / 内存句柄 / 已加载记忆上下文 / 连接的集成 / composio client / tool_call 格式 / 会话血缘) 快照进一个 task-local，子 Agent 靠 `current_parent()` 读它——避免把这十几个参数塞进每个函数签名。同一模式还承载 sandbox 模式、中断 fence、stop-hook 列表。

**toolkit action 排序（纯 CPU 启发式）**：GitHub 这种 toolkit 有 500+ action，全装进子 Agent 会撑爆 prompt。`harness/tool_filter.rs` 用动词检测 + token 重叠 + 动词对齐加分，**无模型调用**地把任务 prompt 对 action 排序，只装 top-K。快、可解释。

---

## 三、上下文工程 —— 这套系统最硬核的部分

如果只能学一样东西，学这个。OpenHuman 把"给模型塞什么、怎么不撑爆、怎么省钱、怎么不丢信息"做成了一个有层次、有不变量、有断路器的工程学科。

### 3.1 四级 reduction 管线（`context/` 域）

`ContextManager`（每会话一个）背后是一条**有序 reduction 链**，`ContextGuard` 决定哪一级触发：

```
Stage 1  tool-result budget   每个工具结果进 history 前，UTF-8 安全地按字节上限（默认 16 KiB）截断 + marker
                              （在 execute_tool_call 内联，不是管线阶段）
Stage 2  hard trim            丢最旧的非系统消息（Agent::trim_history）
Stage 3  microcompact         清空较旧 ToolResults 的 body（保留最近 N 个），
                              ★ 保持 AssistantToolCalls ⇔ ToolResults 的 API 配对不变量 ★ 幂等
Stage 4  autocompact          history 逼近窗口 → LLM 把头部历史压成一条 system 摘要，保留 keep_recent 尾巴
                              ★ snap_split_forward 永不切断 tool-call 对 ★
Stage 5  session memory       够阈值时触发后台 archivist 抽取到持久 MEMORY.md（不改在途历史）
```

精妙的地方在**细节里的纪律**：

- **管线本身不发任何 LLM 调用**。`ContextPipeline::run_before_call` 只*信号* `AutocompactionRequested`；实际 summarization 由 `ContextManager::reduce_before_call` 派发——所以管线可以脱离 provider 完整单测。
- **KV-cache 契约**：microcompact/autocompact **故意改写已发送的历史**（打破 KV-cache 前缀），但**只在 guard 说窗口会爆时才跑**，每次触发把新的更小前缀确立为下一个缓存目标。
- **3-strike 电路断路器**：连续 3 次 summarizer 失败 → 跳闸（`compaction_disabled`）；跳闸后越过 0.95 硬线，guard 返回 `ContextExhausted`，turn 该中止。任何成功 reduction 重置断路器。
- **失败不留半残状态**：`ProviderSummarizer` 和 `SegmentRecapSummarizer` 要么完整重写头部、要么完全不动——所以断路器可以安全地把失败当"什么都没发生"。
- **session memory 三阈值齐过才抽取**（token 增长 + 工具调用数 + 轮次），且无抽取在途。`Arc` 克隆句柄让后台任务在同步借用释放后翻完成状态。

### 3.2 TokenJuice —— 内容感知压缩 + 可逆缓存

工具结果进 history **之前**（在字节预算 backstop 之前），过 TokenJuice 内容路由器（`src/openhuman/tokenjuice/`，约 11K 行）。这其实是**两套东西叠在一起**：

**(A) 规则引擎（命令/日志压缩，96 条 vendored 规则）**。这是它的起源——`vincentkoc/tokenjuice` 的 Rust 移植。三层 overlay（builtin → user `~/.config/tokenjuice/rules/` → project `.tokenjuice/rules/`），id-keyed 合并，启动时预编译所有正则。规则用 JSON 描述 match 条件 + 转换（strip-ANSI / dedupe / head-tail / 计数器 / onEmpty 罐头消息），加一条无需重编译。`git/status` 和 `cloud/gh` 还带硬编码后处理器（porcelain 改写成 `M:/A:/D:`）。**pass-through 安全**：<512 字节或压缩比 >0.95 原样返回，调用方永远不用守护，数据永不静默丢失。

**(B) 内容感知路由器 + 专用压缩器**（更新的一层）：

```
检测 kind（hint > MIME > 按工具名先验 > 结构启发式，热路径无正则）
  JSON   → SmartCrusher：对象数组→表格(每 key 一次)，>40 行保 head+tail+出错行+数值离群行
  Code   → tree-sitter 保签名折叠函数体，保 TODO/FIXME/panic/unsafe；无 tree-sitter 时 brace-depth 兜底
  Log    → 命令输出走规则引擎；其它日志保 error/warn/stack/summary
  Search → grep 命中按 query 词密度分组，每文件保 top-K + "[+N more]"
  Diff   → 保改动 hunk 折叠 unchanged，lockfile 压成一行 +A/-B
  Html   → 剥标签到可读文本（无 DOM，分配友好）
  Text   → 可选 ML(ModernBERT) token salience，或放行
```

**CCR（Compress-Cache-Retrieve）—— lossy 但可逆**：lossy 且 ≥500 token 时，原文进 CCR store（SHA-256 keyed，内存 256 条/64MiB + 可选磁盘 `<workspace>/.tokenjuice/ccr/`），压缩输出尾部留 `⟦tj:<hash>⟧` marker。Agent 需要时调只读工具 `tokenjuice_retrieve(token, range?)` 把原文/切片"放大"回来。**压缩对模型透明地变成无损**：默认看便宜的压缩视图，真要细节时按需 zoom。

**按 agent 调压缩强度**：`tokenjuice_compression = "auto"|"full"|"light"|"off"`。`auto` 把 coding agent（`[model] hint="coding"`）解析成 `light`——关掉 CCR lossy 压缩，让 coding agent 拿到原始 build/test/diff 文本，除非压缩真无损。

**省钱可计量**：`savings.rs` 记 token 省了多少、估算省了多少美元，按 model 和 compressor 归因，持久化到 `<workspace>/state/tokenjuice_savings.json`。README 原话：通过前沿模型摄入六个月邮件，从几百美元降到个位数美元。

### 3.3 token budget 的两个细节（`token_budget.rs`）

- **图片 marker 定价**：附件以 `[IMAGE:<base64>]` marker 进消息串，8MiB 图 ≈ 1100 万字符，按 len/4 估算成 270 万 token 会让裁剪器在图片被提取成 `image_url` 之前就把整条消息逐出。所以图片按**固定 1200 token** 计价（而非 base64 当文本）。
- **本地模型上下文窗口**：本地 provider（LM Studio）报的是*运行时加载的*窗口，可能远小于训练上限。裁剪按 effective 窗口，且对本地模型的"un-evictable 前缀溢出"硬中止用的是*真实加载窗口*而非保守猜测，避免误拒一个真窗口能接的请求。

### 3.4 oversized 结果的 summarizer 绕道

超过阈值的工具结果（200KB Composio JSON、50KB 网页）走专用 `summarizer` 子 Agent，按"保留标识符 + 关键事实"的抽取契约压缩，父只看摘要。硬截断仍是 backstop（summarizer 失败或体量大到不值得为它付一次 LLM 调用时）。配 **circuit-breaker**：一个会话连续 3 次 summarizer 失败就禁用 summarization，回退截断。

---

## 四、记忆：确定性管线 vs 向量库

OpenHuman 对"记忆"的立场很坚定：**Memory Tree 不是带 memory 壳的向量库，是确定性 bucket-seal 管线**。它要回答的不止"和 query 相似的是什么"，还有"今天发生了啥 / 这人最新动态 / 上周二 3 点那个 webhook 说了啥"。

### 4.1 存储分层：Markdown 是真相，SQLite 是索引（`memory_store/`）

```
content/   .md 文件 —— 每个 body 的真相源（原子写，写后不可变，只 YAML front-matter 可改）
chunks/    SQLite 行：metadata + tags + .md 路径指针 + 生命周期状态 + content_sha256
entities/  mem_tree_entity_index：每个节点的实体出现
trees/     摘要树持久化（一张表，kind 参数化）
vectors/   本地向量库（cosine，暴力）—— 嵌入仍在内部，语义搜索仍工作
kv/        global + namespace 键值
```

两条铁律：**content bytes 不可变**（SQLite 存 `(content_path, content_sha256)` 指针，body 首写后永不变）；**SQLite 只管索引和向量，body 上的关键词搜索靠 grep `.md`**。还有一个编译期妙招：`traits.rs` 要求每个存储 kind 同时实现 `VectorEmbeddable + ObsidianRepresentable`——**编译器强制"memory_store 里的一切都既能向量化又能 Obsidian 化"**。检索经 `RetrievalFacade` 统一四种模式（tree-walk / vector / keyword / param-tag）。

### 4.2 bucket-seal 级联 + leaf 生命周期状态机

```
ingest 热路径（无 LLM，只廉价启发式，单事务）：
  source → canonicalize(规范化 md + provenance) → chunker(内容寻址 ID, ≤3k token) → 持久化 → 入队

后台 worker（3 个，信号量限并发 LLM）跑 job 队列（持久，在 chunks.db）：
  extract_chunk → 深度 score + 实体抽取，判 admitted/dropped
  append_buffer → admitted leaf 进 L0 buffer
  seal         → L0 满 → summarise.rs(LLM) 压成 L1 摘要 → 成为 L1 的 leaf → 级联向上
  flush_stale  → 强制 seal 坐太久的 buffer

leaf 状态机：pending_extraction → admitted → buffered → sealed
                                      \→ dropped（chunk 行保留做 provenance，无 buffer 引用）
```

- **确定性**：chunk ID 内容寻址，重跑同输入不产生重复。
- **崩溃不丢活**：启动时租约过期的 job 回队；admitted-but-not-sealed 不丢。
- **provenance 不重跑**：chunk 行 + 终态状态足够展示来源——`dropped` 的也留行。
- **hotness 排序**：实体/source 越频繁出现越积极构建 topic tree；检索按 hotness 排，热内容先浮。
- **自愈摄入**（`memory_sync/sources/rebuild.rs`）：每个摘要批次记原始文件到 `mem_tree_ingested_sources`，每次 sync 后 `check_and_rebuild_tree` диff 磁盘 vs gate，只补摘要没覆盖的余量——中断的 sync 下次自愈，不会永久搁浅原始文件。

> 注意演进：开发文档显示 Global/Topic 树**已被删掉**，改成"walk Source 树 + 实体索引"，底层引擎刻意 kind-agnostic（不分树类型分支）。用户文档还在讲三树是滞后——取经以"Source 树 + 实体索引 + hotness"为准。**这本身是个好信号：多树是 YAGNI，他们用真金白银证明了。**

### 4.3 learning 域：环境人格缓存（"几分钟就懂你"的真相）

这是 README 首页"context in minutes not weeks"承诺的兑现，也是我第一版完全漏掉的硬核子系统。核心是 **ambient personalization cache**（`user_profile_facets` 表）：一个有界、会衰减、打分的 `(class, key) → value` facet 集合。

```
Phase 1  候选分类法 + 全局环形缓冲（cap 1024 的 LearningCandidate）
Phase 2  生产者发候选：邮件签名解析→Identity / 长度比&编辑窗&纠正重复检测器→Style+Veto /
         LLM 摘要的结构化 JSON→各类 facet
Phase 3  稳定性检测器（默认 30min + 事件触发去抖）：
         按 recency-decayed 公式给每个 (class,key) 打分 → 解决值冲突 → 按 class 预算淘汰 →
         分配生命周期态(Active/Provisional/Dropped) → 持久化
Phase 4  注入 system prompt + 渲染 PROFILE.md 的 5 个 managed block(style/identity/tooling/vetoes/goals)
```

精妙处：

- **用户覆盖硬赢评分**：`Pinned ⇒ stability ∞`，`Forgotten ⇒ stability 0`。`update_facet` 隐式 pin。
- **post-turn hooks 喂证据**：`ReflectionHook`（反思）/ `ToolTrackerHook`（per-tool 成功率/时长）/ `UserProfileHook`（Aho-Corasick DFA 匹配偏好短语）。这三个 hook 在用户拿到回答**之后**后台跑（`tokio::spawn`）。
- **本地/云双路 + 干净跳过**：反思本地路要 `local_ai.usage.learning` flag，关了就回退云或 no-op；空响应是 clean-skip 哨兵，回滚节流计数。
- **transcript 摄入纯启发式**（无硬 LLM 依赖），所以能当后台任务跑、不需要 provider 凭证。

还有一条 **LinkedIn 富化管线**：Gmail→找 LinkedIn URL→Apify 抓→LLM 摘要→写 `PROFILE.md` + 记忆。这是"连上账号几分钟就有上下文"的字面实现。

### 4.4 codegraph：内容寻址的增量代码检索（一个独立的小宝石）

issue-crusher / pr-reviewer 技能背后的引擎。给一个 git worktree，回答"哪些文件和这个 query 最相关"，**融合 BM25 词法臂 + dense 结构增强嵌入臂，用 reciprocal-rank fusion（RRF）**。

最妙的是**内容寻址的增量索引**：每个文件的 `{BM25 tokens, 结构文档嵌入}` 按 **git blob SHA（+ 嵌入模型签名）** 缓存；一个分支的索引就是 `(repo_id, ref)` **manifest** join 到那个共享 blob 缓存。所以**切分支 / 新 commit / pull 只重处理真正变了的 blob**，rename 和未变文件全免费。`gc()` 丢没有 live manifest 引用的 blob。`Coverage`（full/partial/none）告诉 agent 索引覆盖度，non-full 时工具描述让 agent 把命中当线索并也用 grep。纯 Rust，git CLI + rusqlite + embeddings 域，无 Python 无额外服务。

---

## 五、统一推理层（`inference/`）—— BYO 一切

这是另一个被我第一版严重低估的域。它把 LLM/STT/TTS/嵌入**全部统一**在一个 provider 抽象下，是"一个账号、不 vendor sprawl"承诺的支柱。

**Provider trait 是核心抽象**（`provider/traits.rs`）。`ChatRequest` 带一个可选的流式 sink：`stream: Option<&Sender<ProviderDelta>>`，`ProviderDelta` 有 `TextDelta / ThinkingDelta / ToolCallArgsDelta` 三种细粒度事件。支持流式的 provider 把 SSE 转成 delta 喂 sink；不支持的回退非流式——**调用方代码不变**。这是"流式作为可选能力挂在统一 trait 上"的干净设计。

**Provider-string 语法 + 工作负载解析**：把工作负载名（`chat`/`reasoning`/`agentic`/`coding`/`memory`/`embeddings`/`heartbeat`/`learning`/`subconscious`）和 provider 串（`openhuman` / `cloud` / `ollama:<model>` / `lmstudio:<model>` / `claude_agent_sdk:<model>` / `<slug>:<model>[@<temp>]`）解析成具体 `Box<dyn Provider>` + model id。注意 `@<temp>` 后缀**按工作负载钉温度**，发上游前剥掉。

**几个值得记的能力**：
- **本地运行时管理**：检测/spawn/adopt `ollama serve` 和 LM Studio，装/跑 Whisper(STT)/Piper(TTS)，跟下载进度，强制最小上下文窗口地板。Adopt 的（外部已启动的）ollama 退出时**不杀**，只杀自己 spawn 的。
- **RouterProvider 智能路由**（`routing/`）：按任务档（Lightweight/Medium/Heavy）+ 本地健康（30s TTL 缓存探测）+ privacy/latency/cost hint 决定 `(primary, fallback)`。本地为 primary 时出错**或低质输出**（长度地板 + 拒答短语 Aho-Corasick DFA + 空噪声 token）重试远端——除非 `privacy_required` 禁止离机。**有工具时强制远端**（需 native tool-calling）。
- **Claude Agent SDK subprocess provider**（`provider/claude_agent_sdk/`）：把 Claude Agent SDK 当成一个子进程 provider（`protocol.rs` + `subprocess.rs`）接进来——**OpenHuman 自己也能把 SDK 当后端**。
- **reliability wrapper**：retry/backoff + config-rejection/billing-error 分类。
- **OpenAI 兼容 `/v1` 端点**：core 暴露 `/v1/chat/completions` + `/v1/models`，用独立的稳定外部 bearer（区别于 core 启动 bearer），让外部 OpenAI 兼容 harness 能调你的 core。
- **model council（多模型议会，`model_council/`）**：一个问题并发跑给几个 **member** 模型（≤5，jurors 用**只读工具注册表**的标准 harness loop，能 recall/search 但不能写），再用一个 **chair** 模型综合，surface 哪里**一致**、哪里**分歧**、各自独特洞见。**部分失败容忍**（一个 member 挂了记成空座位，告诉 chair），**全挂才中止**。纯 helper（validate/normalize/build_prompt/all_failed）与 I/O orchestrator 分离，不碰网络就能单测。

---

## 六、流式 + 在途状态：崩溃也不丢的对话

### 6.1 端到端流式链路（每一跳）

```
LLM provider（SSE）
  │ ProviderDelta { TextDelta | ThinkingDelta | ToolCallArgsDelta }
  ▼ 引擎每轮经 ProgressReporter::make_stream_sink 建 mpsc<ProviderDelta> + forwarder task
  │ forwarder 把 ProviderDelta 翻成 AgentProgress（TextDelta / ToolCall* / Subagent* / TurnCostUpdated）
  ▼ mpsc<AgentProgress>（引擎对外唯一进度出口）
  ▼ spawn_progress_bridge（channels/providers/web/progress_bridge.rs）
  │   - 翻成 WebChannelEvent，打 client_id/thread_id/request_id
  │   - 写 run-ledger（AgentRunUpsert / RunEventAppend / RunTelemetryUpsert）持久化
  │   - 对超大子 Agent 工具输出做 256KB 上线截断（UTF-8 边界 + marker）
  ▼ core/socketio.rs（桌面: Rust-native socket, tokio-tungstenite + rustls, 自实现 Engine.IO v4 + Socket.IO v4 framing）
  ▼ 前端 utils/tauriSocket.ts → ChatRuntimeProvider → 构建 toolTimelineByThread → Redux chatRuntimeSlice → React
```

**两级背压（踩过坑后的纪律）**：`AgentProgress` 是 orchestrator + 所有 inline 子 Agent + delta forwarder 共享的 bounded channel。lifecycle 进度事件用 `try_send`，满了就丢（注释明说：阻塞 `send().await` 会 park 子 Agent 主循环 → 挂死父 turn，即 subagent-stall flake）；但**文本 delta 在自己的 forwarder task 里保留阻塞背压**，可见消息文本不受影响。**可观测可丢，内容不可丢。**

### 6.2 turn_state：重启可恢复的在途快照（`threads/turn_state/`）

这是一个我很欣赏的细节。`TurnStateMirror` 订阅 `AgentProgress`，把它翻成 `TurnState`（含有序的 narration/thinking/tool `transcript`），**只在迭代/工具边界 flush**（高频 delta 只改内存，避免流式下文件系统 thrash），原子写每线程一个 JSON。

- **冷启动恢复**：非终态快照在冷启动被标 `Interrupted`。
- **完成态保留回放**：`Completed` 快照**故意保留**，让"查看处理过程"面板能回放完成的 turn；下一个 turn 才覆盖。
- **camelCase 镜像前端 slice**：turn-state 类型故意序列化成 camelCase，对齐 `chatRuntimeSlice.ts`，快照不用翻译直接 apply。
- **删线程顺序载重**：`delete` 先失效 web session **再**清 snapshot（注释标 ordering 载重），清理失败浮成 RPC 错误而非静默漂移。

### 6.3 中断（`InterruptFence`）

固定安全点检查（每次工具执行前 / spawn 前 / provider call 前）。用户 `/stop`：fence 翻转 → 所有子 Agent 共享同一 `Arc` 标志在下个 checkpoint bail → in-flight provider 流丢弃 → **archivist 仍用部分上下文触发**，对话不丢。中断是用户驱动，stop-hook 是策略驱动，共享底层但从不同侧进入。

---

## 七、安全纵深 —— 不是一道 prompt，是一摞独立的墙

### 7.1 OS 级沙箱矩阵（`security/` + `cwd_jail/`）

`security/` 有可插拔 `Sandbox` trait + `create_sandbox()` 按宿主挑最强后端：**Docker / Bubblewrap / Firejail / Landlock / Noop**。`cwd_jail/` 是互补的"目录牢笼"：给一个声明式 `Jail`（root + 只读路径 + deny_net + deny_subprocess），挑最强 OS 后端（**Linux Landlock / macOS Seatbelt / Windows AppContainer / Noop**）把**子进程**关进单一读写根。关键纪律：**它只 jail 它 spawn 的子进程，从不 jail core 自己**；spawn 前 canonicalize root（连只读路径），后端永不见 `..` 或 symlink 把戏；Landlock 在 `pre_exec`（fork 后 exec 前）应用，父保留特权。各后端语义差异诚实记在 README（Seatbelt 不真正 gate 网络等）。

### 7.2 确定性反注入（`prompt_injection/`，纯库）

在任何模型/工具执行**之前**跑。最硬核的是**归一化层**，专破混淆：小写化、leet（`0→o`/`1→i`/`@→a`）、**Cyrillic 同形字折叠**、全角 ASCII 折叠、**零宽/双向/格式字符剥离**、空白折叠。然后对 **三个变体**（`lowered` / `collapsed` / 去空白的 `compact`）跑一个编译一次的 `RegexSet` DFA + 两个内联启发式——所以 `j a i l b r e a k` 这种空格混淆攻击仍贡献分数。阈值 `Block ≥0.70 / Review ≥0.55 / else Allow`。审计行**记 SHA-256 hash 不记原文**（PII 安全）。阈值历史和误报修复（"show me the password reset flow" 不该触发）都编码在注释里。

### 7.3 审计 / 密钥 / 配对（`security/audit.rs` 等）

- **AuditLogger**：追加式审计 trail（Actor / Action / ExecutionResult / SecurityContext）。
- **SecretStore**：加密落盘的密钥编解码器，master key 在 keychain-backed 存储里。
- **PairingGuard + `constant_time_eq` + `is_public_bind`**：把 RPC server 公开 bind 前的配对 token 检查（常量时间比较防时序攻击）。
- **AutonomyLevel**（Supervised / SemiAutonomous / Autonomous）× workspace_only × trusted_roots × allow_tool_install 驱动 `SecurityPolicy`；含 `max_actions_per_hour` 的滚动动作预算（作为 stop-hook）。
- **`redact()`**：统一 4 字符前缀脱敏，给日志用。

### 7.4 写操作审批门（`approval/` + risk-confirm）

高风险工具过确认门；无交互通道 fail-closed 拒绝。Composio 工具的可见性/执行被 curated catalog + per-toolkit user-scope 偏好 + sandbox 模式 gate，**无法解析的 action slug 默认 Write（fail-closed）**。

---

## 八、主动与具身能力 —— 它不只是"等你问"

这是 OpenHuman 跟普通 chat agent 拉开差距的地方，也是我第一版完全没碰的。

### 8.1 subconscious：主动的"潜意识"循环（`subconscious/`）

一个周期性、结构化的后台循环，每个 tick 三段确定性流程：

```
1. memory_diff（代码）  diff 连接的 source vs 上个 tick 末尾的世界基线 → 用户的世界变了啥
2. prepare_context（代码）跑只读 context_scout 对 diff 收集 grounding（记忆/目标/集成/web）
3. decide（agent）      把 diff + context 交给精简的 subconscious agent，决定做不做事：
                        记 follow-up 到全局待办 / 进化长期目标(goals_*) / 通知用户(notify_user) /
                        委派深活(spawn_async_subagent)
```

精妙：**连续性活在耐久存储（全局待办 + 目标）里，不在 bespoke 草稿本**——所以安静 tick（无 diff）零成本，循环除世界基线外无状态。per-engine `tick_lock` 防重叠，硬墙钟 `TICK_TIMEOUT` 防卡死 LLM 阻塞循环。这是"agent 在你不看时也在帮你盯世界"的工程化实现。

### 8.2 screen_intelligence：屏幕感知（macOS）

consent-gated 捕获会话：轮询前台窗口 → `screencapture -l <windowID>` 截活动窗（**只截窗口 ID，绝无全屏兜底**）→ 3-pass OCR(Apple Vision via swift) + 本地 vision LLM + synthesis LLM(Ollama) → 把"用户此刻在干啥"的 markdown 持久化进记忆（`background` namespace）。**drain-to-latest**：processing worker 丢弃陈旧帧只分析最新，按 `captured_at_ms` 去重。**锁纪律**：worker 在锁内读完所有需要的 state 再 drop 锁才做慢 I/O（截图/磁盘/LLM）。TCC 权限 per-process，新授权要重启 core 才生效——UI 靠 `core_process` pid 验证重启真的发生了。

### 8.3 voice：听写 + 朗读 + 口型同步（`voice/`）

hotkey→录音→转写→插字的听写服务器。**多级 gate**（最小时长 → peak-RMS 静音阈 → 幻觉过滤 → 空文本），每级在投递前丢弃录音；`session_generation` 计数器丢弃被取代录音的陈旧状态转换。STT 走 whisper.cpp(本地) 或后端代理，TTS 走 Piper(本地)/ElevenLabs/Deepgram。agent 回复合成带 **Oculus-15 viseme 对齐做 mascot 口型同步**。macOS 上 rdev 的 CGEventTap 在非主线程调 `TSMGetInputSourceProperty` 会崩（EXC_BREAKPOINT），所以 macOS 只用 Swift globe(Fn) 键监听——这种"具体平台陷阱写进代码注释"的诚实度全仓一致。

### 8.4 meet_agent：活的 Google Meet 机器人（`meet_agent/`）

长寿命的 per-call 会话：Tauri 壳流 PCM 帧 + 抓的字幕进 core，core 跑 VAD 分段 STT（或字幕上的唤醒词匹配）→ 路由进用户**完整的 orchestrator agent**（带工具/记忆/集成）→ TTS → 流 PCM 回去给虚拟麦。亮点：

- **隐私门 fail-closed**：没配 `owner_display_name` 时**没有唤醒**——配错的启动永远不会把用户的工具面暴露给远程参会者。bot 自己的字幕先被丢，永不在自己 TTS 回声上重唤醒。
- **owner 授权流**：非 owner 唤醒记一个 2 分钟 pending grantee；owner 说"allow/go ahead"加进 per-call allowlist。
- **重度限流对抗 Meet 字幕 churn**：Meet 每 ~250ms 重发同一字幕行带标点/大小写抖动，会话叠 per-speaker 去重 + turn_in_progress gate + 60s 最小轮次间隔 + 唤醒冷却，防"sorry sorry sorry"多触发循环。
- **agentic 失败不回退裸 LLM**：orchestrator 超时（90s）就说罐头"让我回头答你"——裸模型会自信地幻觉"我没有日历访问权"，比延迟更糟。
- **reasoning 输出为语音净化**：`strip_for_speech` 去 `<think>` 块/markdown/推理前言，`cap_for_speech` 在句子边界截到 400 字符保持可打断。

---

## 九、Tauri 桌面壳（`app/src-tauri/`）

**进程模型**：core **进程内**跑（tokio 任务），**sidecar 已移除**（PR #1061）。前端 RPC → `core_rpc_relay`(Tauri command) → `http://127.0.0.1:<port>/rpc`，**每次启动生成 hex bearer token** 内存交给 renderer（`core_rpc_token` command 读）。运行期 URL 解析优先级：登录屏字段 > Tauri command > VITE env > 硬编码 `7788`。

**进程恢复（健壮性范本）**：正常退出从 `RunEvent::ExitRequested` 跑 teardown（关子 webview → core cancellation token → SIGTERM 子进程 → 宽限后 SIGKILL，日志 `[app] sweep: term=N kill=M`）。macOS 硬退出（Force Quit）跳过 teardown，下次启动 `[startup-recovery]` 列出属于本 `.app` 的残留进程并清理（`OPENHUMAN_CORE_REUSE_EXISTING=1` 或 CEF SingletonLock 持有时跳过）。

**技术债诚实记录**：root core crate 和 Tauri 壳是**两个独立 Cargo world**（两 `Cargo.lock`、两 `target/`），收敛是 follow-up（#3877）。CEF 子 webview 的 JS 注入是为嵌第三方网页账号付的安全税，AGENTS.md 明令"别长新注入"。

---

## 十、对 Finance Agent：偷什么、改什么、别碰什么

> 你的栈和它高度重合（Tauri + 前端 + 单机），但有两条根本差异决定取舍：① 你的 ReAct 循环归 `@anthropic-ai/claude-agent-sdk`，CLAUDE.md 明令"别重写循环"——所以它的**引擎代码不能抄，但引擎周边的设计能映射到 SDK 的 hooks/canUseTool**；② 你是**单机无云的垂直财务**，红线即地基——它几乎零财务约束，这正是你要反向加固的。

### 10.1 直接能偷的 gem（按价值排序）

1. **上下文工程那一整套（最高价值）**。四级 reduction 管线 + microcompact 保 tool-call 配对不变量 + KV-cache 字节稳定 + "失败不留半残状态"断路器 + session-memory 三阈值抽取。财务对话会很长（核对+解释+追问），这套是你能从 OpenHuman 学到的最值钱的东西。即使 SDK 管循环，你也能在 SDK 外把"什么时候压、压完保持哪些不变量、压失败怎么办"做成自己的策略层。

2. **TokenJuice 的内容感知压缩 + CCR 可逆缓存**。金蝶 JSON、Excel dump、银行流水 CSV、对账明细全是"大体量低密度结构化"。SmartCrusher（对象数组→表格、保出错/离群行）、Log 规则引擎、Search top-K 的设计直接迁移。CCR 的"lossy 但留 marker、按需 `retrieve` 放大"模式尤其适合"默认看摘要、要细节再拉原文"。**但财务版必须把参与计算的数值字段设成 `light`/`off`**（见 10.2）。

3. **记忆双写：Markdown 真相源 + SQLite 索引 + 内容寻址 + leaf 生命周期状态机**。你已经是"ripgrep over 文本镜像"，这套是它的自然升级。把财务的 leaf 状态机改成"原始凭证→已解析→已入账/已对账→已锁定/已驳回"，**驳回的也留行**——这直接同时满足红线 3（草稿/已确认/已锁定状态）+ 红线 8（审计可复盘 provenance）。`node:sqlite` 完全能承载这套。

4. **learning 的环境人格缓存思路**（裁剪版）。你不需要 LinkedIn 富化，但"从工作流里被动学到用户偏好（科目习惯/常用口径/纠正模式），带衰减地注入 prompt"对财务很有用。注意：财务的 facet 要可审计、可 pin、可 forget。

5. **重复失败断路器的分级阈值**。报销校验失败、金蝶取数失败、跨表对账失败，别让 SDK 盲目重试。把"确定性 3 次 / 硬拒第 2 次 / 可恢复 8 次"做成 PreToolUse/PostToolUse 护栏，bail 时带 root-cause。

6. **turn_state 崩溃可恢复快照 + 两级背压**。财务长任务（批量算薪、全量对账）崩了不能丢进度；"只在工具边界 flush、高频 delta 只改内存"避免 FS thrash；"可观测可丢、内容不可丢"是流式必守纪律。

7. **工程地基**：canonical module shape + README 即契约（含 Calls into/Called by）+ 类型化事件总线 + 结构化错误（不靠字符串匹配）+ 文档 CI。你 `lib/agent/` 还小，现在立规矩成本最低。

8. **Tauri 进程恢复（startup-recovery + sweep）**。你 memory 里就记了"stale next 进程叠端口"的坑——它的"启动清理属于本 app 的残留进程"直接对症。

9. **codegraph 的内容寻址增量索引思路**。如果做合同/凭证的语义检索，"按内容 SHA 缓存 + manifest join + 只重处理变化"能让重复导入近乎免费，BM25+dense RRF 融合也比纯向量稳。

### 10.2 必须按红线改造的点

| OpenHuman 做法 | 红线 | 财务版改法 |
|---|---|---|
| 工具结果硬截断 / TokenJuice lossy 采样（>40 行保 head+tail） | **2 数值正确 / 4 我不知道** | **参与计算的数值字段禁止有损压缩/采样/截断**。要么完整带过，要么 `{found:false, reason}` 让 Agent 说"查不到"。一张要汇总的费用明细被采样 = 错数还看不出错。压缩只作用于展示文本。 |
| summarizer 子 Agent / bucket-seal `summarise.rs` 用 LLM 压 | **2 / 3 信任链** | summary 只许叙述性压缩，**禁止含心算出的数值结论**。"本月报销合计 X"必须走 `tools/finance` 确定性函数 + asOf + 状态；草稿数与已确认数禁止直接相加。 |
| 嵌入可走 cloud；privacy 只是 hint | **7 合规驻留** | 含敏感字段（身份证/银行卡/薪资）的 chunk 嵌入**必须本地或不嵌**；脱敏发生在**入 LLM 上下文前**的工具层（不是流式输出时——那时已出本机）。`privacy_required` 要从软偏好做成硬门，fail-closed。 |
| ToolMaker 自写 polyfill / subconscious 自主决策 / Agent 自愈 | **6 决策边界** | Agent 是分析助手不是决策者。"缺函数就自造取数逻辑"在财务极危险。要拍板的口径取舍用 `AskUserQuestion` 交还用户。subconscious 那种主动循环可借鉴但**只许提示不许自动改账**。 |
| 进度和审计都从 AgentProgress 出，lifecycle 用会丢的 try_send | **8 审计落点** | **审计与进度彻底分离**。进度可丢（UI）；审计走独立有保证的写入（`insertAuditLog`，失败重试/告警），且记齐"谁/何时/查了啥/联没联网"四维。它的 run-ledger 是运营观测不是合规审计。 |
| 无逐次写审批概念（只有每小时动作预算） | **5 写审批** | 高风险写过 `risk-confirm` 门，无交互通道 fail-closed。它的 SecurityPolicy 给你框架，但"逐次人工拍板"是你要加的。 |
| hotness（访问频率）决定当前 vs 历史 | **3 信任链** | 财务"当前 vs 历史"靠**结算状态 + 会计期间**，不是访问频率。把"时点+状态"做成一等检索维度，hotness 只做次级排序。 |

### 10.3 明确别抄的过度设计

- **自写 agent loop（40K 行 harness）**：你用 SDK 就是为了不背这个包袱。学设计，别在 SDK 外再套一层自己的循环。
- **双 socket（Rust-native Engine.IO/Socket.IO framing）**：云架构 + 多端 + 后台化的税。单机桌面用 **SSE**（Next API route 流式响应，天然单向、无 framing）即可，全在本机不出网。
- **多 scope 树（Global/Topic）**：他们自己删了，YAGNI 实证。先做 Source 树 + 实体索引。
- **三层 spawn 编排 / 可复用耐久子 Agent 会话 / fork 模式**：先单 orchestrator + 确定性工具/skill；P2 经营分析真需要多步拆解时再引 planner。
- **CEF 子 webview + JS 注入**：你不嵌第三方网页账号，完全不需要，用标准 Tauri webview。
- **`integrations_agent` text-mode + ResultHandoffCache**：为 Composio 超大 schema 撑爆 grammar 逼出来的特例，你工具数量有限，保持 native tool-calling 单一路径。
- **3k-token 盲切 chunk**：财务按业务实体切（一张凭证/一笔分录/一个对账单），过大再二级分段。
- **UTC 日切 digest**：财务按会计期间切。

---

## 整体架构关系图（OpenHuman 全貌）

```
┌──────────────────────────────────────────────────────────────────────────────────┐
│                          Tauri 桌面壳（进程内 core，per-launch bearer，进程恢复）        │
│   IPC（小命令: 窗口/AI文件/core_rpc_relay）        Socket.IO（流式事件，Rust-native）     │
└──────────┬────────────────────────────────────────────────────┬────────────────────┘
           │ HTTP JSON-RPC（请求/响应）                            │ AgentProgress→WebChannelEvent
   ┌───────▼────────┐                                  ┌──────────▼──────────────────────┐
   │ React 19 + RTK │                                  │ progress_bridge → ChatRuntime    │
   │ chatRuntime/   │◄─────────────────────────────────│ toolTimeline / turn_state 回放    │
   │ turn 时间线     │                                  │ 两级背压(可观测可丢/内容不可丢)     │
   └────────────────┘                                  └──────────────────────────────────┘
                                                                  ▲ ProviderDelta sink→forwarder
┌─────────────────────────────────────────────────────────────────┴──────────────────┐
│  agent/harness：run_turn_engine（一个引擎，5 seam，N 入口）                            │
│   ToolSource·ProgressReporter·TurnObserver·CheckpointStrategy·ResponseParser         │
│   inline: stop-hook · 重复失败断路器(分级) · 流式转发 · token-budget                    │
│   多智能体: tier(chat/reasoning/worker)·MAX_DEPTH=3·耐久可复用会话·fork(KV复用)·toolkit排序│
└───┬────────────────┬─────────────────┬────────────────┬───────────────┬─────────────┘
    │                │                 │                │               │
┌───▼──────┐  ┌──────▼───────┐  ┌──────▼────────┐  ┌────▼────────┐  ┌───▼──────────────┐
│ context  │  │  inference   │  │   记忆栈       │  │  security   │  │  主动/具身         │
│ 四级管线  │  │ 统一provider │  │ memory_store  │  │ 沙箱矩阵      │  │ subconscious循环   │
│ microcmpt│  │ 本地运行时    │  │ (.md真相源)    │  │ cwd_jail    │  │ screen_intelligence│
│ TokenJuice│ │ RouterProvider│  │ bucket-seal   │  │ prompt_inj  │  │ voice(听写/口型)   │
│ +CCR可逆  │  │ Claude SDK   │  │ leaf状态机     │  │ AuditLogger │  │ meet_agent(会议bot)│
│ summarizer│  │ /v1兼容端点  │  │ learning人格   │  │ Autonomy    │  │                    │
│ 断路器    │  │ model council│  │ codegraph(RRF) │  │ PairingGuard│  │                    │
└──────────┘  └──────────────┘  └───────────────┘  └─────────────┘  └────────────────────┘
        共用地基: canonical module shape · 类型化 DomainEvent 总线 · 结构化错误 · README即契约 · 文档CI
```

---

## 附：对你三大功能计划（P1合同/P2经营分析/P3税务）的落点建议

- **P1 合同归纳 = 记忆栈 + learning**：直接套"`.md` 真相源 + SQLite 索引 + 内容寻址 + leaf 生命周期 + provenance"，合同条目走状态机（待审/已确认/已归档），learning 思路学"被动积累合同要素偏好"。codegraph 的内容寻址增量索引可用于合同语义检索。
- **P2 经营分析 = 上下文工程 + 确定性数值**：bucket-seal 把明细滚成分层摘要省钱，但**数值结论一律走确定性函数**；TokenJuice 压大体量明细（数值字段 `off`）。需要多步拆解时引一个 planner 子 Agent（学 tier 模型，别建三层）。
- **P3 税务筹划 = 决策边界 + 审计纵深**：线索发现可借鉴 subconscious 的"diff→context→decide"主动循环，但**只提示不自动改**；研发核查的每个判断走审计落点 + provenance，用 `AskUserQuestion` 把口径取舍交还用户。

---

*本分析基于只读研究：`src/openhuman/{agent/harness,context,tokenjuice,memory_store,memory_tree,memory_sync,learning,codegraph,inference,routing,security,prompt_injection,cwd_jail,subconscious,screen_intelligence,voice,meet_agent,model_council,threads,composio,agent_orchestration,channels/providers/web,socket}`，`app/src-tauri/`，`gitbooks/developing/architecture/*`，`docs/agent-subagent-tool-flow.md`，及 20+ 域 README。OpenHuman 文档存在演进滞后（Memory Tree 三树已删但用户文档未更新），取经以"代码为准"结论为准。*
