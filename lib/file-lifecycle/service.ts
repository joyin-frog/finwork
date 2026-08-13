import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { ArtifactGcPolicySchema, type ArtifactGcPolicy, type ArtifactQuotaSnapshot, type GcCandidate, type GcPlan } from "./contracts";

type VersionRow = {
  version_id: string; artifact_id: string; sha256: string; size_bytes: number; created_at: string;
  lifecycle_state: string; current_version_id: string | null; kind: string; retention_json: string; metadata_json: string;
};

const ROOT_REF_TYPES = new Set(["case_input", "case_output", "evidence", "citation", "memory", "knowledge", "delivery"]);
const RECLAIMABLE_KINDS = new Set(["preview", "index", "cache", "thumbnail", "render"]);

function parseObject(raw: string): Record<string, unknown> {
  try { const value = JSON.parse(raw); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

function isExpired(row: VersionRow, policy: ArtifactGcPolicy): boolean {
  const retention = parseObject(row.retention_json);
  const expiresAt = typeof retention.expiresAt === "string" ? Date.parse(retention.expiresAt) : Number.NaN;
  return Number.isFinite(expiresAt) && expiresAt <= Date.parse(policy.now);
}

function isOldEnough(row: VersionRow, policy: ArtifactGcPolicy): boolean {
  return Date.parse(row.created_at) <= Date.parse(policy.now) - policy.minimumAgeMs;
}

function memoryArtifactIds(db: DatabaseSync): string[] {
  const rows = db.prepare(`SELECT source_evidence_json FROM memory_records_v2 WHERE approval_status='approved'`).all() as Array<{ source_evidence_json: string }>;
  const found = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) return void value.forEach(visit);
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if ((key === "artifactVersionId" || key === "artifact_version_id") && typeof child === "string") found.add(child);
      else visit(child);
    }
  };
  for (const row of rows) { try { visit(JSON.parse(row.source_evidence_json)); } catch { /* malformed legacy memory is not a GC root */ } }
  return [...found];
}

export class ArtifactLifecycleService {
  readonly casRoot: string;
  constructor(readonly db: DatabaseSync, casRoot: string) { this.casRoot = path.resolve(casRoot); }

  hold(versionId: string, input: { type: "legal_hold" | "pin"; ownerId: string; reason: string; expiresAt?: string; now: string }): string {
    const row = this.db.prepare("SELECT artifact_id FROM artifact_versions WHERE version_id=?").get(versionId) as { artifact_id: string } | undefined;
    if (!row) throw new Error(`artifact version not found: ${versionId}`);
    const id = randomUUID();
    this.db.prepare(`INSERT INTO artifact_holds(hold_id,artifact_version_id,hold_type,owner_id,reason,expires_at,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, versionId, input.type, input.ownerId, input.reason, input.expiresAt ?? null, input.now);
    this.event(row.artifact_id, versionId, "hold", input.ownerId, { holdId: id, type: input.type, reason: input.reason }, input.now);
    return id;
  }

  releaseHold(holdId: string, actorId: string, now: string): void {
    const row = this.db.prepare(`SELECT h.artifact_version_id, v.artifact_id FROM artifact_holds h JOIN artifact_versions v ON v.version_id=h.artifact_version_id WHERE h.hold_id=? AND h.released_at IS NULL`)
      .get(holdId) as { artifact_version_id: string; artifact_id: string } | undefined;
    if (!row) throw new Error(`active hold not found: ${holdId}`);
    this.db.prepare("UPDATE artifact_holds SET released_at=? WHERE hold_id=?").run(now, holdId);
    this.event(row.artifact_id, row.artifact_version_id, "release", actorId, { holdId }, now);
  }

  plan(rawPolicy: ArtifactGcPolicy): GcPlan {
    const policy = ArtifactGcPolicySchema.parse(rawPolicy);
    const versions = this.db.prepare(`
      SELECT v.version_id,v.artifact_id,v.sha256,v.size_bytes,v.created_at,v.metadata_json,
             a.lifecycle_state,a.current_version_id,a.kind,a.retention_json
      FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
    `).all() as VersionRow[];
    const byId = new Map(versions.map((row) => [row.version_id, row]));
    const roots = new Set<string>();

    for (const row of versions) {
      const metadata = parseObject(row.metadata_json);
      const reclaimable = RECLAIMABLE_KINDS.has(row.kind) || metadata.reclaimable === true;
      if (row.lifecycle_state === "delivered" || (!reclaimable && row.current_version_id === row.version_id && row.lifecycle_state !== "tombstoned" && !isExpired(row, policy))) roots.add(row.version_id);
    }
    for (const ref of this.db.prepare("SELECT artifact_version_id,ref_type FROM artifact_refs").all() as Array<{ artifact_version_id: string; ref_type: string }>) {
      if (ROOT_REF_TYPES.has(ref.ref_type)) roots.add(ref.artifact_version_id);
    }
    for (const row of this.db.prepare("SELECT artifact_version_id FROM evidence_records UNION SELECT artifact_version_id FROM citation_records").all() as Array<{ artifact_version_id: string }>) roots.add(row.artifact_version_id);
    for (const id of memoryArtifactIds(this.db)) roots.add(id);
    for (const row of this.db.prepare(`SELECT artifact_version_id FROM artifact_holds WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).all(policy.now) as Array<{ artifact_version_id: string }>) roots.add(row.artifact_version_id);
    for (const row of this.db.prepare(`SELECT artifact_version_id FROM artifact_leases WHERE released_at IS NULL AND expires_at>?`).all(policy.now) as Array<{ artifact_version_id: string }>) roots.add(row.artifact_version_id);

    const adjacency = new Map<string, Set<string>>();
    const link = (a: string, b: string) => { (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b); };
    for (const edge of this.db.prepare("SELECT from_version_id,to_version_id FROM artifact_edges").all() as Array<{ from_version_id: string; to_version_id: string }>) {
      link(edge.from_version_id, edge.to_version_id); link(edge.to_version_id, edge.from_version_id);
    }
    const marked = new Set<string>();
    const queue = [...roots];
    while (queue.length) { const id = queue.pop()!; if (marked.has(id) || !byId.has(id)) continue; marked.add(id); for (const next of adjacency.get(id) ?? []) queue.push(next); }

    const candidates: GcCandidate[] = [];
    for (const row of versions) {
      if (marked.has(row.version_id) || !isOldEnough(row, policy)) continue;
      const metadata = parseObject(row.metadata_json);
      const reason = row.lifecycle_state === "tombstoned" ? "tombstoned"
        : isExpired(row, policy) ? "expired"
        : RECLAIMABLE_KINDS.has(row.kind) || metadata.reclaimable === true ? "reclaimable_derivative" : null;
      if (reason) candidates.push({ artifactVersionId: row.version_id, artifactId: row.artifact_id, sha256: row.sha256, sizeBytes: row.size_bytes, reason });
    }
    candidates.sort((a, b) => a.artifactVersionId.localeCompare(b.artifactVersionId));
    const runId = randomUUID();
    this.db.prepare(`INSERT INTO artifact_gc_runs(run_id,mode,status,policy_json,stats_json,started_at,completed_at) VALUES(?,?,?,?,?,?,?)`)
      .run(runId, "dry_run", "completed", canonicalJson(policy), canonicalJson({ roots: roots.size, marked: marked.size, candidates: candidates.length }), policy.now, policy.now);
    const insert = this.db.prepare(`INSERT INTO artifact_gc_candidates(run_id,artifact_version_id,artifact_id,sha256,size_bytes,reason,status) VALUES(?,?,?,?,?,?,?)`);
    for (const item of candidates) { insert.run(runId, item.artifactVersionId, item.artifactId, item.sha256, item.sizeBytes, item.reason, "planned"); this.event(item.artifactId, item.artifactVersionId, "gc_plan", policy.actorId, { runId, reason: item.reason }, policy.now); }
    return { runId, roots: [...roots].sort(), marked: [...marked].sort(), candidates, reclaimableBytes: candidates.reduce((sum, item) => sum + item.sizeBytes, 0) };
  }

  tombstone(plan: GcPlan, rawPolicy: ArtifactGcPolicy): void {
    const policy = ArtifactGcPolicySchema.parse(rawPolicy);
    const deleteAfter = new Date(Date.parse(policy.now) + policy.gracePeriodMs).toISOString();
    this.db.exec("BEGIN");
    try {
      for (const item of plan.candidates) {
        const state = this.db.prepare("SELECT lifecycle_state,current_version_id FROM artifacts WHERE artifact_id=?").get(item.artifactId) as { lifecycle_state: string; current_version_id: string | null } | undefined;
        if (!state) continue;
        this.db.prepare("UPDATE artifact_versions SET state='tombstoned' WHERE version_id=?").run(item.artifactVersionId);
        if (state.current_version_id === item.artifactVersionId) this.db.prepare("UPDATE artifacts SET lifecycle_state='tombstoned',updated_at=? WHERE artifact_id=?").run(policy.now, item.artifactId);
        this.db.prepare(`UPDATE artifact_gc_candidates SET status='tombstoned',tombstoned_at=?,delete_after=? WHERE run_id=? AND artifact_version_id=?`).run(policy.now, deleteAfter, plan.runId, item.artifactVersionId);
        this.event(item.artifactId, item.artifactVersionId, "tombstone", policy.actorId, { runId: plan.runId, deleteAfter }, policy.now);
      }
      this.db.prepare("UPDATE artifact_gc_runs SET mode='tombstone',stats_json=? WHERE run_id=?").run(canonicalJson({ tombstoned: plan.candidates.length }), plan.runId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  restore(versionId: string, actorId: string, now: string): void {
    const row = this.db.prepare(`SELECT v.artifact_id,a.current_version_id FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id WHERE v.version_id=? AND v.state='tombstoned'`).get(versionId) as { artifact_id: string; current_version_id: string | null } | undefined;
    if (!row) throw new Error(`restorable tombstone not found: ${versionId}`);
    this.db.exec("BEGIN");
    try {
      this.db.prepare("UPDATE artifact_versions SET state='archived' WHERE version_id=?").run(versionId);
      if (row.current_version_id === versionId) this.db.prepare("UPDATE artifacts SET lifecycle_state='archived',updated_at=? WHERE artifact_id=?").run(now, row.artifact_id);
      this.db.prepare("UPDATE artifact_gc_candidates SET status='restored' WHERE artifact_version_id=? AND status='tombstoned'").run(versionId);
      this.event(row.artifact_id, versionId, "restore", actorId, {}, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  sweep(now: string, actorId = "system:artifact-gc", beforeUnlink?: (sha256: string) => void): { deleted: number; failed: number; bytes: number } {
    const candidates = this.db.prepare(`SELECT * FROM artifact_gc_candidates WHERE status IN ('tombstoned','deleting','failed') AND delete_after<=? ORDER BY rowid`).all(now) as Array<{ run_id: string; artifact_version_id: string; artifact_id: string; sha256: string; size_bytes: number }>;
    let deleted = 0, failed = 0, bytes = 0;
    for (const item of candidates) {
      try {
        this.db.exec("BEGIN");
        this.db.prepare("UPDATE artifact_gc_candidates SET status='deleting',error_message=NULL WHERE run_id=? AND artifact_version_id=?").run(item.run_id, item.artifact_version_id);
        this.db.prepare("DELETE FROM artifact_versions WHERE version_id=? AND state='tombstoned'").run(item.artifact_version_id);
        const remainingArtifact = this.db.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE artifact_id=?").get(item.artifact_id) as { n: number };
        if (remainingArtifact.n === 0) this.db.prepare("DELETE FROM artifacts WHERE artifact_id=? AND lifecycle_state='tombstoned'").run(item.artifact_id);
        this.db.exec("COMMIT");
        const remainingHash = this.db.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE sha256=?").get(item.sha256) as { n: number };
        if (remainingHash.n === 0) {
          beforeUnlink?.(item.sha256);
          const blob = path.join(this.casRoot, item.sha256.slice(0, 2), item.sha256);
          if (fs.existsSync(blob)) fs.unlinkSync(blob);
          bytes += item.size_bytes;
        }
        this.db.prepare("UPDATE artifact_gc_candidates SET status='deleted' WHERE run_id=? AND artifact_version_id=?").run(item.run_id, item.artifact_version_id);
        this.event(item.artifact_id, item.artifact_version_id, "physical_delete", actorId, { runId: item.run_id, sha256: item.sha256 }, now);
        deleted++;
      } catch (error) {
        try { this.db.exec("ROLLBACK"); } catch { /* transaction may already be committed */ }
        const message = error instanceof Error ? error.message : String(error);
        this.db.prepare("UPDATE artifact_gc_candidates SET status='failed',error_message=? WHERE run_id=? AND artifact_version_id=?").run(message, item.run_id, item.artifact_version_id);
        this.event(item.artifact_id, item.artifact_version_id, "delete_failed", actorId, { runId: item.run_id, error: message }, now);
        failed++;
      }
    }
    return { deleted, failed, bytes };
  }

  quotaSnapshot(plan?: GcPlan): ArtifactQuotaSnapshot {
    const totals = this.db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS bytes,COUNT(*) AS versions,COUNT(DISTINCT artifact_id) AS artifacts FROM artifact_versions").get() as { bytes: number; versions: number; artifacts: number };
    const physical = this.db.prepare("SELECT COALESCE(SUM(size_bytes),0) AS bytes FROM (SELECT sha256,MAX(size_bytes) AS size_bytes FROM artifact_versions GROUP BY sha256)").get() as { bytes: number };
    return { logicalBytes: totals.bytes, physicalBytes: physical.bytes, reclaimableBytes: plan?.reclaimableBytes ?? 0, artifactCount: totals.artifacts, versionCount: totals.versions };
  }

  private event(artifactId: string, versionId: string | null, type: string, actorId: string, details: unknown, now: string): void {
    this.db.prepare(`INSERT INTO artifact_lifecycle_events(event_id,artifact_id,artifact_version_id,event_type,actor_id,details_json,created_at) VALUES(?,?,?,?,?,?,?)`)
      .run(randomUUID(), artifactId, versionId, type, actorId, canonicalJson(details), now);
  }
}
