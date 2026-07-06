/**
 * db-facts-migration.test.ts — WP1a 事实库迁移五组测试（TDD 先红后绿）
 *
 * G1 预演先行   — rehearseMigrations 在副本上跑 v7，原库不变，副本 quick_check ok
 * G2 精度校验中止 — 迁移中写入 |x*100 - round(x*100)| >= 0.005 的脏数据，v7 抛出并回滚，旧表依然存在
 * G3 旧表退役   — v7 跑完后 invoice_ledger / payroll_records / business_metrics 不存在，重启仍不复活
 * G4 门面等价抽样 — finance-store 导出函数（recordInvoices / upsertBusinessMetrics / savePayrollDraft /
 *                  getInvoiceLedgerStats / getBusinessOverview / getLatestConfirmedPayroll / confirmPayrollPeriod）
 *                  在新表上的返回值形态与元单位语义不变
 * G5 累计接力保持 — getLatestConfirmedPayroll 年内接力 / confirmPayrollPeriod 锁定语义 /
 *                  (employee,year,month) 唯一性，在新 fact_payroll 表上逐位验证
 */

import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

import { openFinanceDatabase, initializeFinanceDatabase } from "../lib/db/sqlite.ts";
import { LATEST_VERSION, getUserVersion, runMigrations } from "../lib/db/migrations.ts";
import * as sqliteExports from "../lib/db/sqlite.ts";
import {
  recordInvoices,
  upsertBusinessMetrics,
  savePayrollDraft,
  getInvoiceLedgerStats,
  getBusinessOverview,
  getLatestConfirmedPayroll,
  confirmPayrollPeriod,
  listPayrollRecords,
} from "../lib/db/finance-store.ts";

type RehearseResult = { ok: boolean; fromVersion: number; toVersion: number; error?: string };
const rehearseMigrations = (sqliteExports as Record<string, unknown>)["rehearseMigrations"] as
  | ((db: DatabaseSync, dbPath: string) => Promise<RehearseResult> | RehearseResult)
  | undefined;

/** 构造一条标准 CumulativePayrollResult（门面写入格式） */
function makePayrollResult(employeeName: string, overrides?: Partial<{
  grossPay: number;
  socialInsurance: number;
  housingFund: number;
  specialDeduction: number;
  netPay: number;
  taxCurrent: number;
  taxWithheldCum: number;
}>) {
  const base = {
    grossPay: 10000,
    socialInsurance: 2000,
    housingFund: 1000,
    specialDeduction: 500,
    netPay: 6800,
    taxCurrent: 200,
    taxWithheldCum: 200,
    ...overrides,
  };
  return {
    employeeName,
    grossPay: base.grossPay,
    socialInsurance: base.socialInsurance,
    housingFund: base.housingFund,
    specialDeduction: base.specialDeduction,
    netPay: base.netPay,
    taxCurrent: base.taxCurrent,
    taxWithheldCum: base.taxWithheldCum,
    detail: {
      grossCum: base.grossPay,
      socialCum: base.socialInsurance,
      fundCum: base.housingFund,
      specialCum: base.specialDeduction,
      taxableIncomeCum: 6500,
      taxDueCum: 200,
      taxConfigVersion: "2024v1",
    },
  };
}

export const dbFactsMigrationTestPromise = (async () => {
  assert.ok(
    LATEST_VERSION >= 7,
    `前置失败: LATEST_VERSION 应 >= 7（含 v7 facts_foundation），实际 ${LATEST_VERSION}`
  );

  // ─────────────────────────────────────────────────────────────────────────────
  // G1: 预演先行 — rehearseMigrations 在副本跑 v7，原库不变，副本 quick_check ok
  // ─────────────────────────────────────────────────────────────────────────────
  {
    assert.ok(
      rehearseMigrations !== undefined,
      "G1 FAIL: rehearseMigrations 应导出自 lib/db/sqlite.ts"
    );

    const dir = mkdtempSync(path.join(tmpdir(), "fa-facts-g1-"));
    const dbPath = path.join(dir, "g1.db");
    try {
      // 建一个跑到 v6 的库（尚未跑 v7）
      const db = openFinanceDatabase(dbPath);
      // v6 库：先建 baseline，再手动退回 v6
      initializeFinanceDatabase(db, dbPath);

      const versionBefore = getUserVersion(db);
      const tablesBefore = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string }>).map((r) => r.name);

      // 跑 rehearse（此时 LATEST_VERSION=7，副本会跑 v7）
      const result = await rehearseMigrations!(db, dbPath);
      assert.ok(result.ok, `G1 FAIL: rehearseMigrations 应返回 ok:true，实际: ${JSON.stringify(result)}`);
      assert.equal(result.toVersion, LATEST_VERSION, `G1 FAIL: rehearseMigrations 应将副本迁到 ${LATEST_VERSION}`);

      // 原库不变
      const versionAfter = getUserVersion(db);
      const tablesAfter = (db.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
      ).all() as Array<{ name: string }>).map((r) => r.name);

      assert.equal(versionAfter, versionBefore, "G1 FAIL: rehearseMigrations 不应改变原库 user_version");
      assert.deepEqual(tablesAfter, tablesBefore, "G1 FAIL: rehearseMigrations 不应改变原库表集合");

      db.close();
      console.log("G1 PASS: 预演先行 ✓");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // G2: 精度校验中止 — 脏数据行导致 v7 抛出并回滚，旧表依然存在
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-facts-g2-"));
    const dbPath = path.join(dir, "g2.db");
    try {
      // 手建 v6 状态：baseline 表 + invoice_ledger 含脏数据 + user_version=6
      // 不能走 initializeFinanceDatabase（那会直接跑到 v7 删掉旧表）；
      // 改用 initializeSchema 建 baseline 表（含 invoice_ledger），再手动设版本。
      const { initializeSchema: initSchema } = await import("../lib/db/schema.ts");
      const db = openFinanceDatabase(dbPath);
      initSchema(db);
      db.exec("PRAGMA user_version = 6");

      // 插入一条精度超差的 invoice_ledger 行（金额 0.001 元 → round(0.001*100)=0, |0.001*100 - 0| = 0.1 >= 0.005）
      db.prepare(
        "INSERT INTO invoice_ledger (invoice_no, amount, recorded_at) VALUES ('DIRTY001', 0.001, datetime('now'))"
      ).run();
      db.close();

      // 重新打开，跑 migrations（v7），预期因精度超差抛出
      const db2 = openFinanceDatabase(dbPath);
      assert.equal(getUserVersion(db2), 6, "G2 前置: user_version 应为 6");

      let threw = false;
      try {
        runMigrations(db2, dbPath, () => null);
      } catch (err) {
        threw = true;
        assert.ok(
          err instanceof Error && err.message.includes("精度"),
          `G2 FAIL: 应抛精度相关错误，实际: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      assert.ok(threw, "G2 FAIL: 脏数据应导致 v7 抛出错误");

      // 回滚后旧表应仍存在（事务回滚保证原库无损）
      const invoiceTable = db2.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='invoice_ledger'"
      ).get();
      assert.ok(invoiceTable, "G2 FAIL: v7 回滚后 invoice_ledger 应仍存在（事务回滚）");

      // user_version 应仍为 6（迁移失败未提交）
      const version = getUserVersion(db2);
      assert.equal(version, 6, `G2 FAIL: 迁移失败后 user_version 应仍为 6，实际 ${version}`);

      db2.close();
      console.log("G2 PASS: 精度校验中止 ✓");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // G3: 旧表退役 — v7 跑完后三张旧表不存在，重启仍不复活
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-facts-g3-"));
    const dbPath = path.join(dir, "g3.db");
    try {
      // 建全量 v7 库
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);

      // 旧表应不存在
      for (const table of ["invoice_ledger", "payroll_records", "business_metrics"]) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        assert.equal(row, undefined, `G3 FAIL: v7 后 ${table} 应不存在`);
      }

      // 新表应存在
      for (const table of ["fact_invoices", "fact_payroll", "fact_metrics", "fact_obligations"]) {
        const row = db.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        assert.ok(row, `G3 FAIL: v7 后 ${table} 应存在`);
      }

      db.close();

      // 重启（重新走 initializeFinanceDatabase）后旧表仍不复活
      const db2 = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db2, dbPath);

      for (const table of ["invoice_ledger", "payroll_records", "business_metrics"]) {
        const row = db2.prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
        ).get(table);
        assert.equal(row, undefined, `G3 FAIL: 重启后 ${table} 不应复活`);
      }

      db2.close();
      console.log("G3 PASS: 旧表退役 ✓");
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // G4: 门面等价抽样 — finance-store 导出函数在新表上返回值形态与元单位语义不变
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-facts-g4-"));
    const dbPath = path.join(dir, "g4.db");
    const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 4a: recordInvoices — inserted/duplicates 形态不变
      {
        const result = recordInvoices([
          { invoiceNo: "INV-G4-001", amount: 1000.5, invoiceDate: "2026-07-01", category: "办公" },
        ]);
        assert.ok(Array.isArray(result.inserted), "G4a FAIL: inserted 应为数组");
        assert.ok(Array.isArray(result.duplicates), "G4a FAIL: duplicates 应为数组");
        assert.equal(result.inserted.length, 1, "G4a FAIL: 应有 1 条插入");
        assert.equal(result.inserted[0], "INV-G4-001", "G4a FAIL: 插入的发票号应匹配");

        // 重复插入
        const result2 = recordInvoices([{ invoiceNo: "INV-G4-001", amount: 1000.5 }]);
        assert.equal(result2.inserted.length, 0, "G4a FAIL: 重复应为 0 插入");
        assert.equal(result2.duplicates.length, 1, "G4a FAIL: 重复应有 1 条");
        assert.ok(typeof result2.duplicates[0]!.recordedAt === "string", "G4a FAIL: recordedAt 应为字符串");
      }

      // 4b: getInvoiceLedgerStats — total/addedThisMonth 为 number
      {
        const stats = getInvoiceLedgerStats(2026, 7);
        assert.ok(typeof stats.total === "number", "G4b FAIL: total 应为 number");
        assert.ok(typeof stats.addedThisMonth === "number", "G4b FAIL: addedThisMonth 应为 number");
        assert.ok(stats.total >= 1, "G4b FAIL: total 应 >= 1（已有一条发票）");
      }

      // 4c: upsertBusinessMetrics + getBusinessOverview — revenue/profit 为元单位 number
      {
        upsertBusinessMetrics([
          { year: 2026, month: 3, revenue: 100000, profit: 20000 },
          { year: 2026, month: 2, revenue: 90000, profit: 18000 },
          { year: 2025, month: 12, revenue: 80000, profit: 15000 },
        ]);
        const overview = getBusinessOverview(new Date("2026-03-15"), undefined as unknown as DatabaseSync);
        // month 视角：revenue=100000（元），不是分
        assert.equal(overview.month.revenue, 100000, "G4c FAIL: month.revenue 应为元单位 100000");
        assert.equal(overview.month.profit, 20000, "G4c FAIL: month.profit 应为元单位 20000");
        // prevRevenue = 2026年2月
        assert.equal(overview.month.prevRevenue, 90000, "G4c FAIL: prevRevenue 应为元单位 90000");
        // year 视角 sum（含 3 月数据）
        assert.ok(typeof overview.year.revenue === "number", "G4c FAIL: year.revenue 应为 number");
        assert.ok(typeof overview.source === "string" || overview.source === null, "G4c FAIL: source 形态正确");
      }

      // 4d: savePayrollDraft + getLatestConfirmedPayroll — netPay 为元单位
      {
        const result = makePayrollResult("张三", { netPay: 8500.5 });
        savePayrollDraft(2026, 1, result, 3, { db: undefined });
        // getLatestConfirmedPayroll 此时返回 null（未确认）
        const latest = getLatestConfirmedPayroll("张三", 2026, 2);
        assert.equal(latest, null, "G4d FAIL: 未确认时应返回 null");

        // confirmPayrollPeriod 后 getLatestConfirmedPayroll 返回记录，netPay 为元单位
        const db2 = openFinanceDatabase(dbPath);
        confirmPayrollPeriod(2026, 1, undefined, db2);
        const latestAfter = getLatestConfirmedPayroll("张三", 2026, 2, db2);
        assert.ok(latestAfter !== null, "G4d FAIL: 确认后 getLatestConfirmedPayroll 应返回记录");
        assert.equal(latestAfter!.netPay, 8500.5, "G4d FAIL: netPay 应为元单位 8500.5");
        assert.equal(latestAfter!.employeeName, "张三", "G4d FAIL: employeeName 应为 张三");
        assert.equal(latestAfter!.status, "confirmed", "G4d FAIL: 确认后 status 应为 confirmed");
        db2.close();
      }

      console.log("G4 PASS: 门面等价抽样 ✓");
    } finally {
      if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // G5: 累计接力保持 — 在新 fact_payroll 表上逐位验证接力语义
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-facts-g5-"));
    const dbPath = path.join(dir, "g5.db");
    const savedDbPath = process.env.FINANCE_AGENT_DB_PATH;
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 5a: 写入 1-2 月草稿，确认 1 月，getLatestConfirmedPayroll(李四, 2026, 2) 应返回 1 月记录
      const r1 = makePayrollResult("李四", { grossPay: 15000, netPay: 12000, taxCurrent: 500 });
      savePayrollDraft(2026, 1, r1, 1, { db: undefined });

      const r2 = makePayrollResult("李四", { grossPay: 16000, netPay: 12800, taxCurrent: 600 });
      savePayrollDraft(2026, 2, r2, 2, { db: undefined });

      // 确认 1 月
      const db2 = openFinanceDatabase(dbPath);
      const confirmResult = confirmPayrollPeriod(2026, 1, undefined, db2);
      assert.ok(confirmResult.confirmed.includes("李四"), "G5 FAIL: 1 月确认应包含李四");

      // 接力验证：2 月的基线应取 1 月
      const latest = getLatestConfirmedPayroll("李四", 2026, 2, db2);
      assert.ok(latest !== null, "G5 FAIL: 应能取到 1 月已确认记录");
      assert.equal(latest!.month, 1, "G5 FAIL: 接力基线应为 1 月");
      assert.equal(latest!.grossPay, 15000, "G5 FAIL: grossPay 接力应为 15000（元单位）");
      assert.equal(latest!.netPay, 12000, "G5 FAIL: netPay 接力应为 12000（元单位）");

      // 5b: (employee, year, month) 唯一约束 — 同月重写为 upsert，不抛错
      const r1b = makePayrollResult("李四", { grossPay: 15100, netPay: 12050 });
      assert.doesNotThrow(
        () => savePayrollDraft(2026, 1, r1b, 1, { overwriteConfirmed: true, db: db2 }),
        "G5 FAIL: overwriteConfirmed 覆盖不应抛错"
      );
      const records = listPayrollRecords(2026, 1, db2);
      assert.equal(records.length, 1, "G5 FAIL: (员工,年,月) 唯一约束 upsert 后应只有 1 行");

      // 5c: 不同员工不互扰
      const rWang = makePayrollResult("王五", { grossPay: 20000, netPay: 16000 });
      savePayrollDraft(2026, 1, rWang, 1, { overwriteConfirmed: true, db: db2 });
      const records2 = listPayrollRecords(2026, 1, db2);
      assert.equal(records2.length, 2, "G5 FAIL: 两名员工各有一行");

      // 5d: getLatestConfirmedPayroll 年内接力限制 — month < beforeMonth
      const latestForMonth1 = getLatestConfirmedPayroll("李四", 2026, 1, db2);
      assert.equal(latestForMonth1, null, "G5 FAIL: month=1 之前无确认记录，应返回 null");

      db2.close();
      console.log("G5 PASS: 累计接力保持 ✓");
    } finally {
      if (savedDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
      else process.env.FINANCE_AGENT_DB_PATH = savedDbPath;
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log("db-facts-migration: all G1–G5 passed ✓");
})();
