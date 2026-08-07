/**
 * subagent-result-shape.test.ts
 *
 * 回归锁：spawn_subagent 曾返回「裸字符串」而非 MCP CallToolResult 形状
 * （{ content: [{ type:"text", text }] }），导致 SDK 把每次子代理调用标成 isError，
 * 主 Agent 误判失败、反复重派（3 件活派 7 次）。真机验证修复后 isError=false。
 *
 * 运行：FINANCE_AGENT_MOCK_AGENT=1 SKIP_LLM=true node --import tsx tests/subagent-result-shape.test.ts
 */

import assert from "node:assert/strict";
import path from "node:path";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const src = (rel: string) => readFileSync(path.join(ROOT, rel), "utf-8");

export const subagentResultShapeTestPromise = (async () => {
  // SR1: spawn_subagent 返回 CallToolResult 形状（content 数组），不是裸字符串
  {
    const s = src("lib/agent/mcp-tools/subagent.ts");
    assert.ok(
      /return\s*\{\s*content:\s*\[\{\s*type:\s*"text"/.test(s),
      "SR1 FAIL: spawn_subagent 应返回 { content: [{ type:\"text\", ... }] } 形状"
    );
    // 旧 bug：handler 以 `].join("\n");` 作为 return 收尾（裸字符串）——不得再出现在 return 处
    assert.ok(
      !/return\s*\[[\s\S]*?\]\.join\("\\n"\)\s*;/.test(s),
      "SR1 FAIL: spawn_subagent 不得再返回裸字符串（].join 直接 return）"
    );
    console.log("SR1: spawn_subagent 返回 content[] 形状 ✓");
  }

  console.log("subagent-result-shape: CallToolResult shape ✓");
})();
