import assert from "node:assert/strict";
import {
  receivablesTurnover,
  inventoryTurnover,
  totalAssetTurnover,
  roe,
  equityMultiplier,
  dupont,
  periodOverPeriod,
} from "../lib/domain/financial-ratios";

// P2 经营分析 v2:新增比率函数的确定性单测。
// 数据基于真实财报量级(都森 2025.12 档);不含客户实名信息。
export const financialRatiosV2TestPromise = (async () => {
  const { ok } = assert;
  const approx = (r: ReturnType<typeof receivablesTurnover>, expected: number, eps = 1e-6) =>
    r.ok && Math.abs(r.value - expected) < eps;

  // ─── 营运能力 ─────────────────────────────────────────────

  // 应收账款周转率 = 营收 / 平均应收
  ok(approx(receivablesTurnover(1200000, 200000), 6), "recTurn: 1200000/200000=6");
  ok(!receivablesTurnover(1200000, 0).ok, "recTurn: 平均应收=0 不可算");
  ok(!receivablesTurnover(1200000, -1).ok, "recTurn: 平均应收<0 不可算");
  ok(!receivablesTurnover(Number.NaN, 200000).ok, "recTurn: NaN营收 不可算");

  // 存货周转率 = 营业成本 / 平均存货
  ok(approx(inventoryTurnover(800000, 100000), 8), "invTurn: 800000/100000=8");
  ok(!inventoryTurnover(800000, 0).ok, "invTurn: 平均存货=0 不可算");
  ok(!inventoryTurnover(Number.NaN, 100000).ok, "invTurn: NaN成本 不可算");

  // 总资产周转率 = 营收 / 平均总资产
  ok(approx(totalAssetTurnover(3000000, 5000000), 0.6), "taTurn: 3000000/5000000=0.6");
  ok(!totalAssetTurnover(3000000, 0).ok, "taTurn: 平均总资产=0 不可算");
  ok(!totalAssetTurnover(3000000, -100).ok, "taTurn: 平均总资产<0 不可算");

  // ─── 盈利补充(ROE/杜邦) ──────────────────────────────────

  // ROE = 净利 / 平均净资产
  ok(approx(roe(500000, 2000000), 0.25), "roe: 500000/2000000=0.25");
  ok(!roe(500000, 0).ok, "roe: 平均净资产=0 不可算");
  ok(!roe(Number.NaN, 2000000).ok, "roe: NaN净利 不可算");

  // 权益乘数 = 总资产 / 净资产
  ok(approx(equityMultiplier(10000000, 4000000), 2.5), "em: 10000000/4000000=2.5");
  ok(!equityMultiplier(10000000, 0).ok, "em: 净资产=0 不可算");
  ok(!equityMultiplier(10000000, -100).ok, "em: 净资产<0 不可算");

  // 杜邦三因子:ROE=净利率×周转率×杠杆
  // 净利润=500000,营收=5000000,平均总资产=10000000,总资产=10000000,净资产=4000000
  // 净利率=0.1,周转率=0.5,杠杆=2.5 → ROE=0.125
  const dp = dupont({
    netProfit: 500000,
    revenue: 5000000,
    avgTotalAssets: 10000000,
    totalAssets: 10000000,
    equity: 4000000,
  });
  ok(dp.ok, "dupont: 应可算");
  if (dp.ok) {
    ok(Math.abs(dp.netMarginFactor - 0.1) < 1e-9, "dupont: 净利率=0.1");
    ok(Math.abs(dp.assetTurnoverFactor - 0.5) < 1e-9, "dupont: 周转率=0.5");
    ok(Math.abs(dp.equityMultiplierFactor - 2.5) < 1e-9, "dupont: 杠杆=2.5");
    ok(Math.abs(dp.roe - 0.125) < 1e-9, "dupont: ROE=0.125");
  }

  // 杜邦:净资产=0 时不可算
  const dpBad = dupont({ netProfit: 100, revenue: 1000, avgTotalAssets: 500, totalAssets: 500, equity: 0 });
  ok(!dpBad.ok, "dupont: 净资产=0 应不可算");

  // 杜邦:营收=0 时不可算
  const dpBadRev = dupont({ netProfit: 100, revenue: 0, avgTotalAssets: 500, totalAssets: 500, equity: 200 });
  ok(!dpBadRev.ok, "dupont: 营收=0 应不可算");

  // ─── 发展能力(periodOverPeriod 已有旧测试,补增长率语义测试) ──

  // 同比增长率:同别名 yoyGrowthRate
  const { yoyGrowthRate } = await import("../lib/domain/financial-ratios");
  const yoy = yoyGrowthRate(1320000, 1200000);
  ok(yoy.ok && Math.abs(yoy.value - 0.1) < 1e-9, "yoy: 增长10%");

  const yoyNeg = yoyGrowthRate(800000, -100000);
  ok(!yoyNeg.ok, "yoy: 上期亏损(<0)不可算");

  console.log("financial-ratios-v2 tests passed");
})();
