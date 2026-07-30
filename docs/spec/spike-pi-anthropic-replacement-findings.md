# AR10 Findings：Pi + Anthropic Messages

> 状态：AR10 Complete / AR12、AR13 已完成
> 日期：2026-07-30
> 基线：`claude-20260729074120-86905c70`
> PoC 基准提交：`d5008d8`（工作树包含本报告所述未提交改动）
> 网关：`https://znew-api.dev.ztosys.com`（仅记录 origin）
> 模型：`MiniMax-M3`

## 当前结论

Pi `0.82.1` 已在现有网关上真实通过 Anthropic Messages 的文本、thinking、图片、嵌套
schema 工具调用、usage、受控 session 恢复、Pi 原生主/子 Agent、确认/回答、timeout/abort、
真实 compaction 和 steering。API Key 由 Finwork 安全存储读取，只进入 Pi 的内存
credential/provider 配置；PoC session 只写 `$TMPDIR/finwork-ar10-*`，未生成 `auth.json`。

AR10 的 10 项 Pass Gate 已全部满足。AR12 已把生产 Query 的唯一 Agent 调用点切到
`runPiAgent`，并用 MiniMax-M3 真实跑通 Query → Pi Service → session/event/DB 的等价门。
AR13 已删除 Claude Agent SDK 依赖、adapter、CLI 打包、旧设置 API、专属 hooks/runner/test，
生产运行时不保留 Claude fallback。

为兼容已安装版本，仅保留两类不可执行的升级入口：设置读取一次旧 `{claude: ...}` envelope 后
写回 `{agent: ...}`，以及数据库 migration 对历史 `claude_session_*` 列的 rename。它们不加载
SDK、不参与新会话执行，也不出现在打包 runtime closure 中。

## 固定环境

| 项 | 值 |
|---|---|
| OS / arch | darwin / arm64 |
| Node | 24.13.0 |
| Next | 15.5.19 |
| Tauri CLI | 2.11.3 |
| `pi-ai` | 0.82.1（精确锁定） |
| `pi-agent-core` | 0.82.1（精确锁定） |
| `pi-coding-agent` | 0.82.1（精确锁定） |
| Provider API | `anthropic-messages` |
| context / max output | PoC 暂定 200000 / 8192，AR12 前需按网关模型元数据收口 |

三个 Pi 包均作为直接依赖精确锁定，避免上层包的 caret 依赖在安装时独立漂移。

## 实验结果

| 实验 | 状态 | 已验证 | 尚缺 |
|---|---|---|---|
| E1 Provider | PASS | text、thinking、32x32 合成 PNG、usage、stop/error | 1x1 PNG 被网关 400 拒绝，换合规尺寸后通过 |
| E2 Tool/schema | PASS | 45 个生产定义共用原 handler；Zod 权威校验；`read_document` 路径拒绝、`remember_convention` 隔离写入、`run_python` 真进程、`process_voucher_batch` 嵌套 handler、`spawn_subagent` Pi session 均执行 | — |
| E3 安全 | PASS | 无 resolver fail-closed、拒绝、明确确认、角色越权、路径越界；真实主 Service 时间线为 tool start → ask → answer → tool end；trust 按 conversation 隔离；Pi builtin 全关闭 | 现有 unwired 集合为空，按冻结语义保持 |
| E4 事件 | PASS | mapper 覆盖 run/turn/text/thinking/tool/queue/compaction/settled；未知事件 drop+trace；主 Service 增加 ask/answer 与 blocked；Query-owned start/end/settled 不从 Service 重复发；子代理保持独立 `instanceId` | — |
| E5 Session | PASS | 三轮工具对话 → 真实 compaction → 两轮续聊 → dispose/open 后继续；JSONL 只在受控目录 | — |
| E6 Abort | PASS | 模型、真实 `run_python` 子进程、在途 Pi 子代理和主 Service timeout 均可终止；750ms cleanup window 内事件/文件静默 | — |
| E7 Steering | PASS | 输出阶段 `steer` 进入下一 turn；工具阶段同时排队时 `steer` 先于 `followUp`；队列清空后才 settled | UI 仍属 out of scope |
| E8 Packaged | PASS（当前平台） | Next standalone 实际 trace Pi；Tauri 内嵌 Node 启动并加载主 Service、Pi ESM、45 工具、ResourceLoader、受控 session dir | Windows 与另一 macOS 架构留到 AR14 当前三 target 发布门 |
| E9 零残留 | PASS（正式） | AR13 审计同时检查依赖/锁文件、生产源码、Next standalone、Tauri resources 和可执行 Pi-only closure；均无 Claude Agent SDK、adapter、SDK hook/CLI | Windows 与另一 macOS 架构打包仍归 AR14 |

### 可复现命令

```bash
npm run typecheck
npm run test:pi
npm run eval:ar10:text
npm run eval:ar10:tool
npm run eval:ar10:subagent
npm run eval:ar10:subagent-abort
npm run eval:ar10:main
npm run eval:ar10:confirm
npm run eval:ar10:timeout
npm run eval:ar10:compaction
npm run eval:ar10:steering
AR10_ALLOW_REAL=1 npx tsx scratchpad/spikes/ar10-pi-anthropic/run.mts thinking
AR10_ALLOW_REAL=1 npx tsx scratchpad/spikes/ar10-pi-anthropic/run.mts image
AR10_ALLOW_REAL=1 npx tsx scratchpad/spikes/ar10-pi-anthropic/run.mts resume
AR10_ALLOW_REAL=1 npx tsx scratchpad/spikes/ar10-pi-anthropic/run.mts abort
npm run build
npm run tauri:prepare
npm run eval:ar14:packaged
npm run eval:ar13:pi-only
npm run eval:ar12:query
```

`AR10_ALLOW_REAL=1` 是付费真实调用的显式门。PoC stdout 只输出断言、事件类型、时间线 hash、
文件数量/字节数和脱敏错误，不输出 prompt、回复正文、session 内容或凭证。

## 结构发现

1. Pi 是纯 ESM。仓库默认 `.ts` 顶层 runtime import 经 `tsx` CJS 链会报
   `ERR_PACKAGE_PATH_NOT_EXPORTED`；生产 Pi 边界已改为惰性 `import()`，`.mts` PoC 与生产
   `lib/agent/pi/**` 均能真实加载。instrumentation 的显式、环境变量守卫 preflight 让 Next
   trace 主 Service 与 Pi 依赖；Tauri 内嵌 Node 已从 standalone 启动并真实执行无网关 preflight。
2. Pi 不原生提供 MCP、产品确认 UI 或 Finwork 子代理。45 个财务工具不应再包成外置 MCP
   扩展；正确形态是 Finwork 中立目录 → session-scoped Pi `customTools`。
3. 现有所有工具工厂都通过 `sdk.tool(name, description, zodShape, handler)` 建立，因而可以用
   collector 抽出 45 个 `FinanceToolDefinition`，不复制 handler。
4. Pi 模型 schema 从 Zod 转 JSON Schema；运行时仍执行同一个 Zod object 的 `parseAsync`，
   因此 preprocess/refine/transform 不会失去权威性。
5. Pi builtin read/bash/edit/write 当前全部关闭。生产文件与 Python 能力先继续走 Finwork
   工具和安全闸，除非后续证明 builtin 能完整覆盖现有安全语义。
6. 手动 compaction 对短 session 会明确报 `Nothing to compact`。实验把隔离 session 的
   `keepRecentTokens` 降到 32 以制造可压缩边界，仍由真实模型生成摘要；生产默认 8192 未改。
7. 中立工具层不再动态回落 legacy 子代理。Claude 主 adapter 显式注入 legacy executor，
   Pi 主 Service 显式注入 Pi executor；未注入时 fail-closed。这消除了 Pi-only closure
   对 `claude-adapter`/SDK hooks 的隐藏引用。

## Pi 到公共事件映射

| Pi | Finwork |
|---|---|
| `agent_start` | `run_started` |
| `turn_start` | `turn_started` |
| `text_start/delta/end` | `message_started/delta/completed(text)` |
| `thinking_start/delta/end` | `message_started/delta/completed(thinking)` |
| `tool_execution_start/update/end` | `tool_started/updated/completed` |
| `queue_update` | `queue_updated` |
| `compaction_end` | `compaction_completed` |
| `agent_end` | `run_ended` |
| `agent_settled` | `run_settled` |
| provider framing、entry/config/retry | 不进 SSE/DB，只记 mapper trace |

## AR9 / AR11 / AS1 已推进范围

- 增加 Runtime-neutral `AgentMessage`、附件、问题、请求/结果/usage 合同；公共 Query、
  router、recap、pending question 不再从 Claude adapter 取类型。
- 增加 `AgentSettings` 中立入口；磁盘写入和公开 API 均使用 `agent`，只读一次旧 envelope
  以完成已安装版本迁移。
- 从现有工具工厂抽出 45 个中立定义，canonical id、描述、Zod、handler 和当前风险查询同源。
- 增加 Pi custom tool adapter、公共确认/角色授权入口及结构测试。
- 增加 Finwork-owned Pi ResourceLoader：关闭 ambient extension/context/prompt/theme，只加载
  Finwork 内置/用户 Skill 白名单和现有 System Prompt SSOT。
- 增加 Pi Provider 和事件 mapper；所有 Pi import 限制在 `lib/agent/pi/**`（PoC/测试除外）。
- 增加隔离的 Pi 主 Agent Service：装配现有 prompt/memory/profile/skills、45 个工具、角色
  白名单、附件、usage、受控 session、timeout/abort 与确认事件；Query 仍是终态唯一所有者。
- `spawn_subagent`/两个批跑工具支持注入中立执行器；Pi 子代理使用隔离 session、subagent
  模型槽、角色 Skill/工具白名单和同一事件合同，不再回落 Claude runner。
- 工具执行上下文透传 `AbortSignal`；`run_python` 会终止 Python worker，750ms 内无迟到文件。
- 新增 v23 将 conversation 的历史 Claude session 列明确 rename 为 `runtime_session_*`；
  Query/router/DB/UI 只使用不解析的 runtime locator。
- 产品设置入口统一为 `/api/settings/agent`，页面、doctor、usage、telemetry 和聊天页面均改用
  `AgentSettings`；旧 `/api/settings/claude` 已删除。

## AR12 / AR13 完成证据

- Query 唯一调用点直接调用 Pi Agent Service，并写回 Pi session-file locator。
- MiniMax-M3 真实 Query harness 验证 marker、受控 session、消息持久化和唯一末尾
  `run_settled(outcome=completed)`。
- `npm ls @anthropic-ai/claude-agent-sdk --all` 为空。
- `npm run eval:ar13:pi-only` 验证生产源码、依赖、bundle 和当前平台打包产物零运行时残留。
- `npm run build`、`npm run tauri:prepare`、`npm run eval:ar14:packaged` 均通过。
- 完整 `npm test` 当前受本机 Python 环境缺少 `openpyxl` 阻塞；Pi、Query、设置、事件、
  session、子代理等迁移相关测试已独立通过。

## 既存差异

继续按 AS0 冻结，不在迁移中顺手改变语义：

- `export_voucher_list` 不在风险注册表，当前回落为 medium。
- CompletionEvidence contract id 未注入。
- `remember_convention` 的 session/global 语义歧义。
- Claude compaction 不可用。

这些项待 Pi-only 主链与 Claude 删除完成后进入 AS2/缺陷修复；当前测试只防止迁移引入新的
偏差。
