import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";

export type IntegrityVerification = { passed: boolean; failures: string[] };

export function verifyArtifactIntegrity(db: DatabaseSync, casRoot: string, versionIds: string[]): IntegrityVerification {
  const failures: string[] = [];
  const query = db.prepare(`
    SELECT v.version_id,v.sha256,v.state,a.lifecycle_state
    FROM artifact_versions v JOIN artifacts a ON a.artifact_id=v.artifact_id
    WHERE v.version_id=?
  `);
  for (const versionId of versionIds) {
    const row = query.get(versionId) as { version_id: string; sha256: string; state: string; lifecycle_state: string } | undefined;
    if (!row) { failures.push(`artifact_missing:${versionId}`); continue; }
    const blob = path.join(casRoot, row.sha256.slice(0, 2), row.sha256);
    if (!fs.existsSync(blob)) { failures.push(`artifact_blob_missing:${versionId}`); continue; }
    const hash = createHash("sha256").update(fs.readFileSync(blob)).digest("hex");
    if (hash !== row.sha256) failures.push(`artifact_hash_mismatch:${versionId}`);
    if (row.state === "tombstoned" || row.lifecycle_state === "tombstoned") failures.push(`artifact_tombstoned:${versionId}`);
  }
  return { passed: failures.length === 0, failures };
}

export function verifyEvidenceIntegrity(db: DatabaseSync, caseId: string, requiredTypes: string[]): IntegrityVerification {
  const failures: string[] = [];
  const records = db.prepare(`
    SELECT evidence_id,evidence_type,artifact_version_id,locator_json,output_hash
    FROM evidence_records WHERE case_id=?
  `).all(caseId) as Array<{ evidence_id: string; evidence_type: string; artifact_version_id: string; locator_json: string | null; output_hash: string }>;
  const byType = new Map<string, number>();
  for (const record of records) {
    byType.set(record.evidence_type, (byType.get(record.evidence_type) ?? 0) + 1);
    if (!record.artifact_version_id) failures.push(`evidence_artifact_missing:${record.evidence_id}`);
    if (record.evidence_type === "source" && !record.locator_json) failures.push(`source_locator_missing:${record.evidence_id}`);
    if (!/^[a-f0-9]{64}$/i.test(record.output_hash)) failures.push(`evidence_hash_invalid:${record.evidence_id}`);
  }
  for (const type of requiredTypes) if (!byType.get(type)) failures.push(`evidence_type_missing:${type}`);
  const claims = db.prepare(`SELECT claim_id,status FROM claims WHERE case_id=?`).all(caseId) as Array<{ claim_id: string; status: string }>;
  for (const claim of claims) {
    const links = db.prepare(`SELECT COUNT(*) AS n FROM claim_evidence WHERE claim_id=?`).get(claim.claim_id) as { n: number };
    if (links.n === 0) failures.push(`claim_evidence_missing:${claim.claim_id}`);
    if (claim.status === "verified") {
      const citations = db.prepare(`SELECT COUNT(*) AS n FROM citation_records WHERE claim_id=?`).get(claim.claim_id) as { n: number };
      if (citations.n === 0) failures.push(`verified_claim_citation_missing:${claim.claim_id}`);
    }
  }
  return { passed: failures.length === 0, failures };
}
