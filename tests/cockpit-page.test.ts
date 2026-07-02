/**
 * cockpit-page.test.ts — CV-1/CV-2/CV-3 改写版（v3-P0 同步）
 *
 * v2 变更点（spec-cockpit-v2.md §1 + §10）：
 * - QuickActionsCard / TodosCard 删除
 * - page.tsx import AttentionSection + DispatchInput，左列 BusinessMetricsCard 先于 CashObligationsCard
 * - summary route 返回 attention，不返回 todos
 * - lib/domain/cockpit-todos.ts 已迁移为 lib/domain/attention.ts
 *
 * v3-P0 变更点（spec-cockpit-v3.md §1）：
 * - metric-strip.tsx / compliance-strip.tsx 已删除，T1 不再断言其存在；T4 已移除
 * - MetricStrip 从 page.tsx presentFiles 移出，改为断言不存在（见 cockpit-v3-slim.test.ts）
 *
 * 旧断言（todos-card 存在 / deriveCockpitTodos 在 route / QuickActionsCard 含经营分析 /
 *         metric-strip.tsx 第4格 / compliance-strip.tsx 存在）已废弃。
 *
 * 运行方式：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-page.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const cockpitPageTestPromise = (async () => {
  // ── T1: 总览页已拆组件，page 只做装配 ────────────────────────────────────
  // 持续存在的组件（v3-P0: metric-strip / compliance-strip 已删除，不在此列）
  const presentFiles = [
    "app/cockpit/finance-calendar-card.tsx",
    "app/cockpit/cash-obligations-card.tsx",
    "app/cockpit/business-metrics-card.tsx",
    "app/cockpit/types.ts",
    // CV-1 新增
    "app/cockpit/attention-section.tsx",
    "app/cockpit/dispatch-input.tsx",
  ];
  for (const file of presentFiles) {
    assert.ok(existsSync(file), `T1 FAIL: 缺少组件文件 ${file}`);
  }

  // ── T2: 旧死组件已删除 ──────────────────────────────────────────────────
  assert.equal(existsSync("app/cockpit/todos-card.tsx"), false, "T2 FAIL: todos-card.tsx 应已删除");
  assert.equal(existsSync("app/cockpit/quick-actions-card.tsx"), false, "T2 FAIL: quick-actions-card.tsx 应已删除");
  assert.equal(existsSync("lib/domain/cockpit-todos.ts"), false, "T2 FAIL: cockpit-todos.ts 应已迁移删除");
  assert.ok(!existsSync("app/components/tool-call-pill.tsx"), "T2 FAIL: ToolCallPills 死组件应已删除");
  // v3-P0: metric-strip / compliance-strip 也应删除
  assert.equal(existsSync("app/cockpit/metric-strip.tsx"), false, "T2 FAIL: metric-strip.tsx 应已删除（v3-P0）");
  assert.equal(existsSync("app/cockpit/compliance-strip.tsx"), false, "T2 FAIL: compliance-strip.tsx 应已删除（v3-P0）");

  // ── T3: page.tsx 检查 ─────────────────────────────────────────────────────
  const pageSource = await readFile("app/cockpit/page.tsx", "utf-8");

  // 不再 import 旧组件
  assert.ok(!pageSource.includes("QuickActionsCard"), "T3 FAIL: page.tsx 不应 import QuickActionsCard");
  assert.ok(!pageSource.includes("TodosCard"), "T3 FAIL: page.tsx 不应 import TodosCard");
  // v3-P0: MetricStrip / ComplianceStrip 也不应存在
  assert.ok(!pageSource.includes("MetricStrip"), "T3 FAIL: page.tsx 不应 import MetricStrip（v3-P0 已删除）");
  assert.ok(!pageSource.includes("ComplianceStrip"), "T3 FAIL: page.tsx 不应 import ComplianceStrip（v3-P0 已删除）");

  // 已 import 新组件
  assert.ok(pageSource.includes("AttentionSection"), "T3 FAIL: page.tsx 应 import AttentionSection");
  assert.ok(pageSource.includes("DispatchInput"), "T3 FAIL: page.tsx 应 import DispatchInput");

  // 总览页不再渲染 RecentActivityCard
  assert.ok(!pageSource.includes("RecentActivityCard"), "T3 FAIL: 总览页不应再渲染最近活动卡");

  // 总览页渲染经营数据卡
  assert.ok(pageSource.includes("BusinessMetricsCard"), "T3 FAIL: 总览页应渲染经营数据卡");

  // 左列顺序：BusinessMetricsCard 在源码中出现的位置先于 CashObligationsCard（v1.1 评审决定）
  const bizIdx = pageSource.indexOf("BusinessMetricsCard");
  const cashIdx = pageSource.indexOf("CashObligationsCard");
  assert.ok(bizIdx !== -1 && cashIdx !== -1, "T3 FAIL: page.tsx 应同时含 BusinessMetricsCard 和 CashObligationsCard");
  assert.ok(
    bizIdx < cashIdx,
    `T3 FAIL: 左列中 BusinessMetricsCard（pos ${bizIdx}）应先于 CashObligationsCard（pos ${cashIdx}）`
  );

  // page.tsx 作为装配层，总行数约束（v3 ≤160 行；MetricStrip/ComplianceStrip 已删行数只减不增）
  const pageLines = pageSource.split("\n").length;
  assert.ok(pageLines <= 160, `T3 FAIL: page.tsx 应为装配层（≤160 行），实际 ${pageLines} 行`);

  // 总览页不含 agent 指标死数据
  for (const agentTerm of ["工具执行", "活跃技能", "平均轮次", "最常用工具", "topTools"]) {
    assert.ok(!pageSource.includes(agentTerm), `T3 FAIL: 总览页不应再含 agent 指标「${agentTerm}」`);
  }

  // ── T4: metric-strip.tsx 已在 v3-P0 删除，此节已废弃 ───────────────────
  // 原 T4 断言 metric-strip.tsx 第4格文案——组件已删除，断言移至 cockpit-v3-slim.test.ts C1a。
  // 保留此注释以示历史，不读已删除的文件。

  // ── T5: summary route 已切换为 attention 字段，v3-P0 移除 invoices ─────────
  const apiSource = await readFile("app/api/cockpit/summary/route.ts", "utf-8");

  // 保留的依赖（v3-P0: getInvoiceLedgerStats 随 invoices 字段一并移除，不再检查）
  for (const fn of ["getPayrollPeriodSummary", "getBusinessOverview"]) {
    assert.ok(apiSource.includes(fn), `T5 FAIL: summary API 缺 ${fn}`);
  }

  // 新字段
  assert.ok(apiSource.includes("attention"), "T5 FAIL: summary route 返回值应含 attention 字段");

  // 已移除的旧字段（非注释行）
  const apiLines = apiSource.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const hasTodosKey = apiLines.some((l) => /todos\s*:/.test(l));
  assert.ok(!hasTodosKey, "T5 FAIL: summary route 不应再返回 todos 字段（非注释行）");

  // v3-P0: invoices 字段也应已移除（详细断言在 cockpit-v3-slim.test.ts C2a）
  const hasInvoicesKey = apiLines.some((l) => /\binvoices\s*:/.test(l));
  assert.ok(!hasInvoicesKey, "T5 FAIL: summary route 不应再返回 invoices 字段（v3-P0 已迁往 /agents）");

  // deriveCockpitTodos 不应再出现
  assert.ok(!apiSource.includes("deriveCockpitTodos"), "T5 FAIL: route.ts 不应再 import deriveCockpitTodos");

  // 无关 agent 指标
  for (const removed of ["treasury", "totalChunks", "countToolCallsToday", "getTopToolsLast24h", "getRecentActivityFeed"]) {
    assert.ok(!apiSource.includes(removed), `T5 FAIL: summary API 不应再含 ${removed}`);
  }

  // ── T6: types.ts CockpitSummary 同步 ────────────────────────────────────
  const typesSrc = await readFile("app/cockpit/types.ts", "utf-8");
  assert.ok(typesSrc.includes("attention"), "T6 FAIL: CockpitSummary 应含 attention 字段");
  const typesLines = typesSrc.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const hasTodosField = typesLines.some((l) => /todos\s*[?:]/.test(l));
  assert.ok(!hasTodosField, "T6 FAIL: CockpitSummary 不应再含 todos 字段（非注释行）");
  // v3-P0: invoices 字段也应移除
  const hasInvoicesField = typesLines.some((l) => /\binvoices\s*[?:]/.test(l));
  assert.ok(!hasInvoicesField, "T6 FAIL: CockpitSummary 不应再含 invoices 字段（v3-P0 已迁往 /agents）");

  // ── T7: 经营数据卡：月/季/年切换 + 空态 CTA ───────────────────────────
  const bizCard = await readFile("app/cockpit/business-metrics-card.tsx", "utf-8");
  assert.ok(bizCard.includes("/chat/new"), "T7 FAIL: 经营数据卡空态 CTA 应指向 /chat/new");
  assert.ok(
    bizCard.includes("month") && bizCard.includes("quarter") && bizCard.includes("year"),
    "T7 FAIL: 应有月/季/年视角"
  );

  // ── T8: page.tsx 引入 CV-2 新组件（PeriodBadge + RecentWorkCard）───────────
  // spec §4.1 + §4.2：RecentWorkCard 放在 BusinessMetricsCard 同行（md 两列）；
  // PeriodBadge 进 header。
  assert.ok(
    pageSource.includes("PeriodBadge"),
    "T8 FAIL: page.tsx 应 import/使用 PeriodBadge（spec §4.2 header 期间徽章）"
  );
  assert.ok(
    pageSource.includes("RecentWorkCard"),
    "T8 FAIL: page.tsx 应 import/使用 RecentWorkCard（spec §4.1 最近工作卡）"
  );

  // ── T9: TeamPanel + GrowthHint（CV-3 §5）────────────────────────────────
  // 新组件文件必须存在
  assert.ok(
    existsSync("app/cockpit/team-panel.tsx"),
    "T9 FAIL: app/cockpit/team-panel.tsx 应存在（CV-3 团队面板）"
  );
  assert.ok(
    existsSync("app/cockpit/team-growth-hint.tsx"),
    "T9 FAIL: app/cockpit/team-growth-hint.tsx 应存在（CV-3 生长引导卡）"
  );

  // page.tsx 右列：team.length>0 渲染 TeamPanel，否则渲染 TeamGrowthHint
  assert.ok(
    pageSource.includes("TeamPanel"),
    "T9 FAIL: page.tsx 应 import/使用 TeamPanel（§5.2）"
  );
  assert.ok(
    pageSource.includes("TeamGrowthHint") || pageSource.includes("GrowthHint"),
    "T9 FAIL: page.tsx 应 import/使用 TeamGrowthHint（§5.3 冷启动引导卡）"
  );

  // TeamPanel/GrowthHint 位置必须在右列（FinanceCalendarCard 之前或同列）——
  // 宽松断言：右列源码中 TeamPanel 出现在 FinanceCalendarCard 之前
  const teamPanelIdx = pageSource.indexOf("TeamPanel");
  const growthHintIdx = Math.min(
    pageSource.includes("TeamGrowthHint") ? pageSource.indexOf("TeamGrowthHint") : Infinity,
    pageSource.includes("GrowthHint") && !pageSource.includes("TeamGrowthHint")
      ? pageSource.indexOf("GrowthHint")
      : Infinity
  );
  const calendarIdx = pageSource.indexOf("FinanceCalendarCard");
  const teamOrHintIdx = Math.min(
    teamPanelIdx === -1 ? Infinity : teamPanelIdx,
    growthHintIdx
  );
  assert.ok(
    calendarIdx !== -1,
    "T9 FAIL: page.tsx 应含 FinanceCalendarCard"
  );
  assert.ok(
    teamOrHintIdx !== Infinity && teamOrHintIdx < calendarIdx,
    `T9 FAIL: 右列中 TeamPanel/GrowthHint（pos ${teamOrHintIdx}）应出现在 FinanceCalendarCard（pos ${calendarIdx}）之前（日历卡之上）`
  );

  // page.tsx 中 team 字段应传给 TeamPanel（data.team 或 summary?.team）
  assert.ok(
    pageSource.includes("team") && (pageSource.includes("summary?.team") || pageSource.includes("summary.team") || pageSource.includes("data.team") || pageSource.includes("team={") || pageSource.includes("team =")),
    "T9 FAIL: page.tsx 应把 summary.team 传给 TeamPanel"
  );

  // ── T10: summary API 含 team 字段（CV-3 §6）────────────────────────────
  const apiSourceT10 = await readFile("app/api/cockpit/summary/route.ts", "utf-8");
  const apiLinesT10 = apiSourceT10.split("\n").filter(
    (l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")
  );
  const hasTeamKey = apiLinesT10.some((l) => /\bteam\s*:/.test(l));
  assert.ok(
    hasTeamKey,
    "T10 FAIL: summary route.ts 返回的 data 应含 team 字段（非注释行，CV-3 §6）"
  );

  // types.ts 应含 team 字段
  const typesSrcT10 = await readFile("app/cockpit/types.ts", "utf-8");
  assert.ok(
    typesSrcT10.includes("team"),
    "T10 FAIL: CockpitSummary types.ts 应含 team 字段"
  );

  console.log("cockpit-page (CV-1 + CV-2 + CV-3 + v3-P0): all checks passed ✓");
})();
