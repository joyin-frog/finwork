/**
 * 遥测上报器。
 *
 * 红线 7 合规驻留:只传白名单指标,绝不传会话内容/财务数据/PII。
 * 红线 8 审计落点:出网动作落 audit_logs(installId/endpoint/条数/时间)。
 *
 * 设计:
 * - 开关默认关,关则直接 return。
 * - 节流:每个 installId 每天最多一次,只传 lastReportedAt 之后的增量。
 * - 体积防线:组包后按字节预算自动缩批(接收端 /api/ingest 上限 1 MiB);
 *   413 对半缩批重试,429 按 retryAfterMs 延后重试一次。缩批时水位线只推进
 *   到已发送数据的时间戳,漏发部分下次继续(接收端幂等,重发不翻倍)。
 * - 失败静默吞掉,绝不阻塞启动。
 */

import os from "node:os";
import { getDb, insertAuditLog, getAppSetting, setAppSetting, getFeatureEventRows } from "@/lib/db/sqlite";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import { buildEnvelope, type TelemetryEnvelope } from "@/lib/telemetry/projection";
import { fetchUnreportedAppErrors, markAppErrorsReported } from "@/lib/runtime/app-errors";

// package.json version 在 build 时注入;fallback 用 "0.0.0"。
function getAppVersion(): string {
  try {
    // Next.js server 端可读 package.json
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return "0.0.0";
  }
}

const SETTING_LAST_REPORTED_AT = "telemetry:lastReportedAt";
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

/** 从 DB 取 lastReportedAt(epoch ms),未上报过则返回 0。 */
function getLastReportedAt(): number {
  try {
    const v = getAppSetting(SETTING_LAST_REPORTED_AT);
    return v ? Number(v) : 0;
  } catch {
    return 0;
  }
}

/** 更新 lastReportedAt 并记录本次批次大小到 DB(供设置页展示)。缩批时传入已发送数据的时间戳。 */
function markReported(count: number, at: number = Date.now()): void {
  try {
    setAppSetting(SETTING_LAST_REPORTED_AT, String(at));
    setAppSetting("telemetry:lastReportedCount", String(count));
  } catch {
    // best-effort
  }
}

/** 从 agent_traces / agent_spans 取增量数据。 */
function fetchIncrementalData(sinceMs: number): {
  traceRows: Record<string, unknown>[];
  spansByTraceId: Map<string, Record<string, unknown>[]>;
} {
  const db = getDb();
  const sinceIso = new Date(sinceMs).toISOString();

  const traceRows = db.prepare(`
    SELECT trace_id, conversation_id, started_at, total_ms, status,
           role_mode, model_used, router_path, num_turns, llm_call_count,
           tool_call_count, input_tokens, output_tokens, cache_read_tokens,
           cache_creation_tokens, total_cost_usd, error_message, model_usage_json
    FROM agent_traces
    WHERE started_at > ?
    ORDER BY started_at ASC
    LIMIT 500
  `).all(sinceIso) as Record<string, unknown>[];

  const spansByTraceId = new Map<string, Record<string, unknown>[]>();
  if (traceRows.length > 0) {
    const traceIds = traceRows.map((t) => t.trace_id as string);
    const placeholders = traceIds.map(() => "?").join(", ");
    const spanRows = db.prepare(`
      SELECT trace_id, span_type, name, started_at, duration_ms, tokens, error
      FROM agent_spans
      WHERE trace_id IN (${placeholders})
      ORDER BY started_at ASC
    `).all(...traceIds) as Record<string, unknown>[];

    for (const span of spanRows) {
      const tid = span.trace_id as string;
      if (!spansByTraceId.has(tid)) spansByTraceId.set(tid, []);
      spansByTraceId.get(tid)!.push(span);
    }
  }

  return { traceRows, spansByTraceId };
}

/**
 * 取增量 chat_feedback(updated_at > since)。
 * 红线 7:只 SELECT 结构化列,**绝不读 reason**(纵深防御,从源头不取出自由文本)。
 */
function fetchIncrementalFeedback(sinceMs: number): Record<string, unknown>[] {
  const db = getDb();
  const sinceIso = new Date(sinceMs).toISOString();
  return db.prepare(`
    SELECT id, message_id, trace_id, rating, updated_at
    FROM chat_feedback
    WHERE updated_at > ?
    ORDER BY updated_at ASC
    LIMIT 500
  `).all(sinceIso) as Record<string, unknown>[];
}

// ─── 体积预算 + 413/429 恢复 ─────────────────────────────────────────────────

/** 接收端 /api/ingest 请求体上限 1 MiB(INGEST_MAX_BODY_BYTES 默认值);留余量防边界误差。 */
export const MAX_BODY_BYTES = 900 * 1024;
const MAX_413_RETRIES = 4;
const MAX_RETRY_AFTER_MS = 60_000;
const DEFAULT_RETRY_AFTER_MS = 5_000;

type EnvelopeParams = Parameters<typeof buildEnvelope>[0];

export type BoundedEnvelope = {
  envelope: TelemetryEnvelope;
  body: string;
  traceRows: Record<string, unknown>[];
  appErrorRows: Record<string, unknown>[];
  feedbackRows: Record<string, unknown>[];
  /** 单条超限降级:已剥掉 spans 组包(防毒丸堵队列,见 buildBoundedEnvelope)。 */
  spansDropped: boolean;
};

/** 按当前批次行数重新组包(featureRows 极小,永不缩);dropSpans 时剥掉全部 spans。 */
function buildWith(
  params: EnvelopeParams,
  rows: Pick<BoundedEnvelope, "traceRows" | "appErrorRows" | "feedbackRows">,
  dropSpans = false,
): BoundedEnvelope {
  const envelope = buildEnvelope({
    ...params,
    spansByTraceId: dropSpans ? new Map() : params.spansByTraceId,
    traceRows: rows.traceRows,
    appErrorRows: rows.appErrorRows.length > 0 ? rows.appErrorRows : undefined,
    feedbackRows: rows.feedbackRows.length > 0 ? rows.feedbackRows : undefined,
  });
  return {
    envelope,
    body: JSON.stringify(envelope),
    // 注意别 spread rows:halveRows 传入的对象可能携带旧的 envelope/body
    traceRows: rows.traceRows,
    appErrorRows: rows.appErrorRows,
    feedbackRows: rows.feedbackRows,
    spansDropped: dropSpans,
  };
}

/** 对半缩批,优先砍大头 traces;全部缩到 1 条仍超限则返回 null(交给调用方放弃)。 */
function halveRows(
  rows: Pick<BoundedEnvelope, "traceRows" | "appErrorRows" | "feedbackRows">,
): Pick<BoundedEnvelope, "traceRows" | "appErrorRows" | "feedbackRows"> | null {
  if (rows.traceRows.length > 1) {
    return { ...rows, traceRows: rows.traceRows.slice(0, Math.floor(rows.traceRows.length / 2)) };
  }
  if (rows.appErrorRows.length > 1) {
    return { ...rows, appErrorRows: rows.appErrorRows.slice(0, Math.floor(rows.appErrorRows.length / 2)) };
  }
  if (rows.feedbackRows.length > 1) {
    return { ...rows, feedbackRows: rows.feedbackRows.slice(0, Math.floor(rows.feedbackRows.length / 2)) };
  }
  return null;
}

/**
 * 组包并保证 body ≤ maxBytes:超限时按 traces → appErrors → feedback 顺序对半缩批。
 * 行序是时间升序,保留前半 = 保留最旧的,配合水位线让漏发部分下次继续。
 *
 * 毒丸防护:缩到单条仍超限(典型是一条 trace 挂了海量 spans)时剥掉 spans 降级
 * 组包——剥完只剩定长标量(errorMessage ≤200、modelUsageJson ≤2KB),必然进预算。
 * 该条照常发送、水位线照常推进,不会永远堵在队头。
 */
export function buildBoundedEnvelope(params: EnvelopeParams, maxBytes: number = MAX_BODY_BYTES): BoundedEnvelope {
  let rows: Pick<BoundedEnvelope, "traceRows" | "appErrorRows" | "feedbackRows"> = {
    traceRows: params.traceRows,
    appErrorRows: params.appErrorRows ?? [],
    feedbackRows: params.feedbackRows ?? [],
  };
  let dropSpans = false;
  for (;;) {
    const bounded = buildWith(params, rows, dropSpans);
    if (Buffer.byteLength(bounded.body, "utf8") <= maxBytes) return bounded;
    const shrunk = halveRows(rows);
    if (shrunk) {
      rows = shrunk;
      continue;
    }
    if (!dropSpans) {
      dropSpans = true; // 单条仍超限:剥 spans 降级再试
      continue;
    }
    return bounded; // 纯标量仍超限(理论不可达):照发,交给接收端裁决
  }
}

/** 解析 429 响应体里的 retryAfterMs(接收端返回 { error: "rate_limited", retryAfterMs })。 */
export function parseRetryAfterMs(bodyText: string): number | null {
  try {
    const v = (JSON.parse(bodyText) as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

export type SendOutcome = {
  ok: boolean;
  status: number | null;
  attempts: number;
  sent: BoundedEnvelope;
};

/**
 * 发送 envelope,带两类恢复(可注入 fetch/sleep 供单测):
 * - 413:对半缩批立即重试,最多 MAX_413_RETRIES 次
 * - 429:读响应 retryAfterMs(封顶 60s,缺省 5s)等待后重试一次
 * 其余非 2xx / 网络错误不在此吞,由调用方兜底。
 */
export async function sendEnvelopeWithRecovery(opts: {
  url: string;
  token: string;
  params: EnvelopeParams;
  maxBytes?: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): Promise<SendOutcome> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxBytes = opts.maxBytes ?? MAX_BODY_BYTES;

  let bounded = buildBoundedEnvelope(opts.params, maxBytes);
  let retries413 = 0;
  let retried429 = false;
  let attempts = 0;

  for (;;) {
    attempts++;
    const res = await fetchImpl(opts.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${opts.token}`,
        "X-Schema-Version": String(bounded.envelope.schemaVersion),
      },
      body: bounded.body,
    });

    if (res.ok) return { ok: true, status: res.status, attempts, sent: bounded };

    if (res.status === 413 && retries413 < MAX_413_RETRIES) {
      const shrunk = halveRows(bounded);
      if (shrunk) {
        retries413++;
        bounded = buildWith(opts.params, shrunk, bounded.spansDropped);
        continue;
      }
      if (!bounded.spansDropped) {
        // 单条仍被 413:剥 spans 降级重试,防毒丸堵死队列
        retries413++;
        bounded = buildWith(opts.params, bounded, true);
        continue;
      }
    }

    if (res.status === 429 && !retried429) {
      retried429 = true;
      const retryAfterMs = parseRetryAfterMs(await res.text().catch(() => ""));
      await sleep(Math.min(retryAfterMs ?? DEFAULT_RETRY_AFTER_MS, MAX_RETRY_AFTER_MS));
      continue;
    }

    return { ok: false, status: res.status, attempts, sent: bounded };
  }
}

/** 已发送批次里最后一条的时间戳(升序取末尾),供缩批后回退水位线。 */
function lastRowEpochMs(rows: Record<string, unknown>[], column: string): number | null {
  if (rows.length === 0) return null;
  const v = rows[rows.length - 1][column];
  if (v == null) return null;
  const ms = typeof v === "number" ? v : new Date(String(v)).getTime();
  return isNaN(ms) ? null : ms;
}

/**
 * 运行一次遥测上报。
 * - 开关关闭 → 直接 return(无副作用)。
 * - 同一 installId 今天已上报 → 跳过(节流)。
 * - 失败静默吞掉,不抛。
 */
/**
 * 解析最终使用的 endpoint/token:优先读编译期内置 env(§17.1),退回用户设置。
 * 绝不经 NEXT_PUBLIC_,绝不进客户端 JS(reporter 纯服务端)。
 */
function resolveEndpointToken(settings: Awaited<ReturnType<typeof readAgentSettings>>): {
  endpoint: string;
  token: string;
} {
  const endpoint = (process.env.TELEMETRY_ENDPOINT ?? "").trim() || settings.telemetryEndpoint.trim();
  const token = (process.env.TELEMETRY_TOKEN ?? "").trim() || settings.telemetryToken.trim();
  return { endpoint, token };
}

export async function runTelemetryReport(): Promise<void> {
  try {
    const settings = await readAgentSettings();
    if (!settings.telemetryEnabled) return;
    const { endpoint: resolvedEndpoint, token: resolvedToken } = resolveEndpointToken(settings);
    if (!resolvedEndpoint) return;

    // 节流:今天已上报过?
    const lastReportedAt = getLastReportedAt();
    if (Date.now() - lastReportedAt < ONE_DAY_MS) return;

    const { traceRows, spansByTraceId } = fetchIncrementalData(lastReportedAt);
    const appErrorRows = fetchUnreportedAppErrors(200);
    const feedbackRows = fetchIncrementalFeedback(lastReportedAt);
    const featureRows = getFeatureEventRows();

    if (traceRows.length === 0 && appErrorRows.length === 0 && feedbackRows.length === 0 && featureRows.length === 0) {
      // 无增量也要推进 lastReportedAt,避免每次都扫全表。
      markReported(0);
      return;
    }

    const windowFrom = lastReportedAt;
    const windowTo = Date.now();

    // 接收端是 Next.js 应用,ingest 路由在 /api/ingest;endpoint 配基址即可。
    const url = `${resolvedEndpoint.replace(/\/+$/, "")}/api/ingest`;

    // 红线 8 审计落点:出网前落日志。
    insertAuditLog("telemetry:report_attempt", {
      installId: settings.telemetryInstallId,
      endpoint: url,
      traceCount: traceRows.length,
      windowFrom,
      windowTo,
      isExternal: true,
    });

    const outcome = await sendEnvelopeWithRecovery({
      url,
      token: resolvedToken,
      params: {
        installId: settings.telemetryInstallId,
        appVersion: getAppVersion(),
        platform: { os: os.platform(), arch: os.arch() },
        window: { from: windowFrom, to: windowTo },
        traceRows,
        spansByTraceId,
        appErrorRows: appErrorRows.length > 0 ? (appErrorRows as Record<string, unknown>[]) : undefined,
        feedbackRows: feedbackRows.length > 0 ? feedbackRows : undefined,
        featureRows: featureRows.length > 0 ? featureRows : undefined,
      },
    });

    if (outcome.ok) {
      const sent = outcome.sent;
      // 缩批过 → 水位线只推进到已发送数据的最后时间戳,漏发部分下次继续
      //(traces 按 started_at、feedback 按 updated_at,取更早者;接收端幂等,重发无害)。
      const watermarks: number[] = [];
      if (sent.traceRows.length < traceRows.length) {
        const ts = lastRowEpochMs(sent.traceRows, "started_at");
        if (ts != null) watermarks.push(ts);
      }
      if (sent.feedbackRows.length < feedbackRows.length) {
        const ts = lastRowEpochMs(sent.feedbackRows, "updated_at");
        if (ts != null) watermarks.push(ts);
      }
      markReported(sent.traceRows.length, watermarks.length > 0 ? Math.min(...watermarks) : undefined);
      // 把已发送的 appErrors 标为已上报(增量,别重发;缩批漏发的下次再报)。
      if (sent.appErrorRows.length > 0) {
        markAppErrorsReported(sent.appErrorRows.map((r) => r.id as number));
      }
      // 落成功审计。
      insertAuditLog("telemetry:report_success", {
        installId: settings.telemetryInstallId,
        endpoint: url,
        traceCount: sent.traceRows.length,
        appErrorCount: sent.appErrorRows.length,
        attempts: outcome.attempts,
        shrunk: sent.traceRows.length < traceRows.length,
        status: outcome.status,
        isExternal: true,
      });
    } else {
      // 失败:静默,记审计(供回溯)。水位线不推进,下次启动重试。
      insertAuditLog("telemetry:report_failed", {
        installId: settings.telemetryInstallId,
        endpoint: url,
        traceCount: traceRows.length,
        attempts: outcome.attempts,
        status: outcome.status,
        isExternal: true,
      });
    }
  } catch {
    // 任何错误静默吞掉,绝不阻塞启动。
  }
}

// ─── 强制测试上报(纯只读,可重复) ────────────────────────────────────────────

export type TestReportResult =
  | { ok: false; reason: string }
  | {
      ok: true;
      status: number;
      traceCount: number;
      appErrorCount: number;
      endpoint: string;
    }
  | {
      ok: false;
      status?: number;
      traceCount: number;
      appErrorCount: number;
      endpoint: string;
      error: string;
    };

/**
 * 强制测试上报——跳过每日节流、不推进 lastReportedAt、不标 reported。
 * 供设置页「立即上报(测试)」按钮调用;接收端按 (installId,traceId)/(installId,ts,fingerprint) 幂等去重。
 * 红线 8:出网仍落 audit_logs(isExternal=true)。
 */
export async function runTelemetryTestReport(): Promise<TestReportResult> {
  const settings = await readAgentSettings();
  if (!settings.telemetryEnabled) {
    return { ok: false, reason: "未启用或未配置 endpoint" };
  }
  const { endpoint: resolvedEndpoint, token: resolvedToken } = resolveEndpointToken(settings);
  if (!resolvedEndpoint) {
    return { ok: false, reason: "未启用或未配置 endpoint" };
  }

  // 取近 7 天 traces(不看 lastReportedAt)
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
  const { traceRows, spansByTraceId } = fetchIncrementalData(sevenDaysAgo);

  // 取近 7 天 app_errors(不看 reported 标志)
  const db = getDb();
  const appErrorRows = db.prepare(`
    SELECT id, ts, kind, source, message, stack, app_version, fingerprint
    FROM app_errors
    WHERE ts > ?
    ORDER BY ts ASC
    LIMIT 200
  `).all(sevenDaysAgo) as Record<string, unknown>[];

  // 取近 7 天 chat_feedback(只结构化列,不读 reason)
  const feedbackRows = db.prepare(`
    SELECT id, message_id, trace_id, rating, updated_at
    FROM chat_feedback
    WHERE updated_at > ?
    ORDER BY updated_at ASC
    LIMIT 200
  `).all(new Date(sevenDaysAgo).toISOString()) as Record<string, unknown>[];

  const featureRows = getFeatureEventRows();

  // 构造 envelope(同样过体积预算,超限自动缩批;诊断路径不做重试)
  const windowFrom = sevenDaysAgo;
  const windowTo = Date.now();
  const bounded = buildBoundedEnvelope({
    installId: settings.telemetryInstallId,
    appVersion: getAppVersion(),
    platform: { os: os.platform(), arch: os.arch() },
    window: { from: windowFrom, to: windowTo },
    traceRows,
    spansByTraceId,
    appErrorRows: appErrorRows.length > 0 ? appErrorRows : undefined,
    feedbackRows: feedbackRows.length > 0 ? feedbackRows : undefined,
    featureRows: featureRows.length > 0 ? featureRows : undefined,
  });
  const envelope = bounded.envelope;

  const url = `${resolvedEndpoint.replace(/\/+$/, "")}/api/ingest`;

  // 红线 8:出网前落审计
  insertAuditLog("telemetry:test_report", {
    installId: settings.telemetryInstallId,
    endpoint: url,
    traceCount: traceRows.length,
    appErrorCount: appErrorRows.length,
    windowFrom,
    windowTo,
    isExternal: true,
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resolvedToken}`,
        "X-Schema-Version": String(envelope.schemaVersion),
      },
      body: bounded.body,
    });

    if (res.ok) {
      insertAuditLog("telemetry:test_report_success", {
        installId: settings.telemetryInstallId,
        endpoint: url,
        traceCount: traceRows.length,
        appErrorCount: appErrorRows.length,
        status: res.status,
        isExternal: true,
      });
      return {
        ok: true,
        status: res.status,
        traceCount: traceRows.length,
        appErrorCount: appErrorRows.length,
        endpoint: resolvedEndpoint,
      };
    } else {
      insertAuditLog("telemetry:test_report_failed", {
        installId: settings.telemetryInstallId,
        endpoint: url,
        traceCount: traceRows.length,
        status: res.status,
        isExternal: true,
      });
      return {
        ok: false,
        status: res.status,
        traceCount: traceRows.length,
        appErrorCount: appErrorRows.length,
        endpoint: resolvedEndpoint,
        error: `接收端返回 ${res.status}`,
      };
    }
  } catch (err) {
    insertAuditLog("telemetry:test_report_error", {
      installId: settings.telemetryInstallId,
      endpoint: url,
      error: String(err),
      isExternal: true,
    });
    return {
      ok: false,
      traceCount: traceRows.length,
      appErrorCount: appErrorRows.length,
      endpoint: resolvedEndpoint,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 获取上报状态(供设置页展示)。 */
export function getTelemetryStatus(): { lastReportedAt: number; lastReportedCount: number } {
  try {
    const lastReportedAt = Number(getAppSetting(SETTING_LAST_REPORTED_AT) ?? "0");
    const lastReportedCount = Number(getAppSetting("telemetry:lastReportedCount") ?? "0");
    return { lastReportedAt, lastReportedCount };
  } catch {
    return { lastReportedAt: 0, lastReportedCount: 0 };
  }
}
