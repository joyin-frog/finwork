# Audit: provenance-store (WP4b)

> 实施日期：2026-07-07  
> Spec 版本：v1.2（计划已批准）

## Files changed

| 文件 | 动作 |
|---|---|
| `lib/db/migrations.ts` | 修改：追加 v14 迁移（calc_receipts + fact_payroll.receipt_id） |
| `lib/db/receipt-store.ts` | 新增：saveCalcReceipt / saveCalcReceiptSafe / getCalcReceipt |
| `lib/agent/tools/finance/payroll.ts` | 修改：导入 saveCalcReceiptSafe，落库 receipt，results 加 receiptId，savePayrollDraft 传 receiptId |
| `lib/agent/tools/finance/reimbursement.ts` | 修改：导入 saveCalcReceiptSafe/getDb，每条 result 落库附 receiptId |
| `lib/agent/mcp-tools/finance-tools.ts` | 修改：导入 saveCalcReceiptSafe/getDb，tax_calculator 仅落库（structuredContent 不动） |
| `lib/agent/tools/finance/reconciliation.ts` | 修改：导入 saveCalcReceiptSafe/getDb，wrapper 加 receiptId |
| `lib/agent/mcp-tools/kingdee-tools.ts` | 修改：导入 saveCalcReceiptSafe/getDb/makeCalcReceipt，check_voucher_amount ok=true 产 receipt+落库；process_voucher_batch 构造批次 receipt+落库 |
| `lib/agent/mcp-tools/business-analysis-tool.ts` | 修改：导入 getDb，handler 层组装 provenance 段，content 尾部加溯源行 |
| `lib/db/finance-store.ts` | 修改：savePayrollDraft options 加 receiptId，INSERT/ON CONFLICT 均含 receipt_id |
| `tests/receipt-store.test.ts` | 新增：RS-T1~T8 全部行为测试 |
| `tests/fixtures/golden-schema.json` | 修改：calc_receipts 表+索引+列；fact_payroll.receipt_id 列 |
| `tests/all.test.ts` | 修改：末尾注册 receipt-store.test.ts |

`lib/domain/voucher-batch.ts` 未动（processVoucherBatch 输出已含足够信息，在 kingdee-tools.ts handler 层组装 receipt）。

## 成功标准逐条核实

### v14 迁移形状
- calc_receipts 表创建（IF NOT EXISTS）：✓
- 列：id PK AUTOINCREMENT / tool_name NOT NULL / conversation_id NULL / trace_id NULL / receipt NOT NULL / created_at DEFAULT CURRENT_TIMESTAMP：✓
- 索引 idx_calc_receipts_conversation_id：✓
- 无会话 FK（长寿设计同 audit_logs）：✓
- fact_payroll.receipt_id INTEGER NULL（addColumnIfMissing，幂等）：✓
- 防御性：v14 migration 先 CREATE TABLE IF NOT EXISTS fact_payroll，避免"直接设 user_version 绕过 DDL"场景报错：✓
- golden-schema 同步：✓

### saveCalcReceipt
- 校验失败抛错不落库（validateCalcReceipt）：✓（RS-T3）
- 落库返回 receiptId：✓（RS-T2）
- saveCalcReceiptSafe 降级 warn 返回 undefined：✓（RS-T4）
- getCalcReceipt 取回验证：✓（RS-T2）

### 4 生产方接入（两型定案）
- **payroll（wrapper 型）**：structuredContent.results[0].receiptId 存在，calc_receipts 有行，fact_payroll.receipt_id 回填：✓（RS-T5a, T8a）
- **reimbursement（wrapper 型）**：structuredContent.results[0].receiptId 存在，calc_receipts 有行：✓（RS-T5b）
- **reconciliation（wrapper 型）**：structuredContent.receiptId 存在，calc_receipts 有行：✓（RS-T5c）
- **tax_calculator（receipt 本体型，B1 定案）**：structuredContent 一字不动（kind/value/unit/steps/basis，无 receiptId），calc_receipts 有 tax_calculator 行：✓（RS-T5d）
- 形状哨兵全绿（零改动跑绿）：finance-tools-f3.test.ts（F3-T1/T2/T3/T8 直断 structuredContent 字段）✓；receipt.test.ts / reimbursement-receipt / reconciliation-receipt / tax-cumulative-f2 全绿：✓

### voucher 接入
- check_voucher_amount ok=true 产 receipt+receiptId：✓（RS-T6a）
- check_voucher_amount ok=false（mismatch）不产 receipt：✓（RS-T6b）
- process_voucher_batch structuredContent 含 receipt+receiptId，value=批次总金额（分）：✓（RS-T6c）
- 既有顶层字段与文字输出不变（voucher 系测试零改动跑绿）：✓

### 分析 provenance
- structuredContent.provenance 含 caliberVersion/asOf/sources：✓（RS-T7）
- sources[0].table='fact_metrics'：✓
- content 尾部含溯源说明（含"口径"）：✓
- buildBusinessAnalysisV2 不动（纯函数，provenance 在 handler 层组装）：✓

### fact_payroll 回填
- savePayrollDraft options 加 receiptId（可选）：✓
- INSERT 与 ON CONFLICT DO UPDATE 均含 receipt_id：✓（spec §1 N1 定案：重算草稿更新 receipt_id）
- 确认（confirmPayrollPeriod）不动 receipt_id：✓（未改 confirmPayrollPeriod）
- 草稿行 receipt_id 指向 calc_receipts，basis.asOf 与期间一致：✓（RS-T8a）
- 重算后 receipt_id 变为新 id：✓（RS-T8b）

## 偏差与说明

1. **voucher receipt value 单位核实**：reconcileAmount 输入经 yuanToFen 转换为分，返回 valueFen 即分。check_voucher_amount 的 receipt.value 直接取 `result.valueFen`（分）。测试 RS-T6a 断言 600 元 → 60000 分，验证正确（reviewer N5 核实项）。

2. **process_voucher_batch 的 totalFen**：BatchVoucher.amount 是 ReconcileResult 联合类型，mismatch 变体无 valueFen 属性。实施用辅助函数 `getValueFen` 读 valueFen，mismatch 行取 0（不纳入合计）。这符合"不平衡单据不确定金额"的语义。

3. **voucher-batch.ts 不动**：processVoucherBatch 输出（vouchers/summary/sheet）已包含足够信息，receipt 在 kingdee-tools.ts handler 层构造。未动 lib/domain/voucher-batch.ts（spec Files touched 注明"若现返回值已够则不动"）。

4. **wrapper 型严格形状断言**：finance-tools-f3.test.ts F3-T4a/T4b 断言 `r4aResult.receipt`（structuredContent.results[0].receipt），payroll 仍存在 receipt 字段（来自 CumulativePayrollResult.receipt），加 receiptId 字段后断言仍通过。未删断言，扩展通过。

5. **fact_payroll.receipt_id 金-schema cid**：addColumnIfMissing 追加列，SQLite 自动分配 cid=24，golden-schema 已同步。

## 测试结果

```
FINANCE_AGENT_PYTHON_PATH=.venv/bin/python3 FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npm test; echo EXIT=$?
```

- EXIT=0
- 零 unhandledRejection（前次 v14 migration 在测试伪造 user_version 场景下的错误已通过防御性建表修复）
- 新测试 receipt-store: all checks passed ✓
- 哨兵全绿：finance-tools-f3（8/8）/ receipt.test / reimbursement-receipt / reconciliation-receipt / tax-cumulative-f2
- npm run typecheck: 0 errors
- npm run lint: 0 errors, 140 warnings（与 baseline 持平）

## 开放风险

- calc_receipts 无保留策略/清理逻辑（spec 明确非目标，默认永久保留）。
- voucher receipt 在 process_voucher_batch 中是批次级别（非逐单据独立 receipt），适合审计用途；逐单据分辨率若后续需要可扩展 steps。
- business-analysis provenance 的 fact_metrics 查询在 getDb() 不可达时降级（try/catch），不阻断分析返回。
