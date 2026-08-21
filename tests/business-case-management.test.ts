import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { TaskStore } from "../lib/task/index.ts";
import {
  BusinessCaseStore,
  evaluateDeadlines,
  projectRoleView,
  type BusinessCaseKind,
} from "../lib/case-management/index.ts";

const actor = { id: "user-1", type: "user" as const, tenantId: "tenant-1" };
const CASE_KINDS: BusinessCaseKind[] = [
  "financial_consolidation",
  "filing_review",
  "treasury_analysis",
  "payroll_tax",
  "due_diligence",
];

function contract(id: string) {
  return {
    id,
    version: 3 as const,
    goal: "Resume an evidence-backed finance case across runs.",
    businessContext: {
      entities: [{ id: "entity-1", type: "company", name: "示例公司" }],
      counterparties: [],
      periods: [{ start: "2026-01-01", end: "2026-12-31", label: "2026" }],
      currencies: [{ code: "CNY" }],
      units: [{ code: "yuan" }],
      accountingStandards: ["CAS"],
      jurisdictions: ["CN"],
    },
    inputs: [],
    requiredCapabilities: [{ capabilityId: "finance.case", versionRange: "^1.0.0" }],
    invariants: [],
    expectedOutputs: [],
    evidenceRequirements: [{ evidenceType: "source" as const, requiresLocator: true }],
    humanDecisionPoints: [],
    noGuess: ["entity", "period"],
    noDegrade: ["finance.case"],
    security: { classification: "confidential" as const, allowedPrincipals: [actor], allowExternalEgress: false },
    retention: { policyId: "finance-default" },
    budget: { wallTimeMs: 60_000, memoryBytes: 256 * 1024 * 1024 },
  };
}

export const businessCaseManagementTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-business-case-"));
  const dbPath = path.join(root, "case.db");
  const at = new Date("2026-08-09T02:00:00.000Z");
  try {
    let db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, dbPath, () => null);
    const tasks = new TaskStore(db);
    const cases = new BusinessCaseStore(db, () => at);

    for (const [index, kind] of CASE_KINDS.entries()) {
      const taskId = `task-${kind}`;
      const caseId = `case-${kind}`;
      tasks.saveContract(contract(taskId));
      tasks.createCase(taskId, caseId);
      cases.setCaseKind(caseId, kind, actor, "用户确认业务类型");
      cases.putNode({
        id: `${caseId}-entity`, caseId, kind: "entity", title: "示例公司", status: "active",
        data: { registrationNumber: `9136${index}` }, artifactVersionIds: [], evidenceIds: [`ev-${index}`],
      }, actor, "识别主体");
      cases.putNode({
        id: `${caseId}-period`, caseId, kind: "period", title: "2026 年度", status: "active",
        data: { start: "2026-01-01", end: "2026-12-31" }, artifactVersionIds: [], evidenceIds: [],
      }, actor, "确认期间");
      cases.putNode({
        id: `${caseId}-obligation`, caseId, kind: "obligation", title: "申报或交付义务", status: "active",
        data: { jurisdiction: "CN" }, artifactVersionIds: [], evidenceIds: [`ev-${index}`],
      }, actor, "识别义务");
      cases.connect({
        caseId, from: `${caseId}-obligation`, to: `${caseId}-entity`, relation: "belongs_to", evidenceIds: [`ev-${index}`],
      }, actor, "义务归属主体");
      cases.attachRun({
        caseId, runId: `${caseId}-run-1`, roleId: "finance-primary", capabilityIds: ["finance.case"],
        state: "succeeded", startedAt: "2026-08-08T00:00:00.000Z", endedAt: "2026-08-08T00:10:00.000Z",
      }, actor, "首轮检查");
      cases.attachRun({
        caseId, runId: `${caseId}-run-2`, roleId: "finance-review", capabilityIds: ["finance.review"],
        state: "waiting_user", startedAt: "2026-08-09T01:00:00.000Z",
      }, actor, "复核续跑");
      const decision = cases.requestDecision({
        id: `${caseId}-decision`, caseId, specId: "accounting-basis", prompt: "是否采用审定口径？",
      }, actor, "口径冲突需要人工确认", `${caseId}-run-2`);
      cases.resolveDecision(caseId, decision.id, "approved", { basis: "audited" }, actor, "用户选择审定口径");
      cases.scheduleDeadline({
        id: `${caseId}-deadline`, caseId, obligationNodeId: `${caseId}-obligation`,
        dueAt: "2026-08-15T10:00:00.000Z", remindAt: "2026-08-09T01:00:00.000Z",
        status: "scheduled", timezone: "Asia/Shanghai",
      }, actor, "根据法定义务安排提醒");
    }
    db.close();

    // A fresh process connection must recover the same shared case state and evidence chain.
    db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    const restored = new BusinessCaseStore(db, () => at);
    for (const kind of CASE_KINDS) {
      const caseId = `case-${kind}`;
      const snapshot = restored.snapshot(caseId);
      assert.equal(snapshot.kind, kind);
      assert.equal(snapshot.nodes.length, 3);
      assert.equal(snapshot.runs.length, 2);
      assert.equal(snapshot.decisions[0]?.status, "approved");
      assert.ok(snapshot.history.length >= 10);
      assert.deepEqual(evaluateDeadlines(snapshot.deadlines, at).map((item) => item.kind), ["reminder"]);
      const roleView = projectRoleView({
        caseId,
        definition: {
          roleId: "reviewer", capabilityIds: ["finance.review"], rulePackIds: ["cas-2026"],
          visibleKinds: ["entity", "obligation"],
        },
        nodes: snapshot.nodes,
        decisions: snapshot.decisions,
      });
      assert.deepEqual(roleView.visibleNodeIds, [`${caseId}-entity`, `${caseId}-obligation`]);
      assert.deepEqual(roleView.pendingDecisionIds, []);
    }

    const tamperedCase = "case-financial_consolidation";
    db.prepare("UPDATE case_history_events SET reason = 'tampered' WHERE case_id = ? AND sequence_no = 1")
      .run(tamperedCase);
    assert.throws(() => restored.snapshot(tamperedCase), /case history hash mismatch/);
    db.close();
    console.log("business-case-management tests passed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
