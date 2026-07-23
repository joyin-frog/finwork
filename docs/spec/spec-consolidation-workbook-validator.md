# Spec：母子公司合并报表质量 Profile

> ID：CR-Q2  
> 状态：Blocked — 等待 CR-Q1  
> 日期：2026-07-21  
> 前置依赖：CR-R0、CR-S1、CR-Q1  
> 参考回归：都森 2026 年第二季度合并报表

## Problem Statement

通用 XLSX 校验只能证明文件可打开、已重算且没有公式错误，不能证明合并报表期间、公司、资产负债和现金勾稽正确。Finwork 会话 9 的文件在模型回复中声称全部通过，但真实重算后资产负债差额为 -1,756,305.42，现金差额为 18,299,442.55；会话 10/11 还保留模板旧期间和公司 `0`。

## Solution

在 CR-Q1 validator registry 中注册 `financial_consolidation` Profile。TaskContract 在模型执行前冻结公司、期间、关键字段绑定和断言；系统工具将绑定注入工作副本。Validator 使用 CR-S1 的真实重算结果检查用户可见报表源单元格，不相信工作簿内“校验通过”文本。

## User Stories

1. 作为财务用户，我希望资产负债不平时文件不能交付。
2. 作为财务用户，我希望现金流期末现金与资产负债表货币资金一致。
3. 作为财务用户，我希望旧模板期间和公司占位符被自动识别。
4. 作为复核人，我希望知道每条勾稽的源 sheet、单元格、公式和值。
5. 作为模板用户，我希望不同布局能通过显式绑定支持，而不是被固定坐标限制。

## Implementation Decisions

### 1. Profile Inputs

TaskContract 必须包含：

- `company`
- `period`
- 必需 deliverable：一份 XLSX，Profile=`financial_consolidation`
- 字段绑定 snapshot
- SpreadsheetAssertion 列表

公司、期间来自用户请求、输入文件元数据或执行前确认。模型和 finalize 不得覆盖。

### 2. Binding Contract

```ts
type ConsolidationBinding = {
  semanticName:
    | "FW_COMPANY"
    | "FW_PERIOD"
    | "FW_TOTAL_ASSETS"
    | "FW_TOTAL_LIAB_EQUITY"
    | "FW_CF_ENDING_CASH"
    | "FW_BS_CASH"
    | "FW_NET_PROFIT";
  sheet: string;
  cell: string;
  expectedLabel?: string;
  requireFormula: boolean;
};
```

- 输入模板已存在稳定 Defined Name 时直接使用，但需验证它指向可见 sheet 的单一单元格。
- 没有 Defined Name 时，preflight 通过标签同义词、sheet 类型和公式结构生成 Binding Draft。
- 唯一匹配可自动冻结；多匹配或缺失必须在模型执行前询问用户。
- 绑定冻结后写入 TaskContract，最终文件必须使用相同 sheet/cell。
- 系统工具负责向工作副本注入 `FW_*` Defined Names；不依赖模型手写名称。
- 隐藏 `_finwork_validation` 只能保存地址和元数据，不能保存待比较结果。

### 3. Binding Safety

Validator 验证：

- Defined Name 指向 TaskContract 冻结的精确 sheet/cell。
- 目标 sheet 可见。
- 目标单元格附近标签与 expectedLabel/同义词一致。
- `requireFormula=true` 时目标单元格是公式。
- 重算后的缓存值来自同一源单元格。
- 不接受 Defined Name 指向隐藏校验 sheet、常量、多个 range 或外部工作簿。

绑定失败返回结构化 `CONSOLIDATION_BINDING_*` 错误，并给出重新绑定入口；不得静默选择另一个单元格。

### 4. Required Assertions

```text
FW_TOTAL_ASSETS == FW_TOTAL_LIAB_EQUITY, tolerance 0.01
FW_CF_ENDING_CASH == FW_BS_CASH, tolerance 0.01
FW_COMPANY == TaskContract.company
FW_PERIOD == TaskContract.period
```

可选：

- 净利润跨表勾稽。
- 用户明确提供的调整抵消数据点。
- 关键合计为公式。

调整抵消检查必须使用 CR-R0 的 SpreadsheetAssertion schema，不接受自然语言“已抵消”声明。

### 5. Validation Procedure

1. CR-Q1 完成通用文件、MIME、解析检查。
2. CR-S1 在工作副本上用真实 LO 重算。
3. 比较重算前后的公式文本、Defined Names 和外链；非预期变化失败。
4. 以 data-only 读取绑定源单元格。
5. 检查错误类型、必需缓存值和公式要求。
6. 执行公司、期间、资产负债、现金及自定义 assertions。
7. 生成机器报告和用户可读报告。
8. 通过后由 CR-Q1 制作不可变 delivered 副本并提交 Evidence。

### 6. Error Codes

至少包括：

```text
CONSOLIDATION_PROFILE_INCOMPLETE
CONSOLIDATION_BINDING_MISSING
CONSOLIDATION_BINDING_AMBIGUOUS
CONSOLIDATION_BINDING_CHANGED
CONSOLIDATION_COMPANY_INVALID
CONSOLIDATION_COMPANY_MISMATCH
CONSOLIDATION_PERIOD_MISMATCH
CONSOLIDATION_BALANCE_FAILED
CONSOLIDATION_CASH_FAILED
CONSOLIDATION_REQUIRED_FORMULA_MISSING
CONSOLIDATION_ADJUSTMENT_FAILED
```

### 7. Report

每条断言记录：

- semantic name。
- source sheet/cell。
- formula text。
- recalculated value。
- expected/comparison value。
- tolerance。
- pass/fail。

用户可见“编制说明及校验”sheet 可以展示同样内容，但 validator 报告才是质量证据。

## File Ownership

允许：

- financial_consolidation validator/profile。
- binding discovery/injection 工具。
- 领域 fixtures 与报告 renderer。
- 对应 Profile 测试。

禁止：

- 通用 finalize、deliverable registry、不可变复制。
- LO resolver/recalc 实现。
- RunStore 和完成状态。
- 修改 TaskContract 基础类型。

## Testing Decisions

Fixtures：

- balanced consolidation。
- unbalanced balance sheet。
- cash mismatch。
- stale template period。
- company `0`/placeholder。
- missing/ambiguous binding。
- binding 指向隐藏 sheet/常量/外链。
- required total 被硬编码。
- valid named range workbook。

都森脱敏 fixture 必须覆盖原失败值，证明会话 9/10/11 类文件无法 delivered。

## Acceptance Criteria

1. 公司 `0`、空值、模板占位符和不匹配分别失败。
2. 期间与 TaskContract 不一致失败。
3. 资产负债和现金差额超过 0.01 失败。
4. 模型不能通过重绑到其他单元格自证通过。
5. 必需合计不是公式时失败。
6. 通过报告可追溯到可见报表源单元格。
7. 都森错误 fixtures 全部被拒，正确 fixture 才产生 Evidence。

## Out of Scope

- 自动决定所有行业会计口径。
- 替代人工审计和签字。
- 通用任意模板语义理解。
- 税务申报校验。

## Further Notes

如果模板无法稳定绑定，应阻止任务并要求用户确认字段，不应降低 Profile 或改用模型自报结果。

