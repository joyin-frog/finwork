import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import type { ArtifactRef } from "@/lib/artifacts/contracts";
import { canonicalJson } from "@/lib/capability/hash";
import type { FaultDomain } from "@/lib/evaluation/contracts";
import {
  BenchmarkImportManifestSchema,
  BenchmarkMaterializationManifestSchema,
  BenchmarkProfileSchema,
  BenchmarkCaseResultV2Schema,
  RealBenchmarkRunConfigSchema,
  type BenchmarkCaseResultV2,
  type BenchmarkDatasetId,
  type BenchmarkExecutor,
  type BenchmarkImportManifest,
  type BenchmarkMaterializationManifest,
  type BenchmarkProfile,
  type BenchmarkRunReportV2,
  type NormalizedBenchmarkCase,
  type RealBenchmarkRunConfig,
} from "./contracts";
import { readNormalizedBenchmarkCases } from "./importer";
import { deterministicallySampleBenchmarkCases } from "./report";
import { runBenchmarkSuite } from "./runner";
import { validateSpreadsheetBenchmarkPrediction } from "./spreadsheet-oracle";
import { assertProductionBenchmarkValidatorCoverage } from "./validator-coverage";
import { validateGeneralAgentPilotPrediction } from "./general-agent-oracle";

export type RealBenchmarkDatasetBundlePaths = {
  importManifestPath: string;
  casesPath: string;
  materializationManifestPath: string;
};

export type LoadedRealBenchmarkBundle = {
  importManifest: BenchmarkImportManifest;
  materializationManifest: BenchmarkMaterializationManifest;
  cases: NormalizedBenchmarkCase[];
};

export type LoadedRealBenchmarkInputs = {
  bundles: LoadedRealBenchmarkBundle[];
  cases: NormalizedBenchmarkCase[];
  inputArtifactsByCaseId: Record<string, ArtifactRef[]>;
  oracleArtifactsByCaseId: Record<string, ArtifactRef[]>;
};

export type RealBenchmarkStopReason = { code: string; faultDomain?: FaultDomain };

type RealBenchmarkUsageTotals = {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
};

const PROFILE_QUOTAS: Readonly<Partial<Record<BenchmarkProfile, Partial<Record<BenchmarkDatasetId, number>>>>> = {
  "benchmark-smoke": { finqa: 2, tatqa: 2, financebench: 2, spreadsheetbench_v2: 1 },
  pilot: { finqa: 25, tatqa: 25, financebench: 20, spreadsheetbench_v2: 5 },
  "general-agent-pilot": { general_agent_pilot: 30 },
};

export async function loadRealBenchmarkInputs(
  paths: readonly RealBenchmarkDatasetBundlePaths[],
): Promise<LoadedRealBenchmarkInputs> {
  if (paths.length === 0) throw new Error("benchmark_real_dataset_bundles_missing");
  const bundles = await Promise.all(paths.map(loadBundle));
  const cases = bundles.flatMap((bundle) => bundle.cases);
  if (new Set(cases.map((benchmarkCase) => benchmarkCase.id)).size !== cases.length) {
    throw new Error("benchmark_real_case_id_collision");
  }
  const inputArtifactsByCaseId = Object.fromEntries(bundles.flatMap((bundle) =>
    bundle.materializationManifest.cases.map((entry) => [entry.caseId, entry.inputArtifacts] as const)
  ));
  const oracleArtifactsByCaseId = Object.fromEntries(bundles.flatMap((bundle) =>
    bundle.materializationManifest.cases.flatMap((entry) =>
      entry.oracleArtifacts?.length ? [[entry.caseId, entry.oracleArtifacts] as const] : []
    )
  ));
  return { bundles, cases, inputArtifactsByCaseId, oracleArtifactsByCaseId };
}

export function selectRealBenchmarkCases(input: {
  profile: BenchmarkProfile;
  cases: readonly NormalizedBenchmarkCase[];
  bundles: readonly LoadedRealBenchmarkBundle[];
  sampleSeed: string;
  maxCases: number;
}): NormalizedBenchmarkCase[] {
  const profile = BenchmarkProfileSchema.parse(input.profile);
  if (profile === "connection-smoke") throw new Error("connection-smoke does not execute benchmark cases");
  if (!Number.isInteger(input.maxCases) || input.maxCases <= 0) throw new Error("maxCases must be a positive integer");
  const quota = PROFILE_QUOTAS[profile];
  if (!quota) {
    const manifestKey = input.bundles
      .map((bundle) => bundle.materializationManifest.importManifestSha256)
      .sort()
      .join(":");
    return deterministicallySampleBenchmarkCases(input.cases, sha256(manifestKey), input.sampleSeed, input.maxCases);
  }
  const expectedTotal = Object.values(quota).reduce((sum, count) => sum + (count ?? 0), 0);
  if (input.maxCases !== expectedTotal) {
    throw new Error(`${profile} requires --max-cases ${expectedTotal}`);
  }
  const selected: NormalizedBenchmarkCase[] = [];
  for (const datasetId of Object.keys(quota).sort() as BenchmarkDatasetId[]) {
    const count = quota[datasetId] ?? 0;
    const candidates = input.cases.filter((benchmarkCase) => benchmarkCase.datasetId === datasetId);
    if (candidates.length < count) {
      throw new Error(`benchmark_dataset_insufficient:${datasetId}:${count}:${candidates.length}`);
    }
    const bundleHashes = input.bundles
      .filter((bundle) => bundle.importManifest.datasetId === datasetId)
      .map((bundle) => bundle.materializationManifest.importManifestSha256)
      .sort()
      .join(":");
    selected.push(...deterministicallySampleBenchmarkCases(candidates, sha256(bundleHashes), input.sampleSeed, count));
  }
  return selected;
}

export function createRealBenchmarkStopPolicy(input: {
  config: RealBenchmarkRunConfig;
  startedAtMs: number;
  now?: () => number;
}): (result: BenchmarkCaseResultV2, results: readonly BenchmarkCaseResultV2[]) => RealBenchmarkStopReason | null {
  const config = RealBenchmarkRunConfigSchema.parse(input.config);
  const now = input.now ?? Date.now;
  return (result, results) => {
    const code = result.execution.stableFailureCode ?? result.failures[0] ?? null;
    if (result.execution.termination.cancelled || result.execution.termination.aborted) {
      return { code: "benchmark_run_cancelled", faultDomain: "resource" };
    }
    if (result.execution.termination.timedOut) {
      return { code: "benchmark_wall_time_exceeded", faultDomain: "resource" };
    }
    if (code === "provider_auth_failed") return { code, faultDomain: "dependency" };
    if (code === "provider_auth_unavailable") return { code, faultDomain: "dependency" };
    if (code === "provider_model_or_endpoint_invalid") return { code, faultDomain: "dependency" };
    if (result.datasetId === "spreadsheetbench_v2" && (
      result.scores.artifact !== 1
      || !result.execution.validation.delivery.passed
      || result.execution.validation.assertions.failed > 0
    )) {
      return { code: "spreadsheet_delivery_validation_failed", faultDomain: "validator" };
    }
    if (result.faultDomain === "resource") {
      return { code: code ?? "benchmark_resource_limit", faultDomain: "resource" };
    }
    const totals = sumRealBenchmarkUsage(results);
    if (totals.inputTokens >= config.maxInputTokens) return { code: "benchmark_input_token_budget_exceeded", faultDomain: "resource" };
    if (totals.outputTokens >= config.maxOutputTokens) return { code: "benchmark_output_token_budget_exceeded", faultDomain: "resource" };
    if (config.pricingKnown && config.maxCostUsd !== undefined && totals.costUsd >= config.maxCostUsd) {
      return { code: "benchmark_cost_budget_exceeded", faultDomain: "resource" };
    }
    if (now() - input.startedAtMs >= config.maxWallTimeMs) {
      return { code: "benchmark_wall_time_exceeded", faultDomain: "resource" };
    }
    let consecutiveInfrastructureFailures = 0;
    for (let index = results.length - 1; index >= 0; index -= 1) {
      const domain = results[index]!.faultDomain;
      if (domain !== "dependency" && domain !== "evaluator") break;
      consecutiveInfrastructureFailures += 1;
    }
    if (consecutiveInfrastructureFailures >= 3) {
      return { code: "benchmark_consecutive_infrastructure_failures", faultDomain: result.faultDomain };
    }
    return null;
  };
}

export function createRealBenchmarkPreCaseStopPolicy(input: {
  config: RealBenchmarkRunConfig;
  startedAtMs: number;
  now?: () => number;
}): (results: readonly BenchmarkCaseResultV2[]) => RealBenchmarkStopReason | null {
  const config = RealBenchmarkRunConfigSchema.parse(input.config);
  const now = input.now ?? Date.now;
  return (results) => {
    const totals = sumRealBenchmarkUsage(results);
    if (totals.inputTokens >= config.maxInputTokens) return { code: "benchmark_input_token_budget_exceeded", faultDomain: "resource" };
    if (totals.outputTokens >= config.maxOutputTokens) return { code: "benchmark_output_token_budget_exceeded", faultDomain: "resource" };
    if (config.pricingKnown && config.maxCostUsd !== undefined && totals.costUsd >= config.maxCostUsd) {
      return { code: "benchmark_cost_budget_exceeded", faultDomain: "resource" };
    }
    if (now() - input.startedAtMs >= config.maxWallTimeMs) {
      return { code: "benchmark_wall_time_exceeded", faultDomain: "resource" };
    }
    return null;
  };
}

export async function runRealBenchmarkSuite(input: {
  suiteName: string;
  runId: string;
  selectedCases: readonly NormalizedBenchmarkCase[];
  inputArtifactsByCaseId: Readonly<Record<string, ArtifactRef[]>>;
  oracleArtifactsByCaseId: Readonly<Record<string, ArtifactRef[]>>;
  executor: BenchmarkExecutor;
  configuration: RealBenchmarkRunConfig;
  signal?: AbortSignal;
  resumeResults?: readonly BenchmarkCaseResultV2[];
  startedAtMs?: number;
  now?: () => Date;
  onCaseStart?: Parameters<typeof runBenchmarkSuite>[0]["onCaseStart"];
  onCaseResult?: Parameters<typeof runBenchmarkSuite>[0]["onCaseResult"];
}): Promise<BenchmarkRunReportV2> {
  assertProductionBenchmarkValidatorCoverage(input.selectedCases);
  const configuration = RealBenchmarkRunConfigSchema.parse(input.configuration);
  const clock = () => (input.now?.() ?? new Date()).getTime();
  const startedAtMs = input.startedAtMs ?? clock();
  const stopPolicy = createRealBenchmarkStopPolicy({
    config: configuration,
    startedAtMs,
    now: clock,
  });
  const preCaseStopPolicy = createRealBenchmarkPreCaseStopPolicy({
    config: configuration,
    startedAtMs,
    now: clock,
  });
  return runBenchmarkSuite({
    suiteName: input.suiteName,
    runId: input.runId,
    cases: input.selectedCases,
    executor: input.executor,
    signal: input.signal,
    publishable: input.selectedCases.every((benchmarkCase) => benchmarkCase.provenance.licenseStatus === "verified"),
    inputArtifactsByCaseId: input.inputArtifactsByCaseId,
    oracleArtifactsByCaseId: input.oracleArtifactsByCaseId,
    validatePrediction: ({ executionCase, oracle, prediction }) => executionCase.datasetId === "general_agent_pilot"
      ? validateGeneralAgentPilotPrediction({ executionCase, oracle, prediction })
      : validateSpreadsheetBenchmarkPrediction({ oracle, prediction }),
    configuration,
    resumeResults: input.resumeResults,
    now: input.now,
    taskContractOptionsForCase: ({ results }) => {
      const totals = sumRealBenchmarkUsage(results);
      return {
        tokenLimit: Math.max(1, configuration.maxInputTokens + configuration.maxOutputTokens
          - totals.inputTokens - totals.outputTokens),
        wallTimeMs: Math.max(1, configuration.maxWallTimeMs - (clock() - startedAtMs)),
      };
    },
    onCaseStart: input.onCaseStart,
    onCaseResult: input.onCaseResult,
    stopBeforeCase: ({ results }) => preCaseStopPolicy(results),
    stopAfterCase: ({ result, results }) => stopPolicy(result, results),
  });
}

function sumRealBenchmarkUsage(results: readonly BenchmarkCaseResultV2[]): RealBenchmarkUsageTotals {
  return results.reduce((sum, item) => ({
    inputTokens: sum.inputTokens
      + item.execution.inputTokens
      + item.execution.cacheReadInputTokens
      + item.execution.cacheCreationInputTokens,
    outputTokens: sum.outputTokens + item.execution.outputTokens,
    costUsd: sum.costUsd + (item.execution.costUsd ?? 0),
  }), { inputTokens: 0, outputTokens: 0, costUsd: 0 });
}

async function loadBundle(paths: RealBenchmarkDatasetBundlePaths): Promise<LoadedRealBenchmarkBundle> {
  const [manifestBytes, cases, materializationBytes] = await Promise.all([
    fs.readFile(paths.importManifestPath),
    readNormalizedBenchmarkCases(paths.casesPath),
    fs.readFile(paths.materializationManifestPath),
  ]);
  const importManifest = BenchmarkImportManifestSchema.parse(JSON.parse(manifestBytes.toString("utf8")));
  const materializationManifest = BenchmarkMaterializationManifestSchema.parse(JSON.parse(materializationBytes.toString("utf8")));
  if (sha256(manifestBytes) !== materializationManifest.importManifestSha256) {
    throw new Error(`benchmark_import_manifest_sha_mismatch:${importManifest.datasetId}`);
  }
  if (importManifest.datasetId !== materializationManifest.datasetId
    || importManifest.datasetVersion !== materializationManifest.datasetVersion
    || importManifest.split !== materializationManifest.split
    || importManifest.sourceSha256 !== materializationManifest.sourceSha256) {
    throw new Error(`benchmark_materialization_identity_mismatch:${importManifest.datasetId}`);
  }
  if (cases.length !== importManifest.normalizedCases || cases.length !== materializationManifest.cases.length) {
    throw new Error(`benchmark_materialization_case_count_mismatch:${importManifest.datasetId}`);
  }
  const entries = new Map(materializationManifest.cases.map((entry) => [entry.caseId, entry]));
  for (const benchmarkCase of cases) {
    if (benchmarkCase.datasetId !== importManifest.datasetId
      || benchmarkCase.datasetVersion !== importManifest.datasetVersion
      || benchmarkCase.split !== importManifest.split
      || benchmarkCase.provenance.sourceSha256 !== importManifest.sourceSha256) {
      throw new Error(`benchmark_import_case_identity_mismatch:${benchmarkCase.id}`);
    }
    const entry = entries.get(benchmarkCase.id);
    if (!entry || entry.normalizedCaseSha256 !== sha256(canonicalJson(benchmarkCase))) {
      throw new Error(`benchmark_normalized_case_sha_mismatch:${benchmarkCase.id}`);
    }
  }
  return { importManifest, materializationManifest, cases };
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function parseResumeResults(values: readonly unknown[]): BenchmarkCaseResultV2[] {
  return values.map((value) => BenchmarkCaseResultV2Schema.parse(value));
}
