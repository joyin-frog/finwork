import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  createBenchmarkTaskContract,
  deterministicallySampleBenchmarkCases,
  formatBenchmarkRunLog,
  createSyntheticInputArtifacts,
  importExternalBenchmarkSource,
  mineBenchmarkGapProposals,
  partitionBenchmarkCase,
  parseBenchmarkRunReport,
  readNormalizedBenchmarkCases,
  runBenchmarkFixtureSuite,
  runBenchmarkSuite,
  serializeBenchmarkRunReport,
  scoreBenchmarkPrediction,
  writeBenchmarkImport,
  type BenchmarkDatasetId,
  type BenchmarkImportResult,
  type NormalizedBenchmarkCase,
} from "../lib/evaluation/benchmarks/index.ts";

const FIXTURE_ROOT = path.join(process.cwd(), "tests", "fixtures", "benchmarks");
const IMPORTED_AT = "2026-08-13T00:00:00.000Z";

const FIXTURES: ReadonlyArray<{
  datasetId: BenchmarkDatasetId;
  datasetVersion: string;
  split: string;
  file: string;
}> = [
  { datasetId: "finqa", datasetVersion: "synthetic-v1", split: "test", file: "finqa.sample.json" },
  { datasetId: "tatqa", datasetVersion: "synthetic-v1", split: "test", file: "tatqa.sample.json" },
  { datasetId: "convfinqa", datasetVersion: "synthetic-v1", split: "test", file: "convfinqa.sample.json" },
  { datasetId: "financebench", datasetVersion: "synthetic-v1", split: "test", file: "financebench.sample.json" },
  { datasetId: "finben", datasetVersion: "synthetic-v1", split: "test", file: "finben.sample.json" },
  { datasetId: "fineval", datasetVersion: "synthetic-v1", split: "dev", file: "fineval.sample.json" },
  { datasetId: "spreadsheetbench_v2", datasetVersion: "synthetic-v2", split: "test", file: "spreadsheetbench.sample.json" },
  { datasetId: "finagentbench", datasetVersion: "synthetic-v1", split: "dev", file: "finagentbench.sample.json" },
];

async function importFixtures(): Promise<BenchmarkImportResult[]> {
  return Promise.all(FIXTURES.map((fixture) => importExternalBenchmarkSource({
    datasetId: fixture.datasetId,
    datasetVersion: fixture.datasetVersion,
    split: fixture.split,
    sourcePath: path.join(FIXTURE_ROOT, fixture.file),
    acknowledgeLicenseReview: true,
    importedAt: IMPORTED_AT,
  })));
}

function inputArtifactsByCase(cases: readonly NormalizedBenchmarkCase[]): Record<string, ReturnType<typeof createSyntheticInputArtifacts>> {
  return Object.fromEntries(cases
    .filter((benchmarkCase) => benchmarkCase.context.files.length > 0)
    .map((benchmarkCase) => [benchmarkCase.id, createSyntheticInputArtifacts(benchmarkCase)]));
}

export const benchmarkAdaptersTestPromise = (async () => {
  const imports = await importFixtures();
  const cases = imports.flatMap((result) => result.cases);
  assert.equal(imports.length, 8);
  assert.equal(cases.length, 9, "ConvFinQA fixture expands into two turns");
  assert.ok(imports.every((result) => result.manifest.descriptor.integrationStatus === "ready"));
  assert.ok(cases.every((benchmarkCase) => benchmarkCase.provenance.licenseStatus === "review_required"));

  await assert.rejects(
    importExternalBenchmarkSource({
      datasetId: "finqa",
      datasetVersion: "synthetic-v1",
      split: "test",
      sourcePath: path.join(FIXTURE_ROOT, "finqa.sample.json"),
      acknowledgeLicenseReview: false,
    }),
    /explicit license review acknowledgement/,
  );
  await assert.rejects(
    importExternalBenchmarkSource({
      datasetId: "finder",
      datasetVersion: "paper-only",
      split: "test",
      sourcePath: path.join(FIXTURE_ROOT, "financebench.sample.json"),
      acknowledgeLicenseReview: true,
    }),
    /reference-only/,
  );

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "finwork-benchmark-import-"));
  try {
    const written = await writeBenchmarkImport(imports[0]!, temporaryRoot);
    const roundTripped = await readNormalizedBenchmarkCases(written.casesPath);
    assert.deepEqual(roundTripped, imports[0]!.cases);

    const emptySourcePath = path.join(temporaryRoot, "empty.json");
    await writeFile(emptySourcePath, "[]\n", "utf8");
    await assert.rejects(
      importExternalBenchmarkSource({
        datasetId: "finqa",
        datasetVersion: "synthetic-v1",
        split: "test",
        sourcePath: emptySourcePath,
        acknowledgeLicenseReview: true,
      }),
      /source contains no records/,
    );

    const officialFinanceBenchPath = path.join(temporaryRoot, "financebench-official.jsonl");
    await writeFile(officialFinanceBenchPath, `${JSON.stringify({
      financebench_id: "financebench_id_03029",
      question: "What was capital expenditure?",
      answer: "$1577.00",
      evidence: [{
        evidence_text: "Purchases of property, plant and equipment were $1,577 million.",
        evidence_doc_name: "3M_2018_10K",
        evidence_page_num: 59,
      }],
    })}\n`, "utf8");
    const officialFinanceBench = await importExternalBenchmarkSource({
      datasetId: "financebench",
      datasetVersion: "official-schema-test",
      split: "test",
      sourcePath: officialFinanceBenchPath,
      acknowledgeLicenseReview: true,
    });
    assert.equal(officialFinanceBench.cases[0]?.context.textBlocks[0]?.text, "Purchases of property, plant and equipment were $1,577 million.");
    assert.equal(officialFinanceBench.cases[0]?.context.textBlocks[0]?.locator, "page:59");
    assert.equal(officialFinanceBench.cases[0]?.expected.citations[0]?.locator, "page:59");
    assert.equal(officialFinanceBench.cases[0]?.expected.citations[0]?.quote, "Purchases of property, plant and equipment were $1,577 million.");

    const officialSpreadsheetBenchPath = path.join(temporaryRoot, "spreadsheetbench-v2-official.json");
    await writeFile(officialSpreadsheetBenchPath, `${JSON.stringify([{
      id: "financial-model-001",
      instruction: "Complete the financial model.",
      spreadsheet_path: "Financial_Model/spreadsheet/input.xlsx",
      golden_response_path: "Financial_Model/golden_response/answer.xlsx",
      answer_position: "'Model'!B2:C3",
    }])}\n`, "utf8");
    const officialSpreadsheetBench = await importExternalBenchmarkSource({
      datasetId: "spreadsheetbench_v2",
      datasetVersion: "official-schema-test",
      split: "test",
      sourcePath: officialSpreadsheetBenchPath,
      acknowledgeLicenseReview: true,
    });
    assert.deepEqual(officialSpreadsheetBench.cases[0]?.context.files.map((file) => file.upstreamUri), [
      "Financial_Model/spreadsheet/input.xlsx",
    ]);
    assert.equal(officialSpreadsheetBench.cases[0]?.expected.artifact?.logicalName, "financial-model-001_completed.xlsx");
    assert.deepEqual(officialSpreadsheetBench.cases[0]?.expected.artifact?.validatorIds, ["xlsx_generic", "spreadsheetbench_v2_cells"]);
    assert.equal(officialSpreadsheetBench.cases[0]?.expected.artifact?.oracle?.goldenUpstreamUri, "Financial_Model/golden_response/answer.xlsx");
    assert.equal(officialSpreadsheetBench.cases[0]?.expected.artifact?.oracle?.answerRange, "'Model'!B2:C3");
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }

  const answerCase = cases.find((benchmarkCase) => benchmarkCase.datasetId === "finqa")!;
  const answerPartition = partitionBenchmarkCase(answerCase);
  const answerMaterialization = createBenchmarkTaskContract(answerPartition.executionCase);
  assert.equal(answerMaterialization.missingExternalInputs.length, 0);
  assert.ok(answerMaterialization.contract.requiredCapabilities.some((item) => item.capabilityId === "finance.reasoning.answer"));

  const spreadsheetCase = cases.find((benchmarkCase) => benchmarkCase.datasetId === "spreadsheetbench_v2")!;
  const spreadsheetPartition = partitionBenchmarkCase(spreadsheetCase);
  const missingSpreadsheetInput = createBenchmarkTaskContract(spreadsheetPartition.executionCase);
  assert.equal(missingSpreadsheetInput.missingExternalInputs.length, 1);
  const materializedSpreadsheetPartition = partitionBenchmarkCase(
    spreadsheetCase,
    createSyntheticInputArtifacts(spreadsheetCase),
  );
  const materializedSpreadsheet = createBenchmarkTaskContract(materializedSpreadsheetPartition.executionCase);
  assert.equal(materializedSpreadsheet.missingExternalInputs.length, 0);
  assert.equal(materializedSpreadsheet.contract.expectedOutputs[0]?.immutableDelivery, true);
  assert.deepEqual(materializedSpreadsheet.contract.expectedOutputs[0]?.validatorIds, ["xlsx_generic"]);

  const report = await runBenchmarkFixtureSuite({
    suiteName: "synthetic adapter wiring",
    cases,
    publishable: false,
    runId: "benchmark-fixture-test",
    now: () => new Date(IMPORTED_AT),
    inputArtifactsByCaseId: inputArtifactsByCase(cases),
  });
  assert.deepEqual(report.totals, { cases: 9, passed: 9, failed: 0, errors: 0 });
  assert.equal(report.schemaVersion, 2);
  assert.equal(report.realApi, false);
  assert.equal(report.configuration.kind, "fixture");
  assert.equal(report.fixtureOracle, true);
  assert.equal(report.publishable, false);
  assert.equal(report.sources.length, 8);
  assert.equal(report.sources.find((source) => source.datasetId === "convfinqa")?.caseCount, 2);
  assert.ok(report.sources.every((source) => source.sourceSha256.length === 64));
  assert.ok(report.sources.every((source) => source.manifestSha256.length === 64));
  assert.equal(report.aggregateScores.contract, 1);
  assert.ok(report.results.every((result) => result.status === "passed"));
  assert.ok(report.results.every((result) => result.execution.runId === report.runId));

  const v1Report = {
    ...report,
    schemaVersion: 1 as const,
    sources: report.sources.map(({ manifestSha256: _manifestSha256, ...source }) => source),
    results: report.results.map(({ execution: _execution, ...result }) => result),
  };
  const {
    realApi: _realApi,
    configuration: _configuration,
    runStatus: _runStatus,
    stopReason: _stopReason,
    ...v1Fields
  } = v1Report;
  const migratedReport = parseBenchmarkRunReport(v1Fields);
  assert.equal(migratedReport.schemaVersion, 2);
  assert.equal(migratedReport.configuration.kind, "legacy-v1");
  assert.equal(migratedReport.realApi, false);
  assert.equal(parseBenchmarkRunReport(JSON.parse(serializeBenchmarkRunReport(report))).schemaVersion, 2);

  const firstManifest = report.sources[0]!.manifestSha256;
  const sampleA = deterministicallySampleBenchmarkCases(cases, firstManifest, "seed-17", 4).map((item) => item.id);
  const sampleB = deterministicallySampleBenchmarkCases([...cases].reverse(), firstManifest, "seed-17", 4).map((item) => item.id);
  assert.deepEqual(sampleA, sampleB, "same manifest and seed must produce the same sample order");

  await assert.rejects(
    runBenchmarkFixtureSuite({
      suiteName: "empty suite",
      cases: [],
    }),
    /requires at least one normalized case/,
  );
  await assert.rejects(
    runBenchmarkFixtureSuite({
      suiteName: "invalid published oracle",
      cases,
      publishable: true,
      inputArtifactsByCaseId: inputArtifactsByCase(cases),
    } as never),
    /fixture-oracle reports.*cannot be publishable/,
  );
  await assert.rejects(
    runBenchmarkSuite({
      suiteName: "unverified source",
      cases: [answerCase],
      executor: async () => ({ citations: [], assertions: [], metrics: {}, details: {} }),
      publishable: true,
    }),
    /verified licenses/,
  );

  let executorCalled = false;
  const missingInputReport = await runBenchmarkSuite({
    suiteName: "missing external input",
    cases: [spreadsheetCase],
    executor: async () => {
      executorCalled = true;
      return { citations: [], assertions: [], metrics: {}, details: {} };
    },
    runId: "benchmark-missing-input-test",
    now: () => new Date(IMPORTED_AT),
  });
  assert.equal(executorCalled, false, "execution must stop before untrusted external files are materialized");
  assert.equal(missingInputReport.results[0]?.faultDomain, "capability");
  assert.deepEqual(missingInputReport.results[0]?.failures, ["benchmark_input_not_materialized"]);

  const secretSentinel = "sk-benchmark-sentinel-PRIVATE";
  const secretReport = await runBenchmarkSuite({
    suiteName: "secret sanitization",
    cases: [answerCase],
    executor: async () => ({
      answer: answerCase.expected.answers[0],
      citations: [],
      assertions: [],
      metrics: {},
      details: {
        apiKey: secretSentinel,
        sourcePath: "/Users/private-user/Documents/sensitive.xlsx",
      },
    }),
    runId: "benchmark-secret-test",
    now: () => new Date(IMPORTED_AT),
  });
  const serializedSecretReport = serializeBenchmarkRunReport(secretReport, [secretSentinel]);
  assert.equal(serializedSecretReport.includes(secretSentinel), false);
  assert.equal(serializedSecretReport.includes("private-user"), false);
  assert.equal(formatBenchmarkRunLog(secretReport).includes(secretSentinel), false);

  const invalidArtifact = scoreBenchmarkPrediction(spreadsheetPartition.executionCase, spreadsheetPartition.oracle, {
    citations: [],
    assertions: spreadsheetCase.expected.assertions,
    artifact: {
      mediaType: spreadsheetCase.expected.artifact!.mediaType,
      sha256: "c".repeat(64),
      checks: [],
    },
    metrics: { wallTimeMs: 1, tokens: 0, retries: 0, toolCalls: 0 },
    details: {},
  });
  assert.equal(invalidArtifact.faultDomain, "evaluator");
  assert.ok(invalidArtifact.failures.includes("artifact_validation_missing"));

  const wrongAnswer = scoreBenchmarkPrediction(answerPartition.executionCase, answerPartition.oracle, {
    answer: "not the expected answer",
    citations: [],
    assertions: [],
    metrics: { wallTimeMs: 1, tokens: 0, retries: 0, toolCalls: 0 },
    details: {},
  });
  assert.equal(wrongAnswer.faultDomain, "model");
  assert.ok(wrongAnswer.failures.includes("answer_mismatch"));

  const citationCase = cases.find((benchmarkCase) => benchmarkCase.datasetId === "financebench")!;
  const citationPartition = partitionBenchmarkCase(citationCase);
  const expectedCitation = citationCase.expected.citations[0]!;
  const wrongCitationLocator = scoreBenchmarkPrediction(citationPartition.executionCase, citationPartition.oracle, {
    answer: citationCase.expected.answers[0],
    citations: [{ sourceId: expectedCitation.sourceId, locator: "wrong section" }],
    assertions: [],
    metrics: { wallTimeMs: 1, tokens: 0, retries: 0, toolCalls: 0 },
    details: {},
  });
  assert.equal(wrongCitationLocator.scores.citationRecall, 0);
  assert.equal(wrongCitationLocator.scores.citationPrecision, 0);
  assert.ok(wrongCitationLocator.failures.includes("citation_recall_failed"));

  const proposals = mineBenchmarkGapProposals([
    missingInputReport.results[0]!,
    invalidArtifact,
    wrongAnswer,
  ]);
  assert.ok(proposals.length >= 3);
  assert.ok(proposals.every((proposal) => proposal.status === "proposal"));
  assert.ok(proposals.some((proposal) => proposal.faultDomain === "capability"));
  assert.ok(proposals.some((proposal) => proposal.faultDomain === "evaluator"));
  assert.ok(proposals.some((proposal) => proposal.faultDomain === "model"));

  const privateSentinel = "ORACLE_ONLY_SENTINEL_9f7228";
  const privacyCase: NormalizedBenchmarkCase = {
    ...answerCase,
    id: "benchmark-oracle-privacy-case",
    upstreamCaseId: "oracle-privacy-case",
    expected: {
      ...answerCase.expected,
      answers: [privateSentinel],
      numericAnswers: [987654321.125],
      programs: ["private_program_sentinel"],
      citations: [{ sourceId: "private-source-sentinel", locator: "private-locator" }],
      assertions: ["private_assertion_sentinel"],
    },
  };
  let serializedExecutorView = "";
  await runBenchmarkSuite({
    suiteName: "oracle privacy boundary",
    cases: [privacyCase],
    executor: async (executionCase, context) => {
      serializedExecutorView = JSON.stringify({ executionCase, taskContract: context.taskContract });
      return { answer: "redacted", citations: [], assertions: [], metrics: {}, details: {} };
    },
    runId: "benchmark-oracle-privacy-test",
    now: () => new Date(IMPORTED_AT),
  });
  assert.ok(serializedExecutorView.length > 0);
  for (const forbidden of [
    privateSentinel,
    "987654321.125",
    "private_program_sentinel",
    "private-source-sentinel",
    "private-locator",
    "private_assertion_sentinel",
    "\"expected\"",
    "\"answers\"",
    "\"numericAnswers\"",
    "\"programs\"",
    "\"citations\"",
    "\"assertions\"",
  ]) {
    assert.equal(serializedExecutorView.includes(forbidden), false, `executor view leaked ${forbidden}`);
  }

  const naturalSourceSentinel = "NATURAL_SOURCE_SENTINEL_42";
  const sourceCase: NormalizedBenchmarkCase = {
    ...answerCase,
    id: "benchmark-natural-source-case",
    upstreamCaseId: "natural-source-case",
    context: {
      ...answerCase.context,
      textBlocks: [{ id: "natural-source", text: naturalSourceSentinel }],
    },
  };
  const sourcePartition = partitionBenchmarkCase(sourceCase);
  assert.equal(sourcePartition.executionCase.context.textBlocks[0]?.text, naturalSourceSentinel);
  assert.equal(JSON.stringify(sourcePartition.oracle).includes(naturalSourceSentinel), false);
  let naturalSourceExecuted = false;
  await runBenchmarkSuite({
    suiteName: "natural source content is executable",
    cases: [sourceCase],
    executor: async (executionCase) => {
      naturalSourceExecuted = executionCase.context.textBlocks[0]?.text === naturalSourceSentinel;
      return { answer: sourceCase.expected.answers[0], citations: [], assertions: [], metrics: {}, details: {} };
    },
    runId: "benchmark-natural-source-test",
    now: () => new Date(IMPORTED_AT),
  });
  assert.equal(naturalSourceExecuted, true);

  console.log("benchmark-adapters: 8 adapters, 9 normalized cases, gates, scoring, and gap attribution passed ✓");
})();

if (process.argv[1]?.includes("benchmark-adapters.test")) {
  benchmarkAdaptersTestPromise.catch((error) => { console.error(error); process.exit(1); });
}
