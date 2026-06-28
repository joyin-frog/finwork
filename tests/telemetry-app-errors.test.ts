/**
 * 防回归单测:App 级错误捕获 + schemaVersion 2 上报(§16)
 *
 * ① 含 appErrors 的 envelope 深度遍历无黑名单字段
 * ② stack/message 含身份证/银行卡样例被 redact
 * ③ schemaVersion 在有/无 appErrors 时分别为 2/1
 * ④ reported 标志推进正确(fetchUnreportedAppErrors → markAppErrorsReported)
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  buildEnvelope,
  projectAppError,
  BLACKLIST_KEYS,
} from "../lib/telemetry/projection";

const { ok, equal, strictEqual } = assert;

// ─── 深度遍历所有 key ─────────────────────────────────────────────────────────
function collectAllKeys(obj: unknown, keys = new Set<string>()): Set<string> {
  if (obj === null || typeof obj !== "object") return keys;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    keys.add(k);
    collectAllKeys(v, keys);
    if (Array.isArray(v)) {
      for (const item of v) collectAllKeys(item, keys);
    }
  }
  return keys;
}

async function main() {
  // ── T1: 含 appErrors 的 envelope 深度遍历无黑名单字段 ─────────────────────
  {
    const appErrorRow: Record<string, unknown> = {
      id: 1,
      ts: 1718805000000,
      kind: "render",
      source: "/chat",
      message: "Cannot read properties of undefined (reading 'x')",
      stack: "Error: Cannot read x\n  at Page (/chat:10:5)",
      app_version: "0.1.1",
      fingerprint: "ab12cd34ef56gh78",
      // 注入黑名单字段:投影必须完全剔除
      user_message: "这是用户消息",
      userMessage: "这是用户消息",
      final_answer: "这是最终答案",
      finalAnswer: "这是最终答案",
      input_summary: "输入摘要",
      inputSummary: "输入摘要",
      output_summary: "输出摘要",
      outputSummary: "输出摘要",
    };

    const envelope = buildEnvelope({
      installId: "11111111-1111-4111-8111-111111111111",
      appVersion: "0.1.1",
      platform: { os: "darwin", arch: "arm64" },
      window: { from: 1718236800000, to: 1718841600000 },
      traceRows: [],
      spansByTraceId: new Map(),
      appErrorRows: [appErrorRow],
    });

    const allKeys = collectAllKeys(envelope);
    for (const blackKey of BLACKLIST_KEYS) {
      ok(!allKeys.has(blackKey), `T1 FAIL: envelope 不应含黑名单 key "${blackKey}"`);
    }
    console.log("T1 passed: 含 appErrors 的 envelope 不含任何黑名单 key");
  }

  // ── T2: stack/message 含身份证/银行卡被 redact ────────────────────────────
  {
    const piiRow: Record<string, unknown> = {
      id: 2,
      ts: 1718805001000,
      kind: "api",
      source: "/api/payroll",
      message: "员工身份证11010119900307123X核验失败,银行卡6222020200012345678无效",
      stack: "Error: 身份证11010119900307123X\n  at check (/api/payroll:20:5)\n  6222020200012345678",
      app_version: "0.1.1",
      fingerprint: "deadbeef12345678",
    };

    const metric = projectAppError(piiRow);
    ok(!/11010119900307123X/i.test(metric.message), "T2 FAIL: message 身份证应被脱敏");
    ok(!/6222020200012345678/.test(metric.message), "T2 FAIL: message 银行卡应被脱敏");
    ok(!/11010119900307123X/i.test(metric.stack ?? ""), "T2 FAIL: stack 身份证应被脱敏");
    ok(!/6222020200012345678/.test(metric.stack ?? ""), "T2 FAIL: stack 银行卡应被脱敏");
    console.log("T2 passed: PII 在 appErrors 投影中被脱敏");
    console.log("  message:", metric.message.slice(0, 80));
  }

  // ── T3: schemaVersion 有/无 appErrors 时分别为 2/1 ───────────────────────
  {
    const baseParams = {
      installId: "11111111-1111-4111-8111-111111111111",
      appVersion: "0.1.1",
      platform: { os: "darwin", arch: "arm64" } as { os: string; arch: string },
      window: { from: 1718236800000, to: 1718841600000 },
      traceRows: [] as Record<string, unknown>[],
      spansByTraceId: new Map<string, Record<string, unknown>[]>(),
    };

    const envelopeV1 = buildEnvelope({ ...baseParams });
    strictEqual(envelopeV1.schemaVersion, 1, "T3 FAIL: 无 appErrors 时 schemaVersion 应为 1");

    const envelopeV2 = buildEnvelope({
      ...baseParams,
      appErrorRows: [
        {
          id: 3,
          ts: 1718805002000,
          kind: "render",
          source: "/chat",
          message: "Test error",
          stack: null,
          app_version: "0.1.1",
          fingerprint: "aabbccdd11223344",
        },
      ],
    });
    strictEqual(envelopeV2.schemaVersion, 2, "T3 FAIL: 有 appErrors 时 schemaVersion 应为 2");
    ok("appErrors" in envelopeV2, "T3 FAIL: v2 envelope 应含 appErrors 字段");
    equal((envelopeV2 as { appErrors: unknown[] }).appErrors.length, 1, "T3 FAIL: appErrors 应有 1 条");
    console.log("T3 passed: schemaVersion 在有/无 appErrors 时分别为 2/1");
  }

  // ── T4: reported 标志推进正确 ────────────────────────────────────────────
  {
    const tmpDir = mkdtempSync(join(tmpdir(), "app-errors-test-"));
    const dbPath = join(tmpDir, "test.db");
    process.env.FINANCE_AGENT_DB_PATH = dbPath;

    try {
      // 动态 import 后 DB 会初始化
      const { recordAppError, fetchUnreportedAppErrors, markAppErrorsReported } =
        await import("../lib/runtime/app-errors");

      // 写入 2 条错误
      recordAppError({ kind: "render", source: "/chat", message: "error A", stack: null });
      recordAppError({ kind: "api", source: "/api/test", message: "error B", stack: null });

      // 取未上报的(应有 2 条)
      const unreported = fetchUnreportedAppErrors(100);
      ok(unreported.length >= 2, `T4 FAIL: 应有 ≥2 条未上报,实际 ${unreported.length}`);

      // 标记前 1 条为已上报
      const firstId = unreported[0].id;
      markAppErrorsReported([firstId]);

      // 再取未上报的(应少 1 条)
      const afterMark = fetchUnreportedAppErrors(100);
      ok(
        afterMark.every((r) => r.id !== firstId),
        "T4 FAIL: 已标 reported 的记录不应再出现"
      );
      ok(afterMark.length >= 1, "T4 FAIL: 剩余未上报应 ≥1 条");

      console.log("T4 passed: reported 标志推进正确");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      try { rmSync(tmpDir, { recursive: true }); } catch { /* ok */ }
    }
  }

  console.log("telemetry-app-errors tests all passed");
}

export const telemetryAppErrorsTestPromise = main();
