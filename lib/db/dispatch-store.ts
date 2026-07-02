/**
 * dispatch-store.ts
 *
 * 子代理调度史读写(spec-role-registry §5)。
 * 走 getDb() 单例,惯例与 finance-store.ts 一致。
 */

import { getDb } from "./sqlite";

// ─── Write ──────────────────────────────────────────────────────────────────

export type RecordDispatchStartInput = {
  roleId: string;
  skill?: string;
  label?: string;
  traceId?: string;
  conversationId?: string;
};

/**
 * INSERT 一条 status='running' 的调度行,返回新行 id。
 * started_at 由 SQLite DEFAULT (datetime('now')) 填写。
 */
export function recordDispatchStart(input: RecordDispatchStartInput): number {
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO subagent_dispatches
         (role_id, skill, label, trace_id, conversation_id, status)
       VALUES (?, ?, ?, ?, ?, 'running')`
    )
    .run(
      input.roleId,
      input.skill ?? null,
      input.label ?? null,
      input.traceId ?? null,
      input.conversationId ?? null
    );
  return Number(result.lastInsertRowid);
}

export type RecordDispatchEndInput = {
  status: "success" | "failed";
  summary?: string;
  blockedReasons?: string[];
};

/**
 * UPDATE 调度行:写 ended_at、duration_ms、status、summary、blocked_reason。
 * duration_ms 由 started_at 差值计算(SQLite 侧),保证非空且非负。
 * status 与 blocked_reason 独立——任务可以 success 同时有 blocked_reason。
 */
export function recordDispatchEnd(id: number, r: RecordDispatchEndInput): void {
  const db = getDb();
  const blockedReason =
    r.blockedReasons && r.blockedReasons.length > 0
      ? r.blockedReasons.join(",")
      : null;
  db.prepare(
    `UPDATE subagent_dispatches
     SET
       status        = ?,
       summary       = ?,
       blocked_reason = ?,
       ended_at      = datetime('now'),
       duration_ms   = CAST(
         (julianday('now') - julianday(started_at)) * 86400000
         AS INTEGER
       )
     WHERE id = ?`
  ).run(r.status, r.summary ?? null, blockedReason, id);
}

// ─── Read ───────────────────────────────────────────────────────────────────

export type RoleDispatchSummary = {
  roleId: string;
  count: number;
  lastAt: string | null;
  lastSummary: string | null;
};

/**
 * GROUP BY role_id:派发次数 + 最近 started_at + 最近一条 summary。
 * 供角色卡「有记录才渲染」使用(spec §5.1)。
 */
export function listRoleDispatchSummary(): RoleDispatchSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT
         d.role_id,
         COUNT(*) AS cnt,
         MAX(d.started_at) AS last_at,
         (
           SELECT summary
           FROM subagent_dispatches
           WHERE role_id = d.role_id
           ORDER BY id DESC
           LIMIT 1
         ) AS last_summary
       FROM subagent_dispatches d
       GROUP BY d.role_id`
    )
    .all() as Array<{ role_id: string; cnt: number; last_at: string | null; last_summary: string | null }>;
  return rows.map((r) => ({
    roleId: r.role_id,
    count: Number(r.cnt),
    lastAt: r.last_at ?? null,
    lastSummary: r.last_summary ?? null,
  }));
}

export type BlockedDispatchRow = {
  id: number;
  roleId: string;
  label: string | null;
  summary: string | null;
  blockedReason: string;
  conversationId: string | null;
  endedAt: string | null;
};

export type DispatchRow = {
  id: number;
  roleId: string;
  label: string | null;
  summary: string | null;
  status: string;
  blockedReason: string | null;
  conversationId: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/**
 * 按 role_id 查调度史（started_at 降序），支持 limit/offset 分页。
 * 供 /api/agents/dispatches 台账接口使用。
 */
export function listDispatchesByRole(roleId: string, limit = 20, offset = 0): DispatchRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, role_id, label, summary, status, blocked_reason, conversation_id, started_at, ended_at
       FROM subagent_dispatches
       WHERE role_id = ?
       ORDER BY started_at DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(roleId, limit, offset) as Array<{
      id: number;
      role_id: string;
      label: string | null;
      summary: string | null;
      status: string;
      blocked_reason: string | null;
      conversation_id: string | null;
      started_at: string | null;
      ended_at: string | null;
    }>;
  return rows.map((r) => ({
    id: Number(r.id),
    roleId: r.role_id,
    label: r.label ?? null,
    summary: r.summary ?? null,
    status: r.status,
    blockedReason: r.blocked_reason ?? null,
    conversationId: r.conversation_id ?? null,
    startedAt: r.started_at ?? null,
    endedAt: r.ended_at ?? null,
  }));
}

export type RecentDispatchActivityRow = {
  id: number;
  roleId: string;
  label: string | null;
  summary: string | null;
  status: string;
  conversationId: string | null;
  startedAt: string | null;
  endedAt: string | null;
};

/**
 * 全角色 started_at DESC + id DESC 排序，返回最近 limit 条（含 running）。
 * 供动态条 GET /api/agents/activity 使用。
 */
export function listRecentDispatchActivity(limit = 10): RecentDispatchActivityRow[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, role_id, label, summary, status, conversation_id, started_at, ended_at
       FROM subagent_dispatches
       ORDER BY started_at DESC, id DESC
       LIMIT ?`
    )
    .all(limit) as Array<{
      id: number;
      role_id: string;
      label: string | null;
      summary: string | null;
      status: string;
      conversation_id: string | null;
      started_at: string | null;
      ended_at: string | null;
    }>;
  return rows.map((r) => ({
    id: Number(r.id),
    roleId: r.role_id,
    label: r.label ?? null,
    summary: r.summary ?? null,
    status: r.status,
    conversationId: r.conversation_id ?? null,
    startedAt: r.started_at ?? null,
    endedAt: r.ended_at ?? null,
  }));
}

/**
 * 查 blocked_reason 非空且 ended_at 在 sinceDays 天内的行(「停在门前的活」)。
 * sinceDays 默认 7。
 */
export function listBlockedDispatches(sinceDays = 7): BlockedDispatchRow[] {
  const db = getDb();
  // conversation_id 兜底:派发链路只带 trace_id 时,经 agent_traces 反查会话归属
  const rows = db
    .prepare(
      `SELECT sd.id, sd.role_id, sd.label, sd.summary, sd.blocked_reason,
              COALESCE(sd.conversation_id, CAST(at.conversation_id AS TEXT)) AS conversation_id,
              sd.ended_at
       FROM subagent_dispatches sd
       LEFT JOIN agent_traces at ON at.trace_id = sd.trace_id
       WHERE sd.blocked_reason IS NOT NULL
         AND sd.ended_at >= datetime('now', '-' || ? || ' days')`
    )
    .all(sinceDays) as Array<{
      id: number;
      role_id: string;
      label: string | null;
      summary: string | null;
      blocked_reason: string;
      conversation_id: string | null;
      ended_at: string | null;
    }>;
  return rows.map((r) => ({
    id: Number(r.id),
    roleId: r.role_id,
    label: r.label ?? null,
    summary: r.summary ?? null,
    blockedReason: r.blocked_reason,
    conversationId: r.conversation_id ?? null,
    endedAt: r.ended_at ?? null,
  }));
}
