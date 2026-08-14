import assert from "node:assert/strict";
import path from "node:path";
import { getBenchmarkDatasetDescriptor } from "../lib/evaluation/benchmarks/catalog.ts";
import { importExternalBenchmarkSource } from "../lib/evaluation/benchmarks/importer.ts";
import {
  runFinanceProfessionalHarnessSuite,
  validateFinanceProfessionalCorpus,
} from "../lib/evaluation/benchmarks/finance-professional-harness.ts";
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
  assert.equal(imported.manifest.descriptor.redistribution, "bundled");
  assert.equal(imported.manifest.descriptor.license.status, "verified");
  assert.equal(getBenchmarkDatasetDescriptor("finance_agent_professional").artifactRequired, true);

  const corpus = await validateFinanceProfessionalCorpus(cases, path.join(benchmarkRoot, "assets"));
  assert.equal(corpus.length, 30);
  assert.ok(corpus.every((item) => /^[a-f0-9]{64}$/.test(item.inputSha256)));

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
