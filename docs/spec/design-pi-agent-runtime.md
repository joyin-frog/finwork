# Finwork Pi-only Agent Runtime 与多 Provider 设计

> 版本：v2.0
> 日期：2026-07-29
> 状态：Decision Approved / Implementation Not Started
> 产品决策：彻底移除 Claude Agent SDK；Pi 是唯一 Agent Runtime
> 首批 Provider：用户现有 Anthropic Messages 兼容网关
> 关联总纲：`ROADMAP-agent-runtime.md`
> 实施入口：`spike-pi-anthropic-replacement.md`
> 上下文精简：`design-agent-context-simplification.md`

## 1. 结论

Finwork 尚未上线，没有需要保留的客户 session、兼容版本或灰度升级包袱。继续维护
Claude/Pi 双 runtime 会带来两套 session、工具 adapter、权限挂点、打包资源和测试矩阵，
但不能创造用户价值。

目标架构改为：

1. `@earendil-works/pi-coding-agent` 的 `AgentSession` 是唯一 agent loop/session。
2. `@earendil-works/pi-ai` 承担 Provider、模型、凭证和流式 API。
3. Anthropic Messages 兼容网关是第一阶段唯一必须支持的 Provider。
4. Finwork 保有事件、Run、工具、安全、Skill、交付和可观察性合同。
5. `@anthropic-ai/claude-agent-sdk`、Claude CLI、Claude session/transcript/config 全部删除。
6. 公共层仍使用中立命名，不把 Claude 锁定替换成 Pi 锁定。

System Prompt、Skills 和工具目录的长期精简与本迁移一起设计，但按独立工作包实施：
AR10 前由 AS0 建立旧链路基线；AR9/AR11/AR12 期间的 AS1 只做结构中立化；Pi 主链稳定并
删除 Claude 后由 AS2 做语义精简。迁移与优化不得混成一个不可归因 diff。

删除 Claude SDK 不等于删除 Anthropic。Anthropic 在新架构中是模型 API 协议/Provider，
不再拥有 Finwork 的 agent loop。

## 2. 目标与非目标

### 2.1 目标

- 用 Pi `AgentSession` 替换 `runClaudeAgent()`。
- 复用现有 `AgentRuntimeEvent`、Run Contract、CompletionGate 和 durable run events。
- 把当前生产入口注册的 45 个财务工具抽成 Finwork 自有定义，通过 Pi `customTools` 注册。
- 用内部 Pi extension 承载权限、审计、路径安全、事件和 compaction 等横切能力。
- 使用自定义 `ResourceLoader` 显式装载 Finwork 内置/用户 Skills。
- settings、secret、session、usage、telemetry、测试和错误文案全部去 Claude 命名。
- 让 Query Pipeline、SSE、UI、RunStore 不 import Pi SDK 类型。
- 最终依赖树、源码、打包产物和应用数据目录中均不存在 Claude Agent SDK 运行时残留。

### 2.2 非目标

- 第一阶段不同时接 OpenAI、Google 或其他协议。
- 不开发 runtime 切换 UI。
- 不为“未来可能再换 runtime”设计覆盖一切的大接口。
- 不重写第三套 agent loop。
- 不把业务工具塞进 Pi Extension。
- 不默认读取用户机器的 `~/.pi`、`~/.claude` 或 `~/.agents`。
- 不承诺 Claude transcript 能无损转换为 Pi session。
- 不要求 Claude/Pi 的逐 token、thinking 或 compaction 内部轨迹一致。

## 3. Runtime 与 Provider 的边界

| 概念 | 所有者 | v1 取值 |
|---|---|---|
| Agent Runtime | 谁拥有 loop/session/tool execution | 固定为 Pi |
| API type | 模型端点协议 | `anthropic-messages` |
| Provider profile | 端点、凭证引用、兼容参数 | 用户现有 Anthropic 网关 |
| Model slot | Finwork 任务角色映射 | `main` / `router` / `subagent` |
| Runtime session | agent 上下文会话 | Pi session locator |

Runtime 固定并不意味着 Provider 写死。Provider profile 与模型槽必须保持独立，以便后续增加
OpenAI Responses、Google 等协议时只扩 `pi-ai` Provider 层，不改 Query Pipeline 和 UI 事件。

## 4. Pi 包分层

```text
@earendil-works/pi-coding-agent
  └─ AgentSession / ResourceLoader / SessionManager / extensions
       └─ @earendil-works/pi-agent-core
            └─ agent loop / tool execution / state
                 └─ @earendil-works/pi-ai
                      └─ Anthropic Messages / models / credentials / streaming
```

决策：

1. 产品入口显式依赖 `@earendil-works/pi-coding-agent`。
2. Provider 模块需要注册网关或构造模型时可显式依赖 `@earendil-works/pi-ai`。
3. 首期不直接调用 `pi-agent-core` 的低层 loop；它通过 coding-agent 间接接入。
4. 只有 PoC 证明 coding-agent 无法暴露必需控制点，才评估直接使用 core。
5. 所有显式 Pi 包锁同一精确版本，不用 `^` 造成分层漂移。
6. Pi import 只能出现在 `lib/agent/pi/**` 和获批准的 schema adapter。

## 5. 目标架构

```text
UI / SSE client
      │
      ▼
API / Query Pipeline / RunStore
      │
      ▼
Finwork Agent Service
  ├─ FinworkAgentRequest / Result
  ├─ AgentRuntimeEvent emitter
  ├─ CompletionGate / TaskContract
  └─ RuntimeSessionLocator
      │
      ▼
Pi AgentSession
  ├─ AnthropicProviderProfile
  ├─ Finwork ResourceLoader
  ├─ Finance customTools
  └─ Finwork cross-cutting extension
```

候选目录：

```text
lib/agent/
├── contracts/
│   ├── request.ts
│   ├── result.ts
│   ├── session.ts
│   └── usage.ts
├── pi/
│   ├── agent-service.ts
│   ├── anthropic-provider.ts
│   ├── event-mapper.ts
│   ├── resource-loader.ts
│   ├── session-manager.ts
│   └── extension.ts
├── tools/
│   ├── definition.ts
│   ├── registry.ts
│   ├── policy.ts
│   ├── pi-adapter.ts
│   └── finance/**
├── runtime-events.ts
├── run-contract.ts
└── completion-gate.ts
```

`Finwork Agent Service` 是产品与 Pi 之间的薄边界，不是为多 runtime 设计的 factory。它只负责：

- 接收 Finwork 请求/上下文。
- 创建或恢复 Pi session。
- 把 Pi 事件映射为 `AgentRuntimeEvent`。
- 返回中立的结果、usage、session locator 和 termination 信息。
- 在退出时释放本次 run 的资源。

## 6. Anthropic Messages Provider

第一阶段只注册用户现有网关：

```text
providerId: finwork-anthropic
apiType: anthropic-messages
baseUrl: user configured
credentialRef: OS secret store reference
models:
  main
  router
  subagent
```

PoC 必须验证以下兼容差异，不能只以一次文本回复成功作为通过：

- tool call 与增量 tool input。
- thinking block 与 signature replay。
- adaptive thinking。
- cache control / prompt cache。
- strict tools。
- image input。
- usage、stop reason、overflow 和鉴权错误归一化。
- 长上下文、compaction 后续聊。
- 网关是否拒绝 `eager_input_streaming` 等 Anthropic 扩展字段。

兼容参数必须归 `ProviderProfile.compatibility`，不能散落在 Query Pipeline。

## 7. 财务工具

当前 `buildFinanceMcpServers()` 组合 finance worker 34 个、kingdee worker 11 个，共 45 个
生产注册工具。全目录有 46 个 `sdk.tool()` 调用点，其中 `lib/agent/tools/finance/kingdee.ts`
的旧工厂未被生产入口引用；后续迁移与验收以 45 个注册工具为基线，并在 AR11 决定删除或
重新接线该孤立工厂。

现有 `lib/agent/mcp-tools/**` 实际使用 Claude SDK `sdk.tool()` 和
`createSdkMcpServer()` 注册进程内工具，并不存在必须保留的网络 MCP 边界。

目标定义：

```ts
type FinanceToolDefinition<I, O> = {
  id: CanonicalToolId;
  description: string;
  inputSchema: unknown;
  risk: ToolRisk;
  allowedRoles?: string[];
  execute(input: I, context: FinanceToolContext): Promise<O>;
};
```

要求：

- handler 不 import Pi。
- canonical tool id 是权限、审计、幂等和 UI 的唯一身份。
- Pi 合法工具名只是 runtime alias。
- `outputDir`、`conversationId`、`traceId`、`roleId`、confirm resolver 和 abort signal
  通过 session-scoped context 注入。
- Zod 继续承担 handler 前的权威校验。
- 模型可见 schema 由 adapter 生成，并用代表性复杂 schema 验证转换能力。
- 现有 JSON 字符串宽松化垫片保留在 Finwork 校验/handler 边界。

Pi 使用 session-scoped `customTools` 注册业务工具。内部 Extension 不拥有财务 handler。

## 8. Pi Extension

内部 Finwork extension 只承载横切能力：

- Pi 内置 read/bash/edit/write 的路径与风险检查。
- 自定义财务工具执行前后的安全 hook。
- always-confirm、high-risk 和 session trust。
- tool/result 事件标准化。
- Provider 请求/错误 trace。
- compaction 审计。
- abort/cleanup。
- 禁止未接线工具。

安全策略仍归 Finwork：

1. `ToolPolicy` 按 canonical id 判风险。
2. 财务工具先过 Finwork before hooks，再调用 handler。
3. Pi 内置工具在 extension `tool_call` 阶段拦截。
4. 用户确认继续走现有 pending-question/confirm resolver。
5. adapter 不得绕过 CompletionGate 和交付证据。

## 9. Skills

Skill 内容继续由 Finwork 管理：

- 内置：打包的 `agent-skills/skills/**`。
- 用户：Finwork app-data 下受控目录。
- 角色：现有 role allowlist。
- 当前会话：显式引用的 Skills。

Pi 使用自定义 `ResourceLoader` 显式装载。禁止 ambient 扫描用户默认目录。

PoC 至少验证：

- 一个只读 Skill。
- 一个带脚本 Skill。
- 一个用户 Skill。
- 一个受角色白名单限制的 Skill。

## 10. 事件、Run 与 UI

`AgentRuntimeEvent` 继续作为唯一公共实时事件合同。Pi mapper 至少覆盖：

| Pi 行为 | Finwork 事件 |
|---|---|
| session/run start | `run_started` / `turn_started` |
| text/thinking stream | `message_started/delta/completed` |
| tool start/update/end | `tool_started/updated/completed` |
| compaction | `compaction_completed` |
| permission wait | `run_blocked` / `ask_user` |
| steer/follow-up | `queue_updated` |
| end/error/abort | `run_ended`，最终由 Query Pipeline 发 `run_settled` |

规则：

- Pi mapper 发事实事件；`run_settled` 仍由 Finwork 单一收口。
- Pi 原始事件不能进入 SSE、SQLite 或 UI。
- usage 先归一化再进入 trace/quota。
- 未知 Pi 事件默认内部记录并丢弃，除非公共合同明确扩展。
- 聊天 UI、工具时间线、附件、预览和深度思考开关不分叉。

## 11. Session 与数据库

conversation 保存：

```text
runtime_session_id
runtime_session_updated_at
provider_id
model_id
```

不增加 `agent_runtime` 字段，因为产品 runtime 固定为 Pi。字段仍用中立名称，避免未来再次
把业务 schema 锁死在某个 SDK。

迁移：

- `claudeSessionId` → `runtimeSessionId`
- `claude_session_id` → `runtime_session_id`
- `claude_session_updated_at` → `runtime_session_updated_at`
- `setChatConversationClaudeSessionId` → `setChatConversationRuntimeSession`

项目尚未上线，可做明确 rename，不永久维护双字段。数据库变更仍遵守 migration discipline：
冻结 schema 文件不改，新 DDL/rename 追加到 `lib/db/migrations.ts`，实施前核对 main/worktree/
实际数据库三条链尾。

Pi session/config/transcript 写入 Finwork app-data 受控目录，并纳入 retention。RunStore 与
Pi session 是两本账。

## 12. 设置、凭证与 UI

设置模型：

```text
AgentSettings
  providerProfiles
  modelSlots
  product identity / role mode / telemetry

ProviderProfile
  providerId
  apiType
  baseUrl
  credentialRef
  compatibility

ModelSlots
  main
  router
  subagent
```

第一阶段 UI：

```text
模型服务
  协议       Anthropic Messages（固定）
  API 地址
  API Key
  快速模型
  推理模型
```

不显示 Pi/Claude runtime 切换，也不显示复杂 Provider 管理器。未来增加第二 Provider 时再扩
Provider profile 选择。

要求：

- `/api/settings/claude` → 中立 settings API。
- `ClaudeSettings` / `PublicClaudeSettings` → `AgentSettings` / `PublicAgentSettings`。
- API Key 继续进入系统密钥库，不落 JSON。
- secret store 支持以 provider id 为 key，不保留单一 Claude key 语义。
- Pi 默认 `~/.pi/agent/auth.json` 不作为产品凭证 SSOT。
- 模型槽继续遵守现有原子完整性和 role/executionTier usage 口径。

## 13. 子代理

- 子代理通过 Pi session/service 创建隔离 session。
- Provider/model 使用 `subagent` 槽。
- depth、tier、角色白名单、dispatch ledger 和 `instanceId` 语义保持 Finwork 所有。
- 子代理事件继续映射到同一 `AgentRuntimeEvent`。
- 不让子代理直接读取 ambient Pi 配置或绕过安全 hook。

## 14. Tauri 与运行环境

必须验证：

- Next standalone 能解析 Pi ESM 与动态资源。
- 内嵌 Node 版本满足 Pi engine 要求。
- macOS arm64/x64、Windows x64、Linux x64 的依赖和路径。
- Pi session/resource/extension 在打包后可发现。
- 应用只访问 Finwork app-data，不触发产品外更新、遥测或资源扫描。

删除项：

- Claude SDK dependency 与平台 optional dependency。
- Claude 原生 CLI copy/打包逻辑。
- Claude config 路径和 transcript retention。
- Claude 专属环境变量注入。

## 15. Import 与删除规则

1. `@earendil-works/*` 只能出现在 `lib/agent/pi/**` 和批准的 Pi schema adapter。
2. Query Pipeline、UI、DB、RunStore、工具 handler 不 import Pi 类型。
3. `@anthropic-ai/claude-agent-sdk` 最终在源码、测试、package lock 和产物中为零。
4. `claude-adapter.ts`、SDK hooks、Claude MCP adapter 和 Claude subagent runner 删除。
5. 公共类型不使用 Claude/Pi 前缀。
6. `AgentRuntimeEvent`、Run Contract、Tool Policy、CompletionEvidence 是公共 SSOT。

“删除完成”必须同时满足：

- `package.json`/lockfile 无 Claude SDK。
- `rg` 无生产 Claude SDK import。
- 打包产物无 Claude CLI/SDK。
- settings JSON、secret key id、数据库列和 app-data 目录无运行时 Claude 命名。
- 测试不再以 Claude 错误文案或 transcript 行为作为产品合同。

品牌比较、历史 audit 和迁移文档中的文字可保留，不属于运行时残留。

## 16. 实施顺序

### AS0：上下文与行为基线

按 `design-agent-context-simplification.md` 建立 golden tasks、prompt/Skill/tool token 成本、
工具/Skill 选择准确性、安全和交付质量基线。AS0 是 AR10 的执行入口门。

### AR10：Pi + Anthropic Messages 替换 PoC

按 `spike-pi-anthropic-replacement.md` 执行，不接生产 Query Pipeline。

### AR9：Finwork 公共边界与命名中立化

根据 PoC 证据冻结：

- `FinworkAgentRequest/Result`。
- runtime session locator。
- usage/error/termination 归一化。
- Pi event mapper 边界。

同时迁移 settings/session/public types 的 Claude 命名，但暂不删除可运行的旧链路。

### AR11：财务工具中立化

先迁五个代表工具，再机械迁移 45 个注册工具：

1. `read_document`
2. `remember_convention`
3. `run_python`
4. `process_voucher_batch`
5. `spawn_subagent`

### AR12：Pi 生产接入

用 `AgentSession`、Provider、ResourceLoader、customTools 和内部 extension 接入现有
Query Pipeline，保持 SSE/UI/RunStore 合同。

### AR13：Claude SDK 删除

删除旧 adapter、依赖、MCP SDK adapter、session/settings 命名、CLI 打包、transcript
retention、专属测试和错误文案。

### AR14：Pi-only 发布门

执行全工具、安全矩阵、session/compaction、复杂文件交付、三平台 packaged smoke 和零残留
检查；同时执行 AS3 上下文精简 before/after 门。未通过时定位到 Runtime 或上下文工作包修复，
不恢复 Claude fallback。

## 17. 完成定义

1. Pi 是唯一 Agent Runtime。
2. 用户现有 Anthropic Messages 网关通过真实 PoC 和 packaged smoke。
3. 45 个生产注册财务工具只有一份 handler/风险/角色定义。
4. Pi 事件全部映射到公共事件合同。
5. API Key 只存在于系统安全存储。
6. conversation 能在进程重启后通过 Pi session 续聊。
7. Query Pipeline、UI、DB、RunStore 不 import Pi SDK 类型。
8. Claude SDK、CLI、配置、session、retention 和运行时测试残留为零。
9. 删除 Claude 后全量类型检查、测试、build 和三平台 smoke 通过。

## 18. 尚需 PoC 回答

1. 网关需要哪些 Anthropic compatibility flags。
2. Pi JSONL 受控目录是否足够，还是必须注入自定义 session backend。
3. Zod → 模型可见 schema 对复杂工具的可维护转换方式。
4. `AgentSession.steer/followUp` 是否进入首期产品能力；UI 仍暂缓。
5. Pi 内置工具是否全部关闭，还是保留 read/bash/edit/write 并由 extension 加闸。
