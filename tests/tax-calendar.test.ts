import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildCalendarPromptSection, getCalendarContext } from "../lib/domain/tax-calendar.ts";
import { buildSystemPromptParts } from "../lib/agent/system-prompt.ts";

export const taxCalendarTestPromise = (async () => {
  // ── T1: 窗口判定与剩余天数(AC6 给定日期)──────────────────────────────
  const june11 = getCalendarContext(new Date(2026, 5, 11));
  assert.equal(june11.primaryWindow, "tax_filing", "T1 FAIL: 6/11 应为报税期");
  assert.equal(june11.deadlines[0].daysLeft, 4, "T1 FAIL: 6/11 距 15 日截止应剩 4 天");
  assert.ok(june11.windows.includes("payroll_prep"), "T1 FAIL: 6/11 也在发薪日前 5 天算薪窗口内");

  const june20 = getCalendarContext(new Date(2026, 5, 20));
  assert.equal(june20.primaryWindow, "normal", "T1 FAIL: 6/20 应为月中平峰");
  assert.equal(june20.deadlines.length, 0);

  const june28 = getCalendarContext(new Date(2026, 5, 28));
  assert.equal(june28.primaryWindow, "closing", "T1 FAIL: 6/28 应为结账窗口");

  // ── T2: 边界日 ──────────────────────────────────────────────────────
  assert.equal(getCalendarContext(new Date(2026, 5, 15)).deadlines[0].daysLeft, 0, "T2 FAIL: 15 日当天截止");
  assert.equal(getCalendarContext(new Date(2026, 5, 16)).primaryWindow, "normal");
  assert.equal(getCalendarContext(new Date(2026, 5, 25)).primaryWindow, "closing");
  assert.equal(getCalendarContext(new Date(2026, 5, 1)).deadlines[0].daysLeft, 14);
  // 发薪日可配置:发薪日 10 → 9 日在算薪窗口、4 日不在
  assert.ok(getCalendarContext(new Date(2026, 5, 9), { payday: 10 }).windows.includes("payroll_prep"));
  assert.ok(!getCalendarContext(new Date(2026, 5, 4), { payday: 10 }).windows.includes("payroll_prep"));

  // ── T3: prompt 日历段内容 ────────────────────────────────────────────
  const section = buildCalendarPromptSection(new Date(2026, 5, 11));
  assert.ok(section.includes("## 财务日历"), "T3 FAIL: 缺日历标题");
  assert.ok(section.includes("2026-06-11"), "T3 FAIL: 缺当天日期");
  assert.ok(section.includes("还有 4 天"), "T3 FAIL: 缺剩余天数");
  assert.ok(section.includes("节假日顺延"), "T3 FAIL: 缺顺延免责说明");
  const deadlineDay = buildCalendarPromptSection(new Date(2026, 5, 15));
  assert.ok(deadlineDay.includes("今天") && deadlineDay.includes("截止日"), "T3 FAIL: 截止日当天要提示");

  // ── T4: system prompt 动态段包含财务日历 ─────────────────────────────
  const parts = buildSystemPromptParts({ now: new Date(2026, 5, 11) });
  const dynamicPart = parts[2];
  assert.ok(dynamicPart.includes("## 财务日历"), "T4 FAIL: system prompt 应注入日历段");
  assert.ok(dynamicPart.includes("还有 4 天"), "T4 FAIL: system prompt 日历段应含截止信息");

  // ── T5: 驾驶舱渲染日历卡片(源码级 smoke,卡片已拆为独立组件)──────────
  const cockpitSource = await readFile("app/cockpit/page.tsx", "utf-8");
  assert.ok(cockpitSource.includes("getCalendarContext"), "T5 FAIL: 驾驶舱应使用日历模块");
  assert.ok(cockpitSource.includes("FinanceCalendarCard"), "T5 FAIL: 驾驶舱应装配财务日历卡片");
  const calendarCardSource = await readFile("app/cockpit/finance-calendar-card.tsx", "utf-8");
  assert.ok(calendarCardSource.includes("财务日历"), "T5 FAIL: 日历卡片组件应存在");

  console.log("tax-calendar: all 5 checks passed ✓");
})();
