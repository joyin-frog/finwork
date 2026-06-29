/**
 * 功能2-链路1: 薪税 CalcReceipt 补齐 source / settlementStatus / asOf
 *
 * 严格 TDD（CLAUDE.md §5）:
 *   F2-T1 在实现前 RED — calculateCumulativePayroll 的 settlementStatus 硬编码 "draft"，
 *   source 硬编码 []，两个断言都会失败。
 *   实现后（CumulativePayrollInput 加字段 + calculateCumulativePayroll 透传）GREEN。
 */
import assert from "node:assert/strict";
import {
  calculateCumulativePayroll,
  buildTaxCumulativeReceipt,
} from "../lib/domain/tax-cumulative.ts";
import type { CumulativeTaxDetail } from "../lib/domain/tax-cumulative.ts";

/** 纯 TS 用的 mock detail，不走 Python */
const mockDetail: CumulativeTaxDetail = {
  grossCum: 15000,
  basicDeductionCum: 5000,
  socialCum: 1500,
  fundCum: 500,
  specialCum: 0,
  taxableIncomeCum: 8000,
  bracketRate: 0.03,
  quickDeduction: 0,
  taxDueCum: 240,
  taxWithheldPriorCum: 0,
  formula: "(15000-5000-1500-500)×3%-0=240",
  taxConfigVersion: "2026-standard-v1",
};

export const taxCumulativeF2TestPromise = (async () => {
  // ── F2-T1: calculateCumulativePayroll 传入 settlementStatus / source → 回执正确 ──
  // RED 证明: 实现前 receipt.basis.settlementStatus === "draft"（硬编码），
  //           source === []（硬编码），两处断言均失败。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r1 = calculateCumulativePayroll({
    employeeName: "张三",
    grossPay: 15000,
    socialInsurance: 1500,
    housingFund: 500,
    specialDeduction: 0,
    monthsEmployed: 6,
    asOf: "2026-06",
    settlementStatus: "closed",
    source: [{ file: "payroll-2026-06.xlsx", recordCount: 1 }],
  } as unknown as Parameters<typeof calculateCumulativePayroll>[0]);

  assert.equal(
    r1.receipt.basis.settlementStatus,
    "closed",
    "F2-T1 FAIL: settlementStatus 应为 closed（需在 calculateCumulativePayroll 中透传 input.settlementStatus）"
  );
  assert.equal(r1.receipt.source.length, 1, "F2-T1 FAIL: source 应有 1 项");
  assert.equal(
    r1.receipt.source[0].file,
    "payroll-2026-06.xlsx",
    "F2-T1 FAIL: source[0].file"
  );
  assert.equal(
    r1.receipt.source[0].recordCount,
    1,
    "F2-T1 FAIL: source[0].recordCount"
  );
  assert.equal(r1.receipt.basis.asOf, "2026-06", "F2-T1 FAIL: asOf");

  // ── F2-T2: 默认 settlementStatus 保持 "draft"，默认 source 为空（不破坏现有行为）──
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r2 = calculateCumulativePayroll({
    employeeName: "李四",
    grossPay: 10000,
    socialInsurance: 1000,
    housingFund: 500,
    specialDeduction: 0,
    monthsEmployed: 1,
    asOf: "2026-06",
  } as unknown as Parameters<typeof calculateCumulativePayroll>[0]);
  assert.equal(
    r2.receipt.basis.settlementStatus,
    "draft",
    "F2-T2 FAIL: 默认应为 draft（向后兼容）"
  );
  assert.deepEqual(r2.receipt.source, [], "F2-T2 FAIL: 默认 source 应为空数组");

  // ── F2-T3: buildTaxCumulativeReceipt 多来源 source（纯 TS，无 Python）──
  const r3 = buildTaxCumulativeReceipt(mockDetail, {
    taxCurrent: 240,
    asOf: "2026-06",
    settlementStatus: "draft",
    source: [
      { file: "payroll-2026-06.xlsx", ref: "B2", recordCount: 1 },
      { ref: "prior-ytd", recordCount: 5 },
    ],
  });
  assert.equal(r3.source.length, 2, "F2-T3 FAIL: 2 来源");
  assert.equal(r3.source[1].ref, "prior-ytd", "F2-T3 FAIL: source[1].ref");
  assert.equal(r3.source[1].recordCount, 5, "F2-T3 FAIL: source[1].recordCount");

  // ── F2-T4: caliberVersion 来自 detail.taxConfigVersion ──
  assert.equal(
    r3.basis.caliberVersion,
    "2026-standard-v1",
    "F2-T4 FAIL: caliberVersion 应来自 taxConfigVersion"
  );

  console.log("tax-cumulative-f2: all 4 checks passed ✓");
})();
