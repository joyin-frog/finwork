import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { PrincipalRef } from "@/lib/capability/common";
import { canonicalJson, sha256Json } from "@/lib/capability/hash";

type AuditRow = {
  event_id: string;
  sequence_no: number;
  event_type: string;
  principal_json: string;
  tenant_id: string;
  case_id: string | null;
  capability_id: string | null;
  payload_json: string;
  previous_hash: string | null;
  event_hash: string;
  created_at: string;
};

export class SecurityAuditLedger {
  constructor(readonly db: DatabaseSync) {}

  append(input: {
    eventType: string;
    principal: PrincipalRef;
    tenantId: string;
    caseId?: string;
    capabilityId?: string;
    payload: unknown;
    at: string;
  }): string {
    const previous = this.db.prepare("SELECT sequence_no, event_hash FROM security_audit_events ORDER BY sequence_no DESC LIMIT 1")
      .get() as { sequence_no: number; event_hash: string } | undefined;
    const eventId = randomUUID();
    const sequenceNo = (previous?.sequence_no ?? 0) + 1;
    const body = {
      eventId,
      sequenceNo,
      eventType: input.eventType,
      principal: input.principal,
      tenantId: input.tenantId,
      caseId: input.caseId ?? null,
      capabilityId: input.capabilityId ?? null,
      payload: input.payload,
      previousHash: previous?.event_hash ?? null,
      createdAt: input.at,
    };
    const eventHash = sha256Json(body);
    this.db.prepare(`
      INSERT INTO security_audit_events
        (event_id, sequence_no, event_type, principal_json, tenant_id, case_id, capability_id,
         payload_json, previous_hash, event_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, sequenceNo, input.eventType, canonicalJson(input.principal), input.tenantId,
      input.caseId ?? null, input.capabilityId ?? null, canonicalJson(input.payload),
      previous?.event_hash ?? null, eventHash, input.at);
    return eventId;
  }

  verify(): { valid: true; count: number } | { valid: false; sequenceNo: number; reason: string } {
    const rows = this.db.prepare("SELECT * FROM security_audit_events ORDER BY sequence_no")
      .all() as unknown as AuditRow[];
    let previousHash: string | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      if (row.sequence_no !== index + 1) return { valid: false, sequenceNo: row.sequence_no, reason: "sequence gap" };
      if (row.previous_hash !== previousHash) return { valid: false, sequenceNo: row.sequence_no, reason: "previous hash mismatch" };
      const expected = sha256Json({
        eventId: row.event_id,
        sequenceNo: row.sequence_no,
        eventType: row.event_type,
        principal: JSON.parse(row.principal_json),
        tenantId: row.tenant_id,
        caseId: row.case_id,
        capabilityId: row.capability_id,
        payload: JSON.parse(row.payload_json),
        previousHash: row.previous_hash,
        createdAt: row.created_at,
      });
      if (expected !== row.event_hash) return { valid: false, sequenceNo: row.sequence_no, reason: "event hash mismatch" };
      previousHash = row.event_hash;
    }
    return { valid: true, count: rows.length };
  }
}
