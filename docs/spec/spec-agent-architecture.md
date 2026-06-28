# Spec: Agent Architecture 改造

> 状态：待审阅  
> 日期：2026-06-05  
> 范围：Phase 1（Skill/Tools/Hooks 地基）→ Phase 2（展示层）→ Phase 3（LangGraph，本文仅框架）

---

## 背景与问题

当前代码存在三个根本性断裂：

| 问题 | 位置 | 症状 |
|------|------|------|
| Skill `tools` 字段是空声明 | `skills/*/config.json` | 列出的工具名（如 `validate_reimbursement_batch`）根本不存在，`allowedTools` 也从不读取这个字段 |
| `lib/agent/tools.ts` 是孤儿代码 | `lib/agent/tools.ts` | TypeScript 业务函数永远不会被 Claude 调用，只供 API 路由直接使用 |
| Hooks 只是一个权限门卫 | `createToolPermissionHandler` | 没有 before/after 生命周期，`requiresHumanConfirm` 字段声明了但从不触发 |

---

## Phase 1：Skill + Tools + Hooks 地基修复

### 1.1 目标

- Skill 的 `tools` 字段真正控制 Claude 能用哪些工具
- 所有 Claude 可调用工具统一注册在一处，消除孤儿代码
- `requiresHumanConfirm` 和 `riskLevel: "high"` 真正触发拦截行为
- 新增 `before_tool` / `after_tool` 生命周期钩子

---

### 1.2 工具注册统一化

#### 设计方案

建立单一工具注册表，所有工具（MCP 或原生）都在这里声明：

```
lib/agent/
  tools/
    registry.ts         ← 统一注册表，导出 ALL_TOOLS
    built-in.ts         ← Read/Write/Bash 等 SDK 内置工具的元数据描述
    finance/
      reimbursement.ts  ← validate_reimbursement_batch 等
      tax.ts            ← tax_calculator
      excel.ts          ← inspect_excel_workbook, generate_excel_report
      python.ts         ← run_python
      policy.ts         ← read_expense_policy
      ppt.ts            ← generate_ppt
  mcp-server.ts         ← 把 registry 里的 finance tools 注册为 MCP server
```

**工具元数据结构**：

```typescript
type ToolDefinition = {
  name: string
  description: string
  category: "builtin" | "finance" | "system"
  riskLevel: "safe" | "medium" | "high"   // safe=只读, medium=生成文件, high=写外部系统
  handler?: ToolHandler                    // finance 工具有 handler，builtin 工具无需
}
```

#### 处理现有孤儿工具

`lib/agent/tools.ts` 中的三个函数当前只被 API 路由调用，Claude 不可见：

- `validateReimbursementBatch` → 对应 Skill 配置中的 `validate_reimbursement_batch`
- `calculatePayroll` → 可与 Python 的 `tax_calculator` 共存
- `exportKingdeeDraft` → 对应 `kingdee-draft` flow

**⚠️ 需要你决策 — 选项 A/B/C：**

> **选项 A（推荐）：TS 函数升级为 MCP tool**  
> 把这三个函数包装成 MCP 工具注册进 `finance_worker`。好处：Claude 可以直接调用精准的 TS 业务逻辑，不需要绕道 Python。  
> 代价：需要给每个函数定义 Zod input schema。
>
> **选项 B：只保留 API 路由调用，Claude 不可见**  
> 这些函数继续服务 `/api/reimbursements/validate` 等路由，但 Claude 用 `run_python` 或 Python `tax_calculator` 完成同类任务。  
> 代价：TS 和 Python 两套实现长期并存，逻辑可能漂移。
>
> **选项 C：删除 Python 的重复实现，只保留 TS**  
> 删掉 `mcp-tools/finance-tools.ts` 里的 `tax_calculator`，全部用 TS 版本。  
> 代价：Python worker 的灵活性（任意 pandas/openpyxl 逻辑）无法替代，不建议完全删除。

---

### 1.3 allowedTools 动态化

**当前**：`claude-adapter.ts` 硬编码 10 个工具名，Skill `tools` 字段从不读取。

**目标**：运行时根据启用 Skill 动态计算。

```typescript
// 基础集：始终可用，只读无副作用
const BASE_TOOLS = ["Read", "Glob", "Grep", "AskUserQuestion"]

// 从启用的 skills 收集工具声明
function resolveAllowedTools(enabledSkills: ManagedSkill[]): string[] {
  const skillTools = enabledSkills.flatMap(s => s.tools)
  return [...new Set([...BASE_TOOLS, ...skillTools])]
}
```

**Skill config.json 的 `tools` 字段需要同步修正**：

| Skill | 当前 tools（错误） | 修正后 tools |
|-------|-------------------|-------------|
| reimbursement-check | parse_reimbursement_table, validate_reimbursement_batch, generate_reimbursement_sheet | validate_reimbursement_batch, Read, Write（视选项 A/B 调整） |
| payroll-calc | （待查） | tax_calculator, Read |
| excel-finance | （待查） | inspect_excel_workbook, run_python, Read, Write |
| finance-analysis | （待查） | Read, Glob, WebSearch, run_python |
| kingdee-draft | （待查） | exportKingdeeDraft, Read |

**⚠️ 需要你决策 — 安全边界策略：**

> **选项 X（严格）：只有 BASE_TOOLS + skill 声明的工具可用**  
> Bash 默认不在 BASE_TOOLS 里，必须某个 skill 显式列出才能用。最安全，但 Claude 灵活性降低。
>
> **选项 Y（宽松）：BASE_TOOLS + 默认扩展集 + skill 增量**  
> 默认扩展集包含 `Bash`、`WebSearch`、`WebFetch`。Skill 可以额外添加，不能减少。当前行为接近此选项。

---

### 1.4 Hooks 生命周期

**设计**：在 `canUseTool` 基础上扩展为完整的 before/after 钩子。

```typescript
type ToolHookContext = {
  toolName: string
  input: unknown
  activeSkills: ManagedSkill[]    // 当前启用的 skills
  outputDir: string
}

type BeforeToolResult =
  | { action: "allow"; input?: unknown }      // 放行（可修改 input）
  | { action: "deny"; reason: string }        // 拒绝执行
  | { action: "confirm"; prompt: string }     // 暂停，等用户确认

type AfterToolContext = ToolHookContext & {
  result: string
  isError: boolean
  durationMs: number
}
```

**内置 Hook 逻辑**：

```
before_tool:
  1. 路径安全检查（Write/Edit 只能写 outputDir）         ← 现有逻辑
  2. AskUserQuestion 代理                                ← 现有逻辑
  3. riskLevel="high" 的工具 → 触发 confirm              ← 新增
  4. skill.requiresHumanConfirm=true + 非只读工具 → confirm  ← 新增
  5. 工具不在 allowedTools 里 → deny                     ← 新增（现在缺失）

after_tool:
  1. 记录执行耗时到 onAgentEvent                         ← 新增
  2. isError=true → 记录到 audit_log                     ← 新增
```

**⚠️ 需要你决策 — Hook 扩展性：**

> **选项 P（简单）：before/after 写死在 `createToolPermissionHandler` 里**  
> 够用，易理解，改动最小。学习 agent 开发时先走这条路。
>
> **选项 Q（可插拔）：Hook 做成数组，支持多个 handler 串联**  
> ```typescript
> type HookChain = Array<{
>   name: string
>   before?: (ctx) => Promise<BeforeToolResult>
>   after?: (ctx) => Promise<void>
> }>
> ```
> 适合后续加 LangGraph 时把 graph node 注入为 hook。稍微复杂，但为 Phase 3 铺路。

---

### 1.5 执行步骤

```
Step 1: 建 lib/agent/tools/ 目录，把现有 mcp-tools/ 内容迁移重组
  验收：mcp-server 导入新路径后，所有 MCP 工具仍正常响应

Step 2: 给 ToolDefinition 加 riskLevel，更新工具元数据
  验收：registry.ts 能 export 完整工具列表，包含 riskLevel

Step 3: 实现 resolveAllowedTools，替换 claude-adapter.ts 里的硬编码列表
  验收：启用/禁用 skill 后，Claude 的可用工具集发生变化（可通过日志确认）

Step 4: 修正 5 个 skill 的 config.json tools 字段（对应实际存在的工具名）
  验收：skill tools 字段里每个名字都能在 registry 里找到对应 ToolDefinition

Step 5: 扩展 canUseTool → before_tool，加 riskLevel 拦截和 requiresHumanConfirm 逻辑
  验收：调用 riskLevel="high" 工具时前端收到 confirm 事件（即使暂时只打 log）

Step 6: 加 after_tool，记录耗时和 isError 到 onAgentEvent
  验收：每个工具调用结束后，前端 timeline 收到含 durationMs 的事件

Step 7: 处理 lib/agent/tools.ts 孤儿函数（按选项 A/B/C 执行）
  验收：Claude 调用 validate_reimbursement_batch 得到正确结果（如选 A）
```

### 1.6 验收目标（Phase 1 整体）

- [ ] 关闭所有 skill 后，Claude 只能用 BASE_TOOLS
- [ ] 开启 `excel-finance` skill，Claude 能调用 `run_python` 和 `inspect_excel_workbook`
- [ ] `riskLevel: "high"` 的工具调用被拦截，前端能感知（confirm 或 deny）
- [ ] `requiresHumanConfirm: true` 的 skill 触发写操作时，弹出确认
- [ ] `lib/agent/tools.ts` 不再是孤儿（要么 MCP 注册，要么删除）
- [ ] 无任何工具名在 config.json 里列出却不存在于 registry

---

## Phase 2：展示层重构

### 2.1 目标

- ToolCards 从"原始数据 dump"变成"可读步骤"
- 运行中（pills）和运行后（cards）统一为同一组件，消除视觉跳变
- 修复 `linkKnownFiles` 的误替换 bug
- `ChatPage` 的状态做最小拆分，降低维护成本

---

### 2.2 工具调用展示重设计

**核心思路**：每个工具有一个 `summary` 函数，把 input/output 转成一句人话。展开才看原始数据。

```typescript
// lib/agent/tools/renderers.ts
type ToolRenderer = {
  summary(input: unknown, result?: string, isError?: boolean): string
}

const renderers: Record<string, ToolRenderer> = {
  Read:                    { summary: (i) => `读取 ${shortPath((i as any).file_path)}` },
  Write:                   { summary: (i) => `写入 ${shortPath((i as any).file_path)}` },
  Bash:                    { summary: (i) => `执行命令` },
  WebSearch:               { summary: (i) => `搜索「${(i as any).query}」` },
  inspect_excel_workbook:  { summary: (i) => `分析工作簿 ${(i as any).file_path}` },
  run_python:              { summary: (_, r) => `Python 执行，生成 ${parseFileCount(r)} 个文件` },
  tax_calculator:          { summary: (_, r) => `税务计算：${parseTaxLine(r)}` },
  validate_reimbursement_batch: { summary: (_, r) => `报销校验：${parseWarningCount(r)} 条异常` },
  AskUserQuestion:         { summary: (i) => `询问用户：${(i as any).questions?.[0]?.question}` },
}
```

**新组件 `ToolCallStep`**（替换 ToolCallPills + ToolCards）：

```
[状态图标] 工具名称 · 摘要文字            [耗时]
           └── [展开] 输入 / 输出原始内容
```

- 运行中：旋转图标 + 工具名（摘要还不可用）
- 完成：✓ 图标 + 摘要
- 错误：✗ 图标 + 错误摘要（红色）
- 展开内容：输入用 JSON 高亮，输出根据类型格式化（表格数据 → 表格，纯文本 → pre）

**before_tool confirm 事件的展示**：在 ToolCallStep 里增加一种状态：

```
[⚠] run_python · 需要确认才能执行
    [确认执行]  [取消]
```

---

### 2.3 文件 bug 修复

`linkKnownFiles`（`chat-page.tsx:1144`）当前用正则把消息文本里的文件名无差别替换为链接，会误替换代码块内容。

**修复方案**：在 `ReactMarkdown` 的 `code`/`pre` 组件里不做链接化，而不是对全文做正则替换。或者把 `linkKnownFiles` 改为只在非代码区段运行（需要先解析 markdown token 树）。

**⚠️ 需要你决策：**

> **选项 R（简单修复）**：在 `linkKnownFiles` 里跳过被反引号或三引号包裹的区段。用正则排除即可，不完美但够用。  
>
> **选项 S（彻底修复）**：不在 `linkKnownFiles` 里处理，改为在 `ReactMarkdown` 的 `text` 节点 renderer 里做替换（只会作用于实际文本节点，天然跳过代码块）。需要自定义 `remarkPlugin` 或 `rehypePlugin`，改动稍大但干净。

---

### 2.4 ChatPage 状态拆分

不做全面重构，只做**最小拆分**：

```
ChatPage（保留路由、对话管理、文件上传逻辑）
  └── ConversationPane（消息列表渲染、streaming 状态）
        ├── AssistantMessage（单条 assistant turn，含 ToolCallStep 列表）
        └── UserMessage（用户气泡）
  └── MessageInputArea（输入框、附件 tray、@mention）
```

把 40+ useState 中与"当前流式消息"相关的状态（`activeTimeline`、`thinkingContent`、`isStreaming`、`processedEndedAt`）集中为一个 `streamingState` object，用 `useReducer` 管理。

---

### 2.5 执行步骤

```
Step 1: 创建 lib/agent/tools/renderers.ts，实现已有工具的 summary 函数
  验收：每个工具名对应一条人类可读摘要，测试覆盖 Read/Bash/run_python/tax_calculator

Step 2: 创建 ToolCallStep 组件，支持 running/done/error/confirm 四种状态
  验收：组件独立渲染正确（Storybook 或手动测试）

Step 3: 替换 AssistantTurn 内的 ToolCallPills + ToolCards → ToolCallStep 列表
  验收：运行中和运行后视觉一致，工具名显示摘要而非原始 JSON

Step 4: 修复 linkKnownFiles（按选项 R 或 S）
  验收：代码块内出现文件名不被链接化

Step 5: streaming 状态用 useReducer 集中
  验收：ChatPage useState 数量减少（目标：从 40+ 降到 30 以下）
```

### 2.6 验收目标（Phase 2 整体）

- [ ] 工具调用显示"读取了 财务报表.xlsx"而非原始 JSON
- [ ] 运行中和运行后工具列表视觉一致，无跳变
- [ ] 代码块内文件名不被误链接
- [ ] `requiresHumanConfirm` 触发后，前端工具卡片上出现确认按钮
- [ ] ChatPage 文件行数 < 900 行（当前 1422）

---

## Phase 3：LangGraph 接入（框架）

> 本阶段在 Phase 1 完成后再细化 spec。

**架构方向**：Python FastAPI 服务承载 LangGraph 图，Next.js 通过新 API 路由 `/api/agent/graph` 调用，SSE 流式返回 graph 执行事件。

**核心学习目标**：
1. `StateGraph` + `ToolNode` — 把 Phase 1 的工具注册表迁移为 graph tools
2. `conditional_edge` — 根据工具执行结果决定下一步（RAG 检索 → 分析 → 生成）
3. `interrupt` — 对应 Phase 1 的 `requiresHumanConfirm`，在 graph 层实现 human-in-the-loop
4. RAG node — 向量检索作为普通 graph node 接入，配合 LanceDB

**与现有架构的关系**：
- Phase 1 建立的 tool registry 可以直接用作 LangGraph 的 tool 定义
- Phase 2 的 `ToolCallStep` 组件通过增加 `graph_node` 事件类型来展示 graph 执行流
- Claude Agent SDK 暂时并存，新对话走 LangGraph，旧历史保持可读

---

## 待定决策汇总

| # | 问题 | 选项 | 影响范围 |
|---|------|------|---------|
| 1 | financeTools 孤儿处理 | A（升级为 MCP）/ B（保持 API only）/ C（删 Python 重复） | Phase 1 Step 7 |
| 2 | allowedTools 安全策略 | X（严格，Bash 需 skill 声明）/ Y（宽松，默认含 Bash） | Phase 1 Step 3 |
| 3 | Hook 扩展性 | P（写死）/ Q（可插拔 chain） | Phase 1 Step 5，影响 Phase 3 兼容性 |
| 4 | linkKnownFiles 修复 | R（正则跳过）/ S（rehype plugin） | Phase 2 Step 4 |
