/**
 * Plan 034: 验证 countToolCallsToday / countConversationsCompletedToday
 * 使用范围谓词后口径不变——今天的行被计入、昨天的行被排除。
 * 使用 FINANCE_AGENT_DB_PATH 隔离,不污染真实数据目录。
 */
import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import { countToolCallsToday, countConversationsCompletedToday } from "../lib/db/sqlite.ts";

export const cockpitTodayCountsTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "finance-agent-034-test-"));
  const dbPath = path.join(dir, "test.db");

  const origDb = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  try {
    const db = initializeFinanceDatabase(openFinanceDatabase(dbPath));

    // ── 造数据:一条对话 + 一条 message(作为 FK 锚点)────────────────────
    db.prepare(
      "INSERT INTO chat_conversations (title, updated_at) VALUES (?, datetime('now'))"
    ).run("今天的对话");
    const convIdRow = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    const convId = convIdRow.id;

    db.prepare(
      "INSERT INTO chat_conversations (title, updated_at) VALUES (?, datetime('now','-1 day'))"
    ).run("昨天的对话");

    db.prepare(
      "INSERT INTO chat_messages (conversation_id, role, content) VALUES (?, 'user', 'test')"
    ).run(convId);
    const msgIdRow = db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number };
    const msgId = msgIdRow.id;

    // ── 今天的 tool_use 事件 ────────────────────────────────────────────
    db.prepare(
      "INSERT INTO chat_agent_events (message_id, event_type, payload, created_at) VALUES (?, 'tool_use', '{}', datetime('now'))"
    ).run(msgId);

    // ── 昨天的 tool_use 事件(应被排除)──────────────────────────────────
    db.prepare(
      "INSERT INTO chat_agent_events (message_id, event_type, payload, created_at) VALUES (?, 'tool_use', '{}', datetime('now','-1 day'))"
    ).run(msgId);

    // ── 今天的 non-tool_use 事件(应被排除)──────────────────────────────
    db.prepare(
      "INSERT INTO chat_agent_events (message_id, event_type, payload, created_at) VALUES (?, 'text', '{}', datetime('now'))"
    ).run(msgId);

    db.close();

    // ── 断言 countToolCallsToday() = 1 ──────────────────────────────────
    const toolCount = countToolCallsToday();
    assert.equal(toolCount, 1, `Plan-034 FAIL: countToolCallsToday 应为 1,实际 ${toolCount}`);

    // ── 断言 countConversationsCompletedToday() = 1(只有今天更新的那条)──
    const convCount = countConversationsCompletedToday();
    assert.equal(convCount, 1, `Plan-034 FAIL: countConversationsCompletedToday 应为 1,实际 ${convCount}`);

    console.log("cockpit-today-counts (plan-034): all checks passed ✓");
  } finally {
    if (origDb === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = origDb;
    rmSync(dir, { recursive: true, force: true });
  }
})();
