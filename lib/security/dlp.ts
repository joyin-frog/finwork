import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { PrincipalRefSchema, type PrincipalRef } from "@/lib/capability/common";
import { DlpFindingSchema, type DataClassification, type DlpFinding, type SecurityTaint } from "./contracts";
import { SecurityAuditLedger } from "./audit";

const RULES: Array<{ kind: DlpFinding["kind"]; pattern: RegExp }> = [
  { kind: "secret", pattern: /\b(?:sk|api)[-_][A-Za-z0-9_-]{12,}\b/g },
  { kind: "personal_data", pattern: /\b\d{17}[\dXx]\b|\b1[3-9]\d{9}\b/g },
  { kind: "bank_account", pattern: /\b\d{16,19}\b/g },
  { kind: "restricted_financial_data", pattern: /(?:未公开|机密|restricted)[^\n]{0,24}(?:财务|利润|收入|报表)/gi },
];

export function scanDlpText(text: string): DlpFinding[] {
  return RULES.flatMap(({ kind, pattern }) => [...text.matchAll(new RegExp(pattern.source, pattern.flags))].map((match) => {
    const start = match.index ?? 0;
    const value = match[0];
    return DlpFindingSchema.parse({ kind, start, end: start + value.length,
      fingerprint: createHash("sha256").update(value).digest("hex") });
  })).sort((a, b) => a.start - b.start);
}

export function redactDlpText(text: string, findings: DlpFinding[] = scanDlpText(text)): string {
  let redacted = text;
  for (const item of [...findings].sort((left, right) => right.start - left.start)) {
    redacted = `${redacted.slice(0, item.start)}[REDACTED:${item.kind}:${item.fingerprint.slice(0, 12)}]${redacted.slice(item.end)}`;
  }
  return redacted;
}

type ExportRow = {
  principal_json: string; tenant_id: string; case_id: string | null; artifact_version_id: string;
  capability_id: string; destination_domain: string; classification: DataClassification; status: string; expires_at: string;
};

export class ExternalExportService {
  readonly audit: SecurityAuditLedger;
  constructor(readonly db: DatabaseSync, audit = new SecurityAuditLedger(db)) { this.audit = audit; }

  request(input: { principal: PrincipalRef; tenantId: string; caseId?: string; artifactVersionId: string;
    capabilityId: string; destinationDomain: string; classification: DataClassification;
    findings: DlpFinding[]; taints?: SecurityTaint[]; ttlMs: number; now: string;
  }): { requestId: string; status: "pending" | "approved" | "denied" } {
    const principal = PrincipalRefSchema.parse(input.principal);
    const requestId = randomUUID();
    const taints = input.taints ?? [];
    const status = taints.includes("malware_suspected") || taints.includes("prompt_injection")
      ? "denied" as const
      : input.classification === "public" && input.findings.length === 0
        ? "approved" as const
        : "pending" as const;
    const reason = status === "denied" ? "tainted_content" : status === "approved" ? "low_risk_auto_approval" : "human_approval_required";
    const expiresAt = new Date(Date.parse(input.now) + input.ttlMs).toISOString();
    this.db.prepare(`INSERT INTO external_export_requests
      (request_id, principal_json, tenant_id, case_id, artifact_version_id, capability_id, destination_domain,
       classification, findings_json, status, reason, expires_at, created_at, decided_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(requestId, canonicalJson(principal), input.tenantId, input.caseId ?? null, input.artifactVersionId,
        input.capabilityId, input.destinationDomain.toLowerCase(), input.classification, canonicalJson(input.findings),
        status, reason, expiresAt, input.now, status === "pending" ? null : input.now);
    this.audit.append({ eventType: "external_export_requested", principal, tenantId: input.tenantId,
      caseId: input.caseId, capabilityId: input.capabilityId,
      payload: { requestId, artifactVersionId: input.artifactVersionId, destinationDomain: input.destinationDomain.toLowerCase(),
        classification: input.classification, findingFingerprints: input.findings.map((finding) => finding.fingerprint), status }, at: input.now });
    return { requestId, status };
  }

  decide(requestId: string, input: { approver: PrincipalRef; approve: boolean; reason: string; now: string }): void {
    const row = this.db.prepare("SELECT status, tenant_id FROM external_export_requests WHERE request_id = ?")
      .get(requestId) as { status: string; tenant_id: string } | undefined;
    if (!row || row.status !== "pending") throw new Error("export request is not pending");
    this.db.prepare(`UPDATE external_export_requests SET status=?, approver_json=?, reason=?, decided_at=? WHERE request_id=?`)
      .run(input.approve ? "approved" : "denied", canonicalJson(PrincipalRefSchema.parse(input.approver)), input.reason, input.now, requestId);
    this.audit.append({ eventType: "external_export_decided", principal: input.approver, tenantId: row.tenant_id,
      payload: { requestId, approved: input.approve, reason: input.reason }, at: input.now });
  }

  isAuthorized(input: { requestId: string; principal: PrincipalRef; tenantId: string; caseId?: string;
    artifactVersionId: string; capabilityId: string; destinationDomain: string; now: string }): boolean {
    const row = this.db.prepare("SELECT * FROM external_export_requests WHERE request_id = ?").get(input.requestId) as ExportRow | undefined;
    if (!row || row.status !== "approved" || row.expires_at <= input.now) return false;
    const exact = canonicalJson(PrincipalRefSchema.parse(JSON.parse(row.principal_json))) === canonicalJson(PrincipalRefSchema.parse(input.principal))
      && row.tenant_id === input.tenantId && row.case_id === (input.caseId ?? null)
      && row.artifact_version_id === input.artifactVersionId && row.capability_id === input.capabilityId
      && row.destination_domain === input.destinationDomain.toLowerCase();
    return exact;
  }

  complete(input: { requestId: string; principal: PrincipalRef; tenantId: string; caseId?: string;
    artifactVersionId: string; capabilityId: string; destinationDomain: string; now: string }): void {
    if (!this.isAuthorized(input)) throw new Error("export request is not authorized for this exact scope");
    this.db.prepare("UPDATE external_export_requests SET status='completed', completed_at=? WHERE request_id=?")
      .run(input.now, input.requestId);
    this.audit.append({ eventType: "external_export_completed", principal: input.principal, tenantId: input.tenantId,
      caseId: input.caseId, capabilityId: input.capabilityId,
      payload: { requestId: input.requestId, artifactVersionId: input.artifactVersionId,
        destinationDomain: input.destinationDomain.toLowerCase() }, at: input.now });
  }

  authorize(input: { requestId: string; principal: PrincipalRef; tenantId: string; caseId?: string;
    artifactVersionId: string; capabilityId: string; destinationDomain: string; now: string }): boolean {
    if (!this.isAuthorized(input)) return false;
    this.complete(input);
    return true;
  }
}
