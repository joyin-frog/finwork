/**
 * business-metrics-source.test.ts — CV-2 切片
 *
 * 覆盖：
 * - T1  迁移 v5 幂等：先在 v4 库插一行 source='agent'，跑迁移后断言 source='user_dictated'；
 *       连跑两次迁移不报错（幂等）
 * - T2  record_business_metrics 工具写入默认 source='user_dictated'
 * - T3  BusinessMetricsCard 源码含 TrustBadge import
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/business-metrics-source.test.ts
 */

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const businessMetricsSourceTestPromise = (async () => {
  // ──────────────────────────────────────────────────────────────────────────
  // T1: 迁移 v5 幂等 + 存量 'agent' → 'user_dictated' 映射
  // ──────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-biz-source-t1-"));
    const dbPath = path.join(dir, "t1.db");
    const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase, backupDatabase } = await import("../lib/db/sqlite.ts");
      const { runMigrations, LATEST_VERSION, getUserVersion } = await import("../lib/db/migrations.ts");

      // 先用 v4 初始化（至今存在的最新迁移）
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);

      assert.ok(
        LATEST_VERSION >= 5,
        `T1 FAIL: 含 v5 迁移时 LATEST_VERSION 应 >= 5，实际 ${LATEST_VERSION}`
      );

      // 在迁移前插入一行 source='agent'（存量数据）
      // business_metrics 表由 baseline(v1) 创建，v4 前就存在
      db.prepare(
        `INSERT INTO business_metrics (year, month, revenue, cost, expense, profit, note, source, updated_at)
         VALUES (2025, 6, 100000, NULL, NULL, 20000, NULL, 'agent', datetime('now'))`
      ).run();

      // 验证插入成功
      const before = db.prepare(
        "SELECT source FROM business_metrics WHERE year=2025 AND month=6"
      ).get() as { source: string } | undefined;
      assert.ok(before, "T1 FAIL: 测试数据应插入成功");
      assert.equal(before!.source, "agent", "T1 FAIL: 插入时 source 应为 agent（存量模拟）");

      // 裁决修订(2026-07-02):存量模拟必须真的把库退回 v4,让 v5 迁移在 runMigrations 里真实触发;
      // 不许依赖"打开即修正"之类的隐藏 fixup——那会掩盖迁移缺失,也污染 openFinanceDatabase 的职责。
      db.exec(`PRAGMA user_version = 4`);
      db.close();

      // 重新打开后跑迁移:v4 → v5,存量 'agent' 行被 UPDATE
      const db2 = openFinanceDatabase(dbPath);
      assert.equal(getUserVersion(db2), 4, "T1 前置: user_version 应已回退到 4");
      runMigrations(db2, dbPath, backupDatabase);
      const afterRow = db2.prepare(
        "SELECT source FROM business_metrics WHERE year=2025 AND month=6"
      ).get() as { source: string } | undefined;
      assert.ok(afterRow, "T1 FAIL: 迁移后存量行应仍存在");
      assert.equal(
        afterRow!.source,
        "user_dictated",
        `T1 FAIL: v5 迁移后 source 应为 user_dictated，实际 ${afterRow!.source}`
      );
      // 第二次幂等
      runMigrations(db2, dbPath, backupDatabase);
      const afterRow2 = db2.prepare(
        "SELECT source FROM business_metrics WHERE year=2025 AND month=6"
      ).get() as { source: string } | undefined;
      assert.equal(
        afterRow2?.source,
        "user_dictated",
        "T1 FAIL: 第二次迁移后 source 应仍为 user_dictated（幂等）"
      );
      db2.close();

      // 验证 LATEST_VERSION 已更新到 5
      const db3 = openFinanceDatabase(dbPath);
      const finalVersion = getUserVersion(db3);
      assert.ok(finalVersion >= 5, `T1 FAIL: 迁移后 user_version 应 >= 5，实际 ${finalVersion}`);
      db3.close();

      console.log("business-metrics-source T1: v5 迁移幂等 + 存量映射 ✓");
    } finally {
      if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // T2: record_business_metrics 工具写入默认 source='user_dictated'
  // ──────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-biz-source-t2-"));
    const dbPath = path.join(dir, "t2.db");
    const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // mock SDK（与 business-metrics.test.ts 保持一致）
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const captured: Record<string, any> = {};
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const mockSdk: any = {
        tool: (name: string, _desc: string | string[], _schema: unknown, handler: unknown) => {
          captured[name] = handler;
          return { name };
        }
      };

      const { createRecordBusinessMetricsTool } = await import("../lib/agent/mcp-tools/business-metrics.ts");
      createRecordBusinessMetricsTool(mockSdk);
      const toolHandler = captured["record_business_metrics"];
      assert.ok(typeof toolHandler === "function", "T2 FAIL: record_business_metrics 工具 handler 应注册");

      // 调用工具（不传 source 字段，应默认写入 user_dictated）
      const result = await toolHandler({
        rows: [{ year: 2026, month: 5, revenue: 150000, profit: 30000 }]
      });
      assert.ok(!result.isError, `T2 FAIL: 工具调用不应报错: ${JSON.stringify(result.content)}`);

      // 直接查库验证 source 字段
      const rawDb = new DatabaseSync(dbPath, { open: true });
      const row = rawDb.prepare(
        "SELECT source FROM business_metrics WHERE year=2026 AND month=5"
      ).get() as { source: string } | undefined;
      rawDb.close();

      assert.ok(row, "T2 FAIL: 工具调用后应有对应行");
      assert.equal(
        row!.source,
        "user_dictated",
        `T2 FAIL: record_business_metrics 写入默认 source 应为 user_dictated，实际 ${row!.source}`
      );

      console.log("business-metrics-source T2: 工具写入默认 source=user_dictated ✓");
    } finally {
      if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // T3: BusinessMetricsCard 源码含 TrustBadge import
  // ──────────────────────────────────────────────────────────────────────────
  {
    const filePath = "app/cockpit/business-metrics-card.tsx";
    assert.ok(existsSync(filePath), "T3 FAIL: app/cockpit/business-metrics-card.tsx 应存在");

    const src = await readFile(filePath, "utf-8");

    // 应 import TrustBadge
    assert.ok(
      src.includes("TrustBadge"),
      "T3 FAIL: business-metrics-card.tsx 应 import TrustBadge（spec §4.3）"
    );

    // 应 import 或使用 deriveTrustTier
    assert.ok(
      src.includes("deriveTrustTier") || src.includes("trust-tier"),
      "T3 FAIL: business-metrics-card.tsx 应使用 deriveTrustTier（spec §4.3）"
    );

    // TrustBadge 应在 JSX 中使用（渲染数据旁的信任标签）
    assert.ok(
      src.includes("<TrustBadge") || src.includes("TrustBadge tier"),
      "T3 FAIL: business-metrics-card.tsx 应在 JSX 中渲染 <TrustBadge>（spec §4.3）"
    );

    console.log("business-metrics-source T3: BusinessMetricsCard 含 TrustBadge ✓");
  }

  console.log("business-metrics-source: all T1–T3 passed ✓");
})();
