import { sha256Json } from "@/lib/capability/hash";
import { getDb } from "@/lib/db/sqlite";
import type { MemoryRecordV2 } from "./contracts";
import { GovernedMemoryStore } from "./store";

const LOCAL_OWNER = { id: "local-user", type: "user" as const, tenantId: "local" };

function normalize(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function subjectKey(text: string): string {
  const subject = normalize(text).toLowerCase().split(/[：:=，,。；;]/, 1)[0]?.slice(0, 100);
  return sha256Json(subject || normalize(text).toLowerCase()).slice(0, 32);
}

export type SubmitMemoryCandidateRequest = {
  text?: string;
  replaces?: string;
  roleId?: string;
  source: string;
  conversationId?: number;
  now?: string;
};

export type SubmitMemoryCandidateResult = {
  candidate?: MemoryRecordV2;
  duplicate: boolean;
  deletions: Array<{ memoryId: string; proof: string }>;
  missingReplacement: boolean;
};

/**
 * Governed write boundary used by agent tools. A tool call may create a reviewable
 * candidate or execute an explicitly confirmed deletion, but never approves memory.
 */
export function submitMemoryCandidate(request: SubmitMemoryCandidateRequest): SubmitMemoryCandidateResult {
  const text = normalize(request.text ?? "");
  const replaces = normalize(request.replaces ?? "");
  if (!text && !replaces) throw new Error("memory candidate requires text or replaces");

  const db = getDb();
  const store = new GovernedMemoryStore(db);
  const now = request.now ?? new Date().toISOString();
  const scope = request.roleId
    ? { tenantId: "local", roleId: request.roleId }
    : { tenantId: "local", principalId: "local-user" };
  const evidenceRef = request.conversationId != null
    ? `conversation-${request.conversationId}-user-confirmed-memory-request`
    : `tool-memory-request-${sha256Json({ source: request.source, text, replaces, roleId: request.roleId ?? null }).slice(0, 32)}`;

  const deletions: SubmitMemoryCandidateResult["deletions"] = [];
  if (replaces) {
    const matches = store.findExactSummary({
      summary: replaces,
      tenantId: "local",
      principalId: request.roleId ? undefined : "local-user",
      roleId: request.roleId,
    });
    for (const memory of matches) {
      const result = store.requestDeletion({ memoryId: memory.id, requester: LOCAL_OWNER, at: now });
      if (result.status !== "completed") throw new Error(`memory deletion retained: ${result.retentionReason}`);
      deletions.push({ memoryId: memory.id, proof: result.proof });
    }
  }

  if (!text) {
    return { duplicate: false, deletions, missingReplacement: deletions.length === 0 };
  }

  const conflictSeed = replaces || text;
  const conflictKey = `tool:${request.roleId ?? "global"}:${subjectKey(conflictSeed)}`;
  const candidateId = `memory-candidate-${sha256Json({ scope, conflictKey, text }).slice(0, 40)}`;
  const existing = store.get(candidateId);
  if (existing) {
    return { candidate: existing, duplicate: true, deletions, missingReplacement: false };
  }

  const candidate = store.createCandidate({
    conflictKey,
    record: {
      id: candidateId,
      kind: "procedural",
      scope,
      entityRefs: [],
      content: {
        summary: text,
        source: normalize(request.source),
        requestedOperation: replaces ? "replace" : "add",
        ...(replaces ? { replaces } : {}),
      },
      sourceEvidenceRefs: [evidenceRef],
      confidence: request.conversationId != null ? 0.9 : 0.7,
      sensitivity: "confidential",
      createdAt: now,
      owner: LOCAL_OWNER,
    },
  });
  return { candidate, duplicate: false, deletions, missingReplacement: false };
}
