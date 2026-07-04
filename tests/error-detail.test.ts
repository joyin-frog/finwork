import assert from "node:assert/strict";
import { cleanErrorDetail } from "../app/chat/error-detail.ts";

export const errorDetailTestPromise = (async () => {
  // ── E1: <tool_use_error> 包裹 — 剥壳 + headline = body = 内层文本 ──
  {
    const raw = "<tool_use_error>Unknown skill: finance-worker:scan_slip_folder</tool_use_error>";
    const { headline, body } = cleanErrorDetail(raw);
    assert.equal(headline, "Unknown skill: finance-worker:scan_slip_folder", "E1 FAIL: headline 应剥去 XML 包裹");
    assert.equal(body, "Unknown skill: finance-worker:scan_slip_folder", "E1 FAIL: body 应与 headline 相同（纯文本）");
  }

  // ── E2: MCP -32602 校验错误 — headline 提取首个 message 字段 ──
  {
    const validationPayload = JSON.stringify([
      {
        origin: "number",
        code: "too_big",
        maximum: 5,
        type: "number",
        inclusive: true,
        exact: false,
        message: "Too big: expected number to be <=5",
        path: ["topK"],
      },
    ], null, 2);
    const raw = `MCP error -32602: Input validation error: Invalid arguments for tool search_knowledge: ${validationPayload}`;
    const { headline, body } = cleanErrorDetail(raw);
    assert.ok(headline.includes("Too big: expected number to be <=5"), `E2 FAIL: headline 应含 message 字段内容，实际：${headline}`);
    // body 应为 pretty JSON
    assert.ok(body.includes('"Too big: expected number to be <=5"'), "E2 FAIL: body 应含 pretty-printed message");
    assert.ok(body.includes("\n"), "E2 FAIL: body 应为格式化 JSON（含换行）");
  }

  // ── E3: <tool_use_error> 包裹合法 JSON 字符串 — pretty-print ──
  {
    const inner = JSON.stringify({ error: "not_found", detail: "no such file" });
    const raw = `<tool_use_error>${inner}</tool_use_error>`;
    const { headline, body } = cleanErrorDetail(raw);
    // body 应为 pretty-printed
    assert.ok(body.includes("\n"), "E3 FAIL: body 应为格式化 JSON");
    assert.ok(body.includes('"not_found"'), "E3 FAIL: body 应含 JSON 字段");
  }

  // ── E4: <tool_use_error> 包裹 JSON 字符串（双重编码）──
  {
    // 有时内层是 JSON.stringify 后的字符串，即双引号包裹的 JSON 字符串
    const innerObj = { error: "permission_denied" };
    const doubleEncoded = `<tool_use_error>${JSON.stringify(JSON.stringify(innerObj))}</tool_use_error>`;
    const { body } = cleanErrorDetail(doubleEncoded);
    // body 应能看出 permission_denied（无论是 pretty JSON 还是原文）
    assert.ok(body.includes("permission_denied"), `E4 FAIL: body 应含 permission_denied，实际：${body}`);
  }

  // ── E5: 纯文本错误（无 XML 包裹，无 JSON）— headline = body = 原文 ──
  {
    const raw = "Connection timeout after 30s";
    const { headline, body } = cleanErrorDetail(raw);
    assert.equal(headline, "Connection timeout after 30s", "E5 FAIL: 纯文本 headline 应为原文");
    assert.equal(body, "Connection timeout after 30s", "E5 FAIL: 纯文本 body 应为原文");
  }

  // ── E6: 多个 message 字段时取首个 ──
  {
    const payload = JSON.stringify([
      { message: "First error message", path: ["a"] },
      { message: "Second error message", path: ["b"] },
    ], null, 2);
    const raw = `MCP error -32602: Input validation error: ${payload}`;
    const { headline } = cleanErrorDetail(raw);
    assert.ok(headline.includes("First error message"), `E6 FAIL: 应取首个 message，实际：${headline}`);
    assert.ok(!headline.includes("Second error message"), "E6 FAIL: headline 不应含第二个 message");
  }

  console.log("error-detail: all checks passed ✓");
})();
