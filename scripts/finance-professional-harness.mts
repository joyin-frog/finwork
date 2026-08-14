import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { importExternalBenchmarkSource } from "../lib/evaluation/benchmarks/importer.ts";
import { runFinanceProfessionalHarnessSuite } from "../lib/evaluation/benchmarks/finance-professional-harness.ts";

const benchmarkRoot = path.join(process.cwd(), "benchmarks", "finance-agent-professional", "v1");
const imported = await importExternalBenchmarkSource({
  datasetId: "finance_agent_professional",
  datasetVersion: "v1",
  split: "pilot",
  sourcePath: path.join(benchmarkRoot, "cases.jsonl"),
  acknowledgeLicenseReview: false,
});
const report = await runFinanceProfessionalHarnessSuite({
  cases: imported.cases,
  assetsRoot: path.join(benchmarkRoot, "assets"),
});
const outputPath = path.join(
  process.cwd(),
  ".finwork-test",
  "benchmarks",
  "reports",
  "finance-agent-professional-harness.json",
);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
console.log(JSON.stringify({
  outputPath,
  totals: report.totals,
  realApi: report.realApi,
  fixtureOracle: report.fixtureOracle,
  providerRequests: 0,
}, null, 2));
if (report.totals.failed > 0 || report.totals.errors > 0) process.exitCode = 1;
