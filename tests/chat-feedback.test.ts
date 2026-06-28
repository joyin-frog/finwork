import assert from "node:assert/strict";
import { unlinkSync } from "node:fs";
import {
  getDb,
  upsertChatFeedback,
  listFeedbackForConversation,
  getFeedbackStats,
  listRecentNegativeReasons,
  insertChatAgentEvent,
  listAgentEventsForMessage,
} from "../lib/db/sqlite.ts";

// DB 隔离:getDb() 按 FINANCE_AGENT_DB_PATH 切换单例(参照 tests/observability.test.ts),
// 绝不可落到真实运行库——反馈数据会注入 system prompt,测试污染会改变生产行为。
export const chatFeedbackTestPromise = (async () => {
  const dbPath = `/tmp/finance-agent-chat-feedback-${process.pid}-${Date.now()}.db`;
  const prevDbPath = process.env.FINANCE_AGENT_DB_PATH;
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  try {
  const db = getDb();

  // seed：建立对话 + 消息
  db.prepare("INSERT INTO chat_conversations (title) VALUES (?)").run("反馈测试对话");
  const convId = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?,?,?)").run(convId, "user", "问题");
  db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?,?,?)").run(convId, "assistant", "回答");
  const msgId2 = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  // ── AC3-1: upsert 基础写入 ────────────────────────────────────────
  upsertChatFeedback({ messageId: msgId2, conversationId: convId, traceId: null, rating: "up" });
  const list1 = listFeedbackForConversation(convId);
  assert.equal(list1.length, 1, "AC3 FAIL: 应有 1 条反馈");
  assert.equal(list1[0].rating, "up");

  // ── AC3-2: 同 message 二次评价 → upsert，仅 1 行 ─────────────────
  upsertChatFeedback({ messageId: msgId2, conversationId: convId, traceId: null, rating: "down", reason: "数字不对" });
  const list2 = listFeedbackForConversation(convId);
  assert.equal(list2.length, 1, "AC3 FAIL: upsert 后应仍为 1 行");
  assert.equal(list2[0].rating, "down", "AC3 FAIL: 评价应更新为 down");
  assert.equal(list2[0].reason, "数字不对");

  // ── AC3-3: stats 数学正确（窗口 7 天） ───────────────────────────
  const stats = getFeedbackStats(7);
  assert.ok(stats.rated >= 1, "AC3 FAIL: rated 应 >= 1");
  assert.ok(stats.down >= 1, "AC3 FAIL: down 应 >= 1");

  // ── AC3-4: listRecentNegativeReasons 去重/空/上限 ─────────────────
  db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?,?,?)").run(convId, "assistant", "回答2");
  const m3 = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?,?,?)").run(convId, "assistant", "回答3");
  const m4 = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?,?,?)").run(convId, "assistant", "回答4");
  const m5 = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;

  upsertChatFeedback({ messageId: m3, conversationId: convId, traceId: null, rating: "down", reason: "口径不对" });
  upsertChatFeedback({ messageId: m4, conversationId: convId, traceId: null, rating: "down", reason: null });
  upsertChatFeedback({ messageId: m5, conversationId: convId, traceId: null, rating: "down", reason: "数字不对" });

  const reasons = listRecentNegativeReasons(7, 5);
  assert.ok(reasons.includes("数字不对"), "AC3 FAIL: 应包含 数字不对");
  assert.ok(reasons.includes("口径不对"), "AC3 FAIL: 应包含 口径不对");
  const uniqueReasons = new Set(reasons);
  assert.equal(uniqueReasons.size, reasons.length, "AC3 FAIL: 结果应去重");

  const limited = listRecentNegativeReasons(7, 1);
  assert.equal(limited.length, 1, "AC3 FAIL: limit=1 应只返回 1 条");

  console.log("chat-feedback AC3: upsert/stats/reasons ✓");

  // ── AC4: handler 直调 ─────────────────────────────────────────────
  const { POST, GET } = await import("../app/api/chat/feedback/route.ts");

  // 合法 POST（up）
  const postRes = await POST(new Request("http://localhost/api/chat/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: msgId2, rating: "up", reason: "有帮助" }),
  }) as Parameters<typeof POST>[0]);
  assert.equal(postRes.status, 200, `AC4 FAIL: 合法 POST 应返回 200，实际 ${postRes.status}`);
  const postBody = await postRes.json() as { ok: boolean };
  assert.ok(postBody.ok, "AC4 FAIL: 合法 POST 应返回 ok:true");

  // 不存在的 messageId → 404
  const res404 = await POST(new Request("http://localhost/api/chat/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: 999999, rating: "up" }),
  }) as Parameters<typeof POST>[0]);
  assert.equal(res404.status, 404, "AC4 FAIL: 不存在 messageId 应 404");

  // 非法 rating → 400
  const res400 = await POST(new Request("http://localhost/api/chat/feedback", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messageId: msgId2, rating: "maybe" }),
  }) as Parameters<typeof POST>[0]);
  assert.equal(res400.status, 400, "AC4 FAIL: 非法 rating 应 400");

  // GET 回显
  const getRes = await GET(new Request(`http://localhost/api/chat/feedback?conversationId=${convId}`) as Parameters<typeof GET>[0]);
  assert.equal(getRes.status, 200, "AC4 FAIL: GET 应返回 200");
  const getBody = await getRes.json() as { ok: boolean; data: { feedback: Record<string, { rating: string }> } };
  assert.ok(getBody.ok, "AC4 FAIL: GET 应返回 ok:true");
  assert.ok(getBody.data.feedback[msgId2], "AC4 FAIL: 应回显 msgId2 的反馈");

  // Promise.all 并发 10 次 upsert 同一消息 → 最终仅 1 行
  await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      POST(new Request("http://localhost/api/chat/feedback", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: msgId2, rating: i % 2 === 0 ? "up" : "down" }),
      }) as Parameters<typeof POST>[0])
    )
  );
  const finalList = listFeedbackForConversation(convId).filter((f) => f.messageId === msgId2);
  assert.equal(finalList.length, 1, "AC4 FAIL: 并发 upsert 后同 message 应仍仅 1 行");

  console.log("chat-feedback AC4: handler direct calls ✓");

  // ── AC6: StoredAgentEvent 带 traceId ──────────────────────────────
  db.prepare("INSERT INTO chat_messages (conversation_id, role, content) VALUES (?,?,?)").run(convId, "assistant", "带事件");
  const mEvent = (db.prepare("SELECT last_insert_rowid() AS id").get() as { id: number }).id;
  insertChatAgentEvent(mEvent, "tool_use", { name: "test_tool" }, "trace-abc-123");

  const events = listAgentEventsForMessage(mEvent);
  assert.equal(events.length, 1);
  assert.equal(events[0].traceId, "trace-abc-123", "AC6 FAIL: StoredAgentEvent 应含 traceId");

  insertChatAgentEvent(mEvent, "text", { content: "hello" }, null);
  const events2 = listAgentEventsForMessage(mEvent);
  const noTraceEvt = events2.find((e) => e.eventType === "text");
  assert.equal(noTraceEvt?.traceId, null, "AC6 FAIL: 无 trace_id 的事件 traceId 应为 null");

  console.log("chat-feedback AC6: StoredAgentEvent.traceId ✓");

  console.log("\n✅ chat-feedback: all AC3/4/6 checks passed!");
  } finally {
    if (prevDbPath === undefined) delete process.env.FINANCE_AGENT_DB_PATH;
    else process.env.FINANCE_AGENT_DB_PATH = prevDbPath;
    try { unlinkSync(dbPath); } catch { /* ok */ }
  }
})();
