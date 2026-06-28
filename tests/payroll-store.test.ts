import assert from "node:assert/strict";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import {
  confirmPayrollPeriod,
  getLatestConfirmedPayroll,
  listPayrollRecords,
  savePayrollDraft
} from "../lib/db/finance-store.ts";
import { calculateCumulativePayroll, ZERO_PRIOR_CUMULATIVE } from "../lib/domain/tax-cumulative.ts";

export const payrollStoreTestPromise = (async () => {
  const db = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-payroll-store-${process.pid}.db`));

  const may = calculateCumulativePayroll({
    employeeName: "张三",
    grossPay: 30000,
    socialInsurance: 4500,
    housingFund: 0,
    specialDeduction: 2000,
    monthsEmployed: 5,
    prior: ZERO_PRIOR_CUMULATIVE
  });

  // ── T1: 草稿写入与重算覆盖 ───────────────────────────────────────────
  savePayrollDraft(2026, 5, may, 5, { db });
  savePayrollDraft(2026, 5, may, 5, { db }); // 重算覆盖 draft 不报错、不产生重复行
  let records = listPayrollRecords(2026, 5, db);
  assert.equal(records.length, 1, "T1 FAIL: 重算应覆盖草稿而不是新增行");
  assert.equal(records[0].status, "draft");
  assert.equal(records[0].taxConfigVersion, may.detail.taxConfigVersion);

  // ── T2: 确认流转 + 审计日志 ─────────────────────────────────────────
  const { confirmed } = confirmPayrollPeriod(2026, 5, undefined, db);
  assert.deepEqual(confirmed, ["张三"]);
  records = listPayrollRecords(2026, 5, db);
  assert.equal(records[0].status, "confirmed");
  assert.ok(records[0].confirmedAt, "T2 FAIL: confirmed_at 应有值");
  const audit = db
    .prepare("SELECT payload FROM audit_logs WHERE event_type = 'payroll_confirm'")
    .all() as Array<{ payload: string }>;
  assert.equal(audit.length, 1, "T2 FAIL: 确认必须写审计日志");
  assert.ok(audit[0].payload.includes("张三"));

  // ── T3: confirmed 拒绝静默覆盖,显式 overwrite 才放行且留审计 ─────────
  assert.throws(
    () => savePayrollDraft(2026, 5, may, 5, { db }),
    /已确认生效,拒绝静默覆盖/,
    "T3 FAIL: 已确认期间重算必须被拒绝"
  );
  savePayrollDraft(2026, 5, may, 5, { db, overwriteConfirmed: true });
  assert.equal(listPayrollRecords(2026, 5, db)[0].status, "draft", "T3 FAIL: 显式重算后回到 draft");
  const overwriteAudit = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirmed_overwrite'")
    .get() as { n: number };
  assert.equal(overwriteAudit.n, 1, "T3 FAIL: 覆盖已确认记录必须留审计");
  confirmPayrollPeriod(2026, 5, undefined, db);

  // ── T4: 跨月累计接力,只认 confirmed ─────────────────────────────────
  const prior5 = getLatestConfirmedPayroll("张三", 2026, 6, db);
  assert.ok(prior5, "T4 FAIL: 应取到 5 月已确认记录");
  assert.equal(prior5!.month, 5);
  const june = calculateCumulativePayroll({
    employeeName: "张三",
    grossPay: 30000,
    socialInsurance: 4500,
    housingFund: 0,
    specialDeduction: 2000,
    monthsEmployed: prior5!.monthsEmployed + 1,
    prior: {
      grossCum: prior5!.grossCum,
      socialCum: prior5!.socialCum,
      fundCum: prior5!.fundCum,
      specialCum: prior5!.specialCum,
      taxWithheldCum: prior5!.taxWithheldCum
    }
  });
  savePayrollDraft(2026, 6, june, 6, { db });
  // 6 月草稿未确认 → 7 月接力仍应取 5 月
  const priorFor7 = getLatestConfirmedPayroll("张三", 2026, 7, db);
  assert.equal(priorFor7!.month, 5, "T4 FAIL: 草稿不能作为累计基础");

  // ── T5: 没有可确认草稿时显式报错 ────────────────────────────────────
  assert.throws(() => confirmPayrollPeriod(2026, 7, undefined, db), /没有待确认的工资草稿/);

  // ── T6: 事务 happy-path — 3 员工同时确认,全部变 confirmed + 1 条审计日志 ──
  const employees6 = ["李四", "王五", "赵六"];
  for (const name of employees6) {
    const calc = calculateCumulativePayroll({
      employeeName: name,
      grossPay: 20000,
      socialInsurance: 3000,
      housingFund: 0,
      specialDeduction: 1000,
      monthsEmployed: 1,
      prior: ZERO_PRIOR_CUMULATIVE
    });
    savePayrollDraft(2025, 1, calc, 1, { db });
  }
  const { confirmed: confirmed6 } = confirmPayrollPeriod(2025, 1, undefined, db);
  assert.deepEqual(confirmed6.sort(), [...employees6].sort(), "T6 FAIL: 3 员工应全部被确认");
  const records6 = listPayrollRecords(2025, 1, db);
  assert.ok(
    records6.every((r) => r.status === "confirmed"),
    "T6 FAIL: 所有行应变为 confirmed"
  );
  const audit6 = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirm' AND payload LIKE '%2025%'")
    .get() as { n: number };
  assert.equal(audit6.n, 1, "T6 FAIL: 批量确认应写入恰好 1 条审计日志");

  // ── T7: 事务 error-path — 员工不存在时抛错,审计日志不增加 ────────────
  const auditBefore = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirm'")
    .get() as { n: number };
  assert.throws(
    () => confirmPayrollPeriod(2025, 2, ["不存在的人"], db),
    /没有待确认的工资草稿/,
    "T7 FAIL: 不存在的员工应抛错"
  );
  const auditAfter = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirm'")
    .get() as { n: number };
  assert.equal(auditAfter.n, auditBefore.n, "T7 FAIL: 失败路径不应增加审计日志");

  db.close();
  console.log("payroll-store: all 7 checks passed ✓");
})();
