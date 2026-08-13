import ExcelJS from "exceljs";

export const WORKBOOK_CREATE_LIMITS = {
  sheets: 20,
  rowsPerSheet: 2_000,
  columnsPerSheet: 100,
  totalCells: 100_000,
  formulas: 10_000,
  textLength: 32_767,
} as const;

export type WorkbookCreateScalar = string | number | boolean | null;

export type WorkbookCellInput = WorkbookCreateScalar | {
  value?: WorkbookCreateScalar;
  formula?: string;
  result?: Exclude<WorkbookCreateScalar, null>;
  numberFormat?: string;
  bold?: boolean;
};

export type WorkbookSheetInput = {
  name: string;
  rows: WorkbookCellInput[][];
  headerRows?: number;
  freezeRows?: number;
  autoFilter?: boolean;
  columnWidths?: number[];
};

export type CreateWorkbookInput = {
  sheets: WorkbookSheetInput[];
};

export type WorkbookCreationResult = {
  buffer: Buffer;
  sheetCount: number;
  rowCount: number;
  cellCount: number;
  formulaCount: number;
};

const INVALID_SHEET_NAME = /[\\/*?:\[\]]/;
const EXTERNAL_WORKBOOK_REFERENCE = /\[[^\]]+\.(?:xlsx?|xlsm|xlsb|csv)\]/i;
const UNSAFE_FORMULA_FUNCTION = /\b(?:WEBSERVICE|FILTERXML|RTD)\s*\(/i;
const EXTERNAL_HYPERLINK = /\bHYPERLINK\s*\(\s*["'](?:(?:https?|ftp|file):|\\\\)/i;
const FORMULA_PROTOCOL = /(?:https?|ftp|file):\/\//i;
const DDE_REFERENCE = /\|[^!]{1,256}!/;

function normalizeFormula(raw: string): string {
  const formula = raw.trim().replace(/^=/, "");
  if (!formula) throw new Error("公式不能为空");
  if (
    EXTERNAL_WORKBOOK_REFERENCE.test(formula)
    || UNSAFE_FORMULA_FUNCTION.test(formula)
    || EXTERNAL_HYPERLINK.test(formula)
    || FORMULA_PROTOCOL.test(formula)
    || DDE_REFERENCE.test(formula)
  ) {
    throw new Error("公式包含外部工作簿、网络请求或动态数据连接，已拒绝创建");
  }
  return formula;
}

function validateSheetName(name: string): string {
  const normalized = name.trim();
  if (!normalized) throw new Error("工作表名不能为空");
  if (normalized.length > 31) throw new Error(`工作表名超过 31 个字符：${normalized}`);
  if (INVALID_SHEET_NAME.test(normalized) || normalized.startsWith("'") || normalized.endsWith("'")) {
    throw new Error(`工作表名包含 Excel 不允许的字符：${normalized}`);
  }
  return normalized;
}

function isCellObject(value: WorkbookCellInput): value is Exclude<WorkbookCellInput, WorkbookCreateScalar> {
  return typeof value === "object" && value !== null;
}

function validateScalar(value: WorkbookCreateScalar | undefined, locator: string): void {
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new Error(`${locator} 不能写入非有限数字`);
  }
  if (typeof value === "string" && value.length > WORKBOOK_CREATE_LIMITS.textLength) {
    throw new Error(`${locator} 文本超过 Excel 单元格上限 ${WORKBOOK_CREATE_LIMITS.textLength}`);
  }
}

function autoWidth(rows: WorkbookCellInput[][], columnIndex: number): number {
  let width = 10;
  for (const row of rows.slice(0, 500)) {
    const input = row[columnIndex];
    const raw = isCellObject(input) ? (input.value ?? input.result ?? input.formula ?? "") : input;
    const display = raw == null ? "" : String(raw);
    width = Math.max(width, Math.min(40, display.length + 2));
  }
  return width;
}

/**
 * Builds a new workbook from a bounded, declarative representation. Existing
 * workbooks deliberately use the preservation-oriented patch engine instead.
 */
export async function createWorkbookBuffer(input: CreateWorkbookInput): Promise<WorkbookCreationResult> {
  if (input.sheets.length === 0) throw new Error("至少需要一个工作表");
  if (input.sheets.length > WORKBOOK_CREATE_LIMITS.sheets) {
    throw new Error(`工作表数量超过上限 ${WORKBOOK_CREATE_LIMITS.sheets}`);
  }

  const names = new Set<string>();
  let rowCount = 0;
  let cellCount = 0;
  let formulaCount = 0;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = "Finwork";
  workbook.created = new Date();
  workbook.modified = new Date();
  workbook.calcProperties.fullCalcOnLoad = true;

  for (const sheetInput of input.sheets) {
    const name = validateSheetName(sheetInput.name);
    const foldedName = name.toLocaleLowerCase("en-US");
    if (names.has(foldedName)) throw new Error(`工作表名重复：${name}`);
    names.add(foldedName);
    if (sheetInput.rows.length > WORKBOOK_CREATE_LIMITS.rowsPerSheet) {
      throw new Error(`${name} 行数超过上限 ${WORKBOOK_CREATE_LIMITS.rowsPerSheet}`);
    }

    const maxColumns = sheetInput.rows.reduce((max, row) => Math.max(max, row.length), 0);
    if (maxColumns > WORKBOOK_CREATE_LIMITS.columnsPerSheet) {
      throw new Error(`${name} 列数超过上限 ${WORKBOOK_CREATE_LIMITS.columnsPerSheet}`);
    }
    const headerRows = sheetInput.headerRows ?? 0;
    const freezeRows = sheetInput.freezeRows ?? headerRows;
    if (headerRows < 0 || headerRows > sheetInput.rows.length) throw new Error(`${name} 的 headerRows 无效`);
    if (freezeRows < 0 || freezeRows > sheetInput.rows.length) throw new Error(`${name} 的 freezeRows 无效`);

    rowCount += sheetInput.rows.length;
    cellCount += sheetInput.rows.reduce((sum, row) => sum + row.length, 0);
    if (cellCount > WORKBOOK_CREATE_LIMITS.totalCells) {
      throw new Error(`总单元格数量超过上限 ${WORKBOOK_CREATE_LIMITS.totalCells}`);
    }

    const sheet = workbook.addWorksheet(name);
    if (freezeRows > 0) sheet.views = [{ state: "frozen", ySplit: freezeRows }];

    sheetInput.rows.forEach((rowInput, rowIndex) => {
      const row = sheet.getRow(rowIndex + 1);
      rowInput.forEach((input, columnIndex) => {
        const cell = row.getCell(columnIndex + 1);
        const locator = `${name}!${cell.address}`;
        cell.font = { name: "Arial", size: 10 };

        if (isCellObject(input)) {
          if (input.formula != null && input.value !== undefined) {
            throw new Error(`${locator} 不能同时提供 value 和 formula`);
          }
          if (input.formula == null && input.result !== undefined) {
            throw new Error(`${locator} 只有公式单元格可以提供 result`);
          }
          validateScalar(input.value, locator);
          validateScalar(input.result, locator);
          if (input.formula != null) {
            formulaCount += 1;
            if (formulaCount > WORKBOOK_CREATE_LIMITS.formulas) {
              throw new Error(`公式数量超过上限 ${WORKBOOK_CREATE_LIMITS.formulas}`);
            }
            const formulaValue: ExcelJS.CellFormulaValue = { formula: normalizeFormula(input.formula) };
            if (input.result !== undefined) formulaValue.result = input.result;
            cell.value = formulaValue;
          } else {
            cell.value = input.value ?? null;
          }
          if (input.numberFormat) cell.numFmt = input.numberFormat;
          if (input.bold) cell.font = { ...cell.font, bold: true };
        } else {
          validateScalar(input, locator);
          cell.value = input;
        }

        if (rowIndex < headerRows) {
          cell.font = { ...cell.font, bold: true };
          cell.fill = { type: "pattern", pattern: "solid", fgColor: { argb: "FFF2F2F2" } };
          cell.alignment = { vertical: "middle" };
        }
      });
    });

    for (let index = 0; index < maxColumns; index += 1) {
      const requested = sheetInput.columnWidths?.[index];
      if (requested != null && (!Number.isFinite(requested) || requested < 2 || requested > 100)) {
        throw new Error(`${name} 第 ${index + 1} 列宽度必须在 2 到 100 之间`);
      }
      sheet.getColumn(index + 1).width = requested ?? autoWidth(sheetInput.rows, index);
    }

    if (sheetInput.autoFilter && headerRows > 0 && maxColumns > 0) {
      sheet.autoFilter = {
        from: { row: headerRows, column: 1 },
        to: { row: headerRows, column: maxColumns },
      };
    }
  }

  const bytes = await workbook.xlsx.writeBuffer();
  return {
    buffer: Buffer.from(bytes),
    sheetCount: input.sheets.length,
    rowCount,
    cellCount,
    formulaCount,
  };
}
