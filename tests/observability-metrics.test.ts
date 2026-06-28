import assert from "node:assert/strict";
import { initializeFinanceDatabase, openFinanceDatabase } from "../lib/db/sqlite.ts";
import {
  computeObservabilityMetrics,
  listTraces,
  countRecentTraces,
  getTrace,
  listSpansForTrace,
  exportTraces,
  exportSpansForTraces,
  listTracesForMetrics,
  getTraceTokenSummary,
  getToolEvents,
} from "../lib/observability/metrics.ts";

export const observabilityMetricsTestPromise = (async () => {
  const db = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-obs-metrics-${process.pid}.db`));

  // 种子:两种模型、含缓存读取、一条慢请求、num_turns 可平均
  const insert = db.prepare(`
    INSERT INTO agent_traces (
      trace_id, started_at, total_ms, status, model_used,
      input_tokens, output_tokens, cache_read_tokens, total_cost_usd, num_turns
    ) VALUES (?, datetime('now'), ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  // opus: 2 条,各 1000 input / 500 output;其中一条 cache_read 3000
  insert.run("t1", 2000, "ok", "claude-opus-4-8", 1000, 500, 3000, 0.05, 2);
  insert.run("t2", 4000, "slow", "claude-opus-4-8", 1000, 500, 0, 0.05, 4);
  // haiku: 1 条
  insert.run("t3", 1000, "ok", "claude-haiku-4-5", 500, 100, 0, 0.001, 3);
  // 错误 1 条(无模型 → unknown)
  insert.run("t4", 500, "error", null, 0, 0, 0, 0, null);

  const m = computeObservabilityMetrics(db, 7);

  // ── T1: 基础聚合 ────────────────────────────────────────────────────
  assert.equal(m.total_traces, 4);
  assert.equal(m.error_count, 1);
  assert.equal(m.slow_count, 1);
  assert.equal(m.total_input_tokens, 2500);
  assert.equal(m.total_output_tokens, 1100);

  // ── T2: 模型分布(按 traces 降序,unknown 兜底)────────────────────────
  assert.equal(m.model_usage.length, 3, `T2 FAIL: 应有 3 个模型分组,实际 ${JSON.stringify(m.model_usage)}`);
  assert.equal(m.model_usage[0].model, "claude-opus-4-8");
  assert.equal(m.model_usage[0].traces, 2);
  assert.equal(m.model_usage[0].tokens, 3000, "T2 FAIL: opus tokens = (1000+500)×2");
  assert.equal(m.model_usage[0].costUsd, 0.1);
  assert.ok(m.model_usage.some((u) => u.model === "unknown"), "T2 FAIL: 空模型应归入 unknown");

  // ── T3: 缓存命中率 = 3000 / (3000 + 2500) ≈ 0.545 ───────────────────
  assert.equal(m.cache_hit_rate, 0.545, `T3 FAIL: 实际 ${m.cache_hit_rate}`);

  // ── T4: 平均轮次(忽略 NULL):(2+4+3)/3 = 3 ──────────────────────────
  assert.equal(m.avg_turns, 3, `T4 FAIL: 实际 ${m.avg_turns}`);

  // ── T5: P95 耗时:4 条 × 0.95 = 第 4 条(升序)= 4000 ─────────────────
  assert.equal(m.p95_duration_ms, 4000, `T5 FAIL: 实际 ${m.p95_duration_ms}`);
  assert.equal(m.max_duration_ms, 4000);

  // ── T6: 空库不抛错、0 除保护 ─────────────────────────────────────────
  const emptyDb = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-obs-empty-${process.pid}.db`));
  const empty = computeObservabilityMetrics(emptyDb, 7);
  assert.equal(empty.total_traces, 0);
  assert.equal(empty.cache_hit_rate, 0);
  assert.equal(empty.p95_duration_ms, 0);
  // satisfaction 空库兜底
  assert.deepEqual(empty.satisfaction, { rated: 0, up: 0, down: 0 }, "T6 FAIL: 空库 satisfaction 应为 0/0/0");
  emptyDb.close();

  // ── T7: satisfaction 统计正确 ────────────────────────────────────────
  // 先关闭外键约束以便在隔离测试库中直接插入 feedback 数据
  db.exec("PRAGMA foreign_keys = OFF");
  db.prepare("INSERT INTO chat_feedback (message_id, conversation_id, rating) VALUES (9901, 999, 'up')").run();
  db.prepare("INSERT INTO chat_feedback (message_id, conversation_id, rating) VALUES (9902, 999, 'down')").run();
  db.exec("PRAGMA foreign_keys = ON");

  const m2 = computeObservabilityMetrics(db, 7);
  assert.equal(m2.satisfaction.rated, 2, "T7 FAIL: rated 应为 2");
  assert.equal(m2.satisfaction.up, 1, "T7 FAIL: up 应为 1");
  assert.equal(m2.satisfaction.down, 1, "T7 FAIL: down 应为 1");

  db.close();
  console.log("observability-metrics: all 7 checks passed ✓");
})();

// ── 新增:query-functions 单测 ─────────────────────────────────────────────────
export const observabilityQueryFunctionsTestPromise = (async () => {
  const db = initializeFinanceDatabase(openFinanceDatabase(`/tmp/finance-agent-obs-qf-${process.pid}.db`));

  // 关闭外键约束,便于测试库直接插 trace+span+event
  db.exec("PRAGMA foreign_keys = OFF");

  // 插入两条 7 天内的 trace、一条 10 天前(被过滤)
  db.prepare(`INSERT INTO agent_traces (trace_id, conversation_id, started_at, total_ms, status, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, num_turns)
    VALUES ('qf-t1', 10, datetime('now', '-1 days'), 1500, 'ok', 'claude-opus-4-8', 800, 400, 200, 50, 0.03, 2)`
  ).run();
  db.prepare(`INSERT INTO agent_traces (trace_id, conversation_id, started_at, total_ms, status, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, num_turns)
    VALUES ('qf-t2', 10, datetime('now', '-2 days'), 2000, 'ok', 'claude-haiku-4-5', 300, 100, 0, 0, 0.01, 1)`
  ).run();
  db.prepare(`INSERT INTO agent_traces (trace_id, conversation_id, started_at, total_ms, status, model_used, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, total_cost_usd, num_turns)
    VALUES ('qf-old', 10, datetime('now', '-10 days'), 500, 'ok', 'claude-haiku-4-5', 100, 50, 0, 0, 0.001, 1)`
  ).run();

  // 插入 spans for qf-t1
  db.prepare(`INSERT INTO agent_spans (id, trace_id, span_type, name, started_at, duration_ms) VALUES ('s1', 'qf-t1', 'tool_call', 'read_file', 1000, 50)`).run();
  db.prepare(`INSERT INTO agent_spans (id, trace_id, span_type, name, started_at, duration_ms) VALUES ('s2', 'qf-t1', 'llm', null, 1100, 300)`).run();

  // 插入 chat_agent_events for tools (message_id 用任意整数,外键已 OFF)
  db.prepare(`INSERT INTO chat_agent_events (message_id, event_type, payload, created_at) VALUES (1001, 'tool_result', '{"name":"write_file","durationMs":120,"isError":0}', datetime('now', '-1 hours'))`).run();
  db.prepare(`INSERT INTO chat_agent_events (message_id, event_type, payload, created_at) VALUES (1002, 'tool_result', '{"name":"write_file","durationMs":200,"isError":1}', datetime('now', '-2 hours'))`).run();
  db.prepare(`INSERT INTO chat_agent_events (message_id, event_type, payload, created_at) VALUES (1003, 'tool_result', '{"name":"read_file","durationMs":30,"isError":0}', datetime('now', '-3 hours'))`).run();

  // ── QF-T1: countRecentTraces — 7 天内 2 条 ──────────────────────────────
  const total = countRecentTraces(db);
  assert.equal(total, 2, `QF-T1 FAIL: countRecentTraces 应为 2,实际 ${total}`);

  // ── QF-T2: listTraces — 返回 limit/offset 正确 ──────────────────────────
  const page1 = listTraces(db, { limit: 1, offset: 0 });
  assert.equal(page1.length, 1, "QF-T2 FAIL: page1 应有 1 条");
  const page2 = listTraces(db, { limit: 10, offset: 0 });
  assert.equal(page2.length, 2, "QF-T2 FAIL: 全量应有 2 条");
  // 每行都有 feedback_rating 字段
  assert.ok("feedback_rating" in page2[0], "QF-T2 FAIL: 缺少 feedback_rating 字段");

  // ── QF-T3: getTrace — 存在 / 不存在 ─────────────────────────────────────
  const found = getTrace(db, "qf-t1");
  assert.ok(found !== undefined, "QF-T3 FAIL: qf-t1 应存在");
  assert.equal(found!.trace_id, "qf-t1");
  const missing = getTrace(db, "not-exist");
  assert.equal(missing, undefined, "QF-T3 FAIL: 不存在的 trace 应返回 undefined");

  // ── QF-T4: listSpansForTrace — 只返回该 trace 的 span ───────────────────
  const spans = listSpansForTrace(db, "qf-t1");
  assert.equal(spans.length, 2, `QF-T4 FAIL: qf-t1 应有 2 span,实际 ${spans.length}`);
  const noSpans = listSpansForTrace(db, "qf-t2");
  assert.equal(noSpans.length, 0, "QF-T4 FAIL: qf-t2 无 span");

  // ── QF-T5: exportTraces — 7 天内 ≤ 500 条 ──────────────────────────────
  const exported = exportTraces(db);
  assert.equal(exported.length, 2, `QF-T5 FAIL: exportTraces 应有 2 条(7d 内),实际 ${exported.length}`);

  // ── QF-T6: exportSpansForTraces ─────────────────────────────────────────
  const expTraceIds = exported.map((t) => t.trace_id as string);
  const expSpans = exportSpansForTraces(db, expTraceIds);
  assert.equal(expSpans.length, 2, `QF-T6 FAIL: exportSpansForTraces 应有 2 span,实际 ${expSpans.length}`);
  // 空列表不报错
  const emptySpans = exportSpansForTraces(db, []);
  assert.equal(emptySpans.length, 0, "QF-T6 FAIL: 空 traceIds 应返回空数组");

  // ── QF-T7: getTraceTokenSummary — total_prompt_tokens 来自 input_tokens ─
  const summary = getTraceTokenSummary(db, "-7 days");
  assert.equal(summary.total_requests, 2, `QF-T7 FAIL: total_requests 应为 2,实际 ${summary.total_requests}`);
  // qf-t1: input=800, qf-t2: input=300 → sum=1100
  assert.equal(summary.total_prompt_tokens, 1100, `QF-T7 FAIL: total_prompt_tokens 应为 1100,实际 ${summary.total_prompt_tokens}`);
  assert.equal(summary.total_completion_tokens, 500, `QF-T7 FAIL: total_completion_tokens 应为 500,实际 ${summary.total_completion_tokens}`);
  // response key名不变:total_prompt_tokens / total_completion_tokens
  assert.ok("total_prompt_tokens" in summary, "QF-T7 FAIL: 响应字段名必须是 total_prompt_tokens");
  assert.ok("total_completion_tokens" in summary, "QF-T7 FAIL: 响应字段名必须是 total_completion_tokens");

  // ── QF-T8: listTracesForMetrics ─────────────────────────────────────────
  const metricTraces = listTracesForMetrics(db, "-7 days");
  assert.equal(metricTraces.length, 2, `QF-T8 FAIL: listTracesForMetrics 应有 2 条,实际 ${metricTraces.length}`);

  // ── QF-T9: getToolEvents ─────────────────────────────────────────────────
  const toolEvents = getToolEvents(db, "-24 hours");
  assert.equal(toolEvents.length, 3, `QF-T9 FAIL: getToolEvents 应有 3 条,实际 ${toolEvents.length}`);
  const writeFileEvents = toolEvents.filter((e) => e.name === "write_file");
  assert.equal(writeFileEvents.length, 2, "QF-T9 FAIL: write_file 应有 2 条");

  db.exec("PRAGMA foreign_keys = ON");
  db.close();
  console.log("observability-query-functions: all 9 checks passed ✓");
})();
