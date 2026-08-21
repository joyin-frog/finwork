import type { DatabaseSync } from "node:sqlite";
import { ResourceLedger } from "./ledger";
import { TempWorkspaceRegistry } from "./temp-workspaces";

type SqlInput = string | number | bigint | Uint8Array | null;

export function auditQueryPlan(db: DatabaseSync, sql: string, params: SqlInput[] = []): { details: string[]; fullScan: boolean } {
  const details = (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((row) => row.detail);
  return { details, fullScan: details.some((detail) => /SCAN\s+\w+$/i.test(detail) && !/USING (COVERING )?INDEX/i.test(detail)) };
}
export function maintainSqlite(
  db: DatabaseSync,
  usageEventLimit = 10_000,
  historyLimit = 10_000,
): { journalMode: string; trimmedEvents: number; trimmedJobs: number; trimmedSnapshots: number; trimmedReservations: number } {
  const mode = String((db.prepare("PRAGMA journal_mode=WAL").get() as Record<string, unknown>)["journal_mode"] ?? "unknown");
  const count = Number((db.prepare("SELECT COUNT(*) AS n FROM resource_usage_events").get() as { n: number }).n); const trim = Math.max(0, count - usageEventLimit);
  if (trim) db.prepare(`DELETE FROM resource_usage_events WHERE event_id IN (SELECT event_id FROM resource_usage_events ORDER BY sampled_at ASC LIMIT ?)` ).run(trim);
  const jobCount = Number((db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE status NOT IN ('queued','running')").get() as { n: number }).n);
  const trimJobs = Math.max(0, jobCount - historyLimit);
  if (trimJobs) db.prepare(`DELETE FROM worker_jobs WHERE job_id IN (
    SELECT job_id FROM worker_jobs WHERE status NOT IN ('queued','running') ORDER BY ended_at ASC LIMIT ?
  )`).run(trimJobs);
  const snapshotCount = Number((db.prepare("SELECT COUNT(*) AS n FROM resource_metric_snapshots").get() as { n: number }).n);
  const trimSnapshots = Math.max(0, snapshotCount - historyLimit);
  if (trimSnapshots) db.prepare(`DELETE FROM resource_metric_snapshots WHERE snapshot_id IN (
    SELECT snapshot_id FROM resource_metric_snapshots ORDER BY captured_at ASC LIMIT ?
  )`).run(trimSnapshots);
  db.exec("PRAGMA optimize");
  const reservationCount = Number((db.prepare("SELECT COUNT(*) AS n FROM resource_reservations WHERE status!='active'").get() as { n: number }).n);
  const trimReservations = Math.max(0, reservationCount - historyLimit);
  if (trimReservations) db.prepare(`DELETE FROM resource_reservations WHERE reservation_id IN (
    SELECT reservation_id FROM resource_reservations WHERE status!='active' ORDER BY released_at ASC LIMIT ?
  )`).run(trimReservations);
  return { journalMode: mode, trimmedEvents: trim, trimmedJobs: trimJobs, trimmedSnapshots: trimSnapshots, trimmedReservations: trimReservations };
}

export function recoverInterruptedResourceWork(
  db: DatabaseSync,
  runId: string,
  now = new Date().toISOString(),
): { reservations: number; workerJobs: number } {
  const reservations = new ResourceLedger(db).cancelActiveForRun(runId, now);
  const result = db.prepare(`UPDATE worker_jobs SET
    status='cancelled', heartbeat_at=?, ended_at=?, error_message='owner process restarted'
    WHERE run_id=? AND status IN ('queued','running')`).run(now, now, runId);
  return { reservations, workerJobs: Number(result.changes) };
}

export type ResourceMaintenanceResult = ReturnType<typeof maintainSqlite> & {
  sweptWorkspaces: number;
  failedWorkspaceSweeps: number;
  reclaimedWorkspaceBytes: number;
  tombstonedWorkspaces: number;
};

/**
 * 进程启动时可安全执行的资源维护。
 *
 * 注意：worker_jobs 目前没有跨进程 owner lease，不能在这里把 queued/running
 * 任务或 active reservation 当成“上次崩溃遗留”取消。运行恢复只能在调用方
 * 已取得对应 run lease 后显式调用 recoverInterruptedResourceWork。
 *
 * 临时目录采用两阶段删除：本轮先清理此前已过宽限期的 tombstone，再把超时
 * active 目录标成 tombstone，绝不在同一轮直接删除刚发现的目录。
 */
export function maintainResourceState(
  db: DatabaseSync,
  workspaceRoot: string,
  options: {
    usageEventLimit?: number;
    historyLimit?: number;
    staleWorkspaceMs?: number;
    workspaceDeleteGraceMs?: number;
    now?: Date;
  } = {},
): ResourceMaintenanceResult {
  const staleWorkspaceMs = options.staleWorkspaceMs ?? 24 * 60 * 60 * 1000;
  const workspaceDeleteGraceMs = options.workspaceDeleteGraceMs ?? 24 * 60 * 60 * 1000;
  if (!Number.isFinite(staleWorkspaceMs) || staleWorkspaceMs <= 0) {
    throw new Error("staleWorkspaceMs must be positive");
  }
  if (!Number.isFinite(workspaceDeleteGraceMs) || workspaceDeleteGraceMs < 0) {
    throw new Error("workspaceDeleteGraceMs must be non-negative");
  }

  const now = options.now ?? new Date();
  const registry = new TempWorkspaceRegistry(db, workspaceRoot);
  const swept = registry.sweep(now);
  const tombstonedWorkspaces = registry.tombstoneStale(
    staleWorkspaceMs,
    workspaceDeleteGraceMs,
    now,
  );
  return {
    ...maintainSqlite(db, options.usageEventLimit, options.historyLimit),
    sweptWorkspaces: swept.deleted,
    failedWorkspaceSweeps: swept.failed,
    reclaimedWorkspaceBytes: swept.bytesReclaimed,
    tombstonedWorkspaces,
  };
}
