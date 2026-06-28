import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { upsertBusinessMetrics, getBusinessOverview } from "../lib/db/finance-store.ts";

export const businessMetricsTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-biz-test-"));
  const dbPath = path.join(dir, "test.db");

  const origDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  try {
    const db = initializeFinanceDatabase(openFinanceDatabase(dbPath));

    // ── AC6a: upsert 同 (year,month) 二次写入为更新 ────────────────────────
    upsertBusinessMetrics([{ year: 2026, month: 1, revenue: 100000, profit: 20000 }], db);
    upsertBusinessMetrics([{ year: 2026, month: 1, revenue: 120000, profit: 25000 }], db);
    const row = db.prepare("SELECT revenue, profit FROM business_metrics WHERE year=2026 AND month=1").get() as { revenue: number; profit: number };
    assert.equal(row.revenue, 120000, "AC6 FAIL: 同月二次写入应更新");
    assert.equal(row.profit, 25000, "AC6 FAIL: profit 应更新");

    // ── AC6b: 季度聚合 + 环比 ─────────────────────────────────────────────
    // 写入 Q1 2026 (Jan, Feb, Mar) 和 Q4 2025 (Oct, Nov, Dec)
    upsertBusinessMetrics([
      { year: 2026, month: 2, revenue: 130000, profit: 22000 },
      { year: 2026, month: 3, revenue: 140000, profit: 28000 },
      { year: 2025, month: 10, revenue: 90000, profit: 15000 },
      { year: 2025, month: 11, revenue: 95000, profit: 16000 },
      { year: 2025, month: 12, revenue: 100000, profit: 18000 },
    ], db);

    // "now" = 2026-03-15 (Q1)
    const now = new Date("2026-03-15T00:00:00.000Z");
    const overview = getBusinessOverview(now, db);

    // Month view (March 2026)
    assert.equal(overview.month.revenue, 140000, "AC6 FAIL: 月视角 revenue 错误");
    assert.equal(overview.month.profit, 28000, "AC6 FAIL: 月视角 profit 错误");
    assert.equal(overview.month.prevRevenue, 130000, "AC6 FAIL: 月环比 prevRevenue 应为 2 月");

    // Quarter view Q1 2026 vs Q4 2025
    assert.equal(overview.quarter.revenue, 120000 + 130000 + 140000, "AC6 FAIL: 季度 revenue 求和错误");
    assert.equal(overview.quarter.profit, 25000 + 22000 + 28000, "AC6 FAIL: 季度 profit 求和错误");
    assert.equal(overview.quarter.prevRevenue, 90000 + 95000 + 100000, "AC6 FAIL: 季度环比 prevRevenue 错误");
    assert.equal(overview.quarter.monthsCovered, 3, "AC6 FAIL: 季度 monthsCovered 应为 3");

    // Year view 2026 (jan-mar) vs 2025 (jan-mar, no data → null)
    assert.equal(overview.year.revenue, 120000 + 130000 + 140000, "AC6 FAIL: 年度 revenue 错误");
    assert.equal(overview.year.prevRevenue, null, "AC6 FAIL: 无上年同期数据时应为 null");

    // ── AC6c: 空数据库视角返回 null ──────────────────────────────────────
    const emptyDb = initializeFinanceDatabase(openFinanceDatabase(path.join(dir, "empty.db")));
    const emptyOverview = getBusinessOverview(new Date("2026-06-01"), emptyDb);
    assert.equal(emptyOverview.month.revenue, null, "AC6 FAIL: 空库月视角 revenue 应为 null");
    assert.equal(emptyOverview.quarter.profit, null, "AC6 FAIL: 空库季视角 profit 应为 null");
    assert.equal(emptyOverview.year.revenue, null, "AC6 FAIL: 空库年视角 revenue 应为 null");

    // ── AC7: record_business_metrics 工具 handler ─────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const captured: Record<string, any> = {};
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mockSdk: any = {
      tool: (name: string, _desc: string, _schema: unknown, handler: unknown) => {
        captured[name] = handler;
        return { name };
      }
    };

    const { createRecordBusinessMetricsTool } = await import("../lib/agent/mcp-tools/business-metrics.ts");
    createRecordBusinessMetricsTool(mockSdk);
    const toolHandler = captured["record_business_metrics"];
    assert.ok(typeof toolHandler === "function", "AC7 FAIL: 工具 handler 应注册");

    // 合法入参落库
    const validResult = await toolHandler({
      rows: [{ year: 2026, month: 6, revenue: 200000, profit: 40000 }]
    });
    assert.ok(!validResult.isError, `AC7 FAIL: 合法入参不应报错: ${JSON.stringify(validResult.content)}`);

    // 月份 13 → 报错不落库
    const badMonthResult = await toolHandler({
      rows: [{ year: 2026, month: 13, revenue: 100, profit: 10 }]
    });
    assert.ok(badMonthResult.isError, "AC7 FAIL: 月份 13 应报错");

    // 年份越界 → 报错
    const badYearResult = await toolHandler({
      rows: [{ year: 1999, month: 6, revenue: 100, profit: 10 }]
    });
    assert.ok(badYearResult.isError, "AC7 FAIL: 年份 1999 应报错");

    // profit 允许负数
    const negativeResult = await toolHandler({
      rows: [{ year: 2026, month: 5, revenue: 80000, profit: -5000 }]
    });
    assert.ok(!negativeResult.isError, "AC7 FAIL: profit 为负数应合法");

    // ── AC8: /api/cockpit/summary 含 business 三视角 + 空库 200 ───────────
    const { GET: summaryGET } = await import("../app/api/cockpit/summary/route.ts");
    const summaryRes = await summaryGET();
    assert.equal(summaryRes.status, 200, "AC8 FAIL: summary API 应返回 200");
    const summaryBody = (await summaryRes.json()) as {
      ok: boolean;
      data: {
        business: {
          month: { revenue: number | null };
          quarter: { revenue: number | null };
          year: { revenue: number | null };
        };
      };
    };
    assert.ok(summaryBody.ok, "AC8 FAIL: summary API ok 应为 true");
    assert.ok("business" in summaryBody.data, "AC8 FAIL: data 缺 business 字段");
    assert.ok("month" in summaryBody.data.business, "AC8 FAIL: business 缺 month 视角");
    assert.ok("quarter" in summaryBody.data.business, "AC8 FAIL: business 缺 quarter 视角");
    assert.ok("year" in summaryBody.data.business, "AC8 FAIL: business 缺 year 视角");

    db.close();
    emptyDb.close();
  } finally {
    if (origDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = origDb;
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("business-metrics: all 3 checks passed ✓");
})();
