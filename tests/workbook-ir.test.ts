import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import {
  applyWorkbookPatchPlan,
  createPatchPlan,
  parseWorkbookFile,
  requireWorkbookRecalculation,
  rollbackWorkbookPatch,
  type WorkbookSemanticContext,
} from "@/lib/workbook-ir";
import { validateXlsxFile } from "@/lib/deliverable/validators/xlsx";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function createFixture(filePath: string): Promise<void> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Statement");
  sheet.getCell("A1").value = 10;
  sheet.getCell("A2").value = { formula: "A1*2", result: 20 };
  sheet.getCell("B1").value = "CNY";
  sheet.getCell("B1").font = { bold: true };
  sheet.getCell("C1").value = "货币资金";
  sheet.getCell("D1").value = "华东子公司";
  sheet.getCell("E1").value = "未配置标签";
  await workbook.xlsx.writeFile(filePath);
}

export const workbookIrTestPromise = (async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "finwork-workbook-ir-"));
  try {
    const sourcePath = path.join(temporary, "source.xlsx");
    const candidatePath = path.join(temporary, "candidate.xlsx");
    const restoredPath = path.join(temporary, "restored.xlsx");
    await createFixture(sourcePath);

    const semanticContext: WorkbookSemanticContext = {
      version: "fixture-mapping-2026.1",
      defaults: { period: "2026-Q2", scenario: "actual", unit: "1" },
      exactCells: {
        "Statement!D1": { entity: "entity-east" },
      },
      exactLabels: {
        cny: { currency: "CNY" },
        "华东子公司": { entity: "conflicting-entity" },
      },
      accountAliases: {
        "货币资金": "1001",
      },
    };
    const source = await parseWorkbookFile(sourcePath, semanticContext);
    const formula = source.formulaGraph.cells.find((cell) => cell.locator.sheet === "Statement" && cell.locator.address === "A2");
    assert.equal(formula?.formulaAst?.kind, "expression");
    assert.deepEqual(formula?.dependencies, ["Statement!A1"]);
    assert.equal(source.financeGraph.contextVersion, "fixture-mapping-2026.1");
    assert.equal(source.financeGraph.mappings["Statement!B1"]?.resolvedBy, "explicit_label");
    assert.equal(source.financeGraph.mappings["Statement!B1"]?.currency, "CNY");
    assert.equal(source.financeGraph.mappings["Statement!C1"]?.resolvedBy, "dictionary");
    assert.equal(source.financeGraph.mappings["Statement!C1"]?.account, "1001");
    assert.equal(source.financeGraph.mappings["Statement!D1"]?.resolvedBy, "explicit_cell");
    assert.equal(source.financeGraph.mappings["Statement!D1"]?.confidence, 0);
    assert.deepEqual(source.financeGraph.ambiguousLocators, ["Statement!D1"]);
    assert.ok(source.financeGraph.mappings["Statement!B1"]?.evidence.includes("Statement!B1"));
    assert.ok(source.financeGraph.mappings["Statement!E1"]?.period === "2026-Q2");

    const plan = createPatchPlan(source, [{ kind: "set_value", sheet: "Statement", cell: "A1", value: 15 }]);
    assert.equal(plan.sourceSha256, source.sourceSha256);
    assert.equal(plan.preconditions[0]?.expected, 10);

    const applied = await applyWorkbookPatchPlan(sourcePath, candidatePath, plan);
    assert.equal(applied.candidate.formulaGraph.cells.find((cell) => cell.locator.address === "A1")?.value, 15);
    assert.ok(applied.diff.impactedFormulaCells.includes("Statement!A2"));
    assert.equal(applied.diff.untouchedStructurePreserved, true);
    assert.equal(applied.diff.rollbackPlan.preconditions[0]?.expected, 15);

    await rollbackWorkbookPatch(candidatePath, restoredPath, applied.diff);
    const restored = await parseWorkbookFile(restoredPath);
    assert.equal(restored.formulaGraph.cells.find((cell) => cell.locator.address === "A1")?.value, 10);
    assert.deepEqual(restored.structuralGraph.sheets, source.structuralGraph.sheets);

    const blocked = await requireWorkbookRecalculation(sourcePath, async () => ({
      ok: false,
      errorCode: "recalc_unavailable",
      detail: "provider missing",
    }));
    assert.deepEqual(blocked, { status: "blocked", code: "recalc_unavailable", detail: "provider missing" });

    const recalculatedPath = path.join(temporary, "recalculated.xlsx");
    await copyFile(sourcePath, recalculatedPath);
    const recalculatedHash = sha256(await readFile(recalculatedPath));
    const verified = await requireWorkbookRecalculation(sourcePath, async () => ({
      ok: true,
      data: {
        inputHash: source.sourceSha256,
        outputHash: recalculatedHash,
        outputPath: recalculatedPath,
        provider: "test-real-protocol",
        version: "1",
        durationMs: 1,
        executable: "fixture",
      },
    }));
    assert.equal(verified.status, "verified");
    if (verified.status === "verified") assert.equal(verified.evidence.candidateSha256, recalculatedHash);

    const healthyInspect = async () => ({
      ok: true as const,
      data: { sheets: [{ name: "Statement", formula_count: 1, formulas_sample: [{ cell: "A2", formula: "=A1*2", cached_value: 20 }] }] },
    });
    const formalValidation = await validateXlsxFile(
      {
        filePath: sourcePath,
        fileName: "source.xlsx",
        expectedMime: XLSX_MIME,
        qualityProfile: "generic",
        expectedSha256: source.sourceSha256,
        needsRecalc: true,
        recalcPolicy: "required",
      },
      {
        inspect: healthyInspect,
        recalc: async () => ({ ok: false, errorCode: "recalc_unavailable", detail: "no controlled provider" }),
        render: async () => ({ ok: true, data: { files: [], provider: "fixture" } }),
      },
    );
    assert.equal(formalValidation.status, "failed");
    assert.ok(formalValidation.errors.some((issue) => issue.code === "recalc_unavailable"));

    console.log("workbook-ir tests passed");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
})();
