import ExcelJS from "exceljs";
import type { SpreadsheetAssertion, DeliverySpec } from "@/lib/agent/run-contract";
import type { ValidatorIssue, ValidatorResult } from "../types";
import type { ValidatorInput } from "./registry";
import { validateXlsxFile } from "./xlsx";

const VALIDATOR_ID = "xlsx_financial_consolidation";
const DEFAULT_TOLERANCE = 0.01;

type CellFact = {
  sheet: string;
  address: string;
  label: string;
  value: number;
  formula: string | null;
};

type DomainValidation = {
  errors: ValidatorIssue[];
  warnings: ValidatorIssue[];
  evidence: Record<string, unknown>;
};

const REQUIRED_SHEETS = [
  { role: "trial_balance", label: "TB/试算平衡表", patterns: [/^TB(?:表)?$/i, /试算.*平衡/, /科目余额/] },
  { role: "adjustments", label: "调整/抵消分录", patterns: [/调整分录/, /抵消分录/, /elimination/i] },
  { role: "balance_sheet", label: "资产负债表", patterns: [/资产负债表/, /balance\s*sheet/i] },
  { role: "income_statement", label: "利润表", patterns: [/利润表/, /损益表/, /income\s*statement/i] },
  { role: "cash_flow", label: "现金流量表", patterns: [/现金流量表/, /cash\s*flow/i] },
  { role: "equity", label: "所有者权益变动表", patterns: [/所有者权益.*变动/, /equity/i] },
] as const;

export async function validateFinancialConsolidation(input: ValidatorInput): Promise<ValidatorResult> {
  const base = await validateXlsxFile({
    ...input,
    requireFormulaCache: input.requireFormulaCache ?? true,
    needsRecalc: input.needsRecalc ?? true,
  });
  const domain = await validateConsolidationWorkbook(input.filePath, input.expectationSnapshot);
  const errors = [...base.errors, ...domain.errors];
  const warnings = [...base.warnings, ...domain.warnings];
  return {
    status: errors.length ? "failed" : "passed",
    validatorId: VALIDATOR_ID,
    fileSha256: base.fileSha256,
    errors,
    warnings,
    evidence: { ...base.evidence, consolidation: domain.evidence },
  };
}

export async function validateConsolidationWorkbook(
  filePath: string,
  expectation: DeliverySpec["expectationSnapshot"] = {},
): Promise<DomainValidation> {
  const errors: ValidatorIssue[] = [];
  const warnings: ValidatorIssue[] = [];
  const evidence: Record<string, unknown> = {};
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.readFile(filePath);
  } catch (error) {
    return {
      errors: [{
        code: "CONSOLIDATION_OPEN_FAILED",
        message: error instanceof Error ? error.message : String(error),
      }],
      warnings,
      evidence,
    };
  }

  const roles = new Map<string, ExcelJS.Worksheet>();
  for (const required of REQUIRED_SHEETS) {
    const sheet = workbook.worksheets.find((candidate) =>
      required.patterns.some((pattern) => pattern.test(candidate.name.trim())),
    );
    if (!sheet) {
      errors.push({
        code: "CONSOLIDATION_REQUIRED_SHEET_MISSING",
        message: `缺少必需工作表：${required.label}`,
        location: required.role,
      });
    } else {
      roles.set(required.role, sheet);
    }
  }
  evidence.sheetRoles = Object.fromEntries([...roles].map(([role, sheet]) => [role, sheet.name]));

  const allText = workbook.worksheets.flatMap((sheet) =>
    collectText(sheet, 120, 80).map((text) => `${sheet.name}:${text}`),
  );
  if (expectation.company && !allText.some((text) => text.includes(expectation.company!))) {
    errors.push({ code: "CONSOLIDATION_COMPANY_MISMATCH", message: `工作簿未出现合同公司：${expectation.company}` });
  }
  if (expectation.period && !allText.some((text) => normalizeText(text).includes(normalizeText(expectation.period!)))) {
    errors.push({ code: "CONSOLIDATION_PERIOD_MISMATCH", message: `工作簿未出现合同期间：${expectation.period}` });
  }

  const tb = roles.get("trial_balance");
  if (tb) validateTrialBalance(tb, errors, evidence);

  const adjustment = roles.get("adjustments");
  if (adjustment) validateAdjustments(adjustment, errors, evidence);

  const balance = roles.get("balance_sheet");
  const income = roles.get("income_statement");
  const cashFlow = roles.get("cash_flow");
  const equity = roles.get("equity");

  const assets = balance && findLabeledNumber(balance, [/资产总计/, /total\s+assets/i]);
  const liabilitiesEquity = balance && findLabeledNumber(balance, [/(?:负债和|负债及).*所有者权益.*总计/, /total\s+liabilities.*equity/i]);
  compareFacts("CONSOLIDATION_BALANCE_FAILED", "资产总计与负债及权益总计不平", assets, liabilitiesEquity, DEFAULT_TOLERANCE, errors, evidence);

  const profitTotal = income && findLabeledNumber(income, [/利润总额/]);
  const incomeTax = income && findLabeledNumber(income, [/所得税费用/]);
  const netProfit = income && findLabeledNumber(income, [/净利润/]);
  if (profitTotal && incomeTax && netProfit) {
    const difference = profitTotal.value - incomeTax.value - netProfit.value;
    evidence.profitReconciliation = { profitTotal, incomeTax, netProfit, difference };
    if (Math.abs(difference) > DEFAULT_TOLERANCE) {
      errors.push({ code: "CONSOLIDATION_PROFIT_FAILED", message: `利润勾稽不平，差额 ${difference.toFixed(2)}`, location: netProfit.address });
    }
  } else if (income) {
    errors.push({ code: "CONSOLIDATION_PROFIT_INCOMPLETE", message: "利润表缺少利润总额、所得税费用或净利润" });
  }

  const bsEquity = balance && findLabeledNumber(balance, [/所有者权益(?:\(或股东权益\))?合计/, /total\s+equity/i]);
  const equityEnding = equity && findRowEndingTotal(equity, [/本期.*期末余额/, /本年.*期末余额/, /ending\s+balance/i]);
  compareFacts("CONSOLIDATION_EQUITY_FAILED", "权益变动表期末权益与资产负债表不一致", bsEquity, equityEnding, DEFAULT_TOLERANCE, errors, evidence);

  const bsCash = balance && findLabeledNumber(balance, [/货币资金/, /cash(?:\s+and\s+cash\s+equivalents)?/i]);
  const cfCash = cashFlow && findLabeledNumber(cashFlow, [/期末现金及现金等价物余额/, /现金及现金等价物期末余额/, /cash.*end/i]);
  compareFacts("CONSOLIDATION_CASH_FAILED", "现金流期末现金与资产负债表货币资金不一致", bsCash, cfCash, DEFAULT_TOLERANCE, errors, evidence);

  let formulaCount = 0;
  for (const sheet of workbook.worksheets) {
    sheet.eachRow({ includeEmpty: false }, (row) => row.eachCell({ includeEmpty: false }, (cell) => {
      if (formulaOf(cell)) formulaCount += 1;
    }));
  }
  evidence.formulaCount = formulaCount;
  if (formulaCount === 0) {
    errors.push({
      code: "CONSOLIDATION_REQUIRED_FORMULA_MISSING",
      message: "合并报表没有保留任何动态公式，疑似被重建为硬编码静态表",
    });
  }

  validateDeclaredAssertions(workbook, expectation.assertions ?? [], errors, evidence);
  return { errors, warnings, evidence };
}

function validateTrialBalance(sheet: ExcelJS.Worksheet, errors: ValidatorIssue[], evidence: Record<string, unknown>): void {
  let populatedRows = 0;
  let numericCells = 0;
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const values = row.values as unknown[];
    if (values.some((value) => String(value ?? "").trim())) populatedRows += 1;
    row.eachCell({ includeEmpty: false }, (cell) => {
      if (numberOf(cell) != null) numericCells += 1;
    });
  });
  evidence.trialBalance = { sheet: sheet.name, populatedRows, numericCells };
  if (populatedRows < 3 || numericCells < 2) {
    errors.push({ code: "CONSOLIDATION_TB_INCOMPLETE", message: "TB/科目余额表缺少足够的科目和金额数据", location: sheet.name });
  }
}

function validateAdjustments(sheet: ExcelJS.Worksheet, errors: ValidatorIssue[], evidence: Record<string, unknown>): void {
  let debitColumn = 0;
  let creditColumn = 0;
  for (let row = 1; row <= Math.min(sheet.rowCount, 30); row += 1) {
    sheet.getRow(row).eachCell({ includeEmpty: false }, (cell, column) => {
      const label = normalizeText(safeCellText(cell));
      if (/借方/.test(label)) debitColumn ||= column;
      if (/贷方/.test(label)) creditColumn ||= column;
    });
  }
  if (!debitColumn || !creditColumn) {
    errors.push({ code: "CONSOLIDATION_ADJUSTMENT_INCOMPLETE", message: "调整/抵消分录缺少借方或贷方列", location: sheet.name });
    return;
  }
  let debit = 0;
  let credit = 0;
  let entries = 0;
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    const left = numberOf(sheet.getCell(row, debitColumn));
    const right = numberOf(sheet.getCell(row, creditColumn));
    if (left != null || right != null) entries += 1;
    debit += left ?? 0;
    credit += right ?? 0;
  }
  const difference = debit - credit;
  evidence.adjustments = { sheet: sheet.name, entries, debit, credit, difference };
  if (entries === 0) {
    errors.push({ code: "CONSOLIDATION_ADJUSTMENT_INCOMPLETE", message: "没有可验证的调整/抵消分录", location: sheet.name });
  } else if (Math.abs(difference) > DEFAULT_TOLERANCE) {
    errors.push({ code: "CONSOLIDATION_ADJUSTMENT_FAILED", message: `抵消分录借贷不平，差额 ${difference.toFixed(2)}`, location: sheet.name });
  }
}

function validateDeclaredAssertions(
  workbook: ExcelJS.Workbook,
  assertions: SpreadsheetAssertion[],
  errors: ValidatorIssue[],
  evidence: Record<string, unknown>,
): void {
  if (!assertions.length) return;
  const facts = new Map<string, CellFact>();
  for (const entry of (workbook.definedNames.model ?? []) as Array<{ name?: string; ranges?: string[] }>) {
    const range = entry.ranges?.[0];
    if (!entry.name || !range) continue;
    const match = range.match(/^'?(.+?)'?!(?:\$)?([A-Z]{1,3})(?:\$)?(\d+)$/i);
    if (!match) continue;
    const sheet = workbook.getWorksheet(match[1].replace(/''/g, "'"));
    if (!sheet) continue;
    const cell = sheet.getCell(`${match[2]}${match[3]}`);
    const value = numberOf(cell);
    if (value == null) continue;
    facts.set(entry.name, { sheet: sheet.name, address: cell.address, label: entry.name, value, formula: formulaOf(cell) });
  }
  const results: unknown[] = [];
  for (const assertion of assertions) {
    if (assertion.type === "cell_is_formula") {
      const fact = facts.get(assertion.definedName);
      const ok = Boolean(fact?.formula);
      results.push({ assertion, fact, ok });
      if (!ok) errors.push({ code: "CONSOLIDATION_REQUIRED_FORMULA_MISSING", message: `${assertion.definedName} 必须为公式` });
      continue;
    }
    if (assertion.type === "cell_equals") {
      const fact = facts.get(assertion.definedName);
      const expected = typeof assertion.expected === "number" ? assertion.expected : Number(assertion.expected);
      const ok = fact != null && Number.isFinite(expected) && Math.abs(fact.value - expected) <= DEFAULT_TOLERANCE;
      results.push({ assertion, fact, ok });
      if (!ok) errors.push({ code: "CONSOLIDATION_ASSERTION_FAILED", message: `${assertion.definedName} 与合同值不一致` });
      continue;
    }
    const leftName = assertion.type === "cells_balance" ? assertion.leftName : assertion.cashFlowName;
    const rightName = assertion.type === "cells_balance" ? assertion.rightName : assertion.balanceSheetName;
    const left = facts.get(leftName);
    const right = facts.get(rightName);
    const ok = left != null && right != null && Math.abs(left.value - right.value) <= assertion.tolerance;
    results.push({ assertion, left, right, ok });
    if (!ok) errors.push({ code: "CONSOLIDATION_ASSERTION_FAILED", message: `${leftName} 与 ${rightName} 勾稽失败` });
  }
  evidence.declaredAssertions = results;
}

function compareFacts(
  code: string,
  message: string,
  left: CellFact | null | undefined,
  right: CellFact | null | undefined,
  tolerance: number,
  errors: ValidatorIssue[],
  evidence: Record<string, unknown>,
): void {
  const key = code.toLowerCase();
  if (!left || !right) {
    errors.push({ code: code.replace("_FAILED", "_INCOMPLETE"), message: `${message}：缺少可定位的源单元格` });
    evidence[key] = { left: left ?? null, right: right ?? null, checked: false };
    return;
  }
  const difference = left.value - right.value;
  evidence[key] = { left, right, difference, tolerance, checked: true };
  if (Math.abs(difference) > tolerance) {
    errors.push({ code, message: `${message}，差额 ${difference.toFixed(2)}`, location: `${left.sheet}!${left.address}` });
  }
}

function findLabeledNumber(sheet: ExcelJS.Worksheet, patterns: RegExp[]): CellFact | null {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    for (let column = 1; column <= Math.max(sheet.columnCount, 1); column += 1) {
      const label = normalizeText(safeCellText(row.getCell(column)));
      if (!label || !patterns.some((pattern) => pattern.test(label))) continue;
      for (let offset = 1; offset <= 8; offset += 1) {
        const cell = row.getCell(column + offset);
        const value = numberOfOrFormulaZero(cell);
        if (value != null) return { sheet: sheet.name, address: cell.address, label, value, formula: formulaOf(cell) };
      }
    }
  }
  return null;
}

function findRowEndingTotal(sheet: ExcelJS.Worksheet, patterns: RegExp[]): CellFact | null {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    let labelColumn = 0;
    let label = "";
    row.eachCell({ includeEmpty: false }, (cell, column) => {
      const candidate = normalizeText(safeCellText(cell));
      if (!labelColumn && patterns.some((pattern) => pattern.test(candidate))) {
        labelColumn = column;
        label = candidate;
      }
    });
    if (!labelColumn) continue;
    let explicitTotalColumn = 0;
    for (let headerRow = 1; headerRow < rowNumber && !explicitTotalColumn; headerRow += 1) {
      for (let column = labelColumn + 1; column <= sheet.columnCount; column += 1) {
        const header = normalizeText(safeCellText(sheet.getCell(headerRow, column)));
        if (/所有者权益.*合计|权益合计|total.*equity/i.test(header)) {
          explicitTotalColumn = column;
          break;
        }
      }
    }
    if (explicitTotalColumn) {
      const cell = row.getCell(explicitTotalColumn);
      const value = numberOfOrFormulaZero(cell);
      if (value != null) {
        return { sheet: sheet.name, address: cell.address, label, value, formula: formulaOf(cell) };
      }
    }
    let total = 0;
    let count = 0;
    for (let column = labelColumn + 1; column <= sheet.columnCount; column += 1) {
      const value = numberOfOrFormulaZero(row.getCell(column));
      if (value == null) continue;
      total += value;
      count += 1;
    }
    if (count) {
      return {
        sheet: sheet.name,
        address: `${row.getCell(labelColumn + 1).address}:${row.getCell(sheet.columnCount).address}`,
        label,
        value: total,
        formula: null,
      };
    }
  }
  return null;
}

function numberOf(cell: ExcelJS.Cell): number | null {
  const value = cell.value as { result?: unknown } | unknown;
  const raw = value && typeof value === "object" && "result" in value ? (value as { result?: unknown }).result : value;
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw === "string") {
    const parsed = Number(raw.replace(/,/g, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function numberOfOrFormulaZero(cell: ExcelJS.Cell): number | null {
  const value = numberOf(cell);
  if (value != null) return value;
  // LibreOffice intentionally omits cached `<v>` nodes for zero-valued formulas.
  // The generic validator has already performed a successful controlled recalc
  // before this domain pass, so a formula without a cached numeric result is the
  // current-period zero, not a reason to skip across into another period column.
  return formulaOf(cell) ? 0 : null;
}

function formulaOf(cell: ExcelJS.Cell): string | null {
  const value = cell.value as { formula?: unknown } | null;
  return value && typeof value === "object" && "formula" in value
    ? String(value.formula ?? "") || null
    : null;
}

function collectText(sheet: ExcelJS.Worksheet, maxRows: number, maxColumns: number): string[] {
  const values: string[] = [];
  for (let row = 1; row <= Math.min(sheet.rowCount, maxRows); row += 1) {
    for (let column = 1; column <= Math.min(sheet.columnCount, maxColumns); column += 1) {
      const value = safeCellText(sheet.getCell(row, column)).trim();
      if (value) values.push(value);
    }
  }
  return values;
}

/**
 * ExcelJS throws from MergeValue.toString() when a merged range has a blank
 * master cell. Blank decorative merges are common in financial templates and
 * must be treated as empty text, not as a validator/tool failure.
 */
function safeCellText(cell: ExcelJS.Cell): string {
  try {
    return cell.text ?? "";
  } catch {
    return "";
  }
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, "").replace(/[（）()]/g, "").toLowerCase();
}
