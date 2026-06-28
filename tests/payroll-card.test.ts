import assert from "node:assert/strict";
import { parsePayrollStructured } from "../app/components/payroll-card-data.ts";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { confirmPayrollPeriod, savePayrollDraft } from "../lib/db/finance-store.ts";
import { calculateCumulativePayroll, ZERO_PRIOR_CUMULATIVE } from "../lib/domain/tax-cumulative.ts";

export const payrollCardTestPromise = (async () => {
  const row = (name: string, netPay: number) => ({
    employeeName: name,
    grossPay: 30000,
    socialInsurance: 4500,
    housingFund: 1000,
    specialDeduction: 2000,
    taxCurrent: 800,
    netPay,
    detail: { formula: `${name} 的计算过程` }
  });

  // ── AC8a: 合法 structuredContent → 卡片数据,coldStart 置顶 ──
  const data = parsePayrollStructured({
    results: [row("张三", 23700), row("李四", 23600)],
    failures: ["王五:缺少 monthsEmployed"],
    coldStarts: ["李四"],
    totalNetPay: 47300,
    totalTax: 1600,
    taxConfigVersion: "2026-standard"
  });
  assert.ok(data, "AC8 FAIL: 合法 payload 应解析成功");
  assert.equal(data!.rows[0].employeeName, "李四", "AC8 FAIL: 首次计算(待核对)的员工必须置顶");
  assert.equal(data!.rows[0].coldStart, true);
  assert.equal(data!.rows[1].coldStart, false);
  assert.deepEqual(data!.failures, ["王五:缺少 monthsEmployed"], "AC8 FAIL: 失败名单必须保留");
  assert.equal(data!.totalNetPay, 47300, "AC8 FAIL: 合计必须与 structuredContent 一致");
  assert.equal(data!.totalTax, 1600);
  assert.equal(data!.rows[0].formula, "李四 的计算过程", "AC8 FAIL: 计算过程必须可追溯");
  assert.equal(data!.taxConfigVersion, "2026-standard");

  // ── AC8b: 字段残缺 → 整体回退 null(显示层不许凑数) ──
  const broken = { ...row("赵六", 1) } as Record<string, unknown>;
  delete broken.netPay;
  assert.equal(parsePayrollStructured({ results: [broken] }), null, "AC8 FAIL: 字段残缺必须回退文本,不许部分渲染");
  assert.equal(parsePayrollStructured(null), null);
  assert.equal(parsePayrollStructured("text"), null);
  assert.equal(parsePayrollStructured({ noResults: true }), null);

  // ── AC8c: 合计缺失时按行重算 ──
  const computed = parsePayrollStructured({ results: [row("张三", 100.5), row("李四", 200.25)] });
  assert.equal(computed!.totalNetPay, 300.75, "AC8 FAIL: 缺合计时应按行求和");
  assert.equal(computed!.totalTax, 1600);

  // ── AC12: confirm_payroll_period 幂等 ──
  const db = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-payroll-card-${process.pid}.db`));
  const may = calculateCumulativePayroll({
    employeeName: "张三",
    grossPay: 30000,
    socialInsurance: 4500,
    housingFund: 0,
    specialDeduction: 2000,
    monthsEmployed: 5,
    prior: ZERO_PRIOR_CUMULATIVE
  });
  savePayrollDraft(2026, 5, may, 5, { db });

  const first = confirmPayrollPeriod(2026, 5, undefined, db);
  assert.deepEqual(first.confirmed, ["张三"]);
  assert.deepEqual(first.alreadyConfirmed, []);

  const second = confirmPayrollPeriod(2026, 5, undefined, db);
  assert.deepEqual(second.confirmed, [], "AC12 FAIL: 重复确认不应再次变更");
  assert.deepEqual(second.alreadyConfirmed, ["张三"], "AC12 FAIL: 应如实报告已确认名单");

  const auditCount = db
    .prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE event_type = 'payroll_confirm'")
    .get() as { n: number };
  assert.equal(auditCount.n, 1, "AC12 FAIL: 重复确认不得重写审计日志");

  // 完全没有记录的期间仍然显式报错(不静默成功)
  assert.throws(() => confirmPayrollPeriod(2026, 8, undefined, db), /没有待确认的工资草稿/);

  db.close();
  console.log("payroll-card: all checks passed ✓");
})();
