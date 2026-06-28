/**
 * turn-segments.ts — 纯函数，将有序事件数组拆分为「过程段」与「最终回答」。
 *
 * 规则：
 * - 若最后一个 text 段之后再无 tool_use/tool_result 事件，该 text 段为最终回答
 *   (answerText)，其余为过程段；
 * - 否则 answerText 为空（全部都是过程，最终回答取 message.content）；
 * - 过程段保持真实时间顺序：text 与工具按原序交错,连续工具(含 system)归并为一个 tools 段;
 * - ask_user / ask_user_answered 不进过程段(走专门的交互卡片)。
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
  | { kind: "tools"; items: SegmentTimelineItem[] };

export type TurnSegments = {
  processSegments: ProcessSegment[];
  answerText: string;
};

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
  let processItems: SegmentTimelineItem[];
  if (lastTextIdx >= 0 && !toolAfterLastText) {
    const lastTextEvent = timeline[lastTextIdx].event;
    answerText = lastTextEvent.type === "text" ? (lastTextEvent as { type: "text"; content: string }).content : "";
    processItems = [...timeline.slice(0, lastTextIdx), ...timeline.slice(lastTextIdx + 1)];
  } else {
    processItems = timeline;
  }

  // ask_user 走专门的交互卡片渲染,不进过程段。
  const filtered = processItems.filter(
    (t) => t.event.type !== "ask_user" && t.event.type !== "ask_user_answered"
  );

  if (!filtered.length) return { processSegments: [], answerText };

  // 按真实顺序:text 成段;连续工具(及 system)归并为一个 tools 段。
  const segments: ProcessSegment[] = [];
  let pendingTools: SegmentTimelineItem[] = [];

  const flushTools = () => {
    if (pendingTools.length) {
      segments.push({ kind: "tools", items: pendingTools });
      pendingTools = [];
    }
  };

  for (const item of filtered) {
    const type = item.event.type;
    if (type === "text") {
      flushTools();
      const textEvent = item.event as { type: "text"; content: string };
      segments.push({ kind: "text", content: textEvent.content, id: item.id });
    } else {
      // tool_use / tool_result / system 归并为工具段
      pendingTools.push(item);
    }
  }
  flushTools();

  return { processSegments: segments, answerText };
}
