import { randomUUID } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpus } from "node:os";
import path from "node:path";
import { trustedPythonWorkerEnv } from "@/lib/runtime/python-env";
import { getProjectRoot, getPythonPath } from "@/lib/runtime/paths";
import { ResourceLimitError } from "./contracts";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_RESPONSE_BYTES = 20 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_PENDING = 24;

export type DocumentWorkerAction = "extract-text" | "ocr-image";

type WorkerResponse =
  | { id: string | null; ok: true; text: string }
  | { id: string | null; ok: false; error: string };

interface PendingRequest {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface DocumentWorkerClient {
  readonly pendingCount: number;
  run(action: DocumentWorkerAction, filePath: string, timeoutMs: number): Promise<string>;
  close(): Promise<void>;
}

export interface PersistentDocumentWorkerPoolOptions {
  size?: number;
  timeoutMs?: number;
  maxPending?: number;
  maxResponseBytes?: number;
  maxStderrBytes?: number;
  workerFactory?: (index: number) => DocumentWorkerClient;
}

class NdjsonDocumentWorker implements DocumentWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private closing = false;

  constructor(
    private readonly maxResponseBytes: number,
    private readonly maxStderrBytes: number,
  ) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  run(action: DocumentWorkerAction, filePath: string, timeoutMs: number): Promise<string> {
    if (this.closing) return Promise.reject(new Error("document worker is closing"));
    const child = this.ensureStarted();
    this.setStreamsReferenced(child, true);
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new ResourceLimitError(
          "deadline_exceeded",
          `document worker timed out after ${timeoutMs}ms`,
          { action, filePath, timeoutMs },
        );
        this.failProcess(error);
        if (this.child === child && child.exitCode === null && child.signalCode === null) child.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ id, action, file_path: filePath })}\n`, "utf-8", (error) => {
        if (!error) return;
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer);
        this.pending.delete(id);
        request.reject(new Error(`failed to write to document worker: ${error.message}`));
        this.unrefWhenIdle();
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    this.child = null;
    if (child) {
      child.stdin.end();
      if (child.exitCode === null && child.signalCode === null) child.kill();
    }
    this.rejectAll(new Error("document worker closed"));
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return this.child;
    const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
    const child = spawn(getPythonPath(), [workerPath, "document-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: trustedPythonWorkerEnv(undefined, ["FINANCE_PDF_MAX_OCR_PAGES"]),
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";
    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      const remaining = this.maxStderrBytes - Buffer.byteLength(this.stderrBuffer);
      if (remaining > 0) this.stderrBuffer += chunk.toString("utf-8").slice(0, remaining);
    });
    child.on("error", (error) => this.failProcess(new Error(`document worker failed to start: ${error.message}`)));
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = null;
      if (!this.closing || this.pending.size > 0) {
        this.failProcess(new Error(`document worker exited unexpectedly (${code ?? signal ?? "unknown"})`));
      }
    });
    // The child-process handle itself never pins a short-lived CLI. Its stdio
    // stays referenced while requests are pending and is unreferenced only
    // after the queue drains, so awaited work cannot disappear mid-request.
    child.unref();
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuffer += chunk.toString("utf-8");
    if (Buffer.byteLength(this.stdoutBuffer) > this.maxResponseBytes) {
      this.failProcess(new ResourceLimitError(
        "budget_exhausted",
        "document worker response exceeds output budget",
        { maxResponseBytes: this.maxResponseBytes },
      ));
      this.child?.kill();
      return;
    }
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch (error) {
      this.failProcess(new Error(`document worker returned invalid JSON: ${String(error)}`));
      this.child?.kill();
      return;
    }
    if (typeof response.id !== "string") {
      this.failProcess(new Error("document worker response is missing request id"));
      this.child?.kill();
      return;
    }
    const request = this.pending.get(response.id);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(response.id);
    if (response.ok) request.resolve(response.text.trim());
    else request.reject(new Error(response.error));
    this.unrefWhenIdle();
  }

  private failProcess(error: Error): void {
    const stderr = this.stderrBuffer.trim();
    this.rejectAll(stderr ? new Error(`${error.message}: ${stderr}`) : error);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.unrefWhenIdle();
  }

  private unrefWhenIdle(): void {
    if (this.pending.size === 0 && this.child) this.setStreamsReferenced(this.child, false);
  }

  private setStreamsReferenced(child: ChildProcessWithoutNullStreams, referenced: boolean): void {
    for (const stream of [child.stdin, child.stdout, child.stderr]) {
      const target = stream as typeof stream & { ref?: () => void; unref?: () => void };
      if (referenced) target.ref?.();
      else target.unref?.();
    }
  }
}

export class PersistentDocumentWorkerPool {
  private readonly workers: DocumentWorkerClient[];
  private readonly timeoutMs: number;
  private readonly maxPending: number;

  constructor(options: PersistentDocumentWorkerPoolOptions = {}) {
    const configuredSize = Number(process.env.FINWORK_DOCUMENT_WORKERS);
    const defaultSize = Number.isInteger(configuredSize) && configuredSize > 0
      ? configuredSize
      : Math.min(2, cpus().length || 1);
    const size = Math.max(1, Math.min(4, Math.floor(options.size ?? defaultSize)));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? DEFAULT_MAX_PENDING;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
    if (!Number.isInteger(this.maxPending) || this.maxPending < size) throw new Error("maxPending must cover every worker");
    const factory = options.workerFactory ?? (() => new NdjsonDocumentWorker(
      options.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES,
      options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    ));
    this.workers = Array.from({ length: size }, (_, index) => factory(index));
  }

  async run(action: DocumentWorkerAction, filePath: string): Promise<string> {
    const pending = this.workers.reduce((sum, worker) => sum + worker.pendingCount, 0);
    if (pending >= this.maxPending) {
      throw new ResourceLimitError("queue_full", "document worker queue is full", {
        pending,
        maxPending: this.maxPending,
      });
    }
    const worker = this.workers.reduce((best, candidate) =>
      candidate.pendingCount < best.pendingCount ? candidate : best
    );
    return worker.run(action, filePath, this.timeoutMs);
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}

let defaultPool: PersistentDocumentWorkerPool | null = null;

export function runDocumentWorker(action: DocumentWorkerAction, filePath: string): Promise<string> {
  defaultPool ??= new PersistentDocumentWorkerPool();
  return defaultPool.run(action, filePath);
}

export async function closeDocumentWorkerPool(): Promise<void> {
  const pool = defaultPool;
  defaultPool = null;
  if (pool) await pool.close();
}
