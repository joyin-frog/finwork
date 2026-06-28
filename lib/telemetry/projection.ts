/**
 * 遥测投影:从 DB 原始 trace/span 数据按 §2 白名单投影出上报 envelope。
 *
 * 红线 7 合规驻留:严格白名单,绝不包含 user_message / final_answer /
 * input_summary / output_summary / 工具入参原文等任何会话或财务内容。
 * errorMessage / span.error 经 redact() + 截断 200 后才出现在 payload 里。
 */

import { randomUUID } from "node:crypto";
import { redact } from "@/lib/safety/pii";

// ─── 类型定义(与 spec §2 严格对齐) ───────────────────────────────────────────

export type SpanMetric = {
  spanType: string;
  name: string;
  startedAt: number;
  durationMs: number;
  tokens: number | null;
  error: string | null; // 已 redact + 截断
};

export type TraceMetric = {
  traceId: string;
  conversationId: string | null;
  startedAt: number;
  totalMs: number;
  status: string;
  roleMode: string | null;
  modelUsed: string | null;
  routerPath: string | null;
  numTurns: number | null;
  llmCallCount: number | null;
  toolCallCount: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cacheReadTokens: number | null;
  cacheCreationTokens: number | null;
  totalCostUsd: number | null;
  errorMessage: string | null; // 已 redact + 截断
  modelUsageJson: string | null;
  spans: SpanMetric[];
};

export type TelemetryWindow = {
  from: number;
  to: number;
};

/**
 * App 级错误指标(§16.4 白名单)。
 * 永不含原始会话/财务数据;message/stack 已在 recordAppError 时 redact+截断,
 * 出网前再过一遍(纵深防御)。
 */
export type AppErrorMetric = {
  ts: number;
  kind: "render" | "rejection" | "unhandled" | "api" | "server";
  source: string;      // 路由/组件名,截断 200
  message: string;     // redact + 截断 300
  stack: string | null; // redact + 截断 1000
  appVersion: string | null;
  fingerprint: string;
  count: number;       // 本地预聚合次数
};

/**
 * 质量反馈指标(§18.2 白名单,schemaVersion 3)。
 * 只传结构化分数 + 枚举标签,**永不含自由文本**(chat_feedback.reason 绝不投影)。
 */
export type FeedbackMetric = {
  feedbackId: string;
  ts: number;
  signal: string; // user_rating | task_outcome | self_eval | retry | regenerate(本版本仅 user_rating)
  traceId: string | null;
  conversationId: string | null;
  value: number; // user_rating: +1 / -1
  label: string; // thumbs_up | thumbs_down
  roleMode: string | null;
  routerPath: string | null;
  modelUsed: string | null;
  appVersion: string;
};

/** 功能触达指标(白名单计数,schemaVersion 4)——只名字+计数,绝无 PII。 */
export type FeatureEventMetric = {
  name: string;
  count: number;
  firstAt: number;
  lastAt: number;
  appVersion: string;
};

export type TelemetryEnvelope =
  | {
      schemaVersion: 1;
      installId: string;
      appVersion: string;
      platform: { os: string; arch: string };
      reportedAt: number;
      window: TelemetryWindow;
      traces: TraceMetric[];
    }
  | {
      schemaVersion: 2;
      installId: string;
      appVersion: string;
      platform: { os: string; arch: string };
      reportedAt: number;
      window: TelemetryWindow;
      traces: TraceMetric[];
      appErrors: AppErrorMetric[];
    }
  | {
      schemaVersion: 3;
      installId: string;
      appVersion: string;
      platform: { os: string; arch: string };
      reportedAt: number;
      window: TelemetryWindow;
      traces: TraceMetric[];
      appErrors: AppErrorMetric[];
      feedback: FeedbackMetric[];
    }
  | {
      schemaVersion: 4;
      installId: string;
      appVersion: string;
      platform: { os: string; arch: string };
      reportedAt: number;
      window: TelemetryWindow;
      traces: TraceMetric[];
      appErrors: AppErrorMetric[];
      feedback: FeedbackMetric[];
      featureEvents: FeatureEventMetric[];
    };

// ─── 黑名单 key(防回归测试深度遍历用) ───────────────────────────────────────

export const BLACKLIST_KEYS = new Set([
  "user_message",
  "userMessage",
  "final_answer",
  "finalAnswer",
  "input_summary",
  "inputSummary",
  "output_summary",
  "outputSummary",
  // §18.3 自由文本反馈,绝不外发
  "reason",
  "comment",
  "feedbackText",
  "feedback_text",
  "note",
  "correction",
  "userComment",
  "user_comment",
]);

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

function truncate(value: string | null | undefined, max: number): string | null {
  if (!value) return null;
  return value.length <= max ? value : value.slice(0, max - 1) + "…";
}

function safeRedactTruncate(value: unknown, max = 200): string | null {
  if (value == null) return null;
  const str = typeof value === "string" ? value : String(value);
  return truncate(redact(str), max);
}

function toNumber(v: unknown): number | null {
  if (v == null) return null;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function toInt(v: unknown): number | null {
  const n = toNumber(v);
  return n == null ? null : Math.round(n);
}

function toStr(v: unknown): string | null {
  if (v == null) return null;
  return String(v);
}

function toEpochMs(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === "number") return v;
  // SQLite ISO string → epoch ms
  const d = new Date(String(v));
  return isNaN(d.getTime()) ? 0 : d.getTime();
}

// ─── Span 投影 ────────────────────────────────────────────────────────────────

export function projectSpan(row: Record<string, unknown>): SpanMetric {
  return {
    spanType: toStr(row.span_type) ?? "unknown",
    name: truncate(toStr(row.name), 200) ?? "",
    startedAt: toEpochMs(row.started_at),
    durationMs: toInt(row.duration_ms) ?? 0,
    tokens: toInt(row.tokens),
    // 已在 writeSpan 时 redact;但出网前再过一遍(深度防御)
    error: safeRedactTruncate(row.error, 200),
  };
}

// ─── Trace 投影 ───────────────────────────────────────────────────────────────

export function projectTrace(
  row: Record<string, unknown>,
  spans: Record<string, unknown>[]
): TraceMetric {
  return {
    traceId: toStr(row.trace_id) ?? randomUUID(),
    conversationId: toStr(row.conversation_id),
    startedAt: toEpochMs(row.started_at),
    totalMs: toInt(row.total_ms) ?? 0,
    status: toStr(row.status) ?? "ok",
    roleMode: toStr(row.role_mode),
    modelUsed: toStr(row.model_used),
    routerPath: toStr(row.router_path),
    numTurns: toInt(row.num_turns),
    llmCallCount: toInt(row.llm_call_count),
    toolCallCount: toInt(row.tool_call_count),
    inputTokens: toInt(row.input_tokens),
    outputTokens: toInt(row.output_tokens),
    cacheReadTokens: toInt(row.cache_read_tokens),
    cacheCreationTokens: toInt(row.cache_creation_tokens),
    totalCostUsd: toNumber(row.total_cost_usd),
    errorMessage: safeRedactTruncate(row.error_message, 200),
    modelUsageJson: toStr(row.model_usage_json),
    spans: spans.map(projectSpan),
  };
}

// ─── AppError 投影 ────────────────────────────────────────────────────────────

/**
 * 把一条 app_errors 行投影成 AppErrorMetric。
 * message/stack 在 recordAppError 时已脱敏;出网前再过一遍(纵深防御)。
 */
export function projectAppError(row: Record<string, unknown>): AppErrorMetric {
  return {
    ts: typeof row.ts === "number" ? row.ts : Number(row.ts ?? 0),
    kind: (toStr(row.kind) ?? "unhandled") as AppErrorMetric["kind"],
    source: truncate(toStr(row.source), 200) ?? "",
    message: safeRedactTruncate(row.message, 300) ?? "",
    stack: safeRedactTruncate(row.stack, 1000),
    appVersion: toStr(row.app_version),
    fingerprint: toStr(row.fingerprint) ?? "",
    count: 1,
  };
}

// ─── Feedback 投影(§18,质量信号)──────────────────────────────────────────────

/**
 * 把一条 chat_feedback 行投影成 FeedbackMetric。
 * 红线 7:**绝不读 row.reason**(自由文本),只取结构化字段。
 */
export function projectFeedback(row: Record<string, unknown>, appVersion: string): FeedbackMetric {
  const rating = toStr(row.rating);
  const messageKey = toStr(row.message_id) ?? toStr(row.id) ?? randomUUID();
  return {
    feedbackId: `fb-${messageKey}`,
    ts: toEpochMs(row.updated_at ?? row.created_at),
    signal: "user_rating",
    traceId: toStr(row.trace_id),
    conversationId: null, // 本地数字会话 id ≠ 遥测 UUID,本版本不带
    value: rating === "up" ? 1 : rating === "down" ? -1 : 0,
    label: rating === "up" ? "thumbs_up" : "thumbs_down",
    roleMode: null,
    routerPath: null,
    modelUsed: null,
    appVersion,
  };
}

/** 把一条 feature_events 行投影成 FeatureEventMetric(仅名字+计数,白名单已在 record 时把关)。 */
export function projectFeatureEvent(row: Record<string, unknown>, appVersion: string): FeatureEventMetric {
  return {
    name: toStr(row.name) ?? "unknown",
    count: toInt(row.count) ?? 0,
    firstAt: toInt(row.first_at) ?? 0,
    lastAt: toInt(row.last_at) ?? 0,
    appVersion,
  };
}

// ─── Envelope 构造 ────────────────────────────────────────────────────────────

export function buildEnvelope(params: {
  installId: string;
  appVersion: string;
  platform: { os: string; arch: string };
  window: TelemetryWindow;
  traceRows: Record<string, unknown>[];
  spansByTraceId: Map<string, Record<string, unknown>[]>;
  appErrorRows?: Record<string, unknown>[];
  feedbackRows?: Record<string, unknown>[];
  featureRows?: Record<string, unknown>[];
}): TelemetryEnvelope {
  const { installId, appVersion, platform, window: win, traceRows, spansByTraceId, appErrorRows, feedbackRows, featureRows } = params;
  const traces = traceRows.map((t) =>
    projectTrace(t, spansByTraceId.get(toStr(t.trace_id) ?? "") ?? [])
  );
  const base = { installId, appVersion, platform, reportedAt: Date.now(), window: win, traces };

  // schemaVersion 4:含 featureEvents(同载 appErrors + feedback)
  if (featureRows && featureRows.length > 0) {
    return {
      schemaVersion: 4,
      ...base,
      appErrors: (appErrorRows ?? []).map(projectAppError),
      feedback: (feedbackRows ?? []).map((r) => projectFeedback(r, appVersion)),
      featureEvents: featureRows.map((r) => projectFeatureEvent(r, appVersion)),
    };
  }

  // schemaVersion 3:含 feedback(可同载 appErrors)
  if (feedbackRows && feedbackRows.length > 0) {
    return {
      schemaVersion: 3,
      ...base,
      appErrors: (appErrorRows ?? []).map(projectAppError),
      feedback: feedbackRows.map((r) => projectFeedback(r, appVersion)),
    };
  }

  if (appErrorRows && appErrorRows.length > 0) {
    return {
      schemaVersion: 2,
      ...base,
      appErrors: appErrorRows.map(projectAppError),
    };
  }

  return {
    schemaVersion: 1,
    ...base,
  };
}
