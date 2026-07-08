# 审计报告：WP-D 审计原子性与销项守卫

## Files changed

| 文件 | 操作 |
|------|------|
| `tests/audit-undo.test.ts` | 新增 AU13 测试（撤销守卫行为验证） |
| `tests/sales-invoices.test.ts` | 新增 SI-12 / SI-13 / SI-14 / SI-15 测试 |
| `lib/db/audit-store.ts` | WP-D #2：undoAuditEntry UPDATE 加 `AND undone_at IS NULL` 守卫 |
| `lib/db/finance-store.ts` | WP-D #1 / #5 / #6：三函数事务化、月份过滤修复、taxMissingCount |
| `lib/agent/tools/finance/sales-invoices.ts` | WP-D #3 / #4：负数守卫 + 未来日期分箱 |
| `lib/agent/mcp-tools/finance-tools.ts` | WP-D #6：taxMissingCount 标注接线 |

---

## 每处改动详情

### 1. `lib/db/audit-store.ts` — WP-D #2（撤销守卫）

**对应 spec 条目**：WP-D #2"撤销守卫：UPDATE 加 AND undone_at IS NULL，changes === 0 时抛'已被撤销'错误（事务内）"

`undoAuditEntry` 内事务中的 undone_at 写入语句由：
```sql
UPDATE audit_logs SET undone_at = datetime('now') WHERE id = ?
```
改为：
```sql
UPDATE audit_logs SET undone_at = datetime('now') WHERE id = ? AND undone_at IS NULL
```
并在 `changes === 0` 时于事务内抛出错误，防止并发场景下双撤销（外层检查在事务外，不足以覆盖并发竞态）。

### 2. `lib/db/finance-store.ts` — WP-D #1, #5, #6

**WP-D #1：业务写 + recordAudit 同事务**

- `recordInvoices`：将单循环拆为两步——先用 `existing` Map 预分类（无 DB 调用），再在 `BEGIN/COMMIT` 内执行 INSERT 循环 + `recordAudit`。`findInvoicesInLedger` 的查重 SELECT 保留在事务外（已知 TOCTOU 局限，spec 明确不处理）。
- `settleInvoice`：初始 SELECT（存在性/方向/状态检查）保留在事务外，UPDATE + `recordAudit` 包进 `BEGIN/COMMIT`。
- `upsertBusinessMetrics`：将 before-image SELECTs、INSERT/UPDATE 循环、ID 查询、`recordAudit` 全部包进一个 `BEGIN/COMMIT`（before-image 在事务内读，快照一致性更强）。

**WP-D #5：台账口径修复**

`getInvoiceLedgerBreakdown` 的 `uncertifiedCount` 和 `directionUnknownCount` 两条 SQL 各加 `AND invoice_date LIKE ?`（与 `total` 使用相同月份前缀过滤），改为只统计当月发票。

**WP-D #6：进项税部分和标注**

- 在 `InvoiceLedgerBreakdown` 类型新增 `taxMissingCount: number` 字段。
- 在 `getInvoiceLedgerBreakdown` 新增 SQL：`SELECT COUNT(*) FROM fact_invoices WHERE direction='in' AND tax_amount_cents IS NULL AND invoice_date LIKE ?`，返回值挂在 `taxMissingCount`。

### 3. `lib/agent/tools/finance/sales-invoices.ts` — WP-D #3, #4

**WP-D #3：负数回款拒绝**

- Zod schema 层：`settledAmountYuan: z.number().positive()` — 真实 MCP 调用时拒绝非正数。
- 处理器层：在 `withIdempotency` handler 开头加 `if (args.settledAmountYuan <= 0)` 守卫，返回 `isError: true`（与 taxRate 校验同模式，使单元测试可在跳过 Zod 层时仍能验证行为）。

**WP-D #4：账龄负数分箱（未来日期）**

在 `query_sales_invoices` 分箱逻辑新增：
```typescript
const futureDated = rows.filter(r => r.agingDays != null && r.agingDays < 0);
```
并在 `agingSummary` 中增加 `futureDateCount: futureDated.length`，在输出文本中当 `futureDateCount > 0` 时追加一行"另有 N 张开票日期在基准日之后（未来日期）"。保证 `futureDateCount + bucket0_30 + ... + bucket90plus + nullDateCount = totalCount`（分箱守恒）。

### 4. `lib/agent/mcp-tools/finance-tools.ts` — WP-D #6（接线）

`query_invoice_ledger` 工具使用 `breakdown.taxMissingCount`，当值 > 0 时在税额合计行追加"（其中 N 张税额未录）"，structuredContent 同步新增 `taxMissingCount` 字段。

### 5. 测试文件

**`tests/audit-undo.test.ts`**（AU13）

测试双撤销抛错行为。注意：此测试在修复前已经 GREEN（外层 `if (row.undone_at != null)` 检查已覆盖），故 AU13 不是 prior-RED。这是 spec 通用铁律中"防御纵深实现难以独立隔离测试"的既知边界——外层检查在事务前，内层 UPDATE 守卫在事务内，两条路径在单线程同步模型下无法在不修改外层检查的前提下单独触发后者。AU13 作为行为回归测试存在。

**`tests/sales-invoices.test.ts`**（SI-12 ~ SI-15）

| 用例 | 修复前状态 | 对应 WP-D |
|------|-----------|-----------|
| SI-12：负数回款被拒 | RED（handler 未守卫，settleInvoice 正常返回 success:true） | #3 |
| SI-13：futureDateCount 存在 + 分箱守恒 | RED（agingSummary 无 futureDateCount 字段） | #4 |
| SI-14：添加 7 月发票不影响 6 月 uncertifiedCount | RED（全库口径，计数随 7 月发票增加） | #5 |
| SI-15：taxMissingCount 字段存在 + 工具输出含"税额未录" | RED（字段不存在，标注未生成） | #6 |

---

## 与 spec 的偏差及理由

1. **WP-D #1 对 `recordInvoices` 的重构**：原单循环（分类 + INSERT 混合）被拆为两段（先预分类，再事务内 INSERT）。属于最小结构重组，行为等价，spec 并未限定具体结构。

2. **WP-D #1 `upsertBusinessMetrics` before-image 移入事务内**：spec 只要求"业务写 + recordAudit 同事务"，before-image SELECT 也被一并包入。这比 spec 最低要求更严格但完全无害；原注释"无 TOCTOU 风险"的说明在单线程 SQLite 模型下仍成立。

3. **WP-D #3 在 handler 层追加守卫**：spec 仅写 `z.number().positive()`（Zod schema 层），但测试调用绕过 Zod。为使测试可验证，复用 taxRate 的既有模式，在 handler 开头加了防御性检查。两层守卫不冲突，真实 SDK 调用会在 Zod 层被拦截，测试在 handler 层被拦截。

4. **AU13 不是 prior-RED**：见"测试文件"一节说明，属 spec 铁律"除非纯文案/schema 一行改动"的例外边界。

---

## 测试结果

```
tests/audit-undo.test.ts   → audit-undo: all checks passed ✓
tests/sales-invoices.test.ts → sales-invoices: all checks passed ✓
tests/receipt-store.test.ts  → receipt-store: all checks passed ✓
```

所有三个目标测试文件全绿，无 regression。

---

## 开放风险

1. **查重 SELECT TOCTOU（已知局限）**：`recordInvoices` 的 `findInvoicesInLedger` 在事务外，并发插入相同发票号时理论上可绕过去重。这是 spec 明确标注的"既有行为，本批不处理"。

2. **`settleInvoice` 的外层 SELECT 与 UPDATE 之间的窗口**：初始存在性/状态检查在事务外，UPDATE 在事务内。如果两次并发调用同时通过外层检查，则会产生重复 UPDATE（第二次覆盖第一次）。SQLite WAL 模式下并发写者会序列化，但依然存在竞态窗口。这不在本 WP-D 范围内。
