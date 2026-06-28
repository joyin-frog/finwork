/**
 * App 级错误本地记录层(§16.3)。
 *
 * 红线 7 合规驻留:写入前 redact + 截断,堆栈常含文件路径/值,一律脱敏。
 * 红线 8 审计落点:通过 app_errors 表留存,随批次上报后标 reported=1。
 */

import { createHash } from "node:crypto";
import { redact } from "@/lib/safety/pii";

export type AppErrorKind = "render" | "rejection" | "unhandled" | "api" | "server";

export type AppErrorInput = {
  kind: AppErrorKind;
  source: string;
  message: string;
  stack?: string | null;
  appVersion?: string | null;
};

// ─── 内部工具 ─────────────────────────────────────────────────────────────────

function truncateStr(s: string | null | undefined, max: number): string {
  if (!s) return "";
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

function safeRedactTruncate(value: string | null | undefined, max: number): string {
  if (!value) return "";
  return truncateStr(redact(value), max);
}

/**
 * 归一化消息:去掉数字/UUID/哈希等动态段,让同类错误聚合成同一 fingerprint。
 * 只做粗略替换,保证可读性。
 */
function normalizeMessage(msg: string): string {
  return msg
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b\d{6,}\b/g, "<num>")
    .replace(/at\s+\S+:\d+:\d+/g, "at <loc>")
    .trim()
    .slice(0, 200);
}

function computeFingerprint(kind: AppErrorKind, message: string, source: string): string {
  const normalized = normalizeMessage(message);
  return createHash("sha256")
    .update(`${kind}::${normalized}::${source}`)
    .digest("hex")
    .slice(0, 16);
}

// ─── 核心函数 ─────────────────────────────────────────────────────────────────

/**
 * 记录一条 App 错误。
 * - 写入前 redact + 截断(message≤300, stack≤1000)。
 * - fingerprint = hash(kind + 归一化message + source)。
 * - best-effort:失败静默,不能因日志操作拖垮业务流程。
 */
export function recordAppError(input: AppErrorInput): void {
  try {
    // 动态 import db,避免在 Edge Runtime / 客户端被打包
    const { getDb } = require("@/lib/db/sqlite") as typeof import("@/lib/db/sqlite");
    const db = getDb();

    const message = safeRedactTruncate(input.message, 300);
    const stack = input.stack ? safeRedactTruncate(input.stack, 1000) : null;
    const source = truncateStr(input.source, 200);
    const fingerprint = computeFingerprint(input.kind, message, source);
    const ts = Date.now();

    db.prepare(`
      INSERT INTO app_errors (ts, kind, source, message, stack, app_version, fingerprint, reported)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0)
    `).run(ts, input.kind, source, message, stack, input.appVersion ?? null, fingerprint);
  } catch {
    // best-effort:记录失败不能抛
  }
}

/**
 * 取出未上报的 app_errors(reported=0),供 reporter 批次上传。
 * 上报成功后调用 markAppErrorsReported。
 */
export function fetchUnreportedAppErrors(limit = 200): Array<{
  id: number;
  ts: number;
  kind: AppErrorKind;
  source: string;
  message: string;
  stack: string | null;
  app_version: string | null;
  fingerprint: string;
}> {
  try {
    const { getDb } = require("@/lib/db/sqlite") as typeof import("@/lib/db/sqlite");
    const db = getDb();
    return db.prepare(`
      SELECT id, ts, kind, source, message, stack, app_version, fingerprint
      FROM app_errors
      WHERE reported = 0
      ORDER BY ts ASC
      LIMIT ?
    `).all(limit) as Array<{
      id: number;
      ts: number;
      kind: AppErrorKind;
      source: string;
      message: string;
      stack: string | null;
      app_version: string | null;
      fingerprint: string;
    }>;
  } catch {
    return [];
  }
}

/**
 * 上报成功后把这批 ids 的 reported 置 1(增量,别重发)。
 */
export function markAppErrorsReported(ids: number[]): void {
  if (ids.length === 0) return;
  try {
    const { getDb } = require("@/lib/db/sqlite") as typeof import("@/lib/db/sqlite");
    const db = getDb();
    const placeholders = ids.map(() => "?").join(",");
    db.prepare(`UPDATE app_errors SET reported = 1 WHERE id IN (${placeholders})`).run(...ids);
  } catch {
    // best-effort
  }
}
