/**
 * run-store.ts — CR-R1 持久 Run / 事件账本读写。
 *
 * RunStatus / TerminationReason / Checkpoint / SettledOutcome 一律从 run-contract import，
 * 本模块只做 SQLite 写入与查询，不复制 union。
 */

import { getDb } from "./sqlite";
import type { AgentEventEnvelope, AgentRuntimeEvent } from "@/lib/agent/runtime-events";
import {
  isTerminalRunStatus,
  settledOutcomeForRunStatus,
  validateRunCheckpoint,
  type QualityStatus,
  type RunCheckpoint,
  type RunStatus,
  type SettledOutcome,
  type TerminationReason,
} from "@/lib/agent/run-contract";
import type { ExecutionRole, ExecutionTier } from "@/lib/settings/model-config";
import { recoverInterruptedTaskCases } from "@/lib/task/recovery";

export const RUN_REPLAY_SCHEMA_VERSION = 1 as const;

/** 进入 SQLite 的合同事件；高频 delta / thinking 不在此列。 */
export const DURABLE_RUN_EVENT_TYPES = new Set<AgentRuntimeEvent["type"]>([
  "run_started",
  "message_completed",
  "tool_completed",
  "compaction_completed",
  "run_ended",
  "run_state_changed",
  "work_plan_created",
  "work_plan_revised",
  "work_plan_step_changed",
  "run_settled",
]);

export type AgentRunRow = {
  runId: string;
  traceId: string;
  conversationId: number | null;
  status: RunStatus;
  terminationReason: TerminationReason | null;
  qualityStatus: QualityStatus;
  sessionId: string | null;
  modelUsed: string | null;
  modelRole: ExecutionRole | null;
  executionTier: ExecutionTier | null;
  modelFallbackReason: string | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
  heartbeatAt: string | null;
  turnsUsed: number;
  activeMs: number;
  waitingMs: number;
  lastEventId: number | null;
  latestCheckpoint: RunCheckpoint | null;
  errorCode: string | null;
  errorMessage: string | null;
};

export type CreateAgentRunInput = {
  runId: string;
  traceId: string;
  conversationId?: number | null;
  sessionId?: string | null;
  modelUsed?: string | null;
  modelRole?: ExecutionRole | null;
  executionTier?: ExecutionTier | null;
  modelFallbackReason?: string | null;
  /** 默认 queued（spec Trace Semantics） */
  status?: RunStatus;
};

type DbRunRow = {
  run_id: string;
  trace_id: string;
  conversation_id: number | null;
  status: string;
  termination_reason: string | null;
  quality_status: string;
  session_id: string | null;
  model_used: string | null;
  model_role: string | null;
  execution_tier: string | null;
  model_fallback_reason: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
  heartbeat_at: string | null;
  turns_used: number;
  active_ms: number;
  waiting_ms: number;
  last_event_id: number | null;
  latest_checkpoint_json: string | null;
  error_code: string | null;
  error_message: string | null;
};

function mapRunRow(r: DbRunRow): AgentRunRow {
  let latestCheckpoint: RunCheckpoint | null = null;
  if (r.latest_checkpoint_json) {
    try {
      const parsed = JSON.parse(r.latest_checkpoint_json) as unknown;
      const v = validateRunCheckpoint(parsed);
      if (v.ok) latestCheckpoint = v.checkpoint;
    } catch {
      latestCheckpoint = null;
    }
  }
  return {
    runId: r.run_id,
    traceId: r.trace_id,
    conversationId: r.conversation_id,
    status: r.status as RunStatus,
    terminationReason: (r.termination_reason as TerminationReason | null) ?? null,
    qualityStatus: (r.quality_status as QualityStatus) || "not_applicable",
    sessionId: r.session_id,
    modelUsed: r.model_used,
    modelRole: (r.model_role as ExecutionRole | null) ?? null,
    executionTier: (r.execution_tier as ExecutionTier | null) ?? null,
    modelFallbackReason: r.model_fallback_reason,
    startedAt: r.started_at,
    updatedAt: r.updated_at,
    endedAt: r.ended_at,
    heartbeatAt: r.heartbeat_at,
    turnsUsed: r.turns_used,
    activeMs: r.active_ms,
    waitingMs: r.waiting_ms,
    lastEventId: r.last_event_id,
    latestCheckpoint,
    errorCode: r.error_code,
    errorMessage: r.error_message,
  };
}

/** AR2a settled.outcome → 持久 RunStatus（不扩展 outcome union）。 */
export function terminalStatusForSettledOutcome(outcome: SettledOutcome): Extract<RunStatus, "completed" | "failed" | "canceled"> {
  if (outcome === "completed") return "completed";
  if (outcome === "aborted") return "canceled";
  return "failed";
}

export function isDurableRunEventType(type: string): boolean {
  return DURABLE_RUN_EVENT_TYPES.has(type as AgentRuntimeEvent["type"]);
}

/** 创建 Run：status 默认 queued。同 runId 幂等（已存在则返回现有行）。 */
export function createAgentRun(input: CreateAgentRunInput): AgentRunRow {
  const db = getDb();
  const existing = getAgentRun(input.runId);
  if (existing) return existing;

  const now = new Date().toISOString();
  const status = input.status ?? "queued";
  db.prepare(
    `INSERT INTO agent_runs (
       run_id, trace_id, conversation_id, status, quality_status, session_id,
       model_used, model_role, execution_tier, model_fallback_reason,
       started_at, updated_at, heartbeat_at
     ) VALUES (?, ?, ?, ?, 'not_applicable', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    input.runId,
    input.traceId,
    input.conversationId ?? null,
    status,
    input.sessionId ?? null,
    input.modelUsed ?? null,
    input.modelRole ?? null,
    input.executionTier ?? null,
    input.modelFallbackReason ?? null,
    now,
    now,
    now,
  );
  const row = getAgentRun(input.runId);
  if (!row) throw new Error(`createAgentRun: row missing after insert (${input.runId})`);
  return row;
}

export function getAgentRun(runId: string): AgentRunRow | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM agent_runs WHERE run_id = ?`).get(runId) as DbRunRow | undefined;
  return row ? mapRunRow(row) : null;
}

export function updateAgentRunModel(
  runId: string,
  model: {
    modelUsed?: string | null;
    modelRole?: ExecutionRole | null;
    executionTier?: ExecutionTier | null;
    modelFallbackReason?: string | null;
  },
): void {
  const db = getDb();
  db.prepare(
    `UPDATE agent_runs SET
       model_used = COALESCE(?, model_used),
       model_role = COALESCE(?, model_role),
       execution_tier = COALESCE(?, execution_tier),
       model_fallback_reason = COALESCE(?, model_fallback_reason),
       updated_at = ?
     WHERE run_id = ?`
  ).run(
    model.modelUsed ?? null,
    model.modelRole ?? null,
    model.executionTier ?? null,
    model.modelFallbackReason ?? null,
    new Date().toISOString(),
    runId,
  );
}

export function updateAgentRunStatus(
  runId: string,
  status: RunStatus,
  extras?: {
    terminationReason?: TerminationReason | null;
    qualityStatus?: QualityStatus;
    errorCode?: string | null;
    errorMessage?: string | null;
    sessionId?: string | null;
  },
): void {
  const db = getDb();
  const ended = isTerminalRunStatus(status) ? new Date().toISOString() : null;
  db.prepare(
    `UPDATE agent_runs SET
       status = ?,
       termination_reason = COALESCE(?, termination_reason),
       quality_status = COALESCE(?, quality_status),
       error_code = COALESCE(?, error_code),
       error_message = COALESCE(?, error_message),
       session_id = COALESCE(?, session_id),
       updated_at = ?,
       ended_at = COALESCE(?, ended_at),
       heartbeat_at = ?
     WHERE run_id = ?`
  ).run(
    status,
    extras?.terminationReason ?? null,
    extras?.qualityStatus ?? null,
    extras?.errorCode ?? null,
    extras?.errorMessage ?? null,
    extras?.sessionId ?? null,
    new Date().toISOString(),
    ended,
    new Date().toISOString(),
    runId,
  );
}

/**
 * 追加一条持久事件。返回持久 cursor（run_events.id）；非 durable / settled 后拒绝 → null。
 * run_settled 走唯一索引幂等折叠（重复插入 changes=0）。
 */
export function appendDurableRunEvent(envelope: AgentEventEnvelope): number | null {
  const eventType = envelope.event.type;
  if (!isDurableRunEventType(eventType)) return null;

  // conversation 级（title_updated）不挂 run
  const runId = envelope.runId;
  if (!runId) return null;

  const run = getAgentRun(runId);
  if (!run) return null;

  // settled 之后拒绝该 run 的新业务事件；重复 settled 幂等返回已有 id
  if (isTerminalRunStatus(run.status)) {
    return eventType === "run_settled" ? getSettledEventId(runId) : null;
  }

  const db = getDb();
  const now = new Date().toISOString();

  try {
    const result = db.prepare(
      `INSERT INTO run_events (run_id, conversation_id, instance_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      runId,
      envelope.conversationId,
      envelope.instanceId,
      eventType,
      JSON.stringify(envelope),
      now,
    );
    const eventId = Number(result.lastInsertRowid);
    if (!eventId || result.changes === 0) {
      return eventType === "run_settled" ? getSettledEventId(runId) : null;
    }

    db.prepare(
      `UPDATE agent_runs SET last_event_id = ?, updated_at = ?, heartbeat_at = ? WHERE run_id = ?`
    ).run(eventId, now, now, runId);

    if (eventType === "run_settled" && envelope.event.type === "run_settled") {
      const outcome = envelope.event.outcome;
      const status = terminalStatusForSettledOutcome(outcome);
      // 校验 outcome 与 RunStatus 映射仍对齐 AR2a
      const mapped = settledOutcomeForRunStatus(status);
      if (mapped !== outcome) {
        console.warn("[run-store] settled outcome/status mismatch", { outcome, status, mapped });
      }
      updateAgentRunStatus(runId, status, {
        errorMessage: envelope.event.error ?? null,
      });
    } else if (eventType === "run_state_changed" && envelope.event.type === "run_state_changed") {
      const to = envelope.event.to as RunStatus;
      updateAgentRunStatus(runId, to, {
        terminationReason: (envelope.event.terminationReason as TerminationReason | undefined) ?? null,
        qualityStatus: (envelope.event.qualityStatus as QualityStatus | undefined) ?? undefined,
      });
    }

    return eventId;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // UNIQUE settled 冲突 → 幂等返回已有 id
    if (eventType === "run_settled" && /unique|UNIQUE/i.test(msg)) {
      return getSettledEventId(runId);
    }
    throw err;
  }
}

/**
 * Append the explicit-stop terminal pair and update the run atomically.
 * The event ledger always records state_changed before run_settled.
 */
export function appendTerminalRunEventPair(
  changed: AgentEventEnvelope,
  settled: AgentEventEnvelope,
): { changedEventId: number; settledEventId: number } | null {
  if (changed.event.type !== "run_state_changed" || settled.event.type !== "run_settled") {
    throw new Error("terminal pair requires run_state_changed followed by run_settled");
  }
  const runId = changed.runId;
  if (!runId || settled.runId !== runId) {
    throw new Error("terminal pair runId mismatch");
  }

  const terminalStatus = terminalStatusForSettledOutcome(settled.event.outcome);
  if (changed.event.to !== terminalStatus) {
    throw new Error("terminal pair status/outcome mismatch");
  }

  const db = getDb();
  db.exec("BEGIN IMMEDIATE");
  try {
    const run = getAgentRun(runId);
    if (!run) {
      db.exec("ROLLBACK");
      return null;
    }
    if (isTerminalRunStatus(run.status)) {
      db.exec("ROLLBACK");
      return null;
    }

    const now = new Date().toISOString();
    const insert = db.prepare(
      `INSERT INTO run_events (run_id, conversation_id, instance_id, event_type, event_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const changedResult = insert.run(
      runId,
      changed.conversationId,
      changed.instanceId,
      changed.event.type,
      JSON.stringify(changed),
      now,
    );
    const settledResult = insert.run(
      runId,
      settled.conversationId,
      settled.instanceId,
      settled.event.type,
      JSON.stringify(settled),
      now,
    );
    const changedEventId = Number(changedResult.lastInsertRowid);
    const settledEventId = Number(settledResult.lastInsertRowid);
    if (!changedEventId || !settledEventId) {
      throw new Error("terminal pair event insert failed");
    }

    db.prepare(
      `UPDATE agent_runs SET
         status = ?,
         termination_reason = COALESCE(?, termination_reason),
         error_message = COALESCE(?, error_message),
         last_event_id = ?,
         updated_at = ?,
         ended_at = COALESCE(ended_at, ?),
         heartbeat_at = ?
       WHERE run_id = ?`
    ).run(
      terminalStatus,
      (changed.event.terminationReason as TerminationReason | undefined) ?? null,
      settled.event.error ?? null,
      settledEventId,
      now,
      now,
      now,
      runId,
    );
    db.exec("COMMIT");
    return { changedEventId, settledEventId };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* keep original error */
    }
    throw error;
  }
}

function getSettledEventId(runId: string): number | null {
  const db = getDb();
  const row = db.prepare(
    `SELECT id FROM run_events WHERE run_id = ? AND event_type = 'run_settled' LIMIT 1`
  ).get(runId) as { id: number } | undefined;
  return row?.id ?? null;
}

/** checkpoint upsert：校验后写入，并刷新 last_event_id（若提供）。 */
export function upsertRunCheckpoint(
  runId: string,
  checkpoint: RunCheckpoint,
  lastEventId?: number | null,
): boolean {
  const v = validateRunCheckpoint(checkpoint);
  if (!v.ok) return false;
  const db = getDb();
  const now = new Date().toISOString();
  if (lastEventId != null) {
    db.prepare(
      `UPDATE agent_runs SET latest_checkpoint_json = ?, last_event_id = COALESCE(?, last_event_id), updated_at = ?, heartbeat_at = ?
       WHERE run_id = ?`
    ).run(JSON.stringify(v.checkpoint), lastEventId, now, now, runId);
  } else {
    db.prepare(
      `UPDATE agent_runs SET latest_checkpoint_json = ?, updated_at = ?, heartbeat_at = ?
       WHERE run_id = ?`
    ).run(JSON.stringify(v.checkpoint), now, now, runId);
  }
  return true;
}

export type ReplayEvent = AgentEventEnvelope & { persistentEventId: number };

/**
 * 按持久 cursor 增量读取（afterEventId 排他）。
 * 返回的 envelope.eventId 覆盖为持久 id，便于客户端去重。
 */
export function listRunEventsAfter(
  runId: string,
  afterEventId = 0,
  limit = 100,
): { events: ReplayEvent[]; nextEventId: number | null } {
  const db = getDb();
  const safeLimit = Math.min(Math.max(1, limit), 500);
  const rows = db.prepare(
    `SELECT id, event_json FROM run_events
      WHERE run_id = ? AND id > ?
      ORDER BY id ASC
      LIMIT ?`
  ).all(runId, afterEventId, safeLimit + 1) as Array<{ id: number; event_json: string }>;

  const hasMore = rows.length > safeLimit;
  const slice = hasMore ? rows.slice(0, safeLimit) : rows;
  const events: ReplayEvent[] = [];
  for (const row of slice) {
    try {
      const env = JSON.parse(row.event_json) as AgentEventEnvelope;
      events.push({
        ...env,
        eventId: row.id,
        persistentEventId: row.id,
      });
    } catch {
      /* skip corrupt */
    }
  }
  const nextEventId = hasMore && events.length ? events[events.length - 1]!.persistentEventId : null;
  return { events, nextEventId };
}

/** 统计某 run 的持久 settled 条数（测试/诊断）。 */
export function countSettledEvents(runId: string): number {
  const db = getDb();
  const row = db.prepare(
    `SELECT COUNT(*) AS c FROM run_events WHERE run_id = ? AND event_type = 'run_settled'`
  ).get(runId) as { c: number };
  return row.c;
}

/**
 * CR-R2：进程重启后，将仍标为 running/queued/waiting_* 的孤儿 Run 标为 paused/process_crash。
 * 不宣称恢复子进程；只让状态可解释。
 */
export function pauseOrphanRunsOnBoot(reason: TerminationReason = "process_crash"): number {
  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    `UPDATE agent_runs SET
       status = 'paused',
       termination_reason = ?,
       updated_at = ?,
       heartbeat_at = ?
     WHERE status IN ('queued', 'running', 'waiting_user', 'waiting_dependency')`
  ).run(reason, now, now);
  if (reason === "process_crash") recoverInterruptedTaskCases(db, new Date(now));
  return Number(result.changes ?? 0);
}
