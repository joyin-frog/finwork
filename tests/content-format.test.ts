import test from "node:test";
import assert from "node:assert/strict";
import { formatToolInput, formatToolOutput } from "../lib/agent/tools/content-format.ts";

test("content-format: input 按字段定语言", () => {
  assert.equal((formatToolInput("Bash", { command: "grep -n foo x.ts" }) as { lang: string }).lang, "bash");
  assert.equal((formatToolInput("mcp__finance__run_python", { code: "print(1)" }) as { lang: string }).lang, "python");
  assert.equal((formatToolInput("Grep", { pattern: "foo", glob: "*.ts" }) as { lang: string }).lang, "json");
});

test("content-format: output 区分语言与纯文本(grep 判断)", () => {
  // grep 命中行 = 纯文本,不上色
  assert.ok("plain" in formatToolOutput("Grep", "app/x.ts:42:  const a = 1"));
  // Bash stdout 纯文本
  assert.ok("plain" in formatToolOutput("Bash", "hello\nworld"));
  // MCP 工具返回 JSON → 高亮
  assert.equal((formatToolOutput("mcp__finance__x", '{"found":true}') as { lang: string }).lang, "json");
  // 非 JSON 文本 → 纯文本
  assert.ok("plain" in formatToolOutput("mcp__finance__x", "查不到该数据"));
});
console.log("content-format: all checks passed ✓");
