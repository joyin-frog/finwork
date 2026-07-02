/**
 * subagent-dispatches 测试（RR-2 切片）
 *
 * 运行（先行失败，等实现后才绿）：
 *   FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true npx tsx tests/subagent-dispatches.test.ts
 *
 * 覆盖：
 * - T1 迁移：全新库 → user_version === LATEST_VERSION 且 subagent_dispatches 表存在、关键列齐全
 * - T2 幂等：runMigrations 连跑两次不报错，已插入的行还在
 * - T3 store 生命周期：start → status running；end(success, summary, blockedReasons) → 列均写正确
 * - T4 查询：listRoleDispatchSummary count/lastAt 正确；listBlockedDispatches 只回 blocked_reason 非空行
 * - T5 runner 集成（无 API key，不发网络）：runSubagent 落行正确；未知 roleId 不落行
 */

import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";

export const subagentDispatchesTestPromise = (async () => {
  // ─── T1 迁移：全新库 → user_version === LATEST_VERSION 且 subagent_dispatches 表存在 ───
  {
    const dbPath = path.join(tmpdir(), `fa-dispatches-t1-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const { LATEST_VERSION, getUserVersion } = await import("../lib/db/migrations.ts");

      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);

      const version = getUserVersion(db);
      assert.equal(
        version,
        LATEST_VERSION,
        `T1 FAIL: user_version 应为 ${LATEST_VERSION}，实际 ${version}`
      );
      assert.ok(LATEST_VERSION >= 4, `T1 FAIL: 含 subagent_dispatches 迁移时 LATEST_VERSION 应 >= 4，实际 ${LATEST_VERSION}`);

      // 表存在
      const tableRow = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='subagent_dispatches'")
        .get();
      assert.ok(tableRow, "T1 FAIL: subagent_dispatches 表应存在");

      // 关键列齐全（PRAGMA table_info）
      type ColInfo = { cid: number; name: string; type: string; notnull: number; dflt_value: string | null; pk: number };
      const cols = db.prepare("PRAGMA table_info(subagent_dispatches)").all() as ColInfo[];
      const colNames = cols.map((c) => c.name);
      const requiredCols = [
        "id", "role_id", "skill", "label", "trace_id", "conversation_id",
        "status", "summary", "blocked_reason", "started_at", "ended_at", "duration_ms",
      ];
      for (const col of requiredCols) {
        assert.ok(colNames.includes(col), `T1 FAIL: 缺少列 ${col}，实有: ${colNames.join(", ")}`);
      }

      // 索引存在
      type IdxInfo = { type: string; name: string; tbl_name: string };
      const indexes = db
        .prepare("SELECT type, name, tbl_name FROM sqlite_master WHERE type='index' AND tbl_name='subagent_dispatches'")
        .all() as IdxInfo[];
      const idxNames = indexes.map((i) => i.name);
      assert.ok(
        idxNames.some((n) => n.includes("role") || n.includes("dispatch")),
        `T1 FAIL: 应存在 role_id 索引，实有: ${idxNames.join(", ")}`
      );

      db.close();
      console.log("subagent-dispatches T1: 迁移建表 + 列 + 索引 ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T2 幂等：runMigrations 连跑两次不报错，已插入的行还在 ──────────────────────
  {
    const dbPath = path.join(tmpdir(), `fa-dispatches-t2-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const { openFinanceDatabase, initializeFinanceDatabase, backupDatabase } = await import("../lib/db/sqlite.ts");
      const { runMigrations, LATEST_VERSION, getUserVersion } = await import("../lib/db/migrations.ts");

      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);

      // 插一行（需要表存在，若 T1 已通过才能到这里）
      try {
        db.prepare(
          "INSERT INTO subagent_dispatches (role_id, status) VALUES (?, ?)"
        ).run("bookkeeper", "running");
      } catch {
        // 若表不存在，T2 仍应 fail 在此（先行失败OK）
        throw new Error("T2 FAIL: subagent_dispatches 表不存在，无法插入测试行（迁移未实现）");
      }

      const versionBefore = getUserVersion(db);

      // 第二次跑迁移
      runMigrations(db, dbPath, backupDatabase);

      const versionAfter = getUserVersion(db);
      assert.equal(versionAfter, versionBefore, "T2 FAIL: 第二次 runMigrations 不应改变 user_version");
      assert.equal(versionAfter, LATEST_VERSION, `T2 FAIL: 版本应维持 ${LATEST_VERSION}`);

      // 行仍在
      const row = db
        .prepare("SELECT role_id, status FROM subagent_dispatches WHERE role_id='bookkeeper'")
        .get() as { role_id: string; status: string } | undefined;
      assert.ok(row, "T2 FAIL: 第二次迁移后已插入行应仍存在");
      assert.equal(row!.role_id, "bookkeeper", "T2 FAIL: role_id 值应为 bookkeeper");

      db.close();
      console.log("subagent-dispatches T2: 幂等 ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T3 store 生命周期 ──────────────────────────────────────────────────────
  {
    const dbPath = path.join(tmpdir(), `fa-dispatches-t3-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      // dispatch-store 是本切片新建的文件
      const { recordDispatchStart, recordDispatchEnd } = await import("../lib/db/dispatch-store.ts");

      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // start
      const dispatchId = recordDispatchStart({
        roleId: "bookkeeper",
        skill: "kingdee-draft",
        label: "凭证草稿任务",
        traceId: "trace-t3",
        conversationId: "conv-001",
      });
      assert.ok(typeof dispatchId === "number" && dispatchId > 0, `T3 FAIL: recordDispatchStart 应返回正整数行 id，实际 ${dispatchId}`);

      // 验证 status = running
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare("SELECT status, role_id, skill, label, trace_id, conversation_id, ended_at, duration_ms FROM subagent_dispatches WHERE id = ?")
          .get(dispatchId) as Record<string, unknown> | undefined;
        verifyDb.close();
        assert.ok(row, `T3 FAIL: recordDispatchStart 后应能查到 id=${dispatchId} 的行`);
        assert.equal(row!.status, "running", "T3 FAIL: start 后 status 应为 running");
        assert.equal(row!.role_id, "bookkeeper", "T3 FAIL: role_id 应为 bookkeeper");
        assert.equal(row!.skill, "kingdee-draft", "T3 FAIL: skill 应存储");
        assert.equal(row!.label, "凭证草稿任务", "T3 FAIL: label 应存储");
        assert.ok(row!.ended_at == null, "T3 FAIL: 开始时 ended_at 应为 null");
        assert.ok(row!.duration_ms == null, "T3 FAIL: 开始时 duration_ms 应为 null");
      }

      // end(success, summary, blockedReasons)
      recordDispatchEnd(dispatchId, {
        status: "success",
        summary: "凭证草稿生成完毕，共 3 张",
        blockedReasons: ["export_kingdee_draft"],
      });

      // 验证 end 后的状态
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare("SELECT status, summary, blocked_reason, ended_at, duration_ms FROM subagent_dispatches WHERE id = ?")
          .get(dispatchId) as Record<string, unknown> | undefined;
        verifyDb.close();
        assert.ok(row, `T3 FAIL: recordDispatchEnd 后应能查到 id=${dispatchId} 的行`);
        // status 与 blocked_reason 独立：success 可带 blocked_reason
        assert.equal(row!.status, "success", "T3 FAIL: end 后 status 应为 success");
        assert.ok(
          typeof row!.blocked_reason === "string" && (row!.blocked_reason as string).includes("export_kingdee_draft"),
          `T3 FAIL: blocked_reason 应含 export_kingdee_draft，实际: ${row!.blocked_reason}`
        );
        assert.ok(row!.summary, "T3 FAIL: summary 应被写入");
        assert.ok(row!.ended_at != null, "T3 FAIL: end 后 ended_at 应非空");
        assert.ok(typeof row!.duration_ms === "number" && (row!.duration_ms as number) >= 0, "T3 FAIL: duration_ms 应为非负数");
      }

      console.log("subagent-dispatches T3: store 生命周期 ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T4 查询：listRoleDispatchSummary + listBlockedDispatches ───────────────
  {
    const dbPath = path.join(tmpdir(), `fa-dispatches-t4-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    try {
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const { recordDispatchStart, recordDispatchEnd, listRoleDispatchSummary, listBlockedDispatches } =
        await import("../lib/db/dispatch-store.ts");

      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      // 插入多角色多行
      // analyst x2（一条 blocked，一条无 blocked）
      const id1 = recordDispatchStart({ roleId: "analyst", label: "分析 1" });
      recordDispatchEnd(id1, { status: "success", summary: "分析完成", blockedReasons: [] });

      const id2 = recordDispatchStart({ roleId: "analyst", label: "分析 2" });
      recordDispatchEnd(id2, { status: "success", summary: "有门阻", blockedReasons: ["export_kingdee_draft"] });

      // bookkeeper x1（失败 + 无 blocked）
      const id3 = recordDispatchStart({ roleId: "bookkeeper", label: "记账 1" });
      recordDispatchEnd(id3, { status: "failed", summary: "API key 未配置", blockedReasons: [] });

      // listRoleDispatchSummary
      const summary = listRoleDispatchSummary();
      assert.ok(Array.isArray(summary), "T4 FAIL: listRoleDispatchSummary 应返回数组");
      const analystRow = summary.find((r) => r.roleId === "analyst");
      const bookkeeperRow = summary.find((r) => r.roleId === "bookkeeper");
      assert.ok(analystRow, "T4 FAIL: 应有 analyst 的汇总行");
      assert.equal(analystRow!.count, 2, `T4 FAIL: analyst count 应为 2，实际 ${analystRow!.count}`);
      assert.ok(analystRow!.lastAt != null, "T4 FAIL: analyst lastAt 应非空");
      assert.ok(bookkeeperRow, "T4 FAIL: 应有 bookkeeper 的汇总行");
      assert.equal(bookkeeperRow!.count, 1, `T4 FAIL: bookkeeper count 应为 1，实际 ${bookkeeperRow!.count}`);

      // listBlockedDispatches：只回 blocked_reason 非空的行
      const blocked = listBlockedDispatches();
      assert.ok(Array.isArray(blocked), "T4 FAIL: listBlockedDispatches 应返回数组");
      // id2 有 blocked_reason；id1/id3 无
      assert.equal(blocked.length, 1, `T4 FAIL: 应只有 1 条 blocked 行，实际 ${blocked.length}`);
      const blockedRow = blocked[0];
      assert.ok(blockedRow.roleId === "analyst", `T4 FAIL: blocked 行 roleId 应为 analyst，实际 ${blockedRow.roleId}`);
      assert.ok(
        typeof blockedRow.blockedReason === "string" && blockedRow.blockedReason.includes("export_kingdee_draft"),
        `T4 FAIL: blockedReason 应含 export_kingdee_draft，实际 ${blockedRow.blockedReason}`
      );
      // 检查返回字段覆盖契约要求的所有字段
      assert.ok("id" in blockedRow, "T4 FAIL: blocked 行缺少 id 字段");
      assert.ok("label" in blockedRow, "T4 FAIL: blocked 行缺少 label 字段");
      assert.ok("summary" in blockedRow, "T4 FAIL: blocked 行缺少 summary 字段");
      assert.ok("conversationId" in blockedRow, "T4 FAIL: blocked 行缺少 conversationId 字段");
      assert.ok("endedAt" in blockedRow, "T4 FAIL: blocked 行缺少 endedAt 字段");

      console.log("subagent-dispatches T4: 查询 ✓");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try { rmSync(dbPath, { force: true }); } catch { /* ignore */ }
    }
  }

  // ─── T5 runner 集成（无 API key，不发网络） ──────────────────────────────────
  {
    const dir = mkdtempSync(path.join(tmpdir(), "fa-dispatches-t5-"));
    const dbPath = path.join(dir, "t5.db");
    const settingsPath = path.join(dir, "settings.json");
    const secretFilePath = path.join(dir, "secret"); // 不存在 → 空 key

    const savedEnv = {
      DB_PATH: process.env.FINANCE_AGENT_DB_PATH,
      SETTINGS_PATH: process.env.FINANCE_AGENT_SETTINGS_PATH,
      SECRET_BACKEND: process.env.FINANCE_AGENT_SECRET_BACKEND,
      SECRET_FILE: process.env.FINANCE_AGENT_SECRET_FILE,
    };

    process.env.FINANCE_AGENT_DB_PATH = dbPath;
    process.env.FINANCE_AGENT_SETTINGS_PATH = settingsPath;
    process.env.FINANCE_AGENT_SECRET_BACKEND = "file";
    process.env.FINANCE_AGENT_SECRET_FILE = secretFilePath;

    try {
      const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
      _resetSecretCache();

      // 初始化 DB
      const { openFinanceDatabase, initializeFinanceDatabase } = await import("../lib/db/sqlite.ts");
      const db = openFinanceDatabase(dbPath);
      initializeFinanceDatabase(db, dbPath);
      db.close();

      const { runSubagent } = await import("../lib/agent/subagent-runner.ts");
      const parentOutputDir = path.join(dir, "out");

      // 5a：已知 roleId="analyst" → 无 API key → 失败，但应落一行 status=failed
      const r1 = await runSubagent(
        { roleId: "analyst", instructions: "做点分析", label: "T5-analyst" },
        { parentOutputDir }
      );
      assert.equal(r1.success, false, "T5 FAIL: 无 key 时 runSubagent 应返回 success:false");

      // 查库：应有一行 role_id='analyst' 且 status='failed'
      {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const row = verifyDb
          .prepare("SELECT role_id, status, ended_at, duration_ms FROM subagent_dispatches WHERE role_id='analyst' ORDER BY id DESC LIMIT 1")
          .get() as Record<string, unknown> | undefined;
        verifyDb.close();
        assert.ok(row, "T5 FAIL: 已知 roleId 的 dispatch 应落行到 subagent_dispatches");
        assert.equal(row!.role_id, "analyst", "T5 FAIL: 落行的 role_id 应为 analyst");
        assert.equal(row!.status, "failed", `T5 FAIL: 无 key 返回失败时 status 应为 failed，实际 ${row!.status}`);
        assert.ok(row!.ended_at != null, "T5 FAIL: ended_at 应被写入");
        assert.ok(typeof row!.duration_ms === "number", "T5 FAIL: duration_ms 应被写入");
      }

      // 5b：未知 roleId → 不落行
      const countBefore = (() => {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const r = verifyDb
          .prepare("SELECT COUNT(*) AS n FROM subagent_dispatches WHERE role_id='no-such-role'")
          .get() as { n: number };
        verifyDb.close();
        return r.n;
      })();

      const r2 = await runSubagent(
        { roleId: "no-such-role", instructions: "随便做点事", label: "T5-unknown" },
        { parentOutputDir }
      );
      assert.equal(r2.success, false, "T5 FAIL: 未知 roleId 应返回 success:false");

      const countAfter = (() => {
        const verifyDb = new DatabaseSync(dbPath, { open: true });
        const r = verifyDb
          .prepare("SELECT COUNT(*) AS n FROM subagent_dispatches WHERE role_id='no-such-role'")
          .get() as { n: number };
        verifyDb.close();
        return r.n;
      })();

      assert.equal(
        countAfter,
        countBefore,
        `T5 FAIL: 未知 roleId 不应在 subagent_dispatches 中落行，before=${countBefore} after=${countAfter}`
      );

      console.log("subagent-dispatches T5: runner 集成（已知角色落行/未知角色不落行） ✓");
    } finally {
      // 恢复环境变量
      const restoreEnv = (val: string | undefined, key: string) => {
        if (val === undefined) delete process.env[key];
        else process.env[key] = val;
      };
      restoreEnv(savedEnv.DB_PATH, "FINANCE_AGENT_DB_PATH");
      restoreEnv(savedEnv.SETTINGS_PATH, "FINANCE_AGENT_SETTINGS_PATH");
      restoreEnv(savedEnv.SECRET_BACKEND, "FINANCE_AGENT_SECRET_BACKEND");
      restoreEnv(savedEnv.SECRET_FILE, "FINANCE_AGENT_SECRET_FILE");
      try {
        const { _resetSecretCache } = await import("../lib/settings/secret-store.ts");
        _resetSecretCache();
      } catch { /* ignore */ }
      try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  console.log("subagent-dispatches: all T1–T5 ✓");
})();
