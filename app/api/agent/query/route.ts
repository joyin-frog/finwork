import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { runClaudeAgent } from "@/lib/agent/claude-adapter";
import type { AgentAttachment, AgentMessage } from "@/lib/agent/claude-adapter";
import type { ModelUsage } from "@anthropic-ai/claude-agent-sdk";
import { writeSpan } from "@/lib/observability/spans";
import { writeAgentTrace } from "@/lib/observability/trace-write";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import {
  getChatConversation,
  getDb,
  insertChatAgentEvent,
  insertChatMessage,
  setChatConversationClaudeSessionId,
  updateChatConversationTitle
} from "@/lib/db/sqlite";
import { cleanupUnfinalizedFiles, recordNewGeneratedFiles } from "@/lib/chat/generated-files";
import { filterIdentity, createStreamingIdentityFilter } from "@/lib/safety/identity-filter";
import { runRouter } from "@/lib/agent/router";
import { generateConversationTitle } from "@/lib/agent/conversation-title";
import { cancelPendingQuestions, createPendingQuestion } from "@/lib/agent/pending-questions";
import type { AgentQuestion } from "@/lib/agent/claude-adapter";
import { redact } from "@/lib/safety/pii";
import { sanitizeTurnEvents } from "@/lib/agent/persist-hygiene";
import { appendServerLog } from "@/lib/runtime/server-log";
import { createLogger } from "@/lib/runtime/logger";
import { parseStage, sessionStage, quotaStage, routerStage } from "@/lib/agent/query-stages";
import {
  createEmitter,
  contractToLegacyEvents,
  type AgentRuntimeEvent,
  type AgentEventEnvelope,
  type AgentEmitter,
} from "@/lib/agent/runtime-events";

const log = createLogger("agent-query");

export async function POST(request: Request) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const settings = await readClaudeSettings().catch(() => ({ roleMode: "tech" as const, subagentModel: undefined as string | undefined })) as Awaited<ReturnType<typeof readClaudeSettings>>;
  const roleMode = settings.roleMode as string;
  log.info("request start", { traceId });

  // ── Stage 1: parse ──
  const p = await parseStage({ request, traceId, startedAt, settings, roleMode });
  if (p instanceof Response) return p;

  // ── Stage 2: session ──
  const s = await sessionStage(p);
  if (s instanceof Response) return s;

  // ── Stage 3: quota ──
  const q = await quotaStage(s);
  if (q instanceof Response) return q;

  // ── Stage 4: router ──
  const r = await routerStage(q);
  if (r instanceof Response) return r;

  const {
    conversationId, existingClaudeSessionId, claudeSessionId,
    agentMessages, attachments, outputDir, beforeGenerate,
    lastUserContent, useStreaming, routerResult, modelOverride, sessionRoleId,
  } = r;

  // --- Run agent ---
  try {
    log.info("agent start", { traceId, conversationId, claudeSessionId, streaming: useStreaming });

    const turnParams: AgentTurnParams = {
      traceId, agentMessages, claudeSessionId, existingClaudeSessionId,
      attachments, outputDir, routerResult, conversationId,
      // 模型由「深度思考」开关决定:默认快速模型,开了用推理模型(该档未配则回落主模型)。
      modelOverride,
      // 专员会话（E 刀）:以会话绑定的角色身份运行本回合
      roleId: sessionRoleId,
    };
    const persistParams: PersistTurnParams = {
      conversationId, existingClaudeSessionId, beforeGenerate,
      traceId, startedAt, routerResult, lastUserContent, roleMode,
    };

    if (useStreaming) {
      return createStreamingResponse({
        turnParams, persistParams, conversationId, traceId, startedAt,
        requestSignal: request.signal,
      });
    }

    const { result, collector } = await runAgentTurn(turnParams);
    const { generatedAttachments } = persistAgentTurn({ ...persistParams, result, collector });
    if (conversationId) void improveConversationTitle(conversationId).catch(() => {});
    log.info("done", { traceId, durationMs: Date.now() - startedAt });
    return NextResponse.json({ ok: true, data: { ...result, conversationId, conversation: conversationId ? getChatConversation(conversationId) : null, generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined } });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("failed", { traceId, durationMs: Date.now() - startedAt, error });
    // 原始错误落盘:前端只会看到 humanize 后的「网络不稳定…」,真因(401/404/超时/网关地址错等)
    // 需在 server-<date>.log 留底才查得到。best-effort,不 await。
    void appendServerLog(`[agent-query] failed traceId=${traceId} ${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
    // 出错也保留已完成的部分(非流式路径同样不该整回合归零);拿不到 collector 才只记错误 trace。
    const collector = (error as { __collector?: AgentTurnCollector }).__collector;
    const partialUsage = (error as { __modelUsage?: Record<string, ModelUsage> }).__modelUsage;
    if (collector) {
      persistIncompleteTurn({ conversationId, existingClaudeSessionId, beforeGenerate, traceId, startedAt, routerResult, lastUserContent, roleMode, collector, errorMessage: message, modelUsage: partialUsage });
    } else {
      writeAgentTrace({
        traceId, conversationId, startedAt, modelUsed: modelLabel(routerResult),
        routerPath: routerResult.path, errorMessage: message, userMessage: lastUserContent.slice(0, 500),
        finalAnswer: "", roleMode, toolCallCount: 0, modelUsage: partialUsage,
      });
    }
    return NextResponse.json({ ok: false, error: redact(message), data: { conversationId, conversation: conversationId ? getChatConversation(conversationId) : null } }, { status: 502 });
  }
}

// ─── agent execution(streaming 与非 streaming 共用) ────────────────

type AgentTurnCollector = {
  collectedChunks: string[];
  collectedEvents: Array<{ type: string; [key: string]: unknown }>;
};

type AgentTurnParams = {
  traceId: string; agentMessages: AgentMessage[]; claudeSessionId: string | null;
  existingClaudeSessionId: string | null; attachments: AgentAttachment[];
  outputDir: string | undefined; routerResult: Awaited<ReturnType<typeof runRouter>>;
  modelOverride?: string;
  /** 专员会话（E 刀）：会话绑定的角色 id；NULL = 主管会话。 */
  roleId?: string | null;
  signal?: AbortSignal;
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
  /** 流式路径：每条 AgentEventEnvelope 发出时回调（非流式路径无此回调）。 */
  emitEnvelope?: (env: AgentEventEnvelope) => void;
  conversationId?: number;
  /** B2 修复：per-run 共享 eventId 计数器。流式路径由 createStreamingResponse 建立并经此字段注入，
   *  保证 main / sub / stream 三处 emitter 的 eventId 在同一 run 内严格单调递增。
   *  非流式路径不传，runAgentTurn 内部自建（main+sub 共享）。 */
  runCounter?: { next: () => number };
};

type AgentTurnResult =
  | { mode: "cheap"; content: string; claudeSessionId: string | null; direct: true }
  | (Awaited<ReturnType<typeof runClaudeAgent>> & { direct: false });

async function runAgentTurn(params: AgentTurnParams): Promise<{ result: AgentTurnResult; collector: AgentTurnCollector }> {
  const { traceId, agentMessages, claudeSessionId, existingClaudeSessionId, attachments, outputDir, routerResult } = params;
  const collector: AgentTurnCollector = { collectedChunks: [], collectedEvents: [] };

  // Cheap path: router already produced a direct answer
  if (routerResult.path === "cheap" && routerResult.decision.directAnswer) {
    const answer = filterIdentity(routerResult.decision.directAnswer);
    collector.collectedChunks.push(answer);
    coalesceTextIntoEvents(collector.collectedEvents, answer);
    return { result: { mode: "cheap", content: answer, claudeSessionId, direct: true }, collector };
  }

  // 身份出站过滤(安全红线·机制兜底):流式逐 chunk 过滤,collector 与下发都用过滤后文本
  const idFilter = createStreamingIdentityFilter();
  // 思考计时:从回合起算到「首个产出」
  const runStart = Date.now();
  let thinkingSeen = false;
  let firstOutputAt: number | undefined;

  // AR2a: 主对话 emitter（instanceId=null）；子代理事件用 per-instance emitter。
  // B2 修复：流式路径传入 runCounter（main/sub/stream 三处共享）；非流式路径自建（main+sub 共享）。
  let _nonStreamSeq = 0;
  const runCounter = params.runCounter ?? { next: () => ++_nonStreamSeq };
  const mainEmitter = createEmitter(traceId, params.conversationId ?? null, null, runCounter);

  /** 接收 AgentRuntimeEvent，应用过滤，包装 envelope，落库 + 推 SSE。 */
  const handleEmit = (event: AgentRuntimeEvent, emitter: AgentEmitter) => {
    let filteredEvent: AgentRuntimeEvent = event;

    if (event.type === "message_delta" && event.channel === "text") {
      if (firstOutputAt == null) firstOutputAt = Date.now();
      const safe = idFilter.push(event.delta);
      if (!safe) return;
      filteredEvent = { type: "message_delta", channel: "text", delta: safe };
      collector.collectedChunks.push(safe);
    } else if (event.type === "message_delta" && event.channel === "thinking") {
      thinkingSeen = true;
      const safe = redact(filterIdentity(event.delta)).trim();
      if (!safe) return;
      filteredEvent = { type: "message_delta", channel: "thinking", delta: safe };
    } else if (event.type === "tool_started") {
      if (firstOutputAt == null) firstOutputAt = Date.now();
    }

    const env = emitter.wrap(filteredEvent);
    // 转换为落库格式并并入 collector
    for (const legacyEv of contractToLegacyEvents(env)) {
      if (legacyEv.type === "text") {
        coalesceTextIntoEvents(collector.collectedEvents, (legacyEv as { content: string }).content);
      } else {
        collector.collectedEvents.push(legacyEv as { type: string; [key: string]: unknown });
      }
    }
    params.emitEnvelope?.(env);
  };

  const data = await runClaudeAgent(agentMessages, {
    claudeSessionId,
    resumeSession: Boolean(existingClaudeSessionId),
    requestId: traceId,
    attachments,
    outputDir,
    traceId,
    conversationId: params.conversationId,
    modelOverride: params.modelOverride,
    roleId: params.roleId,
    signal: params.signal,
    resolveUserQuestion: params.resolveUserQuestion,
    // 主 Agent 事件走主 emitter
    emit: (event) => handleEmit(event, mainEmitter),
    // 子代理事件：每个子代理有唯一 instanceId，用 per-instance emitter 包装
    // B2 修复：传入同一 runCounter，保证跨子代理事件 eventId 连续单调
    onSubagentEvent: (event, instanceId) => {
      const subEmitter = createEmitter(traceId, params.conversationId ?? null, instanceId, runCounter);
      handleEmit(event, subEmitter);
    },
  }).catch((err: unknown) => {
    // collector 随抛异常会丢 → 挂到错误上，让上层出错收尾把已做的部分落库
    if (thinkingSeen) {
      const thinkingMs = Math.max(0, (firstOutputAt ?? Date.now()) - runStart);
      collector.collectedEvents.push({ type: "system", subtype: "thinking_duration", message: String(thinkingMs) });
    }
    (err as { __collector?: AgentTurnCollector }).__collector = collector;
    throw err;
  });
  // flush 流式过滤器末尾残留
  const tail = idFilter.flush();
  if (tail) {
    collector.collectedChunks.push(tail);
    coalesceTextIntoEvents(collector.collectedEvents, tail);
    // tail 也需要发 envelope（非流式路径 emitEnvelope 为空，流式路径已关流的情况忽略）
    const tailEnv = mainEmitter.wrap({ type: "message_delta", channel: "text", delta: tail });
    params.emitEnvelope?.(tailEnv);
  }
  // 思考时长落库
  if (thinkingSeen) {
    const thinkingMs = Math.max(0, (firstOutputAt ?? Date.now()) - runStart);
    collector.collectedEvents.push({ type: "system", subtype: "thinking_duration", message: String(thinkingMs) });
  }
  // 最终正文以过滤后拼接为准
  const filteredContent = collector.collectedChunks.join("") || filterIdentity(data.content ?? "");
  return { result: { ...data, content: filteredContent, direct: false }, collector };
}

type PersistTurnParams = {
  conversationId: number | undefined; existingClaudeSessionId: string | null;
  beforeGenerate: Set<string>; traceId: string; startedAt: number;
  routerResult: Awaited<ReturnType<typeof runRouter>>;
  lastUserContent: string; roleMode: string;
};

/** 助手回合落库的唯一出口(成功 / 未完成两条收尾共用):写 assistant 消息 + 经 sanitize 落库 collector 事件。 */
function insertAssistantTurn(conversationId: number, content: string, collector: AgentTurnCollector, traceId: string): number {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const messageId = insertChatMessage(conversationId, "assistant", content);
    for (const event of sanitizeTurnEvents(collector.collectedEvents)) insertChatAgentEvent(messageId, event.type, event, traceId);
    db.exec("COMMIT");
    return messageId;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}

/** 唯一的回合收尾:session 写回、消息+事件落库、标题、生成文件、trace。两条响应路径都走这里。 */
function persistAgentTurn(
  params: PersistTurnParams & { result: AgentTurnResult; collector: AgentTurnCollector }
): { messageId?: number; fullContent: string; generatedAttachments: ReturnType<typeof recordNewGeneratedFiles> } {
  const { conversationId, existingClaudeSessionId, beforeGenerate, traceId, startedAt, routerResult, lastUserContent, roleMode, result, collector } = params;

  if (conversationId && result.claudeSessionId && result.claudeSessionId !== existingClaudeSessionId) {
    setChatConversationClaudeSessionId(conversationId, result.claudeSessionId);
  }

  let messageId: number | undefined;
  const fullContent = result.content || collector.collectedChunks.join("");
  if (conversationId && fullContent.trim()) {
    // 持久化本回合实际处理时长(墙钟)
    collector.collectedEvents.push({
      type: "system",
      subtype: "turn_duration",
      message: String(Math.max(0, Date.now() - startedAt)),
    });
    messageId = insertAssistantTurn(conversationId, fullContent, collector, traceId);
  }

  cleanupUnfinalizedFiles(conversationId, beforeGenerate);
  const generatedAttachments = recordNewGeneratedFiles(conversationId, messageId, beforeGenerate);
  const toolCallCount = collector.collectedEvents.filter((e) => e.type === "tool_use" || e.type === "tool_result").length;
  writeAgentTrace({
    traceId, conversationId, startedAt,
    modelUsed: pickRealModel(result, routerResult), routerPath: routerResult.path, errorMessage: null,
    userMessage: lastUserContent, finalAnswer: fullContent,
    roleMode,
    modelUsage: "modelUsage" in result ? result.modelUsage : undefined,
    totalCostUsd: "totalCostUsd" in result ? result.totalCostUsd : undefined,
    numTurns: "numTurns" in result ? result.numTurns : undefined,
    toolCallCount,
  });

  return { messageId, fullContent, generatedAttachments };
}

/** 出错收尾:把本回合已完成的部分落库并标 turn_incomplete。 */
function persistIncompleteTurn(
  params: PersistTurnParams & { collector: AgentTurnCollector; errorMessage: string; modelUsage?: Record<string, ModelUsage> }
): { messageId?: number; fullContent: string; generatedAttachments: ReturnType<typeof recordNewGeneratedFiles> } {
  const { conversationId, beforeGenerate, traceId, startedAt, routerResult, lastUserContent, roleMode, collector, errorMessage, modelUsage } = params;

  const fullContent = collector.collectedChunks.join("");
  const hasWork = fullContent.trim().length > 0 || collector.collectedEvents.some((e) => e.type === "tool_use");
  let messageId: number | undefined;
  if (conversationId && hasWork) {
    collector.collectedEvents.push({ type: "system", subtype: "turn_incomplete", message: errorMessage });
    collector.collectedEvents.push({ type: "system", subtype: "turn_duration", message: String(Math.max(0, Date.now() - startedAt)) });
    messageId = insertAssistantTurn(conversationId, fullContent.trim() || "（本回合未完成，已保留已做的部分，可发「继续」让我接着做）", collector, traceId);
  }

  const generatedAttachments = recordNewGeneratedFiles(conversationId, messageId, beforeGenerate);
  const toolCallCount = collector.collectedEvents.filter((e) => e.type === "tool_use" || e.type === "tool_result").length;
  writeAgentTrace({
    traceId, conversationId, startedAt,
    modelUsed: modelLabel(routerResult), routerPath: routerResult.path, errorMessage,
    userMessage: lastUserContent, finalAnswer: fullContent, roleMode, toolCallCount,
    modelUsage,
  });
  return { messageId, fullContent, generatedAttachments };
}

/** Coalesce a text chunk into the event list (mutates in place). */
function coalesceTextIntoEvents(
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

// ─── streaming ──────────────────────────────────────────────────────

function createStreamingResponse(params: {
  turnParams: AgentTurnParams;
  persistParams: PersistTurnParams;
  conversationId: number | undefined;
  traceId: string;
  startedAt: number;
  requestSignal?: AbortSignal;
}) {
  const { turnParams, persistParams, conversationId, traceId, startedAt, requestSignal } = params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      requestSignal?.addEventListener("abort", () => {
        cancelPendingQuestions(traceId);
        streamClosed = true;
        try { controller.close(); } catch { /* ok */ }
      }, { once: true });

      // enqueue 不抛:客户端断开(abort)后 controller 已关
      const enqueue = (payload: Record<string, unknown>) => {
        if (streamClosed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          streamClosed = true;
        }
      };

      // B2 修复：run 级共享计数器，覆盖 streamEmitter + mainEmitter + 全部 subEmitter
      let _streamSeq = 0;
      const runCounter = { next: () => ++_streamSeq };
      // AR2a: 主 emitter 用于流式路径的 settled/title 事件（ask_user 等旁路事件也经此包装）
      const streamEmitter = createEmitter(traceId, conversationId ?? null, null, runCounter);

      // enqueueEnvelope: 将 AgentEventEnvelope 序列化为 SSE 数据行
      const enqueueEnvelope = (env: AgentEventEnvelope) => enqueue(env as unknown as Record<string, unknown>);

      // 新会话:一开始就把 conversationId 下发（保留 meta 帧兼容旧客户端）
      if (conversationId) enqueue({ type: "meta", conversationId });

      // 确认事件在回合执行中产生，先本地收集，回合结束后并入 collector 落库
      const askEvents: Array<{ type: string; [key: string]: unknown }> = [];

      /** AR2a: 三路径共用收口 —— 发 run_ended + run_settled。 */
      const settleRun = (outcome: "completed" | "aborted" | "error", opts?: { message?: string }) => {
        const endedEnv = streamEmitter.wrap({
          type: "run_ended",
          kind: outcome === "completed" ? "complete" : "incomplete",
          message: opts?.message,
        });
        enqueueEnvelope(endedEnv);
        const settledEnv = streamEmitter.wrap({ type: "run_settled", outcome, error: opts?.message });
        enqueueEnvelope(settledEnv);
      };

      try {
        const { result, collector } = await runAgentTurn({
          ...turnParams,
          signal: requestSignal,
          emitEnvelope: enqueueEnvelope,
          runCounter, // B2 修复：流式路径共享计数器
          // 人机确认链路：把提问下发到前端，挂起等待 /api/agent/answer 应答
          resolveUserQuestion: async (question) => {
            const { id, promise } = createPendingQuestion(traceId, question);
            const askEnv = streamEmitter.wrap({ type: "ask_user", questionId: id, question });
            askEvents.push({ type: "ask_user", questionId: id, question: question as unknown as Record<string, unknown> });
            enqueueEnvelope(askEnv);
            const answer = await promise;
            const answeredEnv = streamEmitter.wrap({ type: "ask_user_answered", questionId: id, answer });
            askEvents.push({ type: "ask_user_answered", questionId: id, answer });
            enqueueEnvelope(answeredEnv);
            return answer;
          },
        });

        collector.collectedEvents.push(...askEvents);
        const { generatedAttachments } = persistAgentTurn({ ...persistParams, result, collector });
        writeSpan({ traceId, spanType: "stream", name: "SSE stream", startedAt, durationMs: Date.now() - startedAt });

        // AR2a: 三路径收口 — 成功路径
        settleRun("completed");
        // 向前兼容：继续发送旧帧 done，chat-stream.tsx onDone 由此驱动（含 conversation/attachments）
        enqueue({ type: "done", conversationId, conversation: conversationId ? getChatConversation(conversationId) : null, generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined });
        // 标题异步提炼，settled 已发（前端不阻塞），title_updated 随后到达
        try {
          if (conversationId) {
            const improvedTitle = await improveConversationTitle(conversationId);
            if (improvedTitle) {
              const titleEnv = streamEmitter.wrapConversation({ type: "title_updated", title: improvedTitle, conversationId });
              enqueueEnvelope(titleEnv);
            }
          }
        } catch { /* 已被停止/abort 关流 → 忽略 */ }
        try { controller.close(); } catch { /* already closed */ }
      } catch (error) {
        cancelPendingQuestions(traceId);
        const msg = error instanceof Error ? error.message : String(error);
        // 原始错误落盘
        void appendServerLog(`[agent-query/stream] failed traceId=${traceId} ${redact(error instanceof Error ? error.stack ?? error.message : String(error))}`);
        const collector = (error as { __collector?: AgentTurnCollector }).__collector;
        const partialUsage = (error as { __modelUsage?: Record<string, ModelUsage> }).__modelUsage;
        // AR2a: 三路径收口 — abort 路径 vs 错误路径
        const isAbort = error instanceof Error && error.name === "AbortError";
        if (collector) {
          collector.collectedEvents.push(...askEvents);
          const { generatedAttachments } = persistIncompleteTurn({ ...persistParams, collector, errorMessage: msg, modelUsage: partialUsage });
          settleRun(isAbort ? "aborted" : "error", { message: redact(msg) });
          // 向前兼容：发旧帧 incomplete，chat-stream.tsx onIncomplete 由此驱动
          enqueue({ type: "incomplete", conversationId, conversation: conversationId ? getChatConversation(conversationId) : null, generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined, message: redact(msg) });
        } else {
          writeAgentTrace({
            traceId, conversationId, startedAt,
            modelUsed: modelLabel(persistParams.routerResult), routerPath: persistParams.routerResult.path, errorMessage: msg,
            userMessage: persistParams.lastUserContent, finalAnswer: "", roleMode: persistParams.roleMode, toolCallCount: 0,
            modelUsage: partialUsage,
          });
          settleRun(isAbort ? "aborted" : "error", { message: redact(msg) });
          // 向前兼容：发旧帧 error
          enqueue({ type: "error", message: redact(msg) });
        }
        try { controller.close(); } catch { /* already closed */ }
      }
    }
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
}


function modelLabel(routerResult?: Awaited<ReturnType<typeof runRouter>>) {
  return routerResult?.decision?.mainModelTier ?? "main";
}

/** 观测保真:有真实 usage 时记真实模型 id(modelUsage 的键),否则回落到分层名。 */
function pickRealModel(result: AgentTurnResult, routerResult?: Awaited<ReturnType<typeof runRouter>>): string {
  if ("modelUsage" in result && result.modelUsage) {
    const keys = Object.keys(result.modelUsage);
    if (keys.length) return keys.join(",");
  }
  return modelLabel(routerResult);
}

/**
 * 首个完整回合(用户+助手各一条)提炼对话标题并落库，返回新标题（无改进/非首回合/失败 → null）。
 */
async function improveConversationTitle(conversationId: number): Promise<string | null> {
  const conv = getChatConversation(conversationId);
  if (!conv || conv.messages.length !== 2) return null;

  const firstUserMsg = conv.messages.find((m) => m.role === "user")?.content ?? "";
  const firstAnswer = conv.messages.find((m) => m.role === "assistant")?.content ?? "";

  try {
    const title = await generateConversationTitle(firstUserMsg, firstAnswer);
    if (title) {
      updateChatConversationTitle(conversationId, title);
      return title;
    }
    return null;
  } catch (err) {
    log.error("title generation failed", { conversationId, error: err });
    return null;
  }
}
