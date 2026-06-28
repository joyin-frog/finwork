import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db/sqlite";
import { redact } from "@/lib/safety/pii";

export type SpanType = "memory" | "llm_call" | "tool_call" | "stream" | "router" | "compact" | "hook";

export type SpanInput = {
  traceId: string;
  spanType: SpanType;
  name: string;
  startedAt: number;
  durationMs: number;
  inputSummary?: string;
  outputSummary?: string;
  tokens?: number;
  error?: string;
  metadata?: Record<string, unknown>;
};

export function writeSpan(span: SpanInput): void {
  try {
    const db = getDb();
    db.prepare(`
      INSERT INTO agent_spans (id, trace_id, span_type, name, started_at, duration_ms, input_summary, output_summary, tokens, error, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      span.traceId,
      span.spanType,
      trancate(span.name, 200),
      span.startedAt,
      span.durationMs,
      trancate(span.inputSummary ? redact(span.inputSummary) : span.inputSummary, 200),
      trancate(span.outputSummary ? redact(span.outputSummary) : span.outputSummary, 200),
      span.tokens ?? null,
      span.error ? redact(span.error) : null,
      span.metadata ? JSON.stringify(span.metadata) : null,
    );
  } catch {
    // best-effort: span write failure must not affect the main flow
  }
}

function trancate(value: string | undefined | null, max: number): string | null {
  if (!value) return null;
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}
