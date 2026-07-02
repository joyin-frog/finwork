/**
 * CV-1 先行失败测试 B：
 * 源码文本断言——验证实现者遵守的组件/API/类型契约。
 * 文件不存在（应删除的）用 existsSync === false 断言。
 * 文件应存在的，readFileSync 后做字符串断言。
 *
 * 运行方式：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-attention-ui.test.ts
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.join(process.cwd());

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

export const cockpitAttentionUiTestPromise = (async () => {
  // ── B1: 旧文件已删除 ─────────────────────────────────────────────────────
  assert.equal(
    exists("app/cockpit/todos-card.tsx"),
    false,
    "B1 FAIL: todos-card.tsx 应已删除"
  );
  assert.equal(
    exists("app/cockpit/quick-actions-card.tsx"),
    false,
    "B1 FAIL: quick-actions-card.tsx 应已删除"
  );

  // ── B2: 旧域逻辑文件已迁移（cockpit-todos.ts 不再存在） ─────────────────
  assert.equal(
    exists("lib/domain/cockpit-todos.ts"),
    false,
    "B2 FAIL: lib/domain/cockpit-todos.ts 应已删除（功能已迁移至 attention.ts）"
  );

  // ── B3: 新域逻辑文件存在 ─────────────────────────────────────────────────
  assert.ok(exists("lib/domain/attention.ts"), "B3 FAIL: lib/domain/attention.ts 应存在");
  assert.ok(exists("lib/domain/cockpit-suggestions.ts"), "B3 FAIL: lib/domain/cockpit-suggestions.ts 应存在");

  // ── B4: attention.ts 导出契约 ────────────────────────────────────────────
  {
    const attSrc = src("lib/domain/attention.ts");
    assert.ok(attSrc.includes("deriveAttentionItems"), "B4 FAIL: attention.ts 应导出 deriveAttentionItems");
    assert.ok(attSrc.includes("AttentionItem"), "B4 FAIL: attention.ts 应包含 AttentionItem 类型");
    assert.ok(attSrc.includes('"rule"'), "B4 FAIL: AttentionItem.source 应含 rule 枚举值");
    assert.ok(attSrc.includes('"gate"'), "B4 FAIL: AttentionItem.source 应含 gate 枚举值（预留）");
    assert.ok(attSrc.includes("sourceLabel"), "B4 FAIL: AttentionItem 应有 sourceLabel 字段");
    assert.ok(attSrc.includes('"urgent"'), "B4 FAIL: AttentionItem.severity 应含 urgent");
    assert.ok(attSrc.includes('"normal"'), "B4 FAIL: AttentionItem.severity 应含 normal");
    assert.ok(attSrc.includes("actions"), "B4 FAIL: AttentionItem 应有 actions 字段");
    // 不能再导出旧的 deriveCockpitTodos
    assert.ok(!attSrc.includes("deriveCockpitTodos"), "B4 FAIL: attention.ts 不应包含旧函数名 deriveCockpitTodos");
  }

  // ── B5: cockpit-suggestions.ts 契约 ────────────────────────────────────
  {
    const sugSrc = src("lib/domain/cockpit-suggestions.ts");
    assert.ok(sugSrc.includes("getCockpitSuggestions"), "B5 FAIL: cockpit-suggestions.ts 应导出 getCockpitSuggestions");
    assert.ok(sugSrc.includes("placeholder"), "B5 FAIL: 返回值应含 placeholder 字段");
    assert.ok(sugSrc.includes("attentionEmptyHint"), "B5 FAIL: 返回值应含 attentionEmptyHint 字段");
    // 四窗口情形必须覆盖
    assert.ok(sugSrc.includes("filing"), "B5 FAIL: cockpit-suggestions.ts 应覆盖 filing 窗口");
    assert.ok(sugSrc.includes("payroll_prep"), "B5 FAIL: cockpit-suggestions.ts 应覆盖 payroll_prep 窗口");
    assert.ok(sugSrc.includes("closing"), "B5 FAIL: cockpit-suggestions.ts 应覆盖 closing 窗口");
  }

  // ── B6: attention-section.tsx 新组件存在且满足 UI 契约 ──────────────────
  assert.ok(exists("app/cockpit/attention-section.tsx"), "B6 FAIL: app/cockpit/attention-section.tsx 应存在");
  {
    const asSrc = src("app/cockpit/attention-section.tsx");
    assert.ok(asSrc.includes("需要你关注"), "B6 FAIL: AttentionSection 源码应含「需要你关注」");
    assert.ok(
      asSrc.includes("当前没有需要你处理的事"),
      "B6 FAIL: AttentionSection 源码应含空态文案「当前没有需要你处理的事」"
    );
    assert.ok(asSrc.includes("fa-dot-pulse"), "B6 FAIL: AttentionSection 源码应含 urgent 脉冲 fa-dot-pulse");
    assert.ok(asSrc.includes("还有"), "B6 FAIL: AttentionSection 源码折叠文案应含「还有」");
    // Phase 3 裁决（2026-07-02）：gate 类卡片必须带 TrustBadge。
    // 旧断言「不应 import TrustBadge」在 Phase 1 时写入，因 Phase 3 起 attention-section
    // 须渲染 gate 类卡片，gate 类带 TrustBadge，故反转为「必须 import TrustBadge」。
    assert.ok(asSrc.includes("TrustBadge"), "B6 FAIL: AttentionSection 应 import TrustBadge（gate 类卡片须带信任徽章，Phase 3 裁决）");

    // gate 卡片渲染特征：source==="gate" 分支必须存在
    assert.ok(
      asSrc.includes('"gate"') || asSrc.includes("=== \"gate\"") || asSrc.includes("==='gate'") || asSrc.includes('source === "gate"'),
      "B6 FAIL: AttentionSection 源码应含 source===\"gate\" 分支（gate 类卡片渲染）"
    );

    // gate 类使用角色 tone（引用 ROLE_UI 或 roleId + tone 的映射）
    assert.ok(
      asSrc.includes("ROLE_UI") || asSrc.includes("roleId") || asSrc.includes("role-ui"),
      "B6 FAIL: AttentionSection 源码应引用角色 tone（通过 ROLE_UI 或 roleId 映射）"
    );
  }

  // ── B7: dispatch-input.tsx 新组件存在且满足 UI 契约 ─────────────────────
  assert.ok(exists("app/cockpit/dispatch-input.tsx"), "B7 FAIL: app/cockpit/dispatch-input.tsx 应存在");
  {
    const diSrc = src("app/cockpit/dispatch-input.tsx");
    assert.ok(
      diSrc.includes("/chat/new?prompt="),
      "B7 FAIL: dispatch-input.tsx 应含 /chat/new?prompt= 跳转逻辑"
    );
    assert.ok(
      diSrc.includes("getCockpitSuggestions"),
      "B7 FAIL: dispatch-input.tsx 应引用 getCockpitSuggestions 的 placeholder"
    );
  }

  // ── B8: page.tsx 不再 import 旧组件，已 import 新组件 ───────────────────
  {
    const pageSrc = src("app/cockpit/page.tsx");
    assert.ok(!pageSrc.includes("QuickActionsCard"), "B8 FAIL: page.tsx 不应 import QuickActionsCard");
    assert.ok(!pageSrc.includes("TodosCard"), "B8 FAIL: page.tsx 不应 import TodosCard");
    assert.ok(pageSrc.includes("AttentionSection"), "B8 FAIL: page.tsx 应 import AttentionSection");
    assert.ok(pageSrc.includes("DispatchInput"), "B8 FAIL: page.tsx 应 import DispatchInput");
    // 左列顺序：BusinessMetricsCard 出现位置先于 CashObligationsCard（v1.1 决定）
    const bizIdx = pageSrc.indexOf("BusinessMetricsCard");
    const cashIdx = pageSrc.indexOf("CashObligationsCard");
    assert.ok(bizIdx !== -1, "B8 FAIL: page.tsx 应含 BusinessMetricsCard");
    assert.ok(cashIdx !== -1, "B8 FAIL: page.tsx 应含 CashObligationsCard");
    assert.ok(
      bizIdx < cashIdx,
      `B8 FAIL: 左列中 BusinessMetricsCard（${bizIdx}）应先于 CashObligationsCard（${cashIdx}）出现`
    );
  }

  // ── B9: metric-strip.tsx 第 4 格文案与 attention 锚点 ────────────────────
  {
    const msSrc = src("app/cockpit/metric-strip.tsx");
    assert.ok(msSrc.includes("需要关注"), "B9 FAIL: metric-strip.tsx 第 4 格文案应含「需要关注」");
    assert.ok(!msSrc.includes('"待办"'), "B9 FAIL: metric-strip.tsx 不应再有「待办」label 文案");
    // attention 锚点或 scrollIntoView（宽松断言含 "attention"）
    assert.ok(
      msSrc.includes("attention"),
      "B9 FAIL: metric-strip.tsx 应含 attention 锚点或 scrollIntoView 引用"
    );
    // urgent 时 alarm 色逻辑保留
    assert.ok(msSrc.includes("tone-alarm"), "B9 FAIL: metric-strip.tsx 应保留 urgent 时 alarm 色逻辑");
  }

  // ── B10: route.ts 返回 attention 字段，不返回 todos ──────────────────────
  {
    const routeSrc = src("app/api/cockpit/summary/route.ts");
    assert.ok(routeSrc.includes("attention"), "B10 FAIL: route.ts 返回值应含 attention 字段");
    // "todos:" 作为对象 key 不应存在（允许注释里出现）
    const routeLines = routeSrc.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hasTodosKey = routeLines.some((l) => /todos\s*:/.test(l));
    assert.ok(!hasTodosKey, "B10 FAIL: route.ts 不应再返回 todos 字段（非注释行）");
  }

  // ── B11: types.ts CockpitSummary 含 attention，不含 todos ───────────────
  {
    const typesSrc = src("app/cockpit/types.ts");
    assert.ok(typesSrc.includes("attention"), "B11 FAIL: CockpitSummary 应含 attention 字段");
    const typesLines = typesSrc.split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hasTodosField = typesLines.some((l) => /todos\s*[?:]/.test(l));
    assert.ok(!hasTodosField, "B11 FAIL: CockpitSummary 不应再含 todos 字段（非注释行）");
  }

  console.log("cockpit-attention-ui: all checks passed ✓");
})();
