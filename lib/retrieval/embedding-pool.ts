import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { cpus } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EMBED_MODEL, getEmbedModelDir, isEmbedModelReady } from "@/lib/knowledge/embed-model";
import { pythonSpawnEnv } from "@/lib/runtime/python-env";
import { getProjectRoot, getPythonPath } from "@/lib/runtime/paths";
import { RetrievalError, type RetrievalEmbedder } from "./contracts";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_BUFFER_BYTES = 32 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;

type WorkerResponse =
  | { id: string | null; ok: true; dim: number; vectors: number[][] }
  | { id: string | null; ok: false; error: string };

interface PendingRequest {
  resolve: (vectors: readonly (readonly number[])[]) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface EmbeddingWorkerClient {
  readonly pendingCount: number;
  embed(texts: readonly string[], modelDir: string, timeoutMs: number): Promise<readonly (readonly number[])[]>;
  close(): Promise<void>;
}

export interface PersistentEmbeddingPoolOptions {
  size?: number;
  timeoutMs?: number;
  maxBufferBytes?: number;
  maxStderrBytes?: number;
  workerFactory?: (index: number) => EmbeddingWorkerClient;
  modelReady?: (model: string) => boolean;
  modelDir?: (model: string) => string;
}

interface ProcessWorkerOptions {
  maxBufferBytes: number;
  maxStderrBytes: number;
}

class NdjsonEmbeddingWorker implements EmbeddingWorkerClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private stdoutBuffer = "";
  private stdoutBytes = 0;
  private stderrBuffer = "";
  private readonly pending = new Map<string, PendingRequest>();
  private closing = false;

  constructor(private readonly options: ProcessWorkerOptions) {}

  get pendingCount(): number {
    return this.pending.size;
  }

  embed(
    texts: readonly string[],
    modelDir: string,
    timeoutMs: number
  ): Promise<readonly (readonly number[])[]> {
    if (this.closing) {
      return Promise.reject(new RetrievalError("embedding_unavailable", "embedding worker is closing", { retryable: true }));
    }
    const child = this.ensureStarted();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const timeoutError = new RetrievalError("embedding_failed", `embedding request timed out after ${timeoutMs}ms`, {
          retryable: true,
          details: { timeoutMs },
        });
        // A timed-out native/Python request may keep consuming CPU and memory.
        // Terminate the shared worker and fail every in-flight request; the next
        // request starts a clean process instead of leaving an orphan behind.
        this.failProcess(timeoutError.message, timeoutError, { timeoutMs });
        if (this.child === child && child.exitCode === null && child.signalCode === null) child.kill();
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const request = JSON.stringify({ id, texts, model_dir: modelDir });
      child.stdin.write(`${request}\n`, "utf-8", (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new RetrievalError("embedding_unavailable", "failed to write to embedding worker", {
          retryable: true,
          cause: error,
        }));
      });
    });
  }

  async close(): Promise<void> {
    this.closing = true;
    const child = this.child;
    if (!child) return;
    this.child = null;
    child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    this.rejectAll(new RetrievalError("embedding_unavailable", "embedding worker closed", { retryable: true }));
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && this.child.signalCode === null) return this.child;
    const workerPath = path.join(getProjectRoot(), "workers", "finance_worker.py");
    const child = spawn(getPythonPath(), [workerPath, "embed-server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: pythonSpawnEnv(),
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stdoutBytes = 0;
    this.stderrBuffer = "";

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(this.stderrBuffer) >= this.options.maxStderrBytes) return;
      this.stderrBuffer += chunk.toString("utf-8").slice(0, this.options.maxStderrBytes - Buffer.byteLength(this.stderrBuffer));
    });
    child.on("error", (error) => {
      this.failProcess("embedding worker failed to start", error);
    });
    child.on("close", (code, signal) => {
      if (this.child === child) this.child = null;
      if (this.closing && this.pending.size === 0) return;
      this.failProcess(`embedding worker exited unexpectedly (${code ?? signal ?? "unknown"})`);
    });
    return child;
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBytes += chunk.length;
    if (this.stdoutBytes > this.options.maxBufferBytes) {
      this.failProcess("embedding worker response exceeds maxBuffer", undefined, {
        maxBufferBytes: this.options.maxBufferBytes,
      });
      this.child?.kill();
      return;
    }
    this.stdoutBuffer += chunk.toString("utf-8");
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.stdoutBytes = Buffer.byteLength(this.stdoutBuffer);
      if (line) this.handleLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    let response: WorkerResponse;
    try {
      response = JSON.parse(line) as WorkerResponse;
    } catch (error) {
      this.failProcess("embedding worker returned invalid JSON", error, { line: line.slice(0, 1000) });
      this.child?.kill();
      return;
    }
    if (typeof response.id !== "string") {
      this.failProcess("embedding worker response is missing request id", undefined, { response });
      this.child?.kill();
      return;
    }
    const pending = this.pending.get(response.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(response.id);
    if (!response.ok) {
      const unavailable = response.error === "model_not_found" || response.error.startsWith("import_error:");
      pending.reject(new RetrievalError(unavailable ? "embedding_unavailable" : "embedding_failed", response.error, {
        retryable: !unavailable,
      }));
      return;
    }
    try {
      validateVectors(response.vectors, response.dim);
      pending.resolve(response.vectors);
    } catch (error) {
      pending.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private failProcess(message: string, cause?: unknown, details?: unknown): void {
    const stderr = this.stderrBuffer.trim();
    this.rejectAll(new RetrievalError("embedding_unavailable", stderr ? `${message}: ${stderr}` : message, {
      retryable: true,
      cause,
      details,
    }));
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }
}

function validateVectors(vectors: readonly (readonly number[])[], expectedDim?: number): void {
  const dim = expectedDim ?? vectors[0]?.length ?? 0;
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new RetrievalError("embedding_failed", "embedding worker returned an invalid vector dimension", {
      retryable: false,
      details: { expectedDim },
    });
  }
  for (const vector of vectors) {
    if (vector.length !== dim || vector.some((value) => !Number.isFinite(value))) {
      throw new RetrievalError("embedding_failed", "embedding worker returned malformed vectors", {
        retryable: false,
        details: { expectedDim: dim, actualDim: vector.length },
      });
    }
  }
}

export class PersistentEmbeddingPool {
  private readonly workers: EmbeddingWorkerClient[];
  private readonly timeoutMs: number;
  private readonly modelReady: (model: string) => boolean;
  private readonly modelDir: (model: string) => string;

  constructor(options: PersistentEmbeddingPoolOptions = {}) {
    const size = Math.max(1, Math.min(8, Math.floor(options.size ?? Math.min(2, cpus().length || 1))));
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) throw new Error("timeoutMs must be positive");
    this.modelReady = options.modelReady ?? isEmbedModelReady;
    this.modelDir = options.modelDir ?? getEmbedModelDir;
    const factory = options.workerFactory ?? (() => new NdjsonEmbeddingWorker({
      maxBufferBytes: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
      maxStderrBytes: options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES,
    }));
    this.workers = Array.from({ length: size }, (_, index) => factory(index));
  }

  readonly embed: RetrievalEmbedder = async (texts, model) => {
    if (texts.length === 0) return [];
    if (model !== EMBED_MODEL) {
      throw new RetrievalError("embedding_unavailable", `unsupported embedding model: ${model}`, {
        retryable: false,
        details: { supportedModel: EMBED_MODEL },
      });
    }
    if (!this.modelReady(model)) {
      throw new RetrievalError("embedding_unavailable", `embedding model is not ready: ${model}`, {
        retryable: false,
      });
    }
    const worker = this.workers.reduce((best, candidate) =>
      candidate.pendingCount < best.pendingCount ? candidate : best
    );
    const vectors = await worker.embed(texts, this.modelDir(model), this.timeoutMs);
    if (vectors.length !== texts.length) {
      throw new RetrievalError("embedding_failed", "embedding worker returned the wrong number of vectors", {
        retryable: false,
        details: { expected: texts.length, actual: vectors.length },
      });
    }
    validateVectors(vectors);
    return vectors;
  };

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
  }
}
