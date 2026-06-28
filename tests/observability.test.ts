import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createChatConversation,
  initializeFinanceDatabase,
  insertChatAgentEvent,
  insertChatMessage,
  listChatMessages,
  openFinanceDatabase,
} from "../lib/db/sqlite";
import { writeSpan } from "../lib/observability/spans";

const { ok, equal, deepEqual } = assert;

const testPid = process.pid;
const tmpPaths: string[] = [];

function freshTmpDbPath() {
  const p = path.join(tmpdir(), `obs-test-${testPid}-${randomUUID().slice(0, 8)}.db`);
  tmpPaths.push(p);
  return p;
}

function setupMemoryDb() {
  return initializeFinanceDatabase(openFinanceDatabase(":memory:"));
}

function useTempDb(): string {
  const dbPath = freshTmpDbPath();
  process.env.FINANCE_AGENT_DB_PATH = dbPath;
  return dbPath;
}

function cleanup() {
  delete process.env.FINANCE_AGENT_DB_PATH;
  for (const p of tmpPaths.splice(0)) {
    try { unlinkSync(p); } catch { /* ok */ }
  }
}

async function main() {
  // ─── DB migration ──────────────────────────────────────

  {
    const db = setupMemoryDb();
    const spanId = randomUUID();
    const traceId = randomUUID();
    db.prepare(`
      INSERT INTO agent_spans (id, trace_id, span_type, name, started_at, duration_ms, tokens, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(spanId, traceId, "tool_call", "grep_docs", Date.now(), 150, null, null);
    const row = db.prepare("SELECT * FROM agent_spans WHERE id = ?").get(spanId) as Record<string, unknown>;
    equal(row.trace_id, traceId);
    equal(row.span_type, "tool_call");
    equal(row.name, "grep_docs");
    equal(row.duration_ms, 150);
    db.close();
  }

  {
    const db = setupMemoryDb();
    const cols = db.prepare("PRAGMA table_info(agent_traces)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    ok(names.includes("user_message"), "missing user_message");
    ok(names.includes("final_answer"), "missing final_answer");
    ok(names.includes("status"), "missing status");
    ok(names.includes("role_mode"), "missing role_mode");
    ok(names.includes("total_cost_usd"), "missing total_cost_usd");
    ok(names.includes("input_tokens"), "missing input_tokens");
    ok(names.includes("output_tokens"), "missing output_tokens");
    ok(names.includes("llm_call_count"), "missing llm_call_count");
    ok(names.includes("num_turns"), "missing num_turns");
    ok(names.includes("model_usage_json"), "missing model_usage_json");
    db.close();
  }

  // ─── Span write ────────────────────────────────────────

  {
    const dbPath = useTempDb();
    const traceId = randomUUID();
    writeSpan({
      traceId, spanType: "router", name: "router",
      startedAt: Date.now() - 50, durationMs: 50,
      inputSummary: "用户输入截断200字",
      outputSummary: "main / complex_workflow", tokens: 0,
    });
    const db = openFinanceDatabase(dbPath);
    const rows = db.prepare("SELECT * FROM agent_spans WHERE trace_id = ?").all(traceId) as Array<Record<string, unknown>>;
    equal(rows.length, 1);
    equal(rows[0].span_type, "router");
    equal(rows[0].name, "router");
    equal(rows[0].duration_ms, 50);
    ok((rows[0].input_summary as string).includes("用户输入"));
    db.close();
    cleanup();
  }

  {
    const dbPath = useTempDb();
    const traceId = randomUUID();
    const long = "x".repeat(300);
    writeSpan({
      traceId, spanType: "memory", name: "memory.md",
      startedAt: Date.now(), durationMs: 10, inputSummary: long,
    });
    const db = openFinanceDatabase(dbPath);
    const row = db.prepare("SELECT input_summary FROM agent_spans WHERE trace_id = ?").get(traceId) as { input_summary: string };
    ok(row.input_summary.length <= 200);
    ok(row.input_summary.endsWith("…"));
    db.close();
    cleanup();
  }

  {
    useTempDb();
    let threw = false;
    try {
      writeSpan({ traceId: "test", spanType: "tool_call", name: "test", startedAt: 0, durationMs: 0 });
    } catch {
      threw = true;
    }
    ok(!threw, "writeSpan should catch errors internally, not throw");
    cleanup();
  }

  // ─── trace_id 链路:agent event 与 trace/span 可直接 join ──
  {
    const dbPath = useTempDb();
    const traceId = randomUUID();
    const convId = createChatConversation("链路测试");
    const msgId = insertChatMessage(convId, "assistant", "回复");
    insertChatAgentEvent(msgId, "tool_use", { name: "grep_docs" }, traceId);
    writeSpan({ traceId, spanType: "tool_call", name: "grep_docs", startedAt: Date.now(), durationMs: 5 });

    const db = openFinanceDatabase(dbPath);
    const evt = db.prepare("SELECT trace_id FROM chat_agent_events WHERE message_id = ?").get(msgId) as { trace_id: string | null };
    equal(evt.trace_id, traceId, "agent event 应携带 trace_id");
    const joined = db.prepare(
      "SELECT COUNT(*) AS c FROM chat_agent_events e JOIN agent_spans s ON e.trace_id = s.trace_id WHERE e.message_id = ?"
    ).get(msgId) as { c: number };
    ok(joined.c >= 1, "event 应能通过 trace_id 直接 join 到 span");
    db.close();
    cleanup();
  }

  // ─── Status / token columns ─────────────────────────────

  {
    const db = setupMemoryDb();
    const traceId = randomUUID();
    db.prepare(`
      INSERT INTO agent_traces (trace_id, started_at, total_ms, user_message, final_answer, role_mode, llm_call_count)
      VALUES (?, datetime('now'), 1200, '测试问题', '测试回答', 'tech', 1)
    `).run(traceId);
    const row = db.prepare("SELECT status FROM agent_traces WHERE trace_id = ?").get(traceId) as { status: string };
    equal(row.status, "ok", "status should default to ok");
    db.close();
  }

  {
    const db = setupMemoryDb();
    const traceId = randomUUID();
    db.prepare(`
      INSERT INTO agent_traces (trace_id, started_at, total_ms, status, user_message, final_answer, role_mode, input_tokens, output_tokens, llm_call_count)
      VALUES (?, datetime('now'), 3000, 'ok', '问题', '回答', 'tech', 1500, 800, 1)
    `).run(traceId);
    const row = db.prepare("SELECT input_tokens, output_tokens FROM agent_traces WHERE trace_id = ?").get(traceId) as { input_tokens: number; output_tokens: number };
    equal(row.input_tokens, 1500);
    equal(row.output_tokens, 800);
    db.close();
  }

  {
    const db = setupMemoryDb();
    const traceId = randomUUID();
    const usage = { "claude-sonnet-4-6": { inputTokens: 500, outputTokens: 200, cacheReadInputTokens: 100, cacheCreationInputTokens: 0, webSearchRequests: 0, costUSD: 0.0045, contextWindow: 200000, maxOutputTokens: 8192 } };
    db.prepare(`
      INSERT INTO agent_traces (trace_id, started_at, total_ms, status, user_message, final_answer, role_mode, model_usage_json, total_cost_usd, llm_call_count)
      VALUES (?, datetime('now'), 3000, 'ok', 'cost test', 'reply', 'tech', ?, 0.0045, 1)
    `).run(traceId, JSON.stringify(usage));
    const row = db.prepare("SELECT model_usage_json, total_cost_usd FROM agent_traces WHERE trace_id = ?").get(traceId) as { model_usage_json: string; total_cost_usd: number };
    equal(row.total_cost_usd, 0.0045);
    const parsed = JSON.parse(row.model_usage_json);
    equal(parsed["claude-sonnet-4-6"].inputTokens, 500);
    db.close();
  }

  // ─── Old traces (NULL new columns) ──────────────────────

  {
    const db = setupMemoryDb();
    const traceId = randomUUID();
    db.prepare(`
      INSERT INTO agent_traces (trace_id, started_at, total_ms, tool_call_count)
      VALUES (?, datetime('now'), 2000, 3)
    `).run(traceId);
    const row = db.prepare(`
      SELECT user_message, final_answer, status, role_mode, input_tokens, output_tokens, total_cost_usd
      FROM agent_traces WHERE trace_id = ?
    `).get(traceId) as Record<string, unknown>;
    equal(row.user_message, null);
    equal(row.final_answer, null);
    equal(row.role_mode, null);
    equal(row.input_tokens, null);
    equal(row.output_tokens, null);
    equal(row.total_cost_usd, null);
    db.close();
  }

  // ─── listChatMessages 批量 agent_events 归并回归 ──────────
  {
    useTempDb();
    const convId = createChatConversation("归并测试");
    const msgIdA = insertChatMessage(convId, "user", "消息A");
    const msgIdB = insertChatMessage(convId, "assistant", "消息B");
    insertChatAgentEvent(msgIdA, "text", { content: "A-事件1" });
    insertChatAgentEvent(msgIdA, "text", { content: "A-事件2" });
    insertChatAgentEvent(msgIdB, "tool_use", { name: "grep_docs" });
    insertChatAgentEvent(msgIdB, "tool_result", { content: "结果" });

    const messages = listChatMessages(convId);
    equal(messages.length, 2, "应返回 2 条消息");

    const msgA = messages.find((m) => m.id === msgIdA);
    const msgB = messages.find((m) => m.id === msgIdB);
    ok(msgA, "消息A 应存在");
    ok(msgB, "消息B 应存在");
    equal((msgA!.agentEvents ?? []).length, 2, "消息A 应有 2 个事件");
    equal((msgB!.agentEvents ?? []).length, 2, "消息B 应有 2 个事件");
    ok(
      (msgA!.agentEvents ?? []).every((e) => !(msgB!.agentEvents ?? []).some((be) => be.id === e.id)),
      "消息A 的事件不应出现在消息B 中"
    );
    cleanup();
  }

  console.log("observability tests passed");
}

export const observabilityTestPromise = main();
