import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import { BoundedWorkerPool, IncrementalCache, OutputSpool, ResourceLedger, auditQueryPlan, captureResourceMetrics, maintainSqlite } from "../lib/resource/index.ts";

function db(): DatabaseSync { const value = new DatabaseSync(":memory:"); value.exec("PRAGMA foreign_keys=ON"); runMigrations(value, ":memory:", () => null); return value; }
const budget = (concurrency = 1) => ({ tokenLimit: 1000, wallTimeMs: 100_000, cpuTimeMs: 100_000, memoryBytes: 10_000_000, diskBytes: 10_000_000, networkBytes: 10_000_000, toolOutputBytes: 10_000_000, concurrency, retryLimit: 3 });

export const resourceGovernorTestPromise = (async () => {
  const database = db(); const ledger = new ResourceLedger(database);
  ledger.setBudget({ type: "global", key: "default" }, budget(2)); ledger.setBudget({ type: "case", key: "case-1" }, budget(1)); ledger.setBudget({ type: "run", key: "run-1" }, budget(1));
  const reservation = ledger.reserve({ runId: "run-1", caseId: "case-1", capabilityId: "test", expected: { wallTimeMs: 10, toolOutputBytes: 20 } });
  assert.throws(() => ledger.reserve({ runId: "run-1", caseId: "case-1", capabilityId: "test", expected: {} }), /concurrency exhausted/);
  ledger.release(reservation, { wallTimeMs: 12, toolOutputBytes: 22 }); assert.equal(ledger.activeCount(), 0);
  ledger.release(reservation, { wallTimeMs: 12 }); assert.equal(ledger.activeCount(), 0, "release must be idempotent");

  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const starts: string[] = [];
  const pool = new BoundedWorkerPool<{ name: string; wait?: boolean }, string>({ name: "parser", concurrency: 1, maxQueue: 2, db: database, handler: async (payload, signal) => { starts.push(payload.name); if (payload.wait) await gate; if (signal.aborted) throw signal.reason; return payload.name; } });
  const blocker = pool.submit({ runId: "r", priority: 1, timeoutMs: 1000, payload: { name: "blocker", wait: true } });
  const low = pool.submit({ runId: "r", priority: 1, timeoutMs: 1000, payload: { name: "low" } }); const high = pool.submit({ runId: "r", priority: 9, timeoutMs: 1000, payload: { name: "high" } });
  assert.rejects(pool.submit({ runId: "r", priority: 0, timeoutMs: 1000, payload: { name: "overflow" } }), /queue is full/); release(); await Promise.all([blocker, low, high]); assert.deepEqual(starts, ["blocker", "high", "low"]);
  const abort = new AbortController(); const cancelPool = new BoundedWorkerPool<void, void>({ name: "cancel", concurrency: 1, maxQueue: 1, db: database, handler: (_, signal) => new Promise((resolve, reject) => { signal.addEventListener("abort", () => reject(signal.reason ?? new DOMException("Aborted", "AbortError")), { once: true }); setTimeout(resolve, 5000); }) });
  const pending = cancelPool.submit({ runId: "r", priority: 1, timeoutMs: 1000, signal: abort.signal, payload: undefined }); const cancelStarted = Date.now(); abort.abort(); await assert.rejects(pending); assert(Date.now() - cancelStarted < 2000); await cancelPool.close(); await pool.close();
  const timeoutPool = new BoundedWorkerPool<void, void>({ name: "watchdog", concurrency: 1, maxQueue: 1, handler: (_, signal) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })) }); await assert.rejects(timeoutPool.submit({ runId: "r", priority: 1, timeoutMs: 20, payload: undefined }), /timed out/); await timeoutPool.close();

  const cache = new IncrementalCache(database, 1024); const descriptor = { namespace: "parse", inputHash: "a", toolVersion: "1", policyRevision: "1", authorizationHash: "acl-1" }; let computations = 0;
  const calculate = () => { const hit = cache.get<number>(descriptor); if (hit != null) return hit; computations++; cache.set(descriptor, 42); return 42; };
  for (let i = 0; i < 10; i++) assert.equal(calculate(), 42); assert.equal(computations, 1); assert(cache.stats().hits >= 9, "repeated artifact must avoid at least 80% work"); assert.equal(cache.get({ ...descriptor, authorizationHash: "acl-2" }), null, "cache authorization must be rechecked");

  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-spool-"));
  try { const spool = new OutputSpool(new ArtifactStore(database, root), 64, 24); const value = { rows: Array.from({ length: 100 }, (_, i) => ({ i, value: "x".repeat(10) })) }; const lazy = spool.write(value, { runId: "run-1", capabilityId: "parse" }); assert.equal(lazy.kind, "artifact"); if (lazy.kind === "artifact") { assert(lazy.preview.length <= 24); const first = spool.readWindow(lazy.artifact.versionId, 0, 24); assert.equal(first.text.length, 24); assert.throws(() => spool.readWindow(lazy.artifact.versionId, 0, 25)); } } finally { rmSync(root, { recursive: true, force: true }); }

  const plan = auditQueryPlan(database, "SELECT * FROM worker_jobs WHERE pool_name=? AND status=? ORDER BY priority DESC,enqueued_at ASC", ["parser", "queued"]); assert.equal(plan.fullScan, false, plan.details.join("; "));
  captureResourceMetrics(database, { runId: "run-1", queueDepth: 0, cacheBytes: cache.stats().bytes }); const maintained = maintainSqlite(database, 10); assert(["memory", "wal"].includes(maintained.journalMode));
  assert.equal((database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok"); database.close();
  console.log("resource-governor: hierarchical budgets, priority, backpressure, cancellation, watchdog, cache, lazy output and DB maintenance passed ✓");
})();
