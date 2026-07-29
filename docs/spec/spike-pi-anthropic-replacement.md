# AR10 Spike：Pi + Anthropic Messages 替换 Claude Agent SDK

> ID：AR10
> 状态：Approved / Waiting for AS0 Baseline
> 类型：替换阻断 Spike，不接生产 Query Pipeline
> 日期：2026-07-29
> 时间盒：2–3 个工作日
> 目标端点：用户现有 Anthropic Messages 兼容网关
> 架构 SSOT：`design-pi-agent-runtime.md`
> 执行前置：完成 `design-agent-context-simplification.md` 的 AS0 基线

AS0 的执行合同见 `as0-agent-context-baseline.md`。Phase A 任务集就绪不等于前置完成；
必须先冻结 Claude Phase B 结果，再开始本 PoC 的真实 Provider 调用。

## Question

Finwork 能否用 Pi `AgentSession` 和 `pi-ai` 的 `anthropic-messages` Provider，在不降低现有
事件、安全、工具、Skill、session、交付和桌面打包合同的前提下，彻底替换
`@anthropic-ai/claude-agent-sdk`？

本 Spike 不是验证“Pi 能回复一句话”，而是验证生产替换所需控制点。

PoC 必须与 AS0 的旧链路 golden tasks/指标对照。为保证结果可归因，AR10 不重写 System
Prompt、Skill SOP、工具描述或业务 handler；只允许为 Pi 接入做最小结构适配。

## Scope

PoC 放在：

```text
scratchpad/spikes/ar10-pi-anthropic/
```

允许：

- 增加独立 PoC 依赖和脚本。
- 使用隔离的临时 session/output/app-data。
- 调用真实 Anthropic Messages 网关。
- 复用只读业务 handler 或构造最小 adapter。
- 生成 findings 和脱敏证据。

禁止：

- 修改 `/api/agent/query` 的生产执行路径。
- 修改生产数据库 schema。
- 把 Claude SDK 从生产依赖中提前删除。
- 复制 45 个生产注册工具的 handler。
- 将真实 API Key、完整财务数据或未脱敏响应写入仓库。

## Fixed Inputs

- Runtime：Pi。
- API type：`anthropic-messages`。
- Provider：用户现有兼容网关。
- UI：不做 runtime 开关。
- Session 根目录：临时 Finwork app-data 子目录。
- 凭证：从进程注入或系统密钥库读取，不写 Pi 默认 `auth.json`。
- 事件目标：现有 `AgentRuntimeEvent`。

开始实验前记录：

- AS0 baseline 版本、golden task id 与证据目录。
- Pi 三包精确版本和依赖关系。
- Node/Next/Tauri 版本。
- 操作系统与架构。
- 网关 base URL 的脱敏标识。
- 模型 id、上下文窗口和最大输出。
- PoC commit/tree 状态。

## Representative Tools

使用五类代表工具覆盖主要风险：

| 工具 | 验证目的 |
|---|---|
| `read_document` | 只读、路径白名单、文本结果 |
| `remember_convention` | 中风险持久化、结构化参数 |
| `run_python` | 高风险确认、长任务、abort、文件产出 |
| `process_voucher_batch` | 嵌套 schema、批处理、结构化结果 |
| `spawn_subagent` | 子 session、递归事件、模型槽 |

PoC 工具必须调用现有 handler 或最小 wrapper，不复制业务实现。

## Experiment Matrix

### E1. Provider 基础兼容

- 注册自定义 Anthropic Messages Provider。
- 完成一次纯文本、一次流式 thinking、一次图片输入。
- 记录请求字段、响应事件、usage、stop reason 和错误。
- 验证凭证未写入 `~/.pi` 或仓库。

### E2. Tool call 与 Schema

- 顺序执行五个代表工具。
- 覆盖简单 object、嵌套 array/object、optional、union/refine/preprocess。
- 验证模型可见 schema、Finwork Zod 权威校验和 handler 实际入参。
- 记录 tool id、增量参数、结果、错误和重试。

### E3. 安全与确认

逐条验证：

- safe 自动执行。
- medium/high 风险确认。
- always-confirm。
- 用户拒绝。
- confirm resolver 缺失。
- 角色越权。
- 路径越界。
- 未接线工具。
- session trust 只在当前 conversation 生效。

任何 Pi 内置工具都必须证明会经过 extension 安全闸，否则在生产方案中关闭。

### E4. 事件映射

生成并保存脱敏时间线：

- run/turn start。
- text/thinking start、delta、complete。
- tool start、update、complete。
- blocked/ask/answer。
- compaction。
- subagent start/tool/end。
- abort/error/end。

每条 Pi 事件标注其 `AgentRuntimeEvent` 映射；未知事件明确 drop/trace 策略。

### E5. Session 与 Compaction

- 创建 session，完成三轮工具对话。
- 终止进程并从受控目录恢复。
- 验证上下文、工具结果和 usage 连续性。
- 触发或模拟 compaction，继续两轮。
- 验证 session 文件不进入用户默认 Pi 目录。

### E6. Abort、Timeout 与 Quiesce

- 模型流式输出时 abort。
- `run_python` 执行时 abort。
- 子代理执行时 abort。
- 达到 timeout 后检查进程、事件和文件。
- settled 后观察一个 cleanup timeout 窗口，不得继续产生模型事件或文件写入。

### E7. Steering

- 在模型输出阶段调用 `steer`。
- 在工具阶段调用 `steer/followUp`。
- 记录输入进入当前 turn、下一 turn或被拒绝的准确时点。
- 只决定底层合同，不做 UI。

### E8. Packaged Runtime

- Next standalone 构建加载 Pi ESM。
- Tauri 内嵌 Node 启动 PoC。
- ResourceLoader、extension、session dir 和 representative tools 可发现。
- 至少完成当前开发平台的安装/隔离目录 smoke。
- 三平台完整 smoke 可作为 AR14 的后续门，但必须在 findings 中列出未验证平台。

### E9. Claude 零残留预演

在临时分支或隔离副本模拟：

- 移除 Claude SDK dependency/optional dependency。
- 移除 Claude CLI 打包。
- 排除 `claude-adapter.ts` 和 SDK hooks。
- 用 Pi PoC 路径完成 typecheck/build 的最小闭环。

本实验不把删除提交进生产分支，只用于发现隐藏依赖。

## Evidence Required

每个实验必须提供：

- 结论：PASS / PARTIAL / FAIL。
- 可复现命令。
- 脱敏配置。
- 事件时间线。
- session/output 目录清单。
- 关键文件 hash 或业务断言。
- process exit/abort 状态。
- 已验证与未验证平台。
- 与现有 Finwork 合同的差异。
- 与 AS0 同一任务的行为/成本差异；不能比较的项必须解释原因。

禁止把模型“任务完成”文本作为通过证据。

## Pass Gate

全部满足才允许 AR9–AR13 生产实施：

1. 网关文本、thinking、图片、工具调用和 usage 可用。
2. 五个代表工具只用一份 handler，并通过 Zod 权威校验。
3. high-risk、always-confirm、拒绝、无 resolver、角色和路径安全语义成立。
4. Pi 事件可映射到公共事件合同，未知事件不污染 SSE/DB。
5. session 在进程重启后恢复，数据只写受控目录。
6. abort/timeout 后达到 quiesce。
7. 子代理保持隔离 session、`instanceId` 和权限。
8. 凭证不写明文配置。
9. 当前开发平台 packaged smoke 通过。
10. Claude 零残留预演没有不可替代的产品能力。

## Blockers

任一命中则阻塞生产替换：

- 网关 tool call/thinking replay 与 Pi 不兼容且无稳定 compat 配置。
- 核心工具 schema 无法表达，且 adapter 会形成第二套 schema SSOT。
- 安全闸无法覆盖 Pi 内置工具或 customTools。
- abort 后工具/子进程继续不可控写入。
- session 必须写用户默认 Pi 目录。
- API Key 必须写 Pi 明文凭证文件。
- packaged runtime 无法稳定加载 Pi。
- Claude SDK 仍承担某项没有替代控制点的必需产品能力。

命中 blocker 时先更新 findings 和架构决策，不恢复双 runtime 方案，也不把 Claude fallback
作为默认止痛措施。

## Deliverables

- `spike-pi-anthropic-replacement-findings.md`
- `scratchpad/spikes/ar10-pi-anthropic/`
- 代表工具兼容矩阵。
- Pi → `AgentRuntimeEvent` 映射表。
- Anthropic 网关 compatibility 配置。
- session/credential/packaging 结论。
- Claude 零残留预演清单。
- AR9–AR13 允许实施范围与阻塞项。

## Out of Scope

- 第二 Provider。
- Runtime 切换 UI。
- 生产 Query Pipeline 改造。
- 生产数据库迁移。
- 45 个生产注册工具全量迁移。
- 正式删除 Claude SDK。
- Steering UI。
