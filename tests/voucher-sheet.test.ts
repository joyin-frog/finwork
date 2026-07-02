import assert from "node:assert/strict";
import { buildVoucherSheet, VOUCHER_SHEET_HEADERS } from "../lib/domain/voucher-sheet.ts";
import type { VoucherLine } from "../lib/domain/voucher-build.ts";

// 凭证 → 金蝶对照手填清单(Excel 行数据)。列顺序对齐金蝶凭证录入界面,借贷分列,多凭证摊平。
export const voucherSheetTestPromise = (async () => {
  const linesA: VoucherLine[] = [
    { summary: "住宿费", account: "6602.04", accountName: "管理费用-旅差费", dimensionType: "部门", dimensionValue: "综合部", debitYuan: 1377 },
    { summary: "餐饮费", account: "6602.04", accountName: "管理费用-旅差费", dimensionType: "部门", dimensionValue: "综合部", debitYuan: 2323 },
    { summary: "付款", account: "1002", accountName: "银行存款", creditYuan: 3700 },
  ];
  const linesB: VoucherLine[] = [
    { summary: "付水电费", account: "6602.08", accountName: "管理费用-水电费", dimensionType: "部门", dimensionValue: "行政部", debitYuan: 6155.8 },
    { summary: "付款", account: "1002", accountName: "银行存款", creditYuan: 6155.8 },
  ];

  const sheet = buildVoucherSheet([
    { date: "2026-06-01", lines: linesA },
    { date: "2026-06-02", voucherWord: "记", lines: linesB },
  ]);

  // ── 表头列顺序对齐金蝶(日期/凭证字/摘要/科目编码/科目全名/核算维度/借方/贷方)──
  assert.deepEqual(sheet.headers, VOUCHER_SHEET_HEADERS, "SH1 FAIL: 表头列顺序");
  assert.equal(sheet.headers[0], "日期", "SH1 FAIL: 首列日期");
  assert.equal(sheet.headers[6], "借方金额", "SH1 FAIL: 第7列借方");
  assert.equal(sheet.headers[7], "贷方金额", "SH1 FAIL: 第8列贷方");

  // ── 行数 = 两张凭证行数之和(3+2=5),多凭证摊平 ──
  assert.equal(sheet.rows.length, 5, "SH2 FAIL: 5 行(3+2)");

  // ── 首行:日期/凭证字每行都填(金蝶导入要求),借方分列,贷方留空 ──
  const r0 = sheet.rows[0];
  assert.equal(r0[0], "2026-06-01", "SH3 FAIL: 日期每行填");
  assert.equal(r0[1], "记", "SH3 FAIL: 凭证字默认记");
  assert.equal(r0[2], "住宿费", "SH3 FAIL: 摘要");
  assert.equal(r0[3], "6602.04", "SH3 FAIL: 科目编码");
  assert.equal(r0[5], "综合部", "SH3 FAIL: 核算维度填维度值");
  assert.equal(r0[6], 1377, "SH3 FAIL: 借方金额");
  assert.equal(r0[7], "", "SH3 FAIL: 借方行贷方列留空");

  // ── 贷方行:借方列留空,贷方列有值 ──
  const r2 = sheet.rows[2];
  assert.equal(r2[6], "", "SH4 FAIL: 贷方行借方列留空");
  assert.equal(r2[7], 3700, "SH4 FAIL: 贷方金额");

  // ── 第二张凭证的行日期正确(摊平后各凭证日期不串)──
  assert.equal(sheet.rows[3][0], "2026-06-02", "SH5 FAIL: 第二凭证日期");
  assert.equal(sheet.rows[3][6], 6155.8, "SH5 FAIL: 第二凭证借方");

  // ── 空输入 → 只有表头无数据行 ──
  const empty = buildVoucherSheet([]);
  assert.equal(empty.rows.length, 0, "SH6 FAIL: 空输入无数据行");
  assert.deepEqual(empty.headers, VOUCHER_SHEET_HEADERS, "SH6 FAIL: 空输入仍有表头");

  console.log("voucher-sheet: 列顺序/借贷分列/多凭证摊平/日期不串/空输入 ✓");
})();
