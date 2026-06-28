import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { redact } from "../lib/safety/pii";
import { buildRouterMessages } from "../lib/agent/router";

// #1 回归:PII 在「出网前(路由分类)」与「落盘前(agent_traces)」被脱敏。
// 注意:主模型出口刻意不脱敏(算税/对账需要真实号码),不在此测试范围。
export const safetyRedactionTestPromise = (async () => {
  const { ok } = assert;

  // ── T1: redact 覆盖身份证/手机/邮箱/银行卡 ─────────────────────
  {
    const out = redact("联系人13800138000,身份证11010119900307123X,卡号6222020200012345678,邮箱a@b.com");
    ok(!out.includes("13800138000"), "T1 FAIL: 手机号应脱敏");
    ok(!/11010119900307123X/i.test(out), "T1 FAIL: 身份证应脱敏");
    ok(!out.includes("6222020200012345678"), "T1 FAIL: 银行卡应脱敏");
    ok(!out.includes("a@b.com"), "T1 FAIL: 邮箱应脱敏");
    ok(out.includes("[已脱敏:手机号]"), "T1 FAIL: 应保留脱敏占位");
  }

  // ── T2: 路由分类 payload 出网前脱敏(分类端点不应看到原始 PII) ──
  {
    const msgs = buildRouterMessages([], "给13800138000报销500元,身份证11010119900307123X");
    const joined = msgs.map((m) => m.content).join("\n");
    ok(!joined.includes("13800138000"), "T2 FAIL: 路由 payload 不应含手机号");
    ok(!/11010119900307123X/i.test(joined), "T2 FAIL: 路由 payload 不应含身份证");
    ok(joined.includes("报销"), "T2 FAIL: 非 PII 文本应保留(意图分类不受影响)");
  }

  // ── T3: writeAgentTrace 落盘前脱敏(本地库不应明文存 PII) ───────
  {
    const tmpPath = path.join(os.tmpdir(), `fa-redact-trace-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = tmpPath;
    try {
      const { initializeFinanceDatabase, openFinanceDatabase } = await import("../lib/db/sqlite");
      initializeFinanceDatabase(openFinanceDatabase(tmpPath)).close();
      const { writeAgentTrace } = await import("../lib/observability/trace-write");
      const traceId = `redact-${Date.now()}`;
      writeAgentTrace({
        traceId,
        startedAt: Date.now() - 10,
        modelUsed: "m",
        routerPath: "main",
        errorMessage: null,
        userMessage: "我的手机是13800138000",
        finalAnswer: "卡号6222020200012345678",
        roleMode: "tech",
        toolCallCount: 0,
      });
      const db = openFinanceDatabase(tmpPath);
      const row = db
        .prepare("SELECT user_message, final_answer FROM agent_traces WHERE trace_id = ?")
        .get(traceId) as { user_message: string; final_answer: string } | undefined;
      db.close();
      ok(row, "T3 FAIL: trace 行应存在");
      ok(!row!.user_message.includes("13800138000"), "T3 FAIL: trace.user_message 应脱敏");
      ok(!row!.final_answer.includes("6222020200012345678"), "T3 FAIL: trace.final_answer 应脱敏");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  // ── T4: writeSpan 落盘前脱敏(agent_spans 不应明文存 PII) ──────────
  {
    const tmpPath = path.join(os.tmpdir(), `fa-redact-span-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = tmpPath;
    try {
      const { initializeFinanceDatabase, openFinanceDatabase } = await import("../lib/db/sqlite");
      initializeFinanceDatabase(openFinanceDatabase(tmpPath)).close();
      const { writeSpan } = await import("../lib/observability/spans");
      const traceId = `redact-span-${Date.now()}`;
      writeSpan({
        traceId,
        spanType: "tool_call",
        name: "calculate_payroll_batch",
        startedAt: Date.now(),
        durationMs: 1,
        inputSummary: "员工张三 卡号6222020200012345678",
        outputSummary: "手机13800138000",
      });
      const db = openFinanceDatabase(tmpPath);
      const row = db
        .prepare("SELECT input_summary, output_summary FROM agent_spans WHERE trace_id = ?")
        .get(traceId) as { input_summary: string; output_summary: string } | undefined;
      db.close();
      ok(row, "T4 FAIL: span 行应存在");
      ok(!row!.input_summary.includes("6222020200012345678"), "T4 FAIL: span.input_summary 应脱敏银行卡");
      ok(!row!.output_summary.includes("13800138000"), "T4 FAIL: span.output_summary 应脱敏手机号");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  // ── T5: writeAgentTrace errorMessage 落盘前脱敏 ────────────────────
  {
    const tmpPath = path.join(os.tmpdir(), `fa-redact-err-${process.pid}-${Date.now()}.db`);
    process.env.FINANCE_AGENT_DB_PATH = tmpPath;
    try {
      const { initializeFinanceDatabase, openFinanceDatabase } = await import("../lib/db/sqlite");
      initializeFinanceDatabase(openFinanceDatabase(tmpPath)).close();
      const { writeAgentTrace } = await import("../lib/observability/trace-write");
      const traceId = `redact-err-${Date.now()}`;
      writeAgentTrace({
        traceId,
        startedAt: Date.now() - 10,
        modelUsed: "m",
        routerPath: "main",
        errorMessage: "张三:卡号6222020200012345678 校验失败",
        userMessage: "test",
        finalAnswer: "",
        roleMode: "tech",
        toolCallCount: 0,
      });
      const db = openFinanceDatabase(tmpPath);
      const row = db
        .prepare("SELECT error_message FROM agent_traces WHERE trace_id = ?")
        .get(traceId) as { error_message: string } | undefined;
      db.close();
      ok(row, "T5 FAIL: trace 行应存在");
      ok(!row!.error_message.includes("6222020200012345678"), "T5 FAIL: trace.error_message 应脱敏银行卡");
    } finally {
      delete process.env.FINANCE_AGENT_DB_PATH;
      await fs.rm(tmpPath, { force: true }).catch(() => {});
    }
  }

  // ── T6: 分隔符格式卡号/手机/统一社会信用代码 ────────────────────────
  {
    const out = redact("卡号 6222 0202 0001 2345 678,手机 138-1234-5678,信用代码 91350100M000100Y43");
    ok(!out.includes("6222 0202 0001 2345 678"), "T6: 分隔卡号应脱敏");
    ok(!out.includes("138-1234-5678"), "T6: 分隔手机应脱敏");
    ok(!out.includes("91350100M000100Y43"), "T6: 统一社会信用代码应脱敏");
    const keep = redact("报销 500 元,共 3 张发票");
    ok(keep.includes("报销") && keep.includes("500"), "T6: 普通短数字不应被脱敏");
  }

  // ── T7: 观测导出路由已随 UI 删除(§12),数据采集层 lib/observability/* 保留 ──

  console.log("safety-redaction tests passed");
})();
