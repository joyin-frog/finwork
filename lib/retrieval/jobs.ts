import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { RetrievalError, RetrievalErrorCodeSchema, type RetrievalErrorCode } from "./contracts";

export type RetrievalJobStatus = "queued" | "running" | "succeeded" | "failed" | "retryable" | "canceled";

export type RetrievalJob = {
  jobId: string;
  documentId: string;
  status: RetrievalJobStatus;
  attemptCount: number;
  leaseOwner?: string;
  leaseExpiresAt?: string;
  errorCode?: RetrievalErrorCode;
  errorMessage?: string;
  queuedAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
};

type JobRow = {
  job_id: string;
  document_id: string;
  status: RetrievalJobStatus;
  attempt_count: number;
  lease_owner: string | null;
  lease_expires_at: string | null;
  error_code: string | null;
  error_message: string | null;
  queued_at: string;
  started_at: string | null;
  completed_at: string | null;
  updated_at: string;
};

function mapJob(row: JobRow): RetrievalJob {
  return {
    jobId: row.job_id,
    documentId: row.document_id,
    status: row.status,
    attemptCount: row.attempt_count,
    leaseOwner: row.lease_owner ?? undefined,
    leaseExpiresAt: row.lease_expires_at ?? undefined,
    errorCode: row.error_code ? RetrievalErrorCodeSchema.parse(row.error_code) : undefined,
    errorMessage: row.error_message ?? undefined,
    queuedAt: row.queued_at,
    startedAt: row.started_at ?? undefined,
    completedAt: row.completed_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

export class RetrievalJobQueue {
  constructor(readonly db: DatabaseSync) {}

  enqueue(documentId: string, at: string, jobId = randomUUID()): RetrievalJob {
    this.db.prepare(`
      INSERT INTO retrieval_ingestion_jobs
        (job_id, document_id, status, attempt_count, queued_at, updated_at)
      VALUES (?, ?, 'queued', 0, ?, ?)
    `).run(jobId, documentId, at, at);
    return this.get(jobId);
  }

  get(jobId: string): RetrievalJob {
    const row = this.db.prepare("SELECT * FROM retrieval_ingestion_jobs WHERE job_id = ?").get(jobId) as JobRow | undefined;
    if (!row) throw new RetrievalError("job_not_found", `retrieval job not found: ${jobId}`);
    return mapJob(row);
  }

  claimNext(workerId: string, at: string, leaseMs = 60_000): RetrievalJob | undefined {
    const leaseExpiresAt = new Date(new Date(at).getTime() + leaseMs).toISOString();
    let inTransaction = false;
    this.db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    try {
      const row = this.db.prepare(`
        SELECT job_id FROM retrieval_ingestion_jobs
        WHERE status IN ('queued','retryable')
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY queued_at, job_id
        LIMIT 1
      `).get(at) as { job_id: string } | undefined;
      if (!row) {
        this.db.exec("COMMIT");
        inTransaction = false;
        return undefined;
      }
      const result = this.db.prepare(`
        UPDATE retrieval_ingestion_jobs
        SET status='running', attempt_count=attempt_count+1, lease_owner=?, lease_expires_at=?,
            error_code=NULL, error_message=NULL, started_at=COALESCE(started_at, ?), updated_at=?
        WHERE job_id=? AND status IN ('queued','retryable')
      `).run(workerId, leaseExpiresAt, at, at, row.job_id);
      if (result.changes !== 1) throw new RetrievalError("job_not_claimable", `retrieval job lost claim race: ${row.job_id}`, { retryable: true });
      const claimed = this.db.prepare("SELECT * FROM retrieval_ingestion_jobs WHERE job_id = ?").get(row.job_id) as JobRow;
      this.db.exec("COMMIT");
      inTransaction = false;
      return mapJob(claimed);
    } catch (error) {
      if (inTransaction) this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** 精确领取调用方刚创建的任务，避免同步上传错误消费其他排队任务。 */
  claim(jobId: string, workerId: string, at: string, leaseMs = 60_000): RetrievalJob {
    const leaseExpiresAt = new Date(new Date(at).getTime() + leaseMs).toISOString();
    const result = this.db.prepare(`
      UPDATE retrieval_ingestion_jobs
      SET status='running', attempt_count=attempt_count+1, lease_owner=?, lease_expires_at=?,
          error_code=NULL, error_message=NULL, started_at=COALESCE(started_at, ?), updated_at=?
      WHERE job_id=? AND status IN ('queued','retryable')
        AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
    `).run(workerId, leaseExpiresAt, at, at, jobId, at);
    if (result.changes !== 1) {
      throw new RetrievalError("job_not_claimable", `retrieval job cannot be claimed: ${jobId}`, { retryable: true });
    }
    return this.get(jobId);
  }

  complete(jobId: string, workerId: string, at: string): RetrievalJob {
    const result = this.db.prepare(`
      UPDATE retrieval_ingestion_jobs
      SET status='succeeded', lease_owner=NULL, lease_expires_at=NULL, error_code=NULL,
          error_message=NULL, completed_at=?, updated_at=?
      WHERE job_id=? AND status='running' AND lease_owner=?
    `).run(at, at, jobId, workerId);
    if (result.changes !== 1) throw new RetrievalError("job_not_claimable", `retrieval job is not owned by ${workerId}: ${jobId}`);
    return this.get(jobId);
  }

  fail(jobId: string, workerId: string, error: RetrievalError, at: string): RetrievalJob {
    const status: RetrievalJobStatus = error.retryable ? "retryable" : "failed";
    const result = this.db.prepare(`
      UPDATE retrieval_ingestion_jobs
      SET status=?, lease_owner=NULL, lease_expires_at=NULL, error_code=?, error_message=?,
          completed_at=CASE WHEN ?='failed' THEN ? ELSE NULL END, updated_at=?
      WHERE job_id=? AND status='running' AND lease_owner=?
    `).run(status, error.code, error.message, status, at, at, jobId, workerId);
    if (result.changes !== 1) throw new RetrievalError("job_not_claimable", `retrieval job is not owned by ${workerId}: ${jobId}`);
    return this.get(jobId);
  }

  recoverExpired(at: string): number {
    const result = this.db.prepare(`
      UPDATE retrieval_ingestion_jobs
      SET status='retryable', lease_owner=NULL, lease_expires_at=NULL,
          error_code='index_failed', error_message='worker lease expired', updated_at=?
      WHERE status='running' AND lease_expires_at <= ?
    `).run(at, at);
    return Number(result.changes);
  }
}

export class RetrievalWorkerPool {
  private running = false;

  constructor(
    readonly queue: RetrievalJobQueue,
    readonly process: (job: RetrievalJob, workerId: string) => Promise<void>,
    readonly concurrency = 2,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("invalid retrieval worker concurrency");
  }

  async drain(now: () => string = () => new Date().toISOString()): Promise<number> {
    if (this.running) throw new Error("retrieval worker pool is already draining");
    this.running = true;
    let processed = 0;
    try {
      await Promise.all(Array.from({ length: this.concurrency }, async (_, slot) => {
        const workerId = `retrieval-worker-${slot}-${randomUUID()}`;
        while (true) {
          const job = this.queue.claimNext(workerId, now());
          if (!job) break;
          await this.process(job, workerId);
          processed += 1;
        }
      }));
      return processed;
    } finally {
      this.running = false;
    }
  }
}
