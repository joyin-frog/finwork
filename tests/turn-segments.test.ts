import assert from "node:assert/strict";
import { buildTurnSegments, coalesceTextEvent } from "../app/chat/turn-segments.ts";
import type { TimelineItem } from "../app/components/tool-call-step.ts";

function makeItem(type: string, extra: Record<string, unknown> = {}, id?: string): TimelineItem {
  const itemId = id ?? `id-${Math.random().toString(36).slice(2)}`;
  return { id: itemId, event: { type, ...extra }, createdAt: Date.now() };
}

export const turnSegmentsTestPromise = (async () => {
  // ── T1: Empty timeline produces empty segments and empty answerText ──
  {
    const { processSegments, answerText } = buildTurnSegments([]);
    assert.equal(processSegments.length, 0, "T1 FAIL: empty timeline should have no segments");
    assert.equal(answerText, "", "T1 FAIL: empty timeline should have empty answerText");
  }

  // ── T2: Only tool events, no text — all go to processSegments, answerText empty ──
  {
    const timeline: TimelineItem[] = [
      makeItem("tool_use", { name: "Read", id: "tu-1" }),
      makeItem("tool_result", { toolUseId: "tu-1", content: "file contents" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "", "T2 FAIL: no text events should give empty answerText");
    assert.equal(processSegments.length, 1, "T2 FAIL: should have 1 tools segment");
    assert.equal(processSegments[0].kind, "tools", "T2 FAIL: segment should be tools kind");
  }

  // ── T3: Text after tools — text becomes answerText ──
  {
    const timeline: TimelineItem[] = [
      makeItem("tool_use", { name: "Read", id: "tu-1" }),
      makeItem("tool_result", { toolUseId: "tu-1", content: "file" }),
      makeItem("text", { content: "Here is my answer." }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "Here is my answer.", "T3 FAIL: last text with no tools after should be answerText");
    // tools should be in processSegments
    const toolSegs = processSegments.filter((s) => s.kind === "tools");
    assert.equal(toolSegs.length, 1, "T3 FAIL: should have 1 tools segment in process");
  }

  // ── T4: Text then tools then text — only last text after no more tools is answerText ──
  {
    const timeline: TimelineItem[] = [
      makeItem("text", { content: "Starting analysis..." }),
      makeItem("tool_use", { name: "Bash", id: "tu-2" }),
      makeItem("tool_result", { toolUseId: "tu-2", content: "ok" }),
      makeItem("text", { content: "Final answer here." }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "Final answer here.", "T4 FAIL: final text should be answerText");
    // Process should have text segment + tools segment in order
    assert.ok(processSegments.length >= 2, "T4 FAIL: should have process and tools segments");
    const textSegs = processSegments.filter((s) => s.kind === "text");
    assert.equal(textSegs.length, 1, "T4 FAIL: intermediate text should be in processSegments");
    if (textSegs[0].kind === "text") {
      assert.equal(textSegs[0].content, "Starting analysis...", "T4 FAIL: intermediate text content mismatch");
    }
  }

  // ── T5: Text then more tools after — text is NOT answerText ──
  {
    const timeline: TimelineItem[] = [
      makeItem("text", { content: "I will check this." }),
      makeItem("tool_use", { name: "Read", id: "tu-3" }),
      makeItem("tool_result", { toolUseId: "tu-3", content: "data" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "", "T5 FAIL: text followed by tools should not be answerText");
    // Both text and tools should be in processSegments
    const textSegs = processSegments.filter((s) => s.kind === "text");
    assert.equal(textSegs.length, 1, "T5 FAIL: text should be in processSegments");
  }

  // ── T6: 工具按真实顺序归并为一个 tools 段;ask_user 被排除在过程段外 ──
  {
    const timeline: TimelineItem[] = [
      makeItem("tool_use", { name: "read_expense_policy", id: "tu-4" }),
      makeItem("tool_result", { toolUseId: "tu-4", content: "...制度..." }),
      makeItem("tool_use", { name: "check_reimbursement_batch", id: "tu-5" }),
      makeItem("tool_result", { toolUseId: "tu-5", content: "...结果..." }),
      makeItem("ask_user", { questionId: "q1", question: { question: "?" } }),
      makeItem("text", { content: "核对完成。" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "核对完成。", "T6 FAIL: 末尾文本应为答案");
    assert.deepEqual(
      processSegments.map((s) => s.kind),
      ["tools"],
      "T6 FAIL: 工具应归并为一个 tools 段"
    );
    // ask_user 不应出现在任何 tools 段里
    for (const seg of processSegments) {
      if (seg.kind === "tools") {
        for (const item of seg.items) {
          assert.notEqual(item.event.type, "ask_user", "T6 FAIL: ask_user 不应进过程段");
        }
      }
    }
  }

  // ── T7: coalesceTextEvent merges consecutive text chunks ──
  {
    const events: Array<{ type: string; [key: string]: unknown }> = [];
    coalesceTextEvent(events, "Hello ");
    coalesceTextEvent(events, "world");
    assert.equal(events.length, 1, "T7 FAIL: consecutive text chunks should be merged");
    assert.equal((events[0] as { type: string; content: string }).content, "Hello world", "T7 FAIL: merged content mismatch");

    // After a non-text event, text should start a new event
    events.push({ type: "tool_use", name: "Read" });
    coalesceTextEvent(events, "After tool");
    assert.equal(events.length, 3, "T7 FAIL: text after tool_use should create new event");
    assert.equal((events[2] as { type: string; content: string }).content, "After tool", "T7 FAIL: new text event content mismatch");
  }

  // ── T8: thinking 按时序作为 thinking 段穿插进过程段,末尾文本仍为答案 ──
  {
    const timeline: TimelineItem[] = [
      makeItem("thinking", { content: "用户想算个税,我先读制度。" }),
      makeItem("tool_use", { name: "Read", id: "tu-6" }),
      makeItem("tool_result", { toolUseId: "tu-6", content: "...制度..." }),
      makeItem("thinking", { content: "拿到税率表,套公式。" }),
      makeItem("tool_use", { name: "run_python", id: "tu-6b" }),
      makeItem("tool_result", { toolUseId: "tu-6b", content: "1200" }),
      makeItem("text", { content: "个税为 1200 元。" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "个税为 1200 元。", "T8 FAIL: 末尾文本应为答案");
    assert.deepEqual(
      processSegments.map((s) => s.kind),
      ["thinking", "tools", "thinking", "tools"],
      "T8 FAIL: thinking 应按时序穿插在工具段之间"
    );
    const think = processSegments.filter((s) => s.kind === "thinking");
    assert.equal(think[0].kind === "thinking" && think[0].content, "用户想算个税,我先读制度。", "T8 FAIL: 第一段思考内容");
    assert.equal(think[1].kind === "thinking" && think[1].content, "拿到税率表,套公式。", "T8 FAIL: 第二段思考内容");
  }

  // ── T9: 连续 thinking 合并为一段(空行分隔);空白 thinking 跳过 ──
  {
    const timeline: TimelineItem[] = [
      makeItem("thinking", { content: "第一段思考" }),
      makeItem("thinking", { content: "第二段思考" }),
      makeItem("thinking", { content: "  " }),
      makeItem("tool_use", { name: "Read", id: "tu-7" }),
      makeItem("tool_result", { toolUseId: "tu-7", content: "ok" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "", "T9 FAIL: 无末尾文本");
    assert.deepEqual(processSegments.map((s) => s.kind), ["thinking", "tools"], "T9 FAIL: 连续 thinking 应合并为一段");
    const seg = processSegments[0];
    assert.equal(seg.kind === "thinking" && seg.content, "第一段思考\n\n第二段思考", "T9 FAIL: 合并用空行分隔且跳过空白段");

    // 纯空白 thinking 不产生段
    const blankOnly = buildTurnSegments([makeItem("thinking", { content: "   " })]);
    assert.equal(blankOnly.processSegments.length, 0, "T9 FAIL: 纯空白 thinking 不应产生段");
  }

  // ── T10: 答案前后的 thinking 不因答案被摘出而误合并成一段 ──
  {
    const timeline: TimelineItem[] = [
      makeItem("thinking", { content: "答前思考" }),
      makeItem("text", { content: "最终答案。" }),
      makeItem("thinking", { content: "答后思考" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "最终答案。", "T10 FAIL: 末尾文本应为答案");
    assert.deepEqual(
      processSegments.map((s) => s.kind),
      ["thinking", "thinking"],
      "T10 FAIL: 答案两侧的 thinking 应各自成段,不合并"
    );
    const [a, b] = processSegments;
    assert.equal(a.kind === "thinking" && a.content, "答前思考", "T10 FAIL: 第一段内容");
    assert.equal(b.kind === "thinking" && b.content, "答后思考", "T10 FAIL: 第二段内容");
  }

  console.log("turn-segments: all 10 checks passed ✓");
})();
