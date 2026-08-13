import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import { ArtifactLifecycleService } from "../lib/file-lifecycle/index.ts";

const old = "2026-01-01T00:00:00.000Z";
const now = "2026-08-09T08:00:00.000Z";
const policy = { now, minimumAgeMs: 1, gracePeriodMs: 0, lowWatermarkBytes: null, actorId: "test:gc" };

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

export const fileLifecycleTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-gc-"));
  try {
    const db = makeDb();
    const artifacts = new ArtifactStore(db, root);
    const lifecycle = new ArtifactLifecycleService(db, root);
    const put = (id: string, kind = "preview", content = id) => {
      const ref = artifacts.put({ artifactId: id, kind, logicalName: `${id}.bin`, classification: "internal", retention: {},
        mediaType: "application/octet-stream", producer: { capabilityId: "test", version: "1" }, metadata: { reclaimable: kind === "preview" },
        content: new TextEncoder().encode(content), state: "candidate" });
      db.prepare("UPDATE artifact_versions SET created_at=? WHERE version_id=?").run(old, ref.versionId);
      db.prepare("UPDATE artifacts SET created_at=?,updated_at=? WHERE artifact_id=?").run(old, old, ref.artifactId);
      return ref;
    };

    const delivered = put("delivered", "document");
    artifacts.transition(delivered.artifactId, "delivered");
    const evidenceRoot = put("evidence-root");
    artifacts.addRef(evidenceRoot.versionId, "evidence", "evidence-1");
    const edgeChild = put("edge-child");
    artifacts.addEdge(evidenceRoot.versionId, edgeChild.versionId, "derived_from");
    const held = put("held");
    lifecycle.hold(held.versionId, { type: "legal_hold", ownerId: "legal", reason: "audit", now });
    const free = put("free");
    const sameA = put("same-a", "preview", "same-bytes");
    const sameB = put("same-b", "document", "same-bytes");
    artifacts.transition(sameB.artifactId, "delivered");

    const plan = lifecycle.plan(policy);
    const ids = new Set(plan.candidates.map((item) => item.artifactVersionId));
    assert(ids.has(free.versionId));
    assert(ids.has(sameA.versionId));
    assert(!ids.has(delivered.versionId));
    assert(!ids.has(evidenceRoot.versionId));
    assert(!ids.has(edgeChild.versionId), "edge trace must retain provenance reachable from a root");
    assert(!ids.has(held.versionId));
    assert(lifecycle.quotaSnapshot(plan).logicalBytes > lifecycle.quotaSnapshot(plan).physicalBytes, "CAS must deduplicate physical bytes");
    lifecycle.tombstone(plan, policy);
    assert.equal((db.prepare("SELECT state FROM artifact_versions WHERE version_id=?").get(free.versionId) as { state: string }).state, "tombstoned");
    lifecycle.restore(free.versionId, "user", now);
    assert.equal((db.prepare("SELECT state FROM artifact_versions WHERE version_id=?").get(free.versionId) as { state: string }).state, "archived");

    const second = lifecycle.plan(policy);
    lifecycle.tombstone(second, policy);
    let failOnce = true;
    const firstSweep = lifecycle.sweep(now, "test", () => { if (failOnce) { failOnce = false; throw new Error("injected unlink failure"); } });
    assert.equal(firstSweep.failed, 1, "post-commit filesystem failure must be journaled for retry");
    const retry = lifecycle.sweep(now);
    assert.equal(retry.failed, 0);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM artifact_versions WHERE version_id=?").get(sameA.versionId)?.n ?? 0, 0);
    assert.equal(new TextDecoder().decode(artifacts.read(sameB.versionId)), "same-bytes", "shared CAS blob must survive while another version references its hash");
    const stable = lifecycle.sweep(now);
    assert.deepEqual(stable, { deleted: 0, failed: 0, bytes: 0 }, "GC retries must be idempotent");

    // Deterministic randomized reference graph: no node reachable from any explicit root may be planned.
    const graphDb = makeDb();
    const graphRoot = path.join(root, "graph");
    const graphStore = new ArtifactStore(graphDb, graphRoot);
    const graphLifecycle = new ArtifactLifecycleService(graphDb, graphRoot);
    const refs = Array.from({ length: 32 }, (_, i) => {
      const ref = graphStore.put({ artifactId: `g-${i}`, kind: "preview", logicalName: `g-${i}`, classification: "internal",
        retention: {}, mediaType: "application/octet-stream", producer: {}, metadata: { reclaimable: true },
        content: new TextEncoder().encode(`graph-${i}`), state: "candidate" });
      graphDb.prepare("UPDATE artifact_versions SET created_at=? WHERE version_id=?").run(old, ref.versionId);
      return ref;
    });
    const adjacency = new Map<number, Set<number>>();
    const connect = (a: number, b: number) => { (adjacency.get(a) ?? adjacency.set(a, new Set()).get(a)!).add(b); (adjacency.get(b) ?? adjacency.set(b, new Set()).get(b)!).add(a); };
    let seed = 17;
    const random = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000;
    for (let i = 0; i < 48; i++) { const a = Math.floor(random() * refs.length); const b = Math.floor(random() * refs.length); if (a !== b && !(adjacency.get(a)?.has(b))) { graphStore.addEdge(refs[a].versionId, refs[b].versionId, "derived_from"); connect(a, b); } }
    const rootIndexes = [0, 7, 19];
    rootIndexes.forEach((i) => graphStore.addRef(refs[i].versionId, "knowledge", `root-${i}`));
    const reachable = new Set<number>(); const queue = [...rootIndexes];
    while (queue.length) { const i = queue.pop()!; if (reachable.has(i)) continue; reachable.add(i); for (const next of adjacency.get(i) ?? []) queue.push(next); }
    const graphPlan = graphLifecycle.plan(policy);
    const graphCandidates = new Set(graphPlan.candidates.map((item) => item.artifactVersionId));
    for (const index of reachable) assert(!graphCandidates.has(refs[index].versionId), `reachable version g-${index} must not be collected`);
    assert.equal(graphDb.prepare("PRAGMA integrity_check").get()?.integrity_check, "ok");
    graphDb.close();
    db.close();
    console.log("file-lifecycle: mark/trace, holds, recovery, CAS dedupe, retry and graph safety passed ✓");
  } finally { rmSync(root, { recursive: true, force: true }); }
})();
