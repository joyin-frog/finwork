import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  GovernedMemoryStore,
  loadGovernedPromptMemory,
  migrateLegacyMemoryCandidates,
  parseEffectivePeriodLabel,
  resolveMemoryRuntimeContext,
} from "../lib/memory-v2/index.ts";

const OWNER = { id: "local-user", type: "user" as const, tenantId: "local" };

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

export const memoryV2PromptMigrationTestPromise = (async () => {
  const root = mkdtempSync(path.join(tmpdir(), "finwork-memory-v2-migration-"));
  const memoryPath = path.join(root, "memory.md");
  writeFileSync(memoryPath, "# 工作约定\n- 报表必须保留公式\n# 反馈\n- 上次把含税价当成不含税价\n", "utf8");
  const db = makeDb();
  try {
    db.prepare("INSERT INTO role_memory(role_id, content, source, created_at) VALUES (?, ?, ?, ?)")
      .run("tax-officer", "申报前复核发票状态", "历史专员口径", "2026-01-01 00:00:00");

    const first = await migrateLegacyMemoryCandidates({ db, memoryPath, at: "2026-08-09T00:00:00.000Z" });
    assert.equal(first.roleMemory, 1, "MP-1 FAIL: role memory not migrated");
    assert.equal(first.memoryMarkdown, 2, "MP-1 FAIL: markdown units not migrated");
    const candidates = db.prepare("SELECT memory_id, approval_status FROM memory_records_v2 ORDER BY memory_id")
      .all() as Array<{ memory_id: string; approval_status: string }>;
    assert.equal(candidates.length, 3);
    assert.ok(candidates.every((row) => row.approval_status === "candidate"),
      "MP-1 FAIL: legacy import must never auto-approve");

    const second = await migrateLegacyMemoryCandidates({ db, memoryPath, at: "2026-08-09T00:05:00.000Z" });
    assert.equal(second.skipped, 3, "MP-2 FAIL: rerun should be idempotent");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_records_v2").get() as { count: number }).count, 3);

    // Simulate the crash window: candidate exists but migration log was not committed.
    const roleLog = db.prepare("SELECT source_id, memory_id FROM memory_migration_log_v2 WHERE source_kind = 'role_memory'")
      .get() as { source_id: string; memory_id: string };
    db.prepare("DELETE FROM memory_migration_log_v2 WHERE source_kind = 'role_memory' AND source_id = ?")
      .run(roleLog.source_id);
    const recovered = await migrateLegacyMemoryCandidates({ db, memoryPath, at: "2026-08-09T00:10:00.000Z" });
    assert.equal(recovered.roleMemory, 1, "MP-3 FAIL: crash-window log should recover");
    assert.equal((db.prepare("SELECT COUNT(*) AS count FROM memory_records_v2 WHERE memory_id = ?")
      .get(roleLog.memory_id) as { count: number }).count, 1, "MP-3 FAIL: recovery created duplicate memory");

    assert.deepEqual(parseEffectivePeriodLabel("2026 Q2"), {
      start: "2026-04-01", end: "2026-06-30", label: "2026 Q2",
    });
    assert.deepEqual(parseEffectivePeriodLabel("2026年"), {
      start: "2026-01-01", end: "2026-12-31", label: "2026年",
    });
    const runtime = resolveMemoryRuntimeContext({
      taskContract: {
        version: 1,
        taskKind: "text",
        requiredDeliverables: [],
        expectationSnapshot: { company: "甲公司", period: "2026 Q2" },
      },
    });
    assert.equal(runtime.entityRefs.length, 1, "MP-4 FAIL: company must become authoritative entity ref");
    assert.equal(runtime.effectivePeriod?.start, "2026-04-01");

    const store = new GovernedMemoryStore(db);
    const entityRef = runtime.entityRefs[0];
    const approved = store.createCandidate({
      conflictKey: "company:tax-rate",
      record: {
        id: "approved-memory-for-prompt",
        kind: "semantic",
        scope: { tenantId: "local", principalId: "local-user" },
        entityRefs: [entityRef],
        effectivePeriod: { start: "2026-04-01", end: "2026-06-30" },
        content: { summary: "甲公司二季度增值税率为 6%" },
        sourceEvidenceRefs: ["evidence-tax-source"],
        confidence: 0.98,
        sensitivity: "confidential",
        createdAt: "2026-04-01T00:00:00.000Z",
        owner: OWNER,
      },
    });
    store.approve({
      memoryId: approved.id,
      approver: OWNER,
      reason: "source-backed semantic fact",
      at: "2026-04-02T00:00:00.000Z",
    });
    const prompt = await loadGovernedPromptMemory({
      db,
      context: runtime,
      migrateLegacy: false,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    assert.equal(prompt.status, "ready");
    assert.match(prompt.markdown, /甲公司二季度增值税率为 6%/);
    assert.match(prompt.markdown, /证据:evidence-tax-source/);
    assert.doesNotMatch(prompt.markdown, /报表必须保留公式|申报前复核发票状态/,
      "MP-5 FAIL: unapproved legacy candidates leaked into prompt");

    const wrongEntity = await loadGovernedPromptMemory({
      db,
      context: { ...runtime, entityRefs: ["company-other"] },
      migrateLegacy: false,
      now: new Date("2026-05-01T00:00:00.000Z"),
    });
    assert.equal(wrongEntity.selections.some((item) => item.memory.id === approved.id), false,
      "MP-6 FAIL: wrong entity memory leaked");
    const wrongPeriod = await loadGovernedPromptMemory({
      db,
      context: { ...runtime, effectivePeriod: { start: "2027-01-01", end: "2027-12-31" } },
      migrateLegacy: false,
      now: new Date("2027-01-01T00:00:00.000Z"),
    });
    assert.equal(wrongPeriod.selections.some((item) => item.memory.id === approved.id), false,
      "MP-6 FAIL: wrong effective period memory leaked");

    const broken = new DatabaseSync(":memory:");
    try {
      broken.exec("CREATE TABLE role_memory(id INTEGER PRIMARY KEY, role_id TEXT, content TEXT, source TEXT, created_at TEXT)");
      broken.prepare("INSERT INTO role_memory VALUES (1, 'tax-officer', '旧口径不得兜底', NULL, '2026-01-01')").run();
      const degraded = await loadGovernedPromptMemory({
        db: broken,
        context: runtime,
        migrateLegacy: false,
      });
      assert.equal(degraded.status, "degraded");
      assert.deepEqual(degraded.selections, []);
      assert.doesNotMatch(degraded.markdown, /旧口径不得兜底/);
      assert.match(degraded.markdown, /不得使用旧记忆文件/);
    } finally {
      broken.close();
    }

    console.log("memory-v2 prompt/migration: candidate-only import, recovery, governed injection and fail-closed passed ✓");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("memory-v2-prompt-migration.test")) {
  memoryV2PromptMigrationTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
