/**
 * WP13b: 销项发票登记 + 发票级账龄 + 回款落盘——spec §1 成功标准全覆盖测试
 *
 * 先红后绿（TDD）：先写此测试文件，跑红；再实现 v13 迁移 + store 函数 + 三工具。
 */

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export const salesInvoicesTestPromise = (async () => {
  // ── 环境隔离：每次测试用独立 db ────────────────────────────────────────────
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "sales-invoices-test-"));
  const dbPath = path.join(baseDir, "sales-invoices.db");
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
  const db = openFinanceDatabase(dbPath);
  initializeFinanceDatabase(db);

  const { recordInvoices, settleInvoice, listSalesInvoices } = await import("../lib/db/finance-store.ts");
  const { undoAuditEntry } = await import("../lib/db/audit-store.ts");

  // ── SI-1: v13 迁移形状——新三列全部存在 ─────────────────────────────────
  type ColInfo = { name: string; type: string; notnull: number; dflt_value: string | null };
  const cols = db.prepare("PRAGMA table_info(fact_invoices)").all() as ColInfo[];
  const colNames = cols.map((c) => c.name);
  assert.ok(colNames.includes("settled_at"), "SI-1 FAIL: fact_invoices 缺 settled_at 列");
  assert.ok(colNames.includes("settled_amount_cents"), "SI-1 FAIL: fact_invoices 缺 settled_amount_cents 列");
  assert.ok(colNames.includes("settlement_note"), "SI-1 FAIL: fact_invoices 缺 settlement_note 列");

  // 三列均允许 NULL（notnull=0）
  const settledAtCol = cols.find((c) => c.name === "settled_at");
  const settledAmtCol = cols.find((c) => c.name === "settled_amount_cents");
  const settledNoteCol = cols.find((c) => c.name === "settlement_note");
  assert.equal(settledAtCol?.notnull, 0, "SI-1 FAIL: settled_at 应允许 NULL");
  assert.equal(settledAmtCol?.notnull, 0, "SI-1 FAIL: settled_amount_cents 应允许 NULL");
  assert.equal(settledNoteCol?.notnull, 0, "SI-1 FAIL: settlement_note 应允许 NULL");

  // ── SI-2: 销项登记（direction='out' 落库 + 审计行含正确 event_type/tool_name）
  const r2 = recordInvoices(
    [
      {
        invoiceNo: "OUT-SI-001",
        amount: 5000,
        invoiceDate: "2026-06-01",
        category: "技术服务",
        counterparty: "测试客户A",
        direction: "out",
        conversationId: 99,
      },
    ],
    db,
    { eventType: "sales_invoice_record", toolName: "record_sales_invoices" }
  );
  assert.deepEqual(r2.inserted, ["OUT-SI-001"], "SI-2 FAIL: 销项登记应成功写入");
  const row2 = db.prepare("SELECT direction, settlement_status FROM fact_invoices WHERE invoice_no = ?").get("OUT-SI-001") as { direction: string; settlement_status: string } | undefined;
  assert.ok(row2, "SI-2 FAIL: 应能查到 OUT-SI-001");
  assert.equal(row2.direction, "out", "SI-2 FAIL: direction 应为 'out'");
  assert.equal(row2.settlement_status, "recorded", "SI-2 FAIL: 新登记 settlement_status 应为 'recorded'");

  // 审计行含 undo 载荷，且 event_type 为 'sales_invoice_record'（不能错记成报销工具）
  const auditRow2 = db.prepare(
    "SELECT undo, event_type, tool_name FROM audit_logs WHERE event_type='sales_invoice_record' ORDER BY id DESC LIMIT 1"
  ).get() as { undo: string | null; event_type: string; tool_name: string | null } | undefined;
  assert.ok(auditRow2, "SI-2 FAIL: 应有 event_type='sales_invoice_record' 的审计行（不能错记成 invoice_ledger_record）");
  assert.equal(auditRow2.event_type, "sales_invoice_record", "SI-2 FAIL: 销项审计 event_type 应为 'sales_invoice_record'");
  assert.equal(auditRow2.tool_name, "record_sales_invoices", "SI-2 FAIL: 销项审计 tool_name 应为 'record_sales_invoices'");
  assert.ok(auditRow2.undo, "SI-2 FAIL: 审计行应含 undo 载荷");
  const undo2 = JSON.parse(auditRow2.undo!) as Array<{ op: string; keys: string[] }>;
  assert.equal(undo2[0].op, "delete_rows", "SI-2 FAIL: 审计 undo 应为 delete_rows");
  assert.ok(undo2[0].keys.includes("OUT-SI-001"), "SI-2 FAIL: undo.keys 应含 OUT-SI-001");

  // 防回归：报销路径（无 auditHint）event_type 仍为 'invoice_ledger_record'
  recordInvoices([{ invoiceNo: "IN-REIMB-REGRESSION", amount: 500, direction: "in" as const, conversationId: 1 }], db);
  const reimbAudit = db.prepare(
    "SELECT event_type, tool_name FROM audit_logs WHERE event_type='invoice_ledger_record' ORDER BY id DESC LIMIT 1"
  ).get() as { event_type: string; tool_name: string | null } | undefined;
  assert.ok(reimbAudit, "SI-2 FAIL: 报销路径应仍有 event_type='invoice_ledger_record'");
  assert.equal(reimbAudit.event_type, "invoice_ledger_record", "SI-2 FAIL: 报销路径 event_type 应仍为 'invoice_ledger_record'");
  assert.equal(reimbAudit.tool_name, "record_reimbursement_invoices", "SI-2 FAIL: 报销路径 tool_name 应仍为 'record_reimbursement_invoices'");

  // ── SI-3: 回款落盘（settled 三列写入 + 审计行 undo=restore_rows before-image）──
  // 先插一张销项发票
  recordInvoices(
    [
      {
        invoiceNo: "OUT-SI-002",
        amount: 10000,
        invoiceDate: "2026-05-15",
        category: "咨询",
        counterparty: "测试客户B",
        direction: "out",
        conversationId: 99,
      },
    ],
    db
  );

  const settleResult = settleInvoice(
    {
      invoiceNo: "OUT-SI-002",
      settledAmountYuan: 10000,
      settledAt: "2026-07-01",
      note: "全额收款",
      conversationId: 77,
    },
    db
  );
  assert.equal(settleResult.success, true, "SI-3 FAIL: settleInvoice 应返回 success:true");

  const row3 = db.prepare(
    "SELECT settlement_status, settled_at, settled_amount_cents, settlement_note FROM fact_invoices WHERE invoice_no = ?"
  ).get("OUT-SI-002") as {
    settlement_status: string;
    settled_at: string | null;
    settled_amount_cents: number | null;
    settlement_note: string | null;
  } | undefined;
  assert.ok(row3, "SI-3 FAIL: 应能查到 OUT-SI-002");
  assert.equal(row3.settlement_status, "settled", "SI-3 FAIL: settlement_status 应为 'settled'");
  assert.equal(row3.settled_at, "2026-07-01", "SI-3 FAIL: settled_at 应为 '2026-07-01'");
  assert.equal(row3.settled_amount_cents, 1000000, "SI-3 FAIL: settled_amount_cents 应为 1000000 分（10000元×100）");
  assert.equal(row3.settlement_note, "全额收款", "SI-3 FAIL: settlement_note 应为 '全额收款'");

  // 审计行含 undo=restore_rows（before-image，此时三列均为 NULL）
  const auditRow3 = db.prepare(
    "SELECT undo FROM audit_logs WHERE event_type='invoice_settlement' ORDER BY id DESC LIMIT 1"
  ).get() as { id: number; undo: string | null };
  assert.ok(auditRow3?.undo, "SI-3 FAIL: 回款审计行应含 undo 载荷");
  const undo3 = JSON.parse(auditRow3.undo!) as Array<{ op: string; rows?: Record<string, unknown>[] }>;
  assert.equal(undo3[0].op, "restore_rows", "SI-3 FAIL: 回款 undo 应为 restore_rows");
  const beforeImage = undo3[0].rows?.[0];
  assert.ok(beforeImage, "SI-3 FAIL: before-image 应存在");
  // B2 约束：before-image 应含全列（含新三列，值均为 NULL）
  assert.ok("settled_at" in beforeImage, "SI-3 FAIL: before-image 应含 settled_at");
  assert.ok("settled_amount_cents" in beforeImage, "SI-3 FAIL: before-image 应含 settled_amount_cents");
  assert.ok("settlement_note" in beforeImage, "SI-3 FAIL: before-image 应含 settlement_note");
  assert.equal(beforeImage.settled_at, null, "SI-3 FAIL: before-image settled_at 应为 NULL");
  assert.equal(beforeImage.settled_amount_cents, null, "SI-3 FAIL: before-image settled_amount_cents 应为 NULL");
  assert.equal(beforeImage.settlement_note, null, "SI-3 FAIL: before-image settlement_note 应为 NULL");

  // N1：conversationId 透传到审计行
  const settleAuditConv = db.prepare(
    "SELECT conversation_id FROM audit_logs WHERE event_type='invoice_settlement' ORDER BY id DESC LIMIT 1"
  ).get() as { conversation_id: number | null };
  assert.equal(settleAuditConv.conversation_id, 77, "SI-3 FAIL: 回款审计行 conversation_id 应为 77（透传验证）");

  // ── SI-4: 回款撤销后三列回 NULL（B2 核心约束）──────────────────────────
  const auditRowForUndo = db.prepare(
    "SELECT id FROM audit_logs WHERE event_type='invoice_settlement' ORDER BY id DESC LIMIT 1"
  ).get() as { id: number };
  undoAuditEntry(auditRowForUndo.id, db);

  const row4 = db.prepare(
    "SELECT settlement_status, settled_at, settled_amount_cents, settlement_note FROM fact_invoices WHERE invoice_no = ?"
  ).get("OUT-SI-002") as {
    settlement_status: string;
    settled_at: string | null;
    settled_amount_cents: number | null;
    settlement_note: string | null;
  } | undefined;
  assert.ok(row4, "SI-4 FAIL: 撤销后 OUT-SI-002 应仍存在");
  assert.equal(row4.settlement_status, "recorded", "SI-4 FAIL: 撤销后 settlement_status 应回 'recorded'");
  assert.equal(row4.settled_at, null, "SI-4 FAIL: 撤销后 settled_at 应为 NULL");
  assert.equal(row4.settled_amount_cents, null, "SI-4 FAIL: 撤销后 settled_amount_cents 应为 NULL");
  assert.equal(row4.settlement_note, null, "SI-4 FAIL: 撤销后 settlement_note 应为 NULL");

  // ── SI-5: 重复回款拒绝（已 settled 拒绝并回显首次回款信息）──────────────
  // 先重新 settle OUT-SI-002
  settleInvoice(
    {
      invoiceNo: "OUT-SI-002",
      settledAmountYuan: 10000,
      settledAt: "2026-07-02",
    },
    db
  );
  // 再次 settle 应拒绝
  const settle5 = settleInvoice(
    {
      invoiceNo: "OUT-SI-002",
      settledAmountYuan: 10000,
    },
    db
  );
  assert.equal(settle5.success, false, "SI-5 FAIL: 已 settled 发票再次回款应拒绝");
  assert.ok(settle5.alreadySettled, "SI-5 FAIL: 应返回 alreadySettled 信息");

  // ── SI-6: 进项发票拒绝（direction='in' 不可用 settleInvoice）───────────
  recordInvoices(
    [
      {
        invoiceNo: "IN-SI-006",
        amount: 3000,
        invoiceDate: "2026-06-10",
        direction: "in",
        conversationId: 99,
      },
    ],
    db
  );
  const settle6 = settleInvoice({ invoiceNo: "IN-SI-006", settledAmountYuan: 3000 }, db);
  assert.equal(settle6.success, false, "SI-6 FAIL: 进项发票应被拒绝");
  assert.ok(settle6.wrongDirection, "SI-6 FAIL: 应返回 wrongDirection 标志");

  // ── SI-7: 发票不存在拒绝 ────────────────────────────────────────────────
  const settle7 = settleInvoice({ invoiceNo: "NONEXISTENT-999", settledAmountYuan: 100 }, db);
  assert.equal(settle7.success, false, "SI-7 FAIL: 不存在的发票应被拒绝");
  assert.ok(settle7.notFound, "SI-7 FAIL: 应返回 notFound 标志");

  // ── SI-8: 账龄计算（正值语义：已开票 N 天）──────────────────────────────
  // asOf=2026-07-07，invoice_date=2026-06-01 → agingDays = 36 天
  const invoiceDate8 = "2026-06-01";
  const asOf8 = "2026-07-07";
  // 先插一张账龄测试发票（方向 out，未 settled）
  recordInvoices(
    [
      {
        invoiceNo: "OUT-SI-008",
        amount: 8000,
        invoiceDate: invoiceDate8,
        category: "测试账龄",
        direction: "out",
        conversationId: 99,
      },
    ],
    db
  );
  const list8 = listSalesInvoices({ asOf: asOf8, includeSettled: false }, db);
  const entry8 = list8.find((r) => r.invoiceNo === "OUT-SI-008");
  assert.ok(entry8, "SI-8 FAIL: 应能查到 OUT-SI-008");
  assert.equal(entry8.agingDays, 36, `SI-8 FAIL: agingDays 应为 36，实际 ${entry8.agingDays}`);
  assert.ok(entry8.agingDays > 0, "SI-8 FAIL: 销项账龄应为正值（已开票天数）");

  // ── SI-9: invoice_date NULL 行 agingDays=null ──────────────────────────
  recordInvoices(
    [
      {
        invoiceNo: "OUT-SI-009-NULL-DATE",
        amount: 1000,
        direction: "out",
        conversationId: 99,
        // invoiceDate 故意不传 → NULL
      },
    ],
    db
  );
  const list9 = listSalesInvoices({ asOf: asOf8, includeSettled: false }, db);
  const entry9 = list9.find((r) => r.invoiceNo === "OUT-SI-009-NULL-DATE");
  assert.ok(entry9, "SI-9 FAIL: 应能查到 OUT-SI-009-NULL-DATE");
  assert.equal(entry9.agingDays, null, "SI-9 FAIL: invoice_date NULL 时 agingDays 应为 null");

  // ── SI-10: settled 行在 includeSettled=false 时被排除 ──────────────────
  // OUT-SI-002 已在 SI-5 中 settle
  const list10Excluded = listSalesInvoices({ asOf: asOf8, includeSettled: false }, db);
  assert.ok(!list10Excluded.find((r) => r.invoiceNo === "OUT-SI-002"), "SI-10 FAIL: settled 行应被排除（includeSettled=false）");
  const list10Included = listSalesInvoices({ asOf: asOf8, includeSettled: true }, db);
  assert.ok(list10Included.find((r) => r.invoiceNo === "OUT-SI-002"), "SI-10 FAIL: settled 行应被包含（includeSettled=true）");

  // settled 行 agingDays 不计算（为 null）
  const settled10 = list10Included.find((r) => r.invoiceNo === "OUT-SI-002")!;
  assert.equal(settled10.agingDays, null, "SI-10 FAIL: settled 行 agingDays 应为 null（不计算）");

  // ── SI-11: query_sales_invoices 工具 structuredContent 形状 ───────────
  const { createSalesInvoiceTools } = await import("../lib/agent/tools/finance/sales-invoices.ts");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = {
    tool: (_name: string, _desc: string, _schema: unknown, handler: (args: unknown) => Promise<unknown>) => ({ name: _name, handler })
  };
  const siTools = createSalesInvoiceTools(mockSdk);
  const queryTool = siTools.find((t: { name: string }) => t.name === "query_sales_invoices") as
    | { name: string; handler: (args: unknown) => Promise<{ structuredContent?: unknown; content: Array<{ type: string; text: string }> }> }
    | undefined;
  assert.ok(queryTool, "SI-11 FAIL: query_sales_invoices 工具应存在");

  const result11 = await queryTool.handler({ asOf: asOf8, includeSettled: false });
  assert.ok(result11.structuredContent, "SI-11 FAIL: 应有 structuredContent");
  const sc = result11.structuredContent as Record<string, unknown>;
  assert.ok("items" in sc, "SI-11 FAIL: structuredContent 应有 items 字段");
  assert.ok("agingSummary" in sc, "SI-11 FAIL: structuredContent 应有 agingSummary 字段");
  assert.ok("totalCount" in sc, "SI-11 FAIL: structuredContent 应有 totalCount 字段");

  // agingSummary 应有四个账龄桶
  const aging = sc.agingSummary as Record<string, unknown>;
  assert.ok("bucket0_30" in aging, "SI-11 FAIL: agingSummary 应有 bucket0_30");
  assert.ok("bucket31_60" in aging, "SI-11 FAIL: agingSummary 应有 bucket31_60");
  assert.ok("bucket61_90" in aging, "SI-11 FAIL: agingSummary 应有 bucket61_90");
  assert.ok("bucket90plus" in aging, "SI-11 FAIL: agingSummary 应有 bucket90plus");

  // ── SI-12: 负数回款 schema 拒绝（WP-D #3）────────────────────────────────────
  // record_invoice_settlement 处理器必须拒绝负数实收金额（isError=true）
  const settleTool12 = siTools.find((t: { name: string }) => t.name === "record_invoice_settlement") as
    | { name: string; handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }
    | undefined;
  assert.ok(settleTool12, "SI-12 FAIL: record_invoice_settlement 工具应存在");
  // 先插一张新的未回款销项发票
  recordInvoices([{ invoiceNo: "OUT-SI-012-NEG", amount: 1000, invoiceDate: "2026-07-01", direction: "out" as const, conversationId: 99 }], db);
  const settle12Result = await settleTool12.handler({
    invoiceNo: "OUT-SI-012-NEG",
    settledAmountYuan: -100, // 负数，应被拒绝
    conversationId: 99,
  });
  assert.ok(settle12Result.isError, "SI-12 FAIL: 负数回款金额应被拒绝（isError=true）");
  // 验证发票未被错误更新（仍为 recorded 状态）
  const row12After = db.prepare("SELECT settlement_status FROM fact_invoices WHERE invoice_no='OUT-SI-012-NEG'").get() as { settlement_status: string } | undefined;
  assert.ok(row12After, "SI-12 FAIL: OUT-SI-012-NEG 应仍存在");
  assert.equal(row12After.settlement_status, "recorded", "SI-12 FAIL: 拒绝后发票状态应仍为 recorded（未被错误更新）");

  // ── SI-13: 未来日期发票分箱守恒（WP-D #4）───────────────────────────────────
  // query_sales_invoices 应新增 futureDateCount 分箱，保证各桶之和 = 未回款总数
  recordInvoices([{
    invoiceNo: "OUT-SI-013-FUTURE",
    amount: 2000,
    invoiceDate: "2026-08-01", // 晚于 asOf=2026-07-07，agingDays < 0
    direction: "out" as const,
    conversationId: 99,
  }], db);
  const asOf13 = "2026-07-07";
  const result13 = await queryTool!.handler({ asOf: asOf13, includeSettled: false });
  assert.ok(result13.structuredContent, "SI-13 FAIL: 应有 structuredContent");
  const sc13 = result13.structuredContent as {
    agingSummary: Record<string, unknown>;
    totalCount: number;
    items: Array<{ invoiceNo: string; agingDays: number | null; settlementStatus: string }>;
  };
  assert.ok("futureDateCount" in sc13.agingSummary, "SI-13 FAIL: agingSummary 应有 futureDateCount 字段");
  assert.ok(
    typeof sc13.agingSummary.futureDateCount === "number" && (sc13.agingSummary.futureDateCount as number) >= 1,
    `SI-13 FAIL: futureDateCount 应 >= 1（含 OUT-SI-013-FUTURE），实际: ${sc13.agingSummary.futureDateCount}`
  );
  // 验证 OUT-SI-013-FUTURE agingDays < 0
  const futureEntry13 = sc13.items.find((r) => r.invoiceNo === "OUT-SI-013-FUTURE");
  assert.ok(futureEntry13, "SI-13 FAIL: 应能查到 OUT-SI-013-FUTURE");
  assert.ok(
    futureEntry13.agingDays != null && futureEntry13.agingDays < 0,
    `SI-13 FAIL: 未来日期发票 agingDays 应为负值，实际: ${futureEntry13.agingDays}`
  );
  // 分箱守恒：所有分箱 + nullDate + futureDateCount = 未回款总数
  const aging13 = sc13.agingSummary as {
    bucket0_30: { count: number }; bucket31_60: { count: number }; bucket61_90: { count: number };
    bucket90plus: { count: number }; nullDateCount: number; futureDateCount: number;
  };
  const accounted13 = aging13.bucket0_30.count + aging13.bucket31_60.count + aging13.bucket61_90.count +
    aging13.bucket90plus.count + aging13.nullDateCount + aging13.futureDateCount;
  assert.equal(
    accounted13, sc13.totalCount,
    `SI-13 FAIL: 分箱守恒失败—accounted=${accounted13} ≠ totalCount=${sc13.totalCount}`
  );

  // ── SI-14: uncertifiedCount 只数本月（WP-D #5）──────────────────────────────
  // getInvoiceLedgerBreakdown 的 uncertifiedCount 应只统计当月，不跨月
  const { getInvoiceLedgerBreakdown } = await import("../lib/db/finance-store.ts");
  // 先记录当前 6 月的 uncertifiedCount 基准
  const breakdown14base = getInvoiceLedgerBreakdown(2026, 6, db);
  // 添加一张 7 月发票（certification_status 默认 NULL）
  recordInvoices([{
    invoiceNo: "SI14-JUL-UNCERT",
    amount: 500,
    invoiceDate: "2026-07-20",
    direction: "in" as const,
    conversationId: 1,
  }], db);
  // 6 月 uncertifiedCount 不应因 7 月发票而改变
  const breakdown14after = getInvoiceLedgerBreakdown(2026, 6, db);
  assert.equal(
    breakdown14after.uncertifiedCount,
    breakdown14base.uncertifiedCount,
    `SI-14 FAIL: 添加7月发票后，6月 uncertifiedCount 不应改变（之前=${breakdown14base.uncertifiedCount}，之后=${breakdown14after.uncertifiedCount}）`
  );
  // 7 月 uncertifiedCount 应包含新发票
  const breakdown14jul = getInvoiceLedgerBreakdown(2026, 7, db);
  assert.ok(
    breakdown14jul.uncertifiedCount >= 1,
    `SI-14 FAIL: 7 月 uncertifiedCount 应 >= 1，实际: ${breakdown14jul.uncertifiedCount}`
  );

  // ── SI-15: 进项税部分和标注（WP-D #6）───────────────────────────────────────
  // getInvoiceLedgerBreakdown 应有 taxMissingCount 字段，
  // query_invoice_ledger 工具当 taxMissingCount > 0 时应在输出追加"张税额未录"标注
  recordInvoices([{
    invoiceNo: "SI15-IN-NOTAX",
    amount: 1000,
    invoiceDate: "2026-06-20",
    direction: "in" as const,
    conversationId: 1,
    // taxAmountCents 不传 → NULL，表示税额未录
  }], db);
  const breakdown15 = getInvoiceLedgerBreakdown(2026, 6, db);
  assert.ok("taxMissingCount" in breakdown15, "SI-15 FAIL: getInvoiceLedgerBreakdown 应有 taxMissingCount 字段");
  assert.ok(
    typeof breakdown15.taxMissingCount === "number" && breakdown15.taxMissingCount >= 1,
    `SI-15 FAIL: 有进项发票税额未录，taxMissingCount 应 >= 1，实际: ${(breakdown15 as Record<string, unknown>).taxMissingCount}`
  );
  // 工具输出应包含"张税额未录"标注
  const { createFinanceTools } = await import("../lib/agent/mcp-tools/finance-tools.ts");
  const captured15: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk15: any = {
    tool: (name: string, _d: string, _s: unknown, handler: unknown) => {
      captured15[name] = handler;
      return { name };
    }
  };
  createFinanceTools(mockSdk15, "/tmp");
  const ledgerHandler15 = captured15["query_invoice_ledger"] as ((args: { year: number; month: number }) => Promise<{ content: Array<{ type: string; text: string }> }>) | undefined;
  assert.ok(ledgerHandler15, "SI-15 FAIL: query_invoice_ledger 处理器应存在");
  const ledger15 = await ledgerHandler15({ year: 2026, month: 6 });
  const text15 = ledger15.content[0].text;
  assert.ok(
    text15.includes("税额未录"),
    `SI-15 FAIL: 有进项税额未录时，工具输出应包含"税额未录"标注，实际输出:\n${text15}`
  );

  // ── WPF-SI-16: NULL 方向发票返回 directionUnknown（不是 wrongDirection）──────
  // direction IS NULL 的历史发票，settleInvoice 应返回 directionUnknown，不得误报 wrongDirection。
  // 红测：改前 direction=NULL 会落入 `direction !== 'out'` 分支返回 wrongDirection，红。
  db.prepare(
    "INSERT INTO fact_invoices (invoice_no, amount_cents, direction, settlement_status, source) VALUES (?, ?, NULL, 'recorded', 'user_dictated')"
  ).run("WPF-NULL-DIR", 100000);
  const settleNullDir = settleInvoice({ invoiceNo: "WPF-NULL-DIR", settledAmountYuan: 1000 }, db);
  assert.equal(settleNullDir.success, false, "WPF-SI-16 FAIL: NULL direction 应被拒绝");
  assert.ok(
    "directionUnknown" in settleNullDir,
    `WPF-SI-16 FAIL: NULL direction 应返回 directionUnknown，实际: ${JSON.stringify(settleNullDir)}`
  );
  assert.ok(!("wrongDirection" in settleNullDir), "WPF-SI-16 FAIL: NULL direction 不应返回 wrongDirection");

  // ── WPF-SI-17: 工具层 NULL 方向文案 ─────────────────────────────────────────
  // 红测：改前会输出"进项发票"文案，红。
  const settleTool17 = siTools.find((t: { name: string }) => t.name === "record_invoice_settlement") as
    | { name: string; handler: (args: unknown) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }
    | undefined;
  assert.ok(settleTool17, "WPF-SI-17 FAIL: record_invoice_settlement 工具应存在");
  const result17 = await settleTool17.handler({ invoiceNo: "WPF-NULL-DIR", settledAmountYuan: 1000, conversationId: 1 });
  assert.ok(result17.isError, "WPF-SI-17 FAIL: NULL direction 应触发 isError");
  assert.ok(
    result17.content[0].text.includes("历史发票未标注方向"),
    `WPF-SI-17 FAIL: NULL direction 工具输出应包含"历史发票未标注方向"，实际: ${result17.content[0].text}`
  );
  assert.ok(
    !result17.content[0].text.includes("进项发票"),
    `WPF-SI-17 FAIL: NULL direction 输出不应含"进项发票"误导文案，实际: ${result17.content[0].text}`
  );

  // ── WPF-SI-18: settleInvoice SQL 层守卫——guarded UPDATE 对已结 invoice 影响 0 行 ──
  // 验证带 AND (settlement_status IS NULL OR settlement_status != 'settled') 守卫的 SQL 语法正确。
  // 此测试直接运行 guarded SQL（绕过 JS 快照检查），验证并发防写机制。
  db.prepare(
    "INSERT INTO fact_invoices (invoice_no, amount_cents, direction, settlement_status, settled_at, settled_amount_cents, source) VALUES (?, ?, 'out', 'settled', '2026-07-01', 200000, 'user_dictated')"
  ).run("WPF-SQL-GUARD", 200000);
  db.exec("BEGIN");
  const guardResult = db.prepare(`
    UPDATE fact_invoices
    SET settlement_status    = 'settled',
        settled_at           = ?,
        settled_amount_cents = ?,
        settlement_note      = ?
    WHERE invoice_no = ? AND (settlement_status IS NULL OR settlement_status != 'settled')
  `).run("2026-07-02", 250000, null, "WPF-SQL-GUARD");
  if (guardResult.changes === 0) {
    db.exec("ROLLBACK");
  } else {
    db.exec("COMMIT");
  }
  assert.equal(guardResult.changes, 0, "WPF-SI-18 FAIL: SQL 守卫应使已结发票 UPDATE 影响 0 行");
  const rowAfterGuard = db.prepare(
    "SELECT settled_at, settled_amount_cents FROM fact_invoices WHERE invoice_no = 'WPF-SQL-GUARD'"
  ).get() as { settled_at: string; settled_amount_cents: number };
  assert.equal(rowAfterGuard.settled_at, "2026-07-01", "WPF-SI-18 FAIL: settled_at 不应被覆盖");
  assert.equal(rowAfterGuard.settled_amount_cents, 200000, "WPF-SI-18 FAIL: settled_amount_cents 不应被覆盖");

  // ── WPF-SI-19: ROLLBACK 后 DB 处于干净状态（可立即 BEGIN 新事务）──────────────
  // 验证守卫命中路径的 ROLLBACK 确实关闭了事务（不会导致"cannot start a transaction within a transaction"）
  {
    let txErr: unknown;
    try {
      db.exec("BEGIN");
      db.exec("ROLLBACK");
    } catch (e) {
      txErr = e;
    }
    assert.ok(!txErr, `WPF-SI-19 FAIL: ROLLBACK 后应能正常 BEGIN 新事务，实际: ${txErr}`);
  }

  db.close();
  console.log("sales-invoices: all checks passed ✓");
})();
