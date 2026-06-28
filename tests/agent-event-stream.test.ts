import assert from "node:assert/strict";
import {
  createToolEventTracker,
  extractStructuredContent,
  extractUserToolResults,
  stringifyToolResult
} from "../lib/agent/tool-event-tracker.ts";
import { createTimingHook } from "../lib/agent/hooks/built-in.ts";
import type { AfterHookContext } from "../lib/agent/hooks/types.ts";
import { isMeaningfulSystemEvent } from "../lib/agent/claude-adapter.ts";
import { shouldHideAgentEvent } from "../app/chat/chat-types.ts";

export const agentEventStreamTestPromise = (async () => {
  // ── AC5a: 内置工具(user 消息 tool_result 块)配对出完整结果 ──
  const tracker = createToolEventTracker();
  tracker.trackToolUse({ id: "tu-1", name: "Read", input: { file_path: "/tmp/a.xlsx" } });

  const userMessage = {
    message: {
      content: [
        { type: "text", text: "noise" },
        { type: "tool_result", tool_use_id: "tu-1", content: "文件内容", is_error: false }
      ]
    }
  };
  const blocks = extractUserToolResults(userMessage);
  assert.equal(blocks.length, 1, "AC5 FAIL: 应从 user 消息提取出 1 个 tool_result 块");

  const resolved = tracker.resolveToolResult(blocks[0]);
  assert.ok(resolved, "AC5 FAIL: 已登记的 tool_use 应配对成功");
  assert.equal(resolved!.name, "Read", "AC5 FAIL: 工具名应来自 tool_use 登记");
  assert.equal(resolved!.content, "文件内容");
  assert.equal(resolved!.isError, false);
  assert.ok(resolved!.durationMs >= 0, "AC5 FAIL: 应有耗时");
  assert.deepEqual(resolved!.input, { file_path: "/tmp/a.xlsx" }, "AC5 FAIL: input 应透传给 after-hooks");

  // ── AC5b: 同一 tool_use_id 两条通道重复出现只发一次 ──
  assert.equal(tracker.resolveToolResult(blocks[0]), null, "AC5 FAIL: 重复结果必须去重");

  // ── AC5c: 未登记的 tool_use_id(如 subagent 内部)跳过 ──
  assert.equal(tracker.resolveToolResult({ tool_use_id: "unknown" }), null, "AC5 FAIL: 未登记的调用应跳过");

  // ── AC5d: 错误结果保留 isError ──
  tracker.trackToolUse({ id: "tu-2", name: "Bash", input: { command: "ls" } });
  const errResolved = tracker.resolveToolResult({ tool_use_id: "tu-2", content: "command failed", is_error: true });
  assert.equal(errResolved!.isError, true, "AC5 FAIL: 失败结果必须保留错误状态");

  // ── AC5e: content 形状防御(string / text 块数组 / 缺失) ──
  assert.equal(stringifyToolResult("plain"), "plain");
  assert.equal(stringifyToolResult([{ type: "text", text: "a" }, { type: "text", text: "b" }]), "a\nb");
  assert.equal(stringifyToolResult(undefined), undefined);
  assert.equal(extractUserToolResults({ message: { content: "纯文本消息" } }).length, 0, "AC5 FAIL: 非数组 content 应安全返回空");
  assert.equal(extractUserToolResults({}).length, 0);

  // ── AC5f: structuredContent 透传(顶层 tool_use_result 优先) ──
  tracker.trackToolUse({ id: "tu-3", name: "mcp__finance_worker__calculate_payroll_batch", input: {} });
  const structured = tracker.resolveToolResult(
    { tool_use_id: "tu-3", content: "text 摘要" },
    { structuredContent: { results: [], totalTax: 0 } }
  );
  assert.deepEqual(structured!.structured, { results: [], totalTax: 0 }, "AC5 FAIL: structuredContent 应透传");
  assert.equal(extractStructuredContent({ other: 1 }, undefined), undefined, "AC5 FAIL: 无 structuredContent 应为 undefined");

  // ── AC6: timing hook 无内部栈,直接消费 durationMs ──
  const seen: Array<{ name: string; durationMs: number; isError: boolean }> = [];
  const timing = createTimingHook((name, durationMs, isError) => seen.push({ name, durationMs, isError }));
  assert.equal(timing.before, undefined, "AC6 FAIL: timing hook 不应再有 before 计时栈");
  await timing.after!({
    toolName: "Read",
    input: {},
    activeSkills: [],
    outputDir: "/tmp",
    result: "",
    isError: false,
    durationMs: 123
  } satisfies AfterHookContext);
  assert.deepEqual(seen, [{ name: "Read", durationMs: 123, isError: false }], "AC6 FAIL: 应直接上报 ctx.durationMs");

  // ── AC7: system 事件源头白名单(挡住 GPT 网关的 thinking_tokens 风暴) ──
  // 源头(claude-adapter)只转发白名单子类型,thinking_tokens/status/未知一律丢弃,不进 SSE/DB。
  assert.equal(isMeaningfulSystemEvent("compact_boundary"), true, "AC7 FAIL: compact_boundary 应放行");
  assert.equal(isMeaningfulSystemEvent("init"), true, "AC7 FAIL: init 应放行");
  assert.equal(isMeaningfulSystemEvent("thinking_tokens"), false, "AC7 FAIL: thinking_tokens 必须在源头丢弃");
  assert.equal(isMeaningfulSystemEvent("status"), false, "AC7 FAIL: status 应丢弃");
  assert.equal(isMeaningfulSystemEvent(undefined), false, "AC7 FAIL: 无 subtype 应丢弃");

  // ── AC8: 前端渲染白名单(净化已落库的历史 thinking_tokens) ──
  assert.equal(shouldHideAgentEvent({ type: "system", subtype: "thinking_tokens", message: "x" }), true, "AC8 FAIL: thinking_tokens 不应渲染");
  assert.equal(shouldHideAgentEvent({ type: "system", subtype: "init", message: "x" }), true, "AC8 FAIL: init 无展示价值,应隐藏");
  assert.equal(shouldHideAgentEvent({ type: "system", subtype: "compact_boundary", message: "x" }), false, "AC8 FAIL: 压缩事件应展示");
  assert.equal(shouldHideAgentEvent({ type: "tool_use", name: "Read" }), false, "AC8 FAIL: 非 system 事件不受影响");

  console.log("agent-event-stream: all 17 checks passed ✓");
})();
