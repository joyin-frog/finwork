import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import type { CapabilityDefinition, CapabilityFailure } from "@/lib/capability/contracts";
import type { CapabilityExecuteRequest, ExecutionResourceGovernor, ExecutionResourceLease } from "@/lib/capability/executor";
import { ResourceBudgetSchema, ResourceLimitError, ResourceUsageSchema, type ResourceBudget, type ResourceScope, type ResourceUsage } from "./contracts";

const ZERO: ResourceUsage = ResourceUsageSchema.parse({});
const fields: Array<[keyof ResourceUsage, keyof ResourceBudget]> = [
  ["tokens", "tokenLimit"], ["wallTimeMs", "wallTimeMs"], ["cpuTimeMs", "cpuTimeMs"],
  ["memoryBytes", "memoryBytes"], ["diskBytes", "diskBytes"], ["networkBytes", "networkBytes"],
  ["toolOutputBytes", "toolOutputBytes"], ["retries", "retryLimit"],
];

export type ReservationRequest = {
  runId: string; caseId?: string; capabilityId: string; expected: Partial<ResourceUsage>;
};

export class ResourceLedger {
  constructor(readonly db: DatabaseSync) {}

  setBudget(scope: ResourceScope, budget: ResourceBudget, now = new Date().toISOString()): void {
    const parsed = ResourceBudgetSchema.parse(budget);
    this.db.prepare(`INSERT INTO resource_budget_scopes
      (scope_id,scope_type,scope_key,budget_json,usage_json,active_count,revision,updated_at)
      VALUES (?,?,?,?,?,0,1,?) ON CONFLICT(scope_type,scope_key) DO UPDATE SET
      budget_json=excluded.budget_json,revision=resource_budget_scopes.revision+1,updated_at=excluded.updated_at`)
      .run(randomUUID(), scope.type, scope.key, canonicalJson(parsed), canonicalJson(ZERO), now);
  }

  reserve(request: ReservationRequest, now = new Date().toISOString()): string {
    const scopes: ResourceScope[] = [{ type: "global", key: "default" }];
    if (request.caseId) scopes.push({ type: "case", key: request.caseId });
    scopes.push({ type: "run", key: request.runId });
    const estimate = ResourceUsageSchema.parse({ ...ZERO, ...request.expected });
    const reservationId = randomUUID();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const scope of scopes) {
        const row = this.db.prepare(`SELECT scope_id,budget_json,usage_json,active_count FROM resource_budget_scopes
          WHERE scope_type=? AND scope_key=?`).get(scope.type, scope.key) as { scope_id: string; budget_json: string; usage_json: string; active_count: number } | undefined;
        if (!row) continue; // An absent narrower scope inherits the next declared scope.
        const budget = ResourceBudgetSchema.parse(JSON.parse(row.budget_json));
        const usage = ResourceUsageSchema.parse(JSON.parse(row.usage_json));
        if (row.active_count >= budget.concurrency) throw new ResourceLimitError("concurrency_exhausted", `${scope.type} concurrency exhausted`, { scope });
        for (const [usageKey, limitKey] of fields) {
          const limit = budget[limitKey];
          if (limit != null && usage[usageKey] + estimate[usageKey] > limit) {
            throw new ResourceLimitError("budget_exhausted", `${String(limitKey)} exhausted`, { scope, used: usage[usageKey], requested: estimate[usageKey], limit });
          }
        }
      }
      this.db.prepare(`INSERT INTO resource_reservations
        (reservation_id,run_id,case_id,capability_id,request_json,usage_json,status,created_at)
        VALUES (?,?,?,?,?,?, 'active',?)`).run(reservationId, request.runId, request.caseId ?? null, request.capabilityId, canonicalJson(estimate), canonicalJson(ZERO), now);
      for (const scope of scopes) this.db.prepare(`UPDATE resource_budget_scopes SET active_count=active_count+1,updated_at=? WHERE scope_type=? AND scope_key=?`).run(now, scope.type, scope.key);
      this.db.exec("COMMIT");
      return reservationId;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  release(reservationId: string, usageInput: Partial<ResourceUsage>, status: "released" | "exhausted" | "cancelled" = "released", now = new Date().toISOString()): void {
    const usage = ResourceUsageSchema.parse({ ...ZERO, ...usageInput });
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT run_id,case_id,status FROM resource_reservations WHERE reservation_id=?").get(reservationId) as { run_id: string; case_id: string | null; status: string } | undefined;
      if (!row || row.status !== "active") { this.db.exec("COMMIT"); return; }
      this.db.prepare("UPDATE resource_reservations SET usage_json=?,status=?,released_at=? WHERE reservation_id=?").run(canonicalJson(usage), status, now, reservationId);
      const scopes: ResourceScope[] = [{ type: "global", key: "default" }, ...(row.case_id ? [{ type: "case" as const, key: row.case_id }] : []), { type: "run", key: row.run_id }];
      for (const scope of scopes) {
        const budgetRow = this.db.prepare("SELECT usage_json FROM resource_budget_scopes WHERE scope_type=? AND scope_key=?").get(scope.type, scope.key) as { usage_json: string } | undefined;
        if (!budgetRow) continue;
        const current = ResourceUsageSchema.parse(JSON.parse(budgetRow.usage_json));
        const next = Object.fromEntries(Object.keys(ZERO).map((key) => [key, current[key as keyof ResourceUsage] + usage[key as keyof ResourceUsage]]));
        this.db.prepare("UPDATE resource_budget_scopes SET usage_json=?,active_count=MAX(0,active_count-1),updated_at=? WHERE scope_type=? AND scope_key=?").run(canonicalJson(next), now, scope.type, scope.key);
      }
      for (const [metric, delta] of Object.entries(usage)) if (delta > 0) this.db.prepare(`INSERT INTO resource_usage_events(event_id,reservation_id,run_id,case_id,metric,delta,sampled_at) VALUES (?,?,?,?,?,?,?)`).run(randomUUID(), reservationId, row.run_id, row.case_id, metric, delta, now);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  activeCount(runId?: string): number {
    const row = runId
      ? this.db.prepare("SELECT COUNT(*) AS n FROM resource_reservations WHERE status='active' AND run_id=?").get(runId)
      : this.db.prepare("SELECT COUNT(*) AS n FROM resource_reservations WHERE status='active'").get();
    return Number((row as { n: number }).n);
  }

  /**
   * Reconcile leases left active by a crashed owner after the caller has acquired
   * exclusive ownership of the run. Uses the normal idempotent release path so
   * every inherited scope's active_count is repaired transactionally.
   */
  cancelActiveForRun(runId: string, now = new Date().toISOString()): number {
    const rows = this.db.prepare(
      "SELECT reservation_id FROM resource_reservations WHERE run_id=? AND status='active'",
    ).all(runId) as Array<{ reservation_id: string }>;
    for (const row of rows) this.release(row.reservation_id, {}, "cancelled", now);
    return rows.length;
  }
}

export class LedgerExecutionGovernor implements ExecutionResourceGovernor {
  constructor(readonly ledger: ResourceLedger) {}
  async acquire(definition: CapabilityDefinition, request: CapabilityExecuteRequest): Promise<{ ok: true; lease: ExecutionResourceLease } | { ok: false; failure: CapabilityFailure }> {
    const started = performance.now();
    try {
      const estimate = definition.resourceEstimate;
      const id = this.ledger.reserve({ runId: request.runId, caseId: request.caseId, capabilityId: definition.id, expected: {
        wallTimeMs: estimate.expectedWallTimeMs, memoryBytes: estimate.expectedMemoryBytes, diskBytes: estimate.expectedDiskBytes,
        networkBytes: estimate.expectedNetworkBytes, toolOutputBytes: estimate.expectedToolOutputBytes,
      } });
      return { ok: true, lease: { release: ({ status, outputBytes }) => this.ledger.release(id, { wallTimeMs: Math.ceil(performance.now() - started), toolOutputBytes: outputBytes ?? 0 }, status === "cancelled" ? "cancelled" : status === "failed" ? "exhausted" : "released") } };
    } catch (error) {
      const limit = error instanceof ResourceLimitError ? error : new ResourceLimitError("budget_exhausted", error instanceof Error ? error.message : String(error));
      return { ok: false, failure: { kind: "resource_exhausted", code: limit.code, message: limit.message, retryable: false, details: limit.details as Record<string, never> } };
    }
  }
}
