/**
 * CV-1 先行失败测试 A：
 * 断言 lib/domain/attention.ts 中 deriveAttentionItems 的行为契约，
 * 以及 lib/domain/cockpit-suggestions.ts 中 getCockpitSuggestions 的四窗口覆盖。
 *
 * 运行方式：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/attention.test.ts
 */
import assert from "node:assert/strict";
import { getCalendarContext } from "../lib/domain/tax-calendar.ts";
import type { PayrollPeriodSummary } from "../lib/db/finance-store.ts";
import type { CashObligation } from "../lib/domain/cash-obligations.ts";

// ── 被测模块（实现前不存在，import 必定失败→红）──────────────────────────
// @ts-ignore
import { deriveAttentionItems } from "../lib/domain/attention.ts";
// @ts-ignore
import { getCockpitSuggestions } from "../lib/domain/cockpit-suggestions.ts";

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

// ── 辅助：构造 CashObligation ────────────────────────────────────────────────
function obligation(partial: Partial<CashObligation>): CashObligation {
  // 裁决修订(2026-07-02):真实 CashObligation 必带 status(方向即状态,如"待付"),
  // urgentObligations 按 DEFAULT_PENDING 过滤——夹具必须给合法待办 status,不许靠强转掩盖缺字段。
  return {
    documentId: 1,
    fileName: "test.pdf",
    kind: "付款",
    counterparty: "客户A",
    dueDate: "2026-06-30",
    status: "待付",
    done: false,
    sourceDoc: null,
    amount: undefined,
    ...partial,
  } as CashObligation;
}

export const attentionTestPromise = (async () => {
  // ── A1: 申报截止 ≤5 天 → urgent AttentionItem，sourceLabel = "申报截止" ─────
  {
    // 2026-06-12：距 15 日截止还有 3 天
    const calendar = getCalendarContext(new Date(2026, 5, 12));
    const items = deriveAttentionItems(calendar, payroll({ confirmedCount: 4 }), []);
    const item = items.find((i: { id: string }) => i.id === "tax-filing");
    assert.ok(item, "A1 FAIL: 应有申报截止 attention 项");
    assert.equal(item.severity, "urgent", "A1 FAIL: 申报截止 ≤5 天应为 urgent");
    assert.equal(item.sourceLabel, "申报截止", `A1 FAIL: sourceLabel 应为「申报截止」,实际 ${item.sourceLabel}`);
    assert.ok(item.title.includes("还有 3 天"), `A1 FAIL: title 应含「还有 3 天」,实际 ${item.title}`);
    assert.ok(item.actions.length > 0, "A1 FAIL: actions 不能为空");
    assert.ok(item.actions[0].href.includes("/chat/new?prompt="), `A1 FAIL: 主动作 href 应含 /chat/new?prompt=,实际 ${item.actions[0].href}`);
    assert.equal(item.source, "rule", "A1 FAIL: source 应为 rule");
  }

  // 距截止 14 天（2026-06-01）→ 不产生申报待办
  {
    const calendar = getCalendarContext(new Date(2026, 5, 1));
    const items = deriveAttentionItems(calendar, payroll(), []);
    assert.ok(!items.some((i: { id: string }) => i.id === "tax-filing"), "A1b FAIL: 距截止 14 天不应出现申报截止项");
  }

  // ── A2: 工资草稿 → urgent，sourceLabel = "工资草稿" ──────────────────────
  {
    const calendar = getCalendarContext(new Date(2026, 5, 20));
    const items = deriveAttentionItems(
      calendar,
      payroll({ draftCount: 3, confirmedCount: 2, draftEmployees: ["张三", "李四", "王五"] }),
      []
    );
    const item = items.find((i: { id: string }) => i.id === "payroll-draft");
    assert.ok(item, "A2 FAIL: 有草稿应产生工资草稿关注项");
    assert.equal(item.severity, "urgent", "A2 FAIL: 工资草稿应为 urgent");
    assert.equal(item.sourceLabel, "工资草稿", `A2 FAIL: sourceLabel 应为「工资草稿」,实际 ${item.sourceLabel}`);
    assert.ok(item.title.includes("3 人"), `A2 FAIL: title 应含草稿人数,实际 ${item.title}`);
    assert.ok(item.actions[0].href.includes("/chat/new?prompt="), "A2 FAIL: 主动作 href 应含 /chat/new?prompt=");

    // 全部已确认时不产生草稿项
    const items2 = deriveAttentionItems(calendar, payroll({ confirmedCount: 5 }), []);
    assert.ok(!items2.some((i: { id: string }) => i.id === "payroll-draft"), "A2b FAIL: 全部已确认时不应产生草稿项");
  }

  // ── A3: 算薪窗口未开算 → normal，sourceLabel = "算薪窗口" ─────────────────
  {
    // 2026-06-11：在算薪窗口（发薪日 15，窗口 10-14）
    const calendar = getCalendarContext(new Date(2026, 5, 11));
    const items = deriveAttentionItems(calendar, payroll(), []);
    const item = items.find((i: { id: string }) => i.id === "payroll-not-started");
    assert.ok(item, "A3 FAIL: 算薪窗口无记录应产生关注项");
    assert.equal(item.severity, "normal", "A3 FAIL: 算薪窗口未开算应为 normal");
    assert.equal(item.sourceLabel, "算薪窗口", `A3 FAIL: sourceLabel 应为「算薪窗口」,实际 ${item.sourceLabel}`);
    assert.ok(item.actions[0].href.includes("/chat/new?prompt="), "A3 FAIL: 主动作 href 应含 /chat/new?prompt=");

    // 已有草稿则不产生未开算提示
    const items2 = deriveAttentionItems(calendar, payroll({ draftCount: 1, draftEmployees: ["张三"] }), []);
    assert.ok(!items2.some((i: { id: string }) => i.id === "payroll-not-started"), "A3b FAIL: 已有草稿不应提示未开算");
  }

  // ── A4: 结账窗口 → normal，sourceLabel = "结账窗口" ──────────────────────
  {
    // 2026-06-27：在结账窗口（25 日之后）
    const calendar = getCalendarContext(new Date(2026, 5, 27));
    const items = deriveAttentionItems(calendar, payroll({ confirmedCount: 4 }), []);
    const item = items.find((i: { id: string }) => i.id === "month-closing");
    assert.ok(item, "A4 FAIL: 结账窗口应产生关注项");
    assert.equal(item.severity, "normal", "A4 FAIL: 结账窗口应为 normal");
    assert.equal(item.sourceLabel, "结账窗口", `A4 FAIL: sourceLabel 应为「结账窗口」,实际 ${item.sourceLabel}`);
  }

  // ── A5: 合同收付临近 → sourceLabel = "合同收付" ──────────────────────────
  {
    // 2026-06-18，有一笔 2026-06-20 到期的付款义务（2 天内，urgent）
    const calendar = getCalendarContext(new Date(2026, 5, 18));
    const o = obligation({
      documentId: 99,
      kind: "付款",
      counterparty: "客户Z",
      dueDate: "2026-06-20",
      done: false,
      amount: 50000,
    });
    const items = deriveAttentionItems(calendar, payroll({ confirmedCount: 2 }), [o]);
    const item = items.find((i: { id: string }) => i.id.startsWith("oblig-"));
    assert.ok(item, "A5 FAIL: 合同收付临近应产生关注项");
    assert.equal(item.sourceLabel, "合同收付", `A5 FAIL: sourceLabel 应为「合同收付」,实际 ${item.sourceLabel}`);
    assert.ok(item.actions[0].href.includes("/chat/new?prompt="), "A5 FAIL: 主动作 href 应含 /chat/new?prompt=");
    assert.equal(item.source, "rule", "A5 FAIL: source 应为 rule");
  }

  // ── A6: 排序——urgent 全部在前 ─────────────────────────────────────────────
  {
    // 2026-06-11：算薪窗口（normal）+ 工资草稿（urgent）+ 结账前
    // 只需确认返回列表的 urgent 全在 normal 前
    const calendar = getCalendarContext(new Date(2026, 5, 11));
    const items = deriveAttentionItems(
      calendar,
      payroll({ draftCount: 2, draftEmployees: ["张三", "李四"] }),
      []
    );
    const urgentIdx = items.map((i: { severity: string }) => i.severity).lastIndexOf("urgent");
    const normalIdx = items.map((i: { severity: string }) => i.severity).indexOf("normal");
    if (urgentIdx !== -1 && normalIdx !== -1) {
      assert.ok(urgentIdx < normalIdx, `A6 FAIL: urgent 应在 normal 之前，urgentIdx=${urgentIdx} normalIdx=${normalIdx}`);
    }
  }

  // ── A7: getCockpitSuggestions 四窗口均返回非空文案 ───────────────────────
  {
    // filing 窗口
    const filing = getCalendarContext(new Date(2026, 5, 12));
    const s1 = getCockpitSuggestions(filing);
    assert.ok(s1.placeholder && s1.placeholder.length > 0, "A7 FAIL: filing 窗口 placeholder 不能为空");
    assert.ok(s1.attentionEmptyHint && s1.attentionEmptyHint.length > 0, "A7 FAIL: filing 窗口 attentionEmptyHint 不能为空");

    // payroll_prep 窗口
    const payrollPrep = getCalendarContext(new Date(2026, 5, 11));
    const s2 = getCockpitSuggestions(payrollPrep);
    assert.ok(s2.placeholder && s2.placeholder.length > 0, "A7 FAIL: payroll_prep 窗口 placeholder 不能为空");
    assert.ok(s2.attentionEmptyHint && s2.attentionEmptyHint.length > 0, "A7 FAIL: payroll_prep 窗口 attentionEmptyHint 不能为空");

    // closing 窗口
    const closing = getCalendarContext(new Date(2026, 5, 27));
    const s3 = getCockpitSuggestions(closing);
    assert.ok(s3.placeholder && s3.placeholder.length > 0, "A7 FAIL: closing 窗口 placeholder 不能为空");
    assert.ok(s3.attentionEmptyHint && s3.attentionEmptyHint.length > 0, "A7 FAIL: closing 窗口 attentionEmptyHint 不能为空");

    // 平峰窗口
    const normal = getCalendarContext(new Date(2026, 5, 20));
    const s4 = getCockpitSuggestions(normal);
    assert.ok(s4.placeholder && s4.placeholder.length > 0, "A7 FAIL: 平峰窗口 placeholder 不能为空");
    assert.ok(s4.attentionEmptyHint && s4.attentionEmptyHint.length > 0, "A7 FAIL: 平峰窗口 attentionEmptyHint 不能为空");
  }

  console.log("attention: all checks passed ✓");
})();
