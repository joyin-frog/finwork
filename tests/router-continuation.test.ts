/**
 * 续轮跳过意图路由器 — 测试套件
 *
 * 跑法:
 *   FINANCE_AGENT_MOCK_AGENT=1 FINANCE_AGENT_MOCK_AGENT_DELAY=0 SKIP_LLM=true \
 *   node --import tsx tests/router-continuation.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

function seedRoutingLog(
  db: DatabaseSync,
  conversationId: number,
  intent: string,
  routerPath: "cheap" | "main" | "fallback"
) {
  db.prepare(
    `INSERT INTO model_routing_log
       (trace_id, conversation_id, user_message, decision_json, path, router_latency_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    "trace-seed",
    conversationId,
    "上一条消息",
    JSON.stringify({ intent, needsRag: false, reasoning: "seed" }),
    routerPath,
    100
  );
}

export const routerContinuationTestPromise = (async () => {
  // 确保 mock 模式 + SKIP_LLM 生效
  process.env.FINANCE_AGENT_MOCK_AGENT = "1";
  process.env.FINANCE_AGENT_MOCK_AGENT_DELAY = "0";
  process.env.SKIP_LLM = "true";

  // 建临时 DB，通过 FINANCE_AGENT_DB_PATH 注入（必须在 import 前设置）
  const dbPath = path.join(os.tmpdir(), `router-cont-test-${process.pid}-${Date.now()}.db`);
  process.env.FINANCE_AGENT_DB_PATH = dbPath;

  // 动态 import 保证 getDb 用临时路径
  const { initializeFinanceDatabase, openFinanceDatabase } = await import("../lib/db/sqlite.ts");
  const db = initializeFinanceDatabase(openFinanceDatabase(dbPath));

  // stub fetch，用于计数 LLM 调用
  let llmCallCount = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (..._args: Parameters<typeof fetch>) => {
    llmCallCount++;
    return new Response(
      JSON.stringify({
        content: [
          {
            type: "text",
            text: JSON.stringify({
              intent: "tool_task",
              needs_rag: false,
              rag_queries: [],
              reasoning: "stub",
            }),
          },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } }
    );
  }) as typeof fetch;

  const { runRouter } = await import("../lib/agent/router.ts");

  try {
    // ── C1: 续轮（有 runtimeSessionId + 上轮 complex_workflow）不发 LLM，沿用 intent ──
    {
      const conversationId = 1001;
      seedRoutingLog(db, conversationId, "complex_workflow", "main");

      llmCallCount = 0;
      const result = await runRouter(
        "1 2026年1月 2 100000，十万",
        [],
        "trace-c1",
        { runtimeSessionId: "session-abc", conversationId }
      );

      assert.equal(llmCallCount, 0, "C1 FAIL: 续轮 complex_workflow 不应发起 LLM 调用");
      assert.equal(result.decision.intent, "complex_workflow", "C1 FAIL: 续轮应沿用上轮 intent");
      assert.ok(
        result.decision.reasoning.includes("continuation"),
        `C1 FAIL: reasoning 应包含 "continuation"，实际: ${result.decision.reasoning}`
      );
      console.log("C1 ✓ continuation skips LLM, reuses complex_workflow intent");
    }

    // ── C2: 首轮（无 runtimeSessionId）不触发续轮路径 ──
    {
      const conversationId = 1002;
      llmCallCount = 0;
      const result = await runRouter(
        "帮我算一下这个月工资",
        [],
        "trace-c2",
        { runtimeSessionId: null, conversationId }
      );

      // mock 模式下走 fallback，不打真 LLM
      assert.equal(llmCallCount, 0, "C2 INFO: mock 模式不打真 LLM（预期）");
      assert.ok(
        !result.decision.reasoning.includes("continuation"),
        `C2 FAIL: 首轮不应触发续轮路径，reasoning: ${result.decision.reasoning}`
      );
      console.log("C2 ✓ first turn without runtimeSessionId does not trigger continuation");
    }

    // ── C3: 上轮路径为 cheap 时，续轮不跳过（走 mock fallback）──
    {
      const conversationId = 1003;
      seedRoutingLog(db, conversationId, "greeting", "cheap");

      llmCallCount = 0;
      const result = await runRouter(
        "那这个月工资呢",
        [],
        "trace-c3",
        { runtimeSessionId: "session-xyz", conversationId }
      );

      assert.equal(llmCallCount, 0, "C3 INFO: mock 模式不打真 LLM（预期）");
      assert.ok(
        !result.decision.reasoning.includes("continuation"),
        `C3 FAIL: 上轮 cheap 不应触发续轮路径，reasoning: ${result.decision.reasoning}`
      );
      console.log("C3 ✓ cheap prior turn does not trigger continuation");
    }

    // ── C4: 上轮 tool_task（main 路径）的续轮也跳过 LLM ──
    {
      const conversationId = 1004;
      seedRoutingLog(db, conversationId, "tool_task", "main");

      llmCallCount = 0;
      const result = await runRouter(
        "100000 十万",
        [],
        "trace-c4",
        { runtimeSessionId: "session-tool", conversationId }
      );

      assert.equal(llmCallCount, 0, "C4 FAIL: tool_task 续轮也不应发起 LLM 调用");
      assert.equal(result.decision.intent, "tool_task", "C4 FAIL: 应沿用上轮 tool_task intent");
      assert.ok(
        result.decision.reasoning.includes("continuation"),
        `C4 FAIL: reasoning 应包含 "continuation"，实际: ${result.decision.reasoning}`
      );
      console.log("C4 ✓ tool_task continuation also skips LLM");
    }

    // ── C5: trivialMessage 短路保留（寒暄仍零成本，即使有续轮上下文）──
    {
      const conversationId = 1005;
      seedRoutingLog(db, conversationId, "complex_workflow", "main");

      llmCallCount = 0;
      const result = await runRouter(
        "你好",
        [],
        "trace-c5",
        { runtimeSessionId: "session-greet", conversationId }
      );

      assert.equal(llmCallCount, 0, "C5 FAIL: 寒暄短路不应打 LLM");
      assert.equal(result.path, "cheap", "C5 FAIL: 寒暄应走 cheap 路径");
      assert.equal(result.decision.intent, "greeting", "C5 FAIL: 寒暄 intent 应为 greeting");
      console.log("C5 ✓ trivial greeting still handled cheaply even with continuation context");
    }

    console.log("\n✅ router-continuation: all 5 checks passed!");
  } finally {
    globalThis.fetch = originalFetch;
    try { fs.unlinkSync(dbPath); } catch { /* best-effort */ }
  }
})();
