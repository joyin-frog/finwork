/**
 * CR-R0：持久 Run 共享合同 v2。
 *
 * 唯一导出位置：Run 状态、终止原因、TaskContract、CompletionEvidence、Checkpoint、
 * AR2a settled 映射。下游只能 import，不得复制 union。
 *
 * 本模块不实现 DB / RunManager / UI / validator。
 */

import type { AgentRuntimeEvent } from "./runtime-events";

export const RUN_CONTRACT_VERSION = 1 as const;

// ─── Run status & termination ───────────────────────────────────────────────

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_user"
  | "waiting_dependency"
  | "paused"
  | "completed"
  | "failed"
  | "canceled";

export type TerminalRunStatus = "completed" | "failed" | "canceled";

export const TERMINAL_RUN_STATUSES: readonly TerminalRunStatus[] = [
  "completed",
  "failed",
  "canceled",
] as const;

export type TerminationReason =
  | "user_stop"
  | "budget_exhausted"
  | "idle_timeout"
  | "hard_timeout"
  | "permission_denied"
  | "permission_expired"
  | "dependency_missing"
  | "validation_failed"
  | "model_auth"
  | "model_not_found"
  | "rate_limited"
  | "network_error"
  | "tool_error"
  | "process_crash"
  | "session_stale"
  | "sdk_error";

/** 订阅断开只记审计，不得进入 termination reason。 */
export type SubscriptionAuditReason = "client_disconnected";

export type QualityStatus = "not_applicable" | "unverified" | "passed" | "failed";

/** AR2a 已冻结；不得扩展为 failed/canceled。 */
export type SettledOutcome = "completed" | "aborted" | "error";

export function isTerminalRunStatus(status: RunStatus): status is TerminalRunStatus {
  return (TERMINAL_RUN_STATUSES as readonly string[]).includes(status);
}

/**
 * RunStatus → AR2a run_settled.outcome。
 * 非终态返回 null（不得发 settled）。
 */
export function settledOutcomeForRunStatus(status: RunStatus): SettledOutcome | null {
  switch (status) {
    case "completed":
      return "completed";
    case "canceled":
      return "aborted";
    case "failed":
      return "error";
    default:
      return null;
  }
}

export function assertNotTerminationReason(reason: string): void {
  if (reason === "client_disconnected") {
    throw new Error("client_disconnected is a subscription audit event, not a termination reason");
  }
}

// ─── State transitions ──────────────────────────────────────────────────────

export type RunTransitionTrigger =
  | "runtime_acquired"
  | "question_created"
  | "dependency_action_required"
  | "answer_accepted"
  | "capability_ready"
  | "recoverable_guard"
  | "explicit_resume"
  | "explicit_stop_quiesced"
  | "completion_gate_passed"
  | "unrecoverable_error";

const TRANSITIONS: ReadonlyArray<{ from: RunStatus; trigger: RunTransitionTrigger; to: RunStatus }> = [
  { from: "queued", trigger: "runtime_acquired", to: "running" },
  { from: "running", trigger: "question_created", to: "waiting_user" },
  { from: "running", trigger: "dependency_action_required", to: "waiting_dependency" },
  { from: "waiting_user", trigger: "answer_accepted", to: "running" },
  { from: "waiting_dependency", trigger: "capability_ready", to: "running" },
  { from: "running", trigger: "recoverable_guard", to: "paused" },
  { from: "paused", trigger: "explicit_resume", to: "running" },
  { from: "queued", trigger: "explicit_stop_quiesced", to: "canceled" },
  { from: "running", trigger: "explicit_stop_quiesced", to: "canceled" },
  { from: "waiting_user", trigger: "explicit_stop_quiesced", to: "canceled" },
  { from: "waiting_dependency", trigger: "explicit_stop_quiesced", to: "canceled" },
  { from: "paused", trigger: "explicit_stop_quiesced", to: "canceled" },
  { from: "running", trigger: "completion_gate_passed", to: "completed" },
  { from: "queued", trigger: "unrecoverable_error", to: "failed" },
  { from: "running", trigger: "unrecoverable_error", to: "failed" },
  { from: "waiting_user", trigger: "unrecoverable_error", to: "failed" },
  { from: "waiting_dependency", trigger: "unrecoverable_error", to: "failed" },
  { from: "paused", trigger: "unrecoverable_error", to: "failed" },
];

export function nextRunStatus(
  from: RunStatus,
  trigger: RunTransitionTrigger,
): RunStatus | null {
  if (isTerminalRunStatus(from)) return null;
  const hit = TRANSITIONS.find((t) => t.from === from && t.trigger === trigger);
  return hit?.to ?? null;
}

export type RunStateChangedEvent = {
  type: "run_state_changed";
  from: RunStatus;
  to: RunStatus;
  trigger: RunTransitionTrigger;
  terminationReason?: TerminationReason;
  qualityStatus?: QualityStatus;
};

export function buildRunStateChanged(
  from: RunStatus,
  trigger: RunTransitionTrigger,
  extras?: { terminationReason?: TerminationReason; qualityStatus?: QualityStatus },
): RunStateChangedEvent | null {
  const to = nextRunStatus(from, trigger);
  if (!to) return null;
  if (extras?.terminationReason) assertNotTerminationReason(extras.terminationReason);
  return {
    type: "run_state_changed",
    from,
    to,
    trigger,
    ...(extras?.terminationReason ? { terminationReason: extras.terminationReason } : {}),
    ...(extras?.qualityStatus ? { qualityStatus: extras.qualityStatus } : {}),
  };
}

/** 仅终态可构造 settled payload；与 AR2a union 对齐。 */
export function buildSettledPayload(
  status: RunStatus,
  error?: string,
): Extract<AgentRuntimeEvent, { type: "run_settled" }> | null {
  const outcome = settledOutcomeForRunStatus(status);
  if (!outcome) return null;
  return error ? { type: "run_settled", outcome, error } : { type: "run_settled", outcome };
}

// ─── TaskContract ───────────────────────────────────────────────────────────

export type SpreadsheetRequirement = {
  needsLegacyXlsRead: boolean;
  needsWrite: boolean;
  needsRecalc: boolean;
  needsRender: boolean;
  needsMacroPreservation: boolean;
};

export type SpreadsheetAssertion =
  | { type: "cells_balance"; leftName: string; rightName: string; tolerance: number }
  | { type: "cash_reconcile"; cashFlowName: string; balanceSheetName: string; tolerance: number }
  | { type: "cell_equals"; definedName: string; expected: string | number }
  | { type: "cell_is_formula"; definedName: string };

export type QualityProfile = "generic" | "financial_consolidation";

export type TaskKind = "text" | "spreadsheet" | "financial_consolidation";

export type RequiredDeliverable = {
  id: string;
  mime: string;
  count: number;
  qualityProfile: QualityProfile;
};

export type TaskContract = {
  version: 1;
  taskKind: TaskKind;
  spreadsheetRequirement?: SpreadsheetRequirement;
  requiredDeliverables: RequiredDeliverable[];
  expectationSnapshot: {
    company?: string;
    period?: string;
    assertions?: SpreadsheetAssertion[];
  };
};

const QUALITY_PROFILES: readonly QualityProfile[] = ["generic", "financial_consolidation"];
const TASK_KINDS: readonly TaskKind[] = ["text", "spreadsheet", "financial_consolidation"];
const ASSERTION_TYPES = ["cells_balance", "cash_reconcile", "cell_equals", "cell_is_formula"] as const;

export type TaskContractValidation =
  | { ok: true; contract: TaskContract }
  | { ok: false; errors: string[] };

export function validateTaskContract(input: unknown): TaskContractValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["TaskContract must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) errors.push("version must be 1");
  if (!(TASK_KINDS as readonly string[]).includes(String(raw.taskKind))) {
    errors.push("unknown taskKind");
  }
  if (!Array.isArray(raw.requiredDeliverables) || raw.requiredDeliverables.length === 0) {
    errors.push("requiredDeliverables must be a non-empty array");
  } else {
    for (const [i, d] of raw.requiredDeliverables.entries()) {
      if (!d || typeof d !== "object") {
        errors.push(`requiredDeliverables[${i}] invalid`);
        continue;
      }
      const item = d as Record<string, unknown>;
      if (typeof item.id !== "string" || !item.id.trim()) errors.push(`requiredDeliverables[${i}].id required`);
      if (typeof item.mime !== "string" || !item.mime.trim()) errors.push(`requiredDeliverables[${i}].mime required`);
      if (typeof item.count !== "number" || !Number.isInteger(item.count) || item.count < 1) {
        errors.push(`requiredDeliverables[${i}].count must be >= 1`);
      }
      if (!(QUALITY_PROFILES as readonly string[]).includes(String(item.qualityProfile))) {
        errors.push(`requiredDeliverables[${i}].qualityProfile unknown`);
      }
    }
  }

  const snap = raw.expectationSnapshot;
  if (snap != null && (typeof snap !== "object" || Array.isArray(snap))) {
    errors.push("expectationSnapshot must be an object when present");
  } else if (snap && typeof snap === "object") {
    const s = snap as Record<string, unknown>;
    if (s.assertions != null) {
      if (!Array.isArray(s.assertions)) {
        errors.push("expectationSnapshot.assertions must be an array");
      } else {
        for (const [i, a] of s.assertions.entries()) {
          if (!a || typeof a !== "object" || !("type" in a)) {
            errors.push(`assertions[${i}] invalid`);
            continue;
          }
          if (!(ASSERTION_TYPES as readonly string[]).includes(String((a as { type: string }).type))) {
            errors.push(`assertions[${i}].type unknown`);
          }
        }
      }
    }
    // 部分 expectation（只有 company 无 period 等）允许；禁止「半个 assertion 对象」已在上面覆盖
  }

  if (raw.spreadsheetRequirement != null) {
    if (typeof raw.spreadsheetRequirement !== "object" || Array.isArray(raw.spreadsheetRequirement)) {
      errors.push("spreadsheetRequirement must be an object");
    } else {
      const req = raw.spreadsheetRequirement as Record<string, unknown>;
      for (const key of [
        "needsLegacyXlsRead",
        "needsWrite",
        "needsRecalc",
        "needsRender",
        "needsMacroPreservation",
      ] as const) {
        if (typeof req[key] !== "boolean") errors.push(`spreadsheetRequirement.${key} must be boolean`);
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, contract: raw as unknown as TaskContract };
}

// ─── CompletionEvidence ─────────────────────────────────────────────────────

export type CompletionEvidence = {
  runId: string;
  contractDeliverableId: string;
  deliveredPath: string;
  deliveredSha256: string;
  mime: string;
  validatorId: string;
  qualityProfile: string;
  validationStatus: "passed";
  validatedAt: string;
  reportId: string;
};

export type CompletionEvidenceValidation =
  | { ok: true; evidence: CompletionEvidence }
  | { ok: false; errors: string[] };

const SHA256_RE = /^[a-f0-9]{64}$/i;

export function validateCompletionEvidence(input: unknown): CompletionEvidenceValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["CompletionEvidence must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  for (const key of [
    "runId",
    "contractDeliverableId",
    "deliveredPath",
    "mime",
    "validatorId",
    "qualityProfile",
    "validatedAt",
    "reportId",
  ] as const) {
    if (typeof raw[key] !== "string" || !(raw[key] as string).trim()) {
      errors.push(`${key} required`);
    }
  }
  if (raw.validationStatus !== "passed") {
    errors.push("validationStatus must be passed");
  }
  if (typeof raw.deliveredSha256 !== "string" || !SHA256_RE.test(raw.deliveredSha256)) {
    errors.push("deliveredSha256 must be a non-empty sha256 hex");
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, evidence: raw as unknown as CompletionEvidence };
}

/**
 * CompletionGate 纯核对：合同 required deliverables 是否都有匹配 Evidence。
 * 不写 Run 状态；RunStore 是唯一写入者。
 */
export function completionGateSatisfied(
  contract: TaskContract,
  evidences: CompletionEvidence[],
): { ok: true } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  for (const d of contract.requiredDeliverables) {
    const matches = evidences.filter(
      (e) =>
        e.contractDeliverableId === d.id &&
        e.validationStatus === "passed" &&
        SHA256_RE.test(e.deliveredSha256),
    );
    if (matches.length < d.count) missing.push(d.id);
  }
  return missing.length ? { ok: false, missing } : { ok: true };
}

// ─── Checkpoint ─────────────────────────────────────────────────────────────

export type RunCheckpoint = {
  version: 1;
  sessionId?: string;
  lastCompletedStage?: string;
  completedToolCallIds: string[];
  generatedFiles: Array<{ path: string; sha256: string; status: string }>;
  pendingAction?: { kind: string; id: string };
  capturedAt: string;
};

export type CheckpointValidation =
  | { ok: true; checkpoint: RunCheckpoint }
  | { ok: false; errors: string[] };

export function validateRunCheckpoint(input: unknown): CheckpointValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object") {
    return { ok: false, errors: ["RunCheckpoint must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  if (raw.version !== 1) errors.push("version must be 1");
  if (!Array.isArray(raw.completedToolCallIds)) errors.push("completedToolCallIds must be an array");
  if (!Array.isArray(raw.generatedFiles)) errors.push("generatedFiles must be an array");
  if (typeof raw.capturedAt !== "string" || !raw.capturedAt.trim()) errors.push("capturedAt required");

  // 禁止把未确认权限写进 checkpoint
  if ("capabilityGrant" in raw || "grantedCapabilities" in raw || "permissionGrant" in raw) {
    errors.push("checkpoint must not persist capability grants");
  }
  if (raw.pendingAction != null) {
    if (typeof raw.pendingAction !== "object" || Array.isArray(raw.pendingAction)) {
      errors.push("pendingAction must be an object");
    } else {
      const p = raw.pendingAction as Record<string, unknown>;
      if (p.kind === "capability_grant" || p.kind === "permission_grant") {
        errors.push("checkpoint must not persist capability grants");
      }
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, checkpoint: raw as unknown as RunCheckpoint };
}
