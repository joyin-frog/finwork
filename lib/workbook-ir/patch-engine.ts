import { createHash, randomUUID } from "node:crypto";
import { copyFile, readFile } from "node:fs/promises";
import { spreadsheetPatchWorkbook, type WorkbookEdit, type RuntimeCommandResult, type WorkbookPatchResult } from "@/lib/runtime/spreadsheet-runtime";
import { parseWorkbookFile } from "./adapter";
import { WorkbookPatchPlanSchema, type WorkbookCell, type WorkbookDiff, type WorkbookIr, type WorkbookPatchOperation, type WorkbookPatchPlan } from "./contracts";

function hash(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
function locator(cell: WorkbookCell): string { return `${cell.locator.sheet}!${cell.locator.address}`; }
function cellMap(ir: WorkbookIr): Map<string, WorkbookCell> { return new Map(ir.formulaGraph.cells.map((cell) => [locator(cell), cell])); }

export function createPatchPlan(source: WorkbookIr, operations: WorkbookPatchOperation[], requireRecalc = true): WorkbookPatchPlan {
  const sourceCells = cellMap(source);
  const preconditions = operations.map((operation) => {
    const key = `${operation.sheet}!${operation.cell}`;
    const current = sourceCells.get(key);
    return { locator: key, ...(current?.value !== undefined ? { expected: current.value } : {}), ...(current?.formula ? { expectedFormula: current.formula } : {}) };
  });
  return WorkbookPatchPlanSchema.parse({ planId: randomUUID(), sourceSha256: source.sourceSha256, operations, preconditions, expectedEffects: operations.map((item) => `${item.kind}:${item.sheet}!${item.cell}`), requireRecalc });
}

function edits(plan: WorkbookPatchPlan): WorkbookEdit[] {
  return plan.operations.map((operation) => operation.kind === "set_value"
    ? { sheet: operation.sheet, cell: operation.cell, value: operation.value, createSheet: operation.createSheet }
    : operation.kind === "set_formula"
      ? { sheet: operation.sheet, cell: operation.cell, formula: operation.formula, createSheet: operation.createSheet }
      : { sheet: operation.sheet, cell: operation.cell, clear: true });
}

function rollbackOperation(cell: WorkbookCell | undefined, sheet: string, address: string): WorkbookPatchOperation {
  if (!cell) return { kind: "clear", sheet, cell: address };
  if (cell.formula) return { kind: "set_formula", sheet, cell: address, formula: cell.formula };
  return { kind: "set_value", sheet, cell: address, value: cell.value ?? null };
}

function impacted(source: WorkbookIr, changed: Set<string>): string[] {
  const reverse = new Map<string, Set<string>>();
  for (const edge of source.formulaGraph.edges) {
    const dependents = reverse.get(edge.to) ?? new Set<string>();
    dependents.add(edge.from);
    reverse.set(edge.to, dependents);
  }
  const queue = [...changed];
  const result = new Set<string>();
  while (queue.length) {
    const current = queue.shift()!;
    for (const dependent of reverse.get(current) ?? []) if (!result.has(dependent)) { result.add(dependent); queue.push(dependent); }
  }
  return [...result];
}

export type PatchWorkbookProvider = (sourcePath: string, outputPath: string, edits: WorkbookEdit[]) => Promise<RuntimeCommandResult<WorkbookPatchResult>>;

export async function applyWorkbookPatchPlan(sourcePath: string, outputPath: string, plan: WorkbookPatchPlan, provider: PatchWorkbookProvider = spreadsheetPatchWorkbook): Promise<{ result: WorkbookPatchResult; candidate: WorkbookIr; diff: WorkbookDiff }> {
  const sourceBytes = await readFile(sourcePath);
  if (hash(sourceBytes) !== plan.sourceSha256) throw new Error("patch_precondition_source_hash_mismatch");
  const source = await parseWorkbookFile(sourcePath);
  const sourceCells = cellMap(source);
  for (const precondition of plan.preconditions) {
    const current = sourceCells.get(precondition.locator);
    if (precondition.expectedFormula !== undefined && current?.formula !== precondition.expectedFormula) throw new Error(`patch_precondition_formula_mismatch:${precondition.locator}`);
    if (precondition.expected !== undefined && JSON.stringify(current?.value) !== JSON.stringify(precondition.expected)) throw new Error(`patch_precondition_value_mismatch:${precondition.locator}`);
  }
  const applied = await provider(sourcePath, outputPath, edits(plan));
  if (!applied.ok || !applied.data) throw new Error(`patch_failed:${applied.errorCode ?? applied.detail ?? "unknown"}`);
  const candidate = await parseWorkbookFile(outputPath);
  const candidateCells = cellMap(candidate);
  const changedKeys = new Set(plan.operations.map((item) => `${item.sheet}!${item.cell}`));
  const changedCells = [...changedKeys].map((key) => ({ locator: key, before: sourceCells.get(key) ?? null, after: candidateCells.get(key) ?? null }));
  const rollbackPlan = createPatchPlan(candidate, plan.operations.map((operation) => rollbackOperation(sourceCells.get(`${operation.sheet}!${operation.cell}`), operation.sheet, operation.cell)), plan.requireRecalc);
  const createsSheet = (item: WorkbookPatchOperation, sheetName: string): boolean => "createSheet" in item && item.createSheet === true && item.sheet === sheetName;
  const sourceStructure = JSON.stringify(source.structuralGraph.sheets.filter((sheet) => !plan.operations.some((item) => createsSheet(item, sheet.name))));
  const targetStructure = JSON.stringify(candidate.structuralGraph.sheets.filter((sheet) => !plan.operations.some((item) => createsSheet(item, sheet.name))));
  return { result: applied.data, candidate, diff: { sourceSha256: source.sourceSha256, targetSha256: candidate.sourceSha256, changedCells, impactedFormulaCells: impacted(source, changedKeys), untouchedStructurePreserved: sourceStructure === targetStructure, rollbackPlan } };
}

export async function rollbackWorkbookPatch(candidatePath: string, restoredPath: string, diff: WorkbookDiff, provider: PatchWorkbookProvider = spreadsheetPatchWorkbook): Promise<void> {
  const applied = await applyWorkbookPatchPlan(candidatePath, restoredPath, diff.rollbackPlan, provider);
  if (!applied.diff.untouchedStructurePreserved) throw new Error("rollback_structure_changed");
}

export async function copyCandidate(sourcePath: string, outputPath: string): Promise<void> { await copyFile(sourcePath, outputPath); }
