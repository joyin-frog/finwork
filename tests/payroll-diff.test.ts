/**
 * payroll-diff.test.ts
 *
 * 1. 纯函数 computePayrollDiff（delta/精度/新增/漏算/排序/税率版本/零差异/冷启动）
 * 2. 源码契约（工具只读/safe/角色白名单/redact/卡片分发/结算状态标签）
 *
 * 运行:
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/payroll-diff.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { computePayrollDiff } from "../lib/domain/payroll-diff.ts";
import { formatSignedDelta } from "../app/components/payroll-diff-card-data.ts";
import type { StoredPayrollRecord } from "../lib/db/finance-store.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

/** 构造最小 StoredPayrollRecord */
function makeRecord(
  overrides: Partial<StoredPayrollRecord> & { employeeName: string }
): StoredPayrollRecord {
  return {
    id: 1,
    year: 2026,
    month: 3,
    grossPay: 10000,
    socialInsurance: 1000,
    housingFund: 500,
    specialDeduction: 200,
    monthsEmployed: 3,
    grossCum: 30000,
    socialCum: 3000,
    fundCum: 1500,
    specialCum: 600,
    taxableIncomeCum: 18300,
    taxDueCum: 549,
    taxCurrent: 183,
    taxWithheldCum: 549,
    netPay: 8317,
    taxConfigVersion: "2024-v1",
    status: "draft",
    createdAt: "2026-03-01T00:00:00.000Z",
    confirmedAt: null,
    ...overrides,
  };
}

export const payrollDiffTestPromise = (async () => {

  // ── 1. delta 正确 ─────────────────────────────────────────────────────────
  {
    const cur = makeRecord({ employeeName: "张三", netPay: 8500 });
    const prior = makeRecord({ employeeName: "张三", netPay: 8317, status: "confirmed" });
    const result = computePayrollDiff([cur], new Map([["张三", prior]]), ["张三"], "2026年2月");
    assert.equal(result.rows.length, 1, "D1 FAIL: rows 应有 1 行");
    assert.equal(result.rows[0].fields.netPay.delta, 183, "D1 FAIL: netPay delta 应为 183");
    assert.ok(result.rows[0].changed, "D1 FAIL: changed 应为 true");
    console.log("D1: delta 正确 ✓");
  }

  // ── 2. 精度到分不漂移 ────────────────────────────────────────────────────
  {
    // 3000.10 - 1000.05 = 2000.05（浮点敏感）
    const cur  = makeRecord({ employeeName: "李四", grossPay: 3000.10 });
    const prior = makeRecord({ employeeName: "李四", grossPay: 1000.05, status: "confirmed" });
    const result = computePayrollDiff([cur], new Map([["李四", prior]]), ["李四"], null);
    assert.equal(result.rows[0].fields.grossPay.delta, 2000.05, "D2a FAIL: 3000.10-1000.05 应精确=2000.05");

    // 1000.1 - 0.1 = 1000（另一浮点边界）
    const cur2  = makeRecord({ employeeName: "王五", grossPay: 1000.1 });
    const prior2 = makeRecord({ employeeName: "王五", grossPay: 0.1, status: "confirmed" });
    const result2 = computePayrollDiff([cur2], new Map([["王五", prior2]]), ["王五"], null);
    assert.equal(result2.rows[0].fields.grossPay.delta, 1000, "D2b FAIL: 1000.1-0.1 应精确=1000");
    console.log("D2: 精度到分不漂移 ✓");
  }

  // ── 3. 新增员工标记（flag:"new"）────────────────────────────────────────
  {
    const cur = makeRecord({ employeeName: "新员工" });
    const result = computePayrollDiff([cur], new Map(), [], "2026年2月");
    assert.equal(result.newEmployees.length, 1, "D3 FAIL: newEmployees 应有 1 人");
    assert.equal(result.newEmployees[0], "新员工", "D3 FAIL: 应是新员工");
    assert.ok(result.rows[0].flags.includes("new"), "D3 FAIL: rows[0] 应有 flag new");
    console.log("D3: 新增员工标记 ✓");
  }

  // ── 4. 漏算/dropped 检测 ─────────────────────────────────────────────────
  {
    const cur = makeRecord({ employeeName: "在职员工" });
    const prior = makeRecord({ employeeName: "离职员工", status: "confirmed" });
    const result = computePayrollDiff(
      [cur],
      new Map([["在职员工", makeRecord({ employeeName: "在职员工", status: "confirmed" })]]),
      ["在职员工", "离职员工"],
      null
    );
    assert.ok(result.dropped.includes("离职员工"), "D4 FAIL: dropped 应含离职员工");
    assert.ok(!result.dropped.includes("在职员工"), "D4 FAIL: 在职员工不应在 dropped");
    console.log("D4: 漏算/dropped 检测 ✓");
  }

  // ── 5. 排序：new 优先，其次按 maxAbsDelta 降序 ───────────────────────────
  {
    const cur = [
      makeRecord({ employeeName: "小变动", grossPay: 10100 }),  // delta=100
      makeRecord({ employeeName: "大变动", grossPay: 15000 }),  // delta=5000
      makeRecord({ employeeName: "新员工2" }),                   // new
    ];
    const priorMap = new Map([
      ["小变动", makeRecord({ employeeName: "小变动", grossPay: 10000, status: "confirmed" })],
      ["大变动", makeRecord({ employeeName: "大变动", grossPay: 10000, status: "confirmed" })],
    ]);
    const result = computePayrollDiff(cur, priorMap, ["小变动", "大变动"], null);
    assert.equal(result.rows[0].employeeName, "新员工2", "D5 FAIL: new 应排在最前");
    assert.equal(result.rows[1].employeeName, "大变动", "D5 FAIL: 大变动应第二");
    assert.equal(result.rows[2].employeeName, "小变动", "D5 FAIL: 小变动应第三");
    console.log("D5: 排序正确 ✓");
  }

  // ── 6. 税率版本变化标记 ──────────────────────────────────────────────────
  {
    const cur   = makeRecord({ employeeName: "赵六", taxConfigVersion: "2025-v1" });
    const prior = makeRecord({ employeeName: "赵六", taxConfigVersion: "2024-v1", status: "confirmed" });
    const result = computePayrollDiff([cur], new Map([["赵六", prior]]), ["赵六"], null);
    assert.ok(result.rows[0].flags.includes("tax_config_changed"), "D6 FAIL: 应标 tax_config_changed");
    console.log("D6: 税率版本变化标记 ✓");
  }

  // ── 7. 零差异员工 changed=false ──────────────────────────────────────────
  {
    const rec = makeRecord({ employeeName: "陈七" });
    const priorRec = makeRecord({ employeeName: "陈七", status: "confirmed" });
    const result = computePayrollDiff([rec], new Map([["陈七", priorRec]]), ["陈七"], null);
    assert.equal(result.rows[0].changed, false, "D7 FAIL: 零差异应为 changed=false");
    assert.equal(result.rows[0].maxAbsDelta, 0, "D7 FAIL: maxAbsDelta 应为 0");
    console.log("D7: 零差异 changed=false ✓");
  }

  // ── 8. 空 priorRoster（冷启动/首月）：全员 new、无 dropped ─────────────
  {
    const cur = [makeRecord({ employeeName: "张一" }), makeRecord({ employeeName: "张二" })];
    const result = computePayrollDiff(cur, new Map(), [], "null期");
    assert.equal(result.newEmployees.length, 2, "D8 FAIL: 冷启动应有 2 人新增");
    assert.equal(result.dropped.length, 0, "D8 FAIL: 冷启动无 dropped");
    assert.ok(result.rows.every((r) => r.flags.includes("new")), "D8 FAIL: 全员应有 new flag");
    console.log("D8: 冷启动/首月 ✓");
  }

  // ── 9. comparedFromPeriod 透传 ───────────────────────────────────────────
  {
    const result = computePayrollDiff([], new Map(), [], "2025年12月");
    assert.equal(result.comparedFromPeriod, "2025年12月", "D9 FAIL: comparedFromPeriod 应透传");
    console.log("D9: comparedFromPeriod 透传 ✓");
  }

  // ── 10. formatSignedDelta 负号（复核回归：减薪必须显负号，不能与加薪同形）──
  {
    assert.ok(formatSignedDelta(183).startsWith("+"), "D10 FAIL: 正 delta 应带 +");
    assert.ok(formatSignedDelta(-500).startsWith("-"), "D10 FAIL: 负 delta 应带 -（减薪不能丢负号）");
    assert.equal(formatSignedDelta(0), "—", "D10 FAIL: 零 delta 应为 —");
    assert.notEqual(
      formatSignedDelta(-500),
      formatSignedDelta(500),
      "D10 FAIL: -500 与 +500 渲染必须不同（此前 bug：负号被吞，减薪读成加薪）"
    );
    console.log("D10: formatSignedDelta 负号 ✓");
  }

  // ── 源码契约 ─────────────────────────────────────────────────────────────

  // SC1: payroll.ts 含 diff_payroll_period 且不含 savePayrollDraft/withIdempotency 于该工具体内
  {
    const payrollSrc = src("lib/agent/tools/finance/payroll.ts");
    assert.ok(payrollSrc.includes("diff_payroll_period"), "SC1 FAIL: payroll.ts 应含 diff_payroll_period");

    // 工具体在 diffPeriod 变量定义之后；确认工具体内不包 withIdempotency
    // （withIdempotency 只存在于 calculate/confirm 工具中）
    const diffToolSection = payrollSrc.split("diff_payroll_period")[1] ?? "";
    // 截到下一个 sdk.tool 调用之前的片段（fmtDelta + return 之后）
    const afterDiff = payrollSrc.indexOf("return [calculate");
    const toolBody = payrollSrc.slice(payrollSrc.indexOf('"diff_payroll_period"'), afterDiff);
    assert.ok(!toolBody.includes("withIdempotency"), "SC1 FAIL: diff_payroll_period 工具体不应包含 withIdempotency（只读）");
    assert.ok(!toolBody.includes("savePayrollDraft"), "SC1 FAIL: diff_payroll_period 工具体不应调用 savePayrollDraft（只读）");
    console.log("SC1: 工具只读（无 withIdempotency/savePayrollDraft）✓");
  }

  // SC2: payroll.ts 使用 redact() 包裹文本输出
  {
    const payrollSrc = src("lib/agent/tools/finance/payroll.ts");
    assert.ok(payrollSrc.includes("redact("), "SC2 FAIL: payroll.ts 应调用 redact()");
    console.log("SC2: 输出走 redact() ✓");
  }

  // SC3: tools/registry.ts 的 diff_payroll_period 是 riskLevel:"safe"
  {
    const registrySrc = src("lib/agent/tools/registry.ts");
    assert.ok(
      registrySrc.includes("diff_payroll_period") && registrySrc.includes('"safe"'),
      "SC3 FAIL: registry.ts 应含 diff_payroll_period 且 riskLevel 为 safe"
    );
    // 更精确：检查 diff_payroll_period 行本身包含 safe
    const line = registrySrc.split("\n").find((l) => l.includes("diff_payroll_period"));
    assert.ok(line?.includes('"safe"'), `SC3 FAIL: diff_payroll_period 行应为 riskLevel:"safe"，实际行: ${line}`);
    console.log("SC3: registry.ts riskLevel safe ✓");
  }

  // SC4: roles/registry.ts payroll-officer 含 diff_payroll_period 裸名
  {
    const rolesSrc = src("lib/agent/roles/registry.ts");
    assert.ok(
      rolesSrc.includes("diff_payroll_period"),
      "SC4 FAIL: roles/registry.ts payroll-officer.tools 应含 diff_payroll_period"
    );
    console.log("SC4: roles/registry.ts payroll-officer 含 diff_payroll_period ✓");
  }

  // SC5: tool-cards.tsx 白名单 + 分发含 diff_payroll_period
  {
    const cardsSrc = src("app/components/tool-cards.tsx");
    assert.ok(
      cardsSrc.includes("diff_payroll_period"),
      "SC5 FAIL: tool-cards.tsx 应含 diff_payroll_period（白名单 + 分发）"
    );
    const inWhitelist = /TOOLS_WITH_RESULT_CARD[\s\S]*?diff_payroll_period/.test(cardsSrc);
    assert.ok(inWhitelist, "SC5 FAIL: diff_payroll_period 应在 TOOLS_WITH_RESULT_CARD 白名单中");
    console.log("SC5: tool-cards.tsx 白名单 + 分发 ✓");
  }

  // SC6: 卡片源码含草稿与已确认字样（结算状态标注）
  {
    const diffCardSrc = src("app/components/payroll-diff-card.tsx");
    assert.ok(diffCardSrc.includes("草稿"), 'SC6 FAIL: payroll-diff-card.tsx 应含"草稿"（结算状态）');
    assert.ok(diffCardSrc.includes("已确认"), 'SC6 FAIL: payroll-diff-card.tsx 应含"已确认"（结算状态）');
    assert.ok(diffCardSrc.includes("非环比"), 'SC6 FAIL: payroll-diff-card.tsx 应含"非环比"警示');
    console.log("SC6: 卡片结算状态标注 ✓");
  }

  console.log("payroll-diff: all 16 tests passed ✓");

})();
