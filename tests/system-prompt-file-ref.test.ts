import assert from "node:assert/strict";
import { buildSystemPromptParts } from "../lib/agent/system-prompt.ts";

// 文件产出/引用的静态规则集中在 SYSTEM_PROMPT.md；
// 仅本会话输出目录是动态的。断言最终发送给 Pi 的完整系统提示。
export const systemPromptFileRefTestPromise = (async () => {
  const full = buildSystemPromptParts({ outputDir: "/tmp/test-session/files/38/generate" }).join("\n");

  // ── 文件引用约束(静态,SYSTEM_PROMPT.md「生成文件与图表」)──────────────
  assert.ok(full.includes("只写文件名"), "T1 FAIL: 应含「只写文件名」文件引用约束");
  assert.ok(full.includes("sandbox:"), "T2 FAIL: 应提及并禁止 sandbox: scheme");
  assert.ok(full.includes("绝对路径"), "T3 FAIL: 应提及并禁止绝对路径");
  assert.ok(full.includes("百分号编码"), "T4 FAIL: 应提及并禁止 URL 百分号编码");
  assert.ok(full.includes("不要原地覆盖"), "T5 FAIL: 应含「不要原地覆盖输入文件」");

  // ── 文档处理和结构化统计走固定入口，不执行模型提供的任意 Python ──
  assert.ok(
    full.includes("必须") && /skill/i.test(full),
    "T6 FAIL: 文档处理应优先用对应 skill"
  );
  assert.ok(
    full.includes("不得执行模型提供的任意代码") && full.includes("analyze_tabular") && !full.includes("run_python"),
    "T6b FAIL: 应禁止任意代码执行并指向 analyze_tabular"
  );

  // ── 动态:本会话输出目录绝对路径注入 ────────────────────────────────────
  assert.ok(
    full.includes("/tmp/test-session/files/38/generate"),
    "T7 FAIL: 动态段应注入本会话输出目录的绝对路径"
  );

  console.log("system-prompt-file-ref: all 7 checks passed ✓");
})();
