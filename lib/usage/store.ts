// 用量配额·IO 编排层:读 app_settings 里的窗口起点 + 从 agent_traces 加载用量 → 调纯函数 computeUsage。
// 与 quota.ts(纯计算)解耦;函数接 db 参数,可在临时库上单测(同 lib/observability/metrics.ts 风格)。

import type { DatabaseSync } from "node:sqlite";
import { getDb } from "@/lib/db/sqlite";
import {
  computeUsage,
  nextWindowStart,
  FIVE_HOUR_MS,
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

  // 从两窗口(重锚后)起点的更早者起加载。通常是周窗口更早;但当周窗口刚滚动、5h 仍活动时
  // (例:5h 窗在 7 天重置前一小时新开),周起点会变成 now,只按它加载会漏掉 5h 窗内的 trace,
  // 致 5h 用量算少、放行本应被拦的请求。取 min 兜住这种错位。
  const start5hResolved = nextWindowStart(storedStart5h, args.now, FIVE_HOUR_MS);
  const weekStartResolved = nextWindowStart(storedStartWeek, args.now, WEEK_MS);
  const traces = loadRecentUsageTraces(Math.min(start5hResolved, weekStartResolved), db);

  const result = computeUsage({ traces, now: args.now, storedStart5h, storedStartWeek, roles: args.roles });

  if (args.persist) {
    writeStoredStart(db, KEY_5H, result.start5h);
    writeStoredStart(db, KEY_WEEK, result.startWeek);
  }
  return result;
}
