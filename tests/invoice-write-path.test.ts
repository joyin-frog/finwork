/**
 * WP1c: 发票写入端补字段 + query_invoice_ledger 读工具
 * 先红后绿 TDD：
 *   1. 写入三路径（全字段 / 零新字段 / 非法税率拒绝）
 *   2. getInvoiceLedgerBreakdown 查询汇总
 *   3. NULL 语义（新字段默认 NULL 落库）
 */
import assert from "node:assert/strict";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import {
  recordInvoices,
  getInvoiceLedgerBreakdown,
} from "../lib/db/finance-store.ts";
import { createReimbursementTools } from "../lib/agent/tools/finance/reimbursement.ts";

export const invoiceWritePathTestPromise = (async () => {
  const db = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-invoice-write-path-${process.pid}.db`));

  // ── T1: 全字段写入 ──────────────────────────────────────────────────────
  // recordInvoices 扩展后须支持 taxRate / taxAmountCents / counterparty / direction / certificationStatus
  const r1 = recordInvoices(
    [
      {
        invoiceNo: "INV-FULL-001",
        amount: 1000,
        invoiceDate: "2026-07-01",
        category: "差旅",
        taxRate: 0.09,
        taxAmountCents: 9000,     // 元转分：90 元 × 100 = 9000 分
        counterparty: "测试供应商A",
        direction: "in",
        certificationStatus: null,
      }
    ],
    db
  );
  assert.deepEqual(r1.inserted, ["INV-FULL-001"], "T1 FAIL: 全字段写入应成功");

  // 验证落库值
  const row1 = db.prepare(
    "SELECT invoice_no, tax_rate, tax_amount_cents, counterparty, direction, certification_status FROM fact_invoices WHERE invoice_no = ?"
  ).get("INV-FULL-001") as {
    invoice_no: string;
    tax_rate: number | null;
    tax_amount_cents: number | null;
    counterparty: string | null;
    direction: string | null;
    certification_status: string | null;
  } | undefined;
  assert.ok(row1, "T1 FAIL: 应能查到写入的发票");
  assert.ok(Math.abs((row1.tax_rate ?? 0) - 0.09) < 0.0001, `T1 FAIL: tax_rate 应为 0.09，实际 ${row1.tax_rate}`);
  assert.equal(row1.tax_amount_cents, 9000, "T1 FAIL: tax_amount_cents 应为 9000");
  assert.equal(row1.counterparty, "测试供应商A", "T1 FAIL: counterparty 字段未写入");
  assert.equal(row1.direction, "in", "T1 FAIL: direction 应为 'in'");
  assert.equal(row1.certification_status, null, "T1 FAIL: certification_status 应为 NULL");

  // ── T2: 零新字段写入（历史兼容路径不变）────────────────────────────────
  const r2 = recordInvoices(
    [
      { invoiceNo: "INV-MIN-001", amount: 200, invoiceDate: "2026-07-02", category: "办公" }
    ],
    db
  );
  assert.deepEqual(r2.inserted, ["INV-MIN-001"], "T2 FAIL: 零新字段写入应成功");

  const row2 = db.prepare(
    "SELECT tax_rate, tax_amount_cents, counterparty, direction, certification_status FROM fact_invoices WHERE invoice_no = ?"
  ).get("INV-MIN-001") as {
    tax_rate: number | null;
    tax_amount_cents: number | null;
    counterparty: string | null;
    direction: string | null;
    certification_status: string | null;
  } | undefined;
  assert.ok(row2, "T2 FAIL: 应能查到最小字段写入的发票");
  assert.equal(row2.tax_rate, null, "T2 FAIL: 未传 taxRate 应为 NULL");
  assert.equal(row2.tax_amount_cents, null, "T2 FAIL: 未传 taxAmountCents 应为 NULL");
  assert.equal(row2.counterparty, null, "T2 FAIL: 未传 counterparty 应为 NULL");
  assert.equal(row2.direction, null, "T2 FAIL: 未传 direction 应为 NULL");

  // ── T3: 非法税率在工具层被拒绝（zod + handler 校验）───────────────────
  // 模拟工具调用：taxRate > 1 应被拒绝，不写入台账
  let toolRejected = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => ({ name: _name, handler })
  };
  const tools = createReimbursementTools(mockSdk);
  const recordTool = tools.find((t: { name: string }) => t.name === "record_reimbursement_invoices") as { name: string; handler?: (args: unknown) => Promise<{ isError?: boolean; content: Array<{ text: string }> }> };
  assert.ok(recordTool, "T3 FAIL: record_reimbursement_invoices 工具应存在");
  if (recordTool.handler) {
    const result = await recordTool.handler({
      items: [{ invoiceNo: "INV-BAD-RATE", amount: 500, taxRate: "1.5", invoiceDate: "2026-07-03" }],
      idempotency_key: "test-bad-rate"
    }) as { isError?: boolean; content: Array<{ text: string }> };
    toolRejected = result.isError === true || (result.content?.[0]?.text ?? "").includes("税率");
  }
  assert.ok(toolRejected, "T3 FAIL: 非法税率(>1)应被工具层拒绝");

  // ── T4: getInvoiceLedgerBreakdown 查询汇总 ──────────────────────────────
  // 再写入一条进项、2026-07 数据
  recordInvoices(
    [
      {
        invoiceNo: "INV-SUMMARY-001",
        amount: 500,
        invoiceDate: "2026-07-01",
        category: "差旅",
        direction: "in",
        taxAmountCents: 4500,
        certificationStatus: null,
      },
      {
        invoiceNo: "INV-SUMMARY-002",
        amount: 300,
        invoiceDate: "2026-07-15",
        category: "餐饮",
        direction: "in",
        taxAmountCents: 2700,
        certificationStatus: null,
      },
      {
        invoiceNo: "INV-SUMMARY-UNKNOWN-DIR",
        amount: 150,
        invoiceDate: "2026-07-20",
        category: "办公",
        // direction 不传 → NULL → directionUnknownCount +1
      }
    ],
    db
  );

  const breakdown = getInvoiceLedgerBreakdown(2026, 7, db);
  // total: INV-FULL-001 + INV-MIN-001 + INV-SUMMARY-001 + INV-SUMMARY-002 + INV-SUMMARY-UNKNOWN-DIR = 5
  assert.ok(typeof breakdown.total === "number", "T4 FAIL: breakdown.total 应为数字");
  assert.ok(breakdown.total >= 5, `T4 FAIL: 台账总数应 ≥ 5，实际 ${breakdown.total}`);
  assert.ok(typeof breakdown.directionIn?.count === "number", "T4 FAIL: directionIn.count 应为数字");
  assert.ok(breakdown.directionIn.count >= 3, `T4 FAIL: direction='in' 数量应 ≥ 3，实际 ${breakdown.directionIn.count}`);
  // INV-FULL-001(9000) + INV-SUMMARY-001(4500) + INV-SUMMARY-002(2700) = 16200
  assert.ok(breakdown.directionIn.taxAmountCentsSum >= 16200, `T4 FAIL: 进项税额合计应 ≥ 16200 分，实际 ${breakdown.directionIn.taxAmountCentsSum}`);
  assert.ok(typeof breakdown.directionUnknownCount === "number", "T4 FAIL: directionUnknownCount 应为数字");
  assert.ok(breakdown.directionUnknownCount >= 2, `T4 FAIL: 未知方向应 ≥ 2（INV-MIN-001 + INV-SUMMARY-UNKNOWN-DIR），实际 ${breakdown.directionUnknownCount}`);

  // ── T5: NULL 语义——certification_status 恒 NULL ──────────────────────
  // 使用 T4 中写入的有 direction 的发票
  const row3 = db.prepare(
    "SELECT certification_status FROM fact_invoices WHERE invoice_no = ?"
  ).get("INV-SUMMARY-001") as { certification_status: string | null } | undefined;
  assert.ok(row3, "T5 FAIL: 应能查到 INV-SUMMARY-001");
  assert.equal(row3.certification_status, null, "T5 FAIL: certification_status 应恒为 NULL");

  db.close();
  console.log("invoice-write-path: all 5 checks passed ✓");
})();
