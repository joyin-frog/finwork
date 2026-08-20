import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeGeneralAgentHarnessCase } from "../lib/evaluation/benchmarks/general-agent-harness.ts";
import { importExternalBenchmarkSource } from "../lib/evaluation/benchmarks/importer.ts";
import { selectCasesForEvaluationLayer } from "../lib/evaluation/benchmarks/evaluation-layers.ts";
import { runFinanceProfessionalHarnessSuite } from "../lib/evaluation/benchmarks/finance-professional-harness.ts";
import { runBenchmarkSuite } from "../lib/evaluation/benchmarks/runner.ts";

type HarnessProfile = "general-agent-pilot" | "finance-agent-professional";

function readProfile(argv: string[]): HarnessProfile {
  const index = argv.indexOf("--profile");
  const profile = index >= 0 ? argv[index + 1] : undefined;
  if (profile === "general-agent-pilot" || profile === "finance-agent-professional") return profile;
  throw new Error("usage: pnpm eval:harness -- --profile <general-agent-pilot|finance-agent-professional>");
}

const profile = readProfile(process.argv.slice(2));
const benchmarkRoot = path.join(process.cwd(), "benchmarks", profile, "v1");
const imported = await importExternalBenchmarkSource({
  datasetId: profile === "general-agent-pilot" ? "general_agent_pilot" : "finance_agent_professional",
  datasetVersion: "v1",
  split: "pilot",
  sourcePath: path.join(benchmarkRoot, "cases.jsonl"),
  acknowledgeLicenseReview: false,
});

const report = profile === "general-agent-pilot"
  ? await runBenchmarkSuite({
      suiteName: "Finwork General Agent Pilot Harness",
      cases: selectCasesForEvaluationLayer(imported.cases, "harness"),
      executor: executeGeneralAgentHarnessCase,
      configuration: { kind: "harness", sampleSeed: "pilot-v1", maxCases: 10 },
    })
  : await runFinanceProfessionalHarnessSuite({
      cases: imported.cases,
      assetsRoot: path.join(benchmarkRoot, "assets"),
    });

const outputPath = path.join(process.cwd(), ".finwork-test", "benchmarks", "reports", `${profile}-harness.json`);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({
  profile,
  outputPath,
  totals: report.totals,
  realApi: report.realApi,
  providerRequests: 0,
}, null, 2));
if (report.totals.failed > 0 || report.totals.errors > 0) process.exitCode = 1;
