import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ExcelJS from "exceljs";
import { validateConsolidationWorkbook } from "../lib/deliverable/validators/financial-consolidation.ts";

export const financialConsolidationValidatorTestPromise = (async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "finwork-consolidation-validator-"));
  try {
    const validPath = path.join(root, "valid.xlsx");
    await writeWorkbook(validPath, { cash: 100, liabilitiesEquity: 1_000, includeCashFlow: true, formulas: true });
    const valid = await validateConsolidationWorkbook(validPath, {
      company: "都森及子公司",
      period: "2026年1-6月",
    });
    assert.deepEqual(valid.errors, [], `valid consolidation should pass: ${JSON.stringify(valid.errors)}`);

    const invalidPath = path.join(root, "invalid.xlsx");
    await writeWorkbook(invalidPath, { cash: 80, liabilitiesEquity: 900, includeCashFlow: false, formulas: false });
    const invalid = await validateConsolidationWorkbook(invalidPath, {
      company: "都森及子公司",
      period: "2026年1-6月",
    });
    const codes = new Set(invalid.errors.map((issue) => issue.code));
    assert.ok(codes.has("CONSOLIDATION_REQUIRED_SHEET_MISSING"));
    assert.ok(codes.has("CONSOLIDATION_BALANCE_FAILED"));
    assert.ok(codes.has("CONSOLIDATION_REQUIRED_FORMULA_MISSING"));
    console.log("financial-consolidation-validator: sheets + TB + statements + eliminations + formulas ✓");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
})();

async function writeWorkbook(
  filePath: string,
  options: { cash: number; liabilitiesEquity: number; includeCashFlow: boolean; formulas: boolean },
) {
  const workbook = new ExcelJS.Workbook();
  const tb = workbook.addWorksheet("TB");
  tb.addRows([
    ["编制单位", "都森及子公司", "会计期间", "2026年1-6月"],
    ["科目", "借方", "贷方"],
    ["货币资金", options.cash, 0],
    ["实收资本", 0, 1_000],
  ]);
  // Real consolidation templates contain decorative merged blank ranges.
  // ExcelJS represents the non-master cells as MergeValue and used to throw
  // when the validator called `.text` while the master value was null.
  tb.mergeCells("D10:E10");

  const adjustments = workbook.addWorksheet("调整分录");
  adjustments.addRows([
    ["调整说明", "借方调整", "贷方调整"],
    ["内部往来抵消", 100, 0],
    ["内部往来抵消", 0, 100],
  ]);

  const balance = workbook.addWorksheet("资产负债表");
  balance.addRow(["编制单位：都森及子公司", "2026年1-6月"]);
  balance.addRow(["货币资金", options.cash]);
  balance.addRow(["资产总计", formula(options.formulas, "B2+900", 1_000)]);
  balance.addRow(["所有者权益合计", formula(options.formulas, "B3-400", 600)]);
  balance.addRow(["负债和所有者权益总计", formula(options.formulas, "B4+400", options.liabilitiesEquity)]);

  const income = workbook.addWorksheet("利润表");
  income.addRows([
    ["利润总额", 100],
    ["所得税费用", 20],
    ["净利润", formula(options.formulas, "B1-B2", 80)],
  ]);

  if (options.includeCashFlow) {
    const cash = workbook.addWorksheet("现金流量表");
    cash.addRow(["期末现金及现金等价物余额", options.cash]);
  }

  const equity = workbook.addWorksheet("所有者权益变动表");
  equity.addRows([
    ["项目", "实收资本", "未分配利润", "所有者权益合计"],
    ["本期期末余额", 500, 100, formula(options.formulas, "B2+C2", 600)],
  ]);
  await workbook.xlsx.writeFile(filePath);
}

function formula(enabled: boolean, expression: string, result: number): ExcelJS.CellValue {
  return enabled ? { formula: expression, result } : result;
}
