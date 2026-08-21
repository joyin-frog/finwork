import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { canonicalJson } from "@/lib/capability/hash";
import { withSqliteSavepoint } from "@/lib/db/transaction";
import {
  CitationRecordSchema,
  ClaimSchema,
  EvidenceRecordSchema,
  type CitationRecord,
  type Claim,
  type EvidenceRecord,
} from "./contracts";

export class EvidenceLedger {
  constructor(readonly db: DatabaseSync) {}

  addEvidence(caseId: string, rawRecord: EvidenceRecord): EvidenceRecord {
    const record = EvidenceRecordSchema.parse(rawRecord);
    const authorization = this.db.prepare(`
      SELECT case_id, capability_id, action, artifact_version_id, decision
      FROM security_policy_decisions WHERE decision_id = ?
    `).get(record.policyDecisionId) as {
      case_id: string | null;
      capability_id: string;
      action: string;
      artifact_version_id: string | null;
      decision: string;
    } | undefined;
    if (!authorization) throw new Error(`evidence policy decision not found: ${record.policyDecisionId}`);
    if (authorization.decision !== "allow") {
      throw new Error(`evidence policy decision is not allowed: ${record.policyDecisionId}:${authorization.decision}`);
    }
    if (authorization.case_id !== caseId
      || authorization.capability_id !== record.producer.capabilityId
      || authorization.action !== "write"
      || authorization.artifact_version_id !== record.artifact.versionId) {
      throw new Error(`evidence policy decision scope mismatch: ${record.policyDecisionId}`);
    }
    this.db.prepare(`
      INSERT INTO evidence_records
        (evidence_id, case_id, evidence_type, artifact_version_id, locator_json, producer_json,
         input_refs_json, output_hash, confidence, uncertainty_json, policy_decision_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      record.id,
      caseId,
      record.type,
      record.artifact.versionId,
      record.locator ? canonicalJson(record.locator) : null,
      canonicalJson(record.producer),
      canonicalJson(record.inputs),
      record.outputHash,
      record.confidence ?? null,
      record.uncertainty ? canonicalJson(record.uncertainty) : null,
      record.policyDecisionId,
      record.createdAt,
    );
    return record;
  }

  addClaim(rawClaim: Claim): Claim {
    const claim = ClaimSchema.parse(rawClaim);
    const now = new Date().toISOString();
    withSqliteSavepoint(this.db, "evidence_claim", () => {
      this.db.prepare(`
        INSERT INTO claims(claim_id, case_id, statement, structured_json, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        claim.id,
        claim.caseId,
        claim.statement,
        claim.structuredValue === undefined ? null : canonicalJson(claim.structuredValue),
        claim.status,
        now,
        now,
      );
      const link = this.db.prepare(`
        INSERT INTO claim_evidence(claim_id, evidence_id, role, created_at) VALUES (?, ?, 'supports', ?)
      `);
      for (const evidenceId of claim.evidenceRefs) link.run(claim.id, evidenceId, now);
    });
    return claim;
  }

  addCitation(rawCitation: CitationRecord): CitationRecord {
    const citation = CitationRecordSchema.parse(rawCitation);
    this.db.prepare(`
      INSERT INTO citation_records
        (citation_id, claim_id, artifact_version_id, locator_json, quote_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      citation.id,
      citation.claimId,
      citation.artifactVersionId,
      canonicalJson(citation.locator),
      citation.quoteHash,
      citation.createdAt,
    );
    return citation;
  }

  recordAssertion(request: {
    caseId: string;
    assertionId: string;
    validatorId: string;
    status: "passed" | "failed" | "unverified" | "not_applicable";
    blocking: boolean;
    evidenceId?: string;
    details?: unknown;
  }): void {
    this.db.prepare(`
      INSERT INTO assertion_results
        (assertion_id, case_id, validator_id, status, blocking, evidence_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(case_id, assertion_id) DO UPDATE SET
        validator_id=excluded.validator_id,
        status=excluded.status,
        blocking=excluded.blocking,
        evidence_id=excluded.evidence_id,
        details_json=excluded.details_json,
        created_at=excluded.created_at
    `).run(
      request.assertionId,
      request.caseId,
      request.validatorId,
      request.status,
      request.blocking ? 1 : 0,
      request.evidenceId ?? null,
      canonicalJson(request.details ?? {}),
      new Date().toISOString(),
    );
  }

  assertDeliveryGate(caseId: string): void {
    const contractRow = this.db.prepare(`
      SELECT tc.contract_json
      FROM cases c JOIN task_contracts tc ON tc.task_id = c.task_id
      WHERE c.case_id = ?
    `).get(caseId) as { contract_json: string } | undefined;
    if (!contractRow) throw new Error(`case or task contract not found: ${caseId}`);
    const contract = JSON.parse(contractRow.contract_json) as {
      invariants?: Array<{ id: string; severity: string }>;
    };
    const requiredBlocking = (contract.invariants ?? [])
      .filter((invariant) => invariant.severity === "blocking")
      .map((invariant) => invariant.id);
    if (requiredBlocking.length > 0) {
      const placeholders = requiredBlocking.map(() => "?").join(",");
      const rows = this.db.prepare(`
        SELECT assertion_id, status FROM assertion_results
        WHERE case_id = ? AND assertion_id IN (${placeholders})
      `).all(caseId, ...requiredBlocking) as Array<{ assertion_id: string; status: string }>;
      const statusById = new Map(rows.map((row) => [row.assertion_id, row.status]));
      const missingOrFailed = requiredBlocking.filter((id) => statusById.get(id) !== "passed");
      if (missingOrFailed.length > 0) {
        throw new Error(
          `delivery blocked by required assertions: ${missingOrFailed
            .map((id) => `${id}:${statusById.get(id) ?? "missing"}`)
            .join(", ")}`,
        );
      }
    }
    const blocking = this.db.prepare(`
      SELECT assertion_id, status FROM assertion_results
      WHERE case_id = ? AND blocking = 1 AND status <> 'passed'
      ORDER BY assertion_id
    `).all(caseId) as Array<{ assertion_id: string; status: string }>;
    if (blocking.length > 0) {
      throw new Error(`delivery blocked by assertions: ${blocking.map((item) => `${item.assertion_id}:${item.status}`).join(", ")}`);
    }
  }

  buildCompletionEvidence(caseId: string): {
    id: string;
    caseId: string;
    evidenceIds: string[];
    verifiedClaimIds: string[];
    passedAssertionIds: string[];
  } {
    const evidenceIds = (this.db.prepare(`
      SELECT evidence_id FROM evidence_records WHERE case_id = ? ORDER BY created_at, evidence_id
    `).all(caseId) as Array<{ evidence_id: string }>).map((row) => row.evidence_id);
    const verifiedClaimIds = (this.db.prepare(`
      SELECT claim_id FROM claims WHERE case_id = ? AND status = 'verified' ORDER BY claim_id
    `).all(caseId) as Array<{ claim_id: string }>).map((row) => row.claim_id);
    const passedAssertionIds = (this.db.prepare(`
      SELECT assertion_id FROM assertion_results WHERE case_id = ? AND status = 'passed' ORDER BY assertion_id
    `).all(caseId) as Array<{ assertion_id: string }>).map((row) => row.assertion_id);
    return { id: randomUUID(), caseId, evidenceIds, verifiedClaimIds, passedAssertionIds };
  }
}
