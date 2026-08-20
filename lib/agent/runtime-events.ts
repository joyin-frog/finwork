/**
 * runtime-events.ts — AR2a：统一事件合同（唯一定义处）
 *
 * 三套平行协议（后端 AgentRunEvent、SSE 帧、前端 AgentEvent）统一为本文件的
 * AgentRuntimeEvent + AgentEventEnvelope。
 *
 * 设计要点：
 * - AgentRuntimeEvent 包含两类：① 新合同事件（后端从 AR2a 起发射）；
 *   ② 遗留兼容类型（前端历史 DB 事件读取 + reducer 翻译层使用，保持 API 兼容）。
 * - projectRuntimeEvent(envelope) 只生成聊天展示投影；envelope 仍是运行事实权威。
 * - createEmitter(runId, conversationId, instanceId?) 工厂内聚 eventId 计数与 ts 盖章。
 */

// ─── 遗留类型定义（避免循环 import，内联最小形状）────────────────────────────

type AskUserQuestionPayload = {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options?: Array<{ label: string; description?: string; preview?: string }>;
  questions?: Array<{ question: string; header?: string; multiSelect?: boolean; options?: Array<{ label: string; description?: string }> }>;
  kind?: "confirm" | "question";
  // 可信任工具为 true 时前端在确认卡里渲染「本次对话不再询问」勾选项。
  trustable?: boolean;
};

type ConversationPayload = {
  id: number;
  title: string;
  messages: unknown[];
} | null;

type GeneratedAttachmentPayload = {
  name: string;
  mimeType: string;
  sizeBytes: number;
};

// ─── AgentRuntimeEvent（唯一共享合同，前后端皆 import 此类型）─────────────────

export type AgentRuntimeEvent =
  // ── 新合同事件（AR2a 后端发射）──────────────────────────────────────────
  /** 主对话 run 开始（替代 meta 帧）；子代理 run 开始时 instanceId 非空，附带 label/roleId。 */
  | { type: "run_started"; conversationId?: number | null; label?: string; roleId?: string }
  /** 为多 turn 预留；v1 在 run_started 后立即发一次（1 run = 1 turn）。 */
  | { type: "turn_started" }
  /** 首个 delta 前发，标记消息流开始。 */
  | { type: "message_started"; channel: "text" | "thinking" }
  /** 文本增量（只带增量不带 partial 快照，SSE 场景避免 O(n²) 传输）。 */
  | { type: "message_delta"; channel: "text" | "thinking"; delta: string }
  /** 消息流结束，携带全文快照。 */
  | { type: "message_completed"; channel: "text" | "thinking"; content: string }
  /** 工具调用开始（替代 tool_use 事件）。 */
  | { type: "tool_started"; toolName: string; input?: unknown; toolCallId?: string }
  /** 本期只定义不发射（AR4/批跑进度用）。 */
  | { type: "tool_updated" }
  /** 工具调用完成（替代 tool_result 事件）。summary 来自 getToolSummary（子代理场景）。
   *  子代理场景额外携带 label/roleId，供聊天展示投影正确分组。 */
  | { type: "tool_completed"; toolName?: string; toolCallId?: string; content?: string; isError?: boolean; durationMs?: number; structured?: unknown; summary?: string; label?: string; roleId?: string }
  /** 上下文压缩完成（替代 system(compact_boundary)）。 */
  | { type: "compaction_completed"; preTokens?: number; postTokens?: number; trigger?: string }
  /** 有意义的系统事件（init 等白名单；替代 system(init) 等）。 */
  | { type: "system_note"; subtype?: string; message: string }
  /** 高风险工具被确认门拦截（主对话或子代理均可；子代理场景携带 label/roleId）。 */
  | { type: "run_blocked"; summary?: string; toolName?: string; label?: string; roleId?: string }
  /** 本期只定义不发射（AR5 steering 队列用）。 */
  | { type: "queue_updated" }
  /** Run 结束（替代 done/incomplete 帧）。子代理场景携带 label/roleId/durationMs/success。
   *  conversation/generatedAttachments 仅主对话成功路径携带。 */
  | { type: "run_ended"; kind: "complete" | "incomplete"; conversation?: ConversationPayload; generatedAttachments?: GeneratedAttachmentPayload[]; message?: string; durationMs?: number; label?: string; roleId?: string; success?: boolean }
  /** Run 终态（本 spec 核心）：三路径（completed/aborted/error）在同一收口函数发射。 */
  | { type: "run_settled"; outcome: "completed" | "aborted" | "error"; error?: string }
  /** CR-R0：可恢复状态变化；与 run_settled 分工。payload 与 run-contract 对齐。 */
  | {
      type: "run_state_changed";
      from: string;
      to: string;
      trigger: string;
      terminationReason?: string;
      qualityStatus?: string;
    }
  /** Backend-owned business plan. Payload is deliberately user-readable and contains no chain-of-thought. */
  | {
      type: "work_plan_created";
      planId: string;
      caseId: string;
      version: number;
      goal: string;
      steps: Array<{ stepId: string; stepKey: string; title: string; expectedOutcome: string; status: string; ordinal: number }>;
    }
  | {
      type: "work_plan_revised";
      planId: string;
      caseId: string;
      version: number;
      reason: string;
    }
  | {
      type: "work_plan_step_changed";
      planId: string;
      caseId: string;
      stepId: string;
      stepKey: string;
      from: string;
      to: string;
      summary?: string;
    }
  /** 对话级事件：标题更新（runId=null，在 settled 之后异步到达）。 */
  | { type: "title_updated"; title: string; conversationId?: number | null }
  // ── 共享事件（新旧同名，payload 一致）────────────────────────────────────
  | { type: "ask_user"; questionId: string; question: AskUserQuestionPayload }
  | { type: "ask_user_answered"; questionId: string; answer: string }
  // ── 遗留兼容类型（前端向后兼容：历史 DB 事件 + reducer 翻译层）───────────
  /** DB 历史事件 / reducer 翻译：文本流合并结果。 */
  | { type: "text"; content: string }
  /** DB 历史事件 / reducer 翻译：思考块。 */
  | { type: "thinking"; content: string }
  /** DB 历史事件 / reducer 翻译：工具调用（tool_started 的落库映射目标）。 */
  | { type: "tool_use"; id?: string; name: string; input?: unknown }
  /** DB 历史事件 / reducer 翻译：工具结果（tool_completed 的落库映射目标）。 */
  | { type: "tool_result"; toolUseId?: string; name?: string; content?: string; isError?: boolean; durationMs?: number; structured?: unknown }
  /** DB 历史事件：系统事件（含 compact_boundary/init/turn_duration 等；shouldHideAgentEvent 按 subtype 过滤）。 */
  | { type: "system"; subtype?: string; message: string; data?: unknown }
  /** DB 历史事件 / reducer 翻译：子代理里程碑（turn-segments backward compat）。 */
  | { type: "subagent"; label: string; roleId: string; phase: "start" | "tool" | "blocked" | "done"; summary?: string; toolName?: string; durationMs?: number; isError?: boolean; success?: boolean };

// ─── Envelope（单 run 内唯一 SSE 传输单元）─────────────────────────────────

export type AgentEventEnvelope = {
  v: 1;
  eventId: number;           // per-run 内存单调计数，从 1 起
  runId: string | null;      // 主对话 = traceId；conversation 级事件（title_updated）= null
  conversationId: number | null;
  instanceId: string | null; // 子代理实例标识；主对话恒 null。铁律 4
  turnId?: string;
  messageId?: number;        // 回合收尾落库后才有
  toolCallId?: string;
  ts: string;                // ISO
  event: AgentRuntimeEvent;
};

// ─── 聊天展示投影（不是运行事实权威）────────────────────────────────────────

export type ChatEventProjection = { type: "text"; content: string } | { type: string; [key: string]: unknown };

// ─── Emitter 工厂 ────────────────────────────────────────────────────────────

export type AgentEmitter = {
  /** 包装合同事件为 envelope（eventId 自动递增）。 */
  wrap(event: AgentRuntimeEvent): AgentEventEnvelope;
  /** 包装 conversation 级事件（runId=null，不受 "settled 后无本 run 事件" 约束）。 */
  wrapConversation(event: AgentRuntimeEvent): AgentEventEnvelope;
};

/**
 * 创建一个 emitter，内聚 per-run eventId 计数与 ts 盖章。
 *
 * @param runId          复用本 run 的 traceId（agent_traces 已有）；无则 crypto.randomUUID()。
 * @param conversationId 会话 id（null 表示新会话尚未落库）。
 * @param instanceId     子代理实例标识；主对话传 undefined/null（默认 null）。
 * @param sharedCounter  可选的 run 级共享计数器。提供时多个 emitter（main/sub/stream）
 *                       共享同一序列，确保同一 run 内 eventId 严格单调递增（B2 修复）。
 *                       不传时退回内部独立计数（非流式测试路径向后兼容）。
 */
export function createEmitter(
  runId: string,
  conversationId: number | null,
  instanceId?: string | null,
  sharedCounter?: { next: () => number }
): AgentEmitter {
  let _localSeq = 0;
  const counter = sharedCounter ?? { next: () => ++_localSeq };
  const resolvedInstanceId = instanceId ?? null;

  const buildEnvelope = (event: AgentRuntimeEvent, overrideRunId: string | null): AgentEventEnvelope => {
    return {
      v: 1,
      eventId: counter.next(),
      runId: overrideRunId,
      conversationId,
      instanceId: resolvedInstanceId,
      ts: new Date().toISOString(),
      event,
    };
  };

  return {
    wrap(event: AgentRuntimeEvent): AgentEventEnvelope {
      return buildEnvelope(event, runId);
    },
    wrapConversation(event: AgentRuntimeEvent): AgentEventEnvelope {
      return buildEnvelope(event, null);
    },
  };
}

// ─── Runtime event → chat projection ────────────────────────────────────────

/**
 * 将单条 envelope 转换为 chat_agent_events 落库词表格式（零或多条）。
 *
 * 映射规则：
 * - message_delta(text)       → [{type:"text", content:delta}]
 * - message_delta(thinking)   → [{type:"thinking", content:delta}]
 * - tool_started(main)        → [{type:"tool_use", id:toolCallId, name:toolName, input}]
 * - tool_completed(main)      → [{type:"tool_result", toolUseId, name, content, isError, durationMs, structured}]
 * - tool_completed(subagent)  → [{type:"subagent", phase:"tool", ...}]
 * - run_started(subagent)     → [{type:"subagent", phase:"start", label, roleId, summary:label}]
 * - run_blocked(subagent)     → [{type:"subagent", phase:"blocked", label, roleId, toolName, summary}]
 * - run_ended(subagent)       → [{type:"subagent", phase:"done", label, roleId, success, durationMs}]
 * - ask_user                  → [{type:"ask_user", questionId, question}]
 * - ask_user_answered         → [{type:"ask_user_answered", questionId, answer}]
 * - compaction_completed      → [{type:"system", subtype:"compact_boundary", message}]
 * - system_note               → [{type:"system", subtype, message}]
 * - 其余（run_started main、run_ended main、run_settled、title_updated 等） → []
 */
export function projectRuntimeEvent(envelope: AgentEventEnvelope): ChatEventProjection[] {
  const { event, instanceId, toolCallId } = envelope;
  const isSubagent = instanceId !== null;

  switch (event.type) {
    case "message_delta":
      if (event.channel === "text") {
        return [{ type: "text", content: event.delta }];
      }
      if (event.channel === "thinking") {
        return [{ type: "thinking", content: event.delta }];
      }
      return [];

    case "tool_started":
      if (!isSubagent) {
        return [{ type: "tool_use", id: toolCallId ?? event.toolCallId, name: event.toolName, input: event.input }];
      }
      // subagent tool_started 不单独落库（由 tool_completed 的 subagent 映射覆盖）
      return [];

    case "tool_completed":
      if (!isSubagent) {
        return [{
          type: "tool_result",
          toolUseId: toolCallId ?? event.toolCallId,
          name: event.toolName,
          content: event.content,
          isError: event.isError,
          durationMs: event.durationMs,
          ...(event.structured !== undefined ? { structured: event.structured } : {}),
        }];
      }
      // subagent tool_completed → subagent(phase=tool)
      // B3 修复：优先用 event.label/roleId（由 subagent-runner 补传），回退 instanceId
      return [{
        type: "subagent",
        label: event.label ?? instanceId,
        roleId: event.roleId ?? instanceId,
        phase: "tool",
        toolName: event.toolName,
        summary: event.summary,
        durationMs: event.durationMs,
        isError: event.isError,
      }];

    case "run_started":
      if (isSubagent) {
        return [{
          type: "subagent",
          label: event.label ?? instanceId,
          roleId: event.roleId ?? instanceId,
          phase: "start",
          summary: event.label ?? instanceId,
        }];
      }
      return []; // 主对话 run_started 不落库

    case "run_blocked":
      if (isSubagent) {
        return [{
          type: "subagent",
          label: event.label ?? instanceId,
          roleId: event.roleId ?? instanceId,
          phase: "blocked",
          toolName: event.toolName,
          summary: event.summary,
        }];
      }
      return [];

    case "run_ended":
      if (isSubagent) {
        return [{
          type: "subagent",
          label: event.label ?? instanceId,
          roleId: event.roleId ?? instanceId,
          phase: "done",
          success: event.kind === "complete",
          durationMs: event.durationMs,
        }];
      }
      return []; // 主对话 run_ended 不单独落库（done/incomplete 帧已由收尾流程处理）

    case "ask_user":
      return [{ type: "ask_user", questionId: event.questionId, question: event.question }];

    case "ask_user_answered":
      return [{ type: "ask_user_answered", questionId: event.questionId, answer: event.answer }];

    case "compaction_completed": {
      const msg = `上下文已压缩${event.trigger ? `（${event.trigger}）` : ""}：${event.preTokens ?? "?"} → ${event.postTokens ?? "?"} tokens`;
      return [{ type: "system", subtype: "compact_boundary", message: msg }];
    }

    case "system_note":
      return [{ type: "system", subtype: event.subtype, message: event.message }];

    // 不落库事件：run_settled、run_state_changed、title_updated、turn_started、
    //             message_started、message_completed、tool_updated、queue_updated
    // （CR-R1 持久化 run_state_changed / settled 走 run_events，不进 chat_agent_events）
    case "run_settled":
    case "run_state_changed":
    case "work_plan_created":
    case "work_plan_revised":
    case "work_plan_step_changed":
    case "title_updated":
    case "turn_started":
    case "message_started":
    case "message_completed":
    case "tool_updated":
    case "queue_updated":
      return [];

    // 遗留兼容类型直接透传（DB 历史重放路径，不应经由 SSE 到达此处，但防御性保留）
    case "text":
    case "thinking":
      return [{ type: event.type, content: (event as { content: string }).content }];
    case "tool_use":
      return [{ type: "tool_use", id: (event as { id?: string }).id, name: (event as { name: string }).name, input: (event as { input?: unknown }).input }];
    case "tool_result":
      return [{ ...event }];
    case "system":
      return [{ type: "system", subtype: (event as { subtype?: string }).subtype, message: (event as { message: string }).message }];
    case "subagent":
      return [{ ...event }];

    default:
      return [];
  }
}
