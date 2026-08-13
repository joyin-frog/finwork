import type { DatabaseSync } from "node:sqlite";

type CountMap = Record<string, number>;

function grouped(db: DatabaseSync, sql: string): CountMap {
  const rows = db.prepare(sql).all() as Array<{ key: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.key, Number(row.count)]));
}

function scalar(db: DatabaseSync, sql: string): number {
  return Number((db.prepare(sql).get() as { value: number } | undefined)?.value ?? 0);
}

/**
 * Management read model. It deliberately returns identifiers, lifecycle state,
 * counts and hashes only; prompts, memory content, evidence quotes and file paths
 * are never projected into an API response.
 */
export function getFoundationManagementSnapshot(db: DatabaseSync) {
  const capabilities = db.prepare(`
    SELECT d.capability_id AS id,d.version,d.title,d.status,d.unavailable_reason AS unavailableReason,
      COUNT(i.instance_id) AS instances,
      SUM(CASE WHEN i.status='available' THEN 1 ELSE 0 END) AS availableInstances
    FROM capability_definitions d
    LEFT JOIN capability_instances i ON i.capability_id=d.capability_id AND i.version=d.version
    GROUP BY d.capability_id,d.version,d.title,d.status,d.unavailable_reason
    ORDER BY d.capability_id,d.version
  `).all();
  const cases = db.prepare(`
    SELECT c.case_id AS caseId,c.task_id AS taskId,c.run_id AS runId,c.state,c.plan_version AS planVersion,
      c.updated_at AS updatedAt,
      COUNT(n.node_id) AS nodes,
      SUM(CASE WHEN n.status='failed' THEN 1 ELSE 0 END) AS failedNodes,
      SUM(CASE WHEN n.status='waiting_for_human' THEN 1 ELSE 0 END) AS waitingNodes
    FROM cases c LEFT JOIN case_nodes n ON n.case_id=c.case_id
    GROUP BY c.case_id,c.task_id,c.run_id,c.state,c.plan_version,c.updated_at
    ORDER BY c.updated_at DESC LIMIT 100
  `).all();
  const activeRollout = db.prepare(`
    SELECT epoch,mode,authority,reason,created_at AS createdAt
    FROM capability_rollout_epochs WHERE state='active' LIMIT 1
  `).get() ?? null;

  return {
    generatedAt: new Date().toISOString(),
    rollout: activeRollout,
    capabilities: {
      totals: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM capability_definitions GROUP BY status"),
      items: capabilities,
    },
    cases: {
      totals: grouped(db, "SELECT state AS key,COUNT(*) AS count FROM cases GROUP BY state"),
      items: cases,
    },
    evidence: {
      records: grouped(db, "SELECT evidence_type AS key,COUNT(*) AS count FROM evidence_records GROUP BY evidence_type"),
      claims: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM claims GROUP BY status"),
      assertions: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM assertion_results GROUP BY status"),
      citations: scalar(db, "SELECT COUNT(*) AS value FROM citation_records"),
    },
    artifacts: {
      lifecycle: grouped(db, "SELECT lifecycle_state AS key,COUNT(*) AS count FROM artifacts GROUP BY lifecycle_state"),
      versions: grouped(db, "SELECT state AS key,COUNT(*) AS count FROM artifact_versions GROUP BY state"),
      logicalBytes: scalar(db, "SELECT COALESCE(SUM(size_bytes),0) AS value FROM artifact_versions"),
      uniqueBytes: scalar(db, "SELECT COALESCE(SUM(size_bytes),0) AS value FROM (SELECT MAX(size_bytes) AS size_bytes FROM artifact_versions GROUP BY sha256)"),
      activeHolds: scalar(db, "SELECT COUNT(*) AS value FROM artifact_holds WHERE released_at IS NULL AND (expires_at IS NULL OR expires_at>datetime('now'))"),
      activeLeases: scalar(db, "SELECT COUNT(*) AS value FROM artifact_leases WHERE released_at IS NULL AND expires_at>datetime('now')"),
      gc: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM artifact_gc_runs GROUP BY status"),
    },
    memory: {
      approval: grouped(db, "SELECT approval_status AS key,COUNT(*) AS count FROM memory_records_v2 GROUP BY approval_status"),
      kinds: grouped(db, "SELECT kind AS key,COUNT(*) AS count FROM memory_records_v2 GROUP BY kind"),
      accessEvents: scalar(db, "SELECT COUNT(*) AS value FROM memory_access_log_v2"),
      deletionRequests: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM memory_deletion_requests_v2 GROUP BY status"),
    },
    evaluation: {
      runs: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM evaluation_runs GROUP BY status"),
      faults: grouped(db, "SELECT COALESCE(fault_domain,'none') AS key,COUNT(*) AS count FROM evaluation_runs GROUP BY COALESCE(fault_domain,'none')"),
      scores: grouped(db, "SELECT dimension AS key,COUNT(*) AS count FROM evaluation_scorecards WHERE passed=1 GROUP BY dimension"),
    },
    resources: {
      jobs: grouped(db, "SELECT status AS key,COUNT(*) AS count FROM worker_jobs GROUP BY status"),
      cacheEntries: scalar(db, "SELECT COUNT(*) AS value FROM incremental_cache_entries"),
      cacheBytes: scalar(db, "SELECT COALESCE(SUM(size_bytes),0) AS value FROM incremental_cache_entries"),
    },
  };
}

export type FoundationManagementSnapshot = ReturnType<typeof getFoundationManagementSnapshot>;
