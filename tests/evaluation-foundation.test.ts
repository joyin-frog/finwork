import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { ArtifactStore } from "../lib/artifacts/index.ts";
import { EvidenceLedger } from "../lib/evidence/index.ts";
import { EvaluationRunner, GOLDEN_MANIFESTS, classifyFault } from "../lib/evaluation/index.ts";
import { TaskStore } from "../lib/task/index.ts";
import { authorizeEvidenceWrite, SecurityAuthorizer } from "../lib/security/index.ts";

const HASH = "b".repeat(64);

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

export const evaluationFoundationTestPromise = (async () => {
  const expectedDomains = new Map([
    ["model_invalid_output", "model"],
    ["capability_missing", "capability"],
    ["dependency_unavailable", "dependency"],
    ["deterministic_validation_failed", "validator"],
    ["policy_blocked", "policy"],
    ["resource_exhausted", "resource"],
    ["evaluator_error", "evaluator"],
  ]);
  for (const [kind, domain] of expectedDomains) assert.equal(classifyFault({ kind }), domain);

  const db = makeDb();
  const casRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-evaluation-"));
  try {
    const tasks = new TaskStore(db);
    const artifacts = new ArtifactStore(db, casRoot);
    const ledger = new EvidenceLedger(db);
    const runner = new EvaluationRunner(db, casRoot);
    const authorizer = new SecurityAuthorizer(db);

    for (const manifest of GOLDEN_MANIFESTS) {
      const caseId = manifest.taskContract.caseId;
      assert.ok(caseId);
      tasks.saveContract(manifest.taskContract);
      tasks.createCase(manifest.taskContract.id, caseId, `${manifest.id}.run`);

      const artifact = artifacts.put({
        artifactId: `${manifest.id}.artifact`,
        kind: "evaluation-deliverable",
        logicalName: manifest.taskContract.expectedOutputs[0]!.logicalName,
        ownerCaseId: caseId,
        classification: "confidential",
        retention: manifest.taskContract.retention,
        mediaType: manifest.taskContract.expectedOutputs[0]!.mediaType,
        producer: { capabilityId: "artifact.deliver", version: "1.0.0", attemptId: `${manifest.id}.attempt` },
        content: new TextEncoder().encode(JSON.stringify({ manifest: manifest.id, verified: true })),
        state: "candidate",
      });
      const delivered = artifacts.transition(artifact.artifactId, "delivered");
      const createdAt = new Date().toISOString();
      const principal = manifest.taskContract.security.allowedPrincipals[0]!;
      authorizer.grant({ id: `${manifest.id}.fixture-write`, principal, tenantId: principal.tenantId!, caseId,
        capabilityId: "evaluation.fixture", actions: ["write"], createdAt });
      const evidenceIds: string[] = [];
      for (const type of manifest.expectedEvidenceTypes) {
        const id = `${manifest.id}.evidence.${type}`;
        ledger.addEvidence(caseId, {
          id,
          type,
          artifact: delivered,
          ...(type === "source" ? { locator: { kind: "char_range" as const, nodeId: "source-1", start: 0, end: 8 } } : {}),
          producer: { capabilityId: "evaluation.fixture", version: "1.0.0", attemptId: `${manifest.id}.attempt` },
          inputs: [],
          outputHash: delivered.sha256,
          confidence: 1,
          policyDecisionId: authorizeEvidenceWrite({ authorizer, principal, tenantId: principal.tenantId!, caseId,
            capabilityId: "evaluation.fixture", artifactVersionId: delivered.versionId,
            classification: "confidential", now: createdAt }),
          createdAt,
        });
        evidenceIds.push(id);
      }
      const claimId = `${manifest.id}.claim`;
      ledger.addClaim({ id: claimId, caseId, statement: `${manifest.name} 已由确定性门禁验证。`, structuredValue: { verified: true }, evidenceRefs: evidenceIds, status: "verified" });
      ledger.addCitation({
        id: `${manifest.id}.citation`,
        claimId,
        artifactVersionId: delivered.versionId,
        locator: { kind: "char_range", nodeId: "source-1", start: 0, end: 8 },
        quoteHash: HASH,
        createdAt,
      });
      for (const invariant of manifest.taskContract.invariants) {
        ledger.recordAssertion({ caseId, assertionId: invariant.id, validatorId: invariant.validatorId, status: "passed", blocking: invariant.severity === "blocking", evidenceId: evidenceIds[0] });
      }
      ledger.assertDeliveryGate(caseId);

      const result = await runner.run(manifest, async () => ({
        artifactVersionIds: [delivered.versionId],
        evidenceIds,
        claimIds: [claimId],
        passedAssertionIds: manifest.assertions.map((assertion) => assertion.id),
        dimensions: { contract: 1, artifact: 1, evidence: 1, memory: 1, rag: 1, security: 1, performance: 1 },
        metrics: { elapsedMs: 1 },
        details: { fixture: true },
      }));
      assert.equal(result.status, "passed", `${manifest.id}: ${result.failures.join(",")}`);
      assert.equal(result.scorecards.length, 7);
      assert.ok(result.scorecards.every((scorecard) => scorecard.passed));
    }

    const counts = db.prepare("SELECT status,COUNT(*) AS n FROM evaluation_runs GROUP BY status").all() as Array<{ status: string; n: number }>;
    assert.equal(counts.length, 1);
    assert.equal(counts[0]?.status, "passed");
    assert.equal(counts[0]?.n, 4);
  } finally {
    db.close();
    rmSync(casRoot, { recursive: true, force: true });
  }
  console.log("evaluation-foundation: four Golden cases and seven fault domains passed ✓");
})();

if (process.argv[1]?.includes("evaluation-foundation.test")) {
  evaluationFoundationTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
