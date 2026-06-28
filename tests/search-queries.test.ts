import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 全局搜索 DB 函数测试:searchFilesByTitle / searchConversations / makeSnippet 行为验证。
export const searchQueriesTestPromise = (async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "fa-search-test-"));
  process.env.FINANCE_AGENT_APP_DATA_DIR = dir;

  // 动态 import 以便 env 生效后再初始化 DB
  const {
    searchFilesByTitle,
    searchConversations,
    recentConversationsForSearch,
    createChatConversation,
    insertChatMessage,
  } = await import("../lib/db/sqlite.ts");

  // ── AC1: 标题命中 ──────────────────────────────────────────────────────────
  {
    // 知识库文档标题命中
    // (library_files 需要 MIME、size_bytes 等字段,通过 API 比较复杂;对话标题更易验证)
    const id = createChatConversation("年度预算规划UNIQ");
    const hits = searchConversations("年度预算规划UNIQ");
    assert.equal(hits.length, 1, "AC1 FAIL: 标题命中应返回 1 条");
    assert.equal(hits[0].id, id, "AC1 FAIL: 命中 id 应与插入一致");
    assert.equal(hits[0].matchedInContent, false, "AC1 FAIL: 仅标题命中,matchedInContent 应为 false");
    console.log("✓ AC1: 标题命中");
  }

  // ── AC2: 内容命中(matchedInContent=true + snippet 含词) ───────────────────
  {
    const id = createChatConversation("日常对话ABC");
    insertChatMessage(id, "user", "请帮我分析这个季度CONTENTMATCH的数据");
    const hits = searchConversations("CONTENTMATCH");
    assert.ok(hits.length >= 1, "AC2 FAIL: 内容命中应至少返回 1 条");
    const hit = hits.find((h) => h.id === id);
    assert.ok(hit, "AC2 FAIL: 应命中刚插入的会话");
    assert.equal(hit!.matchedInContent, true, "AC2 FAIL: matchedInContent 应为 true");
    assert.ok(hit!.snippet.includes("CONTENTMATCH"), "AC2 FAIL: snippet 应含搜索词");
    console.log("✓ AC2: 内容命中,snippet 含词");
  }

  // ── AC3: 通配符 % 被当字面,不误中其他 ────────────────────────────────────
  {
    createChatConversation("含%百分比的标题");
    // 搜一个不含 % 的普通词,不应命中"含%百分比的标题"
    const hits = searchConversations("NOMATCH_WILDCARD_TEST");
    const falseHit = hits.find((h) => h.title.includes("含%百分比"));
    assert.ok(!falseHit, "AC3 FAIL: 通配符 % 应被转义,不应误中含字面 % 的标题");
    // 搜含字面 % 的词,应能命中
    const directHits = searchConversations("%百分比");
    const direct = directHits.find((h) => h.title.includes("含%百分比"));
    assert.ok(direct, "AC3 FAIL: 搜字面 % 时应能精确命中含 % 的标题");
    console.log("✓ AC3: 通配符 % 被正确转义");
  }

  // ── AC4: 同会话多条消息命中,只回一条(按会话去重) ─────────────────────
  {
    const id = createChatConversation("去重测试会话DEDUP");
    insertChatMessage(id, "user", "DEDUPKEYWORD 第一条");
    insertChatMessage(id, "assistant", "DEDUPKEYWORD 第二条");
    const hits = searchConversations("DEDUPKEYWORD");
    const dedupHits = hits.filter((h) => h.id === id);
    assert.equal(dedupHits.length, 1, "AC4 FAIL: 同会话多条命中应去重,只回一条");
    console.log("✓ AC4: 同会话多条命中去重");
  }

  // ── AC5: 空查询返回空数组 ──────────────────────────────────────────────────
  {
    const hits = searchConversations("  ");
    assert.equal(hits.length, 0, "AC5 FAIL: 空/空白查询应返回 []");
    const fileHits = searchFilesByTitle("");
    assert.equal(fileHits.length, 0, "AC5 FAIL: 空查询文件搜索应返回 []");
    console.log("✓ AC5: 空查询返回 []");
  }

  // ── AC6: 空查询默认项 = 最近对话(按 updated_at 倒序,无片段) ───────────────
  {
    const newest = createChatConversation("最新会话RECENTUNIQ");
    const recent = recentConversationsForSearch();
    assert.ok(recent.length > 0, "AC6 FAIL: 应返回最近对话");
    assert.equal(recent[0].id, newest, "AC6 FAIL: 最新会话应排在最前");
    assert.equal(recent[0].snippet, "", "AC6 FAIL: 最近对话项不带片段");
    assert.equal(recent[0].matchedInContent, false, "AC6 FAIL: 最近对话项 matchedInContent=false");
    assert.ok(recentConversationsForSearch(2).length <= 2, "AC6 FAIL: 应遵守 limit");
    console.log("✓ AC6: 空查询默认返回最近对话");
  }

  rmSync(dir, { recursive: true, force: true });
  console.log("✓ search-queries: 全部断言通过");
})();
