import assert from "node:assert/strict";
import { buildTurnSegments, coalesceTextEvent, extractThinkingText, thinkingViewState } from "../app/chat/turn-segments.ts";
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

  // ── T8: thinking 事件不进过程段(既不是 tools 也不是 text),末尾文本仍为答案 ──
  {
    const timeline: TimelineItem[] = [
      makeItem("thinking", { content: "用户想算个税,我先读制度。" }),
      makeItem("tool_use", { name: "Read", id: "tu-6" }),
      makeItem("tool_result", { toolUseId: "tu-6", content: "...制度..." }),
      makeItem("thinking", { content: "拿到税率表,套公式。" }),
      makeItem("text", { content: "个税为 1200 元。" }),
    ];
    const { processSegments, answerText } = buildTurnSegments(timeline);
    assert.equal(answerText, "个税为 1200 元。", "T8 FAIL: 末尾文本应为答案");
    assert.deepEqual(processSegments.map((s) => s.kind), ["tools"], "T8 FAIL: 只应有一个 tools 段");
    for (const seg of processSegments) {
      if (seg.kind === "tools") {
        for (const item of seg.items) {
          assert.notEqual(item.event.type, "thinking", "T8 FAIL: thinking 不应进 tools 段");
        }
      }
    }
  }

  // ── T9: extractThinkingText 按序拼接全部 thinking,空则返回 "" ──
  {
    assert.equal(extractThinkingText([]), "", "T9 FAIL: 无事件应返回空串");
    const noThink: TimelineItem[] = [makeItem("text", { content: "只有答案" })];
    assert.equal(extractThinkingText(noThink), "", "T9 FAIL: 无 thinking 应返回空串");
    const timeline: TimelineItem[] = [
      makeItem("thinking", { content: "第一段思考" }),
      makeItem("tool_use", { name: "Read", id: "tu-7" }),
      makeItem("thinking", { content: "第二段思考" }),
      makeItem("text", { content: "答案" }),
    ];
    assert.equal(
      extractThinkingText(timeline),
      "第一段思考\n\n第二段思考",
      "T9 FAIL: 应按序拼接 thinking,用空行分隔"
    );
    // 空白 thinking 段应被跳过
    const withBlank: TimelineItem[] = [
      makeItem("thinking", { content: "  " }),
      makeItem("thinking", { content: "实质思考" }),
    ];
    assert.equal(extractThinkingText(withBlank), "实质思考", "T9 FAIL: 空白 thinking 应跳过");
  }

  // ── T10: thinkingViewState —— 头部「正在思考/已思考 + 计时」的纯状态 ──
  {
    // 思考进行中(回合活跃 + 还没产出):正在思考 + 实时计时,不可展开
    const live = thinkingViewState({ isActive: true, hasOutput: false, hasText: false, durationMs: undefined, liveMs: 3000 });
    assert.deepEqual(live, { render: true, label: "正在思考", ms: 3000, expandable: false, active: true }, "T10 FAIL: 进行中状态");

    // 思考进行中但已有思考原文(可展开)
    const liveWithText = thinkingViewState({ isActive: true, hasOutput: false, hasText: true, durationMs: undefined, liveMs: 5000 });
    assert.equal(liveWithText.expandable, true, "T10 FAIL: 有原文应可展开");
    assert.equal(liveWithText.label, "正在思考", "T10 FAIL: 仍进行中");

    // 已产出(开始调工具/出答案)→ 已思考 + 定格时长,可展开
    const done = thinkingViewState({ isActive: true, hasOutput: true, hasText: true, durationMs: 8000, liveMs: 99999 });
    assert.deepEqual(done, { render: true, label: "已思考", ms: 8000, expandable: true, active: false }, "T10 FAIL: 已思考用定格时长");

    // 回合结束、重载(非活跃)→ 用持久化时长
    const reloaded = thinkingViewState({ isActive: false, hasOutput: true, hasText: true, durationMs: 12000, liveMs: 0 });
    assert.deepEqual(reloaded, { render: true, label: "已思考", ms: 12000, expandable: true, active: false }, "T10 FAIL: 重载用持久化时长");

    // 没有思考、也不在思考态 → 不渲染
    const none = thinkingViewState({ isActive: false, hasOutput: true, hasText: false, durationMs: undefined, liveMs: 0 });
    assert.equal(none.render, false, "T10 FAIL: 无思考不渲染");
  }

  console.log("turn-segments: all 11 checks passed ✓");
})();
