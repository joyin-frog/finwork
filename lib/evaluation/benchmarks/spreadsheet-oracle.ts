import ExcelJS from "exceljs";
import type { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { ArtifactStore } from "@/lib/artifacts/store";
import { getDb } from "@/lib/db/sqlite";
import { getAppDataDir } from "@/lib/runtime/paths";
import {
  BenchmarkPredictionSchema,
  type BenchmarkEvaluationOracle,
  type BenchmarkPrediction,
} from "./contracts";

const VALIDATOR_ID = "spreadsheetbench_v2_cells";

export async function validateSpreadsheetBenchmarkPrediction(input: {
  oracle: BenchmarkEvaluationOracle;
  prediction: BenchmarkPrediction;
  db?: DatabaseSync;
  casRoot?: string;
}): Promise<BenchmarkPrediction> {
  const oracle = input.oracle.expected.artifact?.oracle;
  if (!oracle) return input.prediction;
  const checks = input.prediction.artifact?.checks ?? [];
  const finish = (passed: boolean, details: Record<string, unknown>) => BenchmarkPredictionSchema.parse({
    ...input.prediction,
    ...(input.prediction.artifact ? {
      artifact: {
        ...input.prediction.artifact,
        checks: [
          ...checks.filter((check) => check.id !== VALIDATOR_ID),
          { id: VALIDATOR_ID, passed, blocking: true, details },
        ],
      },
    } : {}),
  });
  const golden = oracle.goldenArtifactRef;
  const delivered = input.prediction.execution?.artifactRefs.find((artifact) => artifact.state === "delivered");
  if (!input.prediction.artifact || !golden || !delivered) {
    return finish(false, {
      code: "spreadsheet_oracle_artifact_missing",
      goldenMaterialized: Boolean(golden),
      deliveredMaterialized: Boolean(delivered),
    });
  }
  const range = parseAnswerRange(oracle.answerRange);
  if (!range) return finish(false, { code: "spreadsheet_oracle_range_invalid" });
  const db = input.db ?? getDb();
  const artifacts = new ArtifactStore(db, input.casRoot ?? path.join(getAppDataDir(), "artifacts", "cas"));
  try {
    const [goldenWorkbook, deliveredWorkbook] = await Promise.all([
      loadWorkbook(artifacts.read(golden.versionId)),
      loadWorkbook(artifacts.read(delivered.versionId)),
    ]);
    const expectedSheet = goldenWorkbook.getWorksheet(range.sheet);
    const actualSheet = deliveredWorkbook.getWorksheet(range.sheet);
    if (!expectedSheet || !actualSheet) {
      return finish(false, {
        code: "spreadsheet_oracle_sheet_missing",
        sheet: range.sheet,
        expectedSheetPresent: Boolean(expectedSheet),
        deliveredSheetPresent: Boolean(actualSheet),
      });
    }
    const mismatches: string[] = [];
    let comparedCells = 0;
    for (let row = range.startRow; row <= range.endRow; row += 1) {
      for (let column = range.startColumn; column <= range.endColumn; column += 1) {
        comparedCells += 1;
        const expected = comparableValue(expectedSheet.getCell(row, column).value);
        const actual = comparableValue(actualSheet.getCell(row, column).value);
        if (!valuesEqual(actual, expected) && mismatches.length < 50) {
          mismatches.push(expectedSheet.getCell(row, column).address);
        }
      }
    }
    return finish(mismatches.length === 0, {
      code: mismatches.length === 0 ? "spreadsheet_oracle_passed" : "spreadsheet_oracle_mismatch",
      sheet: range.sheet,
      range: oracle.answerRange,
      comparedCells,
      mismatchCount: mismatches.length,
      mismatchLocations: mismatches,
    });
  } catch (error) {
    return finish(false, {
      code: "spreadsheet_oracle_validation_failed",
      error: error instanceof Error ? error.name : "Error",
    });
  }
}

async function loadWorkbook(bytes: Uint8Array): Promise<ExcelJS.Workbook> {
  const workbook = new ExcelJS.Workbook();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(buffer);
  return workbook;
}

function parseAnswerRange(value: string): {
  sheet: string;
  startRow: number;
  startColumn: number;
  endRow: number;
  endColumn: number;
} | null {
  const match = /^(?:'((?:[^']|'')+)'|([^!]+))!\$?([A-Z]{1,3})\$?(\d+):\$?([A-Z]{1,3})\$?(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const sheet = (match[1] ?? match[2] ?? "").replace(/''/g, "'").trim();
  const startRow = Number(match[4]);
  const endRow = Number(match[6]);
  const startColumn = columnNumber(match[3]!);
  const endColumn = columnNumber(match[5]!);
  if (!sheet || startRow <= 0 || endRow < startRow || endColumn < startColumn) return null;
  return { sheet, startRow, startColumn, endRow, endColumn };
}

function columnNumber(value: string): number {
  return [...value.toUpperCase()].reduce((total, character) => total * 26 + character.charCodeAt(0) - 64, 0);
}

function comparableValue(value: ExcelJS.CellValue): unknown {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object") {
    if ("result" in value) return comparableValue((value as ExcelJS.CellFormulaValue).result ?? null);
    if ("richText" in value) return (value as ExcelJS.CellRichTextValue).richText.map((part) => part.text).join("");
    if ("text" in value) return String((value as { text?: unknown }).text ?? "");
  }
  return JSON.stringify(value);
}

function valuesEqual(actual: unknown, expected: unknown): boolean {
  if (typeof actual === "number" && typeof expected === "number") {
    return Math.abs(actual - expected) <= Math.max(1e-6, Math.abs(expected) * 1e-6);
  }
  if (typeof actual === "string" && typeof expected === "string") {
    return actual.normalize("NFKC").trim() === expected.normalize("NFKC").trim();
  }
  return actual === expected;
}
