/**
 * WP15: 审计日志与撤销
 *
 * - recordAudit: 写 audit_logs，支持 undo 逆操作载荷
 * - undoAuditEntry: 单事务执行全部逆操作 → 置 undone_at → 追记 audit_undo
 * - listAuditEntries: 倒序列表，含 undoable 派生字段
 *
 * undo 原语白名单（table 字段硬校验）：
 *   - fact_invoices
 *   - fact_metrics
 * 其余表传入时 recordAudit 直接抛错，防未来误用扩权。
 */

import { DatabaseSync } from "node:sqlite";
import { getDb } from "./sqlite";

// ─── 类型定义 ─────────────────────────────────────────────────────────────────

/** 撤销 INSERT：删除指定主键行 */
export type DeleteRowsOp = {
  op: "delete_rows";
  table: string;
  keyColumn: string;
  keys: Array<string | number>;
};

/** 撤销 UPDATE：恢复 before-image 整行（INSERT OR REPLACE） */
export type RestoreRowsOp = {
  op: "restore_rows";
  table: string;
  keyColumn: string;
  rows: Record<string, unknown>[];
};

export type UndoOp = DeleteRowsOp | RestoreRowsOp;

export type RecordAuditInput = {
  eventType: string;
  payload: unknown;
  conversationId?: number | null;
  traceId?: string | null;
  toolName?: string | null;
  undo?: UndoOp[] | null;
};

export type AuditEntry = {
  id: number;
  eventType: string;
  payload: unknown;
  conversationId: number | null;
  traceId: string | null;
  toolName: string | null;
  undoable: boolean;
  undoneAt: string | null;
  createdAt: string;
};

// ─── 白名单校验 ───────────────────────────────────────────────────────────────

/** table 白名单：仅允许事实写路径 */
const UNDO_TABLE_WHITELIST = new Set<string>(["fact_invoices", "fact_metrics"]);

/** keyColumn 合法标识符格式（防 SQL 注入面）*/
const KEY_COLUMN_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 校验 undo ops：
 * 1. table 必须在白名单内
 * 2. keyColumn 必须是合法 SQL 标识符（防注入）
 * 在 recordAudit（写入时）和 undoAuditEntry（执行时）两处调用，双重防御。
 */
export function validateUndoOps(ops: UndoOp[]): void {
  for (const op of ops) {
    if (!UNDO_TABLE_WHITELIST.has(op.table)) {
      throw new Error(
        `audit-store 白名单校验失败：表 "${op.table}" 不在允许的撤销白名单内（仅允许 fact_invoices、fact_metrics）`
      );
    }
    if (!KEY_COLUMN_PATTERN.test(op.keyColumn)) {
      throw new Error(
        `audit-store keyColumn 格式非法："${op.keyColumn}" 不符合标识符规范 [A-Za-z_][A-Za-z0-9_]*（防 SQL 注入）`
      );
    }
  }
}

// ─── recordAudit ──────────────────────────────────────────────────────────────

/**
 * 写入一条审计记录。
 * 若含 undo 载荷，先校验 table 白名单，非白名单表直接抛错。
 * 返回新插入行的 id。
 */
export function recordAudit(
  db: DatabaseSync,
  input: RecordAuditInput
): number {
  const { eventType, payload, conversationId, traceId, toolName, undo } = input;

  // 白名单校验
  if (undo && undo.length > 0) {
    validateUndoOps(undo);
  }

  const undoJson = undo && undo.length > 0 ? JSON.stringify(undo) : null;
  const result = db.prepare(`
    INSERT INTO audit_logs (event_type, payload, conversation_id, trace_id, tool_name, undo)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    eventType,
    JSON.stringify(payload),
    conversationId ?? null,
    traceId ?? null,
    toolName ?? null,
    undoJson
  );

  return Number(result.lastInsertRowid);
}

// ─── undoAuditEntry ───────────────────────────────────────────────────────────

export type UndoResult = {
  undone: true;
  auditId: number;
  ops: UndoOp[];
};

/**
 * 执行撤销：
 * 1. 校验记录存在、未撤销、有 undo 载荷
 * 2. 单事务内执行全部逆操作
 * 3. 置 undone_at
 * 4. 追记 audit_undo 事件（撤销本身留痕）
 */
export function undoAuditEntry(id: number, db: DatabaseSync = getDb()): UndoResult {
  type Row = {
    id: number;
    event_type: string;
    undo: string | null;
    undone_at: string | null;
  };
  const row = db.prepare("SELECT id, event_type, undo, undone_at FROM audit_logs WHERE id = ?").get(id) as Row | undefined;

  if (!row) {
    throw new Error(`撤销失败：audit_logs 中不存在 id=${id} 的记录`);
  }
  if (row.undone_at != null) {
    throw new Error(`已撤销：id=${id} 的审计记录已于 ${row.undone_at} 撤销，不可重复撤销`);
  }
  if (!row.undo) {
    throw new Error(`不可撤销：id=${id} 的审计记录（${row.event_type}）没有撤销载荷，此操作不支持行级撤销`);
  }

  const ops = JSON.parse(row.undo) as UndoOp[];

  // 执行时二次校验（防未来任何绕过 recordAudit 直写 undo JSON 的路径）
  validateUndoOps(ops);

  // 单事务执行所有逆操作
  db.exec("BEGIN");
  try {
    for (const op of ops) {
      if (op.op === "delete_rows") {
        if (op.keys.length === 0) continue;
        const placeholders = op.keys.map(() => "?").join(", ");
        db.prepare(
          `DELETE FROM ${op.table} WHERE ${op.keyColumn} IN (${placeholders})`
        ).run(...op.keys);
      } else if (op.op === "restore_rows") {
        for (const rowData of op.rows) {
          const cols = Object.keys(rowData);
          if (cols.length === 0) continue;
          const colList = cols.join(", ");
          const placeholders = cols.map(() => "?").join(", ");
          const values = cols.map((c) => rowData[c] as string | number | null);
          db.prepare(
            `INSERT OR REPLACE INTO ${op.table} (${colList}) VALUES (${placeholders})`
          ).run(...values);
        }
      }
    }

    // 置 undone_at（守卫：AND undone_at IS NULL 防止并发双撤销——changes=0 说明已被撤销）
    const updResult = db.prepare(
      "UPDATE audit_logs SET undone_at = datetime('now') WHERE id = ? AND undone_at IS NULL"
    ).run(id) as { changes: number };
    if (Number(updResult.changes) === 0) {
      throw new Error(`已撤销：id=${id} 的审计记录已于 ${new Date().toISOString()} 前被撤销，不可重复撤销`);
    }

    // 撤销本身留痕
    db.prepare(`
      INSERT INTO audit_logs (event_type, payload)
      VALUES ('audit_undo', ?)
    `).run(JSON.stringify({ undoneId: id, eventType: row.event_type }));

    db.exec("COMMIT");
  } catch (err) {
    try { db.exec("ROLLBACK"); } catch { /* ignore rollback error */ }
    throw err;
  }

  return { undone: true, auditId: id, ops };
}

// ─── listAuditEntries ─────────────────────────────────────────────────────────

export type ListAuditOptions = {
  limit?: number;
  undoableOnly?: boolean;
};

/**
 * 倒序列出审计条目（最新在前），含 undoable 派生字段。
 */
export function listAuditEntries(
  opts: ListAuditOptions = {},
  db: DatabaseSync = getDb()
): AuditEntry[] {
  const { limit = 50, undoableOnly = false } = opts;

  const where = undoableOnly ? "WHERE undo IS NOT NULL AND undone_at IS NULL" : "";
  type DbRow = {
    id: number;
    event_type: string;
    payload: string;
    conversation_id: number | null;
    trace_id: string | null;
    tool_name: string | null;
    undo: string | null;
    undone_at: string | null;
    created_at: string;
  };

  const rows = db.prepare(`
    SELECT id, event_type, payload, conversation_id, trace_id, tool_name, undo, undone_at, created_at
    FROM audit_logs
    ${where}
    ORDER BY id DESC
    LIMIT ?
  `).all(limit) as DbRow[];

  return rows.map((r) => ({
    id: r.id,
    eventType: r.event_type,
    payload: (() => { try { return JSON.parse(r.payload) as unknown; } catch { return r.payload; } })(),
    conversationId: r.conversation_id,
    traceId: r.trace_id,
    toolName: r.tool_name,
    undoable: r.undo != null && r.undone_at == null,
    undoneAt: r.undone_at,
    createdAt: r.created_at,
  }));
}
