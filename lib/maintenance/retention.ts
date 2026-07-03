import { DatabaseSync } from "node:sqlite";
import { readdirSync, rmSync, rmdirSync, statSync } from "node:fs";
import path from "node:path";
import { getDb, insertAuditLog } from "@/lib/db/sqlite";
import { getClaudeConfigDir } from "@/lib/runtime/paths";

export const RETENTION_SETTINGS_KEY = "maintenance:retention";
const RETENTION_LAST_RUN_KEY = "maintenance:retention:lastRunAt";
const DAY_MS = 86_400_000;
const RUN_INTERVAL_MS = DAY_MS;
const MAX_RETENTION_DAYS = 3650;

export type RetentionConfig = {
  traceDays: number;
  appErrorDays: number;
  auditLogDays: number;
  /** null 表示禁用。chat_agent_events 是历史对话里的过程时间线(工具步骤/思考/时长),
   *  最终答案在 chat_messages 里不受影响。默认给一个长保留期封住无界增长,而非彻底禁用。 */
  chatEventDays: number | null;
};

export type RetentionStats = {
  traces: number;
  spans: number;
  appErrors: number;
  auditLogs: number;
  chatEvents: number;
  sessionTranscripts: number;
};

/** 内置 Claude CLI 会话 transcript(claude-config/projects/)的保留天数。
 *  仅影响 session resume:过期后续接自动回落全量历史重建(claude-adapter 已兜底),
 *  故写死不进 RetentionConfig;与 CLI 自身 cleanupPeriodDays 默认值对齐。 */
const SESSION_TRANSCRIPT_DAYS = 30;

export const DEFAULT_RETENTION_CONFIG: Readonly<RetentionConfig> = Object.freeze({
  traceDays: 90,
  appErrorDays: 90,
  auditLogDays: 180,
  // 保留一年滚动窗口:重度使用下 chat_agent_events 每任务数百行会无界增长、拖慢会话加载,
  // 一年足够覆盖可见历史;想彻底关闭清理可在设置里显式设为 null。
  chatEventDays: 365,
});

function isRetentionDays(value: unknown): value is number {
  return Number.isInteger(value) && Number(value) >= 1 && Number(value) <= MAX_RETENTION_DAYS;
}

export function isValidRetentionSettingsValue(value: string): boolean {
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const allowed = new Set(["traceDays", "appErrorDays", "auditLogDays", "chatEventDays"]);
    if (Object.keys(parsed).some((key) => !allowed.has(key))) return false;
    return (
      (parsed.traceDays === undefined || isRetentionDays(parsed.traceDays)) &&
      (parsed.appErrorDays === undefined || isRetentionDays(parsed.appErrorDays)) &&
      (parsed.auditLogDays === undefined || isRetentionDays(parsed.auditLogDays)) &&
      (parsed.chatEventDays === undefined || parsed.chatEventDays === null || isRetentionDays(parsed.chatEventDays))
    );
  } catch {
    return false;
  }
}

export function loadRetentionConfig(db: DatabaseSync = getDb()): RetentionConfig {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = ?").get(RETENTION_SETTINGS_KEY) as
    | { value: string }
    | undefined;
  if (!row || !isValidRetentionSettingsValue(row.value)) return { ...DEFAULT_RETENTION_CONFIG };

  const parsed = JSON.parse(row.value) as Partial<RetentionConfig>;
  return {
    traceDays: parsed.traceDays ?? DEFAULT_RETENTION_CONFIG.traceDays,
    appErrorDays: parsed.appErrorDays ?? DEFAULT_RETENTION_CONFIG.appErrorDays,
    auditLogDays: parsed.auditLogDays ?? DEFAULT_RETENTION_CONFIG.auditLogDays,
    chatEventDays: parsed.chatEventDays === undefined ? DEFAULT_RETENTION_CONFIG.chatEventDays : parsed.chatEventDays,
  };
}

function cutoffEpochSeconds(days: number, now: number): number {
  return Math.floor((now - days * DAY_MS) / 1000);
}

export function pruneOldTraces(days: number, db: DatabaseSync = getDb(), now = Date.now()): number {
  const result = db
    .prepare("DELETE FROM agent_traces WHERE unixepoch(started_at) < ?")
    .run(cutoffEpochSeconds(days, now));
  return Number(result.changes);
}

// Traces are pruned immediately before spans. An old span whose trace is deleted in this cycle
// therefore becomes orphaned and is removed here; a newly orphaned span can intentionally lag by
// at most one bounded retention cycle, avoiding deletion of fresh in-flight spans.
export function pruneOldSpans(days: number, db: DatabaseSync = getDb(), now = Date.now()): number {
  const cutoffMs = now - days * DAY_MS;
  const result = db.prepare(
    "DELETE FROM agent_spans WHERE started_at < ? AND NOT EXISTS (SELECT 1 FROM agent_traces WHERE agent_traces.trace_id = agent_spans.trace_id)"
  ).run(cutoffMs);
  return Number(result.changes);
}

export function pruneOldAppErrors(days: number, db: DatabaseSync = getDb(), now = Date.now()): number {
  const result = db
    .prepare("DELETE FROM app_errors WHERE reported = 1 AND ts < ?")
    .run(now - days * DAY_MS);
  return Number(result.changes);
}

export function pruneOldAuditLogs(days: number, db: DatabaseSync = getDb(), now = Date.now()): number {
  const result = db
    .prepare("DELETE FROM audit_logs WHERE unixepoch(created_at) < ?")
    .run(cutoffEpochSeconds(days, now));
  return Number(result.changes);
}

export function pruneOldChatEvents(days: number, db: DatabaseSync = getDb(), now = Date.now()): number {
  const result = db
    .prepare("DELETE FROM chat_agent_events WHERE unixepoch(created_at) < ?")
    .run(cutoffEpochSeconds(days, now));
  return Number(result.changes);
}

/**
 * 清理内置 Claude CLI 落盘的会话 transcript(<configDir>/projects/<cwd编码>/*.jsonl 及同名子目录)。
 * 按 mtime 判老:transcript 每回合追加,活跃会话 mtime 常新,不会被误删。
 * 只清应用自有的 claude-config 目录,绝不碰用户 ~/.claude。
 */
export function pruneOldSessionTranscripts(
  days: number = SESSION_TRANSCRIPT_DAYS,
  configDir: string = getClaudeConfigDir(),
  now = Date.now()
): number {
  const projectsDir = path.join(configDir, "projects");
  const cutoffMs = now - days * DAY_MS;
  let removed = 0;

  let projectEntries;
  try {
    projectEntries = readdirSync(projectsDir, { withFileTypes: true });
  } catch {
    return 0; // 目录还没建(尚无真实会话)
  }

  for (const project of projectEntries) {
    if (!project.isDirectory()) continue;
    const projectPath = path.join(projectsDir, project.name);
    for (const entry of readdirSync(projectPath)) {
      const entryPath = path.join(projectPath, entry);
      try {
        if (statSync(entryPath).mtimeMs < cutoffMs) {
          rmSync(entryPath, { recursive: true, force: true });
          removed += 1;
        }
      } catch {
        // 单个条目失败(并发写入/权限)不阻断其余清理
      }
    }
    try {
      rmdirSync(projectPath); // 仅当已空;非空抛错即保留
    } catch { /* 非空或已删,均可忽略 */ }
  }

  return removed;
}

export function runRetentionCycle(
  config: RetentionConfig = loadRetentionConfig(),
  db: DatabaseSync = getDb(),
  now = Date.now()
): { stats: RetentionStats; errors: string[] } {
  const stats: RetentionStats = { traces: 0, spans: 0, appErrors: 0, auditLogs: 0, chatEvents: 0, sessionTranscripts: 0 };
  const errors: string[] = [];

  const run = (name: keyof RetentionStats, operation: () => number) => {
    try {
      stats[name] = operation();
    } catch (error) {
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  run("traces", () => pruneOldTraces(config.traceDays, db, now));
  run("spans", () => pruneOldSpans(config.traceDays, db, now));
  run("appErrors", () => pruneOldAppErrors(config.appErrorDays, db, now));
  run("auditLogs", () => pruneOldAuditLogs(config.auditLogDays, db, now));
  if (config.chatEventDays !== null) {
    run("chatEvents", () => pruneOldChatEvents(config.chatEventDays!, db, now));
  }
  run("sessionTranscripts", () => pruneOldSessionTranscripts(SESSION_TRANSCRIPT_DAYS, getClaudeConfigDir(), now));

  try {
    insertAuditLog("retention_cycle", {
      config,
      stats,
      errors,
      chatEventsEnabled: config.chatEventDays !== null,
      completedAt: new Date(now).toISOString(),
    }, db);
  } catch {
    // Retention is startup maintenance: audit failure must not block application startup.
  }

  return { stats, errors };
}

// Claim before scheduling to make multiple Next bundles at-most-once. A crash may defer retry
// until the next 24h window, which is intentional for best-effort startup maintenance.
export function claimRetentionRun(db: DatabaseSync = getDb(), now = Date.now()): boolean {
  const result = db.prepare(`
    INSERT INTO app_settings(key, value) VALUES(?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
    WHERE CAST(app_settings.value AS INTEGER) <= ?
  `).run(RETENTION_LAST_RUN_KEY, String(now), String(now - RUN_INTERVAL_MS));
  return Number(result.changes) === 1;
}

export function scheduleRetentionCycle(): void {
  try {
    const db = getDb();
    if (!claimRetentionRun(db)) return;
    setImmediate(() => {
      try {
        runRetentionCycle(loadRetentionConfig(db), db);
      } catch {
        // Best-effort startup maintenance must never block or crash the app.
      }
    });
  } catch {
    // Database may be unavailable during startup; normal request handling reports that separately.
  }
}
