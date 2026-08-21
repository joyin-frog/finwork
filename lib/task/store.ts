import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import { withSqliteSavepoint } from "@/lib/db/transaction";
import {
  CaseCheckpointSchema,
  CaseNodeStatusSchema,
  CasePlanSchema,
  CaseStateSchema,
  TaskContractV3Schema,
  type CaseCheckpoint,
  type CaseNodeStatus,
  type CasePlan,
  type CaseState,
  type TaskContractV3,
} from "./contracts";
import { assertAcyclicPlan } from "./planner";
import { assertCaseTransition } from "./state-machine";

export class TaskStore {
  constructor(readonly db: DatabaseSync) {}

  saveContract(rawContract: TaskContractV3): TaskContractV3 {
    const contract = TaskContractV3Schema.parse(rawContract);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO task_contracts(task_id, contract_version, contract_json, contract_hash, created_at, updated_at)
      VALUES (?, 3, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        contract_version=excluded.contract_version,
        contract_json=excluded.contract_json,
        contract_hash=excluded.contract_hash,
        updated_at=excluded.updated_at
    `).run(contract.id, canonicalJson(contract), sha256Json(contract), now, now);
    return contract;
  }

  createCase(taskId: string, caseId: string = randomUUID(), runId?: string): string {
    const contract = this.db.prepare("SELECT task_id FROM task_contracts WHERE task_id = ?").get(taskId);
    if (!contract) throw new Error(`task contract not found: ${taskId}`);
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO cases(case_id, task_id, run_id, state, created_at, updated_at)
      VALUES (?, ?, ?, 'draft', ?, ?)
    `).run(caseId, taskId, runId ?? null, now, now);
    return caseId;
  }

  getCaseState(caseId: string): CaseState {
    const row = this.db.prepare("SELECT state FROM cases WHERE case_id = ?").get(caseId) as { state: string } | undefined;
    if (!row) throw new Error(`case not found: ${caseId}`);
    return CaseStateSchema.parse(row.state);
  }

  transitionCase(caseId: string, to: CaseState, failure?: unknown): void {
    const from = this.getCaseState(caseId);
    assertCaseTransition(from, to);
    const now = new Date().toISOString();
    const endedAt = to === "delivered" || to === "failed" || to === "canceled" ? now : null;
    this.db.prepare(`
      UPDATE cases SET state = ?, failure_json = ?, updated_at = ?, ended_at = ? WHERE case_id = ?
    `).run(to, failure === undefined ? null : canonicalJson(failure), now, endedAt, caseId);
  }

  savePlan(rawPlan: CasePlan): CasePlan {
    const plan = assertAcyclicPlan(CasePlanSchema.parse(rawPlan));
    if (!this.db.prepare("SELECT case_id FROM cases WHERE case_id = ?").get(plan.caseId)) {
      throw new Error(`case not found: ${plan.caseId}`);
    }
    const startedNode = this.db.prepare(`
      SELECT node_id, status FROM case_nodes
      WHERE case_id = ? AND status NOT IN ('pending','ready')
      LIMIT 1
    `).get(plan.caseId) as { node_id: string; status: string } | undefined;
    if (startedNode) {
      throw new Error(
        `cannot replace an executing or historical plan; node ${startedNode.node_id} is ${startedNode.status}`,
      );
    }
    withSqliteSavepoint(this.db, "task_save_plan", () => {
      this.db.prepare("DELETE FROM case_edges WHERE case_id = ?").run(plan.caseId);
      this.db.prepare("DELETE FROM case_nodes WHERE case_id = ?").run(plan.caseId);
      const insertNode = this.db.prepare(`
        INSERT INTO case_nodes
          (node_id, case_id, capability_id, capability_version, status, input_json, input_hash,
           idempotency_key, ordinal)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const node of plan.nodes) {
        insertNode.run(
          node.id,
          plan.caseId,
          node.capabilityId,
          node.capabilityVersion,
          node.status,
          canonicalJson(node.input),
          node.inputHash,
          node.idempotencyKey ?? null,
          node.ordinal,
        );
      }
      const insertEdge = this.db.prepare(`
        INSERT INTO case_edges(case_id, from_node_id, to_node_id, edge_type) VALUES (?, ?, ?, ?)
      `);
      for (const edge of plan.edges) insertEdge.run(plan.caseId, edge.from, edge.to, edge.type);
      this.db.prepare("UPDATE cases SET plan_version = ?, updated_at = ? WHERE case_id = ?")
        .run(plan.version, new Date().toISOString(), plan.caseId);
    });
    return plan;
  }

  listReadyNodes(caseId: string): Array<{ id: string; status: CaseNodeStatus; input: unknown; idempotencyKey?: string }> {
    const rows = this.db.prepare(`
      SELECT n.node_id, n.status, n.input_json, n.idempotency_key
      FROM case_nodes n
      WHERE n.case_id = ?
        AND n.status IN ('pending','ready')
        AND NOT EXISTS (
          SELECT 1 FROM case_edges e
          JOIN case_nodes parent ON parent.node_id = e.from_node_id
          WHERE e.case_id = n.case_id AND e.to_node_id = n.node_id AND parent.status <> 'succeeded'
        )
      ORDER BY n.ordinal
    `).all(caseId) as Array<{ node_id: string; status: string; input_json: string; idempotency_key: string | null }>;
    return rows.map((row) => ({
      id: row.node_id,
      status: CaseNodeStatusSchema.parse(row.status),
      input: JSON.parse(row.input_json),
      ...(row.idempotency_key ? { idempotencyKey: row.idempotency_key } : {}),
    }));
  }

  updateNodeStatus(nodeId: string, status: CaseNodeStatus, output?: unknown): void {
    CaseNodeStatusSchema.parse(status);
    const now = new Date().toISOString();
    this.db.prepare(`
      UPDATE case_nodes SET status = ?, output_json = COALESCE(?, output_json),
        started_at = CASE WHEN ? = 'running' THEN COALESCE(started_at, ?) ELSE started_at END,
        ended_at = CASE WHEN ? IN ('succeeded','failed','skipped','canceled') THEN ? ELSE ended_at END
      WHERE node_id = ?
    `).run(
      status,
      output === undefined ? null : canonicalJson(output),
      status,
      now,
      status,
      now,
      nodeId,
    );
  }

  saveCheckpoint(caseId: string, snapshot: unknown): CaseCheckpoint {
    const state = this.getCaseState(caseId);
    const sequenceRow = this.db.prepare(`
      SELECT COALESCE(MAX(sequence_no), 0) + 1 AS sequence FROM case_checkpoints WHERE case_id = ?
    `).get(caseId) as { sequence: number };
    const createdAt = new Date().toISOString();
    const checkpoint = CaseCheckpointSchema.parse({
      id: randomUUID(),
      caseId,
      sequence: sequenceRow.sequence,
      state,
      snapshot,
      snapshotHash: sha256Json(snapshot),
      createdAt,
    });
    withSqliteSavepoint(this.db, "task_checkpoint", () => {
      this.db.prepare(`
        INSERT INTO case_checkpoints
          (checkpoint_id, case_id, sequence_no, state, snapshot_json, snapshot_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        checkpoint.id,
        caseId,
        checkpoint.sequence,
        checkpoint.state,
        canonicalJson(checkpoint.snapshot),
        checkpoint.snapshotHash,
        checkpoint.createdAt,
      );
      this.db.prepare("UPDATE cases SET latest_checkpoint_id = ?, updated_at = ? WHERE case_id = ?")
        .run(checkpoint.id, createdAt, caseId);
    });
    return checkpoint;
  }

  restoreLatestCheckpoint(caseId: string): CaseCheckpoint | null {
    const row = this.db.prepare(`
      SELECT checkpoint_id, sequence_no, state, snapshot_json, snapshot_hash, created_at
      FROM case_checkpoints WHERE case_id = ? ORDER BY sequence_no DESC LIMIT 1
    `).get(caseId) as {
      checkpoint_id: string;
      sequence_no: number;
      state: string;
      snapshot_json: string;
      snapshot_hash: string;
      created_at: string;
    } | undefined;
    if (!row) return null;
    const snapshot = JSON.parse(row.snapshot_json);
    if (sha256Json(snapshot) !== row.snapshot_hash) throw new Error("checkpoint integrity mismatch");
    return CaseCheckpointSchema.parse({
      id: row.checkpoint_id,
      caseId,
      sequence: row.sequence_no,
      state: row.state,
      snapshot,
      snapshotHash: row.snapshot_hash,
      createdAt: row.created_at,
    });
  }
}
