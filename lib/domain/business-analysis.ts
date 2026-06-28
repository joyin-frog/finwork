// 经营分析表生成(确定性):吃结构化财报 → 调死公式算比率 → 结构化报表 + MD 渲染。
// v2:四能力 × 三基准(本期/同比/预算);支持 canonical 三表;单位归一到"元"。
// 数字全部走 financial-ratios 确定性函数,不心算;不可算的比率显式标注(红线 2/4);
// 报表带数据信任链脚注(红线 3);只给指标+口径,不替老板下经营结论(红线 6)。
import {
  debtToAssetRatio,
  currentRatio,
  grossMargin,
  netMargin,
  periodOverPeriod,
  ratio,
  receivablesTurnover,
  inventoryTurnover,
  totalAssetTurnover,
  roe,
  dupont,
  type RatioResult,
} from "./financial-ratios";
import type {
  CanonicalBalanceSheet,
  CanonicalIncomeStatement,
} from "./canonical-financials";

const round2 = (v: number) => Math.round(v * 100) / 100;

// ─────────── 报告元信息 ───────────

export type ReportMeta = {
  asOf?: string;     // 数据截止日
  source?: string;   // 来源(哪张表)
  caliber?: string;  // 口径(期末数/未审计等)
  status?: "草稿" | "已确认" | "已锁定"; // 结算状态(红线 3)
};

// ─────────── v2 核心类型 ───────────

/** 三基准列(缺基准时标"无基准",不补数) */
export type BenchmarkColumns = {
  /** 本期数值展示 */
  current: string;
  /** 同比展示("无基准" 若无先期数) */
  yoy: string;
  /** 预算对比展示("无基准" 若无预算) */
  budget: string;
  /** 同业参考(v2 后置;MVP 不做) */
  industry?: string;
};

export type MetricV2 = {
  name: string;
  columns: BenchmarkColumns;
  basis: string; // 计算口径
};

export type SectionV2 = {
  title: string;
  metrics: MetricV2[];
};

/** v2 经营分析报告 */
export type AnalysisReportV2 = {
  sections: SectionV2[];
  footnotes: string[];
  asOf: string;
  status: string; // 结算状态透传
};

// ─────────── 预算传入类型 ───────────

/**
 * 预算数(单位由调用方归一到"元"后传入;red line 2/3)。
 */
export type BudgetData = {
  revenue?: number;
  cost?: number;
  netProfit?: number;
  totalAssets?: number;
  equity?: number;
};

// ─────────── 格式化辅助 ───────────

const asPct = (r: RatioResult) => (r.ok ? `${round2(r.value * 100)}%` : `不可算(${r.reason})`);
const asTimes = (r: RatioResult) => (r.ok ? `${round2(r.value)} 倍/次` : `不可算(${r.reason})`);
const asPctTimes = (r: RatioResult) => (r.ok ? `${round2(r.value * 100)}%` : `不可算(${r.reason})`);

const NO_BASELINE = "无基准";

/**
 * 格式化同比结果:
 * - 有同比 RatioResult → 按百分比展示
 * - 无基准 → "无基准"
 */
function fmtYoy(r: RatioResult | null): string {
  if (!r) return NO_BASELINE;
  return r.ok ? `${r.value >= 0 ? "+" : ""}${round2(r.value * 100)}%` : `不可算(${r.reason})`;
}

/**
 * 格式化预算对比(预算偏差 = (实际-预算)/预算)。
 * 无预算值 → "无基准";有预算但分母≤0 → 不可算。
 */
function fmtBudgetVs(actual: number, budgetVal: number | undefined): string {
  if (budgetVal == null) return NO_BASELINE;
  const r = periodOverPeriod(actual, budgetVal);
  return r.ok
    ? `${r.value >= 0 ? "+" : ""}${round2(r.value * 100)}%`
    : `不可算(${r.reason})`;
}

// ─────────── v2 主引擎 ───────────

/**
 * 平均值计算:有期初数用(期初+期末)/2,否则用期末近似并脚注(红线 3)。
 */
function avg(end: number, prior: number | undefined, label: string, footnotes: string[]): number {
  if (prior != null) return (end + prior) / 2;
  footnotes.push(`${label}无期初数,以期末数近似平均(口径偏差)`);
  return end;
}

export type BuildV2Options = {
  /** canonical 资产负债表(已归一到元) */
  bs: CanonicalBalanceSheet;
  /** canonical 利润表(已归一到元) */
  is: CanonicalIncomeStatement;
  /** 可选预算数(已归一到元) */
  budget?: BudgetData;
  /** 可选:上期快照(用于跨期同比;若 is.prior 已有,则优先 is.prior) */
  priorPeriod?: {
    bs?: {
      totalAssets?: number;
      equity?: number;
      currentAssets?: number;
      receivables?: number;
      inventory?: number;
    };
    is?: {
      revenue?: number;
      cost?: number;
      netProfit?: number;
    };
  };
  meta: ReportMeta;
};

// ─────────── v2 指标注册表(四能力 × 三基准的单一来源) ───────────

type IsPrior = {
  revenue: number; cost: number; sellingExpense: number; adminExpense: number;
  rdExpense: number; financeExpense: number; netProfit: number;
} | null;

/** 单指标构建上下文:预计算的本期/上期快照 + 平均值 + 脚注收集器。 */
type MetricCtx = {
  bs: CanonicalBalanceSheet;
  is: CanonicalIncomeStatement;
  budget?: BudgetData;
  priorPeriod?: BuildV2Options["priorPeriod"];
  bsPrior: CanonicalBalanceSheet["prior"];
  isPrior: IsPrior;
  avgTotalAssets: number;
  avgEquity: number;
  avgReceivables: number;
  avgInventory: number;
};

/** 指标定义:能力归属 + 名称 + 口径 + 构建三基准列。**加一个指标 = 往本表加一行。** */
type MetricDef = {
  capability: "偿债能力" | "盈利能力" | "营运能力" | "发展能力";
  name: string;
  basis: string;
  build: (c: MetricCtx) => BenchmarkColumns;
};

/** 同比 RatioResult:本期/上期都可算时取环比,否则 null(→ 渲染为"无基准")。 */
function yoyOf(cur: RatioResult, prior: RatioResult | null): RatioResult | null {
  return cur.ok && prior?.ok ? periodOverPeriod(cur.value, prior.value) : null;
}

/**
 * 指标注册表 —— 四能力 × 三基准的**单一来源**。
 * 加指标:在对应 capability 下加一行 { name, basis, build };分组/渲染/脚注由 buildBusinessAnalysisV2 统一处理。
 * 每个 build 闭包内自带该指标的本期/同比/预算口径,行为与原手写装配逐字一致。
 */
const METRIC_REGISTRY: MetricDef[] = [
  // ─── 偿债能力 ───
  {
    capability: "偿债能力", name: "资产负债率", basis: "总负债 / 总资产",
    build: (c) => {
      const cur = debtToAssetRatio(c.bs.totalLiabilities, c.bs.totalAssets);
      const prior = c.bsPrior && c.bsPrior.totalAssets > 0
        ? debtToAssetRatio(c.bsPrior.totalLiabilities, c.bsPrior.totalAssets) : null;
      return { current: asPct(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: NO_BASELINE };
    },
  },
  {
    capability: "偿债能力", name: "流动比率", basis: "流动资产 / 流动负债",
    build: (c) => {
      const cur = currentRatio(c.bs.currentAssets, c.bs.currentLiabilities);
      const prior = c.bsPrior && c.bsPrior.currentLiabilities > 0
        ? currentRatio(c.bsPrior.currentAssets, c.bsPrior.currentLiabilities) : null;
      return { current: asTimes(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: NO_BASELINE };
    },
  },
  {
    capability: "偿债能力", name: "流动资产占比", basis: "流动资产 / 总资产",
    build: (c) => ({
      current: asPct(ratio(c.bs.currentAssets, c.bs.totalAssets, "总资产")),
      yoy: NO_BASELINE, budget: NO_BASELINE,
    }),
  },
  // ─── 盈利能力 ───
  {
    capability: "盈利能力", name: "毛利率", basis: "(营业收入 − 营业成本) / 营业收入",
    build: (c) => {
      const cur = grossMargin(c.is.revenue, c.is.cost);
      const prior = c.isPrior ? grossMargin(c.isPrior.revenue, c.isPrior.cost) : null;
      const budgetR = c.budget?.revenue != null && c.budget?.cost != null
        ? grossMargin(c.budget.revenue, c.budget.cost) : null;
      const budgetCol = cur.ok && budgetR?.ok ? fmtBudgetVs(cur.value, budgetR.value) : NO_BASELINE;
      return { current: asPct(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: budgetCol };
    },
  },
  {
    capability: "盈利能力", name: "净利率", basis: "净利润 / 营业收入",
    build: (c) => {
      const cur = netMargin(c.is.netProfit, c.is.revenue);
      const prior = c.isPrior ? netMargin(c.isPrior.netProfit, c.isPrior.revenue) : null;
      const budgetR = c.budget?.revenue != null && c.budget?.netProfit != null
        ? netMargin(c.budget.netProfit, c.budget.revenue) : null;
      const budgetCol = cur.ok && budgetR?.ok ? fmtBudgetVs(cur.value, budgetR.value) : NO_BASELINE;
      return { current: asPct(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: budgetCol };
    },
  },
  {
    capability: "盈利能力", name: "ROE", basis: "净利润 / 平均净资产",
    build: (c) => ({ current: asPctTimes(roe(c.is.netProfit, c.avgEquity)), yoy: NO_BASELINE, budget: NO_BASELINE }),
  },
  {
    capability: "盈利能力", name: "杜邦ROE", basis: "净利率 × 总资产周转率 × 权益乘数",
    build: (c) => {
      const d = dupont({
        netProfit: c.is.netProfit, revenue: c.is.revenue,
        avgTotalAssets: c.avgTotalAssets, totalAssets: c.bs.totalAssets, equity: c.bs.equity,
      });
      return {
        current: d.ok
          ? `${round2(d.roe * 100)}%（净利率${round2(d.netMarginFactor * 100)}%×周转${round2(d.assetTurnoverFactor)}×杠杆${round2(d.equityMultiplierFactor)}）`
          : `不可算(${d.reason})`,
        yoy: NO_BASELINE, budget: NO_BASELINE,
      };
    },
  },
  // ─── 营运能力 ───
  {
    capability: "营运能力", name: "应收账款周转率", basis: "营业收入 / 平均应收账款(次/年)",
    build: (c) => {
      const cur = receivablesTurnover(c.is.revenue, c.avgReceivables);
      const priorAvg = c.bsPrior?.receivables != null && c.priorPeriod?.bs?.receivables != null
        ? (c.bsPrior.receivables + c.priorPeriod.bs.receivables) / 2 : c.bsPrior?.receivables;
      const prior = c.isPrior && priorAvg != null ? receivablesTurnover(c.isPrior.revenue, priorAvg) : null;
      return { current: asTimes(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: NO_BASELINE };
    },
  },
  {
    capability: "营运能力", name: "存货周转率", basis: "营业成本 / 平均存货(次/年)",
    build: (c) => {
      const cur = inventoryTurnover(c.is.cost, c.avgInventory);
      const priorAvg = c.bsPrior?.inventory != null && c.priorPeriod?.bs?.inventory != null
        ? (c.bsPrior.inventory + c.priorPeriod.bs.inventory) / 2 : c.bsPrior?.inventory;
      const prior = c.isPrior && priorAvg != null ? inventoryTurnover(c.isPrior.cost, priorAvg) : null;
      return { current: asTimes(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: NO_BASELINE };
    },
  },
  {
    capability: "营运能力", name: "总资产周转率", basis: "营业收入 / 平均总资产(次/年)",
    build: (c) => {
      const cur = totalAssetTurnover(c.is.revenue, c.avgTotalAssets);
      const priorAvg = c.bsPrior?.totalAssets != null && c.priorPeriod?.bs?.totalAssets != null
        ? (c.bsPrior.totalAssets + c.priorPeriod.bs.totalAssets) / 2 : c.bsPrior?.totalAssets;
      const prior = c.isPrior && priorAvg != null ? totalAssetTurnover(c.isPrior.revenue, priorAvg) : null;
      return { current: asTimes(cur), yoy: fmtYoy(yoyOf(cur, prior)), budget: NO_BASELINE };
    },
  },
  // ─── 发展能力 ───
  {
    capability: "发展能力", name: "营业收入增长率", basis: "(本期营收 − 上期营收) / 上期营收",
    build: (c) => {
      const growth = c.isPrior && c.isPrior.revenue > 0 ? periodOverPeriod(c.is.revenue, c.isPrior.revenue) : null;
      const budgetCol = c.budget?.revenue != null && c.budget.revenue > 0 ? fmtBudgetVs(c.is.revenue, c.budget.revenue) : NO_BASELINE;
      return { current: `${(c.is.revenue / 10000).toFixed(2)} 万元`, yoy: fmtYoy(growth), budget: budgetCol };
    },
  },
  {
    capability: "发展能力", name: "净利润增长率", basis: "(本期净利 − 上期净利) / 上期净利",
    build: (c) => {
      const growth = c.isPrior && c.isPrior.netProfit > 0 ? periodOverPeriod(c.is.netProfit, c.isPrior.netProfit) : null;
      const budgetCol = c.budget?.netProfit != null && c.budget.netProfit > 0 ? fmtBudgetVs(c.is.netProfit, c.budget.netProfit) : NO_BASELINE;
      return { current: `${(c.is.netProfit / 10000).toFixed(2)} 万元`, yoy: fmtYoy(growth), budget: budgetCol };
    },
  },
  {
    capability: "发展能力", name: "总资产增长率", basis: "(本期总资产 − 期初总资产) / 期初总资产",
    build: (c) => {
      const growth = c.bsPrior && c.bsPrior.totalAssets > 0 ? periodOverPeriod(c.bs.totalAssets, c.bsPrior.totalAssets) : null;
      return { current: `${(c.bs.totalAssets / 10000).toFixed(2)} 万元`, yoy: fmtYoy(growth), budget: NO_BASELINE };
    },
  },
  {
    capability: "发展能力", name: "净资产增长率", basis: "(本期净资产 − 期初净资产) / 期初净资产",
    build: (c) => {
      const growth = c.bsPrior && c.bsPrior.equity > 0 ? periodOverPeriod(c.bs.equity, c.bsPrior.equity) : null;
      return { current: `${(c.bs.equity / 10000).toFixed(2)} 万元`, yoy: fmtYoy(growth), budget: NO_BASELINE };
    },
  },
];

const CAPABILITIES = ["偿债能力", "盈利能力", "营运能力", "发展能力"] as const;

/**
 * 构建 v2 四能力 × 三基准经营分析报告。
 * 四能力:偿债 / 盈利 / 营运 / 发展。三基准列:本期 / 同比 / 预算对比。
 * 指标全在 METRIC_REGISTRY(单一来源);本函数只做共享上下文预计算 + 按能力分组遍历。
 */
export function buildBusinessAnalysisV2(opts: BuildV2Options): AnalysisReportV2 {
  const { bs, is, budget, priorPeriod, meta } = opts;
  const footnotes: string[] = [];

  const bsPrior = bs.prior;
  // 同比基准:优先 is.prior(损益表内置);其次 priorPeriod.is(外部快照,字段可空)
  const _isPriorRaw = is.prior ?? priorPeriod?.is;
  const isPrior: IsPrior =
    _isPriorRaw != null && _isPriorRaw.revenue != null && _isPriorRaw.cost != null && _isPriorRaw.netProfit != null
      ? {
          revenue:        _isPriorRaw.revenue,
          cost:           _isPriorRaw.cost,
          sellingExpense: (_isPriorRaw as { sellingExpense?: number }).sellingExpense ?? 0,
          adminExpense:   (_isPriorRaw as { adminExpense?: number }).adminExpense ?? 0,
          rdExpense:      (_isPriorRaw as { rdExpense?: number }).rdExpense ?? 0,
          financeExpense: (_isPriorRaw as { financeExpense?: number }).financeExpense ?? 0,
          netProfit:      _isPriorRaw.netProfit,
        }
      : null;

  // 平均值(顺序固定:总资产→净资产→应收→存货,保证缺期初脚注顺序稳定)
  const ctx: MetricCtx = {
    bs, is, budget, priorPeriod, bsPrior, isPrior,
    avgTotalAssets: avg(bs.totalAssets, bsPrior?.totalAssets ?? priorPeriod?.bs?.totalAssets, "总资产", footnotes),
    avgEquity:      avg(bs.equity,      bsPrior?.equity      ?? priorPeriod?.bs?.equity,      "净资产", footnotes),
    avgReceivables: avg(bs.receivables, bsPrior?.receivables ?? priorPeriod?.bs?.receivables, "应收账款", footnotes),
    avgInventory:   avg(bs.inventory,   bsPrior?.inventory   ?? priorPeriod?.bs?.inventory,   "存货", footnotes),
  };

  const sections: SectionV2[] = CAPABILITIES.map((title) => ({
    title,
    metrics: METRIC_REGISTRY
      .filter((m) => m.capability === title)
      .map((m) => ({ name: m.name, columns: m.build(ctx), basis: m.basis })),
  }));

  const statusStr = meta.status ?? "草稿";
  const footnotesBase = [
    `数据截止日:${meta.asOf ?? "未提供(请补)"}`,
    `来源:${meta.source ?? "未提供"}`,
    `口径:${meta.caliber ?? "未提供(如期末数/未审计,请确认)"}`,
    `结算状态:${statusStr}`,
    "所有数值已归一至「元」;发展能力展示万元换算仅供可读性",
  ];

  return {
    sections,
    footnotes: [...footnotesBase, ...footnotes],
    asOf: meta.asOf ?? "",
    status: statusStr,
  };
}

/**
 * 渲染 v2 报告为 Markdown 三基准表格。
 */
export function renderAnalysisMarkdownV2(report: AnalysisReportV2, title = "经营分析表 v2"): string {
  const lines: string[] = [`# ${title}`, ""];
  for (const s of report.sections) {
    lines.push(`## ${s.title}`, "", "| 指标 | 本期 | 同比 | 预算对比 | 口径 |", "|---|---|---|---|---|");
    for (const m of s.metrics) {
      lines.push(
        `| ${m.name} | ${m.columns.current} | ${m.columns.yoy} | ${m.columns.budget} | ${m.basis} |`
      );
    }
    lines.push("");
  }
  lines.push("---", "**数据信任链**");
  for (const f of report.footnotes) lines.push(`- ${f}`);
  return lines.join("\n");
}
