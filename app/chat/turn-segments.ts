/**
 * turn-segments.ts — 纯函数，将有序事件数组拆分为「过程段」与「最终回答」。
 *
 * 规则：
 * - 若最后一个 text 段之后再无 tool_use/tool_result 事件，该 text 段为最终回答
 *   (answerText)，其余为过程段；
 * - 否则 answerText 为空（全部都是过程，最终回答取 message.content）；
 * - 过程段保持真实时间顺序：thinking / text / ask_user 与工具按原序交错,连续工具(含 system)归并为
 *   一个 tools 段,连续 thinking 合并为一个 thinking 段(空行分隔、空白跳过);
 * - ask_user 进过程段(kind:"ask")按时序落点;ask_user_answered 不进段(答案由渲染侧查表)。
 * - 待答的 ask_user 仍由输入框上方浮层处理,过程区只渲染已答/超时摘要。
 */


/** Minimal timeline item shape needed for segment building. Compatible with both
 * the strict (chat-page) and loose (tool-call-step) TimelineItem types. */
export type SegmentTimelineItem = {
  id: string;
  event: { type: string; content?: string; [key: string]: unknown };
  createdAt: number;
};

export type ProcessSegment =
  | { kind: "text"; content: string; id: string }
  | { kind: "thinking"; content: string; id: string }
  | { kind: "tools"; items: SegmentTimelineItem[] }
  | { kind: "subagent"; label: string; items: SegmentTimelineItem[] }
  | { kind: "ask"; item: SegmentTimelineItem; questionId: string };

export type TurnSegments = {
  processSegments: ProcessSegment[];
  answerText: string;
};

/**
 * 答案气泡该显示什么。
 * - 有摘出的最终回答 → 用它
 * - 否则若 timeline 已有 text 段(过程旁白) → 空串,避免把 join("") 后的 message.content 再当答案粘成一坨
 * - 纯直答/无事件历史 → 回退 message.content
 */
export function resolveAnswerContent(
  answerText: string,
  hasTimelineText: boolean,
  messageContent: string,
): string {
  if (answerText.trim()) return answerText;
  if (hasTimelineText) return "";
  return messageContent;
}

/**
 * Coalesce a new text chunk into an event list (mutates in place).
 * If the last event is a {type:"text"}, appends content; otherwise pushes a new one.
 */
export function coalesceTextEvent(
  events: Array<{ type: string; [key: string]: unknown }>,
  content: string
): void {
  const last = events[events.length - 1];
  if (last?.type === "text") {
    (last as { type: string; content: string }).content += content;
  } else {
    events.push({ type: "text", content });
  }
}

export function buildTurnSegments(timeline: SegmentTimelineItem[]): TurnSegments {
  if (!timeline.length) return { processSegments: [], answerText: "" };

  // Find the last text item's index
  let lastTextIdx = -1;
  for (let i = timeline.length - 1; i >= 0; i--) {
    if (timeline[i].event.type === "text") {
      lastTextIdx = i;
      break;
    }
  }

  // Check if there are any tool events after the last text segment
  let toolAfterLastText = false;
  if (lastTextIdx >= 0) {
    for (let i = lastTextIdx + 1; i < timeline.length; i++) {
      const t = timeline[i].event.type;
      if (t === "tool_use" || t === "tool_result") {
        toolAfterLastText = true;
        break;
      }
    }
  }

  // Determine answer text: last text segment if no tools come after it
  let answerText = "";
  let answerIdx = -1;
  if (lastTextIdx >= 0 && !toolAfterLastText) {
    const lastTextEvent = timeline[lastTextIdx].event;
    answerText = lastTextEvent.type === "text" ? (lastTextEvent as { type: "text"; content: string }).content : "";
    answerIdx = lastTextIdx;
  }

  // 按真实顺序:text 成段;连续 thinking 合并为一个 thinking 段;连续工具(及 system)归并为一个 tools 段;
  // ask_user 单独成段并打断工具归并,落在真实时序位置。答案项(answerIdx)不进过程段。
  // ask_user_answered 不进段(渲染侧用 questionId 查答案)。
  const segments: ProcessSegment[] = [];
  let pendingTools: SegmentTimelineItem[] = [];
  // 摘出答案后其两侧的 thinking 会变相邻,但语义上是被答案隔开的两次思考 → 在摘出处打断合并链。
  let breakThinkingMerge = false;

  const flushTools = () => {
    if (pendingTools.length) {
      segments.push({ kind: "tools", items: pendingTools });
      pendingTools = [];
    }
  };

  for (let i = 0; i < timeline.length; i++) {
    const item = timeline[i];
    const type = item.event.type;
    if (i === answerIdx) {
      breakThinkingMerge = true;
      continue;
    }
    if (type === "ask_user_answered") continue;
    if (type === "ask_user") {
      flushTools();
      const questionId = typeof item.event.questionId === "string" ? item.event.questionId : item.id;
      segments.push({ kind: "ask", item, questionId });
      breakThinkingMerge = false;
      continue;
    }
    if (type === "text") {
      flushTools();
      const textEvent = item.event as { type: "text"; content: string };
      segments.push({ kind: "text", content: textEvent.content, id: item.id });
      breakThinkingMerge = false;
    } else if (type === "thinking") {
      const content = typeof item.event.content === "string" ? item.event.content.trim() : "";
      if (!content) continue;
      flushTools();
      const last = segments[segments.length - 1];
      if (last?.kind === "thinking" && !breakThinkingMerge) {
        last.content += "\n\n" + content;
      } else {
        segments.push({ kind: "thinking", content, id: item.id });
      }
      breakThinkingMerge = false;
    } else if (type === "subagent") {
      // subagent 事件：按 label 归并为子轨道段（不进工具段 catch-all）
      flushTools();
      const label = typeof item.event.label === "string" ? item.event.label : "";
      const last = segments[segments.length - 1];
      if (last?.kind === "subagent" && last.label === label) {
        last.items.push(item);
      } else {
        segments.push({ kind: "subagent", label, items: [item] });
      }
    } else {
      // tool_use / tool_result / system 归并为工具段
      pendingTools.push(item);
    }
  }
  flushTools();

  return { processSegments: segments, answerText };
}
