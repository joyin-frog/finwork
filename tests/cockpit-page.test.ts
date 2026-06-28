import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const cockpitPageTestPromise = (async () => {
  // ── T1: 总览页已拆组件,page 只做装配 ─────────────────────────────────
  const componentFiles = [
    "app/cockpit/finance-calendar-card.tsx",
    "app/cockpit/todos-card.tsx",
    "app/cockpit/cash-obligations-card.tsx",
    "app/cockpit/compliance-strip.tsx",
    "app/cockpit/quick-actions-card.tsx",
    "app/cockpit/business-metrics-card.tsx",
    "app/cockpit/metric-strip.tsx",
    "app/cockpit/types.ts"
  ];
  for (const file of componentFiles) {
    assert.ok(existsSync(file), `T1 FAIL: 缺少组件文件 ${file}`);
  }
  const pageSource = await readFile("app/cockpit/page.tsx", "utf-8");
  const pageLines = pageSource.split("\n").length;
  assert.ok(pageLines <= 130, `T1 FAIL: page.tsx 应为装配层(≤130 行),实际 ${pageLines} 行`);

  // ── T2: 总览页是财务视角,agent 指标已移除 ───────────────────────────
  for (const agentTerm of ["工具执行", "活跃技能", "平均轮次", "最常用工具", "topTools"]) {
    assert.ok(!pageSource.includes(agentTerm), `T2 FAIL: 总览页不应再含 agent 指标「${agentTerm}」`);
  }
  const metricStrip = await readFile("app/cockpit/metric-strip.tsx", "utf-8");
  for (const financeTerm of ["距申报截止", "本月应付", "本月应收", "待办"]) {
    assert.ok(metricStrip.includes(financeTerm), `T2 FAIL: 指标条缺财务指标「${financeTerm}」`);
  }

  // ── T3: summary API 返回财务调度数据,不再返回 agent 指标 ─────────────
  const apiSource = await readFile("app/api/cockpit/summary/route.ts", "utf-8");
  for (const fn of ["getPayrollPeriodSummary", "getInvoiceLedgerStats", "deriveCockpitTodos", "getBusinessOverview"]) {
    assert.ok(apiSource.includes(fn), `T3 FAIL: summary API 缺 ${fn}`);
  }
  for (const removed of ["treasury", "totalChunks", "countToolCallsToday", "getTopToolsLast24h", "getRecentActivityFeed"]) {
    assert.ok(!apiSource.includes(removed), `T3 FAIL: summary API 不应再含 ${removed}`);
  }

  // ── T4: 待办是对话入口(todos-card 渲染 Link href)────────────────────
  const todosCard = await readFile("app/cockpit/todos-card.tsx", "utf-8");
  assert.ok(todosCard.includes("href={todo.href}"), "T4 FAIL: 待办必须可点击进入对话");
  assert.ok(todosCard.includes("urgent"), "T4 FAIL: 待办应区分紧急程度");

  // ── T5: 观测页 UI 已删除(§12),数据采集层 lib/observability/* 保留 ──────
  // (观测页 UI 已随上报功能完成后删除,仅保留 trace/span 数据层供遥测上报)

  // ── T6: 死组件已删除 ────────────────────────────────────────────────
  assert.ok(!existsSync("app/components/tool-call-pill.tsx"), "T6 FAIL: ToolCallPills 死组件应已删除");

  // ── T7: AC9 — 经营数据卡与快捷操作 ────────────────────────────────────
  // 总览页不再渲染 RecentActivityCard
  assert.ok(!pageSource.includes("RecentActivityCard"), "T7 FAIL: 总览页不应再渲染最近活动卡");
  // 总览页渲染经营数据卡
  assert.ok(pageSource.includes("BusinessMetricsCard"), "T7 FAIL: 总览页应渲染经营数据卡");

  // 经营数据卡：月/季/年切换 + 空态 CTA 指向 /chat/new
  const bizCard = await readFile("app/cockpit/business-metrics-card.tsx", "utf-8");
  assert.ok(bizCard.includes("/chat/new"), "T7 FAIL: 经营数据卡空态 CTA 应指向 /chat/new");
  assert.ok(bizCard.includes("month") && bizCard.includes("quarter") && bizCard.includes("year"), "T7 FAIL: 应有月/季/年视角");

  // 快捷操作含「经营分析」(9e18ee3「快捷操作调整」后由「生成老板月报」改为此项)
  const quickActionsSource = await readFile("app/cockpit/quick-actions-card.tsx", "utf-8");
  assert.ok(quickActionsSource.includes("经营分析"), "T7 FAIL: 快捷操作应含经营分析");

  console.log("cockpit-page: all 7 checks passed ✓");
})();
