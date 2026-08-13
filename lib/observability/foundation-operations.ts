import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { BusinessCaseStore } from "@/lib/case-management/store";
import { ArtifactLifecycleService } from "@/lib/file-lifecycle/service";
import type { ArtifactGcPolicy, GcPlan } from "@/lib/file-lifecycle/contracts";
import { getAppDataDir } from "@/lib/runtime/paths";

function json<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string") return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function hashJson(value: unknown): string {
  return hashText(JSON.stringify(value ?? null));
}

function limitWithin(value: number | undefined, fallback = 100): number {
  const finite = Number.isFinite(value) ? Number(value) : fallback;
  return Math.min(Math.max(Math.trunc(finite), 1), 500);
}

function safeProducer(value: unknown): Record<string, unknown> {
  const producer = json<Record<string, unknown>>(value, {});
  return Object.fromEntries(
    ["capabilityId", "version", "attemptId", "workerId"]
      .filter((key) => typeof producer[key] === "string")
      .map((key) => [key, producer[key]]),
  );
}

function safeCaseSnapshot(snapshot: ReturnType<BusinessCaseStore["snapshot"]>) {
  return {
    caseId: snapshot.caseId,
    kind: snapshot.kind,
    snapshotHash: snapshot.snapshotHash,
    nodes: snapshot.nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      status: node.status,
      titleHash: hashText(node.title),
      dataHash: hashJson(node.data),
      artifactVersionIds: node.artifactVersionIds,
      evidenceIds: node.evidenceIds,
      createdAt: node.createdAt,
      updatedAt: node.updatedAt,
    })),
    edges: snapshot.edges.map((edge) => ({
      from: edge.from,
      to: edge.to,
      relation: edge.relation,
      evidenceIds: edge.evidenceIds,
      createdAt: edge.createdAt,
    })),
    runs: snapshot.runs.map((run) => ({
      runId: run.runId,
      roleId: run.roleId,
      capabilityIds: run.capabilityIds,
      state: run.state,
      startedAt: run.startedAt,
      endedAt: run.endedAt ?? null,
    })),
    deadlines: snapshot.deadlines.map((deadline) => ({
      id: deadline.id,
      obligationNodeId: deadline.obligationNodeId,
      dueAt: deadline.dueAt,
      remindAt: deadline.remindAt ?? null,
      status: deadline.status,
      timezone: deadline.timezone,
      createdAt: deadline.createdAt,
      updatedAt: deadline.updatedAt,
    })),
    decisions: snapshot.decisions.map((decision) => ({
      id: decision.id,
      specId: decision.specId,
      status: decision.status,
      promptHash: hashText(decision.prompt),
      ...(decision.answer === undefined ? {} : { answerHash: hashJson(decision.answer) }),
      requestedAt: decision.requestedAt,
      resolvedAt: decision.resolvedAt ?? null,
    })),
    history: snapshot.history.map((event) => ({
      id: event.id,
      sequence: event.sequence,
      eventType: event.eventType,
      reasonHash: hashText(event.reason),
      actorHash: hashJson(event.actor),
      runId: event.runId ?? null,
      decisionId: event.decisionId ?? null,
      evidenceIds: event.evidenceIds,
      payloadHash: hashJson(event.payload),
      previousHash: event.previousHash ?? null,
      eventHash: event.eventHash,
      createdAt: event.createdAt,
    })),
  };
}

export type FoundationCaseSummary = {
  caseId: string;
  taskId: string;
  runId: string | null;
  kind: string;
  state: string;
  planVersion: number;
  nodeCount: number;
  failedNodeCount: number;
  pendingDecisionCount: number;
  updatedAt: string;
};

export function listFoundationCases(db: DatabaseSync, limit = 100): FoundationCaseSummary[] {
  return db.prepare(`
    SELECT c.case_id AS caseId,c.task_id AS taskId,c.run_id AS runId,
      COALESCE(c.case_kind,'financial_consolidation') AS kind,c.state,c.plan_version AS planVersion,
      COUNT(DISTINCT n.node_id) AS nodeCount,
      COUNT(DISTINCT CASE WHEN n.status='failed' THEN n.node_id END) AS failedNodeCount,
      COUNT(DISTINCT CASE WHEN d.status='pending' THEN d.decision_id END) AS pendingDecisionCount,
      c.updated_at AS updatedAt
    FROM cases c
    LEFT JOIN case_nodes n ON n.case_id=c.case_id
    LEFT JOIN case_human_decisions d ON d.case_id=c.case_id
    GROUP BY c.case_id,c.task_id,c.run_id,c.case_kind,c.state,c.plan_version,c.updated_at
    ORDER BY c.updated_at DESC LIMIT ?
  `).all(limitWithin(limit)) as FoundationCaseSummary[];
}

export function getFoundationCase(db: DatabaseSync, caseId: string) {
  const summary = db.prepare(`
    SELECT c.case_id AS caseId,c.task_id AS taskId,c.run_id AS runId,
      COALESCE(c.case_kind,'financial_consolidation') AS kind,c.state,c.plan_version AS planVersion,
      COUNT(DISTINCT n.node_id) AS nodeCount,
      COUNT(DISTINCT CASE WHEN n.status='failed' THEN n.node_id END) AS failedNodeCount,
      COUNT(DISTINCT CASE WHEN d.status='pending' THEN d.decision_id END) AS pendingDecisionCount,
      c.updated_at AS updatedAt
    FROM cases c
    LEFT JOIN case_nodes n ON n.case_id=c.case_id
    LEFT JOIN case_human_decisions d ON d.case_id=c.case_id
    WHERE c.case_id=?
    GROUP BY c.case_id,c.task_id,c.run_id,c.case_kind,c.state,c.plan_version,c.updated_at
  `).get(caseId) as FoundationCaseSummary | undefined;
  if (!summary) throw new Error(`case not found: ${caseId}`);
  return { summary, snapshot: safeCaseSnapshot(new BusinessCaseStore(db).snapshot(caseId)) };
}

export function listFoundationClaims(db: DatabaseSync, input: { caseId?: string; limit?: number } = {}) {
  const limit = limitWithin(input.limit);
  const rows = input.caseId
    ? db.prepare(`
        SELECT c.claim_id AS claimId,c.case_id AS caseId,c.status,c.statement,c.created_at AS createdAt,
          c.updated_at AS updatedAt,COUNT(DISTINCT ce.evidence_id) AS evidenceCount,
          COUNT(DISTINCT cr.citation_id) AS citationCount
        FROM claims c LEFT JOIN claim_evidence ce ON ce.claim_id=c.claim_id
        LEFT JOIN citation_records cr ON cr.claim_id=c.claim_id
        WHERE c.case_id=? GROUP BY c.claim_id ORDER BY c.updated_at DESC LIMIT ?
      `).all(input.caseId, limit)
    : db.prepare(`
        SELECT c.claim_id AS claimId,c.case_id AS caseId,c.status,c.statement,c.created_at AS createdAt,
          c.updated_at AS updatedAt,COUNT(DISTINCT ce.evidence_id) AS evidenceCount,
          COUNT(DISTINCT cr.citation_id) AS citationCount
        FROM claims c LEFT JOIN claim_evidence ce ON ce.claim_id=c.claim_id
        LEFT JOIN citation_records cr ON cr.claim_id=c.claim_id
        GROUP BY c.claim_id ORDER BY c.updated_at DESC LIMIT ?
      `).all(limit);
  return (rows as Array<Record<string, unknown> & { statement: string }>).map(({ statement, ...row }) => ({
    ...row,
    statementHash: hashText(statement),
  }));
}

export function exportFoundationEvidenceChain(db: DatabaseSync, claimId: string, includeContent = false) {
  const claim = db.prepare(`SELECT * FROM claims WHERE claim_id=?`).get(claimId) as Record<string, unknown> | undefined;
  if (!claim) throw new Error(`claim not found: ${claimId}`);
  const statement = String(claim.statement);
  const evidence = db.prepare(`
    SELECT e.*,ce.role,a.logical_name,a.classification,a.lifecycle_state,v.sha256,v.media_type,v.size_bytes
    FROM claim_evidence ce JOIN evidence_records e ON e.evidence_id=ce.evidence_id
    JOIN artifact_versions v ON v.version_id=e.artifact_version_id
    JOIN artifacts a ON a.artifact_id=v.artifact_id
    WHERE ce.claim_id=? ORDER BY e.created_at,e.evidence_id
  `).all(claimId) as Array<Record<string, unknown>>;
  const citations = db.prepare(`
    SELECT cr.*,a.logical_name,a.classification,a.lifecycle_state,v.sha256,v.media_type,v.size_bytes
    FROM citation_records cr JOIN artifact_versions v ON v.version_id=cr.artifact_version_id
    JOIN artifacts a ON a.artifact_id=v.artifact_id
    WHERE cr.claim_id=? ORDER BY cr.created_at,cr.citation_id
  `).all(claimId) as Array<Record<string, unknown>>;
  const assertions = db.prepare(`SELECT * FROM assertion_results WHERE case_id=? ORDER BY created_at,assertion_id`)
    .all(String(claim.case_id)) as Array<Record<string, unknown>>;
  return {
    exportedAt: new Date().toISOString(),
    claim: {
      claimId: claim.claim_id,
      caseId: claim.case_id,
      status: claim.status,
      statementHash: hashText(statement),
      ...(includeContent ? { statement } : {}),
      structuredValueHash: hashJson(json(claim.structured_json, null)),
      ...(includeContent ? { structuredValue: json(claim.structured_json, null) } : {}),
      createdAt: claim.created_at,
      updatedAt: claim.updated_at,
    },
    evidence: evidence.map((row) => ({
      evidenceId: row.evidence_id,
      type: row.evidence_type,
      role: row.role,
      artifactVersionId: row.artifact_version_id,
      artifact: {
        logicalNameHash: hashText(String(row.logical_name)),
        ...(includeContent ? { logicalName: row.logical_name } : {}),
        classification: row.classification, lifecycleState: row.lifecycle_state, sha256: row.sha256,
        mediaType: row.media_type, sizeBytes: row.size_bytes,
      },
      locator: json(row.locator_json, null),
      producer: safeProducer(row.producer_json),
      inputRefsHash: hashJson(json(row.input_refs_json, [])),
      ...(includeContent ? { inputs: json(row.input_refs_json, []) } : {}),
      outputHash: row.output_hash,
      confidence: row.confidence,
      uncertaintyHash: hashJson(json(row.uncertainty_json, null)),
      ...(includeContent ? { uncertainty: json(row.uncertainty_json, null) } : {}),
      policyDecisionId: row.policy_decision_id,
      createdAt: row.created_at,
    })),
    citations: citations.map((row) => ({
      citationId: row.citation_id,
      artifactVersionId: row.artifact_version_id,
      artifact: {
        logicalNameHash: hashText(String(row.logical_name)),
        ...(includeContent ? { logicalName: row.logical_name } : {}),
        classification: row.classification, lifecycleState: row.lifecycle_state, sha256: row.sha256,
        mediaType: row.media_type, sizeBytes: row.size_bytes,
      },
      locator: json(row.locator_json, null),
      quoteHash: row.quote_hash,
      createdAt: row.created_at,
    })),
    assertions: assertions.map((row) => ({
      assertionId: row.assertion_id,
      validatorId: row.validator_id,
      status: row.status,
      blocking: Boolean(row.blocking),
      evidenceId: row.evidence_id,
      detailsHash: hashJson(json(row.details_json, {})),
      ...(includeContent ? { details: json(row.details_json, {}) } : {}),
      createdAt: row.created_at,
    })),
  };
}

export type FoundationArtifactSummary = {
  artifactId: string;
  kind: string;
  logicalName: string;
  ownerCaseId: string | null;
  classification: string;
  lifecycleState: string;
  currentVersionId: string | null;
  retention: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  versionCount: number;
  logicalBytes: number;
};

export function listFoundationArtifacts(db: DatabaseSync, input: { caseId?: string; state?: string; limit?: number } = {}): FoundationArtifactSummary[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (input.caseId) { clauses.push("a.owner_case_id=?"); params.push(input.caseId); }
  if (input.state) { clauses.push("a.lifecycle_state=?"); params.push(input.state); }
  params.push(limitWithin(input.limit));
  const rows = db.prepare(`
    SELECT a.artifact_id AS artifactId,a.kind,a.logical_name AS logicalName,a.owner_case_id AS ownerCaseId,
      a.classification,a.lifecycle_state AS lifecycleState,a.current_version_id AS currentVersionId,
      a.retention_json AS retention,a.created_at AS createdAt,a.updated_at AS updatedAt,
      COUNT(v.version_id) AS versionCount,COALESCE(SUM(v.size_bytes),0) AS logicalBytes
    FROM artifacts a LEFT JOIN artifact_versions v ON v.artifact_id=a.artifact_id
    ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
    GROUP BY a.artifact_id ORDER BY a.updated_at DESC LIMIT ?
  `).all(...params) as Array<Omit<FoundationArtifactSummary, "retention"> & { retention: string }>;
  return rows.map((row) => ({ ...row, retention: json<Record<string, unknown>>(row.retention, {}) }));
}

export function getFoundationArtifact(db: DatabaseSync, artifactId: string) {
  const row = db.prepare(`
    SELECT a.artifact_id AS artifactId,a.kind,a.logical_name AS logicalName,a.owner_case_id AS ownerCaseId,
      a.classification,a.lifecycle_state AS lifecycleState,a.current_version_id AS currentVersionId,
      a.retention_json AS retention,a.created_at AS createdAt,a.updated_at AS updatedAt,
      COUNT(v.version_id) AS versionCount,COALESCE(SUM(v.size_bytes),0) AS logicalBytes
    FROM artifacts a LEFT JOIN artifact_versions v ON v.artifact_id=a.artifact_id
    WHERE a.artifact_id=? GROUP BY a.artifact_id
  `).get(artifactId) as (Omit<FoundationArtifactSummary, "retention"> & { retention: string }) | undefined;
  const artifact = row ? { ...row, retention: json<Record<string, unknown>>(row.retention, {}) } : undefined;
  if (!artifact) throw new Error(`artifact not found: ${artifactId}`);
  const versions = db.prepare(`
    SELECT version_id AS versionId,version_no AS versionNo,sha256,size_bytes AS sizeBytes,media_type AS mediaType,
      state,producer_json AS producer,metadata_json AS metadata,created_at AS createdAt
    FROM artifact_versions WHERE artifact_id=? ORDER BY version_no DESC
  `).all(artifactId) as Array<Record<string, unknown>>;
  const holds = db.prepare(`SELECT hold_id AS holdId,artifact_version_id AS artifactVersionId,hold_type AS type,owner_id AS ownerId,reason,expires_at AS expiresAt,released_at AS releasedAt,created_at AS createdAt FROM artifact_holds WHERE artifact_version_id IN (SELECT version_id FROM artifact_versions WHERE artifact_id=?) ORDER BY created_at DESC`).all(artifactId);
  const events = db.prepare(`SELECT event_id AS eventId,artifact_version_id AS artifactVersionId,event_type AS type,actor_id AS actorId,details_json AS details,created_at AS createdAt FROM artifact_lifecycle_events WHERE artifact_id=? ORDER BY created_at DESC LIMIT 200`).all(artifactId) as Array<Record<string, unknown>>;
  return {
    artifact,
    versions: versions.map(({ metadata, producer, ...row }) => ({
      ...row,
      producer: safeProducer(producer),
      metadataHash: hashJson(json(metadata, {})),
    })),
    holds,
    events: events.map(({ details, ...row }) => ({ ...row, detailsHash: hashJson(json(details, {})) })),
  };
}

export function artifactLifecycleService(db: DatabaseSync) {
  return new ArtifactLifecycleService(db, path.join(getAppDataDir(), "artifacts", "cas"));
}

export function loadGcPlan(db: DatabaseSync, runId: string): { plan: GcPlan; policy: ArtifactGcPolicy } {
  const run = db.prepare(`SELECT policy_json FROM artifact_gc_runs WHERE run_id=? AND status='completed'`).get(runId) as { policy_json: string } | undefined;
  if (!run) throw new Error(`completed GC plan not found: ${runId}`);
  const candidates = db.prepare(`SELECT artifact_version_id AS artifactVersionId,artifact_id AS artifactId,sha256,size_bytes AS sizeBytes,reason FROM artifact_gc_candidates WHERE run_id=? AND status='planned' ORDER BY artifact_version_id`).all(runId) as GcPlan["candidates"];
  return { plan: { runId, roots: [], marked: [], candidates, reclaimableBytes: candidates.reduce((sum, item) => sum + item.sizeBytes, 0) }, policy: json(run.policy_json, {}) as ArtifactGcPolicy };
}
