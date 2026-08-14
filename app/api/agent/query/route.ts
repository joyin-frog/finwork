import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import type {
  AgentModelUsage,
  AgentQuestion,
} from "@/lib/agent/contracts";
import { writeSpan } from "@/lib/observability/spans";
import { writeAgentTrace } from "@/lib/observability/trace-write";
import { readAgentSettings } from "@/lib/settings/agent-settings";
import {
  getChatConversation,
  getDb,
  updateChatConversationTitle
} from "@/lib/db/sqlite";
import { filterIdentity } from "@/lib/safety/identity-filter";
import { runRouter } from "@/lib/agent/router";
import { generateConversationTitle } from "@/lib/agent/conversation-title";
import { cancelPendingQuestions, createPendingQuestion } from "@/lib/agent/pending-questions";
import { redact } from "@/lib/safety/pii";
import { appendServerLog } from "@/lib/runtime/server-log";
import { createLogger } from "@/lib/runtime/logger";
import { parseStage, sessionStage, quotaStage, routerStage } from "@/lib/agent/query-stages";
import {
  createEmitter,
  type AgentEventEnvelope,
} from "@/lib/agent/runtime-events";
import { resolveRunExecutionModel } from "@/lib/agent/resolve-run-model";
import {
  createRunPersistenceContext,
  markRunRunning,
  persistRuntimeEnvelope,
  withRunEventPersistence,
  type RunPersistenceContext,
} from "@/lib/agent/run-event-persistence";
import { deriveTaskContractForTurn, isTerminalRunStatus, type TaskContract } from "@/lib/agent/run-contract";
import {
  registerRunAbort,
  unregisterRunAbort,
} from "@/lib/agent/run-abort-registry";
import { decideSettleFromCompletionGate } from "@/lib/agent/completion-gate-settle";
import { getAgentRun, updateAgentRunStatus } from "@/lib/db/run-store";
import {
  beginProductionTaskRun,
  type ProductionTaskRun,
} from "@/lib/task/production-runtime";
import {
  runAgentTurn,
  type AgentTurnCollector,
  type AgentTurnParams,
} from "@/lib/agent/production-turn";
import {
  modelLabel,
  persistAgentTurn,
  persistIncompleteTurn,
  type PersistTurnParams,
} from "@/lib/agent/turn-persistence";

const log = createLogger("agent-query");

export async function POST(request: Request) {
  const traceId = randomUUID();
  const startedAt = Date.now();
  const settings = await readAgentSettings().catch(() => ({ roleMode: "tech" as const, fastModel: "", reasoningModel: "" })) as Awaited<ReturnType<typeof readAgentSettings>>;
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
    conversationId, existingRuntimeSessionId, runtimeSessionId,
    agentMessages, attachments, outputDir, beforeGenerate,
    lastUserContent, useStreaming, routerResult, modelOverride: tierModelOverride,
    sessionRoleId, modelTier,
  } = r;

  // ── CR-R1: Router 之后真实模型接线（只消费 resolveExecutionModel）──
  const resolvedModel = resolveRunExecutionModel({
    settings,
    modelTier,
    routerPath: routerResult.path,
    routerFailureHint: routerResult.path === "fallback" ? routerResult.decision.reasoning : null,
  });
  const modelOverride = resolvedModel?.modelId ?? tierModelOverride;
  let foundationTaskRun: ProductionTaskRun | undefined;

  // --- Run agent ---
  try {
    log.info("agent start", {
      traceId, conversationId, runtimeSessionId, streaming: useStreaming,
      model: modelOverride ?? null,
      modelRole: resolvedModel?.executionRole ?? null,
      executionTier: resolvedModel?.executionTier ?? null,
      fallbackReason: resolvedModel?.fallbackReason ?? null,
    });

    const runPersist = createRunPersistenceContext({
      runId: traceId,
      traceId,
      conversationId: conversationId ?? null,
      sessionId: runtimeSessionId,
      modelUsed: resolvedModel?.modelId ?? modelOverride ?? null,
      modelRole: resolvedModel?.executionRole ?? null,
      executionTier: resolvedModel?.executionTier ?? null,
      modelFallbackReason: resolvedModel?.fallbackReason ?? null,
      status: "queued",
    });

    const taskContract = deriveTaskContractForTurn({
      intent: routerResult.decision.intent,
      attachments,
    });
    foundationTaskRun = beginProductionTaskRun({
      db: getDb(),
      traceId,
      conversationId,
      goal: lastUserContent,
      attachments,
      legacyContract: taskContract,
      roleId: sessionRoleId,
    });
    const turnParams: AgentTurnParams = {
      traceId, agentMessages, runtimeSessionId, existingRuntimeSessionId,
      attachments, outputDir, routerResult, conversationId,
      // CR-R1：resolveExecutionModel 结果 → SDK model / ANTHROPIC_MODEL
      modelOverride,
      // 专员会话（E 刀）:以会话绑定的角色身份运行本回合
      roleId: sessionRoleId,
      runPersist,
      taskContract,
      executionTier: resolvedModel?.executionTier ?? null,
      foundation: foundationTaskRun.foundation,
      onRuntimeEvent: (event) => foundationTaskRun?.recordRuntimeEvent(event),
    };
    const persistParams: PersistTurnParams = {
      conversationId, existingRuntimeSessionId, beforeGenerate,
      traceId, startedAt, routerResult, lastUserContent, roleMode,
      resolvedModel,
    };

    if (useStreaming) {
      return createStreamingResponse({
        turnParams, persistParams, conversationId, traceId, startedAt,
        requestSignal: request.signal, runPersist, foundationTaskRun,
      });
    }

    // 非流式：同样写 run_started / running / settled
    {
      const emitter = createEmitter(traceId, conversationId ?? null);
      const startedEnv = emitter.wrap({ type: "run_started", conversationId: conversationId ?? null });
      persistRuntimeEnvelope(startedEnv, runPersist);
      markRunRunning(runPersist, (e) => emitter.wrap(e));
    }

    const { result, collector } = await runAgentTurn(turnParams);
    const { messageId, generatedAttachments } = persistAgentTurn({ ...persistParams, result, collector });
    {
      const emitter = createEmitter(traceId, conversationId ?? null);
      foundationTaskRun.markValidating();
      const gateDecision = decideSettleFromCompletionGate(traceId, turnParams.taskContract);
      foundationTaskRun.settle({
        outcome: gateDecision.outcome,
        message: gateDecision.gateMessage,
        assistantMessageId: messageId,
      });
      const endedEnv = emitter.wrap({
        type: "run_ended",
        kind: gateDecision.outcome === "completed" ? "complete" : "incomplete",
        message: gateDecision.gateMessage,
      });
      persistRuntimeEnvelope(endedEnv, runPersist);
      const settledEnv = emitter.wrap({
        type: "run_settled",
        outcome: gateDecision.outcome,
        error: gateDecision.gateMessage,
      });
      persistRuntimeEnvelope(settledEnv, runPersist);
      const after = getAgentRun(traceId);
      if (after) {
        updateAgentRunStatus(traceId, after.status, {
          qualityStatus: gateDecision.qualityStatus,
          terminationReason: gateDecision.terminationReason ?? null,
          errorMessage: gateDecision.gateMessage ?? null,
        });
      }
    }
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
    const partialUsage = (error as { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage;
    const isAbort = error instanceof Error && error.name === "AbortError";
    if (collector) {
      persistIncompleteTurn({ conversationId, existingRuntimeSessionId, beforeGenerate, traceId, startedAt, routerResult, lastUserContent, roleMode, collector, errorMessage: message, modelUsage: partialUsage, resolvedModel });
    } else {
      writeAgentTrace({
        traceId, conversationId, startedAt,
        modelUsed: resolvedModel?.modelId ?? modelLabel(routerResult),
        routerPath: routerResult.path, errorMessage: message, userMessage: lastUserContent.slice(0, 500),
        finalAnswer: "", roleMode, toolCallCount: 0, modelUsage: partialUsage,
        executionTier: resolvedModel?.executionTier,
      });
    }
    try {
      foundationTaskRun?.settle({
        outcome: isAbort ? "aborted" : "error",
        message: redact(message),
      });
    } catch (foundationError) {
      log.error("foundation task error settlement failed", { traceId, error: foundationError });
    }
    try {
      const emitter = createEmitter(traceId, conversationId ?? null);
      const settledEnv = emitter.wrap({
        type: "run_settled",
        outcome: isAbort ? "aborted" : "error",
        error: redact(message),
      });
      persistRuntimeEnvelope(settledEnv);
    } catch { /* best-effort */ }
    return NextResponse.json({ ok: false, error: redact(message), data: { conversationId, conversation: conversationId ? getChatConversation(conversationId) : null } }, { status: 502 });
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
  runPersist: RunPersistenceContext;
  foundationTaskRun: ProductionTaskRun;
}) {
  const {
    turnParams,
    persistParams,
    conversationId,
    traceId,
    startedAt,
    requestSignal,
    runPersist,
    foundationTaskRun,
  } = params;
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let streamClosed = false;
      // CR-R2：Run 生命周期独立于 SSE 订阅；仅显式 stop / 硬超时 abort 此 controller。
      const runAbort = new AbortController();
      registerRunAbort(traceId, runAbort, conversationId ?? null);

      requestSignal?.addEventListener("abort", () => {
        // 只关订阅；不 cancelPendingQuestions（断线后 Run 继续，用户可重连再答）。
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

      // enqueueEnvelope: SSE 实时通道；durable 事件另由 persistRuntimeEnvelope / runAgentTurn 落库
      const enqueueEnvelope = (env: AgentEventEnvelope) => enqueue(env as unknown as Record<string, unknown>);
      // settle / ask_user 等旁路事件：先持久再 SSE（与 handleEmit 对称；delta 仍不落库）
      const emitAndPersist = withRunEventPersistence(enqueueEnvelope, runPersist);

      // 新会话:一开始就把 conversationId + runId 下发（保留 meta 帧兼容旧客户端）
      if (conversationId) enqueue({ type: "meta", conversationId, runId: traceId });
      else enqueue({ type: "meta", runId: traceId });

      // CR-R1：run_started + queued→running（持久 + SSE）
      {
        const startedEnv = streamEmitter.wrap({ type: "run_started", conversationId: conversationId ?? null });
        emitAndPersist(startedEnv);
        markRunRunning(runPersist, (e) => streamEmitter.wrap(e), enqueueEnvelope);
      }

      // 确认事件在回合执行中产生，先本地收集，回合结束后并入 collector 落库
      const askEvents: Array<{ type: string; [key: string]: unknown }> = [];

      /** AR2a: 三路径共用收口 —— 发 run_ended + run_settled（CR-R1 同时落库）。
       *  若 stop API 已写终态，则幂等跳过。 */
      const settleRun = (outcome: "completed" | "aborted" | "error", opts?: { message?: string }) => {
        const existing = getAgentRun(traceId);
        if (existing && isTerminalRunStatus(existing.status)) return;
        const endedEnv = streamEmitter.wrap({
          type: "run_ended",
          kind: outcome === "completed" ? "complete" : "incomplete",
          message: opts?.message,
        });
        emitAndPersist(endedEnv);
        const settledEnv = streamEmitter.wrap({ type: "run_settled", outcome, error: opts?.message });
        emitAndPersist(settledEnv);
      };

      try {
        const { result, collector } = await runAgentTurn({
          ...turnParams,
          signal: runAbort.signal,
          // handleEmit 已 persist；此处只推 SSE，避免 double-write
          emitEnvelope: enqueueEnvelope,
          runCounter, // B2 修复：流式路径共享计数器
          runPersist,
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
        const { messageId, generatedAttachments } = persistAgentTurn({ ...persistParams, result, collector });
        writeSpan({ traceId, spanType: "stream", name: "SSE stream", startedAt, durationMs: Date.now() - startedAt });

        // CR-R2：CompletionGate —— 有交付合同则不得仅凭 agent 结束标 completed
        foundationTaskRun.markValidating();
        const gateDecision = decideSettleFromCompletionGate(traceId, turnParams.taskContract);
        foundationTaskRun.settle({
          outcome: gateDecision.outcome,
          message: gateDecision.gateMessage,
          assistantMessageId: messageId,
        });
        settleRun(gateDecision.outcome, gateDecision.gateMessage ? { message: gateDecision.gateMessage } : undefined);
        {
          const after = getAgentRun(traceId);
          if (after) {
            updateAgentRunStatus(traceId, after.status, {
              qualityStatus: gateDecision.qualityStatus,
              terminationReason: gateDecision.terminationReason ?? null,
              errorMessage: gateDecision.gateMessage ?? null,
            });
          }
        }

        // 向前兼容：继续发送旧帧 done / incomplete（gate 失败走 incomplete，避免 UI 假成功）
        if (gateDecision.outcome === "completed") {
          enqueue({ type: "done", conversationId, conversation: conversationId ? getChatConversation(conversationId) : null, generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined });
        } else {
          enqueue({
            type: "incomplete",
            conversationId,
            conversation: conversationId ? getChatConversation(conversationId) : null,
            generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined,
            message: gateDecision.gateMessage,
          });
        }
        // 标题异步提炼，settled 已发（前端不阻塞），title_updated 随后到达（conversation 级，不进 run_events）
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
        const partialUsage = (error as { __modelUsage?: Record<string, AgentModelUsage> }).__modelUsage;
        // AR2a: 三路径收口 — abort 路径 vs 错误路径（stop API 已 settle 则跳过）
        const isAbort = error instanceof Error && error.name === "AbortError";
        const already = getAgentRun(traceId);
        const skipClientFrames = already && isTerminalRunStatus(already.status) && already.terminationReason === "user_stop";
        try {
          foundationTaskRun.settle({
            outcome: isAbort ? "aborted" : "error",
            message: redact(msg),
          });
        } catch (foundationError) {
          log.error("foundation task stream settlement failed", { traceId, error: foundationError });
        }
        if (collector) {
          collector.collectedEvents.push(...askEvents);
          const { generatedAttachments } = persistIncompleteTurn({ ...persistParams, collector, errorMessage: msg, modelUsage: partialUsage });
          settleRun(isAbort ? "aborted" : "error", { message: redact(msg) });
          if (!skipClientFrames) {
            enqueue({ type: "incomplete", conversationId, conversation: conversationId ? getChatConversation(conversationId) : null, generatedAttachments: generatedAttachments.length ? generatedAttachments : undefined, message: redact(msg) });
          }
        } else {
          writeAgentTrace({
            traceId, conversationId, startedAt,
            modelUsed: persistParams.resolvedModel?.modelId ?? modelLabel(persistParams.routerResult),
            routerPath: persistParams.routerResult.path, errorMessage: msg,
            userMessage: persistParams.lastUserContent, finalAnswer: "", roleMode: persistParams.roleMode, toolCallCount: 0,
            modelUsage: partialUsage,
            executionTier: persistParams.resolvedModel?.executionTier,
          });
          settleRun(isAbort ? "aborted" : "error", { message: redact(msg) });
          if (!skipClientFrames) {
            enqueue({ type: "error", message: redact(msg) });
          }
        }
        try { controller.close(); } catch { /* already closed */ }
      } finally {
        unregisterRunAbort(traceId);
      }
    }
  });

  return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" } });
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
