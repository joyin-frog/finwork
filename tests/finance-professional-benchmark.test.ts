import assert from "node:assert/strict";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import ExcelJS from "exceljs";
import { getBenchmarkDatasetDescriptor } from "../lib/evaluation/benchmarks/catalog.ts";
import { importExternalBenchmarkSource } from "../lib/evaluation/benchmarks/importer.ts";
import { partitionBenchmarkCase } from "../lib/evaluation/benchmarks/case-boundary.ts";
import { validateFinanceProfessionalBusinessAssertions } from "../lib/evaluation/benchmarks/finance-professional-oracle.ts";
import { scoreBenchmarkPrediction } from "../lib/evaluation/benchmarks/scoring.ts";
import {
  runFinanceProfessionalHarnessSuite,
  validateFinanceProfessionalCorpus,
} from "../lib/evaluation/benchmarks/finance-professional-harness.ts";
import {
  BENCHMARK_NORMALIZER_VERSION,
} from "../lib/evaluation/benchmarks/contracts.ts";
import {
  assertProductionBenchmarkValidatorCoverage,
  findMissingProductionBenchmarkValidators,
} from "../lib/evaluation/benchmarks/validator-coverage.ts";
import { selectRealBenchmarkCases, type LoadedRealBenchmarkBundle } from "../lib/evaluation/benchmarks/real-runner.ts";

const benchmarkRoot = path.join(process.cwd(), "benchmarks", "finance-agent-professional", "v1");

export const financeProfessionalBenchmarkTestPromise = (async () => {
  const imported = await importExternalBenchmarkSource({
    datasetId: "finance_agent_professional",
    datasetVersion: "v1",
    split: "pilot",
    sourcePath: path.join(benchmarkRoot, "cases.jsonl"),
    acknowledgeLicenseReview: false,
    importedAt: "2026-08-14T00:00:00.000Z",
  });
  const cases = imported.cases;
  assert.equal(cases.length, 30);
  for (const domain of [
    "domain:bookkeeping",
    "domain:payroll-tax",
    "domain:treasury-ar",
    "domain:management-analysis",
    "domain:document-evidence",
    "domain:rag-memory",
  ]) {
    assert.equal(cases.filter((item) => item.tags.includes(domain)).length, 5, domain);
  }
  assert.ok(cases.every((item) => item.context.files.length > 0));
  assert.ok(cases.every((item) => item.expected.assertions.length > 0));
  assert.ok(cases.every((item) => item.expected.artifact));
  assert.ok(cases.every((item) => (item.expected.deterministicChecks?.length ?? 0) > 0));
  const boardDate = cases.find((item) => item.upstreamCaseId === "doc-01-board-date");
  assert.equal(boardDate?.context.textBlocks[0]?.locator, "page:2");
  assert.equal(boardDate?.expected.citations[0]?.locator, "page:2");
  const supplierStatus = cases.find((item) => item.upstreamCaseId === "doc-03-supplier-status");
  assert.equal(supplierStatus?.context.textBlocks[0]?.locator, "table:supplier-1");
  assert.equal(imported.manifest.descriptor.redistribution, "bundled");
  assert.equal(imported.manifest.descriptor.license.status, "verified");
  assert.equal(getBenchmarkDatasetDescriptor("finance_agent_professional").artifactRequired, true);

  const corpus = await validateFinanceProfessionalCorpus(cases, path.join(benchmarkRoot, "assets"));
  assert.equal(corpus.length, 30);
  assert.ok(corpus.every((item) => /^[a-f0-9]{64}$/.test(item.inputSha256)));

  const treasury = cases.find((item) => item.upstreamCaseId === "treasury-03-bank-reconcile")!;
  const { executionCase: treasuryExecution, oracle: treasuryOracle } = partitionBenchmarkCase(treasury, []);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("对账汇总");
  sheet.addRow(["invoice", "账面已收", "银行到账", "差异"]);
  sheet.addRow(["AR-004", 5000, 4500, 500]);
  const workbookBytes = new Uint8Array(await workbook.xlsx.writeBuffer());
  const delivered = {
    artifactId: "finance-professional-artifact",
    versionId: "finance-professional-version",
    sha256: "d".repeat(64),
    mediaType: treasury.expected.artifact!.mediaType,
    logicalName: treasury.expected.artifact!.logicalName,
    state: "delivered" as const,
  };
  const db = new DatabaseSync(":memory:");
  const businessChecked = await validateFinanceProfessionalBusinessAssertions({
    executionCase: treasuryExecution,
    oracle: treasuryOracle,
    prediction: {
      artifact: { mediaType: delivered.mediaType, sha256: delivered.sha256, checks: [] },
      assertions: [], citations: [], deterministicChecks: [], metrics: {},
      execution: {
        traceId: "finance-professional-trace", caseId: treasury.id,
        taskId: "finance-professional-task", runId: "finance-professional-run",
        inputTokens: 0, outputTokens: 0, latencyMs: 0, retries: 0, costUsd: null,
        artifactRefs: [delivered], evidenceRefs: [],
        validation: { assertions: { total: 0, passed: 0, failed: 0 }, delivery: { required: true, delivered: 1, passed: true } },
        termination: { cancelled: false, aborted: false, timedOut: false }, stableFailureCode: null,
      },
      details: {},
    },
    db,
    readArtifact: () => workbookBytes,
  });
  assert.deepEqual(businessChecked.assertions, treasury.expected.assertions);
  assert.equal(
    (businessChecked.details as { financeProfessionalBusinessAssertions: { passed: number } })
      .financeProfessionalBusinessAssertions.passed,
    2,
  );
  const scoredBusiness = scoreBenchmarkPrediction(treasuryExecution, treasuryOracle, {
    ...businessChecked,
    artifact: {
      ...businessChecked.artifact!,
      checks: [{ id: "xlsx_generic", passed: true, blocking: true, details: {} }],
    },
    answer: treasury.expected.answers[0],
  });
  assert.equal((scoredBusiness.details as { assertionCoverage: number }).assertionCoverage, 1);
  assert.equal(
    (scoredBusiness.details as { financeProfessionalBusinessAssertions: { passed: number } })
      .financeProfessionalBusinessAssertions.passed,
    2,
  );
  assert.doesNotMatch(scoredBusiness.failures.join("\n"), /assertion_coverage_failed/);
  const wrongBusinessChecked = await validateFinanceProfessionalBusinessAssertions({
    executionCase: treasuryExecution,
    oracle: treasuryOracle,
    prediction: { ...businessChecked, assertions: [] },
    db,
    readArtifact: () => new TextEncoder().encode("not an xlsx"),
  });
  assert.equal(wrongBusinessChecked.assertions.length, 0, "业务断言解析失败必须 fail-closed");
  db.close();

  const report = await runFinanceProfessionalHarnessSuite({
    cases,
    assetsRoot: path.join(benchmarkRoot, "assets"),
    runId: "finance-professional-layer-1",
  });
  assert.deepEqual(report.totals, { cases: 30, passed: 30, failed: 0, errors: 0 });
  assert.equal(report.realApi, false);
  assert.equal(report.fixtureOracle, false);
  assert.ok(report.results.every((item) => item.execution.inputTokens === 0 && item.execution.outputTokens === 0));

  assert.equal(findMissingProductionBenchmarkValidators(cases).length, 0);
  assert.doesNotThrow(() => assertProductionBenchmarkValidatorCoverage(cases));

  const bundle: LoadedRealBenchmarkBundle = {
    importManifest: imported.manifest,
    materializationManifest: {
      schemaVersion: 1,
      normalizerVersion: BENCHMARK_NORMALIZER_VERSION,
      datasetId: "finance_agent_professional",
      datasetVersion: "v1",
      split: "pilot",
      importManifestSha256: "b".repeat(64),
      sourceSha256: imported.manifest.sourceSha256,
      licenseStatus: "verified",
      licenseAcknowledged: true,
      createdAt: "2026-08-14T00:00:00.000Z",
      cases: cases.map((item) => ({
        caseId: item.id,
        normalizedCaseSha256: "c".repeat(64),
        inputArtifacts: [],
        sources: [],
      })),
    },
    cases,
  };
  const selected = selectRealBenchmarkCases({
    profile: "finance-agent-professional",
    cases,
    bundles: [bundle],
    sampleSeed: "finance-professional-v1",
    maxCases: 30,
  });
  assert.equal(selected.length, 30);
  assert.throws(() => selectRealBenchmarkCases({
    profile: "finance-agent-professional",
    cases,
    bundles: [bundle],
    sampleSeed: "finance-professional-v1",
    maxCases: 29,
  }), /requires --max-cases 30/);

  console.log("finance-agent-professional: 30/30 Layer 1 corpus, TaskContract, Oracle privacy, file contract and production validator gates PASS");
})();
