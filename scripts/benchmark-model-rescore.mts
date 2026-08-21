import { readFile } from "node:fs/promises";
import path from "node:path";
import { BenchmarkPredictionSchema } from "../lib/evaluation/benchmarks/contracts.ts";
import { partitionBenchmarkCase } from "../lib/evaluation/benchmarks/case-boundary.ts";
import { prepareCasesForEvaluationLayer } from "../lib/evaluation/benchmarks/evaluation-layers.ts";
import { loadRealBenchmarkInputs } from "../lib/evaluation/benchmarks/real-runner.ts";
import { parseBenchmarkRunReport } from "../lib/evaluation/benchmarks/report.ts";
import { scoreBenchmarkPrediction } from "../lib/evaluation/benchmarks/scoring.ts";

const goalRoot = path.join(process.cwd(), ".finwork-test", "benchmarks", "goal", "spec-real-api-benchmark-execution-v1");
const reportPaths = process.argv.slice(2).filter((value) => value !== "--").map((value) => path.resolve(value));
if (reportPaths.length === 0) throw new Error("usage: pnpm eval:benchmarks:model-rescore -- <report.json> [...report.json]");

const state = JSON.parse(await readFile(path.join(goalRoot, "state.json"), "utf8")) as { importedManifests?: unknown };
const loaded = await loadRealBenchmarkInputs((state.importedManifests ?? []) as Parameters<typeof loadRealBenchmarkInputs>[0]);
const casesById = new Map(loaded.cases.map((benchmarkCase) => [benchmarkCase.id, benchmarkCase]));

const cells = [];
for (const reportPath of reportPaths) {
  const report = parseBenchmarkRunReport(JSON.parse(await readFile(reportPath, "utf8")));
  if (report.configuration.kind !== "real" || report.configuration.evaluationLayer !== "model") {
    throw new Error(`not a real Model-layer report:${reportPath}`);
  }
  for (const result of report.results) {
    const imported = casesById.get(result.caseId);
    if (!imported) throw new Error(`report case is not present in Goal imports:${result.caseId}`);
    const prepared = prepareCasesForEvaluationLayer([imported], "model")[0];
    if (!prepared) throw new Error(`report case no longer belongs to Model layer:${result.caseId}`);
    const details = result.details && typeof result.details === "object" && !Array.isArray(result.details)
      ? result.details as Record<string, unknown>
      : {};
    if (typeof details.predictedAnswer !== "string") {
      throw new Error(`report does not contain an auditable predictedAnswer:${report.runId}:${result.caseId}`);
    }
    const { executionCase, oracle } = partitionBenchmarkCase(prepared);
    const rescored = scoreBenchmarkPrediction(executionCase, oracle, BenchmarkPredictionSchema.parse({
      answer: details.predictedAnswer,
      metrics: result.metrics,
      execution: result.execution,
      details: {
        evaluationLayer: "model",
        requestedModel: report.configuration.fixedModel,
        actualModel: typeof details.actualModel === "string" ? details.actualModel : null,
      },
    }));
    cells.push({
      runId: report.runId,
      reportPath,
      model: report.configuration.fixedModel,
      caseId: result.caseId,
      originalStatus: result.status,
      rescoredStatus: rescored.status,
      originalFailures: result.failures,
      rescoredFailures: rescored.failures,
      scores: rescored.scores,
      answer: details.predictedAnswer,
      inputTokens: result.execution.inputTokens,
      outputTokens: result.execution.outputTokens,
      cacheReadInputTokens: result.execution.cacheReadInputTokens,
      cacheCreationInputTokens: result.execution.cacheCreationInputTokens,
      latencyMs: result.execution.latencyMs,
      retries: result.execution.retries,
    });
  }
}

const models = [...new Set(cells.map((cell) => cell.model))].map((model) => {
  const values = cells.filter((cell) => cell.model === model);
  const latencies = values.map((cell) => cell.latencyMs).sort((left, right) => left - right);
  const percentile = (ratio: number) => latencies[Math.ceil((latencies.length - 1) * ratio)] ?? null;
  return {
    model,
    cells: values.length,
    passed: values.filter((cell) => cell.rescoredStatus === "passed").length,
    failed: values.filter((cell) => cell.rescoredStatus === "failed").length,
    errors: values.filter((cell) => cell.rescoredStatus === "error").length,
    accuracy: values.filter((cell) => cell.rescoredStatus === "passed").length / values.length,
    p50LatencyMs: percentile(0.5),
    p95LatencyMs: percentile(0.95),
    inputTokens: values.reduce((sum, cell) => sum + cell.inputTokens, 0),
    outputTokens: values.reduce((sum, cell) => sum + cell.outputTokens, 0),
    cacheReadInputTokens: values.reduce((sum, cell) => sum + cell.cacheReadInputTokens, 0),
    cacheCreationInputTokens: values.reduce((sum, cell) => sum + cell.cacheCreationInputTokens, 0),
    retries: values.reduce((sum, cell) => sum + cell.retries, 0),
  };
});

console.log(JSON.stringify({
  schemaVersion: 1,
  evaluationLayer: "model",
  networkRequests: 0,
  reports: reportPaths,
  models,
  cells,
}, null, 2));
