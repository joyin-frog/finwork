# Spec: 可追溯计算回执（CalcReceipt）

## 背景与目标

财务对黑盒数字零容忍：agent 给出的任何数字必须扛住三连问——**从哪来 / 怎么算 / 为什么这么处理**。可追溯性不是锦上添花，是合规基础设施（对齐 CLAUDE.md 红线 2 数值正确、红线 3 信任链、红线 8 审计落点）。

本 spec **不是新功能**，而是给所有已有计算功能装一个统一的"可追溯"底座。现状是单点已实现、全域未统一：

- `lib/domain/tax-cumulative.ts` 的 `CumulativePayrollResult.detail` 已带 `formula` / 参数 / `taxConfigVersion`——这是现成的回执原型，本 spec 把它标准化推广。
- `app/components/payroll-result-card.tsx:62-72` 的 `<details>/<summary>` 折叠"计算过程"——这是现成的下钻 UI 模式，复用到通用卡片。
- `lib/agent/tool-event-tracker.ts:18` 的 `structured` 字段已全程贯通到前端（`chat-types.ts:64` → `tool-call-step.tsx:141` 的 `ToolResultCard`），无需改通路。

**一句话验收**：用户对话里看到的任何财务数字，都能 3 秒点开看到"从哪来 / 怎么算 / 按哪版口径 / 是不是终值"，且金额绝不因浮点或采样而错。

## 现状扩展点（来自代码调研）

| 层 | 现状缺口 | 文件:行 |
|---|---|---|
| Domain | `RatioResult` 只有 `value`，无 formula/参数 | `lib/domain/financial-ratios.ts:5` |
| Domain | 对账有溯源行号但无计算步骤 | `lib/domain/reconciliation.ts`（`ReconResult`） |
| Domain | 报销有 `warnings` 但无结构化规则命中 | `lib/domain/reimbursement.ts`（`ReimbursementItem[]`） |
| Domain | 薪税已有 detail，需补 source/状态/asOf | `lib/domain/tax-cumulative.ts:54-67` |
| MCP 工具 | `tax_calculator` 返纯文本，计算明细被压平，无 `structuredContent` | `lib/agent/mcp-tools/finance-tools.ts:100-129` |
| 事件通路 | `structured` 字段已贯通，**无需改** | `lib/agent/tool-event-tracker.ts:18` |
| 卡片 UI | `<details>` 折叠公式模式已实现（薪税），可抽成通用卡片 | `app/components/payroll-result-card.tsx:62-72` |
| Provenance | 只追"来源"，可选扩展到"计算步骤" | `app/chat/provenance.ts:46` |
| 精度 | 对外接口是 `number`（元，JS 浮点），无 Decimal/money 类型；`numeric-check` 仅做事后校验 | `lib/safety/numeric-check.ts:11` |

## CalcReceipt 数据契约

字段直接对齐数据可信度四标签（结算状态 / 口径版本 / 合规标记 / 精度规格）与三连问：

```ts
interface CalcReceipt {
  value: number;            // 展示用元；内部计算一律整数分
  unit: "CNY";              // 金额必带单位元数据，万元/千元只在展示层单向转换
  rounding: "half_up" | "bankers"; // 舍入规则显式声明，不靠语言默认
  steps: CalcStep[];        // 怎么算：逐步公式 + 输入 + 小计
  source: CalcSource[];     // 从哪来：原始文件 / 单元格 / 发票号 / 记录数
  basis: {
    caliberVersion: string;        // 口径/费率版本（如 tax-config 版本号）
    settlementStatus: "draft" | "closed" | "filed"; // 结算状态，草稿绝不当终值
    asOf: string;                  // 时点（会计期间），取当期适用口径
  };
  caveats?: string[];       // 为什么这么处理 / 不确定点 / 降级措辞
}

interface CalcStep { label: string; expr: string; inputs: Record<string, number | string>; subtotal: number; }
interface CalcSource { file?: string; ref?: string; recordCount?: number; }
```

## 功能清单

### 功能 1：CalcReceipt schema + money 精度纪律（P0，轻）✅ 已完成（验证通过：money.test.ts / receipt.test.ts 绿，scope 干净，tax-cumulative 产出标准 CalcReceipt）

**做什么**：定义全域通用回执类型 + 整数分金额工具，作为所有 domain 计算函数的标准输出信封。

**核心逻辑**（纯代码，零 LLM）：
- `lib/domain/receipt.ts`：`CalcReceipt` 类型 + 构造器/校验器。
- `lib/domain/money.ts`：整数分存储；`sum(round) ≠ round(sum)` 的尾差调整助手（先加总再舍，或差额补最后一项）；单位转换仅展示层、单向、不回流计算。

**关键业务规则**：金额一律整数分，禁止浮点；舍入规则随回执显式声明（默认四舍五入，税法法定节点按规定）；明细之和必须等于合计（1 分容差由尾差补足）。

**MVP 范围**：定 schema + money，并把 `tax-cumulative` 现有 `detail` 改造成 `CalcReceipt` 作为第一个样板。不动其他 domain。

**Done when**：`receipt.ts` / `money.ts` 落地并测试通过；`tax-cumulative` 产出标准 `CalcReceipt`；尾差/整数分/舍入测试齐全。

### 功能 2：domain 函数产出回执（retrofit 三条高频链路）（P0，中）✅ 已完成（验证通过：薪税/对账/报销均产出 CalcReceipt，21 新断言 + 回归全绿，scope 干净；money 纪律 OK——domain 无新增 JS 浮点算术）

**做什么**：让高频、高错误成本的计算函数都吐 `CalcReceipt`。

**核心逻辑**（确定性，LLM 不碰算术）：
- 薪税（`tax-cumulative.ts`）：补齐 `source` / `settlementStatus`（接 `payroll_records` 的 draft/confirmed）/ `asOf`。
- 对账（`reconciliation.ts`）：每笔勾对生成 `steps`（银行行↔账面行 + 差额），`source` 带行号。
- 报销（`reimbursement.ts`）：`warnings` 升级成结构化规则命中（命中哪条标准 + 阈值 + 实际值）。
- 财务指标（`financial-ratios.ts`）缓做——经营分析错误成本低，优先级靠后。

**关键业务规则**：口径版本（报销标准/税率）从配置取并记进 `caliberVersion`，不写死；草稿数 `settlementStatus=draft` 必须标出，绝不当终值。

**MVP 范围**：薪税补全 + 对账 + 报销三条；指标、kingdee 凭证下一轮。

**Done when**：三个 domain 模块返回 `CalcReceipt`；旧调用点适配；golden/单元测试通过。

### 功能 3：MCP 工具统一信封 + structuredContent 透传（P0，中）✅ 已完成（验证通过：tax_calculator/对账/报销带 structuredContent，settlementStatus 真实接 payroll_records，PII 脱敏，F3 8/8 绿。修复了一处"双真相"——VAT/CIT 一度在 TS 重算，已改为 Python 单一计算路径 + F3-T8 parity 断言钉死 content==structuredContent）

**做什么**：把 domain 回执通过 SDK `structuredContent` 送到前端，堵上"纯文本工具"漏洞（`tax_calculator` 等返 Python 纯文本，回执被压平）。

**核心逻辑**：相关 MCP 工具返回 `{ content（给模型读的叙述摘要）, structuredContent: CalcReceipt }`。事件通路已贯通，只需让更多工具登记结构化输出。

**关键业务规则**：`content` 可叙述压缩，但数值结论必须来自 `structuredContent` 的确定性回执，LLM 不得心算；含敏感字段的 source 在工具层用 `lib/safety/pii` 脱敏后再进 `content`（红线 7：脱敏在数据出站前，不靠模型自觉）。

**MVP 范围**：覆盖功能 2 retrofit 的三条链路对应工具。

**⚠️ 从功能 2 转移来的义务**：薪税 `settlementStatus` 的真实接线在功能 2 被下推到工具层——本功能必须让薪税工具读取 `payroll_records` 的真实 draft/confirmed 状态并透传给 `calculateCumulativePayroll(settlementStatus)`，否则草稿数永远标 draft、确认后不会升级。

**Done when**：对应工具结果带齐 `structuredContent`；集成测试断言字段完整 + 敏感字段已脱敏。

### 功能 4：通用回执卡片 UI（复用 payroll `<details>` 模式）（P0，中）✅ 已完成（验证通过：app/components/receipt-card.tsx 复用 validateCalcReceipt + payroll 折叠模式，草稿红线横幅到位，design-compliance 6/6 绿，e2e 新增 tax_calculator 回执卡用例绿，人工 verify 通过）

**做什么**：一个可复用的"计算回执卡片"，任何带 `CalcReceipt` 的结果都能渲染成可下钻明细。

**核心逻辑**：抽 `payroll-result-card.tsx:62-72` 的折叠模式成通用 `app/components/receipt-card.tsx`，渲染 `steps`（怎么算）/ `source`（从哪来）/ `basis`（口径+状态+时点）/ `caveats`；经现有 `ToolResultCard`（`tool-call-step.tsx:141`）分发挂载。

**关键业务规则**：草稿数在卡片上显著标注"未结账/会变"；金额展示用元、内部整数分；界面不出现 token/置信度等 AI 术语，用财务语言。

**MVP 范围**：渲染 `CalcReceipt` 全字段 + 折叠；不做导出/打印。

**Done when**：卡片渲染全字段；e2e（`e2e/mock` playwright）+ `design-compliance` 测通过；人工 verify 一条真实链路。

### 功能 5（可选，P2）：provenance 扩展 + 检查清单挂载点

把 `provenance.ts` 从"只追来源"扩到也能挂"计算步骤"，并为第二梯队"检查清单引擎"预留挂载点。仅留接口，不实现检查清单本身。信息不足前不展开。

## 功能依赖关系

```
功能1 (CalcReceipt + money)  ← 地基，先做
   ├─► 功能2 (domain 产出回执)
   │       └─► 功能3 (MCP structuredContent 透传)
   │               └─► 功能4 (回执卡片 UI)   ← 闭环在此完成
   └─► 功能5 (provenance 扩展，可选，旁挂)
```

1 → 2 → 3 → 4 是必须顺序链（类型→产出→传输→渲染）；5 独立旁挂。

## 执行约定

**分层测试策略**：
- 功能 1、2（确定性计算核心，错误成本最高）：**严格 TDD**（红-绿-重构）。先写会失败的测试并亲眼确认失败，再实现（对齐 CLAUDE.md 第五条）。先写：`sum(round)≠round(sum)` 尾差、整数分边界、四舍五入 vs 银行家舍入、各 domain 回执字段断言。复用 `tests/golden/` 基建。
- 功能 3（MCP 透传）：集成测试为主，测试后置——断言 `structuredContent` 字段完整 + 敏感字段已脱敏。
- 功能 4（UI 卡片）：不套 unit TDD——走 e2e（`e2e/mock` playwright）+ `design-compliance` + 人工 verify。

**回归网**：浮点→整数分改造可能动到现有计算边角，`numeric-check` 保留作事后回归断言，与 TDD 双保险。

**测试运行**：本地跑绿需 `FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true` + venv。

**实施顺序**：严格 1→2→3→4。功能 1 单独成 PR（纯类型+money，无行为变化，易 review）；功能 2 按"薪税→对账→报销"拆三个小 PR 增量上，每条链路独立闭环、独立可验，无"做一半不可用"中间态。先做薪税（已有雏形，改造成本最低、错误成本最高、收益最大）。

## 红线对齐

| 红线 | 本 spec 如何满足 |
|---|---|
| 2 数值正确 | 金额整数分 + 尾差调整 + 舍入显式；LLM 不碰算术 |
| 3 信任链 | `settlementStatus` + `asOf` + `caliberVersion`，草稿绝不当终值 |
| 4 我不知道 | 回执缺标签时 `caveats` 降级措辞，不静默报数 |
| 7 合规驻留 | source 含敏感字段在工具层脱敏后才进 content |
| 8 审计落点 | 回执结构化保留，可追溯到原始文件/单元格/发票号 |
