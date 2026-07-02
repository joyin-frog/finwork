"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { readSSEStream, submitAgentRequest } from "@/app/chat/chat-request";
import { useNavState } from "@/app/shared/nav-state";
import { humanizeAgentError, type AgentErrorAction } from "@/lib/agent/agent-error";
import { shouldHideAgentEvent } from "@/app/chat/chat-types";
import type {
  AgentEvent,
  ChatAttachment,
  Conversation,
  GeneratedAttachment,
  Message,
  ReferencedFile,
  SkillRef,
  ModelTier
} from "@/app/chat/chat-types";

/** 与 chat-page 本地 TimelineItem 同构(event 用严格 AgentEvent 联合,便于 ask_user 等窄化)。 */
export type StreamTimelineItem = { id: string; event: AgentEvent; createdAt: number };

/**
 * 跨页存活的对话流式 store。
 *
 * 为什么需要它:流式态原本是 chat-page 组件的本地 state,一旦切到别的页面组件就卸载,
 * fetch 虽仍在后台跑(没有卸载 abort),但产生的 chunk/事件 setState 全打到已卸载组件被丢弃,
 * 切回来也只能从 DB 重新加载(而本回合要结束才整批落库)。
 *
 * 把"进行中回合"提到挂在 layout 的 Provider 里,按会话 key 持有累积态;chat-page 只是消费者:
 * 发送时调 startTurn,渲染时按当前会话 key 读 getTurn,切走切回继续渲染同一条流。
 */

export type TurnStatus = "streaming" | "done" | "error" | "stopped" | "incomplete";

export type StreamTurn = {
  /** 会话维度的 key:已有会话用 `c:${id}`,新会话用 `new:${uuid}`(落库拿到真实 id 后由 chat-page 收尾)。 */
  key: string;
  conversationId: number | null;
  status: TurnStatus;
  /** 本回合用户发出的消息(用于在历史之上叠加渲染)。 */
  userMessage: Message;
  /** 本回合之前的历史消息快照(发送时捕获),叠加渲染的基线。 */
  baseMessages: Message[];
  /** 已流式到的助手正文。 */
  streamedContent: string;
  timeline: StreamTimelineItem[];
  startedAt: number;
  /** 最终答案开始流出的时刻(首个 chunk);tool_result 到达会重置,用于"已处理 Xs"计时。 */
  processedEndedAt: number | null;
  generatedAttachments?: GeneratedAttachment[];
  finalConversation?: Conversation | null;
  /** 失败时:已人话化的错误说明(直接展示给用户,不含 raw 401/stack)。 */
  errorMessage?: string;
  /** 失败时的恢复动作类型,供 chat-page 决定弹"去配置"还是"重试"。 */
  errorAction?: AgentErrorAction;
};

export type StartTurnParams = {
  key: string;
  conversationId: number | null;
  userMessage: Message;
  baseMessages: Message[];
  requestMessages: Message[];
  attachments: ChatAttachment[];
  referencedAttachments: ReferencedFile[];
  /** 本条消息引用的技能(可选);发给后端作为"优先使用这些技能"的提示。 */
  referencedSkills?: SkillRef[];
  /** 本条消息的推理强度档位(可选,默认 auto)。 */
  modelTier?: ModelTier;
};

// ——— 纯 reducer:把单个流式事件并入回合态(便于单测,逻辑与原 chat-page 内联回调一致) ———

export function reduceChunk(turn: StreamTurn, chunk: string, now: number): StreamTurn {
  const timeline = [...turn.timeline];
  const last = timeline[timeline.length - 1];
  if (last?.event.type === "text") {
    const prevContent = (last.event as { type: "text"; content: string }).content;
    timeline[timeline.length - 1] = { ...last, event: { type: "text", content: prevContent + chunk } };
  } else {
    timeline.push({ id: crypto.randomUUID(), event: { type: "text", content: chunk }, createdAt: now });
  }
  return {
    ...turn,
    // 仅首个 chunk 记一次:最终答案开始流出的时刻
    processedEndedAt: turn.processedEndedAt ?? now,
    timeline,
    streamedContent: turn.streamedContent + chunk
  };
}

export function reduceAgentEvent(turn: StreamTurn, event: AgentEvent, now: number): StreamTurn {
  if (shouldHideAgentEvent(event)) return turn;
  return {
    ...turn,
    // 工具结果到达 → 重置计时,后续文本重新算"已处理"
    processedEndedAt: event.type === "tool_result" ? null : turn.processedEndedAt,
    timeline: [...turn.timeline, { id: crypto.randomUUID(), event, createdAt: now }]
  };
}

/**
 * 回合结束后,把服务端权威消息与本地流式正文合并成最终消息列表。
 * 优先用服务端 messages(含 agentEvents),但末条助手消息保留本地已流式的正文(避免丢字/不一致)。
 */
export function mergeFinalMessages(turn: StreamTurn): Message[] {
  const serverMessages = turn.finalConversation?.messages;
  if (serverMessages?.length) {
    const merged = [...serverMessages];
    const lastIdx = merged.length - 1;
    if (lastIdx >= 0 && merged[lastIdx].role === "assistant" && turn.streamedContent) {
      merged[lastIdx] = { ...merged[lastIdx], content: turn.streamedContent };
    }
    return merged;
  }
  const assistant: Message = { role: "assistant", content: turn.streamedContent || "（无内容）" };
  return [...turn.baseMessages, turn.userMessage, assistant];
}

/** 终止/失败时,把已流式的内容定格成消息列表(供 chat-page 收尾落入本地 messages)。 */
export function overlayMessages(turn: StreamTurn): Message[] {
  return [...turn.baseMessages, turn.userMessage, { role: "assistant", content: activeAssistantContent(turn) }];
}

/** 叠加渲染时,当前回合助手气泡应显示的正文。 */
export function activeAssistantContent(turn: StreamTurn): string {
  if (turn.status === "error") return turn.errorMessage ?? "处理时出了点问题,请重试。";
  if (turn.status === "stopped") return turn.streamedContent ? `${turn.streamedContent}\n\n已停止` : "已停止";
  // incomplete:正常会走 mergeFinalMessages 显示落库内容,这里仅作兜底,沿用已流式的正文。
  return turn.streamedContent || "...";
}

type ChatStreamApi = {
  getTurn: (key: string | null | undefined) => StreamTurn | undefined;
  startTurn: (params: StartTurnParams) => void;
  stopTurn: (key: string) => void;
  consumeTurn: (key: string) => void;
  /** 按 conversationId 索引的进行中/刚结束回合状态,供侧栏渲染状态点(streaming=蓝/done=绿/error=红)。 */
  statusByConversationId: Record<number, TurnStatus>;
};

const ChatStreamContext = createContext<ChatStreamApi | null>(null);

export function useChatStream(): ChatStreamApi {
  const ctx = useContext(ChatStreamContext);
  if (!ctx) throw new Error("useChatStream must be used within ChatStreamProvider");
  return ctx;
}

export function isFinished(status: TurnStatus) {
  return status === "done" || status === "error" || status === "stopped" || status === "incomplete";
}

export function ChatStreamProvider({ children }: { children: React.ReactNode }) {
  const [turns, setTurns] = useState<Record<string, StreamTurn>>({});
  const controllersRef = useRef<Record<string, AbortController>>({});

  // 标题单一源:agent 提炼标题经 SSE title 事件推来时,更新 nav-state(侧栏 + header 共读)。
  // 用 ref 持最新函数,避免 startTurn 的 [] useCallback 闭包捕获到旧引用。
  const { updateConversationTitle } = useNavState();
  const updateTitleRef = useRef(updateConversationTitle);
  updateTitleRef.current = updateConversationTitle;

  const update = useCallback((key: string, fn: (turn: StreamTurn) => StreamTurn) => {
    setTurns((prev) => (prev[key] ? { ...prev, [key]: fn(prev[key]) } : prev));
  }, []);

  const getTurn = useCallback(
    (key: string | null | undefined) => (key ? turns[key] : undefined),
    [turns]
  );

  const consumeTurn = useCallback((key: string) => {
    delete controllersRef.current[key];
    setTurns((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const stopTurn = useCallback((key: string) => {
    controllersRef.current[key]?.abort();
  }, []);

  const startTurn = useCallback(
    (params: StartTurnParams) => {
      const { key } = params;
      const controller = new AbortController();
      controllersRef.current[key] = controller;
      const startedAt = Date.now();

      setTurns((prev) => {
        // 顺手清理已结束的孤儿回合(例如新会话切走后跑完没人收尾的),避免无界增长
        const next: Record<string, StreamTurn> = {};
        for (const [k, t] of Object.entries(prev)) {
          if (!isFinished(t.status)) next[k] = t;
        }
        next[key] = {
          key,
          conversationId: params.conversationId,
          status: "streaming",
          userMessage: params.userMessage,
          baseMessages: params.baseMessages,
          streamedContent: "",
          timeline: [],
          startedAt,
          processedEndedAt: null
        };
        return next;
      });

      void runStream(params, controller);
    },
    // runStream/update are stable enough; declared below via closure over update/setTurns
    // eslint-disable-next-line react-hooks/exhaustive-deps
    []
  );

  async function runStream(params: StartTurnParams, controller: AbortController) {
    const { key } = params;
    try {
      const response = await submitAgentRequest({
        messages: params.requestMessages,
        conversationId: params.conversationId,
        attachments: params.attachments,
        referencedAttachments: params.referencedAttachments,
        referencedSkills: params.referencedSkills,
        modelTier: params.modelTier,
        signal: controller.signal
      });

      if (!response.ok) {
        const errorPayload = (await response.json().catch(() => null)) as { error?: string } | null;
        throw new Error(errorPayload?.error ?? `Agent 请求失败：${response.status}`);
      }

      const contentType = response.headers.get("content-type") ?? "";
      if (contentType.includes("text/event-stream")) {
        await readSSEStream(response, {
          onChunk: (chunk) => update(key, (turn) => reduceChunk(turn, chunk, Date.now())),
          onAgentEvent: (event) => update(key, (turn) => reduceAgentEvent(turn, event, Date.now())),
          onMeta: (cid) => update(key, (turn) => (turn.conversationId === cid ? turn : { ...turn, conversationId: cid })),
          onTitle: (cid, title) => updateTitleRef.current(cid, title),
          onDone: (payload) =>
            update(key, (turn) => ({
              ...turn,
              status: "done",
              conversationId: payload.conversationId ?? turn.conversationId,
              finalConversation: payload.conversation ?? null,
              generatedAttachments: payload.generatedAttachments
            })),
          // 回合未完成:已落库,按"已完成态"叠加最终消息(narration/文件不丢)+ humanize 出可继续的提示。
          onIncomplete: (payload) =>
            update(key, (turn) => {
              const human = humanizeAgentError(payload.message);
              return {
                ...turn,
                status: "incomplete",
                conversationId: payload.conversationId ?? turn.conversationId,
                finalConversation: payload.conversation ?? null,
                generatedAttachments: payload.generatedAttachments,
                errorMessage: human.message,
                errorAction: human.action
              };
            })
        });
      } else {
        const payload = (await response.json()) as {
          data: { content: string; conversationId?: number; conversation?: Conversation; generatedAttachments?: GeneratedAttachment[] };
        };
        update(key, (turn) => ({
          ...turn,
          status: "done",
          conversationId: payload.data.conversationId ?? turn.conversationId,
          finalConversation: payload.data.conversation ?? null,
          streamedContent: turn.streamedContent || payload.data.content,
          generatedAttachments: payload.data.generatedAttachments
        }));
      }
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        update(key, (turn) => ({ ...turn, status: "stopped" }));
      } else {
        const raw = error instanceof Error ? error.message : String(error ?? "");
        // 已被捕获并 humanize 后在气泡里展示 → 用 warn(error 会触发 Next.js dev 红框,把已处理的预期错误当崩溃)。
        if (raw) console.warn("[chat-stream] agent error:", raw);
        const human = humanizeAgentError(raw);
        update(key, (turn) => ({ ...turn, status: "error", errorMessage: human.message, errorAction: human.action }));
      }
    } finally {
      delete controllersRef.current[key];
    }
  }

  // 按会话索引状态:同一会话取最新一条回合的状态(已 consume 的回合不在 turns 里 → 自然无点)。
  const statusByConversationId = useMemo(() => {
    const map: Record<number, TurnStatus> = {};
    for (const t of Object.values(turns)) {
      if (t.conversationId != null) map[t.conversationId] = t.status;
    }
    return map;
  }, [turns]);

  const api = useMemo<ChatStreamApi>(
    () => ({ getTurn, startTurn, stopTurn, consumeTurn, statusByConversationId }),
    [getTurn, startTurn, stopTurn, consumeTurn, statusByConversationId]
  );

  return <ChatStreamContext.Provider value={api}>{children}</ChatStreamContext.Provider>;
}
