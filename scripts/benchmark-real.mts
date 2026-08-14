import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { createProductionBenchmarkExecutor } from "../lib/evaluation/benchmarks/production-executor.ts";
import {
  appendRealBenchmarkCheckpointEvent,
  createRunStartedEvent,
  createRunStoppedEvent,
  readRealBenchmarkCheckpointEvents,
  reconstructRealBenchmarkResumeState,
  type RealBenchmarkCheckpointEvent,
} from "../lib/evaluation/benchmarks/real-checkpoint.ts";
import {
  loadRealBenchmarkInputs,
  runRealBenchmarkSuite,
  selectRealBenchmarkCases,
  type RealBenchmarkDatasetBundlePaths,
} from "../lib/evaluation/benchmarks/real-runner.ts";
import {
  BenchmarkProfileSchema,
  BenchmarkEvaluationLayerSchema,
  RealBenchmarkRunConfigSchema,
  type BenchmarkEvaluationLayer,
  type BenchmarkProfile,
  type RealBenchmarkRunConfig,
} from "../lib/evaluation/benchmarks/contracts.ts";
import { selectCasesForEvaluationLayer } from "../lib/evaluation/benchmarks/evaluation-layers.ts";
import { createDirectModelBenchmarkExecutor } from "../lib/evaluation/benchmarks/model-executor.ts";
import { runBenchmarkPreflight, resolveMessagesEndpoint } from "../lib/evaluation/benchmarks/preflight.ts";
import { serializeBenchmarkRunReport } from "../lib/evaluation/benchmarks/report.ts";
import { closeProductionBenchmarkRuntime } from "../lib/evaluation/benchmarks/runtime-cleanup.ts";
import { assertProductionBenchmarkValidatorCoverage } from "../lib/evaluation/benchmarks/validator-coverage.ts";
import { readAgentSettings } from "../lib/settings/agent-settings.ts";

const goalRoot = path.join(
  process.cwd(),
  ".finwork-test",
  "benchmarks",
  "goal",
  "spec-real-api-benchmark-execution-v1",
);

type GoalState = {
  importedManifests?: RealBenchmarkDatasetBundlePaths[];
  activeRunIds?: string[];
  finishedRunIds?: string[];
  completedPhases?: number[];
  currentPhase?: number;
  stopReason?: unknown;
  [key: string]: unknown;
};

function parseArgs(argv: string[]): Map<string, string | true> {
  const values = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index]!;
    if (!item.startsWith("--")) throw new Error(`unexpected argument: ${item}`);
    const [key, inlineValue] = item.slice(2).split("=", 2);
    if (inlineValue !== undefined) values.set(key!, inlineValue);
    else if (argv[index + 1] && !argv[index + 1]!.startsWith("--")) values.set(key!, argv[++index]!);
    else values.set(key!, true);
  }
  return values;
}

function requiredString(args: Map<string, string | true>, key: string): string {
  const value = args.get(key);
  if (typeof value !== "string" || !value.trim()) throw new Error(`missing required --${key}`);
  return value.trim();
}

function requiredNumber(args: Map<string, string | true>, key: string): number {
  const raw = requiredString(args, key);
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${key} must be a positive finite number`);
  return value;
}

function optionalNumber(args: Map<string, string | true>, key: string): number | undefined {
  if (!args.has(key)) return undefined;
  const raw = requiredString(args, key);
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) throw new Error(`--${key} must be a non-negative finite number`);
  return value;
}

async function readGoalState(): Promise<GoalState> {
  try {
    return JSON.parse(await readFile(path.join(goalRoot, "state.json"), "utf8")) as GoalState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("benchmark_goal_state_missing");
    throw error;
  }
}

async function assertConnectionSmokePassed(): Promise<void> {
  const phasePath = path.join(goalRoot, "phases", "phase-4.json");
  const phase = JSON.parse(await readFile(phasePath, "utf8")) as {
    status?: unknown;
    realConnectionSmoke?: { ok?: unknown; reportPath?: unknown };
  };
  if (phase.status !== "verified" || phase.realConnectionSmoke?.ok !== true) {
    throw new Error("benchmark_connection_smoke_not_verified");
  }
  if (typeof phase.realConnectionSmoke.reportPath !== "string") {
    throw new Error("benchmark_connection_smoke_report_missing");
  }
  const reportPath = path.resolve(process.cwd(), phase.realConnectionSmoke.reportPath);
  const resolvedGoalRoot = path.resolve(goalRoot);
  if (reportPath !== resolvedGoalRoot && !reportPath.startsWith(`${resolvedGoalRoot}${path.sep}`)) {
    throw new Error("benchmark_connection_smoke_report_path_invalid");
  }
  const report = JSON.parse(await readFile(reportPath, "utf8")) as {
    status?: unknown;
    realApi?: unknown;
    publishable?: unknown;
    probes?: Array<{ role?: unknown }>;
  };
  const roles = new Set((report.probes ?? []).map((probe) => probe.role));
  if (report.status !== "passed" || report.realApi !== true || report.publishable !== false
    || !roles.has("fast") || !roles.has("reasoning")) {
    throw new Error("benchmark_connection_smoke_report_invalid");
  }
}

function resolvePnpmVersion(): string {
  const userAgent = process.env.npm_config_user_agent ?? "";
  const matched = userAgent.match(/(?:^|\s)pnpm\/([^\s]+)/);
  if (matched?.[1]) return matched[1];
  return execFileSync("pnpm", ["--version"], { encoding: "utf8" }).trim();
}

async function buildConfiguration(input: {
  profile: BenchmarkProfile;
  bundles: Awaited<ReturnType<typeof loadRealBenchmarkInputs>>["bundles"];
  sampleSeed: string;
  maxCases: number;
  maxInputTokens: number;
  maxOutputTokens: number;
  maxWallTimeMs: number;
  maxCostUsd?: number;
  pricingKnown: boolean;
  evaluationLayer: BenchmarkEvaluationLayer;
  fixedModel?: string;
}): Promise<RealBenchmarkRunConfig> {
  const settings = await readAgentSettings();
  const packageJson = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string };
  return RealBenchmarkRunConfigSchema.parse({
    kind: "real",
    profile: input.profile,
    evaluationLayer: input.evaluationLayer,
    ...(input.fixedModel ? { fixedModel: input.fixedModel } : {}),
    datasets: input.bundles.map((bundle) => ({
      datasetId: bundle.importManifest.datasetId,
      split: bundle.importManifest.split,
      manifestSha256: bundle.materializationManifest.importManifestSha256,
      sourceSha256: bundle.importManifest.sourceSha256,
      licenseStatus: bundle.importManifest.descriptor.license.status,
    })),
    sampleSeed: input.sampleSeed,
    maxCases: input.maxCases,
    maxInputTokens: input.maxInputTokens,
    maxOutputTokens: input.maxOutputTokens,
    maxWallTimeMs: input.maxWallTimeMs,
    ...(input.maxCostUsd === undefined ? {} : { maxCostUsd: input.maxCostUsd }),
    pricingKnown: input.pricingKnown,
    consent: { environmentGate: true, cliConfirmed: true, explicitBudgets: true },
    providerHost: resolveMessagesEndpoint(settings.apiUrl).host,
    models: {
      fast: settings.fastModel,
      reasoning: settings.reasoningModel,
    },
    modelTierSeparated: settings.fastModel !== settings.reasoningModel,
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
    runnerVersion: "real-benchmark-runner-v1",
    nodeVersion: process.version,
    pnpmVersion: resolvePnpmVersion(),
    appVersion: packageJson.version ?? "unknown",
  });
}

async function atomicWrite(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function updateGoalState(input: {
  state: GoalState;
  runId: string;
  terminal: boolean;
  completed: boolean;
  stopReason: unknown;
}): Promise<void> {
  const active = new Set(input.state.activeRunIds ?? []);
  const finished = new Set(input.state.finishedRunIds ?? []);
  const priorPhase = typeof input.state.currentPhase === "number" ? input.state.currentPhase : 5;
  active.delete(input.runId);
  if (input.terminal) finished.add(input.runId);
  else active.add(input.runId);
  await atomicWrite(path.join(goalRoot, "state.json"), `${JSON.stringify({
    ...input.state,
    currentPhase: input.completed ? Math.max(priorPhase, 6) : Math.max(priorPhase, 5),
    activeRunIds: [...active],
    finishedRunIds: [...finished],
    stopReason: input.stopReason,
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`);
}

async function runMain(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.has("help")) {
    console.log([
      "Usage:",
      "  FINWORK_ALLOW_REAL_API_BENCHMARKS=1 pnpm eval:benchmarks:real -- --profile benchmark-smoke --confirm-real-api --max-cases 7 --max-input-tokens 120000 --max-output-tokens 20000 --max-wall-ms 1800000",
      "  Add --preview for a zero-network full data/config gate.",
      "  Layer 2: add --layer agent --fixed-model <id>; routing is deterministic and all nested agents use that model.",
      "  Layer 3 single cell: add --layer model --fixed-model <id>; it calls the model directly with no tools.",
      "  Use eval:benchmarks:model-matrix to preview the required repeated cells.",
      "  Resume with --resume-run <id>; an interrupted paid case additionally requires --confirm-unknown-case-reviewed.",
      "Dataset bundle paths are read from Goal state importedManifests.",
    ].join("\n"));
    return;
  }
  const profile = BenchmarkProfileSchema.parse(requiredString(args, "profile"));
  const evaluationLayer = BenchmarkEvaluationLayerSchema.parse(
    typeof args.get("layer") === "string" ? args.get("layer") : "mixed",
  );
  if (evaluationLayer === "harness") throw new Error("use eval:benchmarks:harness for deterministic Harness evaluation");
  const fixedModel = typeof args.get("fixed-model") === "string" ? String(args.get("fixed-model")).trim() : undefined;
  if ((evaluationLayer === "agent" || evaluationLayer === "model") && !fixedModel) {
    throw new Error(`${evaluationLayer} evaluation requires --fixed-model`);
  }
  if (profile === "connection-smoke") throw new Error("use eval:benchmarks:preflight for connection-smoke");
  const confirmRealApi = args.get("confirm-real-api") === true;
  const environmentGate = process.env.FINWORK_ALLOW_REAL_API_BENCHMARKS === "1";
  const preview = args.get("preview") === true;
  const maxCases = requiredNumber(args, "max-cases");
  const maxInputTokens = requiredNumber(args, "max-input-tokens");
  const maxOutputTokens = requiredNumber(args, "max-output-tokens");
  const maxWallTimeMs = requiredNumber(args, "max-wall-ms");
  const maxCostUsd = optionalNumber(args, "max-cost-usd");
  const sampleSeed = typeof args.get("sample-seed") === "string" ? String(args.get("sample-seed")) : "real-benchmark-v1";
  const state = await readGoalState();
  const bundlePaths = state.importedManifests ?? [];
  const loaded = await loadRealBenchmarkInputs(bundlePaths);
  const profileCases = selectRealBenchmarkCases({
    profile,
    cases: loaded.cases,
    bundles: loaded.bundles,
    sampleSeed,
    maxCases,
  });
  const selectedCases = selectCasesForEvaluationLayer(profileCases, evaluationLayer);
  if (selectedCases.length === 0) throw new Error(`benchmark_layer_has_no_cases:${evaluationLayer}`);
  assertProductionBenchmarkValidatorCoverage(selectedCases);
  const materializationManifestPaths = bundlePaths.map((bundle) => path.resolve(bundle.materializationManifestPath));
  const preflight = await runBenchmarkPreflight({
    target: profile,
    preview,
    confirmRealApi,
    environmentGate,
    budgets: { maxCases: selectedCases.length, maxInputTokens, maxOutputTokens, maxWallMs: maxWallTimeMs, maxCostUsd },
    materializationManifestPaths,
  });
  console.log(JSON.stringify(preflight, null, 2));
  if (!preflight.ok) throw new Error("benchmark_real_preflight_failed");
  const configuration = await buildConfiguration({
    profile,
    bundles: loaded.bundles,
    sampleSeed,
    maxCases: selectedCases.length,
    maxInputTokens,
    maxOutputTokens,
    maxWallTimeMs,
    maxCostUsd,
    pricingKnown: preflight.pricingKnown,
    evaluationLayer,
    fixedModel,
  });
  if (preview) {
    console.log(JSON.stringify({
      preview: true,
      networkRequests: 0,
      evaluationLayer,
      fixedModel: fixedModel ?? null,
      selectedCaseIds: selectedCases.map((benchmarkCase) => benchmarkCase.id),
      configuration,
    }, null, 2));
    return;
  }
  await assertConnectionSmokePassed();

  const resumeRun = typeof args.get("resume-run") === "string" ? String(args.get("resume-run")) : null;
  const runId = resumeRun ?? `real-benchmark-${randomUUID()}`;
  const runDirectory = path.join(goalRoot, "runs", runId);
  const eventsPath = path.join(runDirectory, "events.jsonl");
  const reportPath = path.join(runDirectory, "report.json");
  let resumeResults = undefined;
  let runStartedAtMs: number;
  if (resumeRun) {
    const resume = reconstructRealBenchmarkResumeState({
      events: await readRealBenchmarkCheckpointEvents(eventsPath),
      runId,
      selectedCaseIds: selectedCases.map((benchmarkCase) => benchmarkCase.id),
      configuration,
      confirmUnknownCaseReviewed: args.get("confirm-unknown-case-reviewed") === true,
    });
    if (resume.finished) throw new Error("benchmark_run_already_finished");
    resumeResults = resume.resumeResults;
    runStartedAtMs = Date.parse(resume.startedAt);
    for (const caseId of resume.unknownCaseIds) {
      await appendRealBenchmarkCheckpointEvent(eventsPath, {
        schemaVersion: 1,
        type: "case_rerun_authorized",
        runId,
        at: new Date().toISOString(),
        caseId,
        reason: "provider_usage_and_run_state_reviewed",
      });
    }
  } else {
    const runStartedAt = new Date().toISOString();
    runStartedAtMs = Date.parse(runStartedAt);
    await appendRealBenchmarkCheckpointEvent(eventsPath, createRunStartedEvent({
      runId,
      selectedCaseIds: selectedCases.map((benchmarkCase) => benchmarkCase.id),
      configuration,
      at: runStartedAt,
    }));
  }
  await updateGoalState({ state, runId, terminal: false, completed: false, stopReason: null });

  const abortController = new AbortController();
  const abort = (signal: string) => abortController.abort(new Error(`benchmark interrupted by ${signal}`));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const report = await runRealBenchmarkSuite({
      suiteName: `Finwork real ${profile}`,
      runId,
      selectedCases,
      inputArtifactsByCaseId: loaded.inputArtifactsByCaseId,
      oracleArtifactsByCaseId: loaded.oracleArtifactsByCaseId,
      executor: evaluationLayer === "model"
        ? createDirectModelBenchmarkExecutor({ model: fixedModel! })
        : createProductionBenchmarkExecutor(evaluationLayer === "agent"
            ? { evaluationMode: "fixed-agent", fixedModel }
            : {}),
      configuration,
      signal: abortController.signal,
      resumeResults,
      startedAtMs: runStartedAtMs,
      onCaseStart: async ({ benchmarkCase, ordinal }) => appendRealBenchmarkCheckpointEvent(eventsPath, {
        schemaVersion: 1,
        type: "case_started",
        runId,
        at: new Date().toISOString(),
        caseId: benchmarkCase.id,
        ordinal,
      }),
      onCaseResult: async ({ result, ordinal }) => appendRealBenchmarkCheckpointEvent(eventsPath, {
        schemaVersion: 1,
        type: "case_finished",
        runId,
        at: new Date().toISOString(),
        caseId: result.caseId,
        ordinal,
        result,
      }),
    });
    const settings = await readAgentSettings();
    const serialized = serializeBenchmarkRunReport(report, [settings.apiKey]);
    await atomicWrite(reportPath, serialized);
    const reportSha256 = createHash("sha256").update(serialized).digest("hex");
    let terminalEvent: RealBenchmarkCheckpointEvent;
    if (report.runStatus === "stopped") {
      terminalEvent = createRunStoppedEvent({
        runId,
        reason: report.stopReason ?? { code: "benchmark_stopped" },
        at: new Date().toISOString(),
      });
    } else {
      terminalEvent = {
        schemaVersion: 1,
        type: "run_finished",
        runId,
        at: new Date().toISOString(),
        reportSha256,
      };
    }
    await appendRealBenchmarkCheckpointEvent(eventsPath, terminalEvent);
    const completed = report.runStatus !== "stopped";
    await updateGoalState({
      state,
      runId,
      terminal: true,
      completed,
      stopReason: completed ? null : report.stopReason,
    });
    console.log(JSON.stringify({ reportPath, eventsPath, runStatus: report.runStatus, totals: report.totals }, null, 2));
    if (!completed) process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}

async function main(): Promise<void> {
  try {
    await runMain();
  } finally {
    await closeProductionBenchmarkRuntime();
  }
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    code: error instanceof Error ? error.message : "benchmark_real_failed",
  }));
  process.exitCode = 1;
});
