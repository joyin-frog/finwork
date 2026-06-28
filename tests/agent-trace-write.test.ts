import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite";
import { writeAgentTrace } from "../lib/observability/trace-write";

const { equal, ok } = assert;

export const agentTraceWriteTestPromise = (async () => {
  // Use in-memory DB via env override
  const tmpPath = `/tmp/agent-trace-write-test-${process.pid}-${Date.now()}.db`;
  process.env.FINANCE_AGENT_DB_PATH = tmpPath;

  // Initialize DB
  const setupDb = initializeFinanceDatabase(openFinanceDatabase(tmpPath));
  setupDb.close();

  // ── T1: 写一条成功 trace 并读回 ────────────────────────────────
  {
    const traceId = randomUUID();
    const startedAt = Date.now() - 1000;
    writeAgentTrace({
      traceId,
      conversationId: undefined,
      startedAt,
      modelUsed: "claude-sonnet-4-6",
      routerPath: "main",
      errorMessage: null,
      userMessage: "测试问题",
      finalAnswer: "测试回答",
      roleMode: "tech",
      toolCallCount: 3,
    });

    const db = openFinanceDatabase(tmpPath);
    const row = db.prepare("SELECT * FROM agent_traces WHERE trace_id = ?").get(traceId) as Record<string, unknown> | undefined;
    ok(row, "T1 FAIL: trace 行应存在");
    equal(row!.tool_call_count, 3, "T1 FAIL: tool_call_count 应为 3");
    equal(row!.status, "ok", "T1 FAIL: 无错误时 status 应为 ok");
    equal(row!.model_used, "claude-sonnet-4-6", "T1 FAIL: model_used 应匹配");
    db.close();
  }

  // ── T2: 错误 trace 的 status 应为 "error" ─────────────────────
  {
    const traceId = randomUUID();
    const startedAt = Date.now() - 500;
    writeAgentTrace({
      traceId,
      conversationId: undefined,
      startedAt,
      modelUsed: "claude-sonnet-4-6",
      routerPath: "main",
      errorMessage: "Something went wrong",
      userMessage: "错误问题",
      finalAnswer: "",
      roleMode: "tech",
      toolCallCount: 0,
    });

    const db = openFinanceDatabase(tmpPath);
    const row = db.prepare("SELECT * FROM agent_traces WHERE trace_id = ?").get(traceId) as Record<string, unknown> | undefined;
    ok(row, "T2 FAIL: 错误 trace 行应存在");
    equal(row!.status, "error", "T2 FAIL: 有 errorMessage 时 status 应为 error");
    equal(row!.error_message, "Something went wrong", "T2 FAIL: error_message 应保存");
    db.close();
  }

  // ── T3: 带 modelUsage 的 trace ────────────────────────────────
  {
    const traceId = randomUUID();
    const startedAt = Date.now() - 2000;
    writeAgentTrace({
      traceId,
      conversationId: 42,
      startedAt,
      modelUsed: "claude-sonnet-4-6",
      routerPath: "main",
      errorMessage: null,
      userMessage: "token 测试",
      finalAnswer: "回答",
      roleMode: "tech",
      toolCallCount: 1,
      modelUsage: {
        "claude-sonnet-4-6": {
          inputTokens: 500,
          outputTokens: 200,
          cacheReadInputTokens: 100,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.001,
          contextWindow: 200000,
          maxOutputTokens: 8192,
        },
      },
      totalCostUsd: 0.001,
      numTurns: 2,
    });

    const db = openFinanceDatabase(tmpPath);
    const row = db.prepare("SELECT * FROM agent_traces WHERE trace_id = ?").get(traceId) as Record<string, unknown> | undefined;
    ok(row, "T3 FAIL: 带 usage 的 trace 行应存在");
    equal(row!.input_tokens, 500, "T3 FAIL: input_tokens 应为 500");
    equal(row!.output_tokens, 200, "T3 FAIL: output_tokens 应为 200");
    equal(row!.model_used, "claude-sonnet-4-6", "T3 FAIL: model_used 应匹配");
    db.close();
  }

  // Cleanup
  delete process.env.FINANCE_AGENT_DB_PATH;
  try { (await import("node:fs")).unlinkSync(tmpPath); } catch { /* ok */ }

  console.log("agent-trace-write tests passed");
})();
