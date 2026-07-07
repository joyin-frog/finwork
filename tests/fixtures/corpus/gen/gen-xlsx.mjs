#!/usr/bin/env node
/**
 * 生成三个 xlsx 语料样本：
 *   corpus/xlsx-offrow-header.xlsx    — 歪表头（数据从第 3 行开始，第 2 行才是表头）
 *   corpus/xlsx-merged-cells.xlsx     — 合并单元格（跨行值）
 *   corpus/xlsx-multisheet-first-empty.xlsx — 多 sheet 且首 sheet 空
 *
 * 运行方式（在仓库根目录）：
 *   node tests/fixtures/corpus/gen/gen-xlsx.mjs
 *
 * PII 规避：发票号 INV- 前缀；金额带小数点；日期带连字符；禁 1[3-9] 开头 11 位数字。
 */

import ExcelJS from "exceljs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, "..");

// 1. xlsx-offrow-header: 第 1 行是标题区，第 2 行是列名，第 3 行起是数据
async function genOffrowHeader() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("报销明细");
  ws.addRow(["报销汇总表 2026-01"]); // row 1: 标题区（非列头）
  ws.addRow(["金额", "类目", "发票号"]);    // row 2: 列名（非首行）
  ws.addRow([100.00, "办公用品", "INV-2026-001"]);
  ws.addRow([250.50, "交通费", "INV-2026-002"]);
  const out = path.join(OUT, "xlsx-offrow-header.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("已生成：", out);
}

// 2. xlsx-merged-cells: A1:A2 合并，值应能在 buildSpreadsheetMirror 输出中体现
async function genMergedCells() {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("账单");
  // 设置表头
  ws.addRow(["部门", "金额", "发票号"]);
  // 合并 A2:A3（"财务部" 跨两行）
  ws.addRow(["财务部", 500.00, "INV-2026-010"]);
  ws.addRow(["财务部", 320.00, "INV-2026-011"]);
  ws.mergeCells("A2:A3");
  ws.getCell("A2").value = "财务部";
  const out = path.join(OUT, "xlsx-merged-cells.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("已生成：", out);
}

// 3. xlsx-multisheet-first-empty: 首 sheet 空，数据在第二 sheet
async function genMultisheetFirstEmpty() {
  const wb = new ExcelJS.Workbook();
  // 首 sheet 空
  wb.addWorksheet("空白页");
  // 第二 sheet 有数据
  const ws2 = wb.addWorksheet("实际数据");
  ws2.addRow(["金额", "类目", "发票号"]);
  ws2.addRow([800.00, "招待费", "INV-2026-020"]);
  ws2.addRow([150.00, "办公用品", "INV-2026-021"]);
  const out = path.join(OUT, "xlsx-multisheet-first-empty.xlsx");
  await wb.xlsx.writeFile(out);
  console.log("已生成：", out);
}

await genOffrowHeader();
await genMergedCells();
await genMultisheetFirstEmpty();
console.log("全部 xlsx 样本已生成。");
