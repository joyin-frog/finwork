import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { ArtifactStore } from "../lib/artifacts/store.ts";
import { getDb } from "../lib/db/sqlite.ts";
import {
  BenchmarkEvaluationOracleSchema,
  BenchmarkPredictionSchema,
} from "../lib/evaluation/benchmarks/contracts.ts";
import { validateSpreadsheetBenchmarkPrediction } from "../lib/evaluation/benchmarks/spreadsheet-oracle.ts";

async function workbookBytes(c3: number): Promise<Uint8Array> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Model");
  sheet.getCell("B2").value = 10;
  sheet.getCell("C2").value = 20;
  sheet.getCell("B3").value = { formula: "B2+C2", result: 30 };
  sheet.getCell("C3").value = c3;
  return new Uint8Array(await workbook.xlsx.writeBuffer());
}

export const benchmarkSpreadsheetOracleTestPromise = (async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "finwork-benchmark-spreadsheet-oracle-"));
  process.env.FINANCE_AGENT_APP_DATA_DIR = root;
  process.env.FINANCE_AGENT_DB_PATH = path.join(root, "benchmark.db");
  try {
    const db = getDb();
    const casRoot = path.join(root, "artifacts", "cas");
    const artifacts = new ArtifactStore(db, casRoot);
    const golden = artifacts.put({
      kind: "benchmark_oracle",
      logicalName: "golden.xlsx",
      classification: "public",
      retention: {},
      mediaType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      producer: {},
      content: await workbookBytes(40),
      state: "candidate",
    });
    const output = artifacts.put({
      kind: "task_output",
      logicalName: "case_completed.xlsx",
      classification: "public",
      retention: {},
      mediaType: golden.mediaType,
      producer: {},
      content: await workbookBytes(40),
      state: "candidate",
    });
    const delivered = artifacts.transition(output.artifactId, "delivered");
    const oracle = BenchmarkEvaluationOracleSchema.parse({
      caseId: "spreadsheetbench_v2:v1:case",
      datasetId: "spreadsheetbench_v2",
      expected: {
        answers: [], numericAnswers: [], programs: [], citations: [], assertions: ["business range matches"],
        artifact: {
          mediaType: golden.mediaType,
          logicalName: "case_completed.xlsx",
          validatorIds: ["xlsx_generic", "spreadsheetbench_v2_cells"],
          oracle: { goldenUpstreamUri: "golden.xlsx", answerRange: "'Model'!B2:C3", goldenArtifactRef: golden },
        },
      },
    });
    const prediction = BenchmarkPredictionSchema.parse({
      artifact: { mediaType: delivered.mediaType, sha256: delivered.sha256, checks: [{ id: "xlsx_generic", passed: true, blocking: true, details: {} }] },
      citations: [], assertions: [], metrics: { wallTimeMs: 1, tokens: 0, retries: 0, toolCalls: 1 },
      execution: {
        traceId: "trace", caseId: oracle.caseId, taskId: "task", runId: "run",
        inputTokens: 0, outputTokens: 0, latencyMs: 1, retries: 0, costUsd: null,
        artifactRefs: [delivered], evidenceRefs: [],
        validation: { assertions: { total: 1, passed: 1, failed: 0 }, delivery: { required: true, delivered: 1, passed: true } },
        termination: { cancelled: false, aborted: false, timedOut: false }, stableFailureCode: null,
      },
    });
    const validated = await validateSpreadsheetBenchmarkPrediction({ oracle, prediction, db, casRoot });
    assert.equal(validated.artifact?.checks.find((check) => check.id === "spreadsheetbench_v2_cells")?.passed, true);
    console.log("benchmark-spreadsheet-oracle: private golden range validation passed ✓");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
})();

if (process.argv[1]?.includes("benchmark-spreadsheet-oracle.test")) {
  benchmarkSpreadsheetOracleTestPromise.catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
