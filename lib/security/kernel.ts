import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import {
  DataClassificationSchema,
  EgressGrantSchema,
  SecurityAclGrantSchema,
  SecurityAuthorizationRequestSchema,
  SecurityDecisionSchema,
  type DataClassification,
  type EgressGrant,
  type SecurityAclGrant,
  type SecurityAuthorizationRequest,
  type SecurityDecision,
  type SecurityTaint,
} from "./contracts";
import { SecurityAuditLedger } from "./audit";
import { withSqliteSavepoint } from "@/lib/db/transaction";

const CLASSIFICATION_RANK: Record<DataClassification, number> = { public: 0, internal: 1, confidential: 2, restricted: 3 };

export function propagateSecurityLabels(inputs: Array<{ classification: DataClassification; taints: SecurityTaint[] }>) {
  if (inputs.length === 0) return { classification: "internal" as const, taints: [] as SecurityTaint[] };
  const classification = inputs.map((item) => DataClassificationSchema.parse(item.classification))
    .sort((a, b) => CLASSIFICATION_RANK[b] - CLASSIFICATION_RANK[a])[0];
  return { classification, taints: [...new Set(inputs.flatMap((item) => item.taints))].sort() as SecurityTaint[] };
}

export function assertNoLabelDowngrade(from: DataClassification, to: DataClassification, approved = false): void {
  if (CLASSIFICATION_RANK[to] < CLASSIFICATION_RANK[from] && !approved) {
    throw new Error(`classification downgrade requires explicit approval: ${from} -> ${to}`);
  }
}

type AclRow = { grant_json: string; revoked_at: string | null };
type EgressRow = { grant_json: string; revoked_at: string | null };
export type ExportApprovalVerifier = (request: SecurityAuthorizationRequest) => boolean;

export class SecurityAuthorizer {
  readonly audit: SecurityAuditLedger;

  constructor(
    readonly db: DatabaseSync,
    audit = new SecurityAuditLedger(db),
    readonly verifyExportApproval?: ExportApprovalVerifier,
  ) {
    this.audit = audit;
  }

  grant(raw: SecurityAclGrant): SecurityAclGrant {
    const grant = SecurityAclGrantSchema.parse(raw);
    this.db.prepare(`INSERT INTO security_acl_grants
      (grant_id, principal_id, principal_type, tenant_id, case_id, artifact_version_id, capability_id,
       actions_json, grant_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(grant.id, grant.principal.id, grant.principal.type, grant.tenantId, grant.caseId ?? null,
        grant.artifactVersionId ?? null, grant.capabilityId ?? null, canonicalJson(grant.actions),
        canonicalJson(grant), grant.expiresAt ?? null, grant.createdAt);
    this.audit.append({ eventType: "acl_granted", principal: grant.principal, tenantId: grant.tenantId,
      caseId: grant.caseId, capabilityId: grant.capabilityId, payload: { grantId: grant.id, actions: grant.actions }, at: grant.createdAt });
    return grant;
  }

  revoke(grantId: string, at: string): void {
    this.db.prepare("UPDATE security_acl_grants SET revoked_at = ? WHERE grant_id = ? AND revoked_at IS NULL").run(at, grantId);
  }

  grantEgress(raw: EgressGrant): EgressGrant {
    const grant = EgressGrantSchema.parse(raw);
    this.db.prepare(`INSERT INTO security_egress_grants
      (grant_id, principal_id, tenant_id, case_id, capability_id, domain, grant_json, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(grant.id, grant.principal.id, grant.tenantId, grant.caseId ?? null, grant.capabilityId,
        grant.domain, canonicalJson(grant), grant.expiresAt, grant.createdAt);
    this.audit.append({ eventType: "egress_granted", principal: grant.principal, tenantId: grant.tenantId,
      caseId: grant.caseId, capabilityId: grant.capabilityId, payload: { grantId: grant.id, domain: grant.domain }, at: grant.createdAt });
    return grant;
  }

  authorize(raw: SecurityAuthorizationRequest): SecurityDecision {
    const request = SecurityAuthorizationRequestSchema.parse(raw);
    const decision = this.decide(request);
    withSqliteSavepoint(this.db, "security_authorization_decision", () => {
      const auditEventId = this.audit.append({ eventType: "authorization_decision", principal: request.principal, tenantId: request.tenantId,
        caseId: request.caseId, capabilityId: request.capabilityId,
        payload: { decisionId: decision.id, decision: decision.decision, code: decision.code, action: request.action,
          artifactVersionId: request.artifactVersionId ?? null, destinationDomain: request.destinationDomain ?? null }, at: request.now });
      this.db.prepare(`INSERT INTO security_policy_decisions
        (decision_id, principal_id, principal_type, tenant_id, case_id, capability_id, action,
         artifact_version_id, decision, request_json, decision_json, audit_event_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(decision.id, request.principal.id, request.principal.type, request.tenantId,
          request.caseId ?? null, request.capabilityId, request.action, request.artifactVersionId ?? null,
          decision.decision, canonicalJson(request), canonicalJson(decision), auditEventId, decision.createdAt);
    });
    return decision;
  }

  authorizeOrThrow(request: SecurityAuthorizationRequest): SecurityDecision {
    const decision = this.authorize(request);
    if (decision.decision !== "allow") throw new Error(`${decision.code}: ${decision.reason}`);
    return decision;
  }

  private decide(request: SecurityAuthorizationRequest): SecurityDecision {
    const make = (decision: SecurityDecision["decision"], code: string, reason: string, matchedGrantIds: string[] = [], obligations: string[] = []) =>
      SecurityDecisionSchema.parse({ id: randomUUID(), decision, code, reason, matchedGrantIds, obligations, createdAt: request.now });
    if (request.principal.tenantId && request.principal.tenantId !== request.tenantId) {
      return make("deny", "tenant_scope_mismatch", "principal tenant does not match requested tenant");
    }
    if (request.taints.includes("malware_suspected")) return make("deny", "malware_taint", "malware-tainted content is quarantined");
    if (request.taints.includes("prompt_injection") && ["execute", "network", "export", "admin"].includes(request.action)) {
      return make("deny", "prompt_injection_capability_escalation", "untrusted content cannot expand execution, network, export, or admin authority");
    }
    const grants = (this.db.prepare(`SELECT grant_json, revoked_at FROM security_acl_grants
      WHERE principal_id = ? AND principal_type = ? AND tenant_id = ? AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at > ?)`)
      .all(request.principal.id, request.principal.type, request.tenantId, request.now) as unknown as AclRow[])
      .map((row) => SecurityAclGrantSchema.parse(JSON.parse(row.grant_json)))
      .filter((grant) => (!grant.caseId || grant.caseId === request.caseId)
        && (!grant.artifactVersionId || grant.artifactVersionId === request.artifactVersionId)
        && (!grant.capabilityId || grant.capabilityId === request.capabilityId)
        && grant.actions.includes(request.action));
    if (grants.length === 0) return make("deny", "acl_default_deny", "no matching principal/tenant/case/artifact/capability grant");

    if (request.action === "network") {
      const egress = (this.db.prepare(`SELECT grant_json, revoked_at FROM security_egress_grants
        WHERE principal_id = ? AND tenant_id = ? AND capability_id = ? AND domain = ?
          AND revoked_at IS NULL AND expires_at > ?`)
        .all(request.principal.id, request.tenantId, request.capabilityId, request.destinationDomain!, request.now) as unknown as EgressRow[])
        .map((row) => EgressGrantSchema.parse(JSON.parse(row.grant_json)))
        .filter((grant) => !grant.caseId || grant.caseId === request.caseId);
      if (egress.length === 0) return make("deny", "egress_default_deny", "no active domain-scoped egress grant", grants.map((g) => g.id));
      return make("allow", "authorized", "ACL and egress grants matched", [...grants.map((g) => g.id), ...egress.map((g) => g.id)]);
    }
    if (request.action === "export" && request.classification === "restricted"
      && (!request.approvalId || !this.verifyExportApproval?.(request))) {
      return make("require_approval", "restricted_export_approval", "restricted export requires an exact active approval", grants.map((g) => g.id), ["obtain_external_export_approval"]);
    }
    return make("allow", "authorized", "matching capability-level grant found", grants.map((g) => g.id));
  }
}
