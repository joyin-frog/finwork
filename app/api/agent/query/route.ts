import { randomUUID } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { isEnabled } from "@/lib/runtime/flags";
import { runClaudeAgent } from "@/lib/agent/claude-adapter";
import type { AgentAttachment, AgentMessage } from "@/lib/agent/claude-adapter";
import { writeSpan } from "@/lib/observability/spans";
import { writeAgentTrace } from "@/lib/observability/trace-write";
import { readClaudeSettings } from "@/lib/settings/claude-settings";
import {
  createChatConversation,
  getChatConversation,
  insertChatAgentEvent,
  insertChatAttachment,
  insertChatMessage,
  setChatConversationClaudeSessionId,
  updateChatConversationTitle
} from "@/lib/db/sqlite";
import { getConversationFilesDir } from "@/lib/runtime/paths";
import { sanitizeFileName, uniqueFilePath } from "@/lib/files/unique-name";
import { cleanupUnfinalizedFiles, recordNewGeneratedFiles, snapshotGeneratedFiles } from "@/lib/chat/generated-files";
import { filterIdentity, createStreamingIdentityFilter } from "@/lib/safety/identity-filter";
import { pickAgentModel, runRouter } from "@/lib/agent/router";
import { getUsageStatus } from "@/lib/usage/store";
import { buildBlockedNotice, type BlockedNotice } from "@/lib/usage/quota";
import { generateConversationTitle } from "@/lib/agent/conversation-title";
import { cancelPendingQuestions, createPendingQuestion } from "@/lib/agent/pending-questions";
import type { AgentQuestion } from "@/lib/agent/claude-adapter";
import { redact } from "@/lib/safety/pii";
import { sanitizeTurnEvents } from "@/lib/agent/persist-hygiene";
import { appendServerLog } from "@/lib/runtime/server-log";
import { createLogger } from "@/lib/runtime/logger";

const log = createLogger("agent-query");

export async function POST(request: Request) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const settings = await readClaudeSettings().catch(() => ({ roleMode: "tech" as const, subagentModel: undefined as string | undefined }));
  const roleMode = settings.roleMode;
  log.info("request start", { traceId });

  let messages: AgentMessage[];
  let conversationId: number | undefined;
  let attachments: AgentAttachment[] = [];

  try {
    const contentType = request.headers.get("content-type") ?? "";
    if (contentType.includes("multipart/form-data")) {
      const parsed = await parseMultipartRequest(request, traceId);
      messages = parsed.messages;
      conversationId = parsed.conversationId;
      attachments = parsed.attachments;
    } else {
      const parsed = await parseJsonRequest(request);
      messages = parsed.messages;
      conversationId = parsed.conversationId;
      attachments = parsed.attachments;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error("parse failed", { traceId, error });
    return NextResponse.json({ ok: false, error: `请求解析失败: ${message}` }, { status: 400 });
  }

  const lastUserMessage = [...messages].reverse().find((m) => m.role === "user");
  const lastUserContent = lastUserMessage?.content.trim() ?? "";
  log.info("payload parsed", { traceId, conversationId: conversationId ?? null, messageCount: messages.length, attachmentCount: attachments.length });

  let conversation = conversationId ? getChatConversation(conversationId) : null;
  if (lastUserContent) {
    if (!conversationId) {
      const shortTitle = generateShortTitle(lastUserContent);
      conversationId = createChatConversation(shortTitle);
      conversation = getChatConversation(conversationId);
      log.info("conversation created", { traceId, conversationId, title: shortTitle });
    }
    const messageId = insertChatMessage(conversationId, "user", lastUserContent);
    for (const att of attachments) {
      if (att.storagePath && conversationId) {
        insertChatAttachment({
          id: randomUUID(), messageId,
          fileName: att.name, mimeType: att.mimeType, sizeBytes: att.size,
          storagePath: path.relative(getConversationFilesDir(conversationId), att.storagePath), role: "user"
        });
      }
    }
  }

  // Session staleness check
  const SESSION_MAX_AGE_MS = 12 * 60 * 60 * 1000;
  let existingClaudeSessionId = conversation?.claudeSessionId ?? null;
  if (isEnabled("SESSION_LIVENESS_CHECK_ENABLED") && existingClaudeSessionId && conversation?.claudeSessionUpdatedAt) {
    if (Date.now() - new Date(conversation.claudeSessionUpdatedAt).getTime() > SESSION_MAX_AGE_MS) {
      log.info("session stale", { traceId, conversationId });
      existingClaudeSessionId = null;
    }
  }
  const claudeSessionId = conversationId ? existingClaudeSessionId ?? randomUUID() : null;
  if (conversationId && claudeSessionId && !existingClaudeSessionId) {
    setChatConversationClaudeSessionId(conversationId, claudeSessionId);
  }

  const agentMessages = messages; // 裁剪职责下沉到 adapter（pickPromptMessages）
  const outputDir = conversationId ? path.join(getConversationFilesDir(conversationId), "generate") : undefined;
  if (outputDir) mkdirSync(outputDir, { recursive: true });
  const beforeGenerate = snapshotGeneratedFiles(conversationId);
  const useStreaming = shouldUseStreaming(request);

  // --- 用量配额拦截:在 router/agent 之前,任何 LLM 花费前 ---
  if (isEnabled("USAGE_LIMIT_ENABLED") && lastUserContent) {
    const usage = getUsageStatus({
      now: Date.now(),
      roles: {
        routerModel: "routerModel" in settings ? settings.routerModel : "",
        mainModel: "mainModel" in settings ? settings.mainModel : "",
        subagentModel: settings.subagentModel ?? "",
      },
      // 放行即把(过期则重锚的)窗口起点写回,使紧随其后的本回合 trace 落在窗口内。
      // 命中拦截时窗口必为活动态,重锚为 no-op,落库无副作用。
      persist: true,
    });
    const notice = buildBlockedNotice(usage);
    if (notice) {
      log.info("usage blocked", { traceId, window: notice.window, resetAt: notice.resetAt });
      return buildUsageBlockedResponse({ notice, conversationId, traceId, useStreaming });
    }
  }

  // --- Router ---
  const routerResult = isEnabled("ROUTER_ENABLED") && lastUserContent
    ? await runRouter(lastUserContent, messages, traceId)
    : { path: "main" as const, decision: { needsRag: false, directAnswer: undefined as string | undefined, mainModelTier: "main" as const, intent: "complex_workflow" as const, reasoning: isEnabled("ROUTER_ENABLED") ? "empty message" : "router disabled" }, latencyMs: 0 };
  log.info("router", { traceId, path: routerResult.path, intent: routerResult.decision.intent, latencyMs: routerResult.latencyMs });
  writeSpan({
    traceId, spanType: "router", name: "router",
    startedAt: Date.now() - routerResult.latencyMs,
    durationMs: routerResult.latencyMs,
    inputSummary: lastUserContent.slice(0, 200),
    outputSummary: `${routerResult.path} / ${routerResult.decision.intent}`,
  });

  // --- Run agent ---
  try {
    log.info("agent start", { traceId, conversationId, claudeSessionId, streaming: useStreaming });

    const turnParams: AgentTurnParams = {
      traceId, agentMessages, claudeSessionId, existingClaudeSessionId,
      attachments, outputDir, routerResult,
      modelOverride: pickAgentModel(routerResult.decision, settings),
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
    void appendServerLog(`[agent-query] failed traceId=${traceId} ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    // 出错也保留已完成的部分(非流式路径同样不该整回合归零);拿不到 collector 才只记错误 trace。
    const collector = (error as { __collector?: AgentTurnCollector }).__collector;
    if (collector) {
      persistIncompleteTurn({ conversationId, existingClaudeSessionId, beforeGenerate, traceId, startedAt, routerResult, lastUserContent, roleMode, collector, errorMessage: message });
    } else {
      writeAgentTrace({
        traceId, conversationId, startedAt, modelUsed: modelLabel(routerResult),
        routerPath: routerResult.path, errorMessage: message, userMessage: lastUserContent.slice(0, 500),
        finalAnswer: "", roleMode, toolCallCount: 0,
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
  signal?: AbortSignal;
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
  emitChunk?: (text: string) => void;
  emitAgentEvent?: (event: Record<string, unknown>) => void;
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
    params.emitChunk?.(answer);
    return { result: { mode: "cheap", content: answer, claudeSessionId, direct: true }, collector };
  }

  // 身份出站过滤(安全红线·机制兜底):流式逐 chunk 过滤,collector 与下发都用过滤后文本,
  // 最终正文也以过滤后的拼接为准(覆盖 SDK 原始 content),让 prompt 里的"别透露模型"不再是唯一防线。
  const idFilter = createStreamingIdentityFilter();
  // 思考计时:从回合起算到「首个产出」(首条答案 chunk 或首个工具调用)= 模型动手前的思考时长,
  // 持久化成 thinking_duration,供「已思考 X」展示(进行中的实时计时由前端跑)。
  const runStart = Date.now();
  let thinkingSeen = false;
  let firstOutputAt: number | undefined;
  const data = await runClaudeAgent(agentMessages, {
    claudeSessionId,
    resumeSession: Boolean(existingClaudeSessionId),
    requestId: traceId,
    attachments,
    outputDir,
    traceId,
    modelOverride: params.modelOverride,
    signal: params.signal,
    resolveUserQuestion: params.resolveUserQuestion,
    onChunk: (text) => {
      if (firstOutputAt == null) firstOutputAt = Date.now();
      const safe = idFilter.push(text);
      if (!safe) return;
      collector.collectedChunks.push(safe);
      coalesceTextIntoEvents(collector.collectedEvents, safe);
      params.emitChunk?.(safe);
    },
    // 思考过程整块上报:按安全红线脱敏(身份过滤 + PII)后,作为 thinking 事件落库 + 下发,前端收进「思考」折叠块。
    // 整块到达(非增量)→ filterIdentity 看到完整文本,不会有跨片模型名漏过滤。空白块跳过。
    onThinking: (text) => {
      thinkingSeen = true;
      const safe = redact(filterIdentity(text)).trim();
      if (!safe) return;
      const event = { type: "thinking", content: safe };
      collector.collectedEvents.push(event);
      params.emitAgentEvent?.(event);
    },
    onAgentEvent: (event) => {
      if (firstOutputAt == null && (event as { type?: string }).type === "tool_use") firstOutputAt = Date.now();
      collector.collectedEvents.push(event);
      params.emitAgentEvent?.(event);
    },
  }).catch((err: unknown) => {
    // collector 随抛异常会丢 → 挂到错误上,让上层出错收尾把"已做的部分"(部分正文/中间事件)落库,
    // 否则一抛异常整回合归零(见红线:出错不该把已完成的工作冲掉)。
    (err as { __collector?: AgentTurnCollector }).__collector = collector;
    throw err;
  });
  // flush 流式过滤器末尾残留的未完 token(模型名可能正好结在最后一片)
  const tail = idFilter.flush();
  if (tail) {
    collector.collectedChunks.push(tail);
    coalesceTextIntoEvents(collector.collectedEvents, tail);
    params.emitChunk?.(tail);
  }
  // 思考时长落库(有思考才记):回合起到首个产出。供前端「已思考 X」与重载后展示。
  if (thinkingSeen) {
    const thinkingMs = Math.max(0, (firstOutputAt ?? Date.now()) - runStart);
    collector.collectedEvents.push({ type: "system", subtype: "thinking_duration", message: String(thinkingMs) });
  }
  // 最终正文以"过滤后的拼接"为准;无流式增量时(模型只回最终)回退到过滤 SDK 原始 content。
  const filteredContent = collector.collectedChunks.join("") || filterIdentity(data.content ?? "");
  return { result: { ...data, content: filteredContent, direct: false }, collector };
}

type PersistTurnParams = {
  conversationId: number | undefined; existingClaudeSessionId: string | null;
  beforeGenerate: Set<string>; traceId: string; startedAt: number;
  routerResult: Awaited<ReturnType<typeof runRouter>>;
  lastUserContent: string; roleMode: string;
};

/** 助手回合落库的唯一出口(成功 / 未完成两条收尾共用):写 assistant 消息 + 经 sanitize 落库 collector 事件。
 * turn_duration / turn_incomplete 等系统事件由调用方在调用前并入 collector。返回 messageId。 */
function insertAssistantTurn(conversationId: number, content: string, collector: AgentTurnCollector, traceId: string): number {
  const messageId = insertChatMessage(conversationId, "assistant", content);
  for (const event of sanitizeTurnEvents(collector.collectedEvents)) insertChatAgentEvent(messageId, event.type, event, traceId);
  return messageId;
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
    // 持久化本回合实际处理时长(墙钟),供前端"已处理 <时长>"展示(system 子类型不进可见时间线)。
    collector.collectedEvents.push({
      type: "system",
      subtype: "turn_duration",
      message: String(Math.max(0, Date.now() - startedAt)),
    });
    messageId = insertAssistantTurn(conversationId, fullContent, collector, traceId);
    // 标题提炼由调用方触发:流式路径在 done 后 await 并推 title 事件(前端两端同步),非流式路径 fire-and-forget。
  }

  // 成功收尾:若 agent 声明了最终产物,清掉本回合未声明的中间/试错文件(未声明则全留)。
  // 仅成功路径做;未完成/出错收尾(persistIncompleteTurn)不清,留着供「继续」。
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

/** 出错收尾:把本回合已完成的部分(部分正文 + 中间文本/工具事件 + 已生成文件)落库并标 turn_incomplete,
 * 让"一抛异常整回合归零"不再发生——已做的工作保留、reload 后照常展示,后续可「继续」。trace 记错误。
 * claude 会话 id 在回合开始前已写入会话(见 route 顶部),故此处不再处理。 */
function persistIncompleteTurn(
  params: PersistTurnParams & { collector: AgentTurnCollector; errorMessage: string }
): { messageId?: number; fullContent: string; generatedAttachments: ReturnType<typeof recordNewGeneratedFiles> } {
  const { conversationId, beforeGenerate, traceId, startedAt, routerResult, lastUserContent, roleMode, collector, errorMessage } = params;

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
      requestSignal?.addEventListener("abort", () => {
        cancelPendingQuestions(traceId);
        try { controller.close(); } catch { /* ok */ }
      }, { once: true });

      const enqueue = (payload: Record<string, unknown>) =>
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));

      // 新会话:一开始就把 conversationId 下发,前端可立刻进侧栏「最近」+ 改 URL,避免流式中切走丢记录
      if (conversationId) enqueue({ type: "meta", conversationId });

      // 确认事件在回合执行中产生,先本地收集,回合结束后并入 collector 落库
      const askEvents: Array<{ type: string; [key: string]: unknown }> = [];

      try {
        const { result, collector } = await runAgentTurn({
          ...turnParams,
          signal: requestSignal,
          // 人机确认链路:把 hook 链的提问下发到前端,挂起等待 /api/agent/answer 应答
          resolveUserQuestion: async (question) => {
            const { id, promise } = createPendingQuestion(traceId, question);
            const askEvent = { type: "ask_user", questionId: id, question };
            askEvents.push(askEvent);
            enqueue(askEvent);
            const answer = await promise;
            const answeredEvent = { type: "ask_user_answered", questionId: id, answer };
            askEvents.push(answeredEvent);
            enqueue(answeredEvent);
            return answer;
          },
          emitChunk: (text) => enqueue({ type: "chunk", content: text }),
          emitAgentEvent: (event) => enqueue({ type: "agent_event", event }),
        });

        collector.collectedEvents.push(...askEvents);
        const { generatedAttachments } = persistAgentTurn({ ...persistParams, result, collector });
        writeSpan({ traceId, spanType: "stream", name: "SSE stream", startedAt, durationMs: Date.now() - startedAt });

        enqueue({ type: "done", conversationId, conversation: conversationId ? getChatConversation(conversationId) : null, generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined });
        // done 已发(前端先进 done/绿点);标题异步提炼,保持流开到它落定再推一条 title 事件,
        // 让对话内 header 与侧栏标题一次性同步(回合已离开页面也能收到,因为生成不随导航 abort)。
        try {
          if (conversationId) {
            const improvedTitle = await improveConversationTitle(conversationId);
            if (improvedTitle) enqueue({ type: "title", conversationId, title: improvedTitle });
          }
        } catch { /* 已被停止/abort 关流 → 忽略 */ }
        try { controller.close(); } catch { /* already closed */ }
      } catch (error) {
        cancelPendingQuestions(traceId);
        const msg = error instanceof Error ? error.message : String(error);
        // 流式聊天的真实失败路径:前端只收到 redact 后的 incomplete/error 文案,原始错误在这里落盘留底。
        void appendServerLog(`[agent-query/stream] failed traceId=${traceId} ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
        const collector = (error as { __collector?: AgentTurnCollector }).__collector;
        if (collector) {
          // 出错也保留已完成的部分:落库(消息+中间事件+文件)并发 incomplete,让前端立刻展示、可「继续」。
          collector.collectedEvents.push(...askEvents);
          const { generatedAttachments } = persistIncompleteTurn({ ...persistParams, collector, errorMessage: msg });
          enqueue({
            type: "incomplete",
            conversationId,
            conversation: conversationId ? getChatConversation(conversationId) : null,
            generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined,
            message: redact(msg),
          });
        } else {
          writeAgentTrace({
            traceId, conversationId, startedAt,
            modelUsed: modelLabel(persistParams.routerResult), routerPath: persistParams.routerResult.path, errorMessage: msg,
            userMessage: persistParams.lastUserContent, finalAnswer: "", roleMode: persistParams.roleMode, toolCallCount: 0,
          });
          enqueue({ type: "error", message: redact(msg) });
        }
        controller.close();
      }
    }
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
}


function modelLabel(routerResult?: Awaited<ReturnType<typeof runRouter>>) {
  return routerResult?.decision?.mainModelTier ?? "main";
}

/** 用量超限:把红字提示作为本回合 assistant 回复落库(+usage_blocked 事件供前端红字渲染),
 * 用户消息已在 route 顶部入库,这里补齐 assistant 侧,使"对话内提示超限"在刷新后仍在。 */
function persistBlockedNotice(conversationId: number | undefined, notice: BlockedNotice, traceId: string): void {
  if (!conversationId) return;
  const messageId = insertChatMessage(conversationId, "assistant", notice.message);
  insertChatAgentEvent(
    messageId,
    "system",
    { type: "system", subtype: "usage_blocked", message: notice.message, resetAt: notice.resetAt, window: notice.window },
    traceId,
  );
}

/** 拦截响应:落库提示后,按流式/非流式返回 blocked 事件(不跑 router/agent)。 */
function buildUsageBlockedResponse(params: {
  notice: BlockedNotice;
  conversationId: number | undefined;
  traceId: string;
  useStreaming: boolean;
}) {
  const { notice, conversationId, traceId, useStreaming } = params;
  persistBlockedNotice(conversationId, notice, traceId);
  const conversation = conversationId ? getChatConversation(conversationId) : null;

  if (!useStreaming) {
    // content 带上提示文案;红字渲染由前端识别已落库的 usage_blocked 事件驱动(见 AssistantTurn)。
    return NextResponse.json({
      ok: true,
      data: { blocked: true, content: notice.message, message: notice.message, resetAt: notice.resetAt, window: notice.window, conversationId, conversation },
    });
  }

  // 流式:拦截无 LLM 产出,直接 meta→done。done 携带已落库会话(含 usage_blocked 事件),
  // 前端 done 后用 mergeFinalMessages 重建消息,AssistantTurn 据此把正文渲染成红字。
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      const enqueue = (o: Record<string, unknown>) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(o)}\n\n`));
      if (conversationId) enqueue({ type: "meta", conversationId });
      enqueue({ type: "done", conversationId, conversation });
      controller.close();
    },
  });
  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
}

/** 观测保真:有真实 usage 时记真实模型 id(modelUsage 的键),否则回落到分层名(cheap/错误路径无 usage)。 */
function pickRealModel(result: AgentTurnResult, routerResult?: Awaited<ReturnType<typeof runRouter>>): string {
  if ("modelUsage" in result && result.modelUsage) {
    const keys = Object.keys(result.modelUsage);
    if (keys.length) return keys.join(",");
  }
  return modelLabel(routerResult);
}

// ─── request parsing ────────────────────────────────────────────────

async function parseMultipartRequest(request: Request, traceId: string) {
  const formData = await request.formData();
  const messages: AgentMessage[] = formData.get("messages") ? (JSON.parse(formData.get("messages") as string) as AgentMessage[]) : [];
  let conversationId: number | undefined = (formData.get("conversationId") as string) ? Number(formData.get("conversationId")) : undefined;
  const uploadedFiles = formData.getAll("files") as File[];
  const attachments: AgentAttachment[] = [];

  if (uploadedFiles.length > 0) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    if (!conversationId && lastUser?.content.trim()) {
      conversationId = createChatConversation(generateShortTitle(lastUser.content.trim()));
      log.info("conversation created for files", { traceId, conversationId });
    }
    if (conversationId) {
      const uploadDir = path.join(getConversationFilesDir(conversationId), "upload");
      mkdirSync(uploadDir, { recursive: true });
      for (const file of uploadedFiles) {
        const filePath = uniqueFilePath(uploadDir, file.name);
        const buffer = Buffer.from(await file.arrayBuffer());
        writeFileSync(filePath, buffer);
        const storedName = path.basename(filePath);
        attachments.push({ name: storedName, mimeType: file.type || guessMimeType(storedName), size: buffer.length, dataUrl: `data:${file.type || "application/octet-stream"};base64,${buffer.toString("base64")}`, storagePath: filePath });
      }
    }
  }

  const refJson = formData.get("referencedAttachments") as string | null;
  if (refJson) { try { attachments.push(...(JSON.parse(refJson) as AgentAttachment[])); } catch { /* ok */ } }

  return { messages, conversationId, attachments };
}

async function parseJsonRequest(request: Request) {
  const body = (await request.json()) as { conversationId?: number; messages?: AgentMessage[]; prompt?: string; attachments?: AgentAttachment[] };
  return { messages: body.messages ?? [{ role: "user" as const, content: body.prompt ?? "" }], conversationId: body.conversationId, attachments: body.attachments ?? [] };
}

// ─── string helpers ─────────────────────────────────────────────────

function shouldUseStreaming(request: Request): boolean {
  return new URL(request.url).searchParams.get("stream") !== "false";
}

function generateShortTitle(text: string): string {
  const cleaned = text.split(/\n\n(?:附件|用户随消息附加了)[\s\S]*/)[0].replace(/\n+/g, " ").trim() || "新对话";
  const first = cleaned.split(/[，。？！,.?!；;]/)[0].trim();
  return first.length <= 20 ? first : first.slice(0, 18) + "…";
}

/**
 * 首个完整回合(用户+助手各一条)提炼对话标题并落库,返回新标题(无改进/非首回合/失败 → null)。
 * 流式路径会 await 它再推 title 事件;非流式路径 fire-and-forget。失败静默(保留初始短标题,红线 4 不编造)。
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

function guessMimeType(fileName: string): string {
  const map: Record<string, string> = { ".png":"image/png",".jpg":"image/jpeg",".jpeg":"image/jpeg",".gif":"image/gif",".webp":"image/webp",".pdf":"application/pdf",".xlsx":"application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",".xls":"application/vnd.ms-excel",".csv":"text/csv",".docx":"application/vnd.openxmlformats-officedocument.wordprocessingml.document",".doc":"application/msword",".txt":"text/plain",".md":"text/markdown",".json":"application/json",".html":"text/html" };
  return map[path.extname(fileName).toLowerCase()] ?? "application/octet-stream";
}
