import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  runBenchmarkPreflight,
  type BenchmarkPreflightTarget,
  type RealApiBudgets,
} from "../lib/evaluation/benchmarks/preflight.ts";
import {
  ConnectionSmokeExecutionError,
  runConnectionSmoke,
  type ConnectionSmokeReport,
} from "../lib/evaluation/benchmarks/connection-smoke.ts";
import {
  assertConnectionSmokePreviewReceipt,
  createConnectionSmokePreviewReceipt,
} from "../lib/evaluation/benchmarks/preflight-receipt.ts";

const goalRoot = path.join(
  process.cwd(),
  ".finwork-test",
  "benchmarks",
  "goal",
  "spec-real-api-benchmark-execution-v1",
);
const connectionPreviewReceiptPath = path.join(goalRoot, "phases", "phase-4-connection-preview.json");

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

function numberArg(args: Map<string, string | true>, key: string): number | undefined {
  const raw = args.get(key);
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || !raw.trim()) throw new Error(`--${key} requires a number`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a finite number`);
  return value;
}

async function atomicWrite(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, filePath);
}

async function checkpointConnectionSmoke(
  report: ConnectionSmokeReport,
  reportPath: string,
  budgets: RealApiBudgets,
): Promise<void> {
  const statePath = path.join(goalRoot, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8")) as {
    completedPhases?: number[];
    finishedRunIds?: string[];
    [key: string]: unknown;
  };
  const passed = report.status === "passed";
  const completedPhases = new Set(state.completedPhases ?? []);
  if (passed) completedPhases.add(4);
  else completedPhases.delete(4);
  const relativeReportPath = path.relative(process.cwd(), reportPath);
  await atomicWrite(path.join(goalRoot, "phases", "phase-4.json"), {
    phase: 4,
    name: "Preflight and Real Connection Probe",
    status: passed ? "verified" : "stopped",
    updatedAt: new Date().toISOString(),
    staticPreflight: { ok: true, networkRequests: 0 },
    preview: { ok: true, networkRequests: 0 },
    realConnectionSmoke: {
      ok: passed,
      runId: report.runId,
      reportPath: relativeReportPath,
      providerHost: report.providerHost,
      probes: report.probes.map((probe) => ({
        role: probe.role,
        requestedModel: probe.requestedModel,
        responseModel: probe.responseModel,
        responseModelMatchesRequest: probe.responseModelMatchesRequest,
        inputTokens: probe.inputTokens,
        outputTokens: probe.outputTokens,
        retries: probe.retries,
        latencyMs: probe.latencyMs,
      })),
      failure: report.failure,
      budgets,
    },
    automaticStopApplied: !passed,
    benchmarkSmokeStarted: false,
  });
  await atomicWrite(statePath, {
    ...state,
    currentPhase: passed ? 5 : 4,
    completedPhases: [...completedPhases].sort((left, right) => left - right),
    realApiConsent: true,
    finishedRunIds: [...new Set([...(state.finishedRunIds ?? []), report.runId])],
    stopReason: passed ? null : report.failure,
    updatedAt: new Date().toISOString(),
  });
}

const args = parseArgs(process.argv.slice(2));
if (args.has("help")) {
  console.log([
    "Usage:",
    "  pnpm eval:benchmarks:preflight -- --mode static",
    "  FINWORK_ALLOW_REAL_API_BENCHMARKS=1 pnpm eval:benchmarks:preflight -- --mode connection-smoke --preview --confirm-real-api --max-input-tokens 2000 --max-output-tokens 64 --max-wall-ms 120000",
    "  Remove --preview only after the preview result has ok=true.",
  ].join("\n"));
  process.exit(0);
}
const mode = String(args.get("mode") ?? "static") as BenchmarkPreflightTarget;
if (!(["static", "connection-smoke"] as string[]).includes(mode)) {
  throw new Error(`unsupported preflight mode: ${mode}`);
}
const budgets: RealApiBudgets = {
  maxInputTokens: numberArg(args, "max-input-tokens"),
  maxOutputTokens: numberArg(args, "max-output-tokens"),
  maxWallMs: numberArg(args, "max-wall-ms"),
  maxCases: numberArg(args, "max-cases"),
  maxCostUsd: numberArg(args, "max-cost-usd"),
};
const materializationPaths = typeof args.get("materialization-manifests") === "string"
  ? String(args.get("materialization-manifests")).split(",").map((value) => path.resolve(value.trim())).filter(Boolean)
  : [];
const preview = args.get("preview") === true;
const preflight = await runBenchmarkPreflight({
  target: mode,
  preview,
  confirmRealApi: args.get("confirm-real-api") === true,
  environmentGate: process.env.FINWORK_ALLOW_REAL_API_BENCHMARKS === "1",
  budgets,
  materializationManifestPaths: materializationPaths,
});
console.log(JSON.stringify(preflight, null, 2));
if (!preflight.ok) process.exit(1);
if (mode === "static") process.exit(0);
if (preview) {
  await atomicWrite(connectionPreviewReceiptPath, createConnectionSmokePreviewReceipt({
    preflight,
    budgets,
    createdAt: new Date().toISOString(),
  }));
  console.log(JSON.stringify({ previewReceiptPath: connectionPreviewReceiptPath, networkRequests: 0 }, null, 2));
  process.exit(0);
}
await assertConnectionSmokePreviewReceipt({
  receipt: JSON.parse(await readFile(connectionPreviewReceiptPath, "utf8")),
  preflight,
  budgets,
});

let report: ConnectionSmokeReport;
let failed = false;
try {
  report = await runConnectionSmoke({
    budgets: {
      maxInputTokens: budgets.maxInputTokens!,
      maxOutputTokens: budgets.maxOutputTokens!,
      maxWallMs: budgets.maxWallMs!,
      ...(budgets.maxCostUsd === undefined ? {} : { maxCostUsd: budgets.maxCostUsd }),
    },
    pricingKnown: preflight.pricingKnown,
  });
} catch (error) {
  if (!(error instanceof ConnectionSmokeExecutionError)) throw error;
  report = error.report;
  failed = true;
}
const outputRoot = path.join(
  process.cwd(),
  ".finwork-test",
  "benchmarks",
  "goal",
  "spec-real-api-benchmark-execution-v1",
  "runs",
  report.runId,
);
await mkdir(outputRoot, { recursive: true });
const reportPath = path.join(outputRoot, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
await checkpointConnectionSmoke(report, reportPath, budgets);
console.log(JSON.stringify({ reportPath, report }, null, 2));
if (failed) process.exit(1);
