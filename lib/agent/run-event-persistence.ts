/**
 * CR-R1：runtime envelope → 持久账本适配。
 * 不改变 AR2a SSE 形状；best-effort 落库，失败只告警。
 */

import {
  appendDurableRunEvent,
  createAgentRun,
  isDurableRunEventType,
  updateAgentRunStatus,
  upsertRunCheckpoint,
  type CreateAgentRunInput,
} from "@/lib/db/run-store";
import type { AgentEventEnvelope, AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import {
  buildRunStateChanged,
  type RunCheckpoint,
  type RunStatus,
} from "@/lib/agent/run-contract";
import { createLogger } from "@/lib/runtime/logger";

const log = createLogger("run-events");

const CHECKPOINT_TRIGGERS = new Set<AgentRuntimeEvent["type"]>([
  "tool_completed",
  "compaction_completed",
  "run_ended",
  "run_settled",
  "run_state_changed",
  "message_completed",
]);

export type RunPersistenceContext = {
  runId: string;
  /** 内存侧累计的已完成 toolCallId（供 checkpoint） */
  completedToolCallIds: string[];
  /** 规范化路径 + hash（无权限 grant） */
  generatedFiles: Array<{ path: string; sha256: string; status: string }>;
  lastCompletedStage?: string;
  sessionId?: string | null;
  status: RunStatus;
};

export function createRunPersistenceContext(
  input: CreateAgentRunInput,
): RunPersistenceContext {
  createAgentRun(input);
  return {
    runId: input.runId,
    completedToolCallIds: [],
    generatedFiles: [],
    sessionId: input.sessionId ?? null,
    status: input.status ?? "queued",
  };
}

/** queued → running（runtime 取得执行权），并发 run_state_changed。 */
export function markRunRunning(
  ctx: RunPersistenceContext,
  wrap: (event: AgentRuntimeEvent) => AgentEventEnvelope,
  emit?: (env: AgentEventEnvelope) => void,
): void {
  if (ctx.status !== "queued") return;
  const changed = buildRunStateChanged("queued", "runtime_acquired");
  if (!changed) return;
  ctx.status = "running";
  updateAgentRunStatus(ctx.runId, "running");
  const env = wrap({
    type: "run_state_changed",
    from: changed.from,
    to: changed.to,
    trigger: changed.trigger,
  });
  persistRuntimeEnvelope(env, ctx);
  emit?.(env);
}

/** 将 durable envelope 写入 run_events；必要时 upsert checkpoint。 */
export function persistRuntimeEnvelope(
  envelope: AgentEventEnvelope,
  ctx?: RunPersistenceContext,
): number | null {
  try {
    if (!isDurableRunEventType(envelope.event.type)) return null;
    const eventId = appendDurableRunEvent(envelope);
    if (eventId == null) return null;

    if (ctx) {
      noteEventForCheckpoint(envelope.event, ctx);
      if (CHECKPOINT_TRIGGERS.has(envelope.event.type)) {
        const checkpoint = buildCheckpointFromContext(ctx);
        upsertRunCheckpoint(ctx.runId, checkpoint, eventId);
      }
      if (envelope.event.type === "run_state_changed") {
        ctx.status = envelope.event.to as RunStatus;
      }
    }
    return eventId;
  } catch (err) {
    log.warn("persist failed", {
      runId: envelope.runId,
      type: envelope.event.type,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

function noteEventForCheckpoint(event: AgentRuntimeEvent, ctx: RunPersistenceContext): void {
  if (event.type === "tool_completed" && event.toolCallId) {
    if (!ctx.completedToolCallIds.includes(event.toolCallId)) {
      ctx.completedToolCallIds.push(event.toolCallId);
    }
    ctx.lastCompletedStage = `tool:${event.toolName ?? "unknown"}`;
  } else if (event.type === "compaction_completed") {
    ctx.lastCompletedStage = "compaction";
  } else if (event.type === "message_completed") {
    ctx.lastCompletedStage = `message:${event.channel}`;
  } else if (event.type === "run_ended") {
    ctx.lastCompletedStage = `run_ended:${event.kind}`;
  }
}

export function buildCheckpointFromContext(ctx: RunPersistenceContext): RunCheckpoint {
  return {
    version: 1,
    sessionId: ctx.sessionId ?? undefined,
    lastCompletedStage: ctx.lastCompletedStage,
    completedToolCallIds: [...ctx.completedToolCallIds],
    generatedFiles: ctx.generatedFiles.map((f) => ({
      path: f.path,
      sha256: f.sha256,
      status: f.status,
    })),
    capturedAt: new Date().toISOString(),
  };
}

/** 包装 emit：先持久化再转发（SSE / collector）。 */
export function withRunEventPersistence(
  emit: (env: AgentEventEnvelope) => void,
  ctx: RunPersistenceContext,
): (env: AgentEventEnvelope) => void {
  return (env) => {
    persistRuntimeEnvelope(env, ctx);
    emit(env);
  };
}
