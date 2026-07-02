/**
 * cockpit-v3-slim.test.ts — v3-P0 先行失败测试
 *
 * 覆盖契约 1-4（spec-cockpit-v3.md §1/§2）：
 * 契约 1 — metric-strip.tsx / compliance-strip.tsx 文件已删除；page.tsx 无相关 import；
 *           lib/domain/tax-calendar.ts 的 filingUrgency 保留（PeriodBadge 在用）
 * 契约 2 — cockpit summary API：响应移除 invoices 字段；
 *           attention/payroll/business/obligations/recentWork/team 保留；types.ts 同步
 * 契约 3 — app/cockpit/team-panel.tsx：标题「我的团队」→「智能体」
 * 契约 4 — page.tsx v3 顺序：DispatchInput < AttentionSection < BusinessMetricsCard < CashObligationsCard；
 *           MetricStrip 不出现；全文件 ≤160 行
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/cockpit-v3-slim.test.ts
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = process.cwd();

function src(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf-8");
}

function exists(rel: string): boolean {
  return existsSync(path.join(ROOT, rel));
}

export const cockpitV3SlimTestPromise = (async () => {
  // ── 契约 1a: metric-strip.tsx 已删除 ─────────────────────────────────────
  assert.equal(
    exists("app/cockpit/metric-strip.tsx"),
    false,
    "C1a FAIL: app/cockpit/metric-strip.tsx 应已删除（v3-P0 减法）"
  );

  // ── 契约 1b: compliance-strip.tsx 已删除 ─────────────────────────────────
  assert.equal(
    exists("app/cockpit/compliance-strip.tsx"),
    false,
    "C1b FAIL: app/cockpit/compliance-strip.tsx 应已删除（v3-P0 减法）"
  );

  // ── 契约 1c: page.tsx 无 MetricStrip / ComplianceStrip import ─────────────
  {
    const pageSrc = src("app/cockpit/page.tsx");
    assert.ok(
      !pageSrc.includes("MetricStrip"),
      "C1c FAIL: page.tsx 不应含 MetricStrip 引用（组件已删除）"
    );
    assert.ok(
      !pageSrc.includes("ComplianceStrip"),
      "C1c FAIL: page.tsx 不应含 ComplianceStrip 引用（组件已删除）"
    );
    assert.ok(
      !pageSrc.includes("metric-strip"),
      "C1c FAIL: page.tsx 不应 import metric-strip 模块"
    );
    assert.ok(
      !pageSrc.includes("compliance-strip"),
      "C1c FAIL: page.tsx 不应 import compliance-strip 模块"
    );
  }

  // ── 契约 1d: lib/domain/tax-calendar.ts 的 filingUrgency 保留 ─────────────
  {
    const calSrc = src("lib/domain/tax-calendar.ts");
    assert.ok(
      calSrc.includes("filingUrgency"),
      "C1d FAIL: lib/domain/tax-calendar.ts 应保留 filingUrgency（PeriodBadge 在用）"
    );
  }

  // ── 契约 2a: route.ts 不含 invoices 字段 key（非注释行）────────────────────
  {
    const routeSrc = src("app/api/cockpit/summary/route.ts");
    const routeCodeLines = routeSrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hasInvoicesKey = routeCodeLines.some((l) => /\binvoices\s*:/.test(l));
    assert.ok(
      !hasInvoicesKey,
      "C2a FAIL: route.ts 返回的 data 不应含 invoices 字段 key（已迁往 /agents，非注释行）"
    );
    // 裁决补强(2026-07-02):字段迁走后调用也要删干净,不留死代码
    assert.ok(
      !routeSrc.includes("getInvoiceLedgerStats"),
      "C2a2 FAIL: route.ts 不应再调用 getInvoiceLedgerStats（发票计数已迁往 /api/agents）"
    );
  }

  // ── 契约 2b: route.ts 保留 attention/payroll/business/obligations/recentWork/team ─
  {
    const routeSrc = src("app/api/cockpit/summary/route.ts");
    const routeCodeLines = routeSrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    for (const field of ["attention", "payroll", "business", "obligations", "recentWork", "team"]) {
      const hasField = routeCodeLines.some((l) => new RegExp(`\\b${field}\\s*[,:]`).test(l) || l.includes(field));
      assert.ok(
        hasField,
        `C2b FAIL: route.ts 返回的 data 应保留 ${field} 字段`
      );
    }
  }

  // ── 契约 2c: types.ts CockpitSummary 不含 invoices 字段（非注释行）─────────
  {
    const typesSrc = src("app/cockpit/types.ts");
    const typesCodeLines = typesSrc
      .split("\n")
      .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
    const hasInvoicesField = typesCodeLines.some((l) => /\binvoices\s*[?:]/.test(l));
    assert.ok(
      !hasInvoicesField,
      "C2c FAIL: CockpitSummary types.ts 不应含 invoices 字段（已迁往 /agents，非注释行）"
    );
  }

  // ── 契约 3: team-panel.tsx 标题「我的团队」→「智能体」 ─────────────────────
  {
    assert.ok(
      exists("app/cockpit/team-panel.tsx"),
      "C3 FAIL: app/cockpit/team-panel.tsx 应存在"
    );
    const tpSrc = src("app/cockpit/team-panel.tsx");
    assert.ok(
      !tpSrc.includes("我的团队"),
      "C3 FAIL: team-panel.tsx 不应再含「我的团队」（应更名为「智能体」）"
    );
    assert.ok(
      tpSrc.includes("智能体"),
      "C3 FAIL: team-panel.tsx 标题应含「智能体」"
    );
  }

  // ── 契约 4a: page.tsx v3 顺序：DispatchInput < AttentionSection < BusinessMetricsCard < CashObligationsCard ─
  {
    const pageSrc = src("app/cockpit/page.tsx");
    const dispatchIdx = pageSrc.indexOf("DispatchInput");
    const attentionIdx = pageSrc.indexOf("AttentionSection");
    const bizIdx = pageSrc.indexOf("BusinessMetricsCard");
    const cashIdx = pageSrc.indexOf("CashObligationsCard");

    assert.ok(
      dispatchIdx !== -1,
      "C4a FAIL: page.tsx 应含 DispatchInput"
    );
    assert.ok(
      attentionIdx !== -1,
      "C4a FAIL: page.tsx 应含 AttentionSection"
    );
    assert.ok(
      bizIdx !== -1,
      "C4a FAIL: page.tsx 应含 BusinessMetricsCard"
    );
    assert.ok(
      cashIdx !== -1,
      "C4a FAIL: page.tsx 应含 CashObligationsCard"
    );
    assert.ok(
      dispatchIdx < attentionIdx,
      `C4a FAIL: DispatchInput（pos ${dispatchIdx}）应先于 AttentionSection（pos ${attentionIdx}）`
    );
    assert.ok(
      attentionIdx < bizIdx,
      `C4a FAIL: AttentionSection（pos ${attentionIdx}）应先于 BusinessMetricsCard（pos ${bizIdx}）`
    );
    assert.ok(
      bizIdx < cashIdx,
      `C4a FAIL: BusinessMetricsCard（pos ${bizIdx}）应先于 CashObligationsCard（pos ${cashIdx}）`
    );
  }

  // ── 契约 4b: page.tsx 不含 MetricStrip ────────────────────────────────────
  {
    const pageSrc = src("app/cockpit/page.tsx");
    assert.ok(
      !pageSrc.includes("MetricStrip"),
      "C4b FAIL: page.tsx 不应含 MetricStrip（已删除）"
    );
  }

  // ── 契约 4c: page.tsx ≤160 行 ─────────────────────────────────────────────
  {
    const pageSrc = src("app/cockpit/page.tsx");
    const lineCount = pageSrc.split("\n").length;
    assert.ok(
      lineCount <= 160,
      `C4c FAIL: page.tsx 应为装配层（≤160 行），实际 ${lineCount} 行`
    );
  }

  console.log("cockpit-v3-slim: all C1–C4 checks passed ✓");
})();
