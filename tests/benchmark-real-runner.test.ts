import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { canonicalJson } from "../lib/capability/hash.ts";
import { getBenchmarkDatasetDescriptor } from "../lib/evaluation/benchmarks/catalog.ts";
import {
  BenchmarkCaseResultV2Schema,
  NormalizedBenchmarkCaseSchema,
  RealBenchmarkRunConfigSchema,
  type BenchmarkCaseResultV2,
  type BenchmarkDatasetId,
  type NormalizedBenchmarkCase,
  type RealBenchmarkRunConfig,
} from "../lib/evaluation/benchmarks/contracts.ts";
import {
  appendRealBenchmarkCheckpointEvent,
  createRunStartedEvent,
  readRealBenchmarkCheckpointEvents,
  reconstructRealBenchmarkResumeState,
  type RealBenchmarkCheckpointEvent,
} from "../lib/evaluation/benchmarks/real-checkpoint.ts";
import {
  filterRealBenchmarkCasesById,
  runRealBenchmarkSuite,
  loadRealBenchmarkInputs,
  selectRealBenchmarkCases,
  type LoadedRealBenchmarkBundle,
} from "../lib/evaluation/benchmarks/real-runner.ts";

const SOURCE_SHA = "a".repeat(64);
const MANIFEST_SHA = "b".repeat(64);
const PRIVATE_SENTINEL = "PRIVATE_REAL_RUNNER_ORACLE_SENTINEL";

function benchmarkCase(datasetId: BenchmarkDatasetId, index: number): NormalizedBenchmarkCase {
  return NormalizedBenchmarkCaseSchema.parse({
    schemaVersion: 1,
    id: `${datasetId}:v1:case-${index}`,
    datasetId,
    datasetVersion: "v1",
    upstreamCaseId: `case-${index}`,
    split: "test",
    locale: "en-US",
    taskKind: datasetId === "spreadsheetbench_v2" ? "spreadsheet" : "qa",
    prompt: `Public prompt ${datasetId} ${index}`,
    context: { textBlocks: [], tables: [], conversation: [], files: [] },
    expected: {
      answers: [PRIVATE_SENTINEL],
      numericAnswers: [],
      programs: [],
      citations: [],
      assertions: [],
    },
    capabilities: ["financial_qa"],
    tags: ["real-runner-test"],
    provenance: {
      sourceSha256: SOURCE_SHA,
      sourceRecordIndex: index,
      homepage: "https://example.invalid/benchmark",
      upstreamRef: `fixture-${index}`,
      licenseStatus: "verified",
    },
  });
}

function fakeBundle(datasetId: BenchmarkDatasetId, cases: NormalizedBenchmarkCase[]): LoadedRealBenchmarkBundle {
  const catalogDescriptor = getBenchmarkDatasetDescriptor(datasetId);
  return {
    importManifest: {
      schemaVersion: 1,
      datasetId,
      datasetVersion: "v1",
      split: "test",
      sourceSha256: SOURCE_SHA,
      sourceBytes: 1,
      sourceRecords: cases.length,
      normalizedCases: cases.length,
      descriptor: {
        ...catalogDescriptor,
        license: { ...catalogDescriptor.license, status: "verified" },
      },
      importedAt: "2026-08-13T00:00:00.000Z",
    },
    materializationManifest: {
      schemaVersion: 1,
      datasetId,
      datasetVersion: "v1",
      split: "test",
      importManifestSha256: MANIFEST_SHA,
      sourceSha256: SOURCE_SHA,
      licenseStatus: "verified",
      licenseAcknowledged: true,
      createdAt: "2026-08-13T00:00:00.000Z",
      cases: cases.map((item) => ({
        caseId: item.id,
        normalizedCaseSha256: "c".repeat(64),
        inputArtifacts: [],
        sources: [],
      })),
    },
    cases,
  };
}

const config: RealBenchmarkRunConfig = RealBenchmarkRunConfigSchema.parse({
  kind: "real",
  profile: "benchmark-smoke",
  datasets: ["finqa", "tatqa", "financebench", "spreadsheetbench_v2"].map((datasetId) => ({
    datasetId,
    split: "test",
    manifestSha256: MANIFEST_SHA,
    sourceSha256: SOURCE_SHA,
    licenseStatus: "verified",
  })),
  sampleSeed: "real-runner-test",
  maxCases: 7,
  maxInputTokens: 100,
  maxOutputTokens: 40,
  maxWallTimeMs: 10_000,
  pricingKnown: false,
  consent: { environmentGate: true, cliConfirmed: true, explicitBudgets: true },
  providerHost: "provider.example.com",
  models: { fast: "fast", reasoning: "reasoning" },
  modelTierSeparated: true,
  commitSha: "2295d76",
  runnerVersion: "test",
  nodeVersion: process.version,
  pnpmVersion: "10.0.0",
  appVersion: "0.1.0",
});

function checkpointResult(caseId: string, datasetId: BenchmarkDatasetId): BenchmarkCaseResultV2 {
  return BenchmarkCaseResultV2Schema.parse({
    caseId,
    datasetId,
    status: "failed",
    faultDomain: "dependency",
    scores: {
      exactMatch: 0,
      numericAccuracy: null,
      tokenF1: 0,
      citationPrecision: null,
      citationRecall: null,
      artifact: null,
      contract: 0,
      performance: 1,
    },
    failures: ["execution_failure:provider_unavailable"],
    capabilities: ["financial_qa"],
    metrics: { wallTimeMs: 1, tokens: 2, retries: 1, toolCalls: 0 },
    details: {},
    execution: {
      traceId: `trace-${caseId}`,
      caseId: `production-${caseId}`,
      taskId: `task-${caseId}`,
      runId: `execution-${caseId}`,
      inputTokens: 1,
      outputTokens: 1,
      latencyMs: 1,
      retries: 1,
      costUsd: null,
      artifactRefs: [],
      evidenceRefs: [],
      validation: {
        assertions: { total: 0, passed: 0, failed: 0 },
        delivery: { required: false, delivered: 0, passed: true },
      },
      termination: { cancelled: false, aborted: false, timedOut: false },
      stableFailureCode: "provider_unavailable",
    },
  });
}

export const benchmarkRealRunnerTestPromise = (async () => {
  const datasetCases = {
    finqa: Array.from({ length: 5 }, (_, index) => benchmarkCase("finqa", index)),
    tatqa: Array.from({ length: 5 }, (_, index) => benchmarkCase("tatqa", index)),
    financebench: Array.from({ length: 5 }, (_, index) => benchmarkCase("financebench", index)),
    spreadsheetbench_v2: Array.from({ length: 2 }, (_, index) => benchmarkCase("spreadsheetbench_v2", index)),
  };
  const bundles = Object.entries(datasetCases).map(([datasetId, cases]) =>
    fakeBundle(datasetId as BenchmarkDatasetId, cases)
  );
  const allCases = Object.values(datasetCases).flat();
  const selected = selectRealBenchmarkCases({
    profile: "benchmark-smoke",
    cases: allCases,
    bundles,
    sampleSeed: "stable-seed",
    maxCases: 7,
  });
  assert.deepEqual(
    selected.reduce<Record<string, number>>((counts, item) => {
      counts[item.datasetId] = (counts[item.datasetId] ?? 0) + 1;
      return counts;
    }, {}),
    { finqa: 2, tatqa: 2, financebench: 2, spreadsheetbench_v2: 1 },
  );
  assert.deepEqual(
    selected.map((item) => item.id),
    selectRealBenchmarkCases({
      profile: "benchmark-smoke",
      cases: [...allCases].reverse(),
      bundles,
      sampleSeed: "stable-seed",
      maxCases: 7,
    }).map((item) => item.id),
    "manifest + seed must select a stable order",
  );
  const exact = filterRealBenchmarkCasesById(selected, [selected[3]!.id, selected[0]!.id]);
  assert.deepEqual(exact.map((item) => item.id), [selected[0]!.id, selected[3]!.id]);
  assert.throws(
    () => filterRealBenchmarkCasesById(selected, [selected[0]!.id, selected[0]!.id]),
    new RegExp(`benchmark_case_id_duplicate:${selected[0]!.id}`),
  );
  assert.throws(
    () => filterRealBenchmarkCasesById(selected, ["general_agent_pilot:v1:unknown"]),
    /benchmark_case_id_not_selected:general_agent_pilot:v1:unknown/,
  );
  assert.throws(() => filterRealBenchmarkCasesById(selected, [""]), /benchmark_case_ids_empty/);

  const started: string[] = [];
  const finished: string[] = [];
  let executorCalls = 0;
  const report = await runRealBenchmarkSuite({
    suiteName: "real runner failure stop test",
    runId: "real-runner-test-run",
    selectedCases: selected,
    inputArtifactsByCaseId: {},
    configuration: config,
    executor: async (executionCase, context) => {
      executorCalls += 1;
      assert.doesNotMatch(JSON.stringify(executionCase), new RegExp(PRIVATE_SENTINEL));
      assert.doesNotMatch(JSON.stringify(context.taskContract), new RegExp(PRIVATE_SENTINEL));
      assert.equal(context.taskContract.budget.tokenLimit, 140);
      assert.equal(context.taskContract.budget.wallTimeMs, 10_000);
      return {
        citations: [],
        assertions: [],
        metrics: { wallTimeMs: 1, tokens: 2, retries: 1, toolCalls: 0 },
        failure: { kind: "transient_external_failure", code: "provider_unavailable", source: "dependency", details: {} },
        execution: {
          traceId: `trace-${executionCase.id}`,
          caseId: `production-${executionCase.id}`,
          taskId: `task-${executionCase.id}`,
          runId: `execution-${executionCase.id}`,
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
          retries: 1,
          costUsd: null,
          artifactRefs: [],
          evidenceRefs: [],
          validation: {
            assertions: { total: 0, passed: 0, failed: 0 },
            delivery: { required: false, delivered: 0, passed: true },
          },
          termination: { cancelled: false, aborted: false, timedOut: false },
          stableFailureCode: "provider_unavailable",
        },
        details: {},
      };
    },
    onCaseStart: ({ benchmarkCase }) => { started.push(benchmarkCase.id); },
    onCaseResult: ({ result }) => { finished.push(result.caseId); },
  });
  assert.equal(executorCalls, 3, "three consecutive infrastructure failures must stop paid execution");
  assert.deepEqual(started, finished);
  assert.equal(report.runStatus, "stopped");
  assert.equal(report.stopReason?.code, "benchmark_consecutive_infrastructure_failures");
  assert.equal(report.totals.cases, 3);
  assert.equal(report.realApi, true);
  assert.equal(report.fixtureOracle, false);

  let authUnavailableCalls = 0;
  const authUnavailableReport = await runRealBenchmarkSuite({
    suiteName: "real runner auth pool stop test",
    runId: "real-runner-auth-unavailable",
    selectedCases: selected,
    inputArtifactsByCaseId: {},
    configuration: config,
    executor: async (executionCase) => {
      authUnavailableCalls += 1;
      return {
        failure: { kind: "dependency_unavailable", code: "provider_auth_unavailable", source: "dependency" },
        execution: {
          traceId: `trace-auth-${executionCase.id}`,
          caseId: `production-auth-${executionCase.id}`,
          taskId: `task-auth-${executionCase.id}`,
          runId: `execution-auth-${executionCase.id}`,
          inputTokens: 0,
          outputTokens: 0,
          latencyMs: 1,
          retries: 1,
          costUsd: null,
          artifactRefs: [],
          evidenceRefs: [],
          validation: {
            assertions: { total: 0, passed: 0, failed: 1 },
            delivery: { required: false, delivered: 0, passed: true },
          },
          termination: { cancelled: false, aborted: false, timedOut: false },
          stableFailureCode: "provider_auth_unavailable",
        },
      };
    },
  });
  assert.equal(authUnavailableCalls, 1, "auth pool exhaustion must stop paid execution immediately");
  assert.equal(authUnavailableReport.runStatus, "stopped");
  assert.equal(authUnavailableReport.stopReason?.code, "provider_auth_unavailable");

  const checkpointRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-real-checkpoint-"));
  try {
    const eventsPath = path.join(checkpointRoot, "events.jsonl");
    const runId = "resume-test-run";
    const selectedCaseIds = selected.map((item) => item.id);
    const result = checkpointResult(selected[0]!.id, selected[0]!.datasetId);
    const events: RealBenchmarkCheckpointEvent[] = [
      createRunStartedEvent({ runId, selectedCaseIds, configuration: config, at: "2026-08-13T00:00:00.000Z" }),
      { schemaVersion: 1, type: "case_started", runId, at: "2026-08-13T00:00:01.000Z", caseId: selected[0]!.id, ordinal: 0 },
      { schemaVersion: 1, type: "case_finished", runId, at: "2026-08-13T00:00:02.000Z", caseId: selected[0]!.id, ordinal: 0, result },
      { schemaVersion: 1, type: "case_started", runId, at: "2026-08-13T00:00:03.000Z", caseId: selected[1]!.id, ordinal: 1 },
    ];
    for (const event of events) await appendRealBenchmarkCheckpointEvent(eventsPath, event);
    const persisted = await readRealBenchmarkCheckpointEvents(eventsPath);
    await assert.rejects(
      async () => reconstructRealBenchmarkResumeState({
        events: persisted,
        runId,
        selectedCaseIds,
        configuration: config,
        confirmUnknownCaseReviewed: false,
      }),
      /benchmark_paid_case_status_unknown/,
    );
    const resume = reconstructRealBenchmarkResumeState({
      events: persisted,
      runId,
      selectedCaseIds,
      configuration: config,
      confirmUnknownCaseReviewed: true,
    });
    assert.equal(resume.startedAt, "2026-08-13T00:00:00.000Z");
    assert.deepEqual(resume.resumeResults.map((item) => item.caseId), [selected[0]!.id]);
    assert.deepEqual(resume.unknownCaseIds, [selected[1]!.id]);
    const rerunResult = checkpointResult(selected[1]!.id, selected[1]!.datasetId);
    await appendRealBenchmarkCheckpointEvent(eventsPath, {
      schemaVersion: 1,
      type: "case_rerun_authorized",
      runId,
      at: "2026-08-13T00:00:04.000Z",
      caseId: selected[1]!.id,
      reason: "provider_usage_and_run_state_reviewed",
    });
    await appendRealBenchmarkCheckpointEvent(eventsPath, {
      schemaVersion: 1,
      type: "case_started",
      runId,
      at: "2026-08-13T00:00:05.000Z",
      caseId: selected[1]!.id,
      ordinal: 1,
    });
    await appendRealBenchmarkCheckpointEvent(eventsPath, {
      schemaVersion: 1,
      type: "case_finished",
      runId,
      at: "2026-08-13T00:00:06.000Z",
      caseId: selected[1]!.id,
      ordinal: 1,
      result: rerunResult,
    });
    const afterReviewedRerun = reconstructRealBenchmarkResumeState({
      events: await readRealBenchmarkCheckpointEvents(eventsPath),
      runId,
      selectedCaseIds,
      configuration: config,
      confirmUnknownCaseReviewed: false,
    });
    assert.deepEqual(afterReviewedRerun.unknownCaseIds, []);
    assert.deepEqual(afterReviewedRerun.resumeResults.map((item) => item.caseId), [selected[0]!.id, selected[1]!.id]);
  } finally {
    rmSync(checkpointRoot, { recursive: true, force: true });
  }

  const budgetExhaustedResult = BenchmarkCaseResultV2Schema.parse({
    ...checkpointResult(selected[0]!.id, selected[0]!.datasetId),
    execution: {
      ...checkpointResult(selected[0]!.id, selected[0]!.datasetId).execution,
      inputTokens: 0,
      cacheReadInputTokens: config.maxInputTokens,
    },
  });
  let budgetExecutorCalls = 0;
  const budgetStopped = await runRealBenchmarkSuite({
    suiteName: "resume budget stop test",
    runId: "resume-budget-stop",
    selectedCases: selected.slice(0, 2),
    inputArtifactsByCaseId: {},
    configuration: config,
    resumeResults: [budgetExhaustedResult],
    startedAtMs: 1_000,
    now: () => new Date(2_000),
    executor: async () => {
      budgetExecutorCalls += 1;
      throw new Error("executor must not run after persisted budget is exhausted");
    },
  });
  assert.equal(budgetExecutorCalls, 0);
  assert.equal(budgetStopped.runStatus, "stopped");
  assert.equal(budgetStopped.stopReason?.code, "benchmark_input_token_budget_exceeded", "cache-read input must consume the explicit input budget");

  let wallExecutorCalls = 0;
  const wallStopped = await runRealBenchmarkSuite({
    suiteName: "resume wall stop test",
    runId: "resume-wall-stop",
    selectedCases: selected.slice(0, 1),
    inputArtifactsByCaseId: {},
    configuration: config,
    startedAtMs: 1_000,
    now: () => new Date(1_000 + config.maxWallTimeMs),
    executor: async () => {
      wallExecutorCalls += 1;
      throw new Error("executor must not run after original wall budget is exhausted");
    },
  });
  assert.equal(wallExecutorCalls, 0);
  assert.equal(wallStopped.stopReason?.code, "benchmark_wall_time_exceeded");

  const bundleRoot = mkdtempSync(path.join(os.tmpdir(), "finwork-real-bundle-"));
  try {
    const sourceCase = benchmarkCase("finqa", 99);
    const sourceBundle = fakeBundle("finqa", [sourceCase]);
    const importManifestPath = path.join(bundleRoot, "import-manifest.json");
    const casesPath = path.join(bundleRoot, "cases.jsonl");
    const materializationManifestPath = path.join(bundleRoot, "materialization-manifest.json");
    const importBytes = Buffer.from(`${JSON.stringify(sourceBundle.importManifest, null, 2)}\n`);
    writeFileSync(importManifestPath, importBytes);
    writeFileSync(casesPath, `${JSON.stringify(sourceCase)}\n`);
    writeFileSync(materializationManifestPath, `${JSON.stringify({
      ...sourceBundle.materializationManifest,
      importManifestSha256: createHash("sha256").update(importBytes).digest("hex"),
      cases: [{
        caseId: sourceCase.id,
        normalizedCaseSha256: createHash("sha256").update(canonicalJson(sourceCase)).digest("hex"),
        inputArtifacts: [],
        sources: [],
      }],
    }, null, 2)}\n`);
    const loaded = await loadRealBenchmarkInputs([{ importManifestPath, casesPath, materializationManifestPath }]);
    assert.deepEqual(loaded.cases.map((item) => item.id), [sourceCase.id]);
    writeFileSync(casesPath, `${JSON.stringify({ ...sourceCase, prompt: "tampered after materialization" })}\n`);
    await assert.rejects(
      () => loadRealBenchmarkInputs([{ importManifestPath, casesPath, materializationManifestPath }]),
      /benchmark_normalized_case_sha_mismatch/,
    );
  } finally {
    rmSync(bundleRoot, { recursive: true, force: true });
  }

  console.log("benchmark-real-runner: quotas, Oracle isolation, auto-stop and paid resume gates passed ✓");
})();

if (process.argv[1]?.includes("benchmark-real-runner.test")) {
  benchmarkRealRunnerTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
