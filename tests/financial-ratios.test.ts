import assert from "node:assert/strict";
import { debtToAssetRatio, currentRatio, grossMargin, periodOverPeriod, netMargin, ratio } from "../lib/domain/financial-ratios";

// 财务死公式:确定性比率 + 分母≤0 不可算信号(不裸除)。
export const financialRatiosTestPromise = (async () => {
  const { ok } = assert;
  const approx = (r: ReturnType<typeof debtToAssetRatio>, v: number) => r.ok && Math.abs(r.value - v) < 1e-9;

  // 资产负债率 = 总负债/总资产
  ok(approx(debtToAssetRatio(60, 100), 0.6), "T1 FAIL: 资产负债率 60/100=0.6");
  ok(!debtToAssetRatio(60, 0).ok, "T2 FAIL: 总资产=0 应不可算");

  // 流动比率 = 流动资产/流动负债
  ok(approx(currentRatio(150, 100), 1.5), "T3 FAIL: 流动比率 150/100=1.5");
  ok(!currentRatio(150, 0).ok, "T4 FAIL: 流动负债=0 应不可算");
  ok(!currentRatio(150, -10).ok, "T5 FAIL: 流动负债<0 应不可算");

  // 毛利率 = (营收-成本)/营收
  ok(approx(grossMargin(1000, 650), 0.35), "T6 FAIL: 毛利率 (1000-650)/1000=0.35");
  ok(!grossMargin(0, 0).ok, "T7 FAIL: 营收=0 应不可算");

  // 环比 = (本期-上期)/上期;上期≤0 不可算
  ok(approx(periodOverPeriod(112, 100), 0.12), "T8 FAIL: 环比 (112-100)/100=0.12");
  ok(!periodOverPeriod(3, 0).ok, "T9 FAIL: 上期=0 应不可算");
  ok(!periodOverPeriod(3, -5).ok, "T10 FAIL: 上期<0(亏损)应不可算→定性");

  // 非有限数
  ok(!debtToAssetRatio(Number.NaN, 100).ok, "T11 FAIL: NaN 应不可算");

  // 净利率 = 净利润/营收;通用占比 ratio
  ok(approx(netMargin(120, 1000), 0.12), "T12 FAIL: 净利率 120/1000=0.12");
  ok(!netMargin(120, 0).ok, "T13 FAIL: 营收=0 净利率不可算");
  ok(approx(ratio(400, 1000, "总资产"), 0.4), "T14 FAIL: 占比 400/1000=0.4");
  ok(!ratio(400, 0, "总资产").ok, "T15 FAIL: 分母0 占比不可算");

  console.log("financial-ratios tests passed");
})();
