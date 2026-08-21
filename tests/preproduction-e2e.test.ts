import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson, sha256Json } from "../lib/capability/hash.ts";
import {
  createBuiltInPreproductionAdapters,
  createConsolidationPreproductionAdapter,
  createMultiDocumentRagPreproductionAdapter,
  createTaxPayrollPreproductionAdapter,
  createWebDueDiligencePreproductionAdapter,
  getGoldenManifest,
  runPreproductionE2E,
  type PreproductionE2EReport,
  type PreproductionScenarioAdapter,
  type PreproductionScenarioContext,
} from "../lib/evaluation/index.ts";

const FIXED_NOW = new Date("2026-08-11T00:00:00.000Z");

function sha256(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function makeRoot(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeJson(target: string, value: unknown): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function fixtureManifest(input: {
  sourcePath: string;
  sourceSha256: string;
  provenance?: string;
  parameters?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    provenance: input.provenance ?? "historical-production",
    anonymization: {
      method: "approved deterministic redaction",
      approvedBy: "finance-evaluation-owner",
      approvedAt: "2026-08-10T00:00:00.000Z",
    },
    cases: [{
      manifestId: "golden.consolidation",
      inputs: [{
        id: "source",
        path: input.sourcePath,
        sha256: input.sourceSha256,
        mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        logicalName: "历史集团底稿.xlsx",
      }],
      parameters: input.parameters ?? {},
    }],
  };
}

function assertReportHash(report: PreproductionE2EReport): void {
  const { reportSha256, ...withoutHash } = report;
  assert.equal(sha256(Buffer.from(canonicalJson(withoutHash))), reportSha256);
}

function reportPath(outputRoot: string, report: PreproductionE2EReport): string {
  return path.join(outputRoot, report.runId, "report.json");
}

async function runMissingManifestCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "missing-fixtures");
  const outputRoot = path.join(root, "missing-output");
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [],
    trustedAdapterIds: [],
    now: () => FIXED_NOW,
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => item.startsWith("fixture_manifest_missing:")));
  assert.ok(fs.existsSync(reportPath(outputRoot, report)));
  assertReportHash(report);
}

async function runInvalidProvenanceCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "invalid-provenance-fixtures");
  const outputRoot = path.join(root, "invalid-provenance-output");
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "unused.xlsx",
    sourceSha256: "0".repeat(64),
    provenance: "synthetic",
  }));
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [],
    trustedAdapterIds: [],
    now: () => FIXED_NOW,
  });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.some((item) => item.startsWith("fixture_manifest_invalid:")));
  assertReportHash(report);
}

async function runHashMismatchCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "hash-mismatch-fixtures");
  const outputRoot = path.join(root, "hash-mismatch-output");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.writeFileSync(path.join(fixtureRoot, "source.xlsx"), "not-the-approved-fixture", { mode: 0o600 });
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "source.xlsx",
    sourceSha256: "a".repeat(64),
  }));
  const adapter = createConsolidationPreproductionAdapter();
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [adapter],
    trustedAdapterIds: [adapter.id],
    now: () => FIXED_NOW,
  });
  assert.equal(report.status, "blocked");
  assert.ok(report.blockers.some((item) => item.startsWith("fixture_hash_mismatch:source:")));
  assertReportHash(report);
}

async function runUntrustedAdapterCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "untrusted-fixtures");
  const outputRoot = path.join(root, "untrusted-output");
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "missing.xlsx",
    sourceSha256: "b".repeat(64),
  }));
  const adapter = createConsolidationPreproductionAdapter();
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [adapter],
    trustedAdapterIds: [],
    now: () => FIXED_NOW,
  });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.includes(`production_adapter_not_trusted:${adapter.id}`));
  assertReportHash(report);
}

async function runDuplicateAdapterCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "duplicate-fixtures");
  const outputRoot = path.join(root, "duplicate-output");
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "missing.xlsx",
    sourceSha256: "c".repeat(64),
  }));
  const first = createConsolidationPreproductionAdapter();
  const second = createConsolidationPreproductionAdapter();
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [first, second],
    trustedAdapterIds: [first.id],
    now: () => FIXED_NOW,
  });
  assert.equal(report.status, "failed");
  assert.ok(report.failures.includes("duplicate_production_adapter:golden.consolidation"));
  assertReportHash(report);
}

async function runProtocolImpersonationCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "protocol-fixtures");
  const outputRoot = path.join(root, "protocol-output");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const source = Buffer.from("approved historical source");
  fs.writeFileSync(path.join(fixtureRoot, "source.xlsx"), source, { mode: 0o600 });
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "source.xlsx",
    sourceSha256: sha256(source),
  }));
  const adapter: PreproductionScenarioAdapter = {
    id: "test.protocol-impersonation",
    manifestId: "golden.consolidation",
    async execute(context) {
      const outputPath = path.join(context.workDir, "fake.xlsx");
      fs.mkdirSync(context.workDir, { recursive: true });
      fs.writeFileSync(outputPath, "fake", { mode: 0o600 });
      return {
        executionClass: "protocol",
        sourceInputId: "source",
        outputPath,
        sourceLocator: { kind: "sheet_range", sheet: "Sheet", range: "A1" },
        toolVersions: { fake: "1" },
        validation: {
          structuralDiff: { status: "passed", details: {} },
          visualRender: { status: "passed", details: {} },
          recalculationOrParse: { status: "passed", details: {} },
          businessAssertions: { status: "passed", details: {} },
        },
        claims: [{ statement: "fake" }],
        dimensions: { contract: 1, artifact: 1, evidence: 1, security: 1, performance: 1 },
        metrics: {},
      } as never;
    },
  };
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [adapter],
    trustedAdapterIds: [adapter.id],
    now: () => FIXED_NOW,
  });
  assert.equal(report.status, "failed");
  const consolidation = report.cases.find((item) => item.manifestId === "golden.consolidation");
  assert.equal(consolidation?.status, "failed");
  assert.ok(consolidation?.failures.some((item) => item.includes("executionClass")));
  assertReportHash(report);
}

async function runAdapterCannotSelfScorePerformanceCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "self-score-fixtures");
  const outputRoot = path.join(root, "self-score-output");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const source = Buffer.from("approved historical source");
  fs.writeFileSync(path.join(fixtureRoot, "source.xlsx"), source, { mode: 0o600 });
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "source.xlsx",
    sourceSha256: sha256(source),
  }));
  const adapter: PreproductionScenarioAdapter = {
    id: "test.production-over-budget",
    manifestId: "golden.consolidation",
    async execute(context) {
      const outputPath = path.join(context.workDir, "fake.xlsx");
      fs.mkdirSync(context.workDir, { recursive: true });
      fs.writeFileSync(outputPath, "fake", { mode: 0o600 });
      return {
        executionClass: "production",
        sourceInputId: "source",
        outputPath,
        sourceLocator: { kind: "sheet_range", sheet: "Sheet", range: "A1" },
        toolVersions: { fake: "1" },
        validation: {
          structuralDiff: { status: "passed", details: {} },
          visualRender: { status: "passed", details: {} },
          recalculationOrParse: { status: "passed", details: {} },
          businessAssertions: { status: "passed", details: {} },
        },
        claims: [{ statement: "adapter cannot override central performance scoring" }],
        dimensions: { contract: 1, artifact: 1, evidence: 1, security: 1, performance: 1 },
        metrics: { wallTimeMs: 600_001 },
      };
    },
  };
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [adapter],
    trustedAdapterIds: [adapter.id],
    now: () => FIXED_NOW,
  });
  const consolidation = report.cases.find((item) => item.manifestId === "golden.consolidation");
  assert.equal(consolidation?.status, "failed");
  assert.ok(consolidation?.failures.some((item) => item.includes("performance")));
  assertReportHash(report);
}

async function runTaxPayrollAdapterContractCase(root: string): Promise<void> {
  const adapter = createTaxPayrollPreproductionAdapter();
  assert.equal(adapter.manifestId, "golden.tax-payroll");
  assert.equal(adapter.id, "production.tax-payroll.rag-memory-rules-docx.v1");
  assert.ok(createBuiltInPreproductionAdapters().some((candidate) => candidate.id === adapter.id));
  assert.ok(adapter.preflight, "tax/payroll production adapter must expose an explicit preflight");

  const fixtureRoot = path.join(root, "tax-payroll-contract-fixtures");
  const workDir = path.join(root, "tax-payroll-contract-work");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const context: PreproductionScenarioContext = {
    manifest: getGoldenManifest("golden.tax-payroll"),
    fixture: {
      manifestId: "golden.tax-payroll",
      inputs: [],
      parameters: {},
    },
    fixtureRoot,
    workDir,
    allowExternalEgress: false,
  };
  const invalidBlockers = await adapter.preflight!(context);
  assert.ok(invalidBlockers.some((item) => item.startsWith("fixture_parameters_invalid:")));

  context.fixture = {
    manifestId: "golden.tax-payroll",
    inputs: [
      {
        id: "source",
        path: "missing-source.docx",
        sha256: "a".repeat(64),
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        logicalName: "历史薪税申报材料.docx",
      },
      {
        id: "policy",
        path: "missing-policy.md",
        sha256: "b".repeat(64),
        mediaType: "text/markdown",
        logicalName: "历史薪税政策.md",
      },
    ],
    parameters: {
      sourceInputId: "source",
      policyInputId: "policy",
      outputName: "薪税申报复核.docx",
      asOf: "2026-06-30",
      effectivePeriod: { start: "2026-01-01", end: "2026-06-30", label: "2026 上半年" },
      entityRef: "entity.demo",
      sourceLocator: { kind: "paragraph", nodeId: "source-p0" },
      sourceQuote: "历史申报材料中的受控口径",
      policyQuery: "2026 年薪税申报政策口径",
      expectedPolicyQuote: "历史政策中的受控口径",
      ruleEvaluations: [
        {
          ruleId: "tax-rate-basic",
          version: "2026.1",
          facts: { taxableBase: 100_000, applicableRate: 0.25, recordedTax: 25_000, locators: ["source:p0"] },
          expectedStatus: "passed",
          statement: "税率基础口径通过",
        },
        {
          ruleId: "payroll-basic",
          version: "2026.1",
          facts: { grossPay: 50_000, deductions: 8_000, recordedNetPay: 42_000, locators: ["source:p0"] },
          expectedStatus: "passed",
          statement: "薪资基础口径通过",
        },
      ],
      memory: { summary: "经审批的历史口径", conflictKey: "payroll-policy" },
    },
  };
  const blockers = await adapter.preflight!(context);
  assert.ok(blockers.includes("fixture_missing:source"));
  assert.ok(blockers.includes("fixture_missing:policy"));
  assert.equal(new Set(blockers).size, blockers.length, "preflight blockers must be stable and deduplicated");
}

async function runMultiDocumentRagAdapterContractCase(root: string): Promise<void> {
  const adapter = createMultiDocumentRagPreproductionAdapter();
  assert.equal(adapter.manifestId, "golden.multi-document-rag");
  assert.equal(adapter.id, "production.multi-document-rag.hybrid-citations-pdf.v1");
  assert.ok(createBuiltInPreproductionAdapters().some((candidate) => candidate.id === adapter.id));
  assert.ok(adapter.preflight, "multi-document RAG production adapter must expose an explicit preflight");

  const fixtureRoot = path.join(root, "multi-document-contract-fixtures");
  const workDir = path.join(root, "multi-document-contract-work");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const context: PreproductionScenarioContext = {
    manifest: getGoldenManifest("golden.multi-document-rag"),
    fixture: {
      manifestId: "golden.multi-document-rag",
      inputs: [],
      parameters: {},
    },
    fixtureRoot,
    workDir,
    allowExternalEgress: false,
  };
  const invalidBlockers = await adapter.preflight!(context);
  assert.ok(invalidBlockers.some((item) => item.startsWith("fixture_parameters_invalid:")));

  context.fixture = {
    manifestId: "golden.multi-document-rag",
    inputs: [
      {
        id: "source-a",
        path: "missing-source-a.md",
        sha256: "c".repeat(64),
        mediaType: "text/markdown",
        logicalName: "历史尽调材料 A.md",
      },
      {
        id: "source-b",
        path: "missing-source-b.docx",
        sha256: "d".repeat(64),
        mediaType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        logicalName: "历史尽调材料 B.docx",
      },
    ],
    parameters: {
      sourceInputIds: ["source-a", "source-b"],
      outputName: "多文档检索报告.pdf",
      asOf: "2026-06-30",
      reportTitle: "多文档可追溯问答",
      claims: [
        {
          id: "claim-a",
          inputId: "source-a",
          query: "材料 A 的受控结论",
          statement: "材料 A 结论已核验",
          expectedQuote: "材料 A 的不可变原文",
          sourceLocator: { kind: "paragraph", nodeId: "source-a-p0" },
        },
        {
          id: "claim-b",
          inputId: "source-b",
          query: "材料 B 的受控结论",
          statement: "材料 B 结论已核验",
          expectedQuote: "材料 B 的不可变原文",
          sourceLocator: { kind: "paragraph", nodeId: "source-b-p0" },
        },
      ],
      memory: {
        entityRef: "entity.multi-document-demo",
        summary: "经审批的跨文档口径",
        conflictKey: "multi-document-policy",
        effectivePeriod: { start: "2026-01-01", end: "2026-06-30", label: "2026 上半年" },
      },
    },
  };
  const blockers = await adapter.preflight!(context);
  assert.ok(blockers.includes("fixture_missing:source-a"));
  assert.ok(blockers.includes("fixture_missing:source-b"));
  assert.equal(new Set(blockers).size, blockers.length, "preflight blockers must be stable and deduplicated");
}

async function runWebDueDiligenceAdapterContractCase(root: string): Promise<void> {
  const adapter = createWebDueDiligencePreproductionAdapter();
  assert.equal(adapter.manifestId, "golden.web-due-diligence");
  assert.equal(adapter.id, "production.web-due-diligence.audited-gateway-pdf.v1");
  assert.ok(createBuiltInPreproductionAdapters().some((candidate) => candidate.id === adapter.id));
  assert.ok(adapter.preflight, "web due-diligence adapter must expose an explicit preflight");

  const context: PreproductionScenarioContext = {
    manifest: getGoldenManifest("golden.web-due-diligence"),
    fixture: { manifestId: "golden.web-due-diligence", inputs: [], parameters: {} },
    fixtureRoot: path.join(root, "web-contract-fixtures"),
    workDir: path.join(root, "web-contract-work"),
    allowExternalEgress: false,
  };
  fs.mkdirSync(context.fixtureRoot, { recursive: true });
  const invalid = await adapter.preflight!(context);
  assert.ok(invalid.some((item) => item.startsWith("fixture_parameters_invalid:")));

  context.fixture = {
    manifestId: "golden.web-due-diligence",
    inputs: [{
      id: "request",
      path: "missing-request.md",
      sha256: "e".repeat(64),
      mediaType: "text/markdown",
      logicalName: "历史尽调请求.md",
    }],
    parameters: {
      requestInputId: "request",
      outputName: "尽职调查报告.pdf",
      reportTitle: "联网尽职调查报告",
      providerId: "production-research-gateway",
      subject: {
        legalName: "匿名示例企业",
        aliases: [],
        jurisdiction: "CN",
        identifiers: { registration: "91360000123456789X" },
      },
      topics: ["entity", "ownership", "people", "litigation", "penalty", "finance", "media", "related_parties"],
      queries: ["匿名示例企业 工商 诉讼 处罚 财务"],
      languages: ["zh-CN"],
      asOf: "2026-08-12T00:00:00.000Z",
      maxSources: 8,
      policy: {
        allowedDomains: ["gov.cn", "samr.gov.cn"],
        deniedDomains: [],
        allowedRegions: ["CN"],
        requireRobotsCompliance: true,
        allowRestrictedLicense: false,
        allowSensitivePersonalData: true,
        maxRequestsPerMinute: 30,
      },
      memory: {
        entityRef: "entity.demo",
        conflictKey: "due-diligence",
        effectivePeriod: { start: "2026-01-01", end: "2026-08-12" },
      },
    },
  };
  const blockers = await adapter.preflight!(context);
  assert.ok(blockers.includes("fixture_missing:request"));
  assert.ok(blockers.includes("external_egress_not_authorized"));
  assert.ok(blockers.includes("research_gateway_url_missing"));
  assert.equal(new Set(blockers).size, blockers.length);
}

async function runMultiSourceCitationGateCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "multi-source-fixtures");
  const outputRoot = path.join(root, "multi-source-output");
  fs.mkdirSync(fixtureRoot, { recursive: true });
  const fixtureBytes = Buffer.from("历史多文档请求");
  fs.writeFileSync(path.join(fixtureRoot, "request.md"), fixtureBytes, { mode: 0o600 });
  const manifest = fixtureManifest({ sourcePath: "request.md", sourceSha256: sha256(fixtureBytes) });
  const fixtureCase = (manifest.cases as Array<Record<string, unknown>>)[0];
  fixtureCase.manifestId = "golden.multi-document-rag";
  (fixtureCase.inputs as Array<Record<string, unknown>>)[0].mediaType = "text/markdown";
  (fixtureCase.inputs as Array<Record<string, unknown>>)[0].logicalName = "历史多文档请求.md";
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), manifest);

  const adapter: PreproductionScenarioAdapter = {
    id: "test.multi-source-citation-gate",
    manifestId: "golden.multi-document-rag",
    async execute(context) {
      fs.mkdirSync(context.workDir, { recursive: true });
      const first = "来源甲：合同金额为 100 万元。";
      const second = "来源乙：付款期限为验收后 30 日。";
      const firstPath = path.join(context.workDir, "source-a.txt");
      const secondPath = path.join(context.workDir, "source-b.txt");
      const outputPath = path.join(context.workDir, "report.pdf");
      fs.writeFileSync(firstPath, first, { mode: 0o600 });
      fs.writeFileSync(secondPath, second, { mode: 0o600 });
      fs.writeFileSync(outputPath, "%PDF-1.7\npreproduction citation gate\n", { mode: 0o600 });
      return {
        executionClass: "production",
        outputPath,
        evidenceSources: [
          {
            id: "source-a", path: firstPath, sha256: sha256(Buffer.from(first)), mediaType: "text/plain",
            logicalName: "source-a.txt", locator: { kind: "char_range", nodeId: "source-a", start: 0, end: first.length }, metadata: {},
          },
          {
            id: "source-b", path: secondPath, sha256: sha256(Buffer.from(second)), mediaType: "text/plain",
            logicalName: "source-b.txt", locator: { kind: "char_range", nodeId: "source-b", start: 0, end: second.length }, metadata: {},
          },
        ],
        toolVersions: { citationGate: "test:v1" },
        validation: {
          structuralDiff: { status: "passed", details: {} },
          visualRender: { status: "passed", details: {} },
          recalculationOrParse: { status: "passed", details: {} },
          businessAssertions: { status: "passed", details: {} },
        },
        claims: [
          {
            statement: "合同金额为 100 万元",
            citations: [{
              evidenceSourceId: "source-a",
              locator: { kind: "char_range", nodeId: "source-a", start: 0, end: first.length },
              quoteHash: sha256Json(first),
            }],
          },
          {
            statement: "付款期限为验收后 30 日",
            citations: [{
              evidenceSourceId: "source-b",
              locator: { kind: "char_range", nodeId: "source-b", start: 0, end: second.length },
              quoteHash: sha256Json(second),
            }],
          },
        ],
        dimensions: { memory: 1, rag: 1, security: 1, performance: 1 },
        metrics: { wallTimeMs: 1 },
      };
    },
  };
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [adapter],
    trustedAdapterIds: [adapter.id],
    now: () => FIXED_NOW,
  });
  const target = report.cases.find((item) => item.manifestId === "golden.multi-document-rag");
  assert.equal(target?.status, "passed", target?.failures.join(","));
  assert.equal(target?.completionEvidence?.verifiedClaimIds.length, 2);
  assert.equal(target?.metrics.wallTimeMs, 1);
  assertReportHash(report);
}

async function runLiveConsolidationCase(root: string): Promise<void> {
  const fixtureRoot = path.join(root, "live-fixtures");
  const outputRoot = path.join(root, "live-output");
  const sourceFixture = path.resolve("tests/fixtures/spreadsheet/render-visible.xlsx");
  const sourceBytes = fs.readFileSync(sourceFixture);
  fs.mkdirSync(fixtureRoot, { recursive: true });
  fs.copyFileSync(sourceFixture, path.join(fixtureRoot, "historical-group-workbook.xlsx"));
  writeJson(path.join(fixtureRoot, "preproduction-e2e.json"), fixtureManifest({
    sourcePath: "historical-group-workbook.xlsx",
    sourceSha256: sha256(sourceBytes),
    parameters: {
      sourceInputId: "source",
      outputName: "集团合并底稿.xlsx",
      edits: [{ sheet: "Sheet", cell: "A2", value: "验收通过" }],
      allowedChanges: { sheet: "Sheet", columns: ["A"] },
      expectedCells: { "Sheet!A2": "验收通过" },
      numericTolerance: 0,
      sourceLocator: { kind: "sheet_range", sheet: "Sheet", range: "A1:A2" },
    },
  }));
  const adapter = createConsolidationPreproductionAdapter();
  const report = await runPreproductionE2E({
    fixtureRoot,
    outputRoot,
    adapters: [adapter],
    trustedAdapterIds: [adapter.id],
    now: () => FIXED_NOW,
  });
  const consolidation = report.cases.find((item) => item.manifestId === "golden.consolidation");
  assert.ok(consolidation, "consolidation case must be present");
  if (consolidation.status === "blocked") {
    assert.ok(
      consolidation.blockers.some((item) => item.startsWith("spreadsheet_")),
      `unexpected live validation blockers: ${consolidation.blockers.join(",")}`,
    );
  } else {
    assert.equal(consolidation.status, "passed", consolidation.failures.join(","));
    assert.ok(consolidation.artifact?.sha256);
    assert.ok(consolidation.completionEvidence?.evidenceIds.length);
    assert.ok(consolidation.completionEvidence?.verifiedClaimIds.length);
    assert.ok(consolidation.completionEvidence?.passedAssertionIds.length);
    assert.equal(consolidation.metrics.businessAssertionCount, 1);
  }
  assert.equal(report.status, "blocked", "unimplemented production scenarios must block suite qualification");
  assert.ok(report.blockers.includes("production_adapter_missing:golden.tax-payroll"));
  assert.ok(report.blockers.includes("production_adapter_missing:golden.multi-document-rag"));
  assert.ok(report.blockers.includes("production_adapter_missing:golden.web-due-diligence"));
  assert.ok(report.blockers.includes("external_egress_not_authorized:web_due_diligence"));
  assertReportHash(report);
}

export const preproductionE2ETestPromise = (async () => {
  const root = makeRoot("finwork-preproduction-e2e-");
  try {
    await runMissingManifestCase(root);
    await runInvalidProvenanceCase(root);
    await runHashMismatchCase(root);
    await runUntrustedAdapterCase(root);
    await runDuplicateAdapterCase(root);
    await runProtocolImpersonationCase(root);
    await runAdapterCannotSelfScorePerformanceCase(root);
    await runTaxPayrollAdapterContractCase(root);
    await runMultiDocumentRagAdapterContractCase(root);
    await runWebDueDiligenceAdapterContractCase(root);
    await runMultiSourceCitationGateCase(root);
    await runLiveConsolidationCase(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log("preproduction-e2e: provenance, trust, hash, protocol, governed adapters, multi-source citations and live spreadsheet gates passed ✓");
})();

if (process.argv[1]?.includes("preproduction-e2e.test")) {
  preproductionE2ETestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
