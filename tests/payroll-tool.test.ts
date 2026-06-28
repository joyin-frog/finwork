import assert from "node:assert/strict";
import path from "node:path";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { confirmPayrollPeriod, listPayrollRecords } from "../lib/db/finance-store.ts";
import { createPayrollTools } from "../lib/agent/tools/finance/payroll.ts";

export const payrollToolTestPromise = (async () => {
  const dbPath = path.join(`/tmp/finance-agent-payroll-tool-${process.pid}`, "payroll-tool.db");

  delete process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  const db = initializeFinanceDatabase(openFinanceDatabase(dbPath));

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const captured: Record<string, any> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockSdk: any = { tool: (name: string, _d: string, _s: unknown, handler: any) => { captured[name] = handler; return { name }; } };
  createPayrollTools(mockSdk);

  // ── T1: COLD-START (ytd 提供,推入 coldStarts) ────────────────────────
  const r1 = await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 3,
    employees: [{
      employeeName: "甲",
      grossPay: 30000,
      socialInsurance: 3000,
      housingFund: 1500,
      specialDeduction: 1000,
      monthsEmployed: 3,
      ytd: {
        grossCum: 60000,
        socialCum: 6000,
        fundCum: 3000,
        specialCum: 2000,
        taxWithheldCum: 1000
      }
    }]
  });
  assert.ok(!r1.isError, `T1 FAIL: isError 应为 falsy,实际:${JSON.stringify(r1)}`);
  assert.ok(r1.structuredContent.coldStarts.includes("甲"), `T1 FAIL: coldStarts 应含"甲",实际:${JSON.stringify(r1.structuredContent.coldStarts)}`);
  assert.equal(r1.structuredContent.failures.length, 0, `T1 FAIL: failures 应为空,实际:${JSON.stringify(r1.structuredContent.failures)}`);
  assert.equal(r1.structuredContent.results.length, 1, `T1 FAIL: results 应有 1 条,实际:${r1.structuredContent.results.length}`);

  // ── T2: RELAY INFERENCE (上月已确认 → 本月 monthsEmployed 自动 +1) ────
  // 先算 6 月草稿
  await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 6,
    employees: [{
      employeeName: "乙",
      grossPay: 20000,
      socialInsurance: 2000,
      housingFund: 1500,
      specialDeduction: 1000,
      monthsEmployed: 6
    }]
  });
  // 确认 6 月(写入 db,供 getLatestConfirmedPayroll 查询)
  confirmPayrollPeriod(2026, 6, undefined, db);
  // 计算 7 月:不传 monthsEmployed,不传 ytd → 应从已确认 6 月推算 monthsEmployed=7
  await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 7,
    employees: [{
      employeeName: "乙",
      grossPay: 20000,
      socialInsurance: 2000,
      housingFund: 1500,
      specialDeduction: 1000
    }]
  });
  const rec = listPayrollRecords(2026, 7, db).find((r) => r.employeeName === "乙");
  assert.ok(rec, "T2 FAIL: 7 月找不到乙的记录");
  assert.equal(rec.monthsEmployed, 7, `T2 FAIL: 应由上月已确认 6 推算为 7,实际:${rec.monthsEmployed}`);

  // ── T3: FAILURE (ytd 但缺 monthsEmployed) ────────────────────────────
  const r3 = await captured["calculate_payroll_batch"]({
    year: 2026,
    month: 4,
    employees: [{
      employeeName: "丙",
      grossPay: 20000,
      socialInsurance: 2000,
      housingFund: 1500,
      specialDeduction: 1000,
      monthsEmployed: null,
      ytd: {
        grossCum: 0,
        socialCum: 0,
        fundCum: 0,
        specialCum: 0,
        taxWithheldCum: 0
      }
    }]
  });
  assert.equal(r3.structuredContent.failures.length, 1, `T3 FAIL: failures 应有 1 条,实际:${JSON.stringify(r3.structuredContent.failures)}`);
  assert.equal(r3.structuredContent.results.length, 0, `T3 FAIL: results 应为空,实际:${r3.structuredContent.results.length}`);
  assert.equal(r3.isError, true, `T3 FAIL: isError 应为 true,实际:${r3.isError}`);

  db.close();
  delete process.env.FINANCE_AGENT_DB_PATH;
  console.log("payroll-tool: all 3 checks passed ✓");
})();
