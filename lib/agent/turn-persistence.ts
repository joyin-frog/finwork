import type { AgentModelUsage } from "@/lib/agent/contracts";
import {
  assembleAssistantContent,
  type AgentTurnCollector,
  type AgentTurnResult,
} from "@/lib/agent/production-turn";
import type { runRouter } from "@/lib/agent/router";
import { cleanupUnfinalizedFiles, recordNewGeneratedFiles } from "@/lib/chat/generated-files";
import {
  getDb,
  insertChatAgentEvent,
  insertChatMessage,
  setChatConversationRuntimeSession,
} from "@/lib/db/sqlite";
import { sanitizeTurnEvents } from "@/lib/agent/persist-hygiene";
import { writeAgentTrace } from "@/lib/observability/trace-write";
import type { ResolvedModel } from "@/lib/settings/model-config";

export type PersistTurnParams = {
  conversationId: number | undefined;
  existingRuntimeSessionId: string | null;
  beforeGenerate: Set<string>;
  /** 本回合 run/work 的执行前快照；旧调用可省略并继续使用会话 generate。 */
  beforeWorking?: Set<string>;
  outputDir?: string;
  traceId: string;
  startedAt: number;
  routerResult: Awaited<ReturnType<typeof runRouter>>;
  lastUserContent: string;
  roleMode: string;
  resolvedModel?: ResolvedModel | null;
  retryCount?: number;
};

export type PersistedAgentTurn = {
  messageId?: number;
  fullContent: string;
  generatedAttachments: ReturnType<typeof recordNewGeneratedFiles>;
};

/** Count attempted tool invocations once; completion events are not calls. */
export function countToolCalls(events: AgentTurnCollector["collectedEvents"]): number {
  const seenIds = new Set<string>();
  let count = 0;
  for (const event of events) {
    if (event.type !== "tool_use" && event.type !== "tool_started") continue;
    const id = event.type === "tool_use"
      ? (typeof event.id === "string" ? event.id : undefined)
      : (typeof event.toolCallId === "string" ? event.toolCallId : undefined);
    if (id) {
      if (seenIds.has(id)) continue;
      seenIds.add(id);
    }
    count += 1;
  }
  return count;
}

/** Assistant-message persistence is shared by HTTP and benchmark execution. */
export function insertAssistantTurn(
  conversationId: number,
  content: string,
  collector: AgentTurnCollector,
  traceId: string,
): number {
  const db = getDb();
  db.exec("BEGIN");
  try {
    const messageId = insertChatMessage(conversationId, "assistant", content);
    for (const event of sanitizeTurnEvents(collector.collectedEvents)) {
      insertChatAgentEvent(messageId, event.type, event, traceId);
    }
    db.exec("COMMIT");
    return messageId;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* preserve original error */ }
    throw error;
  }
}

/** The single successful-turn persistence boundary used by production transports. */
export function persistAgentTurn(
  params: PersistTurnParams & { result: AgentTurnResult; collector: AgentTurnCollector },
): PersistedAgentTurn {
  const {
    conversationId,
    existingRuntimeSessionId,
    beforeGenerate,
    traceId,
    startedAt,
    routerResult,
    lastUserContent,
    roleMode,
    result,
    collector,
  } = params;

  if (conversationId && result.runtimeSessionId && result.runtimeSessionId !== existingRuntimeSessionId) {
    setChatConversationRuntimeSession(conversationId, result.runtimeSessionId);
  }

  let messageId: number | undefined;
  const fullContent = result.content || assembleAssistantContent(collector.collectedEvents, collector.collectedChunks);
  if (conversationId && fullContent.trim()) {
    collector.collectedEvents.push({
      type: "system",
      subtype: "turn_duration",
      message: String(Math.max(0, Date.now() - startedAt)),
    });
    messageId = insertAssistantTurn(conversationId, fullContent, collector, traceId);
  }

  cleanupUnfinalizedFiles(conversationId, params.beforeWorking ?? beforeGenerate, params.outputDir);
  const generatedAttachments = recordNewGeneratedFiles(conversationId, messageId, beforeGenerate);
  const toolCallCount = countToolCalls(collector.collectedEvents);
  const resolved = params.resolvedModel;
  writeAgentTrace({
    traceId,
    conversationId,
    startedAt,
    modelUsed: resolved?.modelId ?? pickRealModel(result, routerResult),
    routerPath: routerResult.path,
    errorMessage: null,
    userMessage: lastUserContent,
    finalAnswer: fullContent,
    roleMode,
    modelUsage: "modelUsage" in result ? result.modelUsage : undefined,
    totalCostUsd: "totalCostUsd" in result ? result.totalCostUsd : undefined,
    numTurns: "numTurns" in result ? result.numTurns : undefined,
    llmCallCount: "numTurns" in result ? result.numTurns : undefined,
    toolCallCount,
    retryCount: params.retryCount,
    executionTier: resolved?.executionTier,
  });

  return { messageId, fullContent, generatedAttachments };
}

/** Persist partial work after an interrupted or failed production turn. */
export function persistIncompleteTurn(
  params: PersistTurnParams & {
    collector: AgentTurnCollector;
    errorMessage: string;
    modelUsage?: Record<string, AgentModelUsage>;
    numTurns?: number;
  },
): PersistedAgentTurn {
  const {
    conversationId,
    beforeGenerate,
    traceId,
    startedAt,
    routerResult,
    lastUserContent,
    roleMode,
    collector,
    errorMessage,
    modelUsage,
    numTurns,
    resolvedModel,
  } = params;

  const fullContent = assembleAssistantContent(collector.collectedEvents, collector.collectedChunks);
  const hasWork = fullContent.trim().length > 0
    || collector.collectedEvents.some((event) => event.type === "tool_use" || event.type === "ask_user");
  let messageId: number | undefined;
  if (conversationId && hasWork) {
    collector.collectedEvents.push({ type: "system", subtype: "turn_incomplete", message: errorMessage });
    collector.collectedEvents.push({
      type: "system",
      subtype: "turn_duration",
      message: String(Math.max(0, Date.now() - startedAt)),
    });
    messageId = insertAssistantTurn(
      conversationId,
      fullContent.trim() || "**本回合未完成，已保留已做的部分，可发「继续」让我接着做**",
      collector,
      traceId,
    );
  }

  const generatedAttachments = recordNewGeneratedFiles(conversationId, messageId, beforeGenerate);
  const toolCallCount = countToolCalls(collector.collectedEvents);
  writeAgentTrace({
    traceId,
    conversationId,
    startedAt,
    modelUsed: resolvedModel?.modelId ?? modelLabel(routerResult),
    routerPath: routerResult.path,
    errorMessage,
    userMessage: lastUserContent,
    finalAnswer: fullContent,
    roleMode,
    toolCallCount,
    retryCount: params.retryCount,
    modelUsage,
    numTurns,
    llmCallCount: numTurns,
    executionTier: resolvedModel?.executionTier,
  });
  return { messageId, fullContent, generatedAttachments };
}

export function modelLabel(routerResult?: Awaited<ReturnType<typeof runRouter>>): string {
  return routerResult?.path === "cheap" ? "router" : "agent";
}

/** Preserve actual provider model ids when the production SDK reports usage. */
export function pickRealModel(
  result: AgentTurnResult,
  routerResult?: Awaited<ReturnType<typeof runRouter>>,
): string {
  if ("modelUsage" in result && result.modelUsage) {
    const keys = Object.keys(result.modelUsage);
    if (keys.length) return keys.join(",");
  }
  return modelLabel(routerResult);
}
