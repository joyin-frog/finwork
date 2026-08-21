/**
 * 迁移纪律测试（spec-migration-discipline v1.1）
 *
 * 五组行为测试：
 * T1 删表不复活   — 存量已到 LATEST_VERSION 库，DROP TABLE 后再 initializeFinanceDatabase，表不复活
 * T2 新库 dump 等价 — :memory: 空库建完后，表名集合 / 索引名集合 / 各表列清单与 golden-schema.json 完全一致
 * T3 漂移愈合    — user_version=5 但缺一列，v6 reconcile 迁移愈合后列存在、版本升至 LATEST
 * T4 幂等        — 同一库连续 initializeFinanceDatabase 两次，第二次无 DDL、版本不变、不触发备份
 * T5 预演不碰原库 — rehearseMigrations 跑完后原库表集合与 user_version 不变
 *
 * 注意：所有用例使用显式 openFinanceDatabase(path) 传参，不污染 getDb() 单例。
 * 临时库路径：/tmp/finance-agent-<name>-<pid>.db（对齐 db-hardening.test.ts 样板）。
 */

import assert from "node:assert/strict";
import { mkdirSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openFinanceDatabase, initializeFinanceDatabase } from "../lib/db/sqlite.ts";
import { LATEST_VERSION, getUserVersion, runMigrations, MIGRATIONS } from "../lib/db/migrations.ts";
import { initializeSchema } from "../lib/db/schema.ts";
import { createManualMemoryConflictKey } from "../lib/memory-v2/manual.ts";
import goldenSchema from "./fixtures/golden-schema.json";

// rehearseMigrations is exported only after implementation; safe lazy read
import * as sqliteExports from "../lib/db/sqlite.ts";
type RehearseResult = { ok: boolean; fromVersion: number; toVersion: number; error?: string };
const rehearseMigrations = (sqliteExports as Record<string, unknown>)["rehearseMigrations"] as
  | ((db: DatabaseSync, dbPath: string) => Promise<RehearseResult> | RehearseResult)
  | undefined;

export const dbMigrationDisciplineTestPromise = (async () => {
  const pid = process.pid;

  // ─────────────────────────────────────────────────────────────────────────────
  // T1: 删表不复活（核心变更证明）
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dbPath = path.join(os.tmpdir(), `finance-agent-discipline-t1-${pid}.db`);
    mkdirSync(path.dirname(dbPath), { recursive: true });

    // 步骤 1：建全新库（走完所有迁移 → 达到 LATEST_VERSION）
    const db = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db, dbPath);

    // 步骤 2：确认 skill_snapshots 存在
    const beforeDrop = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_snapshots'"
    ).get();
    assert.ok(beforeDrop, "T1 前置: skill_snapshots 应存在");

    // 步骤 3：手动 DROP TABLE
    db.exec("DROP TABLE skill_snapshots");
    db.close();

    // 步骤 4：重新走 initializeFinanceDatabase
    const db2 = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db2, dbPath);

    // 步骤 5：断言表仍不存在（测试实现后才绿，改动前该断言失败）
    const afterReinit = db2.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='skill_snapshots'"
    ).get();
    assert.equal(afterReinit, undefined, "T1 FAIL: skill_snapshots 不应被 baseline 复活（存量库应只走迁移）");

    db2.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("T1 PASS: 删表不复活 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T2: 新库 dump 等价（表名集合 / 索引名集合 / 各表列清单 对照 golden-schema.json）
  // ─────────────────────────────────────────────────────────────────────────────
  {
    // 用 :memory: 因为新库不需要 rehearse 文件复制
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA foreign_keys = ON");

    // no-op backupFn：内存库无路径需要
    runMigrations(db, ":memory:", () => null);

    // 表名集合
    const actualTables = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>).map((r) => r.name);

    const expectedTables = [...goldenSchema.tables].sort();
    assert.deepEqual(
      [...actualTables].sort(),
      expectedTables,
      `T2 FAIL: 表名集合不匹配。实际: ${JSON.stringify(actualTables)}`
    );

    // 索引名集合
    const actualIndexes = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_autoindex_%' ORDER BY name"
    ).all() as Array<{ name: string }>).map((r) => r.name);

    const expectedIndexes = [...goldenSchema.indexes].sort();
    assert.deepEqual(
      [...actualIndexes].sort(),
      expectedIndexes,
      `T2 FAIL: 索引名集合不匹配。实际: ${JSON.stringify(actualIndexes)}`
    );

    // 各表列清单（PRAGMA table_info 成员对照）
    for (const tbl of actualTables) {
      const actualCols = (db.prepare(`PRAGMA table_info("${tbl}")`).all() as Array<{ name: string }>).map(
        (c) => c.name
      ).sort();
      const expectedEntry = (goldenSchema.columns as Record<string, Array<{ name: string }>>)[tbl];
      assert.ok(expectedEntry, `T2 FAIL: golden-schema.json 中缺少表 ${tbl}`);
      const expectedCols = expectedEntry.map((c) => c.name).sort();
      assert.deepEqual(
        actualCols,
        expectedCols,
        `T2 FAIL: 表 ${tbl} 的列清单不匹配。实际: ${JSON.stringify(actualCols)}，预期: ${JSON.stringify(expectedCols)}`
      );
    }

    // user_version 应为 LATEST_VERSION
    const version = getUserVersion(db);
    assert.equal(version, LATEST_VERSION, `T2 FAIL: 新库 user_version 应为 ${LATEST_VERSION}，实际 ${version}`);

    db.close();
    console.log("T2 PASS: 新库 dump 等价 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T3: 漂移愈合（user_version=5 但缺一列，v6 reconcile 愈合后列存在、版本升至 LATEST）
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dbPath = path.join(os.tmpdir(), `finance-agent-discipline-t3-${pid}.db`);
    mkdirSync(path.dirname(dbPath), { recursive: true });

    // 先建全新库并执行 baseline（v1）以创建所有基础表
    const db = openFinanceDatabase(dbPath);
    initializeSchema(db);
    db.exec("PRAGMA user_version = 5");

    // 模拟漂移：删掉 knowledge_documents.meta_status 列（重建表缺失该列）
    db.exec(`
      CREATE TABLE knowledge_documents_backup AS SELECT * FROM knowledge_documents;
      DROP TABLE knowledge_documents;
      CREATE TABLE knowledge_documents (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        title        TEXT    NOT NULL,
        file_name    TEXT    NOT NULL,
        mime_type    TEXT    NOT NULL,
        category     TEXT    NOT NULL DEFAULT 'general',
        size_bytes   INTEGER NOT NULL DEFAULT 0,
        chunk_count  INTEGER NOT NULL DEFAULT 0,
        content_hash TEXT    NOT NULL DEFAULT '',
        created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
        storage_path TEXT    NOT NULL DEFAULT '',
        last_hit_at  TEXT,
        hit_count    INTEGER NOT NULL DEFAULT 0,
        archived     INTEGER NOT NULL DEFAULT 0,
        metadata     TEXT
      );
      INSERT INTO knowledge_documents SELECT id, title, file_name, mime_type, category, size_bytes, chunk_count, content_hash, created_at, updated_at, storage_path, last_hit_at, hit_count, archived, metadata FROM knowledge_documents_backup;
      DROP TABLE knowledge_documents_backup;
    `);

    // 验证 meta_status 列确实不存在
    const colsBefore = (db.prepare("PRAGMA table_info(knowledge_documents)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(!colsBefore.includes("meta_status"), "T3 前置: meta_status 应不存在（模拟漂移）");

    db.close();

    // 重新打开并走 initializeFinanceDatabase → v6 reconcile 应补上 meta_status
    const db2 = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db2, dbPath);

    const colsAfter = (db2.prepare("PRAGMA table_info(knowledge_documents)").all() as Array<{ name: string }>).map((c) => c.name);
    assert.ok(colsAfter.includes("meta_status"), "T3 FAIL: v6 reconcile 应补回 meta_status 列");

    const version = getUserVersion(db2);
    assert.equal(version, LATEST_VERSION, `T3 FAIL: 愈合后 user_version 应为 ${LATEST_VERSION}，实际 ${version}`);

    db2.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("T3 PASS: 漂移愈合 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T4: 幂等（同一库连续两次 initializeFinanceDatabase，第二次不触发备份）
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const dbPath = path.join(os.tmpdir(), `finance-agent-discipline-t4-${pid}.db`);
    mkdirSync(path.dirname(dbPath), { recursive: true });

    // 第一次初始化
    const db = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db, dbPath);

    const versionAfterFirst = getUserVersion(db);
    assert.equal(versionAfterFirst, LATEST_VERSION, `T4 前置: 第一次后 user_version 应为 ${LATEST_VERSION}`);

    // 第二次：直接调 runMigrations 并注入计数 backupFn，断言未被调用
    let backupCallCount = 0;
    runMigrations(db, dbPath, (_db, _path) => {
      backupCallCount++;
      return null;
    });

    const versionAfterSecond = getUserVersion(db);
    assert.equal(versionAfterSecond, LATEST_VERSION, `T4 FAIL: 第二次后 user_version 应不变（${LATEST_VERSION}）`);
    assert.equal(backupCallCount, 0, `T4 FAIL: 第二次 runMigrations 不应触发备份，实际触发了 ${backupCallCount} 次`);

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("T4 PASS: 幂等 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T5: 预演不碰原库（rehearseMigrations 后原库表集合与 user_version 不变）
  // ─────────────────────────────────────────────────────────────────────────────
  {
    assert.ok(
      rehearseMigrations !== undefined,
      "T5 FAIL: rehearseMigrations 应导出自 lib/db/sqlite.ts"
    );

    const dbPath = path.join(os.tmpdir(), `finance-agent-discipline-t5-${pid}.db`);
    mkdirSync(path.dirname(dbPath), { recursive: true });

    // 建一个已到 LATEST_VERSION 的库
    const db = openFinanceDatabase(dbPath);
    initializeFinanceDatabase(db, dbPath);

    const versionBefore = getUserVersion(db);
    const tablesBefore = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>).map((r) => r.name);

    // 跑 rehearse
    const result = await rehearseMigrations!(db, dbPath);
    assert.ok(result.ok, `T5 FAIL: rehearseMigrations 应返回 ok:true，实际: ${JSON.stringify(result)}`);

    // 原库不变
    const versionAfter = getUserVersion(db);
    const tablesAfter = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all() as Array<{ name: string }>).map((r) => r.name);

    assert.equal(versionAfter, versionBefore, "T5 FAIL: rehearseMigrations 不应改变原库 user_version");
    assert.deepEqual(tablesAfter, tablesBefore, "T5 FAIL: rehearseMigrations 不应改变原库表集合");

    db.close();
    try { unlinkSync(dbPath); } catch { /* ignore */ }
    console.log("T5 PASS: 预演不碰原库 ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T6: v23 session 列 rename 保留存量 locator
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE chat_conversations (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        claude_session_id TEXT,
        claude_session_updated_at TEXT
      );
      INSERT INTO chat_conversations
        (id, title, claude_session_id, claude_session_updated_at)
      VALUES
        (1, 'legacy', 'legacy-session-1', '2026-07-29 10:00:00');
    `);
    const migration = MIGRATIONS.find((item) => item.version === 23);
    assert.ok(migration, "T6 FAIL: v23 migration 应存在");
    migration.up(db);
    const columns = (db.prepare("PRAGMA table_info(chat_conversations)").all() as Array<{ name: string }>)
      .map((column) => column.name);
    assert.ok(columns.includes("runtime_session_id"));
    assert.ok(columns.includes("runtime_session_updated_at"));
    assert.ok(!columns.includes("claude_session_id"));
    const row = db.prepare(
      "SELECT runtime_session_id, runtime_session_updated_at FROM chat_conversations WHERE id = 1"
    ).get() as { runtime_session_id: string; runtime_session_updated_at: string };
    assert.equal(row.runtime_session_id, "legacy-session-1");
    assert.equal(row.runtime_session_updated_at, "2026-07-29 10:00:00");
    db.close();
    console.log("T6 PASS: v23 session rename 保留存量 locator ✓");
  }

  // ─────────────────────────────────────────────────────────────────────────────
  // T7: v39 重建历史手工记忆冲突键与双向关系，且重复执行幂等
  // ─────────────────────────────────────────────────────────────────────────────
  {
    const db = new DatabaseSync(":memory:");
    runMigrations(db, ":memory:", () => null);
    const insert = db.prepare(`
      INSERT INTO memory_records_v2
        (memory_id, kind, scope_json, scope_tenant_id, scope_principal_id,
         entity_refs_json, content_json, conflict_key, source_evidence_json,
         confidence, sensitivity, approval_status, supersedes_json, conflicts_with_json,
         created_at, owner_json, content_hash, lifecycle_status)
      VALUES (?, 'semantic', ?, 'local', 'local-user', '[]', ?, ?, '["evidence-1"]',
              1, 'internal', ?, '[]', '[]', ?, ?, ?, 'active')
    `);
    const scope = JSON.stringify({ tenantId: "local", principalId: "local-user" });
    const owner = JSON.stringify({ id: "local-user", type: "user", tenantId: "local" });
    insert.run(
      "manual-old-a",
      scope,
      JSON.stringify({ topic: " 月结  报表口径 ", summary: "采用审定数" }),
      "legacy-random-key-a",
      "candidate",
      "2026-08-01T00:00:00.000Z",
      owner,
      "content-a",
    );
    insert.run(
      "manual-old-b",
      scope,
      JSON.stringify({ topic: "月结 报表口径", summary: "采用账面数" }),
      "legacy-random-key-b",
      "approved",
      "2026-08-02T00:00:00.000Z",
      owner,
      "content-b",
    );

    const expectedKey = createManualMemoryConflictKey("semantic", "月结 报表口径");
    const migrate = () => {
      db.exec("PRAGMA user_version = 38");
      runMigrations(db, ":memory:", () => null);
    };
    migrate();
    const rows = db.prepare(`
      SELECT memory_id, conflict_key, conflicts_with_json
      FROM memory_records_v2
      WHERE memory_id IN ('manual-old-a','manual-old-b')
      ORDER BY memory_id
    `).all() as Array<{ memory_id: string; conflict_key: string; conflicts_with_json: string }>;
    assert.deepEqual(rows.map((row) => row.conflict_key), [expectedKey, expectedKey]);
    assert.deepEqual(JSON.parse(rows[0].conflicts_with_json), ["manual-old-b"]);
    assert.deepEqual(JSON.parse(rows[1].conflicts_with_json), ["manual-old-a"]);
    const relationCount = () => (db.prepare(`
      SELECT COUNT(*) AS count FROM memory_relations_v2
      WHERE relation = 'conflicts_with'
        AND from_memory_id IN ('manual-old-a','manual-old-b')
        AND to_memory_id IN ('manual-old-a','manual-old-b')
    `).get() as { count: number }).count;
    assert.equal(relationCount(), 2, "T7 FAIL: 应创建两条对称冲突关系");
    migrate();
    assert.equal(relationCount(), 2, "T7 FAIL: 重复迁移不应产生重复冲突关系");
    db.close();
    console.log("T7 PASS: v39 重建历史手工记忆冲突关系且幂等 ✓");
  }

  console.log("db-migration-discipline: all 7 checks passed ✓");
})();
