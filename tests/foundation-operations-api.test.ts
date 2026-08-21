import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

const savedEnv = {
  dbPath: process.env.FINANCE_AGENT_DB_PATH,
  appData: process.env.FINANCE_AGENT_APP_DATA_DIR,
};
const appData = mkdtempSync(path.join(os.tmpdir(), "finwork-foundation-api-"));
process.env.FINANCE_AGENT_DB_PATH = path.join(appData, "foundation-api.db");
process.env.FINANCE_AGENT_APP_DATA_DIR = appData;

function restoreEnv(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function request(url: string, init?: { method?: string; body?: unknown; trusted?: boolean }) {
  const trusted = init?.trusted ?? true;
  const origin = trusted ? "http://localhost" : "https://evil.example";
  return new NextRequest(url, {
    method: init?.method ?? "GET",
    headers: {
      origin,
      "sec-fetch-site": trusted ? "same-origin" : "cross-site",
      ...(init?.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(init?.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
}

async function json(response: Response): Promise<{ ok: boolean; data?: any; error?: string }> {
  return await response.json() as { ok: boolean; data?: any; error?: string };
}

export const foundationOperationsApiTestPromise = (async () => {
  try {
    const [{ getDb }, { ArtifactStore }, { TaskStore }, { BusinessCaseStore }, { EvidenceLedger }, security] = await Promise.all([
      import("../lib/db/sqlite.ts"),
      import("../lib/artifacts/store.ts"),
      import("../lib/task/store.ts"),
      import("../lib/case-management/store.ts"),
      import("../lib/evidence/ledger.ts"),
      import("../lib/security/index.ts"),
    ]);
    const [{ GET: getCases }, { GET: getEvidence }, { GET: getArtifacts, POST: postArtifacts }] = await Promise.all([
      import("../app/api/capability-foundation/cases/route.ts"),
      import("../app/api/capability-foundation/evidence/route.ts"),
      import("../app/api/capability-foundation/artifacts/route.ts"),
    ]);

    const db = getDb();
    const actor = { id: "local-user", type: "user" as const, tenantId: "local" };
    const tasks = new TaskStore(db);
    tasks.saveContract({
      id: "task-api", version: 3, goal: "验证生产治理接口",
      businessContext: {
        entities: [{ id: "entity-api", type: "company", name: "敏感企业名称" }], counterparties: [],
        periods: [{ start: "2026-01-01", end: "2026-06-30", label: "2026H1" }],
        currencies: [{ code: "CNY" }], units: [{ code: "yuan" }], accountingStandards: ["CAS"], jurisdictions: ["CN"],
      },
      inputs: [], requiredCapabilities: [{ capabilityId: "fixture.read", versionRange: "^1.0.0" }], invariants: [],
      expectedOutputs: [], evidenceRequirements: [{ evidenceType: "source", requiresLocator: true }],
      humanDecisionPoints: [], noGuess: [], noDegrade: [],
      security: { classification: "confidential", allowedPrincipals: [actor], allowExternalEgress: false },
      retention: { policyId: "finance-default" }, budget: { wallTimeMs: 60_000, memoryBytes: 64 * 1024 * 1024 },
    });
    const caseId = tasks.createCase("task-api", "case-api", "run-api");
    const cases = new BusinessCaseStore(db);
    cases.setCaseKind(caseId, "financial_consolidation", actor, "设置案件类型");
    cases.putNode({
      id: "entity-api", caseId, kind: "entity", title: "敏感企业名称", status: "active",
      data: { account: "6222020200012345678" }, artifactVersionIds: [], evidenceIds: [],
    }, actor, "创建敏感业务节点");

    const artifacts = new ArtifactStore(db, path.join(appData, "artifacts", "cas"));
    const source = artifacts.put({
      artifactId: "artifact-api-source", kind: "document", logicalName: "敏感来源.json", ownerCaseId: caseId,
      classification: "confidential", retention: { policyId: "finance-default" }, mediaType: "application/json",
      producer: { capabilityId: "fixture.read", version: "1.0.0", attemptId: "attempt-api" }, metadata: {},
      content: new TextEncoder().encode('{"secret":"仅显式导出可见"}'), state: "candidate",
    });
    const reclaimable = ["restore", "delete"].map((suffix) => artifacts.put({
      artifactId: `artifact-api-${suffix}`, kind: "preview", logicalName: `预览-${suffix}.png`, ownerCaseId: caseId,
      classification: "internal", retention: {}, mediaType: "image/png", producer: { capabilityId: "preview", version: "1.0.0" },
      metadata: { reclaimable: true }, content: new Uint8Array([1, 2, suffix.length]), state: "candidate",
    }));
    for (const ref of reclaimable) {
      db.prepare("UPDATE artifact_versions SET created_at=? WHERE version_id=?")
        .run("2026-01-01T00:00:00.000Z", ref.versionId);
    }

    const ledger = new EvidenceLedger(db);
    const authorizer = new security.SecurityAuthorizer(db);
    authorizer.grant({ id: "api-source-write", principal: actor, tenantId: actor.tenantId, caseId,
      capabilityId: "fixture.read", actions: ["write"], createdAt: "2026-08-12T00:00:00.000Z" });
    const policyDecisionId = security.authorizeEvidenceWrite({ authorizer, principal: actor, tenantId: actor.tenantId,
      caseId, capabilityId: "fixture.read", artifactVersionId: source.versionId,
      classification: "confidential", now: "2026-08-12T00:00:00.000Z" });
    const evidence = ledger.addEvidence(caseId, {
      id: "evidence-api", type: "source", artifact: source,
      locator: { kind: "char_range", nodeId: "source", start: 0, end: 20 },
      producer: { capabilityId: "fixture.read", version: "1.0.0", attemptId: "attempt-api" },
      inputs: [{ evidenceId: "upstream-evidence", outputHash: "c".repeat(64) }],
      outputHash: source.sha256, confidence: 1,
      policyDecisionId, createdAt: "2026-08-12T00:00:00.000Z",
    });
    ledger.addClaim({
      id: "claim-api", caseId, statement: "敏感结论正文", structuredValue: { amount: 100 },
      evidenceRefs: [evidence.id], status: "verified",
    });
    ledger.addCitation({
      id: "citation-api", claimId: "claim-api", artifactVersionId: source.versionId,
      locator: { kind: "char_range", nodeId: "source", start: 0, end: 20 },
      quoteHash: "b".repeat(64), createdAt: "2026-08-12T00:00:00.000Z",
    });

    const rejected = await getCases(request("https://evil.example/api/capability-foundation/cases", { trusted: false }));
    assert.equal(rejected.status, 403, "non-loopback cross-site requests must be rejected");

    const caseList = await json(await getCases(request("http://localhost/api/capability-foundation/cases")));
    assert.equal(caseList.ok, true);
    assert.equal(caseList.data.cases[0].caseId, caseId);
    const caseDetail = await json(await getCases(request(`http://localhost/api/capability-foundation/cases?caseId=${caseId}`)));
    const casePayload = JSON.stringify(caseDetail.data);
    assert(!casePayload.includes("敏感企业名称"));
    assert(!casePayload.includes("6222020200012345678"));
    assert.equal(caseDetail.data.snapshot.nodes[0].id, "entity-api");

    const claimList = await json(await getEvidence(request("http://localhost/api/capability-foundation/evidence")));
    assert.equal(claimList.data.claims[0].claimId, "claim-api");
    assert(!JSON.stringify(claimList.data).includes("敏感结论正文"));
    const safeEvidence = await json(await getEvidence(request("http://localhost/api/capability-foundation/evidence?claimId=claim-api")));
    assert(!JSON.stringify(safeEvidence.data).includes("敏感结论正文"));
    assert(!JSON.stringify(safeEvidence.data).includes("敏感来源.json"));
    assert(!JSON.stringify(safeEvidence.data).includes("cas://"));
    const explicitEvidenceResponse = await getEvidence(request("http://localhost/api/capability-foundation/evidence?claimId=claim-api&includeContent=true&download=true"));
    const explicitEvidence = await json(explicitEvidenceResponse);
    assert.equal(explicitEvidence.data.claim.statement, "敏感结论正文");
    assert.equal(explicitEvidenceResponse.headers.get("content-disposition"), 'attachment; filename="evidence-claim-api.json"');

    const artifactList = await json(await getArtifacts(request(`http://localhost/api/capability-foundation/artifacts?caseId=${caseId}`)));
    assert.equal(artifactList.data.artifacts.length, 3);
    assert(!JSON.stringify(artifactList.data).includes("cas://"));
    const artifactDetail = await json(await getArtifacts(request("http://localhost/api/capability-foundation/artifacts?artifactId=artifact-api-source")));
    assert.equal(artifactDetail.data.versions[0].sha256, source.sha256);
    assert(!JSON.stringify(artifactDetail.data).includes("cas://"));

    const hold = await json(await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "hold", versionId: source.versionId, type: "pin", reason: "用户明确保留" },
    })));
    assert.match(hold.data.holdId, /^[0-9a-f-]{36}$/i);
    const heldDetail = await json(await getArtifacts(request("http://localhost/api/capability-foundation/artifacts?artifactId=artifact-api-source")));
    assert.equal(heldDetail.data.holds[0].reason, "用户明确保留");
    assert.equal((await json(await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "release_hold", holdId: hold.data.holdId },
    })))).ok, true);

    const dryRun = await json(await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "dry_run", minimumAgeMs: 0, gracePeriodMs: 0, lowWatermarkBytes: null },
    })));
    assert.deepEqual(
      dryRun.data.plan.candidates.map((item: { artifactVersionId: string }) => item.artifactVersionId).sort(),
      reclaimable.map((item) => item.versionId).sort(),
    );
    assert.equal((await json(await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "tombstone", runId: dryRun.data.plan.runId },
    })))).ok, true);
    assert.equal((await json(await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "restore", versionId: reclaimable[0].versionId },
    })))).ok, true);
    assert.equal((await json(await getArtifacts(request("http://localhost/api/capability-foundation/artifacts?artifactId=artifact-api-restore")))).data.versions[0].state, "archived");

    const badSweep = await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "sweep", confirm: "no" },
    }));
    assert.equal(badSweep.status, 400, "physical deletion must require the exact confirmation phrase");
    const sweep = await json(await postArtifacts(request("http://localhost/api/capability-foundation/artifacts", {
      method: "POST", body: { action: "sweep", confirm: "DELETE_EXPIRED_ARTIFACTS" },
    })));
    assert.equal(sweep.data.deleted, 1);
    const deleted = await getArtifacts(request("http://localhost/api/capability-foundation/artifacts?artifactId=artifact-api-delete"));
    assert.equal(deleted.status, 404);

    console.log("foundation-operations-api: trust boundary, redaction, evidence export and lifecycle routes passed ✓");
  } finally {
    restoreEnv("FINANCE_AGENT_DB_PATH", savedEnv.dbPath);
    restoreEnv("FINANCE_AGENT_APP_DATA_DIR", savedEnv.appData);
    rmSync(appData, { recursive: true, force: true });
  }
})();
