// 用量配额·IO 编排层:读 app_settings 里的窗口起点 + 从 agent_traces 加载用量 → 调纯函数 computeUsage。
// 与 quota.ts(纯计算)解耦;函数接 db 参数,可在临时库上单测(同 lib/observability/metrics.ts 风格)。

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db/sqlite";
import {
  computeUsage,
  nextWindowStart,
  WEEK_MS,
  type RoleModels,
  type UsageResult,
  type UsageTrace,
} from "./quota";

// 窗口起点存 app_settings(KV);值为 epoch ms 字符串。运行时状态,不进 settings JSON。
const KEY_5H = "usage.window_start_5h";
const KEY_WEEK = "usage.window_start_week";

/** 把 agent_traces 加载成 UsageTrace[]:解析 model_usage_json 为分模型 token。无 usage 的行(cheap/router/错误)跳过。 */
export function loadRecentUsageTraces(sinceMs: number, db: DatabaseSync = getDb()): UsageTrace[] {
  const sinceIso = new Date(sinceMs).toISOString();
  const rows = db
    .prepare(`SELECT started_at, model_usage_json FROM agent_traces WHERE started_at >= ? AND model_usage_json IS NOT NULL`)
    .all(sinceIso) as Array<{ started_at: string; model_usage_json: string }>;

  const traces: UsageTrace[] = [];
  for (const row of rows) {
    const startedAt = Date.parse(row.started_at);
    if (Number.isNaN(startedAt)) continue;
    let parsed: Record<string, { inputTokens?: number; outputTokens?: number; cacheReadInputTokens?: number; cacheCreationInputTokens?: number }>;
    try {
      parsed = JSON.parse(row.model_usage_json);
    } catch {
      continue;
    }
    const models = Object.entries(parsed).map(([model, u]) => ({
      model,
      inputTokens: u?.inputTokens ?? 0,
      outputTokens: u?.outputTokens ?? 0,
      cacheReadTokens: u?.cacheReadInputTokens ?? 0,
      cacheCreationTokens: u?.cacheCreationInputTokens ?? 0,
    }));
    traces.push({ startedAt, models });
  }
  return traces;
}

function readStoredStart(db: DatabaseSync, key: string): number | null {
  const row = db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value: string } | undefined;
  if (!row) return null;
  const n = Number(row.value);
  return Number.isFinite(n) ? n : null;
}

function writeStoredStart(db: DatabaseSync, key: string, value: number): void {
  db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, String(value));
}

/**
 * 计算当前用量与拦截状态。
 * - persist=true(请求路径):把重锚后的窗口起点写回 app_settings。
 * - persist=false(展示路径):只读,不落库。
 * 时钟以 now 注入,便于测试。
 */
export function getUsageStatus(args: {
  now: number;
  roles: RoleModels;
  persist: boolean;
  db?: DatabaseSync;
}): UsageResult {
  const db = args.db ?? getDb();
  const storedStart5h = readStoredStart(db, KEY_5H);
  const storedStartWeek = readStoredStart(db, KEY_WEEK);

  // 周窗口是更早的边界:从它的(重锚后)起点起加载,足以覆盖两个窗口。
  const weekStartResolved = nextWindowStart(storedStartWeek, args.now, WEEK_MS);
  const traces = loadRecentUsageTraces(weekStartResolved, db);

  const result = computeUsage({ traces, now: args.now, storedStart5h, storedStartWeek, roles: args.roles });

  if (args.persist) {
    writeStoredStart(db, KEY_5H, result.start5h);
    writeStoredStart(db, KEY_WEEK, result.startWeek);
  }
  return result;
}
