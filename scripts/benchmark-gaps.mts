import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { mineBenchmarkGapProposals, parseBenchmarkGapCliArgs, parseBenchmarkGapReportResults } from "../lib/evaluation/benchmarks/gap-miner.ts";

const { reportArgument, outputArgument } = parseBenchmarkGapCliArgs(process.argv.slice(2));
const reportPath = path.resolve(reportArgument);
const outputPath = path.resolve(outputArgument ?? path.join(".finwork-test", "benchmarks", "reports", "gap-proposals.json"));
const rawReport = JSON.parse(await readFile(reportPath, "utf8")) as unknown;
const results = parseBenchmarkGapReportResults(rawReport);
if (typeof rawReport === "object" && rawReport !== null && !Array.isArray(rawReport) && (rawReport as { fixtureOracle?: unknown }).fixtureOracle === true) {
  console.warn("This is a fixture-oracle report. Any proposals are harness diagnostics, not evidence of model capability gaps.");
}
const proposals = mineBenchmarkGapProposals(results);
await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(proposals, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ reportPath, outputPath, proposals: proposals.length }, null, 2));
