// 财务死公式:确定性比率函数(红线 2 数值正确性)。
// 分母≤0 等边界返回明确"不可算"信号,不裸除 —— 由调用方定性表述(红线 4「我不知道」)。
// 内部不舍入,返回全精度小数;展示侧再按口径 ×100%(资产负债率/毛利率/环比)或保留倍数(流动比率)。

export type RatioResult = { ok: true; value: number } | { ok: false; reason: string };

function divide(numerator: number, denominator: number, denomLabel: string): RatioResult {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return { ok: false, reason: "含非有限数,不可算" };
  }
  if (denominator <= 0) {
    return { ok: false, reason: `${denomLabel}≤0,比率不可算(需定性说明)` };
  }
  return { ok: true, value: numerator / denominator };
}

/** 资产负债率 = 总负债 / 总资产(展示 ×100%)。 */
export function debtToAssetRatio(totalLiabilities: number, totalAssets: number): RatioResult {
  return divide(totalLiabilities, totalAssets, "总资产");
}

/** 流动比率 = 流动资产 / 流动负债(展示为倍数)。 */
export function currentRatio(currentAssets: number, currentLiabilities: number): RatioResult {
  return divide(currentAssets, currentLiabilities, "流动负债");
}

/** 毛利率 = (营业收入 − 营业成本) / 营业收入(展示 ×100%)。 */
export function grossMargin(revenue: number, cost: number): RatioResult {
  if (!Number.isFinite(cost)) return { ok: false, reason: "含非有限数,不可算" };
  return divide(revenue - cost, revenue, "营业收入");
}

/** 环比 = (本期 − 上期) / 上期。上期≤0(含亏损)不可算,改定性(如扭亏)(展示 ×100%)。 */
export function periodOverPeriod(current: number, prior: number): RatioResult {
  if (!Number.isFinite(current) || !Number.isFinite(prior)) {
    return { ok: false, reason: "含非有限数,不可算" };
  }
  if (prior <= 0) {
    return { ok: false, reason: "上期≤0,环比不可算(可能扭亏/不可比,需定性)" };
  }
  return { ok: true, value: (current - prior) / prior };
}

/** 净利率 = 净利润 / 营业收入(展示 ×100%)。 */
export function netMargin(netProfit: number, revenue: number): RatioResult {
  if (!Number.isFinite(netProfit)) return { ok: false, reason: "含非有限数,不可算" };
  return divide(netProfit, revenue, "营业收入");
}

/** 通用带护栏比率 = 分子 / 分母(分母≤0 不可算)。供占比、净利率类复用,统一边界处理。 */
export function ratio(numerator: number, denominator: number, denomLabel: string): RatioResult {
  return divide(numerator, denominator, denomLabel);
}

// ─────────── 营运能力 ───────────

/**
 * 应收账款周转率 = 营业收入 / 平均应收账款。
 * 平均应收 = (期初+期末)/2;只有期末时用 periodEndOnly=true,口径偏差由调用方在脚注标注(红线 3)。
 */
export function receivablesTurnover(
  revenue: number,
  avgReceivables: number,
): RatioResult {
  if (!Number.isFinite(revenue)) return { ok: false, reason: "营业收入含非有限数,不可算" };
  return divide(revenue, avgReceivables, "平均应收账款");
}

/**
 * 存货周转率 = 营业成本 / 平均存货。
 * 平均存货 = (期初+期末)/2;只有期末时同上标脚注。
 */
export function inventoryTurnover(
  costOfGoods: number,
  avgInventory: number,
): RatioResult {
  if (!Number.isFinite(costOfGoods)) return { ok: false, reason: "营业成本含非有限数,不可算" };
  return divide(costOfGoods, avgInventory, "平均存货");
}

/**
 * 总资产周转率 = 营业收入 / 平均总资产(展示为倍/次)。
 */
export function totalAssetTurnover(
  revenue: number,
  avgTotalAssets: number,
): RatioResult {
  if (!Number.isFinite(revenue)) return { ok: false, reason: "营业收入含非有限数,不可算" };
  return divide(revenue, avgTotalAssets, "平均总资产");
}

// ─────────── 发展能力 ───────────

/**
 * 同比增长率(发展能力专用别名)= periodOverPeriod。
 * 上期≤0 不可算(如亏损→扭亏场景,需定性)。
 */
export { periodOverPeriod as yoyGrowthRate };

// ─────────── 盈利补充(ROE / 杜邦) ───────────

/**
 * ROE = 净利润 / 平均净资产(展示 ×100%)。
 * 平均净资产 = (期初净资产 + 期末净资产) / 2;只有期末时用期末近似。
 */
export function roe(
  netProfit: number,
  avgEquity: number,
): RatioResult {
  if (!Number.isFinite(netProfit)) return { ok: false, reason: "净利润含非有限数,不可算" };
  return divide(netProfit, avgEquity, "平均净资产");
}

/**
 * 权益乘数 = 总资产 / 净资产(杜邦三因子之一)。
 */
export function equityMultiplier(
  totalAssets: number,
  equity: number,
): RatioResult {
  if (!Number.isFinite(totalAssets)) return { ok: false, reason: "总资产含非有限数,不可算" };
  return divide(totalAssets, equity, "净资产");
}

/**
 * 杜邦三因子分解:ROE = 净利率 × 总资产周转率 × 权益乘数。
 * 任一因子不可算时整体不可算,分别返回各因子和合成 ROE。
 */
export type DupontResult =
  | {
      ok: true;
      netMarginFactor: number;       // 净利润 / 营业收入
      assetTurnoverFactor: number;   // 营业收入 / 平均总资产
      equityMultiplierFactor: number;// 总资产 / 净资产
      roe: number;                   // 三因子之积
    }
  | { ok: false; reason: string };

export function dupont(params: {
  netProfit: number;
  revenue: number;
  avgTotalAssets: number;
  totalAssets: number;     // 期末总资产(用于权益乘数)
  equity: number;          // 期末净资产
}): DupontResult {
  const nm = netMargin(params.netProfit, params.revenue);
  if (!nm.ok) return { ok: false, reason: `净利率不可算:${nm.reason}` };

  const tat = totalAssetTurnover(params.revenue, params.avgTotalAssets);
  if (!tat.ok) return { ok: false, reason: `总资产周转率不可算:${tat.reason}` };

  const em = equityMultiplier(params.totalAssets, params.equity);
  if (!em.ok) return { ok: false, reason: `权益乘数不可算:${em.reason}` };

  return {
    ok: true,
    netMarginFactor: nm.value,
    assetTurnoverFactor: tat.value,
    equityMultiplierFactor: em.value,
    roe: nm.value * tat.value * em.value,
  };
}
