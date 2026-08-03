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

  // --- S1: 新会话创建（locator 归 runtime 所有，Query 不得自铸）---
  // RuntimeSessionLocator 在 Pi 下就是受控目录里的 .jsonl 路径。Query 若先铸一个
  // UUID 落库，回合中途失败时这个假 locator 会留在库里，下一轮 resume 必然报
  // 「Pi session 不存在或已过期」且永久卡死。因此第一轮必须无 locator。
  {
    const ctx = makeCtx();
    const result = await sessionStage(ctx);
    assert.ok(!(result instanceof Response), "S1 FAIL: sessionStage 不应短路");
    assert.ok(typeof result.conversationId === "number", "S1 FAIL: 应创建 conversationId");
    assert.equal(result.runtimeSessionId, null, "S1 FAIL: 首轮尚无 runtime session，不得自铸 locator");
    assert.equal(result.existingRuntimeSessionId, null, "S1 FAIL: 新会话 existingRuntimeSessionId 应为 null");
    // 验证会话已落库，且 runtime_session_id 仍为空（只由回合结束的回写填）
    const conv = getChatConversation(result.conversationId!);
    assert.ok(conv, "S1 FAIL: 会话应已落库");
    assert.equal(conv.runtimeSessionId, null, "S1 FAIL: Query 不得把自铸 locator 写进会话");
    console.log("query-stages S1 pass ✓");
  }

  // --- S2: 既有会话追加（复用回合结束时回写的真实 locator）---
  {
    const { setChatConversationRuntimeSession: writeBack } = await import("../lib/db/sqlite.ts");
    // 先建一条会话
    const ctx1 = makeCtx();
    const r1 = await sessionStage(ctx1);
    assert.ok(!(r1 instanceof Response), "S2 setup FAIL");
    const existingConvId = r1.conversationId!;
    // 模拟回合结束：route.ts 把 runtime 返回的真实 session 文件路径回写
    const locator = path.join(baseDir, "pi-sessions", "s2-session.jsonl");
    writeBack(existingConvId, locator);

    // 同 conversationId 再次请求
    const ctx2 = makeCtx({ conversationId: existingConvId });
    const r2 = await sessionStage(ctx2);
    assert.ok(!(r2 instanceof Response), "S2 FAIL: sessionStage 不应短路");
    assert.equal(r2.conversationId, existingConvId, "S2 FAIL: conversationId 应保持");
    assert.equal(r2.existingRuntimeSessionId, locator, "S2 FAIL: 应复用回写的 locator");
    assert.equal(r2.runtimeSessionId, locator, "S2 FAIL: runtimeSessionId 应与既有相同");
    console.log("query-stages S2 pass ✓");
  }

  // --- S3: staleness 重置（超龄会话清空 runtimeSessionId）---
  {
    // 建一条会话并手动设置 runtimeSessionUpdatedAt 为超旧时间
    const { createChatConversation, setChatConversationRuntimeSession } = await import("../lib/db/sqlite.ts");
    const convId = createChatConversation("stale-test");
    const oldSessionId = "old-session-12345";
    setChatConversationRuntimeSession(convId, oldSessionId);

    // 直接操控 DB 让 updated_at 超旧（超 12h）
    const { openFinanceDatabase: openDb } = await import("../lib/db/sqlite.ts");
    const db = openDb(process.env.FINANCE_AGENT_DB_PATH!);
    db.prepare("UPDATE chat_conversations SET runtime_session_updated_at = datetime('now', '-13 hours') WHERE id = ?").run(convId);
    db.close();

    // 确保 flag SESSION_LIVENESS_CHECK_ENABLED 开启
    process.env.FINANCE_AGENT_FLAG_SESSION_LIVENESS_CHECK_ENABLED = "1";
    const { _resetFlagsForTest } = await import("../lib/runtime/flags.ts");
    _resetFlagsForTest();

    const ctx3 = makeCtx({ conversationId: convId });
    const r3 = await sessionStage(ctx3);
    assert.ok(!(r3 instanceof Response), "S3 FAIL: sessionStage 不应短路");
    assert.equal(r3.existingRuntimeSessionId, null, "S3 FAIL: 超龄会话 existingRuntimeSessionId 应重置为 null");
    assert.equal(r3.runtimeSessionId, null, "S3 FAIL: 超龄会话应弃用旧 locator 且不自铸新的");

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

  // --- S6: 去重命中时新附件应落库（Plan 045 本 bug）---
  {
    const { openFinanceDatabase: openDb6, getMessageAttachments: getAtts6 } = await import("../lib/db/sqlite.ts");

    // 第一次请求：建会话，不带附件
    const ctx1 = makeCtx({ lastUserContent: "附件测试", messages: [{ role: "user" as const, content: "附件测试" }] });
    const r1 = await sessionStage(ctx1);
    assert.ok(!(r1 instanceof Response), "S6 setup FAIL");
    const convId = r1.conversationId!;

    // 取第一条 user 消息 id
    const db6 = openDb6(process.env.FINANCE_AGENT_DB_PATH!);
    const msgRow = db6.prepare(
      "SELECT id FROM chat_messages WHERE conversation_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1"
    ).get(convId) as { id: number };
    db6.close();
    const msgId = msgRow.id;

    // 第二次请求：同 content（触发去重）+ 一个新附件
    const fakeStoragePath = path.join(baseDir, "conversations", String(convId), "upload", "report.csv");
    const newAtt = { name: "report.csv", mimeType: "text/csv", size: 1024, dataUrl: "", storagePath: fakeStoragePath };
    const ctx2 = makeCtx({
      conversationId: convId,
      lastUserContent: "附件测试",
      messages: [{ role: "user" as const, content: "附件测试" }],
      attachments: [newAtt],
    });
    const r2 = await sessionStage(ctx2);
    assert.ok(!(r2 instanceof Response), "S6 FAIL: sessionStage 不应短路");

    // 断言 chat_attachments 有该附件记录
    const atts = getAtts6(msgId);
    assert.equal(atts.length, 1, `S6 FAIL: 去重命中后新附件应落库，期望 1 条，实际 ${atts.length} 条`);
    assert.equal(atts[0].fileName, "report.csv", "S6 FAIL: 附件文件名不符");
    assert.equal(atts[0].sizeBytes, 1024, "S6 FAIL: 附件大小不符");
    console.log("query-stages S6 pass ✓");
  }

  // --- S7: 同附件重复提交不产生重复行（防双插）---
  {
    const { openFinanceDatabase: openDb7, getMessageAttachments: getAtts7 } = await import("../lib/db/sqlite.ts");

    // 建会话
    const ctx1 = makeCtx({ lastUserContent: "防双插测试", messages: [{ role: "user" as const, content: "防双插测试" }] });
    const r1 = await sessionStage(ctx1);
    assert.ok(!(r1 instanceof Response), "S7 setup FAIL");
    const convId = r1.conversationId!;

    // 取消息 id
    const db7 = openDb7(process.env.FINANCE_AGENT_DB_PATH!);
    const msgRow7 = db7.prepare(
      "SELECT id FROM chat_messages WHERE conversation_id = ? AND role = 'user' ORDER BY id ASC LIMIT 1"
    ).get(convId) as { id: number };
    db7.close();
    const msgId7 = msgRow7.id;

    // 第二次请求：去重命中 + 同一附件（同名同大小）
    const fakeStoragePath7 = path.join(baseDir, "conversations", String(convId), "upload", "invoice.pdf");
    const dupAtt = { name: "invoice.pdf", mimeType: "application/pdf", size: 2048, dataUrl: "", storagePath: fakeStoragePath7 };
    const ctx2 = makeCtx({
      conversationId: convId,
      lastUserContent: "防双插测试",
      messages: [{ role: "user" as const, content: "防双插测试" }],
      attachments: [dupAtt],
    });
    await sessionStage(ctx2);

    // 第三次请求：同附件再来一次（模拟真重试）
    const ctx3 = makeCtx({
      conversationId: convId,
      lastUserContent: "防双插测试",
      messages: [{ role: "user" as const, content: "防双插测试" }],
      attachments: [dupAtt],
    });
    await sessionStage(ctx3);

    // 断言只有 1 条附件记录
    const atts7 = getAtts7(msgId7);
    assert.equal(atts7.length, 1, `S7 FAIL: 同附件重复提交不应产生重复行，期望 1 条，实际 ${atts7.length} 条`);
    console.log("query-stages S7 pass ✓");
  }

  console.log("query-stages: S1-S7 全部通过 ✓");
})();
