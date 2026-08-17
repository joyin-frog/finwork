import {
  needsStructuredQuestionRepair,
  runPiAgent,
  type PiAgentServiceOptions,
} from "@/lib/agent/pi/agent-service";
import type {
  AgentAttachment,
  AgentFoundationContext,
  AgentMessage,
  AgentModelUsage,
  AgentQuestion,
  AgentWorkPlanSummary,
} from "@/lib/agent/contracts";
import { filterIdentity, createStreamingIdentityFilter } from "@/lib/safety/identity-filter";
import { redact } from "@/lib/safety/pii";
import type { runRouter } from "@/lib/agent/router";
import {
  createEmitter,
  contractToLegacyEvents,
  type AgentRuntimeEvent,
  type AgentEventEnvelope,
  type AgentEmitter,
} from "@/lib/agent/runtime-events";
import { persistRuntimeEnvelope, type RunPersistenceContext } from "@/lib/agent/run-event-persistence";
import { deriveTaskContractForTurn, type TaskContract } from "@/lib/agent/run-contract";
import { prefetchRouterKnowledge } from "@/lib/agent/retrieval-prefetch";

/**
 * Production agent turn shared by the HTTP route and benchmark execution.
 * Keep transport, UI persistence, and benchmark scoring outside this module.
 */
export type AgentTurnCollector = {
  collectedChunks: string[];
  collectedEvents: Array<{ type: string; [key: string]: unknown }>;
};

export type AgentTurnParams = {
  traceId: string;
  agentMessages: AgentMessage[];
  runtimeSessionId: string | null;
  existingRuntimeSessionId: string | null;
  attachments: AgentAttachment[];
  workspaceRootIds?: string[];
  outputDir: string | undefined;
  routerResult: Awaited<ReturnType<typeof runRouter>>;
  modelOverride?: string;
  roleId?: string | null;
  signal?: AbortSignal;
  resolveUserQuestion?: (question: AgentQuestion) => Promise<string>;
  emitEnvelope?: (env: AgentEventEnvelope) => void;
  conversationId?: number;
  runCounter?: { next: () => number };
  runPersist?: RunPersistenceContext;
  taskContract?: TaskContract | null;
  executionTier?: import("@/lib/settings/model-config").ExecutionTier | null;
  foundation?: AgentFoundationContext;
  workPlan?: AgentWorkPlanSummary;
  onRuntimeEvent?: (event: AgentRuntimeEvent) => AgentRuntimeEvent[] | void;
  /** Caller-owned hard limits; benchmark execution uses the V3 contract budget. */
  agentServiceOptions?: PiAgentServiceOptions;
  /** Provider/service seam for integration tests; production uses runPiAgent. */
  agentRunner?: typeof runPiAgent;
};

export type AgentTurnResult =
  | {
      mode: "cheap";
      content: string;
      runtimeSessionId: string | null;
      modelUsage?: Record<string, AgentModelUsage>;
      direct: true;
    }
  | {
      mode: string;
      content: string;
      runtimeSessionId: string | null;
      modelUsage?: Record<string, AgentModelUsage>;
      totalCostUsd?: number;
      numTurns?: number;
      roleMode?: string;
      direct: false;
    };

export async function runAgentTurn(
  params: AgentTurnParams,
): Promise<{ result: AgentTurnResult; collector: AgentTurnCollector }> {
  const { traceId, agentMessages, runtimeSessionId, existingRuntimeSessionId, attachments, outputDir, routerResult } = params;
  const collector: AgentTurnCollector = { collectedChunks: [], collectedEvents: [] };

  if (routerResult.path === "cheap" && routerResult.decision.directAnswer) {
    const answer = filterIdentity(routerResult.decision.directAnswer);
    params.onRuntimeEvent?.({ type: "message_started", channel: "text" });
    params.onRuntimeEvent?.({ type: "message_completed", channel: "text", content: answer });
    collector.collectedChunks.push(answer);
    coalesceTextIntoEvents(collector.collectedEvents, answer);
    return {
      result: {
        mode: "cheap",
        content: answer,
        runtimeSessionId,
        modelUsage: routerUsage(routerResult),
        direct: true,
      },
      collector,
    };
  }

  const idFilter = createStreamingIdentityFilter();
  const runStart = Date.now();
  let thinkingSeen = false;
  let firstOutputAt: number | undefined;
  let nonStreamSeq = 0;
  const runCounter = params.runCounter ?? { next: () => ++nonStreamSeq };
  const mainEmitter = createEmitter(traceId, params.conversationId ?? null, null, runCounter);

  const handleEmit = (event: AgentRuntimeEvent, emitter: AgentEmitter) => {
    const derivedEvents = params.onRuntimeEvent?.(event) ?? [];
    let filteredEvent: AgentRuntimeEvent = event;

    if (event.type === "ask_user") {
      alignPendingQuestionContent(collector, event.question);
    }

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
    } else if (event.type === "tool_started" && firstOutputAt == null) {
      firstOutputAt = Date.now();
    }

    const envelope = emitter.wrap(filteredEvent);
    for (const legacyEvent of contractToLegacyEvents(envelope)) {
      if (legacyEvent.type === "text") {
        coalesceTextIntoEvents(collector.collectedEvents, (legacyEvent as { content: string }).content);
      } else {
        collector.collectedEvents.push(legacyEvent as { type: string; [key: string]: unknown });
      }
    }
    if (params.runPersist) persistRuntimeEnvelope(envelope, params.runPersist);
    params.emitEnvelope?.(envelope);
    for (const derivedEvent of derivedEvents) {
      const derivedEnvelope = emitter.wrap(derivedEvent);
      if (params.runPersist) persistRuntimeEnvelope(derivedEnvelope, params.runPersist);
      params.emitEnvelope?.(derivedEnvelope);
    }
  };

  const preparedAgentMessages = await prefetchRouterKnowledge(agentMessages, routerResult.decision);
  const data = await (params.agentRunner ?? runPiAgent)({
    messages: preparedAgentMessages,
    runtimeSessionId,
    resumeSession: Boolean(existingRuntimeSessionId),
    requestId: traceId,
    attachments,
    workspaceRootIds: params.workspaceRootIds,
    outputDir,
    traceId,
    conversationId: params.conversationId,
    modelOverride: params.modelOverride,
    roleId: params.roleId,
    signal: params.signal,
    resolveUserQuestion: params.resolveUserQuestion,
    taskContract: params.taskContract ?? deriveTaskContractForTurn({
      intent: routerResult.decision.intent,
      attachments,
      userMessage: [...agentMessages].reverse().find((message) => message.role === "user")?.content,
    }),
    executionTier: params.executionTier,
    intent: routerResult.decision.intent,
    foundation: params.foundation,
    workPlan: params.workPlan,
    emit: (event) => handleEmit(event, mainEmitter),
    onSubagentEvent: (event, instanceId) => {
      const subEmitter = createEmitter(traceId, params.conversationId ?? null, instanceId, runCounter);
      handleEmit(event, subEmitter);
    },
  }, params.agentServiceOptions).catch((error: unknown) => {
    if (thinkingSeen) {
      const thinkingMs = Math.max(0, (firstOutputAt ?? Date.now()) - runStart);
      collector.collectedEvents.push({ type: "system", subtype: "thinking_duration", message: String(thinkingMs) });
    }
    (error as { __collector?: AgentTurnCollector }).__collector = collector;
    const accountingError = error as { __modelUsage?: Record<string, AgentModelUsage> };
    accountingError.__modelUsage = mergeModelUsage(routerUsage(routerResult), accountingError.__modelUsage);
    throw error;
  });

  const tail = idFilter.flush();
  if (tail) {
    collector.collectedChunks.push(tail);
    coalesceTextIntoEvents(collector.collectedEvents, tail);
    params.emitEnvelope?.(mainEmitter.wrap({ type: "message_delta", channel: "text", delta: tail }));
  }
  if (thinkingSeen) {
    const thinkingMs = Math.max(0, (firstOutputAt ?? Date.now()) - runStart);
    collector.collectedEvents.push({ type: "system", subtype: "thinking_duration", message: String(thinkingMs) });
  }

  const filteredContent = assembleAssistantContent(collector.collectedEvents, collector.collectedChunks)
    || filterIdentity(data.content ?? "");
  return {
    result: {
      ...data,
      content: filteredContent,
      modelUsage: mergeModelUsage(routerUsage(routerResult), data.modelUsage),
      direct: false,
    },
    collector,
  };
}

function routerUsage(routerResult: AgentTurnParams["routerResult"]): Record<string, AgentModelUsage> | undefined {
  const usage = routerResult.usage;
  if (!usage) return undefined;
  return {
    [usage.modelId]: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      cacheReadInputTokens: usage.cacheReadInputTokens,
      cacheCreationInputTokens: usage.cacheCreationInputTokens,
    },
  };
}

export function mergeModelUsage(
  ...sources: Array<Record<string, AgentModelUsage> | undefined>
): Record<string, AgentModelUsage> | undefined {
  const merged: Record<string, AgentModelUsage> = {};
  for (const source of sources) {
    for (const [modelId, usage] of Object.entries(source ?? {})) {
      const current = merged[modelId] ?? {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      };
      merged[modelId] = {
        inputTokens: current.inputTokens + usage.inputTokens,
        outputTokens: current.outputTokens + usage.outputTokens,
        cacheReadInputTokens: current.cacheReadInputTokens + usage.cacheReadInputTokens,
        cacheCreationInputTokens: current.cacheCreationInputTokens + usage.cacheCreationInputTokens,
      };
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function coalesceTextIntoEvents(
  events: Array<{ type: string; [key: string]: unknown }>,
  content: string,
): void {
  const last = events[events.length - 1];
  if (last?.type === "text") {
    (last as { type: string; content: string }).content += content;
  } else {
    events.push({ type: "text", content });
  }
}

export function assembleAssistantContent(
  events: Array<{ type: string; [key: string]: unknown }>,
  chunks: string[],
): string {
  const fromEvents = events
    .filter((event) => event.type === "text")
    .map((event) => String((event as { content?: unknown }).content ?? "").trim())
    .filter(Boolean)
    .join("\n\n");
  return fromEvents || chunks.join("");
}

/**
 * 协议修复前的普通文本只是临时提问草稿；一旦结构化 ask_user 成功发出，
 * 持久化内容必须以真正展示给用户的问题为准，不能继续保留被工具门禁剔除的
 * 猜测日期、主体或金额候选值。
 */
export function alignPendingQuestionContent(
  collector: AgentTurnCollector,
  question: { question: string; questions?: Array<{ question: string }> },
): boolean {
  const priorText = assembleAssistantContent(collector.collectedEvents, collector.collectedChunks);
  if (!needsStructuredQuestionRepair(priorText)) return false;
  const authoritativeText = (question.questions?.length
    ? question.questions.map((item) => item.question).join("\n")
    : question.question).trim();
  if (!authoritativeText) return false;

  const firstTextIndex = collector.collectedEvents.findIndex((event) => event.type === "text");
  collector.collectedEvents = collector.collectedEvents.filter((event) => event.type !== "text");
  collector.collectedEvents.splice(Math.max(0, firstTextIndex), 0, {
    type: "text",
    content: authoritativeText,
  });
  collector.collectedChunks.splice(0, collector.collectedChunks.length, authoritativeText);
  return true;
}
