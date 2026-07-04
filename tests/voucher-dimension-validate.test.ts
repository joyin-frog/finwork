import assert from "node:assert/strict";
import { validateVoucherDimensions } from "../lib/domain/voucher-dimension-validate.ts";
import type { VoucherLine } from "../lib/domain/voucher-build.ts";
import type { KingdeeAccount } from "../lib/db/finance-store.ts";

// B. 维度合法性确定性校验:纯函数,给定分录行 + 科目表条目
// 规则:科目无核算维度 → 行不应填维度(否则报错);科目有核算维度 → 类型须一致;值缺失出 warning
export const voucherDimensionValidateTestPromise = (async () => {
  const chart: KingdeeAccount[] = [
    { code: "6602.04", name: "管理费用-旅差费", type: "费用", dimension: "部门" },
    { code: "6603.01", name: "财务费用-利息支出", type: "费用" /* 无核算维度 */ },
    { code: "6603.02", name: "财务费用-利息收入", type: "费用" /* 无核算维度 */ },
    { code: "6603.04", name: "财务费用-手续费", type: "费用" /* 无核算维度 */ },
    { code: "1002.01", name: "银行存款-浦发", type: "资产", dimension: "银行账号" },
  ];

  // ── DV1: 科目无核算维度,行填了维度 → errors 包含拒绝信息 ──
  const noChartDimButFilled: VoucherLine = {
    summary: "利息支出",
    account: "6603.01",
    accountName: "财务费用-利息支出",
    dimensionType: "部门",
    dimensionValue: "财务部",
    debitYuan: 100,
  };
  const dv1 = validateVoucherDimensions([noChartDimButFilled], chart);
  assert.ok(dv1.errors.length > 0, "DV1 FAIL: 无核算维度科目填维度应报错");
  assert.ok(dv1.errors[0].includes("6603.01"), "DV1 FAIL: 错误信息应含科目编码");
  assert.ok(dv1.errors[0].includes("无核算维度"), "DV1 FAIL: 错误信息应含「无核算维度」");

  // ── DV2: 科目有核算维度,行的 dimensionType 与之一致 + 有值 → ok,无 errors/warnings ──
  const matchDim: VoucherLine = {
    summary: "差旅费",
    account: "6602.04",
    dimensionType: "部门",
    dimensionValue: "综合部",
    debitYuan: 3700,
  };
  const dv2 = validateVoucherDimensions([matchDim], chart);
  assert.equal(dv2.errors.length, 0, "DV2 FAIL: 维度类型一致+有值不应有错误");
  assert.equal(dv2.warnings.length, 0, "DV2 FAIL: 维度类型一致+有值不应有警告");

  // ── DV3: 科目有核算维度,dimensionType 不一致 → errors ──
  const mismatchDim: VoucherLine = {
    summary: "差旅费",
    account: "6602.04",
    dimensionType: "员工",
    dimensionValue: "张三",
    debitYuan: 3700,
  };
  const dv3 = validateVoucherDimensions([mismatchDim], chart);
  assert.ok(dv3.errors.length > 0, "DV3 FAIL: 维度类型不一致应报错");
  assert.ok(dv3.errors[0].includes("6602.04"), "DV3 FAIL: 错误应含科目编码");

  // ── DV4: 科目有核算维度,维度值缺失 → warnings,不是 error ──
  const missingValue: VoucherLine = {
    summary: "差旅费",
    account: "6602.04",
    dimensionType: "部门",
    // dimensionValue 缺失
    debitYuan: 3700,
  };
  const dv4 = validateVoucherDimensions([missingValue], chart);
  assert.equal(dv4.errors.length, 0, "DV4 FAIL: 维度值缺失不应是 error");
  assert.ok(dv4.warnings.length > 0, "DV4 FAIL: 维度值缺失应有 warning");

  // ── DV5: 无核算维度科目,行也无维度 → 完全 ok ──
  const noChartNoDim: VoucherLine = {
    summary: "利息收入",
    account: "6603.02",
    creditYuan: 26.34,
    // 无 dimensionType/Value
  };
  const dv5 = validateVoucherDimensions([noChartNoDim], chart);
  assert.equal(dv5.errors.length, 0, "DV5 FAIL: 无核算维度科目+行也无维度→无错");
  assert.equal(dv5.warnings.length, 0, "DV5 FAIL: 无核算维度科目+行也无维度→无警告");

  // ── DV6: 混合行:一行正确(银行账号)+一行无维度科目填了维度 → 只报有问题的那行 ──
  const bankLine: VoucherLine = {
    summary: "收款",
    account: "1002.01",
    dimensionType: "银行账号",
    dimensionValue: "建设银行浦东支行",
    debitYuan: 26.34,
  };
  const badLine: VoucherLine = {
    summary: "利息收入",
    account: "6603.02",
    dimensionType: "部门",
    dimensionValue: "财务部",
    creditYuan: 26.34,
  };
  const dv6 = validateVoucherDimensions([bankLine, badLine], chart);
  assert.equal(dv6.errors.length, 1, "DV6 FAIL: 只有一行有问题,应只有一个错误");
  assert.ok(dv6.errors[0].includes("6603.02"), "DV6 FAIL: 错误应指向 6603.02");

  console.log("voucher-dimension-validate: 无维度填了拒/一致通过/不一致拒/值缺失警告/混合行 ✓");
})();
