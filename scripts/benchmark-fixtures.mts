import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { BenchmarkDatasetId, NormalizedBenchmarkCase } from "../lib/evaluation/benchmarks/contracts.ts";
import {
  SYNTHETIC_BENCHMARK_WARNING,
  createSyntheticInputArtifacts,
} from "../lib/evaluation/benchmarks/fixture-oracle.ts";
import { mineBenchmarkGapProposals } from "../lib/evaluation/benchmarks/gap-miner.ts";
import { importExternalBenchmarkSource } from "../lib/evaluation/benchmarks/importer.ts";
import { runBenchmarkFixtureSuite } from "../lib/evaluation/benchmarks/runner.ts";

const fixtureRoot = path.join(process.cwd(), "tests", "fixtures", "benchmarks");
const outputRoot = path.join(process.cwd(), ".finwork-test", "benchmarks", "reports");
const fixtures: ReadonlyArray<{
  datasetId: BenchmarkDatasetId;
  datasetVersion: string;
  split: string;
  file: string;
}> = [
  { datasetId: "finqa", datasetVersion: "synthetic-v1", split: "test", file: "finqa.sample.json" },
  { datasetId: "tatqa", datasetVersion: "synthetic-v1", split: "test", file: "tatqa.sample.json" },
  { datasetId: "convfinqa", datasetVersion: "synthetic-v1", split: "test", file: "convfinqa.sample.json" },
  { datasetId: "financebench", datasetVersion: "synthetic-v1", split: "test", file: "financebench.sample.json" },
  { datasetId: "finben", datasetVersion: "synthetic-v1", split: "test", file: "finben.sample.json" },
  { datasetId: "fineval", datasetVersion: "synthetic-v1", split: "dev", file: "fineval.sample.json" },
  { datasetId: "spreadsheetbench_v2", datasetVersion: "synthetic-v2", split: "test", file: "spreadsheetbench.sample.json" },
  { datasetId: "finagentbench", datasetVersion: "synthetic-v1", split: "dev", file: "finagentbench.sample.json" },
];

const imports = await Promise.all(fixtures.map((fixture) => importExternalBenchmarkSource({
  datasetId: fixture.datasetId,
  datasetVersion: fixture.datasetVersion,
  split: fixture.split,
  sourcePath: path.join(fixtureRoot, fixture.file),
  acknowledgeLicenseReview: true,
})));
const cases = imports.flatMap((result) => result.cases);
const inputArtifactsByCaseId = Object.fromEntries(cases
  .filter((benchmarkCase: NormalizedBenchmarkCase) => benchmarkCase.context.files.length > 0)
  .map((benchmarkCase: NormalizedBenchmarkCase) => [benchmarkCase.id, createSyntheticInputArtifacts(benchmarkCase)]));
const report = await runBenchmarkFixtureSuite({
  suiteName: "synthetic benchmark adapter wiring",
  cases,
  publishable: false,
  inputArtifactsByCaseId,
});
const proposals = mineBenchmarkGapProposals(report.results);
await mkdir(outputRoot, { recursive: true });
const reportPath = path.join(outputRoot, "fixture-baseline.json");
const proposalPath = path.join(outputRoot, "fixture-gaps.json");
await Promise.all([
  writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8"),
  writeFile(proposalPath, `${JSON.stringify(proposals, null, 2)}\n`, "utf8"),
]);
console.log(SYNTHETIC_BENCHMARK_WARNING);
console.log(JSON.stringify({ reportPath, proposalPath, totals: report.totals }, null, 2));
