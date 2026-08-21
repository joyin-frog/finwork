import assert from "node:assert/strict";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  PersistentDocumentWorkerPool,
  type DocumentWorkerAction,
  type DocumentWorkerClient,
} from "../lib/resource/document-worker-pool.ts";
import { ResourceLimitError } from "../lib/resource/contracts.ts";

class ControlledWorker implements DocumentWorkerClient {
  pendingCount = 0;
  calls: Array<{ action: DocumentWorkerAction; filePath: string; timeoutMs: number }> = [];
  private releases: Array<() => void> = [];

  run(action: DocumentWorkerAction, filePath: string, timeoutMs: number): Promise<string> {
    this.pendingCount += 1;
    this.calls.push({ action, filePath, timeoutMs });
    return new Promise((resolve) => {
      this.releases.push(() => {
        this.pendingCount -= 1;
        resolve(filePath);
      });
    });
  }

  release(): void {
    this.releases.shift()?.();
  }

  async close(): Promise<void> {}
}

export const documentWorkerPoolTestPromise = (async () => {
  {
    const workers = [new ControlledWorker(), new ControlledWorker()];
    const pool = new PersistentDocumentWorkerPool({
      size: 2,
      timeoutMs: 4321,
      maxPending: 2,
      workerFactory: (index) => workers[index],
    });
    const first = pool.run("extract-text", "first.pdf");
    const second = pool.run("ocr-image", "second.png");
    assert.equal(workers[0].calls.length, 1);
    assert.equal(workers[1].calls.length, 1, "requests should use the least-loaded worker");
    await assert.rejects(
      () => pool.run("extract-text", "overflow.pdf"),
      (error: unknown) => error instanceof ResourceLimitError && error.code === "queue_full",
    );
    workers[0].release();
    workers[1].release();
    assert.deepEqual(await Promise.all([first, second]), ["first.pdf", "second.png"]);
    assert.equal(workers[0].calls[0].timeoutMs, 4321);
  }

  const dir = mkdtempSync(path.join(tmpdir(), "finwork-document-worker-"));
  const source = path.join(dir, "note.txt");
  writeFileSync(source, "persistent worker smoke", "utf-8");
  const pool = new PersistentDocumentWorkerPool({ size: 1, maxPending: 2 });
  try {
    await assert.rejects(
      () => pool.run("extract-text", source),
      /unsupported file type: \.txt/,
      "worker errors must return through NDJSON without terminating the process",
    );
    await assert.rejects(
      () => pool.run("ocr-image", source),
      /unsupported image type: \.txt/,
      "the same worker should remain reusable after a failed request",
    );
  } finally {
    await pool.close();
    rmSync(dir, { recursive: true, force: true });
  }

  console.log("document-worker-pool: bounded queue / routing / persistent error recovery ✓");
})();
