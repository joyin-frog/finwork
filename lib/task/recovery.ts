import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { TaskStore } from "./store";
import { WorkPlanStore } from "./work-plan";

export type InterruptedCaseRecovery = {
  caseId: string;
  runId: string;
  interruptedStepKeys: string[];
  retryableStepKeys: string[];
  blockedStepKeys: string[];
};

/**
 * Reconciles task state after a process crash. It never claims that an in-flight
 * model call, Python process, or transaction survived. Completed steps stay
 * completed; only unfinished work is marked interrupted.
 */
export function recoverInterruptedTaskCases(
  db: DatabaseSync,
  now = new Date(),
): InterruptedCaseRecovery[] {
  const rows = db.prepare(`
    SELECT c.case_id,c.run_id
    FROM cases c JOIN agent_runs r ON r.run_id=c.run_id
    WHERE r.status='paused' AND r.termination_reason='process_crash'
      AND c.state IN ('preflight','planned','running','waiting_for_human','validating','repairing','finalizing')
  `).all() as Array<{ case_id: string; run_id: string }>;
  const recovered: InterruptedCaseRecovery[] = [];
  for (const row of rows) {
    const interruptedSteps = db.prepare(`
      SELECT s.step_key,n.idempotency_key
      FROM case_plan_versions p
      JOIN case_plan_steps s ON s.plan_id=p.plan_id
      LEFT JOIN case_plan_step_nodes l ON l.plan_id=p.plan_id AND l.step_id=s.step_id
      LEFT JOIN case_nodes n ON n.node_id=l.node_id
      WHERE p.case_id=? AND p.status='active'
        AND s.status IN ('ready','running','waiting_user','verifying','blocked')
      ORDER BY s.ordinal
    `).all(row.case_id) as Array<{ step_key: string; idempotency_key: string | null }>;
    const interruptedStepKeys = interruptedSteps.map((step) => step.step_key);
    const retryableStepKeys = interruptedSteps.filter((step) => Boolean(step.idempotency_key)).map((step) => step.step_key);
    const blockedStepKeys = interruptedSteps.filter((step) => !step.idempotency_key).map((step) => step.step_key);
    const capturedAt = now.toISOString();
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(`
        UPDATE case_step_attempts SET status='failed',failure_json=?,ended_at=?
        WHERE case_id=? AND status='running'
      `).run(canonicalJson({ code: "process_interrupted", retryable: true }), capturedAt, row.case_id);
      db.prepare(`
        UPDATE case_plan_steps SET status='interrupted',result_summary=?,updated_at=?,ended_at=?
        WHERE plan_id IN (SELECT plan_id FROM case_plan_versions WHERE case_id=? AND status='active')
          AND status IN ('ready','running','waiting_user','verifying','blocked')
      `).run("进程中断；运行中的调用未被伪装为已恢复", capturedAt, capturedAt, row.case_id);
      db.prepare(`
        UPDATE case_plan_versions SET status='interrupted',updated_at=?
        WHERE case_id=? AND status='active'
      `).run(capturedAt, row.case_id);
      db.prepare(`
        UPDATE case_nodes SET status='failed',output_json=?,ended_at=?
        WHERE case_id=? AND status IN ('ready','running','waiting_for_human','validating')
      `).run(canonicalJson({ code: "process_interrupted" }), capturedAt, row.case_id);
      db.prepare(`
        UPDATE cases SET state='repairing',failure_json=?,updated_at=?,ended_at=NULL
        WHERE case_id=?
      `).run(canonicalJson({ code: "process_interrupted", retryableStepKeys, blockedStepKeys }), capturedAt, row.case_id);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    new TaskStore(db).saveCheckpoint(row.case_id, {
      phase: "process_interrupted",
      runId: row.run_id,
      interruptedStepKeys,
      retryableStepKeys,
      blockedStepKeys,
      capturedAt,
    });
    recovered.push({
      caseId: row.case_id,
      runId: row.run_id,
      interruptedStepKeys,
      retryableStepKeys,
      blockedStepKeys,
    });
  }
  return recovered;
}

/** Read-only resume contract consumed by a future UI or another backend client. */
export function getInterruptedRunResumeContract(db: DatabaseSync, runId: string) {
  const row = db.prepare(`
    SELECT c.case_id,c.state,r.status AS run_status,r.termination_reason
    FROM cases c JOIN agent_runs r ON r.run_id=c.run_id WHERE c.run_id=?
  `).get(runId) as {
    case_id: string; state: string; run_status: string; termination_reason: string | null;
  } | undefined;
  if (!row) return null;
  const plans = new WorkPlanStore(db);
  const plan = plans.getCurrent(row.case_id);
  const checkpoint = new TaskStore(db).restoreLatestCheckpoint(row.case_id);
  const interrupted = plan?.steps.filter((step) => step.status === "interrupted") ?? [];
  const retryable = interrupted.filter((step) => {
    const node = db.prepare(`
      SELECT n.idempotency_key FROM case_plan_step_nodes l
      JOIN case_nodes n ON n.node_id=l.node_id WHERE l.plan_id=? AND l.step_id=?
    `).get(plan!.planId, step.stepId) as { idempotency_key: string | null } | undefined;
    return Boolean(node?.idempotency_key);
  });
  return {
    runId,
    caseId: row.case_id,
    runStatus: row.run_status,
    caseState: row.state,
    terminationReason: row.termination_reason,
    resumable: row.run_status === "paused" && interrupted.length > 0 && retryable.length === interrupted.length,
    exactProcessContinuation: false,
    retryMode: "checkpoint_idempotent_step" as const,
    retryableStepKeys: retryable.map((step) => step.stepKey),
    blockedStepKeys: interrupted.filter((step) => !retryable.includes(step)).map((step) => step.stepKey),
    checkpoint,
  };
}
