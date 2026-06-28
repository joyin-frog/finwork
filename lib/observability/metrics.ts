// 观测面板聚合查询(开发视角:链路耗时/token/成本/模型路由/缓存)。
// 与 route 解耦:带 db 参数,可在临时库上单测。

import type { DatabaseSync } from "node:sqlite";

// ── traces/route ──────────────────────────────────────────────────────────────

const TRACE_SELECT = `
  SELECT at.trace_id, at.conversation_id, at.started_at, at.total_ms, at.status,
         at.user_message, at.final_answer, at.model_used, at.router_path,
         at.tool_call_count, at.input_tokens, at.output_tokens, at.total_cost_usd,
         at.llm_call_count, at.num_turns, at.role_mode, at.error_message,
         (SELECT cf.rating FROM chat_feedback cf
          WHERE cf.trace_id = at.trace_id
          ORDER BY cf.updated_at DESC LIMIT 1) AS feedback_rating
  FROM agent_traces at
`;

export function listTraces(db: DatabaseSync, opts: { limit: number; offset: number }): Array<Record<string, unknown>> {
  return db.prepare(`
    ${TRACE_SELECT}
    WHERE at.started_at >= datetime('now', '-7 days')
    ORDER BY at.started_at DESC
    LIMIT ? OFFSET ?
  `).all(opts.limit, opts.offset) as Array<Record<string, unknown>>;
}

export function countRecentTraces(db: DatabaseSync): number {
  const row = db.prepare(`
    SELECT COUNT(*) AS total FROM agent_traces
    WHERE started_at >= datetime('now', '-7 days')
  `).get() as { total: number };
  return row.total;
}

export function getTrace(db: DatabaseSync, traceId: string): Record<string, unknown> | undefined {
  return db.prepare(`${TRACE_SELECT} WHERE at.trace_id = ?`).get(traceId) as Record<string, unknown> | undefined;
}

// ── spans/route ───────────────────────────────────────────────────────────────

export function listSpansForTrace(db: DatabaseSync, traceId: string): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT id, span_type, name, started_at, duration_ms,
           input_summary, output_summary, tokens, error, metadata_json
    FROM agent_spans
    WHERE trace_id = ?
    ORDER BY started_at ASC
  `).all(traceId) as Array<Record<string, unknown>>;
}

// ── export/route ──────────────────────────────────────────────────────────────

export function exportTraces(db: DatabaseSync): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT trace_id, conversation_id, started_at, ended_at, total_ms,
           status, user_message, final_answer, model_used, router_path,
           tool_call_count, input_tokens, output_tokens, total_cost_usd,
           cache_read_tokens, cache_creation_tokens, llm_call_count,
           num_turns, role_mode, error_message, model_usage_json
    FROM agent_traces
    WHERE started_at >= datetime('now', '-7 days')
    ORDER BY started_at DESC
    LIMIT 500
  `).all() as Array<Record<string, unknown>>;
}

export function exportSpansForTraces(db: DatabaseSync, traceIds: string[]): Array<Record<string, unknown>> {
  if (traceIds.length === 0) return [];
  const placeholders = traceIds.map(() => "?").join(", ");
  return db.prepare(`
    SELECT trace_id, span_type, name, duration_ms, input_summary, output_summary, tokens, error
    FROM agent_spans
    WHERE trace_id IN (${placeholders})
    ORDER BY started_at ASC
  `).all(...traceIds) as Array<Record<string, unknown>>;
}

// ── metrics/traces/route ──────────────────────────────────────────────────────

export function listTracesForMetrics(db: DatabaseSync, since: string): Array<Record<string, unknown>> {
  return db.prepare(`
    SELECT * FROM agent_traces
    WHERE started_at >= datetime('now', ?)
    ORDER BY started_at DESC
    LIMIT 100
  `).all(since) as Array<Record<string, unknown>>;
}

export function getTraceTokenSummary(db: DatabaseSync, since: string): Record<string, unknown> {
  return db.prepare(`
    SELECT
      COUNT(*) AS total_requests,
      AVG(total_ms) AS avg_latency_ms,
      SUM(input_tokens) AS total_prompt_tokens,
      SUM(output_tokens) AS total_completion_tokens,
      SUM(cache_read_tokens) AS total_cache_read_tokens,
      SUM(cache_creation_tokens) AS total_cache_creation_tokens
    FROM agent_traces
    WHERE started_at >= datetime('now', ?)
  `).get(since) as Record<string, unknown>;
}

// ── metrics/tools/route ───────────────────────────────────────────────────────

export type ToolEventRow = {
  name: string;
  duration_ms: number | null;
  is_error: boolean | number | null;
};

export function getToolEvents(db: DatabaseSync, since: string): ToolEventRow[] {
  return db.prepare(`
    SELECT
      json_extract(payload, '$.name') AS name,
      CAST(json_extract(payload, '$.durationMs') AS REAL) AS duration_ms,
      json_extract(payload, '$.isError') AS is_error
    FROM chat_agent_events
    WHERE event_type = 'tool_result'
      AND created_at >= datetime('now', ?)
      AND json_extract(payload, '$.name') IS NOT NULL
  `).all(since) as ToolEventRow[];
}

export type ModelUsage = {
  model: string;
  traces: number;
  tokens: number;
  costUsd: number;
};

export type ObservabilityMetrics = {
  total_traces: number;
  avg_duration_ms: number;
  max_duration_ms: number;
  p95_duration_ms: number;
  avg_turns: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  /** 缓存读取 token 占比(cache_read / (cache_read + input)),prompt 缓存策略是否生效的直接信号 */
  cache_hit_rate: number;
  error_count: number;
  slow_count: number;
  tool_counts: Record<string, number>;
  model_usage: ModelUsage[];
  hourly_latency: Array<{ hour: string; avg_ms: number; count: number }>;
  satisfaction: { rated: number; up: number; down: number };
};

export function computeObservabilityMetrics(db: DatabaseSync, days: number): ObservabilityMetrics {
  const row = db.prepare(`
    SELECT
      COUNT(*) AS total_traces,
      COALESCE(AVG(total_ms), 0) AS avg_duration_ms,
      COALESCE(MAX(total_ms), 0) AS max_duration_ms,
      COALESCE(AVG(num_turns), 0) AS avg_turns,
      COALESCE(SUM(input_tokens), 0) AS total_input_tokens,
      COALESCE(SUM(output_tokens), 0) AS total_output_tokens,
      COALESCE(SUM(cache_read_tokens), 0) AS total_cache_read_tokens,
      COALESCE(SUM(total_cost_usd), 0) AS total_cost_usd,
      COALESCE(SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END), 0) AS error_count,
      COALESCE(SUM(CASE WHEN status = 'slow' THEN 1 ELSE 0 END), 0) AS slow_count
    FROM agent_traces
    WHERE started_at >= datetime('now', '-' || ? || ' days')
  `).get(days) as Record<string, number>;

  const durationCount = (db.prepare(`
    SELECT COUNT(*) AS n FROM agent_traces
    WHERE started_at >= datetime('now', '-' || ? || ' days') AND total_ms IS NOT NULL
  `).get(days) as { n: number }).n;
  const p95Row = durationCount > 0
    ? (db.prepare(`
        SELECT total_ms FROM agent_traces
        WHERE started_at >= datetime('now', '-' || ? || ' days') AND total_ms IS NOT NULL
        ORDER BY total_ms ASC
        LIMIT 1 OFFSET ?
      `).get(days, Math.max(0, Math.ceil(durationCount * 0.95) - 1)) as { total_ms: number })
    : undefined;

  const toolCounts = db.prepare(`
    SELECT name, COUNT(*) AS count
    FROM agent_spans
    WHERE span_type = 'tool_call'
      AND trace_id IN (
        SELECT trace_id FROM agent_traces
        WHERE started_at >= datetime('now', '-' || ? || ' days')
      )
    GROUP BY name
    ORDER BY count DESC
  `).all(days) as Array<{ name: string; count: number }>;

  // If no agent_spans data yet, fall back to chat_agent_events
  if (toolCounts.length === 0) {
    const fallback = db.prepare(`
      SELECT json_extract(payload, '$.name') AS name, COUNT(*) AS count
      FROM chat_agent_events
      WHERE event_type = 'tool_result'
        AND created_at >= datetime('now', '-' || ? || ' days')
      GROUP BY name
      ORDER BY count DESC
    `).all(days) as Array<{ name: string; count: number }>;
    toolCounts.push(...fallback);
  }

  const modelUsage = db.prepare(`
    SELECT
      COALESCE(model_used, 'unknown') AS model,
      COUNT(*) AS traces,
      COALESCE(SUM(COALESCE(input_tokens, 0) + COALESCE(output_tokens, 0)), 0) AS tokens,
      COALESCE(SUM(total_cost_usd), 0) AS cost_usd
    FROM agent_traces
    WHERE started_at >= datetime('now', '-' || ? || ' days')
    GROUP BY COALESCE(model_used, 'unknown')
    ORDER BY traces DESC
  `).all(days) as Array<{ model: string; traces: number; tokens: number; cost_usd: number }>;

  const hourlyLatency = db.prepare(`
    SELECT
      strftime('%Y-%m-%dT%H:00:00', started_at) AS hour,
      COALESCE(AVG(total_ms), 0) AS avg_ms,
      COUNT(*) AS count
    FROM agent_traces
    WHERE started_at >= datetime('now', '-24 hours')
    GROUP BY hour
    ORDER BY hour ASC
  `).all() as Array<{ hour: string; avg_ms: number; count: number }>;

  const satisfactionRow = db.prepare(`
    SELECT
      COUNT(*) AS rated,
      SUM(CASE WHEN rating = 'up' THEN 1 ELSE 0 END) AS up,
      SUM(CASE WHEN rating = 'down' THEN 1 ELSE 0 END) AS down
    FROM chat_feedback
    WHERE updated_at >= datetime('now', '-' || ? || ' days')
  `).get(days) as { rated: number; up: number; down: number };

  const cacheRead = row.total_cache_read_tokens;
  const cacheDenominator = cacheRead + row.total_input_tokens;

  return {
    total_traces: row.total_traces,
    avg_duration_ms: Math.round(row.avg_duration_ms),
    max_duration_ms: row.max_duration_ms,
    p95_duration_ms: p95Row?.total_ms ?? 0,
    avg_turns: Math.round(row.avg_turns * 10) / 10,
    total_input_tokens: row.total_input_tokens,
    total_output_tokens: row.total_output_tokens,
    total_cost_usd: Math.round(row.total_cost_usd * 10000) / 10000,
    cache_hit_rate: cacheDenominator > 0 ? Math.round((cacheRead / cacheDenominator) * 1000) / 1000 : 0,
    error_count: row.error_count,
    slow_count: row.slow_count,
    tool_counts: Object.fromEntries(toolCounts.map((t) => [t.name || "unknown", t.count])),
    model_usage: modelUsage.map((m) => ({
      model: m.model,
      traces: m.traces,
      tokens: m.tokens,
      costUsd: Math.round(m.cost_usd * 10000) / 10000
    })),
    hourly_latency: hourlyLatency,
    satisfaction: {
      rated: satisfactionRow?.rated ?? 0,
      up: satisfactionRow?.up ?? 0,
      down: satisfactionRow?.down ?? 0,
    },
  };
}
