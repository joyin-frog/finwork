/**
 * WP4b: CalcReceipt 落库（receipt-store.ts）集成测试
 *
 * RS-T1: v14 迁移形状正确（calc_receipts 表 + fact_payroll.receipt_id 列）
 * RS-T2: saveCalcReceipt 落库成功，返回 receiptId
 * RS-T3: saveCalcReceipt 校验失败抛错，不落库
 * RS-T4: 落库失败不阻断工具返回（降级断言）
 * RS-T5: 4 生产方 receiptId 存在且表有行
 *   RS-T5a: payroll receiptId 存在
 *   RS-T5b: reimbursement receiptId 存在
 *   RS-T5c: reconciliation receiptId 存在
 *   RS-T5d: tax_calculator 仅落库（structuredContent 一字不动）
 * RS-T6: voucher receipt 形状（value=合计、steps 数=行数）
 *   RS-T6a: check_voucher_amount ok=true 产 receipt+receiptId
 *   RS-T6b: check_voucher_amount ok=false 不产 receipt
 *   RS-T6c: process_voucher_batch structuredContent 含 receipt+receiptId
 * RS-T7: 分析 provenance 段存在
 * RS-T8: payroll 草稿回填 receipt_id
 *   RS-T8a: 草稿行 receipt_id 指向 calc_receipts 行，basis.asOf 与期间一致
 *   RS-T8b: 重算后 receipt_id 变为新 id
 */
import assert from "node:assert/strict";
import path from "node:path";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { saveCalcReceipt, getCalcReceipt } from "../lib/db/receipt-store.ts";
import { makeCalcReceipt } from "../lib/domain/receipt.ts";
import { createPayrollTools } from "../lib/agent/tools/finance/payroll.ts";
import { createReimbursementTools } from "../lib/agent/tools/finance/reimbursement.ts";
import { createReconciliationTools } from "../lib/agent/tools/finance/reconciliation.ts";
import { createFinanceTools } from "../lib/agent/mcp-tools/finance-tools.ts";
import { createKingdeeTools } from "../lib/agent/mcp-tools/kingdee-tools.ts";
import { createBusinessAnalysisTool } from "../lib/agent/mcp-tools/business-analysis-tool.ts";
import type { DatabaseSync } from "node:sqlite";

export const receiptStoreTestPromise = (async () => {
  const dbDir = `/tmp/receipt-store-test-${process.pid}`;
  const dbPath = path.join(dbDir, "test.db");
  delete process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  const db: DatabaseSync = initializeFinanceDatabase(openFinanceDatabase(dbPath));

  // ── RS-T1: v14 迁移形状 ─────────────────────────────────────────────────────
  {
    const tables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
    ).all() as Array<{ name: string }>).map((r) => r.name);
    assert.ok(tables.includes("calc_receipts"), "RS-T1 FAIL: calc_receipts 表应存在");

    // calc_receipts 列
    const cols = (db.prepare("PRAGMA table_info(calc_receipts)").all() as Array<{ name: string; notnull: number; type: string }>);
    const colMap = new Map(cols.map((c) => [c.name, c]));
    assert.ok(colMap.has("id"), "RS-T1 FAIL: calc_receipts.id 应存在");
    assert.ok(colMap.has("tool_name"), "RS-T1 FAIL: calc_receipts.tool_name 应存在");
    assert.ok(colMap.has("receipt"), "RS-T1 FAIL: calc_receipts.receipt 应存在");
    assert.ok(colMap.has("conversation_id"), "RS-T1 FAIL: calc_receipts.conversation_id 应存在");
    assert.ok(colMap.has("trace_id"), "RS-T1 FAIL: calc_receipts.trace_id 应存在");
    assert.ok(colMap.has("created_at"), "RS-T1 FAIL: calc_receipts.created_at 应存在");
    // receipt NOT NULL
    assert.equal(colMap.get("receipt")?.notnull, 1, "RS-T1 FAIL: calc_receipts.receipt 应为 NOT NULL");
    // conversation_id index
    const idxRows = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='calc_receipts'"
    ).all() as Array<{ name: string }>;
    assert.ok(idxRows.some((r) => r.name.includes("conversation_id")), "RS-T1 FAIL: calc_receipts 应有 conversation_id 索引");

    // fact_payroll.receipt_id 列
    const fpCols = (db.prepare("PRAGMA table_info(fact_payroll)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(fpCols.includes("receipt_id"), "RS-T1 FAIL: fact_payroll.receipt_id 列应存在");
  }

  // ── RS-T2: saveCalcReceipt 落库成功 ────────────────────────────────────────
  const sampleReceipt = makeCalcReceipt({
    value: 1000,
    steps: [{ label: "测试步骤", expr: "x=1000", inputs: {}, subtotal: 1000 }],
    source: [{ ref: "test-ref" }],
    basis: { caliberVersion: "test-v1", settlementStatus: "draft", asOf: "2026-01" },
  });
  const receiptId = saveCalcReceipt(db, { toolName: "test_tool", receipt: sampleReceipt });
  assert.ok(typeof receiptId === "number" && receiptId > 0, `RS-T2 FAIL: receiptId 应为正整数，实际: ${receiptId}`);

  // 表中有该行
  const row = db.prepare("SELECT id, tool_name, receipt FROM calc_receipts WHERE id = ?").get(receiptId) as
    | { id: number; tool_name: string; receipt: string }
    | undefined;
  assert.ok(row, "RS-T2 FAIL: calc_receipts 应有刚落库的行");
  assert.equal(row.tool_name, "test_tool", "RS-T2 FAIL: tool_name 不匹配");
  const parsedReceipt = JSON.parse(row.receipt);
  assert.equal(parsedReceipt.kind, "calc_receipt", "RS-T2 FAIL: 落库的 receipt.kind 应为 calc_receipt");
  assert.equal(parsedReceipt.value, 1000, "RS-T2 FAIL: 落库的 receipt.value 不匹配");

  // getCalcReceipt 供测试取回
  const fetched = getCalcReceipt(db, receiptId);
  assert.ok(fetched, "RS-T2 FAIL: getCalcReceipt 应能取回");
  assert.equal(fetched!.value, 1000, "RS-T2 FAIL: 取回的 receipt.value 不匹配");

  // ── RS-T3: 校验失败抛错不落库 ─────────────────────────────────────────────
  {
    const badReceipt = { value: "not-a-number", unit: "CNY" }; // 不合法
    assert.throws(
      () => saveCalcReceipt(db, { toolName: "bad_tool", receipt: badReceipt as unknown as ReturnType<typeof makeCalcReceipt> }),
      /CalcReceipt/,
      "RS-T3 FAIL: 非法 receipt 应抛错"
    );
    // 没有新行（仍只有 RS-T2 的那一行，id=receiptId）
    const count = (db.prepare("SELECT COUNT(*) AS c FROM calc_receipts WHERE tool_name='bad_tool'").get() as { c: number }).c;
    assert.equal(count, 0, "RS-T3 FAIL: 校验失败不应写入 calc_receipts");
  }

  // ── RS-T4: 落库失败不阻断工具返回（降级断言，用只读 db 模拟写失败）──────────
  // 因为构造一个真正只读 db 比较麻烦，这里测试 saveCalcReceipt 调用方用 try/catch 处理
  // 直接断言：若传入 null 作为 db，应捕获并返回 undefined（降级）
  {
    const { saveCalcReceiptSafe } = await import("../lib/db/receipt-store.ts");
    const result = saveCalcReceiptSafe(
      null as unknown as DatabaseSync,
      { toolName: "safe_test", receipt: sampleReceipt },
      "RS-T4-test"
    );
    assert.equal(result, undefined, "RS-T4 FAIL: 落库失败应返回 undefined（降级）");
  }

  // ── RS-T5: 4 生产方 receiptId ──────────────────────────────────────────────
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (name: string, _d: string, _s: unknown, handler: unknown) => {
      captured[name] = handler;
      return { name };
    },
  };

  createPayrollTools(mockSdk, "/tmp");
  createReimbursementTools(mockSdk);
  createReconciliationTools(mockSdk);
  createFinanceTools(mockSdk, "/tmp");
  createKingdeeTools(mockSdk);
  createBusinessAnalysisTool(mockSdk);

  // RS-T5a: payroll receiptId
  const payrollResult = await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 3,
    employees: [
      {
        employeeName: "RS测试员工",
        grossPay: 15000,
        socialInsurance: 1500,
        housingFund: 1000,
        specialDeduction: 500,
        monthsEmployed: 3,
      },
    ],
  });
  assert.ok(!payrollResult.isError, `RS-T5a FAIL: 工资计算不应报错: ${JSON.stringify(payrollResult)}`);
  const payrollResultItem = payrollResult.structuredContent.results[0] as { receiptId?: number };
  assert.ok(
    typeof payrollResultItem.receiptId === "number" && payrollResultItem.receiptId > 0,
    `RS-T5a FAIL: payroll structuredContent.results[0].receiptId 应为正整数，实际: ${JSON.stringify(payrollResultItem)}`
  );
  // 表有该行
  const payrollReceiptRow = db.prepare("SELECT id FROM calc_receipts WHERE id = ?").get(payrollResultItem.receiptId) as { id: number } | undefined;
  assert.ok(payrollReceiptRow, `RS-T5a FAIL: calc_receipts 应有 payroll receiptId=${payrollResultItem.receiptId} 的行`);

  // RS-T5b: reimbursement receiptId
  const reimbResult = await captured["check_reimbursement_batch"]({
    items: [
      {
        employeeName: "RS报销测试",
        expenseDate: "2026-03-15",
        invoiceNo: "RS-INV-001",
        category: "交通",
        amount: 300,
      },
    ],
  });
  assert.ok(!reimbResult.isError, `RS-T5b FAIL: 报销校验不应报错`);
  const reimbItems = reimbResult.structuredContent.results as Array<{ receiptId?: number }>;
  assert.ok(reimbItems.length > 0, "RS-T5b FAIL: results 不应为空");
  assert.ok(
    typeof reimbItems[0].receiptId === "number" && reimbItems[0].receiptId > 0,
    `RS-T5b FAIL: reimbursement results[0].receiptId 应为正整数，实际: ${JSON.stringify(reimbItems[0])}`
  );
  const reimbReceiptRow = db.prepare("SELECT id FROM calc_receipts WHERE id = ?").get(reimbItems[0].receiptId) as { id: number } | undefined;
  assert.ok(reimbReceiptRow, "RS-T5b FAIL: calc_receipts 应有 reimbursement receiptId 的行");

  // RS-T5c: reconciliation receiptId
  const reconResult = await captured["reconcile_bank_statement"]({
    bankRows: [{ date: "2026-03-01", amount: 500, direction: "in" as const }],
    bookRows: [{ date: "2026-03-01", amount: 500, direction: "in" as const }],
  });
  assert.ok(!reconResult.isError, `RS-T5c FAIL: 对账不应报错`);
  const reconSC = reconResult.structuredContent as { receiptId?: number };
  assert.ok(
    typeof reconSC.receiptId === "number" && reconSC.receiptId > 0,
    `RS-T5c FAIL: reconcile structuredContent.receiptId 应为正整数，实际: ${JSON.stringify(reconSC)}`
  );
  const reconReceiptRow = db.prepare("SELECT id FROM calc_receipts WHERE id = ?").get(reconSC.receiptId) as { id: number } | undefined;
  assert.ok(reconReceiptRow, "RS-T5c FAIL: calc_receipts 应有 reconcile receiptId 的行");

  // RS-T5d: tax_calculator 仅落库，structuredContent 一字不动（无 receiptId 字段）
  const taxResult = await captured["tax_calculator"]({
    type: "vat",
    amount: 2000,
    vatParams: { direction: "from_tax_exclusive", rate: "0.13" },
  });
  assert.ok(!taxResult.isError, `RS-T5d FAIL: 税额计算不应报错`);
  assert.ok(taxResult.structuredContent, "RS-T5d FAIL: tax_calculator 应有 structuredContent");
  // structuredContent 是 CalcReceipt（kind/value/unit/steps/source/basis），不含 receiptId
  assert.equal(taxResult.structuredContent.kind, "calc_receipt", "RS-T5d FAIL: structuredContent.kind 应为 calc_receipt");
  assert.equal(taxResult.structuredContent.unit, "CNY", "RS-T5d FAIL: structuredContent.unit 应为 CNY");
  assert.ok(
    !("receiptId" in taxResult.structuredContent),
    `RS-T5d FAIL: tax_calculator structuredContent 不应含 receiptId（B1 定案），实际: ${JSON.stringify(taxResult.structuredContent)}`
  );
  // 但 calc_receipts 表应有 tax_calculator 的行（已落库）
  const taxReceiptRow = db.prepare("SELECT COUNT(*) AS c FROM calc_receipts WHERE tool_name='tax_calculator'").get() as { c: number };
  assert.ok(taxReceiptRow.c > 0, "RS-T5d FAIL: tax_calculator 应已落库 calc_receipts");

  // ── RS-T6: voucher receipt 形状 ────────────────────────────────────────────
  // RS-T6a: check_voucher_amount ok=true 产 receipt+receiptId
  const checkAmountResult = await captured["check_voucher_amount"]({
    lineItemsYuan: [100, 200, 300],
    totalYuan: 600,
  });
  assert.ok(!checkAmountResult.isError, `RS-T6a FAIL: check_voucher_amount 不应报错`);
  const checkSC = checkAmountResult.structuredContent as { ok?: boolean; receipt?: { value: number; steps: unknown[] }; receiptId?: number };
  assert.ok(checkSC.ok === true, `RS-T6a FAIL: check_voucher_amount 应 ok=true`);
  assert.ok(checkSC.receipt, `RS-T6a FAIL: ok=true 时应有 receipt`);
  assert.equal(checkSC.receipt!.value, 60000, `RS-T6a FAIL: receipt.value 应为 60000 分（= 600 * 100），实际: ${checkSC.receipt!.value}`);
  assert.equal(checkSC.receipt!.steps.length, 3, `RS-T6a FAIL: steps 数应等于 lineItems 行数 3，实际: ${checkSC.receipt!.steps.length}`);
  assert.ok(
    typeof checkSC.receiptId === "number" && checkSC.receiptId > 0,
    `RS-T6a FAIL: check_voucher_amount receiptId 应为正整数，实际: ${JSON.stringify(checkSC)}`
  );

  // RS-T6b: check_voucher_amount ok=false（不平衡）不产 receipt
  const checkAmountBad = await captured["check_voucher_amount"]({
    lineItemsYuan: [100, 200],
    totalYuan: 999, // 不匹配
  });
  // 不报错，但无 receipt（ok=false）
  const badSC = checkAmountBad.structuredContent as { ok?: boolean; receipt?: unknown };
  assert.ok(badSC.ok === false, `RS-T6b FAIL: 不平衡时 ok 应为 false`);
  assert.ok(!badSC.receipt, `RS-T6b FAIL: ok=false 时不应产 receipt，实际: ${JSON.stringify(badSC)}`);

  // RS-T6c: process_voucher_batch structuredContent 含 receipt+receiptId
  const batchResult = await captured["process_voucher_batch"]({
    slips: [
      {
        file: "test-slip-1.pdf",
        date: "2026-03-15",
        lineItems: [
          { summary: "交通费", amountYuan: 100 },
          { summary: "餐饮费", amountYuan: 200 },
        ],
        totalYuan: 300,
      },
    ],
    mappings: [],
  });
  assert.ok(!batchResult.isError, `RS-T6c FAIL: process_voucher_batch 不应报错，实际: ${JSON.stringify(batchResult)}`);
  const batchSC = batchResult.structuredContent as { receipt?: { value: number; steps: unknown[] }; receiptId?: number };
  assert.ok(batchSC.receipt, `RS-T6c FAIL: process_voucher_batch structuredContent 应含 receipt`);
  assert.ok(
    typeof batchSC.receiptId === "number" && batchSC.receiptId > 0,
    `RS-T6c FAIL: process_voucher_batch receiptId 应为正整数，实际: ${JSON.stringify(batchSC)}`
  );
  // value 为批次总金额（分）
  assert.equal(batchSC.receipt!.value, 30000, `RS-T6c FAIL: receipt.value 应为 30000 分（=300 元），实际: ${batchSC.receipt!.value}`);

  // ── RS-T7: 分析 provenance 段 ───────────────────────────────────────────────
  const analysisResult = await captured["generate_business_analysis"]({
    balanceSheet: {
      cash: 100000,
      receivables: 50000,
      inventory: 30000,
      currentAssets: 180000,
      totalAssets: 300000,
      shortTermBorrowing: 20000,
      payables: 30000,
      currentLiabilities: 50000,
      totalLiabilities: 80000,
      equity: 220000,
    },
    incomeStatement: {
      revenue: 500000,
      cost: 300000,
      sellingExpense: 50000,
      adminExpense: 30000,
      rdExpense: 10000,
      financeExpense: 5000,
      netProfit: 105000,
    },
    cashFlow: {
      operatingCashFlow: -120000,
      investingCashFlow: -10000,
      financingCashFlow: 150000,
      netCashIncrease: 20000,
    },
    sourceCells: {
      "balanceSheet.totalAssets": { sheet: "资产负债表", range: "B37" },
      "incomeStatement.revenue": { sheet: "利润表", range: "D5" },
      "cashFlow.operatingCashFlow": { sheet: "现金流量表", range: "I12" },
    },
    asOf: "2026-03-31",
    source: "2026年3月报表",
  });
  assert.ok(!analysisResult.isError, `RS-T7 FAIL: 经营分析不应报错，实际: ${JSON.stringify(analysisResult)}`);
  const analysisSC = analysisResult.structuredContent as {
    provenance?: {
      caliberVersion: string;
      asOf: string;
      sources: unknown[];
      workbookFacts: Array<{ field: string; value: number; locator: { kind: string; sheet: string; range: string } }>;
    };
  };
  assert.ok(analysisSC.provenance, `RS-T7 FAIL: structuredContent 应含 provenance 段`);
  assert.ok(analysisSC.provenance!.caliberVersion, `RS-T7 FAIL: provenance.caliberVersion 应存在`);
  assert.ok(analysisSC.provenance!.asOf, `RS-T7 FAIL: provenance.asOf 应存在`);
  assert.ok(Array.isArray(analysisSC.provenance!.sources), `RS-T7 FAIL: provenance.sources 应为数组`);
  assert.deepEqual(analysisSC.provenance!.workbookFacts, [
    { field: "balanceSheet.totalAssets", value: 300000, locator: { kind: "sheet_range", sheet: "资产负债表", range: "B37" } },
    { field: "incomeStatement.revenue", value: 500000, locator: { kind: "sheet_range", sheet: "利润表", range: "D5" } },
    { field: "cashFlow.operatingCashFlow", value: -120000, locator: { kind: "sheet_range", sheet: "现金流量表", range: "I12" } },
  ]);
  // content 尾部含溯源行（中文）
  const analysisText = analysisResult.content[0].text as string;
  assert.ok(analysisText.includes("口径"), `RS-T7 FAIL: content 应含溯源说明（含"口径"），实际末尾: ${analysisText.slice(-200)}`);

  // ── RS-T8: payroll 草稿回填 receipt_id ─────────────────────────────────────
  // RS-T8a: 草稿行 receipt_id 指向 calc_receipts，basis.asOf 与期间一致
  const payrollRow8 = db.prepare(
    "SELECT receipt_id FROM fact_payroll WHERE employee_name = ? AND year = ? AND month = ?"
  ).get("RS测试员工", 2026, 3) as { receipt_id: number | null } | undefined;
  assert.ok(payrollRow8, "RS-T8a FAIL: fact_payroll 应有 RS测试员工 2026-03 行");
  assert.ok(
    typeof payrollRow8.receipt_id === "number" && payrollRow8.receipt_id > 0,
    `RS-T8a FAIL: fact_payroll.receipt_id 应为正整数，实际: ${payrollRow8.receipt_id}`
  );
  const linkedReceipt = getCalcReceipt(db, payrollRow8.receipt_id!);
  assert.ok(linkedReceipt, "RS-T8a FAIL: getCalcReceipt 应能取回 receipt_id 指向的行");
  assert.equal(linkedReceipt!.basis.asOf, "2026-03", `RS-T8a FAIL: receipt.basis.asOf 应为 2026-03，实际: ${linkedReceipt!.basis.asOf}`);

  // RS-T8b: 重算后 receipt_id 变为新 id
  const oldReceiptId = payrollRow8.receipt_id!;
  await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 3,
    employees: [
      {
        employeeName: "RS测试员工",
        grossPay: 16000, // 不同金额触发重算
        socialInsurance: 1600,
        housingFund: 1100,
        specialDeduction: 500,
        monthsEmployed: 3,
      },
    ],
  });
  const payrollRow8b = db.prepare(
    "SELECT receipt_id FROM fact_payroll WHERE employee_name = ? AND year = ? AND month = ?"
  ).get("RS测试员工", 2026, 3) as { receipt_id: number | null } | undefined;
  assert.ok(payrollRow8b, "RS-T8b FAIL: fact_payroll 应有重算后的行");
  assert.ok(
    payrollRow8b.receipt_id !== oldReceiptId,
    `RS-T8b FAIL: 重算后 receipt_id 应变为新 id，旧=${oldReceiptId}，新=${payrollRow8b.receipt_id}`
  );

  db.close();
  delete process.env.FINANCE_AGENT_DB_PATH;
  console.log("receipt-store: all checks passed ✓");
})();
