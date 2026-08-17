import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import type { TaskContractV3 } from "../lib/task/contracts.ts";
import { getInterruptedRunResumeContract, recoverInterruptedTaskCases } from "../lib/task/recovery.ts";
import { TaskStore } from "../lib/task/store.ts";
import { buildWorkPlan, evaluateTaskPreflight, WorkPlanStore, workPlanPrompt } from "../lib/task/work-plan.ts";

function taskContract(): TaskContractV3 {
  return {
    id: "task-work-plan",
    version: 3,
    caseId: "case-work-plan",
    goal: "先研究公开资料，再完成综合财务分析",
    businessContext: {
      entities: [], counterparties: [], periods: [], currencies: [], units: [],
      accountingStandards: [], jurisdictions: [],
    },
    inputs: [],
    requiredCapabilities: [
      { capabilityId: "agent.turn", versionRange: "^1.0.0", required: true },
      { capabilityId: "research.web", versionRange: "^1.0.0", required: true },
    ],
    invariants: [],
    expectedOutputs: [],
    evidenceRequirements: [],
    humanDecisionPoints: [],
    noGuess: ["不得猜测"],
    noDegrade: ["不得跳过研究"],
    security: {
      classification: "public",
      allowedPrincipals: [{ id: "local-user", type: "user", tenantId: "local" }],
      allowExternalEgress: true,
      allowedDomains: ["example.com"],
      requireEncryptionAtRest: true,
      requireHumanApprovalForExport: false,
    },
    retention: {
      policyId: "local-default", legalHold: false, allowUserDeletionRequest: true, gracePeriodDays: 7,
    },
    budget: {
      tokenLimit: 10_000, wallTimeMs: 60_000, cpuTimeMs: null,
      memoryBytes: 64 * 1024 * 1024, diskBytes: 128 * 1024 * 1024,
      networkBytes: 10 * 1024 * 1024, toolOutputBytes: 1024 * 1024,
      concurrency: 1, retryLimit: 1,
    },
  };
}

export const workPlanRuntimeTestPromise = (async () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=ON");
  runMigrations(db, ":memory:", () => null);
  try {
    const contract = taskContract();
    const tasks = new TaskStore(db);
    tasks.saveContract(contract);
    tasks.createCase(contract.id, contract.caseId, "run-work-plan");
    tasks.transitionCase(contract.caseId!, "preflight");

    const created = buildWorkPlan({
      caseId: contract.caseId!, runId: "run-work-plan", contract, intent: "complex_workflow",
      now: new Date("2026-08-15T00:00:00.000Z"),
    });
    assert.deepEqual(
      created.summary.steps.map((step) => step.stepKey),
      ["preflight", "gather_evidence", "execute", "validate"],
    );
    assert.equal(created.casePlan.nodes.length, 4, "complex tasks must be a real multi-node DAG");
    assert.equal(created.casePlan.edges.length, 3);
    tasks.savePlan(created.casePlan);
    const plans = new WorkPlanStore(db);
    plans.create(created);
    const preflight = evaluateTaskPreflight(contract, new Date("2026-08-15T00:00:00.000Z"));
    plans.savePreflight(contract.caseId!, preflight);
    assert.ok(preflight.every((result) => result.status === "available"));

    plans.setStepStatus(contract.caseId!, "preflight", "running");
    plans.setStepStatus(contract.caseId!, "preflight", "succeeded");
    plans.setStepStatus(contract.caseId!, "gather_evidence", "running");
    plans.setStepStatus(contract.caseId!, "gather_evidence", "succeeded", "证据已落账");
    plans.setStepStatus(contract.caseId!, "execute", "running");
    tasks.transitionCase(contract.caseId!, "planned");
    tasks.transitionCase(contract.caseId!, "running");
    db.prepare(`
      INSERT INTO agent_runs(run_id,trace_id,status,termination_reason,started_at,updated_at)
      VALUES ('run-work-plan','run-work-plan','paused','process_crash',?,?)
    `).run("2026-08-15T00:00:00.000Z", "2026-08-15T00:00:00.000Z");

    const recovered = recoverInterruptedTaskCases(db, new Date("2026-08-15T00:01:00.000Z"));
    assert.equal(recovered.length, 1);
    const after = plans.getCurrent(contract.caseId!)!;
    assert.equal(after.status, "interrupted");
    assert.equal(after.steps.find((step) => step.stepKey === "gather_evidence")?.status, "succeeded", "completed work must survive recovery");
    assert.equal(after.steps.find((step) => step.stepKey === "execute")?.status, "interrupted");
    assert.equal((db.prepare("SELECT state FROM cases WHERE case_id=?").get(contract.caseId!) as { state: string }).state, "repairing");
    const resume = getInterruptedRunResumeContract(db, "run-work-plan");
    assert.equal(resume?.resumable, true);
    assert.equal(resume?.exactProcessContinuation, false);
    assert.deepEqual(resume?.retryableStepKeys, ["execute"]);
    assert.match(workPlanPrompt(after), /不是隐藏推理/);
    assert.doesNotMatch(workPlanPrompt(after), /chain.of.thought/i);
  } finally {
    db.close();
  }
  console.log("work-plan-runtime: multi-node plan, preflight, persistence and safe crash recovery passed ✓");
})();

if (process.argv[1]?.includes("work-plan-runtime.test")) {
  workPlanRuntimeTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
