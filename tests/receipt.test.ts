import assert from "node:assert/strict";
import { makeCalcReceipt, validateCalcReceipt } from "../lib/domain/receipt.ts";
import type { CalcReceipt, CalcStep, CalcSource } from "../lib/domain/receipt.ts";
import { buildTaxCumulativeReceipt } from "../lib/domain/tax-cumulative.ts";
import type { CumulativeTaxDetail } from "../lib/domain/tax-cumulative.ts";

// CalcReceipt schema / 构造器 / 校验器 + tax-cumulative 回执字段断言
export const receiptTestPromise = (async () => {
  // ── makeCalcReceipt 构造 ────────────────────────────────────────────────
  const basic: CalcReceipt = makeCalcReceipt({
    value: 240,
    steps: [],
    source: [],
    basis: {
      caliberVersion: "2024-01",
      settlementStatus: "draft",
      asOf: "2025-01",
    },
  });
  assert.equal(basic.unit, "CNY", "T1 FAIL: unit 必须是 CNY");
  assert.equal(basic.rounding, "half_up", "T1 FAIL: 默认舍入应是 half_up");
  assert.equal(basic.value, 240, "T1 FAIL: value");
  assert.deepEqual(basic.steps, [], "T1 FAIL: steps 空数组");
  assert.deepEqual(basic.source, [], "T1 FAIL: source 空数组");
  assert.equal(basic.basis.caliberVersion, "2024-01", "T1 FAIL: caliberVersion");
  assert.equal(basic.basis.settlementStatus, "draft", "T1 FAIL: settlementStatus");
  assert.equal(basic.basis.asOf, "2025-01", "T1 FAIL: asOf");

  // 显式 bankers 舍入
  const bankersReceipt = makeCalcReceipt({
    value: 100,
    basis: { caliberVersion: "v1", settlementStatus: "closed", asOf: "2024-12" },
    rounding: "bankers",
  });
  assert.equal(bankersReceipt.rounding, "bankers", "T2 FAIL: 显式 bankers 应保留");

  // caveats 可选
  const withCaveats = makeCalcReceipt({
    value: 0,
    basis: { caliberVersion: "v1", settlementStatus: "filed", asOf: "2025-03" },
    caveats: ["降级：税率以最新口径估算"],
  });
  assert.deepEqual(withCaveats.caveats, ["降级：税率以最新口径估算"], "T3 FAIL: caveats");

  // ── validateCalcReceipt 校验 ────────────────────────────────────────────
  assert.throws(
    () => validateCalcReceipt({ value: 100, unit: "USD", rounding: "half_up", steps: [], source: [], basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-01" } }),
    /CNY/,
    'T4 FAIL: unit="USD" 应抛 CNY 错误'
  );
  assert.throws(
    () => validateCalcReceipt({ value: 100, unit: "CNY", rounding: "floor", steps: [], source: [], basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-01" } }),
    /rounding/,
    "T5 FAIL: 非法 rounding 应抛错"
  );
  assert.throws(
    () => validateCalcReceipt({ value: Number.NaN, unit: "CNY", rounding: "half_up", steps: [], source: [], basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-01" } }),
    /有限数/,
    "T6 FAIL: NaN value 应抛错"
  );
  assert.throws(
    () => validateCalcReceipt({ value: 100, unit: "CNY", rounding: "half_up", steps: [], source: [], basis: { caliberVersion: "v1", settlementStatus: "pending", asOf: "2025-01" } }),
    /settlementStatus/,
    'T7 FAIL: 非法 settlementStatus="pending" 应抛错'
  );
  assert.throws(
    () => validateCalcReceipt(null),
    /对象/,
    "T8 FAIL: null 应抛对象错误"
  );
  assert.throws(
    () => validateCalcReceipt({ value: 100, unit: "CNY", rounding: "half_up", steps: [], source: [], basis: null }),
    /basis/,
    "T9 FAIL: basis=null 应抛错"
  );

  // ── tax-cumulative 回执字段（buildTaxCumulativeReceipt）──────────────────
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
    taxConfigVersion: "2024-01",
  };

  const txReceipt = buildTaxCumulativeReceipt(mockDetail, {
    taxCurrent: 240,
    asOf: "2025-01",
    settlementStatus: "draft",
  });

  assert.equal(txReceipt.unit, "CNY", "T10 FAIL: tx receipt unit");
  assert.equal(txReceipt.rounding, "half_up", "T10 FAIL: tx receipt rounding");
  assert.equal(txReceipt.value, 240, "T10 FAIL: tx receipt value = taxCurrent");
  assert.equal(txReceipt.basis.caliberVersion, "2024-01", "T10 FAIL: caliberVersion from taxConfigVersion");
  assert.equal(txReceipt.basis.settlementStatus, "draft", "T10 FAIL: settlementStatus");
  assert.equal(txReceipt.basis.asOf, "2025-01", "T10 FAIL: asOf");
  assert.ok(txReceipt.steps.length >= 1, "T10 FAIL: steps 不能为空");
  // 最后一步小计=taxCurrent
  const lastStep = txReceipt.steps[txReceipt.steps.length - 1];
  assert.equal(lastStep.subtotal, 240, "T10 FAIL: 最后一步小计=taxCurrent");
  // source 默认空
  assert.deepEqual(txReceipt.source, [], "T10 FAIL: source 默认空数组");

  // settlementStatus filed
  const filedReceipt = buildTaxCumulativeReceipt(mockDetail, {
    taxCurrent: 240,
    asOf: "2024-12",
    settlementStatus: "filed",
  });
  assert.equal(filedReceipt.basis.settlementStatus, "filed", "T11 FAIL: filed 状态应传透");

  // source 自定义
  const withSource: CalcSource[] = [{ file: "payroll-2025-01.xlsx", ref: "B2", recordCount: 1 }];
  const sourceReceipt = buildTaxCumulativeReceipt(mockDetail, {
    taxCurrent: 240,
    asOf: "2025-01",
    source: withSource,
  });
  assert.deepEqual(sourceReceipt.source, withSource, "T12 FAIL: 自定义 source 应透传");

  console.log("receipt: CalcReceipt schema / 构造器 / 校验器 / tax-cumulative 回执字段 ✓");
})();
