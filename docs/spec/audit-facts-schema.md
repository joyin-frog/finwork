# Audit: facts-schema (WP1a — 事实库第一刀)

spec: docs/spec/spec-facts-schema.md v1.1

## Files changed

| 文件 | 操作 |
|------|------|
| `tests/db-facts-migration.test.ts` | 新建 — 5 组 TDD 红测试（G1 预演先行 / G2 精度校验中止 / G3 旧表退役 / G4 门面等价抽样 / G5 累计接力保持） |
| `tests/all.test.ts` | 追加注册 `db-facts-migration.test.ts` |
| `tests/fixtures/golden-schema.json` | 移除 3 张旧表（business_metrics / invoice_ledger / payroll_records）及其索引；加入 4 张 fact_* 新表及索引 |
| `lib/db/migrations.ts` | 在 MIGRATIONS 数组末尾追加 v7 `facts_foundation`（建 4 张 fact_* 表 + 搬数据 + DROP 3 旧表） |
| `lib/db/finance-store.ts` | 内部切换全部 SQL 到 fact_* 表；添加 yuanToCents / centsToYuan 辅助函数；所有导出函数签名与返回值（元单位）不变 |
| `lib/domain/cash-obligations.ts` | 新增 `persistDerivedObligations` 持久化出口 |
| `tests/data-safety.test.ts` | CORE_TABLES / AC3 断言从 payroll_records → fact_payroll |
| `tests/small-utils.test.ts` | 注释说明 initializeSchema baseline 仍有旧表（符合预期，测的是 schema.ts 而非 v7 迁移），无断言改动 |
| `tests/business-metrics-source.test.ts` | T1 测试桩改为 initializeSchema + user_version=4，使 business_metrics 表在插入数据时仍存在；T2/T3 无改动 |
| `tests/business-metrics.test.ts` | AC6a 改为查 fact_metrics 并断言 cents 值 |
| `tests/db-hardening.test.ts` | T3 备份验表断言从 payroll_records → fact_payroll（orchestrator 授权第五个物理表断言型文件） |

## 各文件改动详情

### tests/db-facts-migration.test.ts（新建）
5 个测试组，共同导出 `dbFactsMigrationTestPromise`：
- **G1**：rehearseMigrations 不修改原库（VACUUM INTO 副本），跑完 LATEST_VERSION >= 7
- **G2**：用 initializeSchema + user_version=6 建立基线，插入精度超差脏数据（0.001 元，|0.1 - 0| >= 0.005），跑 v7 迁移应抛含"精度"的异常，原库 fact_invoices 不应存在（事务回滚）
- **G3**：全量迁移后旧表 invoice_ledger / payroll_records / business_metrics 应不存在，4 张 fact_* 表应存在
- **G4**：通过 finance-store 门面写入工资单与发票，迁移前后读值（元单位）一致
- **G5**：累计接力——向 fact_payroll 写入 confirmed 工资单，getLatestConfirmedPayroll 正确返回

### tests/all.test.ts
在 `dbMigrationDisciplineTestPromise` await 之后追加：
```ts
const { dbFactsMigrationTestPromise } = await import("./db-facts-migration.test.ts");
await dbFactsMigrationTestPromise;
```

### tests/fixtures/golden-schema.json
- 移除 tables: business_metrics, invoice_ledger, payroll_records
- 移除 indexes: idx_business_metrics_period, idx_payroll_records_period
- 添加 tables: fact_invoices, fact_metrics, fact_obligations, fact_payroll
- 添加 indexes: idx_fact_invoices_recorded_at, idx_fact_metrics_period, idx_fact_obligations_due, idx_fact_payroll_period

### lib/db/migrations.ts
MIGRATIONS[6]（v7 `facts_foundation`）：
1. 建 fact_invoices（amount_cents INTEGER、source TEXT DEFAULT 'user_dictated'）
2. 建 fact_payroll（全 *_cents INTEGER、settlement_status TEXT DEFAULT 'draft'、caliber_version TEXT）
3. 建 fact_metrics（revenue_cents / profit_cents INTEGER、settlement_status DEFAULT 'stated'）
4. 建 fact_obligations（amount_cents INTEGER、direction 'pay'/'receive'、status 'pending'/'settled'）
5. 内部 toCents(yuan, rowId) 超差抛异常（|raw - rounded| >= 0.005）
6. 搬迁 invoice_ledger → fact_invoices（source='user_dictated'）
7. 搬迁 payroll_records → fact_payroll（status→settlement_status、tax_config_version→caliber_version）
8. 搬迁 business_metrics → fact_metrics
9. DROP TABLE IF EXISTS 3 张旧表
- 类型修正：payroll_records / business_metrics 查询结果从 `Array<Record<string, unknown>>` 改为具体接口，消除 TS2769

### lib/db/finance-store.ts
- 新增 yuanToCents(yuan, ctx) / centsToYuan(cents) 内部辅助
- savePayrollDraft / getLatestConfirmedPayroll / listPayrollRecords / confirmPayrollPeriod / getPayrollPeriodSummary / getPriorConfirmedPeriod：SQL 改指 fact_payroll，列名用 settlement_status / caliber_version / *_cents
- mapPayrollRow：读 *_cents 后 /100 返回元，settlement_status→status，caliber_version→taxConfigVersion
- recordInvoices / findInvoicesInLedger / getInvoiceLedgerStats（reviewer B3）：SQL 改指 fact_invoices，amount_cents 存分返元
- upsertBusinessMetrics / buildMonthView / buildRangeView（reviewer B3）：SQL 改指 fact_metrics，revenue_cents/profit_cents 存分返元

### lib/domain/cash-obligations.ts
新增 persistDerivedObligations(sourceDocumentId, obligations, db)：
- DELETE FROM fact_obligations WHERE source_document_id = ?
- 逐行 INSERT（direction: 付款/开票→'pay', 收款→'receive'；amount_cents = Math.round(amount*100)；done→'settled'，else 'pending'）

### tests/data-safety.test.ts
- CORE_TABLES 数组：`"payroll_records"` → `"fact_payroll"`
- AC3 断言 SQL：`name='payroll_records'` → `name='fact_payroll'`；消息更新对应

### tests/small-utils.test.ts
无断言改动。添加注释说明 initializeSchema（基线，schema.ts 已冻结）仍建旧表，测试验证的是 initializeSchema 行为而非 v7 迁移。

### tests/business-metrics-source.test.ts
T1 测试桩重构：
- 原：initializeFinanceDatabase（触发 v7，business_metrics 在插入前已被 DROP）→ 插入失败
- 改：initializeSchema(db) + PRAGMA user_version=4 → 插入存量数据（此时 business_metrics 存在）→ db.close() → runMigrations → 验证 fact_metrics 含 source='user_dictated'
- 导入从 `initializeFinanceDatabase` 改为 `initializeSchema`

### tests/business-metrics.test.ts
AC6a：
- 原：查 business_metrics.revenue/profit（浮点元）
- 改：查 fact_metrics.revenue_cents/profit_cents（整数分），断言值为 12000000 / 2500000

### tests/db-hardening.test.ts（orchestrator 授权）
T3 备份验表：
- 原：`name='payroll_records'`
- 改：`name='fact_payroll'`
- 断言消息：`"T3 FAIL: 备份应包含业务表(fact_payroll)"`

## 与计划的偏差

### 偏差 1：db-hardening.test.ts — 发现→停下→授权→修复全过程

**发现**：实施完成后首次全量 `npm test`，`db-hardening.test.ts` T3 抛 `"AssertionError: T3 FAIL: 备份应包含业务表"`（leaked async rejection）。原因：`initializeFinanceDatabase` 触发 v7 后 `payroll_records` 被 DROP；T3 在 v7 后的备份中查 `payroll_records`，找不到。

**红态证据**（测试运行时错误）：
```
# Error: A resource generated asynchronous activity after the test ended.
# This activity created the error "AssertionError [ERR_ASSERTION]: T3 FAIL: 备份应包含业务表"
# which triggered an unhandledRejection event, caught by the test runner.
```
连带后果：进程在 golden-tool-names 后以 exit 1 退出，后续所有测试（含 db-facts-migration、data-safety 等）均未运行。

**停下报告**：按 spec 硬约束"除这四个外还有测试要改断言 = 停下报告"，停止实施，向 orchestrator 报告。

**授权**：orchestrator 回复"批准。spec Files touched 已由 orchestrator 增补 tests/db-hardening.test.ts（第五个物理表断言型文件，与前四个同类）"。

**修复**：将 T3 查表 SQL 改为 `name='fact_payroll'`，消息更新为 `"T3 FAIL: 备份应包含业务表(fact_payroll)"`。

### 偏差 2：business-metrics-source.test.ts T1 插入时序 bug

计划未预见：原 T1 调用 `initializeFinanceDatabase`（跑 v7）后再 INSERT INTO business_metrics，但 v7 已 DROP 该表，插入必报 `no such table: business_metrics`。

**修复**：改用 `initializeSchema(db)` + `PRAGMA user_version=4` 建基线（business_metrics 此时存在），插入数据，再 `runMigrations` 跑 v5+v7，验证 fact_metrics 中数据正确。这是对同一测试文件内逻辑的修正，仍在授权文件范围内。

## 测试结果

### 红态证据（实施前）
```
LATEST_VERSION 应 >= 7，实际 6   ← G1 初始红态
```
5 组测试全部 FAIL，证明 v7 未实现时的红态。

### 全量绿态
```
db-hardening: all 4 checks passed ✓
data-safety: all AC1–AC6 passed ✓
small-utils: all checks passed ✓
business-metrics: all 3 checks passed ✓
business-metrics-source: all T1–T3 passed ✓
db-migration-discipline: all 5 checks passed ✓
db-facts-migration: all G1–G5 passed ✓
payroll-store: all 8 checks passed ✓
reimbursement-ledger: all 5 checks passed ✓
finance-summary: all 3 checks passed ✓
cockpit-today-counts: all checks passed ✓
cockpit-todos: all checks passed ✓
cockpit-page: all checks passed ✓
# tests 11 / pass 11 / fail 0
```
TypeScript typecheck：`npm run typecheck` 0 errors。

## 开放风险

1. **精度转换上界**：toCents 仅拦截 |raw-rounded| >= 0.005（半分误差），对 0.004 以内的浮点脏数据静默四舍五入。这是 spec 规定的门槛，无偏差，但若存量数据有系统性 0.004 内漂移，搬迁后数据与原始源会有 ≤0.4 分差异。
2. **fact_obligations 无消费方**：persistDerivedObligations 已实现并导出，但当前无任何调用方——该函数将在 WP1b 接入时激活。调用前应再确认接口签名仍匹配。
3. **INSERT OR IGNORE 去重键**：fact_payroll 以 (employee_name, year, month) UNIQUE 去重；若存量 payroll_records 有同名员工同月多条草稿，仅第一条入库，其余静默忽略。生产数据中若存在此情形需 WP1b 前排查。

---

## 实施审查裁定记录（orchestrator，2026-07-06）

实施审查裁决 fix first，唯一阻塞 B1 称 lib/db/sqlite.ts 的 85 行改动（rehearseMigrations 新增 + initializeFinanceDatabase 摘除无条件 baseline）未申报。**裁定：B1 撤销**——该改动属于已 ship 的 WP6（见 docs/spec/audit-migration-discipline.md Files changed 首节，含该文件与两项改动的完整描述），系同一工作树多任务未提交改动叠加导致 reviewer 无法区分归属。WP1a 仅消费 WP6 已交付的 rehearseMigrations API（G1 测试）。
非阻塞项记录：N1（fact_invoices.source 建议补 DEFAULT 'user_dictated'）与 N3（persistDerivedObligations 的 Math.round 无 0.005 校验）均转入 WP1b/WP1c 处理清单；N2/N4/N5/N6 无需动作。两处实施偏差均获 reviewer 正面裁定。

**最终裁决：ship。**
