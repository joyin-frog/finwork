import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// sessionStage 独立测试：经 FINANCE_AGENT_DB_PATH 隔离，函数不存在即红
export const queryStagesTestPromise = (async () => {
  // 先用临时 DB 隔离
  const baseDir = mkdtempSync(path.join(os.tmpdir(), "query-stages-test-"));
  process.env.FINANCE_AGENT_APP_DATA_DIR = baseDir;
  process.env.FINANCE_AGENT_DB_PATH = path.join(baseDir, "query-stages.db");

  const { openFinanceDatabase, initializeFinanceDatabase, getChatConversation } = await import("../lib/db/sqlite.ts");
  initializeFinanceDatabase(openFinanceDatabase(process.env.FINANCE_AGENT_DB_PATH));

  // 导入被测函数（函数不存在时此处即红）
  const { sessionStage } = await import("../lib/agent/query-stages.ts");

  // 构造最小 ctx (parseStage 产出的上游字段)
  const makeCtx = (overrides: Record<string, unknown> = {}) => ({
    traceId: "test-trace-id",
    settings: { roleMode: "tech" as const, subagentModel: undefined as string | undefined },
    roleMode: "tech" as string,
    messages: [{ role: "user" as const, content: "你好" }],
    attachments: [],
    conversationId: undefined as number | undefined,
    lastUserContent: "你好",
    referencedSkills: [] as string[],
    ...overrides,
  });

  // --- S1: 新会话创建 ---
  {
    const ctx = makeCtx();
    const result = await sessionStage(ctx);
    assert.ok(!(result instanceof Response), "S1 FAIL: sessionStage 不应短路");
    assert.ok(typeof result.conversationId === "number", "S1 FAIL: 应创建 conversationId");
    assert.ok(typeof result.claudeSessionId === "string" && result.claudeSessionId.length > 0, "S1 FAIL: 应生成 claudeSessionId");
    assert.ok(result.existingClaudeSessionId === null, "S1 FAIL: 新会话 existingClaudeSessionId 应为 null");
    // 验证会话已落库
    const conv = getChatConversation(result.conversationId!);
    assert.ok(conv, "S1 FAIL: 会话应已落库");
    assert.ok(conv.claudeSessionId === result.claudeSessionId, "S1 FAIL: claudeSessionId 应写入会话");
    console.log("query-stages S1 pass ✓");
  }

  // --- S2: 既有会话追加（claudeSessionId 复用）---
  {
    // 先建一条会话
    const ctx1 = makeCtx();
    const r1 = await sessionStage(ctx1);
    assert.ok(!(r1 instanceof Response), "S2 setup FAIL");
    const existingConvId = r1.conversationId!;
    const existingSessionId = r1.claudeSessionId!;

    // 同 conversationId 再次请求
    const ctx2 = makeCtx({ conversationId: existingConvId });
    const r2 = await sessionStage(ctx2);
    assert.ok(!(r2 instanceof Response), "S2 FAIL: sessionStage 不应短路");
    assert.equal(r2.conversationId, existingConvId, "S2 FAIL: conversationId 应保持");
    assert.equal(r2.existingClaudeSessionId, existingSessionId, "S2 FAIL: 应复用 existingClaudeSessionId");
    assert.equal(r2.claudeSessionId, existingSessionId, "S2 FAIL: claudeSessionId 应与既有相同");
    console.log("query-stages S2 pass ✓");
  }

  // --- S3: staleness 重置（超龄会话清空 claudeSessionId）---
  {
    // 建一条会话并手动设置 claudeSessionUpdatedAt 为超旧时间
    const { createChatConversation, setChatConversationClaudeSessionId } = await import("../lib/db/sqlite.ts");
    const convId = createChatConversation("stale-test");
    const oldSessionId = "old-session-12345";
    setChatConversationClaudeSessionId(convId, oldSessionId);

    // 直接操控 DB 让 updated_at 超旧（超 12h）
    const { openFinanceDatabase: openDb } = await import("../lib/db/sqlite.ts");
    const db = openDb(process.env.FINANCE_AGENT_DB_PATH!);
    db.prepare("UPDATE chat_conversations SET claude_session_updated_at = datetime('now', '-13 hours') WHERE id = ?").run(convId);
    db.close();

    // 确保 flag SESSION_LIVENESS_CHECK_ENABLED 开启
    process.env.FINANCE_AGENT_FLAG_SESSION_LIVENESS_CHECK_ENABLED = "1";
    const { _resetFlagsForTest } = await import("../lib/runtime/flags.ts");
    _resetFlagsForTest();

    const ctx3 = makeCtx({ conversationId: convId });
    const r3 = await sessionStage(ctx3);
    assert.ok(!(r3 instanceof Response), "S3 FAIL: sessionStage 不应短路");
    assert.equal(r3.existingClaudeSessionId, null, "S3 FAIL: 超龄会话 existingClaudeSessionId 应重置为 null");
    assert.ok(r3.claudeSessionId !== oldSessionId, "S3 FAIL: 超龄会话应生成新 claudeSessionId");

    // 清理 env
    delete process.env.FINANCE_AGENT_FLAG_SESSION_LIVENESS_CHECK_ENABLED;
    _resetFlagsForTest();
    console.log("query-stages S3 pass ✓");
  }

  // --- S4: 重试去重（同 conversationId 同 content 连发两次，DB 只有一条 user 消息）---
  {
    const { openFinanceDatabase: openDb4 } = await import("../lib/db/sqlite.ts");

    // 第一次请求（新建会话，插入第一条 user 消息）
    const ctx1 = makeCtx();
    const r1 = await sessionStage(ctx1);
    assert.ok(!(r1 instanceof Response), "S4 setup FAIL: sessionStage 不应短路");
    const convId = r1.conversationId!;

    // 第二次请求：同 conversationId 同 content（模拟重试）
    const ctx2 = makeCtx({ conversationId: convId });
    const r2 = await sessionStage(ctx2);
    assert.ok(!(r2 instanceof Response), "S4 FAIL: sessionStage 不应短路");

    // 验证 DB 中只有 1 条 user 消息（去重成功）
    const db4 = openDb4(process.env.FINANCE_AGENT_DB_PATH!);
    const row4 = db4.prepare(
      "SELECT COUNT(*) as cnt FROM chat_messages WHERE conversation_id = ? AND role = 'user'"
    ).get(convId) as { cnt: number };
    db4.close();
    assert.equal(row4.cnt, 1, `S4 FAIL: 重试不应写入重复 user 消息，期望 1 条，实际 ${row4.cnt} 条`);
    console.log("query-stages S4 pass ✓");
  }

  // --- S5: 正常两轮对话（中间有 assistant 回复，同问题第二次应照常落库）---
  {
    const { openFinanceDatabase: openDb5, insertChatMessage: insertMsg5 } = await import("../lib/db/sqlite.ts");

    // 第一次用户请求
    const ctx1 = makeCtx({ lastUserContent: "你好", messages: [{ role: "user" as const, content: "你好" }] });
    const r1 = await sessionStage(ctx1);
    assert.ok(!(r1 instanceof Response), "S5 setup FAIL: sessionStage 不应短路");
    const convId = r1.conversationId!;

    // 模拟 assistant 回复写入（正常对话流）
    insertMsg5(convId, "assistant", "你好！有什么可以帮您？");

    // 第二次用户请求：同 content，但上条消息是 assistant，应照常插入
    const ctx2 = makeCtx({ conversationId: convId, lastUserContent: "你好", messages: [{ role: "user" as const, content: "你好" }] });
    const r2 = await sessionStage(ctx2);
    assert.ok(!(r2 instanceof Response), "S5 FAIL: sessionStage 不应短路");

    // 验证 DB 中有 2 条 user 消息
    const db5 = openDb5(process.env.FINANCE_AGENT_DB_PATH!);
    const row5 = db5.prepare(
      "SELECT COUNT(*) as cnt FROM chat_messages WHERE conversation_id = ? AND role = 'user'"
    ).get(convId) as { cnt: number };
    db5.close();
    assert.equal(row5.cnt, 2, `S5 FAIL: 正常两轮对话应有 2 条 user 消息，实际 ${row5.cnt} 条`);
    console.log("query-stages S5 pass ✓");
  }

  console.log("query-stages: S1-S5 全部通过 ✓");
})();
