/**
 * 遥测上报器。
 *
 * 红线 7 合规驻留:只传白名单指标,绝不传会话内容/财务数据/PII。
 * 红线 8 审计落点:出网动作落 audit_logs(installId/endpoint/条数/时间)。
 *
 * 设计:
 * - 开关默认关,关则直接 return。
 * - 节流:每个 installId 每天最多一次,只传 lastReportedAt 之后的增量。
 * - 失败静默吞掉,绝不阻塞启动。
 */

import os from "node:os";
import { getDb, insertAuditLog, getAppSetting, setAppSetting, getFeatureEventRows } from "@/lib/db/sqlite";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import { buildEnvelope } from "@/lib/telemetry/projection";
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

/** 更新 lastReportedAt 并记录本次批次大小到 DB(供设置页展示)。 */
function markReported(count: number): void {
  const now = Date.now();
  try {
    setAppSetting(SETTING_LAST_REPORTED_AT, String(now));
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
function resolveEndpointToken(settings: Awaited<ReturnType<typeof readClaudeSettings>>): {
  endpoint: string;
  token: string;
} {
  const endpoint = (process.env.TELEMETRY_ENDPOINT ?? "").trim() || settings.telemetryEndpoint.trim();
  const token = (process.env.TELEMETRY_TOKEN ?? "").trim() || settings.telemetryToken.trim();
  return { endpoint, token };
}

export async function runTelemetryReport(): Promise<void> {
  try {
    const settings = await readClaudeSettings();
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
    const envelope = buildEnvelope({
      installId: settings.telemetryInstallId,
      appVersion: getAppVersion(),
      platform: { os: os.platform(), arch: os.arch() },
      window: { from: windowFrom, to: windowTo },
      traceRows,
      spansByTraceId,
      appErrorRows: appErrorRows.length > 0 ? (appErrorRows as Record<string, unknown>[]) : undefined,
      feedbackRows: feedbackRows.length > 0 ? feedbackRows : undefined,
      featureRows: featureRows.length > 0 ? featureRows : undefined,
    });

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

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${resolvedToken}`,
        "X-Schema-Version": String(envelope.schemaVersion),
      },
      body: JSON.stringify(envelope),
    });

    if (res.ok) {
      markReported(traceRows.length);
      // 把 appErrors 标为已上报(增量,别重发)。
      if (appErrorRows.length > 0) {
        markAppErrorsReported(appErrorRows.map((r) => r.id));
      }
      // 落成功审计。
      insertAuditLog("telemetry:report_success", {
        installId: settings.telemetryInstallId,
        endpoint: url,
        traceCount: traceRows.length,
        appErrorCount: appErrorRows.length,
        status: res.status,
        isExternal: true,
      });
    } else {
      // 失败:静默,记审计(供回溯)。
      insertAuditLog("telemetry:report_failed", {
        installId: settings.telemetryInstallId,
        endpoint: url,
        traceCount: traceRows.length,
        status: res.status,
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
  const settings = await readClaudeSettings();
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

  // 构造 envelope
  const windowFrom = sevenDaysAgo;
  const windowTo = Date.now();
  const envelope = buildEnvelope({
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
      body: JSON.stringify(envelope),
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
