import assert from "node:assert/strict";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { findInvoicesInLedger, loadReimbursementSingleLimit, recordInvoices } from "../lib/db/finance-store.ts";
import { sortReimbursementsByRisk, validateReimbursements } from "../lib/domain/reimbursement.ts";

export const reimbursementLedgerTestPromise = (async () => {
  const db = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-invoice-ledger-${process.pid}.db`));

  // ── T1: 台账登记与重复检出 ──────────────────────────────────────────
  const first = recordInvoices(
    [
      { invoiceNo: "INV-2026-001", amount: 320, invoiceDate: "2026-05-10", category: "交通" },
      { invoiceNo: "INV-2026-002", amount: 1500, invoiceDate: "2026-05-12", category: "住宿" }
    ],
    db
  );
  assert.deepEqual(first.inserted, ["INV-2026-001", "INV-2026-002"]);
  assert.equal(first.duplicates.length, 0);

  const second = recordInvoices([{ invoiceNo: "INV-2026-001", amount: 320, category: "交通" }], db);
  assert.equal(second.inserted.length, 0, "T1 FAIL: 已登记发票不应重复入账");
  assert.equal(second.duplicates[0].invoiceNo, "INV-2026-001", "T1 FAIL: 重复必须显式报告");

  const auditCount = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'invoice_ledger_record'")
    .get() as { n: number };
  assert.equal(auditCount.n, 1, "T1 FAIL: 入台账写审计日志(无新增时不写)");

  // ── T2: 跨月历史查重进入校验警告 ────────────────────────────────────
  const history = findInvoicesInLedger(["INV-2026-001", "INV-2026-999"], db);
  assert.equal(history.size, 1);
  const checked = validateReimbursements(
    [
      { employeeName: "A", expenseDate: "2026-06-01", invoiceNo: "INV-2026-001", category: "交通", amount: 320 },
      { employeeName: "B", expenseDate: "2026-06-02", invoiceNo: "INV-2026-999", category: "餐饮", amount: 80 }
    ],
    { singleLimit: 1500 },
    history
  );
  const dupWarning = checked[0].warnings.find((w) => w.startsWith("历史重复"));
  assert.ok(dupWarning, "T2 FAIL: 台账中已有的发票必须报历史重复");
  assert.match(dupWarning!, /历史重复\(\d{4}-\d{2} 已登记\)/, "T2 FAIL: 必须标注首次登记年月");
  assert.deepEqual(checked[1].warnings, [], "T2 FAIL: 未登记发票不应误报");

  // ── T3: 批内重复回归(原有规则不被破坏)──────────────────────────────
  const batch = validateReimbursements(
    [
      { employeeName: "A", expenseDate: "2026-05-01", invoiceNo: "INV-1", category: "交通", amount: 100 },
      { employeeName: "B", expenseDate: "2026-05-02", invoiceNo: "INV-1", category: "", amount: 2000 }
    ],
    { singleLimit: 1500 }
  );
  assert.deepEqual(batch[0].warnings, ["发票号重复"]);
  assert.deepEqual(batch[1].warnings, ["缺少类目", "超过单笔标准", "发票号重复"]);

  // ── T4: 异常按风险排序:历史重复 > 批内重复 > 超标 > 缺字段 > 无异常 ──
  const sorted = sortReimbursementsByRisk([
    { employeeName: "干净", expenseDate: "2026-06-01", invoiceNo: "N-1", category: "交通", amount: 50, warnings: [] },
    { employeeName: "缺类目", expenseDate: "2026-06-01", invoiceNo: "N-2", category: "", amount: 50, warnings: ["缺少类目"] },
    { employeeName: "超标", expenseDate: "2026-06-01", invoiceNo: "N-3", category: "住宿", amount: 9000, warnings: ["超过单笔标准"] },
    { employeeName: "历史", expenseDate: "2026-06-01", invoiceNo: "N-4", category: "交通", amount: 50, warnings: ["历史重复(2026-05 已登记)"] },
    { employeeName: "批内", expenseDate: "2026-06-01", invoiceNo: "N-5", category: "交通", amount: 50, warnings: ["发票号重复"] }
  ]);
  assert.deepEqual(
    sorted.map((i) => i.employeeName),
    ["历史", "批内", "超标", "缺类目", "干净"],
    "T4 FAIL: 风险排序不正确"
  );

  // ── T5: 单笔上限可配置(WP4 / AC4.1),非法值回落默认 ────────────────────
  assert.equal(loadReimbursementSingleLimit(db), 1500, "T5 FAIL: 未配置时默认 1500");
  db.prepare("INSERT INTO app_settings(key,value) VALUES('reimbursement_single_limit','800')").run();
  assert.equal(loadReimbursementSingleLimit(db), 800, "T5 FAIL: 配置值应生效");
  db.prepare("UPDATE app_settings SET value='不是数字' WHERE key='reimbursement_single_limit'").run();
  assert.equal(loadReimbursementSingleLimit(db), 1500, "T5 FAIL: 非法配置值应回落默认 1500");
  db.prepare("UPDATE app_settings SET value='-5' WHERE key='reimbursement_single_limit'").run();
  assert.equal(loadReimbursementSingleLimit(db), 1500, "T5 FAIL: 非正值应回落默认 1500");

  db.close();
  console.log("reimbursement-ledger: all 5 checks passed ✓");
})();
