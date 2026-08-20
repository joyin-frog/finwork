import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { withSqliteSavepoint } from "@/lib/db/transaction";
import type { DataClassification } from "@/lib/security/contracts";
import {
  MemoryCandidateSchema,
  MemoryDeletionResultSchema,
  MemoryRecordV2Schema,
  MemoryRetrievalQuerySchema,
  MemorySelectionSchema,
  type MemoryCandidate,
  type MemoryDeletionResult,
  type MemoryRecordV2,
  type MemoryRetrievalQuery,
  type MemorySelection,
} from "./contracts";
import { evaluateMemoryRelevance } from "./relevance";

type MemoryRow = {
  memory_id: string;
  kind: MemoryRecordV2["kind"];
  scope_json: string;
  entity_refs_json: string;
  effective_period_json: string | null;
  content_json: string;
  source_evidence_json: string;
  confidence: number;
  sensitivity: DataClassification;
  approval_status: MemoryRecordV2["approvalStatus"];
  lifecycle_status?: "active" | "archived";
  supersedes_json: string;
  conflicts_with_json: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  owner_json: string;
};

export type GovernedMemoryListQuery = {
  statuses?: MemoryRecordV2["approvalStatus"][];
  kinds?: MemoryRecordV2["kind"][];
  tenantId?: string;
  principalId?: string;
  roleId?: string;
  search?: string;
  limit?: number;
};

export type MemoryAccessLogEntry = {
  id: string;
  memoryId: string;
  principal: MemoryRecordV2["owner"];
  action: "created" | "selected" | "approved" | "rejected" | "expired" | "archived" | "restored" | "corrected" | "deletion_requested" | "deleted" | "retained";
  reason?: string;
  evidenceRefs: string[];
  createdAt: string;
};

export type MemoryRetentionDecision = {
  id: string;
  memoryId: string;
  status: "completed" | "retained";
  retentionReason?: string;
  deletionProof?: string;
  requestedAt: string;
  completedAt?: string;
};

const SENSITIVITY_RANK: Record<DataClassification, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

function parseRow(row: MemoryRow): MemoryRecordV2 {
  return MemoryRecordV2Schema.parse({
    id: row.memory_id,
    kind: row.kind,
    scope: JSON.parse(row.scope_json),
    entityRefs: JSON.parse(row.entity_refs_json),
    effectivePeriod: row.effective_period_json ? JSON.parse(row.effective_period_json) : undefined,
    content: JSON.parse(row.content_json),
    sourceEvidenceRefs: JSON.parse(row.source_evidence_json),
    confidence: row.confidence,
    sensitivity: row.sensitivity,
    approvalStatus: row.lifecycle_status === "archived" ? "archived" : row.approval_status,
    supersedes: JSON.parse(row.supersedes_json),
    conflictsWith: JSON.parse(row.conflicts_with_json),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at ?? undefined,
    expiresAt: row.expires_at ?? undefined,
    owner: JSON.parse(row.owner_json),
  });
}

function periodsOverlap(left: MemoryRecordV2["effectivePeriod"], right: MemoryRecordV2["effectivePeriod"]): boolean {
  if (!left || !right) return true;
  return left.start <= right.end && right.start <= left.end;
}

function sharesEntity(left: string[], right: string[]): boolean {
  if (left.length === 0 && right.length === 0) return true;
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((item) => rightSet.has(item));
}

function summarizeContent(content: MemoryRecordV2["content"]): string {
  if (typeof content === "string") return content.slice(0, 2000);
  if (
    content
    && typeof content === "object"
    && !Array.isArray(content)
    && typeof content.summary === "string"
    && content.summary.trim()
  ) {
    return content.summary.trim().slice(0, 2000);
  }
  return canonicalJson(content).slice(0, 2000);
}

function freshnessScore(memory: MemoryRecordV2, now: string): number {
  const anchor = Date.parse(memory.lastUsedAt ?? memory.createdAt);
  const ageDays = Math.max(0, Date.parse(now) - anchor) / 86_400_000;
  const decay = Math.exp(-ageDays / 365);
  return Math.max(0, Math.min(1, memory.confidence * decay));
}

export class GovernedMemoryStore {
  constructor(readonly db: DatabaseSync) {}

  findExactSummary(request: {
    summary: string;
    tenantId?: string;
    principalId?: string;
    roleId?: string;
  }): MemoryRecordV2[] {
    const normalized = request.summary.replace(/\s+/g, " ").trim();
    if (!normalized) return [];
    const rows = this.db.prepare(`
      SELECT * FROM memory_records_v2
      WHERE approval_status IN ('candidate','approved')
        AND lifecycle_status = 'active'
        AND (scope_tenant_id IS NULL OR scope_tenant_id = ?)
        AND (scope_principal_id IS NULL OR scope_principal_id = ?)
        AND (scope_role_id IS NULL OR scope_role_id = ?)
      ORDER BY created_at DESC, memory_id
      LIMIT 500
    `).all(
      request.tenantId ?? null,
      request.principalId ?? null,
      request.roleId ?? null,
    ) as unknown as MemoryRow[];
    return rows
      .map(parseRow)
      .filter((memory) => summarizeContent(memory.content).replace(/\s+/g, " ").trim() === normalized)
      .filter((memory) => request.principalId ? memory.scope.principalId === request.principalId : true)
      .filter((memory) => request.roleId ? memory.scope.roleId === request.roleId : true);
  }

  createCandidate(rawCandidate: MemoryCandidate): MemoryRecordV2 {
    const candidate = MemoryCandidateSchema.parse(rawCandidate);
    const record: MemoryRecordV2 = MemoryRecordV2Schema.parse({
      ...candidate.record,
      approvalStatus: "candidate",
      supersedes: [],
      conflictsWith: [],
    });
    const contentHash = sha256Json(record.content);
    const potential = this.db.prepare(`
      SELECT * FROM memory_records_v2
      WHERE conflict_key = ?
        AND approval_status IN ('candidate','approved')
        AND lifecycle_status = 'active'
        AND content_hash <> ?
        AND (? IS NULL OR scope_tenant_id IS NULL OR scope_tenant_id = ?)
    `).all(
      candidate.conflictKey,
      contentHash,
      record.scope.tenantId ?? null,
      record.scope.tenantId ?? null,
    ) as unknown as MemoryRow[];
    const conflicts = potential
      .map(parseRow)
      .filter((existing) => periodsOverlap(existing.effectivePeriod, record.effectivePeriod))
      .filter((existing) => sharesEntity(existing.entityRefs, record.entityRefs));
    const withConflicts = MemoryRecordV2Schema.parse({
      ...record,
      conflictsWith: conflicts.map((item) => item.id),
    });

    withSqliteSavepoint(this.db, "memory_candidate", () => {
      this.insertRecord(withConflicts, candidate.conflictKey, contentHash);
      const relation = this.db.prepare(`
        INSERT OR IGNORE INTO memory_relations_v2(from_memory_id, to_memory_id, relation, created_at)
        VALUES (?, ?, 'conflicts_with', ?)
      `);
      for (const conflict of conflicts) {
        relation.run(withConflicts.id, conflict.id, withConflicts.createdAt);
        relation.run(conflict.id, withConflicts.id, withConflicts.createdAt);
        const ids = [...new Set([...conflict.conflictsWith, withConflicts.id])];
        this.db.prepare("UPDATE memory_records_v2 SET conflicts_with_json = ? WHERE memory_id = ?")
          .run(canonicalJson(ids), conflict.id);
      }
      this.log(withConflicts.id, withConflicts.owner, "created", "candidate extracted", withConflicts.sourceEvidenceRefs, withConflicts.createdAt);
    });
    return withConflicts;
  }

  get(memoryId: string): MemoryRecordV2 | undefined {
    const row = this.db.prepare("SELECT * FROM memory_records_v2 WHERE memory_id = ?")
      .get(memoryId) as unknown as MemoryRow | undefined;
    return row ? parseRow(row) : undefined;
  }

  list(query: GovernedMemoryListQuery = {}): MemoryRecordV2[] {
    const requestedLimit = query.limit ?? 100;
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
    const rows = this.db.prepare(`
      SELECT * FROM memory_records_v2
      WHERE (? IS NULL OR scope_tenant_id IS NULL OR scope_tenant_id = ?)
        AND (? IS NULL OR scope_principal_id IS NULL OR scope_principal_id = ?)
        AND (? IS NULL OR scope_role_id IS NULL OR scope_role_id = ?)
      ORDER BY created_at DESC, memory_id
      LIMIT 500
    `).all(
      query.tenantId ?? null,
      query.tenantId ?? null,
      query.principalId ?? null,
      query.principalId ?? null,
      query.roleId ?? null,
      query.roleId ?? null,
    ) as unknown as MemoryRow[];
    const statuses = new Set(query.statuses ?? []);
    const kinds = new Set(query.kinds ?? []);
    const search = query.search?.replace(/\s+/g, " ").trim().toLocaleLowerCase() ?? "";
    return rows
      .map(parseRow)
      .filter((memory) => query.tenantId ? memory.scope.tenantId === query.tenantId : true)
      .filter((memory) => query.principalId ? memory.scope.principalId === query.principalId : true)
      .filter((memory) => query.roleId ? memory.scope.roleId === query.roleId : true)
      .filter((memory) => statuses.size === 0 || statuses.has(memory.approvalStatus))
      .filter((memory) => kinds.size === 0 || kinds.has(memory.kind))
      .filter((memory) => !search || summarizeContent(memory.content).toLocaleLowerCase().includes(search))
      .slice(0, limit);
  }

  listAccessLog(request: { memoryId?: string; limit?: number } = {}): MemoryAccessLogEntry[] {
    const requestedLimit = request.limit ?? 100;
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
    const rows = this.db.prepare(`
      SELECT access_id, memory_id, principal_json, action, reason, evidence_json, created_at
      FROM (
        SELECT access_id, memory_id, principal_json, action, reason, evidence_json, created_at
        FROM memory_access_log_v2
        UNION ALL
        SELECT event_id AS access_id, memory_id, principal_json, action, reason,
               '[]' AS evidence_json, created_at
        FROM memory_lifecycle_events_v2
      )
      WHERE (? IS NULL OR memory_id = ?)
      ORDER BY created_at DESC, access_id DESC
      LIMIT ?
    `).all(request.memoryId ?? null, request.memoryId ?? null, limit) as Array<{
      access_id: string;
      memory_id: string;
      principal_json: string;
      action: MemoryAccessLogEntry["action"];
      reason: string | null;
      evidence_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.access_id,
      memoryId: row.memory_id,
      principal: JSON.parse(row.principal_json) as MemoryRecordV2["owner"],
      action: row.action,
      reason: row.reason ?? undefined,
      evidenceRefs: JSON.parse(row.evidence_json) as string[],
      createdAt: row.created_at,
    }));
  }

  listRetentionDecisions(request: { memoryIds?: string[]; limit?: number } = {}): MemoryRetentionDecision[] {
    const requestedLimit = request.limit ?? 100;
    const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 500)) : 100;
    const requestedIds = [...new Set(request.memoryIds ?? [])];
    const rows = this.db.prepare(`
      SELECT request_id, memory_id, status, retention_reason, deletion_proof, requested_at, completed_at
      FROM memory_deletion_requests_v2
      ORDER BY requested_at DESC, request_id DESC
      LIMIT ?
    `).all(limit) as Array<{
      request_id: string;
      memory_id: string;
      status: MemoryRetentionDecision["status"];
      retention_reason: string | null;
      deletion_proof: string | null;
      requested_at: string;
      completed_at: string | null;
    }>;
    const idSet = new Set(requestedIds);
    return rows
      .filter((row) => idSet.size === 0 || idSet.has(row.memory_id))
      .map((row) => ({
        id: row.request_id,
        memoryId: row.memory_id,
        status: row.status,
        retentionReason: row.retention_reason ?? undefined,
        deletionProof: row.deletion_proof ?? undefined,
        requestedAt: row.requested_at,
        completedAt: row.completed_at ?? undefined,
      }));
  }

  correct(request: {
    memoryId: string;
    content: MemoryRecordV2["content"];
    principal: MemoryRecordV2["owner"];
    reason: string;
    sourceEvidenceRefs: string[];
    at: string;
  }): MemoryRecordV2 {
    const current = this.require(request.memoryId);
    if (["rejected", "expired", "archived"].includes(current.approvalStatus)) {
      throw new Error(`inactive memory cannot be corrected: ${current.id}:${current.approvalStatus}`);
    }
    if (sha256Json(current.content) === sha256Json(request.content)) {
      throw new Error("memory correction must change content");
    }
    const row = this.db.prepare("SELECT conflict_key FROM memory_records_v2 WHERE memory_id = ?")
      .get(current.id) as { conflict_key: string };
    const corrected = this.createCandidate({
      conflictKey: row.conflict_key,
      record: {
        id: randomUUID(),
        kind: current.kind,
        scope: current.scope,
        entityRefs: current.entityRefs,
        effectivePeriod: current.effectivePeriod,
        content: request.content,
        sourceEvidenceRefs: [...new Set([...current.sourceEvidenceRefs, ...request.sourceEvidenceRefs])],
        confidence: current.confidence,
        sensitivity: current.sensitivity,
        createdAt: request.at,
        expiresAt: current.expiresAt,
        owner: request.principal,
      },
    });
    this.log(
      current.id,
      request.principal,
      "corrected",
      `${request.reason}; replacement candidate ${corrected.id}`,
      request.sourceEvidenceRefs,
      request.at,
    );
    return corrected;
  }

  approve(request: {
    memoryId: string;
    approver: MemoryRecordV2["owner"];
    supersedeIds?: string[];
    reason: string;
    at: string;
  }): MemoryRecordV2 {
    const memory = this.require(request.memoryId);
    if (memory.approvalStatus !== "candidate") {
      throw new Error(`only candidate memory can be approved: ${memory.id}:${memory.approvalStatus}`);
    }
    if (memory.kind === "procedural" && !this.hasPassedEvaluationEvidence(memory.sourceEvidenceRefs)) {
      throw new Error("procedural memory approval requires passed eval or golden evidence");
    }
    const supersedeIds = [...new Set(request.supersedeIds ?? [])];
    const unresolved = memory.conflictsWith.filter((id) => !supersedeIds.includes(id));
    if (unresolved.length > 0) {
      throw new Error(`conflicting memory requires explicit resolution: ${unresolved.join(",")}`);
    }
    for (const id of supersedeIds) this.require(id);

    withSqliteSavepoint(this.db, "memory_approve", () => {
      this.db.prepare(`
        UPDATE memory_records_v2
        SET approval_status = 'approved', supersedes_json = ?, revision = revision + 1
        WHERE memory_id = ?
      `).run(canonicalJson(supersedeIds), memory.id);
      const relation = this.db.prepare(`
        INSERT OR IGNORE INTO memory_relations_v2(from_memory_id, to_memory_id, relation, created_at)
        VALUES (?, ?, 'supersedes', ?)
      `);
      for (const id of supersedeIds) {
        relation.run(memory.id, id, request.at);
        this.db.prepare(`
          UPDATE memory_records_v2
          SET approval_status = 'expired', revision = revision + 1
          WHERE memory_id = ?
        `).run(id);
        this.log(id, request.approver, "expired", `superseded by ${memory.id}`, memory.sourceEvidenceRefs, request.at);
      }
      this.log(memory.id, request.approver, "approved", request.reason, memory.sourceEvidenceRefs, request.at);
    });
    return this.require(memory.id);
  }

  reject(memoryId: string, principal: MemoryRecordV2["owner"], reason: string, at: string): MemoryRecordV2 {
    const memory = this.require(memoryId);
    if (memory.approvalStatus !== "candidate") throw new Error("only candidate memory can be rejected");
    this.db.prepare("UPDATE memory_records_v2 SET approval_status = 'rejected', revision = revision + 1 WHERE memory_id = ?")
      .run(memoryId);
    this.log(memoryId, principal, "rejected", reason, memory.sourceEvidenceRefs, at);
    return this.require(memoryId);
  }

  archive(memoryId: string, principal: MemoryRecordV2["owner"], reason: string, at: string): MemoryRecordV2 {
    const memory = this.require(memoryId);
    if (memory.approvalStatus === "archived") throw new Error("memory is already archived");
    withSqliteSavepoint(this.db, "memory_archive", () => {
      this.db.prepare(`
        UPDATE memory_records_v2
        SET lifecycle_status = 'archived', archived_at = ?, archived_reason = ?, revision = revision + 1
        WHERE memory_id = ?
      `).run(at, reason, memoryId);
      this.logLifecycle(memoryId, principal, "archived", reason, at);
    });
    return this.require(memoryId);
  }

  restoreArchived(memoryId: string, principal: MemoryRecordV2["owner"], reason: string, at: string): MemoryRecordV2 {
    const memory = this.require(memoryId);
    if (memory.approvalStatus !== "archived") throw new Error("only archived memory can be restored");
    withSqliteSavepoint(this.db, "memory_restore", () => {
      this.db.prepare(`
        UPDATE memory_records_v2
        SET lifecycle_status = 'active', archived_at = NULL, archived_reason = NULL, revision = revision + 1
        WHERE memory_id = ?
      `).run(memoryId);
      this.logLifecycle(memoryId, principal, "restored", reason, at);
    });
    return this.require(memoryId);
  }

  expireDue(now: string): string[] {
    const ids = (this.db.prepare(`
      SELECT memory_id FROM memory_records_v2
      WHERE approval_status = 'approved' AND expires_at IS NOT NULL AND expires_at <= ?
      ORDER BY memory_id
    `).all(now) as Array<{ memory_id: string }>).map((row) => row.memory_id);
    const update = this.db.prepare("UPDATE memory_records_v2 SET approval_status = 'expired', revision = revision + 1 WHERE memory_id = ?");
    for (const id of ids) {
      const memory = this.require(id);
      update.run(id);
      this.log(id, memory.owner, "expired", "expiresAt reached", memory.sourceEvidenceRefs, now);
    }
    return ids;
  }

  retrieve(rawQuery: MemoryRetrievalQuery): MemorySelection[] {
    const query = MemoryRetrievalQuerySchema.parse(rawQuery);
    this.expireDue(query.now);
    const rows = this.db.prepare(`
      SELECT * FROM memory_records_v2
      WHERE approval_status = 'approved'
        AND lifecycle_status = 'active'
        AND confidence >= ?
        AND (scope_tenant_id IS NULL OR scope_tenant_id = ?)
        AND (scope_principal_id IS NULL OR scope_principal_id = ?)
        AND (scope_case_id IS NULL OR scope_case_id = ?)
        AND (scope_role_id IS NULL OR scope_role_id = ?)
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY confidence DESC, COALESCE(last_used_at, created_at) DESC
      LIMIT 500
    `).all(
      query.minimumConfidence,
      query.tenantId ?? query.principal.tenantId ?? null,
      query.principal.id,
      query.caseId ?? null,
      query.roleId ?? null,
      query.now,
    ) as unknown as MemoryRow[];

    const kindSet = new Set(query.kinds);
    const entitySet = new Set(query.entityRefs);
    const selected = rows
      .map(parseRow)
      .filter((memory) => kindSet.size === 0 || kindSet.has(memory.kind))
      .filter((memory) => SENSITIVITY_RANK[memory.sensitivity] <= SENSITIVITY_RANK[query.maximumSensitivity])
      .filter((memory) => memory.entityRefs.length === 0 || memory.entityRefs.every((id) => entitySet.has(id)))
      .filter((memory) => !memory.effectivePeriod || (!!query.effectivePeriod && periodsOverlap(memory.effectivePeriod, query.effectivePeriod)))
      .map((memory) => {
        const summary = summarizeContent(memory.content);
        return { memory, summary, relevance: evaluateMemoryRelevance(query.queryText, summary) };
      })
      .filter(({ relevance }) => relevance.relevant)
      .map(({ memory, summary, relevance }) => MemorySelectionSchema.parse({
        memory,
        summary,
        evidenceRefs: memory.sourceEvidenceRefs,
        score: Math.min(1, relevance.score * 0.85 + freshnessScore(memory, query.now) * 0.15),
        selectionReason: `作用域匹配；主题词匹配：${relevance.matchedTerms.join("、")}`,
      }))
      .sort((left, right) => right.score - left.score || left.memory.id.localeCompare(right.memory.id))
      .slice(0, query.limit);

    const touch = this.db.prepare("UPDATE memory_records_v2 SET last_used_at = ? WHERE memory_id = ?");
    for (const item of selected) {
      touch.run(query.now, item.memory.id);
      this.log(item.memory.id, query.principal, "selected", item.selectionReason, item.evidenceRefs, query.now);
    }
    return selected;
  }

  requestDeletion(request: {
    memoryId: string;
    requester: MemoryRecordV2["owner"];
    at: string;
    retentionReason?: string;
  }): MemoryDeletionResult {
    return withSqliteSavepoint(this.db, "memory_delete_request", () => {
      const memory = this.require(request.memoryId);
      const requestId = randomUUID();
      this.log(memory.id, request.requester, "deletion_requested", request.retentionReason ?? "user requested deletion", [], request.at);
      if (request.retentionReason) {
        this.db.prepare(`
          INSERT INTO memory_deletion_requests_v2
            (request_id, memory_id, requester_json, status, retention_reason, requested_at)
          VALUES (?, ?, ?, 'retained', ?, ?)
        `).run(requestId, memory.id, canonicalJson(request.requester), request.retentionReason, request.at);
        if (memory.approvalStatus !== "archived") {
          this.archive(memory.id, request.requester, request.retentionReason, request.at);
        }
        this.log(memory.id, request.requester, "retained", request.retentionReason, [], request.at);
        return MemoryDeletionResultSchema.parse({
          status: "retained",
          requestId,
          memoryId: memory.id,
          retentionReason: request.retentionReason,
        });
      }

      const proof = sha256Json({
        requestId,
        memoryId: memory.id,
        contentHash: sha256Json(memory.content),
        sourceEvidenceRefs: memory.sourceEvidenceRefs,
        deletedAt: request.at,
      });
      const linkedIds = this.db.prepare(`
        SELECT DISTINCT CASE
          WHEN from_memory_id = ? THEN to_memory_id
          ELSE from_memory_id
        END AS memory_id
        FROM memory_relations_v2
        WHERE from_memory_id = ? OR to_memory_id = ?
      `).all(memory.id, memory.id, memory.id) as Array<{ memory_id: string }>;
      const linkedRows = linkedIds
        .map(({ memory_id: memoryId }) => this.db.prepare(
          "SELECT * FROM memory_records_v2 WHERE memory_id = ?",
        ).get(memoryId) as unknown as MemoryRow | undefined)
        .filter((row): row is MemoryRow => Boolean(row));
      const unlink = this.db.prepare(`
        UPDATE memory_records_v2
        SET conflicts_with_json = ?, supersedes_json = ?, revision = revision + 1
        WHERE memory_id = ?
      `);
      for (const linked of linkedRows.map(parseRow)) {
        unlink.run(
          canonicalJson(linked.conflictsWith.filter((id) => id !== memory.id)),
          canonicalJson(linked.supersedes.filter((id) => id !== memory.id)),
          linked.id,
        );
      }
      this.db.prepare("DELETE FROM memory_records_v2 WHERE memory_id = ?").run(memory.id);
      const remaining = this.db.prepare("SELECT COUNT(*) AS count FROM memory_records_v2 WHERE memory_id = ?")
        .get(memory.id) as { count: number };
      if (remaining.count !== 0) throw new Error(`memory deletion incomplete: ${memory.id}`);
      this.db.prepare(`
        INSERT INTO memory_deletion_requests_v2
          (request_id, memory_id, requester_json, status, deletion_proof, requested_at, completed_at)
        VALUES (?, ?, ?, 'completed', ?, ?, ?)
      `).run(requestId, memory.id, canonicalJson(request.requester), proof, request.at, request.at);
      this.log(memory.id, request.requester, "deleted", "content and relations removed", [], request.at);
      return MemoryDeletionResultSchema.parse({
        status: "completed",
        requestId,
        memoryId: memory.id,
        proof,
        completedAt: request.at,
      });
    });
  }

  private insertRecord(record: MemoryRecordV2, conflictKey: string, contentHash: string): void {
    this.db.prepare(`
      INSERT INTO memory_records_v2
        (memory_id, kind, scope_json, scope_tenant_id, scope_principal_id, scope_case_id, scope_role_id,
         entity_refs_json, effective_period_json, period_start, period_end, content_json, conflict_key,
         source_evidence_json, confidence, sensitivity, approval_status, supersedes_json, conflicts_with_json,
         created_at, last_used_at, expires_at, owner_json, content_hash)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      record.kind,
      canonicalJson(record.scope),
      record.scope.tenantId ?? null,
      record.scope.principalId ?? null,
      record.scope.caseId ?? null,
      record.scope.roleId ?? null,
      canonicalJson(record.entityRefs),
      record.effectivePeriod ? canonicalJson(record.effectivePeriod) : null,
      record.effectivePeriod?.start ?? null,
      record.effectivePeriod?.end ?? null,
      canonicalJson(record.content),
      conflictKey,
      canonicalJson(record.sourceEvidenceRefs),
      record.confidence,
      record.sensitivity,
      record.approvalStatus,
      canonicalJson(record.supersedes),
      canonicalJson(record.conflictsWith),
      record.createdAt,
      record.lastUsedAt ?? null,
      record.expiresAt ?? null,
      canonicalJson(record.owner),
      contentHash,
    );
  }

  private require(memoryId: string): MemoryRecordV2 {
    const memory = this.get(memoryId);
    if (!memory) throw new Error(`memory not found: ${memoryId}`);
    return memory;
  }

  private hasPassedEvaluationEvidence(evidenceIds: string[]): boolean {
    if (evidenceIds.length === 0) return false;
    const placeholders = evidenceIds.map(() => "?").join(",");
    const row = this.db.prepare(`
      SELECT 1 AS ok
      FROM assertion_results
      WHERE evidence_id IN (${placeholders})
        AND status = 'passed'
        AND (validator_id LIKE 'eval.%' OR validator_id LIKE 'golden.%')
      LIMIT 1
    `).get(...evidenceIds) as { ok: number } | undefined;
    return row?.ok === 1;
  }

  private log(
    memoryId: string,
    principal: MemoryRecordV2["owner"],
    action: "created" | "selected" | "approved" | "rejected" | "expired" | "corrected" | "deletion_requested" | "deleted" | "retained",
    reason: string,
    evidenceRefs: string[],
    at: string,
  ): void {
    this.db.prepare(`
      INSERT INTO memory_access_log_v2
        (access_id, memory_id, principal_json, action, reason, evidence_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), memoryId, canonicalJson(principal), action, reason, canonicalJson(evidenceRefs), at);
  }

  private logLifecycle(
    memoryId: string,
    principal: MemoryRecordV2["owner"],
    action: "archived" | "restored",
    reason: string,
    at: string,
  ): void {
    this.db.prepare(`
      INSERT INTO memory_lifecycle_events_v2
        (event_id, memory_id, principal_json, action, reason, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(randomUUID(), memoryId, canonicalJson(principal), action, reason, at);
  }
}
