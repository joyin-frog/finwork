import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { ResourceLimitError } from "./contracts";

export type WorkerJob<T> = { jobId: string; runId: string; caseId?: string; priority: number; payload: T; signal?: AbortSignal; timeoutMs: number };
type Queued<T, R> = WorkerJob<T> & {
  resolve: (value: R) => void;
  reject: (error: Error) => void;
  seq: number;
  detachAbort: () => void;
};

export class BoundedWorkerPool<T, R> {
  private queue: Array<Queued<T, R>> = [];
  private active = new Map<string, AbortController>();
  private sequence = 0;
  private closed = false;
  constructor(readonly options: { name: string; concurrency: number; maxQueue: number; db?: DatabaseSync; handler: (payload: T, signal: AbortSignal) => Promise<R> }) {}

  submit(input: Omit<WorkerJob<T>, "jobId"> & { jobId?: string }): Promise<R> {
    if (this.closed) return Promise.reject(new Error("worker pool closed"));
    if (this.queue.length >= this.options.maxQueue) return Promise.reject(new ResourceLimitError("queue_full", `${this.options.name} queue is full`, { maxQueue: this.options.maxQueue }));
    const jobId = input.jobId ?? randomUUID();
    return new Promise<R>((resolve, reject) => {
      const onAbort = () => this.cancel(jobId);
      const item: Queued<T, R> = {
        ...input,
        jobId,
        resolve,
        reject,
        seq: this.sequence++,
        detachAbort: () => input.signal?.removeEventListener("abort", onAbort),
      };
      this.queue.push(item); this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      this.persist(item, "queued");
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.drain();
    });
  }

  cancel(jobId: string): boolean {
    const index = this.queue.findIndex((job) => job.jobId === jobId);
    if (index >= 0) { const [job] = this.queue.splice(index, 1); job.detachAbort(); this.update(jobId, "cancelled"); job.reject(new DOMException("Aborted", "AbortError")); return true; }
    const controller = this.active.get(jobId); if (controller) { controller.abort(); return true; }
    return false;
  }
  get snapshot() { return { queued: this.queue.length, active: this.active.size, concurrency: this.options.concurrency, maxQueue: this.options.maxQueue }; }
  async close(): Promise<void> { this.closed = true; for (const job of this.queue.splice(0)) { job.detachAbort(); this.update(job.jobId, "cancelled"); job.reject(new Error("worker pool closed")); } for (const controller of this.active.values()) controller.abort(); while (this.active.size) await new Promise((r) => setTimeout(r, 5)); }

  private drain(): void {
    while (!this.closed && this.active.size < this.options.concurrency && this.queue.length) {
      const job = this.queue.shift()!; if (job.signal?.aborted) { job.detachAbort(); this.update(job.jobId, "cancelled"); job.reject(new DOMException("Aborted", "AbortError")); continue; }
      const controller = new AbortController(); this.active.set(job.jobId, controller); this.update(job.jobId, "running");
      const timeoutError = new ResourceLimitError("deadline_exceeded", `worker timed out after ${job.timeoutMs}ms`);
      const timer = setTimeout(() => controller.abort(timeoutError), job.timeoutMs);
      const abortPromise = new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true });
      });
      const handlerPromise = Promise.resolve().then(() => this.options.handler(job.payload, controller.signal));
      Promise.race([handlerPromise, abortPromise]).then((value) => {
        this.update(job.jobId, "succeeded");
        job.resolve(value);
      }).catch((error) => {
        const timeout = error instanceof ResourceLimitError || controller.signal.reason instanceof ResourceLimitError;
        this.update(job.jobId, timeout ? "timed_out" : controller.signal.aborted ? "cancelled" : "failed", error);
        job.reject(error instanceof Error ? error : new Error(String(error)));
      }).finally(() => {
        clearTimeout(timer);
        job.detachAbort();
        this.active.delete(job.jobId);
        this.drain();
      });
    }
  }
  private persist(job: WorkerJob<T>, status: string): void { this.options.db?.prepare(`INSERT INTO worker_jobs(job_id,pool_name,run_id,case_id,priority,status,payload_hash,enqueued_at) VALUES (?,?,?,?,?,?,?,?)`).run(job.jobId, this.options.name, job.runId, job.caseId ?? null, job.priority, status, createHash("sha256").update(JSON.stringify(job.payload)).digest("hex"), new Date().toISOString()); }
  private update(jobId: string, status: string, error?: unknown): void { const now = new Date().toISOString(); this.options.db?.prepare(`UPDATE worker_jobs SET status=?,started_at=CASE WHEN ?='running' THEN COALESCE(started_at,?) ELSE started_at END,heartbeat_at=?,ended_at=CASE WHEN ? IN ('succeeded','failed','cancelled','timed_out') THEN ? ELSE ended_at END,error_message=? WHERE job_id=?`).run(status, status, now, now, status, now, error instanceof Error ? error.message : error ? String(error) : null, jobId); }
}
