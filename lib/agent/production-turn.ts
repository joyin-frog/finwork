import { runPiAgent } from "@/lib/agent/pi/agent-service";
import type {
  AgentAttachment,
  AgentFoundationContext,
  AgentMessage,
  AgentModelUsage,
  AgentQuestion,
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
  onRuntimeEvent?: (event: AgentRuntimeEvent) => void;
};

export type AgentTurnResult =
  | { mode: "cheap"; content: string; runtimeSessionId: string | null; direct: true }
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
    collector.collectedChunks.push(answer);
    coalesceTextIntoEvents(collector.collectedEvents, answer);
    return { result: { mode: "cheap", content: answer, runtimeSessionId, direct: true }, collector };
  }

  const idFilter = createStreamingIdentityFilter();
  const runStart = Date.now();
  let thinkingSeen = false;
  let firstOutputAt: number | undefined;
  let nonStreamSeq = 0;
  const runCounter = params.runCounter ?? { next: () => ++nonStreamSeq };
  const mainEmitter = createEmitter(traceId, params.conversationId ?? null, null, runCounter);

  const handleEmit = (event: AgentRuntimeEvent, emitter: AgentEmitter) => {
    params.onRuntimeEvent?.(event);
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
  };

  const data = await runPiAgent({
    messages: agentMessages,
    runtimeSessionId,
    resumeSession: Boolean(existingRuntimeSessionId),
    requestId: traceId,
    attachments,
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
    }),
    executionTier: params.executionTier,
    intent: routerResult.decision.intent,
    foundation: params.foundation,
    emit: (event) => handleEmit(event, mainEmitter),
    onSubagentEvent: (event, instanceId) => {
      const subEmitter = createEmitter(traceId, params.conversationId ?? null, instanceId, runCounter);
      handleEmit(event, subEmitter);
    },
  }).catch((error: unknown) => {
    if (thinkingSeen) {
      const thinkingMs = Math.max(0, (firstOutputAt ?? Date.now()) - runStart);
      collector.collectedEvents.push({ type: "system", subtype: "thinking_duration", message: String(thinkingMs) });
    }
    (error as { __collector?: AgentTurnCollector }).__collector = collector;
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
  return { result: { ...data, content: filteredContent, direct: false }, collector };
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
