import { DatabaseSync } from "node:sqlite";

export function addColumnIfMissing(db: DatabaseSync, table: string, column: string, definition: string) {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  if (!columns.some((item) => item.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

export function initializeSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS skill_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      skill_id TEXT NOT NULL,
      name TEXT NOT NULL,
      flow TEXT NOT NULL,
      enabled INTEGER NOT NULL,
      content TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      claude_session_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      conversation_id INTEGER NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated_at
      ON chat_conversations(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_chat_messages_conversation_id
      ON chat_messages(conversation_id, id);

    CREATE TABLE IF NOT EXISTS chat_attachments (
      id TEXT PRIMARY KEY,
      message_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_attachments_message_id
      ON chat_attachments(message_id);

    CREATE TABLE IF NOT EXISTS chat_agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_chat_agent_events_message_id
      ON chat_agent_events(message_id, id);
  `);
  addColumnIfMissing(db, "chat_conversations", "claude_session_id", "TEXT");
  addColumnIfMissing(db, "chat_conversations", "claude_session_updated_at", "TEXT");
  addColumnIfMissing(db, "chat_conversations", "pinned", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "chat_conversations", "user_id", "TEXT NOT NULL DEFAULT 'default-user'");
  addColumnIfMissing(db, "audit_logs", "trace_id", "TEXT");
  addColumnIfMissing(db, "chat_agent_events", "trace_id", "TEXT");
  // 统一文件库:kept 标记(1=保留到文件库,不随对话删除)
  addColumnIfMissing(db, "chat_attachments", "kept", "INTEGER NOT NULL DEFAULT 0");

  // 统一文件库:从对话解耦后的保留文件(message_id 置空,不受 CASCADE 影响)
  db.exec(`
    CREATE TABLE IF NOT EXISTS library_files (
      id          TEXT    PRIMARY KEY,
      file_name   TEXT    NOT NULL,
      mime_type   TEXT    NOT NULL,
      size_bytes  INTEGER NOT NULL,
      storage_path TEXT   NOT NULL,
      source_kind  TEXT   NOT NULL DEFAULT 'generated',
      source_label TEXT   NOT NULL DEFAULT '',
      created_at  TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      kept_at     TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_library_files_created ON library_files(created_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL UNIQUE,
      conversation_id INTEGER NOT NULL,
      trace_id TEXT,
      rating TEXT NOT NULL CHECK (rating IN ('up', 'down')),
      reason TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (message_id) REFERENCES chat_messages(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_chat_feedback_conversation ON chat_feedback(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_chat_feedback_trace ON chat_feedback(trace_id);
    CREATE INDEX IF NOT EXISTS idx_chat_feedback_updated ON chat_feedback(updated_at DESC);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_executions (
      idempotency_key TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_hash TEXT NOT NULL,
      result_json TEXT NOT NULL,
      is_error INTEGER NOT NULL DEFAULT 0,
      trace_id TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (idempotency_key, tool_name)
    );
    CREATE INDEX IF NOT EXISTS idx_tool_executions_created ON tool_executions(created_at DESC);

    CREATE INDEX IF NOT EXISTS idx_audit_logs_trace ON audit_logs(trace_id);
    CREATE INDEX IF NOT EXISTS idx_audit_logs_type_created ON audit_logs(event_type, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_chat_agent_events_trace ON chat_agent_events(trace_id);
    CREATE INDEX IF NOT EXISTS idx_chat_agent_events_type_created
      ON chat_agent_events(event_type, created_at);
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_user ON chat_conversations(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS model_routing_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      trace_id TEXT,
      conversation_id INTEGER,
      user_message TEXT NOT NULL,
      decision_json TEXT NOT NULL,
      path TEXT NOT NULL CHECK (path IN ('cheap', 'main', 'fallback')),
      router_latency_ms INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_model_routing_log_trace ON model_routing_log(trace_id);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_documents (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      title        TEXT    NOT NULL,
      file_name    TEXT    NOT NULL,
      mime_type    TEXT    NOT NULL,
      category     TEXT    NOT NULL DEFAULT 'general',
      size_bytes   INTEGER NOT NULL DEFAULT 0,
      chunk_count  INTEGER NOT NULL DEFAULT 0,
      content_hash TEXT    NOT NULL DEFAULT '',
      created_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at   TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_knowledge_documents_category ON knowledge_documents(category);
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  addColumnIfMissing(db, "knowledge_documents", "storage_path", "TEXT NOT NULL DEFAULT ''");
  // 生命周期治理:使用信号 + 归档(治理旧数据,不自动删除)
  addColumnIfMissing(db, "knowledge_documents", "last_hit_at", "TEXT");
  addColumnIfMissing(db, "knowledge_documents", "hit_count", "INTEGER NOT NULL DEFAULT 0");
  addColumnIfMissing(db, "knowledge_documents", "archived", "INTEGER NOT NULL DEFAULT 0");
  // P1 合同归纳:结构化 metadata + 确认状态
  addColumnIfMissing(db, "knowledge_documents", "metadata", "TEXT");
  addColumnIfMissing(db, "knowledge_documents", "meta_status", "TEXT NOT NULL DEFAULT 'none'");

  // Drop legacy RAG tables if they exist
  db.exec(`
    DROP TABLE IF EXISTS knowledge_chunks_fts;
    DROP TABLE IF EXISTS knowledge_chunks;
    DROP TABLE IF EXISTS knowledge_query_log;
    DROP TABLE IF EXISTS memory_entries;
    DELETE FROM app_settings WHERE key = 'knowledge_embed_dim';
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_traces (
      trace_id TEXT PRIMARY KEY,
      conversation_id INTEGER,
      user_id TEXT,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      total_ms INTEGER,
      model_used TEXT,
      router_path TEXT,
      prompt_tokens INTEGER,
      completion_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_creation_tokens INTEGER,
      tool_call_count INTEGER DEFAULT 0,
      retry_count INTEGER DEFAULT 0,
      error_message TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_traces_started ON agent_traces(started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_traces_conv ON agent_traces(conversation_id);
  `);

  // Additive columns for observability panel
  addColumnIfMissing(db, "agent_traces", "user_message", "TEXT");
  addColumnIfMissing(db, "agent_traces", "final_answer", "TEXT");
  addColumnIfMissing(db, "agent_traces", "status", "TEXT DEFAULT 'ok'");
  addColumnIfMissing(db, "agent_traces", "role_mode", "TEXT");
  addColumnIfMissing(db, "agent_traces", "total_cost_usd", "REAL");
  addColumnIfMissing(db, "agent_traces", "input_tokens", "INTEGER");
  addColumnIfMissing(db, "agent_traces", "output_tokens", "INTEGER");
  addColumnIfMissing(db, "agent_traces", "llm_call_count", "INTEGER DEFAULT 1");
  addColumnIfMissing(db, "agent_traces", "num_turns", "INTEGER");
  addColumnIfMissing(db, "agent_traces", "model_usage_json", "TEXT");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agent_spans (
      id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      span_type TEXT NOT NULL,
      name TEXT,
      started_at INTEGER NOT NULL,
      duration_ms INTEGER,
      input_summary TEXT,
      output_summary TEXT,
      tokens INTEGER,
      error TEXT,
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_spans_trace ON agent_spans(trace_id);
  `);

  // P2 经营分析 v2:financial_periods 底表预留(post-MVP;MVP 单文件分析不落盘)
  // 后续实现时追加:
  // CREATE TABLE IF NOT EXISTS financial_periods (year INT, month INT, scope TEXT,
  //   line_item TEXT, amount REAL, unit TEXT, status TEXT, as_of TEXT, ...);

  // 经营数据:月度收入/利润录入(用于驾驶舱三视角汇总)
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_metrics (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      year       INTEGER NOT NULL,
      month      INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
      revenue    REAL    NOT NULL,
      cost       REAL,
      expense    REAL,
      profit     REAL    NOT NULL,
      note       TEXT,
      source     TEXT    NOT NULL DEFAULT 'agent',
      created_at TEXT    NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT    NOT NULL DEFAULT (datetime('now')),
      UNIQUE(year, month)
    );
    CREATE INDEX IF NOT EXISTS idx_business_metrics_period ON business_metrics(year, month);
  `);

  // 业务数据层:薪资期间记录(draft/confirmed 状态机)与发票台账(跨月查重)
  db.exec(`
    CREATE TABLE IF NOT EXISTS payroll_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      employee_name TEXT NOT NULL,
      year INTEGER NOT NULL,
      month INTEGER NOT NULL,
      gross_pay REAL NOT NULL,
      social_insurance REAL NOT NULL,
      housing_fund REAL NOT NULL,
      special_deduction REAL NOT NULL,
      months_employed INTEGER NOT NULL,
      gross_cum REAL NOT NULL,
      social_cum REAL NOT NULL,
      fund_cum REAL NOT NULL,
      special_cum REAL NOT NULL,
      taxable_income_cum REAL NOT NULL,
      tax_due_cum REAL NOT NULL,
      tax_current REAL NOT NULL,
      tax_withheld_cum REAL NOT NULL,
      net_pay REAL NOT NULL,
      tax_config_version TEXT NOT NULL,
      detail_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      confirmed_at TEXT,
      UNIQUE(employee_name, year, month)
    );
    CREATE INDEX IF NOT EXISTS idx_payroll_records_period ON payroll_records(year, month);

    CREATE TABLE IF NOT EXISTS invoice_ledger (
      invoice_no TEXT PRIMARY KEY,
      amount REAL NOT NULL,
      invoice_date TEXT,
      category TEXT,
      conversation_id INTEGER,
      recorded_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // App 级错误捕获表(§16):记录渲染崩溃/客户端异常/API 错误/服务端错误
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_errors (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      ts          INTEGER NOT NULL,
      kind        TEXT    NOT NULL CHECK (kind IN ('render','rejection','unhandled','api','server')),
      source      TEXT    NOT NULL DEFAULT '',
      message     TEXT    NOT NULL DEFAULT '',
      stack       TEXT,
      app_version TEXT,
      fingerprint TEXT    NOT NULL DEFAULT '',
      reported    INTEGER NOT NULL DEFAULT 0,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_app_errors_reported ON app_errors(reported, ts);
    CREATE INDEX IF NOT EXISTS idx_app_errors_fingerprint ON app_errors(fingerprint, ts DESC);
  `);
}
