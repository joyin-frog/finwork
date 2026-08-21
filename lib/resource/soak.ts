import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { IncrementalCache } from "./cache";
import { ResourceLedger } from "./ledger";
import { maintainSqlite, recoverInterruptedResourceWork } from "./maintenance";
import { captureResourceMetrics, directoryBytes, type ResourceMetrics } from "./metrics";
import { TempWorkspaceRegistry } from "./temp-workspaces";
import { BoundedWorkerPool } from "./worker-pool";

const REAL_TARGET_MS = 24 * 60 * 60 * 1000;
const DEFAULT_SLICE_MS = 15 * 60 * 1000;
const DEFAULT_CHECKPOINT_MS = 60 * 1000;
const LEASE_MS = 2 * 60 * 1000;

export type ResourceSoakContract = {
  version: 1;
  mode: "real" | "accelerated";
  targetWallMs: number;
  sliceMs: number;
  checkpointMs: number;
  concurrency: number;
  maxQueue: number;
  cacheBytes: number;
  tempHighWaterBytes: number;
  tempLowWaterBytes: number;
  rssDriftRatio: number;
};

export type ResourceSoakState = {
  runId: string;
  status: "running" | "completed" | "failed" | "cancelled";
  mode: ResourceSoakContract["mode"];
  targetWallMs: number;
  accumulatedWallMs: number;
  iterations: number;
  resumeCount: number;
  checkpointCount: number;
  baselineRssBytes: number;
  peakRssBytes: number;
  peakHeapBytes: number;
  peakTempBytes: number;
  peakQueueDepth: number;
  finalEvidenceHash?: string;
  failures: string[];
};

export type ResourceSoakEvidenceVerification = {
  ok: boolean;
  checkpointCount: number;
  errors: string[];
};

export type ResourceSoakRunnerOptions = {
  db: DatabaseSync;
  workspaceRoot: string;
  contract?: Partial<ResourceSoakContract>;
  runId?: string;
  /** Wall clock for durable timestamps and leases. Tests may override it. */
  now?: () => number;
  /** Monotonic elapsed-time source. Defaults to performance.now(). */
  monotonicNow?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
};

type RunRow = {
  run_id: string;
  contract_hash: string;
  mode: ResourceSoakContract["mode"];
  status: ResourceSoakState["status"];
  target_wall_ms: number;
  accumulated_wall_ms: number;
  baseline_rss_bytes: number;
  peak_rss_bytes: number;
  peak_heap_bytes: number;
  peak_temp_bytes: number;
  peak_queue_depth: number;
  iterations: number;
  resume_count: number;
  lease_owner_id: string | null;
  lease_expires_at: string | null;
  failure_json: string | null;
  final_evidence_hash: string | null;
};

export function createResourceSoakContract(
  input: Partial<ResourceSoakContract> = {},
): ResourceSoakContract {
  const mode = input.mode ?? "real";
  const targetWallMs = input.targetWallMs ?? REAL_TARGET_MS;
  if (mode === "real" && targetWallMs < REAL_TARGET_MS) {
    throw new Error("real resource soak must accumulate at least 24 hours of monotonic wall time");
  }
  const contract: ResourceSoakContract = {
    version: 1,
    mode,
    targetWallMs,
    sliceMs: input.sliceMs ?? DEFAULT_SLICE_MS,
    checkpointMs: input.checkpointMs ?? DEFAULT_CHECKPOINT_MS,
    concurrency: input.concurrency ?? 4,
    maxQueue: input.maxQueue ?? 32,
    cacheBytes: input.cacheBytes ?? 4 * 1024 * 1024,
    tempHighWaterBytes: input.tempHighWaterBytes ?? 8 * 1024 * 1024,
    tempLowWaterBytes: input.tempLowWaterBytes ?? 2 * 1024 * 1024,
    rssDriftRatio: input.rssDriftRatio ?? 0.15,
  };
  for (const [key, value] of Object.entries(contract)) {
    if (key === "mode" || key === "version" || key === "rssDriftRatio") continue;
    if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${key} must be a positive integer`);
  }
  if (contract.tempLowWaterBytes >= contract.tempHighWaterBytes) {
    throw new Error("tempLowWaterBytes must be below tempHighWaterBytes");
  }
  if (!(contract.rssDriftRatio > 0 && contract.rssDriftRatio < 1)) {
    throw new Error("rssDriftRatio must be between 0 and 1");
  }
  return contract;
}

export async function runResourceSoakSlice(options: ResourceSoakRunnerOptions): Promise<ResourceSoakState> {
  const contract = createResourceSoakContract(options.contract);
  const db = options.db;
  const wallNow = options.now ?? Date.now;
  const monotonicNow = options.monotonicNow ?? (options.now ? options.now : () => performance.now());
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const ownerId = randomUUID();
  const contractHash = digest(contract);
  const run = acquireRun(db, options.runId, contract, contractHash, ownerId, wallNow());
  if (run.status !== "running") return readResourceSoakState(db, run.run_id);
  recoverInterruptedResourceWork(db, run.run_id, new Date(wallNow()).toISOString());

  const ledger = new ResourceLedger(db);
  ensureSoakBudgets(ledger, run.run_id, contract);
  const cache = new IncrementalCache(db, contract.cacheBytes);
  const workspaces = new TempWorkspaceRegistry(db, options.workspaceRoot);
  const workspace = workspaces.activeForRun(run.run_id) ?? workspaces.create(run.run_id);
  let accumulated = run.accumulated_wall_ms;
  let iterations = run.iterations;
  let peakRss = run.peak_rss_bytes;
  let peakHeap = run.peak_heap_bytes;
  let peakTemp = run.peak_temp_bytes;
  let peakQueue = run.peak_queue_depth;
  let lastCheckpoint = monotonicNow();
  let lastTick = lastCheckpoint;
  const sliceDeadline = lastCheckpoint + Math.min(contract.sliceMs, contract.targetWallMs - accumulated);
  let failure: Error | null = null;

  const pool = new BoundedWorkerPool<{ iteration: number }, { bytes: number }>({
    name: "resource-soak",
    concurrency: contract.concurrency,
    maxQueue: contract.maxQueue,
    db,
    handler: async ({ iteration }, signal) => {
      if (signal.aborted) throw signal.reason;
      const reservationId = ledger.reserve({
        runId: run.run_id,
        capabilityId: "resource-soak-workload",
        expected: {},
      });
      const filePath = path.join(workspace.path, `sample-${iteration % 64}.json`);
      const payload = canonicalJson({ iteration, values: Array.from({ length: 32 }, (_, i) => i + iteration) });
      fs.writeFileSync(filePath, payload);
      cache.set({
        namespace: "resource-soak",
        inputHash: digest({ bucket: iteration % 128 }),
        toolVersion: "1",
        policyRevision: "1",
        authorizationHash: "resource-soak-local",
      }, { iteration, digest: digest(payload) });
      ledger.release(reservationId, {});
      return { bytes: Buffer.byteLength(payload) };
    },
  });

  try {
    while (accumulated < contract.targetWallMs && monotonicNow() < sliceDeadline) {
      if (options.signal?.aborted) throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
      const batch = Array.from({ length: contract.concurrency }, (_, offset) =>
        pool.submit({ runId: run.run_id, priority: offset % 2, timeoutMs: 10_000, payload: { iteration: iterations + offset } }),
      );
      peakQueue = Math.max(peakQueue, pool.snapshot.queued + pool.snapshot.active);
      await Promise.all(batch);
      iterations += batch.length;
      const tick = monotonicNow();
      accumulated += Math.max(0, tick - lastTick);
      lastTick = tick;
      const checkpointWallMs = wallNow();
      const tempBytes = workspaces.heartbeat(workspace.workspaceId, new Date(checkpointWallMs).toISOString());
      peakTemp = Math.max(peakTemp, tempBytes);
      if (tempBytes > contract.tempHighWaterBytes) {
        pruneWorkspaceToLowWater(workspace.path, contract.tempLowWaterBytes);
      }
      if (tick - lastCheckpoint >= contract.checkpointMs || accumulated >= contract.targetWallMs) {
        const metrics = captureResourceMetrics(db, {
          runId: run.run_id,
          queueDepth: pool.snapshot.queued,
          cacheBytes: cache.stats().bytes,
          diskBytes: directoryBytes(workspace.path),
        });
        peakRss = Math.max(peakRss, metrics.rssBytes);
        peakHeap = Math.max(peakHeap, metrics.heapUsedBytes);
        saveCheckpoint(db, run, ownerId, contract, {
          accumulated,
          iterations,
          peakRss,
          peakHeap,
          peakTemp,
          peakQueue,
          metrics,
          workspaces,
          cache,
          nowMs: checkpointWallMs,
        });
        maintainSqlite(db);
        lastCheckpoint = tick;
      }
      if (contract.mode === "real") await sleep(Math.min(25, Math.max(1, sliceDeadline - monotonicNow())));
    }
  } catch (error) {
    failure = error instanceof Error ? error : new Error(String(error));
  } finally {
    await pool.close();
  }

  const endedAt = monotonicNow();
  const endedWallAt = wallNow();
  accumulated += Math.max(0, endedAt - lastTick);
  const reachedTarget = accumulated >= contract.targetWallMs;
  if (reachedTarget) {
    pruneWorkspaceToLowWater(workspace.path, contract.tempLowWaterBytes);
    workspaces.heartbeat(workspace.workspaceId, new Date(endedWallAt).toISOString());
    workspaces.tombstone(workspace.workspaceId, 0, new Date(endedWallAt));
    workspaces.sweep(new Date(endedWallAt));
  }
  const metrics = captureResourceMetrics(db, {
    runId: run.run_id,
    queueDepth: pool.snapshot.queued,
    cacheBytes: cache.stats().bytes,
    diskBytes: directoryBytes(workspace.path),
  });
  peakRss = Math.max(peakRss, metrics.rssBytes);
  peakHeap = Math.max(peakHeap, metrics.heapUsedBytes);
  peakTemp = Math.max(peakTemp, metrics.diskBytes);
  const failures = validateInvariants(db, run, contract, metrics, workspaces);
  if (failure) failures.push(failure.message);
  const completed = reachedTarget && failures.length === 0;
  const status: ResourceSoakState["status"] = failure
    ? failure.name === "AbortError" ? "cancelled" : "failed"
    : completed ? "completed" : reachedTarget ? "failed" : "running";
  saveCheckpoint(db, run, ownerId, contract, {
    accumulated,
    iterations,
    peakRss,
    peakHeap,
    peakTemp,
    peakQueue,
    metrics,
    workspaces,
    cache,
    nowMs: endedWallAt,
    status,
    failures,
    releaseLease: true,
  });
  if (status === "completed") {
    db.prepare("UPDATE resource_soak_runs SET final_evidence_hash=? WHERE run_id=?")
      .run(computeFinalEvidenceHash(db, run.run_id), run.run_id);
  } else if (status !== "running" && !reachedTarget) {
    workspaces.tombstone(workspace.workspaceId, 0, new Date(endedWallAt));
    workspaces.sweep(new Date(endedWallAt));
  }
  return readResourceSoakState(db, run.run_id);
}

export function readResourceSoakState(db: DatabaseSync, runId: string): ResourceSoakState {
  const row = db.prepare("SELECT * FROM resource_soak_runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (!row) throw new Error(`unknown resource soak run ${runId}`);
  const checkpointCount = Number((db.prepare("SELECT COUNT(*) AS n FROM resource_soak_checkpoints WHERE run_id=?").get(runId) as { n: number }).n);
  return {
    runId: row.run_id,
    status: row.status,
    mode: row.mode,
    targetWallMs: row.target_wall_ms,
    accumulatedWallMs: row.accumulated_wall_ms,
    iterations: row.iterations,
    resumeCount: row.resume_count,
    checkpointCount,
    baselineRssBytes: row.baseline_rss_bytes,
    peakRssBytes: row.peak_rss_bytes,
    peakHeapBytes: row.peak_heap_bytes,
    peakTempBytes: row.peak_temp_bytes,
    peakQueueDepth: row.peak_queue_depth,
    ...(row.final_evidence_hash ? { finalEvidenceHash: row.final_evidence_hash } : {}),
    failures: row.failure_json ? JSON.parse(row.failure_json) as string[] : [],
  };
}

export function verifyResourceSoakEvidence(db: DatabaseSync, runId: string): ResourceSoakEvidenceVerification {
  const run = db.prepare("SELECT * FROM resource_soak_runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (!run) return { ok: false, checkpointCount: 0, errors: [`unknown resource soak run ${runId}`] };
  const rows = db.prepare(`SELECT sequence_no,elapsed_wall_ms,metrics_json,invariants_json,
    prior_checkpoint_hash,checkpoint_hash,captured_at FROM resource_soak_checkpoints
    WHERE run_id=? ORDER BY sequence_no ASC`).all(runId) as Array<{
      sequence_no: number;
      elapsed_wall_ms: number;
      metrics_json: string;
      invariants_json: string;
      prior_checkpoint_hash: string | null;
      checkpoint_hash: string;
      captured_at: string;
    }>;
  const errors: string[] = [];
  let previous: string | null = null;
  let elapsed = -1;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (row.sequence_no !== index) errors.push(`checkpoint sequence gap at ${row.sequence_no}`);
    if (row.prior_checkpoint_hash !== previous) errors.push(`checkpoint ${row.sequence_no} prior hash mismatch`);
    if (row.elapsed_wall_ms < elapsed) errors.push(`checkpoint ${row.sequence_no} elapsed time regressed`);
    const expected = digest({
      runId,
      sequence: row.sequence_no,
      elapsedWallMs: row.elapsed_wall_ms,
      metrics: JSON.parse(row.metrics_json),
      invariants: JSON.parse(row.invariants_json),
      previous: row.prior_checkpoint_hash,
      capturedAt: row.captured_at,
    });
    if (expected !== row.checkpoint_hash) errors.push(`checkpoint ${row.sequence_no} hash mismatch`);
    previous = row.checkpoint_hash;
    elapsed = row.elapsed_wall_ms;
  }
  if (run.status === "completed") {
    if (run.accumulated_wall_ms < run.target_wall_ms) errors.push("completed run did not reach target wall time");
    if (!run.final_evidence_hash) errors.push("completed run has no final evidence hash");
    else if (run.final_evidence_hash !== computeFinalEvidenceHash(db, runId)) errors.push("final evidence hash mismatch");
    if (rows.length === 0) errors.push("completed run has no checkpoints");
  }
  return { ok: errors.length === 0, checkpointCount: rows.length, errors };
}

function acquireRun(
  db: DatabaseSync,
  requestedRunId: string | undefined,
  contract: ResourceSoakContract,
  contractHash: string,
  ownerId: string,
  nowMs: number,
): RunRow {
  const runId = requestedRunId ?? randomUUID();
  const now = new Date(nowMs).toISOString();
  const existing = db.prepare("SELECT * FROM resource_soak_runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (existing) {
    if (existing.contract_hash !== contractHash) throw new Error("resource soak contract changed; start a new run instead of mutating evidence");
    if (existing.status !== "running") return existing;
    if (existing.lease_owner_id && existing.lease_owner_id !== ownerId && existing.lease_expires_at && existing.lease_expires_at > now) {
      throw new Error(`resource soak run ${runId} is already owned by another live process`);
    }
    db.prepare(`UPDATE resource_soak_runs SET lease_owner_id=?,lease_expires_at=?,
      last_resumed_at=?,last_checkpoint_at=?,resume_count=resume_count+1 WHERE run_id=?`)
      .run(ownerId, new Date(nowMs + LEASE_MS).toISOString(), now, now, runId);
    return db.prepare("SELECT * FROM resource_soak_runs WHERE run_id=?").get(runId) as RunRow;
  }
  const memory = process.memoryUsage();
  db.prepare(`INSERT INTO resource_soak_runs
    (run_id,contract_hash,mode,status,target_wall_ms,accumulated_wall_ms,baseline_rss_bytes,
     peak_rss_bytes,peak_heap_bytes,started_at,last_resumed_at,last_checkpoint_at,lease_owner_id,lease_expires_at)
    VALUES (?,?,?,'running',?,0,?,?,?,?,?,?,?,?)`)
    .run(runId, contractHash, contract.mode, contract.targetWallMs, memory.rss, memory.rss, memory.heapUsed,
      now, now, now, ownerId, new Date(nowMs + LEASE_MS).toISOString());
  return db.prepare("SELECT * FROM resource_soak_runs WHERE run_id=?").get(runId) as RunRow;
}

function ensureSoakBudgets(ledger: ResourceLedger, runId: string, contract: ResourceSoakContract): void {
  const budget = {
    tokenLimit: null,
    wallTimeMs: null,
    cpuTimeMs: null,
    memoryBytes: null,
    diskBytes: null,
    networkBytes: null,
    toolOutputBytes: null,
    concurrency: contract.concurrency,
    retryLimit: 0,
  };
  ledger.setBudget({ type: "global", key: "default" }, budget);
  ledger.setBudget({ type: "run", key: runId }, budget);
}

function saveCheckpoint(
  db: DatabaseSync,
  run: RunRow,
  ownerId: string,
  contract: ResourceSoakContract,
  input: {
    accumulated: number;
    iterations: number;
    peakRss: number;
    peakHeap: number;
    peakTemp: number;
    peakQueue: number;
    metrics: ResourceMetrics;
    workspaces: TempWorkspaceRegistry;
    cache: IncrementalCache;
    nowMs: number;
    status?: ResourceSoakState["status"];
    failures?: string[];
    releaseLease?: boolean;
  },
): void {
  const now = new Date(input.nowMs).toISOString();
  const previous = db.prepare(`SELECT sequence_no,checkpoint_hash FROM resource_soak_checkpoints
    WHERE run_id=? ORDER BY sequence_no DESC LIMIT 1`).get(run.run_id) as { sequence_no: number; checkpoint_hash: string } | undefined;
  const sequence = (previous?.sequence_no ?? -1) + 1;
  const invariants = {
    activeReservations: new ResourceLedger(db).activeCount(run.run_id),
    activeWorkers: Number((db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE run_id=? AND status IN ('queued','running')").get(run.run_id) as { n: number }).n),
    cacheBytes: input.cache.stats().bytes,
    tempWorkspaces: input.workspaces.counts(run.run_id),
    mode: contract.mode,
  };
  const payload = {
    runId: run.run_id,
    sequence,
    elapsedWallMs: Math.min(input.accumulated, contract.targetWallMs),
    metrics: input.metrics,
    invariants,
    previous: previous?.checkpoint_hash ?? null,
    capturedAt: now,
  };
  const checkpointHash = digest(payload);
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO resource_soak_checkpoints
      (checkpoint_id,run_id,sequence_no,elapsed_wall_ms,metrics_json,invariants_json,
       prior_checkpoint_hash,checkpoint_hash,captured_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(randomUUID(), run.run_id, sequence, payload.elapsedWallMs, canonicalJson(input.metrics),
        canonicalJson(invariants), previous?.checkpoint_hash ?? null, checkpointHash, now);
    db.prepare(`UPDATE resource_soak_runs SET status=?,accumulated_wall_ms=?,peak_rss_bytes=?,
      peak_heap_bytes=?,peak_temp_bytes=?,peak_queue_depth=?,iterations=?,last_checkpoint_at=?,
      lease_owner_id=?,lease_expires_at=?,completed_at=?,failure_json=?,final_evidence_hash=? WHERE run_id=?`)
      .run(input.status ?? "running", payload.elapsedWallMs, input.peakRss, input.peakHeap,
        input.peakTemp, input.peakQueue, input.iterations, now,
        input.releaseLease || (input.status && input.status !== "running") ? null : ownerId,
        input.releaseLease || (input.status && input.status !== "running") ? null : new Date(input.nowMs + LEASE_MS).toISOString(),
        input.status && input.status !== "running" ? now : null,
        input.failures?.length ? canonicalJson(input.failures) : null,
        null, run.run_id);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function validateInvariants(
  db: DatabaseSync,
  run: RunRow,
  contract: ResourceSoakContract,
  metrics: ResourceMetrics,
  workspaces: TempWorkspaceRegistry,
): string[] {
  const failures: string[] = [];
  const activeReservations = new ResourceLedger(db).activeCount(run.run_id);
  const activeJobs = Number((db.prepare("SELECT COUNT(*) AS n FROM worker_jobs WHERE run_id=? AND status IN ('queued','running')").get(run.run_id) as { n: number }).n);
  if (activeReservations !== 0) failures.push(`active reservations remain: ${activeReservations}`);
  if (activeJobs !== 0) failures.push(`active worker jobs remain: ${activeJobs}`);
  if (metrics.cacheBytes > contract.cacheBytes) failures.push(`cache exceeds budget: ${metrics.cacheBytes}`);
  if (metrics.diskBytes > contract.tempHighWaterBytes) failures.push(`temporary workspace exceeds high water: ${metrics.diskBytes}`);
  const drift = Math.max(0, metrics.rssBytes - run.baseline_rss_bytes) / run.baseline_rss_bytes;
  if (drift > contract.rssDriftRatio) failures.push(`rss drift ${drift.toFixed(4)} exceeds ${contract.rssDriftRatio}`);
  const workspaceCounts = workspaces.counts(run.run_id);
  if ((workspaceCounts.failed ?? 0) > 0) failures.push("temporary workspace cleanup failure recorded");
  if (metrics.diskBytes > 0 && metrics.diskBytes > contract.tempLowWaterBytes) failures.push(`temporary workspace did not return to low water: ${metrics.diskBytes}`);
  return failures;
}

function pruneWorkspaceToLowWater(root: string, lowWaterBytes: number): void {
  const files = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => ({ path: path.join(root, entry.name), mtimeMs: fs.statSync(path.join(root, entry.name)).mtimeMs }))
    .sort((a, b) => a.mtimeMs - b.mtimeMs);
  let bytes = directoryBytes(root);
  for (const file of files) {
    if (bytes <= lowWaterBytes) break;
    const size = fs.statSync(file.path).size;
    fs.rmSync(file.path, { force: true });
    bytes -= size;
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(typeof value === "string" ? value : canonicalJson(value)).digest("hex");
}

function computeFinalEvidenceHash(db: DatabaseSync, runId: string): string {
  const row = db.prepare("SELECT * FROM resource_soak_runs WHERE run_id=?").get(runId) as RunRow | undefined;
  if (!row) throw new Error(`unknown resource soak run ${runId}`);
  const head = db.prepare(`SELECT checkpoint_hash FROM resource_soak_checkpoints
    WHERE run_id=? ORDER BY sequence_no DESC LIMIT 1`).get(runId) as { checkpoint_hash: string } | undefined;
  return digest({
    runId: row.run_id,
    contractHash: row.contract_hash,
    status: row.status,
    targetWallMs: row.target_wall_ms,
    accumulatedWallMs: row.accumulated_wall_ms,
    iterations: row.iterations,
    peakRssBytes: row.peak_rss_bytes,
    peakHeapBytes: row.peak_heap_bytes,
    peakTempBytes: row.peak_temp_bytes,
    peakQueueDepth: row.peak_queue_depth,
    failures: row.failure_json ? JSON.parse(row.failure_json) : [],
    checkpointHead: head?.checkpoint_hash ?? null,
  });
}
