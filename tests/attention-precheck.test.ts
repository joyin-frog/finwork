/**
 * 红测试：WP2a attention 三条新规则 R6/R7/R8
 *
 * R6: tax_filing 窗口时产出申报前复核入口（LLM 型，normal）
 * R7: 当月 15 日后且本月发票台账新增=0 → 断档提醒（normal）
 * R8: 当月 5 日后且上月经营指标未登记 → 未登记提醒（normal）
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/attention-precheck.test.ts
 */
import assert from "node:assert/strict";
import { getCalendarContext } from "../lib/domain/tax-calendar.ts";
import type { PayrollPeriodSummary } from "../lib/db/finance-store.ts";

// @ts-ignore
import { deriveAttentionItems } from "../lib/domain/attention.ts";

// ── 辅助：构造 PayrollPeriodSummary ─────────────────────────────────────────
function payroll(partial: Partial<PayrollPeriodSummary> = {}): PayrollPeriodSummary {
  return {
    year: 2026,
    month: 6,
    draftCount: 0,
    confirmedCount: 0,
    draftEmployees: [],
    latestConfirmedPeriod: null,
    ...partial,
  };
}

// ── 辅助：构造 InvoiceLedgerStats ────────────────────────────────────────────
function invoiceStats(addedThisMonth: number, total = 10) {
  return { total, addedThisMonth };
}

export const attentionPrecheckTestPromise = (async () => {
  // ─────────────────────────────────────────────────────────────────────────
  // R6：申报前复核入口（tax_filing 窗口触发）
  // ─────────────────────────────────────────────────────────────────────────

  // B6a: 有 tax_filing 窗口 + 传入 starter → 产生 filing-precheck 项
  {
    // 2026-06-05: day=5, tax_filing 窗口（≤15日）
    const calendar = getCalendarContext(new Date(2026, 5, 5));
    assert.ok(calendar.windows.includes("tax_filing"), "前提：应在 tax_filing 窗口");

    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(3),
      false, // 上月 metrics 存在
      "帮我做申报前复核"
    );
    const item = items.find((i: { id: string }) => i.id === "filing-precheck");
    assert.ok(item, "B6a FAIL: tax_filing 窗口应产生 filing-precheck 项");
    assert.equal(item.severity, "normal", "B6a FAIL: filing-precheck 应为 normal");
    assert.equal(item.roleId, "tax-officer", `B6a FAIL: roleId 应为 tax-officer，实际 ${item.roleId}`);
    assert.ok(
      item.title.includes("申报前复核"),
      `B6a FAIL: title 应含「申报前复核」，实际 ${item.title}`
    );
    assert.ok(item.actions.length > 0, "B6a FAIL: actions 不能为空");
    const href = item.actions[0].href;
    assert.ok(
      href.includes("/chat/new?prompt=") && href.includes(encodeURIComponent("帮我做申报前复核")),
      `B6a FAIL: href 应包含 starter prompt，实际 ${href}`
    );
    assert.equal(item.source, "rule", "B6a FAIL: source 应为 rule");
    assert.equal(item.sourceLabel, "申报前复核", `B6a FAIL: sourceLabel，实际 ${item.sourceLabel}`);
  }

  // B6b: starter=undefined → 降级为无预填跳转 /chat/new（不抛错）
  {
    const calendar = getCalendarContext(new Date(2026, 5, 5));
    let items: unknown[];
    assert.doesNotThrow(() => {
      items = deriveAttentionItems(
        calendar,
        payroll({ confirmedCount: 4 }),
        [],
        invoiceStats(3),
        false,
        undefined
      );
    }, "B6b FAIL: starter=undefined 不应抛错");
    // @ts-ignore
    const item = items!.find((i: { id: string }) => i.id === "filing-precheck");
    assert.ok(item, "B6b FAIL: starter=undefined 时仍应产生 filing-precheck 项");
    const href = item.actions[0].href;
    assert.equal(href, "/chat/new", `B6b FAIL: 无 starter 时 href 应为 /chat/new，实际 ${href}`);
  }

  // B6c: 不在 tax_filing 窗口 → 不产生 filing-precheck
  {
    // 2026-06-20: day=20, 不在 tax_filing 窗口（>15日）
    const calendar = getCalendarContext(new Date(2026, 5, 20));
    assert.ok(!calendar.windows.includes("tax_filing"), "前提：不应在 tax_filing 窗口");
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(3),
      false,
      "帮我做申报前复核"
    );
    assert.ok(
      !items.some((i: { id: string }) => i.id === "filing-precheck"),
      "B6c FAIL: 非 tax_filing 窗口不应产生 filing-precheck"
    );
  }

  // B6d: 15 日当天（tax_filing 窗口末尾）— R6 与 tax-filing（≤5天 urgent）同时在清单（reviewer N2）
  {
    // 2026-06-15: day=15, daysLeft=0 → tax-filing urgent 规则触发；同时 tax_filing 窗口仍有效
    const calendar = getCalendarContext(new Date(2026, 5, 15));
    assert.ok(calendar.windows.includes("tax_filing"), "前提：15日应在 tax_filing 窗口");
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(3),
      false,
      "帮我做申报前复核"
    );
    const filingPrecheck = items.find((i: { id: string }) => i.id === "filing-precheck");
    const taxFiling = items.find((i: { id: string }) => i.id === "tax-filing");
    assert.ok(filingPrecheck, "B6d FAIL: 15日应有 filing-precheck（normal）");
    assert.ok(taxFiling, "B6d FAIL: 15日应有 tax-filing（urgent）");
    assert.equal(taxFiling.severity, "urgent", "B6d FAIL: tax-filing 应为 urgent");
    assert.equal(filingPrecheck.severity, "normal", "B6d FAIL: filing-precheck 应为 normal");
    // urgent 应在前
    const urgentIdx = items.indexOf(taxFiling);
    const normalIdx = items.indexOf(filingPrecheck);
    assert.ok(urgentIdx < normalIdx, `B6d FAIL: urgent tax-filing 应在 normal filing-precheck 前`);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R7：台账断档（当月 15 日后 + 本月新增=0）
  // ─────────────────────────────────────────────────────────────────────────

  // B7a: day=16, addedThisMonth=0 → 产生 invoice-ledger-gap 项
  {
    // 2026-06-16: day=16 > 15
    const calendar = getCalendarContext(new Date(2026, 5, 16));
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(0),
      false,
      undefined
    );
    const item = items.find((i: { id: string }) => i.id === "invoice-ledger-gap");
    assert.ok(item, "B7a FAIL: 16日且本月新增=0 应产生 invoice-ledger-gap");
    assert.equal(item.severity, "normal", "B7a FAIL: invoice-ledger-gap 应为 normal");
    assert.ok(
      item.title.includes("发票台账"),
      `B7a FAIL: title 应含「发票台账」，实际 ${item.title}`
    );
    assert.ok(item.actions[0].href.includes("/chat/new"), "B7a FAIL: action href 应含 /chat/new");
  }

  // B7b: day=15（边界，≤15）→ 不触发 R7
  {
    // 2026-06-15: day=15, 边界：不触发（需要 >15）
    const calendar = getCalendarContext(new Date(2026, 5, 15));
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(0),
      false,
      undefined
    );
    assert.ok(
      !items.some((i: { id: string }) => i.id === "invoice-ledger-gap"),
      "B7b FAIL: 15日不应触发 invoice-ledger-gap（阈值为>15日）"
    );
  }

  // B7c: day=16, addedThisMonth=1 → 不触发 R7
  {
    const calendar = getCalendarContext(new Date(2026, 5, 16));
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(1),
      false,
      undefined
    );
    assert.ok(
      !items.some((i: { id: string }) => i.id === "invoice-ledger-gap"),
      "B7c FAIL: 本月新增>0 时不应触发 invoice-ledger-gap"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // R8：上月经营指标未登记（当月 5 日后 + hasMetricsForLastMonth=false）
  // ─────────────────────────────────────────────────────────────────────────

  // B8a: day=6, hasMetricsForLastMonth=false → 产生 metrics-missing 项
  {
    // 2026-06-06: day=6 > 5
    const calendar = getCalendarContext(new Date(2026, 5, 6));
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(3),
      false, // 上月指标未登记
      undefined
    );
    const item = items.find((i: { id: string }) => i.id === "metrics-missing");
    assert.ok(item, "B8a FAIL: 6日且上月指标未登记 应产生 metrics-missing");
    assert.equal(item.severity, "normal", "B8a FAIL: metrics-missing 应为 normal");
    assert.ok(
      item.title.includes("经营指标"),
      `B8a FAIL: title 应含「经营指标」，实际 ${item.title}`
    );
    assert.ok(item.actions[0].href.includes("/chat/new"), "B8a FAIL: action href 应含 /chat/new");
  }

  // B8b: day=5（边界，≤5）→ 不触发 R8
  {
    // 2026-06-05: day=5，边界，不触发
    const calendar = getCalendarContext(new Date(2026, 5, 5));
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(3),
      false,
      "starter"
    );
    assert.ok(
      !items.some((i: { id: string }) => i.id === "metrics-missing"),
      "B8b FAIL: 5日不应触发 metrics-missing（阈值为>5日）"
    );
  }

  // B8c: day=6, hasMetricsForLastMonth=true → 不触发 R8
  {
    const calendar = getCalendarContext(new Date(2026, 5, 6));
    const items = deriveAttentionItems(
      calendar,
      payroll({ confirmedCount: 4 }),
      [],
      invoiceStats(3),
      true, // 上月指标已登记
      undefined
    );
    assert.ok(
      !items.some((i: { id: string }) => i.id === "metrics-missing"),
      "B8c FAIL: 上月指标已登记时不应触发 metrics-missing"
    );
  }

  // ─────────────────────────────────────────────────────────────────────────
  // 排序：新规则（normal）在既有 urgent 规则后
  // ─────────────────────────────────────────────────────────────────────────

  // B_sort: 日期=15日，触发 tax-filing(urgent) + filing-precheck(normal) + invoice-ledger-gap触发条件不满足
  {
    const calendar = getCalendarContext(new Date(2026, 5, 15));
    const items = deriveAttentionItems(
      calendar,
      payroll({ draftCount: 2, draftEmployees: ["张三", "李四"] }),
      [],
      invoiceStats(5),
      true,
      "帮我做申报前复核"
    );
    const urgentItems = items.filter((i: { severity: string }) => i.severity === "urgent");
    const normalItems = items.filter((i: { severity: string }) => i.severity === "normal");
    if (urgentItems.length > 0 && normalItems.length > 0) {
      const lastUrgentIdx = items.lastIndexOf(urgentItems[urgentItems.length - 1]);
      const firstNormalIdx = items.indexOf(normalItems[0]);
      assert.ok(
        lastUrgentIdx < firstNormalIdx,
        `B_sort FAIL: 所有 urgent 应在 normal 前，lastUrgentIdx=${lastUrgentIdx} firstNormalIdx=${firstNormalIdx}`
      );
    }
  }

  console.log("attention-precheck: all checks passed ✓");
})();
