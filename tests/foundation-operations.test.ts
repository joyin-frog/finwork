import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { BusinessCaseStore } from "../lib/case-management/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import { EvidenceLedger } from "../lib/evidence/ledger.ts";
import {
  exportFoundationEvidenceChain,
  getFoundationArtifact,
  getFoundationCase,
  listFoundationArtifacts,
  listFoundationCases,
  listFoundationClaims,
  loadGcPlan,
} from "../lib/observability/foundation-operations.ts";
import { TaskStore } from "../lib/task/store.ts";
import { authorizeEvidenceWrite, SecurityAuthorizer } from "../lib/security/index.ts";

const actor = { id: "local-user", type: "user" as const, tenantId: "local" };
const now = "2026-08-12T00:00:00.000Z";

function contract() {
  return {
    id: "task-ops", version: 3 as const, goal: "Manage an evidence backed case.",
    businessContext: {
      entities: [{ id: "entity-1", type: "company", name: "示例公司" }], counterparties: [],
      periods: [{ start: "2026-01-01", end: "2026-06-30", label: "2026H1" }],
      currencies: [{ code: "CNY" }], units: [{ code: "yuan" }], accountingStandards: ["CAS"], jurisdictions: ["CN"],
    },
    inputs: [], requiredCapabilities: [{ capabilityId: "fixture.read", versionRange: "^1.0.0" }], invariants: [],
    expectedOutputs: [], evidenceRequirements: [{ evidenceType: "source" as const, requiresLocator: true }],
    humanDecisionPoints: [], noGuess: [], noDegrade: [],
    security: { classification: "confidential" as const, allowedPrincipals: [actor], allowExternalEgress: false },
    retention: { policyId: "finance-default" }, budget: { wallTimeMs: 60_000, memoryBytes: 64 * 1024 * 1024 },
  };
}

export const foundationOperationsTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-foundation-ops-"));
  try {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    runMigrations(db, ":memory:", () => null);
    const tasks = new TaskStore(db);
    tasks.saveContract(contract());
    const caseId = tasks.createCase("task-ops", "case-ops", "run-ops");
    const cases = new BusinessCaseStore(db, () => new Date(now));
    cases.setCaseKind(caseId, "financial_consolidation", actor, "测试案件类型");
    cases.putNode({ id: "entity-1", caseId, kind: "entity", title: "示例公司", status: "active", data: {}, artifactVersionIds: [], evidenceIds: [] }, actor, "测试节点");

    const store = new ArtifactStore(db, root);
    const source = store.put({
      artifactId: "artifact-source", kind: "document", logicalName: "source.json", ownerCaseId: caseId,
      classification: "confidential", retention: { policyId: "finance-default" }, mediaType: "application/json",
      producer: { capabilityId: "fixture.read", version: "1.0.0" }, metadata: {},
      content: new TextEncoder().encode('{"value":1}'), state: "candidate",
    });
    const free = store.put({
      artifactId: "artifact-preview", kind: "preview", logicalName: "preview.png", ownerCaseId: caseId,
      classification: "internal", retention: {}, mediaType: "image/png", producer: {}, metadata: { reclaimable: true },
      content: new Uint8Array([1, 2, 3]), state: "candidate",
    });
    db.prepare("UPDATE artifact_versions SET created_at=? WHERE version_id=?").run("2026-01-01T00:00:00.000Z", free.versionId);

    const ledger = new EvidenceLedger(db);
    const authorizer = new SecurityAuthorizer(db);
    authorizer.grant({ id: "ops-source-write", principal: actor, tenantId: actor.tenantId,
      caseId, capabilityId: "fixture.read", actions: ["write"], createdAt: now });
    const policyDecisionId = authorizeEvidenceWrite({ authorizer, principal: actor, tenantId: actor.tenantId,
      caseId, capabilityId: "fixture.read", artifactVersionId: source.versionId,
      classification: "confidential", now });
    const evidence = ledger.addEvidence(caseId, {
      id: "evidence-source", type: "source", artifact: source,
      locator: { kind: "char_range", nodeId: "source", start: 0, end: 11 },
      producer: { capabilityId: "fixture.read", version: "1.0.0", attemptId: "attempt-ops" }, inputs: [], outputHash: source.sha256,
      confidence: 1, policyDecisionId, createdAt: now,
    });
    ledger.addClaim({ id: "claim-ops", caseId, statement: "来源数值为一。", structuredValue: { value: 1 }, evidenceRefs: [evidence.id], status: "verified" });
    ledger.addCitation({ id: "citation-ops", claimId: "claim-ops", artifactVersionId: source.versionId,
      locator: { kind: "char_range", nodeId: "source", start: 0, end: 11 }, quoteHash: "a".repeat(64), createdAt: now });

    assert.equal(listFoundationCases(db)[0]?.caseId, caseId);
    const caseSnapshot = getFoundationCase(db, caseId).snapshot;
    assert.equal(caseSnapshot.nodes[0]?.id, "entity-1");
    assert(!("title" in (caseSnapshot.nodes[0] ?? {})), "case snapshots must redact node titles");
    assert(!("data" in (caseSnapshot.nodes[0] ?? {})), "case snapshots must redact node payloads");
    assert(!JSON.stringify(caseSnapshot).includes("示例公司"), "case snapshots must not expose business content");
    const claim = listFoundationClaims(db)[0];
    assert.equal(claim?.claimId, "claim-ops");
    assert(!("statement" in (claim ?? {})), "claim lists must not expose statement content");
    const safeExport = exportFoundationEvidenceChain(db, "claim-ops");
    assert(!("statement" in safeExport.claim), "evidence exports must redact statements by default");
    assert(!("structuredValue" in safeExport.claim), "evidence exports must redact structured values by default");
    assert(!("inputs" in safeExport.evidence[0]!), "evidence exports must redact tool inputs by default");
    assert(!("uncertainty" in safeExport.evidence[0]!), "evidence exports must redact uncertainty details by default");
    assert(!("logicalName" in safeExport.evidence[0]!.artifact), "evidence exports must redact logical file names by default");
    assert.equal(exportFoundationEvidenceChain(db, "claim-ops", true).claim.statement, "来源数值为一。");
    assert.deepEqual(exportFoundationEvidenceChain(db, "claim-ops", true).claim.structuredValue, { value: 1 });
    assert.equal(safeExport.evidence[0]?.locator?.kind, "char_range");
    assert(!JSON.stringify(safeExport).includes("cas_uri"));
    assert(!JSON.stringify(safeExport).includes(root));

    assert.equal(listFoundationArtifacts(db, { caseId }).length, 2);
    const detail = getFoundationArtifact(db, "artifact-source");
    assert.equal(detail.versions[0]?.sha256, source.sha256);
    assert(!JSON.stringify(detail).includes("casUri"));
    assert(!JSON.stringify(detail).includes(root));

    const lifecycle = new (await import("../lib/file-lifecycle/service.ts")).ArtifactLifecycleService(db, root);
    const policy = { now, minimumAgeMs: 0, gracePeriodMs: 60_000, lowWatermarkBytes: null, actorId: "test:gc" };
    const plan = lifecycle.plan(policy);
    assert.deepEqual(plan.candidates.map((item) => item.artifactVersionId), [free.versionId]);
    const persisted = loadGcPlan(db, plan.runId);
    assert.equal(persisted.plan.candidates[0]?.artifactVersionId, free.versionId);
    lifecycle.tombstone(persisted.plan, persisted.policy);
    lifecycle.restore(free.versionId, "local-user", now);
    assert.equal(getFoundationArtifact(db, "artifact-preview").versions[0]?.state, "archived");
    db.close();
    console.log("foundation-operations: redacted read models, evidence export and lifecycle actions passed ✓");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();
