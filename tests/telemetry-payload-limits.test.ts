/**
 * 遥测体积防线单测:
 * ① modelUsageJson 超 2KB 置空(截断会破坏 JSON)
 * ② buildBoundedEnvelope 超预算自动对半缩批,body ≤ maxBytes
 * ③ sendEnvelopeWithRecovery:413 缩批重试后成功
 * ④ sendEnvelopeWithRecovery:429 读 retryAfterMs 延后重试一次
 * ⑤ 其他非 2xx 不重试,ok=false
 * ⑥ parseRetryAfterMs 解析
 */
import assert from "node:assert/strict";
import { projectTrace, MODEL_USAGE_JSON_MAX } from "../lib/telemetry/projection";
import {
  buildBoundedEnvelope,
  sendEnvelopeWithRecovery,
  parseRetryAfterMs,
} from "../lib/telemetry/reporter";

const { ok, equal } = assert;

function makeTraceRow(i: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trace_id: `aaaa1111-1111-4111-8111-${String(i).padStart(12, "0")}`,
    conversation_id: null,
    started_at: new Date(1700000000000 + i * 60_000).toISOString(),
    total_ms: 1000 + i,
    status: "ok",
    role_mode: "analyst",
    model_used: "claude-sonnet-4-6",
    router_path: "fast",
    num_turns: 2,
    llm_call_count: 1,
    tool_call_count: 3,
    input_tokens: 100,
    output_tokens: 50,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    total_cost_usd: 0.001,
    error_message: null,
    model_usage_json: '{"claude-sonnet-4-6":{"in":100,"out":50}}',
    ...extra,
  };
}

function baseParams(traceRows: Record<string, unknown>[]) {
  return {
    installId: "11111111-1111-4111-8111-111111111111",
    appVersion: "0.1.0",
    platform: { os: "darwin", arch: "arm64" },
    window: { from: 0, to: 1 },
    traceRows,
    spansByTraceId: new Map<string, Record<string, unknown>[]>(),
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

async function main() {
  // ── T1: modelUsageJson 超限置空,常规值原样保留 ─────────────────────────────
  {
    const small = projectTrace(makeTraceRow(1), []);
    equal(small.modelUsageJson, '{"claude-sonnet-4-6":{"in":100,"out":50}}');

    const fat = projectTrace(
      makeTraceRow(2, { model_usage_json: `{"x":"${"a".repeat(MODEL_USAGE_JSON_MAX + 100)}"}` }),
      [],
    );
    equal(fat.modelUsageJson, null);
    console.log("T1 passed: modelUsageJson ≤2KB 保留、超限置空");
  }

  // ── T2: buildBoundedEnvelope 超预算自动缩批 ────────────────────────────────
  {
    const rows = Array.from({ length: 64 }, (_, i) => makeTraceRow(i));
    const full = buildBoundedEnvelope(baseParams(rows));
    equal(full.traceRows.length, 64); // 默认预算下装得下,不缩

    const maxBytes = 4_000;
    const bounded = buildBoundedEnvelope(baseParams(rows), maxBytes);
    ok(bounded.traceRows.length < 64, "T2 FAIL: 超预算应缩批");
    ok(Buffer.byteLength(bounded.body, "utf8") <= maxBytes, "T2 FAIL: body 应 ≤ maxBytes");
    // 保留最旧的(升序前半),水位线语义才成立
    equal(bounded.traceRows[0].trace_id, rows[0].trace_id);
    // 缩批后仍是合法 envelope
    const parsed = JSON.parse(bounded.body) as { schemaVersion: number; traces: unknown[] };
    equal(parsed.traces.length, bounded.traceRows.length);
    console.log(`T2 passed: 64 条超预算缩到 ${bounded.traceRows.length} 条,body ≤ ${maxBytes}B`);
  }

  // ── T3: 413 → 对半缩批重试后成功 ───────────────────────────────────────────
  {
    const rows = Array.from({ length: 16 }, (_, i) => makeTraceRow(i));
    const bodySizes: number[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      const body = String(init?.body ?? "");
      bodySizes.push(body.length);
      const traces = (JSON.parse(body) as { traces: unknown[] }).traces;
      return traces.length > 4 ? jsonResponse(413, { error: "payload_too_large" }) : jsonResponse(200, { accepted: traces.length });
    }) as typeof fetch;

    const outcome = await sendEnvelopeWithRecovery({
      url: "https://example.test/api/ingest",
      token: "t",
      params: baseParams(rows),
      fetchImpl,
      sleep: async () => {},
    });
    ok(outcome.ok, "T3 FAIL: 缩批后应成功");
    equal(outcome.sent.traceRows.length, 4); // 16 → 8 → 4
    equal(outcome.attempts, 3);
    ok(bodySizes[1] < bodySizes[0] && bodySizes[2] < bodySizes[1], "T3 FAIL: 每次重试 body 应更小");
    console.log("T3 passed: 413 对半缩批(16→8→4)后成功");
  }

  // ── T4: 429 → 读 retryAfterMs 延后重试一次 ─────────────────────────────────
  {
    const sleeps: number[] = [];
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return calls === 1 ? jsonResponse(429, { error: "rate_limited", retryAfterMs: 1234 }) : jsonResponse(200, { accepted: 1 });
    }) as typeof fetch;

    const outcome = await sendEnvelopeWithRecovery({
      url: "https://example.test/api/ingest",
      token: "t",
      params: baseParams([makeTraceRow(1)]),
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    ok(outcome.ok, "T4 FAIL: 429 重试后应成功");
    equal(outcome.attempts, 2);
    assert.deepEqual(sleeps, [1234]);
    console.log("T4 passed: 429 按 retryAfterMs=1234 延后重试一次");
  }

  // ── T5: 其他非 2xx(500)不重试 ─────────────────────────────────────────────
  {
    let calls = 0;
    const fetchImpl = (async () => {
      calls++;
      return jsonResponse(500, { error: "boom" });
    }) as typeof fetch;

    const outcome = await sendEnvelopeWithRecovery({
      url: "https://example.test/api/ingest",
      token: "t",
      params: baseParams([makeTraceRow(1)]),
      fetchImpl,
      sleep: async () => {},
    });
    equal(outcome.ok, false);
    equal(outcome.status, 500);
    equal(calls, 1);
    console.log("T5 passed: 500 不重试,ok=false 交调用方兜底");
  }

  // ── T6: parseRetryAfterMs ─────────────────────────────────────────────────
  {
    equal(parseRetryAfterMs('{"error":"rate_limited","retryAfterMs":5000}'), 5000);
    equal(parseRetryAfterMs('{"error":"rate_limited"}'), null);
    equal(parseRetryAfterMs("not json"), null);
    equal(parseRetryAfterMs('{"retryAfterMs":-1}'), null);
    console.log("T6 passed: parseRetryAfterMs 解析与容错");
  }

  console.log("telemetry-payload-limits tests all passed");
}

export const telemetryPayloadLimitsTestPromise = main();
