import assert from "node:assert/strict";
import { deriveCockpitTodos } from "../lib/domain/cockpit-todos.ts";
import { getCalendarContext } from "../lib/domain/tax-calendar.ts";
import type { PayrollPeriodSummary } from "../lib/db/finance-store.ts";

function payrollSummary(partial: Partial<PayrollPeriodSummary>): PayrollPeriodSummary {
  return {
    year: 2026,
    month: 6,
    draftCount: 0,
    confirmedCount: 0,
    draftEmployees: [],
    latestConfirmedPeriod: null,
    ...partial
  };
}

export const cockpitTodosTestPromise = (async () => {
  // ── T1: 报税期临近(6/12,距 15 日还有 3 天)→ urgent 申报待办 ─────────
  const t1 = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 12)), payrollSummary({ confirmedCount: 4 }));
  const filing = t1.find((t) => t.id === "tax-filing");
  assert.ok(filing, "T1 FAIL: 应有申报截止待办");
  assert.equal(filing!.severity, "urgent");
  assert.ok(filing!.label.includes("还有 3 天"), `T1 FAIL: 文案应含剩余天数,实际 ${filing!.label}`);
  assert.ok(filing!.href.startsWith("/chat/new?prompt="), "T1 FAIL: 待办必须是对话入口");

  // 6/1(距截止 14 天,> 5)不应出现申报待办
  const t1b = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 1)), payrollSummary({}));
  assert.ok(!t1b.some((t) => t.id === "tax-filing"), "T1 FAIL: 距截止 14 天不应进入待办");

  // ── T2: 工资草稿待确认 → urgent,且绝不把已确认算成待确认 ─────────────
  const t2 = deriveCockpitTodos(
    getCalendarContext(new Date(2026, 5, 20)),
    payrollSummary({ draftCount: 3, confirmedCount: 2, draftEmployees: ["张三", "李四", "王五"] })
  );
  const draftTodo = t2.find((t) => t.id === "payroll-draft");
  assert.ok(draftTodo, "T2 FAIL: 有草稿必须出现确认待办");
  assert.ok(draftTodo!.label.includes("3 人待确认"), `T2 FAIL: 人数应为草稿数而非总数,实际 ${draftTodo!.label}`);
  assert.ok(draftTodo!.label.includes("张三"), "T2 FAIL: 应列出草稿员工");

  const t2b = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 20)), payrollSummary({ confirmedCount: 5 }));
  assert.ok(!t2b.some((t) => t.id === "payroll-draft"), "T2 FAIL: 全部已确认时不得出现待确认待办");

  // ── T3: 算薪窗口且本月无任何工资记录 → 提醒发起算薪 ──────────────────
  const t3 = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 11)), payrollSummary({}));
  assert.ok(t3.some((t) => t.id === "payroll-not-started"), "T3 FAIL: 算薪窗口无记录应提醒");
  // 已有草稿则不再提示"尚未计算"
  const t3b = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 11)), payrollSummary({ draftCount: 1, draftEmployees: ["张三"] }));
  assert.ok(!t3b.some((t) => t.id === "payroll-not-started"), "T3 FAIL: 已有草稿不应再提示未计算");

  // ── T4: 结账窗口 → normal 待办 ──────────────────────────────────────
  const t4 = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 27)), payrollSummary({ confirmedCount: 4 }));
  const closing = t4.find((t) => t.id === "month-closing");
  assert.ok(closing, "T4 FAIL: 结账窗口应有结账待办");
  assert.equal(closing!.severity, "normal");

  // ── T5: 平峰且无业务事项 → 空待办 ───────────────────────────────────
  const t5 = deriveCockpitTodos(getCalendarContext(new Date(2026, 5, 20)), payrollSummary({ confirmedCount: 4 }));
  assert.equal(t5.length, 0, "T5 FAIL: 平峰无事项应为空待办");

  console.log("cockpit-todos: all 5 checks passed ✓");
})();
