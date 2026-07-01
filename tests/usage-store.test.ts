import assert from "node:assert/strict";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite";
import { getUsageStatus, loadRecentUsageTraces } from "../lib/usage/store";
import { buildBlockedNotice, FIVE_HOUR_LIMIT, FIVE_HOUR_MS, WEEK_MS, type RoleModels } from "../lib/usage/quota";

const { equal, ok } = assert;

const roles: RoleModels = {
  routerModel: "claude-haiku-4-5",
  mainModel: "claude-opus-4-8",
  subagentModel: "claude-sonnet-4-6",
};

function insertTrace(db: ReturnType<typeof openFinanceDatabase>, traceId: string, startedAtMs: number, usage: Record<string, unknown>) {
  db.prepare(`
    INSERT INTO agent_traces (trace_id, started_at, model_used, model_usage_json)
    VALUES (?, ?, ?, ?)
  `).run(traceId, new Date(startedAtMs).toISOString(), "claude-opus-4-8", JSON.stringify(usage));
}

const opus = (input: number) => ({ "claude-opus-4-8": { inputTokens: input, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } });

export const usageStoreTestPromise = (async () => {
  const tmpPath = `/tmp/usage-store-test-${process.pid}-${Date.now()}.db`;
  process.env.FINANCE_AGENT_DB_PATH = tmpPath;
  const setupDb = initializeFinanceDatabase(openFinanceDatabase(tmpPath));
  setupDb.close();

  const now = 1_900_000_000_000; // 固定时钟

  // ── T1: 加载 + 窗口归并(5h 只计窗内,周计全部) ─────────────────
  {
    const db = openFinanceDatabase(tmpPath);
    insertTrace(db, "t-in5h", now - 1000, opus(100));                  // 5h、周内
    insertTrace(db, "t-out5h", now - FIVE_HOUR_MS - 1000, opus(200));  // 出 5h、入周
    // 窗口起点:5h 覆盖 t-in5h 不覆盖 t-out5h;周覆盖两者
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run("usage.window_start_5h", String(now - FIVE_HOUR_MS + 2000));
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run("usage.window_start_week", String(now - WEEK_MS + 1000));

    const traces = loadRecentUsageTraces(now - WEEK_MS, db);
    ok(traces.length >= 2, "T1 FAIL: 应加载到 >=2 条 trace");

    const r = getUsageStatus({ now, roles, persist: false, db });
    equal(r.fivehour.used, 100, "T1 FAIL: 5h 只应计窗内 100");
    equal(r.week.used, 300, "T1 FAIL: 周应计 100+200=300");
    equal(r.blocked, false, "T1 FAIL: 远未超限");
    db.close();
  }

  // ── T2: persist=true 把重锚起点写回 app_settings ────────────────
  {
    const db = openFinanceDatabase(tmpPath);
    const r = getUsageStatus({ now, roles, persist: true, db });
    const v5 = (db.prepare("SELECT value FROM app_settings WHERE key=?").get("usage.window_start_5h") as { value: string }).value;
    equal(Number(v5), r.start5h, "T2 FAIL: 应把 start5h 写回 app_settings");
    db.close();
  }

  // ── T3: 首次使用(无 app_settings 记录)→ 懒锚为 now、used=0 ──────
  {
    const tmp2 = `/tmp/usage-store-fresh-${process.pid}-${Date.now()}.db`;
    const db = initializeFinanceDatabase(openFinanceDatabase(tmp2), tmp2);
    // 塞一条"过去"的 trace:首次锚定为 now 后不应被回溯计入
    insertTrace(db, "old", now - 10_000, opus(999));
    const r = getUsageStatus({ now, roles, persist: true, db });
    equal(r.fivehour.used, 0, "T3 FAIL: 首次锚定后历史 trace 不应计入");
    equal(r.start5h, now, "T3 FAIL: 首次应锚定为 now");
    const v = (db.prepare("SELECT value FROM app_settings WHERE key=?").get("usage.window_start_week") as { value: string }).value;
    equal(Number(v), now, "T3 FAIL: 周起点应写回 now");
    db.close();
    try { (await import("node:fs")).unlinkSync(tmp2); } catch { /* ok */ }
  }

  // ── T4: 超限集成(真 SQLite)→ blocked + notice ─────────────────
  {
    const tmp3 = `/tmp/usage-store-over-${process.pid}-${Date.now()}.db`;
    const db = initializeFinanceDatabase(openFinanceDatabase(tmp3), tmp3);
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run("usage.window_start_5h", String(now - 2000));
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run("usage.window_start_week", String(now - 2000));
    insertTrace(db, "over", now - 1000, opus(FIVE_HOUR_LIMIT + 1));
    const r = getUsageStatus({ now, roles, persist: false, db });
    equal(r.blocked, true, "T4 FAIL: 超限应 blocked");
    const notice = buildBlockedNotice(r);
    ok(notice && notice.window === "5h", "T4 FAIL: 应给出 5h 拦截 notice");
    db.close();
    try { (await import("node:fs")).unlinkSync(tmp3); } catch { /* ok */ }
  }

  // ── T5: 周窗口刚滚动、5h 仍活动 → 不漏 5h 窗内用量(P1 回归) ──
  {
    const tmp5 = `/tmp/usage-store-rollover-${process.pid}-${Date.now()}.db`;
    const db = initializeFinanceDatabase(openFinanceDatabase(tmp5), tmp5);
    // 5h 窗 1 小时前开、仍活动;周窗已过期 → getUsageStatus 内部重锚为 now。
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run("usage.window_start_5h", String(now - 60 * 60 * 1000));
    db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?)").run("usage.window_start_week", String(now - WEEK_MS - 1000));
    // 30 分钟前的 trace:落在 5h 窗内,但在重锚后的周起点(now)之前。
    insertTrace(db, "in5h-prerollover", now - 30 * 60 * 1000, opus(123));
    const r = getUsageStatus({ now, roles, persist: false, db });
    equal(r.fivehour.used, 123, "T5 FAIL: 5h 窗内 trace 不应因周窗滚动而被漏算");
    equal(r.week.used, 0, "T5 FAIL: 周窗刚重锚,用量应为 0");
    db.close();
    try { (await import("node:fs")).unlinkSync(tmp5); } catch { /* ok */ }
  }

  delete process.env.FINANCE_AGENT_DB_PATH;
  try { (await import("node:fs")).unlinkSync(tmpPath); } catch { /* ok */ }
  console.log("usage-store tests passed");
})();
