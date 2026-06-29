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

  // ask_user 走专门的交互卡片渲染、thinking 走专门的「思考过程」折叠块,都不进过程段。
  const filtered = processItems.filter(
    (t) => t.event.type !== "ask_user" && t.event.type !== "ask_user_answered" && t.event.type !== "thinking"
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

/**
 * 按时序拼接本回合所有 thinking 事件的文本(供「思考过程」折叠块展示)。
 * 跳过空白段;无 thinking 返回 ""。空行分隔多段,保留各段内部换行。
 */
/**
 * 「思考」头部的纯状态:决定显示「正在思考(实时计时)」还是「已思考(定格时长)」、是否渲染/可展开。
 * - 思考进行中 = 回合活跃且尚未产出任何工具/答案(产出一旦开始即视为思考结束)。
 * - ms:进行中用实时 liveMs;结束用定格/持久化 durationMs。
 * - 渲染条件:有思考原文,或正处于思考态(后者覆盖"刚起手还没出原文"的瞬间)。
 */
export function thinkingViewState(opts: {
  isActive: boolean;
  hasOutput: boolean;
  hasText: boolean;
  durationMs: number | undefined;
  liveMs: number;
}): { render: boolean; label: string; ms: number | undefined; expandable: boolean; active: boolean } {
  const active = opts.isActive && !opts.hasOutput;
  return {
    render: opts.hasText || active,
    label: active ? "正在思考" : "已思考",
    ms: active ? opts.liveMs : opts.durationMs,
    expandable: opts.hasText,
    active,
  };
}

export function extractThinkingText(timeline: SegmentTimelineItem[]): string {
  return timeline
    .filter((t) => t.event.type === "thinking")
    .map((t) => (typeof t.event.content === "string" ? t.event.content.trim() : ""))
    .filter(Boolean)
    .join("\n\n");
}
