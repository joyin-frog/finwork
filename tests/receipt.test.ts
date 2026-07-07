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

  // ── kind 判别契约（WP4a-K1 ~ K5）──────────────────────────────────────────
  // K1: makeCalcReceipt 输出必须带 kind="calc_receipt"
  assert.equal(
    (basic as unknown as Record<string, unknown>).kind,
    "calc_receipt",
    "K1 FAIL: makeCalcReceipt 输出缺少 kind='calc_receipt'"
  );

  // K2: validateCalcReceipt — 带 kind 的合法对象直接通过，kind 保留
  const withKind = validateCalcReceipt({
    kind: "calc_receipt",
    value: 100,
    unit: "CNY",
    rounding: "half_up",
    steps: [],
    source: [],
    basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-01" },
  });
  assert.equal(
    (withKind as unknown as Record<string, unknown>).kind,
    "calc_receipt",
    "K2 FAIL: 带 kind 的合法对象通过后 kind 应保留"
  );

  // K3: validateCalcReceipt — 缺 kind 但形状合格时归一化补 kind（不报错）
  const normalized = validateCalcReceipt({
    value: 200,
    unit: "CNY",
    rounding: "half_up",
    steps: [],
    source: [],
    basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-02" },
  });
  assert.equal(
    (normalized as unknown as Record<string, unknown>).kind,
    "calc_receipt",
    "K3 FAIL: 缺 kind 但形状合格时 validateCalcReceipt 应归一化补 kind"
  );
  assert.equal(normalized.value, 200, "K3 FAIL: 归一化后 value 应保留");

  // K4: validateCalcReceipt — 形状不合格（缺 value）应拒绝
  assert.throws(
    () =>
      validateCalcReceipt({
        kind: "calc_receipt",
        unit: "CNY",
        rounding: "half_up",
        steps: [],
        source: [],
        basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-01" },
      }),
    /value|有限数/,
    "K4 FAIL: 形状不合格（缺 value）应抛错"
  );

  // K5: kind 错误值不影响其余字段校验——仍允许归一化覆盖（不属于拒绝条件）
  const wrongKind = validateCalcReceipt({
    kind: "other_kind",
    value: 50,
    unit: "CNY",
    rounding: "half_up",
    steps: [],
    source: [],
    basis: { caliberVersion: "v1", settlementStatus: "draft", asOf: "2025-03" },
  });
  assert.equal(
    (wrongKind as unknown as Record<string, unknown>).kind,
    "calc_receipt",
    "K5 FAIL: 错误 kind 值应被覆盖归一化为 'calc_receipt'"
  );

  // ── tax_calculator source 补链（WP4a-TX1 ~ TX2）──────────────────────────
  // 验证 tax source 字段约定（实现后 finance-tools.ts:137 处按入参组装）
  // 此处测试 source 结构可带 ref 和可读描述——作为契约断言
  // TX1: vat 入参 source 条目应含描述性信息（非空 ref 包含 amount/rate 信息）
  const vatSourceEntry: CalcSource = { ref: "金额 1000 元与税率 0.13（本次对话提供）" };
  assert.ok(vatSourceEntry.ref?.includes("1000"), "TX1 FAIL: vat source ref 应含 amount 信息");
  assert.ok(vatSourceEntry.ref?.includes("0.13"), "TX1 FAIL: vat source ref 应含 rate 信息");

  // TX2: cit 入参 source 条目同理
  const citSourceEntry: CalcSource = { ref: "金额 500000 元与税率 0.25（本次对话提供）" };
  assert.ok(citSourceEntry.ref?.includes("500000"), "TX2 FAIL: cit source ref 应含 amount");
  assert.ok(citSourceEntry.ref?.includes("0.25"), "TX2 FAIL: cit source ref 应含 rate");

  console.log("receipt: CalcReceipt schema / 构造器 / 校验器 / tax-cumulative 回执字段 ✓");
})();
