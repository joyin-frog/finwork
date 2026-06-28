import assert from "node:assert/strict";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  backupDatabase,
  initializeFinanceDatabase,
  openAndVerifyDatabase,
  openFinanceDatabase
} from "../lib/db/sqlite.ts";

export const dbHardeningTestPromise = (async () => {
  const baseDir = `/tmp/finance-agent-db-hardening-${process.pid}`;
  mkdirSync(baseDir, { recursive: true });

  // ── T1: 正常库通过 quick_check ───────────────────────────────────────
  const goodPath = path.join(baseDir, "good.db");
  initializeFinanceDatabase(openFinanceDatabase(goodPath)).close();
  const verified = openAndVerifyDatabase(goodPath);
  assert.ok(verified, "T1 FAIL: 正常库应通过完整性校验");

  // ── T2: 损坏库显式报错且指向备份目录 ─────────────────────────────────
  const corruptPath = path.join(baseDir, "corrupt.db");
  writeFileSync(corruptPath, "这不是一个 SQLite 文件,模拟磁盘损坏 " + "x".repeat(4096));
  assert.throws(
    () => openAndVerifyDatabase(corruptPath),
    (err: Error) => err.message.includes("可能已损坏") && err.message.includes("backups"),
    "T2 FAIL: 损坏库必须显式报错并指向备份目录"
  );

  // ── T3: 备份生成、内容可用、超额轮转 ─────────────────────────────────
  const db = initializeFinanceDatabase(openFinanceDatabase(goodPath));
  db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run("test", "{}");
  for (let i = 0; i < 9; i += 1) {
    const target = backupDatabase(db, goodPath);
    assert.ok(target, `T3 FAIL: 第 ${i + 1} 次备份失败`);
  }
  const backupsDir = path.join(baseDir, "backups");
  const backups = readdirSync(backupsDir).filter((f) => f.endsWith(".db"));
  assert.equal(backups.length, 7, `T3 FAIL: 应只保留 7 份备份,实际 ${backups.length}`);
  // 备份可被打开且含业务表与数据
  const restored = openFinanceDatabase(path.join(backupsDir, backups.sort().reverse()[0]));
  const count = restored.prepare("SELECT COUNT(*) AS n FROM audit_logs").get() as { n: number };
  assert.ok(count.n >= 1, "T3 FAIL: 备份应包含已写入的数据");
  const hasPayrollTable = restored
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='payroll_records'")
    .get();
  assert.ok(hasPayrollTable, "T3 FAIL: 备份应包含业务表");
  restored.close();
  db.close();
  verified.close();

  // ── T4: allowExtension 遗留已移除(源码断言)──────────────────────────
  const sqliteSource = await readFile("lib/db/sqlite.ts", "utf-8");
  assert.ok(!sqliteSource.includes("allowExtension"), "T4 FAIL: allowExtension 遗留未清除");

  console.log("db-hardening: all 4 checks passed ✓");
})();
