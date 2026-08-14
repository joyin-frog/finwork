import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { BenchmarkRunReportSchema } from "../lib/evaluation/benchmarks/contracts.ts";
import { mineBenchmarkGapProposals, parseBenchmarkGapCliArgs } from "../lib/evaluation/benchmarks/gap-miner.ts";

const { reportArgument, outputArgument } = parseBenchmarkGapCliArgs(process.argv.slice(2));
const reportPath = path.resolve(reportArgument);
const outputPath = path.resolve(outputArgument ?? path.join(".finwork-test", "benchmarks", "reports", "gap-proposals.json"));
const report = BenchmarkRunReportSchema.parse(JSON.parse(await readFile(reportPath, "utf8")));
if (report.fixtureOracle) {
  console.warn("This is a fixture-oracle report. Any proposals are harness diagnostics, not evidence of model capability gaps.");
}
const proposals = mineBenchmarkGapProposals(report.results);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(proposals, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, outputPath, proposals: proposals.length }, null, 2));
