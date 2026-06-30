import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, unlinkSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { getDatabasePath, getConversationFilesDir } from "@/lib/runtime/paths";
import { isFeatureEventName } from "@/lib/telemetry/feature-events";
import { initializeSchema } from "./schema";
import { runMigrations, LATEST_VERSION, getUserVersion } from "./migrations";

export * from "./schema";
export { MIGRATIONS, LATEST_VERSION, getUserVersion } from "./migrations";

export function openFinanceDatabase(dbPath = getDatabasePath()) {
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/**
 * 打开并校验数据库完整性。财务数据带病运行比报错更糟:
 * 损坏立即显式失败,并指出最近备份的位置。
 */
export function openAndVerifyDatabase(dbPath = getDatabasePath()): DatabaseSync {
  const backupsDir = path.join(path.dirname(dbPath), "backups");
  try {
    const db = openFinanceDatabase(dbPath);
    const row = db.prepare("PRAGMA quick_check").get() as { quick_check: string } | undefined;
    if (row?.quick_check !== "ok") {
      db.close();
      throw new Error(`完整性校验未通过:${row?.quick_check ?? "无返回"}`);
    }
    return db;
  } catch (error) {
    throw new Error(
      `数据库文件可能已损坏:${dbPath}(${error instanceof Error ? error.message : String(error)})。` +
        `请勿继续操作,可从最近备份恢复:${backupsDir}`
    );
  }
}

/**
 * 在线备份(VACUUM INTO),保留最近 BACKUP_KEEP 份。
 * 备份是兜底动作:失败只告警,不阻断主流程。
 */
const BACKUP_KEEP = 7;

export function backupDatabase(db: DatabaseSync, dbPath: string): string | null {
  try {
    const backupsDir = path.join(path.dirname(dbPath), "backups");
    mkdirSync(backupsDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 17);
    let target = path.join(backupsDir, `finance-agent-${stamp}.db`);
    let suffix = 0;
    while (existsSync(target)) {
      suffix += 1;
      target = path.join(backupsDir, `finance-agent-${stamp}-${suffix}.db`);
    }
    db.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);

    const backups = readdirSync(backupsDir)
      .filter((f) => f.startsWith("finance-agent-") && f.endsWith(".db"))
      .sort()
      .reverse();
    for (const stale of backups.slice(BACKUP_KEEP)) {
      rmSync(path.join(backupsDir, stale));
    }
    return target;
  } catch (error) {
    console.error(`[db] 自动备份失败(不影响使用,但请尽快人工备份数据库文件):${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

let _db: DatabaseSync | null = null;
let _dbPath: string | null = null;

export function getDb(): DatabaseSync {
  const currentPath = getDatabasePath();
  if (!_db || _dbPath !== currentPath) {
    _db?.close();
    const db = openAndVerifyDatabase(currentPath);
    _db = initializeFinanceDatabase(db, currentPath);
    _dbPath = currentPath;
    // 启动兜底备份既不该挡首个查询,也不该每次冷启都全量 VACUUM:挪到本 tick 之后异步做,
    // 且限频(最近一次 < BACKUP_MIN_INTERVAL_MS 就跳过)。这同时消解了"多个 Next bundle 各自
    // 实例化单例 → 一次启动刷多份全量备份"。关键写操作(如工资确认)仍走各自的显式
    // backupDatabase 无条件备份(见 tools/finance/payroll),数据安全不受影响。
    scheduleStartupBackup(db, currentPath);
  }
  return _db;
}

const BACKUP_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;

function scheduleStartupBackup(db: DatabaseSync, dbPath: string) {
  if (!shouldBackupNow(dbPath)) return;
  setImmediate(() => {
    try {
      backupDatabase(db, dbPath);
    } catch {
      // backupDatabase 自身已吞错并告警
    }
  });
}

function shouldBackupNow(dbPath: string): boolean {
  try {
    const backupsDir = path.join(path.dirname(dbPath), "backups");
    if (!existsSync(backupsDir)) return true;
    const newest = readdirSync(backupsDir)
      .filter((f) => f.startsWith("finance-agent-") && f.endsWith(".db"))
      .map((f) => statSync(path.join(backupsDir, f)).mtimeMs)
      .sort((a, b) => b - a)[0];
    return newest === undefined || Date.now() - newest >= BACKUP_MIN_INTERVAL_MS;
  } catch {
    return true; // 判断失败就保守备份
  }
}

export function initializeFinanceDatabase(db = openFinanceDatabase(), dbPath?: string) {
  initializeSchema(db);
  // 迁移系统:initializeSchema 已确保 baseline 表存在;
  // 若 user_version=0(全新库或老库),runMigrations 会把它升到最新 version。
  // dbPath 仅在需要备份时使用;未提供时跳过路径解析。
  const resolvedPath = dbPath ?? getDatabasePath();
  runMigrations(db, resolvedPath, backupDatabase);
  return db;
}

export function insertAuditLog(eventType: string, payload: unknown, db: DatabaseSync = getDb()) {
  const statement = db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)");
  const result = statement.run(eventType, JSON.stringify(payload));
  return Number(result.lastInsertRowid);
}

// ─── 数据导出 / 恢复 ──────────────────────────────────────────────────────────

/**
 * 导出当前数据库为干净、完整的单文件 .db(VACUUM INTO)。
 *
 * 红线约束:
 * - 红线 7:只写本地文件路径,零网络。
 * - 红线 8:落 audit_logs。
 *
 * @param destPath  目标文件绝对路径(必须是绝对路径)
 * @returns         { path: destPath, bytes: 文件大小 }
 */
export function exportDatabase(destPath: string): { path: string; bytes: number } {
  if (!path.isAbsolute(destPath)) {
    throw new Error(`exportDatabase: destPath 必须是绝对路径,收到: ${destPath}`);
  }

  const db = getDb();
  // WAL checkpoint:确保所有 WAL 帧刷入主库文件,VACUUM INTO 产出完整一致快照
  db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  db.exec(`VACUUM INTO '${destPath.replaceAll("'", "''")}'`);

  const bytes = statSync(destPath).size;

  // 落审计(红线 8)
  insertAuditLog("data_export", { destPath, bytes, exportedAt: new Date().toISOString() });

  return { path: destPath, bytes };
}

/**
 * 从导出文件恢复数据库。
 *
 * 步骤:
 * 1. 校验 srcPath:合法 SQLite + 含核心表 + user_version ≤ LATEST_VERSION
 * 2. backupDatabase(当前库,留退路)
 * 3. 关闭当前全局连接 → 原子覆盖(tmp copy + rename)
 * 4. 重开连接 + runMigrations(把恢复进来的老库升到当前版本)
 *
 * 红线约束:
 * - 红线 5:高风险写操作(若经 agent 工具暴露需标 riskLevel:"high";此 lib 层提供逻辑)。
 * - 红线 7:只读本地文件,零网络。
 * - 红线 8:落 audit_logs(恢复成功 + 校验失败都记)。
 *
 * @param srcPath  源文件绝对路径(必须是绝对路径)
 * @returns        { restored: true, backupOf: 备份路径 }
 */
export function restoreDatabase(srcPath: string): { restored: true; backupOf: string | null } {
  if (!path.isAbsolute(srcPath)) {
    throw new Error(`restoreDatabase: srcPath 必须是绝对路径,收到: ${srcPath}`);
  }
  if (!existsSync(srcPath)) {
    throw new Error(`restoreDatabase: 源文件不存在: ${srcPath}`);
  }

  // ── 步骤 1:校验 srcPath ────────────────────────────────────────────────
  let srcDb: DatabaseSync;
  try {
    srcDb = new DatabaseSync(srcPath, { open: true });
  } catch (err) {
    throw new Error(`restoreDatabase: 无法打开源文件(非合法 SQLite): ${err instanceof Error ? err.message : String(err)}`);
  }

  try {
    // 校验核心表存在
    const REQUIRED_TABLES = ["app_settings", "audit_logs"];
    for (const table of REQUIRED_TABLES) {
      const row = srcDb.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name=?"
      ).get(table);
      if (!row) {
        throw new Error(`restoreDatabase: 源库缺少核心表 ${table},不是合法的 finance-agent 库`);
      }
    }

    // 校验 user_version ≤ LATEST_VERSION(拒绝来自未来版本的库)
    const srcVersion = getUserVersion(srcDb);
    if (srcVersion > LATEST_VERSION) {
      throw new Error(
        `restoreDatabase: 源库 user_version=${srcVersion} 高于当前代码最新版本 ${LATEST_VERSION},` +
        `请升级应用后再恢复`
      );
    }
  } catch (err) {
    srcDb.close();
    // 校验失败落审计(红线 8),然后抛出——不破坏当前库
    try {
      insertAuditLog("data_restore_failed", {
        srcPath,
        reason: err instanceof Error ? err.message : String(err),
        attemptedAt: new Date().toISOString(),
      });
    } catch {
      // audit 失败不影响主流程抛出
    }
    throw err;
  }
  srcDb.close();

  // ── 步骤 2:备份当前库 ──────────────────────────────────────────────────
  const currentPath = getDatabasePath();
  const currentDb = getDb();
  const backupPath = backupDatabase(currentDb, currentPath);

  // ── 步骤 3:关闭当前连接 → 原子覆盖(tmp copy + rename) ────────────────
  // 关闭全局单例连接
  _db?.close();
  _db = null;
  _dbPath = null;

  const tmpPath = path.join(os.tmpdir(), `finance-agent-restore-${process.pid}-${Date.now()}.db`);
  try {
    copyFileSync(srcPath, tmpPath);
    renameSync(tmpPath, currentPath);
  } catch (err) {
    // 覆盖失败:tmp 文件可能残留,但当前库未被破坏(rename 是原子的)
    try { rmSync(tmpPath, { force: true }); } catch { /* 忽略 */ }
    throw new Error(`restoreDatabase: 覆盖数据库文件失败: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ── 步骤 4:重开连接 + runMigrations ────────────────────────────────────
  const restoredDb = openAndVerifyDatabase(currentPath);
  _db = initializeFinanceDatabase(restoredDb, currentPath);
  _dbPath = currentPath;

  // 落审计(红线 8)
  insertAuditLog("data_restore", {
    srcPath,
    backupPath,
    restoredAt: new Date().toISOString(),
  });

  return { restored: true, backupOf: backupPath };
}

export type StoredChatMessage = {
  id: number;
  conversationId: number;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
  agentEvents?: StoredAgentEvent[];
};

export type StoredAgentEvent = {
  id: number;
  messageId: number;
  eventType: string;
  payload: unknown;
  createdAt: string;
  traceId: string | null;
};

export type StoredChatConversation = {
  id: number;
  title: string;
  claudeSessionId: string | null;
  claudeSessionUpdatedAt: string | null;
  createdAt: string;
  updatedAt: string;
  messages: StoredChatMessage[];
};

export type StoredChatAttachment = {
  id: string;
  messageId: number;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  storagePath: string;
  role: "user" | "assistant";
  createdAt: string;
};

type AttachmentRow = {
  id: string;
  message_id: number;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  storage_path: string;
  role: "user" | "assistant";
  created_at: string;
};

type ConversationRow = {
  id: number;
  title: string;
  claude_session_id: string | null;
  claude_session_updated_at: string | null;
  created_at: string;
  updated_at: string;
  pinned: number;
};

type MessageRow = {
  id: number;
  conversation_id: number;
  role: "user" | "assistant";
  content: string;
  created_at: string;
};

type AgentEventRow = {
  id: number;
  message_id: number;
  event_type: string;
  payload: string;
  created_at: string;
  trace_id: string | null;
};

export function createChatConversation(title: string) {
  const db = getDb();
  const statement = db.prepare("INSERT INTO chat_conversations (title) VALUES (?)");
  const result = statement.run(title);
  return Number(result.lastInsertRowid);
}

export function insertChatMessage(
  conversationId: number,
  role: StoredChatMessage["role"],
  content: string
) {
  const db = getDb();
  const statement = db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, ?, ?)");
  const result = statement.run(conversationId, role, content);
  db.prepare("UPDATE chat_conversations SET updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(conversationId);
  return Number(result.lastInsertRowid);
}

export function listAgentEventsForMessage(messageId: number): StoredAgentEvent[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, message_id, event_type, payload, created_at, trace_id FROM chat_agent_events WHERE message_id = ? ORDER BY id ASC")
    .all(messageId) as AgentEventRow[];
  return rows.map(mapAgentEventRow);
}

export function listChatMessages(conversationId: number) {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, conversation_id, role, content, created_at FROM chat_messages WHERE conversation_id = ? ORDER BY id ASC")
    .all(conversationId) as MessageRow[];

  if (rows.length === 0) return [];

  const msgIds = rows.map((r) => r.id);
  const evtPlaceholders = msgIds.map(() => "?").join(",");
  const evtRows = db
    .prepare(
      `SELECT id, message_id, event_type, payload, created_at, trace_id FROM chat_agent_events WHERE message_id IN (${evtPlaceholders}) ORDER BY id ASC`
    )
    .all(...msgIds) as AgentEventRow[];

  const eventsByMsgId = new Map<number, StoredAgentEvent[]>();
  for (const evt of evtRows) {
    const list = eventsByMsgId.get(evt.message_id) ?? [];
    list.push(mapAgentEventRow(evt));
    eventsByMsgId.set(evt.message_id, list);
  }

  return rows.map((row) => mapMessageRow(row, eventsByMsgId.get(row.id) ?? []));
}

export function listRecentChatConversations(limit = 10) {
  const db = getDb();
  const convRows = db
    .prepare(
      "SELECT id, title, claude_session_id, claude_session_updated_at, created_at, updated_at, pinned FROM chat_conversations ORDER BY updated_at DESC, id DESC LIMIT ?"
    )
    .all(limit) as ConversationRow[];

  if (convRows.length === 0) return [];

  const convIds = convRows.map((r) => r.id);
  const placeholders = convIds.map(() => "?").join(",");

  const msgRows = db
    .prepare(
      `SELECT id, conversation_id, role, content, created_at FROM chat_messages WHERE conversation_id IN (${placeholders}) ORDER BY id ASC`
    )
    .all(...convIds) as MessageRow[];

  const msgIds = msgRows.map((r) => r.id);
  let eventsByMsgId = new Map<number, StoredAgentEvent[]>();

  if (msgIds.length > 0) {
    const evtPlaceholders = msgIds.map(() => "?").join(",");
    const evtRows = db
      .prepare(
        `SELECT id, message_id, event_type, payload, created_at, trace_id FROM chat_agent_events WHERE message_id IN (${evtPlaceholders}) ORDER BY id ASC`
      )
      .all(...msgIds) as AgentEventRow[];
    for (const evt of evtRows) {
      const list = eventsByMsgId.get(evt.message_id) ?? [];
      list.push(mapAgentEventRow(evt));
      eventsByMsgId.set(evt.message_id, list);
    }
  }

  const msgsByConvId = new Map<number, StoredChatMessage[]>();
  for (const msg of msgRows) {
    const list = msgsByConvId.get(msg.conversation_id) ?? [];
    list.push(mapMessageRow(msg, eventsByMsgId.get(msg.id) ?? []));
    msgsByConvId.set(msg.conversation_id, list);
  }

  return convRows.map((row) => mapConversationRow(row, msgsByConvId.get(row.id) ?? []));
}

export function countChatConversations() {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS count FROM chat_conversations").get() as { count: number };
  return row.count;
}

export type ConversationSummary = {
  id: number;
  title: string;
  updatedAt: string;
  pinned: boolean;
};

export function listRecentConversationSummaries(limit = 5, offset = 0): ConversationSummary[] {
  const db = getDb();
  const rows = db
    .prepare(
      "SELECT id, title, updated_at, pinned FROM chat_conversations ORDER BY pinned DESC, updated_at DESC, id DESC LIMIT ? OFFSET ?"
    )
    .all(limit, offset) as Array<{ id: number; title: string; updated_at: string; pinned: number }>;
  return rows.map((row) => ({ id: row.id, title: row.title, updatedAt: row.updated_at, pinned: row.pinned === 1 }));
}

export function updateChatConversationTitle(conversationId: number, title: string) {
  const db = getDb();
  db.prepare("UPDATE chat_conversations SET title = ? WHERE id = ?").run(title, conversationId);
}

export function setConversationPinned(conversationId: number, pinned: boolean) {
  const db = getDb();
  db.prepare("UPDATE chat_conversations SET pinned = ? WHERE id = ?").run(pinned ? 1 : 0, conversationId);
}

export function deleteChatConversation(conversationId: number) {
  const db = getDb();
  // FK cascades clean up chat_messages → chat_attachments, chat_agent_events
  db.prepare("DELETE FROM chat_conversations WHERE id = ?").run(conversationId);
  // 连带删会话磁盘目录(上传 + 生成文件),否则删了会话、文件仍滞留 = 存储泄漏。
  try {
    rmSync(getConversationFilesDir(conversationId), { recursive: true, force: true });
  } catch { /* 目录不存在/占用:忽略,DB 行已删 */ }
}

export function getChatConversation(conversationId: number) {
  const db = getDb();
  const row = db
    .prepare("SELECT id, title, claude_session_id, claude_session_updated_at, created_at, updated_at, pinned FROM chat_conversations WHERE id = ?")
    .get(conversationId) as ConversationRow | undefined;
  return row ? mapConversationRow(row, listChatMessages(row.id)) : null;
}

export function setChatConversationClaudeSessionId(conversationId: number, claudeSessionId: string) {
  const db = getDb();
  db.prepare(
    "UPDATE chat_conversations SET claude_session_id = ?, claude_session_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(claudeSessionId, conversationId);
}

export function insertChatAttachment(attachment: Omit<StoredChatAttachment, "createdAt">) {
  const db = getDb();
  db.prepare(
    "INSERT INTO chat_attachments (id, message_id, file_name, mime_type, size_bytes, storage_path, role) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(attachment.id, attachment.messageId, attachment.fileName, attachment.mimeType, attachment.sizeBytes, attachment.storagePath, attachment.role);
}

export function getMessageAttachments(messageId: number): StoredChatAttachment[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, message_id, file_name, mime_type, size_bytes, storage_path, role, created_at FROM chat_attachments WHERE message_id = ? ORDER BY id ASC")
    .all(messageId) as AttachmentRow[];
  return rows.map(mapAttachmentRow);
}

export function getConversationAttachments(conversationId: number): StoredChatAttachment[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT a.id, a.message_id, a.file_name, a.mime_type, a.size_bytes, a.storage_path, a.role, a.created_at
       FROM chat_attachments a
       JOIN chat_messages m ON a.message_id = m.id
       WHERE m.conversation_id = ?
       ORDER BY a.id ASC`
    )
    .all(conversationId) as AttachmentRow[];
  return rows.map(mapAttachmentRow);
}

export function insertChatAgentEvent(messageId: number, eventType: string, payload: unknown, traceId?: string | null) {
  const db = getDb();
  const result = db
    .prepare("INSERT INTO chat_agent_events (message_id, event_type, payload, trace_id) VALUES (?, ?, ?, ?)")
    .run(messageId, eventType, JSON.stringify(payload), traceId ?? null);
  return Number(result.lastInsertRowid);
}

function mapAttachmentRow(row: AttachmentRow): StoredChatAttachment {
  return {
    id: row.id,
    messageId: row.message_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    role: row.role,
    createdAt: row.created_at
  };
}

function mapConversationRow(row: ConversationRow, messages: StoredChatMessage[]): StoredChatConversation {
  return {
    id: row.id,
    title: row.title,
    claudeSessionId: row.claude_session_id,
    claudeSessionUpdatedAt: row.claude_session_updated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    messages
  };
}

function mapMessageRow(row: MessageRow, agentEvents: StoredAgentEvent[] = []): StoredChatMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    createdAt: row.created_at,
    agentEvents
  };
}

function mapAgentEventRow(row: AgentEventRow): StoredAgentEvent {
  return {
    id: row.id,
    messageId: row.message_id,
    eventType: row.event_type,
    payload: safeParseJson(row.payload),
    createdAt: row.created_at,
    traceId: row.trace_id ?? null,
  };
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export type KnowledgeDocumentRow = {
  id: number; title: string; file_name: string; mime_type: string;
  category: string; size_bytes: number; chunk_count: number;
  content_hash: string; storage_path: string; created_at: string; updated_at: string;
  last_hit_at: string | null; hit_count: number; archived: number;
  // P1 合同归纳:结构化 metadata + 确认状态
  metadata: string | null; meta_status: string;
};

/** 命中埋点:检索/读取真正返回某文档时调用,治理旧数据的使用信号 */
export function markKnowledgeHits(docIds: number[], db = getDb()): void {
  if (docIds.length === 0) return;
  const placeholders = docIds.map(() => "?").join(",");
  db.prepare(
    `UPDATE knowledge_documents SET hit_count = hit_count + 1, last_hit_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`
  ).run(...docIds);
}

export function setKnowledgeArchived(id: number, archived: boolean, db = getDb()): void {
  db.prepare("UPDATE knowledge_documents SET archived = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?").run(
    archived ? 1 : 0,
    id
  );
}

/** P1 合同归纳:写入提炼 metadata（草稿）；status 为 'draft'|'confirmed'|'none' */
export function setKnowledgeDocumentMeta(
  id: number,
  metadata: Record<string, unknown> | null,
  metaStatus: "none" | "draft" | "confirmed",
  db = getDb()
): void {
  db.prepare(
    "UPDATE knowledge_documents SET metadata = ?, meta_status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
  ).run(metadata ? JSON.stringify(metadata) : null, metaStatus, id);
}
export function updateKnowledgeDocumentMetadata(
  id: number,
  doc: Pick<KnowledgeDocumentRow, "title" | "file_name" | "mime_type" | "category" | "size_bytes">
) {
  const db = getDb();
  db.prepare(`
    UPDATE knowledge_documents
    SET title = ?, file_name = ?, mime_type = ?, category = ?, size_bytes = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(doc.title, doc.file_name, doc.mime_type, doc.category, doc.size_bytes, id);
}

export function deleteKnowledgeDocument(id: number) {
  const db = getDb();
  db.prepare("DELETE FROM knowledge_documents WHERE id = ?").run(id);
}

export function listKnowledgeDocuments(category?: string): KnowledgeDocumentRow[] {
  const db = getDb();
  if (category) return db.prepare("SELECT * FROM knowledge_documents WHERE category=? ORDER BY updated_at DESC").all(category) as KnowledgeDocumentRow[];
  return db.prepare("SELECT * FROM knowledge_documents ORDER BY updated_at DESC").all() as KnowledgeDocumentRow[];
}

/** P1 合同归纳:取「已确认且有 metadata」的未归档文档(供现金义务派生);metadata 为原始 JSON 串,调用方解析。 */
export function listConfirmedMetaDocRows(db = getDb()): Array<{ id: number; file_name: string; metadata: string; meta_status: string }> {
  return db.prepare(
    "SELECT id, file_name, metadata, meta_status FROM knowledge_documents WHERE meta_status = 'confirmed' AND metadata IS NOT NULL AND archived = 0"
  ).all() as Array<{ id: number; file_name: string; metadata: string; meta_status: string }>;
}

/** 检索可见的文档(排除已归档),供 ripgrep / 命名镜像使用 */
export function listActiveKnowledgeDocuments(db = getDb()): KnowledgeDocumentRow[] {
  return db.prepare("SELECT * FROM knowledge_documents WHERE archived = 0 ORDER BY updated_at DESC").all() as KnowledgeDocumentRow[];
}

export function getKnowledgeDocumentByFileName(fileName: string): KnowledgeDocumentRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM knowledge_documents WHERE file_name=?").get(fileName) as KnowledgeDocumentRow | undefined;
}

export function getKnowledgeDocumentByHash(hash: string): KnowledgeDocumentRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM knowledge_documents WHERE content_hash=?").get(hash) as KnowledgeDocumentRow | undefined;
}

export function getKnowledgeDocumentById(id: number): KnowledgeDocumentRow | undefined {
  const db = getDb();
  return db.prepare("SELECT * FROM knowledge_documents WHERE id = ?").get(id) as KnowledgeDocumentRow | undefined;
}

export function insertKnowledgeDocument(
  doc: Omit<KnowledgeDocumentRow, "id" | "created_at" | "updated_at" | "storage_path" | "last_hit_at" | "hit_count" | "archived" | "metadata" | "meta_status"> & { storage_path?: string },
  db = getDb()
) {
  const r = db.prepare(
    "INSERT INTO knowledge_documents (title,file_name,mime_type,category,size_bytes,chunk_count,content_hash,storage_path) VALUES (?,?,?,?,?,?,?,?)"
  ).run(doc.title, doc.file_name, doc.mime_type, doc.category, doc.size_bytes, doc.chunk_count, doc.content_hash, doc.storage_path ?? "");
  return Number(r.lastInsertRowid);
}

export function getAppSetting(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare("SELECT value FROM app_settings WHERE key=?").get(key) as { value: string } | undefined;
  return row?.value;
}

export function setAppSetting(key: string, value: string): void {
  const db = getDb();
  db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
}

export function deleteAppSetting(key: string): void {
  const db = getDb();
  db.prepare("DELETE FROM app_settings WHERE key=?").run(key);
}


export function countConversationsCompletedToday(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM chat_conversations WHERE updated_at >= datetime('now','start of day')"
  ).get() as { cnt: number };
  return row.cnt;
}

export function countToolCallsToday(): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM chat_agent_events WHERE event_type = 'tool_use' AND created_at >= datetime('now','start of day')"
  ).get() as { cnt: number };
  return row.cnt;
}

export function countKnowledgeDocs(): number {
  const db = getDb();
  const row = db.prepare("SELECT COUNT(*) AS cnt FROM knowledge_documents").get() as { cnt: number };
  return row.cnt;
}

export function aggregateKnowledgeByType(): Array<{ type: string; count: number }> {
  const db = getDb();
  return db.prepare(
    "SELECT mime_type AS type, COUNT(*) AS count FROM knowledge_documents GROUP BY mime_type ORDER BY count DESC"
  ).all() as Array<{ type: string; count: number }>;
}

export function getLatestKnowledgeIngestedAt(): number | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT strftime('%s', updated_at) * 1000 AS ts FROM knowledge_documents ORDER BY updated_at DESC LIMIT 1"
  ).get() as { ts: number } | undefined;
  return row ? Number(row.ts) : null;
}

export function getTopToolsLast24h(limit = 5): Array<{ name: string; count: number }> {
  const db = getDb();
  return db.prepare(`
    SELECT json_extract(payload, '$.name') AS name, COUNT(*) AS count
    FROM chat_agent_events
    WHERE event_type = 'tool_use'
      AND created_at >= datetime('now', '-24 hours')
    GROUP BY name
    ORDER BY count DESC
    LIMIT ?
  `).all(limit) as Array<{ name: string; count: number }>;
}

export function getAvgTurnsPerConv(): number {
  const db = getDb();
  const row = db.prepare(`
    SELECT AVG(cnt) AS avg_turns
    FROM (
      SELECT conversation_id, COUNT(*) AS cnt
      FROM chat_messages
      GROUP BY conversation_id
    )
  `).get() as { avg_turns: number | null };
  return row.avg_turns ?? 0;
}

export function getRecentConversationsWithStatus(limit = 10): Array<{
  id: number;
  title: string;
  updatedAt: string;
}> {
  const db = getDb();
  return (db.prepare(
    "SELECT id, title, updated_at FROM chat_conversations ORDER BY updated_at DESC LIMIT ?"
  ).all(limit) as Array<{ id: number; title: string; updated_at: string }>)
    .map((r) => ({ id: r.id, title: r.title, updatedAt: r.updated_at }));
}

export function getMessageCountForConversation(conversationId: number): number {
  const db = getDb();
  const row = db.prepare(
    "SELECT COUNT(*) AS cnt FROM chat_messages WHERE conversation_id = ?"
  ).get(conversationId) as { cnt: number };
  return row.cnt;
}

export function getLatestKnowledgeIngestion(): {
  title: string;
  fileName: string;
  category: string;
  ingestedAt: string;
} | null {
  const db = getDb();
  const row = db.prepare(
    "SELECT title, file_name, category, created_at FROM knowledge_documents ORDER BY created_at DESC LIMIT 1"
  ).get() as {
    title: string;
    file_name: string;
    category: string;
    created_at: string;
  } | undefined;
  if (!row) return null;
  return {
    title: row.title,
    fileName: row.file_name,
    category: row.category,
    ingestedAt: row.created_at,
  };
}

// ─── Feedback ─────────────────────────────────────────────────────

export type StoredChatFeedback = {
  id: number;
  messageId: number;
  conversationId: number;
  traceId: string | null;
  rating: "up" | "down";
  reason: string | null;
  createdAt: string;
  updatedAt: string;
};

export function upsertChatFeedback(params: {
  messageId: number;
  conversationId: number;
  traceId: string | null;
  rating: "up" | "down";
  reason?: string | null;
}): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO chat_feedback (message_id, conversation_id, trace_id, rating, reason)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(message_id) DO UPDATE SET
      rating = excluded.rating,
      reason = excluded.reason,
      trace_id = COALESCE(excluded.trace_id, chat_feedback.trace_id),
      updated_at = CURRENT_TIMESTAMP
  `).run(params.messageId, params.conversationId, params.traceId ?? null, params.rating, params.reason ?? null);
}

/** 匿名功能触达计数(红线 7:仅事件名+计数;白名单外丢弃,杜绝事件名夹带 PII)。reporter 投影成 schemaVersion 4 上报。 */
export function recordFeatureEvent(name: string): void {
  if (!isFeatureEventName(name)) return;
  const now = Date.now();
  getDb().prepare(`
    INSERT INTO feature_events (name, count, first_at, last_at) VALUES (?, 1, ?, ?)
    ON CONFLICT(name) DO UPDATE SET count = count + 1, last_at = excluded.last_at
  `).run(name, now, now);
}

/** 取全部功能触达计数(供遥测 reporter 投影成 v4 envelope)。 */
export function getFeatureEventRows(): Array<Record<string, unknown>> {
  return getDb().prepare(
    "SELECT name, count, first_at, last_at FROM feature_events ORDER BY name ASC"
  ).all() as Array<Record<string, unknown>>;
}

export function listFeedbackForConversation(conversationId: number): StoredChatFeedback[] {
  const db = getDb();
  return (db.prepare(
    "SELECT id, message_id, conversation_id, trace_id, rating, reason, created_at, updated_at FROM chat_feedback WHERE conversation_id = ? ORDER BY id ASC"
  ).all(conversationId) as Array<Record<string, unknown>>).map(mapFeedbackRow);
}

export function getFeedbackStats(days: number): { rated: number; up: number; down: number } {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) AS rated,
      SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down
    FROM chat_feedback
    WHERE updated_at >= datetime('now', '-' || ? || ' days')
  `).get(days) as { rated: number; up: number; down: number };
  return { rated: row.rated ?? 0, up: row.up ?? 0, down: row.down ?? 0 };
}

export function listRecentNegativeReasons(days: number, limit: number): string[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT reason
    FROM chat_feedback
    WHERE rating = 'down'
      AND reason IS NOT NULL
      AND reason != ''
      AND updated_at >= datetime('now', '-' || ? || ' days')
    ORDER BY updated_at DESC
    LIMIT ?
  `).all(days, limit) as Array<{ reason: string }>;
  return rows.map((r) => r.reason);
}

function mapFeedbackRow(row: Record<string, unknown>): StoredChatFeedback {
  return {
    id: row.id as number,
    messageId: row.message_id as number,
    conversationId: row.conversation_id as number,
    traceId: (row.trace_id as string | null) ?? null,
    rating: row.rating as "up" | "down",
    reason: (row.reason as string | null) ?? null,
    createdAt: row.created_at as string,
    updatedAt: row.updated_at as string,
  };
}

// ─── 统一文件库 ────────────────────────────────────────────────────────────────

export type UnifiedFileEntry = {
  id: string;
  kind: "upload" | "generated" | "knowledge" | "library";
  name: string;
  mime: string;
  sizeBytes: number;
  /** 来源:对话标题 / 知识类目 / "已保留文件库" */
  source: string;
  /** 会话 ID(上传/生成类用) */
  conversationId: number | null;
  /** storage_path(相对路径,对话类) 或 绝对路径(知识/文件库) */
  storagePath: string;
  createdAt: string;
  kept: boolean;
};

export type ListFilesOptions = {
  kind?: "upload" | "generated" | "knowledge" | "library";
  q?: string;
  sort?: "name" | "size" | "date";
};

/**
 * 统一文件索引:UNION 三类文件(上传/生成/知识 + 已解耦库文件)。
 * - chat_attachments role='user'  → upload
 * - chat_attachments role='assistant' → generated
 * - knowledge_documents archived=0  → knowledge
 * - library_files                 → library
 */
export function listAllFiles(opts: ListFilesOptions = {}, db = getDb()): UnifiedFileEntry[] {
  const { kind, q, sort = "date" } = opts;

  // 附件查询(上传 + 生成,关联对话标题)
  const attachRows = db.prepare(`
    SELECT
      a.id,
      a.role,
      a.file_name,
      a.mime_type,
      a.size_bytes,
      COALESCE(c.title, '') AS conv_title,
      c.id AS conversation_id,
      a.storage_path,
      a.created_at,
      a.kept
    FROM chat_attachments a
    LEFT JOIN chat_messages m ON a.message_id = m.id
    LEFT JOIN chat_conversations c ON m.conversation_id = c.id
    ORDER BY a.created_at DESC
  `).all() as Array<{
    id: string;
    role: "user" | "assistant";
    file_name: string;
    mime_type: string;
    size_bytes: number;
    conv_title: string;
    conversation_id: number | null;
    storage_path: string;
    created_at: string;
    kept: number;
  }>;

  const knowledgeRows = db.prepare(`
    SELECT id, file_name, mime_type, size_bytes, category, storage_path, created_at
    FROM knowledge_documents
    WHERE archived = 0
    ORDER BY created_at DESC
  `).all() as Array<{
    id: number;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    category: string;
    storage_path: string;
    created_at: string;
  }>;

  const libraryRows = db.prepare(`
    SELECT id, file_name, mime_type, size_bytes, storage_path, source_kind, source_label, created_at, kept_at
    FROM library_files
    ORDER BY kept_at DESC
  `).all() as Array<{
    id: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
    source_kind: string;
    source_label: string;
    created_at: string;
    kept_at: string;
  }>;

  let results: UnifiedFileEntry[] = [
    ...attachRows.map((r) => ({
      id: `attach:${r.id}`,
      kind: (r.role === "user" ? "upload" : "generated") as "upload" | "generated",
      name: r.file_name,
      mime: r.mime_type,
      sizeBytes: r.size_bytes,
      source: r.conv_title || "对话",
      conversationId: r.conversation_id,
      storagePath: r.storage_path,
      createdAt: r.created_at,
      kept: r.kept === 1,
    })),
    ...knowledgeRows.map((r) => ({
      id: `know:${r.id}`,
      kind: "knowledge" as const,
      name: r.file_name,
      mime: r.mime_type,
      sizeBytes: r.size_bytes,
      source: r.category,
      conversationId: null,
      storagePath: r.storage_path,
      createdAt: r.created_at,
      kept: true,
    })),
    ...libraryRows.map((r) => ({
      id: `lib:${r.id}`,
      kind: "library" as const,
      name: r.file_name,
      mime: r.mime_type,
      sizeBytes: r.size_bytes,
      source: r.source_label || "已保留文件库",
      conversationId: null,
      storagePath: r.storage_path,
      createdAt: r.created_at,
      kept: true,
    })),
  ];

  // kind 过滤
  if (kind) {
    results = results.filter((r) => r.kind === kind);
  }

  // 搜索
  if (q && q.trim()) {
    const lower = q.trim().toLowerCase();
    results = results.filter(
      (r) => r.name.toLowerCase().includes(lower) || r.source.toLowerCase().includes(lower)
    );
  }

  // 排序
  if (sort === "name") {
    results.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
  } else if (sort === "size") {
    results.sort((a, b) => b.sizeBytes - a.sizeBytes);
  } else {
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  return results;
}

/**
 * 标记附件为「保留」(kept=1):文件库显示该文件、对话删除时迁库而非删除。
 * 落审计(红线 8)。
 */
export function setAttachmentKept(attachmentId: string, kept: boolean, db = getDb()): void {
  db.prepare("UPDATE chat_attachments SET kept = ? WHERE id = ?").run(kept ? 1 : 0, attachmentId);
  db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
    "file_kept", JSON.stringify({ attachmentId, kept, at: new Date().toISOString() })
  );
}

/**
 * 将 kept=1 的 chat_attachments 行迁移到 library_files 表 + 移动物理文件。
 * 仅迁移属于指定会话(通过 message_id → chat_messages.conversation_id)的附件。
 *
 * 生命周期安全保证:
 * - 先 copyFileSync 到库目录,成功后再 unlinkSync 源;
 * - 任意步骤失败 → 抛出错误,调用方不得删除会话/文件。
 *
 * 返回迁移成功的附件 id 列表。
 */
export function migrateKeptAttachmentsBeforeConversationDelete(
  conversationId: number,
  getConversationFilesDirFn: (id: number) => string,
  libraryDir: string,
  db = getDb()
): string[] {
  const nodePath = path;

  // 找出该会话下 kept=1 的附件
  const rows = db.prepare(`
    SELECT a.id, a.file_name, a.mime_type, a.size_bytes, a.storage_path, c.title AS conv_title
    FROM chat_attachments a
    JOIN chat_messages m ON a.message_id = m.id
    JOIN chat_conversations c ON m.conversation_id = c.id
    WHERE m.conversation_id = ? AND a.kept = 1
  `).all(conversationId) as Array<{
    id: string;
    file_name: string;
    mime_type: string;
    size_bytes: number;
    storage_path: string;
    conv_title: string;
  }>;

  if (rows.length === 0) return [];

  mkdirSync(libraryDir, { recursive: true });
  const convFilesDir = getConversationFilesDirFn(conversationId);
  const migrated: string[] = [];

  for (const row of rows) {
    const srcPath = nodePath.resolve(nodePath.join(convFilesDir, row.storage_path));
    // Path safety: ensure src is inside conv files dir
    if (!srcPath.startsWith(nodePath.resolve(convFilesDir))) {
      throw new Error(`[file-library] 路径异常,拒绝迁移: ${row.storage_path}`);
    }

    if (!existsSync(srcPath)) {
      // 物理文件已不存在(可能已手动删除),记录到 library 但 storage_path 标为缺失
      db.prepare(`
        INSERT OR REPLACE INTO library_files (id, file_name, mime_type, size_bytes, storage_path, source_kind, source_label, created_at, kept_at)
        VALUES (?, ?, ?, ?, ?, 'generated', ?, ?, CURRENT_TIMESTAMP)
      `).run(row.id, row.file_name, row.mime_type, row.size_bytes, "", row.conv_title, new Date().toISOString());
      migrated.push(row.id);
      continue;
    }

    // 生成目标路径,避免重名冲突
    const base = nodePath.basename(row.file_name, nodePath.extname(row.file_name));
    const ext = nodePath.extname(row.file_name);
    let destPath = nodePath.join(libraryDir, row.file_name);
    let counter = 1;
    while (existsSync(destPath)) {
      destPath = nodePath.join(libraryDir, `${base}-${counter}${ext}`);
      counter++;
    }

    // 移动文件:先 copy,成功后删源(绝不在 copy 成功前删源)
    copyFileSync(srcPath, destPath);
    try {
      unlinkSync(srcPath);
    } catch {
      // 删源失败不影响迁移成功(下次清理时会重复),不抛出
    }

    db.prepare(`
      INSERT OR REPLACE INTO library_files (id, file_name, mime_type, size_bytes, storage_path, source_kind, source_label, created_at, kept_at)
      VALUES (?, ?, ?, ?, ?, 'generated', ?, ?, CURRENT_TIMESTAMP)
    `).run(row.id, row.file_name, row.mime_type, row.size_bytes, destPath, row.conv_title, new Date().toISOString());

    migrated.push(row.id);
  }

  db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
    "file_library_migrate",
    JSON.stringify({ conversationId, migratedIds: migrated, count: migrated.length, at: new Date().toISOString() })
  );

  return migrated;
}

/**
 * 删除文件库中的一个文件(library_files 或 chat_attachments):
 * - 删磁盘文件
 * - 删 DB 记录
 * - 落审计(红线 8)
 */
export function deleteLibraryFile(
  fileId: string,
  db = getDb()
): void {

  if (fileId.startsWith("lib:")) {
    const id = fileId.slice(4);
    const row = db.prepare("SELECT storage_path, file_name FROM library_files WHERE id = ?").get(id) as { storage_path: string; file_name: string } | undefined;
    if (!row) throw new Error(`library_files 找不到记录: ${id}`);
    if (row.storage_path && existsSync(row.storage_path)) {
      unlinkSync(row.storage_path);
    }
    db.prepare("DELETE FROM library_files WHERE id = ?").run(id);
    db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
      "file_deleted", JSON.stringify({ source: "library", fileId: id, fileName: row.file_name, at: new Date().toISOString() })
    );
  } else if (fileId.startsWith("attach:")) {
    const id = fileId.slice(7);
    const row = db.prepare(`
      SELECT a.storage_path, a.file_name, m.conversation_id
      FROM chat_attachments a
      LEFT JOIN chat_messages m ON a.message_id = m.id
      WHERE a.id = ?
    `).get(id) as { storage_path: string; file_name: string; conversation_id: number | null } | undefined;
    if (!row) throw new Error(`chat_attachments 找不到记录: ${id}`);
    // For conversation attachments, storage_path is relative
    if (row.storage_path && row.conversation_id) {
      const absPath = path.join(getConversationFilesDir(row.conversation_id), row.storage_path);
      if (existsSync(absPath)) unlinkSync(absPath);
    } else if (row.storage_path && existsSync(row.storage_path)) {
      unlinkSync(row.storage_path);
    }
    db.prepare("DELETE FROM chat_attachments WHERE id = ?").run(id);
    db.prepare("INSERT INTO audit_logs (event_type, payload) VALUES (?, ?)").run(
      "file_deleted", JSON.stringify({ source: "chat_attachments", fileId: id, fileName: row.file_name, at: new Date().toISOString() })
    );
  } else if (fileId.startsWith("know:")) {
    // Knowledge deletion is handled by the knowledge API, not here
    throw new Error("知识库文件请从知识库页面删除");
  } else {
    throw new Error(`未知文件 ID 格式: ${fileId}`);
  }
}

export function readFeatureFlags(dbOverride?: import("node:sqlite").DatabaseSync): Record<string, boolean> {
  const db = dbOverride ?? getDb();
  const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'flag:%'").all() as Array<{ key: string; value: string }>;
  const flags: Record<string, boolean> = {};
  for (const row of rows) {
    const flagName = row.key.replace("flag:", "");
    flags[flagName] = row.value === "true";
  }
  return flags;
}

// ── 全局搜索 ──────────────────────────────────────────────────────────────────

function likeArg(q: string): string {
  // 转义用户输入里的 \ % _,配合 ESCAPE '\' 防通配注入
  return "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
}

function makeSnippet(content: string, q: string): string {
  if (!content) return "";
  const i = content.toLowerCase().indexOf(q.toLowerCase());
  if (i < 0) return content.slice(0, 60) + (content.length > 60 ? "…" : "");
  const start = Math.max(0, i - 30);
  const end = i + q.length + 30;
  return (start > 0 ? "…" : "") + content.slice(start, end) + (end < content.length ? "…" : "");
}

export type FileSearchHit = { kind: "library" | "knowledge"; id: string; title: string; mimeType: string };

export function searchFilesByTitle(q: string, limit = 20): FileSearchHit[] {
  if (!q.trim()) return [];
  const db = getDb();
  const arg = likeArg(q.trim());
  const lib = db.prepare(
    "SELECT id, file_name AS title, mime_type FROM library_files WHERE file_name LIKE ? ESCAPE '\\' ORDER BY kept_at DESC LIMIT ?"
  ).all(arg, limit) as Array<{ id: string; title: string; mime_type: string }>;
  const kn = db.prepare(
    "SELECT CAST(id AS TEXT) AS id, title, mime_type FROM knowledge_documents WHERE title LIKE ? ESCAPE '\\' OR file_name LIKE ? ESCAPE '\\' ORDER BY updated_at DESC LIMIT ?"
  ).all(arg, arg, limit) as Array<{ id: string; title: string; mime_type: string }>;
  return [
    ...lib.map((r) => ({ kind: "library" as const, id: r.id, title: r.title, mimeType: r.mime_type })),
    ...kn.map((r) => ({ kind: "knowledge" as const, id: r.id, title: r.title, mimeType: r.mime_type })),
  ];
}

export type ConversationSearchHit = { id: number; title: string; snippet: string; matchedInContent: boolean };

export function searchConversations(q: string, limit = 20): ConversationSearchHit[] {
  if (!q.trim()) return [];
  const db = getDb();
  const arg = likeArg(q.trim());
  const rows = db.prepare(`
    SELECT c.id AS id, c.title AS title,
      (SELECT m.content FROM chat_messages m
        WHERE m.conversation_id = c.id AND m.content LIKE ? ESCAPE '\\'
        ORDER BY m.created_at LIMIT 1) AS hitContent
    FROM chat_conversations c
    WHERE c.title LIKE ? ESCAPE '\\'
       OR EXISTS (SELECT 1 FROM chat_messages m2 WHERE m2.conversation_id = c.id AND m2.content LIKE ? ESCAPE '\\')
    ORDER BY c.updated_at DESC LIMIT ?
  `).all(arg, arg, arg, limit) as Array<{ id: number; title: string; hitContent: string | null }>;
  return rows.map((r) => ({
    id: r.id,
    title: r.title,
    matchedInContent: r.hitContent != null,
    snippet: makeSnippet(r.hitContent ?? "", q.trim()),
  }));
}

/** 全局搜索空查询时的默认项:最近对话(只取标题,无片段)。 */
export function recentConversationsForSearch(limit = 15): ConversationSearchHit[] {
  const db = getDb();
  const rows = db
    .prepare("SELECT id, title FROM chat_conversations ORDER BY updated_at DESC, id DESC LIMIT ?")
    .all(limit) as Array<{ id: number; title: string }>;
  return rows.map((r) => ({ id: r.id, title: r.title, snippet: "", matchedInContent: false }));
}
