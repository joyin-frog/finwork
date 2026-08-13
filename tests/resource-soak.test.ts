import assert from "node:assert/strict";
import { getEventListeners } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  BoundedWorkerPool,
  ResourceLedger,
  TempWorkspaceRegistry,
  createResourceSoakContract,
  maintainResourceState,
  maintainSqlite,
  readResourceSoakState,
  recoverInterruptedResourceWork,
  runResourceSoakSlice,
  verifyResourceSoakEvidence,
} from "../lib/resource/index.ts";

function memoryDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

const unlimitedBudget = {
  tokenLimit: null,
  wallTimeMs: null,
  cpuTimeMs: null,
  memoryBytes: null,
  diskBytes: null,
  networkBytes: null,
  toolOutputBytes: null,
  concurrency: 4,
  retryLimit: 0,
};

export const resourceSoakTestPromise = (async () => {
  assert.throws(
    () => createResourceSoakContract({ mode: "real", targetWallMs: 23 * 60 * 60 * 1000 }),
    /at least 24 hours/,
    "a shortened test must never be labelled as the real soak",
  );

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-resource-soak-test-"));
  const database = memoryDb();
  try {
    const contract = createResourceSoakContract({
      mode: "accelerated",
      targetWallMs: 240,
      sliceMs: 80,
      checkpointMs: 20,
      concurrency: 2,
      maxQueue: 4,
      cacheBytes: 4096,
      tempHighWaterBytes: 2048,
      tempLowWaterBytes: 512,
      rssDriftRatio: 0.99,
    });
    let wall = Date.UTC(2026, 7, 12);
    let monotonic = 0;
    const clock = {
      now: () => (wall += 5),
      monotonicNow: () => (monotonic += 5),
    };

    const first = await runResourceSoakSlice({ db: database, workspaceRoot: root, contract, ...clock });
    assert.equal(first.status, "running");
    assert(first.accumulatedWallMs > 0 && first.accumulatedWallMs < contract.targetWallMs);
    const runId = first.runId;
    const second = await runResourceSoakSlice({ db: database, workspaceRoot: root, contract, runId, ...clock });
    assert.equal(second.status, "running");
    assert(second.accumulatedWallMs > first.accumulatedWallMs, "resume must accumulate, not restart, wall time");
    let state = second;
    while (state.status === "running") {
      state = await runResourceSoakSlice({ db: database, workspaceRoot: root, contract, runId, ...clock });
    }
    assert.equal(state.status, "completed", state.failures.join("; "));
    assert(state.accumulatedWallMs >= contract.targetWallMs);
    assert(state.resumeCount >= 2);
    assert(state.checkpointCount >= 3);
    assert(state.finalEvidenceHash);
    assert.equal(readResourceSoakState(database, runId).status, "completed");
    assert.deepEqual(verifyResourceSoakEvidence(database, runId), {
      ok: true,
      checkpointCount: state.checkpointCount,
      errors: [],
    });
    assert.equal(new TempWorkspaceRegistry(database, root).counts(runId).deleted, 1);
    await assert.rejects(
      runResourceSoakSlice({ db: database, workspaceRoot: root, contract: { ...contract, maxQueue: 5 }, runId, ...clock }),
      /contract changed/,
    );
    database.prepare(`UPDATE resource_soak_checkpoints SET metrics_json='{}'
      WHERE run_id=? AND sequence_no=0`).run(runId);
    assert.equal(verifyResourceSoakEvidence(database, runId).ok, false, "tampered evidence must fail verification");

    const ledger = new ResourceLedger(database);
    ledger.setBudget({ type: "global", key: "default" }, unlimitedBudget);
    ledger.setBudget({ type: "run", key: "crashed-run" }, unlimitedBudget);
    ledger.reserve({ runId: "crashed-run", capabilityId: "crash-test", expected: {} });
    database.prepare(`INSERT INTO worker_jobs
      (job_id,pool_name,run_id,priority,status,payload_hash,enqueued_at)
      VALUES ('crashed-job','test','crashed-run',0,'running','hash',?)`).run(new Date().toISOString());
    assert.deepEqual(recoverInterruptedResourceWork(database, "crashed-run"), { reservations: 1, workerJobs: 1 });
    assert.equal(ledger.activeCount("crashed-run"), 0);

    const registry = new TempWorkspaceRegistry(database, root);
    const healthyReservation = ledger.reserve({
      runId: "healthy-run",
      capabilityId: "startup-maintenance",
      expected: {},
    });
    database.prepare(`INSERT INTO worker_jobs
      (job_id,pool_name,run_id,priority,status,payload_hash,enqueued_at,started_at,heartbeat_at)
      VALUES ('healthy-job','test','healthy-run',0,'running','hash',?,?,?)`)
      .run("2026-08-12T00:59:59.000Z", "2026-08-12T00:59:59.000Z", "2026-08-12T00:59:59.000Z");
    const staleWorkspace = registry.create("stale-run", "2026-08-11T00:00:00.000Z");
    fs.writeFileSync(path.join(staleWorkspace.path, "stale.bin"), Buffer.alloc(32));
    const expiredWorkspace = registry.create("expired-run", "2026-08-10T00:00:00.000Z");
    fs.writeFileSync(path.join(expiredWorkspace.path, "expired.bin"), Buffer.alloc(64));
    registry.tombstone(expiredWorkspace.workspaceId, 1, new Date("2026-08-11T00:00:00.000Z"));

    const startupMaintenance = maintainResourceState(database, root, {
      staleWorkspaceMs: 60 * 60 * 1000,
      workspaceDeleteGraceMs: 60 * 60 * 1000,
      now: new Date("2026-08-12T01:00:00.000Z"),
    });
    assert.equal(startupMaintenance.sweptWorkspaces, 1);
    assert.equal(startupMaintenance.tombstonedWorkspaces, 1);
    assert.equal(fs.existsSync(expiredWorkspace.path), false);
    assert.equal(fs.existsSync(staleWorkspace.path), true, "new tombstones must survive the current maintenance pass");
    assert.equal(registry.counts("stale-run").tombstoned, 1);
    assert.equal(ledger.activeCount("healthy-run"), 1, "startup maintenance must not cancel live reservations");
    assert.equal((database.prepare("SELECT status FROM worker_jobs WHERE job_id='healthy-job'").get() as { status: string }).status, "running");
    ledger.release(healthyReservation, {});

    database.prepare(`INSERT INTO resource_temp_workspaces
      (workspace_id,owner_run_id,path,state,created_at,heartbeat_at,last_size_bytes)
      VALUES ('escaped','unsafe',?,'active',?,?,0)`).run(path.dirname(root), new Date().toISOString(), new Date().toISOString());
    assert.throws(() => registry.activeForRun("unsafe"), /escapes managed root/);

    const signal = new AbortController().signal;
    const listenerPool = new BoundedWorkerPool<number, number>({
      name: "listener-test",
      concurrency: 2,
      maxQueue: 16,
      handler: async (value) => value,
    });
    for (let batch = 0; batch < 20; batch += 1) {
      await Promise.all(Array.from({ length: 10 }, (_, value) => listenerPool.submit({
        runId: "listener-run", priority: 0, timeoutMs: 1000, signal, payload: value,
      })));
    }
    await listenerPool.close();
    assert.equal(getEventListeners(signal, "abort").length, 0, "completed jobs must detach external abort listeners");

    for (let index = 0; index < 25; index += 1) {
      database.prepare(`INSERT INTO resource_metric_snapshots
        (snapshot_id,metrics_json,captured_at) VALUES (?,?,?)`).run(`snapshot-${index}`, "{}", new Date(index).toISOString());
      const reservationId = ledger.reserve({
        runId: "maintenance-run",
        capabilityId: `maintenance-${index}`,
        expected: {},
      });
      ledger.release(reservationId, {});
    }
    const maintenance = maintainSqlite(database, 5, 5);
    assert(maintenance.trimmedSnapshots > 0);
    assert(maintenance.trimmedJobs > 0);
    assert(maintenance.trimmedReservations > 0);
    assert.equal((database.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check, "ok");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("resource-soak: resumable checkpoints, evidence chain, cleanup, recovery and listener bounds passed ✓");
})();
