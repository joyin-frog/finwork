import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import {
  WorkbookIrSchema,
  WorkbookSemanticContextSchema,
  type FinanceSemanticMapping,
  type FinanceSemanticValues,
  type WorkbookCell,
  type WorkbookIr,
  type WorkbookScalar,
  type WorkbookSemanticContext,
} from "./contracts";
import { formulaReferences, parseFormulaAst } from "./formula";

function hash(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function scalar(value: unknown): WorkbookScalar | undefined {
  return value == null || typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined;
}

const EMPTY_CONTEXT: WorkbookSemanticContext = WorkbookSemanticContextSchema.parse({ version: "builtin-2026.1" });

function normalized(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function mergeValues(...values: Array<FinanceSemanticValues | undefined>): FinanceSemanticValues {
  return Object.assign({}, ...values.filter(Boolean));
}

function heuristicValues(sheet: string, value: unknown): FinanceSemanticValues {
  const text = `${sheet} ${String(value ?? "")}`.toLowerCase();
  const currency = /cny|rmb|人民币|元/.test(text) ? "CNY" : /usd|美元/.test(text) ? "USD" : null;
  const unit = /万元/.test(text) ? "10000" : /千元/.test(text) ? "1000" : /元/.test(text) ? "1" : null;
  const scenario = /预算|budget/.test(text) ? "budget" : /实际|actual/.test(text) ? "actual" : null;
  const period = text.match(/20\d{2}(?:[-年/.]\d{1,2})?(?:[-月/.]\d{1,2})?/)?.[0] ?? null;
  const entity = text.match(/([\u4e00-\u9fffA-Za-z0-9（）()·]{2,80}(?:公司|集团|银行|企业))/)?.[1] ?? null;
  return { entity, period, currency, unit, scenario };
}

function inferMapping(
  sheet: string,
  address: string,
  value: unknown,
  context: WorkbookSemanticContext,
): FinanceSemanticMapping {
  const locator = `${sheet}!${address}`;
  const label = typeof value === "string" ? normalized(value) : "";
  const exactCell = context.exactCells[locator];
  const exactLabel = label ? context.exactLabels[label] : undefined;
  const dictionaryAccount = label ? context.accountAliases[label] : undefined;
  const heuristic = heuristicValues(sheet, value);
  const mapping = mergeValues(
    heuristic,
    context.defaults,
    dictionaryAccount ? { account: dictionaryAccount } : undefined,
    exactLabel,
    exactCell,
  );
  const ambiguities: string[] = [];
  if (exactCell && exactLabel) {
    for (const dimension of ["entity", "period", "account", "currency", "unit", "scenario"] as const) {
      const cellValue = exactCell[dimension];
      const labelValue = exactLabel[dimension];
      if (cellValue != null && labelValue != null && cellValue !== labelValue) ambiguities.push(`${dimension}:cell=${cellValue}:label=${labelValue}`);
    }
  }
  const resolvedBy = exactCell ? "explicit_cell" : exactLabel ? "explicit_label" : dictionaryAccount ? "dictionary" : Object.values(heuristic).some(Boolean) ? "heuristic" : "unresolved";
  const evidence = [locator, `semantic-context:${context.version}`, ...(label ? [`label:${label}`] : [])];
  return {
    entity: mapping.entity ?? null,
    period: mapping.period ?? null,
    account: mapping.account ?? null,
    currency: mapping.currency ?? null,
    unit: mapping.unit ?? null,
    scenario: mapping.scenario ?? null,
    confidence: ambiguities.length ? 0 : resolvedBy.startsWith("explicit") ? 1 : resolvedBy === "dictionary" ? 0.95 : resolvedBy === "heuristic" ? 0.65 : 0,
    evidence,
    resolvedBy,
    mappingVersion: context.version,
    ambiguities,
  };
}

export async function parseWorkbookBytes(bytes: Uint8Array, semanticContext: WorkbookSemanticContext = EMPTY_CONTEXT): Promise<WorkbookIr> {
  const context = WorkbookSemanticContextSchema.parse(semanticContext);
  const workbook = new ExcelJS.Workbook();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  await workbook.xlsx.load(buffer);
  const zip = await JSZip.loadAsync(bytes);
  const cells: WorkbookCell[] = [];
  const mappings: Record<string, FinanceSemanticMapping> = {};
  workbook.eachSheet((sheet) => {
    sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
      const locator = `${sheet.name}!${cell.address}`;
      const raw = cell.value;
      const formulaValue = raw && typeof raw === "object" && "formula" in raw ? raw as { formula: string; result?: unknown } : null;
      const value = formulaValue ? scalar(formulaValue.result) : scalar(raw);
      const item: WorkbookCell = {
        locator: { sheet: sheet.name, address: cell.address },
        ...(value !== undefined ? { value } : {}),
        ...(formulaValue ? { formula: formulaValue.formula, cachedValue: scalar(formulaValue.result), formulaAst: parseFormulaAst(formulaValue.formula, sheet.name) } : {}),
        dependencies: formulaValue ? formulaReferences(formulaValue.formula, sheet.name) : [],
        styleFingerprint: hash(JSON.stringify(cell.style ?? {})),
      };
      cells.push(item);
      mappings[locator] = inferMapping(sheet.name, cell.address, value, context);
    }));
  });
  const externalLinks: string[] = [];
  for (const entry of Object.keys(zip.files).filter((item) => item.endsWith(".rels"))) {
    const content = await zip.file(entry)?.async("text");
    if (content && /TargetMode\s*=\s*["']External["']/i.test(content)) externalLinks.push(entry);
  }
  const formulaCells = cells.filter((item) => item.formula);
  return WorkbookIrSchema.parse({
    schemaVersion: 1,
    sourceSha256: hash(bytes),
    structuralGraph: {
      sheets: workbook.worksheets.map((sheet) => ({ name: sheet.name, state: sheet.state, rowCount: sheet.rowCount, columnCount: sheet.columnCount })),
      namedRanges: Object.keys(workbook.definedNames.model ?? {}),
      externalLinks,
    },
    formulaGraph: { cells, edges: formulaCells.flatMap((cell) => cell.dependencies.map((dependency) => ({ from: `${cell.locator.sheet}!${cell.locator.address}`, to: dependency }))) },
    financeGraph: {
      contextVersion: context.version,
      mappings,
      unresolvedLocators: Object.entries(mappings).filter(([, mapping]) => mapping.resolvedBy === "unresolved").map(([locator]) => locator),
      ambiguousLocators: Object.entries(mappings).filter(([, mapping]) => mapping.ambiguities.length > 0).map(([locator]) => locator),
    },
    calculation: { stale: formulaCells.some((item) => item.cachedValue === undefined), provider: null, providerVersion: null, recalculatedSha256: null },
  });
}

export async function parseWorkbookFile(filePath: string, semanticContext: WorkbookSemanticContext = EMPTY_CONTEXT): Promise<WorkbookIr> {
  return parseWorkbookBytes(await readFile(filePath), semanticContext);
}
