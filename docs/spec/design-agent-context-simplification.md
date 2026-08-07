# Finwork Agent 上下文精简设计

> 版本：v1.0
> 日期：2026-07-29
> 状态：Decision Approved / Implementation Not Started
> 范围：System Prompt、Skills、工具目录与模型可见上下文
> 关联架构：`design-pi-agent-runtime.md`
> 原则：与 Pi 迁移一起设计、分阶段实施；先可比，再精简

## 1. 结论

Finwork 希望采用与 Pi 一致的简洁思路：核心提示更小、领域能力渐进披露、工具职责准确、
确定性规则尽量由代码保证。

这项工作不能简单地全部塞进 Runtime 迁移，也不应等 Pi 发布后才开始考虑。最终节奏是：

1. **迁移前建立基线和职责归属**。
2. **迁移中只做结构性收口，保持行为语义等价**。
3. **Pi 主链稳定后实施语义精简**。
4. **在 Pi-only 发布门验证“更小且更准”，而不是只验证 token 变少**。

如果同时替换 Runtime、删除工具、重写 Skill 和缩短 system prompt，出现行为变化时无法归因。
因此迁移 diff 与精简 diff 必须分工作包、分提交、分评测结果。

## 2. 设计原则

### 2.1 简洁不等于短

精简目标不是机械减少字符，而是：

- 每条规则只有一个权威所有者。
- 模型只在需要时看到领域知识和工具。
- 描述能准确区分相似能力。
- 安全与确定性约束不依赖模型“记住”。
- 删除内容后有评测证明能力未下降。

### 2.2 单一所有权

| 内容 | 唯一所有者 | 不应出现的位置 |
|---|---|---|
| 身份、总目标、全局优先级 | System Prompt | 每个 Skill/工具重复 |
| 领域工作流、SOP、示例 | Skill | System Prompt |
| 工具用途、输入、输出、调用边界 | Tool Definition | 长篇 Skill 重复参数说明 |
| 风险、权限、路径、幂等、确认 | Code / Hook / ToolPolicy | 依赖 prompt 自律 |
| 用户、公司、时间、文件、记忆、输出目录 | Dynamic Context | 静态 System Prompt |
| 完成证据与交付质量 | TaskContract / CompletionGate | 模型口头宣称 |

### 2.3 渐进披露

目标上下文层次：

```text
小型 Core System Prompt
  ├─ 当前任务动态上下文
  ├─ 精简的 Skill listing
  │    └─ 按需加载 Skill 正文/reference/script
  └─ 当前角色/任务允许的工具子集
       └─ Tool schema + concise description
```

禁止默认把完整 Skill 正文、全部领域 SOP 和全部工具 schema 塞入每一轮。

## 3. 当前事实

### 3.1 System Prompt

当前 `lib/agent/system-prompt.ts` 已区分：

- A 段：静态前缀。
- B 段：Claude SDK dynamic boundary。
- C 段：记忆、日历、反馈、输出目录和公司画像等动态内容。

Skill 已不再全文注入 System Prompt，这是应保留的方向。迁移问题是 B 段依赖 Claude SDK，
内容问题则是 A/C 段与 Skill/tool description 是否存在重复；两者必须分开处理。

### 3.2 Skills

当前 Skill loader 已采用渐进加载：

- listing 只暴露 name + description。
- 正文和 scripts 按需加载。
- 内置/用户目录由 Finwork 管理。
- ambient 用户目录被隔离。

Pi 迁移应保留这些产品语义，只替换 Claude plugin 配置为 Pi `ResourceLoader`。

### 3.3 Tools

生产 `buildFinanceMcpServers()` 当前注册：

- finance worker：34 个。
- kingdee worker：11 个。
- 合计：45 个生产工具。

同时，`TOOL_REGISTRY` 当前只登记 44 个财务工具，漏了生产已创建的
`export_voucher_list`。AS0 将其冻结为迁移前既存差异；AS1/AR11 统一生产目录、风险元数据
和 Provider 暴露集合，迁移评测不得把该差异误判为 Pi 回归。

工具 registry 当前让模型看到全部已登记财务工具，并主要依赖 Skill 描述指导选择。这会带来：

- 工具 schema token 固定成本。
- 相近工具之间的选择噪声。
- Skill、工具描述和 System Prompt 重复解释。
- 角色/任务不相关工具也进入当前上下文。

全目录另有一个未被生产入口引用的 Kingdee 旧工具工厂；AS1 决定删除或重新接线，不计入
45 个迁移基线。

## 4. 迁移前基线：AS0

AS0 必须在 AR10 发起真实 PoC 前完成，避免迁移后失去可比较的 Claude 基线。

### 4.1 Golden Task Set

建立 15–20 个脱敏、可重复任务，至少覆盖：

1. 闲聊/简单解释，不应调用工具。
2. 知识检索与文档读取。
3. Excel/文档处理 Skill。
4. 报销审核。
5. 工资计算。
6. 发票/应收查询。
7. 银行对账。
8. 单据到凭证批处理。
9. 高风险写入与用户拒绝。
10. 子代理与批跑。
11. 复杂文件交付与 CompletionGate。
12. 错误输入、缺文件、缺环境和中断恢复。

每个任务固定：

- 输入/附件 fixture。
- 允许使用的业务事实。
- 预期工具或明确“不应调用工具”。
- 关键业务断言。
- 风险确认预期。
- 最终交付/质量证据。

### 4.2 基线指标

记录：

| 维度 | 指标 |
|---|---|
| 上下文成本 | 静态 prompt tokens、动态 tokens、Skill listing tokens、工具 schema tokens |
| 选择准确性 | 首次工具命中率、错误工具调用数、无效重试数 |
| Skill | 正确触发率、漏触发率、误触发率、正文加载次数 |
| 执行 | 总 turn、LLM call、tool call、耗时、abort 后残留 |
| 业务质量 | golden assertions、CompletionEvidence、交付文件校验 |
| 安全 | 误放行、误拦截、确认次数、角色/路径越界 |
| 稳定性 | session 续聊、compaction、错误归一化、packaged smoke |

成本下降不能抵消业务准确性、安全或交付质量下降。

### 4.3 资产清单

为每条 System Prompt 规则、每个 Skill、每个工具建立清单：

```text
id
owner
purpose
source
runtimeSpecific
duplicates
goldenTasks
decision: keep | move | merge | delete | investigate
```

AS0 只分类和测量，不实施大规模删除。

AS0 的可执行合同、20 个任务、fixture、指标和证据格式见
`as0-agent-context-baseline.md` 与 `fixtures/as0-golden-tasks.v1.json`。

## 5. 迁移中结构收口：AS1

AS1 与 AR9/AR11/AR12 协同，但必须保持语义等价。

### 5.1 System Prompt

允许：

- 移除 Claude `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`。
- 将 cache boundary 替换为 Pi 实际支持的结构。
- 把 `RoleMode` 等 Claude 命名泛化。
- 保留静态/动态分层。
- 保持 `SYSTEM_PROMPT.md` 作为可编辑 SSOT。

禁止：

- 同时删除大段业务规则。
- 改变角色职责或交付标准。
- 把动态公司/文件/记忆重新放进静态提示。

### 5.2 Skills

允许：

- Claude plugin loader → Pi `ResourceLoader`。
- 保留 Finwork 内置/用户/角色白名单和 ambient 隔离。
- 为 Pi 加载要求调整 metadata 格式。

禁止：

- 迁移时合并多个业务 Skill。
- 重写 SOP。
- 删除脚本或 reference。
- 以 Pi ambient Skills 替代 Finwork SSOT。

### 5.3 Tools

允许：

- `sdk.tool()`/MCP 注册 → `FinanceToolDefinition` → Pi `customTools`。
- canonical id、risk、roles、schema、handler、audit metadata 中立化。
- 删除确认无生产引用且无产品价值的孤立旧工厂。
- 为 Pi schema 表达做最小机械适配。

禁止：

- 迁移时合并业务动作。
- 改变工具风险等级。
- 改变 handler 业务计算。
- 因描述看起来冗长就直接删语义。

AS1 的通过标准是同一 golden task 在旧基线与 Pi 路径上的业务断言、安全和交付等价。

## 6. Pi 稳定后的语义精简：AS2

AS2 已在 AR12 Pi 生产主链通过、AR13 Claude SDK 删除后执行。当前实现完成并进入
AR14/AS3 验收；完整 20-case golden 和发布矩阵通过前，不把 AS2 标为发布完成。

### 6.1 Core System Prompt 目标

只保留：

- Agent 身份与职责。
- 指令优先级和外部上下文不可信边界。
- 何时加载 Skill、何时调用工具。
- 不编造数据、金额和交付结果。
- CompletionGate/交付要求。
- 必要的回答风格。

下沉：

- 财务领域 SOP → Skills。
- 工具参数和选择细节 → Tool Definition。
- 风险确认 → Code/ToolPolicy。
- 文件/公司/日期/记忆 → Dynamic Context。

不预先规定任意 token 数字；先以 AS0 基线和评测确定可接受预算。

### 6.2 Skill 精简目标

每个 Skill 入口回答四件事：

1. 什么时候使用。
2. 什么时候不要使用。
3. 需要什么输入。
4. 成功完成的证据是什么。

正文设计：

- 入口简短。
- 详细制度、示例和边界进入 references。
- 确定性操作进入 scripts。
- 删除与 System Prompt、Tool Definition 重复的内容。
- 相似 Skill 只有在 golden tasks 证明选择更准确时才合并。

### 6.3 工具精简目标

优先级：

1. 按角色、Skill、任务阶段暴露工具子集。
2. 删除未接线和已被替代工具。
3. 用批处理工具覆盖高频碎片调用。
4. 合并业务动作相同、只是粒度不同的工具。
5. 缩短 description，保留调用条件、关键输入和结果。
6. Schema 字段描述只写消歧所需信息。

工具减少不是目标本身。若两个工具分开能显著提高选择准确性，就应保留。

## 7. 变更纪律

每个 AS2 实验只改变一个维度：

- System Prompt。
- Skill。
- Tool exposure。
- Tool description/schema。
- Tool merge/delete。

不得在同一实验同时改变多个维度。每次记录：

- before/after 内容和 token。
- 受影响 golden tasks。
- 指标变化。
- 回归与收益。
- keep/revert 决策。

迁移提交和语义优化提交不得混合。发现 Runtime bug 时回到 AR 工作包修复；发现 prompt/Skill/
tool 选择问题时进入 AS 工作包，不用 runtime 兼容垫片掩盖。

## 8. 工作包

| ID | 工作包 | 依赖 | 产出 | 状态 |
|---|---|---|---|---|
| AS0 | 上下文基线与职责清单 | 无 | golden tasks、token/质量基线、资产清单 | **已完成** |
| AS1 | 结构中立化 | AR10；与 AR9/AR11/AR12 协同 | Pi loader/tool/prompt 结构，行为等价证据 | **已完成** |
| AS2 | Pi-native 语义精简 | AR12、AR13、AS1 | 精简 prompt、Skills、工具暴露/目录，逐项评测 | **实现完成，验收中** |
| AS3 | 精简发布门 | AS2 | before/after 报告、回归结论、预算与准确率门 | **进行中；并入 AR14** |

关键路径：

```text
AS0 基线 ──→ AR10 PoC
   │              │
   └────→ AR9 / AR11 / AR12 + AS1 结构中立化
                                  │
                                  ▼
                           AR13 删除 Claude
                                  │
                                  ▼
                           AS2 语义精简
                                  │
                                  ▼
                           AR14 / AS3 发布门
```

## 9. 完成定义

1. System Prompt、Skill、Tool、Code、Dynamic Context 的职责无关键重复。
2. Core System Prompt 只保留全局不变量。
3. Skills 维持渐进披露，入口短、触发边界清晰、脚本/reference 按需加载。
4. 模型不再默认看到与当前角色/任务无关的全部工具。
5. 工具目录、description 和 schema 无已知重复/孤立项。
6. 安全、权限、路径、幂等和确认均由代码合同保证。
7. AS0 与 AS2 有可复现 before/after 数据。
8. Golden tasks 的业务质量、安全和交付不下降。
9. 上下文成本、错误工具调用或无效 turns 至少一项有可量化改善。
10. Pi-only packaged smoke 通过。

## 10. 不做清单

- 为追求更短而删除安全/质量合同。
- 迁移 Pi 时顺手重写全部 Agent 行为。
- 把所有领域知识塞回 System Prompt。
- 把所有工具默认暴露给每个角色和任务。
- 用 prompt 代替权限、安全、路径和幂等代码。
- 没有 golden task 证据就合并工具或 Skills。
- 为减少工具数把不同行为硬塞进一个巨型工具。
- 让 Pi/Claude 差异和 prompt/Skill/tool 优化出现在同一不可归因 diff。
