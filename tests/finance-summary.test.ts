import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import path from "node:path";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import {
  confirmPayrollPeriod,
  getInvoiceLedgerStats,
  getPayrollPeriodSummary,
  recordInvoices,
  savePayrollDraft
} from "../lib/db/finance-store.ts";
import { calculateCumulativePayroll } from "../lib/domain/tax-cumulative.ts";
import { createPayrollTools } from "../lib/agent/tools/finance/payroll.ts";

export const financeSummaryTestPromise = (async () => {
  const baseDir = `/tmp/finance-agent-summary-${process.pid}`;
  const dbPath = path.join(baseDir, "summary.db");

  // 用 env 让 getDb()(工具链路)与测试指向同一临时库;先清理避免被前序套件污染
  delete process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  const db = initializeFinanceDatabase(openFinanceDatabase(dbPath));

  const calc = (name: string, months: number) =>
    calculateCumulativePayroll({
      employeeName: name,
      grossPay: 20000,
      socialInsurance: 2000,
      housingFund: 1500,
      specialDeduction: 1000,
      monthsEmployed: months
    });

  // ── T1: 期间汇总:草稿/已确认分开计数 ────────────────────────────────
  savePayrollDraft(2026, 6, calc("张三", 6), 6, { db });
  savePayrollDraft(2026, 6, calc("李四", 6), 6, { db });
  savePayrollDraft(2026, 5, calc("王五", 5), 5, { db });
  confirmPayrollPeriod(2026, 5, undefined, db);

  const summary = getPayrollPeriodSummary(2026, 6, db);
  assert.equal(summary.draftCount, 2, "T1 FAIL: 6 月应有 2 份草稿");
  assert.equal(summary.confirmedCount, 0);
  assert.deepEqual(summary.draftEmployees.sort(), ["张三", "李四"].sort());
  assert.deepEqual(summary.latestConfirmedPeriod, { year: 2026, month: 5, count: 1 }, "T1 FAIL: 最近确认期间应为 2026-05");

  // ── T2: 发票台账统计 ────────────────────────────────────────────────
  recordInvoices([{ invoiceNo: "INV-A", amount: 100 }, { invoiceNo: "INV-B", amount: 200 }], db);
  const now = new Date();
  const stats = getInvoiceLedgerStats(now.getFullYear(), now.getMonth() + 1, db);
  assert.equal(stats.total, 2, "T2 FAIL: 台账总数");
  assert.equal(stats.addedThisMonth, 2, "T2 FAIL: 本月新增(recorded_at 为当前时间)");
  const statsOtherMonth = getInvoiceLedgerStats(2020, 1, db);
  assert.equal(statsOtherMonth.addedThisMonth, 0, "T2 FAIL: 其他月份新增应为 0");

  // ── T3: 工资确认(关键写操作)触发备份 ────────────────────────────────
  // 通过真实工具 handler 走 getDb() 链路(env 已指向临时库)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = { tool: (name: string, _d: string, _s: unknown, handler: any) => { captured[name] = handler; return { name }; } };
  createPayrollTools(mockSdk);

  const backupsDir = path.join(baseDir, "backups");
  const countBackups = () => {
    try {
      return readdirSync(backupsDir).filter((f) => f.endsWith(".db")).length;
    } catch {
      return 0;
    }
  };

  const before = countBackups();
  const result = await captured["confirm_payroll_period"]({ year: 2026, month: 6 });
  assert.ok(!result.isError, `T3 FAIL: 确认失败:${JSON.stringify(result.content)}`);
  const after = countBackups();
  assert.ok(after > before, `T3 FAIL: 确认后应新增备份(before=${before}, after=${after})`);

  // 确认结果落库(经 getDb 链路)
  const summaryAfter = getPayrollPeriodSummary(2026, 6, db);
  assert.equal(summaryAfter.confirmedCount, 2, "T3 FAIL: 确认后 6 月应有 2 人 confirmed");
  assert.equal(summaryAfter.draftCount, 0);

  db.close();
  delete process.env.FINANCE_AGENT_DB_PATH;
  console.log("finance-summary: all 3 checks passed ✓");
})();
