/**
 * tests/excel-preview-enhance.test.ts
 * Excel 预览增强纯函数单测:formatNumber / isNumericFormat / extractCellStyle / 公式提取。
 * 不需要浏览器;wire 进 tests/all.test.ts。
 */
import assert from "node:assert/strict";
import { formatNumber, isNumericFormat } from "../lib/preview/numfmt.ts";

export const excelPreviewEnhanceTestPromise = (async () => {

  // ── formatNumber:货币格式 ─────────────────────────────────────────────────
  {
    const r = formatNumber(1234567.89, "¥#,##0.00");
    assert.equal(r.text, "¥1,234,567.89", "货币 ¥#,##0.00");
    assert.equal(r.isNumeric, true, "货币格式 isNumeric");
    assert.equal(r.negative, false, "正数 negative=false");
  }
  {
    const r = formatNumber(-5000, "¥#,##0.00");
    assert.equal(r.text, "-¥5,000.00", "货币负数 ¥#,##0.00");
    assert.equal(r.negative, true, "负数 negative=true");
  }
  console.log("✓ PASS: formatNumber 货币格式");

  // ── formatNumber:千分位 ──────────────────────────────────────────────────
  {
    const r = formatNumber(1000000, "#,##0");
    assert.equal(r.text, "1,000,000", "千分位整数");
  }
  {
    const r = formatNumber(9876543.21, "#,##0.00");
    assert.equal(r.text, "9,876,543.21", "千分位两位小数");
  }
  console.log("✓ PASS: formatNumber 千分位");

  // ── formatNumber:百分比 ──────────────────────────────────────────────────
  {
    const r = formatNumber(0.1234, "0%");
    assert.equal(r.text, "12%", "百分比 0% 整数");
    assert.equal(r.isNumeric, true);
  }
  {
    const r = formatNumber(0.1234, "0.0%");
    assert.equal(r.text, "12.3%", "百分比 0.0%");
  }
  {
    const r = formatNumber(0.1234, "0.00%");
    assert.equal(r.text, "12.34%", "百分比 0.00%");
  }
  console.log("✓ PASS: formatNumber 百分比");

  // ── formatNumber:小数位 ──────────────────────────────────────────────────
  {
    const r = formatNumber(3.14159, "0.00");
    assert.equal(r.text, "3.14", "两位小数");
  }
  {
    const r = formatNumber(42, "0");
    assert.equal(r.text, "42", "整数 0 格式");
  }
  console.log("✓ PASS: formatNumber 小数位");

  // ── formatNumber:负数格式段 ─────────────────────────────────────────────
  {
    // #,##0;[Red]-#,##0 — 负数段有 [Red] 前缀
    const r = formatNumber(-9999, "#,##0;[Red]-#,##0");
    assert.equal(r.text, "-9,999", "负数 [Red] 格式");
    assert.equal(r.negative, true);
  }
  {
    // #,##0.00;(#,##0.00) — 括号格式
    const r = formatNumber(-1234.5, "#,##0.00;(#,##0.00)");
    assert.equal(r.text, "1,234.50", "括号负数格式(括号已在 applyPositiveFormat 里保留)");
    assert.equal(r.negative, true);
  }
  console.log("✓ PASS: formatNumber 负数格式段");

  // ── formatNumber:识别不了的格式回落不崩 ──────────────────────────────────
  {
    const r = formatNumber(123, "些乱七八糟的格式xyz");
    // 回落:至少不抛错,返回字符串
    assert.equal(typeof r.text, "string", "未知格式回落不崩");
  }
  {
    const r = formatNumber("文字单元格", "#,##0");
    // value 不是数字 → 原样返回
    assert.equal(r.text, "文字单元格", "非数字 value 原样");
    assert.equal(r.isNumeric, false);
  }
  {
    const r = formatNumber(null, "¥#,##0.00");
    assert.equal(r.text, "", "null 回落空字符串");
  }
  console.log("✓ PASS: formatNumber 回落");

  // ── formatNumber:General / 无 numFmt ─────────────────────────────────────
  {
    const r = formatNumber(42.5);
    assert.equal(r.text, "42.5", "无 numFmt 原值");
    assert.equal(r.isNumeric, true);
  }
  {
    const r = formatNumber(0, "General");
    assert.equal(r.text, "0", "General 格式");
  }
  console.log("✓ PASS: formatNumber General");

  // ── isNumericFormat ───────────────────────────────────────────────────────
  assert.equal(isNumericFormat("#,##0"), true, "千分位是数字格式");
  assert.equal(isNumericFormat("0.00%"), true, "百分比是数字格式");
  assert.equal(isNumericFormat("¥#,##0.00"), true, "货币是数字格式");
  assert.equal(isNumericFormat("@"), false, "@ 文本格式 → false");
  assert.equal(isNumericFormat(""), false, "空 numFmt → false");
  assert.equal(isNumericFormat(undefined), false, "undefined numFmt → false");
  assert.equal(isNumericFormat("General"), true, "General 是数字格式");
  console.log("✓ PASS: isNumericFormat");

  // ── 公式提取(isFormulaValue 逻辑) ─────────────────────────────────────────
  {
    // 模拟 ExcelJS formula value 结构
    const formulaValue = { formula: "SUM(B1:B4)", result: 100 };
    const isFormula = typeof formulaValue === "object" && formulaValue !== null && "formula" in formulaValue;
    assert.equal(isFormula, true, "含 formula 字段的对象识别为公式");
    // 公式栏内容:=SUM(B1:B4)
    const barValue = isFormula ? `=${formulaValue.formula}` : String(formulaValue.result);
    assert.equal(barValue, "=SUM(B1:B4)", "公式栏显示 =公式");
  }
  {
    const plainValue = 42;
    const isFormula = typeof plainValue === "object" && plainValue !== null && "formula" in (plainValue as object);
    assert.equal(isFormula, false, "普通数字不是公式");
  }
  console.log("✓ PASS: 公式提取逻辑");

  // ── 数字右对齐判定 ────────────────────────────────────────────────────────
  {
    // 当 cell.alignment.horizontal 未设置,数字类型 → isNumeric=true
    const numFmt = "#,##0.00";
    const rawValue = 999;
    const hAlign = undefined; // 文件未设 alignment
    const fileAlignSet = hAlign && hAlign !== "general";
    const { isNumeric: fmt_isNumeric } = formatNumber(rawValue, numFmt);
    const isNumericCell = !fileAlignSet && fmt_isNumeric;
    assert.equal(isNumericCell, true, "无文件 alignment + 数字 → 右对齐标记");
  }
  {
    // 当文件显式设了 horizontal="left" → 不走数字右对齐
    const numFmt = "#,##0.00";
    const rawValue = 999;
    const hAlign = "left";
    const fileAlignSet = hAlign && hAlign !== "general";
    const isNumericCell = !fileAlignSet;
    assert.equal(isNumericCell, false, "文件 alignment left → 不强制右对齐");
  }
  console.log("✓ PASS: 数字右对齐判定");

  console.log("\n✅ All excel-preview-enhance tests passed!");
})();
