/**
 * WP-G 发票日期索引：v17 迁移幂等性 + 索引存在断言。
 */

import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations, getUserVersion, LATEST_VERSION } from "../lib/db/migrations.ts";

export const migrationV17TestPromise = (async () => {
  // ── T1: 全新库跑完迁移链后 idx_fact_invoices_invoice_date 存在 ─────────────
  {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, ":memory:", () => null);

    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fact_invoices_invoice_date'"
    ).get() as { name: string } | undefined;
    assert.ok(idx, "v17 T1: idx_fact_invoices_invoice_date 应存在");
    assert.equal(idx!.name, "idx_fact_invoices_invoice_date", "v17 T1: 索引名应正确");

    const version = getUserVersion(db);
    assert.equal(version, LATEST_VERSION, `v17 T1: user_version 应为 LATEST_VERSION(${LATEST_VERSION})，实际 ${version}`);
    assert.ok(version >= 17, `v17 T1: user_version 应 >= 17，实际 ${version}`);

    db.close();
    console.log("migration-v17 T1 PASS: 全新库索引存在 ✓");
  }

  // ── T2: 连跑两次 runMigrations 幂等（索引仍存在，不报错）──────────────────
  {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON");

    // 第一次
    runMigrations(db, ":memory:", () => null);
    const v1 = getUserVersion(db);

    // 第二次（应 no-op）
    runMigrations(db, ":memory:", () => null);
    const v2 = getUserVersion(db);

    assert.equal(v1, v2, "v17 T2: 二次运行后 user_version 不变");

    const idx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fact_invoices_invoice_date'"
    ).get() as { name: string } | undefined;
    assert.ok(idx, "v17 T2: 二次运行后索引仍存在（幂等）");

    db.close();
    console.log("migration-v17 T2 PASS: 幂等运行 ✓");
  }

  // ── T3: 直接执行 v17 up() 函数在已有 fact_invoices 的库上是幂等的 ──────────
  {
    const { MIGRATIONS } = await import("../lib/db/migrations.ts");
    const v17 = MIGRATIONS.find((m) => m.version === 17);
    assert.ok(v17, "v17 T3: MIGRATIONS 数组中应有 version=17 条目");
    assert.equal(v17!.version, 17, "v17 T3: 迁移编号确为 17");

    // 建一个只含 fact_invoices 的简易库，运行 v17 up 两次
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE fact_invoices (
        invoice_no TEXT PRIMARY KEY,
        invoice_date TEXT,
        amount_cents INTEGER NOT NULL,
        source TEXT NOT NULL
      )
    `);
    // 第一次
    v17!.up(db);
    const idx1 = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fact_invoices_invoice_date'"
    ).get() as { name: string } | undefined;
    assert.ok(idx1, "v17 T3: 第一次执行后索引应存在");

    // 第二次（CREATE INDEX IF NOT EXISTS 幂等）
    v17!.up(db);
    const idx2 = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_fact_invoices_invoice_date'"
    ).get() as { name: string } | undefined;
    assert.ok(idx2, "v17 T3: 第二次执行后索引仍存在");

    db.close();
    console.log("migration-v17 T3 PASS: v17.up 幂等 ✓");
  }

  console.log("migration-v17: all 3 checks passed ✓");
})();
