import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { JsonValue, PrincipalRef } from "@/lib/capability/common";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";
import {
  BusinessCaseKindSchema,
  BusinessEdgeSchema,
  BusinessNodeSchema,
  CaseDeadlineSchema,
  CaseHistoryEventSchema,
  CaseRunBindingSchema,
  CaseSnapshotSchema,
  HumanDecisionRecordSchema,
  type BusinessCaseKind,
  type BusinessEdge,
  type BusinessNode,
  type CaseDeadline,
  type CaseHistoryEvent,
  type CaseRunBinding,
  type CaseSnapshot,
  type HumanDecisionRecord,
} from "./contracts";

type HistoryInput = {
  eventType: string;
  reason: string;
  actor: PrincipalRef;
  payload: JsonValue;
  runId?: string;
  decisionId?: string;
  evidenceIds?: string[];
};

export class BusinessCaseStore {
  constructor(readonly db: DatabaseSync, readonly now: () => Date = () => new Date()) {}

  setCaseKind(caseId: string, kind: BusinessCaseKind, actor: PrincipalRef, reason: string): void {
    BusinessCaseKindSchema.parse(kind);
    this.assertCase(caseId);
    this.db.prepare("UPDATE cases SET case_kind = ?, updated_at = ? WHERE case_id = ?")
      .run(kind, this.isoNow(), caseId);
    this.appendHistory(caseId, { eventType: "case.kind_set", reason, actor, payload: { kind } });
  }

  putNode(input: Omit<BusinessNode, "createdAt" | "updatedAt">, actor: PrincipalRef, reason: string): BusinessNode {
    this.assertCase(input.caseId);
    const previous = this.db.prepare("SELECT created_at FROM case_business_nodes WHERE node_id = ?")
      .get(input.id) as { created_at: string } | undefined;
    const now = this.isoNow();
    const node = BusinessNodeSchema.parse({
      ...input,
      createdAt: previous?.created_at ?? now,
      updatedAt: now,
    });
    this.db.prepare(`
      INSERT INTO case_business_nodes(
        node_id, case_id, node_kind, title, status, data_json,
        artifact_versions_json, evidence_ids_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(node_id) DO UPDATE SET
        node_kind=excluded.node_kind,
        title=excluded.title,
        status=excluded.status,
        data_json=excluded.data_json,
        artifact_versions_json=excluded.artifact_versions_json,
        evidence_ids_json=excluded.evidence_ids_json,
        updated_at=excluded.updated_at
    `).run(
      node.id,
      node.caseId,
      node.kind,
      node.title,
      node.status,
      canonicalJson(node.data),
      canonicalJson(node.artifactVersionIds),
      canonicalJson(node.evidenceIds),
      node.createdAt,
      node.updatedAt,
    );
    this.appendHistory(node.caseId, {
      eventType: previous ? "node.updated" : "node.created",
      reason,
      actor,
      evidenceIds: node.evidenceIds,
      payload: { nodeId: node.id, kind: node.kind, status: node.status },
    });
    return node;
  }

  connect(input: Omit<BusinessEdge, "createdAt">, actor: PrincipalRef, reason: string): BusinessEdge {
    this.assertNode(input.caseId, input.from);
    this.assertNode(input.caseId, input.to);
    const edge = BusinessEdgeSchema.parse({ ...input, createdAt: this.isoNow() });
    this.db.prepare(`
      INSERT INTO case_business_edges(case_id, from_node_id, to_node_id, relation, evidence_ids_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id, from_node_id, to_node_id, relation) DO UPDATE SET
        evidence_ids_json=excluded.evidence_ids_json
    `).run(edge.caseId, edge.from, edge.to, edge.relation, canonicalJson(edge.evidenceIds), edge.createdAt);
    this.appendHistory(edge.caseId, {
      eventType: "edge.connected",
      reason,
      actor,
      evidenceIds: edge.evidenceIds,
      payload: { from: edge.from, to: edge.to, relation: edge.relation },
    });
    return edge;
  }

  attachRun(input: CaseRunBinding, actor: PrincipalRef, reason: string): CaseRunBinding {
    const binding = CaseRunBindingSchema.parse(input);
    this.assertCase(binding.caseId);
    this.db.prepare(`
      INSERT INTO case_run_bindings(case_id, run_id, role_id, capability_ids_json, state, started_at, ended_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id, run_id) DO UPDATE SET
        role_id=excluded.role_id,
        capability_ids_json=excluded.capability_ids_json,
        state=excluded.state,
        ended_at=excluded.ended_at
    `).run(
      binding.caseId,
      binding.runId,
      binding.roleId,
      canonicalJson(binding.capabilityIds),
      binding.state,
      binding.startedAt,
      binding.endedAt ?? null,
    );
    this.appendHistory(binding.caseId, {
      eventType: "run.bound",
      reason,
      actor,
      runId: binding.runId,
      payload: { roleId: binding.roleId, state: binding.state, capabilityIds: binding.capabilityIds },
    });
    return binding;
  }

  scheduleDeadline(
    input: Omit<CaseDeadline, "createdAt" | "updatedAt">,
    actor: PrincipalRef,
    reason: string,
  ): CaseDeadline {
    this.assertNode(input.caseId, input.obligationNodeId, "obligation");
    const now = this.isoNow();
    const deadline = CaseDeadlineSchema.parse({ ...input, createdAt: now, updatedAt: now });
    this.db.prepare(`
      INSERT INTO case_deadlines(
        deadline_id, case_id, obligation_node_id, due_at, remind_at, status, timezone, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(deadline_id) DO UPDATE SET
        due_at=excluded.due_at,
        remind_at=excluded.remind_at,
        status=excluded.status,
        timezone=excluded.timezone,
        updated_at=excluded.updated_at
    `).run(
      deadline.id,
      deadline.caseId,
      deadline.obligationNodeId,
      deadline.dueAt,
      deadline.remindAt ?? null,
      deadline.status,
      deadline.timezone,
      deadline.createdAt,
      deadline.updatedAt,
    );
    this.appendHistory(deadline.caseId, {
      eventType: "deadline.scheduled",
      reason,
      actor,
      payload: { deadlineId: deadline.id, obligationNodeId: deadline.obligationNodeId, dueAt: deadline.dueAt },
    });
    return deadline;
  }

  updateDeadlineStatus(
    deadlineId: string,
    status: CaseDeadline["status"],
    actor: PrincipalRef,
    reason: string,
  ): void {
    const row = this.db.prepare("SELECT case_id FROM case_deadlines WHERE deadline_id = ?")
      .get(deadlineId) as { case_id: string } | undefined;
    if (!row) throw new Error(`deadline not found: ${deadlineId}`);
    this.db.prepare("UPDATE case_deadlines SET status = ?, updated_at = ? WHERE deadline_id = ?")
      .run(status, this.isoNow(), deadlineId);
    this.appendHistory(row.case_id, {
      eventType: "deadline.status_changed",
      reason,
      actor,
      payload: { deadlineId, status },
    });
  }

  requestDecision(input: {
    id?: string;
    caseId: string;
    specId: string;
    prompt: string;
  }, actor: PrincipalRef, reason: string, runId?: string): HumanDecisionRecord {
    this.assertCase(input.caseId);
    const decision = HumanDecisionRecordSchema.parse({
      id: input.id ?? randomUUID(),
      caseId: input.caseId,
      specId: input.specId,
      status: "pending",
      prompt: input.prompt,
      requestedAt: this.isoNow(),
    });
    this.db.prepare(`
      INSERT INTO case_human_decisions(decision_id, case_id, spec_id, status, prompt, requested_at)
      VALUES (?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(case_id, spec_id) DO UPDATE SET
        status='pending', prompt=excluded.prompt, answer_json=NULL,
        requested_at=excluded.requested_at, resolved_at=NULL
    `).run(decision.id, decision.caseId, decision.specId, decision.prompt, decision.requestedAt);
    const persisted = this.getDecisions(decision.caseId).find((item) => item.specId === decision.specId);
    if (!persisted) throw new Error(`failed to persist decision: ${decision.specId}`);
    this.appendHistory(decision.caseId, {
      eventType: "decision.requested",
      reason,
      actor,
      runId,
      decisionId: persisted.id,
      payload: { specId: decision.specId, prompt: decision.prompt },
    });
    return persisted;
  }

  resolveDecision(
    caseId: string,
    decisionId: string,
    status: "approved" | "rejected" | "canceled",
    answer: JsonValue,
    actor: PrincipalRef,
    reason: string,
  ): HumanDecisionRecord {
    const existing = this.db.prepare(`
      SELECT status FROM case_human_decisions WHERE case_id = ? AND decision_id = ?
    `).get(caseId, decisionId) as { status: string } | undefined;
    if (!existing) throw new Error(`decision not found: ${decisionId}`);
    if (existing.status !== "pending") throw new Error(`decision is already ${existing.status}: ${decisionId}`);
    const resolvedAt = this.isoNow();
    this.db.prepare(`
      UPDATE case_human_decisions SET status = ?, answer_json = ?, resolved_at = ?
      WHERE case_id = ? AND decision_id = ?
    `).run(status, canonicalJson(answer), resolvedAt, caseId, decisionId);
    this.appendHistory(caseId, {
      eventType: "decision.resolved",
      reason,
      actor,
      decisionId,
      payload: { status, answer },
    });
    return this.getDecisions(caseId).find((decision) => decision.id === decisionId)!;
  }

  appendHistory(caseId: string, input: HistoryInput): CaseHistoryEvent {
    this.assertCase(caseId);
    const last = this.db.prepare(`
      SELECT sequence_no, event_hash FROM case_history_events
      WHERE case_id = ? ORDER BY sequence_no DESC LIMIT 1
    `).get(caseId) as { sequence_no: number; event_hash: string } | undefined;
    const body = {
      id: randomUUID(),
      caseId,
      sequence: (last?.sequence_no ?? 0) + 1,
      eventType: input.eventType,
      reason: input.reason,
      actor: input.actor,
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.decisionId ? { decisionId: input.decisionId } : {}),
      evidenceIds: input.evidenceIds ?? [],
      payload: input.payload,
      ...(last?.event_hash ? { previousHash: last.event_hash } : {}),
      createdAt: this.isoNow(),
    };
    const event = CaseHistoryEventSchema.parse({ ...body, eventHash: sha256Json(body) });
    this.db.prepare(`
      INSERT INTO case_history_events(
        event_id, case_id, sequence_no, event_type, reason, actor_json, run_id, decision_id,
        evidence_ids_json, payload_json, previous_hash, event_hash, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.caseId,
      event.sequence,
      event.eventType,
      event.reason,
      canonicalJson(event.actor),
      event.runId ?? null,
      event.decisionId ?? null,
      canonicalJson(event.evidenceIds),
      canonicalJson(event.payload),
      event.previousHash ?? null,
      event.eventHash,
      event.createdAt,
    );
    return event;
  }

  snapshot(caseId: string): CaseSnapshot {
    this.assertHistoryIntegrity(caseId);
    const caseRow = this.db.prepare("SELECT case_kind FROM cases WHERE case_id = ?").get(caseId) as { case_kind: string };
    const data = {
      caseId,
      kind: BusinessCaseKindSchema.parse(caseRow.case_kind),
      nodes: this.getNodes(caseId),
      edges: this.getEdges(caseId),
      runs: this.getRuns(caseId),
      deadlines: this.getDeadlines(caseId),
      decisions: this.getDecisions(caseId),
      history: this.getHistory(caseId),
    };
    return CaseSnapshotSchema.parse({ ...data, snapshotHash: sha256Json(data) });
  }

  assertHistoryIntegrity(caseId: string): void {
    let previousHash: string | undefined;
    for (const event of this.getHistory(caseId)) {
      if (event.previousHash !== previousHash) throw new Error(`case history chain mismatch at sequence ${event.sequence}`);
      const { eventHash: _eventHash, ...body } = event;
      if (sha256Json(body) !== event.eventHash) throw new Error(`case history hash mismatch at sequence ${event.sequence}`);
      previousHash = event.eventHash;
    }
  }

  getNodes(caseId: string): BusinessNode[] {
    const rows = this.db.prepare(`SELECT * FROM case_business_nodes WHERE case_id = ? ORDER BY created_at, node_id`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => BusinessNodeSchema.parse({
      id: row.node_id,
      caseId: row.case_id,
      kind: row.node_kind,
      title: row.title,
      status: row.status,
      data: JSON.parse(String(row.data_json)),
      artifactVersionIds: JSON.parse(String(row.artifact_versions_json)),
      evidenceIds: JSON.parse(String(row.evidence_ids_json)),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getEdges(caseId: string): BusinessEdge[] {
    const rows = this.db.prepare(`SELECT * FROM case_business_edges WHERE case_id = ? ORDER BY created_at, from_node_id`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => BusinessEdgeSchema.parse({
      caseId: row.case_id,
      from: row.from_node_id,
      to: row.to_node_id,
      relation: row.relation,
      evidenceIds: JSON.parse(String(row.evidence_ids_json)),
      createdAt: row.created_at,
    }));
  }

  getRuns(caseId: string): CaseRunBinding[] {
    const rows = this.db.prepare(`SELECT * FROM case_run_bindings WHERE case_id = ? ORDER BY started_at, run_id`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => CaseRunBindingSchema.parse({
      caseId: row.case_id,
      runId: row.run_id,
      roleId: row.role_id,
      capabilityIds: JSON.parse(String(row.capability_ids_json)),
      state: row.state,
      startedAt: row.started_at,
      ...(row.ended_at ? { endedAt: row.ended_at } : {}),
    }));
  }

  getDeadlines(caseId: string): CaseDeadline[] {
    const rows = this.db.prepare(`SELECT * FROM case_deadlines WHERE case_id = ? ORDER BY due_at, deadline_id`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => CaseDeadlineSchema.parse({
      id: row.deadline_id,
      caseId: row.case_id,
      obligationNodeId: row.obligation_node_id,
      dueAt: row.due_at,
      ...(row.remind_at ? { remindAt: row.remind_at } : {}),
      status: row.status,
      timezone: row.timezone,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  getDecisions(caseId: string): HumanDecisionRecord[] {
    const rows = this.db.prepare(`SELECT * FROM case_human_decisions WHERE case_id = ? ORDER BY requested_at, decision_id`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => HumanDecisionRecordSchema.parse({
      id: row.decision_id,
      caseId: row.case_id,
      specId: row.spec_id,
      status: row.status,
      prompt: row.prompt,
      ...(row.answer_json ? { answer: JSON.parse(String(row.answer_json)) } : {}),
      requestedAt: row.requested_at,
      ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    }));
  }

  getHistory(caseId: string): CaseHistoryEvent[] {
    const rows = this.db.prepare(`SELECT * FROM case_history_events WHERE case_id = ? ORDER BY sequence_no`)
      .all(caseId) as Array<Record<string, unknown>>;
    return rows.map((row) => CaseHistoryEventSchema.parse({
      id: row.event_id,
      caseId: row.case_id,
      sequence: row.sequence_no,
      eventType: row.event_type,
      reason: row.reason,
      actor: JSON.parse(String(row.actor_json)),
      ...(row.run_id ? { runId: row.run_id } : {}),
      ...(row.decision_id ? { decisionId: row.decision_id } : {}),
      evidenceIds: JSON.parse(String(row.evidence_ids_json)),
      payload: JSON.parse(String(row.payload_json)),
      ...(row.previous_hash ? { previousHash: row.previous_hash } : {}),
      eventHash: row.event_hash,
      createdAt: row.created_at,
    }));
  }

  private isoNow(): string {
    return this.now().toISOString();
  }

  private assertCase(caseId: string): void {
    if (!this.db.prepare("SELECT case_id FROM cases WHERE case_id = ?").get(caseId)) {
      throw new Error(`case not found: ${caseId}`);
    }
  }

  private assertNode(caseId: string, nodeId: string, kind?: BusinessNode["kind"]): void {
    const row = this.db.prepare("SELECT node_kind FROM case_business_nodes WHERE case_id = ? AND node_id = ?")
      .get(caseId, nodeId) as { node_kind: BusinessNode["kind"] } | undefined;
    if (!row) throw new Error(`business node not found in case: ${nodeId}`);
    if (kind && row.node_kind !== kind) throw new Error(`business node ${nodeId} must be ${kind}`);
  }
}
