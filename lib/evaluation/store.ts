import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { GoldenManifestSchema, type EvaluationResult, type GoldenManifest } from "./contracts";

export class EvaluationStore {
  constructor(readonly db: DatabaseSync) {}
  saveManifest(raw: GoldenManifest): GoldenManifest {
    const manifest = GoldenManifestSchema.parse(raw); const now = new Date().toISOString();
    this.db.prepare(`INSERT INTO evaluation_manifests(manifest_id,version,case_kind,manifest_json,manifest_hash,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?) ON CONFLICT(manifest_id,version) DO UPDATE SET case_kind=excluded.case_kind,manifest_json=excluded.manifest_json,manifest_hash=excluded.manifest_hash,updated_at=excluded.updated_at`)
      .run(manifest.id, manifest.version, manifest.caseKind, canonicalJson(manifest), sha256Json(manifest), now, now);
    return manifest;
  }
  start(manifest: GoldenManifest, startedAt: string): string {
    const id = randomUUID(); this.db.prepare(`INSERT INTO evaluation_runs(eval_run_id,manifest_id,manifest_version,status,started_at) VALUES(?,?,?,'running',?)`).run(id, manifest.id, manifest.version, startedAt); return id;
  }
  finish(result: EvaluationResult): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare(`UPDATE evaluation_runs SET status=?,fault_domain=?,result_json=?,ended_at=? WHERE eval_run_id=?`).run(result.status, result.faultDomain ?? null, canonicalJson(result), result.endedAt, result.runId);
      const put = this.db.prepare(`INSERT INTO evaluation_scorecards(scorecard_id,eval_run_id,dimension,score,passed,details_json,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(eval_run_id,dimension) DO UPDATE SET score=excluded.score,passed=excluded.passed,details_json=excluded.details_json`);
      for (const card of result.scorecards) put.run(randomUUID(), result.runId, card.dimension, card.score, card.passed ? 1 : 0, canonicalJson(card.details), result.endedAt);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
