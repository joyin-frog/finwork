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

  console.log("turn-segments: all 8 checks passed ✓");
})();
