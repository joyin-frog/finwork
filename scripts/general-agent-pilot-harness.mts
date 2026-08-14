import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { executeGeneralAgentHarnessCase } from "../lib/evaluation/benchmarks/general-agent-harness.ts";
import { importExternalBenchmarkSource } from "../lib/evaluation/benchmarks/importer.ts";
import { selectCasesForEvaluationLayer } from "../lib/evaluation/benchmarks/evaluation-layers.ts";
import { runBenchmarkSuite } from "../lib/evaluation/benchmarks/runner.ts";

const imported = await importExternalBenchmarkSource({
  datasetId: "general_agent_pilot",
  datasetVersion: "v1",
  split: "pilot",
  sourcePath: path.join(process.cwd(), "benchmarks", "general-agent-pilot", "v1", "cases.jsonl"),
  acknowledgeLicenseReview: false,
});
const cases = selectCasesForEvaluationLayer(imported.cases, "harness");
const report = await runBenchmarkSuite({
  suiteName: "Finwork General Agent Pilot Layer 1 Harness",
  cases,
  executor: executeGeneralAgentHarnessCase,
  configuration: { kind: "harness", sampleSeed: "pilot-v1", maxCases: 10 },
});
const outputPath = path.join(process.cwd(), ".finwork-test", "benchmarks", "reports", "general-agent-pilot-harness.json");
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({ outputPath, totals: report.totals, realApi: report.realApi }, null, 2));
if (report.totals.failed > 0 || report.totals.errors > 0) process.exitCode = 1;
