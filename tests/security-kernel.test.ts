import assert from "node:assert/strict";
import fs, { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { z } from "zod";
import JSZip from "jszip";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { runMigrations } from "../lib/db/migrations.ts";
import {
  ExternalExportService,
  InMemorySecretBackend,
  QuarantineService,
  SecretBroker,
  SecurityAuditLedger,
  SecurityAuthorizer,
  assertNoLabelDowngrade,
  createCapabilitySecurityGuard,
  propagateSecurityLabels,
  inspectFileSafety,
  redactDlpText,
  scanDlpText,
} from "../lib/security/index.ts";

const now = "2026-08-09T04:00:00.000Z";
const later = "2026-08-09T04:01:00.000Z";
const expires = "2026-08-09T05:00:00.000Z";
const principal = { id: "user-security", type: "user" as const, tenantId: "tenant-security" };

function manifest(id: string, kind: "read" | "network" | "external_action") {
  return {
    id, version: "1.0.0", title: id, inputSchemaId: `${id}.input`, outputSchemaId: `${id}.output`,
    preconditions: [], sideEffects: [{ kind, target: "security-fixture", reversible: true }], requiredPermissions: [],
    evidenceProduced: [], resourceEstimate: { expectedWallTimeMs: 1, expectedMemoryBytes: 1, expectedDiskBytes: 0,
      expectedNetworkBytes: 0, expectedToolOutputBytes: 0, confidence: 1 }, validators: [],
    failureSemantics: { declaredKinds: ["permission_denied" as const], retryableKinds: [], maxAttempts: 1, backoffMs: 0 },
    idempotency: { mode: "none" as const }, metadata: {}, inputSchema: z.object({}).strict(), outputSchema: z.object({}).strict(),
    handler: async () => ({}),
  };
}

export const securityKernelTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-security-"));
  try {
    const dbPath = path.join(root, "security.db");
    const db = new DatabaseSync(dbPath);
    db.exec("PRAGMA foreign_keys = ON");
    runMigrations(db, dbPath, () => null);
    const audit = new SecurityAuditLedger(db);
    const exports = new ExternalExportService(db, audit);
    const authorizer = new SecurityAuthorizer(db, audit, (request) => Boolean(request.approvalId && exports.isAuthorized({
      requestId: request.approvalId!, principal: request.principal, tenantId: request.tenantId, caseId: request.caseId,
      artifactVersionId: request.artifactVersionId!, capabilityId: request.capabilityId,
      destinationDomain: request.destinationDomain!, now: request.now,
    })));

    authorizer.grant({ id: "grant-case", principal, tenantId: "tenant-security", caseId: "case-1",
      capabilityId: "cap.read", actions: ["read"], expiresAt: expires, createdAt: now });
    const allowRead = authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1",
      capabilityId: "cap.read", action: "read", now });
    assert.equal(allowRead.decision, "allow");
    const persistedAllowRead = db.prepare(`
      SELECT decision, case_id, capability_id, action, audit_event_id
      FROM security_policy_decisions WHERE decision_id = ?
    `).get(allowRead.id) as {
      decision: string;
      case_id: string | null;
      capability_id: string;
      action: string;
      audit_event_id: string;
    } | undefined;
    assert.deepEqual(persistedAllowRead && {
      decision: persistedAllowRead.decision,
      caseId: persistedAllowRead.case_id,
      capabilityId: persistedAllowRead.capability_id,
      action: persistedAllowRead.action,
    }, { decision: "allow", caseId: "case-1", capabilityId: "cap.read", action: "read" });
    assert.equal(
      (db.prepare("SELECT COUNT(*) AS count FROM security_audit_events WHERE event_id = ?")
        .get(persistedAllowRead!.audit_event_id) as { count: number }).count,
      1,
      "every policy decision must point to the audit event committed in the same transaction",
    );
    assert.equal(authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-2",
      capabilityId: "cap.read", action: "read", now }).code, "acl_default_deny");
    assert.equal(authorizer.authorize({ principal, tenantId: "other-tenant", caseId: "case-1",
      capabilityId: "cap.read", action: "read", now }).code, "tenant_scope_mismatch");

    authorizer.grant({ id: "grant-network", principal, tenantId: "tenant-security", caseId: "case-1",
      capabilityId: "cap.network", actions: ["network"], expiresAt: expires, createdAt: now });
    assert.equal(authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1", capabilityId: "cap.network",
      action: "network", destinationDomain: "api.example.com", now }).code, "egress_default_deny");
    authorizer.grantEgress({ id: "egress-api", principal, tenantId: "tenant-security", caseId: "case-1",
      capabilityId: "cap.network", domain: "api.example.com", expiresAt: expires, createdAt: now });
    assert.equal(authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1", capabilityId: "cap.network",
      action: "network", destinationDomain: "api.example.com", now }).decision, "allow");
    assert.equal(authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1", capabilityId: "cap.network",
      action: "network", destinationDomain: "evil.example.com", now }).decision, "deny");

    assert.deepEqual(propagateSecurityLabels([
      { classification: "internal", taints: ["untrusted_input"] },
      { classification: "restricted", taints: ["financial_data", "untrusted_input"] },
    ]), { classification: "restricted", taints: ["financial_data", "untrusted_input"] });
    assert.throws(() => assertNoLabelDowngrade("restricted", "internal"), /explicit approval/);
    assert.doesNotThrow(() => assertNoLabelDowngrade("restricted", "internal", true));

    const blocked = authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1", capabilityId: "cap.network",
      action: "network", destinationDomain: "api.example.com", taints: ["prompt_injection"], now });
    assert.equal(blocked.code, "prompt_injection_capability_escalation");

    const backend = new InMemorySecretBackend();
    backend.register("secret-api", "sk-this-must-never-be-persisted");
    const broker = new SecretBroker(db, backend, audit);
    const lease = broker.issueLease({ secretId: "secret-api", principal, capabilityId: "cap.network",
      destinationDomain: "api.example.com", ttlMs: 60_000, maxUses: 1, now });
    assert.equal(broker.use(lease.id, { principal, capabilityId: "cap.network", destinationDomain: "api.example.com", now },
      (secret) => secret.startsWith("sk-")), true);
    assert.throws(() => broker.use(lease.id, { principal, capabilityId: "cap.network", destinationDomain: "api.example.com", now },
      () => true), /exhausted/);
    const persistedSecurity = JSON.stringify({
      leases: db.prepare("SELECT * FROM secret_leases").all(),
      audit: db.prepare("SELECT payload_json FROM security_audit_events").all(),
    });
    assert(!persistedSecurity.includes("sk-this-must-never-be-persisted"));

    const artifacts = new ArtifactStore(db, path.join(root, "cas"));
    const ingestRoot = path.join(root, "ingest");
    fs.mkdirSync(ingestRoot);
    const cleanPath = path.join(ingestRoot, "clean.xlsx");
    const cleanWorkbook = await new JSZip()
      .file("[Content_Types].xml", "<Types/>")
      .file("xl/workbook.xml", "<workbook/>")
      .file("xl/worksheets/sheet1.xml", "<worksheet><sheetData/></worksheet>")
      .generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
    fs.writeFileSync(cleanPath, cleanWorkbook);
    const quarantine = new QuarantineService(db, artifacts);
    const staged = quarantine.stage({ filePath: cleanPath, allowedRoot: ingestRoot, classification: "confidential",
      retention: { policyId: "security-test" }, producer: { capabilityId: "ingest", version: "1", attemptId: "attempt-1" },
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
    assert.equal(staged.artifact.state, "staging");
    assert.equal((await quarantine.scan(staged.quarantineId, { scan: async () => ({ verdict: "clean", scannerId: "fixture" }) }, later)).verdict, "clean");
    assert.equal((db.prepare("SELECT lifecycle_state FROM artifacts WHERE artifact_id=?").get(staged.artifact.artifactId) as { lifecycle_state: string }).lifecycle_state, "candidate");
    const failed = quarantine.stage({ filePath: cleanPath, allowedRoot: ingestRoot, classification: "confidential",
      retention: { policyId: "security-test" }, producer: {}, mediaType: "application/octet-stream" });
    assert.equal((await quarantine.scan(failed.quarantineId, null, later)).verdict, "scan_failed");
    assert.equal((db.prepare("SELECT lifecycle_state FROM artifacts WHERE artifact_id=?").get(failed.artifact.artifactId) as { lifecycle_state: string }).lifecycle_state, "staging");
    const linkPath = path.join(ingestRoot, "link.xlsx");
    fs.symlinkSync(cleanPath, linkPath);
    assert.throws(() => quarantine.stage({ filePath: linkPath, allowedRoot: ingestRoot, classification: "internal",
      retention: {}, producer: {}, mediaType: "application/octet-stream" }), /symbolic links/);

    const traversalPackage = await new JSZip().file("../escape.txt", "unsafe").generateAsync({ type: "nodebuffer" });
    const traversalManifest = await inspectFileSafety(traversalPackage, "unsafe.zip", "application/zip");
    assert.equal(traversalManifest.decision, "block");
    assert(traversalManifest.findings.some((item) => item.code === "archive_path_traversal"));

    const macroPackage = await new JSZip()
      .file("[Content_Types].xml", "<Types/>")
      .file("xl/workbook.xml", "<workbook/>")
      .file("xl/vbaProject.bin", Buffer.from([1, 2, 3]))
      .generateAsync({ type: "nodebuffer" });
    const macroPath = path.join(ingestRoot, "unsafe.xlsm");
    fs.writeFileSync(macroPath, macroPackage);
    const macroStaged = quarantine.stage({ filePath: macroPath, allowedRoot: ingestRoot, classification: "restricted",
      retention: { policyId: "security-test" }, producer: {}, mediaType: "application/vnd.ms-excel.sheet.macroEnabled.12" });
    const macroResult = await quarantine.scan(macroStaged.quarantineId, {
      scan: async () => ({ verdict: "clean", scannerId: "fixture" }),
    }, later);
    assert.equal(macroResult.verdict, "policy_blocked");
    assert.equal(macroResult.reasonCode, "macro_present");
    assert.equal((db.prepare("SELECT lifecycle_state FROM artifacts WHERE artifact_id=?").get(macroStaged.artifact.artifactId) as { lifecycle_state: string }).lifecycle_state, "staging");
    const storedInspection = db.prepare("SELECT inspection_json FROM quarantine_items WHERE quarantine_id=?")
      .get(macroStaged.quarantineId) as { inspection_json: string };
    assert.match(storedInspection.inspection_json, /macro_present/);

    const activePackage = await new JSZip()
      .file("[Content_Types].xml", "<Types/>")
      .file("xl/workbook.xml", "<workbook/>")
      .file("xl/_rels/workbook.xml.rels", '<Relationships><Relationship TargetMode="External" Target="https://evil.example"/></Relationships>')
      .file("xl/worksheets/sheet1.xml", '<worksheet><sheetData><c><f>WEBSERVICE(&quot;https://evil.example&quot;)</f></c><c t="inlineStr"><is><t>=cmd|calc</t></is></c></sheetData></worksheet>')
      .generateAsync({ type: "nodebuffer" });
    const activeManifest = await inspectFileSafety(activePackage, "active.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    assert.equal(activeManifest.decision, "block");
    assert(activeManifest.findings.some((item) => item.code === "external_link_present"));
    assert(activeManifest.findings.some((item) => item.code === "active_formula_present"));
    assert(activeManifest.findings.some((item) => item.code === "formula_injection_present"));

    const bombPackage = Buffer.from(await new JSZip().file("payload.txt", "x").generateAsync({ type: "nodebuffer", compression: "DEFLATE" }));
    for (let offset = 0; offset + 46 < bombPackage.length; offset += 1) {
      if (bombPackage.readUInt32LE(offset) === 0x02014b50) bombPackage.writeUInt32LE(1_000_000_000, offset + 24);
    }
    const bombManifest = await inspectFileSafety(bombPackage, "bomb.zip", "application/zip");
    assert.equal(bombManifest.decision, "block");
    assert(bombManifest.findings.some((item) => item.code === "archive_compression_ratio_limit" || item.code === "archive_entry_size_limit"));

    const sensitive = "客户身份证 11010519491231002X，银行卡 6222021234567890123，密钥 sk-abcdefghijklmnop";
    const findings = scanDlpText(sensitive);
    assert(findings.some((item) => item.kind === "personal_data"));
    assert(findings.some((item) => item.kind === "bank_account"));
    assert(findings.some((item) => item.kind === "secret"));
    const redacted = redactDlpText(sensitive, findings);
    assert(!redacted.includes("11010519491231002X"));
    assert(!redacted.includes("6222021234567890123"));
    assert(!redacted.includes("sk-abcdefghijklmnop"));
    assert.match(redacted, /\[REDACTED:secret:/);
    authorizer.grant({ id: "grant-export", principal, tenantId: "tenant-security", caseId: "case-1",
      artifactVersionId: "artifact-version-1", capabilityId: "cap.export", actions: ["export"], expiresAt: expires, createdAt: now });
    const exportRequest = exports.request({ principal, tenantId: "tenant-security", caseId: "case-1",
      artifactVersionId: "artifact-version-1", capabilityId: "cap.export", destinationDomain: "auditor.example.com",
      classification: "restricted", findings, ttlMs: 120_000, now });
    assert.equal(exportRequest.status, "pending");
    exports.decide(exportRequest.requestId, { approver: { id: "approver", type: "user", tenantId: "tenant-security" },
      approve: true, reason: "approved for named auditor", now: later });
    assert.equal(authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1", capabilityId: "cap.export",
      artifactVersionId: "artifact-version-1", action: "export", destinationDomain: "wrong.example.com",
      classification: "restricted", approvalId: exportRequest.requestId, now: later }).decision, "require_approval");
    assert.equal(authorizer.authorize({ principal, tenantId: "tenant-security", caseId: "case-1", capabilityId: "cap.export",
      artifactVersionId: "artifact-version-1", action: "export", destinationDomain: "auditor.example.com",
      classification: "restricted", approvalId: exportRequest.requestId, now: later }).decision, "allow");
    assert.equal(exports.isAuthorized({ requestId: exportRequest.requestId, principal, tenantId: "tenant-security", caseId: "case-1",
      artifactVersionId: "artifact-version-1", capabilityId: "cap.export", destinationDomain: "auditor.example.com", now: later }), true,
    "authorization checks must not consume the approval before the export succeeds");
    exports.complete({ requestId: exportRequest.requestId, principal, tenantId: "tenant-security", caseId: "case-1",
      artifactVersionId: "artifact-version-1", capabilityId: "cap.export", destinationDomain: "auditor.example.com", now: later });
    assert(!JSON.stringify(db.prepare("SELECT findings_json FROM external_export_requests").all()).includes("11010519491231002X"));

    const guardAuthorizer = new SecurityAuthorizer(db, audit);
    const approvalGuard = createCapabilitySecurityGuard(guardAuthorizer, { principal, tenantId: "tenant-security", caseId: "case-1",
      classification: "restricted", artifactVersionId: () => "artifact-version-1", destinationDomain: () => "auditor.example.com", now: () => later });
    const approvalFailure = await approvalGuard(manifest("cap.export", "external_action"), {});
    assert.equal(approvalFailure?.kind, "human_decision_required");
    const injectionGuard = createCapabilitySecurityGuard(authorizer, { principal, tenantId: "tenant-security", caseId: "case-1",
      taints: ["prompt_injection"], destinationDomain: () => "api.example.com", now: () => later });
    const injectionFailure = await injectionGuard(manifest("cap.network", "network"), {});
    assert.equal(injectionFailure?.kind, "policy_blocked");

    assert.deepEqual(audit.verify().valid, true);
    db.prepare("UPDATE security_audit_events SET payload_json='{}' WHERE sequence_no=1").run();
    assert.equal(audit.verify().valid, false, "audit hash chain must reveal tampering");
    db.close();
    console.log("security-kernel: ACL, egress, labels, secrets, quarantine, DLP, approval and audit checks passed ✓");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("security-kernel.test")) {
  securityKernelTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
