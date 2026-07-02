/**
 * cockpit-page.test.ts — CV-1 改写版
 *
 * v2 变更点（spec-cockpit-v2.md §1 + §10）：
 * - QuickActionsCard / TodosCard 删除
 * - page.tsx import AttentionSection + DispatchInput，左列 BusinessMetricsCard 先于 CashObligationsCard
 * - metric-strip.tsx 第 4 格「待办」→「需要关注」
 * - summary route 返回 attention，不返回 todos
 * - lib/domain/cockpit-todos.ts 已迁移为 lib/domain/attention.ts
 *
 * 旧断言（todos-card 存在 / deriveCockpitTodos 在 route / QuickActionsCard 含经营分析）已废弃。
 *
 * 运行方式：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-page.test.ts
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";

export const cockpitPageTestPromise = (async () => {
  // ── T1: 总览页已拆组件，page 只做装配 ────────────────────────────────────
  // 持续存在的组件
  const presentFiles = [
    "app/cockpit/finance-calendar-card.tsx",
    "app/cockpit/cash-obligations-card.tsx",
    "app/cockpit/compliance-strip.tsx",
    "app/cockpit/business-metrics-card.tsx",
    "app/cockpit/metric-strip.tsx",
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

  // ── T3: page.tsx 检查 ─────────────────────────────────────────────────────
  const pageSource = await readFile("app/cockpit/page.tsx", "utf-8");

  // 不再 import 旧组件
  assert.ok(!pageSource.includes("QuickActionsCard"), "T3 FAIL: page.tsx 不应 import QuickActionsCard");
  assert.ok(!pageSource.includes("TodosCard"), "T3 FAIL: page.tsx 不应 import TodosCard");

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

  // page.tsx 作为装配层，总行数约束（v2 后宽松到 160，派活入口+关注区多了些行）
  const pageLines = pageSource.split("\n").length;
  assert.ok(pageLines <= 160, `T3 FAIL: page.tsx 应为装配层（≤160 行），实际 ${pageLines} 行`);

  // 总览页不含 agent 指标死数据
  for (const agentTerm of ["工具执行", "活跃技能", "平均轮次", "最常用工具", "topTools"]) {
    assert.ok(!pageSource.includes(agentTerm), `T3 FAIL: 总览页不应再含 agent 指标「${agentTerm}」`);
  }

  // ── T4: metric-strip.tsx 第 4 格文案与 attention 锚点 ───────────────────
  const metricStrip = await readFile("app/cockpit/metric-strip.tsx", "utf-8");
  // 前 3 格财务指标保留
  for (const financeTerm of ["距申报截止", "本月应付", "本月应收"]) {
    assert.ok(metricStrip.includes(financeTerm), `T4 FAIL: 指标条缺财务指标「${financeTerm}」`);
  }
  // 第 4 格文案已更新
  assert.ok(metricStrip.includes("需要关注"), "T4 FAIL: metric-strip.tsx 第 4 格应含「需要关注」");
  assert.ok(!metricStrip.includes('"待办"'), "T4 FAIL: metric-strip.tsx 不应再有「待办」label");
  // attention 锚点（宽松断言：含 attention 字符串）
  assert.ok(metricStrip.includes("attention"), "T4 FAIL: metric-strip.tsx 应含 attention 锚点或 scrollIntoView 引用");
  // urgent 时 alarm 色逻辑保留
  assert.ok(metricStrip.includes("tone-alarm"), "T4 FAIL: metric-strip.tsx 应保留 urgent alarm 色逻辑");

  // ── T5: summary route 已切换为 attention 字段 ───────────────────────────
  const apiSource = await readFile("app/api/cockpit/summary/route.ts", "utf-8");

  // 保留的依赖
  for (const fn of ["getPayrollPeriodSummary", "getInvoiceLedgerStats", "getBusinessOverview"]) {
    assert.ok(apiSource.includes(fn), `T5 FAIL: summary API 缺 ${fn}`);
  }

  // 新字段
  assert.ok(apiSource.includes("attention"), "T5 FAIL: summary route 返回值应含 attention 字段");

  // 已移除的旧字段（非注释行）
  const apiLines = apiSource.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
  const hasTodosKey = apiLines.some((l) => /todos\s*:/.test(l));
  assert.ok(!hasTodosKey, "T5 FAIL: summary route 不应再返回 todos 字段（非注释行）");

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

  console.log("cockpit-page (CV-1 + CV-2): all 8 checks passed ✓");
})();
