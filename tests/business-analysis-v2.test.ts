import assert from "node:assert/strict";
import { buildBusinessAnalysisV2, renderAnalysisMarkdownV2 } from "../lib/domain/business-analysis";
import type { CanonicalBalanceSheet, CanonicalIncomeStatement } from "../lib/domain/canonical-financials";

// P2 经营分析 v2:四能力×三基准报告构建。
// Fixture 数据基于都森 2025.12 报表量级(已脱敏)。
export const businessAnalysisV2TestPromise = (async () => {
  const { ok, equal } = assert;

  // ─── Fixture:都森 2025.12(已归一到元,脱敏) ───
  const bs: CanonicalBalanceSheet = {
    cash:               500000,
    receivables:        800000,
    inventory:          400000,
    currentAssets:     2000000,
    totalAssets:       5000000,
    shortTermBorrowing: 200000,
    payables:           300000,
    currentLiabilities: 900000,
    totalLiabilities:  2000000,
    equity:            3000000,
    prior: {
      cash:               480000,
      receivables:        750000,
      inventory:          380000,
      currentAssets:     1900000,
      totalAssets:       4800000,
      currentLiabilities: 820000,
      totalLiabilities:  1900000,
      equity:            2900000,
    },
  };

  const is: CanonicalIncomeStatement = {
    revenue:        3000000,
    cost:           2100000,
    sellingExpense: 150000,
    adminExpense:   200000,
    rdExpense:      50000,
    financeExpense: 20000,
    netProfit:      480000,
    prior: {
      revenue:        2800000,
      cost:           1960000,
      sellingExpense: 140000,
      adminExpense:   190000,
      rdExpense:      45000,
      financeExpense: 18000,
      netProfit:      447000,
    },
  };

  const report = buildBusinessAnalysisV2({
    bs,
    is,
    meta: { asOf: "2025-12-31", source: "会小企01/02", caliber: "期末数·未审计", status: "草稿" },
  });

  // ─── 1. 四个 section 都存在 ───
  const titles = report.sections.map(s => s.title);
  ok(titles.includes("偿债能力"), "应有偿债能力");
  ok(titles.includes("盈利能力"), "应有盈利能力");
  ok(titles.includes("营运能力"), "应有营运能力");
  ok(titles.includes("发展能力"), "应有发展能力");

  function getMetric(sectionTitle: string, metricName: string) {
    const sec = report.sections.find(s => s.title === sectionTitle);
    return sec?.metrics.find(m => m.name === metricName);
  }

  // ─── 2. 偿债能力 ───
  const dtar = getMetric("偿债能力", "资产负债率");
  ok(dtar, "应有资产负债率");
  // 总负债/总资产 = 2000000/5000000 = 40%
  ok(dtar?.columns.current.includes("40%"), `资产负债率本期应≈40%,实际:${dtar?.columns.current}`);

  const crRatio = getMetric("偿债能力", "流动比率");
  ok(crRatio, "应有流动比率");
  // 2000000/900000 ≈ 2.22
  ok(crRatio?.columns.current.includes("2.22"), `流动比率≈2.22倍,实际:${crRatio?.columns.current}`);

  // ─── 3. 盈利能力 ───
  const gm = getMetric("盈利能力", "毛利率");
  // (3000000-2100000)/3000000 = 30%
  ok(gm?.columns.current.includes("30%"), `毛利率应=30%,实际:${gm?.columns.current}`);

  const nm = getMetric("盈利能力", "净利率");
  // 480000/3000000 = 16%
  ok(nm?.columns.current.includes("16%"), `净利率应=16%,实际:${nm?.columns.current}`);

  // 同比毛利率:上年 (2800000-1960000)/2800000 = 30%, 本年 30% → 同比≈0%
  ok(gm?.columns.yoy !== "无基准", "毛利率应有同比(非「无基准」)");

  // ROE
  const roeM = getMetric("盈利能力", "ROE");
  ok(roeM, "应有ROE");
  // 净利480000 / 平均净资产(3000000+2900000)/2=2950000 ≈ 16.27%
  ok(roeM?.columns.current.includes("%"), "ROE应有百分比");

  // 杜邦
  const dpM = getMetric("盈利能力", "杜邦ROE");
  ok(dpM, "应有杜邦ROE");
  ok(dpM?.columns.current.includes("净利率") && dpM?.columns.current.includes("周转"), "杜邦应包含分解信息");

  // ─── 4. 营运能力 ───
  const recTurn = getMetric("营运能力", "应收账款周转率");
  ok(recTurn, "应有应收账款周转率");
  // 营收/平均应收 = 3000000/((800000+750000)/2) = 3000000/775000 ≈ 3.87次
  ok(recTurn?.columns.current.includes("3.87") || recTurn?.columns.current.includes("次"), "应收周转率应有数值");

  const invTurn = getMetric("营运能力", "存货周转率");
  ok(invTurn, "应有存货周转率");
  // 成本/平均存货 = 2100000/((400000+380000)/2) = 2100000/390000 ≈ 5.38次
  ok(invTurn?.columns.current.includes("5.38") || invTurn?.columns.current.includes("次"), "存货周转率应有数值");

  const taTurn = getMetric("营运能力", "总资产周转率");
  ok(taTurn, "应有总资产周转率");

  // ─── 5. 发展能力 ───
  const revGrowth = getMetric("发展能力", "营业收入增长率");
  ok(revGrowth, "应有营业收入增长率");
  // (3000000-2800000)/2800000 ≈ 7.14%
  ok(revGrowth?.columns.yoy.includes("7.14") || revGrowth?.columns.yoy.includes("+"), "营收增长率同比应含正增长");

  const profitGrowth = getMetric("发展能力", "净利润增长率");
  ok(profitGrowth, "应有净利润增长率");
  // (480000-447000)/447000 ≈ 7.38%
  ok(profitGrowth?.columns.yoy.includes("7.38") || profitGrowth?.columns.yoy.includes("+"), "净利增长率同比应含正增长");

  // ─── 6. 无预算时预算列为「无基准」 ───
  ok(gm?.columns.budget === "无基准", `无预算时毛利率预算列应=无基准,实际:${gm?.columns.budget}`);

  // ─── 7. 带预算测试 ───
  const budget = {
    revenue:   3200000, // 预算营收 320万
    cost:      2200000,
    netProfit: 400000,
  };
  const withBudget = buildBusinessAnalysisV2({
    bs,
    is,
    budget,
    meta: { asOf: "2025-12-31", status: "草稿" },
  });
  const gmBudget = withBudget.sections.find(s => s.title === "盈利能力")
    ?.metrics.find(m => m.name === "毛利率")?.columns.budget;
  ok(gmBudget !== undefined && gmBudget !== "无基准", `有预算时毛利率预算列不应为无基准,实际:${gmBudget}`);

  // 发展能力:收入 vs 预算 3200000 → (3000000-3200000)/3200000 ≈ -6.25%
  const revBudget = withBudget.sections.find(s => s.title === "发展能力")
    ?.metrics.find(m => m.name === "营业收入增长率")?.columns.budget;
  ok(revBudget && revBudget.includes("-"), `收入低于预算应为负,实际:${revBudget}`);

  // ─── 8. 无期初/无同比时发展能力同比为「无基准」 ───
  const noHistBS: CanonicalBalanceSheet = { ...bs, prior: undefined };
  const noHistIS: CanonicalIncomeStatement = { ...is, prior: undefined };
  const noHist = buildBusinessAnalysisV2({ bs: noHistBS, is: noHistIS, meta: { asOf: "2025-12-31" } });
  const noHistRevGrowth = noHist.sections.find(s => s.title === "发展能力")
    ?.metrics.find(m => m.name === "营业收入增长率")?.columns.yoy;
  equal(noHistRevGrowth, "无基准", `无同比基准时营收增长应=「无基准」,实际:${noHistRevGrowth}`);

  // ─── 9. 数据信任链脚注 ───
  ok(report.footnotes.some(f => f.includes("2025-12-31")), "脚注应含截止日");
  ok(report.footnotes.some(f => f.includes("草稿")), "脚注应含结算状态");
  ok(report.asOf === "2025-12-31", "报告asOf透传");

  // ─── 10. Markdown 渲染 ───
  const md = renderAnalysisMarkdownV2(report);
  ok(md.includes("# 经营分析表 v2"), "MD含标题");
  ok(md.includes("偿债能力"), "MD含偿债能力");
  ok(md.includes("盈利能力"), "MD含盈利能力");
  ok(md.includes("营运能力"), "MD含营运能力");
  ok(md.includes("发展能力"), "MD含发展能力");
  ok(md.includes("本期") && md.includes("同比") && md.includes("预算对比"), "MD含三基准表头");
  ok(md.includes("数据信任链"), "MD含数据信任链");

  // ─── 11. 分母≤0 时不可算(资产负债率) ───
  const zeroBs: CanonicalBalanceSheet = {
    ...bs,
    totalAssets: 0,
    prior: undefined,
  };
  const zeroReport = buildBusinessAnalysisV2({ bs: zeroBs, is, meta: {} });
  const zeroDtar = zeroReport.sections.find(s => s.title === "偿债能力")
    ?.metrics.find(m => m.name === "资产负债率")?.columns.current;
  ok(zeroDtar?.includes("不可算"), `总资产=0时资产负债率应不可算,实际:${zeroDtar}`);

  console.log("business-analysis-v2 tests passed");
})();
