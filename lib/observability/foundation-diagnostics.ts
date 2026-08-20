import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";

type CountMap = Record<string, number>;

export type FoundationDiagnosticsSnapshot = {
  snapshotId: string;
  capturedAt: string;
  capabilities: { definitions: CountMap; instances: CountMap; recentAttempts: CountMap };
  cases: CountMap;
  artifacts: { lifecycle: CountMap; logicalBytes: number; physicalBytes: number; activeHolds: number; activeLeases: number };
  evidence: { byType: CountMap; claims: CountMap; citations: number; blockingAssertions: CountMap };
  memory: { approval: CountMap; active: number; expired: number };
  retrieval: { jobs: CountMap; chunks: number };
  resources: { workers: CountMap; cacheEntries: number; cacheBytes: number; cacheHits: number; latestMetricsAt: string | null };
  evaluation: { runs: CountMap; faults: CountMap; latestRunAt: string | null };
  gc: { runs: CountMap; candidates: CountMap; latestRunAt: string | null };
};

function grouped(db: DatabaseSync, sql: string): CountMap {
  const rows = db.prepare(sql).all() as Array<{ key: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

function scalar(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { value: number } | undefined)?.value ?? 0);
}

function latest(db: DatabaseSync, sql: string): string | null {
  return (db.prepare(sql).get() as { value: string | null } | undefined)?.value ?? null;
}

/** Aggregated operational state only. Payload, prompt, document, and secret fields never leave their stores. */
export function captureFoundationDiagnostics(db: DatabaseSync, now = new Date().toISOString()): FoundationDiagnosticsSnapshot {
  const cache = db.prepare(`
    SELECT COUNT(*) AS entries,COALESCE(SUM(size_bytes),0) AS bytes,COALESCE(SUM(hit_count),0) AS hits
    FROM incremental_cache_entries
  `).get() as { entries: number; bytes: number; hits: number };
  const artifactBytes = db.prepare(`
    SELECT COALESCE(SUM(size_bytes),0) AS logical_bytes,
      COALESCE((SELECT SUM(size_bytes) FROM (SELECT MAX(size_bytes) AS size_bytes FROM artifact_versions GROUP BY sha256)),0) AS physical_bytes
    FROM artifact_versions
  `).get() as { logical_bytes: number; physical_bytes: number };
  const gcLatest = latest(db, "SELECT MAX(started_at) AS value FROM artifact_gc_runs");
  const snapshot: FoundationDiagnosticsSnapshot = {
    snapshotId: randomUUID(),
    capturedAt: now,
    capabilities: {
      definitions: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM capability_definitions GROUP BY status"),
      instances: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM capability_instances GROUP BY status"),
      recentAttempts: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM capability_attempts WHERE started_at>=datetime('now','-24 hours') GROUP BY status"),
    },
    cases: grouped(db, "SELECT state AS key,COUNT(*) AS count FROM cases GROUP BY state"),
    artifacts: {
      lifecycle: grouped(db, "SELECT lifecycle_state AS key,COUNT(*) AS count FROM artifacts GROUP BY lifecycle_state"),
      logicalBytes: Number(artifactBytes.logical_bytes),
      physicalBytes: Number(artifactBytes.physical_bytes),
      activeHolds: scalar(db, "SELECT COUNT(*) AS value FROM artifact_holds WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at>datetime('now'))"),
      activeLeases: scalar(db, "SELECT COUNT(*) AS value FROM artifact_leases WHERE released_at IS NULL AND expires_at>datetime('now')"),
    },
    evidence: {
      byType: grouped(db, "SELECT evidence_type AS key,COUNT(*) AS count FROM evidence_records GROUP BY evidence_type"),
      claims: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM claims GROUP BY status"),
      citations: scalar(db, "SELECT COUNT(*) AS value FROM citation_records"),
      blockingAssertions: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM assertion_results WHERE blocking=1 GROUP BY status"),
    },
    memory: {
      approval: grouped(db, "SELECT approval_status AS key,COUNT(*) AS count FROM memory_records_v2 GROUP BY approval_status"),
      active: scalar(db, "SELECT COUNT(*) AS value FROM memory_records_v2 WHERE approval_status='approved' AND (expires_at IS NULL OR expires_at>datetime('now'))"),
      expired: scalar(db, "SELECT COUNT(*) AS value FROM memory_records_v2 WHERE expires_at IS NOT NULL AND expires_at<=datetime('now')"),
    },
    retrieval: {
      jobs: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM retrieval_ingestion_jobs GROUP BY status"),
      chunks: scalar(db, "SELECT COUNT(*) AS value FROM retrieval_chunks WHERE active=1"),
    },
    resources: {
      workers: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM worker_jobs GROUP BY status"),
      cacheEntries: Number(cache.entries), cacheBytes: Number(cache.bytes), cacheHits: Number(cache.hits),
      latestMetricsAt: latest(db, "SELECT MAX(captured_at) AS value FROM resource_metric_snapshots"),
    },
    evaluation: {
      runs: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM evaluation_runs GROUP BY status"),
      faults: grouped(db, "SELECT COALESCE(fault_domain,'none') AS key,COUNT(*) AS count FROM evaluation_runs GROUP BY COALESCE(fault_domain,'none')"),
      latestRunAt: latest(db, "SELECT MAX(started_at) AS value FROM evaluation_runs"),
    },
    gc: {
      runs: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM artifact_gc_runs GROUP BY status"),
      candidates: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM artifact_gc_candidates GROUP BY status"),
      latestRunAt: gcLatest,
    },
  };
  db.prepare("INSERT INTO foundation_diagnostics(snapshot_id,snapshot_json,captured_at) VALUES (?,?,?)")
    .run(snapshot.snapshotId, canonicalJson(snapshot), snapshot.capturedAt);
  return snapshot;
}
