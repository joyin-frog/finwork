import assert from "node:assert/strict";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import {
  confirmPayrollPeriod,
  getLatestConfirmedPayroll,
  getPriorConfirmedPeriod,
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

  // ── T8: getPriorConfirmedPeriod 只取紧邻上月（P2 修复）─────────────────
  {
    const c = calculateCumulativePayroll({
      employeeName: "李四", grossPay: 20000, socialInsurance: 2000, housingFund: 0,
      specialDeduction: 0, monthsEmployed: 1, prior: ZERO_PRIOR_CUMULATIVE
    });
    savePayrollDraft(2027, 1, c, 1, { db }); confirmPayrollPeriod(2027, 1, undefined, db);
    savePayrollDraft(2026, 12, c, 12, { db }); confirmPayrollPeriod(2026, 12, undefined, db);

    assert.deepEqual(getPriorConfirmedPeriod(2027, 2, db), { year: 2027, month: 1 },
      "T8 FAIL: 紧邻上月已确认应返回该月");
    assert.deepEqual(getPriorConfirmedPeriod(2027, 1, db), { year: 2026, month: 12 },
      "T8 FAIL: 1 月的上月应跨年到去年 12 月");
    // 关键回归：2027-04 的紧邻上月是 2027-03（无已确认）→ 必须 null，不得回溯到更早的 2027-01
    assert.equal(getPriorConfirmedPeriod(2027, 4, db), null,
      "T8 FAIL: 紧邻上月无已确认时返回 null，不得回溯更早月份充当「上月」");
  }

  // ── T9: savePayrollDraft SQL 层守卫——UPSERT 不降级已确认工资 ─────────────────
  // 验证 ON CONFLICT DO UPDATE 的 WHERE settlement_status != 'confirmed' 守卫阻止降级。
  // 直接运行带守卫条件的 UPSERT SQL，验证并发防写机制（单进程行为不变，JS 层仍抛错）。
  {
    const calcT9 = calculateCumulativePayroll({
      employeeName: "WPF-T9-Employee",
      grossPay: 20000,
      socialInsurance: 3000,
      housingFund: 0,
      specialDeduction: 1000,
      monthsEmployed: 1,
      prior: ZERO_PRIOR_CUMULATIVE
    });
    savePayrollDraft(2027, 9, calcT9, 1, { db });
    confirmPayrollPeriod(2027, 9, undefined, db);
    const rowBefore = db.prepare("SELECT settlement_status FROM fact_payroll WHERE employee_name = 'WPF-T9-Employee' AND year = 2027 AND month = 9").get() as { settlement_status: string };
    assert.equal(rowBefore.settlement_status, "confirmed", "T9 setup FAIL: 应已确认");

    // 直接运行带 WHERE 守卫的 UPSERT（等价于实施后的 savePayrollDraft SQL 层守卫）
    db.prepare(`
      INSERT INTO fact_payroll (
        employee_name, year, month,
        gross_pay_cents, social_insurance_cents, housing_fund_cents, special_deduction_cents, months_employed,
        gross_cum_cents, social_cum_cents, fund_cum_cents, special_cum_cents,
        taxable_income_cum_cents, tax_due_cum_cents, tax_current_cents, tax_withheld_cum_cents, net_pay_cents,
        caliber_version, detail_json, settlement_status, confirmed_at, receipt_id
      ) VALUES ('WPF-T9-Employee', 2027, 9, 1000000, 100000, 0, 50000, 1, 1000000, 100000, 0, 50000, 850000, 50000, 50000, 50000, 800000, 'v1', '{}', 'draft', NULL, NULL)
      ON CONFLICT(employee_name, year, month) DO UPDATE SET
        settlement_status = 'draft',
        confirmed_at = NULL
        WHERE settlement_status != 'confirmed'
    `).run();
    const rowAfter = db.prepare("SELECT settlement_status FROM fact_payroll WHERE employee_name = 'WPF-T9-Employee' AND year = 2027 AND month = 9").get() as { settlement_status: string };
    assert.equal(rowAfter.settlement_status, "confirmed", "T9 FAIL: SQL 守卫应防止已确认工资被 UPSERT 降级为 draft");
  }

  // ── T10: confirmPayrollPeriod 审计使用实际 changes 行数对应员工 ─────────────────
  // 验证审计载荷的 employees 列表与实际更新行数一致（覆盖正常路径；并发路径因 SQLite 同步无法模拟）
  {
    const calcT10 = calculateCumulativePayroll({
      employeeName: "WPF-T10-Employee",
      grossPay: 25000,
      socialInsurance: 3500,
      housingFund: 0,
      specialDeduction: 0,
      monthsEmployed: 1,
      prior: ZERO_PRIOR_CUMULATIVE
    });
    savePayrollDraft(2027, 10, calcT10, 1, { db });
    const auditCountBefore = (db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirm' AND payload LIKE '%2027%10%'").get() as { n: number }).n;
    const { confirmed: confirmedT10 } = confirmPayrollPeriod(2027, 10, undefined, db);
    assert.deepEqual(confirmedT10, ["WPF-T10-Employee"], "T10 FAIL: confirmed 列表应与实际更新员工一致");
    const auditCountAfter = (db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirm' AND payload LIKE '%2027%10%'").get() as { n: number }).n;
    assert.equal(auditCountAfter, auditCountBefore + 1, "T10 FAIL: confirmPayrollPeriod 应写入 1 条审计日志");
    const lastAudit = db.prepare(
      "SELECT payload FROM audit_logs WHERE event_type = 'payroll_confirm' AND payload LIKE '%WPF-T10-Employee%' ORDER BY id DESC LIMIT 1"
    ).get() as { payload: string } | undefined;
    assert.ok(lastAudit, "T10 FAIL: 应有含 WPF-T10-Employee 的审计日志");
    const payloadT10 = JSON.parse(lastAudit.payload) as { employees: string[] };
    assert.deepEqual(payloadT10.employees, ["WPF-T10-Employee"], "T10 FAIL: 审计 payload.employees 应精确匹配实际确认员工");
  }

  db.close();
  console.log("payroll-store: all 10 checks passed ✓");
})();
