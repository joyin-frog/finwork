/**
 * schema 迁移系统:PRAGMA user_version + 有序 MIGRATIONS + runMigrations
 *
 * 规则:
 * - version 1 = baseline(现有 initializeSchema):全新库 / 老库(user_version=0)先跑 initializeSchema,再设 v=1
 * - version 2+ = 后续结构变更,一律新增迁移条目
 * - 每条迁移在事务内执行;任一失败 → 事务回滚 + 抛出(禁止静默吞,红线 4)
 * - 幂等:迁移内使用 addColumnIfMissing / CREATE TABLE IF NOT EXISTS 等守卫
 * - 迁移前若 user_version < 最新 version,先调用传入的 backupFn(留退路)
 *
 * 注意:backupDatabase 以参数注入,避免与 sqlite.ts 形成循环引用。
 */

import { DatabaseSync } from "node:sqlite";
import { addColumnIfMissing, initializeSchema } from "./schema";

export type Migration = {
  version: number;
  name: string;
  up: (db: DatabaseSync) => void;
};

/**
 * MIGRATIONS 数组按 version 升序排列。
 * version 1 = baseline(initializeSchema);之后的结构变更追加到此数组末尾。
 *
 * 新增迁移示例:
 *   { version: 2, name: "add_xyz_column", up: (db) => { addColumnIfMissing(db, "table", "col", "TEXT"); } }
 */
export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "baseline",
    up: (db) => {
      // baseline:应用全量 schema(幂等 CREATE IF NOT EXISTS + addColumnIfMissing)
      initializeSchema(db);
    },
  },
  // 后续结构变更在此追加:
  {
    version: 2,
    name: "remove_phantom_generated_attachments",
    up: (db) => {
      // 修复旧 bug:syncGeneratedAttachments 把用户上传文件误登记成 assistant(生成)分身。
      // 删除"storage_path 与同会话某条 user 附件相同"的 assistant 行(仅删行,不动物理文件——
      // 文件仍被 user 附件引用,零断链)。幂等:无分身时匹配为空、no-op。
      db.exec(`
        DELETE FROM chat_attachments
        WHERE role = 'assistant'
          AND id IN (
            SELECT a.id
            FROM chat_attachments a
            JOIN chat_messages ma ON a.message_id = ma.id
            WHERE a.role = 'assistant'
              AND EXISTS (
                SELECT 1 FROM chat_attachments u
                JOIN chat_messages mu ON u.message_id = mu.id
                WHERE u.role = 'user'
                  AND u.storage_path = a.storage_path
                  AND mu.conversation_id = ma.conversation_id
              )
          )
      `);
    },
  },
  {
    version: 3,
    name: "add_feature_events",
    up: (db) => {
      // 匿名「功能触达」计数(红线 7:只存名字+计数,无 PII)。遥测 reporter 投影成 schemaVersion 4。
      db.exec(`
        CREATE TABLE IF NOT EXISTS feature_events (
          name TEXT PRIMARY KEY,
          count INTEGER NOT NULL DEFAULT 0,
          first_at INTEGER NOT NULL,
          last_at INTEGER NOT NULL
        )
      `);
    },
  },
  {
    version: 4,
    name: "add_subagent_dispatches",
    up: (db) => {
      // 子代理调度史(spec-role-registry §5):记录每次 runSubagent 的起止、结果与高风险工具阻断原因。
      db.exec(`
        CREATE TABLE IF NOT EXISTS subagent_dispatches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role_id TEXT NOT NULL,
          skill TEXT,
          label TEXT,
          trace_id TEXT,
          conversation_id TEXT,
          status TEXT NOT NULL DEFAULT 'running',
          summary TEXT,
          blocked_reason TEXT,
          started_at TEXT NOT NULL DEFAULT (datetime('now')),
          ended_at TEXT,
          duration_ms INTEGER
        )
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatches_role_time
          ON subagent_dispatches(role_id, started_at DESC)
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_dispatches_blocked
          ON subagent_dispatches(blocked_reason) WHERE blocked_reason IS NOT NULL
      `);
    },
  },
  {
    version: 5,
    name: "business_metrics_source_enum",
    up: (db) => {
      // 存量 source='agent' 映射为 'user_dictated'（现状该表数据全部来自对话录入）。
      // 幂等：已经是 user_dictated 的行不受影响；UPDATE WHERE 不存在匹配行时无副作用。
      db.exec(`
        UPDATE business_metrics
        SET source = 'user_dictated'
        WHERE source = 'agent'
      `);
    },
  },
];

/** 当前代码所知的最新 schema version */
export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

/**
 * 读取当前 user_version
 */
export function getUserVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return row.user_version;
}

/**
 * 设置 user_version(必须用字符串拼接,PRAGMA 不支持 ? 占位)
 */
function setUserVersion(db: DatabaseSync, version: number): void {
  db.exec(`PRAGMA user_version = ${version}`);
}

/**
 * 幂等地将数据库从当前 user_version 迁移到最新 version。
 *
 * 步骤:
 * 1. 读 user_version
 * 2. 若 < 最新 → 先调用 backupFn(可回滚)
 * 3. 逐条对 version > current 的迁移:事务内 up() + 更新 user_version
 * 4. 任一失败 → 事务回滚 + 抛出(禁止静默吞,红线 4)
 *
 * @param db        已打开的 DatabaseSync 实例
 * @param dbPath    数据库文件绝对路径(传给 backupFn)
 * @param backupFn  备份函数(注入 backupDatabase,解循环引用)
 */
export function runMigrations(
  db: DatabaseSync,
  dbPath: string,
  backupFn: (db: DatabaseSync, dbPath: string) => string | null
): void {
  const current = getUserVersion(db);

  if (current >= LATEST_VERSION) {
    // 已是最新或超前(不降级),no-op
    return;
  }

  // 迁移前先备份(退路)—— backupFn 失败只告警不抛,与现有约定一致
  backupFn(db, dbPath);

  const pending = MIGRATIONS.filter((m) => m.version > current).sort(
    (a, b) => a.version - b.version
  );

  for (const migration of pending) {
    // 在事务内执行迁移,失败自动回滚
    try {
      db.exec("BEGIN");
      migration.up(db);
      setUserVersion(db, migration.version);
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // rollback 失败也要把原错抛出
      }
      throw new Error(
        `迁移 v${migration.version}(${migration.name})失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

// 重新导出供外部测试直接使用
export { addColumnIfMissing };
