# Audit: invoice-write-path（WP1c）

> 实施者：implementer（Sonnet 4.6）  
> 日期：2026-07-07  
> 基于 spec：docs/spec/spec-invoice-write-path.md v1.1

---

## Files changed

| 文件 | 动作 | 说明 |
|---|---|---|
| `tests/invoice-write-path.test.ts` | 新增 | TDD 测试：全字段/零字段/非法税率/查询汇总/NULL 语义五路径 |
| `tests/all.test.ts` | 修改 | 末尾追加 invoiceWritePathTestPromise |
| `lib/db/finance-store.ts` | 修改 | InvoiceLedgerEntry 类型扩展；recordInvoices 全列 INSERT；新增 InvoiceLedgerBreakdown 类型与 getInvoiceLedgerBreakdown 函数 |
| `lib/agent/tools/finance/reimbursement.ts` | 修改 | record_reimbursement_invoices zod 加 taxRate/taxAmountYuan/counterparty；handler 内 taxRate parseFloat+范围校验、taxAmountYuan 元转分；direction 写死 'in'；certificationStatus 恒 NULL |
| `lib/agent/mcp-tools/finance-tools.ts` | 修改 | 新增 query_invoice_ledger 工具定义；import getInvoiceLedgerBreakdown |
| `lib/agent/tools/registry.ts` | 修改 | 注册 mcp__finance_worker__query_invoice_ledger（category finance，riskLevel safe） |
| `lib/agent/tools/renderers.ts` | 修改 | summaries 补 query_invoice_ledger 中文摘要（T6 守卫要求） |
| `lib/agent/roles/registry.ts` | 修改 | bookkeeper/tax-officer tools 数组加 "query_invoice_ledger"；dataScope 4 处旧表名更新（invoice_ledger→fact_invoices，payroll_records→fact_payroll，business_metrics→fact_metrics） |
| `agent-skills/skills/filing-precheck/SKILL.md` | 修改 | A4 段升级：三分支（有登记/directionUnknownCount>0/台账为空） |

---

## 每个文件的改动内容

### `lib/db/finance-store.ts`

- `InvoiceLedgerEntry` 新增五个可选字段：`taxRate`（number|null）、`taxAmountCents`（number|null）、`counterparty`（string|null）、`direction`（string|null）、`certificationStatus`（string|null）。
- `recordInvoices` INSERT 语句从 6 列扩展到 11 列，新增字段默认 NULL（INSERT OR IGNORE 语义不变）。
- 新增 `InvoiceLedgerBreakdown` 类型与 `getInvoiceLedgerBreakdown(year, month, db?)` 函数：查台账总数、进项张数与税额合计（按 invoice_date LIKE 年月前缀）、未认证数（certification_status IS NULL）、方向未知数（direction IS NULL）。

### `lib/agent/tools/finance/reimbursement.ts`

- zod schema 新增三字段：`taxRate`（z.string().nullish()）、`taxAmountYuan`（z.number().nullish()）、`counterparty`（z.string().nullish()）。
- handler 内对 taxRate 先 parseFloat，再 0 < rate < 1 校验，非法时 early return isError。
- taxAmountYuan 用与 `yuanToCents` 等价的内联逻辑（round+0.005 精度校验）转分传入 recordInvoices。
- direction 写死 `"in"`（报销场景恒进项），certificationStatus 写死 null。

### `lib/agent/mcp-tools/finance-tools.ts`

- import 增加 `getInvoiceLedgerBreakdown`。
- 新增 `queryInvoiceLedger` 工具（only-read，riskLevel safe），入参 year/month，返回 structuredContent `{total, directionIn, uncertifiedCount, directionUnknownCount}` 及中文文本摘要。
- `createFinanceTools` 返回值从 `[readExpensePolicy, taxCalculator]` 改为 `[readExpensePolicy, taxCalculator, queryInvoiceLedger]`。

### `lib/agent/tools/registry.ts`

- 在 Policy/tax tools 块末尾追加：`{ name: "mcp__finance_worker__query_invoice_ledger", category: "finance", riskLevel: "safe" }`。

### `lib/agent/tools/renderers.ts`

- `summaries` 中在 `read_expense_policy` 行后追加 `query_invoice_ledger` 条目，输出"查询${year}年${month}月发票台账汇总"或"查询发票台账"。

### `lib/agent/roles/registry.ts`

- `bookkeeper.tools` 追加 `"query_invoice_ledger"`。
- `tax-officer.tools` 追加 `"query_invoice_ledger"`。
- `bookkeeper.dataScope`：`"invoice_ledger"` → `"fact_invoices"`。
- `payroll-officer.dataScope`：`"payroll_records"` → `"fact_payroll"`。
- `tax-officer.dataScope`：`"invoice_ledger（读）"` → `"fact_invoices（读）"`。
- `analyst.dataScope`：`"business_metrics（只读）"` → `"fact_metrics（只读）"`。

### `agent-skills/skills/filing-precheck/SKILL.md`

- A4 升级为调用 `query_invoice_ledger` 三分支：有登记→报数并与文件互证；`directionUnknownCount > 0`→明示 N 张未标注方向未计入；台账为空→保留"请自查"提示。

### `tests/invoice-write-path.test.ts`（新增）

- T1：全字段写入并验证 DB 落库值（tax_rate/tax_amount_cents/counterparty/direction/certification_status）。
- T2：零新字段写入，验证新列全为 NULL（历史兼容路径不变）。
- T3：非法税率（"1.5"）经工具层 handler 拒绝，isError=true 或文本含"税率"。
- T4：`getInvoiceLedgerBreakdown` 查询汇总，验证 total/directionIn.count/directionIn.taxAmountCentsSum/directionUnknownCount 边界。
- T5：certification_status 恒 NULL。

### `tests/all.test.ts`

- 末尾追加 `invoiceWritePathTestPromise` 导入与 await。

---

## 与计划的偏差及原因

1. **yuanToCents 内联而非调用**：spec 第 5 节指出"抄既有 yuanToCents"；但 `yuanToCents` 在 finance-store.ts 中是 `function`（非 export），不可跨文件直接调用。在 reimbursement.ts handler 内内联等价逻辑（同样 round+0.005 校验），语义完全相同，无精度偏差。若后续需要跨文件复用，应将其 export——属于 WP 外的改动，本 spec 不触及。

2. **T3 测试通过 mock handler**：测试绕过 SDK zod 校验层（测试环境无真实 SDK），直接调用 handler 函数。taxRate 的 zod schema 仅声明 `z.string().nullish()`（不做范围校验），范围校验在 handler 内完成——与 spec 约定一致。

3. **getInvoiceLedgerBreakdown 的 month 维度基于 invoice_date 而非 recorded_at**：spec 原文未明确 month 过滤字段，但语义上"查询某月发票"应基于开票日期（invoice_date），与财务实际一致。查询函数注释已标注此口径。

4. **dataScope 原文 4 处行号 37/60/82/140**：spec 注明的行号与代码行号有轻微出入（代码在多次改造后行号移位），但 4 处旧表名（invoice_ledger/payroll_records/business_metrics）均已全量替换。

---

## 测试结果

```
# 红→绿过程
红：T1 FAIL: tax_rate 应为 0.09，实际 null  （实施前）
绿：invoice-write-path: all 5 checks passed ✓  （实施后）

# 守卫通过
tool-registry: all 6 checks passed ✓
role-registry: all 7 guards passed ✓

# 全量测试
EXIT=0；零 unhandledRejection
# tests 11 / # pass 11 / # fail 0

# 类型检查
TYPECHECK_EXIT=0

# Lint
LINT_EXIT=0（仅 warnings，无 errors；均为既有警告，非本次改动引入）

# golden-schema 零改动
git diff tests/fixtures/golden-schema.json  →（无输出）
```

---

## 开放风险

- `yuanToCents` 目前在 finance-store.ts 中是私有函数，两处独立实现（store 内部 + reimbursement handler）。如果精度逻辑将来变化，需同步两处。建议 WP4+ 时将其 export。
- `query_invoice_ledger` 的 `uncertifiedCount` 目前统计全库（非按月），与 `total` 统计口径一致，但与 `directionIn` 按月口径不同——已在注释中说明。如需精细化，可后续加 invoice_date 过滤参数。
