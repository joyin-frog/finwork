# AR3-spike：工具安全闸可行性验证结论

> 版本 v2.0 / 2026-07-10
> 状态：**静态 + 运行时实验均已跑**（E2a/E2b/E3/E3b 有定论；E1 截断未能复现，见 §3.1）。
> 运行时实验通过独立脚本直连 SDK、走应用同款本地网关（127.0.0.1:8317，gpt-5.4）完成，
> 脚本见 scratchpad/exp/exp-tool-gate.ts（临时，跑完即弃）。
> 来源：`ROADMAP-agent-runtime.md` AR3-spike。背景：想在 SDK 外层实现两个安全闸——
> ①截断闸：模型响应因 max_output_tokens 截断时阻止执行参数可能残缺的工具；
> ②垫片：参数 schema 校验前对工具入参做兼容性重写（模型把结构化参数发成 JSON 字符串时解析兜底）。
> SDK 版本：@anthropic-ai/claude-agent-sdk v0.3.x（行号引用对应主 checkout 的
> `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`，升级后重核）。

## 0. 结论速览（v2.0，含运行时实验）

| 闸 | 可行性 | 依据 |
|---|---|---|
| ②垫片（入参重写） | **确认可行，通路已验证** | 静态：`PermissionResult.updatedInput`（sdk.d.ts:2030-2042）+ hook chain 已返回 `updatedInput`（chain.ts:42）。运行时 **E2a 实证**：canUseTool 返回 `updatedInput` 后，工具实际收到的是**重写后**的参数（120/300→1120/1300），改写生效。**可直接立 AR3b-垫片实施包** |
| ②垫片的适用边界 | **对 MCP 工具"发成 JSON 字符串"场景救不了** | 运行时 **E2b 实证**：MCP 工具的 zod 校验发生在 canUseTool **之后**——canUseTool 返回的非法 `updatedInput` 被 zod 拒（MCP error -32602），返回 is_error 给模型。**推论**：若模型把参数发成 JSON 字符串，zod 会在垫片有机会介入前直接拒（垫片挂 canUseTool 层来不及）。要救此场景，垫片须挂进 **MCP 工具 handler 内部**（tool 回调入口自行宽松解析），而非 canUseTool。**AR3b-垫片方案据此定型** |
| ①截断闸 | **必要性大幅下降，且挂点受限** | ①E2b 附带证明：MCP 工具的 zod 校验是**天然截断兜底**——参数残缺（形状不符）会被 zod 拒、返回 is_error 让模型重发，不会执行。finwork 的高风险写工具（金蝶导出等）都是带 zod schema 的 MCP 工具，**已被 zod 覆盖**。②E1 未能复现截断（§3.1），"截断时 SDK 是否执行工具"仍无正面观测。③**挂点受限**：见下方 E3/E3b |
| allowedTools 绕过性（挂点关键） | **MCP 工具过闸门，内置工具绕过** | 运行时 **E3 vs E3b 实证**：MCP 工具（`exp__report_totals`）即使在 allowedTools 里**仍走 canUseTool**；但内置 **Bash** 在 allowedTools 里**完全绕过 canUseTool**（无回调日志、直接执行）。**推论**：任何挂在 canUseTool/hook chain 上的闸门对 allowedTools 里的内置工具无效；若要闸内置工具，须用 SDK 原生 PreToolUse hook 或把该工具移出 allowedTools |

## 1. 四问静态验证结果

**问① max_output_tokens 截断时 SDK 是否仍尝试执行工具**
静态不可判。类型上只有 `SDKAssistantMessageError` 含 `'max_output_tokens'` 枚举
（sdk.d.ts:2738），没有任何字段说明此时已解析出的 tool_use block 是否会进入执行。
→ 运行时实验 E1。

**问② hook 能否读到外层缓存的 stop reason**
部分可行。`stop_reason` 两处可见：`SDKResultSuccess/Error`（sdk.d.ts:3961/3931，
loop 结束才到，太晚）与 `SDKAssistantMessage.error`（sdk.d.ts:2706/2738，逐条
assistant 消息即到，claude-adapter.ts:479 已读）。外层可在 assistant 消息到达时缓存
`error === 'max_output_tokens'`，在 canUseTool 里查缓存——**前提是 SDK 总是先推
assistant 帧再触发 canUseTool**，此时序静态不可判。→ 运行时实验 E1（同一实验顺带测）。

**问③ schema 校验前是否存在统一 input rewrite 点**
已确认存在两个：`CanUseTool` 的 `PermissionResult.behavior:'allow'` 分支含
`updatedInput`（sdk.d.ts:2030-2042）；`PreToolUseHookSpecificOutput` 也含
`updatedInput` + `permissionDecision`（sdk.d.ts:2171-2176）。finwork 走前者，通路已通。
**未决小项**：MCP 工具（createSdkMcpServer 注册）的 zod 校验发生在 canUseTool 之前还是
之后，静态不可判——若在之前，垫片救不了"发成 JSON 字符串导致 zod 直接拒"的场景。
→ 运行时实验 E2。

**问④ allowedTools 自动放行的工具是否仍过闸门**
静态不可判。sdk.d.ts:1294-1300 说 allowedTools 是 "auto-allowed without prompting"，
sdk.d.ts:3822 说 "PreToolUse hook denies bypass canUseTool"（暗示 PreToolUse 与
canUseTool 是两个独立拦截层、PreToolUse 更早），但没写 allowedTools 是否跳过
canUseTool 回调本身。→ 运行时实验 E3。**若结论是"跳过"，截断闸必须挂 SDK 原生
PreToolUse hook（finwork 目前未用 SDK hooks 配置，只用 canUseTool）而非 hook chain。**

## 2. finwork 现有接线（实施 AR3b 时的挂点）

- `canUseTool`：claude-adapter.ts:244-256，直接调 `runBeforeHooks(hookChain, ...)`，
  返回形状与 `PermissionResult` 对齐（behavior + updatedInput）。
- hook chain（claude-adapter.ts:232-243）现有七环：unwiredTool → readGuard → stuckGuard
  → askUserQuestion → pathSafety → riskConfirm → timing，全在 before 流。
- SDK 原生 hooks 配置（PreToolUse/PostToolBatch 等）目前**未使用**——问④若判"绕过"，
  这是备用挂点（PreToolUse 有 updatedInput + permissionDecision，能力等价）。
- PostToolBatch（sdk.d.ts:2098-2104）只能注入 additionalContext，不能阻断/改写，
  与安全闸无关，排除。

## 3. 运行时实验结果（已跑）

实验脚本 exp-tool-gate.ts 直连 `@anthropic-ai/claude-agent-sdk` 的 `query()`，注册一个
测试 MCP 工具 `report_totals`（zod schema 要求 `items: {name, amount}[]`），
canUseTool 里打时间戳日志并按模式改写/放行。走本地网关（gpt-5.4）。

- **E2a 入参重写传播（✅ 定论）**：canUseTool 返回 `updatedInput`（把 amount 各 +1000）。
  观测：`TOOL_EXECUTED` 收到的是 1120/1300（重写后值），非原始 120/300。
  → 垫片经 canUseTool 改写**确实生效**。
- **E2b zod 校验时机（✅ 定论）**：canUseTool 把合法入参重写成非法（items 设为字符串）。
  观测：工具**未执行**，返回 `MCP error -32602 Input validation error`（zod invalid_type），
  is_error 回给模型。→ MCP zod 校验在 canUseTool **之后**；canUseTool 层的非法改写会被
  zod 拦下。**双刃**：既证明 zod 是残缺参数的兜底，也证明"发成 JSON 字符串"这类需要
  宽松化的场景，垫片挂 canUseTool 来不及（zod 会先拒），须挂 MCP handler 内部。
- **E3 MCP 工具 + allowedTools（✅ 定论）**：MCP 工具放进 allowedTools。观测：
  `CAN_USE_TOOL` 日志**照常出现**，工具经 canUseTool 后执行。→ MCP 工具不被 allowedTools
  豁免出 canUseTool。
- **E3b 内置工具 + allowedTools（✅ 定论，关键差异）**：Bash 放进 allowedTools。观测：
  Bash 执行并返回 marker，但**全程无 CAN_USE_TOOL 日志**。→ 内置工具在 allowedTools 里
  **绕过 canUseTool**。任何挂 canUseTool 的闸对 allowedTools 内置工具无效。

### 3.1 E1 截断实验：未能复现（inconclusive）

用 `CLAUDE_CODE_MAX_OUTPUT_TOKENS=120` + 诱导 60 条长描述的 prompt，跑两次，两次模型
都产出了**完整合法**的工具调用（60 条齐全、无残缺、error=null、stop_reason 正常）。
判断：该环境变量对当前网关代理模型（gpt-5.4）未生效，或被 SDK/网关钳到更大下限。
**"截断时 SDK 是否执行工具"仍无正面观测。** 若要补：需换一个真正尊重 max output 上限
的直连 provider，或在网关侧强制限流触发 stop_reason=max_tokens。但见下方——此实验的
优先级已被 E2b 结论大幅降低。

## 4. 对 AR3b 立项的建议（v2.0 定论）

1. **AR3b-垫片：立项，方案已定型**——挂点是 **MCP 工具 handler 内部**（tool 回调入口做
   宽松解析：若某字段应为 object/array 却收到 JSON 字符串，先 `JSON.parse` 再交给业务），
   **不是** canUseTool/hook chain（E2b 证明 zod 会先拒）。范围：finwork 的 MCP 工具里
   参数含嵌套结构、历史上出现过"发成字符串"的那几个（写 spec 时 grep 确认清单）。
2. **AR3b-截断闸：降级为"观察项"，暂不立实施包**——理由：①finwork 高风险写工具都是带
   zod 的 MCP 工具，E2b 证明残缺参数会被 zod 拦（天然兜底）；②E1 未能证明 SDK 截断时
   真会执行工具；③即便要做，canUseTool 里读缓存的 `SDKAssistantMessage.error` 只能覆盖
   MCP 工具，覆盖不到 allowedTools 里的内置工具（E3b）。**结论**：截断闸的边际价值不足以
   现在立项；把 stop_reason 观测挂进 AR2a 的事件合同（run_ended 带 stop_reason），日后
   若线上真出现"截断导致错误工具执行"的实例，再回头立项。
3. **附带产出给 AR2a**：`SDKAssistantMessage.error` 实时可见已被多次实证（含早前 401 的
   authentication_failed、正常轮的 null），可作为 run_ended/run_settled 的 outcome 来源。

## 附：实验原始信号（供 reviewer 复核）

| 实验 | 关键观测 | 结论 |
|---|---|---|
| E2a | TOOL_EXECUTED = 重写后值(1120/1300) | 垫片经 canUseTool 生效 |
| E2b | 非法 updatedInput → MCP error -32602，工具未执行 | zod 在 canUseTool 之后 |
| E3 | MCP 工具在 allowedTools 仍打 CAN_USE_TOOL | MCP 不被豁免 |
| E3b | Bash 在 allowedTools 执行但无 CAN_USE_TOOL | 内置工具绕过 canUseTool |
| E1 ×2 | max output 限制未触发截断，工具调用完整 | 截断未复现，inconclusive |
