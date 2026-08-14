import { randomUUID } from "node:crypto";
import type { ArtifactRef } from "@/lib/artifacts/contracts";
import {
  BenchmarkCaseResultSchema,
  BenchmarkCaseResultV2Schema,
  BenchmarkRunConfigSnapshotSchema,
  BenchmarkRunReportV2Schema,
  type BenchmarkCapability,
  type BenchmarkCaseResult,
  type BenchmarkCaseResultV2,
  type BenchmarkDatasetId,
  type BenchmarkExecutor,
  type BenchmarkEvaluationOracle,
  type BenchmarkExecutionCase,
  type BenchmarkExecutionContext,
  type BenchmarkPrediction,
  type BenchmarkRunConfigSnapshot,
  type BenchmarkRunReportV2,
  type BenchmarkRunSourceV2,
  type BenchmarkScores,
  type NormalizedBenchmarkCase,
} from "./contracts";
import type { FaultDomain } from "@/lib/evaluation/contracts";
import { partitionBenchmarkCase } from "./case-boundary";
import { createFixtureOracle, type BenchmarkFixtureOracle } from "./fixture-oracle";
import {
  createBenchmarkTaskContract,
  type BenchmarkTaskContractOptions,
} from "./task-contract";
import { scoreBenchmarkPrediction } from "./scoring";
import {
  createEmptyExecutionSummary,
  sanitizeBenchmarkDetails,
  sha256Text,
} from "./report";

export interface RunBenchmarkSuiteOptions {
  suiteName: string;
  cases: readonly NormalizedBenchmarkCase[];
  executor: BenchmarkExecutor;
  signal?: AbortSignal;
  runId?: string;
  now?: () => Date;
  publishable?: boolean;
  inputArtifactsByCaseId?: Readonly<Record<string, ArtifactRef[]>>;
  oracleArtifactsByCaseId?: Readonly<Record<string, ArtifactRef[]>>;
  validatePrediction?: (input: {
    executionCase: BenchmarkExecutionCase;
    oracle: BenchmarkEvaluationOracle;
    prediction: BenchmarkPrediction;
  }) => Promise<BenchmarkPrediction>;
  configuration?: BenchmarkRunConfigSnapshot;
  taskContractOptions?: BenchmarkTaskContractOptions;
  taskContractOptionsForCase?: (input: {
    benchmarkCase: NormalizedBenchmarkCase;
    results: readonly BenchmarkCaseResultV2[];
  }) => BenchmarkTaskContractOptions;
  resumeResults?: readonly BenchmarkCaseResultV2[];
  onCaseStart?: (input: { benchmarkCase: NormalizedBenchmarkCase; ordinal: number; runId: string }) => void | Promise<void>;
  onCaseResult?: (input: { result: BenchmarkCaseResultV2; ordinal: number; runId: string }) => void | Promise<void>;
  stopAfterCase?: (input: {
    result: BenchmarkCaseResultV2;
    results: readonly BenchmarkCaseResultV2[];
  }) => { code: string; faultDomain?: FaultDomain } | null;
  stopBeforeCase?: (input: {
    benchmarkCase: NormalizedBenchmarkCase;
    results: readonly BenchmarkCaseResultV2[];
  }) => { code: string; faultDomain?: FaultDomain } | null;
}

export interface RunBenchmarkFixtureSuiteOptions {
  suiteName: string;
  cases: readonly NormalizedBenchmarkCase[];
  signal?: AbortSignal;
  runId?: string;
  now?: () => Date;
  publishable?: false;
  inputArtifactsByCaseId?: Readonly<Record<string, ArtifactRef[]>>;
  oracleArtifactsByCaseId?: Readonly<Record<string, ArtifactRef[]>>;
  validatePrediction?: RunBenchmarkSuiteOptions["validatePrediction"];
  oracle?: BenchmarkFixtureOracle;
  configuration?: BenchmarkRunConfigSnapshot;
}

type BenchmarkPredictionProvider = (
  executionCase: BenchmarkExecutionCase,
  oracle: BenchmarkEvaluationOracle,
  context: BenchmarkExecutionContext,
) => Promise<BenchmarkPrediction>;

const SCORE_KEYS: Array<keyof BenchmarkScores> = [
  "exactMatch",
  "numericAccuracy",
  "tokenF1",
  "citationPrecision",
  "citationRecall",
  "artifact",
  "contract",
  "performance",
];

function aggregateScores(results: readonly BenchmarkCaseResult[]): BenchmarkScores {
  return Object.fromEntries(SCORE_KEYS.map((key) => {
    const values = results.flatMap((result) => {
      const value = result.scores[key];
      return value === null ? [] : [value];
    });
    const emptyValue = key === "contract" || key === "performance" ? 0 : null;
    return [key, values.length === 0 ? emptyValue : values.reduce((sum, value) => sum + value, 0) / values.length];
  })) as BenchmarkScores;
}

function incrementSummary<Key extends string>(
  target: Partial<Record<Key, { cases: number; passed: number }>>,
  key: Key,
  passed: boolean,
): void {
  const current = target[key] ?? { cases: 0, passed: 0 };
  target[key] = { cases: current.cases + 1, passed: current.passed + (passed ? 1 : 0) };
}

interface RunBenchmarkSuiteInternalOptions {
  suiteName: string;
  cases: readonly NormalizedBenchmarkCase[];
  predictionProvider: BenchmarkPredictionProvider;
  signal?: AbortSignal;
  runId?: string;
  now?: () => Date;
  fixtureOracle: boolean;
  publishable: boolean;
  inputArtifactsByCaseId?: Readonly<Record<string, ArtifactRef[]>>;
  oracleArtifactsByCaseId?: Readonly<Record<string, ArtifactRef[]>>;
  validatePrediction?: RunBenchmarkSuiteOptions["validatePrediction"];
  configuration?: BenchmarkRunConfigSnapshot;
  taskContractOptions?: BenchmarkTaskContractOptions;
  taskContractOptionsForCase?: RunBenchmarkSuiteOptions["taskContractOptionsForCase"];
  resumeResults?: readonly BenchmarkCaseResultV2[];
  onCaseStart?: RunBenchmarkSuiteOptions["onCaseStart"];
  onCaseResult?: RunBenchmarkSuiteOptions["onCaseResult"];
  stopAfterCase?: RunBenchmarkSuiteOptions["stopAfterCase"];
  stopBeforeCase?: RunBenchmarkSuiteOptions["stopBeforeCase"];
}

function buildCaseResult(input: {
  result: BenchmarkCaseResult;
  benchmarkCase: NormalizedBenchmarkCase;
  runId: string;
  prediction?: BenchmarkPrediction;
  failureCode?: string;
}): BenchmarkCaseResultV2 {
  const execution = input.prediction?.execution ?? createEmptyExecutionSummary({
    runId: input.runId,
    benchmarkCase: input.benchmarkCase,
    failureCode: input.failureCode ?? input.result.failures[0] ?? null,
  });
  return BenchmarkCaseResultV2Schema.parse({
    ...input.result,
    details: sanitizeBenchmarkDetails(input.result.details),
    execution,
  });
}

async function runBenchmarkSuiteInternal(options: RunBenchmarkSuiteInternalOptions): Promise<BenchmarkRunReportV2> {
  if (options.cases.length === 0) {
    throw new Error("benchmark suite requires at least one normalized case");
  }
  if (options.fixtureOracle && options.publishable) {
    throw new Error("fixture-oracle reports are wiring checks and cannot be publishable");
  }
  if (options.publishable && options.cases.some((benchmarkCase) => benchmarkCase.provenance.licenseStatus !== "verified")) {
    throw new Error("publishable benchmark reports require verified licenses for every source dataset");
  }

  const now = options.now ?? (() => new Date());
  const runId = options.runId ?? `benchmark-${randomUUID()}`;
  const configuration = BenchmarkRunConfigSnapshotSchema.parse(options.configuration ?? {
    kind: options.fixtureOracle ? "fixture" : "harness",
    sampleSeed: "ordered-input-v1",
    maxCases: options.cases.length,
  });
  const realApi = configuration.kind === "real";
  if (options.fixtureOracle && configuration.kind !== "fixture") {
    throw new Error("fixture oracle requires fixture benchmark configuration");
  }
  if (!options.fixtureOracle && configuration.kind === "fixture") {
    throw new Error("fixture benchmark configuration requires fixture oracle");
  }
  if (configuration.kind !== "legacy-v1" && options.cases.length > configuration.maxCases) {
    throw new Error(`benchmark case count ${options.cases.length} exceeds configured maxCases ${configuration.maxCases}`);
  }
  const startedAt = now().toISOString();
  const caseIds = new Set(options.cases.map((benchmarkCase) => benchmarkCase.id));
  const results = (options.resumeResults ?? []).map((result) => BenchmarkCaseResultV2Schema.parse(result));
  if (new Set(results.map((result) => result.caseId)).size !== results.length) {
    throw new Error("benchmark resume results contain duplicate case IDs");
  }
  if (results.some((result) => !caseIds.has(result.caseId))) {
    throw new Error("benchmark resume result does not belong to the selected suite");
  }
  let stopReason: { code: string; faultDomain?: FaultDomain } | null = null;

  for (const [ordinal, benchmarkCase] of options.cases.entries()) {
    if (results.some((result) => result.caseId === benchmarkCase.id)) continue;
    stopReason = options.stopBeforeCase?.({ benchmarkCase, results }) ?? null;
    if (stopReason) break;
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : new Error("benchmark run aborted");
    }
    await options.onCaseStart?.({ benchmarkCase, ordinal, runId });
    const { executionCase, oracle } = partitionBenchmarkCase(
      benchmarkCase,
      options.inputArtifactsByCaseId?.[benchmarkCase.id],
      options.oracleArtifactsByCaseId?.[benchmarkCase.id],
    );
    const taskContractOptions = options.taskContractOptionsForCase?.({ benchmarkCase, results })
      ?? options.taskContractOptions;
    const materialization = createBenchmarkTaskContract(executionCase, taskContractOptions);
    if (materialization.missingExternalInputs.length > 0) {
      const result = scoreFailureResult({
        caseId: benchmarkCase.id,
        datasetId: benchmarkCase.datasetId,
        status: "failed",
        faultDomain: "capability",
        scores: {
          exactMatch: null,
          numericAccuracy: null,
          tokenF1: null,
          citationPrecision: null,
          citationRecall: null,
          artifact: benchmarkCase.expected.artifact ? 0 : null,
          contract: 0,
          performance: 1,
        },
        failures: ["benchmark_input_not_materialized"],
        capabilities: benchmarkCase.capabilities,
        metrics: { wallTimeMs: 0, tokens: 0, retries: 0, toolCalls: 0 },
        details: { missingExternalInputs: materialization.missingExternalInputs },
      });
      const built = buildCaseResult({ result, benchmarkCase, runId, failureCode: "benchmark_input_not_materialized" });
      results.push(built);
      await options.onCaseResult?.({ result: built, ordinal, runId });
      stopReason = options.stopAfterCase?.({ result: built, results }) ?? null;
      if (stopReason) break;
      continue;
    }
    let built: BenchmarkCaseResultV2;
    try {
      const rawPrediction = await options.predictionProvider(executionCase, oracle, {
        signal: options.signal,
        taskContract: materialization.contract,
        missingExternalInputs: materialization.missingExternalInputs,
      });
      const prediction = options.validatePrediction
        ? await options.validatePrediction({ executionCase, oracle, prediction: rawPrediction })
        : rawPrediction;
      built = buildCaseResult({
        result: scoreBenchmarkPrediction(executionCase, oracle, prediction),
        benchmarkCase,
        runId,
        prediction,
      });
    } catch (error) {
      const result = scoreFailureResult({
        caseId: benchmarkCase.id,
        datasetId: benchmarkCase.datasetId,
        status: "error",
        faultDomain: "evaluator",
        scores: {
          exactMatch: null,
          numericAccuracy: null,
          tokenF1: null,
          citationPrecision: null,
          citationRecall: null,
          artifact: benchmarkCase.expected.artifact ? 0 : null,
          contract: 0,
          performance: 0,
        },
        failures: ["evaluator_error"],
        capabilities: benchmarkCase.capabilities,
        metrics: { wallTimeMs: 0, tokens: 0, retries: 0, toolCalls: 0 },
        details: { message: error instanceof Error ? error.message : String(error) },
      });
      built = buildCaseResult({ result, benchmarkCase, runId, failureCode: "evaluator_error" });
    }
    results.push(built);
    await options.onCaseResult?.({ result: built, ordinal, runId });
    stopReason = options.stopAfterCase?.({ result: built, results }) ?? null;
    if (stopReason) break;
  }

  const byDataset: Partial<Record<BenchmarkDatasetId, { cases: number; passed: number }>> = {};
  const byCapability: Partial<Record<BenchmarkCapability, { cases: number; passed: number }>> = {};
  const byFaultDomain: Partial<Record<NonNullable<BenchmarkCaseResult["faultDomain"]>, number>> = {};
  for (const result of results) {
    incrementSummary(byDataset, result.datasetId, result.status === "passed");
    for (const capability of result.capabilities) incrementSummary(byCapability, capability, result.status === "passed");
    if (result.faultDomain) byFaultDomain[result.faultDomain] = (byFaultDomain[result.faultDomain] ?? 0) + 1;
  }

  const sourceMap = new Map<string, BenchmarkRunSourceV2>();
  for (const benchmarkCase of options.cases) {
    const key = [
      benchmarkCase.datasetId,
      benchmarkCase.datasetVersion,
      benchmarkCase.split,
      benchmarkCase.provenance.sourceSha256,
    ].join(":");
    const existing = sourceMap.get(key);
    if (existing) {
      existing.caseCount += 1;
      continue;
    }
    const configuredSource = configuration.kind === "real"
      ? configuration.datasets.find((source) => source.datasetId === benchmarkCase.datasetId && source.split === benchmarkCase.split)
      : undefined;
    sourceMap.set(key, {
      datasetId: benchmarkCase.datasetId,
      datasetVersion: benchmarkCase.datasetVersion,
      split: benchmarkCase.split,
      sourceSha256: benchmarkCase.provenance.sourceSha256,
      manifestSha256: configuredSource?.manifestSha256 ?? sha256Text(JSON.stringify({
        datasetId: benchmarkCase.datasetId,
        datasetVersion: benchmarkCase.datasetVersion,
        split: benchmarkCase.split,
        sourceSha256: benchmarkCase.provenance.sourceSha256,
      })),
      licenseStatus: benchmarkCase.provenance.licenseStatus,
      caseCount: 1,
    });
  }

  return BenchmarkRunReportV2Schema.parse({
    schemaVersion: 2,
    runId,
    suiteName: options.suiteName,
    publishable: options.publishable,
    fixtureOracle: options.fixtureOracle,
    realApi,
    configuration,
    startedAt,
    endedAt: now().toISOString(),
    sources: [...sourceMap.values()],
    totals: {
      cases: results.length,
      passed: results.filter((result) => result.status === "passed").length,
      failed: results.filter((result) => result.status === "failed").length,
      errors: results.filter((result) => result.status === "error").length,
    },
    aggregateScores: aggregateScores(results),
    byDataset,
    byCapability,
    byFaultDomain,
    results,
    runStatus: stopReason ? "stopped" : "completed",
    ...(stopReason ? { stopReason } : {}),
  });
}

function scoreFailureResult(input: Omit<BenchmarkCaseResult, "details"> & { details?: unknown }): BenchmarkCaseResult {
  return BenchmarkCaseResultSchema.parse({
    ...input,
    details: sanitizeBenchmarkDetails(input.details ?? {}),
  });
}

/** Production execution entry. The executor receives only BenchmarkExecutionCase. */
export async function runBenchmarkSuite(options: RunBenchmarkSuiteOptions): Promise<BenchmarkRunReportV2> {
  return runBenchmarkSuiteInternal({
    ...options,
    fixtureOracle: false,
    publishable: options.publishable ?? false,
    predictionProvider: (executionCase, _oracle, context) => options.executor(executionCase, context),
  });
}

/**
 * Synthetic wiring-only entry. Keeping this separate makes it impossible to
 * select the fixture oracle through the production BenchmarkExecutor option.
 */
export async function runBenchmarkFixtureSuite(
  options: RunBenchmarkFixtureSuiteOptions,
): Promise<BenchmarkRunReportV2> {
  if ((options as { publishable?: boolean }).publishable) {
    throw new Error("fixture-oracle reports are wiring checks and cannot be publishable");
  }
  const fixtureOracle = options.oracle ?? createFixtureOracle();
  return runBenchmarkSuiteInternal({
    ...options,
    fixtureOracle: true,
    publishable: false,
    configuration: options.configuration ?? {
      kind: "fixture",
      sampleSeed: "ordered-input-v1",
      maxCases: options.cases.length,
    },
    predictionProvider: (_executionCase, oracle) => fixtureOracle(oracle),
  });
}
