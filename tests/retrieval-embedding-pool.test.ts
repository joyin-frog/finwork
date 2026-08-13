import assert from "node:assert/strict";
import {
  PersistentEmbeddingPool,
  RetrievalError,
  type EmbeddingWorkerClient,
} from "../lib/retrieval/index.ts";

class FakeWorker implements EmbeddingWorkerClient {
  pendingCount = 0;
  calls = 0;
  closed = false;

  constructor(private readonly delayMs: number, private readonly fail = false) {}

  async embed(texts: readonly string[], _modelDir: string, timeoutMs: number): Promise<readonly (readonly number[])[]> {
    this.pendingCount += 1;
    this.calls += 1;
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, this.delayMs);
        if (this.delayMs > timeoutMs) {
          clearTimeout(timer);
          setTimeout(() => reject(new RetrievalError("embedding_failed", "fake timeout", { retryable: true })), timeoutMs);
        }
      });
      if (this.fail) throw new RetrievalError("embedding_failed", "fake embedding failure", { retryable: true });
      return texts.map((text) => [text.length, 1]);
    } finally {
      this.pendingCount -= 1;
    }
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

export const retrievalEmbeddingPoolTestPromise = (async () => {
  const workers = [new FakeWorker(25), new FakeWorker(25)];
  const pool = new PersistentEmbeddingPool({
    size: 2,
    timeoutMs: 100,
    workerFactory: (index) => workers[index],
    modelReady: () => true,
    modelDir: () => "/fake/model",
  });
  const [left, right] = await Promise.all([
    pool.embed(["甲"], "bge-small-zh-v1.5"),
    pool.embed(["乙乙"], "bge-small-zh-v1.5"),
  ]);
  assert.deepEqual(left, [[1, 1]]);
  assert.deepEqual(right, [[2, 1]]);
  assert.deepEqual(workers.map((worker) => worker.calls), [1, 1]);
  await pool.close();
  assert.ok(workers.every((worker) => worker.closed));

  const timeoutWorker = new FakeWorker(50);
  const timeoutPool = new PersistentEmbeddingPool({
    size: 1,
    timeoutMs: 5,
    workerFactory: () => timeoutWorker,
    modelReady: () => true,
    modelDir: () => "/fake/model",
  });
  await assert.rejects(() => timeoutPool.embed(["超时"], "bge-small-zh-v1.5"), (error: unknown) => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.code, "embedding_failed");
    assert.equal(error.retryable, true);
    return true;
  });
  await timeoutPool.close();

  const unavailable = new PersistentEmbeddingPool({
    workerFactory: () => new FakeWorker(0),
    modelReady: () => false,
  });
  await assert.rejects(() => unavailable.embed(["模型"], "bge-small-zh-v1.5"), (error: unknown) => {
    assert.ok(error instanceof RetrievalError);
    assert.equal(error.code, "embedding_unavailable");
    return true;
  });

  console.log("retrieval-embedding-pool: bounded concurrency, timeout, lifecycle and explicit unavailability passed ✓");
})();

if (process.argv[1]?.includes("retrieval-embedding-pool.test")) {
  retrievalEmbeddingPoolTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
