import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { runMigrations } from "../lib/db/migrations.ts";
import { sha256Json } from "../lib/capability/hash.ts";
import { TaskStore } from "../lib/task/index.ts";
import { ArtifactStore } from "../lib/artifacts/index.ts";
import { EvidenceLedger } from "../lib/evidence/index.ts";
import { authorizeEvidenceWrite, SecurityAuthorizer } from "../lib/security/index.ts";

const HASH = "a".repeat(64);

function makeDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  runMigrations(db, ":memory:", () => null);
  return db;
}

function taskContract(taskId: string) {
  return {
    id: taskId,
    version: 3 as const,
    goal: "Produce a validated, evidence-backed finance artifact.",
    businessContext: {
      entities: [{ id: "entity-1", type: "company", name: "示例公司" }],
      counterparties: [],
      periods: [{ start: "2026-01-01", end: "2026-06-30", label: "2026H1" }],
      currencies: [{ code: "CNY" }],
      units: [{ code: "yuan" }],
      accountingStandards: ["CAS"],
      jurisdictions: ["CN"],
    },
    inputs: [],
    requiredCapabilities: [{ capabilityId: "fixture.read", versionRange: "^1.0.0" }],
    invariants: [{ id: "balance-check", validatorId: "accounting.equation", severity: "blocking" as const, parameters: {} }],
    expectedOutputs: [{
      id: "result",
      mediaType: "application/json",
      logicalName: "result.json",
      validatorIds: ["accounting.equation"],
    }],
    evidenceRequirements: [
      { evidenceType: "source" as const, requiresLocator: true },
      { evidenceType: "assertion" as const },
      { evidenceType: "delivery" as const },
    ],
    humanDecisionPoints: [],
    noGuess: ["entity", "period", "currency"],
    noDegrade: ["fixture.read", "evidence.delivery"],
    security: {
      classification: "confidential" as const,
      allowedPrincipals: [{ id: "user-1", type: "user" as const, tenantId: "tenant-1" }],
      allowExternalEgress: false,
    },
    retention: { policyId: "finance-default" },
    budget: { wallTimeMs: 60_000, memoryBytes: 512 * 1024 * 1024 },
  };
}

export const taskArtifactEvidenceKernelTestPromise = (async () => {
  const db = makeDb();
  const taskStore = new TaskStore(db);
  taskStore.saveContract(taskContract("task-kernel"));
  const caseId = taskStore.createCase("task-kernel", "case-kernel", "run-kernel");
  const now = new Date().toISOString();
  const nodeA = { id: "node-a", capabilityId: "fixture.read", capabilityVersion: "1.0.0", status: "pending" as const, input: { part: "a" }, inputHash: sha256Json({ part: "a" }), ordinal: 0 };
  const nodeB = { id: "node-b", capabilityId: "fixture.read", capabilityVersion: "1.0.0", status: "pending" as const, input: { part: "b" }, inputHash: sha256Json({ part: "b" }), ordinal: 1 };
  taskStore.savePlan({ caseId, version: 1, nodes: [nodeA, nodeB], edges: [{ from: "node-a", to: "node-b", type: "depends_on" }], createdAt: now });
  assert.deepEqual(taskStore.listReadyNodes(caseId).map((node) => node.id), ["node-a"]);
  taskStore.updateNodeStatus("node-a", "running");
  assert.throws(
    () => taskStore.savePlan({ caseId, version: 2, nodes: [nodeA], edges: [], createdAt: now }),
    /cannot replace an executing or historical plan/,
  );
  taskStore.updateNodeStatus("node-a", "succeeded", { ok: true });
  assert.deepEqual(taskStore.listReadyNodes(caseId).map((node) => node.id), ["node-b"]);
  assert.throws(
    () => taskStore.savePlan({
      caseId,
      version: 2,
      nodes: [nodeA, nodeB],
      edges: [
        { from: "node-a", to: "node-b", type: "depends_on" },
        { from: "node-b", to: "node-a", type: "depends_on" },
      ],
      createdAt: now,
    }),
    /dependency cycle/,
  );
  assert.throws(() => taskStore.transitionCase(caseId, "delivered"), /illegal case state transition/);
  taskStore.transitionCase(caseId, "preflight");
  taskStore.transitionCase(caseId, "planned");
  taskStore.transitionCase(caseId, "running");
  const checkpoint = taskStore.saveCheckpoint(caseId, { completed: ["node-a"] });
  assert.equal(taskStore.restoreLatestCheckpoint(caseId)?.snapshotHash, checkpoint.snapshotHash);
  db.prepare("UPDATE case_checkpoints SET snapshot_json = ? WHERE checkpoint_id = ?")
    .run(JSON.stringify({ completed: [] }), checkpoint.id);
  assert.throws(() => taskStore.restoreLatestCheckpoint(caseId), /integrity mismatch/);

  const casRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-cas-kernel-"));
  try {
    const artifacts = new ArtifactStore(db, casRoot);
    const first = artifacts.put({
      artifactId: "artifact-kernel",
      kind: "document",
      logicalName: "source.json",
      ownerCaseId: caseId,
      classification: "confidential",
      retention: { policyId: "finance-default" },
      mediaType: "application/json",
      producer: { capabilityId: "fixture.read", version: "1.0.0", attemptId: "attempt-1" },
      content: new TextEncoder().encode('{"value":1}'),
      state: "staging",
    });
    assert.equal(new TextDecoder().decode(artifacts.read(first.versionId)), '{"value":1}');
    const candidate = artifacts.transition(first.artifactId, "candidate");
    const delivered = artifacts.transition(first.artifactId, "delivered");
    assert.equal(delivered.state, "delivered");
    assert.throws(() => artifacts.put({
      artifactId: first.artifactId,
      kind: "document",
      logicalName: "changed.json",
      ownerCaseId: caseId,
      classification: "confidential",
      retention: { policyId: "finance-default" },
      mediaType: "application/json",
      producer: {},
      content: new TextEncoder().encode('{}'),
    }), /immutable after delivery/);

    const ledger = new EvidenceLedger(db);
    const principal = { id: "user-1", type: "user" as const, tenantId: "tenant-1" };
    const authorizer = new SecurityAuthorizer(db);
    authorizer.grant({ id: "kernel-source-write", principal, tenantId: "tenant-1", caseId,
      capabilityId: "fixture.read", actions: ["write"], createdAt: now });
    const policyDecisionId = authorizeEvidenceWrite({ authorizer, principal, tenantId: "tenant-1", caseId,
      capabilityId: "fixture.read", artifactVersionId: candidate.versionId,
      classification: "confidential", now });
    assert.throws(() => ledger.addEvidence(caseId, {
      id: "evidence-forged", type: "source", artifact: candidate,
      locator: { kind: "char_range", nodeId: "source-node", start: 0, end: 11 },
      producer: { capabilityId: "fixture.read", version: "1.0.0", attemptId: "attempt-1" },
      inputs: [], outputHash: candidate.sha256, confidence: 1,
      policyDecisionId: "forged-policy-decision", createdAt: now,
    }), /policy decision not found/);
    const evidence = ledger.addEvidence(caseId, {
      id: "evidence-source",
      type: "source",
      artifact: candidate,
      locator: { kind: "char_range", nodeId: "source-node", start: 0, end: 11 },
      producer: { capabilityId: "fixture.read", version: "1.0.0", attemptId: "attempt-1" },
      inputs: [],
      outputHash: candidate.sha256,
      confidence: 1,
      policyDecisionId,
      createdAt: now,
    });
    ledger.addClaim({
      id: "claim-1",
      caseId,
      statement: "The source value is one.",
      structuredValue: { value: 1 },
      evidenceRefs: [evidence.id],
      status: "verified",
    });
    ledger.addCitation({
      id: "citation-1",
      claimId: "claim-1",
      artifactVersionId: candidate.versionId,
      locator: { kind: "char_range", nodeId: "source-node", start: 0, end: 11 },
      quoteHash: HASH,
      createdAt: now,
    });
    assert.throws(() => ledger.assertDeliveryGate(caseId), /balance-check:missing/);
    ledger.recordAssertion({
      caseId,
      assertionId: "balance-check",
      validatorId: "accounting.equation",
      status: "unverified",
      blocking: true,
      evidenceId: evidence.id,
    });
    assert.throws(() => ledger.assertDeliveryGate(caseId), /balance-check:unverified/);
    ledger.recordAssertion({
      caseId,
      assertionId: "balance-check",
      validatorId: "accounting.equation",
      status: "passed",
      blocking: true,
      evidenceId: evidence.id,
    });
    ledger.assertDeliveryGate(caseId);
    const completion = ledger.buildCompletionEvidence(caseId);
    assert.deepEqual(completion.evidenceIds, ["evidence-source"]);
    assert.deepEqual(completion.verifiedClaimIds, ["claim-1"]);
    assert.deepEqual(completion.passedAssertionIds, ["balance-check"]);
  } finally {
    rmSync(casRoot, { recursive: true, force: true });
  }

  db.close();
  console.log("task-artifact-evidence-kernel: DAG, checkpoint, CAS and delivery-gate checks passed ✓");
})();

if (process.argv[1]?.includes("task-artifact-evidence-kernel.test")) {
  taskArtifactEvidenceKernelTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
