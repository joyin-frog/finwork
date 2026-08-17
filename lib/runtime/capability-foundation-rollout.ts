import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";

export type RolloutMode = "shadow" | "cutover" | "rollback";
export type RolloutAuthority = "legacy" | "new";

export type RolloutEpoch = {
  epoch: number;
  mode: RolloutMode;
  authority: RolloutAuthority;
  state: "active" | "retired";
  reason: string;
  createdAt: string;
};

export type ShadowComparison = {
  id: string;
  caseId?: string;
  runId?: string;
  legacyHash: string;
  newHash: string;
  equivalent: boolean;
  outcome: "matched" | "mismatched" | "inconclusive";
  details: Record<string, unknown>;
  createdAt: string;
};

function rowToEpoch(row: {
  epoch: number; mode: RolloutMode; authority: RolloutAuthority; state: "active" | "retired";
  reason: string; created_at: string;
}): RolloutEpoch {
  return { epoch: row.epoch, mode: row.mode, authority: row.authority, state: row.state, reason: row.reason, createdAt: row.created_at };
}

/**
 * Owns the single-writer cutover. The partial unique index is the final database
 * guard; BEGIN IMMEDIATE makes retirement and activation one atomic decision.
 */
export class CapabilityFoundationRollout {
  constructor(readonly db: DatabaseSync, readonly now = () => new Date()) {}

  active(): RolloutEpoch | null {
    const row = this.db.prepare(`
      SELECT epoch,mode,authority,state,reason,created_at
      FROM capability_rollout_epochs WHERE state='active' LIMIT 1
    `).get() as Parameters<typeof rowToEpoch>[0] | undefined;
    return row ? rowToEpoch(row) : null;
  }

  ensureInitialized(reason = "Capability Foundation is the sole production authority"): RolloutEpoch {
    const active = this.active();
    if (active?.mode === "cutover" && active.authority === "new") return active;
    return this.activate("cutover", "new", reason);
  }

  beginShadow(reason: string): never {
    throw new Error(`shadow authority is retired; Capability Foundation is production-only (${reason.trim() || "no reason"})`);
  }
  cutover(reason: string): RolloutEpoch {
    const active = this.ensureInitialized(reason);
    return active;
  }
  rollback(reason: string): never {
    throw new Error(`legacy rollback authority is retired; use capability-level recovery instead (${reason.trim() || "no reason"})`);
  }

  recordComparison(input: {
    caseId?: string;
    runId?: string;
    legacy: unknown;
    next: unknown;
    conclusive?: boolean;
    details?: Record<string, unknown>;
  }): ShadowComparison {
    const legacyHash = sha256Json(input.legacy);
    const newHash = sha256Json(input.next);
    const conclusive = input.conclusive ?? true;
    const equivalent = conclusive && legacyHash === newHash;
    const outcome = conclusive ? (equivalent ? "matched" : "mismatched") : "inconclusive";
    const comparison: ShadowComparison = {
      id: randomUUID(),
      ...(input.caseId ? { caseId: input.caseId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      legacyHash,
      newHash,
      equivalent,
      outcome,
      details: input.details ?? {},
      createdAt: this.now().toISOString(),
    };
    this.db.prepare(`
      INSERT INTO capability_shadow_comparisons
        (comparison_id,case_id,run_id,legacy_hash,new_hash,equivalent,outcome,details_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)
    `).run(
      comparison.id,
      comparison.caseId ?? null,
      comparison.runId ?? null,
      comparison.legacyHash,
      comparison.newHash,
      comparison.equivalent ? 1 : 0,
      comparison.outcome,
      canonicalJson(comparison.details),
      comparison.createdAt,
    );
    return comparison;
  }

  assertNewAuthority(): void {
    const active = this.active();
    if (!active || active.authority !== "new" || active.mode !== "cutover") {
      throw new Error("capability foundation is not the active write authority");
    }
  }

  private activate(mode: RolloutMode, authority: RolloutAuthority, reason: string): RolloutEpoch {
    if (!reason.trim()) throw new Error("rollout reason is required");
    const createdAt = this.now().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE capability_rollout_epochs SET state='retired' WHERE state='active'").run();
      const result = this.db.prepare(`
        INSERT INTO capability_rollout_epochs(mode,authority,state,reason,created_at)
        VALUES (?,?,'active',?,?)
      `).run(mode, authority, reason.trim(), createdAt);
      const row = this.db.prepare(`
        SELECT epoch,mode,authority,state,reason,created_at
        FROM capability_rollout_epochs WHERE epoch=?
      `).get(Number(result.lastInsertRowid)) as Parameters<typeof rowToEpoch>[0];
      this.db.exec("COMMIT");
      return rowToEpoch(row);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
